/**
 * THE adapter. There is one, and it is driven entirely by a SourceSpec.
 *
 * Adding a dataset must not mean writing code -- that is the whole commercial
 * claim -- so every source-specific decision lives in the spec and this file
 * stays the same regardless of how many sources exist.
 */

import type { Db } from '../db/index.ts';
import type { Result, Transport } from '../contracts/index.ts';
import { ok, err } from '../contracts/index.ts';
import { defaultTransport } from '../connectors/transport.ts';
import { nowIso } from '../runtime/clock.ts';
import { canonicalHash, shortHash } from '../runtime/hash.ts';
import { readPath, type FieldRule, type SourceSpec } from './spec.ts';
import { parseRecords, profileRecords, proposeMapping, type MappingProposal, type RawRecord, type SchemaProfile } from './profile.ts';
import {
  detectFunnelAnomalies, diagnoseGeoAnomaly, formatAnomaly,
  type Anomaly, type FunnelStage, type RejectionSample,
} from './anomaly.ts';

export interface SourceMetadata {
  id: string; name: string; entity: string; format: string; locator: string;
  license: string; attribution: string; commercialUse: boolean; trustTier: string;
  reachable: boolean; bytes: number | null;
}

export interface ValidationResult {
  valid: boolean;
  issues: string[];
  /** Canonical fields the spec maps but the data never populates. */
  deadMappings: string[];
  coverage: Record<string, number>;
}

export interface IngestOptions {
  limit?: number;
  dryRun?: boolean;
  transport?: Transport;
  /** Ingest even when the content hash is unchanged. */
  force?: boolean;
}

export interface IngestResult {
  runId: string;
  sourceId: string;
  stages: FunnelStage[];
  imported: number;
  rejected: number;
  unchanged: boolean;
  anomalies: Anomaly[];
  warnings: string[];
  status: 'ok' | 'ok_with_anomalies' | 'failed' | 'unchanged';
  records: MappedRecord[];
  rejections: ValidationRejection[];
}

export interface ChangeSet {
  changed: boolean;
  previousHash: string | null;
  currentHash: string | null;
  checkedAt: string;
}

export interface SourceHealth {
  sourceId: string; status: 'up' | 'degraded' | 'down' | 'unconfigured';
  checkedAt: string; bytes: number | null; error: string | null;
}

export interface MappedRecord {
  identity: string;
  values: Record<string, unknown>;
  raw: RawRecord;
}

/**
 * A record that failed validation. Returned in FULL, not sampled: "no silent
 * drops" means a rejected row can be re-driven after a mapping is repaired,
 * which is impossible if only a diagnostic sample survived.
 */
export interface ValidationRejection {
  record: MappedRecord;
  reasonCode: 'MISSING_REQUIRED_FIELD' | 'OUT_OF_RANGE';
  details: string;
}

const REJECT_SAMPLE_CAP = 500;

/**
 * Run ids are hashed from the source id and the timestamp, which collide when
 * two runs of the same source land in the same millisecond -- ordinary in tests
 * and in a batch loop. A process-local sequence makes them unique regardless.
 */
let runSequence = 0;
function nextRunId(sourceId: string): string {
  runSequence += 1;
  return `run_${shortHash(`${sourceId}|${nowIso()}|${runSequence}|${process.pid}`)}`;
}

function applyTransform(value: unknown, transform: FieldRule['transform']): unknown {
  if (value === undefined || value === null) return value;
  switch (transform) {
    case 'upper': return String(value).toUpperCase();
    case 'lower': return String(value).toLowerCase();
    case 'trim': return String(value).trim();
    case 'number': { const n = Number(value); return Number.isFinite(n) ? n : null; }
    case 'integer': { const n = Number(value); return Number.isFinite(n) ? Math.trunc(n) : null; }
    case 'boolean': return value === true || value === 'true' || value === 'yes' || value === 1;
    case 'first': return Array.isArray(value) ? (value[0] ?? null) : value;
    case 'join': return Array.isArray(value) ? value.join('; ') : value;
    default: return value;
  }
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === '' ||
    (Array.isArray(value) && value.length === 0);
}

/** Extract one canonical field from a raw record, before resolvers run. */
export function extractField(record: RawRecord, rule: FieldRule): unknown {
  if (rule.const !== undefined) return rule.const;
  let value: unknown;
  if (rule.field) value = readPath(record, rule.field);
  if (isBlank(value) && rule.anyOf) {
    for (const candidate of rule.anyOf) {
      const v = readPath(record, candidate);
      if (!isBlank(v)) { value = v; break; }
    }
  }
  value = applyTransform(value, rule.transform);
  return isBlank(value) ? (rule.default ?? null) : value;
}

/** Run a spec's resolver chain against the database and already-mapped values. */
export function resolveField(
  db: Db,
  rule: FieldRule,
  record: RawRecord,
  mapped: Record<string, unknown>,
): unknown {
  if (!rule.resolver) return null;
  for (const step of rule.resolver) {
    if (step.const !== undefined) return step.const;
    if (step.fromField) {
      const v = mapped[step.fromField] ?? readPath(record, step.fromField);
      if (!isBlank(v)) return v;
      continue;
    }
    if (step.lookup) {
      const { table, match, from, using } = step.lookup;
      const key = mapped[using] ?? readPath(record, using);
      if (isBlank(key)) continue;
      // Identifiers come from the spec, which is operator-authored config, and
      // are constrained to plain identifiers before reaching SQL.
      const ident = /^[a-z_][a-z0-9_]*$/i;
      if (!ident.test(table) || !ident.test(match) || !ident.test(from)) continue;
      const row = db.get<Record<string, unknown>>(
        `SELECT ${from} AS value FROM ${table} WHERE ${match} = ? LIMIT 1`,
        typeof key === 'string' ? key.toUpperCase() : key,
      );
      if (row && !isBlank(row.value)) return row.value;
    }
  }
  return null;
}

export function createSourceAdapter(db: Db, spec: SourceSpec) {
  let cachedBody: string | null = null;

  async function body(transport?: Transport): Promise<Result<string>> {
    if (cachedBody !== null) return ok(cachedBody);
    const t = transport ?? defaultTransport();
    const response = await t.request({ url: spec.locator });
    if (!response.ok) return response;
    if (response.value.status >= 400) {
      return err('upstream_unavailable', `${spec.id}: HTTP ${response.value.status}`, { status: response.value.status });
    }
    cachedBody = response.value.body;
    return ok(cachedBody);
  }

  return {
    spec,

    async discover(transport?: Transport): Promise<Result<SourceMetadata>> {
      const fetched = await body(transport);
      return ok({
        id: spec.id, name: spec.name, entity: spec.entity, format: spec.format,
        locator: spec.locator, license: spec.license.name,
        attribution: spec.license.attribution, commercialUse: spec.license.commercialUse,
        trustTier: spec.trustTier,
        reachable: fetched.ok,
        bytes: fetched.ok ? fetched.value.length : null,
      });
    },

    async inspect(transport?: Transport): Promise<Result<SchemaProfile>> {
      const fetched = await body(transport);
      if (!fetched.ok) return fetched;
      try {
        return ok(profileRecords(parseRecords(fetched.value, spec), spec.format));
      } catch (cause) {
        return err('upstream_schema_drift', `${spec.id}: could not parse`, { format: spec.format }, cause);
      }
    },

    async sample(limit = 5, transport?: Transport): Promise<Result<RawRecord[]>> {
      const fetched = await body(transport);
      if (!fetched.ok) return fetched;
      try {
        return ok(parseRecords(fetched.value, spec).slice(0, limit));
      } catch (cause) {
        return err('upstream_schema_drift', `${spec.id}: could not parse`, {}, cause);
      }
    },

    async proposeMapping(transport?: Transport): Promise<Result<MappingProposal>> {
      const profile = await this.inspect(transport);
      if (!profile.ok) return profile;
      return ok(proposeMapping(profile.value));
    },

    /**
     * Check the spec against the data BEFORE a full run: a field the spec maps
     * that the data never populates is the failure mode that silently drops
     * most of a dataset.
     */
    async validateMapping(transport?: Transport): Promise<Result<ValidationResult>> {
      const profiled = await this.inspect(transport);
      if (!profiled.ok) return profiled;
      const profile = profiled.value;
      const byName = new Map(profile.fields.map((f) => [f.name, f]));

      const issues: string[] = [];
      const deadMappings: string[] = [];
      const coverage: Record<string, number> = {};

      for (const [canonical, rule] of Object.entries(spec.fields)) {
        const names = [rule.field, ...(rule.anyOf ?? [])].filter(Boolean) as string[];
        if (names.length === 0) continue;
        const best = Math.max(0, ...names.map((n) => byName.get(n)?.populated ?? 0));
        coverage[canonical] = Number(best.toFixed(3));
        if (best === 0) {
          const hasFallback = Boolean(rule.resolver || rule.const !== undefined || rule.default !== undefined);
          if (hasFallback) {
            issues.push(`${canonical}: source fields are empty; relying on the resolver chain`);
          } else {
            deadMappings.push(canonical);
            issues.push(`${canonical}: mapped to ${names.join('/')}, which is empty in every sampled record`);
          }
        }
      }
      for (const key of spec.identity) {
        if ((coverage[key] ?? 1) === 0) issues.push(`identity field ${key} is never populated`);
      }
      return ok({ valid: deadMappings.length === 0, issues, deadMappings, coverage });
    },

    async checkChanges(transport?: Transport): Promise<Result<ChangeSet>> {
      const fetched = await body(transport);
      const checkedAt = nowIso();
      if (!fetched.ok) return fetched;
      const currentHash = canonicalHash(fetched.value);
      const previous = db.get<{ content_hash: string }>(
        `SELECT content_hash FROM ingestion_runs WHERE source_id = ? AND content_hash IS NOT NULL
         ORDER BY started_at DESC LIMIT 1`,
        spec.id,
      );
      const previousHash = previous?.content_hash ?? null;
      return ok({ changed: previousHash !== currentHash, previousHash, currentHash, checkedAt });
    },

    async healthCheck(transport?: Transport): Promise<SourceHealth> {
      const checkedAt = nowIso();
      const fetched = await body(transport);
      if (!fetched.ok) {
        return {
          sourceId: spec.id,
          status: fetched.error.kind === 'not_configured' ? 'unconfigured' : 'down',
          checkedAt, bytes: null, error: fetched.error.message,
        };
      }
      try {
        const count = parseRecords(fetched.value, spec).length;
        return {
          sourceId: spec.id, status: count > 0 ? 'up' : 'degraded',
          checkedAt, bytes: fetched.value.length,
          error: count > 0 ? null : 'source parsed to zero records',
        };
      } catch (cause) {
        return {
          sourceId: spec.id, status: 'degraded', checkedAt, bytes: fetched.value.length,
          error: `unparseable: ${cause instanceof Error ? cause.message : String(cause)}`,
        };
      }
    },

    /**
     * Map and validate every record, recording the full funnel. Persistence of
     * the mapped records is the caller's job -- this stage is about whether the
     * data survived, and if not, where and why.
     */
    async ingest(options: IngestOptions = {}): Promise<Result<IngestResult>> {
      const runId = nextRunId(spec.id);
      const startedAt = nowIso();
      const fetched = await body(options.transport);
      if (!fetched.ok) {
        db.run(
          `INSERT INTO ingestion_runs (run_id, source_id, started_at, finished_at, status, error)
           VALUES (?,?,?,?,?,?)`,
          runId, spec.id, startedAt, nowIso(), 'failed', fetched.error.message,
        );
        return fetched;
      }

      const contentHash = canonicalHash(fetched.value);
      const changes = await this.checkChanges(options.transport);
      if (!options.force && changes.ok && !changes.value.changed) {
        db.run(
          `INSERT INTO ingestion_runs (run_id, source_id, started_at, finished_at, status, content_hash, unchanged)
           VALUES (?,?,?,?,?,?,1)`,
          runId, spec.id, startedAt, nowIso(), 'ok', contentHash,
        );
        return ok({
          runId, sourceId: spec.id, stages: [], imported: 0, rejected: 0, unchanged: true,
          anomalies: [], warnings: ['source unchanged since the last run; skipped'],
          status: 'unchanged', records: [], rejections: [],
        });
      }

      let raw: RawRecord[];
      try {
        raw = parseRecords(fetched.value, spec);
      } catch (cause) {
        return err('upstream_schema_drift', `${spec.id}: could not parse`, { runId }, cause);
      }
      if (options.limit) raw = raw.slice(0, options.limit);

      const profile = profileRecords(raw, spec.format);
      const rejects: RejectionSample[] = [];
      const rejections: ValidationRejection[] = [];
      const records: MappedRecord[] = [];
      const required = spec.quality?.rejectIfMissing ?? [];
      const warnMissing = spec.quality?.warnIfMissing ?? [];
      const warnCounts = new Map<string, number>();

      let mappedCount = 0;
      let countryMatched = 0;
      let regionResolved = 0;
      const mapsCountry = 'countryIso2' in spec.fields;
      const mapsRegion = 'regionCode' in spec.fields;

      for (const record of raw) {
        const values: Record<string, unknown> = {};
        for (const [canonical, rule] of Object.entries(spec.fields)) {
          values[canonical] = extractField(record, rule);
        }
        mappedCount += 1;

        // Resolver chains run after plain extraction so they can reference
        // fields the source did supply.
        for (const [canonical, rule] of Object.entries(spec.fields)) {
          if (!rule.resolver) continue;
          if (isBlank(values[canonical])) {
            values[canonical] = resolveField(db, rule, record, values);
          }
        }

        // Geography is counted as its own funnel stages, whether or not the
        // spec configured a resolver: that is what localises a mass rejection
        // to "the country did not match" versus "the region did not resolve".
        if (mapsCountry && !isBlank(values.countryIso2)) countryMatched += 1;
        if (mapsRegion && !isBlank(values.regionCode)) regionResolved += 1;

        const identity = spec.identity.map((f) => String(values[f] ?? '')).join('|');
        const missing = required.filter((f) => isBlank(values[f]));
        if (missing.length > 0) {
          // Diagnostic sample stays capped; the retained rejection does not.
          if (rejects.length < REJECT_SAMPLE_CAP) {
            rejects.push({ reason: `missing ${missing.join(', ')}`, field: missing[0] ?? null, record });
          }
          rejections.push({
            record: { identity, values, raw: record },
            reasonCode: 'MISSING_REQUIRED_FIELD',
            details: `missing ${missing.join(', ')}`,
          });
          continue;
        }

        let outOfRange: string | null = null;
        for (const range of spec.quality?.ranges ?? []) {
          const v = Number(values[range.field]);
          if (!Number.isFinite(v) || (range.min !== undefined && v < range.min) || (range.max !== undefined && v > range.max)) {
            outOfRange = `${range.field}=${String(values[range.field])} outside [${range.min ?? '-inf'}, ${range.max ?? 'inf'}]`;
            if (rejects.length < REJECT_SAMPLE_CAP) {
              rejects.push({ reason: `${range.field} out of range`, field: range.field, record });
            }
            break;
          }
        }
        if (outOfRange) {
          rejections.push({
            record: { identity, values, raw: record },
            reasonCode: 'OUT_OF_RANGE',
            details: outOfRange,
          });
          continue;
        }

        for (const field of warnMissing) {
          if (isBlank(values[field])) warnCounts.set(field, (warnCounts.get(field) ?? 0) + 1);
        }

        records.push({ identity, values, raw: record });
      }

      const stages: FunnelStage[] = [
        { name: 'SOURCE ROWS', count: raw.length },
        { name: 'PARSED', count: raw.length },
        { name: 'MAPPED', count: mappedCount },
      ];
      if (mapsCountry) stages.push({ name: 'COUNTRY MATCHED', count: countryMatched });
      if (mapsRegion) stages.push({ name: 'REGION RESOLVED', count: regionResolved });
      stages.push({ name: 'IMPORTED', count: records.length });

      const totalRejected = raw.length - records.length;
      let anomalies = detectFunnelAnomalies(stages);
      anomalies = anomalies.map((a) =>
        a.stage === 'REGION RESOLVED' || a.stage === 'COUNTRY MATCHED' || a.stage === 'IMPORTED'
          ? diagnoseGeoAnomaly(db, a, rejects, profile, totalRejected)
          : a,
      );

      const warnings = [...warnCounts.entries()].map(
        ([field, n]) => `${field} missing on ${n.toLocaleString()} imported records`,
      );

      const ratio = raw.length === 0 ? 1 : records.length / raw.length;
      const floor = spec.quality?.minImportRatio;
      const belowFloor = floor !== undefined && ratio < floor;
      if (belowFloor) {
        anomalies.push({
          severity: 'critical', stage: 'IMPORTED', lossRatio: 1 - ratio,
          message: `only ${(ratio * 100).toFixed(1)}% of rows imported, below the spec floor of ${(floor * 100).toFixed(0)}%`,
          likelyCause: null, repair: null,
        });
      }

      const status: IngestResult['status'] =
        belowFloor ? 'failed' : anomalies.length > 0 ? 'ok_with_anomalies' : 'ok';

      if (!options.dryRun) {
        db.run(
          `INSERT INTO ingestion_runs (run_id, source_id, started_at, finished_at, status,
             source_rows, parsed, mapped, geo_resolved, imported, rejected,
             content_hash, unchanged, anomalies_json, warnings_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
          runId, spec.id, startedAt, nowIso(), status,
          raw.length, raw.length, mappedCount, regionResolved, records.length,
          raw.length - records.length, contentHash,
          JSON.stringify(anomalies), JSON.stringify(warnings),
        );
        for (const [index, reject] of rejects.slice(0, 100).entries()) {
          db.run(
            `INSERT INTO ingest_rejections (id, run_id, stage, reason, field, sample_json)
             VALUES (?,?,?,?,?,?)`,
            `${runId}_r${index}`, runId, 'validate', reject.reason, reject.field,
            JSON.stringify(reject.record).slice(0, 2000),
          );
        }
        db.run(
          `UPDATE source_registry SET last_checked = ?, last_successful_ingestion = ?
           WHERE source_id = ?`,
          nowIso(), status === 'failed' ? null : nowIso(), spec.id,
        );
      }

      return ok({
        runId, sourceId: spec.id, stages, imported: records.length,
        rejected: raw.length - records.length, unchanged: false,
        anomalies, warnings, status, records, rejections,
      });
    },
  };
}

export { formatAnomaly };

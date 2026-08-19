/**
 * The Scout Truth Layer.
 *
 * Nothing writes a fact onto an entity directly. Sources file claims into
 * `source_records`; this engine groups the live claims for one (entity, field)
 * by agreement, scores each agreement group with the ONE confidence model, and
 * writes the winner into `truth_resolutions` before applying it to the entity.
 *
 * The whole point is auditability: for any value in the graph you can ask which
 * source won, what it beat, and why.
 */

import type { Db } from '../db/index.ts';
import { jsonColumn } from '../db/index.ts';
import { liveClaims, claimedFields, getSource } from '../db/repo-truth.ts';
import { applyResolvedField } from '../db/repo-places.ts';
import type {
  Confidence,
  EntityType,
  Result,
  Source,
  SourceRecord,
  TruthResolution,
  VerificationState,
  FreshnessTier,
} from '../contracts/index.ts';
import {
  ok,
  err,
  computeConfidence,
  confidenceBand,
  policyFor,
  RESOLVABLE_PLACE_FIELDS,
  VERIFICATION_WEIGHT,
} from '../contracts/index.ts';
import { nowIso, daysBetween } from '../runtime/clock.ts';
import { canonicalJson, shortHash } from '../runtime/hash.ts';

const RESOLVABLE = new Set<string>(RESOLVABLE_PLACE_FIELDS);

/** Higher means more volatile, so the shortest half-life wins a group. */
const TIER_VOLATILITY: Readonly<Record<FreshnessTier, number>> = {
  base: 0,
  periodic: 1,
  live: 2,
};

const NUMBER_EPSILON = 1e-9;

/**
 * Do two claimed values say the same thing?
 *
 * Numbers agree within 1e-9 (float noise from different serialisers is not a
 * conflict), strings agree ignoring case and surrounding/repeated whitespace,
 * objects and arrays agree when their canonical JSON matches (key order is not
 * a disagreement). Anything else falls back to strict identity.
 */
export function valuesAgree(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a ?? null) === (b ?? null);
  }
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    return Math.abs(a - b) <= NUMBER_EPSILON;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    return normaliseString(a) === normaliseString(b);
  }
  if (typeof a === 'object' && typeof b === 'object') {
    return canonicalJson(a) === canonicalJson(b);
  }
  return Object.is(a, b);
}

function normaliseString(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

interface Claim {
  record: SourceRecord;
  source: Source;
}

interface AgreementGroup {
  value: unknown;
  claims: Claim[];
  confidence: Confidence;
  /** Newest observation in the group, drives freshness and tie-breaks. */
  newestObservedAt: string;
  chosen: Claim;
}

/** camelCase contract field names map onto snake_case columns. */
export function toColumnName(field: string): string {
  return field
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

function strongestVerification(claims: Claim[]): VerificationState {
  let best: VerificationState = 'rejected';
  let bestWeight = -1;
  for (const claim of claims) {
    const weight = VERIFICATION_WEIGHT[claim.record.verification] ?? 0;
    if (weight > bestWeight) {
      bestWeight = weight;
      best = claim.record.verification;
    }
  }
  return claims.length ? best : 'unverified';
}

/** Most volatile tier in the group decides how fast the group's evidence decays. */
function halfLifeFor(claims: Claim[]): number | null {
  let tier: FreshnessTier = 'base';
  for (const claim of claims) {
    if (TIER_VOLATILITY[claim.source.freshnessTier] > TIER_VOLATILITY[tier]) {
      tier = claim.source.freshnessTier;
    }
  }
  return policyFor(tier).confidenceHalfLifeDays;
}

/** Deterministic pick inside a winning group: strongest source, then newest, then id. */
function chooseRecord(claims: Claim[]): Claim {
  const sorted = [...claims].sort((a, b) => {
    if (b.source.authority !== a.source.authority) return b.source.authority - a.source.authority;
    const at = Date.parse(a.record.observedAt);
    const bt = Date.parse(b.record.observedAt);
    if (bt !== at) return bt - at;
    return a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0;
  });
  return sorted[0] as Claim;
}

function groupClaims(claims: Claim[], now: string): AgreementGroup[] {
  const buckets: Claim[][] = [];
  for (const claim of claims) {
    const bucket = buckets.find((b) => valuesAgree((b[0] as Claim).record.value, claim.record.value));
    if (bucket) bucket.push(claim);
    else buckets.push([claim]);
  }

  return buckets.map((bucket) => {
    // One source corroborating itself is not corroboration: dedupe by source.
    const bySource = new Map<string, Claim>();
    for (const claim of bucket) {
      const seen = bySource.get(claim.source.id);
      if (!seen || Date.parse(claim.record.observedAt) > Date.parse(seen.record.observedAt)) {
        bySource.set(claim.source.id, claim);
      }
    }
    const independent = [...bySource.values()];
    let newestObservedAt = (bucket[0] as Claim).record.observedAt;
    for (const claim of bucket) {
      if (Date.parse(claim.record.observedAt) > Date.parse(newestObservedAt)) {
        newestObservedAt = claim.record.observedAt;
      }
    }

    const confidence = computeConfidence({
      authorities: independent.map((c) => c.source.authority),
      ageDays: daysBetween(newestObservedAt, now),
      halfLifeDays: halfLifeFor(independent),
      verification: strongestVerification(bucket),
    });

    return {
      value: (bucket[0] as Claim).record.value,
      claims: bucket,
      confidence,
      newestObservedAt,
      chosen: chooseRecord(bucket),
    };
  });
}

/**
 * Winner = highest confidence. Ties fall to more independent observations, then
 * the newest observation, then the lexicographically first record id, so the
 * same inputs always resolve the same way.
 */
function rankGroups(groups: AgreementGroup[]): AgreementGroup[] {
  return [...groups].sort((a, b) => {
    if (b.confidence.value !== a.confidence.value) return b.confidence.value - a.confidence.value;
    if (b.confidence.observations !== a.confidence.observations) {
      return b.confidence.observations - a.confidence.observations;
    }
    const at = Date.parse(a.newestObservedAt);
    const bt = Date.parse(b.newestObservedAt);
    if (bt !== at) return bt - at;
    return a.chosen.record.id < b.chosen.record.id ? -1 : 1;
  });
}

function buildRationale(winner: AgreementGroup, losers: AgreementGroup[]): string {
  const band = confidenceBand(winner.confidence.value);
  const score = winner.confidence.value.toFixed(2);
  const name = winner.chosen.source.name;
  const corroborators = winner.confidence.observations - 1;
  const conflicting = losers.reduce((n, g) => n + g.claims.length, 0);

  if (conflicting === 0) {
    return corroborators > 0
      ? `chose ${name} (${score} ${band}) corroborated by ${corroborators} other source${corroborators === 1 ? '' : 's'}, no conflicting claims`
      : `chose ${name} (${score} ${band}), the only claim on record`;
  }
  const classes = [...new Set(losers.flatMap((g) => g.claims.map((c) => c.source.sourceClass)))]
    .sort()
    .join(' and ');
  const corroboration = corroborators > 0 ? ` with ${corroborators} corroborating source${corroborators === 1 ? '' : 's'}` : '';
  return `chose ${name} (${score} ${band})${corroboration} over ${conflicting} conflicting claim${conflicting === 1 ? '' : 's'} from ${classes} sources`;
}

function resolutionId(entityType: EntityType, entityId: string, field: string): string {
  return `tr_${shortHash(`${entityType}|${entityId}|${field}`)}`;
}

/**
 * Resolve one (entity, field) from its live claims.
 *
 * Returns ok(null) when nothing has been claimed. Writing the resolution is
 * part of resolving: the resolution row is the audit record.
 */
export function resolveField(
  db: Db,
  entityType: EntityType,
  entityId: string,
  field: string,
): Result<TruthResolution | null> {
  try {
    const records = liveClaims(db, entityId, field);
    if (records.length === 0) return ok(null);

    const all: Claim[] = [];
    for (const record of records) {
      const source = getSource(db, record.sourceId);
      if (!source) continue;
      all.push({ record, source });
    }
    // Disabled sources are ignored unless they are all we have, in which case a
    // stale answer still beats no answer at all.
    const enabled = all.filter((c) => c.source.enabled);
    const claims = enabled.length ? enabled : all;
    if (claims.length === 0) {
      return err('not_found', 'claims exist but none has a known source', { entityId, field });
    }

    const now = nowIso();
    const ranked = rankGroups(groupClaims(claims, now));
    const winner = ranked[0] as AgreementGroup;
    const losers = ranked.slice(1);

    const resolution: TruthResolution = {
      id: resolutionId(entityType, entityId, field),
      entityType,
      entityId,
      field,
      value: winner.value,
      confidence: winner.confidence,
      chosenRecordId: winner.chosen.record.id,
      agreeingRecordIds: winner.claims.map((c) => c.record.id).sort(),
      conflictingRecordIds: losers.flatMap((g) => g.claims.map((c) => c.record.id)).sort(),
      rationale: buildRationale(winner, losers),
      resolvedAt: now,
    };

    db.run(
      `INSERT INTO truth_resolutions (id, entity_type, entity_id, field, value_json, confidence,
         confidence_json, chosen_record_id, agreeing_record_ids, conflicting_record_ids,
         rationale, resolved_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(entity_type, entity_id, field) DO UPDATE SET
         id = excluded.id,
         value_json = excluded.value_json,
         confidence = excluded.confidence,
         confidence_json = excluded.confidence_json,
         chosen_record_id = excluded.chosen_record_id,
         agreeing_record_ids = excluded.agreeing_record_ids,
         conflicting_record_ids = excluded.conflicting_record_ids,
         rationale = excluded.rationale,
         resolved_at = excluded.resolved_at`,
      resolution.id,
      resolution.entityType,
      resolution.entityId,
      resolution.field,
      JSON.stringify(resolution.value ?? null),
      resolution.confidence.value,
      JSON.stringify(resolution.confidence),
      resolution.chosenRecordId,
      JSON.stringify(resolution.agreeingRecordIds),
      JSON.stringify(resolution.conflictingRecordIds),
      resolution.rationale,
      resolution.resolvedAt,
    );

    return ok(resolution);
  } catch (error) {
    return err('internal', `truth resolution failed for ${entityId}.${field}`, { entityId, field }, error);
  }
}

/**
 * Resolve every claimed field, then apply what can be applied.
 *
 * `conflicts` counts fields where sources disagreed at all; `skipped` counts
 * resolutions that are recorded but have no column to land on (non-place
 * entities, or place fields outside RESOLVABLE_PLACE_FIELDS).
 */
export function resolveAll(
  db: Db,
): Result<{ resolved: number; applied: number; conflicts: number; skipped: number }> {
  let resolved = 0;
  let applied = 0;
  let conflicts = 0;
  let skipped = 0;

  try {
    for (const target of claimedFields(db)) {
      const result = resolveField(db, target.entityType, target.entityId, target.field);
      if (!result.ok) return err(result.error.kind, result.error.message, result.error.detail, result.error.cause);
      const resolution = result.value;
      if (!resolution) continue;
      resolved += 1;
      if (resolution.conflictingRecordIds.length > 0) conflicts += 1;

      const column = toColumnName(resolution.field);
      if (target.entityType === 'place' && RESOLVABLE.has(column)) {
        if (applyResolvedField(db, resolution.entityId, column, resolution.value)) applied += 1;
        else skipped += 1;
      } else {
        skipped += 1;
      }
    }
    return ok({ resolved, applied, conflicts, skipped });
  } catch (error) {
    return err('internal', 'resolveAll failed', undefined, error);
  }
}

export function getResolution(db: Db, entityId: string, field: string): TruthResolution | null {
  const row = db.get<Record<string, unknown>>(
    'SELECT * FROM truth_resolutions WHERE entity_id = ? AND field = ?',
    entityId,
    field,
  );
  return row ? rowToResolution(row) : null;
}

export function rowToResolution(row: Record<string, unknown>): TruthResolution {
  return {
    id: String(row.id),
    entityType: row.entity_type as EntityType,
    entityId: String(row.entity_id),
    field: String(row.field),
    value: jsonColumn<unknown>(row.value_json, null),
    confidence: jsonColumn<Confidence>(row.confidence_json, computeConfidence({ authorities: [] })),
    chosenRecordId: String(row.chosen_record_id),
    agreeingRecordIds: jsonColumn<string[]>(row.agreeing_record_ids, []),
    conflictingRecordIds: jsonColumn<string[]>(row.conflicting_record_ids, []),
    rationale: String(row.rationale),
    resolvedAt: String(row.resolved_at),
  };
}

/** Every resolution recorded for one entity. Used by scoring to weigh fact quality. */
export function listResolutions(db: Db, entityId: string): TruthResolution[] {
  return db
    .all<Record<string, unknown>>(
      'SELECT * FROM truth_resolutions WHERE entity_id = ? ORDER BY field',
      entityId,
    )
    .map(rowToResolution);
}

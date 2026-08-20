/**
 * Conditional fetch and change detection.
 *
 * The cost model this design rests on: a watched source that has not changed
 * must cost one conditional request and nothing else. So every scan sends the
 * validators the last scan learned (`If-None-Match`, `If-Modified-Since`), and a
 * 304 short-circuits everything -- no body, no hash, no parse, no diff.
 *
 * What Radar does with a real change is equally deliberate: it NEVER writes to
 * `places`. It records the observation as a source claim via `recordClaim` and
 * lets the Truth Engine adjudicate it against every other source. Radar detects;
 * Truth decides. Collapsing those two would make the graph unauditable.
 */

import type { Db } from '../db/index.ts';
import { jsonColumn } from '../db/index.ts';
import type {
  DeltaKind,
  EntityType,
  Place,
  RadarDelta,
  RadarScan,
  Result,
  ScanStatus,
  Transport,
  TransportResponse,
  VerificationState,
  Watch,
} from '../contracts/index.ts';
import { ok, err, RESOLVABLE_PLACE_FIELDS } from '../contracts/index.ts';
import { defaultTransport } from '../connectors/transport.ts';
import { getPlace } from '../db/repo-places.ts';
import { recordClaim } from '../db/repo-truth.ts';
import { sha256, shortHash } from '../runtime/hash.ts';
import { nowIso } from '../runtime/clock.ts';
import { diffEntities, isActionable } from './delta.ts';
import { dueWatches, listWatches, recordWatchCheck } from './watches.ts';

export interface ScanOptions {
  transport?: Transport;
  limit?: number;
  /** Ignore stored validators and the due check: fetch unconditionally. */
  force?: boolean;
  now?: string;
}

export interface ScanOutcome {
  scan: RadarScan;
  deltas: RadarDelta[];
}

export interface ScanSummary {
  scanned: number;
  changed: number;
  unchanged: number;
  errors: number;
  skipped: number;
  deltas: number;
}

let sequence = 0;
function nextSequence(): number {
  sequence += 1;
  return sequence;
}

const PLACE_FIELD_TO_PROP: Readonly<Record<string, keyof Place>> = {
  name: 'name',
  category: 'category',
  price_tier: 'priceTier',
  indoor_outdoor: 'indoorOutdoor',
  rating: 'rating',
  min_age: 'minAge',
  max_age: 'maxAge',
  duration_minutes: 'durationMinutes',
  touristiness: 'touristiness',
  local_favor: 'localFavor',
  description: 'description',
  lat: 'lat',
  lon: 'lon',
  neighborhood_id: 'neighborhoodId',
};

const RESOLVABLE_FIELD_SET: ReadonlySet<string> = new Set(RESOLVABLE_PLACE_FIELDS);

/** `priceTier` and `price_tier` are the same field; canonical form is snake. */
export function toSnakeField(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

export function rowToScan(row: Record<string, unknown>): RadarScan {
  return {
    id: String(row.id),
    watchId: String(row.watch_id),
    startedAt: String(row.started_at),
    finishedAt: String(row.finished_at),
    status: row.status as ScanStatus,
    httpStatus: row.http_status === null || row.http_status === undefined ? null : Number(row.http_status),
    bytes: row.bytes === null || row.bytes === undefined ? null : Number(row.bytes),
    hash: (row.hash as string) ?? null,
    conditionalHit: Number(row.conditional_hit) === 1,
    error: (row.error as string) ?? null,
  };
}

export function rowToDelta(row: Record<string, unknown>): RadarDelta {
  return {
    id: String(row.id),
    watchId: String(row.watch_id),
    scanId: String(row.scan_id),
    entityType: row.entity_type as EntityType,
    entityId: String(row.entity_id),
    field: String(row.field),
    oldValue: jsonColumn<unknown>(row.old_value_json, null),
    newValue: jsonColumn<unknown>(row.new_value_json, null),
    semanticScore: Number(row.semantic_score),
    kind: row.kind as DeltaKind,
    verification: row.verification as VerificationState,
    sourceRecordId: (row.source_record_id as string) ?? null,
    createdAt: String(row.created_at),
  };
}

function header(response: TransportResponse, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(response.headers ?? {})) {
    if (key.toLowerCase() === wanted) return value;
  }
  return null;
}

/** Parse a scanned body into a flat field map. Unparseable bodies still count. */
export function payloadOf(body: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return { raw: body };
}

/**
 * The entity's CURRENT state, as the graph believes it today.
 *
 * For places that is the resolved row. For everything else there is no typed
 * table, so the live source claims stand in as the current state -- which keeps
 * the diff honest instead of reporting every field as brand new each scan.
 */
export function currentStateFor(db: Db, watch: Watch): Record<string, unknown> {
  if (watch.entityType === 'place') {
    const place = getPlace(db, watch.entityId);
    if (!place) return {};
    const state: Record<string, unknown> = {};
    for (const field of RESOLVABLE_PLACE_FIELDS) {
      const prop = PLACE_FIELD_TO_PROP[field];
      state[field] = prop ? (place[prop] ?? null) : null;
    }
    return state;
  }
  const state: Record<string, unknown> = {};
  const rows = db.all<Record<string, unknown>>(
    `SELECT field, value_json FROM source_records
     WHERE entity_id = ? AND superseded_by IS NULL ORDER BY observed_at ASC`,
    watch.entityId,
  );
  for (const row of rows) state[String(row.field)] = jsonColumn<unknown>(row.value_json, null);
  return state;
}

/** Payload keys mapped onto canonical field names the graph understands. */
export function normalizePayload(watch: Watch, payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    const field = toSnakeField(key);
    if (watch.entityType === 'place' && !RESOLVABLE_FIELD_SET.has(field)) continue;
    out[field] = value;
  }
  return out;
}

function insertScan(db: Db, scan: RadarScan): void {
  db.run(
    `INSERT INTO radar_scans (id, watch_id, started_at, finished_at, status, http_status,
       bytes, hash, conditional_hit, error)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    scan.id, scan.watchId, scan.startedAt, scan.finishedAt, scan.status, scan.httpStatus,
    scan.bytes, scan.hash, scan.conditionalHit ? 1 : 0, scan.error,
  );
}

function insertDelta(db: Db, delta: RadarDelta): void {
  db.run(
    `INSERT INTO radar_deltas (id, watch_id, scan_id, entity_type, entity_id, field,
       old_value_json, new_value_json, semantic_score, kind, verification, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO NOTHING`,
    delta.id, delta.watchId, delta.scanId, delta.entityType, delta.entityId, delta.field,
    JSON.stringify(delta.oldValue ?? null), JSON.stringify(delta.newValue ?? null),
    delta.semanticScore, delta.kind, delta.verification, delta.createdAt,
  );
}

/**
 * Scan one watch.
 *
 * Never throws: transport failures, unparseable bodies and unknown entities all
 * land as a recorded scan row with a status, because a scan that vanished is
 * indistinguishable from a scan that never ran.
 */
export async function scanWatch(
  db: Db,
  watch: Watch,
  opts: ScanOptions = {},
): Promise<Result<ScanOutcome>> {
  const transport = opts.transport ?? defaultTransport();
  const startedAt = opts.now ?? nowIso();
  const scanId = `sc_${shortHash(`${watch.id}|${startedAt}|${nextSequence()}`)}`;

  const finish = (
    status: ScanStatus,
    patch: Partial<RadarScan>,
    deltas: RadarDelta[] = [],
  ): Result<ScanOutcome> => {
    const scan: RadarScan = {
      id: scanId,
      watchId: watch.id,
      startedAt,
      finishedAt: opts.now ?? nowIso(),
      status,
      httpStatus: null,
      bytes: null,
      hash: null,
      conditionalHit: false,
      error: null,
      ...patch,
    };
    insertScan(db, scan);
    for (const delta of deltas) insertDelta(db, delta);
    return ok({ scan, deltas });
  };

  if (!watch.enabled && !opts.force) {
    return finish('skipped', { error: 'watch disabled' });
  }

  const headers: Record<string, string> = { accept: 'application/json, text/plain;q=0.8' };
  if (!opts.force) {
    if (watch.etag) headers['if-none-match'] = watch.etag;
    if (watch.lastModified) headers['if-modified-since'] = watch.lastModified;
  }

  const response = await transport.request({ url: watch.locator, method: 'GET', headers });
  const finishedAt = opts.now ?? nowIso();

  if (!response.ok) {
    // Transport-level failure: the watch was checked, but nothing was learned.
    // last_hash is left alone so the next 200 still compares against reality.
    recordWatchCheck(db, watch.id, { lastCheckedAt: finishedAt });
    return finish('error', { finishedAt, error: `${response.error.kind}: ${response.error.message}` });
  }

  const res = response.value;
  const etag = header(res, 'etag');
  const lastModified = header(res, 'last-modified');

  // 304: the whole point of the conditional request. No body, no work.
  if (res.status === 304) {
    recordWatchCheck(db, watch.id, {
      lastCheckedAt: finishedAt,
      etag: etag ?? watch.etag,
      lastModified: lastModified ?? watch.lastModified,
    });
    return finish('unchanged', {
      finishedAt,
      httpStatus: 304,
      bytes: 0,
      hash: watch.lastHash,
      conditionalHit: true,
    });
  }

  if (res.status < 200 || res.status >= 300) {
    recordWatchCheck(db, watch.id, { lastCheckedAt: finishedAt });
    return finish('error', {
      finishedAt,
      httpStatus: res.status,
      error: `unexpected http ${res.status}`,
    });
  }

  const body = res.body ?? '';
  const bytes = Buffer.byteLength(body, 'utf8');
  const hash = sha256(body);

  if (hash === watch.lastHash) {
    // The source answered in full but said the same thing. Cheaper next time if
    // it starts sending validators, which is why we still store them.
    recordWatchCheck(db, watch.id, {
      lastCheckedAt: finishedAt,
      etag: etag ?? watch.etag,
      lastModified: lastModified ?? watch.lastModified,
      lastHash: hash,
    });
    return finish('unchanged', {
      finishedAt,
      httpStatus: res.status,
      bytes,
      hash,
      conditionalHit: false,
    });
  }

  const payload = normalizePayload(watch, payloadOf(body));
  const current = currentStateFor(db, watch);
  const fields = watch.entityType === 'place' ? [...RESOLVABLE_PLACE_FIELDS] : undefined;
  const diffs = diffEntities(current, payload, fields);

  const deltas: RadarDelta[] = [];
  for (const diff of diffs) {
    // Cosmetic churn updates the hash (so we do not re-diff it forever) but
    // never becomes a row, a claim or a verification task.
    if (!isActionable(diff.kind)) continue;
    deltas.push({
      id: `rd_${shortHash(`${scanId}|${diff.field}`)}`,
      watchId: watch.id,
      scanId,
      entityType: watch.entityType,
      entityId: watch.entityId,
      field: diff.field,
      oldValue: diff.oldValue,
      newValue: diff.newValue,
      semanticScore: diff.semanticScore,
      kind: diff.kind,
      verification: 'unverified',
      // Filled in below, once the claim for this change has been recorded.
      sourceRecordId: null,
      createdAt: finishedAt,
    });
  }

  recordWatchCheck(db, watch.id, {
    lastCheckedAt: finishedAt,
    etag: etag ?? watch.etag,
    lastModified: lastModified ?? watch.lastModified,
    lastHash: hash,
  });

  const outcome = finish(
    'changed',
    { finishedAt, httpStatus: res.status, bytes, hash, conditionalHit: false },
    deltas,
  );

  // Hand every actionable change to the Truth Engine as a claim from this
  // watch's source. Radar does not touch `places`. The claim id is stored on
  // the delta so verification can reach it without re-deriving it by hash.
  for (const delta of deltas) {
    const claimId = recordClaim(db, {
      sourceId: watch.sourceId,
      entityType: delta.entityType,
      entityId: delta.entityId,
      field: delta.field,
      value: delta.newValue,
      observedAt: finishedAt,
      verification: 'unverified',
    });
    db.run('UPDATE radar_deltas SET source_record_id = ? WHERE id = ?', claimId, delta.id);
    delta.sourceRecordId = claimId;
  }

  return outcome;
}

/** Scan every due watch (or every enabled watch under `force`). */
export async function scanDue(db: Db, opts: ScanOptions = {}): Promise<Result<ScanSummary>> {
  const now = opts.now ?? nowIso();
  const candidates = opts.force ? listWatches(db, { enabled: true }) : dueWatches(db, now);
  const batch = opts.limit && opts.limit > 0 ? candidates.slice(0, opts.limit) : candidates;

  const summary: ScanSummary = {
    scanned: 0, changed: 0, unchanged: 0, errors: 0, skipped: 0, deltas: 0,
  };

  for (const watch of batch) {
    const result = await scanWatch(db, watch, opts);
    if (!result.ok) {
      summary.errors += 1;
      continue;
    }
    summary.scanned += 1;
    summary.deltas += result.value.deltas.length;
    const status = result.value.scan.status;
    if (status === 'changed') summary.changed += 1;
    else if (status === 'unchanged') summary.unchanged += 1;
    else if (status === 'error') summary.errors += 1;
    else summary.skipped += 1;
  }

  return ok(summary);
}

export function recentScans(db: Db, limit = 50): RadarScan[] {
  return db
    .all<Record<string, unknown>>(
      'SELECT * FROM radar_scans ORDER BY started_at DESC, rowid DESC LIMIT ?',
      limit,
    )
    .map(rowToScan);
}

export function scansSince(db: Db, sinceIso: string): RadarScan[] {
  return db
    .all<Record<string, unknown>>(
      'SELECT * FROM radar_scans WHERE started_at >= ? ORDER BY started_at DESC',
      sinceIso,
    )
    .map(rowToScan);
}

export function deltasForScan(db: Db, scanId: string): RadarDelta[] {
  return db
    .all<Record<string, unknown>>('SELECT * FROM radar_deltas WHERE scan_id = ? ORDER BY field', scanId)
    .map(rowToDelta);
}

export function getDelta(db: Db, id: string): RadarDelta | null {
  const row = db.get<Record<string, unknown>>('SELECT * FROM radar_deltas WHERE id = ?', id);
  return row ? rowToDelta(row) : null;
}

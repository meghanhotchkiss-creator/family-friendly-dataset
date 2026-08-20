/**
 * Radar watch graph.
 *
 * A watch is "this source, at this locator, speaks for this entity, and should
 * be re-checked every N minutes". Watch identity is derived, not generated:
 * the same (sourceId, entityId, locator) triple always produces the same id, so
 * registering a watch twice is a no-op rather than a duplicate row (the table
 * also carries a UNIQUE on that triple).
 */

import type { Db } from '../db/index.ts';
import type { EntityType, FreshnessTier, Result, Watch } from '../contracts/index.ts';
import { ok, err, policyFor, ENTITY_TYPES, FRESHNESS_TIERS } from '../contracts/index.ts';
import { shortHash } from '../runtime/hash.ts';
import { nowIso } from '../runtime/clock.ts';

const ENTITY_TYPE_SET: ReadonlySet<string> = new Set(ENTITY_TYPES);
const TIER_SET: ReadonlySet<string> = new Set(FRESHNESS_TIERS);

export interface WatchInput {
  sourceId: string;
  entityType: EntityType;
  entityId: string;
  locator: string;
  freshnessTier: FreshnessTier;
  checkIntervalMinutes?: number;
}

/** Deterministic watch id. Same triple in, same id out, forever. */
export function watchIdFor(sourceId: string, entityId: string, locator: string): string {
  return `w_${shortHash(`${sourceId}|${entityId}|${locator}`)}`;
}

export function rowToWatch(row: Record<string, unknown>): Watch {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    entityType: row.entity_type as EntityType,
    entityId: String(row.entity_id),
    locator: String(row.locator),
    freshnessTier: row.freshness_tier as FreshnessTier,
    checkIntervalMinutes: Number(row.check_interval_minutes),
    lastCheckedAt: (row.last_checked_at as string) ?? null,
    lastHash: (row.last_hash as string) ?? null,
    etag: (row.etag as string) ?? null,
    lastModified: (row.last_modified as string) ?? null,
    enabled: Number(row.enabled) === 1,
  };
}

/**
 * Register (or re-register) a watch. Idempotent: re-registering updates the
 * cadence and tier but never resets the fetch validators, because throwing away
 * an etag would turn a free 304 into a full body transfer.
 */
export function registerWatch(db: Db, w: WatchInput): Result<string> {
  const sourceId = w.sourceId?.trim();
  const entityId = w.entityId?.trim();
  const locator = w.locator?.trim();

  if (!sourceId) return err('invalid_input', 'watch requires a sourceId');
  if (!entityId) return err('invalid_input', 'watch requires an entityId');
  if (!locator) return err('invalid_input', 'watch requires a locator');
  if (!ENTITY_TYPE_SET.has(w.entityType)) {
    return err('invalid_input', `unknown entityType ${w.entityType}`, { entityType: w.entityType });
  }
  if (!TIER_SET.has(w.freshnessTier)) {
    return err('invalid_input', `unknown freshnessTier ${w.freshnessTier}`, {
      freshnessTier: w.freshnessTier,
    });
  }

  const interval = w.checkIntervalMinutes ?? policyFor(w.freshnessTier).recheckIntervalMinutes;
  if (!Number.isFinite(interval) || interval <= 0) {
    return err('invalid_input', `checkIntervalMinutes must be positive, got ${interval}`);
  }

  const source = db.get<{ id: string }>('SELECT id FROM sources WHERE id = ?', sourceId);
  if (!source) return err('not_found', `unknown source ${sourceId}`, { sourceId });

  const id = watchIdFor(sourceId, entityId, locator);
  db.run(
    `INSERT INTO watches (id, source_id, entity_type, entity_id, locator, freshness_tier,
       check_interval_minutes, last_checked_at, last_hash, etag, last_modified, enabled, created_at)
     VALUES (?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,1,?)
     ON CONFLICT(id) DO UPDATE SET
       entity_type = excluded.entity_type,
       freshness_tier = excluded.freshness_tier,
       check_interval_minutes = excluded.check_interval_minutes`,
    id, sourceId, w.entityType, entityId, locator, w.freshnessTier, Math.round(interval), nowIso(),
  );
  return ok(id);
}

export function getWatch(db: Db, id: string): Watch | null {
  const row = db.get<Record<string, unknown>>('SELECT * FROM watches WHERE id = ?', id);
  return row ? rowToWatch(row) : null;
}

export function listWatches(db: Db, opts: { enabled?: boolean } = {}): Watch[] {
  const rows =
    opts.enabled === undefined
      ? db.all<Record<string, unknown>>('SELECT * FROM watches ORDER BY id')
      : db.all<Record<string, unknown>>(
          'SELECT * FROM watches WHERE enabled = ? ORDER BY id',
          opts.enabled ? 1 : 0,
        );
  return rows.map(rowToWatch);
}

/**
 * Enabled watches that are due. Deliberately computed in TypeScript rather than
 * SQL date arithmetic: the interval is per-row, and SQLite's datetime maths
 * would not survive the move to another engine.
 */
export function dueWatches(db: Db, now: string = nowIso()): Watch[] {
  const at = Date.parse(now);
  return listWatches(db, { enabled: true }).filter((w) => isDue(w, at));
}

export function isDue(watch: Watch, at: number): boolean {
  if (!watch.enabled) return false;
  if (watch.lastCheckedAt === null) return true;
  const last = Date.parse(watch.lastCheckedAt);
  if (!Number.isFinite(last)) return true;
  return last + watch.checkIntervalMinutes * 60_000 <= at;
}

/** Minutes a watch is past its due time. Negative means not yet due. */
export function overdueMinutes(watch: Watch, now: string = nowIso()): number {
  const at = Date.parse(now);
  if (watch.lastCheckedAt === null) return Number.POSITIVE_INFINITY;
  const due = Date.parse(watch.lastCheckedAt) + watch.checkIntervalMinutes * 60_000;
  return (at - due) / 60_000;
}

export function setWatchEnabled(db: Db, id: string, enabled: boolean): boolean {
  return db.run('UPDATE watches SET enabled = ? WHERE id = ?', enabled ? 1 : 0, id).changes > 0;
}

export interface WatchCheckPatch {
  lastCheckedAt: string;
  lastHash?: string | null;
  etag?: string | null;
  lastModified?: string | null;
}

/**
 * Record the outcome of a check. Only the keys actually present are written:
 * an errored scan must not clobber `last_hash`, and a 304 must not drop the
 * validators that earned it.
 */
export function recordWatchCheck(db: Db, id: string, patch: WatchCheckPatch): void {
  const sets = ['last_checked_at = ?'];
  const params: unknown[] = [patch.lastCheckedAt];
  if ('lastHash' in patch) {
    sets.push('last_hash = ?');
    params.push(patch.lastHash ?? null);
  }
  if ('etag' in patch) {
    sets.push('etag = ?');
    params.push(patch.etag ?? null);
  }
  if ('lastModified' in patch) {
    sets.push('last_modified = ?');
    params.push(patch.lastModified ?? null);
  }
  params.push(id);
  db.run(`UPDATE watches SET ${sets.join(', ')} WHERE id = ?`, ...params);
}

export function countWatches(db: Db): { total: number; enabled: number } {
  const row = db.get<{ total: number; enabled: number }>(
    'SELECT COUNT(*) AS total, COALESCE(SUM(enabled), 0) AS enabled FROM watches',
  );
  return { total: Number(row?.total ?? 0), enabled: Number(row?.enabled ?? 0) };
}

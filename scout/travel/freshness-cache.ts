/**
 * TTL cache over `live_data_cache`, implementing the base / periodic / live
 * tiers from `FRESHNESS_POLICY`.
 *
 * Three ages matter, and they come from the policy, never from a local number:
 *
 *   age < ttlSeconds            fresh    -> served, `stale: false`
 *   ttl <= age                  expired  -> `cacheGet` returns null, refetch
 *   staleAfterSeconds <= age    stale    -> flagged, and `cacheSweep` deletes
 *
 * `staleAfterSeconds` is always >= `ttlSeconds`, so the window between them is
 * "expired but still usable": `cacheGet` refuses it, but `withCache` will fall
 * back to it when the loader fails. That is the serve-stale-while-revalidate
 * failover Sentinel depends on — a dead upstream degrades the answer instead of
 * removing it.
 */

import type { Db } from '../db/index.ts';
import { jsonColumn } from '../db/index.ts';
import type { CacheEntry, FreshnessTier, Result } from '../contracts/index.ts';
import { ok, err, policyFor, isExpired, isStale, ageSeconds } from '../contracts/index.ts';
import { nowIso, plusSeconds } from '../runtime/clock.ts';
import { canonicalHash, canonicalJson, shortHash } from '../runtime/hash.ts';

interface CacheRow {
  cache_key: string;
  provider_id: string | null;
  tier: string;
  value_json: string;
  fetched_at: string;
  expires_at: string;
  hash: string;
  stale: number;
}

/**
 * Deterministic cache key: same provider + same request parts -> same key,
 * regardless of key order in `parts`.
 */
export function cacheKey(providerId: string, parts: Record<string, unknown>): string {
  return `${providerId}:${shortHash(canonicalJson(parts))}`;
}

function rowToEntry<T>(row: CacheRow, now: string): CacheEntry<T> {
  const tier = row.tier as FreshnessTier;
  return {
    key: row.cache_key,
    tier,
    value: jsonColumn<T>(row.value_json, null as unknown as T),
    fetchedAt: row.fetched_at,
    expiresAt: row.expires_at,
    hash: row.hash,
    stale: Number(row.stale) === 1 || isStale({ fetchedAt: row.fetched_at, tier }, now),
  };
}

function readRow(db: Db, key: string): CacheRow | undefined {
  return db.get<CacheRow>('SELECT * FROM live_data_cache WHERE cache_key = ?', key);
}

/**
 * Read an unexpired entry. Returns null when the entry is missing or past its
 * TTL. An entry that is past `staleAfterSeconds` but somehow still inside its
 * TTL is returned with `stale: true` rather than withheld.
 */
export function cacheGet<T>(db: Db, key: string): CacheEntry<T> | null {
  const row = readRow(db, key);
  if (!row) return null;
  const now = nowIso();
  if (isExpired({ expiresAt: row.expires_at }, now)) return null;
  return rowToEntry<T>(row, now);
}

export function cacheSet<T>(
  db: Db,
  key: string,
  tier: FreshnessTier,
  value: T,
  providerId?: string | null,
): CacheEntry<T> {
  const policy = policyFor(tier);
  const fetchedAt = nowIso();
  const expiresAt = plusSeconds(fetchedAt, policy.ttlSeconds);
  const hash = canonicalHash(value);
  db.run(
    `INSERT INTO live_data_cache
       (cache_key, provider_id, tier, value_json, fetched_at, expires_at, hash, stale)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(cache_key) DO UPDATE SET
       provider_id = excluded.provider_id, tier = excluded.tier,
       value_json = excluded.value_json, fetched_at = excluded.fetched_at,
       expires_at = excluded.expires_at, hash = excluded.hash, stale = 0`,
    key,
    providerId ?? null,
    tier,
    canonicalJson(value),
    fetchedAt,
    expiresAt,
    hash,
  );
  return { key, tier, value, fetchedAt, expiresAt, hash, stale: false };
}

export function cacheInvalidate(db: Db, key: string): boolean {
  return db.run('DELETE FROM live_data_cache WHERE cache_key = ?', key).changes > 0;
}

/**
 * Housekeeping pass.
 *
 *   expired      rows older than the tier's `staleAfterSeconds` are deleted:
 *                past that age they are no longer usable even as failover.
 *   markedStale  rows inside the stale window get `stale = 1` so a reader can
 *                see the flag without recomputing the age.
 */
export function cacheSweep(db: Db): { expired: number; markedStale: number } {
  const now = nowIso();
  const rows = db.all<CacheRow>('SELECT * FROM live_data_cache');
  let expired = 0;
  let markedStale = 0;
  db.transaction(() => {
    for (const row of rows) {
      const tier = row.tier as FreshnessTier;
      if (isStale({ fetchedAt: row.fetched_at, tier }, now)) {
        db.run('DELETE FROM live_data_cache WHERE cache_key = ?', row.cache_key);
        expired += 1;
        continue;
      }
      if (isExpired({ expiresAt: row.expires_at }, now) && Number(row.stale) !== 1) {
        db.run('UPDATE live_data_cache SET stale = 1 WHERE cache_key = ?', row.cache_key);
        markedStale += 1;
      }
    }
  });
  return { expired, markedStale };
}

/**
 * Read-through cache with stale failover.
 *
 *   hit                    -> { cached: true,  stale: entry.stale }
 *   miss + load ok         -> { cached: false, stale: false } and the value is stored
 *   miss + load fails      -> the last usable value, { cached: true, stale: true }
 *   miss + load fails + no usable value -> the loader's error
 */
export async function withCache<T>(
  db: Db,
  key: string,
  tier: FreshnessTier,
  providerId: string | null,
  load: () => Promise<Result<T>>,
): Promise<Result<{ value: T; cached: boolean; stale: boolean }>> {
  const hit = cacheGet<T>(db, key);
  if (hit) return ok({ value: hit.value, cached: true, stale: hit.stale });

  let loaded: Result<T>;
  try {
    loaded = await load();
  } catch (error) {
    loaded = err<T>('internal', `cache loader threw for ${key}`, { key, tier }, error);
  }

  if (loaded.ok) {
    cacheSet(db, key, tier, loaded.value, providerId);
    return ok({ value: loaded.value, cached: false, stale: false });
  }

  // Failover: an expired-but-not-yet-swept entry beats no answer at all.
  const row = readRow(db, key);
  if (row) {
    const now = nowIso();
    const rowTier = row.tier as FreshnessTier;
    if (ageSeconds(row.fetched_at, now) < policyFor(rowTier).staleAfterSeconds) {
      const entry = rowToEntry<T>(row, now);
      return ok({ value: entry.value, cached: true, stale: true });
    }
  }
  return { ok: false, error: loaded.error };
}

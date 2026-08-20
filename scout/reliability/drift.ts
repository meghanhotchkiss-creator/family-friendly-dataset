/**
 * Schema drift detection.
 *
 * A provider's payload shape is fingerprinted by `schemaFingerprintOf` (see
 * contracts/provider.ts) and every distinct fingerprint is remembered in
 * `schema_fingerprints`. The rule:
 *
 *   first fingerprint ever seen  -> BASELINE, not drift (nothing to drift from)
 *   a different fingerprint      -> DRIFT
 *   a fingerprint we already know -> not drift, just bump last_seen_at
 *
 * Re-seeing an old shape is deliberately not drift: providers legitimately
 * flip between shapes (optional blocks, A/B rollouts) and alerting on every
 * flap teaches everyone to ignore the alert.
 */

import type { Db } from '../db/index.ts';
import type { SchemaFingerprintRecord } from '../contracts/index.ts';
import { nowIso } from '../runtime/clock.ts';
import { shortHash } from '../runtime/hash.ts';

interface FingerprintRow {
  id: string;
  provider_id: string;
  fingerprint: string;
  first_seen_at: string;
  last_seen_at: string;
}

function rowToRecord(row: FingerprintRow): SchemaFingerprintRecord {
  return {
    id: String(row.id),
    providerId: String(row.provider_id),
    fingerprint: String(row.fingerprint),
    firstSeenAt: String(row.first_seen_at),
    lastSeenAt: String(row.last_seen_at),
  };
}

/** Deterministic id: one row per (provider, fingerprint), matching the UNIQUE key. */
export function fingerprintId(providerId: string, fingerprint: string): string {
  return `fingerprint:${shortHash(`${providerId}|${fingerprint}`)}`;
}

/** Newest-seen first, so [0] is the current shape. */
export function listFingerprints(db: Db, providerId: string): SchemaFingerprintRecord[] {
  const rows = db.all<FingerprintRow>(
    `SELECT * FROM schema_fingerprints WHERE provider_id = ?
     ORDER BY last_seen_at DESC, first_seen_at DESC, id ASC`,
    providerId,
  );
  return rows.map(rowToRecord);
}

/**
 * Read-only. `previous` is the most recently seen fingerprint that DIFFERS
 * from the one supplied (null when the provider has none), so on a drift it is
 * exactly the shape we drifted away from.
 */
export function detectDrift(
  db: Db,
  providerId: string,
  fingerprint: string,
): { drifted: boolean; previous: string | null; knownCount: number } {
  const known = listFingerprints(db, providerId);
  const knownCount = known.length;
  const previous = known.find((k) => k.fingerprint !== fingerprint)?.fingerprint ?? null;
  const alreadyKnown = known.some((k) => k.fingerprint === fingerprint);
  // Baseline: nothing recorded yet, so there is nothing to have drifted from.
  const drifted = knownCount > 0 && !alreadyKnown;
  return { drifted, previous, knownCount };
}

/**
 * Remember a fingerprint. `isNew` is true when this shape had never been seen
 * before (which for the very first one is the baseline, not drift).
 * `knownCount` is the number of distinct shapes known AFTER recording.
 */
export function recordFingerprint(
  db: Db,
  providerId: string,
  fingerprint: string,
): { isNew: boolean; knownCount: number } {
  const at = nowIso();
  const existing = db.get<{ id: string }>(
    'SELECT id FROM schema_fingerprints WHERE provider_id = ? AND fingerprint = ?',
    providerId,
    fingerprint,
  );
  db.run(
    `INSERT INTO schema_fingerprints (id, provider_id, fingerprint, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(provider_id, fingerprint) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    fingerprintId(providerId, fingerprint),
    providerId,
    fingerprint,
    at,
    at,
  );
  const count = db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM schema_fingerprints WHERE provider_id = ?',
    providerId,
  );
  return { isNew: existing === undefined, knownCount: count ? Number(count.n) : 0 };
}

/**
 * Top-level key diff between two shape strings from `schemaFingerprintOf`.
 *
 * The format is `{key:type,key:type}` with arbitrary nesting; nested commas
 * and colons are skipped by depth-tracking rather than by a regex, and an
 * array wrapper (`[{...}]`) is unwrapped so a list payload diffs on its item
 * keys. Anything that is not an object shape yields no keys instead of
 * throwing.
 */
export function fingerprintDiff(a: string, b: string): { added: string[]; removed: string[] } {
  const keysA = topLevelKeys(a);
  const keysB = topLevelKeys(b);
  const added = [...keysB].filter((k) => !keysA.has(k)).sort();
  const removed = [...keysA].filter((k) => !keysB.has(k)).sort();
  return { added, removed };
}

/** Exported for callers that want the key set itself (health detail lines). */
export function topLevelKeys(shape: string): Set<string> {
  const out = new Set<string>();
  let s = (shape ?? '').trim();
  // Unwrap array wrappers: [ {..} ] describes a list of items with those keys.
  while (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1).trim();
  if (!s.startsWith('{') || !s.endsWith('}')) return out;
  const body = s.slice(1, -1);
  let depth = 0;
  let start = 0;
  const segments: string[] = [];
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) {
      segments.push(body.slice(start, i));
      start = i + 1;
    }
  }
  segments.push(body.slice(start));
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    let d = 0;
    let key = trimmed;
    for (let i = 0; i < trimmed.length; i += 1) {
      const c = trimmed[i];
      if (c === '{' || c === '[') d += 1;
      else if (c === '}' || c === ']') d = Math.max(0, d - 1);
      else if (c === ':' && d === 0) {
        key = trimmed.slice(0, i);
        break;
      }
    }
    const cleaned = key.trim();
    if (cleaned) out.add(cleaned);
  }
  return out;
}

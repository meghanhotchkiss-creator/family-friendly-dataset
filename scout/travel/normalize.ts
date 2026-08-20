/**
 * The normalisation pipeline (`npm run travel:normalize`).
 *
 * Runs after the importers have populated `places`, and is idempotent: running
 * it twice changes nothing the second time. Four passes, in this order:
 *
 *   1. dedupe        merge places in the same city whose names normalise equal
 *   2. enrich        fill null touristiness / local_favor from row signals
 *   3. hash          recompute canonical_hash so Radar change detection works
 *   4. link          attach orphan places to their nearest neighbourhood
 *
 * Dedupe runs first so the later passes never spend work on a row that is
 * about to disappear, and the whole run happens in one transaction so a failure
 * cannot leave half-merged duplicates behind.
 */

import type { Db } from '../db/index.ts';
import type { Place, PlaceCategory, PriceTier, Result } from '../contracts/index.ts';
import { ok, err, clamp01 } from '../contracts/index.ts';
import { computeCanonicalHash, rowToPlace } from '../db/repo-places.ts';
import { nowIso } from '../runtime/clock.ts';
import { startJob, finishJob } from './jobs.ts';

export interface NormalizeStats {
  scanned: number;
  deduped: number;
  hashed: number;
  enriched: number;
  neighborhoodsLinked: number;
  issues: string[];
}

/** Keep the issue list bounded: it is a diagnostic, not a log. */
const MAX_ISSUES = 40;

/** Neighbourhood linking radius. Beyond this a place is left unlinked. */
const LINK_RADIUS_KM = 3;

const LEADING_ARTICLES: ReadonlySet<string> = new Set([
  'the', 'le', 'la', 'les', 'el', 'los', 'las', 'il', 'lo', 'de', 'het', 'der', 'die', 'das',
]);

/** Trailing words that describe the category, not the identity, of a place. */
const GENERIC_SUFFIXES: ReadonlySet<string> = new Set([
  'museum', 'museo', 'musee', 'park', 'parc', 'parque', 'gardens', 'garden', 'zoo', 'aquarium',
  'library', 'beach', 'market', 'cafe', 'restaurant', 'center', 'centre', 'gallery', 'trail',
  'playground', 'plaza', 'square',
]);

/**
 * Canonical comparison form of a place name.
 *
 * lowercase -> strip diacritics -> drop apostrophes -> punctuation to space ->
 * collapse whitespace -> drop a leading article -> drop trailing generic words,
 * each only while at least one word remains. "The Louvre Museum" and
 * "Louvre, Le" both land on "louvre"; a place actually called "Museum" stays
 * "museum".
 */
export function normalizeName(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’ʼ`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!base) return '';

  let tokens = base.split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && LEADING_ARTICLES.has(tokens[0] as string)) tokens = tokens.slice(1);
  while (tokens.length > 1 && GENERIC_SUFFIXES.has(tokens[tokens.length - 1] as string)) {
    tokens = tokens.slice(0, -1);
  }
  // A trailing article ("Louvre, Le") is noise too, once punctuation is gone.
  while (tokens.length > 1 && LEADING_ARTICLES.has(tokens[tokens.length - 1] as string)) {
    tokens = tokens.slice(0, -1);
  }
  return tokens.join(' ');
}

/**
 * How touristy a category reads before any row-level evidence. 0..1.
 * These are priors, not measurements: the row's own rating and its city's size
 * move the final number away from them.
 */
const CATEGORY_TOURISTINESS: Readonly<Record<PlaceCategory, number>> = {
  landmark: 0.9, theme_park: 0.9, viewpoint: 0.8, historic_site: 0.75, museum: 0.7,
  aquarium: 0.65, zoo: 0.6, science_center: 0.55, market: 0.55, beach: 0.5, garden: 0.45,
  restaurant: 0.4, park: 0.35, trail: 0.3, cafe: 0.25, transit: 0.2, library: 0.15,
  playground: 0.1,
};

/** How much locals actually use a category, independent of tourist pressure. */
const CATEGORY_LOCAL: Readonly<Record<PlaceCategory, number>> = {
  playground: 0.95, library: 0.9, park: 0.9, cafe: 0.85, trail: 0.75, market: 0.7,
  garden: 0.7, beach: 0.65, restaurant: 0.6, transit: 0.5, museum: 0.45, science_center: 0.45,
  zoo: 0.4, aquarium: 0.35, historic_site: 0.35, viewpoint: 0.3, landmark: 0.25,
  theme_park: 0.2,
};

const PRICE_LOCAL: Readonly<Record<PriceTier, number>> = {
  free: 0.9, $: 0.8, $$: 0.55, $$$: 0.3,
};

/** Log-scaled "how big is this city's catalogue", 0..1 (~100 places saturates). */
function cityScale(cityPlaceCount: number): number {
  return clamp01(Math.log10(1 + Math.max(0, cityPlaceCount)) / 2);
}

/** Rating on 0..1, with a neutral 0.5 when the row has no rating. */
function ratingSignal(rating: number | null): number {
  return rating === null ? 0.5 : clamp01(rating / 5);
}

/**
 * touristiness = 0.55*category + 0.30*(rating * cityScale) + 0.15*cityScale
 *
 * The rating term is multiplied by city scale on purpose: a 4.8 in a city with
 * 200 catalogued places is a tourist magnet, a 4.8 in a town with three places
 * is just a good local spot. The bare cityScale term is the crowd baseline —
 * everything in a major destination gets some tourist traffic.
 */
export function deriveTouristiness(place: Place, cityPlaceCount: number): number {
  const category = CATEGORY_TOURISTINESS[place.category] ?? 0.5;
  const scale = cityScale(cityPlaceCount);
  return clamp01(0.55 * category + 0.3 * ratingSignal(place.rating) * scale + 0.15 * scale);
}

/**
 * localFavor = 0.35*(1 - touristiness) + 0.35*categoryLocal + 0.20*priceLocal
 *              + 0.10*rating
 *
 * Deliberately NOT `1 - touristiness`: the two answer different questions.
 * Inverse touristiness is only a third of the weight, so a great free city park
 * scores high on both — packed with visitors AND the place locals take their
 * kids. Price carries real signal: a $$$ ticket prices locals out of a repeat
 * visit however good it is; free keeps them coming back.
 */
export function deriveLocalFavor(place: Place, touristiness: number): number {
  const categoryLocal = CATEGORY_LOCAL[place.category] ?? 0.5;
  const priceLocal = place.priceTier === null ? 0.6 : PRICE_LOCAL[place.priceTier] ?? 0.6;
  return clamp01(
    0.35 * (1 - clamp01(touristiness)) +
      0.35 * categoryLocal +
      0.2 * priceLocal +
      0.1 * ratingSignal(place.rating),
  );
}

/** Great-circle distance in kilometres. */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371.0088;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Tables that point at a place and must follow the survivor of a merge. */
const COMPOSITE_KEY_LINKS = [
  { table: 'place_topics', columns: 'place_id, topic_id, weight, source', rest: 'topic_id, weight, source' },
  { table: 'place_vibes', columns: 'place_id, vibe_id, weight', rest: 'vibe_id, weight' },
  { table: 'place_transit', columns: 'place_id, stop_id, walk_minutes', rest: 'stop_id, walk_minutes' },
] as const;

const SIMPLE_KEY_LINKS = ['user_signals', 'trip_items'] as const;

function nonNullFieldCount(row: Record<string, unknown>): number {
  let n = 0;
  for (const value of Object.values(row)) if (value !== null && value !== undefined) n += 1;
  return n;
}

function dedupe(db: Db, stats: NormalizeStats): void {
  const rows = db.all<Record<string, unknown>>('SELECT * FROM places');
  stats.scanned = rows.length;

  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const key = `${String(row.city_id)}|${normalizeName(String(row.name))}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  for (const [key, bucket] of groups) {
    if (bucket.length < 2) continue;
    // Winner: most populated row, ties broken by the lexicographically smaller id
    // so the merge is deterministic across runs.
    const sorted = [...bucket].sort((a, b) => {
      const diff = nonNullFieldCount(b) - nonNullFieldCount(a);
      return diff !== 0 ? diff : String(a.id).localeCompare(String(b.id));
    });
    const winner = sorted[0];
    if (!winner) continue;
    const winnerId = String(winner.id);

    for (const loser of sorted.slice(1)) {
      const loserId = String(loser.id);
      for (const link of COMPOSITE_KEY_LINKS) {
        db.run(
          `INSERT OR IGNORE INTO ${link.table} (${link.columns})
           SELECT ?, ${link.rest} FROM ${link.table} WHERE place_id = ?`,
          winnerId,
          loserId,
        );
        db.run(`DELETE FROM ${link.table} WHERE place_id = ?`, loserId);
      }
      for (const table of SIMPLE_KEY_LINKS) {
        db.run(`UPDATE ${table} SET place_id = ? WHERE place_id = ?`, winnerId, loserId);
      }
      db.run('DELETE FROM places WHERE id = ?', loserId);
      stats.deduped += 1;
      if (stats.issues.length < MAX_ISSUES) {
        stats.issues.push(`merged ${loserId} into ${winnerId} (${key.split('|')[1] ?? ''})`);
      }
    }
  }
}

function enrich(db: Db, stats: NormalizeStats): void {
  const counts = new Map<string, number>();
  for (const row of db.all<{ city_id: string; n: number }>(
    'SELECT city_id, COUNT(*) AS n FROM places GROUP BY city_id',
  )) {
    counts.set(String(row.city_id), Number(row.n));
  }

  const rows = db.all<Record<string, unknown>>(
    'SELECT * FROM places WHERE touristiness IS NULL OR local_favor IS NULL',
  );
  for (const row of rows) {
    const place = rowToPlace(row);
    if (!(place.category in CATEGORY_TOURISTINESS) && stats.issues.length < MAX_ISSUES) {
      stats.issues.push(`unknown category ${place.category} on ${place.id}, using neutral priors`);
    }
    const cityCount = counts.get(place.cityId) ?? 1;
    const touristiness = place.touristiness ?? deriveTouristiness(place, cityCount);
    const localFavor = place.localFavor ?? deriveLocalFavor(place, touristiness);
    db.run(
      'UPDATE places SET touristiness = ?, local_favor = ?, updated_at = ? WHERE id = ?',
      touristiness,
      localFavor,
      nowIso(),
      place.id,
    );
    stats.enriched += 1;
  }
}

/** `hashed` counts rows whose canonical hash was missing or had drifted. */
function rehash(db: Db, stats: NormalizeStats): void {
  for (const row of db.all<Record<string, unknown>>('SELECT * FROM places')) {
    const place = rowToPlace(row);
    const hash = computeCanonicalHash(place);
    if (place.canonicalHash === hash) continue;
    db.run('UPDATE places SET canonical_hash = ? WHERE id = ?', hash, place.id);
    stats.hashed += 1;
  }
}

function linkNeighborhoods(db: Db, stats: NormalizeStats): void {
  const orphans = db.all<{ id: string; city_id: string; lat: number; lon: number }>(
    `SELECT id, city_id, lat, lon FROM places
     WHERE neighborhood_id IS NULL AND lat IS NOT NULL AND lon IS NOT NULL
       -- A city centroid is a real coordinate and a useless one for "nearest":
       -- linking on it would put every place in the city in one neighbourhood.
       AND location_precision = 'venue'`,
  );
  // Report imprecise coordinates before the early return: a database where
  // EVERY place is a centroid has nothing to link and most needs the warning.
  const imprecise = db.get<{ n: number }>(
    `SELECT COUNT(*) n FROM places
     WHERE neighborhood_id IS NULL AND lat IS NOT NULL
       AND (location_precision IS NULL OR location_precision <> 'venue')`,
  );
  if (imprecise && imprecise.n > 0) {
    stats.issues.push(
      `${imprecise.n} place(s) skipped for neighborhood linking: coordinates are a ` +
        `city centroid, not the venue. Run a geocoding pass to upgrade them.`,
    );
  }

  if (orphans.length === 0) return;

  const byCity = new Map<string, { id: string; lat: number; lon: number }[]>();
  for (const n of db.all<{ id: string; city_id: string; lat: number; lon: number }>(
    'SELECT id, city_id, lat, lon FROM neighborhoods WHERE lat IS NOT NULL AND lon IS NOT NULL',
  )) {
    const bucket = byCity.get(String(n.city_id)) ?? [];
    bucket.push({ id: String(n.id), lat: Number(n.lat), lon: Number(n.lon) });
    byCity.set(String(n.city_id), bucket);
  }

  let unreachable = 0;
  for (const place of orphans) {
    const candidates = byCity.get(String(place.city_id));
    if (!candidates || candidates.length === 0) continue;
    let best: { id: string; km: number } | null = null;
    for (const candidate of candidates) {
      const km = haversineKm(Number(place.lat), Number(place.lon), candidate.lat, candidate.lon);
      if (!best || km < best.km) best = { id: candidate.id, km };
    }
    if (!best || best.km > LINK_RADIUS_KM) {
      unreachable += 1;
      continue;
    }
    db.run(
      'UPDATE places SET neighborhood_id = ?, updated_at = ? WHERE id = ?',
      best.id,
      nowIso(),
      place.id,
    );
    stats.neighborhoodsLinked += 1;
  }
  if (unreachable > 0 && stats.issues.length < MAX_ISSUES) {
    stats.issues.push(`${unreachable} place(s) had no neighborhood within ${LINK_RADIUS_KM}km`);
  }
}

/**
 * Recorded in `job_runs` under `travel:normalize`.
 *
 * The ledger calls are written out rather than using `runJob`, because the
 * declared contract for this function is synchronous (`Result<NormalizeStats>`,
 * not a promise) while `runJob` is async. The rows written are identical.
 */
export function normalizePlaces(db: Db): Result<NormalizeStats> {
  const stats: NormalizeStats = {
    scanned: 0, deduped: 0, hashed: 0, enriched: 0, neighborhoodsLinked: 0, issues: [],
  };
  const runId = startJob(db, 'travel:normalize');
  try {
    db.transaction(() => {
      dedupe(db, stats);
      enrich(db, stats);
      rehash(db, stats);
      linkNeighborhoods(db, stats);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finishJob(db, runId, 'failed', { ...stats }, message);
    return err('internal', `travel:normalize failed: ${message}`, { runId }, error);
  }
  finishJob(db, runId, 'ok', { ...stats });
  return ok(stats);
}

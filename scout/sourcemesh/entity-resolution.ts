/**
 * Entity resolution across sources.
 *
 * The governing rule: never merge on name alone. The live data makes the case
 * -- there are nine distinct Springfields in the United States, and merging
 * them would destroy the graph. Name is the BLOCKING key (cheap candidate
 * generation); geography is the DECISION.
 *
 * Measured over 6,579 same-country same-name city pairs, the distribution is
 * cleanly bimodal: 4,043 pairs under 25km (one city seen twice) and 2,149 over
 * 200km (different cities sharing a name), with 387 in between. Those figures
 * set the thresholds below, and the ambiguous middle becomes POSSIBLE_MATCH
 * rather than a coin flip.
 *
 * admin1 is deliberately NOT used as a discriminator. GeoNames encodes it
 * numerically ("08") and the airport feed uses postal abbreviations ("CA"), so
 * it agrees on exactly 0 of those 6,579 pairs. Treating disagreement as
 * evidence of difference would reject nearly every true match.
 */

import type { Db } from '../db/index.ts';
import type { Confidence, Result } from '../contracts/index.ts';
import { ok, computeConfidence, SOURCE_AUTHORITY } from '../contracts/index.ts';
import { nowIso } from '../runtime/clock.ts';
import { shortHash } from '../runtime/hash.ts';

export const MATCH_STATES = ['MATCH', 'POSSIBLE_MATCH', 'NO_MATCH'] as const;
export type MatchState = (typeof MATCH_STATES)[number];

/** Both rows assert a region: only very close pairs are the same city. */
export const MATCH_KM = 25;

/**
 * One row is a STUB (no admin1 -- typically derived from an airport's
 * municipality field). It asserts no region, so it carries no evidence
 * contradicting the other row, and proximity alone can decide.
 *
 * Measured over the 387 ambiguous pairs: 309 have a stub on one side and are
 * true duplicates (ae-du-dubai/ae-dubai, us-ms-meridian/us-meridian), while
 * the 78 where BOTH assert a region include Salem MA vs Salem NH and Ridgewood
 * NJ vs Ridgewood NY -- genuinely different towns that must never merge.
 */
export const STUB_MATCH_KM = 75;
/** Beyond this, a shared name is a coincidence, not an identity. */
export const NO_MATCH_KM = 200;

export interface MatchEvidence {
  distanceKm: number;
  nameExact: boolean;
  aliasOverlap: boolean;
  populationRatio: number | null;
  /** Recorded for audit, never used to decide -- see the file header. */
  admin1: { left: string | null; right: string | null; comparable: boolean };
}

export interface CandidatePair {
  leftId: string;
  rightId: string;
  name: string;
  state: MatchState;
  score: number;
  confidence: Confidence;
  evidence: MatchEvidence;
}

const R_KM = 6371;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.sqrt(h));
}

export function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Decide a pair. Distance dominates; the other signals only move a pair inside
 * the ambiguous band, never across the confident ones.
 */
export function classifyPair(evidence: MatchEvidence): { state: MatchState; score: number } {
  const { distanceKm, nameExact, aliasOverlap, populationRatio } = evidence;

  if (!nameExact && !aliasOverlap) return { state: 'NO_MATCH', score: 0 };
  if (distanceKm > NO_MATCH_KM) return { state: 'NO_MATCH', score: 0 };

  // A stub asserts no region, so it cannot contradict the other row.
  const oneIsStub = !evidence.admin1.left || !evidence.admin1.right;
  const matchLimit = oneIsStub ? STUB_MATCH_KM : MATCH_KM;

  // 1 at zero distance, decaying to 0 at the no-match boundary.
  const proximity = Math.max(0, 1 - distanceKm / NO_MATCH_KM);
  let score = proximity * 0.8 + (nameExact ? 0.15 : 0.05) + (aliasOverlap ? 0.05 : 0);

  // A wildly different population is weak evidence against, not a veto: the two
  // sources may be measuring city proper versus metro area.
  if (populationRatio !== null && populationRatio < 0.1) score -= 0.1;
  score = Math.max(0, Math.min(1, score));

  if (distanceKm <= matchLimit) return { state: 'MATCH', score };
  // Both rows assert a region and disagree. That may be two different towns
  // (Salem MA vs Salem NH) or one city under two encodings (cn-23 vs cn-sh
  // Shanghai). Since those are indistinguishable from here, neither is merged.
  return { state: 'POSSIBLE_MATCH', score };
}

function parseAliases(value: unknown): Set<string> {
  if (typeof value !== 'string' || value === '') return new Set();
  return new Set(value.split(';').map((a) => normalizeName(a)).filter(Boolean));
}

export interface ResolveStats {
  candidatePairs: number;
  match: number;
  possibleMatch: number;
  noMatch: number;
}

/**
 * Generate and classify candidate city pairs.
 *
 * Blocking on (country, normalised name) keeps this from being a 50,000-squared
 * comparison; only pairs that already share a country and a name are scored.
 */
export function resolveCities(db: Db, opts: { limit?: number } = {}): Result<ResolveStats> {
  const rows = db.all<Record<string, unknown>>(
    `SELECT a.id AS a_id, b.id AS b_id, a.name AS name,
            a.lat AS a_lat, a.lon AS a_lon, b.lat AS b_lat, b.lon AS b_lon,
            a.admin1 AS a_admin1, b.admin1 AS b_admin1,
            a.population AS a_pop, b.population AS b_pop
     FROM cities a
     JOIN cities b
       ON a.country_id = b.country_id
      AND lower(a.name) = lower(b.name)
      AND a.id < b.id
     ${opts.limit ? 'LIMIT ' + Number(opts.limit) : ''}`,
  );

  const stats: ResolveStats = { candidatePairs: rows.length, match: 0, possibleMatch: 0, noMatch: 0 };
  const decidedAt = nowIso();

  db.transaction(() => {
    for (const row of rows) {
      const aLat = Number(row.a_lat), aLon = Number(row.a_lon);
      const bLat = Number(row.b_lat), bLon = Number(row.b_lon);
      const distanceKm = Number.isFinite(aLat) && Number.isFinite(bLat)
        ? haversineKm(aLat, aLon, bLat, bLon)
        : Number.POSITIVE_INFINITY;

      const aPop = row.a_pop === null ? null : Number(row.a_pop);
      const bPop = row.b_pop === null ? null : Number(row.b_pop);
      const populationRatio =
        aPop && bPop && aPop > 0 && bPop > 0 ? Math.min(aPop, bPop) / Math.max(aPop, bPop) : null;

      const left = String(row.a_admin1 ?? '') || null;
      const right = String(row.b_admin1 ?? '') || null;

      const evidence: MatchEvidence = {
        distanceKm: Number.isFinite(distanceKm) ? Number(distanceKm.toFixed(3)) : -1,
        nameExact: true,
        aliasOverlap: false,
        populationRatio: populationRatio === null ? null : Number(populationRatio.toFixed(3)),
        admin1: {
          left, right,
          // Both present and encoded the same way; see the header.
          comparable: Boolean(left && right && left.length === right.length),
        },
      };

      const { state, score } = classifyPair(evidence);
      // Two independent open datasets agreeing is the evidence here.
      const confidence = computeConfidence({
        authorities: state === 'NO_MATCH' ? [] : [SOURCE_AUTHORITY.open_dataset, SOURCE_AUTHORITY.open_dataset],
        verification: state === 'MATCH' ? 'auto_verified' : 'unverified',
      });

      if (state === 'MATCH') stats.match += 1;
      else if (state === 'POSSIBLE_MATCH') stats.possibleMatch += 1;
      else stats.noMatch += 1;

      db.run(
        `INSERT INTO entity_matches (id, entity_type, left_source, left_key, right_entity,
           state, score, evidence_json, decided_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(entity_type, left_key, right_entity) DO UPDATE SET
           state = excluded.state,
           score = excluded.score, evidence_json = excluded.evidence_json,
           decided_at = excluded.decided_at`,
        `em_${shortHash(`city|${String(row.a_id)}|${String(row.b_id)}`)}`,
        'city', 'cities', String(row.a_id), String(row.b_id),
        state, Number(score.toFixed(4)),
        JSON.stringify({ ...evidence, confidence: confidence.value }), decidedAt,
      );
    }
  });

  return ok(stats);
}

export interface MergeStats {
  merged: number;
  airportsRepointed: number;
  placesRepointed: number;
  skipped: number;
}

/**
 * Merge confirmed duplicates.
 *
 * Only MATCH is merged. POSSIBLE_MATCH is left for review precisely because an
 * automatic decision there is the one that quietly corrupts the graph.
 *
 * The survivor is the richer record -- population, timezone and aliases are
 * what a city row is for, and the airport-derived stub has none of them.
 */
export function mergeMatches(db: Db): Result<MergeStats> {
  const stats: MergeStats = { merged: 0, airportsRepointed: 0, placesRepointed: 0, skipped: 0 };

  const matches = db.all<{ left_key: string; right_entity: string }>(
    "SELECT left_key, right_entity FROM entity_matches WHERE entity_type = 'city' AND state = 'MATCH'",
  );

  db.transaction(() => {
    for (const match of matches) {
      const a = db.get<Record<string, unknown>>('SELECT * FROM cities WHERE id = ?', match.left_key);
      const b = db.get<Record<string, unknown>>('SELECT * FROM cities WHERE id = ?', match.right_entity);
      if (!a || !b) { stats.skipped += 1; continue; }

      const richness = (row: Record<string, unknown>) =>
        (row.population === null ? 0 : 1) + (row.timezone === null ? 0 : 1) + (row.admin1 === null ? 0 : 1);
      // Tie-break on id so a merge is deterministic across runs.
      const [survivor, loser] =
        richness(a) > richness(b) || (richness(a) === richness(b) && String(a.id) < String(b.id))
          ? [a, b] : [b, a];

      const survivorId = String(survivor.id);
      const loserId = String(loser.id);

      stats.airportsRepointed += db.run(
        'UPDATE airports SET city_id = ? WHERE city_id = ?', survivorId, loserId,
      ).changes;
      stats.placesRepointed += db.run(
        'UPDATE places SET city_id = ? WHERE city_id = ?', survivorId, loserId,
      ).changes;
      db.run('UPDATE users SET home_city_id = ? WHERE home_city_id = ?', survivorId, loserId);
      db.run('UPDATE trips SET destination_city_id = ? WHERE destination_city_id = ?', survivorId, loserId);
      db.run('UPDATE neighborhoods SET city_id = ? WHERE city_id = ?', survivorId, loserId);
      db.run('UPDATE gtfs_feeds SET city_id = ? WHERE city_id = ?', survivorId, loserId);

      db.run('DELETE FROM cities WHERE id = ?', loserId);
      stats.merged += 1;
    }
  });

  return ok(stats);
}

export function matchSummary(db: Db): Record<string, number> {
  const out: Record<string, number> = { MATCH: 0, POSSIBLE_MATCH: 0, NO_MATCH: 0 };
  for (const row of db.all<{ state: string; n: number }>(
    'SELECT state, COUNT(*) n FROM entity_matches GROUP BY state',
  )) {
    out[row.state] = Number(row.n);
  }
  return out;
}

export interface ExactLinkStats {
  linked: number;
  alreadyCorrect: number;
  noCityRow: number;
}

/**
 * Link airports to cities by GeoNames id.
 *
 * This is identity, not similarity: OpenTravelData publishes the GeoNames id of
 * the city an airport serves, and GeoNames publishes the same id on the city
 * itself. Where both are present there is nothing to infer, so this runs before
 * any name-and-distance matching and its results are never second-guessed by it.
 */
export function linkAirportsByGeonameId(db: Db): Result<ExactLinkStats> {
  const stats: ExactLinkStats = { linked: 0, alreadyCorrect: 0, noCityRow: 0 };

  const rows = db.all<{ airport_id: string; city_id: string | null; target: string | null }>(
    `SELECT a.id AS airport_id, a.city_id AS city_id,
            (SELECT c.id FROM cities c WHERE c.geoname_id = a.city_geoname_id LIMIT 1) AS target
     FROM airports a
     WHERE a.city_geoname_id IS NOT NULL`,
  );

  db.transaction(() => {
    for (const row of rows) {
      if (!row.target) { stats.noCityRow += 1; continue; }
      if (row.city_id === row.target) { stats.alreadyCorrect += 1; continue; }
      db.run('UPDATE airports SET city_id = ? WHERE id = ?', row.target, row.airport_id);
      stats.linked += 1;
    }
  });

  return ok(stats);
}

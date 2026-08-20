/**
 * Travel friction: how unpleasant an itinerary is, independent of price.
 *
 * 0 is a civilised nonstop; 1 is a two-stop red-eye that lands at 4am. Cheap
 * award space is often cheap precisely because the itinerary is punishing, and
 * a family with a toddler pays for that in a currency points cannot cover, so
 * friction is scored separately and never folded into cents-per-point.
 *
 * The number is explained the same way the recommendation engine explains its
 * scores: every contribution is itemised in `factors`, and the factors SUM to
 * the score. If they ever disagree, the score is wrong, not the factors.
 *
 * Weights (chosen to total exactly 1.00 at the worst case, so the clamp never
 * has to silently discard a contribution):
 *
 *   stops              0.22 each, capped at 0.44 (2+ stops)
 *   duration           0..0.22, ramping from 3h to 15h of total travel
 *   red-eye departure  0.14  departing 22:00-04:59
 *   overnight          0.10  the itinerary spans a night
 *   small-hours arrival 0.10 landing 00:00-05:59
 *   -------------------------
 *   worst case         1.00
 *
 * Stops dominate because a connection is where itineraries actually fail, and
 * duration is a ramp rather than a step because the 6th hour hurts far less
 * than the 14th.
 */

import type { Db } from '../db/index.ts';
import type { Result, TravelFriction } from '../contracts/index.ts';
import { ok, err, clamp01 } from '../contracts/index.ts';
import { jsonColumn } from '../db/index.ts';
import { shortHash } from '../runtime/hash.ts';
import { nowIso } from '../runtime/clock.ts';

/**
 * A friction score that is not yet attached to a route. Derived from the
 * contract type rather than redefined, so the two can never drift.
 */
export type FrictionScore = Omit<TravelFriction, 'originAirportId' | 'destinationAirportId'>;

export const FRICTION_WEIGHTS = {
  perStop: 0.22,
  stopsCap: 0.44,
  duration: 0.22,
  redeye: 0.14,
  overnight: 0.1,
  smallHoursArrival: 0.1,
} as const;

/** Below this many minutes, duration contributes nothing. */
export const DURATION_EASY_MINUTES = 180;
/** At or above this many minutes, duration contributes its full weight. */
export const DURATION_HARD_MINUTES = 900;

/** Departures in [22:00, 05:00) are red-eyes. */
export function isRedeyeHour(hour: number): boolean {
  if (!Number.isFinite(hour)) return false;
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  return h >= 22 || h < 5;
}

/** Arrivals in [00:00, 06:00) are "small hours" landings. */
export function isSmallHoursArrival(hour: number): boolean {
  if (!Number.isFinite(hour)) return false;
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  return h < 6;
}

const EARTH_RADIUS_KM = 6371.0088;

/** Standard great-circle distance in kilometres. */
export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface FrictionInput {
  stops: number;
  totalMinutes: number;
  departureHour?: number;
  arrivalHour?: number;
  overnight?: boolean;
}

/**
 * Score an itinerary. Contributions are itemised and always sum to the score:
 * if the raw total ever exceeded 1 the factors would be scaled down together,
 * so the invariant survives even a future re-weighting.
 */
export function computeFriction(input: FrictionInput): FrictionScore {
  const stops = Number.isFinite(input.stops) && input.stops > 0 ? Math.floor(input.stops) : 0;
  const totalMinutes =
    Number.isFinite(input.totalMinutes) && input.totalMinutes > 0 ? Math.round(input.totalMinutes) : 0;
  const redeye = input.departureHour === undefined ? false : isRedeyeHour(input.departureHour);
  const smallHours = input.arrivalHour === undefined ? false : isSmallHoursArrival(input.arrivalHour);
  const overnight = input.overnight === true;

  const factors: { label: string; contribution: number }[] = [];

  const stopsContribution = Math.min(FRICTION_WEIGHTS.stopsCap, stops * FRICTION_WEIGHTS.perStop);
  if (stopsContribution > 0) {
    factors.push({
      label: `${stops} stop${stops === 1 ? '' : 's'}`,
      contribution: stopsContribution,
    });
  }

  const span = DURATION_HARD_MINUTES - DURATION_EASY_MINUTES;
  const durationRatio = clamp01((totalMinutes - DURATION_EASY_MINUTES) / span);
  const durationContribution = durationRatio * FRICTION_WEIGHTS.duration;
  if (durationContribution > 0) {
    factors.push({
      label: `${(totalMinutes / 60).toFixed(1)}h total travel`,
      contribution: durationContribution,
    });
  }

  if (redeye) {
    factors.push({ label: 'red-eye departure', contribution: FRICTION_WEIGHTS.redeye });
  }
  if (overnight) {
    factors.push({ label: 'overnight itinerary', contribution: FRICTION_WEIGHTS.overnight });
  }
  if (smallHours) {
    factors.push({ label: 'arrives in the small hours', contribution: FRICTION_WEIGHTS.smallHoursArrival });
  }

  const raw = factors.reduce((sum, f) => sum + f.contribution, 0);
  // The weights total 1.00 by construction, so this only fires if someone
  // re-weights carelessly. Scaling keeps factors-sum-to-score true regardless.
  if (raw > 1) {
    const scale = 1 / raw;
    for (const factor of factors) factor.contribution *= scale;
  }
  const score = clamp01(factors.reduce((sum, f) => sum + f.contribution, 0));

  return { stops, totalMinutes, overnight, redeye, score, factors };
}

/** Deterministic friction id: same route + same itinerary shape, same row. */
export function frictionIdFor(
  originAirportId: string,
  destinationAirportId: string,
  input: FrictionInput,
): string {
  return `fr_${shortHash(
    [
      originAirportId, destinationAirportId, input.stops, input.totalMinutes,
      input.departureHour ?? '-', input.arrivalHour ?? '-', input.overnight === true ? 1 : 0,
    ].join('|'),
  )}`;
}

export function rowToFriction(row: Record<string, unknown>): TravelFriction {
  return {
    originAirportId: String(row.origin_airport_id),
    destinationAirportId: String(row.destination_airport_id),
    stops: Number(row.stops),
    totalMinutes: Number(row.total_minutes),
    overnight: Number(row.overnight) === 1,
    redeye: Number(row.redeye) === 1,
    score: Number(row.score),
    factors: jsonColumn<{ label: string; contribution: number }[]>(row.factors_json, []),
  };
}

export function recordFriction(
  db: Db,
  originAirportId: string,
  destinationAirportId: string,
  input: FrictionInput,
): Result<TravelFriction> {
  const origin = db.get<{ id: string }>('SELECT id FROM airports WHERE id = ?', originAirportId);
  if (!origin) return err('not_found', `unknown origin airport ${originAirportId}`, { originAirportId });
  const dest = db.get<{ id: string }>('SELECT id FROM airports WHERE id = ?', destinationAirportId);
  if (!dest) {
    return err('not_found', `unknown destination airport ${destinationAirportId}`, { destinationAirportId });
  }

  const scored = computeFriction(input);
  const friction: TravelFriction = { originAirportId, destinationAirportId, ...scored };
  const id = frictionIdFor(originAirportId, destinationAirportId, input);

  try {
    db.run(
      `INSERT INTO travel_friction
         (id, origin_airport_id, destination_airport_id, stops, total_minutes,
          overnight, redeye, score, factors_json, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         stops = excluded.stops, total_minutes = excluded.total_minutes,
         overnight = excluded.overnight, redeye = excluded.redeye,
         score = excluded.score, factors_json = excluded.factors_json,
         computed_at = excluded.computed_at`,
      id, originAirportId, destinationAirportId, friction.stops, friction.totalMinutes,
      friction.overnight ? 1 : 0, friction.redeye ? 1 : 0, friction.score,
      JSON.stringify(friction.factors), nowIso(),
    );
  } catch (error) {
    return err('internal', `failed to write friction ${id}`, { id }, error);
  }

  return ok(friction);
}

/** The most recently computed friction for a route, if any. */
export function frictionBetween(
  db: Db,
  originAirportId: string,
  destinationAirportId: string,
): TravelFriction | null {
  const row = db.get<Record<string, unknown>>(
    `SELECT * FROM travel_friction
     WHERE origin_airport_id = ? AND destination_airport_id = ?
     ORDER BY computed_at DESC, score ASC LIMIT 1`,
    originAirportId, destinationAirportId,
  );
  return row ? rowToFriction(row) : null;
}

/**
 * User Graph: context-aware preference learning.
 *
 * `user_signals` is the ledger; `user_preferences` is a pure function of it.
 * Everything is recomputed from scratch, so the learner is idempotent and a bad
 * signal can be deleted rather than un-learned.
 *
 * The interesting part is context. A family that rejects a big outdoor park at
 * 5pm in the rain with a toddler in tow has not told us they dislike parks:
 * they told us something about rain, or bedtime, or the toddler. So a signal
 * carrying distinguishing circumstances is damped before it is allowed to teach
 * anything general. See `contextAttenuation`.
 */

import type { Db } from '../db/index.ts';
import { jsonColumn } from '../db/index.ts';
import { getPlace } from '../db/repo-places.ts';
import type {
  Confidence,
  PartyMember,
  PartyRole,
  Place,
  Preference,
  PreferenceDimension,
  Result,
  SignalContext,
  SignalKind,
  UserGraph,
  UserSignal,
} from '../contracts/index.ts';
import { ok, err, computeConfidence, SOURCE_AUTHORITY } from '../contracts/index.ts';
import { nowIso, daysBetween } from '../runtime/clock.ts';
import { shortHash } from '../runtime/hash.ts';

/** Behavioural evidence from one user sits at the `community` authority level. */
const SIGNAL_AUTHORITY = SOURCE_AUTHORITY.community;
/** Tastes drift; four months roughly halves the weight of old behaviour. */
const PREFERENCE_HALF_LIFE_DAYS = 120;

/** How much each signal kind says about liking the place, before attenuation. */
const POLARITY: Readonly<Record<SignalKind, number>> = {
  saved: 1.0,
  booked: 1.0,
  visited: 0.6,
  rated: 0, // the rating itself carries the sign, see polarityOf
  rejected: -1.0,
  viewed: 0.1,
};

const RATING_POLARITY: Readonly<Record<number, number>> = {
  1: -1.0,
  2: -0.5,
  3: 0,
  4: 0.5,
  5: 1.0,
};

export function polarityOf(kind: SignalKind, rating: number | null | undefined): number {
  if (kind === 'rated') {
    const r = rating === null || rating === undefined ? 3 : Math.round(rating);
    return RATING_POLARITY[r] ?? 0;
  }
  return POLARITY[kind];
}

/**
 * THE context rule.
 *
 * A "distinguishing circumstance" is a fact about the visit rather than about
 * the place: a child under five in the party, adverse weather (rain/snow/hot/
 * cold), or a specific time of day. Each one is an alternative explanation for
 * the signal, so the signal generalises less:
 *
 *   0 distinguishing factors -> 1.00  (nothing else to blame; full weight)
 *   1 distinguishing factor  -> 0.50  (half the evidence is about the context)
 *   2 or more                -> 0.35  (mostly about the context)
 *
 * `clear` weather and a neutral/absent context are NOT distinguishing: an
 * ordinary outing under ordinary conditions is exactly the case where the place
 * itself is the only explanation left.
 */
export function contextAttenuation(context: SignalContext | null | undefined): number {
  if (!context) return 1;
  let factors = 0;
  if (context.hasChildUnder5 === true) factors += 1;
  if (context.weather && context.weather !== 'clear') factors += 1;
  if (context.timeOfDay) factors += 1;
  if (factors === 0) return 1;
  if (factors === 1) return 0.5;
  return 0.35;
}

export function recordSignal(
  db: Db,
  signal: {
    userId: string;
    placeId: string;
    kind: SignalKind;
    rating?: number | null;
    context?: SignalContext;
  },
): Result<string> {
  const rating = signal.rating ?? null;
  if (rating !== null && (rating < 1 || rating > 5)) {
    return err('invalid_input', `rating must be 1..5, got ${rating}`, { rating });
  }
  const createdAt = nowIso();
  const context = signal.context ?? {};
  const id = `sig_${shortHash(
    `${signal.userId}|${signal.placeId}|${signal.kind}|${rating}|${JSON.stringify(context)}|${createdAt}`,
  )}`;
  try {
    db.run(
      `INSERT INTO user_signals (id, user_id, place_id, kind, rating, context_json, created_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(id) DO NOTHING`,
      id,
      signal.userId,
      signal.placeId,
      signal.kind,
      rating,
      JSON.stringify(context),
      createdAt,
    );
    return ok(id);
  } catch (error) {
    return err(
      'invalid_input',
      'could not record signal',
      { userId: signal.userId, placeId: signal.placeId },
      error,
    );
  }
}

export function listSignals(db: Db, userId: string): UserSignal[] {
  return db
    .all<Record<string, unknown>>(
      'SELECT * FROM user_signals WHERE user_id = ? ORDER BY created_at, id',
      userId,
    )
    .map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      placeId: String(row.place_id),
      kind: row.kind as SignalKind,
      rating: row.rating === null || row.rating === undefined ? null : Number(row.rating),
      context: jsonColumn<SignalContext>(row.context_json, {}),
      createdAt: String(row.created_at),
    }));
}

export function getParty(db: Db, userId: string): PartyMember[] {
  return db
    .all<Record<string, unknown>>('SELECT * FROM travel_party WHERE user_id = ? ORDER BY id', userId)
    .map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      label: String(row.label),
      role: row.role as PartyRole,
      age: row.age === null || row.age === undefined ? null : Number(row.age),
      needs: jsonColumn<string[]>(row.needs_json, []),
    }));
}

export function bucketTouristiness(value: number): string {
  return value < 0.34 ? 'low' : value < 0.67 ? 'medium' : 'high';
}

export function bucketDuration(minutes: number): string {
  return minutes < 90 ? 'short' : minutes < 180 ? 'medium' : 'long';
}

/**
 * The (dimension, value) pairs a place is evidence for. Every one of these is a
 * general trait: the user is not choosing "this place", they are choosing a
 * category, a price, a topic. That is why all of them are damped by the context
 * attenuation rather than only some of them.
 */
export function placeTraits(
  db: Db,
  place: Place,
): { dimension: PreferenceDimension; value: string }[] {
  const traits: { dimension: PreferenceDimension; value: string }[] = [
    { dimension: 'category', value: place.category },
  ];
  if (place.priceTier) traits.push({ dimension: 'price_tier', value: place.priceTier });
  if (place.indoorOutdoor) traits.push({ dimension: 'indoor_outdoor', value: place.indoorOutdoor });
  if (place.touristiness !== null) {
    traits.push({ dimension: 'touristiness', value: bucketTouristiness(place.touristiness) });
  }
  if (place.durationMinutes !== null) {
    traits.push({ dimension: 'duration', value: bucketDuration(place.durationMinutes) });
  }
  const topics = db.all<{ topic_id: string }>(
    'SELECT topic_id FROM place_topics WHERE place_id = ? ORDER BY topic_id',
    place.id,
  );
  for (const topic of topics) traits.push({ dimension: 'topic', value: String(topic.topic_id) });
  return traits;
}

interface Accumulator {
  dimension: PreferenceDimension;
  value: string;
  sum: number;
  count: number;
  newestAt: string;
}

/** Recompute every preference for one user from their raw signals. */
export function buildUserGraph(db: Db, userId: string): Result<UserGraph> {
  try {
    const signals = listSignals(db, userId);
    const now = nowIso();
    const accumulators = new Map<string, Accumulator>();
    const placeCache = new Map<string, Place | undefined>();

    for (const signal of signals) {
      if (!placeCache.has(signal.placeId)) {
        placeCache.set(signal.placeId, getPlace(db, signal.placeId));
      }
      const place = placeCache.get(signal.placeId);
      if (!place) continue;

      const polarity = polarityOf(signal.kind, signal.rating);
      const attenuated = polarity * contextAttenuation(signal.context);
      if (attenuated === 0) continue;

      for (const trait of placeTraits(db, place)) {
        const key = `${trait.dimension} ${trait.value}`;
        const existing = accumulators.get(key);
        if (existing) {
          existing.sum += attenuated;
          existing.count += 1;
          if (Date.parse(signal.createdAt) > Date.parse(existing.newestAt)) {
            existing.newestAt = signal.createdAt;
          }
        } else {
          accumulators.set(key, {
            dimension: trait.dimension,
            value: trait.value,
            sum: attenuated,
            count: 1,
            newestAt: signal.createdAt,
          });
        }
      }
    }

    const preferences: Preference[] = [...accumulators.values()]
      .sort((a, b) => {
        if (a.dimension !== b.dimension) return a.dimension < b.dimension ? -1 : 1;
        return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
      })
      .map((acc) => {
        // Smoothed mean: dividing by count+1 keeps a single signal from
        // saturating a preference, while repeated evidence still approaches 1.
        const weight = clampSigned(acc.sum / (acc.count + 1));
        const confidence = computeConfidence({
          authorities: new Array<number>(acc.count).fill(SIGNAL_AUTHORITY),
          ageDays: daysBetween(acc.newestAt, now),
          halfLifeDays: PREFERENCE_HALF_LIFE_DAYS,
        });
        return {
          id: `pref_${shortHash(`${userId}|${acc.dimension}|${acc.value}`)}`,
          userId,
          dimension: acc.dimension,
          value: acc.value,
          weight,
          confidence,
          evidenceCount: acc.count,
          updatedAt: now,
        };
      });

    db.transaction(() => {
      db.run('DELETE FROM user_preferences WHERE user_id = ?', userId);
      for (const pref of preferences) {
        db.run(
          `INSERT INTO user_preferences (id, user_id, dimension, value, weight, confidence,
             confidence_json, evidence_count, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          pref.id,
          pref.userId,
          pref.dimension,
          pref.value,
          pref.weight,
          pref.confidence.value,
          JSON.stringify(pref.confidence),
          pref.evidenceCount,
          pref.updatedAt,
        );
      }
    });

    return ok({ userId, preferences, party: getParty(db, userId), signalCount: signals.length });
  } catch (error) {
    return err('internal', `could not build user graph for ${userId}`, { userId }, error);
  }
}

export function rebuildAllUserGraphs(db: Db): Result<{ users: number; preferences: number }> {
  const rows = db.all<{ id: string }>('SELECT id FROM users ORDER BY id');
  let preferences = 0;
  for (const row of rows) {
    const result = buildUserGraph(db, String(row.id));
    if (!result.ok) {
      return err(result.error.kind, result.error.message, result.error.detail, result.error.cause);
    }
    preferences += result.value.preferences.length;
  }
  return ok({ users: rows.length, preferences });
}

export function getPreferences(db: Db, userId: string): Preference[] {
  return db
    .all<Record<string, unknown>>(
      'SELECT * FROM user_preferences WHERE user_id = ? ORDER BY dimension, value',
      userId,
    )
    .map(rowToPreference);
}

export function preferenceFor(
  db: Db,
  userId: string,
  dimension: PreferenceDimension,
  value: string,
): Preference | null {
  const row = db.get<Record<string, unknown>>(
    'SELECT * FROM user_preferences WHERE user_id = ? AND dimension = ? AND value = ?',
    userId,
    dimension,
    value,
  );
  return row ? rowToPreference(row) : null;
}

function rowToPreference(row: Record<string, unknown>): Preference {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    dimension: row.dimension as PreferenceDimension,
    value: String(row.value),
    weight: Number(row.weight),
    confidence: jsonColumn<Confidence>(row.confidence_json, computeConfidence({ authorities: [] })),
    evidenceCount: Number(row.evidence_count),
    updatedAt: String(row.updated_at),
  };
}

function clampSigned(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < -1 ? -1 : n > 1 ? 1 : n;
}

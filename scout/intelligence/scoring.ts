/**
 * Scout Mind's ranking.
 *
 * A score is a plain SUM of signed, labelled contributions. Nothing is hidden
 * in a magic blend: every number that moved a place up or down comes back as a
 * ScoreFactor with a human sentence attached, and the one-line explanation is
 * assembled from those same factors. If the ranking is wrong, the explanation
 * says exactly which factor was wrong.
 *
 * Fact quality is part of the ranking, not a footnote: a place whose fields
 * rest on one weak claim scores below an otherwise identical place whose fields
 * are corroborated, because recommending a well-described place is a better bet
 * than recommending a rumour.
 */

import type { Db } from '../db/index.ts';
import { jsonColumn } from '../db/index.ts';
import type {
  Confidence,
  Constraint,
  ConstraintKind,
  ParsedIntent,
  Place,
  Preference,
  Recommendation,
  RecommendationRequest,
  RecommendationResponse,
  ScoreFactor,
  FreshnessTier,
  VerificationState,
} from '../contracts/index.ts';
import {
  ok,
  err,
  computeConfidence,
  confidenceBand,
  policyFor,
  VERIFICATION_WEIGHT,
} from '../contracts/index.ts';
import type { Result } from '../contracts/index.ts';
import { listPlacesByCity } from '../db/repo-places.ts';
import { nowIso, daysBetween } from '../runtime/clock.ts';
import { parseIntent, biasFor } from './intent.ts';
import { getPreferences, bucketDuration, bucketTouristiness, getParty } from './user-graph.ts';
import { listResolutions } from './truth-engine.ts';

/*
 * Weights. All in the same score units, chosen so that:
 *   - what the user explicitly ASKED for (intent) outranks what we inferred
 *     from their history, which outranks generic quality signals like rating;
 *   - a hard mismatch on age is decisive, because taking a 3-year-old somewhere
 *     with a minimum age of 8 is not a ranking problem, it is a wasted day;
 *   - fact confidence is a tie-breaker sized to swing close calls (+-0.4), not
 *     to bury a place the user actually asked for.
 */
const W_TOPIC = 0.6;
const W_TOPIC_CAP = 1.8;
const W_TOURISTINESS = 1.0;
const W_PRICE = 0.6;
const W_INDOOR = 0.6;
const W_DURATION = 0.5;
const W_LOCAL = 1.2;
const W_PREFERENCE = 0.8;
const W_AGE_BLOCK = -0.9;
const W_AGE_FIT = 0.35;
const W_RATING = 0.5;
const W_TRUTH = 0.8;
const W_SOFT_CONSTRAINT = -0.6;
const W_HARD_VIOLATION = -10;

export interface ScoreContext {
  intent: ParsedIntent;
  preferences: Preference[];
  partyHasYoungChild: boolean;
  hardConstraints: Constraint[];
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function clampAbs(n: number, limit: number): number {
  return n < -limit ? -limit : n > limit ? limit : n;
}

function humanTopic(slug: string): string {
  return slug.replace(/^topic:/, '').replace(/-/g, ' ');
}

/** Topic slugs linked to a place, with their link weights. */
function placeTopicWeights(db: Db, placeId: string): Map<string, number> {
  const rows = db.all<{ topic_id: string; slug: string; weight: number }>(
    `SELECT pt.topic_id AS topic_id, t.slug AS slug, pt.weight AS weight
     FROM place_topics pt JOIN topics t ON t.id = pt.topic_id
     WHERE pt.place_id = ? ORDER BY t.slug`,
    placeId,
  );
  const out = new Map<string, number>();
  for (const row of rows) out.set(String(row.slug), Number(row.weight));
  return out;
}

const TIER_VOLATILITY: Readonly<Record<FreshnessTier, number>> = { base: 0, periodic: 1, live: 2 };

/**
 * How well-established are this place's facts?
 *
 * Built from the truth resolutions on the place: every distinct SOURCE behind
 * them contributes its authority once, and those authorities are combined with
 * `computeConfidence` (noisy-OR), never averaged. Deduping by source is what
 * keeps the number honest -- five fields from one seed source is one weak
 * source, not five corroborations.
 */
export function placeFactConfidence(db: Db, placeId: string): Confidence {
  const resolutions = listResolutions(db, placeId);
  if (resolutions.length === 0) return computeConfidence({ authorities: [] });

  const recordIds = new Set<string>();
  for (const resolution of resolutions) {
    recordIds.add(resolution.chosenRecordId);
    for (const id of resolution.agreeingRecordIds) recordIds.add(id);
  }
  if (recordIds.size === 0) return computeConfidence({ authorities: [] });

  const ids = [...recordIds];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.all<Record<string, unknown>>(
    `SELECT sr.source_id AS source_id, sr.observed_at AS observed_at,
            s.authority AS authority, s.freshness_tier AS freshness_tier
     FROM source_records sr JOIN sources s ON s.id = sr.source_id
     WHERE sr.id IN (${placeholders})`,
    ...ids,
  );

  const authorityBySource = new Map<string, number>();
  let tier: FreshnessTier = 'base';
  let oldestObservedAt: string | null = null;
  for (const row of rows) {
    const sourceId = String(row.source_id);
    const authority = Number(row.authority);
    const seen = authorityBySource.get(sourceId);
    if (seen === undefined || authority > seen) authorityBySource.set(sourceId, authority);
    const rowTier = row.freshness_tier as FreshnessTier;
    if (TIER_VOLATILITY[rowTier] > TIER_VOLATILITY[tier]) tier = rowTier;
    const observedAt = String(row.observed_at);
    if (oldestObservedAt === null || Date.parse(observedAt) < Date.parse(oldestObservedAt)) {
      oldestObservedAt = observedAt;
    }
  }

  // The weakest verification anywhere in the place's facts sets the ceiling.
  let verification: VerificationState = 'human_verified';
  for (const resolution of resolutions) {
    const state = resolution.confidence.verification;
    if ((VERIFICATION_WEIGHT[state] ?? 0) < (VERIFICATION_WEIGHT[verification] ?? 0)) {
      verification = state;
    }
  }

  return computeConfidence({
    authorities: [...authorityBySource.values()],
    ageDays: oldestObservedAt ? daysBetween(oldestObservedAt, nowIso()) : 0,
    halfLifeDays: policyFor(tier).confidenceHalfLifeDays,
    verification,
  });
}

function constraintCategories(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (value && typeof value === 'object') {
    const inner = (value as Record<string, unknown>).category ?? (value as Record<string, unknown>).categories;
    if (inner !== undefined) return constraintCategories(inner);
  }
  return [];
}

export function violatesHardConstraint(place: Place, constraint: Constraint): boolean {
  if (constraint.kind === 'avoid_category') {
    return constraintCategories(constraint.value).includes(place.category);
  }
  if (constraint.kind === 'require_indoor') {
    if (constraint.value === false) return false;
    // Unknown indoor/outdoor cannot satisfy a hard indoor requirement.
    return place.indoorOutdoor !== 'indoor' && place.indoorOutdoor !== 'mixed';
  }
  return false;
}

export function listConstraints(db: Db, userId: string, tripId?: string | null): Constraint[] {
  const rows = db.all<Record<string, unknown>>(
    `SELECT * FROM constraints WHERE user_id = ? OR (trip_id IS NOT NULL AND trip_id = ?)
     ORDER BY id`,
    userId,
    tripId ?? null,
  );
  return rows.map((row) => ({
    id: String(row.id),
    userId: (row.user_id as string) ?? null,
    tripId: (row.trip_id as string) ?? null,
    kind: row.kind as ConstraintKind,
    value: jsonColumn<unknown>(row.value_json, null),
    hard: Number(row.hard) === 1,
  }));
}

/** Score one place and say why, in factors and in one sentence. */
export function scorePlace(
  db: Db,
  place: Place,
  ctx: ScoreContext,
): { score: number; factors: ScoreFactor[]; explanation: string } {
  const factors: ScoreFactor[] = [];
  const intent = ctx.intent;

  const push = (label: string, contribution: number, detail: string): void => {
    if (contribution === 0) return;
    factors.push({ label, contribution: round(contribution), detail });
  };

  // 1. What the user asked for, by topic.
  const topicWeights = placeTopicWeights(db, place.id);
  const matchedTopics: string[] = [];
  let topicScore = 0;
  for (const slug of intent.topics) {
    const weight = topicWeights.get(slug);
    if (weight === undefined) continue;
    matchedTopics.push(slug);
    topicScore += W_TOPIC * weight;
  }
  if (matchedTopics.length > 0) {
    topicScore = Math.min(topicScore, W_TOPIC_CAP);
    push(
      'asked-for topics',
      topicScore,
      `it is ${matchedTopics.map(humanTopic).join(' and ')}, which you asked for`,
    );
  }

  // 2. Tourist crowds. The headline case for "not too touristy".
  const touristiness = place.touristiness;
  if (touristiness !== null) {
    const high = biasFor(intent, 'touristiness', 'high');
    const low = biasFor(intent, 'touristiness', 'low');
    const contribution = (high * touristiness + low * (1 - touristiness)) * W_TOURISTINESS;
    const bucket = bucketTouristiness(touristiness);
    if (contribution !== 0) {
      push(
        'tourist crowds',
        contribution,
        contribution > 0
          ? `tourist pressure here is ${bucket}, which is what you wanted`
          : `it draws ${bucket} tourist crowds, which you wanted to avoid`,
      );
    }
  }

  // 3. Price.
  if (place.priceTier) {
    const bias = biasFor(intent, 'price_tier', place.priceTier);
    if (bias !== 0) {
      push(
        'price fit',
        bias * W_PRICE,
        bias > 0
          ? `${place.priceTier === 'free' ? 'free entry' : `it costs ${place.priceTier}`}, matching your budget`
          : `at ${place.priceTier} it is pricier than you asked for`,
      );
    }
  }

  // 4. Indoor / outdoor.
  if (place.indoorOutdoor) {
    const indoorBias = biasFor(intent, 'indoor_outdoor', 'indoor');
    const outdoorBias = biasFor(intent, 'indoor_outdoor', 'outdoor');
    const indoorness =
      place.indoorOutdoor === 'indoor' ? 1 : place.indoorOutdoor === 'mixed' ? 0.5 : 0;
    const contribution = (indoorBias * indoorness + outdoorBias * (1 - indoorness)) * W_INDOOR;
    if (contribution !== 0) {
      push(
        'indoor or outdoor',
        contribution,
        contribution > 0
          ? `it is ${place.indoorOutdoor}, as you asked`
          : `it is ${place.indoorOutdoor}, which is not what you asked for`,
      );
    }
  }

  // 5. How long a visit takes.
  if (place.durationMinutes !== null) {
    const bucket = bucketDuration(place.durationMinutes);
    const bias = biasFor(intent, 'duration', bucket);
    if (bias !== 0) {
      push(
        'visit length',
        bias * W_DURATION,
        bias > 0
          ? `a ${bucket} visit of about ${place.durationMinutes} minutes suits your plan`
          : `a ${bucket} visit of about ${place.durationMinutes} minutes does not fit your plan`,
      );
    }
  }

  // 6. Local character: the explicit bias and the local_favor signal together.
  const localBias = biasFor(intent, 'neighborhood_character', 'local');
  if (localBias !== 0 && place.localFavor !== null) {
    const contribution = localBias * (place.localFavor - 0.5) * W_LOCAL;
    push(
      'local favour',
      contribution,
      contribution > 0
        ? `locals actually go here (local favour ${place.localFavor.toFixed(2)})`
        : `this is not somewhere locals go (local favour ${place.localFavor.toFixed(2)})`,
    );
  }

  // 7. What we learned from this user's own behaviour.
  const byDimension = new Map<string, { total: number; parts: string[] }>();
  const traits = placeTraitValues(db, place);
  for (const pref of ctx.preferences) {
    const values = traits.get(pref.dimension);
    if (!values || !values.has(pref.value)) continue;
    const contribution = pref.weight * pref.confidence.value * W_PREFERENCE;
    if (contribution === 0) continue;
    const entry = byDimension.get(pref.dimension) ?? { total: 0, parts: [] };
    entry.total += contribution;
    // Prose only: the numbers behind this live in `contribution` and in the
    // preference row, so the detail stays readable inside a sentence.
    entry.parts.push(pref.dimension === 'topic' ? humanTopic(pref.value) : pref.value);
    byDimension.set(pref.dimension, entry);
  }
  for (const [dimension, entry] of [...byDimension.entries()].sort()) {
    const listed = joinWords(entry.parts.slice(0, 3));
    push(
      `learned preference: ${dimension}`,
      entry.total,
      entry.total > 0
        ? `you keep choosing ${listed}`
        : `you have turned down ${listed} before`,
    );
  }

  // 8. Who is actually coming.
  const wantsFamily = intent.familyFriendly || ctx.partyHasYoungChild;
  if (ctx.partyHasYoungChild && place.minAge !== null && place.minAge > 5) {
    push(
      'age suitability',
      W_AGE_BLOCK,
      `its minimum age of ${place.minAge} rules out the youngest in your party`,
    );
  } else if (wantsFamily && (place.minAge === null || place.minAge <= 5)) {
    push('age suitability', W_AGE_FIT, 'it works for young children');
  }
  if (ctx.partyHasYoungChild && place.durationMinutes !== null && place.durationMinutes > 210) {
    push(
      'visit length for young children',
      -0.25,
      `${place.durationMinutes} minutes is a long visit with a small child`,
    );
  }

  // 9. Plain quality.
  if (place.rating !== null) {
    const contribution = clampAbs(((place.rating - 3.5) / 1.5) * W_RATING, 0.6);
    push(
      'rating',
      contribution,
      contribution >= 0
        ? `visitors rate it ${place.rating.toFixed(1)} out of 5`
        : `visitors only rate it ${place.rating.toFixed(1)} out of 5`,
    );
  }

  // 10. How well-established the facts are. Always emitted, so every result has
  // at least one factor even when nothing else is known about the place.
  const confidence = placeFactConfidence(db, place.id);
  const truthContribution = (confidence.value - 0.5) * W_TRUTH;
  factors.push({
    label: 'fact confidence',
    contribution: round(truthContribution),
    detail:
      confidence.observations === 0
        ? 'nothing here has been corroborated by a source yet'
        : `its facts are ${confidenceBand(confidence.value)} confidence from ${confidence.observations} source${confidence.observations === 1 ? '' : 's'}`,
  });

  // 11. Safety net: scorePlace is honest on its own even if a caller forgot to
  // filter. `recommend` removes these candidates before they get here.
  for (const constraint of ctx.hardConstraints) {
    if (!constraint.hard) continue;
    if (violatesHardConstraint(place, constraint)) {
      push(
        'hard constraint',
        W_HARD_VIOLATION,
        `it breaks your hard constraint on ${constraint.kind.replace(/_/g, ' ')}`,
      );
    }
  }

  const score = round(factors.reduce((sum, factor) => sum + factor.contribution, 0));
  return { score, factors, explanation: explain(place, factors) };
}

/** dimension -> set of values this place exhibits, for preference matching. */
function placeTraitValues(db: Db, place: Place): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const add = (dimension: string, value: string): void => {
    const set = map.get(dimension) ?? new Set<string>();
    set.add(value);
    map.set(dimension, set);
  };
  add('category', place.category);
  if (place.priceTier) add('price_tier', place.priceTier);
  if (place.indoorOutdoor) add('indoor_outdoor', place.indoorOutdoor);
  if (place.touristiness !== null) add('touristiness', bucketTouristiness(place.touristiness));
  if (place.durationMinutes !== null) add('duration', bucketDuration(place.durationMinutes));
  const rows = db.all<{ topic_id: string }>(
    'SELECT topic_id FROM place_topics WHERE place_id = ?',
    place.id,
  );
  for (const row of rows) add('topic', String(row.topic_id));
  return map;
}

function joinWords(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function capitalise(sentence: string): string {
  return sentence.length ? sentence[0]?.toUpperCase() + sentence.slice(1) : sentence;
}

/** One sentence, assembled from the top positives plus the worst real negative. */
export function explain(place: Place, factors: ScoreFactor[]): string {
  const sorted = [...factors].sort((a, b) => b.contribution - a.contribution);
  const positives = sorted.filter((f) => f.contribution > 0.05).slice(0, 3);
  const worst = sorted[sorted.length - 1];
  const negative = worst && worst.contribution <= -0.2 ? worst : null;

  if (positives.length === 0 && !negative) {
    return capitalise(
      `${place.name} is a ${place.category.replace(/_/g, ' ')} here, but little is known about it yet.`,
    );
  }

  const clauses = positives.map((f) => f.detail);
  let sentence: string;
  if (clauses.length === 0) {
    sentence = capitalise(`${negative?.detail ?? ''}.`);
  } else {
    const joined = joinWords(clauses);
    sentence = capitalise(negative ? `${joined}, but ${negative.detail}.` : `${joined}.`);
  }
  return sentence;
}

export function recommend(db: Db, req: RecommendationRequest): Result<RecommendationResponse> {
  try {
    const intent = parseIntent(req.intent ?? '');
    const preferences = getPreferences(db, req.userId);
    const constraints = listConstraints(db, req.userId, req.tripId ?? null);
    const hardConstraints = constraints.filter((c) => c.hard);
    const softConstraints = constraints.filter((c) => !c.hard);

    const party = getParty(db, req.userId);
    const partyHasYoungChild =
      req.context?.hasChildUnder5 === true ||
      party.some((m) => m.role === 'infant' || (m.age !== null && m.age < 5));

    const excluded = new Set(req.exclude ?? []);
    const candidates = listPlacesByCity(db, req.cityId).filter(
      (place) =>
        !excluded.has(place.id) && !hardConstraints.some((c) => violatesHardConstraint(place, c)),
    );

    const ctx: ScoreContext = { intent, preferences, partyHasYoungChild, hardConstraints };

    const scored = candidates.map((place) => {
      const base = scorePlace(db, place, ctx);
      const factors = [...base.factors];
      let score = base.score;
      // Soft constraints never remove a candidate, they only push it down.
      for (const constraint of softConstraints) {
        if (!violatesHardConstraint(place, { ...constraint, hard: true })) continue;
        factors.push({
          label: `soft constraint: ${constraint.kind.replace(/_/g, ' ')}`,
          contribution: W_SOFT_CONSTRAINT,
          detail: `you would rather avoid ${constraint.kind.replace(/_/g, ' ')}`,
        });
        score = round(score + W_SOFT_CONSTRAINT);
      }
      const recommendation: Recommendation = {
        place,
        score,
        rank: 0,
        factors,
        confidence: placeFactConfidence(db, place.id),
        explanation: explain(place, factors),
      };
      return recommendation;
    });

    scored.sort((a, b) =>
      b.score !== a.score ? b.score - a.score : a.place.id < b.place.id ? -1 : 1,
    );

    const limit = req.limit && req.limit > 0 ? req.limit : 10;
    const results = scored.slice(0, limit).map((rec, index) => ({ ...rec, rank: index + 1 }));

    return ok({
      request: req,
      results,
      parsedIntent: intent,
      generatedAt: nowIso(),
      rerankOf: null,
    });
  } catch (error) {
    return err('internal', 'recommendation failed', { userId: req.userId, cityId: req.cityId }, error);
  }
}

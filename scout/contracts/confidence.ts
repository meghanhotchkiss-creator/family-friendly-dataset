/**
 * THE confidence model. There is exactly one.
 *
 * Radar deltas, Truth Engine resolutions, User Graph preferences, Sentinel
 * health and reward quotes all express certainty with this type and compute it
 * with `computeConfidence`. Nothing anywhere else may invent its own scale.
 *
 * The score combines four independent factors:
 *
 *   1. authority     how much the source is trusted on its own (0..1)
 *   2. corroboration independent sources agreeing, combined with noisy-OR:
 *                      1 - product(1 - authority_i)
 *                    so two 0.6 sources give 0.84, never more than 1
 *   3. freshness     exponential decay, 0.5 ^ (ageDays / halfLifeDays),
 *                    floored so old-but-stable facts never hit zero
 *   4. verification  a multiplier for human/automated review state
 *
 *   confidence = noisyOr(authorities) * freshness * verification
 *
 * All four are reported alongside the score so any number in the system can be
 * explained without re-deriving it.
 */

export const VERIFICATION_STATES = [
  'unverified',
  'auto_verified',
  'human_verified',
  'disputed',
  'rejected',
] as const;

export type VerificationState = (typeof VERIFICATION_STATES)[number];

/** Multiplier applied to the corroborated authority. */
export const VERIFICATION_WEIGHT: Readonly<Record<VerificationState, number>> = {
  unverified: 0.85,
  auto_verified: 0.95,
  human_verified: 1.0,
  disputed: 0.4,
  rejected: 0.0,
};

/**
 * Default authority by source class. Concrete sources may override within
 * their class, but every source must sit on this one 0..1 scale.
 */
export const SOURCE_AUTHORITY = {
  /** The operator itself: official site, official API, government register. */
  official: 0.95,
  /** Large curated aggregator with editorial process. */
  major_aggregator: 0.8,
  /** Open collaborative dataset (OSM, Wikidata, Wikipedia). */
  open_dataset: 0.7,
  /** Community reviews and user-generated content. */
  community: 0.55,
  /** Derived by Scout from other records rather than observed. */
  inferred: 0.45,
  /** Placeholder / demo data. Never outranks a real source. */
  seed: 0.35,
} as const;

export type SourceClass = keyof typeof SOURCE_AUTHORITY;

/** Floor for the freshness factor, so stale facts decay but never vanish. */
export const FRESHNESS_FLOOR = 0.25;

export interface ConfidenceInput {
  /** Authority of each independent source asserting the claim (0..1 each). */
  readonly authorities: readonly number[];
  /** Age of the newest observation, in days. */
  readonly ageDays?: number;
  /** Half-life for decay. Omit for facts that do not go stale. */
  readonly halfLifeDays?: number | null;
  readonly verification?: VerificationState;
}

export interface Confidence {
  /** 0..1, the number to compare and rank on. */
  readonly value: number;
  readonly authority: number;
  readonly corroboration: number;
  readonly freshness: number;
  readonly verification: VerificationState;
  readonly verificationWeight: number;
  /** Number of independent sources folded into `authority`. */
  readonly observations: number;
}

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Combine independent evidence: 1 - product(1 - a_i). */
export function noisyOr(authorities: readonly number[]): number {
  let inverse = 1;
  for (const a of authorities) inverse *= 1 - clamp01(a);
  return clamp01(1 - inverse);
}

export function freshnessFactor(ageDays: number, halfLifeDays: number | null | undefined): number {
  if (halfLifeDays === null || halfLifeDays === undefined || halfLifeDays <= 0) return 1;
  if (ageDays <= 0) return 1;
  const decayed = Math.pow(0.5, ageDays / halfLifeDays);
  return clamp01(FRESHNESS_FLOOR + (1 - FRESHNESS_FLOOR) * decayed);
}

export function computeConfidence(input: ConfidenceInput): Confidence {
  const authorities = input.authorities.filter((a) => Number.isFinite(a) && a > 0);
  const verification = input.verification ?? 'unverified';
  const verificationWeight = VERIFICATION_WEIGHT[verification];
  const corroborated = noisyOr(authorities);
  const freshness = freshnessFactor(input.ageDays ?? 0, input.halfLifeDays);
  const best = authorities.length ? Math.max(...authorities) : 0;

  return {
    value: clamp01(corroborated * freshness * verificationWeight),
    authority: clamp01(best),
    corroboration: corroborated,
    freshness,
    verification,
    verificationWeight,
    observations: authorities.length,
  };
}

/** Confidence with no evidence behind it. */
export const NO_CONFIDENCE: Confidence = computeConfidence({ authorities: [] });

/** Bands for human-facing copy. Thresholds live here and nowhere else. */
export function confidenceBand(value: number): 'high' | 'medium' | 'low' | 'none' {
  if (value >= 0.75) return 'high';
  if (value >= 0.5) return 'medium';
  if (value > 0) return 'low';
  return 'none';
}

export function explainConfidence(c: Confidence): string {
  if (c.observations === 0) return 'no supporting evidence';
  const parts = [
    `${c.observations} source${c.observations === 1 ? '' : 's'}`,
    `authority ${c.authority.toFixed(2)}`,
  ];
  if (c.freshness < 1) parts.push(`freshness ${c.freshness.toFixed(2)}`);
  if (c.verification !== 'unverified') parts.push(c.verification.replace('_', ' '));
  return `${confidenceBand(c.value)} (${c.value.toFixed(2)}): ${parts.join(', ')}`;
}

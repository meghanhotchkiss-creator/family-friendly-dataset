/**
 * Scout Mind's request/response contract.
 *
 * Every recommendation carries its reasons. A score with no explanation is not
 * a valid result: the UI, the tests and the user all read the same rationale.
 */

import type { EntityId } from './ids.ts';
import type { Confidence } from './confidence.ts';
import type { Place } from './entities.ts';
import type { SignalContext } from './user.ts';

export interface RecommendationRequest {
  userId: EntityId;
  cityId: EntityId;
  /** Free-text intent, e.g. "family-friendly, local, not too touristy". */
  intent?: string;
  tripId?: EntityId | null;
  context?: SignalContext;
  limit?: number;
  /** Places already shown, so a re-rank can report movement. */
  exclude?: EntityId[];
}

/** One additive contribution to a place's score. */
export interface ScoreFactor {
  label: string;
  /** Signed contribution in score units. */
  contribution: number;
  detail: string;
}

export interface Recommendation {
  place: Place;
  score: number;
  rank: number;
  factors: ScoreFactor[];
  /** Confidence in the underlying facts, from the Truth Layer. */
  confidence: Confidence;
  /** One-sentence human explanation assembled from the factors. */
  explanation: string;
}

export interface RecommendationResponse {
  request: RecommendationRequest;
  results: Recommendation[];
  /** Intent terms Scout Mind actually understood. */
  parsedIntent: ParsedIntent;
  generatedAt: string;
  /** Set when this response re-ranks an earlier one. */
  rerankOf?: string | null;
}

export interface ParsedIntent {
  raw: string;
  topics: string[];
  vibes: string[];
  /** Signed preferences the intent implies, e.g. touristiness -0.8. */
  dimensionBias: { dimension: string; value: string; weight: number }[];
  familyFriendly: boolean;
  wantsLocal: boolean;
  avoidsTouristy: boolean;
}

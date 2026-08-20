/** User Graph: travel party, learned preferences, context-aware signals. */

import type { EntityId } from './ids.ts';
import type { Confidence } from './confidence.ts';

export const PARTY_ROLES = ['adult', 'child', 'infant', 'teen', 'senior'] as const;
export type PartyRole = (typeof PARTY_ROLES)[number];

export interface PartyMember {
  id: string; userId: EntityId; label: string;
  role: PartyRole; age: number | null; needs: string[];
}

/**
 * Dimensions the User Graph learns along. Preferences are always
 * (dimension, value) pairs so one table and one learner cover them all.
 */
export const PREFERENCE_DIMENSIONS = [
  'category', 'topic', 'vibe', 'price_tier', 'indoor_outdoor',
  'touristiness', 'duration', 'neighborhood_character',
] as const;
export type PreferenceDimension = (typeof PREFERENCE_DIMENSIONS)[number];

export interface Preference {
  id: string;
  userId: EntityId;
  dimension: PreferenceDimension;
  value: string;
  /** -1..1. Negative is aversion, positive is affinity. */
  weight: number;
  confidence: Confidence;
  evidenceCount: number;
  updatedAt: string;
}

/**
 * The context a signal was observed in. Learning is context-aware: rejecting a
 * crowded landmark on a rainy day with a toddler should not teach "dislikes
 * landmarks" outright.
 */
export interface SignalContext {
  tripId?: EntityId | null;
  partySize?: number | null;
  hasChildUnder5?: boolean | null;
  weather?: 'clear' | 'rain' | 'snow' | 'hot' | 'cold' | null;
  timeOfDay?: 'morning' | 'afternoon' | 'evening' | null;
  season?: 'spring' | 'summer' | 'fall' | 'winter' | null;
}

export const SIGNAL_KINDS = ['saved', 'rejected', 'visited', 'rated', 'viewed', 'booked'] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export interface UserSignal {
  id: string; userId: EntityId; placeId: EntityId;
  kind: SignalKind;
  /** Rating 1..5 where applicable, else null. */
  rating: number | null;
  context: SignalContext;
  createdAt: string;
}

export interface UserGraph {
  userId: EntityId;
  preferences: Preference[];
  party: PartyMember[];
  signalCount: number;
}

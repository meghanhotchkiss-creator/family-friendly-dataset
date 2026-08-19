/** Topic Graph: curated taxonomy plus automatically discovered candidates. */

import type { EntityId } from './ids.ts';
import type { Confidence } from './confidence.ts';

export const TOPIC_STATUS = ['core', 'candidate', 'promoted', 'rejected'] as const;
export type TopicStatus = (typeof TOPIC_STATUS)[number];

export interface Topic {
  id: EntityId;
  slug: string;
  label: string;
  parentTopicId: EntityId | null;
  status: TopicStatus;
  /** Places currently linked to the topic. */
  supportCount: number;
  confidence: Confidence;
  createdAt: string;
}

export interface PlaceTopic {
  placeId: EntityId;
  topicId: EntityId;
  /** 0..1 strength of the association. */
  weight: number;
  source: 'taxonomy' | 'discovered' | 'manual';
}

/** A term the discovery pass thinks might deserve to become a topic. */
export interface TopicCandidate {
  term: string;
  /** Places whose text supports the term. */
  support: EntityId[];
  /** Discriminative power: high means the term separates places, not describes all of them. */
  distinctiveness: number;
  score: number;
}

export const TOPIC_PROMOTION_MIN_SUPPORT = 3;
export const TOPIC_PROMOTION_MIN_DISTINCTIVENESS = 0.15;

/**
 * Scout Truth Layer.
 *
 * Nothing writes a fact onto an entity directly. Every observation enters as a
 * SourceRecord (one source's claim about one field of one entity), and the
 * Truth Engine resolves competing claims into a single TruthResolution using
 * the one confidence model. That is what makes the graph auditable: for any
 * value you can ask which source won, against what competition, and why.
 */

import type { EntityId, EntityType } from './ids.ts';
import type { Confidence, SourceClass, VerificationState } from './confidence.ts';
import type { FreshnessTier } from './freshness.ts';
import type { RegionCode } from './entities.ts';

export interface Source {
  id: EntityId;
  name: string;
  sourceClass: SourceClass;
  /** 0..1, defaults to SOURCE_AUTHORITY[sourceClass] but may be tuned. */
  authority: number;
  homepage: string | null;
  /** Empty means global. */
  regionScope: RegionCode[];
  freshnessTier: FreshnessTier;
  enabled: boolean;
}

/** One source's claim about one field of one entity, at one point in time. */
export interface SourceRecord {
  id: string;
  sourceId: EntityId;
  entityType: EntityType;
  entityId: EntityId;
  field: string;
  value: unknown;
  observedAt: string;
  /** Hash of the normalised value, for cheap change detection. */
  contentHash: string;
  verification: VerificationState;
  /** Set when a newer record from the same source replaces this one. */
  supersededBy: string | null;
}

export interface TruthResolution {
  id: string;
  entityType: EntityType;
  entityId: EntityId;
  field: string;
  value: unknown;
  confidence: Confidence;
  /** Record that won. */
  chosenRecordId: string;
  /** Records that agreed, and so contributed corroboration. */
  agreeingRecordIds: string[];
  /** Records that claimed something different. */
  conflictingRecordIds: string[];
  rationale: string;
  resolvedAt: string;
}

/** Fields the truth engine is allowed to resolve onto a place. */
export const RESOLVABLE_PLACE_FIELDS = [
  'name', 'category', 'price_tier', 'indoor_outdoor', 'rating',
  'min_age', 'max_age', 'duration_minutes', 'touristiness', 'local_favor',
  'description', 'lat', 'lon', 'neighborhood_id',
] as const;
export type ResolvablePlaceField = (typeof RESOLVABLE_PLACE_FIELDS)[number];

/**
 * Radar: watched-source registry, conditional fetch, hashing, semantic delta
 * detection and the verification workflow.
 */

import type { EntityId, EntityType } from './ids.ts';
import type { VerificationState } from './confidence.ts';
import type { FreshnessTier } from './freshness.ts';

export interface Watch {
  id: string;
  sourceId: EntityId;
  entityType: EntityType;
  entityId: EntityId;
  /** Locator handed to the provider. A URL for http sources, a key otherwise. */
  locator: string;
  freshnessTier: FreshnessTier;
  checkIntervalMinutes: number;
  lastCheckedAt: string | null;
  /** Hash of the last body seen, for unconditional change detection. */
  lastHash: string | null;
  /** Conditional-fetch validators, so unchanged sources cost one 304. */
  etag: string | null;
  lastModified: string | null;
  enabled: boolean;
}

export const SCAN_STATUS = ['unchanged', 'changed', 'error', 'skipped'] as const;
export type ScanStatus = (typeof SCAN_STATUS)[number];

export interface RadarScan {
  id: string;
  watchId: string;
  startedAt: string;
  finishedAt: string;
  status: ScanStatus;
  httpStatus: number | null;
  bytes: number | null;
  hash: string | null;
  /** True when a conditional request avoided a full body transfer. */
  conditionalHit: boolean;
  error: string | null;
}

/**
 * How much a change actually matters. Cosmetic changes must never trigger a
 * re-rank; structural ones always do.
 */
export const DELTA_KINDS = ['cosmetic', 'material', 'structural'] as const;
export type DeltaKind = (typeof DELTA_KINDS)[number];

export interface RadarDelta {
  id: string;
  watchId: string;
  scanId: string;
  entityType: EntityType;
  entityId: EntityId;
  field: string;
  oldValue: unknown;
  newValue: unknown;
  /** 0..1 semantic distance between old and new. */
  semanticScore: number;
  kind: DeltaKind;
  verification: VerificationState;
  createdAt: string;
}

export interface Verification {
  id: string;
  deltaId: string;
  verifier: string;
  method: 'corroboration' | 'refetch' | 'heuristic' | 'human';
  outcome: VerificationState;
  notes: string | null;
  createdAt: string;
}

/** Semantic score at or above which a change stops being cosmetic. */
export const DELTA_MATERIAL_THRESHOLD = 0.2;
/** Semantic score at or above which a change is structural. */
export const DELTA_STRUCTURAL_THRESHOLD = 0.6;

/** Fields whose change is always structural regardless of string distance. */
export const STRUCTURAL_FIELDS: ReadonlySet<string> = new Set([
  'category', 'price_tier', 'indoor_outdoor', 'lat', 'lon', 'closed', 'name',
]);

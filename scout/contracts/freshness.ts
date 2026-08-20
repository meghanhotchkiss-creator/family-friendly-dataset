/**
 * One freshness model: three tiers, one TTL table, one staleness rule.
 *
 *   base     structural facts that rarely move (geography, airport codes)
 *   periodic facts that drift over days (opening hours, prices, topics)
 *   live     facts that move within minutes (weather, delays, availability)
 */

export const FRESHNESS_TIERS = ['base', 'periodic', 'live'] as const;
export type FreshnessTier = (typeof FRESHNESS_TIERS)[number];

export interface FreshnessPolicy {
  readonly tier: FreshnessTier;
  /** Cache lifetime before a refetch is due. */
  readonly ttlSeconds: number;
  /** Age past which a value is served but flagged stale. */
  readonly staleAfterSeconds: number;
  /** Half-life fed to computeConfidence for facts from this tier. */
  readonly confidenceHalfLifeDays: number | null;
  /** How often Radar should re-check a watched source in this tier. */
  readonly recheckIntervalMinutes: number;
}

export const FRESHNESS_POLICY: Readonly<Record<FreshnessTier, FreshnessPolicy>> = {
  base: {
    tier: 'base',
    ttlSeconds: 60 * 60 * 24 * 30,
    staleAfterSeconds: 60 * 60 * 24 * 180,
    confidenceHalfLifeDays: null,
    recheckIntervalMinutes: 60 * 24 * 30,
  },
  periodic: {
    tier: 'periodic',
    ttlSeconds: 60 * 60 * 12,
    staleAfterSeconds: 60 * 60 * 24 * 7,
    confidenceHalfLifeDays: 120,
    recheckIntervalMinutes: 60 * 12,
  },
  live: {
    tier: 'live',
    ttlSeconds: 60 * 5,
    staleAfterSeconds: 60 * 30,
    confidenceHalfLifeDays: 1,
    recheckIntervalMinutes: 5,
  },
};

export function policyFor(tier: FreshnessTier): FreshnessPolicy {
  return FRESHNESS_POLICY[tier];
}

export interface CacheEntry<T> {
  readonly key: string;
  readonly tier: FreshnessTier;
  readonly value: T;
  readonly fetchedAt: string;
  readonly expiresAt: string;
  readonly hash: string;
  readonly stale: boolean;
}

export function ageSeconds(fetchedAtIso: string, nowIso: string): number {
  return Math.max(0, (Date.parse(nowIso) - Date.parse(fetchedAtIso)) / 1000);
}

export function isExpired(entry: { expiresAt: string }, nowIso: string): boolean {
  return Date.parse(nowIso) >= Date.parse(entry.expiresAt);
}

export function isStale(
  entry: { fetchedAt: string; tier: FreshnessTier },
  nowIso: string,
): boolean {
  return ageSeconds(entry.fetchedAt, nowIso) >= FRESHNESS_POLICY[entry.tier].staleAfterSeconds;
}

/**
 * ONE provider interface family. Every external integration -- places,
 * airports, geography, GTFS, weather, hotel, flight, rewards -- implements
 * `Provider`. Sentinel monitors them, the freshness cache wraps them and
 * failover chains compose them without knowing which one it is holding.
 *
 * Adapters never call fetch() directly. They go through `Transport`, which in
 * this environment replays recorded fixtures and in production hits the wire.
 * That seam is why the adapters are real code rather than mocks: the parsing,
 * normalisation, schema-fingerprinting and error mapping all execute for real.
 */

import type { Result } from './result.ts';
import type { FreshnessTier } from './freshness.ts';
import type { SourceClass } from './confidence.ts';
import type { RegionCode } from './entities.ts';

export const PROVIDER_KINDS = [
  'geography', 'airports', 'places', 'gtfs', 'weather',
  'hotel', 'flight', 'rewards', 'events',
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export interface TransportRequest {
  readonly url: string;
  readonly method?: 'GET' | 'POST';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs?: number;
}

export interface TransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** True when served from a recorded fixture rather than the network. */
  readonly replayed: boolean;
  readonly latencyMs: number;
}

/**
 * The single seam between Scout and the outside world.
 *
 * `FixtureTransport` (default here: egress is closed and providers need
 * credentials) and `HttpTransport` (production) both implement it, so no
 * adapter needs a code change to go live.
 */
export interface Transport {
  readonly mode: 'fixture' | 'network';
  request(req: TransportRequest): Promise<Result<TransportResponse>>;
}

export interface ProviderCredentials {
  readonly apiKey?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
}

export interface ProviderContext {
  readonly transport: Transport;
  readonly credentials: ProviderCredentials;
  readonly now: () => string;
}

export const PROVIDER_STATUS = ['up', 'degraded', 'down', 'unconfigured'] as const;
export type ProviderStatus = (typeof PROVIDER_STATUS)[number];

export interface ProviderHealth {
  readonly providerId: string;
  readonly status: ProviderStatus;
  readonly checkedAt: string;
  readonly latencyMs: number | null;
  readonly httpStatus: number | null;
  readonly authOk: boolean;
  readonly schemaOk: boolean;
  /** Fingerprint of the response shape, for drift detection. */
  readonly schemaFingerprint: string | null;
  readonly error: string | null;
}

export interface FetchRequest {
  /** Free-form, provider-specific query. Adapters validate their own shape. */
  readonly query: Record<string, unknown>;
  readonly regionCode?: RegionCode;
  readonly limit?: number;
}

export interface FetchResponse<T> {
  readonly items: readonly T[];
  readonly fetchedAt: string;
  readonly replayed: boolean;
  /** Shape fingerprint of this payload, compared against the last known one. */
  readonly schemaFingerprint: string;
}

/**
 * The one provider contract. `T` is the adapter's raw item type; normalisation
 * into travel-graph entities is a separate step so raw payloads stay
 * inspectable in source_records.
 */
export interface Provider<T = unknown> {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly sourceClass: SourceClass;
  /** 0..1 on the one authority scale in confidence.ts. */
  readonly authority: number;
  readonly freshnessTier: FreshnessTier;
  /** Empty means global coverage. */
  readonly regionScope: readonly RegionCode[];
  /** False when required credentials are absent. */
  isConfigured(ctx: ProviderContext): boolean;
  health(ctx: ProviderContext): Promise<ProviderHealth>;
  fetch(ctx: ProviderContext, req: FetchRequest): Promise<Result<FetchResponse<T>>>;
}

/** Stable fingerprint of a payload's shape (keys and types, not values). */
export function schemaFingerprintOf(sample: unknown): string {
  const shape = describeShape(sample, 0);
  return shape;
}

function describeShape(value: unknown, depth: number): string {
  if (depth > 6) return '…';
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return value.length === 0 ? '[]' : `[${describeShape(value[0], depth + 1)}]`;
  }
  const t = typeof value;
  if (t !== 'object') return t;
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => `${k}:${describeShape(v, depth + 1)}`)
    .sort();
  return `{${entries.join(',')}}`;
}

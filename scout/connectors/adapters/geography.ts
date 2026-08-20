/**
 * Geography provider: countries, their region flag, currency and capital.
 *
 * Upstream is REST Countries v3.1 (https://restcountries.com), an open dataset
 * with no credentials. The URL, the `fields` projection, the payload shape and
 * the region derivation below are the real ones; today the bytes arrive from a
 * recorded fixture because this environment's egress is closed. Flipping
 * SCOUT_TRANSPORT=network is the only change needed to go live.
 *
 * This file also owns the small pieces of HTTP plumbing every adapter shares --
 * status -> ErrorKind mapping, the request wrapper and the health probe runner.
 * They live here rather than in an adapters/common.ts because the connector
 * file set is fixed; geography is the first adapter and therefore the host.
 */

import type {
  ErrorKind,
  FetchRequest,
  FetchResponse,
  Provider,
  ProviderContext,
  ProviderHealth,
  RegionCode,
  Result,
  TransportRequest,
  TransportResponse,
} from '../../contracts/index.ts';
import { err, ok, schemaFingerprintOf } from '../../contracts/index.ts';

/** A probe slower than this is reachable but unhealthy. */
export const SLOW_RESPONSE_MS = 2_000;

/**
 * The one HTTP-status -> ErrorKind rule for every Scout connector.
 *
 *   401 / 403      upstream_auth           credentials missing, wrong or revoked
 *   429            upstream_rate_limited   back off and retry later
 *   408 / 504      timeout                 upstream took too long
 *   5xx            upstream_unavailable    upstream is broken, retry later
 *   404            not_found               the resource genuinely is not there
 *   other 4xx      invalid_input           we built a bad request
 */
export function errorKindForStatus(status: number): ErrorKind {
  if (status === 401 || status === 403) return 'upstream_auth';
  if (status === 429) return 'upstream_rate_limited';
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 500) return 'upstream_unavailable';
  if (status === 404) return 'not_found';
  if (status >= 400) return 'invalid_input';
  return 'internal';
}

/**
 * Issue a request and fail on anything that is not 2xx. Transport-level
 * failures (timeout, connection refused, missing fixture) keep their own kind.
 */
export async function requestOk(
  providerId: string,
  ctx: ProviderContext,
  request: TransportRequest,
): Promise<Result<TransportResponse>> {
  const response = await ctx.transport.request(request);
  if (!response.ok) {
    return err(
      response.error.kind,
      `${providerId}: ${response.error.message}`,
      { providerId, url: request.url, ...(response.error.detail ?? {}) },
      response.error.cause,
    );
  }
  const value = response.value;
  if (value.status < 200 || value.status >= 300) {
    return err(errorKindForStatus(value.status), `${providerId}: HTTP ${value.status} from ${request.url}`, {
      providerId,
      url: request.url,
      httpStatus: value.status,
    });
  }
  return ok(value);
}

/** Parse a JSON body, mapping anything unparseable to schema drift. */
export function parseJsonBody<T>(providerId: string, body: string): Result<T> {
  try {
    return ok(JSON.parse(body) as T);
  } catch (cause) {
    return err(
      'upstream_schema_drift',
      `${providerId}: response body was not JSON`,
      { providerId, bodyPreview: body.slice(0, 120) },
      cause,
    );
  }
}

export interface HealthProbe {
  readonly request: TransportRequest;
  /**
   * Pull a representative sample out of the body. Return null when the payload
   * does not look like what this adapter parses -- that is schema drift, which
   * is degraded rather than down: the service answered, we just cannot read it.
   */
  readonly sample: (body: string) => unknown;
}

/**
 * One health-check implementation for every provider: real request, real
 * timing, real status mapping, real schema fingerprint.
 */
export async function checkHealth(
  providerId: string,
  ctx: ProviderContext,
  configured: boolean,
  probe: HealthProbe,
): Promise<ProviderHealth> {
  const checkedAt = ctx.now();

  // A missing API key is a configuration gap, not an outage.
  if (!configured) {
    return {
      providerId,
      status: 'unconfigured',
      checkedAt,
      latencyMs: null,
      httpStatus: null,
      authOk: false,
      schemaOk: false,
      schemaFingerprint: null,
      error: 'required credentials are not set',
    };
  }

  const started = Date.now();
  const response = await ctx.transport.request(probe.request);
  if (!response.ok) {
    return {
      providerId,
      status: response.error.kind === 'timeout' ? 'degraded' : 'down',
      checkedAt,
      latencyMs: Math.max(0, Date.now() - started),
      httpStatus: null,
      authOk: false,
      schemaOk: false,
      schemaFingerprint: null,
      error: `${response.error.kind}: ${response.error.message}`,
    };
  }

  const value = response.value;
  const authOk = value.status !== 401 && value.status !== 403;
  if (value.status < 200 || value.status >= 300) {
    return {
      providerId,
      status: value.status === 429 ? 'degraded' : 'down',
      checkedAt,
      latencyMs: value.latencyMs,
      httpStatus: value.status,
      authOk,
      schemaOk: false,
      schemaFingerprint: null,
      error: `HTTP ${value.status} (${errorKindForStatus(value.status)})`,
    };
  }

  let sample: unknown = null;
  try {
    sample = probe.sample(value.body);
  } catch {
    sample = null;
  }
  const schemaOk = sample !== null && sample !== undefined;

  return {
    providerId,
    status: !schemaOk ? 'degraded' : value.latencyMs > SLOW_RESPONSE_MS ? 'degraded' : 'up',
    checkedAt,
    latencyMs: value.latencyMs,
    httpStatus: value.status,
    authOk,
    schemaOk,
    schemaFingerprint: schemaOk ? schemaFingerprintOf(sample) : null,
    error: schemaOk ? null : 'payload did not match the shape this adapter parses',
  };
}

/** Build the FetchResponse envelope from a transport response. */
export function fetchResponseOf<T>(
  items: readonly T[],
  response: { replayed: boolean },
  wireSample: unknown,
  fetchedAt: string,
): FetchResponse<T> {
  return {
    items,
    fetchedAt,
    replayed: response.replayed,
    // Fingerprint the WIRE sample, not our normalised item: drift is a change
    // in what the upstream sends, which is exactly what we want to notice.
    schemaFingerprint: schemaFingerprintOf(wireSample),
  };
}

/* ------------------------------------------------------------------ *
 * Region assignment
 * ------------------------------------------------------------------ */

/**
 * ISO2 -> Scout region for the cases no continent code can express: Scout
 * splits the Americas into NA / CA / SA and carves ME out of Asia, so these
 * countries are pinned here and everything else falls back to continent or
 * REST Countries subregion.
 */
const REGION_BY_ISO2: Readonly<Record<string, RegionCode>> = {
  // North America
  US: 'NA', CA: 'NA', MX: 'NA', BM: 'NA', GL: 'NA', PM: 'NA',
  // Central America & Caribbean
  BZ: 'CA', CR: 'CA', GT: 'CA', HN: 'CA', NI: 'CA', PA: 'CA', SV: 'CA',
  AG: 'CA', AI: 'CA', AW: 'CA', BB: 'CA', BS: 'CA', BQ: 'CA', CU: 'CA', CW: 'CA',
  DM: 'CA', DO: 'CA', GD: 'CA', GP: 'CA', HT: 'CA', JM: 'CA', KN: 'CA', KY: 'CA',
  LC: 'CA', MQ: 'CA', MS: 'CA', PR: 'CA', SX: 'CA', TC: 'CA', TT: 'CA', VC: 'CA',
  VG: 'CA', VI: 'CA',
  // South America
  AR: 'SA', BO: 'SA', BR: 'SA', CL: 'SA', CO: 'SA', EC: 'SA', FK: 'SA', GF: 'SA',
  GY: 'SA', PE: 'SA', PY: 'SA', SR: 'SA', UY: 'SA', VE: 'SA',
  // Middle East
  AE: 'ME', BH: 'ME', IL: 'ME', IQ: 'ME', IR: 'ME', JO: 'ME', KW: 'ME', LB: 'ME',
  OM: 'ME', PS: 'ME', QA: 'ME', SA: 'ME', SY: 'ME', TR: 'ME', YE: 'ME',
};

/** Continent codes as OurAirports and REST Countries spell them. */
const REGION_BY_CONTINENT: Readonly<Record<string, RegionCode>> = {
  AF: 'AF', AS: 'AS', EU: 'EU', NA: 'NA', OC: 'OC', SA: 'SA',
};

const REGION_BY_SUBREGION: Readonly<Record<string, RegionCode>> = {
  'north america': 'NA',
  'northern america': 'NA',
  'central america': 'CA',
  caribbean: 'CA',
  'south america': 'SA',
  'western asia': 'ME',
  'australia and new zealand': 'OC',
  melanesia: 'OC',
  micronesia: 'OC',
  polynesia: 'OC',
};

const REGION_BY_CONTINENT_NAME: Readonly<Record<string, RegionCode>> = {
  africa: 'AF',
  asia: 'AS',
  europe: 'EU',
  oceania: 'OC',
  americas: 'SA', // only reached when the subregion is missing; SA is the largest slice
  antarctic: 'OC',
};

/** Pinned region for a country, when Scout's split differs from the continent. */
export function regionForIso2(iso2: string): RegionCode | undefined {
  return REGION_BY_ISO2[iso2.toUpperCase()];
}

/** Region for a row that carries a continent code (OurAirports style). */
export function regionForContinent(iso2: string, continent: string): RegionCode | null {
  return regionForIso2(iso2) ?? REGION_BY_CONTINENT[continent.toUpperCase()] ?? null;
}

/** Region for a REST Countries row: pinned code first, then subregion, then region. */
export function regionForRestCountry(
  iso2: string,
  region: string | undefined,
  subregion: string | undefined,
): RegionCode | null {
  const pinned = regionForIso2(iso2);
  if (pinned) return pinned;
  const bySub = subregion ? REGION_BY_SUBREGION[subregion.trim().toLowerCase()] : undefined;
  if (bySub) return bySub;
  const byRegion = region ? REGION_BY_CONTINENT_NAME[region.trim().toLowerCase()] : undefined;
  return byRegion ?? null;
}

/* ------------------------------------------------------------------ *
 * The provider
 * ------------------------------------------------------------------ */

export const GEOGRAPHY_PROVIDER_ID = 'provider:restcountries';

export const GEOGRAPHY_PROVIDER_META = {
  id: GEOGRAPHY_PROVIDER_ID,
  name: 'REST Countries',
  homepage: 'https://restcountries.com',
} as const;

const BASE_URL = 'https://restcountries.com/v3.1';

/** The projection REST Countries requires on /all since 2024. */
const FIELDS = 'cca2,cca3,name,region,subregion,currencies,capital,capitalInfo';

export function countriesUrl(): string {
  return `${BASE_URL}/all?fields=${FIELDS}`;
}

/** Cheap single-country call, used as the health probe. */
export function countryProbeUrl(iso2 = 'us'): string {
  return `${BASE_URL}/alpha/${iso2.toLowerCase()}?fields=${FIELDS}`;
}

/** The upstream payload shape, as REST Countries v3.1 sends it. */
interface WireCountry {
  cca2?: string;
  cca3?: string;
  name?: { common?: string; official?: string };
  region?: string;
  subregion?: string;
  currencies?: Record<string, { name?: string; symbol?: string }>;
  capital?: string[];
  capitalInfo?: { latlng?: number[] };
}

/** One normalised country plus its capital, ready for the travel graph. */
export interface RawCountry {
  readonly iso2: string;
  readonly iso3: string;
  readonly name: string;
  readonly officialName: string | null;
  readonly regionCode: RegionCode;
  readonly currency: string | null;
  readonly capital: string | null;
  readonly capitalLat: number | null;
  readonly capitalLon: number | null;
}

export function normaliseCountry(wire: WireCountry): RawCountry | null {
  const iso2 = typeof wire.cca2 === 'string' ? wire.cca2.toUpperCase() : '';
  const iso3 = typeof wire.cca3 === 'string' ? wire.cca3.toUpperCase() : '';
  const name = wire.name?.common;
  if (iso2.length !== 2 || iso3.length !== 3 || !name) return null;

  const regionCode = regionForRestCountry(iso2, wire.region, wire.subregion);
  if (!regionCode) return null;

  const currencyCodes = wire.currencies ? Object.keys(wire.currencies) : [];
  const latlng = wire.capitalInfo?.latlng;

  return {
    iso2,
    iso3,
    name,
    officialName: wire.name?.official ?? null,
    regionCode,
    currency: currencyCodes[0] ?? null,
    capital: wire.capital?.[0] ?? null,
    capitalLat: typeof latlng?.[0] === 'number' ? latlng[0] : null,
    capitalLon: typeof latlng?.[1] === 'number' ? latlng[1] : null,
  };
}

/** Health probe sample: the first country object of the alpha lookup. */
function probeSample(body: string): unknown {
  const parsed: unknown = JSON.parse(body);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first || typeof first !== 'object') return null;
  return normaliseCountry(first as WireCountry) ? first : null;
}

export function createGeographyProvider(): Provider<RawCountry> {
  return {
    id: GEOGRAPHY_PROVIDER_ID,
    kind: 'geography',
    sourceClass: 'open_dataset',
    authority: 0.7,
    freshnessTier: 'base',
    regionScope: [], // global

    isConfigured(_ctx: ProviderContext): boolean {
      // REST Countries is keyless: it is configured wherever it is reachable.
      return true;
    },

    health(ctx: ProviderContext): Promise<ProviderHealth> {
      return checkHealth(GEOGRAPHY_PROVIDER_ID, ctx, this.isConfigured(ctx), {
        request: { url: countryProbeUrl(), method: 'GET', timeoutMs: 5_000 },
        sample: probeSample,
      });
    },

    async fetch(ctx: ProviderContext, req: FetchRequest): Promise<Result<FetchResponse<RawCountry>>> {
      const fetchedAt = ctx.now();
      const response = await requestOk(GEOGRAPHY_PROVIDER_ID, ctx, {
        url: countriesUrl(),
        method: 'GET',
        headers: { accept: 'application/json' },
        timeoutMs: 15_000,
      });
      if (!response.ok) return response;

      const parsed = parseJsonBody<unknown>(GEOGRAPHY_PROVIDER_ID, response.value.body);
      if (!parsed.ok) return parsed;
      if (!Array.isArray(parsed.value)) {
        return err('upstream_schema_drift', `${GEOGRAPHY_PROVIDER_ID}: expected an array of countries`, {
          providerId: GEOGRAPHY_PROVIDER_ID,
          got: typeof parsed.value,
        });
      }

      const wire = parsed.value as WireCountry[];
      const items: RawCountry[] = [];
      for (const row of wire) {
        const country = normaliseCountry(row);
        if (!country) continue;
        if (req.regionCode && country.regionCode !== req.regionCode) continue;
        items.push(country);
        if (req.limit && items.length >= req.limit) break;
      }

      if (wire.length > 0 && items.length === 0 && !req.regionCode) {
        return err('upstream_schema_drift', `${GEOGRAPHY_PROVIDER_ID}: no row carried the expected fields`, {
          providerId: GEOGRAPHY_PROVIDER_ID,
          rows: wire.length,
        });
      }

      return ok(fetchResponseOf(items, response.value, wire[0] ?? null, fetchedAt));
    },
  };
}

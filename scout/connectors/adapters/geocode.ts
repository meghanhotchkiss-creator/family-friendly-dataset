/**
 * OpenStreetMap / Nominatim geocoder.
 *
 * This is the pre-built answer to the coordinate gap: 120 imported places carry
 * a city centroid rather than a street address, flagged `location_precision =
 * 'city'` and refused for any distance work. This adapter upgrades them.
 *
 * It writes lat/lon as CLAIMS at `open_dataset` authority (0.70), which
 * outranks the seed dataset (0.35), so the Truth Engine replaces the centroids
 * through the ordinary resolution path -- no special-casing, no direct writes.
 *
 * Nothing here is speculative: the request shape, the `jsonv2` response fields
 * and the usage rules below are Nominatim's real contract. It cannot run in
 * this environment because egress is closed, which is an organisation policy
 * and not something to route around. To run it:
 *
 *   1. allowlist nominatim.openstreetmap.org in the egress policy
 *   2. export SCOUT_TRANSPORT=network
 *   3. export SCOUT_GEOCODE_EMAIL=you@example.org   (Nominatim requires contact info)
 *   4. npm run travel:geocode
 *
 * Nominatim's usage policy caps this at 1 request/second with an identifying
 * User-Agent, so `GEOCODE_RATE_LIMIT_MS` is deliberately conservative and the
 * CLI walks places one at a time rather than fanning out.
 */

import type {
  FetchRequest,
  FetchResponse,
  Provider,
  ProviderContext,
  ProviderHealth,
  RegionCode,
  Result,
} from '../../contracts/index.ts';
import { SOURCE_AUTHORITY, err, ok, schemaFingerprintOf } from '../../contracts/index.ts';
import { checkHealth, parseJsonBody, requestOk } from './geography.ts';

export const GEOCODE_PROVIDER_ID = 'provider:osm-nominatim';

export const GEOCODE_PROVIDER_META = {
  id: GEOCODE_PROVIDER_ID,
  name: 'OpenStreetMap Nominatim',
  homepage: 'https://nominatim.openstreetmap.org',
} as const;

const BASE_URL = 'https://nominatim.openstreetmap.org/search';

/** Nominatim's published limit is 1 req/s. Stay under it. */
export const GEOCODE_RATE_LIMIT_MS = 1100;

export interface GeocodeQuery {
  name: string;
  city: string;
  countryIso2: string;
}

export interface RawGeocodeHit {
  readonly lat: number;
  readonly lon: number;
  readonly displayName: string;
  /** Nominatim's own confidence, 0..1. */
  readonly importance: number;
  readonly osmType: string | null;
  readonly category: string | null;
}

export function geocodeUrl(query: GeocodeQuery, email?: string): string {
  const search = new URLSearchParams();
  search.set('q', `${query.name}, ${query.city}`);
  search.set('countrycodes', query.countryIso2.toLowerCase());
  search.set('format', 'jsonv2');
  search.set('limit', '1');
  search.set('addressdetails', '0');
  if (email) search.set('email', email);
  return `${BASE_URL}?${search.toString()}`;
}

interface WireHit {
  lat?: string;
  lon?: string;
  display_name?: string;
  importance?: number;
  osm_type?: string;
  category?: string;
}

export function normalizeHit(hit: WireHit): RawGeocodeHit | null {
  const lat = Number(hit.lat);
  const lon = Number(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return {
    lat,
    lon,
    displayName: hit.display_name ?? '',
    importance: typeof hit.importance === 'number' ? hit.importance : 0,
    osmType: hit.osm_type ?? null,
    category: hit.category ?? null,
  };
}

/**
 * Reject a "hit" that is really just the city again.
 *
 * Nominatim happily falls back to the settlement when it cannot find the venue,
 * which would hand back the very centroid we are trying to replace -- with a
 * higher authority attached. Anything within `minMetres` of the city centre, or
 * whose OSM category is a place/boundary rather than a feature, is not an upgrade.
 */
export function isVenueUpgrade(
  hit: RawGeocodeHit,
  cityCentre: { lat: number; lon: number },
  minMetres = 150,
): boolean {
  if (hit.category === 'place' || hit.category === 'boundary') return false;
  const dLat = (hit.lat - cityCentre.lat) * 111_320;
  const dLon =
    (hit.lon - cityCentre.lon) * 111_320 * Math.cos((cityCentre.lat * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLon * dLon) >= minMetres;
}

export function createGeocodeProvider(): Provider<RawGeocodeHit> {
  return {
    id: GEOCODE_PROVIDER_ID,
    kind: 'geography',
    sourceClass: 'open_dataset',
    authority: SOURCE_AUTHORITY.open_dataset,
    freshnessTier: 'base',
    regionScope: [] as readonly RegionCode[],

    isConfigured(ctx: ProviderContext): boolean {
      // Replay needs nothing. On the wire Nominatim requires contact details.
      return ctx.transport.mode !== 'network' || Boolean(process.env.SCOUT_GEOCODE_EMAIL);
    },

    async health(ctx: ProviderContext): Promise<ProviderHealth> {
      return checkHealth(GEOCODE_PROVIDER_ID, ctx, this.isConfigured(ctx), {
        request: {
          url: geocodeUrl(
            { name: 'Eiffel Tower', city: 'Paris', countryIso2: 'FR' },
            process.env.SCOUT_GEOCODE_EMAIL,
          ),
          headers: geocodeHeaders(),
        },
        sample: (body: string) => {
          const parsed: unknown = JSON.parse(body);
          return Array.isArray(parsed) ? (parsed[0] ?? null) : null;
        },
      });
    },

    async fetch(
      ctx: ProviderContext,
      req: FetchRequest,
    ): Promise<Result<FetchResponse<RawGeocodeHit>>> {
      const query = req.query as unknown as GeocodeQuery;
      if (!query?.name || !query?.city || !query?.countryIso2) {
        return err('invalid_input', `${GEOCODE_PROVIDER_ID}: query needs {name, city, countryIso2}`, {
          query: req.query,
        });
      }

      const response = await requestOk(GEOCODE_PROVIDER_ID, ctx, {
        url: geocodeUrl(query, process.env.SCOUT_GEOCODE_EMAIL),
        headers: geocodeHeaders(),
      });
      if (!response.ok) return response;

      const parsed = parseJsonBody<WireHit[]>(GEOCODE_PROVIDER_ID, response.value.body);
      if (!parsed.ok) return parsed;
      if (!Array.isArray(parsed.value)) {
        return err('upstream_schema_drift', `${GEOCODE_PROVIDER_ID}: expected an array`, {
          got: typeof parsed.value,
        });
      }

      const items = parsed.value
        .map(normalizeHit)
        .filter((hit): hit is RawGeocodeHit => hit !== null);

      return ok({
        items,
        fetchedAt: ctx.now(),
        replayed: response.value.replayed,
        schemaFingerprint: schemaFingerprintOf(parsed.value[0] ?? {}),
      });
    },
  };
}

function geocodeHeaders(): Record<string, string> {
  // Nominatim blocks unidentified clients. This is a requirement, not politeness.
  const email = process.env.SCOUT_GEOCODE_EMAIL;
  return {
    accept: 'application/json',
    'user-agent': `scout-travel-platform/0.1 (${email ?? 'contact-not-set'})`,
  };
}

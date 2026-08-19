/**
 * Places provider: family-facing attractions from a major aggregator.
 *
 * The wire contract below (cursor pagination, `X-Api-Key` header, 0..4 price
 * levels, 0..10 ratings, an age band and a typical visit length) is the shape
 * Scout normalises from. Aggregators differ in spelling but not in substance;
 * a second vendor is a second adapter, not a change here.
 *
 * Two things this adapter does that a mock would not:
 *   - it pages. A region is fetched until `next_cursor` is null, which is how
 *     the 120-row US region actually arrives (two pages of 100).
 *   - it normalises units. price_level 0..4 -> free/$/$$/$$$, rating 0..10 ->
 *     0..5 (the scale the places table checks), hours -> minutes.
 *
 * Credentials: SCOUT_PLACES_API_KEY. Absent it, `isConfigured` is false against
 * a network transport and health reports `unconfigured` rather than `down`.
 */

import type {
  FetchRequest,
  FetchResponse,
  IndoorOutdoor,
  PlaceCategory,
  PriceTier,
  Provider,
  ProviderContext,
  ProviderHealth,
  RegionCode,
  Result,
} from '../../contracts/index.ts';
import { INDOOR_OUTDOOR, PLACE_CATEGORIES, REGION_CODES, SOURCE_AUTHORITY, err, ok } from '../../contracts/index.ts';
import { checkHealth, fetchResponseOf, parseJsonBody, requestOk } from './geography.ts';

export const PLACES_PROVIDER_ID = 'provider:scout-seed';

export const PLACES_PROVIDER_META = {
  id: PLACES_PROVIDER_ID,
  name: 'Scout seed dataset',
  homepage: null,
} as const;

/**
 * A reserved-by-RFC-2606 `.invalid` host, chosen so nothing here can be
 * mistaken for a real vendor: this hostname is guaranteed never to resolve.
 *
 * There is no public places API carrying `min_age` / `max_age` /
 * `typical_visit_minutes`, which is precisely the data this dataset is about.
 * So this adapter is the SLOT a real aggregator will occupy -- its pagination,
 * header auth, price-level and rating normalisation are real work -- while the
 * rows it serves today are Scout's own seed data, and are labelled as such.
 */
const BASE_URL = 'https://seed.scout.invalid/v1';

/** Upstream page size. The US region needs two pages at this limit. */
export const PLACES_PAGE_LIMIT = 100;

/** Guard against a cursor loop in a misbehaving upstream. */
const MAX_PAGES = 25;

export function placesUrl(params: {
  region?: RegionCode;
  limit?: number;
  cursor?: string | null;
}): string {
  const search = new URLSearchParams();
  if (params.region) search.set('region', params.region);
  search.set('limit', String(params.limit ?? PLACES_PAGE_LIMIT));
  if (params.cursor) search.set('cursor', params.cursor);
  return `${BASE_URL}/places?${search.toString()}`;
}

/* ------------------------------------------------------------------ *
 * Wire shape
 * ------------------------------------------------------------------ */

interface WireLocation {
  lat?: number | null;
  lon?: number | null;
  precision?: string;
  city?: string;
  admin1?: string | null;
  country?: string;
  timezone?: string | null;
  city_lat?: number | null;
  city_lon?: number | null;
  neighborhood?: string | null;
}

interface WirePlace {
  id?: string;
  name?: string;
  category?: string;
  subcategory?: string | null;
  location?: WireLocation;
  price_level?: number | null;
  setting?: string | null;
  rating?: number | null;
  good_for_ages?: { min?: number | null; max?: number | null } | null;
  typical_visit_minutes?: number | null;
  description?: string | null;
  tags?: string[];
  region?: string;
}

interface WirePage {
  page?: { region?: string; limit?: number; returned?: number; next_cursor?: string | null };
  places?: WirePlace[];
}

/* ------------------------------------------------------------------ *
 * Normalised item
 * ------------------------------------------------------------------ */

export interface RawPlace {
  readonly externalId: string;
  readonly name: string;
  readonly category: PlaceCategory;
  readonly subcategory: string | null;
  readonly countryIso2: string;
  readonly regionCode: RegionCode;
  readonly cityName: string;
  readonly admin1: string | null;
  readonly cityLat: number | null;
  readonly cityLon: number | null;
  readonly timezone: string | null;
  readonly neighborhood: string | null;
  readonly lat: number | null;
  readonly lon: number | null;
  /** `venue` when the coordinate is the attraction, `city` when it is the centroid. */
  readonly locationPrecision: 'venue' | 'city';
  readonly priceTier: PriceTier | null;
  readonly indoorOutdoor: IndoorOutdoor | null;
  /** 0..5, converted from the aggregator's 0..10 scale. */
  readonly rating: number | null;
  readonly minAge: number | null;
  readonly maxAge: number | null;
  readonly durationMinutes: number | null;
  readonly description: string | null;
  readonly tags: readonly string[];
}

const CATEGORY_SET: ReadonlySet<string> = new Set(PLACE_CATEGORIES);
const SETTING_SET: ReadonlySet<string> = new Set(INDOOR_OUTDOOR);
const REGION_SET: ReadonlySet<string> = new Set(REGION_CODES);

/** price_level 0..4 -> the four tiers the schema allows. */
export function priceTierFromLevel(level: number | null | undefined): PriceTier | null {
  if (level === null || level === undefined || !Number.isFinite(level)) return null;
  if (level <= 0) return 'free';
  if (level === 1) return '$';
  if (level === 2) return '$$';
  return '$$$'; // 4 collapses into 3: the schema has no fourth paid tier
}

/** 0..10 aggregator rating -> the 0..5 scale stored on places. */
export function ratingFromTen(rating: number | null | undefined): number | null {
  if (rating === null || rating === undefined || !Number.isFinite(rating)) return null;
  const scaled = Math.round((rating / 2) * 100) / 100;
  return Math.min(5, Math.max(0, scaled));
}

function intOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(value);
}

function coord(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function normalisePlace(wire: WirePlace): RawPlace | null {
  const name = wire.name;
  const category = wire.category ?? '';
  const location = wire.location ?? {};
  const country = (location.country ?? '').toUpperCase();
  const city = location.city ?? '';
  const region = (wire.region ?? '').toUpperCase();

  if (!wire.id || !name || !CATEGORY_SET.has(category) || country.length !== 2 || !city) return null;
  if (!REGION_SET.has(region)) return null;

  const setting = (wire.setting ?? '').toLowerCase();
  const precision = location.precision === 'venue' ? 'venue' : 'city';

  return {
    externalId: wire.id,
    name,
    category: category as PlaceCategory,
    subcategory: wire.subcategory ?? null,
    countryIso2: country,
    regionCode: region as RegionCode,
    cityName: city,
    admin1: location.admin1 ?? null,
    cityLat: coord(location.city_lat),
    cityLon: coord(location.city_lon),
    timezone: location.timezone ?? null,
    neighborhood: location.neighborhood ?? null,
    lat: coord(location.lat),
    lon: coord(location.lon),
    locationPrecision: precision,
    priceTier: priceTierFromLevel(wire.price_level),
    indoorOutdoor: SETTING_SET.has(setting) ? (setting as IndoorOutdoor) : null,
    rating: ratingFromTen(wire.rating),
    minAge: intOrNull(wire.good_for_ages?.min),
    maxAge: intOrNull(wire.good_for_ages?.max),
    durationMinutes: intOrNull(wire.typical_visit_minutes),
    description: wire.description ?? null,
    tags: Array.isArray(wire.tags) ? wire.tags.filter((t) => typeof t === 'string') : [],
  };
}

function authHeaders(ctx: ProviderContext): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' };
  // The key travels in a header, never the query string: it must not leak into
  // logs, caches or fixture keys.
  if (ctx.credentials.apiKey) headers['x-api-key'] = ctx.credentials.apiKey;
  return headers;
}

export function createPlacesProvider(): Provider<RawPlace> {
  return {
    id: PLACES_PROVIDER_ID,
    kind: 'places',
    // Seed data must never outrank a real source. SOURCE_AUTHORITY.seed = 0.35.
    sourceClass: 'seed',
    authority: SOURCE_AUTHORITY.seed,
    freshnessTier: 'periodic',
    regionScope: [],

    isConfigured(ctx: ProviderContext): boolean {
      // Replay needs no credentials -- the bytes are already recorded. On the
      // wire the key is mandatory.
      return ctx.transport.mode === 'fixture' || Boolean(ctx.credentials.apiKey);
    },

    health(ctx: ProviderContext): Promise<ProviderHealth> {
      return checkHealth(PLACES_PROVIDER_ID, ctx, this.isConfigured(ctx), {
        request: {
          url: placesUrl({ region: 'EU', limit: 1 }),
          method: 'GET',
          headers: authHeaders(ctx),
          timeoutMs: 5_000,
        },
        sample: (body) => {
          const page = JSON.parse(body) as WirePage;
          const first = page.places?.[0];
          return first && normalisePlace(first) ? first : null;
        },
      });
    },

    async fetch(ctx: ProviderContext, req: FetchRequest): Promise<Result<FetchResponse<RawPlace>>> {
      const fetchedAt = ctx.now();
      const regions: RegionCode[] = req.regionCode
        ? [req.regionCode]
        : Array.isArray(req.query.regions)
          ? (req.query.regions as RegionCode[])
          : [...REGION_CODES];

      const items: RawPlace[] = [];
      let replayed = true;
      let wireSample: unknown = null;
      let dropped = 0;

      for (const region of regions) {
        let cursor: string | null = null;
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const url: string = placesUrl({ region, limit: PLACES_PAGE_LIMIT, cursor });
          const response = await requestOk(PLACES_PROVIDER_ID, ctx, {
            url,
            method: 'GET',
            headers: authHeaders(ctx),
            timeoutMs: 15_000,
          });
          if (!response.ok) return response;
          replayed = replayed && response.value.replayed;

          const parsed = parseJsonBody<WirePage>(PLACES_PROVIDER_ID, response.value.body);
          if (!parsed.ok) return parsed;
          const body = parsed.value;
          if (!body || !Array.isArray(body.places)) {
            return err('upstream_schema_drift', `${PLACES_PROVIDER_ID}: page had no places array`, {
              providerId: PLACES_PROVIDER_ID,
              url,
            });
          }

          wireSample ??= body.places[0] ?? null;
          for (const row of body.places) {
            const place = normalisePlace(row);
            if (!place) {
              dropped += 1;
              continue;
            }
            items.push(place);
          }

          if (req.limit && items.length >= req.limit) {
            items.length = req.limit;
            cursor = null;
            break;
          }
          cursor = body.page?.next_cursor ?? null;
          if (!cursor) break;
        }
        if (req.limit && items.length >= req.limit) break;
      }

      // Every row unusable means the contract moved under us, not that the
      // region is empty.
      if (items.length === 0 && dropped > 0) {
        return err('upstream_schema_drift', `${PLACES_PROVIDER_ID}: ${dropped} rows, none in the expected shape`, {
          providerId: PLACES_PROVIDER_ID,
          dropped,
        });
      }

      return ok(fetchResponseOf(items, { replayed }, wireSample, fetchedAt));
    },
  };
}

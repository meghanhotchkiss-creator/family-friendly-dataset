/**
 * Weather provider: current conditions by coordinate. This is the adapter that
 * exercises the `live` freshness tier (5 minute TTL, 1 day confidence
 * half-life), so a cached observation ages out fast.
 *
 * Upstream is Open-Meteo (https://open-meteo.com), which is keyless for
 * non-commercial use and accepts comma-separated coordinate lists, returning
 * one object per point. Batching is real behaviour, not a fixture convenience:
 * a whole city list is one request.
 */

import type {
  FetchRequest,
  FetchResponse,
  Provider,
  ProviderContext,
  ProviderHealth,
  Result,
} from '../../contracts/index.ts';
import { err, ok } from '../../contracts/index.ts';
import { checkHealth, fetchResponseOf, parseJsonBody, requestOk } from './geography.ts';

export const WEATHER_PROVIDER_ID = 'provider:open-meteo';

export const WEATHER_PROVIDER_META = {
  id: WEATHER_PROVIDER_ID,
  name: 'Open-Meteo',
  homepage: 'https://open-meteo.com',
} as const;

const BASE_URL = 'https://api.open-meteo.com/v1/forecast';

/** The `current` block Scout asks for. Order is part of the URL identity. */
const CURRENT_FIELDS =
  'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,is_day';

export interface WeatherPoint {
  readonly lat: number;
  readonly lon: number;
  readonly label?: string;
}

/** Cities the platform keeps warm by default: one request covers all of them. */
export const DEFAULT_WEATHER_POINTS: readonly WeatherPoint[] = [
  { lat: 37.7749, lon: -122.4194, label: 'San Francisco' },
  { lat: 40.7128, lon: -74.006, label: 'New York' },
  { lat: 51.5074, lon: -0.1278, label: 'London' },
  { lat: 35.6762, lon: 139.6503, label: 'Tokyo' },
  { lat: -33.8688, lon: 151.2093, label: 'Sydney' },
  { lat: -23.5505, lon: -46.6333, label: 'Sao Paulo' },
];

/**
 * Coordinates are fixed to 4 decimals (about 11 m) so the same city always
 * produces the same URL -- and therefore the same cache key and fixture name.
 */
function coordList(points: readonly WeatherPoint[], pick: (p: WeatherPoint) => number): string {
  return points.map((p) => pick(p).toFixed(4)).join(',');
}

export function weatherUrl(points: readonly WeatherPoint[]): string {
  const search = new URLSearchParams();
  search.set('latitude', coordList(points, (p) => p.lat));
  search.set('longitude', coordList(points, (p) => p.lon));
  search.set('current', CURRENT_FIELDS);
  search.set('timezone', 'UTC');
  return `${BASE_URL}?${search.toString()}`;
}

interface WireCurrent {
  time?: string;
  temperature_2m?: number;
  apparent_temperature?: number;
  relative_humidity_2m?: number;
  precipitation?: number;
  weather_code?: number;
  wind_speed_10m?: number;
  is_day?: number;
}

interface WireForecast {
  latitude?: number;
  longitude?: number;
  timezone?: string;
  elevation?: number;
  current?: WireCurrent;
  current_units?: Record<string, string>;
}

export interface RawWeather {
  readonly lat: number;
  readonly lon: number;
  readonly label: string | null;
  readonly observedAt: string;
  readonly temperatureC: number | null;
  readonly feelsLikeC: number | null;
  readonly humidityPct: number | null;
  readonly precipitationMm: number | null;
  readonly windKph: number | null;
  /** WMO weather interpretation code. */
  readonly weatherCode: number | null;
  readonly isDay: boolean | null;
  readonly timezone: string | null;
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function normaliseWeather(
  wire: WireForecast,
  point: WeatherPoint | undefined,
  fetchedAt: string,
): RawWeather | null {
  const current = wire.current;
  if (!current || typeof current !== 'object') return null;
  const lat = numOrNull(wire.latitude) ?? point?.lat ?? null;
  const lon = numOrNull(wire.longitude) ?? point?.lon ?? null;
  if (lat === null || lon === null) return null;
  if (numOrNull(current.temperature_2m) === null) return null;

  // Open-Meteo reports the observation time without a zone when timezone=UTC.
  const time = current.time ? `${current.time}${current.time.endsWith('Z') ? '' : ':00Z'}` : null;
  const observedAt = time && !Number.isNaN(Date.parse(time)) ? new Date(time).toISOString() : fetchedAt;

  return {
    lat,
    lon,
    label: point?.label ?? null,
    observedAt,
    temperatureC: numOrNull(current.temperature_2m),
    feelsLikeC: numOrNull(current.apparent_temperature),
    humidityPct: numOrNull(current.relative_humidity_2m),
    precipitationMm: numOrNull(current.precipitation),
    windKph: numOrNull(current.wind_speed_10m),
    weatherCode: numOrNull(current.weather_code),
    isDay: current.is_day === undefined ? null : current.is_day === 1,
    timezone: wire.timezone ?? null,
  };
}

function pointsFrom(req: FetchRequest): WeatherPoint[] | null {
  const query = req.query;
  if (Array.isArray(query.points)) {
    const points: WeatherPoint[] = [];
    for (const entry of query.points as Record<string, unknown>[]) {
      const lat = numOrNull(entry?.lat);
      const lon = numOrNull(entry?.lon);
      if (lat === null || lon === null) return null;
      points.push({ lat, lon, label: typeof entry.label === 'string' ? entry.label : undefined });
    }
    return points.length > 0 ? points : null;
  }
  const lat = numOrNull(query.lat);
  const lon = numOrNull(query.lon);
  if (lat !== null && lon !== null) {
    return [{ lat, lon, label: typeof query.label === 'string' ? query.label : undefined }];
  }
  return [...DEFAULT_WEATHER_POINTS];
}

export function createWeatherProvider(): Provider<RawWeather> {
  return {
    id: WEATHER_PROVIDER_ID,
    kind: 'weather',
    sourceClass: 'official',
    authority: 0.95,
    freshnessTier: 'live',
    regionScope: [],

    isConfigured(_ctx: ProviderContext): boolean {
      // Open-Meteo's free tier is keyless. A commercial key would be read from
      // ctx.credentials here and appended as `apikey`.
      return true;
    },

    health(ctx: ProviderContext): Promise<ProviderHealth> {
      const probePoint = DEFAULT_WEATHER_POINTS[2] as WeatherPoint; // London
      return checkHealth(WEATHER_PROVIDER_ID, ctx, this.isConfigured(ctx), {
        request: { url: weatherUrl([probePoint]), method: 'GET', timeoutMs: 5_000 },
        sample: (body) => {
          const parsed: unknown = JSON.parse(body);
          const first = Array.isArray(parsed) ? parsed[0] : parsed;
          if (!first || typeof first !== 'object') return null;
          return normaliseWeather(first as WireForecast, probePoint, '') ? first : null;
        },
      });
    },

    async fetch(ctx: ProviderContext, req: FetchRequest): Promise<Result<FetchResponse<RawWeather>>> {
      const fetchedAt = ctx.now();
      const points = pointsFrom(req);
      if (!points) {
        return err('invalid_input', `${WEATHER_PROVIDER_ID}: query needs {lat,lon} or {points:[{lat,lon}]}`, {
          providerId: WEATHER_PROVIDER_ID,
          query: req.query,
        });
      }

      const response = await requestOk(WEATHER_PROVIDER_ID, ctx, {
        url: weatherUrl(points),
        method: 'GET',
        headers: { accept: 'application/json' },
        timeoutMs: 10_000,
      });
      if (!response.ok) return response;

      const parsed = parseJsonBody<unknown>(WEATHER_PROVIDER_ID, response.value.body);
      if (!parsed.ok) return parsed;

      // A single coordinate returns an object; a list returns an array.
      const wire: WireForecast[] = Array.isArray(parsed.value)
        ? (parsed.value as WireForecast[])
        : [parsed.value as WireForecast];

      const items: RawWeather[] = [];
      for (let i = 0; i < wire.length; i += 1) {
        const observation = normaliseWeather(wire[i] as WireForecast, points[i], fetchedAt);
        if (observation) items.push(observation);
      }

      if (items.length === 0) {
        return err('upstream_schema_drift', `${WEATHER_PROVIDER_ID}: no forecast carried a current block`, {
          providerId: WEATHER_PROVIDER_ID,
          points: points.length,
        });
      }

      return ok(fetchResponseOf(items, response.value, wire[0] ?? null, fetchedAt));
    },
  };
}

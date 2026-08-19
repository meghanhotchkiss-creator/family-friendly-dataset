/**
 * Airports provider: the OurAirports open dataset.
 *
 * https://davidmegginson.github.io/ourairports-data/airports.csv is the
 * canonical public airport table (id, ident, type, name, coordinates,
 * continent, iso_country, iso_region, municipality, iata_code, ...). It is a
 * plain CSV file, so this adapter reuses the GTFS CSV reader rather than
 * inventing a second one.
 *
 * Region flags are the interesting piece of normalisation: OurAirports has six
 * continent codes and Scout has eight regions, so Central America/Caribbean and
 * the Middle East are pinned per country by the geography adapter's table.
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
import { err, ok } from '../../contracts/index.ts';
import { checkHealth, fetchResponseOf, regionForContinent, requestOk } from './geography.ts';
import { parseCsv } from './gtfs.ts';

export const AIRPORTS_PROVIDER_ID = 'provider:ourairports';

export const AIRPORTS_PROVIDER_META = {
  id: AIRPORTS_PROVIDER_ID,
  name: 'OurAirports',
  homepage: 'https://ourairports.com/data/',
} as const;

const BASE_URL = 'https://davidmegginson.github.io/ourairports-data';

export function airportsUrl(): string {
  return `${BASE_URL}/airports.csv`;
}

/** countries.csv is a few kilobytes: the cheap probe on the same dataset. */
export function airportsProbeUrl(): string {
  return `${BASE_URL}/countries.csv`;
}

export interface RawAirport {
  readonly iata: string | null;
  readonly icao: string | null;
  readonly name: string;
  readonly kind: 'large' | 'medium' | 'small';
  readonly lat: number;
  readonly lon: number;
  readonly countryIso2: string;
  readonly regionCode: RegionCode;
  readonly municipality: string | null;
  /** ISO 3166-2 subdivision suffix, e.g. `CA` out of `US-CA`. */
  readonly admin1: string | null;
}

const KIND_BY_TYPE: Readonly<Record<string, RawAirport['kind']>> = {
  large_airport: 'large',
  medium_airport: 'medium',
  small_airport: 'small',
};

/** Turn one OurAirports CSV row into a RawAirport, or null when unusable. */
export function normaliseAirport(row: Record<string, string>): RawAirport | null {
  const kind = KIND_BY_TYPE[row.type ?? ''];
  const name = row.name ?? '';
  const iso2 = (row.iso_country ?? '').toUpperCase();
  if (!kind || !name || iso2.length !== 2) return null;

  const lat = Number(row.latitude_deg);
  const lon = Number(row.longitude_deg);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const regionCode = regionForContinent(iso2, row.continent ?? '');
  if (!regionCode) return null;

  const iata = (row.iata_code ?? '').toUpperCase();
  const icao = (row.gps_code || row.ident || '').toUpperCase();
  const isoRegion = row.iso_region ?? '';
  const admin1 = isoRegion.includes('-') ? isoRegion.slice(isoRegion.indexOf('-') + 1) : null;

  return {
    iata: iata.length === 3 ? iata : null,
    icao: icao.length === 4 ? icao : null,
    name,
    kind,
    lat,
    lon,
    countryIso2: iso2,
    regionCode,
    municipality: row.municipality ? row.municipality : null,
    admin1: admin1 && admin1 !== '' ? admin1 : null,
  };
}

export function createAirportsProvider(): Provider<RawAirport> {
  return {
    id: AIRPORTS_PROVIDER_ID,
    kind: 'airports',
    sourceClass: 'open_dataset',
    authority: 0.7,
    freshnessTier: 'base',
    regionScope: [],

    isConfigured(_ctx: ProviderContext): boolean {
      // A static public CSV: nothing to configure.
      return true;
    },

    health(ctx: ProviderContext): Promise<ProviderHealth> {
      return checkHealth(AIRPORTS_PROVIDER_ID, ctx, this.isConfigured(ctx), {
        request: { url: airportsProbeUrl(), method: 'GET', timeoutMs: 5_000 },
        sample: (body) => {
          const rows = parseCsv(body);
          const first = rows[0];
          // countries.csv carries code/name/continent; that is enough to say
          // "the dataset is still being served in the shape we parse".
          return first && 'code' in first && 'continent' in first ? first : null;
        },
      });
    },

    async fetch(ctx: ProviderContext, req: FetchRequest): Promise<Result<FetchResponse<RawAirport>>> {
      const fetchedAt = ctx.now();
      const response = await requestOk(AIRPORTS_PROVIDER_ID, ctx, {
        url: airportsUrl(),
        method: 'GET',
        headers: { accept: 'text/csv' },
        timeoutMs: 30_000,
      });
      if (!response.ok) return response;

      const rows = parseCsv(response.value.body);
      if (rows.length === 0 || !('iso_country' in (rows[0] as Record<string, string>))) {
        return err('upstream_schema_drift', `${AIRPORTS_PROVIDER_ID}: airports.csv did not carry the expected columns`, {
          providerId: AIRPORTS_PROVIDER_ID,
          columns: Object.keys(rows[0] ?? {}),
        });
      }

      const requireIata = req.query.requireIata !== false;
      const items: RawAirport[] = [];
      for (const row of rows) {
        const airport = normaliseAirport(row);
        if (!airport) continue;
        if (requireIata && !airport.iata) continue;
        if (req.regionCode && airport.regionCode !== req.regionCode) continue;
        items.push(airport);
        if (req.limit && items.length >= req.limit) break;
      }

      if (items.length === 0 && !req.regionCode) {
        return err('upstream_schema_drift', `${AIRPORTS_PROVIDER_ID}: no row parsed into an airport`, {
          providerId: AIRPORTS_PROVIDER_ID,
          rows: rows.length,
        });
      }

      return ok(fetchResponseOf(items, response.value, rows[0] ?? null, fetchedAt));
    },
  };
}

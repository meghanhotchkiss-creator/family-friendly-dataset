/**
 * GTFS static provider: agencies, stops and routes for a transit feed.
 *
 * A GTFS feed is a set of CSV files. Agencies publish them as a zip, and Scout
 * reads the unzipped mirror of that feed -- `<base>/agency.txt`,
 * `<base>/stops.txt`, `<base>/routes.txt` -- so the adapter never needs an
 * archive reader. The catalog below carries real feed bases; going live is
 * SCOUT_TRANSPORT=network and nothing else.
 *
 * This file also owns the CSV reader, because GTFS is the format that forces it
 * to be correct: agency and route names contain commas and quotes, so a naive
 * split(',') mangles real feeds. The airports adapter reuses it for the
 * OurAirports CSV.
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
import { shortHash } from '../../runtime/hash.ts';
import { checkHealth, fetchResponseOf, requestOk } from './geography.ts';

/* ------------------------------------------------------------------ *
 * CSV
 * ------------------------------------------------------------------ */

/**
 * RFC 4180 CSV, which is what GTFS is: fields may be quoted, a quoted field may
 * contain commas, newlines and doubled quotes (`""` -> `"`). Handles CRLF and a
 * UTF-8 BOM, and ignores a trailing newline.
 */
export function parseCsvRows(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false; // distinguishes an empty trailing line from a real empty field

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i] as string;

    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field === '') {
      quoted = true;
      started = true;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      started = true;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i += 1;
      if (started || field !== '' || row.length > 0) {
        row.push(field);
        rows.push(row);
      }
      row = [];
      field = '';
      started = false;
      continue;
    }
    field += ch;
    started = true;
  }

  if (started || field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Rows keyed by the header line, values trimmed of surrounding whitespace. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows = parseCsvRows(text);
  const header = rows[0];
  if (!header) return [];
  const keys = header.map((k) => k.trim());
  const out: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r] as string[];
    const record: Record<string, string> = {};
    for (let c = 0; c < keys.length; c += 1) {
      record[keys[c] as string] = (row[c] ?? '').trim();
    }
    out.push(record);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Feed catalog
 * ------------------------------------------------------------------ */

export interface GtfsFeedSource {
  readonly id: string;
  readonly name: string;
  readonly cityName: string;
  readonly admin1: string | null;
  readonly countryIso2: string;
  readonly regionCode: RegionCode;
  /** Base of the unzipped static feed. Files hang directly off it. */
  readonly baseUrl: string;
}

export const GTFS_FEEDS: readonly GtfsFeedSource[] = [
  {
    id: 'bart',
    name: 'Bay Area Rapid Transit',
    cityName: 'San Francisco',
    admin1: 'CA',
    countryIso2: 'US',
    regionCode: 'NA',
    baseUrl: 'https://www.bart.gov/dev/schedules/google_transit',
  },
  {
    id: 'tfl',
    name: 'Transport for London',
    cityName: 'London',
    admin1: null,
    countryIso2: 'GB',
    regionCode: 'EU',
    baseUrl: 'https://tfl.gov.uk/gtfs',
  },
  {
    id: 'tokyo-metro',
    name: 'Tokyo Metro',
    cityName: 'Tokyo',
    admin1: null,
    countryIso2: 'JP',
    regionCode: 'AS',
    baseUrl: 'https://api.odpt.org/gtfs/tokyometro',
  },
];

export const GTFS_FILES = ['agency.txt', 'stops.txt', 'routes.txt'] as const;
export type GtfsFile = (typeof GTFS_FILES)[number];

export function gtfsFileUrl(feed: GtfsFeedSource, file: GtfsFile): string {
  return `${feed.baseUrl}/${file}`;
}

/* ------------------------------------------------------------------ *
 * Normalised items
 * ------------------------------------------------------------------ */

export interface RawGtfsAgency {
  readonly agencyId: string;
  readonly name: string;
  readonly timezone: string | null;
  readonly url: string | null;
}

export interface RawGtfsStop {
  readonly stopId: string;
  readonly code: string | null;
  readonly name: string;
  readonly lat: number | null;
  readonly lon: number | null;
}

export interface RawGtfsRoute {
  readonly routeId: string;
  readonly agencyId: string | null;
  readonly shortName: string | null;
  readonly longName: string | null;
  readonly routeType: number | null;
}

export interface RawGtfsFeed {
  readonly feedId: string;
  readonly name: string;
  readonly cityName: string;
  readonly admin1: string | null;
  readonly countryIso2: string;
  readonly regionCode: RegionCode;
  readonly sourceUrl: string;
  /** Hash of the three files, so an unchanged feed is a no-op on re-import. */
  readonly feedHash: string;
  readonly agencies: readonly RawGtfsAgency[];
  readonly stops: readonly RawGtfsStop[];
  readonly routes: readonly RawGtfsRoute[];
}

function num(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function text(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}

export function normaliseAgencies(rows: Record<string, string>[]): RawGtfsAgency[] {
  return rows
    .filter((r) => (r.agency_name ?? '') !== '')
    .map((r) => ({
      // agency_id is optional in GTFS when a feed has exactly one agency.
      agencyId: r.agency_id && r.agency_id !== '' ? r.agency_id : (r.agency_name as string),
      name: r.agency_name as string,
      timezone: text(r.agency_timezone),
      url: text(r.agency_url),
    }));
}

export function normaliseStops(rows: Record<string, string>[]): RawGtfsStop[] {
  return rows
    .filter((r) => (r.stop_id ?? '') !== '' && (r.stop_name ?? '') !== '')
    // location_type 0/empty is a stop or platform; 1 is a station, 2+ are
    // entrances and generic nodes we do not model.
    .filter((r) => (r.location_type ?? '') === '' || r.location_type === '0' || r.location_type === '1')
    .map((r) => ({
      stopId: r.stop_id as string,
      code: text(r.stop_code),
      name: r.stop_name as string,
      lat: num(r.stop_lat),
      lon: num(r.stop_lon),
    }));
}

export function normaliseRoutes(rows: Record<string, string>[]): RawGtfsRoute[] {
  return rows
    .filter((r) => (r.route_id ?? '') !== '')
    .map((r) => ({
      routeId: r.route_id as string,
      agencyId: text(r.agency_id),
      shortName: text(r.route_short_name),
      longName: text(r.route_long_name),
      routeType: num(r.route_type),
    }));
}

/* ------------------------------------------------------------------ *
 * The provider
 * ------------------------------------------------------------------ */

export const GTFS_PROVIDER_ID = 'provider:gtfs-static';

export const GTFS_PROVIDER_META = {
  id: GTFS_PROVIDER_ID,
  name: 'GTFS static feeds',
  homepage: 'https://gtfs.org/schedule/reference/',
} as const;

function feedsFor(req: FetchRequest): readonly GtfsFeedSource[] {
  const requested = req.query.feedIds;
  const ids = Array.isArray(requested) ? requested.map(String) : null;
  return GTFS_FEEDS.filter(
    (feed) =>
      (!ids || ids.includes(feed.id)) && (!req.regionCode || feed.regionCode === req.regionCode),
  );
}

export function createGtfsProvider(): Provider<RawGtfsFeed> {
  return {
    id: GTFS_PROVIDER_ID,
    kind: 'gtfs',
    sourceClass: 'official',
    authority: 0.95,
    freshnessTier: 'periodic',
    regionScope: [],

    isConfigured(_ctx: ProviderContext): boolean {
      // Static feeds are public files; no credentials exist to be missing.
      return true;
    },

    health(ctx: ProviderContext): Promise<ProviderHealth> {
      const feed = GTFS_FEEDS[0] as GtfsFeedSource;
      return checkHealth(GTFS_PROVIDER_ID, ctx, this.isConfigured(ctx), {
        // agency.txt is the smallest required file in every feed: the cheapest
        // honest probe of "is this feed still being served".
        request: { url: gtfsFileUrl(feed, 'agency.txt'), method: 'GET', timeoutMs: 5_000 },
        sample: (body) => {
          const rows = parseCsv(body);
          return normaliseAgencies(rows).length > 0 ? rows[0] : null;
        },
      });
    },

    async fetch(ctx: ProviderContext, req: FetchRequest): Promise<Result<FetchResponse<RawGtfsFeed>>> {
      const fetchedAt = ctx.now();
      const feeds = feedsFor(req);
      if (feeds.length === 0) {
        return err('invalid_input', `${GTFS_PROVIDER_ID}: no feed matched the request`, {
          providerId: GTFS_PROVIDER_ID,
          query: req.query,
          regionCode: req.regionCode ?? null,
        });
      }

      const items: RawGtfsFeed[] = [];
      let replayed = true;
      let wireSample: unknown = null;

      for (const feed of feeds) {
        const bodies: Record<string, string> = {};
        for (const file of GTFS_FILES) {
          const response = await requestOk(GTFS_PROVIDER_ID, ctx, {
            url: gtfsFileUrl(feed, file),
            method: 'GET',
            headers: { accept: 'text/csv' },
            timeoutMs: 15_000,
          });
          if (!response.ok) return response;
          replayed = replayed && response.value.replayed;
          bodies[file] = response.value.body;
        }

        const agencyRows = parseCsv(bodies['agency.txt'] as string);
        const stopRows = parseCsv(bodies['stops.txt'] as string);
        const routeRows = parseCsv(bodies['routes.txt'] as string);

        const agencies = normaliseAgencies(agencyRows);
        const stops = normaliseStops(stopRows);
        const routes = normaliseRoutes(routeRows);

        // A feed with no agency or no stops is not a feed; treat it as drift
        // rather than importing an empty transit graph.
        if (agencies.length === 0 || stops.length === 0) {
          return err('upstream_schema_drift', `${GTFS_PROVIDER_ID}: feed ${feed.id} is missing agencies or stops`, {
            providerId: GTFS_PROVIDER_ID,
            feedId: feed.id,
            agencies: agencies.length,
            stops: stops.length,
          });
        }

        wireSample ??= stopRows[0] ?? agencyRows[0] ?? null;
        items.push({
          feedId: feed.id,
          name: feed.name,
          cityName: feed.cityName,
          admin1: feed.admin1,
          countryIso2: feed.countryIso2,
          regionCode: feed.regionCode,
          sourceUrl: feed.baseUrl,
          feedHash: shortHash(GTFS_FILES.map((f) => bodies[f] ?? '').join(' ')),
          agencies,
          stops,
          routes,
        });
      }

      return ok(fetchResponseOf(items, { replayed }, wireSample, fetchedAt));
    },
  };
}

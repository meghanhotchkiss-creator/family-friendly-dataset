/**
 * Shared read/write for the geography spine and users.
 *
 * Owned centrally because every track reads these. Track-local tables get
 * track-local access; these do not.
 */

import type { Db } from './index.ts';
import { jsonColumn } from './index.ts';
import type { City, Country, Neighborhood, Airport, Region, RegionCode } from '../contracts/index.ts';
import { REGION_LABELS, makeId } from '../contracts/index.ts';
import { nowIso } from '../runtime/clock.ts';

export function ensureRegions(db: Db): number {
  const stmt =
    'INSERT INTO regions (id, code, name) VALUES (?, ?, ?) ON CONFLICT(code) DO NOTHING';
  let n = 0;
  for (const [code, name] of Object.entries(REGION_LABELS)) {
    n += db.run(stmt, makeId('region', code), code, name).changes;
  }
  return n;
}

export function upsertCountry(db: Db, c: Omit<Country, 'id'> & { id?: string }): string {
  const id = c.id ?? makeId('country', c.iso2);
  db.run(
    `INSERT INTO countries (id, iso2, iso3, name, region_code, currency, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, region_code = excluded.region_code,
       currency = excluded.currency, updated_at = excluded.updated_at`,
    id, c.iso2, c.iso3, c.name, c.regionCode, c.currency, nowIso(),
  );
  return id;
}

export function upsertCity(db: Db, c: Omit<City, 'id'> & { id?: string }): string {
  const id = c.id ?? makeId('city', c.countryId.replace('country:', ''), c.admin1 ?? '', c.name);
  db.run(
    `INSERT INTO cities (id, name, country_id, admin1, lat, lon, population, timezone, geoname_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, lat = excluded.lat, lon = excluded.lon,
       population = excluded.population, timezone = excluded.timezone,
       geoname_id = COALESCE(excluded.geoname_id, cities.geoname_id),
       updated_at = excluded.updated_at`,
    id, c.name, c.countryId, c.admin1, c.lat, c.lon, c.population, c.timezone,
    (c as { geonameId?: number | null }).geonameId ?? null, nowIso(),
  );
  return id;
}

export function upsertNeighborhood(db: Db, n: Omit<Neighborhood, 'id'> & { id?: string }): string {
  const id = n.id ?? makeId('neighborhood', n.cityId.replace('city:', ''), n.name);
  db.run(
    `INSERT INTO neighborhoods (id, city_id, name, lat, lon, local_character, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, lat = excluded.lat, lon = excluded.lon,
       local_character = excluded.local_character, updated_at = excluded.updated_at`,
    id, n.cityId, n.name, n.lat, n.lon, n.localCharacter, nowIso(),
  );
  return id;
}

/**
 * Columns OurAirports carries that the frozen `Airport` contract does not.
 *
 * They live here rather than widening the contract because nothing downstream
 * reasons about them -- they are detail the graph stores and serves, not
 * signals the recommender branches on.
 */
export interface AirportExtras {
  geonameId?: number | null;
  cityGeonameId?: number | null;
  ident?: string | null;
  gpsCode?: string | null;
  localCode?: string | null;
  isoRegion?: string | null;
  admin1?: string | null;
  airportType?: string | null;
  elevationFt?: number | null;
  scheduledService?: boolean | null;
  homeLink?: string | null;
  wikipediaLink?: string | null;
}

export function upsertAirport(db: Db, a: Omit<Airport, 'id'> & { id?: string } & AirportExtras): string {
  const id = a.id ?? makeId('airport', a.iata ?? a.icao ?? a.name);
  db.run(
    `INSERT INTO airports (id, iata, icao, name, city_id, country_id, region_code, lat, lon, kind,
       geoname_id, city_geoname_id, ident, gps_code, local_code, iso_region, admin1, airport_type, elevation_ft,
       scheduled_service, home_link, wikipedia_link, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       -- Codes are COALESCEd, not overwritten. Two sources describing one
       -- airport rarely carry the same identifiers: OurAirports publishes an
       -- ICAO for 10,446 of 85,936 rows, so letting it overwrite meant a second
       -- source erased an ICAO the first one knew. A real correction still
       -- wins; only a null loses.
       iata = COALESCE(excluded.iata, airports.iata),
       icao = COALESCE(excluded.icao, airports.icao),
       name = excluded.name,
       city_id = excluded.city_id, lat = excluded.lat, lon = excluded.lon,
       kind = excluded.kind,
       -- Geography tracks the source. It used to be insert-only, so an airport
       -- kept whichever region the first source that mentioned it happened to
       -- resolve, and a later correction in the countries table never reached it.
       country_id = excluded.country_id, region_code = excluded.region_code,
       geoname_id = COALESCE(excluded.geoname_id, airports.geoname_id),
       city_geoname_id = COALESCE(excluded.city_geoname_id, airports.city_geoname_id),
       ident = COALESCE(excluded.ident, airports.ident),
       gps_code = COALESCE(excluded.gps_code, airports.gps_code),
       local_code = COALESCE(excluded.local_code, airports.local_code),
       iso_region = COALESCE(excluded.iso_region, airports.iso_region),
       admin1 = COALESCE(excluded.admin1, airports.admin1),
       airport_type = COALESCE(excluded.airport_type, airports.airport_type),
       elevation_ft = COALESCE(excluded.elevation_ft, airports.elevation_ft),
       scheduled_service = COALESCE(excluded.scheduled_service, airports.scheduled_service),
       home_link = COALESCE(excluded.home_link, airports.home_link),
       wikipedia_link = COALESCE(excluded.wikipedia_link, airports.wikipedia_link),
       updated_at = excluded.updated_at`,
    id, a.iata, a.icao, a.name, a.cityId, a.countryId, a.regionCode, a.lat, a.lon, a.kind,
    a.geonameId ?? null, a.cityGeonameId ?? null,
    a.ident ?? null, a.gpsCode ?? null, a.localCode ?? null, a.isoRegion ?? null, a.admin1 ?? null, a.airportType ?? null,
    a.elevationFt ?? null,
    a.scheduledService === null || a.scheduledService === undefined ? null : a.scheduledService ? 1 : 0,
    a.homeLink ?? null, a.wikipediaLink ?? null, nowIso(),
  );
  return id;
}

export interface AdminRegionInput {
  code: string; localCode: string | null; name: string; continent: string | null;
  countryIso2: string; countryId: string | null; wikipediaLink: string | null;
}

/** OurAirports `regions.csv`: the `US-PA` -> "Pennsylvania" join airports need. */
export function upsertAdminRegion(db: Db, r: AdminRegionInput): string {
  const id = makeId('admin_region', r.code);
  db.run(
    `INSERT INTO admin_regions (id, code, local_code, name, continent, country_iso2, country_id, wikipedia_link, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       local_code = excluded.local_code, name = excluded.name, continent = excluded.continent,
       country_iso2 = excluded.country_iso2, country_id = excluded.country_id,
       wikipedia_link = excluded.wikipedia_link, updated_at = excluded.updated_at`,
    id, r.code, r.localCode, r.name, r.continent, r.countryIso2, r.countryId, r.wikipediaLink, nowIso(),
  );
  return id;
}

export interface RunwayInput {
  sourceId: string; airportIdent: string; airportId: string | null;
  lengthFt: number | null; widthFt: number | null; surface: string | null;
  lighted: boolean | null; closed: boolean | null;
  leIdent: string | null; heIdent: string | null;
}

export function upsertRunway(db: Db, r: RunwayInput): string {
  const id = makeId('runway', r.sourceId);
  db.run(
    `INSERT INTO runways (id, airport_ident, airport_id, length_ft, width_ft, surface,
       lighted, closed, le_ident, he_ident, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       airport_ident = excluded.airport_ident, airport_id = excluded.airport_id,
       length_ft = excluded.length_ft, width_ft = excluded.width_ft, surface = excluded.surface,
       lighted = excluded.lighted, closed = excluded.closed,
       le_ident = excluded.le_ident, he_ident = excluded.he_ident, updated_at = excluded.updated_at`,
    id, r.airportIdent, r.airportId, r.lengthFt, r.widthFt, r.surface,
    r.lighted === null ? null : r.lighted ? 1 : 0,
    r.closed === null ? null : r.closed ? 1 : 0,
    r.leIdent, r.heIdent, nowIso(),
  );
  return id;
}

export interface FrequencyInput {
  sourceId: string; airportIdent: string; airportId: string | null;
  frequencyType: string | null; description: string | null; frequencyMhz: number | null;
}

export function upsertFrequency(db: Db, f: FrequencyInput): string {
  const id = makeId('frequency', f.sourceId);
  db.run(
    `INSERT INTO airport_frequencies (id, airport_ident, airport_id, frequency_type, description, frequency_mhz, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       airport_ident = excluded.airport_ident, airport_id = excluded.airport_id,
       frequency_type = excluded.frequency_type, description = excluded.description,
       frequency_mhz = excluded.frequency_mhz, updated_at = excluded.updated_at`,
    id, f.airportIdent, f.airportId, f.frequencyType, f.description, f.frequencyMhz, nowIso(),
  );
  return id;
}

export interface NavaidInput {
  sourceId: string; navaidIdent: string; name: string; navaidType: string | null;
  frequencyKhz: number | null; lat: number | null; lon: number | null;
  elevationFt: number | null; countryIso2: string | null; usageType: string | null;
  power: string | null; associatedAirport: string | null; airportId: string | null;
}

export function upsertNavaid(db: Db, n: NavaidInput): string {
  const id = makeId('navaid', n.sourceId);
  db.run(
    `INSERT INTO navaids (id, navaid_ident, name, navaid_type, frequency_khz, lat, lon,
       elevation_ft, country_iso2, usage_type, power, associated_airport, airport_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       navaid_ident = excluded.navaid_ident, name = excluded.name, navaid_type = excluded.navaid_type,
       frequency_khz = excluded.frequency_khz, lat = excluded.lat, lon = excluded.lon,
       elevation_ft = excluded.elevation_ft, country_iso2 = excluded.country_iso2,
       usage_type = excluded.usage_type, power = excluded.power,
       associated_airport = excluded.associated_airport, airport_id = excluded.airport_id,
       updated_at = excluded.updated_at`,
    id, n.navaidIdent, n.name, n.navaidType, n.frequencyKhz, n.lat, n.lon, n.elevationFt,
    n.countryIso2, n.usageType, n.power, n.associatedAirport, n.airportId, nowIso(),
  );
  return id;
}

export function getCityByName(db: Db, name: string, admin1?: string): City | undefined {
  const row = admin1
    ? db.get<Record<string, unknown>>('SELECT * FROM cities WHERE name = ? AND admin1 = ?', name, admin1)
    : db.get<Record<string, unknown>>('SELECT * FROM cities WHERE name = ?', name);
  return row ? rowToCity(row) : undefined;
}

export function getCity(db: Db, id: string): City | undefined {
  const row = db.get<Record<string, unknown>>('SELECT * FROM cities WHERE id = ?', id);
  return row ? rowToCity(row) : undefined;
}

export function rowToCity(row: Record<string, unknown>): City {
  return {
    id: String(row.id), name: String(row.name), countryId: String(row.country_id),
    admin1: (row.admin1 as string) ?? null,
    lat: Number(row.lat), lon: Number(row.lon),
    population: row.population === null ? null : Number(row.population),
    timezone: (row.timezone as string) ?? null,
  };
}

export function rowToAirport(row: Record<string, unknown>): Airport {
  return {
    id: String(row.id), iata: (row.iata as string) ?? null, icao: (row.icao as string) ?? null,
    name: String(row.name), cityId: (row.city_id as string) ?? null,
    countryId: String(row.country_id), regionCode: row.region_code as RegionCode,
    lat: Number(row.lat), lon: Number(row.lon),
    kind: row.kind as Airport['kind'],
  };
}

export function listRegions(db: Db): Region[] {
  return db.all<Record<string, unknown>>('SELECT * FROM regions ORDER BY code').map((r) => ({
    id: String(r.id), code: r.code as RegionCode, name: String(r.name),
  }));
}

export function upsertUser(
  db: Db,
  user: { id: string; displayName: string; homeCityId?: string | null },
): string {
  db.run(
    `INSERT INTO users (id, display_name, home_city_id, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name,
       home_city_id = excluded.home_city_id`,
    user.id, user.displayName, user.homeCityId ?? null, nowIso(),
  );
  return user.id;
}

export function countRows(db: Db, table: string): number {
  const row = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
  return row ? Number(row.n) : 0;
}

export { jsonColumn };

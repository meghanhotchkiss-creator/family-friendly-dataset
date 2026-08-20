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

export function upsertAirport(db: Db, a: Omit<Airport, 'id'> & { id?: string }): string {
  const id = a.id ?? makeId('airport', a.iata ?? a.icao ?? a.name);
  db.run(
    `INSERT INTO airports (id, iata, icao, name, city_id, country_id, region_code, lat, lon, kind, geoname_id, city_geoname_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       iata = excluded.iata, icao = excluded.icao, name = excluded.name,
       city_id = excluded.city_id, lat = excluded.lat, lon = excluded.lon,
       kind = excluded.kind,
       geoname_id = COALESCE(excluded.geoname_id, airports.geoname_id),
       city_geoname_id = COALESCE(excluded.city_geoname_id, airports.city_geoname_id),
       updated_at = excluded.updated_at`,
    id, a.iata, a.icao, a.name, a.cityId, a.countryId, a.regionCode, a.lat, a.lon, a.kind,
    (a as { geonameId?: number | null }).geonameId ?? null,
    (a as { cityGeonameId?: number | null }).cityGeonameId ?? null, nowIso(),
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

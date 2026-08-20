/**
 * The import pipeline: provider payloads in, Travel Graph rows out.
 *
 * Three rules hold for every importer here.
 *
 *   1. Geography first. Regions exist before countries, countries before
 *      cities, cities before the places and airports that reference them. When
 *      a payload names a city the geography import did not supply, the importer
 *      creates it rather than dropping the row.
 *   2. Ids come from makeId(), never from string concatenation, so the same
 *      place reported by two providers lands on the same id and corroborates
 *      instead of duplicating.
 *   3. Every place fact is also a claim. The row in `places` is convenience;
 *      the row in `source_records` is the evidence, and it is what the Truth
 *      Engine adjudicates. `recordClaim` no-ops on an unchanged value from the
 *      same source, which is what makes re-importing free.
 */

import type { Place, ProviderContext, RegionCode, Result } from '../contracts/index.ts';
import { err, makeId, ok } from '../contracts/index.ts';
import type { Db } from '../db/index.ts';
import { ensureRegions, upsertAirport, upsertCity, upsertCountry, upsertNeighborhood } from '../db/repo-core.ts';
import { computeCanonicalHash, upsertPlace } from '../db/repo-places.ts';
import { recordClaim } from '../db/repo-truth.ts';
import { nowIso } from '../runtime/clock.ts';
import { contextFor, providerContext, providerById, registerProvidersInDb } from './registry.ts';
import { GEOGRAPHY_PROVIDER_ID } from './adapters/geography.ts';
import type { RawCountry } from './adapters/geography.ts';
import { AIRPORTS_PROVIDER_ID } from './adapters/airports.ts';
import type { RawAirport } from './adapters/airports.ts';
import { PLACES_PROVIDER_ID } from './adapters/places.ts';
import type { RawPlace } from './adapters/places.ts';
import { GTFS_PROVIDER_ID } from './adapters/gtfs.ts';
import type { RawGtfsFeed } from './adapters/gtfs.ts';

/* ------------------------------------------------------------------ *
 * Shared plumbing
 * ------------------------------------------------------------------ */

async function fetchFrom<T>(
  db: Db,
  providerId: string,
  ctx: ProviderContext | undefined,
  query: Record<string, unknown> = {},
): Promise<Result<readonly T[]>> {
  const registered = registerProvidersInDb(db);
  if (!registered.ok) return registered;

  const provider = providerById(providerId);
  if (!provider) return err('not_found', `no provider registered as ${providerId}`, { providerId });

  const scoped = contextFor(provider, ctx ?? providerContext());
  if (!provider.isConfigured(scoped)) {
    return err('not_configured', `${providerId} has no credentials configured`, {
      providerId,
      hint: `set SCOUT_${provider.kind.toUpperCase()}_API_KEY`,
    });
  }

  const response = await provider.fetch(scoped, { query });
  if (!response.ok) return response;
  return ok(response.value.items as readonly T[]);
}

function countryIdFor(db: Db, iso2: string): string | null {
  const row = db.get<{ id: string }>('SELECT id FROM countries WHERE iso2 = ?', iso2.toUpperCase());
  return row ? row.id : null;
}

export interface CityInput {
  readonly countryId: string;
  readonly name: string;
  readonly admin1: string | null;
  readonly lat: number | null;
  readonly lon: number | null;
  readonly timezone?: string | null;
  readonly population?: number | null;
}

/**
 * One city per (country, name). Airports, places and GTFS feeds all name cities
 * with slightly different metadata, so the first writer creates the row and the
 * later ones only fill gaps -- otherwise "London" arrives three times.
 */
function ensureCity(db: Db, input: CityInput): { id: string; created: boolean } {
  const existing = db.get<{ id: string; lat: number | null; lon: number | null; timezone: string | null }>(
    'SELECT id, lat, lon, timezone FROM cities WHERE country_id = ? AND lower(name) = lower(?)',
    input.countryId,
    input.name,
  );
  if (existing) {
    if ((existing.lat === null && input.lat !== null) || (existing.timezone === null && input.timezone)) {
      db.run(
        'UPDATE cities SET lat = COALESCE(lat, ?), lon = COALESCE(lon, ?), timezone = COALESCE(timezone, ?), updated_at = ? WHERE id = ?',
        input.lat,
        input.lon,
        input.timezone ?? null,
        nowIso(),
        existing.id,
      );
    }
    return { id: existing.id, created: false };
  }
  const id = upsertCity(db, {
    name: input.name,
    countryId: input.countryId,
    admin1: input.admin1,
    lat: input.lat as number,
    lon: input.lon as number,
    population: input.population ?? null,
    timezone: input.timezone ?? null,
  });
  return { id, created: true };
}

/** Geography is a prerequisite for everything else; run it once if it is missing. */
async function ensureGeography(db: Db, ctx?: ProviderContext): Promise<Result<number>> {
  const row = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM countries');
  if (row && Number(row.n) > 0) return ok(Number(row.n));
  const imported = await importGeography(db, ctx);
  if (!imported.ok) return imported;
  return ok(imported.value.countries);
}

/* ------------------------------------------------------------------ *
 * Geography
 * ------------------------------------------------------------------ */

export async function importGeography(
  db: Db,
  ctx?: ProviderContext,
): Promise<Result<{ regions: number; countries: number; cities: number }>> {
  ensureRegions(db);

  const fetched = await fetchFrom<RawCountry>(db, GEOGRAPHY_PROVIDER_ID, ctx);
  if (!fetched.ok) return fetched;

  const stats = db.transaction(() => {
    let countries = 0;
    let cities = 0;
    for (const country of fetched.value) {
      const countryId = upsertCountry(db, {
        iso2: country.iso2,
        iso3: country.iso3,
        name: country.name,
        regionCode: country.regionCode,
        currency: country.currency,
      });
      countries += 1;

      // The capital is the first city of every country: it anchors the country
      // in the graph even before any place or airport names a city there.
      if (country.capital) {
        ensureCity(db, {
          countryId,
          name: country.capital,
          admin1: null,
          lat: country.capitalLat,
          lon: country.capitalLon,
        });
        cities += 1;
      }
    }
    return { countries, cities };
  });

  const regions = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM regions');
  return ok({ regions: regions ? Number(regions.n) : 0, countries: stats.countries, cities: stats.cities });
}

/* ------------------------------------------------------------------ *
 * Airports
 * ------------------------------------------------------------------ */

export async function importAirports(
  db: Db,
  ctx?: ProviderContext,
): Promise<Result<{ airports: number; byRegion: Record<string, number> }>> {
  const geography = await ensureGeography(db, ctx);
  if (!geography.ok) return geography;

  const fetched = await fetchFrom<RawAirport>(db, AIRPORTS_PROVIDER_ID, ctx);
  if (!fetched.ok) return fetched;

  const outcome = db.transaction(() => {
    const byRegion: Record<string, number> = {};
    let airports = 0;
    let skipped = 0;

    for (const airport of fetched.value) {
      const countryId = countryIdFor(db, airport.countryIso2);
      if (!countryId) {
        // No country row means no region flag we can trust: skip rather than
        // invent geography from an airport record.
        skipped += 1;
        continue;
      }

      // The imported country is authoritative for the region flag; the airport
      // payload only overrides it when it actually carries one.
      const regionCode =
        airport.regionCode ??
        (db.get<{ region_code: string }>(
          'SELECT region_code FROM countries WHERE id = ?',
          countryId,
        )?.region_code as RegionCode | undefined) ??
        null;
      if (!regionCode) {
        skipped += 1;
        continue;
      }

      const cityId = airport.municipality
        ? ensureCity(db, {
            countryId,
            name: airport.municipality,
            admin1: airport.admin1,
            // The airport coordinate stands in for the city until a place
            // payload supplies a better one.
            lat: airport.lat,
            lon: airport.lon,
          }).id
        : null;

      upsertAirport(db, {
        iata: airport.iata,
        icao: airport.icao,
        name: airport.name,
        cityId,
        countryId,
        regionCode,
        lat: airport.lat,
        lon: airport.lon,
        kind: airport.kind,
      });
      airports += 1;
      byRegion[regionCode] = (byRegion[regionCode] ?? 0) + 1;
    }
    return { airports, byRegion, skipped };
  });

  if (outcome.airports === 0) {
    return err('upstream_schema_drift', 'no airport could be attached to a known country', {
      providerId: AIRPORTS_PROVIDER_ID,
      skipped: outcome.skipped,
    });
  }

  return ok({ airports: outcome.airports, byRegion: outcome.byRegion });
}

/* ------------------------------------------------------------------ *
 * Places
 * ------------------------------------------------------------------ */

/** The place fields the Truth Engine is allowed to resolve, as claims. */
function claimsForPlace(place: RawPlace): { field: string; value: unknown }[] {
  const candidates: { field: string; value: unknown }[] = [
    { field: 'name', value: place.name },
    { field: 'category', value: place.category },
    { field: 'price_tier', value: place.priceTier },
    { field: 'indoor_outdoor', value: place.indoorOutdoor },
    { field: 'rating', value: place.rating },
    { field: 'min_age', value: place.minAge },
    { field: 'max_age', value: place.maxAge },
    { field: 'duration_minutes', value: place.durationMinutes },
    { field: 'description', value: place.description },
    { field: 'lat', value: place.lat },
    { field: 'lon', value: place.lon },
  ];
  // A source asserting nothing about a field is not the same as asserting null.
  return candidates.filter((c) => c.value !== null && c.value !== undefined);
}

export async function importPlaces(
  db: Db,
  ctx?: ProviderContext,
): Promise<Result<{ places: number; claims: number; cities: number }>> {
  const geography = await ensureGeography(db, ctx);
  if (!geography.ok) return geography;

  const fetched = await fetchFrom<RawPlace>(db, PLACES_PROVIDER_ID, ctx);
  if (!fetched.ok) return fetched;

  const observedAt = nowIso();

  const outcome = db.transaction(() => {
    const cities = new Set<string>();
    let places = 0;
    let claims = 0;
    let skipped = 0;

    for (const raw of fetched.value) {
      const countryId = countryIdFor(db, raw.countryIso2);
      if (!countryId) {
        skipped += 1;
        continue;
      }

      const city = ensureCity(db, {
        countryId,
        name: raw.cityName,
        admin1: raw.admin1,
        lat: raw.cityLat,
        lon: raw.cityLon,
        timezone: raw.timezone,
      });
      cities.add(city.id);

      const neighborhoodId = raw.neighborhood
        ? upsertNeighborhood(db, {
            cityId: city.id,
            name: raw.neighborhood,
            lat: null,
            lon: null,
            localCharacter: null,
          })
        : null;

      // Identity is (country, city, name): the same attraction reported by a
      // second provider lands on this id and corroborates rather than doubling.
      const placeId = makeId('place', raw.countryIso2, raw.cityName, raw.name);
      const place: Place = {
        id: placeId,
        name: raw.name,
        cityId: city.id,
        neighborhoodId,
        lat: raw.lat,
        lon: raw.lon,
        // Carried through from the adapter instead of being dropped: a city
        // centroid must not be mistaken for the venue's address.
        locationPrecision: raw.locationPrecision,
        category: raw.category,
        subcategory: raw.subcategory,
        priceTier: raw.priceTier,
        indoorOutdoor: raw.indoorOutdoor,
        rating: raw.rating,
        minAge: raw.minAge,
        maxAge: raw.maxAge,
        durationMinutes: raw.durationMinutes,
        touristiness: null,
        localFavor: null,
        description: raw.description,
        canonicalHash: null,
        updatedAt: nowIso(),
      };
      upsertPlace(db, { ...place, canonicalHash: computeCanonicalHash(place) });
      places += 1;

      for (const claim of claimsForPlace(raw)) {
        recordClaim(db, {
          sourceId: PLACES_PROVIDER_ID,
          entityType: 'place',
          entityId: placeId,
          field: claim.field,
          value: claim.value,
          observedAt,
        });
        claims += 1;
      }
    }
    return { places, claims, cities: cities.size, skipped };
  });

  if (outcome.places === 0) {
    return err('upstream_schema_drift', 'no place could be attached to a known country', {
      providerId: PLACES_PROVIDER_ID,
      skipped: outcome.skipped,
    });
  }

  return ok({ places: outcome.places, claims: outcome.claims, cities: outcome.cities });
}

/* ------------------------------------------------------------------ *
 * GTFS
 * ------------------------------------------------------------------ */

export async function importGtfs(
  db: Db,
  ctx?: ProviderContext,
): Promise<Result<{ feeds: number; stops: number; routes: number; agencies: number }>> {
  const geography = await ensureGeography(db, ctx);
  if (!geography.ok) return geography;

  const fetched = await fetchFrom<RawGtfsFeed>(db, GTFS_PROVIDER_ID, ctx);
  if (!fetched.ok) return fetched;

  const importedAt = nowIso();

  const outcome = db.transaction(() => {
    let feeds = 0;
    let stops = 0;
    let routes = 0;
    let agencies = 0;

    for (const feed of fetched.value) {
      const countryId = countryIdFor(db, feed.countryIso2);
      if (!countryId) continue;

      const city = ensureCity(db, {
        countryId,
        name: feed.cityName,
        admin1: feed.admin1,
        lat: feed.stops[0]?.lat ?? null,
        lon: feed.stops[0]?.lon ?? null,
        timezone: feed.agencies[0]?.timezone ?? null,
      });

      // GTFS has no entity type of its own in the id scheme: a feed is a data
      // source, a stop is a node in the place graph, a route is a route.
      const feedId = makeId('source', 'gtfs', feed.feedId);
      db.run(
        `INSERT INTO gtfs_feeds (id, name, city_id, region_code, source_url, feed_hash, imported_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, city_id = excluded.city_id, region_code = excluded.region_code,
           source_url = excluded.source_url, feed_hash = excluded.feed_hash,
           imported_at = excluded.imported_at`,
        feedId,
        feed.name,
        city.id,
        feed.regionCode,
        feed.sourceUrl,
        feed.feedHash,
        importedAt,
      );
      feeds += 1;

      const agencyIds = new Map<string, string>();
      for (const agency of feed.agencies) {
        const id = makeId('source', 'gtfs', feed.feedId, 'agency', agency.agencyId);
        db.run(
          `INSERT INTO gtfs_agencies (id, feed_id, name, timezone) VALUES (?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, timezone = excluded.timezone`,
          id,
          feedId,
          agency.name,
          agency.timezone,
        );
        agencyIds.set(agency.agencyId, id);
        agencies += 1;
      }

      for (const stop of feed.stops) {
        const id = makeId('place', 'gtfs', feed.feedId, 'stop', stop.stopId);
        db.run(
          `INSERT INTO gtfs_stops (id, feed_id, code, name, lat, lon) VALUES (?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET code = excluded.code, name = excluded.name,
             lat = excluded.lat, lon = excluded.lon`,
          id,
          feedId,
          stop.code,
          stop.name,
          stop.lat,
          stop.lon,
        );
        stops += 1;
      }

      for (const route of feed.routes) {
        const id = makeId('route', feed.feedId, route.routeId);
        const agencyId = route.agencyId ? (agencyIds.get(route.agencyId) ?? null) : null;
        db.run(
          `INSERT INTO gtfs_routes (id, feed_id, agency_id, short_name, long_name, route_type)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET agency_id = excluded.agency_id,
             short_name = excluded.short_name, long_name = excluded.long_name,
             route_type = excluded.route_type`,
          id,
          feedId,
          // A single-agency feed may omit agency_id on its routes.
          agencyId ?? (agencyIds.size === 1 ? ([...agencyIds.values()][0] as string) : null),
          route.shortName,
          route.longName,
          route.routeType,
        );
        routes += 1;
      }
    }
    return { feeds, stops, routes, agencies };
  });

  if (outcome.feeds === 0) {
    return err('upstream_schema_drift', 'no GTFS feed could be attached to a known country', {
      providerId: GTFS_PROVIDER_ID,
    });
  }

  return ok(outcome);
}

/* ------------------------------------------------------------------ *
 * Everything
 * ------------------------------------------------------------------ */

export async function importAll(db: Db, ctx?: ProviderContext): Promise<Result<Record<string, unknown>>> {
  const context = ctx ?? providerContext();

  const geography = await importGeography(db, context);
  if (!geography.ok) return geography;

  const airports = await importAirports(db, context);
  if (!airports.ok) return airports;

  const places = await importPlaces(db, context);
  if (!places.ok) return places;

  const gtfs = await importGtfs(db, context);
  if (!gtfs.ok) return gtfs;

  return ok({
    geography: geography.value,
    airports: airports.value,
    places: places.value,
    gtfs: gtfs.value,
    replayed: context.transport.mode !== 'network',
  });
}

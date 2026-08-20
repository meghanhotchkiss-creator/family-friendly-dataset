/**
 * Connector tests: the provider contract, the health and error mapping the
 * Sentinel depends on, and the import pipeline's effect on the Travel Graph.
 *
 * Everything runs against the recorded fixtures, which is the point of the
 * transport seam: the parsing, normalisation and error mapping under test are
 * the same code that will run against the wire.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FRESHNESS_TIERS,
  PROVIDER_KINDS,
  REGION_CODES,
  SOURCE_AUTHORITY,
  isEntityId,
  ok,
  schemaFingerprintOf,
} from '../../scout/contracts/index.ts';
import type {
  ProviderContext,
  Result,
  Transport,
  TransportResponse,
} from '../../scout/contracts/index.ts';
import { openDb } from '../../scout/db/index.ts';
import type { Db } from '../../scout/db/index.ts';
import { migrate } from '../../scout/db/migrate.ts';
import { createFixtureTransport } from '../../scout/connectors/transport.ts';
import {
  allProviders,
  providerById,
  providerContext,
  providersByKind,
  registerProvidersInDb,
} from '../../scout/connectors/registry.ts';
import {
  importAirports,
  importAll,
  importGeography,
  importGtfs,
  importPlaces,
} from '../../scout/connectors/import.ts';
import { parseCsv, parseCsvRows } from '../../scout/connectors/adapters/gtfs.ts';
import { GEOGRAPHY_PROVIDER_ID, errorKindForStatus } from '../../scout/connectors/adapters/geography.ts';
import { PLACES_PROVIDER_ID, priceTierFromLevel, ratingFromTen } from '../../scout/connectors/adapters/places.ts';
import { AIRPORTS_PROVIDER_ID } from '../../scout/connectors/adapters/airports.ts';
import { WEATHER_PROVIDER_ID } from '../../scout/connectors/adapters/weather.ts';

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function freshDb(): Db {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function fixtureContext(): ProviderContext {
  return providerContext({ transport: createFixtureTransport(), credentials: {} });
}

/** A transport that answers every request the same way, without any network. */
function stubTransport(status: number, body: string, mode: 'fixture' | 'network' = 'network'): Transport & { calls: number } {
  const transport = {
    mode,
    calls: 0,
    async request(): Promise<Result<TransportResponse>> {
      transport.calls += 1;
      return ok({ status, headers: { 'content-type': 'application/json' }, body, replayed: mode === 'fixture', latencyMs: 3 });
    },
  };
  return transport;
}

function stubContext(transport: Transport, apiKey?: string): ProviderContext {
  return {
    transport,
    credentials: apiKey ? { apiKey } : {},
    now: () => '2026-08-19T12:00:00.000Z',
  };
}

function countRows(db: Db, table: string): number {
  const row = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
  return row ? Number(row.n) : 0;
}

/* ------------------------------------------------------------------ *
 * the provider contract
 * ------------------------------------------------------------------ */

test('every provider satisfies the Provider contract', () => {
  const providers = allProviders();
  assert.equal(providers.length, 5);

  const seen = new Set<string>();
  for (const provider of providers) {
    assert.ok(isEntityId(provider.id, 'provider'), `${provider.id} is not a provider id`);
    assert.ok(!seen.has(provider.id), `duplicate provider id ${provider.id}`);
    seen.add(provider.id);

    assert.ok(PROVIDER_KINDS.includes(provider.kind), `${provider.id} kind ${provider.kind}`);
    assert.ok(FRESHNESS_TIERS.includes(provider.freshnessTier), `${provider.id} tier`);
    assert.ok(provider.sourceClass in SOURCE_AUTHORITY, `${provider.id} source class`);
    assert.ok(provider.authority >= 0 && provider.authority <= 1, `${provider.id} authority`);
    // The authority a provider claims must be the one its class allows.
    assert.equal(provider.authority, SOURCE_AUTHORITY[provider.sourceClass]);
    for (const region of provider.regionScope) {
      assert.ok(REGION_CODES.includes(region), `${provider.id} region scope`);
    }
    assert.equal(typeof provider.isConfigured, 'function');
    assert.equal(typeof provider.health, 'function');
    assert.equal(typeof provider.fetch, 'function');
  }

  assert.deepEqual(
    providers.map((p) => p.kind).sort(),
    ['airports', 'geography', 'gtfs', 'places', 'weather'],
  );
  assert.equal(providersByKind('weather')[0]?.id, WEATHER_PROVIDER_ID);
  assert.equal(providerById(GEOGRAPHY_PROVIDER_ID)?.kind, 'geography');
  assert.equal(providerById('provider:nope'), undefined);

  // The one live-tier provider exists, and the structural datasets are base.
  assert.equal(providerById(WEATHER_PROVIDER_ID)?.freshnessTier, 'live');
  assert.equal(providerById(AIRPORTS_PROVIDER_ID)?.freshnessTier, 'base');
  assert.equal(providerById(PLACES_PROVIDER_ID)?.freshnessTier, 'periodic');
});

/* ------------------------------------------------------------------ *
 * health
 * ------------------------------------------------------------------ */

test('health() reports up against the recorded fixtures', async () => {
  const ctx = fixtureContext();
  for (const provider of allProviders()) {
    const health = await provider.health(ctx);
    assert.equal(health.status, 'up', `${provider.id}: ${health.error}`);
    assert.equal(health.providerId, provider.id);
    assert.equal(health.httpStatus, 200);
    assert.ok(health.authOk && health.schemaOk);
    assert.ok(typeof health.latencyMs === 'number' && health.latencyMs >= 0);
    assert.ok(health.schemaFingerprint && health.schemaFingerprint.length > 2);
    assert.equal(health.error, null);
  }
});

test('health() reports unconfigured, not down, when credentials are missing', async () => {
  const places = providerById(PLACES_PROVIDER_ID);
  assert.ok(places);
  const transport = stubTransport(200, '{}', 'network');
  const ctx = stubContext(transport);

  assert.equal(places.isConfigured(ctx), false);
  const health = await places.health(ctx);
  assert.equal(health.status, 'unconfigured');
  assert.equal(health.latencyMs, null);
  assert.equal(health.httpStatus, null);
  assert.equal(health.schemaFingerprint, null);
  // A missing key must not cost a request.
  assert.equal(transport.calls, 0);

  // With a key the same provider probes for real.
  const withKey = stubContext(stubTransport(200, JSON.stringify({ page: {}, places: [] })), 'k-123');
  assert.equal(places.isConfigured(withKey), true);
  const probed = await places.health(withKey);
  assert.equal(probed.status, 'degraded'); // reachable, but no parseable row
  assert.equal(probed.authOk, true);
});

test('health() maps a rate limit to degraded and a 500 to down', async () => {
  const geography = providerById(GEOGRAPHY_PROVIDER_ID);
  assert.ok(geography);

  const limited = await geography.health(stubContext(stubTransport(429, 'slow down')));
  assert.equal(limited.status, 'degraded');
  assert.equal(limited.httpStatus, 429);

  const broken = await geography.health(stubContext(stubTransport(500, 'boom')));
  assert.equal(broken.status, 'down');

  const forbidden = await geography.health(stubContext(stubTransport(403, 'nope')));
  assert.equal(forbidden.status, 'down');
  assert.equal(forbidden.authOk, false);
});

/* ------------------------------------------------------------------ *
 * error mapping
 * ------------------------------------------------------------------ */

test('fetch() maps HTTP status to the right ErrorKind', async () => {
  const geography = providerById(GEOGRAPHY_PROVIDER_ID);
  assert.ok(geography);

  const cases: [number, string][] = [
    [401, 'upstream_auth'],
    [403, 'upstream_auth'],
    [429, 'upstream_rate_limited'],
    [500, 'upstream_unavailable'],
    [503, 'upstream_unavailable'],
    [404, 'not_found'],
  ];

  for (const [status, kind] of cases) {
    const result = await geography.fetch(stubContext(stubTransport(status, 'x')), { query: {} });
    assert.equal(result.ok, false, `HTTP ${status} should fail`);
    if (!result.ok) {
      assert.equal(result.error.kind, kind, `HTTP ${status}`);
      assert.equal(result.error.detail?.httpStatus, status);
    }
  }

  // The mapping table itself, so Sentinel can reuse it.
  assert.equal(errorKindForStatus(504), 'timeout');
  assert.equal(errorKindForStatus(400), 'invalid_input');
});

test('fetch() maps a malformed payload to upstream_schema_drift', async () => {
  const geography = providerById(GEOGRAPHY_PROVIDER_ID);
  assert.ok(geography);

  const garbage = await geography.fetch(stubContext(stubTransport(200, '<html>not json</html>')), { query: {} });
  assert.equal(garbage.ok, false);
  if (!garbage.ok) assert.equal(garbage.error.kind, 'upstream_schema_drift');

  // Valid JSON of the wrong shape is drift too.
  const wrongShape = await geography.fetch(
    stubContext(stubTransport(200, JSON.stringify({ countries: [] }))),
    { query: {} },
  );
  assert.equal(wrongShape.ok, false);
  if (!wrongShape.ok) assert.equal(wrongShape.error.kind, 'upstream_schema_drift');

  // An array whose rows carry none of the fields we parse is also drift.
  const emptyRows = await geography.fetch(
    stubContext(stubTransport(200, JSON.stringify([{ id: 1 }, { id: 2 }]))),
    { query: {} },
  );
  assert.equal(emptyRows.ok, false);
  if (!emptyRows.ok) assert.equal(emptyRows.error.kind, 'upstream_schema_drift');
});

test('a missing fixture is not_configured, not a crash', async () => {
  const weather = providerById(WEATHER_PROVIDER_ID);
  assert.ok(weather);
  const result = await weather.fetch(fixtureContext(), { query: { lat: 12.34, lon: 56.78 } });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, 'not_configured');
});

/* ------------------------------------------------------------------ *
 * fetch against fixtures
 * ------------------------------------------------------------------ */

test('geography fetch normalises countries across all eight regions', async () => {
  const provider = providerById(GEOGRAPHY_PROVIDER_ID);
  assert.ok(provider);
  const result = await provider.fetch(fixtureContext(), { query: {} });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const items = result.value.items as { iso2: string; regionCode: string; currency: string | null }[];
  assert.ok(items.length >= 40, `only ${items.length} countries`);
  assert.equal(result.value.replayed, true);
  assert.ok(result.value.schemaFingerprint.includes('cca2'));

  const regions = new Set(items.map((c) => c.regionCode));
  assert.equal(regions.size, 8, `regions: ${[...regions].join(',')}`);

  const us = items.find((c) => c.iso2 === 'US');
  assert.equal(us?.regionCode, 'NA');
  assert.equal(us?.currency, 'USD');
  // Scout splits the Americas and carves the Middle East out of Asia.
  assert.equal(items.find((c) => c.iso2 === 'PA')?.regionCode, 'CA');
  assert.equal(items.find((c) => c.iso2 === 'BR')?.regionCode, 'SA');
  assert.equal(items.find((c) => c.iso2 === 'AE')?.regionCode, 'ME');
  assert.equal(items.find((c) => c.iso2 === 'JP')?.regionCode, 'AS');
});

test('places fetch follows the cursor to the end of a region', async () => {
  const provider = providerById(PLACES_PROVIDER_ID);
  assert.ok(provider);
  const result = await provider.fetch(fixtureContext(), { query: {}, regionCode: 'NA' });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  // The NA region is more than one page: paging is what gets us past 100.
  assert.ok(result.value.items.length > 100, `${result.value.items.length} NA places`);

  const places = result.value.items as { rating: number | null; priceTier: string | null; category: string }[];
  for (const place of places) {
    if (place.rating !== null) assert.ok(place.rating >= 0 && place.rating <= 5, `rating ${place.rating}`);
  }
  assert.ok(places.some((p) => p.category === 'science_center'));
});

test('unit conversions match the schema the places table enforces', () => {
  assert.equal(priceTierFromLevel(0), 'free');
  assert.equal(priceTierFromLevel(1), '$');
  assert.equal(priceTierFromLevel(3), '$$$');
  assert.equal(priceTierFromLevel(4), '$$$');
  assert.equal(priceTierFromLevel(null), null);
  assert.equal(ratingFromTen(9.4), 4.7);
  assert.equal(ratingFromTen(null), null);
});

test('weather returns a live-tier observation per point', async () => {
  const provider = providerById(WEATHER_PROVIDER_ID);
  assert.ok(provider);
  const result = await provider.fetch(fixtureContext(), { query: {} });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const items = result.value.items as { temperatureC: number | null; observedAt: string }[];
  assert.equal(items.length, 6);
  assert.equal(typeof items[0]?.temperatureC, 'number');
  assert.ok(!Number.isNaN(Date.parse(items[0]?.observedAt ?? '')));
});

/* ------------------------------------------------------------------ *
 * CSV
 * ------------------------------------------------------------------ */

test('the GTFS CSV reader handles quoted commas, quotes and CRLF', () => {
  const csv = [
    'route_id,agency_id,route_short_name,route_long_name,route_type',
    'ROUTE 1,BART,Yellow-N,"Antioch, CA - SFO Airport/Millbrae, CA",1',
    'ROUTE 2,BART,Blue-N,"He said ""go west"", then left",1',
    '',
  ].join('\r\n');

  const rows = parseCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.route_long_name, 'Antioch, CA - SFO Airport/Millbrae, CA');
  assert.equal(rows[0]?.route_type, '1');
  assert.equal(rows[1]?.route_long_name, 'He said "go west", then left');

  // A naive split(',') would have produced seven fields for that first row.
  const raw = parseCsvRows(csv);
  assert.equal(raw[1]?.length, 5);

  // Empty trailing fields survive; a trailing newline does not become a row.
  const sparse = parseCsv('a,b,c\n1,,3\n');
  assert.deepEqual(sparse, [{ a: '1', b: '', c: '3' }]);
});

/* ------------------------------------------------------------------ *
 * registration
 * ------------------------------------------------------------------ */

test('registerProvidersInDb writes providers and matching sources', () => {
  const db = freshDb();
  try {
    const first = registerProvidersInDb(db);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.value.providers, 5);
    assert.equal(first.value.sources, 5);

    for (const provider of allProviders()) {
      const providerRow = db.get<{ id: string; authority: number }>('SELECT * FROM providers WHERE id = ?', provider.id);
      const sourceRow = db.get<{ id: string; authority: number }>('SELECT * FROM sources WHERE id = ?', provider.id);
      assert.ok(providerRow, `no providers row for ${provider.id}`);
      assert.ok(sourceRow, `no sources row for ${provider.id}`);
      // Same id in both tables: that is what lets a claim point back at a provider.
      assert.equal(sourceRow?.id, providerRow?.id);
      assert.equal(Number(sourceRow?.authority), provider.authority);
    }

    // Re-registering is an update, not a duplicate.
    assert.equal(registerProvidersInDb(db).ok, true);
    assert.equal(countRows(db, 'providers'), 5);
    assert.equal(countRows(db, 'sources'), 5);
  } finally {
    db.close();
  }
});

/* ------------------------------------------------------------------ *
 * imports
 * ------------------------------------------------------------------ */

test('importGeography lands regions, countries and capitals', async () => {
  const db = freshDb();
  try {
    const result = await importGeography(db, fixtureContext());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.regions, 8);
    assert.ok(result.value.countries >= 40);
    assert.ok(result.value.cities > 0);

    const row = db.get<{ region_code: string; currency: string }>(
      'SELECT region_code, currency FROM countries WHERE iso2 = ?',
      'JP',
    );
    assert.equal(row?.region_code, 'AS');
    assert.equal(row?.currency, 'JPY');
    assert.ok(db.get('SELECT id FROM cities WHERE name = ?', 'Tokyo'));
  } finally {
    db.close();
  }
});

test('importAirports populates all eight region codes', async () => {
  const db = freshDb();
  try {
    const result = await importAirports(db, fixtureContext());
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.ok(result.value.airports >= 60, `${result.value.airports} airports`);
    const byRegion = result.value.byRegion;
    assert.equal(Object.keys(byRegion).length, 8, `regions: ${Object.keys(byRegion).join(',')}`);
    for (const code of REGION_CODES) {
      assert.ok((byRegion[code] ?? 0) > 0, `region ${code} has no airports`);
    }

    const sfo = db.get<{ iata: string; region_code: string; city_id: string; kind: string }>(
      'SELECT * FROM airports WHERE iata = ?',
      'SFO',
    );
    assert.equal(sfo?.region_code, 'NA');
    assert.equal(sfo?.kind, 'large');
    // Airports reference a city, and geography ran first to supply the country.
    assert.ok(sfo?.city_id);
  } finally {
    db.close();
  }
});

test('importPlaces writes places rows and source claims for every fact', async () => {
  const db = freshDb();
  try {
    const result = await importPlaces(db, fixtureContext());
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.ok(result.value.places >= 150, `${result.value.places} places`);
    assert.ok(result.value.claims > result.value.places, 'each place should assert several fields');
    assert.ok(result.value.cities > 0);

    assert.equal(countRows(db, 'places'), result.value.places);
    assert.ok(countRows(db, 'source_records') > 0);

    // Places span the globe, not just the seed dataset's US rows.
    const regions = db.all<{ region_code: string }>(
      `SELECT DISTINCT co.region_code AS region_code FROM places p
       JOIN cities c ON c.id = p.city_id JOIN countries co ON co.id = c.country_id`,
    );
    assert.ok(regions.length >= 6, `places in ${regions.length} regions`);

    // A US seed row survived the round trip, keeping its identity.
    const academy = db.get<{ id: string; category: string; rating: number }>(
      'SELECT * FROM places WHERE name = ?',
      'California Academy of Sciences',
    );
    assert.ok(academy);
    assert.equal(academy?.category, 'museum');
    assert.equal(Number(academy?.rating), 4.7);

    // The aggregator's finer `type` refines the coarse seed category.
    const exploratorium = db.get<{ category: string; subcategory: string }>(
      'SELECT * FROM places WHERE name = ?',
      'Exploratorium',
    );
    assert.equal(exploratorium?.category, 'science_center');
    assert.equal(exploratorium?.subcategory, 'Science Center');

    // ...and its facts are claims the Truth Engine can adjudicate.
    const claims = db.all<{ field: string; value_json: string; source_id: string }>(
      'SELECT * FROM source_records WHERE entity_id = ? AND superseded_by IS NULL',
      academy?.id,
    );
    const fields = new Set(claims.map((c) => c.field));
    for (const field of ['name', 'category', 'price_tier', 'rating', 'min_age', 'duration_minutes', 'lat', 'lon']) {
      assert.ok(fields.has(field), `no claim for ${field}`);
    }
    assert.ok(claims.every((c) => c.source_id === PLACES_PROVIDER_ID));
    // Every claim points at a registered source.
    assert.ok(db.get('SELECT id FROM sources WHERE id = ?', PLACES_PROVIDER_ID));
  } finally {
    db.close();
  }
});

test('imports are idempotent: a second run changes nothing', async () => {
  const db = freshDb();
  try {
    const first = await importPlaces(db, fixtureContext());
    assert.equal(first.ok, true);
    const placesAfterFirst = countRows(db, 'places');
    const claimsAfterFirst = countRows(db, 'source_records');
    const citiesAfterFirst = countRows(db, 'cities');

    const second = await importPlaces(db, fixtureContext());
    assert.equal(second.ok, true);

    assert.equal(countRows(db, 'places'), placesAfterFirst);
    assert.equal(countRows(db, 'source_records'), claimsAfterFirst);
    assert.equal(countRows(db, 'cities'), citiesAfterFirst);
    // No claim was superseded either: the values did not change.
    assert.equal(countRows(db, 'source_records'), claimsAfterFirst);
    assert.equal(
      db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source_records WHERE superseded_by IS NOT NULL')?.n,
      0,
    );

    const airportsFirst = await importAirports(db, fixtureContext());
    const airportCount = countRows(db, 'airports');
    const airportsSecond = await importAirports(db, fixtureContext());
    assert.equal(airportsFirst.ok && airportsSecond.ok, true);
    assert.equal(countRows(db, 'airports'), airportCount);
  } finally {
    db.close();
  }
});

test('importGtfs parses feeds, stops and routes with quoted names', async () => {
  const db = freshDb();
  try {
    const result = await importGtfs(db, fixtureContext());
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.ok(result.value.feeds >= 3);
    assert.ok(result.value.stops >= 10);
    assert.ok(result.value.routes >= 6);
    assert.ok(result.value.agencies >= 3);

    const route = db.get<{ long_name: string }>(
      "SELECT long_name FROM gtfs_routes WHERE long_name LIKE 'Antioch%'",
    );
    // The comma inside the quoted field survived the CSV reader.
    assert.equal(route?.long_name, 'Antioch, CA - SFO Airport/Millbrae, CA');

    // Feeds hang off a real city, and stops off a real feed.
    const feed = db.get<{ id: string; city_id: string; region_code: string }>(
      "SELECT * FROM gtfs_feeds WHERE id LIKE '%bart%'",
    );
    assert.ok(feed?.city_id);
    assert.equal(feed?.region_code, 'NA');
    assert.ok(countRows(db, 'gtfs_stops') > 0);

    // Re-importing the same feed does not duplicate stops.
    const stops = countRows(db, 'gtfs_stops');
    assert.equal((await importGtfs(db, fixtureContext())).ok, true);
    assert.equal(countRows(db, 'gtfs_stops'), stops);
  } finally {
    db.close();
  }
});

test('importAll runs the whole pipeline in dependency order', async () => {
  const db = freshDb();
  try {
    const result = await importAll(db, fixtureContext());
    assert.equal(result.ok, true);
    if (!result.ok) return;

    for (const key of ['geography', 'airports', 'places', 'gtfs']) {
      assert.ok(result.value[key], `no ${key} stats`);
    }
    assert.equal(result.value.replayed, true);

    // Nothing references a city that does not exist.
    assert.equal(
      db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM places p LEFT JOIN cities c ON c.id = p.city_id WHERE c.id IS NULL',
      )?.n,
      0,
    );
    assert.equal(
      db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM airports a LEFT JOIN countries c ON c.id = a.country_id WHERE c.id IS NULL',
      )?.n,
      0,
    );
  } finally {
    db.close();
  }
});

/* ------------------------------------------------------------------ *
 * drift detection
 * ------------------------------------------------------------------ */

test('schemaFingerprintOf ignores values and notices keys', () => {
  const a = { id: 'x', name: 'Alpha', location: { lat: 1, lon: 2 }, tags: ['a'] };
  const b = { id: 'y', name: 'Beta', location: { lat: 9.5, lon: -3 }, tags: ['b', 'c'] };
  assert.equal(schemaFingerprintOf(a), schemaFingerprintOf(b));

  // Key order is not a change.
  assert.equal(schemaFingerprintOf({ a: 1, b: 'x' }), schemaFingerprintOf({ b: 'y', a: 2 }));

  // An added key, a dropped key or a retyped value all are.
  assert.notEqual(schemaFingerprintOf(a), schemaFingerprintOf({ ...a, rating: 4.5 }));
  assert.notEqual(schemaFingerprintOf(a), schemaFingerprintOf({ id: 'x', name: 'Alpha', tags: ['a'] }));
  assert.notEqual(schemaFingerprintOf({ id: 'x' }), schemaFingerprintOf({ id: 7 }));
});

test('an airport with no continent column is kept, not silently discarded', async () => {
  // Regression, found by importing a real 28k-row global dataset. The adapter
  // used to `return null` when it could not derive a region from the payload,
  // and REGION_BY_ISO2 is only a small override pin-list -- GB, FR, JP, AU and
  // ZA are all absent from it. A real feed without a `continent` column
  // therefore lost every airport outside the handful of pinned countries:
  // 3,784 of 28,291 rows survived, covering 4 of 8 regions. The imported
  // country row is authoritative for the region, so the adapter now passes the
  // row through with a null region and lets the import resolve it.
  const { normaliseAirport } = await import('../../scout/connectors/adapters/airports.ts');

  const row = {
    id: '1', ident: 'EGLL', type: 'medium_airport', name: 'London Heathrow Airport',
    latitude_deg: '51.4706', longitude_deg: '-0.461941', elevation_ft: '83',
    continent: '', iso_country: 'GB', iso_region: 'GB-ENG', municipality: 'London',
    scheduled_service: 'yes', gps_code: 'EGLL', iata_code: 'LHR', local_code: '',
    home_link: '', wikipedia_link: '', keywords: '',
  };

  const airport = normaliseAirport(row);
  assert.ok(airport, 'a row with a blank continent must survive normalisation');
  assert.equal(airport.iata, 'LHR');
  assert.equal(airport.countryIso2, 'GB');
  assert.equal(airport.regionCode, null, 'region is deferred to the country row');

  // Rows that are genuinely unusable are still rejected.
  assert.equal(normaliseAirport({ ...row, type: 'heliport' }), null);
  assert.equal(normaliseAirport({ ...row, latitude_deg: 'x' }), null);
  assert.equal(normaliseAirport({ ...row, iso_country: '' }), null);
});

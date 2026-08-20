/**
 * The geography spine, end to end, on real rows.
 *
 * The failure this guards against actually happened: an airport import that
 * kept 3,784 of 28,291 rows and four of eight regions, reported no error, and
 * was only caught by reading the table. So these tests assert on the shape of
 * the result -- nine countries on four continents resolving, ids that do not
 * collapse, supporting files that join -- rather than on a row count.
 *
 * Everything runs through the fixture transport, whose fixtures are verbatim
 * slices of the vendored OurAirports files (see scripts/record_fixtures.py).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../../scout/db/index.ts';
import type { Db } from '../../scout/db/index.ts';
import { migrate } from '../../scout/db/migrate.ts';
import { ensureRegions } from '../../scout/db/repo-core.ts';
import { createFixtureTransport } from '../../scout/connectors/transport.ts';
import { loadSpecs, registerAll } from '../../scout/sourcemesh/registry.ts';
import { createSourceAdapter } from '../../scout/sourcemesh/adapter.ts';
import { writeRecords } from '../../scout/sourcemesh/sink.ts';
import { quarantineRecords } from '../../scout/sourcemesh/quarantine.ts';
import {
  TEST_COUNTRIES, checkCountries, geographyReport, validateAirports, formatGeographyReport,
} from '../../scout/api/data-validate.ts';
import { unwrap } from '../../scout/contracts/index.ts';

const SOURCES = [
  'restcountries',
  'ourairports-regions',
  'ourairports',
  'ourairports-runways',
  'ourairports-frequencies',
  'ourairports-navaids',
];

/** Load the spine from fixtures, in the dependency order the registry gives. */
async function seed(): Promise<Db> {
  const db = openDb(':memory:');
  migrate(db);
  ensureRegions(db);
  unwrap(registerAll(db));
  const transport = createFixtureTransport();
  // loadSpecs() already sorts by entity dependency; filtering preserves it.
  for (const spec of loadSpecs().filter((s) => SOURCES.includes(s.id))) {
    const result = unwrap(await createSourceAdapter(db, spec).ingest({ transport, force: true }));
    const written = unwrap(writeRecords(db, spec, result.records));
    if (result.rejections.length > 0) {
      quarantineRecords(db, result.runId, spec.id, result.rejections, 'validate');
    }
    if (written.rejections.length > 0) {
      quarantineRecords(db, result.runId, spec.id, written.rejections);
    }
  }
  return db;
}

const db = await seed();

test('every test country resolves a travel region and its administrative regions', () => {
  const checks = checkCountries(db);
  assert.equal(checks.length, TEST_COUNTRIES.length);
  const failed = checks.filter((c) => !c.ok).map((c) => `${c.iso2}: ${c.problems.join('; ')}`);
  assert.deepEqual(failed, []);
});

test('the nine test countries span more than one continent', () => {
  // A resolver that returns 'NA' for everything would satisfy every per-country
  // check above and still be broken.
  const regions = new Set(checkCountries(db).map((c) => c.regionCode));
  assert.ok(regions.size >= 4, `expected several travel regions, got ${[...regions].join(',')}`);
  assert.ok(!regions.has(null));
});

test('region flags come from the country table, not the source continent column', () => {
  // OurAirports files GB under continent EU and ZA under AF, which happen to
  // match. The distinguishing case is a country whose travel flag the continent
  // column cannot express at all.
  const gb = db.get<{ region_code: string }>("SELECT region_code FROM countries WHERE iso2 = 'GB'");
  assert.equal(gb?.region_code, 'EU');
  const regionCodes = db.all<{ region_code: string }>('SELECT DISTINCT region_code FROM airports');
  // 'AN' is an OurAirports continent, never a Scout travel region.
  assert.ok(!regionCodes.some((r) => r.region_code === 'AN'));
});

test('airport ids do not collapse: one stored row per upstream ident', () => {
  const a = validateAirports(db);
  assert.equal(
    a.storedRows, a.distinctIdents,
    `${a.storedRows - a.distinctIdents} airports share an id with another airport`,
  );
});

test('an airport with no IATA and no ICAO is identified by a namespaced ident', () => {
  const row = db.get<{ id: string; ident: string }>(
    'SELECT id, ident FROM airports WHERE iata IS NULL AND icao IS NULL AND ident IS NOT NULL LIMIT 1',
  );
  assert.ok(row, 'fixture should contain at least one airport with neither code');
  assert.ok(
    row.id.startsWith('airport:ident-'),
    `${row.id} is not namespaced, so it can collide with an IATA or ICAO slug`,
  );
});

test('iso_region resolves to an administrative region name and an ISO subdivision', () => {
  const heathrow = db.get<{ iso_region: string; admin1: string; city_id: string }>(
    "SELECT iso_region, admin1, city_id FROM airports WHERE iata = 'LHR'",
  );
  assert.equal(heathrow?.iso_region, 'GB-ENG');
  assert.equal(heathrow?.admin1, 'England');
  // The city keys on the ISO subdivision, which is the vocabulary GeoNames
  // also uses for GB -- storing the display name here forged a second London.
  assert.equal(heathrow?.city_id, 'city:gb-eng-london');
});

test('runways and frequencies join to a real airport', () => {
  const orphanRunways = db.get<{ n: number }>(
    'SELECT COUNT(*) n FROM runways WHERE airport_id IS NULL',
  );
  assert.equal(orphanRunways?.n, 0);
  const joined = db.get<{ n: number }>(
    `SELECT COUNT(*) n FROM runways r JOIN airports a ON a.id = r.airport_id
     WHERE a.iata = 'LHR'`,
  );
  assert.ok((joined?.n ?? 0) > 0, 'Heathrow should have runways');
  const frequencies = db.get<{ n: number }>(
    `SELECT COUNT(*) n FROM airport_frequencies f JOIN airports a ON a.id = f.airport_id
     WHERE a.iata = 'LHR'`,
  );
  assert.ok((frequencies?.n ?? 0) > 0, 'Heathrow should have frequencies');
});

test('airport size is read from the source, not guessed from IATA presence', () => {
  const heathrow = db.get<{ kind: string; airport_type: string }>(
    "SELECT kind, airport_type FROM airports WHERE iata = 'LHR'",
  );
  assert.equal(heathrow?.airport_type, 'large_airport');
  assert.equal(heathrow?.kind, 'large');
  // Nothing could ever be 'large' while size was derived from IATA presence.
  const large = db.get<{ n: number }>("SELECT COUNT(*) n FROM airports WHERE kind = 'large'");
  assert.ok((large?.n ?? 0) > 0);
});

test('the report reaches a verdict and prints it', () => {
  const report = geographyReport(db);
  assert.deepEqual(report.failures, []);
  for (const table of ['adminRegions', 'runways', 'navaids', 'frequencies']) {
    assert.ok((report.coverage[table] ?? 0) > 0, `${table} is empty`);
  }
  const text = formatGeographyReport(report);
  assert.match(text, /VERDICT: pass/);
  for (const iso2 of TEST_COUNTRIES) assert.match(text, new RegExp(`\\b${iso2}\\b`));
});

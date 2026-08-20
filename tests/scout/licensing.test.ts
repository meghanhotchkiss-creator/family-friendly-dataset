/**
 * Licence terms as an enforced constraint, not a recorded string.
 *
 * `commercialUse` answered "may we build a business on this" and was being
 * read as "may we store it and serve it onward". Those come apart: the Google
 * Places terms permit commercial use and forbid retaining most fields, so on
 * the old model that source was indistinguishable from public domain. Anything
 * in the shared graph is redistributed -- the API serves it -- so the
 * distinction has to have teeth at the sink.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../../scout/db/index.ts';
import { migrate } from '../../scout/db/migrate.ts';
import { ensureRegions, upsertCountry } from '../../scout/db/repo-core.ts';
import {
  validateSpec, redistributionOf, SpecError, type SourceSpec,
} from '../../scout/sourcemesh/spec.ts';
import { registerSpec, loadSpecs, attributionNotice, listRegistered } from '../../scout/sourcemesh/registry.ts';
import { writeRecords } from '../../scout/sourcemesh/sink.ts';

function db0() {
  const db = openDb(':memory:');
  migrate(db);
  ensureRegions(db);
  return db;
}

const PLACES_SPEC: SourceSpec = {
  id: 'test-places', name: 'A restricted place feed', entity: 'city', format: 'json',
  locator: 'https://places.example.test/v1/places', trustTier: 'aggregator',
  license: {
    name: 'Proprietary (display-time only)',
    attribution: 'Example Places',
    commercialUse: true,
    redistribution: 'restricted',
    cacheDays: 30,
  },
  identity: ['name'],
  fields: { name: { field: 'name' }, countryIso2: { field: 'country' } },
};

const record = (name: string) => ({
  identity: name,
  values: { name, countryIso2: 'US' },
  raw: { name, country: 'US' },
});

test('a source may be commercially usable and still not redistributable', () => {
  assert.equal(PLACES_SPEC.license.commercialUse, true);
  assert.equal(redistributionOf(PLACES_SPEC.license), 'restricted');
});

test('an unstated licence is treated as needing attribution, never as public domain', () => {
  assert.equal(
    redistributionOf({ name: 'Unknown', attribution: 'someone', commercialUse: true }),
    'attributed',
  );
});

test('a restricted source must state how long a value may be kept', () => {
  const withoutCache = {
    ...PLACES_SPEC,
    license: { ...PLACES_SPEC.license, cacheDays: undefined },
  };
  assert.throws(() => validateSpec(withoutCache), SpecError);

  const db = db0();
  try {
    // registerSpec refuses it too, so a spec built in memory rather than parsed
    // from disk cannot slip past.
    const refused = registerSpec(db, withoutCache as SourceSpec);
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.match(refused.error.message, /cacheDays/);
  } finally {
    db.close();
  }
});

test('an unknown redistribution value is refused rather than silently ignored', () => {
  assert.throws(
    () => validateSpec({ ...PLACES_SPEC, license: { ...PLACES_SPEC.license, redistribution: 'maybe' } }),
    SpecError,
  );
});

test('the sink refuses to persist a restricted source into the shared graph', () => {
  const db = db0();
  try {
    upsertCountry(db, { iso2: 'US', iso3: 'USA', name: 'United States', regionCode: 'NA', currency: 'USD' });
    const before = Number(db.get<{ n: number }>('SELECT COUNT(*) n FROM cities')?.n ?? 0);

    const written = writeRecords(db, PLACES_SPEC, [record('Chicago'), record('Denver')]);
    assert.equal(written.ok, true);
    if (!written.ok) return;

    assert.equal(written.value.inserted, 0);
    assert.equal(written.value.rejections.length, 2);
    assert.equal(written.value.rejections[0]?.reasonCode, 'REDISTRIBUTION_FORBIDDEN');
    assert.match(written.value.rejections[0]?.details ?? '', /display time/);

    // The rows are retained as rejections rather than dropped, and nothing
    // reached the table.
    assert.equal(Number(db.get<{ n: number }>('SELECT COUNT(*) n FROM cities')?.n ?? 0), before);
  } finally {
    db.close();
  }
});

test('an attributed source is unaffected by the gate', () => {
  const db = db0();
  try {
    upsertCountry(db, { iso2: 'US', iso3: 'USA', name: 'United States', regionCode: 'NA', currency: 'USD' });
    const open: SourceSpec = {
      ...PLACES_SPEC,
      id: 'test-open',
      license: { name: 'CC BY 4.0', attribution: 'Example', commercialUse: true, redistribution: 'attributed' },
    };
    const written = writeRecords(db, open, [record('Chicago')]);
    assert.equal(written.ok, true);
    if (written.ok) assert.equal(written.value.inserted, 1);
  } finally {
    db.close();
  }
});

test('attribution separates what needs credit from what cannot be republished at all', () => {
  const db = db0();
  try {
    for (const spec of loadSpecs()) assert.equal(registerSpec(db, spec).ok, true);
    assert.equal(registerSpec(db, PLACES_SPEC).ok, true);

    const notice = attributionNotice(db);
    assert.ok(notice.required.length > 0);
    // A restricted source must not appear among the lines a publisher is told
    // to print: an attribution line does not make it publishable.
    assert.ok(!notice.required.some((l) => l.includes('A restricted place feed')));
    assert.equal(notice.notRedistributable.length, 1);
    assert.match(notice.notRedistributable[0] ?? '', /display-time only, cache at most 30 days/);
  } finally {
    db.close();
  }
});

test('every shipped spec states its redistribution terms', () => {
  for (const spec of loadSpecs(undefined, { includeDemo: true })) {
    assert.ok(
      spec.license.redistribution,
      `${spec.id} leaves redistribution unstated, so it silently defaults`,
    );
  }
});

test('the registry round-trips redistribution and the cache limit', () => {
  const db = db0();
  try {
    registerSpec(db, PLACES_SPEC);
    const stored = listRegistered(db).find((s) => s.sourceId === 'test-places');
    assert.equal(stored?.redistribution, 'restricted');
    assert.equal(stored?.cacheDays, 30);
  } finally {
    db.close();
  }
});

test('one row that cannot be persisted does not roll back the rest of the run', () => {
  // The run is a single transaction now, for speed: 85,925 top-level commits
  // meant 85,925 fsyncs. Per-record savepoints are what keep that from turning
  // a single constraint violation into a lost run, so it is worth proving
  // rather than assuming.
  const db = db0();
  try {
    upsertCountry(db, { iso2: 'US', iso3: 'USA', name: 'United States', regionCode: 'NA', currency: 'USD' });
    const spec: SourceSpec = {
      id: 'test-airports-clash', name: 'Airports', entity: 'airport', format: 'csv',
      locator: 'https://example.test/a.csv', trustTier: 'open_dataset',
      license: { name: 'CC BY 4.0', attribution: 'Example', commercialUse: true, redistribution: 'attributed' },
      identity: ['ident'],
      fields: {
        ident: { field: 'ident' }, iata: { field: 'iata' }, name: { field: 'name' },
        lat: { field: 'lat' }, lon: { field: 'lon' },
        countryIso2: { field: 'country' }, regionCode: { field: 'region' },
      },
    };
    const airport = (ident: string, iata: string, name: string, regionCode = 'NA') => ({
      identity: ident,
      values: { ident, iata, name, lat: 1, lon: 1, countryIso2: 'US', regionCode },
      raw: { ident, iata, name },
    });

    // The middle record carries `AN`, which is an OurAirports continent and not
    // a Scout travel region. It is non-empty, so it passes the sink's own
    // check and fails on the regions foreign key -- a real database error
    // raised in the middle of the run.
    const written = writeRecords(db, spec, [
      airport('KAAA', 'AAA', 'First'),
      airport('KBBB', 'BBB', 'Antarctic, which is not a region', 'AN'),
      airport('KCCC', 'CCC', 'Third'),
    ]);
    assert.equal(written.ok, true);
    if (!written.ok) return;

    assert.equal(written.value.inserted, 2, 'the two good rows landed');
    assert.equal(written.value.rejections.length, 1);
    assert.equal(written.value.rejections[0]?.reasonCode, 'PERSIST_FAILED');

    const names = db.all<{ name: string }>('SELECT name FROM airports ORDER BY name').map((r) => r.name);
    assert.deepEqual(names, ['First', 'Third']);
  } finally {
    db.close();
  }
});

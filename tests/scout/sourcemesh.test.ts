/**
 * SourceMesh: the commercial claim is that a new dataset is a spec, not code.
 * These tests hold that line -- three record shapes through one adapter, and an
 * 85%-loss anomaly surfacing as a diagnosis instead of a green tick.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../scout/db/index.ts';
import { migrate } from '../../scout/db/migrate.ts';
import { ensureRegions, upsertCountry } from '../../scout/db/repo-core.ts';
import { validateSpec, readPath, SpecError, type SourceSpec } from '../../scout/sourcemesh/spec.ts';
import { parseRecords, profileRecords, proposeMapping } from '../../scout/sourcemesh/profile.ts';
import { detectFunnelAnomalies, diagnoseGeoAnomaly, SYSTEMIC_LOSS } from '../../scout/sourcemesh/anomaly.ts';
import { createSourceAdapter, extractField } from '../../scout/sourcemesh/adapter.ts';
import { registerSpec, loadSpecs } from '../../scout/sourcemesh/registry.ts';
import { mapRegion } from '../../scout/sourcemesh/sink.ts';
import type { Transport } from '../../scout/contracts/index.ts';
import { unwrap } from '../../scout/contracts/index.ts';

function db0() {
  const db = openDb(':memory:');
  migrate(db);
  ensureRegions(db);
  return db;
}

function stubTransport(body: string): Transport {
  return {
    mode: 'offline',
    async request() {
      return { ok: true, value: { status: 200, headers: {}, body, replayed: true, latencyMs: 1 } };
    },
  };
}

const AIRPORT_CSV = `"ident","type","name","latitude_deg","longitude_deg","continent","iso_country","municipality","gps_code","iata_code"
"EGLL","medium_airport","London Heathrow",51.4706,-0.4619,"","GB","London","EGLL","LHR"
"RJTT","medium_airport","Tokyo Haneda",35.5523,139.78,"","JP","Tokyo","RJTT","HND"
"KORD","medium_airport","Chicago O'Hare, Intl",41.9769,-87.9081,"","US","Chicago","KORD","ORD"
`;

const AIRPORT_SPEC: SourceSpec = {
  id: 'test-airports', name: 'Test airports', entity: 'airport', format: 'csv',
  locator: 'https://example.test/airports.csv', trustTier: 'open_dataset',
  license: { name: 'MIT', attribution: 'test', commercialUse: true },
  identity: ['icao'],
  fields: {
    icao: { anyOf: ['gps_code', 'ident'], transform: 'upper' },
    name: { field: 'name', transform: 'trim' },
    lat: { field: 'latitude_deg', transform: 'number' },
    lon: { field: 'longitude_deg', transform: 'number' },
    countryIso2: { field: 'iso_country', transform: 'upper' },
    regionCode: { field: 'continent', transform: 'upper' },
  },
  quality: { rejectIfMissing: ['icao', 'name', 'lat', 'lon', 'countryIso2', 'regionCode'] },
};

test('a source without licence and attribution cannot be registered', () => {
  const db = db0();
  try {
    assert.throws(() => validateSpec({ ...AIRPORT_SPEC, license: { name: 'MIT' } }), SpecError);
    const bad = { ...AIRPORT_SPEC, license: { name: '', attribution: '', commercialUse: true } };
    const result = registerSpec(db, bad as SourceSpec);
    assert.equal(result.ok, false, 'provenance must be mandatory, not advisory');
  } finally {
    db.close();
  }
});

test('every shipped spec is valid and declares a licence', () => {
  for (const spec of loadSpecs()) {
    assert.ok(spec.license.name, `${spec.id} has no licence`);
    assert.ok(spec.license.attribution, `${spec.id} has no attribution`);
    assert.ok(spec.identity.length > 0, `${spec.id} has no identity`);
  }
});

test('one adapter parses three different record shapes', async () => {
  const db = db0();
  try {
    // 1. CSV with a quoted comma inside a field
    const csv = parseRecords(AIRPORT_CSV, AIRPORT_SPEC);
    assert.equal(csv.length, 3);
    assert.equal(csv[2]?.name, "Chicago O'Hare, Intl");

    // 2. JSON array with nested paths
    const jsonSpec = { ...AIRPORT_SPEC, format: 'json' as const };
    const arr = parseRecords(JSON.stringify([{ name: { common: 'France' }, cca2: 'FR' }]), jsonSpec);
    assert.equal(readPath(arr[0], 'name.common'), 'France');

    // 3. JSON object keyed by id -- the key survives as _key
    const mapSpec = { ...AIRPORT_SPEC, format: 'json-map' as const };
    const map = parseRecords(JSON.stringify({ '3040051': { name: 'Escaldes' } }), mapSpec);
    assert.equal(map[0]?._key, '3040051');
    assert.equal(map[0]?.name, 'Escaldes');
  } finally {
    db.close();
  }
});

test('auto-mapping refuses a plausible-looking but wrong field', () => {
  // Regression: substring matching mapped the synonym `alt` (elevation) onto
  // `alternatenames`, proposing a list of place names as an altitude.
  const records = [{ alternatenames: ['A', 'B'], name: 'X', latitude: 1, longitude: 2 }];
  const proposal = proposeMapping(profileRecords(records, 'json'));
  assert.notEqual(proposal.mapping.elevation, 'alternatenames');
  assert.equal(proposal.mapping.aliases, 'alternatenames');
  assert.equal(proposal.mapping.lat, 'latitude');
});

test('a field that is never populated is never proposed', () => {
  const records = [{ continent: '', iso_country: 'GB', name: 'x' }, { continent: '', iso_country: 'JP', name: 'y' }];
  const profile = profileRecords(records, 'csv');
  assert.ok(profile.neverPopulated.includes('continent'));
  const proposal = proposeMapping(profile);
  assert.notEqual(proposal.mapping.countryIso2, 'continent');
});

test('validateMapping catches a dead mapping before a full run', async () => {
  const db = db0();
  try {
    const adapter = createSourceAdapter(db, AIRPORT_SPEC);
    const result = unwrap(await adapter.validateMapping(stubTransport(AIRPORT_CSV)));
    assert.equal(result.valid, false);
    assert.ok(result.deadMappings.includes('regionCode'),
      'a mapping onto an always-empty column must be flagged');
    assert.equal(result.coverage.countryIso2, 1);
  } finally {
    db.close();
  }
});

test('an 85% loss is an anomaly with a repair, not a successful run', async () => {
  const db = db0();
  try {
    for (const [iso2, iso3, name, region] of [
      ['GB', 'GBR', 'United Kingdom', 'EU'], ['JP', 'JPN', 'Japan', 'AS'], ['US', 'USA', 'United States', 'NA'],
    ] as const) {
      upsertCountry(db, { iso2, iso3, name, regionCode: region, currency: null });
    }

    const adapter = createSourceAdapter(db, AIRPORT_SPEC);
    const result = unwrap(await adapter.ingest({ transport: stubTransport(AIRPORT_CSV), dryRun: true }));

    assert.equal(result.imported, 0, 'the naive spec should lose every row');
    assert.ok(result.anomalies.length > 0, 'a total loss must raise an anomaly');

    const anomaly = result.anomalies.find((a) => a.repair);
    assert.ok(anomaly, 'the anomaly must carry a repair proposal');
    assert.equal(anomaly.severity, 'critical');
    assert.equal(anomaly.likelyCause, 'continent');
    assert.match(anomaly.repair!.chain, /iso_country -> countries\.iso2 -> countries\.region_code/);
    assert.ok(anomaly.repair!.recoverableInSample > 0);
    assert.ok(anomaly.repair!.sampled >= anomaly.repair!.recoverableInSample,
      'recoveries can never exceed the sample they were observed in');

    // The funnel must localise the failure, not just report the total.
    const region = result.stages.find((s) => s.name === 'REGION RESOLVED');
    const country = result.stages.find((s) => s.name === 'COUNTRY MATCHED');
    assert.equal(country?.count, 3, 'countries matched fine');
    assert.equal(region?.count, 0, 'the region is where it failed');
  } finally {
    db.close();
  }
});

test('the proposed repair, applied as config alone, recovers every row', async () => {
  const db = db0();
  try {
    for (const [iso2, iso3, name, region] of [
      ['GB', 'GBR', 'United Kingdom', 'EU'], ['JP', 'JPN', 'Japan', 'AS'], ['US', 'USA', 'United States', 'NA'],
    ] as const) {
      upsertCountry(db, { iso2, iso3, name, regionCode: region, currency: null });
    }

    const repaired: SourceSpec = {
      ...AIRPORT_SPEC,
      id: 'test-airports-repaired',
      fields: {
        ...AIRPORT_SPEC.fields,
        regionCode: {
          field: 'continent', transform: 'upper',
          resolver: [{ lookup: { table: 'countries', match: 'iso2', using: 'countryIso2', from: 'region_code' } }],
        },
      },
    };

    const result = unwrap(
      await createSourceAdapter(db, repaired).ingest({ transport: stubTransport(AIRPORT_CSV), dryRun: true }),
    );
    assert.equal(result.imported, 3, 'the resolver chain should recover every row');
    assert.equal(result.anomalies.length, 0);
    assert.deepEqual(
      result.records.map((r) => r.values.regionCode).sort(),
      ['AS', 'EU', 'NA'],
    );
  } finally {
    db.close();
  }
});

test('unchanged sources are skipped rather than re-ingested', async () => {
  const db = db0();
  try {
    upsertCountry(db, { iso2: 'GB', iso3: 'GBR', name: 'United Kingdom', regionCode: 'EU', currency: null });
    const spec: SourceSpec = { ...AIRPORT_SPEC, id: 'test-change', quality: {} };
    const adapter = createSourceAdapter(db, spec);
    registerSpec(db, spec);

    const first = unwrap(await adapter.ingest({ transport: stubTransport(AIRPORT_CSV) }));
    assert.equal(first.unchanged, false);

    const second = unwrap(await createSourceAdapter(db, spec).ingest({ transport: stubTransport(AIRPORT_CSV) }));
    assert.equal(second.unchanged, true, 'an unchanged source must not be re-processed');
    assert.equal(second.status, 'unchanged');

    const changed = unwrap(
      await createSourceAdapter(db, spec).ingest({ transport: stubTransport(AIRPORT_CSV + '"X","medium_airport","Y",1,2,"","GB","Z","XXXX","XYZ"\n') }),
    );
    assert.equal(changed.unchanged, false, 'a changed body must be re-processed');
  } finally {
    db.close();
  }
});

test('extractField applies transforms and anyOf fallbacks', () => {
  assert.equal(extractField({ a: ' x ' }, { field: 'a', transform: 'trim' }), 'x');
  assert.equal(extractField({ a: '3.5' }, { field: 'a', transform: 'number' }), 3.5);
  assert.equal(extractField({ a: '3.9' }, { field: 'a', transform: 'integer' }), 3);
  assert.equal(extractField({ a: 'yes' }, { field: 'a', transform: 'boolean' }), true);
  assert.equal(extractField({ a: ['p', 'q'] }, { field: 'a', transform: 'join' }), 'p; q');
  assert.equal(extractField({ b: 'fallback' }, { field: 'a', anyOf: ['b'] }), 'fallback');
  assert.equal(extractField({}, { field: 'a', default: 'd' }), 'd');
  assert.equal(extractField({ a: '' }, { field: 'a' }), null);
});

test('funnel anomalies fire only on systemic loss', () => {
  const small = detectFunnelAnomalies([{ name: 'A', count: 100 }, { name: 'B', count: 95 }]);
  assert.equal(small.length, 0, `${SYSTEMIC_LOSS * 100}% is the floor; 5% is noise`);
  const big = detectFunnelAnomalies([{ name: 'A', count: 100 }, { name: 'B', count: 20 }]);
  assert.equal(big.length, 1);
  assert.equal(big[0]?.severity, 'critical');
});

test('region mapping falls back from subregion to region', () => {
  assert.equal(mapRegion('Western Europe', 'Europe'), 'EU');
  assert.equal(mapRegion('Western Asia', 'Asia'), 'ME');
  assert.equal(mapRegion(null, 'Oceania'), 'OC');
  assert.equal(mapRegion('nonsense', null), null);
});

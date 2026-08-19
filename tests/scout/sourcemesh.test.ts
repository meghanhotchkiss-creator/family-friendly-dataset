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
import { mapRegion, writeRecords } from '../../scout/sourcemesh/sink.ts';
import { checkAccounting, REASON_CODES } from '../../scout/sourcemesh/accounting.ts';
import { quarantineRecords, listQuarantine } from '../../scout/sourcemesh/quarantine.ts';
import { statusReport } from '../../scout/sourcemesh/status.ts';
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

test('every source row lands in exactly one terminal bucket', () => {
  const balanced = {
    source_rows: 100, parsed_rows: 100, mapped_rows: 100, validated_rows: 90, matched_rows: 100,
    inserted_rows: 70, updated_rows: 15, unchanged_rows: 5, quarantined_rows: 8, rejected_rows: 2,
  };
  const check = checkAccounting(balanced);
  assert.equal(check.balanced, true);
  assert.equal(check.terminal, 100);

  // Progress gauges must NOT be counted as destinations.
  const doubleCounted = { ...balanced, inserted_rows: 80 };
  assert.equal(checkAccounting(doubleCounted).balanced, false);
  assert.ok(checkAccounting(doubleCounted).explanation.includes('counted twice'));

  const leaking = { ...balanced, inserted_rows: 60 };
  const leak = checkAccounting(leaking);
  assert.equal(leak.balanced, false);
  assert.equal(leak.unaccounted, 10);
  assert.ok(leak.explanation.includes('unaccounted for'));
});

test('a total validation failure quarantines every row rather than sampling', async () => {
  const db = db0();
  try {
    for (const [iso2, iso3, name, region] of [
      ['GB', 'GBR', 'United Kingdom', 'EU'], ['JP', 'JPN', 'Japan', 'AS'], ['US', 'USA', 'United States', 'NA'],
    ] as const) {
      upsertCountry(db, { iso2, iso3, name, regionCode: region, currency: null });
    }
    const spec = { ...AIRPORT_SPEC, id: 'test-quarantine' };
    registerSpec(db, spec);
    const result = unwrap(
      await createSourceAdapter(db, spec).ingest({ transport: stubTransport(AIRPORT_CSV) }),
    );

    // Every rejected row is returned, not a diagnostic sample.
    assert.equal(result.rejections.length, 3, 'all rejected rows must be retained');
    for (const rejection of result.rejections) {
      assert.equal(rejection.reasonCode, 'MISSING_REQUIRED_FIELD');
      assert.ok(rejection.record.raw, 'the raw record must survive for a re-drive');
    }

    const held = quarantineRecords(db, result.runId, spec.id, result.rejections, 'validate');
    assert.equal(held, 3);
    const rows = listQuarantine(db, spec.id, 10);
    assert.equal(rows.length, 3);
    assert.ok(rows[0]?.rawRecord.includes('"iso_country"') || rows[0]?.rawRecord.includes('iso_country'));
    assert.ok(rows.every((r) => r.reasonCode === 'MISSING_REQUIRED_FIELD'));
  } finally {
    db.close();
  }
});

test('the sink distinguishes inserted from updated from unchanged', () => {
  const db = db0();
  try {
    upsertCountry(db, { iso2: 'GB', iso3: 'GBR', name: 'United Kingdom', regionCode: 'EU', currency: null });
    const spec: SourceSpec = {
      ...AIRPORT_SPEC, id: 'test-sink', entity: 'city',
      identity: ['name'],
      fields: {
        name: { field: 'name' }, countryIso2: { field: 'iso' },
        lat: { field: 'lat', transform: 'number' }, lon: { field: 'lon', transform: 'number' },
        population: { field: 'pop', transform: 'integer' },
      },
      quality: {},
    };
    const make = (pop: number) => [{
      identity: 'London',
      values: { name: 'London', countryIso2: 'GB', lat: 51.5, lon: -0.1, population: pop },
      raw: {},
    }];

    const first = unwrap(writeRecords(db, spec, make(9000000)));
    assert.equal(first.inserted, 1);

    const same = unwrap(writeRecords(db, spec, make(9000000)));
    assert.equal(same.unchanged, 1, 'an identical record is unchanged, not an update');
    assert.equal(same.inserted, 0);

    const changed = unwrap(writeRecords(db, spec, make(9500000)));
    assert.equal(changed.updated, 1, 'a differing record is an update');
  } finally {
    db.close();
  }
});

test('the sink quarantines with a machine-readable reason code', () => {
  const db = db0();
  try {
    const spec: SourceSpec = {
      ...AIRPORT_SPEC, id: 'test-sink-reject', entity: 'city', identity: ['name'],
      fields: { name: { field: 'name' }, countryIso2: { field: 'iso' } }, quality: {},
    };
    const result = unwrap(writeRecords(db, spec, [
      { identity: 'Nowhere', values: { name: 'Nowhere', countryIso2: 'ZZ' }, raw: { name: 'Nowhere' } },
    ]));
    assert.equal(result.rejections.length, 1);
    assert.equal(result.rejections[0]?.reasonCode, 'NO_MATCHING_COUNTRY');
    assert.ok(REASON_CODES.includes(result.rejections[0]!.reasonCode));
  } finally {
    db.close();
  }
});

test('status is derived from live state, and gaps are visible', () => {
  const db = db0();
  try {
    const report = statusReport(db);
    // Designed-but-unconnected sources must appear, or a gap looks like absence.
    const nps = report.find((r) => r.id === 'nps');
    assert.ok(nps, 'a designed source must be listed even when not started');
    assert.equal(nps.state, 'NOT STARTED');
    assert.match(nps.detail, /priority 1/);

    // A shipped spec on an empty database is BUILT, not SEEDED.
    const shipped = report.find((r) => r.id === 'ourairports');
    assert.ok(shipped);
    assert.equal(shipped.state === 'SEEDED' || shipped.state === 'TESTED', false,
      'nothing is seeded on a fresh database');
    assert.ok(shipped.reached.includes('BUILT'));
  } finally {
    db.close();
  }
});

test('the same airport from two sources resolves to one row, not a collision', () => {
  // Regression: the sink derived airport ids as `icao ?? iata` while
  // repo-core and the fixture importer used `iata ?? icao`, so the same
  // physical airport got two ids depending on which source loaded it -- and
  // the second write blew up on the UNIQUE iata index mid-run.
  const db = db0();
  try {
    upsertCountry(db, { iso2: 'US', iso3: 'USA', name: 'United States', regionCode: 'NA', currency: null });
    const spec: SourceSpec = {
      ...AIRPORT_SPEC, id: 'test-identity',
      fields: {
        icao: { field: 'gps_code', transform: 'upper' },
        iata: { field: 'iata_code', transform: 'upper' },
        name: { field: 'name' }, countryIso2: { field: 'iso', transform: 'upper' },
        lat: { field: 'lat', transform: 'number' }, lon: { field: 'lon', transform: 'number' },
        regionCode: { const: 'NA' },
      },
      quality: {},
    };
    const record = (name: string) => [{
      identity: 'KSFO',
      values: { icao: 'KSFO', iata: 'SFO', name, countryIso2: 'US', lat: 37.6, lon: -122.4, regionCode: 'NA' },
      raw: {},
    }];

    const first = unwrap(writeRecords(db, spec, record('San Francisco Intl')));
    assert.equal(first.inserted, 1);

    // A second source describing the same airport must update, not collide.
    const second = unwrap(writeRecords(db, spec, record('San Francisco International Airport')));
    assert.equal(second.rejections.length, 0, 'must not fail on the UNIQUE iata index');
    assert.equal(second.updated, 1);
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) n FROM airports')?.n, 1, 'one physical airport, one row');
  } finally {
    db.close();
  }
});

test('a database constraint quarantines one record instead of aborting the run', () => {
  const db = db0();
  try {
    upsertCountry(db, { iso2: 'US', iso3: 'USA', name: 'United States', regionCode: 'NA', currency: null });
    const spec: SourceSpec = {
      ...AIRPORT_SPEC, id: 'test-persist-fail',
      fields: {
        icao: { field: 'icao' }, iata: { field: 'iata' }, name: { field: 'name' },
        countryIso2: { const: 'US' }, lat: { const: 1 }, lon: { const: 2 },
        regionCode: { const: 'BADREGION' },
      },
      quality: {},
    };
    const rows = [
      { identity: 'a', values: { icao: 'KAAA', iata: 'AAA', name: 'A', countryIso2: 'US', lat: 1, lon: 2, regionCode: 'BADREGION' }, raw: { n: 1 } },
      { identity: 'b', values: { icao: 'KBBB', iata: 'BBB', name: 'B', countryIso2: 'US', lat: 1, lon: 2, regionCode: 'NA' }, raw: { n: 2 } },
    ];
    const result = unwrap(writeRecords(db, spec, rows));
    // The bad row is quarantined with a reason code; the good row still lands.
    assert.equal(result.rejections.length, 1);
    assert.equal(result.rejections[0]?.reasonCode, 'PERSIST_FAILED');
    assert.equal(result.inserted, 1, 'one bad row must not roll back the whole run');
  } finally {
    db.close();
  }
});

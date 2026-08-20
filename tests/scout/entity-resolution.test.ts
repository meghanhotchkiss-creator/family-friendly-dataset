/**
 * Entity resolution. The rule that matters: never merge on name alone.
 * There are nine distinct Springfields in the United States.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../scout/db/index.ts';
import { migrate } from '../../scout/db/migrate.ts';
import { ensureRegions, upsertCountry, upsertCity, upsertAirport } from '../../scout/db/repo-core.ts';
import {
  resolveCities, mergeMatches, classifyPair, haversineKm, normalizeName,
  matchSummary, linkAirportsByGeonameId, MATCH_KM, STUB_MATCH_KM, NO_MATCH_KM, type MatchEvidence,
} from '../../scout/sourcemesh/entity-resolution.ts';
import { unwrap } from '../../scout/contracts/index.ts';

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  ensureRegions(db);
  upsertCountry(db, { iso2: 'US', iso3: 'USA', name: 'United States', regionCode: 'NA', currency: null });
  return db;
}

function city(db: ReturnType<typeof seed>, id: string, name: string, admin1: string | null, lat: number, lon: number, population: number | null = null) {
  return upsertCity(db, {
    id, name, countryId: 'country:us', admin1, lat, lon, population, timezone: null,
  } as never);
}

const base: MatchEvidence = {
  distanceKm: 0, nameExact: true, aliasOverlap: false, populationRatio: null,
  admin1: { left: 'CA', right: 'CA', comparable: true },
};

test('haversine and name normalisation', () => {
  // London -> Paris is about 344km.
  const km = haversineKm(51.5074, -0.1278, 48.8566, 2.3522);
  assert.ok(Math.abs(km - 344) < 8, `expected ~344km, got ${km.toFixed(1)}`);
  assert.equal(normalizeName('  São  Paulo! '), 'sao paulo');
  assert.equal(normalizeName('St. Louis'), 'st louis');
});

test('distance decides, not the name', () => {
  assert.equal(classifyPair({ ...base, distanceKm: 2 }).state, 'MATCH');
  assert.equal(classifyPair({ ...base, distanceKm: MATCH_KM + 1 }).state, 'POSSIBLE_MATCH');
  assert.equal(classifyPair({ ...base, distanceKm: NO_MATCH_KM + 1 }).state, 'NO_MATCH');
  // An identical name at continental distance is a coincidence.
  assert.equal(classifyPair({ ...base, distanceKm: 1200 }).score, 0);
});

test('a stub with no admin1 matches further out than two rows that both assert one', () => {
  const stub: MatchEvidence = { ...base, admin1: { left: 'CA', right: null, comparable: false } };
  const bothAssert: MatchEvidence = { ...base, admin1: { left: 'MA', right: 'NH', comparable: true } };
  const distance = 40; // between MATCH_KM and STUB_MATCH_KM

  assert.equal(classifyPair({ ...stub, distanceKm: distance }).state, 'MATCH',
    'a stub asserts no region, so it cannot contradict the other row');
  assert.equal(classifyPair({ ...bothAssert, distanceKm: distance }).state, 'POSSIBLE_MATCH',
    'Salem MA and Salem NH both assert a region and must not merge');
  assert.equal(classifyPair({ ...stub, distanceKm: STUB_MATCH_KM + 1 }).state, 'POSSIBLE_MATCH');
});

test('nine Springfields survive resolution; one city seen twice does not', () => {
  const db = seed();
  try {
    // Genuinely different towns sharing a name.
    city(db, 'city:us-il-springfield', 'Springfield', 'IL', 39.80, -89.64);
    city(db, 'city:us-ma-springfield', 'Springfield', 'MA', 42.10, -72.59);
    city(db, 'city:us-mo-springfield', 'Springfield', 'MO', 37.22, -93.30);
    // One city, two sources: a rich row and an airport-derived stub 20km away.
    city(db, 'city:us-ca-los-angeles', 'Los Angeles', 'CA', 34.05, -118.24, 3_900_000);
    city(db, 'city:us-los-angeles', 'Los Angeles', null, 33.94, -118.40);

    const stats = unwrap(resolveCities(db));
    assert.equal(stats.candidatePairs, 4, '3 Springfield pairs + 1 Los Angeles pair');
    assert.equal(stats.match, 1, 'only Los Angeles is one city');
    assert.equal(stats.noMatch, 3, 'the Springfields are distinct');

    const summary = matchSummary(db);
    assert.equal(summary.MATCH, 1);
    assert.equal(summary.NO_MATCH, 3);

    unwrap(mergeMatches(db));
    const springfields = db.all('SELECT id FROM cities WHERE name = ?', 'Springfield');
    assert.equal(springfields.length, 3, 'merging on name alone would have destroyed these');
    const la = db.all('SELECT id FROM cities WHERE name = ?', 'Los Angeles');
    assert.equal(la.length, 1, 'the duplicate must be gone');
    assert.equal(la[0]?.id, 'city:us-ca-los-angeles', 'the richer row survives');
  } finally {
    db.close();
  }
});

test('every candidate pair is stored — the pair is the identity, not the left row', () => {
  // Regression: the unique key was (entity_type, left_source, left_key), so a
  // city appearing in several pairs kept only the last decision. 785 of 6,579
  // real pairs were overwritten with no error raised.
  const db = seed();
  try {
    for (const [id, admin1, lat] of [
      ['city:us-a-springfield', 'IL', 39.80], ['city:us-b-springfield', 'MA', 42.10],
      ['city:us-c-springfield', 'MO', 37.22], ['city:us-d-springfield', 'OH', 39.92],
    ] as const) {
      city(db, id, 'Springfield', admin1, lat, -89.0);
    }
    const stats = unwrap(resolveCities(db));
    assert.equal(stats.candidatePairs, 6, '4 cities produce 6 unordered pairs');
    const stored = db.get<{ n: number }>('SELECT COUNT(*) n FROM entity_matches')?.n;
    assert.equal(stored, 6, 'every classified pair must be retained');
  } finally {
    db.close();
  }
});

test('merging re-points references and leaves no dangling rows', () => {
  const db = seed();
  try {
    city(db, 'city:us-ca-los-angeles', 'Los Angeles', 'CA', 34.05, -118.24, 3_900_000);
    city(db, 'city:us-los-angeles', 'Los Angeles', null, 33.94, -118.40);
    upsertAirport(db, {
      id: 'airport:lax', iata: 'LAX', icao: 'KLAX', name: 'Los Angeles Intl',
      cityId: 'city:us-los-angeles', countryId: 'country:us', regionCode: 'NA',
      lat: 33.94, lon: -118.40, kind: 'large',
    });

    unwrap(resolveCities(db));
    const stats = unwrap(mergeMatches(db));
    assert.equal(stats.merged, 1);
    assert.equal(stats.airportsRepointed, 1, 'the airport must follow the survivor');

    const airport = db.get<{ city_id: string }>('SELECT city_id FROM airports WHERE id = ?', 'airport:lax');
    assert.equal(airport?.city_id, 'city:us-ca-los-angeles');
    assert.equal(db.all('PRAGMA foreign_key_check').length, 0, 'no dangling references');
  } finally {
    db.close();
  }
});

test('POSSIBLE_MATCH is never merged automatically', () => {
  const db = seed();
  try {
    // Salem MA and Salem NH: 39km apart, both assert a region.
    city(db, 'city:us-ma-salem', 'Salem', 'MA', 42.5195, -70.8967);
    city(db, 'city:us-nh-salem', 'Salem', 'NH', 42.7884, -71.2009);

    const stats = unwrap(resolveCities(db));
    assert.equal(stats.possibleMatch, 1);
    assert.equal(stats.match, 0);

    unwrap(mergeMatches(db));
    assert.equal(db.all('SELECT id FROM cities WHERE name = ?', 'Salem').length, 2,
      'an automatic decision on an ambiguous pair is what corrupts a graph');
  } finally {
    db.close();
  }
});

test('a published GeoNames id links exactly, with nothing to infer', () => {
  const db = seed();
  try {
    // OPTD publishes the GeoNames id of the city an airport serves; GeoNames
    // publishes the same id on the city. Where both exist this is identity.
    upsertCity(db, {
      id: 'city:us-ca-los-angeles', name: 'Los Angeles', countryId: 'country:us',
      admin1: 'CA', lat: 34.05, lon: -118.24, population: 3_900_000, timezone: null,
      geonameId: 5368361,
    } as never);
    upsertAirport(db, {
      id: 'airport:lax', iata: 'LAX', icao: 'KLAX', name: 'Los Angeles Intl',
      cityId: null, countryId: 'country:us', regionCode: 'NA',
      lat: 33.94, lon: -118.40, kind: 'large',
      geonameId: 5368418, cityGeonameId: 5368361,
    } as never);
    // An airport whose city is not in the graph must be reported, not guessed at.
    upsertAirport(db, {
      id: 'airport:zzz', iata: 'ZZZ', icao: 'KZZZ', name: 'Nowhere Intl',
      cityId: null, countryId: 'country:us', regionCode: 'NA',
      lat: 1, lon: 1, kind: 'small', geonameId: 1, cityGeonameId: 999999999,
    } as never);

    const stats = unwrap(linkAirportsByGeonameId(db));
    assert.equal(stats.linked, 1);
    assert.equal(stats.noCityRow, 1, 'an unmatched id is reported, not invented');

    const airport = db.get<{ city_id: string }>('SELECT city_id FROM airports WHERE id = ?', 'airport:lax');
    assert.equal(airport?.city_id, 'city:us-ca-los-angeles');

    // Re-running is idempotent: the link is already correct.
    const again = unwrap(linkAirportsByGeonameId(db));
    assert.equal(again.linked, 0);
    assert.equal(again.alreadyCorrect, 1);
  } finally {
    db.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';

import type { Db } from '../../scout/db/index.ts';
import { openDb } from '../../scout/db/index.ts';
import { migrate } from '../../scout/db/migrate.ts';
import { ensureRegions, upsertCountry, upsertCity, upsertNeighborhood, upsertUser } from '../../scout/db/repo-core.ts';
import { upsertPlace } from '../../scout/db/repo-places.ts';
import type { Place, PlaceCategory, Result } from '../../scout/contracts/index.ts';
import { ok, err } from '../../scout/contracts/index.ts';
import { freezeClock, unfreezeClock, nowIso, plusSeconds } from '../../scout/runtime/clock.ts';

import {
  cacheKey, cacheGet, cacheSet, cacheInvalidate, cacheSweep, withCache,
} from '../../scout/travel/freshness-cache.ts';
import { startJob, finishJob, runJob, recentJobs, lastJobRun } from '../../scout/travel/jobs.ts';
import {
  normalizeName, deriveTouristiness, deriveLocalFavor, normalizePlaces,
} from '../../scout/travel/normalize.ts';

const T0 = '2026-01-01T00:00:00.000Z';

interface Fixture {
  db: Db;
  cityId: string;
}

function setup(): Fixture {
  const db = openDb(':memory:');
  migrate(db);
  ensureRegions(db);
  const countryId = upsertCountry(db, {
    iso2: 'FR', iso3: 'FRA', name: 'France', regionCode: 'EU', currency: 'EUR',
  });
  const cityId = upsertCity(db, {
    name: 'Paris', countryId, admin1: 'IDF', lat: 48.8566, lon: 2.3522,
    population: 2_100_000, timezone: 'Europe/Paris',
  });
  return { db, cityId };
}

function mkPlace(db: Db, cityId: string, over: Partial<Place> & { id: string; name: string }): Place {
  const place: Place = {
    id: over.id,
    name: over.name,
    cityId,
    neighborhoodId: over.neighborhoodId ?? null,
    lat: over.lat ?? null,
    lon: over.lon ?? null,
    category: (over.category ?? 'museum') as PlaceCategory,
    subcategory: over.subcategory ?? null,
    priceTier: over.priceTier ?? null,
    indoorOutdoor: over.indoorOutdoor ?? null,
    rating: over.rating ?? null,
    minAge: over.minAge ?? null,
    maxAge: over.maxAge ?? null,
    durationMinutes: over.durationMinutes ?? null,
    touristiness: over.touristiness ?? null,
    localFavor: over.localFavor ?? null,
    description: over.description ?? null,
    canonicalHash: over.canonicalHash ?? 'not-a-real-hash',
    updatedAt: over.updatedAt ?? T0,
  };
  upsertPlace(db, place);
  return place;
}

// --------------------------------------------------------------------------
// freshness cache
// --------------------------------------------------------------------------

test('cacheKey is order-independent and provider-scoped', () => {
  const a = cacheKey('provider:weather', { city: 'paris', day: 3 });
  const b = cacheKey('provider:weather', { day: 3, city: 'paris' });
  assert.equal(a, b);
  assert.notEqual(a, cacheKey('provider:other', { city: 'paris', day: 3 }));
  assert.ok(a.startsWith('provider:weather:'));
});

test('cache hit, expiry and stale flag', () => {
  const { db } = setup();
  try {
    freezeClock(T0);
    const entry = cacheSet(db, 'k1', 'live', { temp: 7 }, null);
    assert.equal(entry.stale, false);
    assert.equal(entry.expiresAt, plusSeconds(T0, 300));

    const hit = cacheGet<{ temp: number }>(db, 'k1');
    assert.ok(hit);
    assert.deepEqual(hit.value, { temp: 7 });
    assert.equal(hit.stale, false);

    // one second before the TTL: still a hit
    freezeClock(plusSeconds(T0, 299));
    assert.ok(cacheGet(db, 'k1'));

    // past the TTL: withheld, a refetch is due
    freezeClock(plusSeconds(T0, 301));
    assert.equal(cacheGet(db, 'k1'), null);

    // a row flagged stale is still served while inside its TTL
    freezeClock(T0);
    cacheSet(db, 'k2', 'periodic', { hours: '9-5' }, null);
    db.run('UPDATE live_data_cache SET stale = 1 WHERE cache_key = ?', 'k2');
    const flagged = cacheGet<{ hours: string }>(db, 'k2');
    assert.ok(flagged);
    assert.equal(flagged.stale, true);

    assert.equal(cacheInvalidate(db, 'k2'), true);
    assert.equal(cacheInvalidate(db, 'k2'), false);
    assert.equal(cacheGet(db, 'k2'), null);
  } finally {
    unfreezeClock();
    db.close();
  }
});

test('cacheSweep deletes past staleAfter and flags past ttl', () => {
  const { db } = setup();
  try {
    freezeClock(T0);
    cacheSet(db, 'old', 'live', 1, null); // age 2000s at sweep -> beyond staleAfter (1800)
    freezeClock(plusSeconds(T0, 1500));
    cacheSet(db, 'mid', 'live', 2, null); // age 500s -> past ttl (300), flagged
    freezeClock(plusSeconds(T0, 1900));
    cacheSet(db, 'fresh', 'live', 3, null); // age 100s -> untouched

    freezeClock(plusSeconds(T0, 2000));
    assert.deepEqual(cacheSweep(db), { expired: 1, markedStale: 1 });

    assert.equal(db.get('SELECT 1 AS x FROM live_data_cache WHERE cache_key = ?', 'old'), undefined);
    const mid = db.get<{ stale: number }>(
      'SELECT stale FROM live_data_cache WHERE cache_key = ?', 'mid',
    );
    assert.equal(Number(mid?.stale), 1);
    const fresh = db.get<{ stale: number }>(
      'SELECT stale FROM live_data_cache WHERE cache_key = ?', 'fresh',
    );
    assert.equal(Number(fresh?.stale), 0);

    // sweeping again is idempotent for the already-flagged row
    assert.deepEqual(cacheSweep(db), { expired: 0, markedStale: 0 });
  } finally {
    unfreezeClock();
    db.close();
  }
});

test('withCache reads through, then falls back to a stale value when load fails', async () => {
  const { db } = setup();
  try {
    freezeClock(T0);
    let calls = 0;
    const good = async (): Promise<Result<{ n: number }>> => {
      calls += 1;
      return ok({ n: calls });
    };

    const miss = await withCache(db, 'wc', 'live', null, good);
    assert.ok(miss.ok);
    assert.deepEqual(miss.value, { value: { n: 1 }, cached: false, stale: false });

    const hit = await withCache(db, 'wc', 'live', null, good);
    assert.ok(hit.ok);
    assert.equal(hit.value.cached, true);
    assert.equal(hit.value.stale, false);
    assert.equal(calls, 1, 'a hit must not call the loader');

    // past the TTL but inside staleAfter, with a dead upstream
    freezeClock(plusSeconds(T0, 600));
    const failing = async (): Promise<Result<{ n: number }>> =>
      err('upstream_unavailable', 'provider down');
    const stale = await withCache(db, 'wc', 'live', null, failing);
    assert.ok(stale.ok, 'a stale value beats no value');
    assert.deepEqual(stale.value, { value: { n: 1 }, cached: true, stale: true });

    // past staleAfter the entry is no longer usable, so the error surfaces
    freezeClock(plusSeconds(T0, 3600));
    const dead = await withCache(db, 'wc', 'live', null, failing);
    assert.equal(dead.ok, false);
    if (!dead.ok) assert.equal(dead.error.kind, 'upstream_unavailable');

    // a thrown loader is caught, and still fails over to nothing here
    const thrower = async (): Promise<Result<number>> => {
      throw new Error('boom');
    };
    const threw = await withCache(db, 'never-cached', 'live', null, thrower);
    assert.equal(threw.ok, false);
    if (!threw.ok) assert.equal(threw.error.kind, 'internal');
  } finally {
    unfreezeClock();
    db.close();
  }
});

test('cacheSet stores against a provider when one is given', () => {
  const { db } = setup();
  try {
    freezeClock(T0);
    db.run(
      `INSERT INTO providers (id, kind, source_class, authority, freshness_tier)
       VALUES ('provider:test', 'weather', 'official', 0.95, 'live')`,
    );
    cacheSet(db, 'p1', 'live', { ok: true }, 'provider:test');
    const row = db.get<{ provider_id: string }>(
      'SELECT provider_id FROM live_data_cache WHERE cache_key = ?', 'p1',
    );
    assert.equal(row?.provider_id, 'provider:test');
  } finally {
    unfreezeClock();
    db.close();
  }
});

// --------------------------------------------------------------------------
// job ledger
// --------------------------------------------------------------------------

test('runJob records ok runs and returns the Result untouched', async () => {
  const { db } = setup();
  try {
    freezeClock(T0);
    const result = await runJob(db, 'demo:ok', () => ok({ rows: 12 }));
    assert.ok(result.ok);
    assert.deepEqual(result.value, { rows: 12 });

    const runs = recentJobs(db, 'demo:ok');
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, 'ok');
    assert.deepEqual(runs[0]?.stats, { rows: 12 });
    assert.equal(runs[0]?.error, null);
    assert.equal(runs[0]?.finishedAt, T0);
    assert.deepEqual(lastJobRun(db, 'demo:ok'), { status: 'ok', finishedAt: T0 });
  } finally {
    unfreezeClock();
    db.close();
  }
});

test('runJob records failures and thrown errors without swallowing them', async () => {
  const { db } = setup();
  try {
    freezeClock(T0);
    const failed = await runJob(db, 'demo:fail', () => err<number>('not_found', 'nothing there'));
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.equal(failed.error.kind, 'not_found');

    const thrown = await runJob(db, 'demo:throw', () => {
      throw new Error('kaboom');
    });
    assert.equal(thrown.ok, false);
    if (!thrown.ok) {
      assert.equal(thrown.error.kind, 'internal');
      assert.match(thrown.error.message, /kaboom/);
    }

    assert.equal(lastJobRun(db, 'demo:fail')?.status, 'failed');
    assert.equal(recentJobs(db, 'demo:fail')[0]?.error, 'nothing there');
    assert.equal(lastJobRun(db, 'demo:throw')?.status, 'failed');
    assert.deepEqual(recentJobs(db, 'demo:throw')[0]?.stats, { threw: true });

    assert.equal(recentJobs(db).length, 2);
    assert.equal(lastJobRun(db, 'demo:never'), null);
  } finally {
    unfreezeClock();
    db.close();
  }
});

test('startJob/finishJob leave a running row until closed', () => {
  const { db } = setup();
  try {
    freezeClock(T0);
    const id = startJob(db, 'demo:manual');
    assert.deepEqual(lastJobRun(db, 'demo:manual'), { status: 'running', finishedAt: null });
    finishJob(db, id, 'ok', { touched: 3 });
    const run = recentJobs(db, 'demo:manual')[0];
    assert.equal(run?.status, 'ok');
    assert.deepEqual(run?.stats, { touched: 3 });
  } finally {
    unfreezeClock();
    db.close();
  }
});

// --------------------------------------------------------------------------
// normalizeName
// --------------------------------------------------------------------------

test('normalizeName strips articles, diacritics, punctuation and generic suffixes', () => {
  assert.equal(normalizeName('The Louvre Museum'), 'louvre');
  assert.equal(normalizeName('Musée du Louvre'), 'musee du louvre');
  assert.equal(normalizeName('  LOUVRE   '), 'louvre');
  assert.equal(normalizeName("St. Mark's Basilica"), 'st marks basilica');
  assert.equal(normalizeName('Le Jardin des Plantes'), 'jardin des plantes');
  assert.equal(normalizeName('Central Park'), 'central');
  assert.equal(normalizeName('Park'), 'park', 'a bare generic word survives');
  assert.equal(normalizeName('The'), 'the', 'a bare article survives');
  assert.equal(normalizeName('Museum of Science — Park'), 'museum of science');
  assert.equal(normalizeName('!!!'), '');
  assert.equal(normalizeName('Louvre, Le'), 'louvre');
});

// --------------------------------------------------------------------------
// derived scores
// --------------------------------------------------------------------------

test('touristiness and localFavor stay in 0..1 and are not complements', () => {
  const { db, cityId } = setup();
  try {
    freezeClock(T0);
    const cases: Place[] = [
      mkPlace(db, cityId, { id: 'place:a', name: 'Eiffel', category: 'landmark', rating: 4.7, priceTier: '$$$' }),
      mkPlace(db, cityId, { id: 'place:b', name: 'Buttes', category: 'park', rating: 4.8, priceTier: 'free' }),
      mkPlace(db, cityId, { id: 'place:c', name: 'Local Lib', category: 'library', rating: null, priceTier: 'free' }),
      mkPlace(db, cityId, { id: 'place:d', name: 'Swings', category: 'playground', rating: 3.2, priceTier: 'free' }),
    ];
    let sawNonComplement = false;
    for (const place of cases) {
      for (const count of [1, 12, 400]) {
        const t = deriveTouristiness(place, count);
        const lf = deriveLocalFavor(place, t);
        assert.ok(t >= 0 && t <= 1, `touristiness ${t} out of range`);
        assert.ok(lf >= 0 && lf <= 1, `localFavor ${lf} out of range`);
        if (Math.abs(t + lf - 1) > 0.05) sawNonComplement = true;
      }
    }
    assert.ok(sawNonComplement, 'localFavor must not be 1 - touristiness');

    // A great free city park is both touristy and beloved locally.
    const park = cases[1] as Place;
    const landmark = cases[0] as Place;
    const parkT = deriveTouristiness(park, 400);
    const landmarkT = deriveTouristiness(landmark, 400);
    assert.ok(landmarkT > parkT, 'a landmark out-tourists a park');
    assert.ok(
      deriveLocalFavor(park, parkT) > deriveLocalFavor(landmark, landmarkT),
      'locals favour the park',
    );
    assert.ok(parkT > 0.5 && deriveLocalFavor(park, parkT) > 0.5, 'a place can be both');

    // Bigger city catalogue -> more tourist pressure for the same row.
    assert.ok(deriveTouristiness(park, 400) > deriveTouristiness(park, 2));
  } finally {
    unfreezeClock();
    db.close();
  }
});

// --------------------------------------------------------------------------
// normalizePlaces
// --------------------------------------------------------------------------

test('normalizePlaces merges duplicates and re-points their edges', () => {
  const { db, cityId } = setup();
  try {
    freezeClock(T0);
    // winner has more populated fields; loser sorts earlier by id
    mkPlace(db, cityId, {
      id: 'place:louvre-b', name: 'The Louvre Museum', category: 'museum',
      lat: 48.8606, lon: 2.3376, rating: 4.7, priceTier: '$$',
      description: 'the big one', durationMinutes: 180,
    });
    mkPlace(db, cityId, { id: 'place:louvre-a', name: 'Louvre', category: 'museum' });
    mkPlace(db, cityId, { id: 'place:orsay', name: "Musée d'Orsay", category: 'museum', rating: 4.6 });

    db.run(
      `INSERT INTO topics (id, slug, label, status, support_count, confidence, created_at)
       VALUES ('topic:art', 'art', 'Art', 'core', 0, 0, ?)`, T0,
    );
    for (const placeId of ['place:louvre-a', 'place:louvre-b']) {
      db.run(
        `INSERT INTO place_topics (place_id, topic_id, weight, source) VALUES (?, 'topic:art', 1, 'taxonomy')`,
        placeId,
      );
    }

    upsertUser(db, { id: 'user:meg', displayName: 'Meg' });
    db.run(
      `INSERT INTO user_signals (id, user_id, place_id, kind, rating, context_json, created_at)
       VALUES ('sig:1', 'user:meg', 'place:louvre-a', 'saved', NULL, '{}', ?)`, T0,
    );

    const result = normalizePlaces(db);
    assert.ok(result.ok);
    const stats = result.value;
    assert.equal(stats.scanned, 3);
    assert.equal(stats.deduped, 1);

    const survivors = db.all<{ id: string }>('SELECT id FROM places ORDER BY id').map((r) => r.id);
    assert.deepEqual(survivors, ['place:louvre-b', 'place:orsay']);

    const signal = db.get<{ place_id: string }>('SELECT place_id FROM user_signals WHERE id = ?', 'sig:1');
    assert.equal(signal?.place_id, 'place:louvre-b', 'signal follows the survivor');

    const topics = db.all<{ place_id: string }>('SELECT place_id FROM place_topics');
    assert.equal(topics.length, 1, 'the composite-key edge collapsed instead of colliding');
    assert.equal(topics[0]?.place_id, 'place:louvre-b');

    // every survivor got scores and a real hash
    const rows = db.all<{ touristiness: number; local_favor: number; canonical_hash: string }>(
      'SELECT touristiness, local_favor, canonical_hash FROM places',
    );
    assert.equal(stats.enriched, 2);
    assert.equal(stats.hashed, 2);
    for (const row of rows) {
      assert.ok(Number(row.touristiness) >= 0 && Number(row.touristiness) <= 1);
      assert.ok(Number(row.local_favor) >= 0 && Number(row.local_favor) <= 1);
      assert.notEqual(row.canonical_hash, 'not-a-real-hash');
      assert.equal(row.canonical_hash.length, 64);
    }

    assert.equal(lastJobRun(db, 'travel:normalize')?.status, 'ok');

    // idempotent: a second run finds nothing to do
    const again = normalizePlaces(db);
    assert.ok(again.ok);
    assert.deepEqual(
      { d: again.value.deduped, e: again.value.enriched, h: again.value.hashed },
      { d: 0, e: 0, h: 0 },
    );
  } finally {
    unfreezeClock();
    db.close();
  }
});

test('normalizePlaces links the nearest neighborhood within 3km and skips the rest', () => {
  const { db, cityId } = setup();
  try {
    freezeClock(T0);
    const near = upsertNeighborhood(db, {
      cityId, name: 'Near', lat: 48.8600, lon: 2.3522, localCharacter: 0.5,
    });
    upsertNeighborhood(db, {
      cityId, name: 'Further', lat: 48.8700, lon: 2.3522, localCharacter: 0.5,
    });

    mkPlace(db, cityId, { id: 'place:close', name: 'Close Cafe', category: 'cafe', lat: 48.8566, lon: 2.3522 });
    mkPlace(db, cityId, { id: 'place:far', name: 'Far Cafe', category: 'cafe', lat: 48.9500, lon: 2.3522 });
    mkPlace(db, cityId, { id: 'place:nowhere', name: 'No Coords', category: 'cafe' });

    const result = normalizePlaces(db);
    assert.ok(result.ok);
    assert.equal(result.value.neighborhoodsLinked, 1);

    const close = db.get<{ neighborhood_id: string }>(
      'SELECT neighborhood_id FROM places WHERE id = ?', 'place:close',
    );
    assert.equal(close?.neighborhood_id, near, 'picks the nearer of the two');

    for (const id of ['place:far', 'place:nowhere']) {
      const row = db.get<{ neighborhood_id: string | null }>(
        'SELECT neighborhood_id FROM places WHERE id = ?', id,
      );
      assert.equal(row?.neighborhood_id, null);
    }
    assert.ok(result.value.issues.some((i) => i.includes('3km')));
  } finally {
    unfreezeClock();
    db.close();
  }
});

test('normalizePlaces respects scores that already exist', () => {
  const { db, cityId } = setup();
  try {
    freezeClock(T0);
    mkPlace(db, cityId, {
      id: 'place:known', name: 'Known', category: 'museum', touristiness: 0.42, localFavor: 0.11,
    });
    const result = normalizePlaces(db);
    assert.ok(result.ok);
    assert.equal(result.value.enriched, 0);
    const row = db.get<{ touristiness: number; local_favor: number }>(
      'SELECT touristiness, local_favor FROM places WHERE id = ?', 'place:known',
    );
    assert.equal(Number(row?.touristiness), 0.42);
    assert.equal(Number(row?.local_favor), 0.11);
    assert.equal(nowIso(), T0);
  } finally {
    unfreezeClock();
    db.close();
  }
});

/**
 * Cross-track integration tests.
 *
 * These cover behaviour that only shows up when subsystems are composed, which
 * is exactly where the single-contract discipline can still go wrong even
 * though every track passes its own suite.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../scout/db/index.ts';
import { migrate } from '../../scout/db/migrate.ts';
import { ensureRegions, upsertCountry, upsertCity, upsertUser } from '../../scout/db/repo-core.ts';
import { upsertPlace, getPlace, hasUsableCoordinates } from '../../scout/db/repo-places.ts';
import { upsertSource, recordClaim } from '../../scout/db/repo-truth.ts';
import { registerWatch, getWatch } from '../../scout/radar/watches.ts';
import { scanWatch } from '../../scout/radar/scan.ts';
import { verifyPending } from '../../scout/radar/verify.ts';
import { resolveAll } from '../../scout/intelligence/truth-engine.ts';
import { seedCoreTopics, getTopicBySlug } from '../../scout/intelligence/topic-graph.ts';
import { propagateToSourceRecord } from '../../scout/radar/verify.ts';
import { unwrap, type Transport } from '../../scout/contracts/index.ts';
import { nowIso, freezeClock, unfreezeClock } from '../../scout/runtime/clock.ts';
import { normalizePlaces } from '../../scout/travel/normalize.ts';

const AGGREGATOR = 'source:test-aggregator';
const OFFICIAL = 'source:test-official';
const PLACE = 'place:test-venue';

function seedDb() {
  const db = openDb(':memory:');
  migrate(db);
  ensureRegions(db);
  const country = upsertCountry(db, {
    iso2: 'US', iso3: 'USA', name: 'United States', regionCode: 'NA', currency: 'USD',
  });
  const city = upsertCity(db, {
    name: 'Testville', countryId: country, admin1: 'TS',
    lat: 40, lon: -80, population: 1000, timezone: 'UTC',
  });
  upsertPlace(db, {
    id: PLACE, name: 'Test Venue', cityId: city, neighborhoodId: null,
    lat: 40, lon: -80, locationPrecision: 'venue', category: 'museum', subcategory: null, priceTier: 'free',
    indoorOutdoor: 'indoor', rating: 4.5, minAge: 0, maxAge: 99, durationMinutes: 90,
    touristiness: 0.3, localFavor: 0.8, description: 'A test venue.',
    canonicalHash: null, updatedAt: nowIso(),
  });
  upsertUser(db, { id: 'user:test', displayName: 'Test', homeCityId: city });
  upsertSource(db, {
    id: AGGREGATOR, name: 'Aggregator', sourceClass: 'major_aggregator', authority: 0.8,
    homepage: null, regionScope: [], freshnessTier: 'periodic', enabled: true,
  });
  upsertSource(db, {
    id: OFFICIAL, name: 'Official site', sourceClass: 'official', authority: 0.95,
    homepage: null, regionScope: [], freshnessTier: 'periodic', enabled: true,
  });
  return db;
}

function siteTransport(payload: unknown): Transport {
  return {
    mode: 'fixture',
    async request() {
      return {
        ok: true,
        value: {
          status: 200, headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload), replayed: true, latencyMs: 1,
        },
      };
    },
  };
}

test('a higher-authority source supersedes an older claim rather than being disputed by it', async () => {
  // Regression: the corroboration check used to treat ANY differing claim from
  // another source as a dispute -- including the stale value being replaced.
  // Since every genuine change differs from its predecessor, real updates
  // disputed themselves, took the 0.4 disputed weight, and lost to the value
  // they were meant to supersede.
  const db = seedDb();
  try {
    freezeClock('2026-01-01T00:00:00.000Z');
    recordClaim(db, {
      sourceId: AGGREGATOR, entityType: 'place', entityId: PLACE,
      field: 'price_tier', value: 'free',
    });
    unfreezeClock();

    const watchId = unwrap(registerWatch(db, {
      sourceId: OFFICIAL, entityType: 'place', entityId: PLACE,
      locator: 'https://official.example/venue.json', freshnessTier: 'periodic',
    }));
    const watch = getWatch(db, watchId);
    assert.ok(watch);

    const scan = unwrap(await scanWatch(db, watch, {
      transport: siteTransport({ price_tier: '$$$' }),
    }));
    assert.ok(scan.deltas.length > 0, 'expected a delta for the price change');

    const verified = unwrap(await verifyPending(db, {
      transport: siteTransport({ price_tier: '$$$' }),
    }));
    assert.equal(verified.disputed, 0, 'an older differing claim must not dispute the change');

    unwrap(resolveAll(db));
    assert.equal(getPlace(db, PLACE)?.priceTier, '$$$',
      'the official 0.95 source must win over the aggregator 0.80');
  } finally {
    unfreezeClock();
    db.close();
  }
});

test('a concurrent counter-claim from another source still disputes', async () => {
  const db = seedDb();
  try {
    const watchId = unwrap(registerWatch(db, {
      sourceId: OFFICIAL, entityType: 'place', entityId: PLACE,
      locator: 'https://official.example/venue.json', freshnessTier: 'periodic',
    }));
    const watch = getWatch(db, watchId);
    assert.ok(watch);

    const scan = unwrap(await scanWatch(db, watch, {
      transport: siteTransport({ price_tier: '$$$' }),
    }));
    assert.ok(scan.deltas.length > 0);

    // Another source asserts something different AFTER the change was observed.
    const later = new Date(Date.parse(nowIso()) + 60_000).toISOString();
    recordClaim(db, {
      sourceId: AGGREGATOR, entityType: 'place', entityId: PLACE,
      field: 'price_tier', value: '$', observedAt: later,
    });

    const verified = unwrap(await verifyPending(db, {
      transport: siteTransport({ price_tier: '$$$' }),
    }));
    assert.equal(verified.disputed, 1, 'a contemporaneous counter-claim must dispute');
  } finally {
    db.close();
  }
});

test('Radar records claims but never writes to places itself', async () => {
  const db = seedDb();
  try {
    const watchId = unwrap(registerWatch(db, {
      sourceId: OFFICIAL, entityType: 'place', entityId: PLACE,
      locator: 'https://official.example/venue.json', freshnessTier: 'periodic',
    }));
    const watch = getWatch(db, watchId);
    assert.ok(watch);
    const before = getPlace(db, PLACE);

    unwrap(await scanWatch(db, watch, { transport: siteTransport({ price_tier: '$$$', rating: 3.9 }) }));

    const afterScan = getPlace(db, PLACE);
    assert.equal(afterScan?.priceTier, before?.priceTier, 'Radar must not mutate places');
    assert.equal(afterScan?.rating, before?.rating, 'Radar must not mutate places');

    const claims = db.all<{ n: number }>(
      'SELECT COUNT(*) n FROM source_records WHERE source_id = ? AND entity_id = ?',
      OFFICIAL, PLACE,
    );
    assert.ok((claims[0]?.n ?? 0) > 0, 'Radar must record claims for the Truth Engine');
  } finally {
    db.close();
  }
});

test('topic confidence round-trips exactly instead of shrinking on every read', () => {
  // Regression: topics persisted only the scalar, and the reader rebuilt the
  // object by feeding that final value back in as an AUTHORITY. computeConfidence
  // then re-applied the verification weight, so 0.95 read back as 0.8075 and a
  // human_verified topic silently became unverified.
  const db = seedDb();
  try {
    unwrap(seedCoreTopics(db));
    const slug = db.get<{ slug: string }>('SELECT slug FROM topics LIMIT 1')?.slug;
    assert.ok(slug);

    const stored = db.get<{ confidence: number }>('SELECT confidence FROM topics WHERE slug = ?', slug);
    const topic = getTopicBySlug(db, slug);
    assert.ok(topic);
    assert.ok(Math.abs(topic.confidence.value - (stored?.confidence ?? -1)) < 1e-12,
      'restored confidence must equal what was written');
    assert.equal(topic.confidence.verification, 'human_verified',
      'verification state must survive the round-trip');

    const unpersisted = db.get<{ n: number }>('SELECT COUNT(*) n FROM topics WHERE confidence_json IS NULL');
    assert.equal(unpersisted?.n, 0, 'every topic must persist its full Confidence');
  } finally {
    db.close();
  }
});

test('a delta links to the exact claim it filed, not one that merely hashes the same', async () => {
  // Regression: verification used to re-identify the claim by
  // (source, entity, field, content_hash) with "newest wins", so a decoy row
  // carrying the same value would capture the verification outcome.
  const db = seedDb();
  try {
    const watchId = unwrap(registerWatch(db, {
      sourceId: OFFICIAL, entityType: 'place', entityId: PLACE,
      locator: 'https://official.example/venue.json', freshnessTier: 'periodic',
    }));
    const watch = getWatch(db, watchId);
    assert.ok(watch);

    const scan = unwrap(await scanWatch(db, watch, { transport: siteTransport({ price_tier: '$$$' }) }));
    const delta = scan.deltas.find((d) => d.field === 'price_tier');
    assert.ok(delta, 'expected a price_tier delta');
    assert.ok(delta.sourceRecordId, 'delta must carry the id of the claim it filed');

    const claim = db.get<{ id: string; value_json: string; content_hash: string }>(
      'SELECT id, value_json, content_hash FROM source_records WHERE id = ?', delta.sourceRecordId!,
    );
    assert.ok(claim, 'the linked claim must exist');
    assert.equal(JSON.parse(claim.value_json), '$$$');

    // A newer row from the same source, same field, same value hash: under the
    // old "newest wins" hash lookup this would have absorbed the outcome.
    const later = new Date(Date.parse(nowIso()) + 120_000).toISOString();
    db.run(
      `INSERT INTO source_records (id, source_id, entity_type, entity_id, field, value_json,
         observed_at, content_hash, verification, superseded_by)
       VALUES (?,?,?,?,?,?,?,?,?,NULL)`,
      'sr_decoy', OFFICIAL, 'place', PLACE, 'price_tier', JSON.stringify('$$$'),
      later, claim.content_hash, 'unverified',
    );

    const updated = propagateToSourceRecord(db, delta, OFFICIAL, 'human_verified');
    assert.equal(updated, delta.sourceRecordId, 'must update the linked claim');

    const decoy = db.get<{ verification: string }>('SELECT verification FROM source_records WHERE id = ?', 'sr_decoy');
    assert.equal(decoy?.verification, 'unverified', 'the decoy must be untouched');
    const linked = db.get<{ verification: string }>('SELECT verification FROM source_records WHERE id = ?', delta.sourceRecordId!);
    assert.equal(linked?.verification, 'human_verified');
  } finally {
    db.close();
  }
});

test('a city centroid is never treated as a usable coordinate', () => {
  // 73 of 179 imported places share their city's centroid -- all 10 Chicago
  // places sit on 41.878,-87.63. Checking `lat !== null` would happily use them
  // for "what is nearest" and put every place in one neighbourhood.
  const venue = { lat: 41.8663, lon: -87.6169, locationPrecision: 'venue' as const };
  const centroid = { lat: 41.878, lon: -87.63, locationPrecision: 'city' as const };
  const unknown = { lat: 41.878, lon: -87.63, locationPrecision: null };
  const missing = { lat: null, lon: null, locationPrecision: 'venue' as const };

  assert.equal(hasUsableCoordinates(venue), true);
  assert.equal(hasUsableCoordinates(centroid), false, 'a centroid must be refused');
  assert.equal(hasUsableCoordinates(unknown), false, 'unknown provenance must be refused');
  assert.equal(hasUsableCoordinates(missing), false);
});

test('location precision survives a write/read round-trip', () => {
  const db = seedDb();
  try {
    const base = getPlace(db, PLACE);
    assert.ok(base);
    assert.equal(base.locationPrecision, 'venue');

    upsertPlace(db, { ...base, locationPrecision: 'city' });
    assert.equal(getPlace(db, PLACE)?.locationPrecision, 'city');
    assert.equal(hasUsableCoordinates(getPlace(db, PLACE)!), false);

    upsertPlace(db, { ...base, locationPrecision: null });
    assert.equal(getPlace(db, PLACE)?.locationPrecision, null);
  } finally {
    db.close();
  }
});

test('normalize refuses to link a centroid place and says so', () => {
  const db = seedDb();
  try {
    const base = getPlace(db, PLACE);
    assert.ok(base);
    upsertPlace(db, { ...base, locationPrecision: 'city', neighborhoodId: null });
    db.run(
      `INSERT INTO neighborhoods (id, city_id, name, lat, lon, local_character, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
      'neighborhood:test', base.cityId, 'Testside', 40.001, -80.001, 0.7, nowIso(),
    );

    const stats = unwrap(normalizePlaces(db));
    assert.equal(getPlace(db, PLACE)?.neighborhoodId, null,
      'a centroid place must not be linked to a neighbourhood');
    assert.ok(stats.issues.some((i) => i.includes('city centroid')),
      `expected a centroid warning, got: ${JSON.stringify(stats.issues)}`);

    // The same place at venue precision links normally.
    upsertPlace(db, { ...base, locationPrecision: 'venue', neighborhoodId: null });
    unwrap(normalizePlaces(db));
    assert.equal(getPlace(db, PLACE)?.neighborhoodId, 'neighborhood:test');
  } finally {
    db.close();
  }
});

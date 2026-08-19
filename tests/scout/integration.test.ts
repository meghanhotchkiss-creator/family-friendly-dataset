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
import { upsertPlace, getPlace } from '../../scout/db/repo-places.ts';
import { upsertSource, recordClaim } from '../../scout/db/repo-truth.ts';
import { registerWatch, getWatch } from '../../scout/radar/watches.ts';
import { scanWatch } from '../../scout/radar/scan.ts';
import { verifyPending } from '../../scout/radar/verify.ts';
import { resolveAll } from '../../scout/intelligence/truth-engine.ts';
import { unwrap, type Transport } from '../../scout/contracts/index.ts';
import { nowIso, freezeClock, unfreezeClock } from '../../scout/runtime/clock.ts';

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
    lat: 40, lon: -80, category: 'museum', subcategory: null, priceTier: 'free',
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

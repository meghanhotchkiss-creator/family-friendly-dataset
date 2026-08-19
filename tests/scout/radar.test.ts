/**
 * Track C (Radar) tests: watch graph, conditional fetch, semantic deltas,
 * verification and the health criteria.
 *
 * Everything runs against an in-memory database with a hand-rolled Transport,
 * so the 304 path, the hash path and the diff path are all exercised for real.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../../scout/db/index.ts';
import type { Db } from '../../scout/db/index.ts';
import { migrate } from '../../scout/db/migrate.ts';
import { ensureRegions, upsertCity, upsertCountry } from '../../scout/db/repo-core.ts';
import { getPlace, upsertPlace } from '../../scout/db/repo-places.ts';
import { recordClaim, upsertSource } from '../../scout/db/repo-truth.ts';
import type { Transport, TransportRequest, TransportResponse } from '../../scout/contracts/index.ts';
import { ok, unwrap } from '../../scout/contracts/index.ts';
import { freezeClock, unfreezeClock, nowIso } from '../../scout/runtime/clock.ts';
import { sha256 } from '../../scout/runtime/hash.ts';

import {
  classifyDelta,
  diffEntities,
  normalizedEditDistance,
  semanticDistance,
} from '../../scout/radar/delta.ts';
import {
  dueWatches,
  getWatch,
  listWatches,
  registerWatch,
  setWatchEnabled,
  watchIdFor,
} from '../../scout/radar/watches.ts';
import { recentScans, scanDue, scanWatch } from '../../scout/radar/scan.ts';
import { listVerifications, pendingDeltas, verifyDelta } from '../../scout/radar/verify.ts';
import { collectHealth, healthVerdict, type RadarHealth } from '../../scout/cli/radar-health.ts';

const T0 = '2026-03-01T12:00:00.000Z';
const LOCATOR = 'https://example.test/places/exploratorium.json';

interface StubTransport extends Transport {
  calls: TransportRequest[];
}

interface StubReply {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

/** Transport is a two-field interface, so a stub needs no fixture files. */
function stubTransport(handler: (req: TransportRequest, call: number) => StubReply): StubTransport {
  const calls: TransportRequest[] = [];
  return {
    mode: 'fixture',
    calls,
    async request(req: TransportRequest) {
      const reply = handler(req, calls.length);
      calls.push(req);
      const response: TransportResponse = {
        status: reply.status,
        headers: reply.headers ?? {},
        body: reply.body ?? '',
        replayed: true,
        latencyMs: 1,
      };
      return ok(response);
    },
  };
}

function always(reply: StubReply): StubTransport {
  return stubTransport(() => reply);
}

interface Fixture {
  db: Db;
  placeId: string;
  sourceA: string;
  sourceB: string;
  watchId: string;
}

const BASE_PLACE = {
  name: 'The Exploratorium',
  category: 'museum' as const,
  priceTier: '$$' as const,
  indoorOutdoor: 'indoor' as const,
  rating: 4.5,
  minAge: 2,
  maxAge: 14,
  durationMinutes: 180,
  touristiness: 0.6,
  localFavor: 0.5,
  description: 'Hands-on science museum on the Embarcadero.',
};

function setup(): Fixture {
  const db = openDb(':memory:');
  migrate(db);
  ensureRegions(db);
  const countryId = upsertCountry(db, {
    iso2: 'US', iso3: 'USA', name: 'United States', regionCode: 'NA', currency: 'USD',
  });
  const cityId = upsertCity(db, {
    name: 'San Francisco', countryId, admin1: 'CA',
    lat: 37.7749, lon: -122.4194, population: 815_000, timezone: 'America/Los_Angeles',
  });
  const placeId = upsertPlace(db, {
    id: 'place:sf-exploratorium',
    cityId,
    neighborhoodId: null,
    lat: 37.8017,
    locationPrecision: 'venue',
    lon: -122.3973,
    subcategory: null,
    canonicalHash: null,
    updatedAt: T0,
    ...BASE_PLACE,
  });
  const sourceA = upsertSource(db, {
    id: 'source:exploratorium-official', name: 'Exploratorium official site',
    sourceClass: 'official', authority: 0.95, homepage: null, regionScope: [],
    freshnessTier: 'periodic', enabled: true,
  });
  const sourceB = upsertSource(db, {
    id: 'source:city-open-data', name: 'City open data', sourceClass: 'open_dataset',
    authority: 0.7, homepage: null, regionScope: [], freshnessTier: 'periodic', enabled: true,
  });
  const watchId = unwrap(
    registerWatch(db, {
      sourceId: sourceA, entityType: 'place', entityId: placeId,
      locator: LOCATOR, freshnessTier: 'periodic',
    }),
  );
  return { db, placeId, sourceA, sourceB, watchId };
}

function watchOf(f: Fixture) {
  const watch = getWatch(f.db, f.watchId);
  assert.ok(watch, 'watch should exist');
  return watch;
}

// ---------------------------------------------------------------- edit distance

test('normalizedEditDistance matches known Levenshtein values', () => {
  assert.equal(normalizedEditDistance('kitten', 'sitting'), 3 / 7);
  assert.equal(normalizedEditDistance('', ''), 0);
  assert.equal(normalizedEditDistance('abc', 'abc'), 0);
  assert.equal(normalizedEditDistance('abc', ''), 1);
  assert.equal(normalizedEditDistance('flaw', 'lawn'), 2 / 4);
  // Order must not matter, and the longer side must be the denominator.
  assert.equal(normalizedEditDistance('sitting', 'kitten'), 3 / 7);
});

test('semanticDistance ignores case, whitespace and punctuation', () => {
  assert.equal(semanticDistance('The Exploratorium ', 'the exploratorium'), 0);
  assert.equal(semanticDistance('Cafe, The', 'cafe the'), 0);
  assert.ok(semanticDistance('museum', 'market') > 0);
});

test('semanticDistance scores numbers relatively and type changes maximally', () => {
  assert.equal(semanticDistance(4.5, 4.5), 0);
  assert.ok(semanticDistance(4.5, 4.6) < 0.05);
  assert.equal(semanticDistance(2, 4), 0.5);
  assert.equal(semanticDistance(true, false), 1);
  assert.equal(semanticDistance(null, null), 0);
  assert.equal(semanticDistance(null, 'x'), 1);
  assert.equal(semanticDistance(5, '5'), 1);
  // Objects compare through canonicalJson, so key order is not a change.
  assert.equal(semanticDistance({ a: 1, b: 2 }, { b: 2, a: 1 }), 0);
});

// ---------------------------------------------------------------- classification

test('punctuation-only values are not laundered into a score of 0', () => {
  // Stripping symbols would empty both sides; a price tier IS its punctuation.
  assert.ok(semanticDistance('$$', '$$$') > 0);
  assert.equal(classifyDelta('price_tier', '$$', '$$$').kind, 'structural');
  assert.equal(semanticDistance('$$', ' $$ '), 0, 'whitespace is still cosmetic');
});

test('a whitespace/case-only change is cosmetic even on a structural field', () => {
  const { semanticScore, kind } = classifyDelta('name', 'The Exploratorium ', 'the exploratorium');
  assert.equal(semanticScore, 0);
  assert.equal(kind, 'cosmetic');
});

test('category museum -> market is structural despite similar strings', () => {
  const { semanticScore, kind } = classifyDelta('category', 'museum', 'market');
  assert.ok(semanticScore < 1, 'the strings really are close');
  assert.equal(kind, 'structural');
});

test('a structural field is structural for any non-zero distance', () => {
  // lat moving by a hair is a tiny number distance but still structural.
  const tiny = classifyDelta('lat', 37.8017, 37.8018);
  assert.ok(tiny.semanticScore > 0 && tiny.semanticScore < 0.001);
  assert.equal(tiny.kind, 'structural');
});

test('numeric fields land on either side of the thresholds', () => {
  const nudge = classifyDelta('rating', 4.5, 4.6); // ~0.02 -> below material
  assert.equal(nudge.kind, 'cosmetic');
  const drop = classifyDelta('rating', 4.5, 2.0); // ~0.56 -> material
  assert.equal(drop.kind, 'material');
  const collapse = classifyDelta('rating', 4.5, 0.5); // ~0.89 -> structural by score
  assert.equal(collapse.kind, 'structural');
});

test('diffEntities only reports fields the new payload mentions', () => {
  const diffs = diffEntities(
    { name: 'A', rating: 4.5, category: 'museum' },
    { rating: 2.0 },
  );
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0]?.field, 'rating');
  assert.equal(diffs[0]?.kind, 'material');
});

// ---------------------------------------------------------------- watch graph

test('registerWatch is idempotent and derives its id from the triple', () => {
  const f = setup();
  const again = unwrap(
    registerWatch(f.db, {
      sourceId: f.sourceA, entityType: 'place', entityId: f.placeId,
      locator: LOCATOR, freshnessTier: 'periodic',
    }),
  );
  assert.equal(again, f.watchId);
  assert.equal(f.watchId, watchIdFor(f.sourceA, f.placeId, LOCATOR));
  assert.equal(listWatches(f.db).length, 1);
  // periodic tier default cadence comes from the freshness policy
  assert.equal(watchOf(f).checkIntervalMinutes, 12 * 60);
  f.db.close();
});

test('registerWatch rejects unknown sources and bad input', () => {
  const f = setup();
  const missing = registerWatch(f.db, {
    sourceId: 'source:nope', entityType: 'place', entityId: f.placeId,
    locator: LOCATOR, freshnessTier: 'periodic',
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.kind, 'not_found');

  const blank = registerWatch(f.db, {
    sourceId: f.sourceA, entityType: 'place', entityId: f.placeId,
    locator: '   ', freshnessTier: 'periodic',
  });
  assert.equal(blank.ok, false);
  f.db.close();
});

test('dueWatches respects the check interval', async (t) => {
  const f = setup();
  t.after(() => {
    unfreezeClock();
    f.db.close();
  });
  freezeClock(T0);

  // Never checked -> due immediately.
  assert.equal(dueWatches(f.db).length, 1);

  await scanWatch(f.db, watchOf(f), { transport: always({ status: 304 }) });
  assert.equal(watchOf(f).lastCheckedAt, T0);
  assert.equal(dueWatches(f.db).length, 0, 'just checked, not due again');

  const almost = new Date(Date.parse(T0) + (12 * 60 - 1) * 60_000).toISOString();
  assert.equal(dueWatches(f.db, almost).length, 0);
  const past = new Date(Date.parse(T0) + 12 * 60 * 60_000).toISOString();
  assert.equal(dueWatches(f.db, past).length, 1);

  setWatchEnabled(f.db, f.watchId, false);
  assert.equal(dueWatches(f.db, past).length, 0, 'disabled watches are never due');
});

// ---------------------------------------------------------------- conditional fetch

test('304 yields unchanged + conditionalHit and creates no deltas', async (t) => {
  const f = setup();
  t.after(() => {
    unfreezeClock();
    f.db.close();
  });
  freezeClock(T0);

  const body = JSON.stringify({ name: 'The Exploratorium', rating: 4.5 });
  const first = stubTransport(() => ({
    status: 200,
    body,
    headers: { ETag: 'W/"v1"', 'Last-Modified': 'Sun, 01 Mar 2026 11:00:00 GMT' },
  }));
  unwrap(await scanWatch(f.db, watchOf(f), { transport: first }));
  assert.equal(watchOf(f).etag, 'W/"v1"');

  const conditional = always({ status: 304 });
  const outcome = unwrap(await scanWatch(f.db, watchOf(f), { transport: conditional }));

  assert.equal(outcome.scan.status, 'unchanged');
  assert.equal(outcome.scan.conditionalHit, true);
  assert.equal(outcome.scan.httpStatus, 304);
  assert.equal(outcome.scan.bytes, 0);
  assert.equal(outcome.deltas.length, 0);
  assert.equal(
    f.db.all('SELECT * FROM radar_deltas').length,
    0,
    'a 304 must never produce a delta row',
  );

  // The validators the previous scan learned were actually sent.
  const sent = conditional.calls[0];
  assert.equal(sent?.headers?.['if-none-match'], 'W/"v1"');
  assert.equal(sent?.headers?.['if-modified-since'], 'Sun, 01 Mar 2026 11:00:00 GMT');
  // And they survive the 304 rather than being cleared.
  assert.equal(watchOf(f).etag, 'W/"v1"');
  assert.equal(watchOf(f).lastHash, sha256(body));
});

test('an identical body is unchanged without a conditional hit', async (t) => {
  const f = setup();
  t.after(() => {
    unfreezeClock();
    f.db.close();
  });
  freezeClock(T0);

  const body = JSON.stringify({ name: 'The Exploratorium', rating: 4.5 });
  const transport = always({ status: 200, body });

  const first = unwrap(await scanWatch(f.db, watchOf(f), { transport }));
  assert.equal(first.scan.hash, sha256(body));

  const second = unwrap(await scanWatch(f.db, watchOf(f), { transport }));
  assert.equal(second.scan.status, 'unchanged');
  assert.equal(second.scan.conditionalHit, false);
  assert.equal(second.scan.httpStatus, 200);
  assert.equal(second.deltas.length, 0);
});

test('a non-2xx response is an error and does not clobber last_hash', async (t) => {
  const f = setup();
  t.after(() => {
    unfreezeClock();
    f.db.close();
  });
  freezeClock(T0);

  const body = JSON.stringify({ rating: 4.5 });
  unwrap(await scanWatch(f.db, watchOf(f), { transport: always({ status: 200, body }) }));
  const hash = watchOf(f).lastHash;

  const outcome = unwrap(
    await scanWatch(f.db, watchOf(f), { transport: always({ status: 503, body: 'nope' }) }),
  );
  assert.equal(outcome.scan.status, 'error');
  assert.equal(outcome.scan.httpStatus, 503);
  assert.match(String(outcome.scan.error), /503/);
  assert.equal(watchOf(f).lastHash, hash, 'a failed scan must not rewrite the known-good hash');
});

// ---------------------------------------------------------------- change detection

test('a changed body writes deltas and a source claim, never a places row', async (t) => {
  const f = setup();
  t.after(() => {
    unfreezeClock();
    f.db.close();
  });
  freezeClock(T0);

  unwrap(
    await scanWatch(f.db, watchOf(f), {
      transport: always({ status: 200, body: JSON.stringify({ rating: 4.5 }) }),
    }),
  );

  const outcome = unwrap(
    await scanWatch(f.db, watchOf(f), {
      // camelCase and snake_case keys must map onto the same canonical fields.
      transport: always({
        status: 200,
        body: JSON.stringify({ rating: 2.0, priceTier: '$$$', duration_minutes: 90 }),
      }),
    }),
  );

  assert.equal(outcome.scan.status, 'changed');
  assert.equal(outcome.scan.conditionalHit, false);
  const byField = new Map(outcome.deltas.map((d) => [d.field, d]));
  assert.equal(byField.get('rating')?.kind, 'material');
  assert.equal(byField.get('price_tier')?.kind, 'structural');
  assert.equal(byField.get('duration_minutes')?.kind, 'material');
  assert.equal(byField.get('rating')?.oldValue, 4.5);
  assert.equal(byField.get('rating')?.newValue, 2);

  // Radar detects; the Truth Engine decides. The place row is untouched.
  const place = getPlace(f.db, f.placeId);
  assert.equal(place?.rating, 4.5);
  assert.equal(place?.priceTier, '$$');
  assert.equal(place?.updatedAt, T0);

  const claims = f.db.all<Record<string, unknown>>(
    'SELECT * FROM source_records WHERE entity_id = ? ORDER BY field',
    f.placeId,
  );
  assert.equal(claims.length, 3, 'one claim per actionable delta');
  for (const claim of claims) {
    assert.equal(claim.source_id, f.sourceA);
    assert.equal(claim.verification, 'unverified');
  }
  assert.deepEqual(
    claims.map((c) => c.field).sort(),
    ['duration_minutes', 'price_tier', 'rating'],
  );

  const persisted = f.db.all('SELECT * FROM radar_deltas');
  assert.equal(persisted.length, 3);
});

test('a whitespace/case-only change updates the hash but writes no delta', async (t) => {
  const f = setup();
  t.after(() => {
    unfreezeClock();
    f.db.close();
  });
  freezeClock(T0);

  const original = JSON.stringify({ name: 'The Exploratorium' });
  unwrap(await scanWatch(f.db, watchOf(f), { transport: always({ status: 200, body: original }) }));

  const reformatted = JSON.stringify({ name: '  the exploratorium!  ' });
  const outcome = unwrap(
    await scanWatch(f.db, watchOf(f), { transport: always({ status: 200, body: reformatted }) }),
  );

  assert.equal(outcome.scan.status, 'changed', 'the bytes did change');
  assert.equal(outcome.deltas.length, 0, 'but the meaning did not');
  assert.equal(f.db.all('SELECT * FROM radar_deltas').length, 0);
  assert.equal(f.db.all('SELECT * FROM source_records').length, 0, 'no cosmetic claims');
  assert.equal(watchOf(f).lastHash, sha256(reformatted), 'hash still advances');
});

test('a category flip is recorded as a structural delta', async (t) => {
  const f = setup();
  t.after(() => {
    unfreezeClock();
    f.db.close();
  });
  freezeClock(T0);

  const outcome = unwrap(
    await scanWatch(f.db, watchOf(f), {
      transport: always({ status: 200, body: JSON.stringify({ category: 'market' }) }),
    }),
  );
  assert.equal(outcome.deltas.length, 1);
  assert.equal(outcome.deltas[0]?.field, 'category');
  assert.equal(outcome.deltas[0]?.kind, 'structural');
  assert.equal(getPlace(f.db, f.placeId)?.category, 'museum');
});

test('scanDue scans the due batch, honours --limit and records scans', async (t) => {
  const f = setup();
  t.after(() => {
    unfreezeClock();
    f.db.close();
  });
  freezeClock(T0);

  unwrap(
    registerWatch(f.db, {
      sourceId: f.sourceB, entityType: 'place', entityId: f.placeId,
      locator: 'https://example.test/open-data/exploratorium.json', freshnessTier: 'live',
    }),
  );

  const limited = unwrap(
    await scanDue(f.db, { transport: always({ status: 200, body: '{"rating": 4.5}' }), limit: 1 }),
  );
  assert.equal(limited.scanned, 1);

  const rest = unwrap(
    await scanDue(f.db, { transport: always({ status: 200, body: '{"rating": 4.5}' }) }),
  );
  assert.equal(rest.scanned, 1, 'the already-scanned watch is no longer due');
  assert.equal(recentScans(f.db).length, 2);
});

test('a disabled watch scans as skipped', async (t) => {
  const f = setup();
  t.after(() => {
    unfreezeClock();
    f.db.close();
  });
  freezeClock(T0);
  setWatchEnabled(f.db, f.watchId, false);
  const watch = watchOf(f);
  const outcome = unwrap(await scanWatch(f.db, watch, { transport: always({ status: 200, body: '{}' }) }));
  assert.equal(outcome.scan.status, 'skipped');
});

// ---------------------------------------------------------------- verification

async function seedRatingDelta(f: Fixture): Promise<string> {
  unwrap(
    await scanWatch(f.db, watchOf(f), {
      transport: always({ status: 200, body: JSON.stringify({ rating: 2.0 }) }),
    }),
  );
  const pending = pendingDeltas(f.db);
  assert.equal(pending.length, 1);
  return pending[0]!.id;
}

test('a corroborating independent claim auto-verifies the delta', async (t) => {
  const f = setup();
  t.after(() => {
    unfreezeClock();
    f.db.close();
  });
  freezeClock(T0);

  const deltaId = await seedRatingDelta(f);
  recordClaim(f.db, {
    sourceId: f.sourceB, entityType: 'place', entityId: f.placeId, field: 'rating', value: 2.0,
  });

  const verification = unwrap(await verifyDelta(f.db, deltaId));
  assert.equal(verification.method, 'corroboration');
  assert.equal(verification.outcome, 'auto_verified');

  const stored = f.db.get<{ verification: string }>(
    'SELECT verification FROM radar_deltas WHERE id = ?',
    deltaId,
  );
  assert.equal(stored?.verification, 'auto_verified');
  assert.equal(listVerifications(f.db, deltaId).length, 1);

  // The outcome reaches the claim Radar filed, which is what the Truth Engine reads.
  const claim = f.db.get<{ verification: string }>(
    `SELECT verification FROM source_records
     WHERE source_id = ? AND entity_id = ? AND field = 'rating'`,
    f.sourceA, f.placeId,
  );
  assert.equal(claim?.verification, 'auto_verified');
  assert.equal(pendingDeltas(f.db).length, 0);
});

test('a contradicting independent claim disputes the delta', async (t) => {
  const f = setup();
  t.after(() => {
    unfreezeClock();
    f.db.close();
  });
  freezeClock(T0);

  const deltaId = await seedRatingDelta(f);
  recordClaim(f.db, {
    sourceId: f.sourceB, entityType: 'place', entityId: f.placeId, field: 'rating', value: 4.9,
  });

  const verification = unwrap(await verifyDelta(f.db, deltaId));
  assert.equal(verification.method, 'corroboration');
  assert.equal(verification.outcome, 'disputed');

  const claim = f.db.get<{ verification: string }>(
    `SELECT verification FROM source_records
     WHERE source_id = ? AND entity_id = ? AND field = 'rating'`,
    f.sourceA, f.placeId,
  );
  assert.equal(claim?.verification, 'disputed');
});

test('with no other source, a refetch confirms or rejects the change', async (t) => {
  const f = setup();
  t.after(() => {
    unfreezeClock();
    f.db.close();
  });
  freezeClock(T0);

  const confirmed = await seedRatingDelta(f);
  const stillThere = unwrap(
    await verifyDelta(f.db, confirmed, {
      transport: always({ status: 200, body: JSON.stringify({ rating: 2.0 }) }),
    }),
  );
  assert.equal(stillThere.method, 'refetch');
  assert.equal(stillThere.outcome, 'auto_verified');

  const g = setup();
  t.after(() => g.db.close());
  const blip = await seedRatingDelta(g);
  const reverted = unwrap(
    await verifyDelta(g.db, blip, {
      transport: always({ status: 200, body: JSON.stringify({ rating: 4.5 }) }),
    }),
  );
  assert.equal(reverted.method, 'refetch');
  assert.equal(reverted.outcome, 'rejected');
});

test('an unsupported structural change stays unverified for a human', async (t) => {
  const f = setup();
  t.after(() => {
    unfreezeClock();
    f.db.close();
  });
  freezeClock(T0);

  unwrap(
    await scanWatch(f.db, watchOf(f), {
      transport: always({ status: 200, body: JSON.stringify({ category: 'market' }) }),
    }),
  );
  const deltaId = pendingDeltas(f.db)[0]!.id;
  // Refetch cannot help either: the origin no longer mentions the field.
  const verification = unwrap(
    await verifyDelta(f.db, deltaId, { transport: always({ status: 200, body: '{}' }) }),
  );
  assert.equal(verification.method, 'heuristic');
  assert.equal(verification.outcome, 'unverified');
});

test('verifyDelta reports an unknown delta rather than throwing', async () => {
  const f = setup();
  const result = await verifyDelta(f.db, 'rd_missing');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, 'not_found');
  f.db.close();
});

// ---------------------------------------------------------------- health

test('healthVerdict fails on a high error rate and passes on a clean run', () => {
  const base: RadarHealth = {
    now: T0,
    watches: { total: 3, enabled: 3, due: 0 },
    scans24h: { total: 8, changed: 1, unchanged: 5, error: 2, skipped: 0 },
    errorRate: 2 / 8,
    conditionalHits: 5,
    conditionalHitRate: 5 / 8,
    deltasByKind: { cosmetic: 0, material: 2, structural: 1 },
    pendingVerifications: 1,
    oldestOverdue: null,
  };
  assert.equal(healthVerdict(base).healthy, true, '25% is the limit, not past it');

  const noisy: RadarHealth = { ...base, scans24h: { ...base.scans24h, error: 5 }, errorRate: 5 / 8 };
  const verdict = healthVerdict(noisy);
  assert.equal(verdict.healthy, false);
  assert.match(verdict.reasons.join(' '), /error rate/);

  // Too few scans to judge a rate: one failure out of two is not a verdict.
  const quiet: RadarHealth = {
    ...base,
    scans24h: { total: 2, changed: 0, unchanged: 1, error: 1, skipped: 0 },
    errorRate: 0.5,
  };
  assert.equal(healthVerdict(quiet).healthy, true);

  const stale: RadarHealth = {
    ...base,
    oldestOverdue: { watchId: 'w_x', entityId: 'place:x', overdueMinutes: 3000 },
  };
  assert.equal(healthVerdict(stale).healthy, false);
});

test('collectHealth summarises the real tables', async (t) => {
  const f = setup();
  t.after(() => {
    unfreezeClock();
    f.db.close();
  });
  freezeClock(T0);

  unwrap(
    await scanWatch(f.db, watchOf(f), {
      transport: always({ status: 200, body: JSON.stringify({ rating: 2.0 }) }),
    }),
  );
  unwrap(await scanWatch(f.db, watchOf(f), { transport: always({ status: 304 }) }));

  const health = collectHealth(f.db, nowIso());
  assert.equal(health.watches.total, 1);
  assert.equal(health.watches.enabled, 1);
  assert.equal(health.scans24h.total, 2);
  assert.equal(health.scans24h.changed, 1);
  assert.equal(health.scans24h.unchanged, 1);
  assert.equal(health.conditionalHits, 1);
  assert.equal(health.conditionalHitRate, 0.5);
  assert.equal(health.deltasByKind.material, 1);
  assert.equal(health.pendingVerifications, 1);
  assert.equal(health.oldestOverdue, null, 'just checked, nothing is late');
  assert.equal(healthVerdict(health).healthy, true);
});

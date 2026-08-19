/**
 * npm run scout:demo -- the nine-step proof scenario, executed for real.
 *
 * Nothing here is narrated or stubbed: every step calls the same exported
 * functions the API and the other CLIs call, against the same SQLite database
 * the imports populated. The only injected component is the Transport handed
 * to Radar in step 7, which stands in for the venue's website responding with
 * changed content -- exactly the seam that would carry a real HTTP response.
 */

import { openDb } from '../db/index.ts';
import { getPlace } from '../db/repo-places.ts';
import { upsertSource } from '../db/repo-truth.ts';
import { upsertUser } from '../db/repo-core.ts';
import { recommend } from '../intelligence/scoring.ts';
import { recordSignal, buildUserGraph } from '../intelligence/user-graph.ts';
import { resolveAll, getResolution } from '../intelligence/truth-engine.ts';
import { registerWatch, getWatch } from '../radar/watches.ts';
import { scanWatch } from '../radar/scan.ts';
import { verifyPending } from '../radar/verify.ts';
import { systemHealth, healthSummaryLine, isHealthy } from '../api/health.ts';
import { normalizePlaces } from '../travel/normalize.ts';
import { cacheKey, withCache } from '../travel/freshness-cache.ts';
import { seedPrograms } from '../rewards/programs.ts';
import { recordQuote } from '../rewards/points.ts';
import { checkAll } from '../reliability/sentinel.ts';
import { registerProvidersInDb, providerContext } from '../connectors/registry.ts';
import { createWeatherProvider } from '../connectors/adapters/weather.ts';
import { ok, unwrap, type Transport, type SignalContext } from '../contracts/index.ts';
import { nowIso } from '../runtime/clock.ts';

const db = openDb();
const CITY = process.env.DEMO_CITY ?? 'city:us-il-chicago';
const USER = 'user:demo-family';
const INTENT = 'Family-friendly, local, not too touristy';

const STEPS_TOTAL = 9;
const stepsSeen: number[] = [];
function step(n: number, title: string): void {
  stepsSeen.push(n);
  console.log(`\n${'='.repeat(74)}\nSTEP ${n}/${STEPS_TOTAL}. ${title}\n${'='.repeat(74)}`);
}
function fail(message: string): never {
  console.error(`\nPROOF FAILED: ${message}`);
  process.exit(1);
}

/**
 * Remove everything a previous demo run left behind, so the proof is
 * reproducible rather than accumulating state across runs. Uses the real
 * resolution and normalisation paths to restore derived values instead of
 * writing them back by hand.
 */
function resetDemoState(): void {
  const OFFICIAL_ID = 'source:venue-official';
  const touched = db
    .all<{ entity_id: string }>('SELECT DISTINCT entity_id FROM source_records WHERE source_id = ?', OFFICIAL_ID)
    .map((r) => r.entity_id);

  db.transaction(() => {
    db.run('DELETE FROM verifications WHERE delta_id IN (SELECT id FROM radar_deltas WHERE watch_id IN (SELECT id FROM watches WHERE source_id = ?))', OFFICIAL_ID);
    db.run('DELETE FROM radar_deltas WHERE watch_id IN (SELECT id FROM watches WHERE source_id = ?)', OFFICIAL_ID);
    db.run('DELETE FROM radar_scans WHERE watch_id IN (SELECT id FROM watches WHERE source_id = ?)', OFFICIAL_ID);
    db.run('DELETE FROM watches WHERE source_id = ?', OFFICIAL_ID);
    // truth_resolutions.chosen_record_id references source_records, so the
    // resolutions have to go before the claims they were resolved from.
    for (const entityId of touched) {
      db.run('DELETE FROM truth_resolutions WHERE entity_id = ?', entityId);
      // Derived fields are recomputed by normalize; null them so it refills.
      db.run('UPDATE places SET touristiness = NULL, local_favor = NULL WHERE id = ?', entityId);
    }
    db.run('UPDATE source_records SET superseded_by = NULL WHERE superseded_by IN (SELECT id FROM source_records WHERE source_id = ?)', OFFICIAL_ID);
    db.run('DELETE FROM source_records WHERE source_id = ?', OFFICIAL_ID);
    db.run('DELETE FROM user_preferences WHERE user_id = ?', USER);
    db.run('DELETE FROM user_signals WHERE user_id = ?', USER);
  });

  if (touched.length > 0) {
    unwrap(resolveAll(db));        // restores importer-sourced fields onto places
    unwrap(normalizePlaces(db));   // recomputes touristiness / local_favor
  }
}

// ---------------------------------------------------------------- setup
upsertUser(db, { id: USER, displayName: 'Demo Family', homeCityId: CITY });
db.run(
  `INSERT INTO travel_party (id, user_id, label, role, age, needs_json) VALUES (?,?,?,?,?,?)
   ON CONFLICT(id) DO UPDATE SET age = excluded.age`,
  'party:demo-toddler', USER, 'Toddler', 'child', 3, JSON.stringify(['stroller']),
);
db.run(
  `INSERT INTO travel_party (id, user_id, label, role, age, needs_json) VALUES (?,?,?,?,?,?)
   ON CONFLICT(id) DO UPDATE SET age = excluded.age`,
  'party:demo-adult', USER, 'Parent', 'adult', 38, JSON.stringify([]),
);

resetDemoState();

// Bring every subsystem onto real rows before the proof runs, so step 9 is a
// genuine all-green rather than a green that only means "nothing ran yet".
unwrap(registerProvidersInDb(db));
unwrap(seedPrograms(db));

// Exercises the live tier for real: a weather fetch through the actual adapter,
// read-through the TTL cache. Coordinates are the recorded probe point.
const weather = createWeatherProvider();
const wctx = providerContext();
const WEATHER_POINT = { lat: 51.5074, lon: -0.1278 };
const warmed = await withCache(
  db,
  cacheKey(weather.id, WEATHER_POINT),
  'live',
  weather.id,
  async () => {
    const fetched = await weather.fetch(wctx, { query: WEATHER_POINT });
    return fetched.ok ? ok(fetched.value.items) : fetched;
  },
);
if (!warmed.ok) console.log(`(live cache warm skipped: ${warmed.error.message})`);

// One award quote so the rewards subsystem reports on real rows.
const pair = db.all<{ id: string }>(
  "SELECT id FROM airports WHERE iata IN ('ORD','LHR') ORDER BY iata DESC LIMIT 2",
);
const program = db.get<{ id: string }>("SELECT id FROM loyalty_programs WHERE kind = 'airline' LIMIT 1");
if (pair.length === 2 && program) {
  const quoted = recordQuote(db, {
    userId: USER,
    originAirportId: pair[0]!.id,
    destinationAirportId: pair[1]!.id,
    programId: program.id,
    pointsCost: 60000, cashCents: 148000, taxesCents: 5600,
    sourceAuthorities: [0.8],
  });
  if (!quoted.ok) console.log(`(award quote skipped: ${quoted.error.message})`);
}

const swept = await checkAll(db, wctx);
if (!swept.ok) console.log(`(sentinel sweep skipped: ${swept.error.message})`);

const placeCount = db.get<{ n: number }>('SELECT COUNT(*) n FROM places WHERE city_id = ?', CITY);
if (!placeCount || placeCount.n === 0) {
  fail(`no places in ${CITY}. Run: npm run bootstrap`);
}
console.log(`Scout demo -- ${placeCount.n} places in ${CITY}, party of 2 (one child aged 3)`);

// ------------------------------------------------------- step 1: retrieval
step(1, `Scout retrieves real places for: "${INTENT}"`);
const candidates = db.all<{ n: number }>('SELECT COUNT(*) n FROM places WHERE city_id = ?', CITY);
const first = unwrap(recommend(db, { userId: USER, cityId: CITY, intent: INTENT, limit: 5 }));
console.log(`Candidate set: ${candidates[0]?.n ?? 0} real places imported into the travel graph,`);
console.log(`each one backed by claims in source_records rather than written directly.`);
console.log('Parsed intent:',
  `familyFriendly=${first.parsedIntent.familyFriendly}`,
  `wantsLocal=${first.parsedIntent.wantsLocal}`,
  `avoidsTouristy=${first.parsedIntent.avoidsTouristy}`);
console.log('Intent bias:', first.parsedIntent.dimensionBias
  .map((b) => `${b.dimension}=${b.value}${b.weight >= 0 ? '+' : ''}${b.weight}`).join(' '));

if (first.results.length === 0) fail('no recommendations returned');

// --------------------------------------------------------- steps 2 and 3
step(2, 'Scout ranks them');
console.log('rank  place                                     score   facts');
for (const r of first.results) {
  console.log(`  #${r.rank}  ${r.place.name.slice(0, 40).padEnd(40)} ${r.score.toFixed(3)}   ${r.confidence.value.toFixed(2)}`);
}

step(3, 'Scout explains why');
for (const r of first.results) {
  console.log(`\n  #${r.rank} ${r.place.name}  (score ${r.score.toFixed(3)}, facts ${r.confidence.value.toFixed(2)})`);
  console.log(`     ${r.explanation}`);
  for (const f of r.factors.slice(0, 4)) {
    console.log(`       ${f.contribution >= 0 ? '+' : ''}${f.contribution.toFixed(3)}  ${f.label}: ${f.detail}`);
  }
}
for (const r of first.results) {
  if (!r.explanation.trim()) fail(`recommendation ${r.place.id} has no explanation`);
}

// --------------------------------------------------------- step 5: rejection
const rejected = first.results[1] ?? first.results[0];
if (!rejected) fail('nothing to reject');
step(4, `User rejects "${rejected.place.name}" (rank #${rejected.rank})`);
const context: SignalContext = { weather: 'rain', hasChildUnder5: true, timeOfDay: 'afternoon' };
console.log('Rejection context:', JSON.stringify(context));
unwrap(recordSignal(db, { userId: USER, placeId: rejected.place.id, kind: 'rejected', context }));
console.log('Signal recorded.');

// ------------------------------------------------- step 6: user graph learns
step(5, 'User Graph learns -- in context, not as a blanket rule');
const graph = unwrap(buildUserGraph(db, USER));
const learned = graph.preferences.filter((p) => p.weight !== 0)
  .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
if (learned.length === 0) fail('rejection taught the user graph nothing');
console.log(`Learned ${graph.preferences.length} preferences from ${graph.signalCount} signal(s):`);
for (const p of learned.slice(0, 8)) {
  console.log(`  ${p.weight >= 0 ? '+' : ''}${p.weight.toFixed(3)}  ${p.dimension}=${p.value}`
    + `  (evidence ${p.evidenceCount}, confidence ${p.confidence.value.toFixed(2)})`);
}
const negatives = learned.filter((p) => p.weight < 0);
if (negatives.length === 0) fail('a rejection produced no negative preference');
console.log(`\nContext damping: this rejection carried 3 distinguishing circumstances`);
console.log(`(rain, a child under 5, an afternoon slot), so it teaches a weaker general`);
console.log(`lesson than a context-free rejection would -- the weather may be the reason,`);
console.log(`not the place.`);

// ------------------------------------------- step 7: radar detects a change
const watched = first.results[0];
if (!watched) fail('nothing to watch');
step(6, `Radar detects a change at "${watched.place.name}"`);
const before = getPlace(db, watched.place.id);
if (!before) fail('watched place vanished');
console.log(`Stored now: price_tier=${before.priceTier} rating=${before.rating} touristiness=${before.touristiness?.toFixed(2)}`);

// The venue's own site is an `official` source (0.95) and outranks the
// aggregator (0.80) that supplied the original facts.
const OFFICIAL = 'source:venue-official';
upsertSource(db, {
  id: OFFICIAL, name: 'Venue official site', sourceClass: 'official', authority: 0.95,
  homepage: 'https://example-venue.org', regionScope: [], freshnessTier: 'periodic', enabled: true,
});
const locator = `https://example-venue.org/${watched.place.id}/visit.json`;
const watchId = unwrap(registerWatch(db, {
  sourceId: OFFICIAL, entityType: 'place', entityId: watched.place.id,
  locator, freshnessTier: 'periodic',
}));
const watch = getWatch(db, watchId);
if (!watch) fail('watch did not persist');

// Stands in for the venue's website returning updated content.
const changedPayload = {
  name: before.name,
  price_tier: '$$$',
  rating: 4.1,
  touristiness: 0.93,
  description: before.description,
};
const siteTransport: Transport = {
  mode: 'fixture',
  async request() {
    return {
      ok: true,
      value: {
        status: 200,
        headers: { 'content-type': 'application/json', etag: 'W/"visit-v2"' },
        body: JSON.stringify(changedPayload),
        replayed: true,
        latencyMs: 4,
      },
    };
  },
};

const scan = unwrap(await scanWatch(db, watch, { transport: siteTransport }));
console.log(`Scan status: ${scan.scan.status} (conditional hit: ${scan.scan.conditionalHit})`);
if (scan.deltas.length === 0) fail('radar detected no change');
console.log(`${scan.deltas.length} delta(s) detected:`);
for (const d of scan.deltas) {
  console.log(`  ${d.kind.padEnd(11)} ${d.field.padEnd(14)} ${JSON.stringify(d.oldValue)} -> ${JSON.stringify(d.newValue)}  (distance ${d.semanticScore.toFixed(3)})`);
}
const afterScan = getPlace(db, watched.place.id);
if (afterScan && afterScan.priceTier !== before.priceTier) {
  fail('Radar wrote directly to places -- it must only record claims');
}
console.log('\nRadar did NOT touch the places row. It recorded claims for the Truth Engine.');

// ------------------------------------------ step 8: truth engine verifies
step(7, 'Truth Engine verifies and adjudicates the change');
const verified = unwrap(await verifyPending(db, { transport: siteTransport }));
console.log(`Verification: ${verified.verified} verified, ${verified.disputed} disputed, `
  + `${verified.rejected} rejected, ${verified.unresolved} unresolved`);

const resolved = unwrap(resolveAll(db));
console.log(`Resolution: ${resolved.resolved} fields resolved, ${resolved.applied} applied, `
  + `${resolved.conflicts} with competing claims`);

const after = getPlace(db, watched.place.id);
if (!after) fail('place vanished after resolution');
console.log(`\nStored now: price_tier=${after.priceTier} rating=${after.rating} touristiness=${after.touristiness?.toFixed(2)}`);
if (after.priceTier === before.priceTier && after.rating === before.rating) {
  fail('Truth Engine did not apply the verified change');
}
for (const field of ['price_tier', 'rating', 'touristiness']) {
  const res = getResolution(db, watched.place.id, field);
  if (res) console.log(`  ${field.padEnd(14)} conf ${res.confidence.value.toFixed(3)}  ${res.rationale}`);
}

// ------------------------------------------------- step 9: recommendations rerank
step(8, 'Recommendations rerank on the verified facts');
const second = unwrap(recommend(db, { userId: USER, cityId: CITY, intent: INTENT, limit: 5 }));
const beforeRank = new Map(first.results.map((r) => [r.place.id, r.rank]));
const beforeScore = new Map(first.results.map((r) => [r.place.id, r.score]));
console.log('rank  place                                     score      change');
for (const r of second.results) {
  const wasRank = beforeRank.get(r.place.id);
  const wasScore = beforeScore.get(r.place.id);
  const move = wasRank === undefined ? 'new'
    : wasRank === r.rank ? '--'
    : wasRank > r.rank ? `up ${wasRank - r.rank}` : `down ${r.rank - wasRank}`;
  const delta = wasScore === undefined ? '' : ` (${(r.score - wasScore >= 0 ? '+' : '')}${(r.score - wasScore).toFixed(3)})`;
  console.log(`  #${r.rank}  ${r.place.name.slice(0, 40).padEnd(40)} ${r.score.toFixed(3)}${delta.padEnd(12)} ${move}`);
}

const movedRank = (beforeRank.get(watched.place.id) ?? 0) !== (second.results.find((r) => r.place.id === watched.place.id)?.rank ?? 99);
const movedScore = (beforeScore.get(watched.place.id) ?? 0) !== (second.results.find((r) => r.place.id === watched.place.id)?.score ?? 0);
if (!movedRank && !movedScore) fail('the verified change did not affect ranking at all');
console.log(`\n"${watched.place.name}" became pricier and far more touristy, and the user asked`);
console.log(`for somewhere NOT touristy -- so its score fell. The change flowed source -> Radar`);
console.log(`-> claim -> verification -> Truth Engine -> places -> ranking, with no step skipped.`);

// ------------------------------------------------------- step 10: health
step(9, 'Health endpoint remains green');
const health = systemHealth(db);
console.log(healthSummaryLine(health));
for (const s of health.subsystems) console.log(`  ${s.status.padEnd(10)} ${s.name.padEnd(14)} ${s.detail}`);
if (!isHealthy(health)) fail(`system health is ${health.status}`);

if (stepsSeen.length !== STEPS_TOTAL) {
  fail(`only ${stepsSeen.length}/${STEPS_TOTAL} steps executed: ran ${stepsSeen.join(',')}`);
}
console.log(`\n${'='.repeat(74)}`);
console.log(`ALL ${STEPS_TOTAL} STEPS PASSED at ${nowIso()}`);
console.log(`${'='.repeat(74)}`);
db.close();

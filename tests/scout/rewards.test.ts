/**
 * Track F: rewards foundation.
 *
 * The rules under test are the ones that cost real people real money:
 * confidence-weighted quote ranking, floored transfer ratios, and a transfer
 * plan that refuses to stay quiet about irreversibility, minimums, bad ratios
 * and shortfalls.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../../scout/db/index.ts';
import type { Db } from '../../scout/db/index.ts';
import { migrate } from '../../scout/db/migrate.ts';
import {
  ensureRegions, upsertCountry, upsertCity, upsertAirport, upsertUser, countRows,
} from '../../scout/db/repo-core.ts';
import { makeId, SOURCE_AUTHORITY, unwrap } from '../../scout/contracts/index.ts';
import type { AwardQuote } from '../../scout/contracts/index.ts';

import {
  SEED_PROGRAMS, SEED_TRANSFERS, seedPrograms, getProgram, listPrograms,
  setBalance, getBalances, transferPartnersOf, upsertTransferPartner, programIdFor,
} from '../../scout/rewards/programs.ts';
import { centsPerPoint, valuePoints, recordQuote, bestQuotes, compareQuotes } from '../../scout/rewards/points.ts';
import { applyRatio, findTransferRoutes, planTransfer } from '../../scout/rewards/transfers.ts';
import { computeFriction, haversineKm, recordFriction, frictionBetween } from '../../scout/rewards/friction.ts';

const SFO = makeId('airport', 'SFO');
const LHR = makeId('airport', 'LHR');
const USER = makeId('user', 'test-traveller');

const CHASE = programIdFor('chase-ultimate-rewards');
const AMEX = programIdFor('amex-membership-rewards');
const UNITED = programIdFor('united-mileageplus');
const MARRIOTT = programIdFor('marriott-bonvoy');
const HILTON = programIdFor('hilton-honors');
const ANA = programIdFor('ana-mileage-club');
const QANTAS = programIdFor('qantas-frequent-flyer');

/** Migrated in-memory db with just enough geography to hang quotes on. */
function setup(): Db {
  const db = openDb(':memory:');
  migrate(db);
  ensureRegions(db);

  const us = upsertCountry(db, { iso2: 'US', iso3: 'USA', name: 'United States', regionCode: 'NA', currency: 'USD' });
  const gb = upsertCountry(db, { iso2: 'GB', iso3: 'GBR', name: 'United Kingdom', regionCode: 'EU', currency: 'GBP' });
  const sf = upsertCity(db, { name: 'San Francisco', countryId: us, admin1: 'CA', lat: 37.7749, lon: -122.4194, population: 815_000, timezone: 'America/Los_Angeles' });
  const london = upsertCity(db, { name: 'London', countryId: gb, admin1: null, lat: 51.5072, lon: -0.1276, population: 8_900_000, timezone: 'Europe/London' });

  upsertAirport(db, { iata: 'SFO', icao: 'KSFO', name: 'San Francisco International', cityId: sf, countryId: us, regionCode: 'NA', lat: 37.6189, lon: -122.375, kind: 'large' });
  upsertAirport(db, { iata: 'LHR', icao: 'EGLL', name: 'London Heathrow', cityId: london, countryId: gb, regionCode: 'EU', lat: 51.47, lon: -0.4543, kind: 'large' });
  upsertUser(db, { id: USER, displayName: 'Test Traveller', homeCityId: sf });

  unwrap(seedPrograms(db));
  return db;
}

function quote(db: Db, over: Partial<Parameters<typeof recordQuote>[1]>): AwardQuote {
  return unwrap(recordQuote(db, {
    userId: USER,
    originAirportId: SFO,
    destinationAirportId: LHR,
    programId: UNITED,
    pointsCost: 60_000,
    cashCents: 98_000,
    taxesCents: 5_600,
    ...over,
  }));
}

// --------------------------------------------------------------- programs --

test('seedPrograms is idempotent', () => {
  const db = setup();
  const first = unwrap(seedPrograms(db));
  const programsAfterFirst = countRows(db, 'loyalty_programs');
  const transfersAfterFirst = countRows(db, 'transfer_partners');

  const second = unwrap(seedPrograms(db));
  assert.equal(countRows(db, 'loyalty_programs'), programsAfterFirst);
  assert.equal(countRows(db, 'transfer_partners'), transfersAfterFirst);
  assert.deepEqual(second, first);

  assert.equal(programsAfterFirst, SEED_PROGRAMS.length);
  assert.equal(transfersAfterFirst, SEED_TRANSFERS.length);
  db.close();
});

test('the loyalty graph covers every program kind and reads back', () => {
  const db = setup();
  const kinds = new Set(listPrograms(db).map((p) => p.kind));
  assert.deepEqual([...kinds].sort(), ['airline', 'bank', 'hotel', 'rail']);

  const chase = getProgram(db, CHASE);
  assert.ok(chase);
  assert.equal(chase.kind, 'bank');
  assert.equal(getProgram(db, 'program:does-not-exist'), null);

  const partners = transferPartnersOf(db, CHASE);
  assert.ok(partners.length >= 5);
  assert.ok(partners.every((p) => p.fromProgramId === CHASE));
  db.close();
});

test('balances are set, not incremented, and read back richest first', () => {
  const db = setup();
  unwrap(setBalance(db, USER, CHASE, 60_000));
  unwrap(setBalance(db, USER, AMEX, 90_000));
  unwrap(setBalance(db, USER, CHASE, 45_000));

  const balances = getBalances(db, USER);
  assert.equal(balances.length, 2);
  assert.equal(balances[0]?.programId, AMEX);
  assert.equal(balances[1]?.balance, 45_000);

  assert.equal(setBalance(db, USER, CHASE, -5).ok, false);
  assert.equal(setBalance(db, 'user:nobody', CHASE, 10).ok, false);
  assert.equal(setBalance(db, USER, 'program:nobody', 10).ok, false);
  db.close();
});

// ----------------------------------------------------------------- points --

test('centsPerPoint: normal case, divide-by-zero guard, taxes over cash', () => {
  // 92,400c of value for 60,000 points = 1.54 cents per point.
  assert.equal(centsPerPoint(60_000, 98_000, 5_600), 1.54);

  // Divide-by-zero must not leak Infinity or NaN into a ranking.
  assert.equal(centsPerPoint(0, 98_000, 5_600), 0);
  assert.equal(centsPerPoint(-100, 98_000, 5_600), 0);
  assert.equal(centsPerPoint(Number.NaN, 98_000, 0), 0);

  // Taxes above the cash fare: worth nothing, never negative.
  assert.equal(centsPerPoint(60_000, 20_000, 45_000), 0);
  assert.equal(centsPerPoint(60_000, 20_000, 20_000), 0);

  assert.equal(valuePoints(60_000, 1.54), 92_400);
  assert.equal(valuePoints(60_000, 0), 0);
  assert.equal(valuePoints(-1, 2), 0);
});

test('recordQuote persists both the scalar confidence and its explanation', () => {
  const db = setup();
  const recorded = quote(db, { sourceAuthorities: [SOURCE_AUTHORITY.official], ageDays: 0 });

  assert.equal(recorded.centsPerPoint, 1.54);
  assert.ok(recorded.confidence.value > 0.7);
  assert.equal(recorded.confidence.observations, 1);

  const row = db.get<{ confidence: number; confidence_json: string }>(
    'SELECT confidence, confidence_json FROM award_quotes WHERE id = ?', recorded.id,
  );
  assert.ok(row);
  assert.equal(Number(row.confidence), recorded.confidence.value);
  assert.equal(JSON.parse(row.confidence_json).value, recorded.confidence.value);

  // Round-trips through bestQuotes with the confidence object intact.
  const [readBack] = bestQuotes(db, SFO, LHR);
  assert.equal(readBack?.confidence.value, recorded.confidence.value);

  // Unknown route / program / user are errors, not exceptions.
  assert.equal(recordQuote(db, { originAirportId: 'airport:nope', destinationAirportId: LHR, programId: UNITED, pointsCost: 1, cashCents: 1, taxesCents: 0 }).ok, false);
  assert.equal(recordQuote(db, { originAirportId: SFO, destinationAirportId: LHR, programId: UNITED, pointsCost: 0, cashCents: 1, taxesCents: 0 }).ok, false);
  db.close();
});

test('compareQuotes: a flashy low-confidence quote loses to a solid one', () => {
  const db = setup();

  // 5.00 cpp, but a placeholder source and a month old.
  const flashy = quote(db, {
    programId: ANA, pointsCost: 20_000, cashCents: 100_000, taxesCents: 0,
    sourceAuthorities: [SOURCE_AUTHORITY.seed], ageDays: 30,
  });
  // 4.00 cpp, official and fresh.
  const solid = quote(db, {
    programId: UNITED, pointsCost: 25_000, cashCents: 100_000, taxesCents: 0,
    sourceAuthorities: [SOURCE_AUTHORITY.official], ageDays: 0,
  });

  assert.ok(flashy.centsPerPoint > solid.centsPerPoint, 'the weak quote must look better on raw cpp');

  const { best, ranked } = compareQuotes(db, [flashy, solid]);
  assert.equal(best?.id, solid.id, 'ranking must be confidence-adjusted, not raw cents per point');
  assert.equal(ranked[0]?.quote.id, solid.id);
  assert.equal(ranked[1]?.quote.id, flashy.id);
  assert.ok(ranked[0]!.centsPerPoint < ranked[1]!.centsPerPoint);
  assert.ok(ranked[0]!.confidenceAdjusted > ranked[1]!.confidenceAdjusted);

  // bestQuotes orders the same way straight out of SQL.
  assert.equal(bestQuotes(db, SFO, LHR, 5)[0]?.id, solid.id);

  assert.deepEqual(compareQuotes(db, []), { best: null, ranked: [] });
  db.close();
});

// -------------------------------------------------------------- transfers --

test('applyRatio floors partial points', () => {
  assert.equal(applyRatio(1_000, 1_000, 1_000), 1_000);      // 1:1
  assert.equal(applyRatio(1_000, 3_000, 1_000), 333);        // 3:1, 333.33 -> 333
  assert.equal(applyRatio(2_999, 3_000, 1_000), 999);        // never rounds up
  assert.equal(applyRatio(1, 3_000, 1_000), 0);              // below one whole point
  assert.equal(applyRatio(1_000, 1_000, 2_000), 2_000);      // 1:2 multiplies
  assert.equal(applyRatio(2_500, 5_000, 2_000), 1_000);      // 2.5:1
  assert.equal(applyRatio(0, 1_000, 1_000), 0);
  assert.equal(applyRatio(1_000, 0, 1_000), 0);
});

test('findTransferRoutes finds multi-hop routes, and skips inactive edges', () => {
  const db = setup();

  // No direct Chase -> ANA edge exists; the only way there is via Bonvoy.
  const routes = findTransferRoutes(db, CHASE, ANA);
  assert.ok(routes.length > 0);
  const twoHop = routes.find((r) => r.path.length === 2);
  assert.ok(twoHop, 'expected a 2-hop Chase -> Marriott -> ANA route');
  assert.equal(twoHop.path[0]?.toProgramId, MARRIOTT);
  assert.equal(twoHop.path[1]?.toProgramId, ANA);
  assert.ok(Math.abs(twoHop.effectiveRatio - 1 / 3) < 1e-9);
  assert.equal(twoHop.totalTimeHours, 50); // 2h into Bonvoy + 48h out

  // maxHops is respected.
  assert.equal(findTransferRoutes(db, CHASE, ANA, 1).length, 0);

  // Deactivating the first hop removes the whole route.
  unwrap(upsertTransferPartner(db, {
    fromProgramId: CHASE, toProgramId: MARRIOTT, ratioNum: 1_000, ratioDen: 1_000,
    minTransfer: 1_000, transferTimeHours: 2, active: false,
  }));
  assert.equal(findTransferRoutes(db, CHASE, ANA).length, 0);
  assert.ok(transferPartnersOf(db, CHASE).some((p) => p.toProgramId === MARRIOTT && !p.active));
  db.close();
});

test('findTransferRoutes never revisits a program', () => {
  const db = setup();
  // Introduce a cycle: airlines transferring back into the bank currency.
  unwrap(upsertTransferPartner(db, {
    fromProgramId: UNITED, toProgramId: CHASE, ratioNum: 1_000, ratioDen: 1_000, minTransfer: 1_000, transferTimeHours: 1,
  }));
  unwrap(upsertTransferPartner(db, {
    fromProgramId: ANA, toProgramId: MARRIOTT, ratioNum: 1_000, ratioDen: 1_000, minTransfer: 1_000, transferTimeHours: 1,
  }));

  for (const route of findTransferRoutes(db, CHASE, ANA, 4)) {
    const visited = [route.path[0]!.fromProgramId, ...route.path.map((h) => h.toProgramId)];
    assert.equal(new Set(visited).size, visited.length, `cycle in ${visited.join(' -> ')}`);
  }
  assert.equal(findTransferRoutes(db, CHASE, CHASE).length, 0);
  db.close();
});

test('planTransfer always warns that transfers are irreversible', () => {
  const db = setup();
  unwrap(setBalance(db, USER, CHASE, 60_000));

  const plan = unwrap(planTransfer(db, USER, UNITED, 50_000));
  assert.equal(plan.feasible, true);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0]?.pointsOut, 50_000);
  assert.equal(plan.steps[0]?.pointsIn, 50_000);
  assert.equal(plan.totalPointsFromUser, 50_000);
  assert.equal(plan.pointsDelivered, 50_000);
  assert.equal(plan.shortfall, 0);
  assert.ok(plan.warnings.some((w) => w.toLowerCase().includes('irreversible')));
  assert.equal(plan.warnings[0]?.toLowerCase().includes('irreversible'), true);
  db.close();
});

test('planTransfer prefers a direct balance over any transfer', () => {
  const db = setup();
  unwrap(setBalance(db, USER, UNITED, 60_000));
  unwrap(setBalance(db, USER, CHASE, 90_000));

  const plan = unwrap(planTransfer(db, USER, UNITED, 50_000));
  assert.deepEqual(plan.steps, []);
  assert.equal(plan.totalPointsFromUser, 0);
  assert.equal(plan.pointsDelivered, 60_000);
  assert.equal(plan.feasible, true);
  assert.ok(plan.warnings.some((w) => w.includes('No transfer needed')));
  // Nothing moved, so nothing is irreversible.
  assert.equal(plan.warnings.some((w) => w.toLowerCase().includes('irreversible')), false);
  db.close();
});

test('planTransfer flags a balance below the minimum transfer', () => {
  const db = setup();
  // Bonvoy -> airline moves in 3,000-point blocks; 2,000 cannot move at all.
  unwrap(setBalance(db, USER, MARRIOTT, 2_000));

  const plan = unwrap(planTransfer(db, USER, UNITED, 1_000));
  assert.equal(plan.steps.length, 0);
  assert.equal(plan.feasible, false);
  const warning = plan.warnings.find((w) => w.includes('minimum transfer'));
  assert.ok(warning, `expected a minimum-transfer warning, got ${JSON.stringify(plan.warnings)}`);
  assert.ok(warning.includes('3,000'));
  db.close();
});

test('planTransfer states the loss on a worse-than-1:1 ratio', () => {
  const db = setup();
  unwrap(setBalance(db, USER, MARRIOTT, 90_000));

  const plan = unwrap(planTransfer(db, USER, UNITED, 20_000));
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0]?.pointsOut, 60_000);
  assert.equal(plan.steps[0]?.pointsIn, 20_000);
  assert.equal(plan.feasible, true);

  const ratioWarning = plan.warnings.find((w) => w.includes('3:1'));
  assert.ok(ratioWarning, `expected a ratio warning, got ${JSON.stringify(plan.warnings)}`);
  assert.ok(ratioWarning.includes('67%'));
  assert.ok(plan.warnings.some((w) => w.includes('48 hours') && w.includes('award space')));
  db.close();
});

test('planTransfer sets feasible:false on a shortfall', () => {
  const db = setup();
  unwrap(setBalance(db, USER, CHASE, 12_000));

  const plan = unwrap(planTransfer(db, USER, UNITED, 50_000));
  assert.equal(plan.feasible, false);
  assert.equal(plan.pointsDelivered, 12_000);
  assert.equal(plan.shortfall, 38_000);
  assert.ok(plan.warnings.some((w) => w.startsWith('Shortfall:') && w.includes('38,000')));
  db.close();
});

test('planTransfer warns when it would move more points than needed', () => {
  const db = setup();
  // A 1,000-point minimum forces an over-transfer for a 400-point need.
  unwrap(setBalance(db, USER, CHASE, 60_000));

  const plan = unwrap(planTransfer(db, USER, UNITED, 400));
  assert.equal(plan.steps[0]?.pointsOut, 1_000);
  assert.equal(plan.pointsDelivered, 1_000);
  assert.ok(plan.warnings.some((w) => w.startsWith('Speculative transfer:')));
  assert.ok(plan.warnings.some((w) => w.includes('600 points are stranded')));
  db.close();
});

test('planTransfer chains hops and rejects nonsense input', () => {
  const db = setup();
  // Only Amex, and the target is ANA: Amex -> ANA direct at 1:1 (48h).
  unwrap(setBalance(db, USER, AMEX, 100_000));
  const direct = unwrap(planTransfer(db, USER, ANA, 60_000));
  assert.equal(direct.steps.length, 1);
  assert.ok(direct.warnings.some((w) => w.includes('48 hours')));

  // Drain the Amex balance so Honors is the only way to Qantas: 10:1,
  // in 10,000-point blocks. (With Amex still funded the planner would - and
  // should - prefer the 1:1 Amex -> Qantas edge.)
  unwrap(setBalance(db, USER, AMEX, 0));
  unwrap(setBalance(db, USER, HILTON, 100_000));
  const lossy = unwrap(planTransfer(db, USER, QANTAS, 5_000));
  assert.equal(lossy.steps[0]?.fromProgramId, HILTON);
  assert.equal(lossy.steps[0]?.pointsOut, 50_000);
  assert.equal(lossy.steps[0]?.pointsIn, 5_000);
  assert.ok(lossy.warnings.some((w) => w.includes('10:1') && w.includes('90%')));

  assert.equal(planTransfer(db, USER, UNITED, 0).ok, false);
  assert.equal(planTransfer(db, 'user:nobody', UNITED, 1_000).ok, false);
  assert.equal(planTransfer(db, USER, 'program:nobody', 1_000).ok, false);
  db.close();
});

// --------------------------------------------------------------- friction --

const EPSILON = 1e-9;

function assertFactorsSumToScore(f: { score: number; factors: { contribution: number }[] }): void {
  const sum = f.factors.reduce((total, factor) => total + factor.contribution, 0);
  assert.ok(Math.abs(sum - f.score) < EPSILON, `factors sum ${sum} != score ${f.score}`);
  assert.ok(f.score >= 0 && f.score <= 1, `score ${f.score} out of range`);
}

test('friction: a civilised nonstop scores near zero', () => {
  const easy = computeFriction({ stops: 0, totalMinutes: 150, departureHour: 11, arrivalHour: 14 });
  assert.equal(easy.score, 0);
  assert.equal(easy.redeye, false);
  assert.equal(easy.overnight, false);
  assertFactorsSumToScore(easy);

  // Just over the duration floor: small but non-zero, still nowhere near 0.1.
  const mild = computeFriction({ stops: 0, totalMinutes: 240, departureHour: 10, arrivalHour: 16 });
  assert.ok(mild.score > 0 && mild.score < 0.05);
  assertFactorsSumToScore(mild);
});

test('friction: a two-stop red-eye scores high', () => {
  const ordeal = computeFriction({
    stops: 2, totalMinutes: 960, departureHour: 23, arrivalHour: 4, overnight: true,
  });
  assert.ok(ordeal.score > 0.9, `expected a punishing score, got ${ordeal.score}`);
  assert.equal(ordeal.redeye, true);
  assert.equal(ordeal.overnight, true);
  assert.equal(ordeal.factors.length, 5);
  assertFactorsSumToScore(ordeal);

  // A third stop cannot push past the cap, and the score stays inside 0..1.
  const worse = computeFriction({
    stops: 4, totalMinutes: 2_000, departureHour: 2, arrivalHour: 3, overnight: true,
  });
  assert.ok(worse.score <= 1);
  assertFactorsSumToScore(worse);
});

test('friction: factors sum to the score across a spread of itineraries', () => {
  const cases = [
    { stops: 0, totalMinutes: 90 },
    { stops: 1, totalMinutes: 600, departureHour: 9, arrivalHour: 2 },
    { stops: 2, totalMinutes: 480, departureHour: 22, arrivalHour: 11, overnight: true },
    { stops: 1, totalMinutes: 900, departureHour: 4, arrivalHour: 5, overnight: false },
    { stops: 3, totalMinutes: 1_440, departureHour: 21, arrivalHour: 23, overnight: true },
  ];
  for (const input of cases) assertFactorsSumToScore(computeFriction(input));
});

test('recordFriction round-trips through the database', () => {
  const db = setup();
  const recorded = unwrap(recordFriction(db, SFO, LHR, {
    stops: 1, totalMinutes: 780, departureHour: 23, arrivalHour: 5, overnight: true,
  }));
  assert.equal(recorded.originAirportId, SFO);
  assertFactorsSumToScore(recorded);

  const read = frictionBetween(db, SFO, LHR);
  assert.ok(read);
  assert.equal(read.score, recorded.score);
  assert.deepEqual(read.factors, recorded.factors);
  assert.equal(read.redeye, true);

  // Same itinerary, same derived id: recording twice keeps one row.
  unwrap(recordFriction(db, SFO, LHR, {
    stops: 1, totalMinutes: 780, departureHour: 23, arrivalHour: 5, overnight: true,
  }));
  assert.equal(countRows(db, 'travel_friction'), 1);

  assert.equal(recordFriction(db, 'airport:nope', LHR, { stops: 0, totalMinutes: 60 }).ok, false);
  assert.equal(frictionBetween(db, LHR, SFO), null);
  db.close();
});

test('haversineKm matches published great-circle distances', () => {
  const lhr = { lat: 51.47, lon: -0.4543 };
  const jfk = { lat: 40.6413, lon: -73.7781 };
  const sfo = { lat: 37.6189, lon: -122.375 };

  const within = (actual: number, expected: number): boolean =>
    Math.abs(actual - expected) / expected <= 0.02;

  assert.ok(within(haversineKm(lhr, jfk), 5_555), `LHR-JFK was ${haversineKm(lhr, jfk)}`);
  assert.ok(within(haversineKm(sfo, lhr), 8_616), `SFO-LHR was ${haversineKm(sfo, lhr)}`);
  assert.equal(haversineKm(sfo, sfo), 0);
  // Symmetric.
  assert.ok(Math.abs(haversineKm(sfo, lhr) - haversineKm(lhr, sfo)) < 1e-9);
});

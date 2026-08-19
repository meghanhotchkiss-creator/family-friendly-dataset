/**
 * Track B (Intelligence) tests: truth engine, user graph, topic graph, intent
 * parsing and scoring, all against an in-memory database.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../../scout/db/index.ts';
import type { Db } from '../../scout/db/index.ts';
import { migrate } from '../../scout/db/migrate.ts';
import { ensureRegions, upsertCountry, upsertCity, upsertUser } from '../../scout/db/repo-core.ts';
import { upsertPlace, getPlace } from '../../scout/db/repo-places.ts';
import { upsertSource, recordClaim } from '../../scout/db/repo-truth.ts';
import type { Place, Source, SourceClass } from '../../scout/contracts/index.ts';
import { unwrap, SOURCE_AUTHORITY, makeId } from '../../scout/contracts/index.ts';
import { nowIso, plusSeconds, freezeClock, unfreezeClock } from '../../scout/runtime/clock.ts';

import {
  resolveAll,
  resolveField,
  getResolution,
  valuesAgree,
} from '../../scout/intelligence/truth-engine.ts';
import {
  recordSignal,
  buildUserGraph,
  rebuildAllUserGraphs,
  getPreferences,
  preferenceFor,
  contextAttenuation,
} from '../../scout/intelligence/user-graph.ts';
import {
  CORE_TOPICS,
  seedCoreTopics,
  linkPlacesToTopics,
  discoverCandidates,
  promoteCandidates,
  buildTopicGraph,
  getTopicBySlug,
} from '../../scout/intelligence/topic-graph.ts';
import { parseIntent, biasFor } from '../../scout/intelligence/intent.ts';
import { recommend, scorePlace } from '../../scout/intelligence/scoring.ts';

// --- fixtures ---------------------------------------------------------------

const CITY_ID = 'city:us-or-portland';

function freshDb(): Db {
  const db = openDb(':memory:');
  migrate(db);
  ensureRegions(db);
  upsertCountry(db, {
    iso2: 'US',
    iso3: 'USA',
    name: 'United States',
    regionCode: 'NA',
    currency: 'USD',
  });
  upsertCity(db, {
    id: CITY_ID,
    name: 'Portland',
    countryId: makeId('country', 'US'),
    admin1: 'OR',
    lat: 45.52,
    lon: -122.68,
    population: 650_000,
    timezone: 'America/Los_Angeles',
  });
  return db;
}

function place(overrides: Partial<Place> & { id: string; name: string }): Place {
  const base: Place = {
    id: overrides.id,
    name: overrides.name,
    cityId: CITY_ID,
    neighborhoodId: null,
    lat: 45.5,
    lon: -122.6,
    locationPrecision: 'venue',
    category: 'museum',
    subcategory: null,
    priceTier: '$',
    indoorOutdoor: 'indoor',
    rating: 4.2,
    minAge: null,
    maxAge: null,
    durationMinutes: 120,
    touristiness: 0.4,
    localFavor: 0.6,
    description: null,
    canonicalHash: null,
    updatedAt: nowIso(),
  };
  return { ...base, ...overrides };
}

function addPlace(db: Db, overrides: Partial<Place> & { id: string; name: string }): Place {
  const p = place(overrides);
  upsertPlace(db, p);
  return p;
}

function source(id: string, sourceClass: SourceClass, name?: string): Source {
  return {
    id,
    name: name ?? id.replace('source:', ''),
    sourceClass,
    authority: SOURCE_AUTHORITY[sourceClass],
    homepage: null,
    regionScope: [],
    freshnessTier: 'periodic',
    enabled: true,
  };
}

// --- truth engine -----------------------------------------------------------

test('valuesAgree handles scalars, strings and objects', () => {
  assert.equal(valuesAgree(1, 1), true);
  assert.equal(valuesAgree(0.1 + 0.2, 0.3), true, 'float noise is not a conflict');
  assert.equal(valuesAgree(1, 2), false);
  assert.equal(valuesAgree('  Portland  Zoo ', 'portland zoo'), true);
  assert.equal(valuesAgree('Portland Zoo', 'Seattle Zoo'), false);
  assert.equal(valuesAgree({ a: 1, b: 2 }, { b: 2, a: 1 }), true, 'key order is not a conflict');
  assert.equal(valuesAgree({ a: 1 }, { a: 2 }), false);
  assert.equal(valuesAgree(null, null), true);
  assert.equal(valuesAgree(null, 0), false);
  assert.equal(valuesAgree([1, 2], [1, 2]), true);
});

test('a high-authority source beats a low-authority one', () => {
  const db = freshDb();
  const p = addPlace(db, { id: 'place:pdx-zoo', name: 'Zoo' });
  upsertSource(db, source('source:official', 'official'));
  upsertSource(db, source('source:seedy', 'seed'));

  recordClaim(db, {
    sourceId: 'source:official',
    entityType: 'place',
    entityId: p.id,
    field: 'rating',
    value: 4.6,
  });
  recordClaim(db, {
    sourceId: 'source:seedy',
    entityType: 'place',
    entityId: p.id,
    field: 'rating',
    value: 2.1,
  });

  const resolution = unwrap(resolveField(db, 'place', p.id, 'rating'));
  assert.ok(resolution);
  assert.equal(resolution.value, 4.6);
  assert.equal(resolution.conflictingRecordIds.length, 1);
  assert.match(resolution.rationale, /conflicting claim/);
  db.close();
});

test('two corroborating mid-authority sources beat one higher-authority source (noisy-OR)', () => {
  const db = freshDb();
  const p = addPlace(db, { id: 'place:pdx-park', name: 'Park' });
  // 0.8 alone vs 0.7 + 0.7 combined: noisy-OR gives 1-(0.3*0.3) = 0.91 > 0.8.
  upsertSource(db, source('source:aggregator', 'major_aggregator'));
  upsertSource(db, source('source:osm', 'open_dataset'));
  upsertSource(db, source('source:wikidata', 'open_dataset'));

  recordClaim(db, {
    sourceId: 'source:aggregator',
    entityType: 'place',
    entityId: p.id,
    field: 'name',
    value: 'Aggregator Park',
  });
  recordClaim(db, {
    sourceId: 'source:osm',
    entityType: 'place',
    entityId: p.id,
    field: 'name',
    value: 'Community Park',
  });
  recordClaim(db, {
    sourceId: 'source:wikidata',
    entityType: 'place',
    entityId: p.id,
    field: 'name',
    value: 'Community Park',
  });

  const resolution = unwrap(resolveField(db, 'place', p.id, 'name'));
  assert.ok(resolution);
  assert.equal(
    resolution.value,
    'Community Park',
    'two independent 0.7 sources should out-corroborate one 0.8 source',
  );
  assert.equal(resolution.confidence.observations, 2);
  assert.ok(resolution.confidence.corroboration > SOURCE_AUTHORITY.major_aggregator);
  assert.equal(resolution.agreeingRecordIds.length, 2);
  db.close();
});

test('one strong source still beats a single weaker one at equal freshness', () => {
  const db = freshDb();
  const p = addPlace(db, { id: 'place:pdx-lib', name: 'Library' });
  upsertSource(db, source('source:official', 'official'));
  upsertSource(db, source('source:reviews', 'community'));
  recordClaim(db, {
    sourceId: 'source:official',
    entityType: 'place',
    entityId: p.id,
    field: 'priceTier',
    value: 'free',
  });
  recordClaim(db, {
    sourceId: 'source:reviews',
    entityType: 'place',
    entityId: p.id,
    field: 'priceTier',
    value: '$$',
  });
  const resolution = unwrap(resolveField(db, 'place', p.id, 'priceTier'));
  assert.equal(resolution?.value, 'free');
  db.close();
});

test('resolution is deterministic and lands the resolved value on the place row', () => {
  // Frozen so the freshness term cannot drift between the two runs: the point
  // of the test is determinism of the RESOLUTION, not of the wall clock.
  freezeClock('2026-05-01T12:00:00.000Z');
  const db = freshDb();
  const p = addPlace(db, { id: 'place:pdx-sci', name: 'Old Name', rating: 1.0 });
  upsertSource(db, source('source:official', 'official', 'place-official'));
  upsertSource(db, source('source:community', 'community'));

  recordClaim(db, {
    sourceId: 'source:official',
    entityType: 'place',
    entityId: p.id,
    field: 'name',
    value: 'Science Works',
  });
  recordClaim(db, {
    sourceId: 'source:community',
    entityType: 'place',
    entityId: p.id,
    field: 'name',
    value: 'Sciense Wurks',
  });
  recordClaim(db, {
    sourceId: 'source:official',
    entityType: 'place',
    entityId: p.id,
    field: 'durationMinutes',
    value: 150,
  });
  recordClaim(db, {
    sourceId: 'source:official',
    entityType: 'place',
    entityId: p.id,
    field: 'popularityRank',
    value: 3,
  });

  const first = unwrap(resolveAll(db));
  assert.equal(first.resolved, 3);
  assert.equal(first.conflicts, 1);
  assert.equal(first.applied, 2, 'name and durationMinutes apply; popularityRank has no column');
  assert.equal(first.skipped, 1);

  const applied = getPlace(db, p.id);
  assert.equal(applied?.name, 'Science Works');
  assert.equal(applied?.durationMinutes, 150);

  const before = getResolution(db, p.id, 'name');
  const second = unwrap(resolveAll(db));
  const after = getResolution(db, p.id, 'name');
  assert.deepEqual(second, first, 'counts must not drift on a repeat run');
  assert.equal(after?.value, before?.value);
  assert.equal(after?.chosenRecordId, before?.chosenRecordId);
  assert.equal(after?.confidence.value, before?.confidence.value);
  assert.equal(after?.id, before?.id, 'the resolution is upserted, not duplicated');
  assert.match(before?.rationale ?? '', /place-official/);
  db.close();
  unfreezeClock();
});

// --- user graph -------------------------------------------------------------

function seedUserFixture(db: Db): { userId: string; museum: Place; park: Place } {
  const userId = 'user:mara';
  upsertUser(db, { id: userId, displayName: 'Mara' });
  const museum = addPlace(db, {
    id: 'place:pdx-museum',
    name: 'City Museum',
    category: 'museum',
    priceTier: '$$',
    indoorOutdoor: 'indoor',
    touristiness: 0.8,
    durationMinutes: 120,
  });
  const park = addPlace(db, {
    id: 'place:pdx-greenpark',
    name: 'Green Park',
    category: 'park',
    priceTier: 'free',
    indoorOutdoor: 'outdoor',
    touristiness: 0.2,
    durationMinutes: 60,
  });
  return { userId, museum, park };
}

test('a rejection produces a negative preference and saves produce a positive one', () => {
  const db = freshDb();
  const { userId, museum, park } = seedUserFixture(db);

  unwrap(recordSignal(db, { userId, placeId: museum.id, kind: 'rejected' }));
  unwrap(recordSignal(db, { userId, placeId: park.id, kind: 'saved' }));
  unwrap(buildUserGraph(db, userId));

  const disliked = preferenceFor(db, userId, 'category', 'museum');
  const liked = preferenceFor(db, userId, 'category', 'park');
  assert.ok(disliked && disliked.weight < 0, 'rejecting a museum must teach a museum aversion');
  assert.ok(liked && liked.weight > 0);
  assert.ok(disliked.confidence.value > 0 && disliked.confidence.value <= 1);
  assert.equal(disliked.evidenceCount, 1);
  db.close();
});

test('context attenuation: a rejection under distinguishing circumstances generalises less', () => {
  assert.equal(contextAttenuation({}), 1);
  assert.equal(contextAttenuation({ weather: 'clear' }), 1, 'clear weather is not distinguishing');
  assert.equal(contextAttenuation({ weather: 'rain' }), 0.5);
  assert.equal(contextAttenuation({ weather: 'rain', hasChildUnder5: true }), 0.35);

  const plain = freshDb();
  const plainFixture = seedUserFixture(plain);
  unwrap(recordSignal(plain, { userId: plainFixture.userId, placeId: plainFixture.museum.id, kind: 'rejected' }));
  unwrap(buildUserGraph(plain, plainFixture.userId));
  const plainWeight = preferenceFor(plain, plainFixture.userId, 'category', 'museum')?.weight ?? 0;

  const context = freshDb();
  const contextFixture = seedUserFixture(context);
  unwrap(
    recordSignal(context, {
      userId: contextFixture.userId,
      placeId: contextFixture.museum.id,
      kind: 'rejected',
      context: { weather: 'rain', hasChildUnder5: true, timeOfDay: 'evening' },
    }),
  );
  unwrap(buildUserGraph(context, contextFixture.userId));
  const contextWeight =
    preferenceFor(context, contextFixture.userId, 'category', 'museum')?.weight ?? 0;

  assert.ok(plainWeight < 0 && contextWeight < 0, 'both are still aversions');
  assert.ok(
    contextWeight > plainWeight,
    `a contextual rejection (${contextWeight}) must be less negative than a context-free one (${plainWeight})`,
  );
  assert.ok(Math.abs(contextWeight - plainWeight * 0.35) < 1e-9, 'two or more factors damp to 0.35');

  plain.close();
  context.close();
});

test('buildUserGraph is idempotent and rebuildAllUserGraphs covers every user', () => {
  const db = freshDb();
  const { userId, museum, park } = seedUserFixture(db);
  unwrap(recordSignal(db, { userId, placeId: museum.id, kind: 'rated', rating: 5 }));
  unwrap(recordSignal(db, { userId, placeId: park.id, kind: 'visited' }));
  unwrap(recordSignal(db, { userId, placeId: park.id, kind: 'viewed' }));

  unwrap(buildUserGraph(db, userId));
  const first = getPreferences(db, userId);
  unwrap(buildUserGraph(db, userId));
  const second = getPreferences(db, userId);

  assert.ok(first.length > 0);
  assert.equal(first.length, second.length);
  assert.deepEqual(
    first.map((p) => [p.dimension, p.value, p.weight, p.evidenceCount]),
    second.map((p) => [p.dimension, p.value, p.weight, p.evidenceCount]),
  );

  const all = unwrap(rebuildAllUserGraphs(db));
  assert.equal(all.users, 1);
  assert.equal(all.preferences, second.length);

  // A 1-star rating is an aversion, a 5-star is an affinity.
  const rating1 = preferenceFor(db, userId, 'touristiness', 'high');
  assert.ok(rating1 && rating1.weight > 0, 'a 5-star museum rating is positive evidence');
  db.close();
});

// --- topic graph ------------------------------------------------------------

test('core topics seed with a parent hierarchy and link to matching places', () => {
  const db = freshDb();
  addPlace(db, {
    id: 'place:pdx-omsi',
    name: 'Museum of Science and Industry',
    category: 'science_center',
    description: 'Hands-on science experiments and a planetarium.',
  });
  addPlace(db, {
    id: 'place:pdx-zoo2',
    name: 'Oregon Zoo',
    category: 'zoo',
    description: 'Animals and wildlife from around the world.',
  });

  const result = unwrap(buildTopicGraph(db));
  assert.equal(result.core, CORE_TOPICS.length);
  assert.ok(result.links > 0);

  const science = getTopicBySlug(db, 'hands-on-science');
  assert.ok(science);
  assert.equal(science.status, 'core');
  assert.equal(science.parentTopicId, makeId('topic', 'learning'));

  const linked = db.all<{ slug: string; weight: number }>(
    `SELECT t.slug AS slug, pt.weight AS weight FROM place_topics pt
     JOIN topics t ON t.id = pt.topic_id WHERE pt.place_id = ?`,
    'place:pdx-omsi',
  );
  const slugs = linked.map((r) => r.slug);
  assert.ok(slugs.includes('hands-on-science'));
  assert.ok(slugs.includes('learning'), 'the parent topic matches on "museum" too');

  // A name match must outweigh a description-only match.
  addPlace(db, {
    id: 'place:pdx-cosy',
    name: 'Cosy Corner',
    category: 'cafe',
    description: 'A sheltered indoor room for wet afternoons.',
  });
  unwrap(linkPlacesToTopics(db));
  const nameWeight = linked.find((r) => r.slug === 'hands-on-science')?.weight ?? 0;
  const descriptionWeight = db.get<{ weight: number }>(
    'SELECT weight FROM place_topics WHERE place_id = ? AND topic_id = ?',
    'place:pdx-cosy',
    makeId('topic', 'rainy-day-indoor'),
  )?.weight;
  assert.ok(descriptionWeight !== undefined);
  assert.ok(
    nameWeight > Number(descriptionWeight),
    `a name hit (${nameWeight}) must beat a description hit (${descriptionWeight})`,
  );

  // Seeding twice must not duplicate.
  const again = unwrap(seedCoreTopics(db));
  assert.equal(again.created, 0);
  unwrap(linkPlacesToTopics(db));
  db.close();
});

test('discovery promotes a distinctive recurring term and ignores a universal one', () => {
  const db = freshDb();
  // "kayaking" appears in 3 of 6 places (distinctive). "portland" appears in
  // all 6 (useless as a topic, distinctiveness 0).
  const blurbs: [string, string][] = [
    ['a', 'Portland kayaking lagoon with rentals'],
    ['b', 'Portland kayaking launch on the river'],
    ['c', 'Portland kayaking club open to visitors'],
    ['d', 'Portland pottery shed'],
    ['e', 'Portland skate bowl'],
    ['f', 'Portland dumpling hall'],
  ];
  for (const [id, description] of blurbs) {
    addPlace(db, { id: `place:disc-${id}`, name: `Spot ${id}`, description, category: 'landmark' });
  }
  unwrap(seedCoreTopics(db));

  const candidates = unwrap(discoverCandidates(db));
  const kayaking = candidates.find((c) => c.term === 'kayaking');
  const portland = candidates.find((c) => c.term === 'portland');

  assert.ok(kayaking, 'kayaking should surface as a candidate');
  assert.equal(kayaking.support.length, 3);
  assert.ok(Math.abs(kayaking.distinctiveness - 0.5) < 1e-9);
  assert.ok(portland, 'portland is counted');
  assert.equal(portland.distinctiveness, 0, 'a term in every place has no discriminative power');
  assert.ok(kayaking.score > portland.score);

  unwrap(promoteCandidates(db, candidates));
  assert.equal(getTopicBySlug(db, 'kayaking')?.status, 'promoted');
  assert.equal(getTopicBySlug(db, 'portland')?.status, 'candidate');
  assert.equal(getTopicBySlug(db, 'kayaking')?.supportCount, 3);

  const links = db.all<{ place_id: string }>(
    'SELECT place_id FROM place_topics WHERE topic_id = ? AND source = ?',
    makeId('topic', 'kayaking'),
    'discovered',
  );
  assert.equal(links.length, 3, 'a promoted topic links to its supporting places');
  db.close();
});

// --- intent -----------------------------------------------------------------

test('the driving example parses all three flags with the right signs', () => {
  const intent = parseIntent('Family-friendly, local, not too touristy');
  assert.equal(intent.familyFriendly, true);
  assert.equal(intent.wantsLocal, true);
  assert.equal(intent.avoidsTouristy, true);

  const touristy = biasFor(intent, 'touristiness', 'high');
  assert.ok(touristy < -0.5, `"not too touristy" must be strongly negative, got ${touristy}`);
  const local = biasFor(intent, 'neighborhood_character', 'local');
  assert.ok(local > 0.5, `"local" must be strongly positive, got ${local}`);
  assert.equal(intent.raw, 'Family-friendly, local, not too touristy');
});

test('negation flips biases instead of dropping the term', () => {
  const negated = parseIntent('not indoors please');
  assert.ok(biasFor(negated, 'indoor_outdoor', 'indoor') < 0);

  const affirmed = parseIntent('somewhere indoors');
  assert.ok(biasFor(affirmed, 'indoor_outdoor', 'indoor') > 0);

  const avoided = parseIntent('avoid crowded tourist traps');
  assert.equal(avoided.avoidsTouristy, true);
  assert.ok(biasFor(avoided, 'touristiness', 'high') < 0);

  const touristy = parseIntent('the big tourist sights');
  assert.ok(biasFor(touristy, 'touristiness', 'high') > 0, 'an affirmed term stays positive');
  assert.equal(touristy.avoidsTouristy, false);
});

test('intent recognises budget, duration, crowd and age vocabulary', () => {
  const cheap = parseIntent('free things to do with a toddler, quick visits');
  assert.ok(biasFor(cheap, 'price_tier', 'free') > 0);
  assert.ok(biasFor(cheap, 'duration', 'short') > 0);
  assert.equal(cheap.familyFriendly, true);
  assert.ok(cheap.topics.includes('stroller-friendly'));

  const gem = parseIntent('a hidden gem, somewhere quiet');
  assert.equal(gem.wantsLocal, true);
  assert.equal(gem.avoidsTouristy, true);
  assert.ok(gem.vibes.includes('quiet'));

  const rainy = parseIntent('rainy day science museum');
  assert.ok(rainy.topics.includes('rainy-day-indoor'));
  assert.ok(rainy.topics.includes('hands-on-science'));

  const splurge = parseIntent('a full day splurge with teens');
  assert.ok(biasFor(splurge, 'price_tier', '$$$') > 0);
  assert.ok(biasFor(splurge, 'duration', 'long') > 0);
});

// --- scoring ----------------------------------------------------------------

function seedScoringFixture(db: Db): string {
  const userId = 'user:rec';
  upsertUser(db, { id: userId, displayName: 'Rec' });
  addPlace(db, {
    id: 'place:rec-science',
    name: 'Hands-on Science Centre',
    category: 'science_center',
    description: 'Interactive science experiments in a quiet local neighbourhood.',
    touristiness: 0.15,
    localFavor: 0.85,
    rating: 4.5,
    priceTier: '$',
  });
  addPlace(db, {
    id: 'place:rec-trap',
    name: 'Famous Observation Tower',
    category: 'landmark',
    description: 'The single busiest tourist attraction in the city.',
    touristiness: 0.95,
    localFavor: 0.1,
    rating: 4.0,
    priceTier: '$$$',
  });
  addPlace(db, {
    id: 'place:rec-park',
    name: 'Neighbourhood Playground',
    category: 'playground',
    description: 'A residential playground with swings and a splash fountain.',
    touristiness: 0.1,
    localFavor: 0.9,
    rating: 4.3,
    priceTier: 'free',
    indoorOutdoor: 'outdoor',
    durationMinutes: 60,
  });
  unwrap(buildTopicGraph(db));
  return userId;
}

test('every recommendation carries an explanation and at least one factor', () => {
  const db = freshDb();
  const userId = seedScoringFixture(db);
  const response = unwrap(
    recommend(db, { userId, cityId: CITY_ID, intent: 'Family-friendly, local, not too touristy' }),
  );

  assert.ok(response.results.length >= 3);
  response.results.forEach((rec, index) => {
    assert.equal(rec.rank, index + 1);
    assert.ok(rec.explanation.trim().length > 0, 'explanation must never be empty');
    assert.ok(rec.factors.length > 0, 'every result needs at least one factor');
    assert.ok(rec.confidence.value >= 0 && rec.confidence.value <= 1);
  });

  const ids = response.results.map((r) => r.place.id);
  assert.ok(
    ids.indexOf('place:rec-trap') > ids.indexOf('place:rec-science'),
    'a tourist trap must rank below a local favourite for this intent',
  );
  assert.equal(response.parsedIntent.avoidsTouristy, true);
  db.close();
});

test('excluded places are removed and limit is honoured', () => {
  const db = freshDb();
  const userId = seedScoringFixture(db);
  const response = unwrap(
    recommend(db, { userId, cityId: CITY_ID, intent: 'local', exclude: ['place:rec-science'] }),
  );
  assert.ok(!response.results.some((r) => r.place.id === 'place:rec-science'));

  const limited = unwrap(recommend(db, { userId, cityId: CITY_ID, intent: 'local', limit: 1 }));
  assert.equal(limited.results.length, 1);
  assert.equal(limited.results[0]?.rank, 1);
  db.close();
});

test('a hard constraint filters candidates, a soft one only penalises', () => {
  const db = freshDb();
  const userId = seedScoringFixture(db);
  db.run(
    `INSERT INTO constraints (id, user_id, trip_id, kind, value_json, hard, created_at)
     VALUES (?,?,NULL,?,?,?,?)`,
    'con_hard',
    userId,
    'avoid_category',
    JSON.stringify('landmark'),
    1,
    nowIso(),
  );
  const hard = unwrap(recommend(db, { userId, cityId: CITY_ID, intent: 'local' }));
  assert.ok(!hard.results.some((r) => r.place.category === 'landmark'), 'hard constraint removes');

  db.run('UPDATE constraints SET hard = 0 WHERE id = ?', 'con_hard');
  const soft = unwrap(recommend(db, { userId, cityId: CITY_ID, intent: 'local' }));
  const trap = soft.results.find((r) => r.place.id === 'place:rec-trap');
  assert.ok(trap, 'soft constraint keeps the candidate');
  assert.ok(
    trap.factors.some((f) => f.label.startsWith('soft constraint')),
    'soft constraint shows up as a penalty factor',
  );
  db.close();
});

test('weak truth confidence ranks a place below an otherwise identical well-sourced one', () => {
  const db = freshDb();
  const userId = 'user:truthrank';
  upsertUser(db, { id: userId, displayName: 'T' });
  const shared: Partial<Place> = {
    category: 'museum',
    description: 'An identical museum for comparison.',
    touristiness: 0.3,
    localFavor: 0.7,
    rating: 4.2,
    priceTier: '$',
    durationMinutes: 120,
  };
  const strong = addPlace(db, { ...shared, id: 'place:tr-strong', name: 'Alpha Museum' });
  const weak = addPlace(db, { ...shared, id: 'place:tr-weak', name: 'Alpha Museum Two' });
  unwrap(buildTopicGraph(db));

  upsertSource(db, source('source:official', 'official'));
  upsertSource(db, source('source:osm', 'open_dataset'));
  upsertSource(db, source('source:seedy', 'seed'));

  for (const sourceId of ['source:official', 'source:osm']) {
    recordClaim(db, {
      sourceId,
      entityType: 'place',
      entityId: strong.id,
      field: 'rating',
      value: 4.2,
      verification: 'human_verified',
    });
  }
  recordClaim(db, {
    sourceId: 'source:seedy',
    entityType: 'place',
    entityId: weak.id,
    field: 'rating',
    value: 4.2,
  });
  unwrap(resolveAll(db));

  const response = unwrap(recommend(db, { userId, cityId: CITY_ID, intent: 'a museum' }));
  const strongRec = response.results.find((r) => r.place.id === strong.id);
  const weakRec = response.results.find((r) => r.place.id === weak.id);
  assert.ok(strongRec && weakRec);
  assert.ok(
    strongRec.confidence.value > weakRec.confidence.value,
    'corroborated facts must carry more confidence',
  );
  assert.ok(
    strongRec.score > weakRec.score,
    `well-sourced (${strongRec.score}) must outrank thinly-sourced (${weakRec.score})`,
  );
  assert.ok(strongRec.rank < weakRec.rank);
  db.close();
});

test('scorePlace reports learned preferences and age suitability', () => {
  const db = freshDb();
  const userId = seedScoringFixture(db);
  const target = getPlace(db, 'place:rec-science');
  assert.ok(target);

  unwrap(recordSignal(db, { userId, placeId: target.id, kind: 'saved' }));
  unwrap(recordSignal(db, { userId, placeId: target.id, kind: 'booked' }));
  unwrap(buildUserGraph(db, userId));

  const scored = scorePlace(db, target, {
    intent: parseIntent('family-friendly, local, not too touristy'),
    preferences: getPreferences(db, userId),
    partyHasYoungChild: true,
    hardConstraints: [],
  });

  assert.ok(scored.factors.some((f) => f.label.startsWith('learned preference')));
  assert.ok(scored.factors.some((f) => f.label === 'age suitability'));
  assert.ok(scored.factors.some((f) => f.label === 'fact confidence'));
  assert.ok(scored.explanation.endsWith('.'));
  assert.equal(scored.explanation[0], scored.explanation[0]?.toUpperCase());

  // A place whose minimum age excludes the youngest child is penalised hard.
  const grownUp = addPlace(db, {
    id: 'place:rec-adults',
    name: 'Adults Only Distillery',
    category: 'restaurant',
    minAge: 18,
  });
  const blocked = scorePlace(db, grownUp, {
    intent: parseIntent('family-friendly'),
    preferences: [],
    partyHasYoungChild: true,
    hardConstraints: [],
  });
  const ageFactor = blocked.factors.find((f) => f.label === 'age suitability');
  assert.ok(ageFactor && ageFactor.contribution < 0);
  db.close();
});

test('older evidence decays: a stale claim resolves with lower confidence than a fresh one', () => {
  const db = freshDb();
  const p = addPlace(db, { id: 'place:decay', name: 'Decay Hall' });
  upsertSource(db, source('source:official', 'official'));
  const stale = plusSeconds(nowIso(), -240 * 86_400);
  recordClaim(db, {
    sourceId: 'source:official',
    entityType: 'place',
    entityId: p.id,
    field: 'description',
    value: 'A hall.',
    observedAt: stale,
  });
  const resolution = unwrap(resolveField(db, 'place', p.id, 'description'));
  assert.ok(resolution);
  assert.ok(resolution.confidence.freshness < 1, 'a 240-day-old periodic claim must have decayed');
  assert.ok(resolution.confidence.value < SOURCE_AUTHORITY.official);
  db.close();
});

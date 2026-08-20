/**
 * Track E: Connection Sentinel.
 *
 * Deliberately standalone: the providers here are inline stubs, so this suite
 * exercises the reliability layer without depending on the connector registry
 * or on any fixture being present.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../../scout/db/index.ts';
import type { Db } from '../../scout/db/index.ts';
import { migrate } from '../../scout/db/migrate.ts';
import type {
  Provider,
  ProviderContext,
  ProviderHealth,
  ProviderKind,
  Result,
  FetchResponse,
  Transport,
} from '../../scout/contracts/index.ts';
import { ok, err, LATENCY_BUDGET_MS, LATENCY_CRITICAL_MS } from '../../scout/contracts/index.ts';
import { nowIso, freezeClock, unfreezeClock } from '../../scout/runtime/clock.ts';
import { canonicalHash } from '../../scout/runtime/hash.ts';

import {
  log,
  logger,
  captureLogs,
  setLogLevel,
  resetLogLevel,
  REDACTED,
} from '../../scout/reliability/logging.ts';
import {
  recordFingerprint,
  detectDrift,
  listFingerprints,
  fingerprintDiff,
} from '../../scout/reliability/drift.ts';
import {
  checkProvider,
  openIncident,
  closeIncident,
  openIncidents,
  detectStaleData,
  latencyStatus,
  ensureProviderRow,
} from '../../scout/reliability/sentinel.ts';
import { orderByPreference, withFailover } from '../../scout/reliability/failover.ts';
import { systemHealth, healthSummaryLine, isHealthy } from '../../scout/api/health.ts';

// Keep the suite's stderr quiet; the logging tests set their own level.
setLogLevel('error');

function makeDb(): Db {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

const stubTransport: Transport = {
  mode: 'fixture',
  async request() {
    return err('not_configured', 'stub transport');
  },
};

function makeCtx(): ProviderContext {
  return { transport: stubTransport, credentials: {}, now: nowIso };
}

interface StubOptions {
  id: string;
  kind?: ProviderKind;
  authority?: number;
  configured?: boolean;
  health?: Partial<ProviderHealth>;
  healthFn?: () => ProviderHealth;
  fetchResult?: () => Result<FetchResponse<unknown>>;
}

/** A hand-rolled Provider: the contract is a plain interface, so no registry needed. */
function stubProvider(options: StubOptions): Provider {
  const base: ProviderHealth = {
    providerId: options.id,
    status: 'up',
    checkedAt: nowIso(),
    latencyMs: 12,
    httpStatus: 200,
    authOk: true,
    schemaOk: true,
    schemaFingerprint: null,
    error: null,
    ...(options.health ?? {}),
  };
  return {
    id: options.id,
    kind: options.kind ?? 'places',
    sourceClass: 'official',
    authority: options.authority ?? 0.9,
    freshnessTier: 'periodic',
    regionScope: [],
    isConfigured: () => options.configured ?? true,
    async health() {
      return options.healthFn ? options.healthFn() : { ...base, checkedAt: nowIso() };
    },
    async fetch() {
      return options.fetchResult
        ? options.fetchResult()
        : ok({ items: [], fetchedAt: nowIso(), replayed: true, schemaFingerprint: '{}' });
    },
  };
}

// --------------------------------------------------------------- logging ---

test('logging redacts credential-looking keys at every depth', () => {
  setLogLevel('debug');
  const events = captureLogs(() => {
    log('info', 'calling upstream', {
      providerId: 'provider:demo',
      apiKey: 'sk-live-123',
      Authorization: 'Bearer abc',
      nested: { clientSecret: 'shh', accessToken: 'tok', safe: 'visible' },
      list: [{ password: 'hunter2' }],
    });
  });
  assert.equal(events.length, 1);
  const event = events[0]!;
  assert.equal(event.providerId, 'provider:demo');
  assert.equal(event.apiKey, REDACTED);
  assert.equal(event.Authorization, REDACTED);
  const nested = event.nested as Record<string, unknown>;
  assert.equal(nested.clientSecret, REDACTED);
  assert.equal(nested.accessToken, REDACTED);
  assert.equal(nested.safe, 'visible');
  const list = event.list as Record<string, unknown>[];
  assert.equal(list[0]!.password, REDACTED);
  assert.ok(!JSON.stringify(events).includes('sk-live-123'));
  assert.ok(!JSON.stringify(events).includes('hunter2'));
  resetLogLevel();
  setLogLevel('error');
});

test('captureLogs buffers instead of writing, and keeps scope + level fields', () => {
  setLogLevel('debug');
  const events = captureLogs(() => {
    logger('sentinel').warn('provider slow', { latencyMs: 4000 });
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.level, 'warn');
  assert.equal(events[0]!.scope, 'sentinel');
  assert.equal(events[0]!.msg, 'provider slow');
  assert.equal(events[0]!.latencyMs, 4000);
  assert.equal(typeof events[0]!.at, 'string');
  setLogLevel('error');
});

test('log level filters everything below the threshold', () => {
  setLogLevel('warn');
  const events = captureLogs(() => {
    log('debug', 'noise');
    log('info', 'chatter');
    log('warn', 'kept');
    log('error', 'kept too');
  });
  assert.deepEqual(events.map((e) => e.msg), ['kept', 'kept too']);
  setLogLevel('error');
});

// ----------------------------------------------------------------- drift ---

test('the first fingerprint is a baseline, a different one is drift, a known one is not', () => {
  const db = makeDb();
  const provider = stubProvider({ id: 'provider:drifty' });
  ensureProviderRow(db, provider);

  const shapeA = '{id:string,name:string}';
  const shapeB = '{id:string,label:string,name:string}';

  // baseline
  const first = detectDrift(db, provider.id, shapeA);
  assert.equal(first.drifted, false);
  assert.equal(first.knownCount, 0);
  assert.equal(first.previous, null);
  const recorded = recordFingerprint(db, provider.id, shapeA);
  assert.equal(recorded.isNew, true);
  assert.equal(recorded.knownCount, 1);

  // re-seeing a known shape is not drift
  const again = detectDrift(db, provider.id, shapeA);
  assert.equal(again.drifted, false);
  const rerecorded = recordFingerprint(db, provider.id, shapeA);
  assert.equal(rerecorded.isNew, false);
  assert.equal(rerecorded.knownCount, 1, 'a re-seen shape must not add a row');

  // a different shape is drift
  const drift = detectDrift(db, provider.id, shapeB);
  assert.equal(drift.drifted, true);
  assert.equal(drift.previous, shapeA);
  assert.equal(drift.knownCount, 1);
  recordFingerprint(db, provider.id, shapeB);
  assert.equal(listFingerprints(db, provider.id).length, 2);

  // and going back to a shape we already know is a flap, not drift
  assert.equal(detectDrift(db, provider.id, shapeA).drifted, false);
  db.close();
});

test('fingerprintDiff reports top-level added and removed keys through nesting', () => {
  const a = '{address:{city:string,zip:string},id:string,name:string}';
  const b = '{address:{city:string,country:string},id:string,rating:number}';
  const diff = fingerprintDiff(a, b);
  assert.deepEqual(diff.added, ['rating']);
  assert.deepEqual(diff.removed, ['name']);

  // array wrappers unwrap to the item shape
  const arrayDiff = fingerprintDiff('[{a:string,b:string}]', '[{a:string,c:number}]');
  assert.deepEqual(arrayDiff.added, ['c']);
  assert.deepEqual(arrayDiff.removed, ['b']);

  // non-object shapes are handled, not thrown at
  assert.deepEqual(fingerprintDiff('string', 'null'), { added: [], removed: [] });
  assert.deepEqual(fingerprintDiff('', '{a:string}'), { added: ['a'], removed: [] });
});

// ------------------------------------------------------------- incidents ---

test('latencyStatus honours the budget and critical boundaries', () => {
  assert.equal(latencyStatus(0), 'up');
  assert.equal(latencyStatus(LATENCY_BUDGET_MS - 1), 'up');
  assert.equal(latencyStatus(LATENCY_BUDGET_MS), 'degraded');
  assert.equal(latencyStatus(LATENCY_CRITICAL_MS - 1), 'degraded');
  assert.equal(latencyStatus(LATENCY_CRITICAL_MS), 'down');
  assert.equal(latencyStatus(LATENCY_CRITICAL_MS + 5000), 'down');
  assert.equal(latencyStatus(null), 'unconfigured');
});

test('three consecutive down checks open exactly one incident, and recovery closes it', async () => {
  const db = makeDb();
  let down = true;
  const provider = stubProvider({
    id: 'provider:flaky',
    healthFn: () => ({
      providerId: 'provider:flaky',
      status: down ? 'down' : 'up',
      checkedAt: nowIso(),
      latencyMs: down ? null : 20,
      httpStatus: down ? 503 : 200,
      authOk: true,
      schemaOk: true,
      schemaFingerprint: null,
      error: down ? 'connection refused' : null,
    }),
  });
  const ctx = makeCtx();

  for (let i = 0; i < 3; i += 1) await checkProvider(db, provider, ctx);

  const open = openIncidents(db, provider.id);
  assert.equal(open.length, 1, 'incident lifecycle must be idempotent');
  assert.equal(open[0]!.kind, 'unreachable');
  assert.equal(open[0]!.severity, 'critical');
  const openedAt = open[0]!.openedAt;
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM provider_health_checks')!.n,
    3,
    'every check is still recorded',
  );
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM incidents')!.n, 1);
  assert.equal(openIncidents(db, provider.id)[0]!.openedAt, openedAt, 'openedAt must be stable');

  down = false;
  const recovered = await checkProvider(db, provider, ctx);
  assert.equal(recovered.status, 'up');
  assert.equal(openIncidents(db, provider.id).length, 0, 'recovery closes the open incident');
  const closed = db.get<{ closed_at: string | null }>('SELECT closed_at FROM incidents LIMIT 1');
  assert.ok(closed && closed.closed_at !== null);
  db.close();
});

test('checkProvider opens drift and latency incidents, and openIncident/closeIncident dedup by hand', async () => {
  const db = makeDb();
  let fingerprint = '{id:string,name:string}';
  const provider = stubProvider({
    id: 'provider:slow',
    healthFn: () => ({
      providerId: 'provider:slow',
      status: 'degraded',
      checkedAt: nowIso(),
      latencyMs: LATENCY_BUDGET_MS + 500,
      httpStatus: 200,
      authOk: true,
      schemaOk: true,
      schemaFingerprint: fingerprint,
      error: null,
    }),
  });
  const ctx = makeCtx();

  await checkProvider(db, provider, ctx);
  let kinds = openIncidents(db, provider.id).map((i) => i.kind);
  assert.deepEqual(kinds, ['latency_regression'], 'the baseline fingerprint is not drift');

  fingerprint = '{id:string,title:string}';
  await checkProvider(db, provider, ctx);
  kinds = openIncidents(db, provider.id).map((i) => i.kind).sort();
  assert.deepEqual(kinds, ['latency_regression', 'schema_drift']);
  const drift = openIncidents(db, provider.id).find((i) => i.kind === 'schema_drift')!;
  assert.equal(drift.severity, 'warning');
  assert.match(drift.detail, /title/);

  // manual dedup: a second open for the same (provider, kind) returns the same id
  const idA = openIncident(db, provider.id, 'rate_limited', 'warning', '429 from upstream');
  const idB = openIncident(db, provider.id, 'rate_limited', 'warning', 'still 429');
  assert.equal(idA, idB);
  assert.equal(closeIncident(db, idA), true);
  assert.equal(closeIncident(db, idA), false, 'closing twice is a no-op');
  db.close();
});

test('an auth failure becomes an auth_failure incident and a provider that throws is not fatal', async () => {
  const db = makeDb();
  const ctx = makeCtx();
  const badAuth = stubProvider({
    id: 'provider:noauth',
    health: { status: 'degraded', authOk: false, error: '401 unauthorized' },
  });
  await checkProvider(db, badAuth, ctx);
  assert.deepEqual(openIncidents(db, badAuth.id).map((i) => i.kind), ['auth_failure']);

  const thrower = stubProvider({
    id: 'provider:throws',
    healthFn: () => {
      throw new Error('socket hang up');
    },
  });
  const health = await checkProvider(db, thrower, ctx);
  assert.equal(health.status, 'down');
  assert.match(String(health.error), /socket hang up/);
  assert.ok(openIncidents(db, thrower.id).some((i) => i.kind === 'unreachable'));
  db.close();
});

test('an unconfigured provider is recorded but raises no incident', async () => {
  const db = makeDb();
  const provider = stubProvider({
    id: 'provider:unset',
    configured: false,
    health: { status: 'unconfigured', authOk: false, latencyMs: null, httpStatus: null, error: 'no credentials' },
  });
  await checkProvider(db, provider, makeCtx());
  assert.equal(openIncidents(db, provider.id).length, 0);
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM provider_health_checks')!.n, 1);
  db.close();
});

// -------------------------------------------------------------- failover ---

test('orderByPreference is deterministic: configured, then authority, then id', () => {
  const ctx = makeCtx();
  const providers = [
    stubProvider({ id: 'provider:c', authority: 0.7 }),
    stubProvider({ id: 'provider:a', authority: 0.7 }),
    stubProvider({ id: 'provider:top', authority: 0.95 }),
    stubProvider({ id: 'provider:unconfigured', authority: 0.99, configured: false }),
  ];
  const once = orderByPreference(providers, ctx).map((p) => p.id);
  const twice = orderByPreference([...providers].reverse(), ctx).map((p) => p.id);
  assert.deepEqual(once, ['provider:top', 'provider:a', 'provider:c', 'provider:unconfigured']);
  assert.deepEqual(once, twice, 'order must not depend on input order');
  // Without a context nothing can be asked whether it is configured.
  assert.deepEqual(orderByPreference(providers).map((p) => p.id), [
    'provider:unconfigured',
    'provider:top',
    'provider:a',
    'provider:c',
  ]);
});

test('withFailover falls through to the next provider and flags the answer degraded', async () => {
  const db = makeDb();
  const first = stubProvider({ id: 'provider:first', authority: 0.95 });
  const second = stubProvider({ id: 'provider:second', authority: 0.8 });
  const result = await withFailover(db, [second, first], makeCtx(), async (p) =>
    p.id === first.id ? err<string>('upstream_unavailable', '503') : ok(`answer from ${p.id}`),
  );
  assert.ok(result.ok);
  assert.equal(result.value.providerId, 'provider:second');
  assert.equal(result.value.value, 'answer from provider:second');
  assert.equal(result.value.degraded, true);
  assert.ok(result.value.attempts.length >= 1);
  assert.ok(result.value.attempts.every((a) => a.providerId === 'provider:first'));
  assert.equal(result.value.attempts[0]!.error?.kind, 'upstream_unavailable');
  db.close();
});

test('withFailover does not retry upstream_auth or not_configured on the same provider', async () => {
  const db = makeDb();
  const authFail = stubProvider({ id: 'provider:auth', authority: 0.95 });
  const unconfigured = stubProvider({ id: 'provider:noconf', authority: 0.9 });
  const good = stubProvider({ id: 'provider:good', authority: 0.5 });
  let calls = 0;
  const result = await withFailover(db, [good, authFail, unconfigured], makeCtx(), async (p) => {
    calls += 1;
    if (p.id === authFail.id) return err<string>('upstream_auth', 'token expired');
    if (p.id === unconfigured.id) return err<string>('not_configured', 'no api key');
    return ok('fallback answer');
  });
  assert.ok(result.ok);
  assert.equal(result.value.providerId, 'provider:good');
  assert.equal(calls, 3, 'each failing provider is tried exactly once, then we move on');
  assert.deepEqual(
    result.value.attempts.map((a) => a.error?.kind),
    ['upstream_auth', 'not_configured'],
  );
  assert.equal(result.value.degraded, true);
  db.close();
});

test('withFailover returns the last error with every attempt in its detail', async () => {
  const db = makeDb();
  const a = stubProvider({ id: 'provider:a1', authority: 0.9 });
  const b = stubProvider({ id: 'provider:b1', authority: 0.8 });
  const result = await withFailover(db, [a, b], makeCtx(), async (p) =>
    p.id === a.id ? err<string>('upstream_auth', 'bad token') : err<string>('timeout', 'took too long'),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, 'timeout', 'the LAST error is returned');
  const attempts = result.error.detail?.attempts as { providerId: string; kind: string }[];
  assert.equal(attempts.length, 3, 'auth tried once, timeout retried once');
  assert.deepEqual(attempts.map((x) => x.providerId), ['provider:a1', 'provider:b1', 'provider:b1']);
  assert.deepEqual(result.error.detail?.chain, ['provider:a1', 'provider:b1']);

  const empty = await withFailover(db, [], makeCtx(), async () => ok('never'));
  assert.equal(empty.ok, false);
  db.close();
});

// ------------------------------------------------------------- staleness ---

test('detectStaleData finds aged cache entries and sources that stopped updating', () => {
  const db = makeDb();
  const provider = stubProvider({ id: 'provider:feed' });
  ensureProviderRow(db, provider);

  freezeClock('2026-08-19T12:00:00.000Z');
  const twoHoursAgo = '2026-08-19T10:00:00.000Z';
  const justNow = '2026-08-19T11:59:00.000Z';
  const insert =
    'INSERT INTO live_data_cache (cache_key, provider_id, tier, value_json, fetched_at, expires_at, hash, stale) VALUES (?,?,?,?,?,?,?,0)';
  // live tier goes stale after 30 minutes
  db.run(insert, 'key:old', provider.id, 'live', '{}', twoHoursAgo, twoHoursAgo, canonicalHash({ a: 1 }));
  db.run(insert, 'key:fresh', provider.id, 'live', '{}', justNow, '2026-08-19T12:05:00.000Z', canonicalHash({ a: 2 }));
  // base tier is allowed to sit still for months
  db.run(insert, 'key:base', provider.id, 'base', '{}', '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', canonicalHash({ a: 3 }));

  db.run(
    `INSERT INTO sources (id, name, source_class, authority, homepage, region_scope, freshness_tier, enabled)
     VALUES (?,?,?,?,?,?,?,1)`,
    'source:silent', 'Silent Feed', 'official', 0.95, null, '[]', 'live',
  );
  db.run(
    `INSERT INTO source_records (id, source_id, entity_type, entity_id, field, value_json, observed_at, content_hash)
     VALUES (?,?,?,?,?,?,?,?)`,
    'record:1', 'source:silent', 'place', 'place:demo', 'openingHours', '"09:00"',
    '2026-08-14T12:00:00.000Z', canonicalHash({ v: 1 }),
  );

  const report = detectStaleData(db);
  assert.equal(report.staleCacheEntries, 1, 'only the aged live entry is stale');
  assert.equal(report.staleSources.length, 1);
  assert.equal(report.staleSources[0]!.sourceId, 'source:silent');
  assert.equal(report.staleSources[0]!.field, 'openingHours');
  assert.equal(report.staleSources[0]!.ageDays, 5);

  // an explicit `now` in the past makes nothing stale
  const earlier = detectStaleData(db, '2026-08-19T10:10:00.000Z');
  assert.equal(earlier.staleCacheEntries, 0);

  unfreezeClock();
  db.close();
});

// ---------------------------------------------------------- system health ---

test('systemHealth does not throw on a freshly migrated empty database', () => {
  const db = makeDb();
  let health = systemHealth(db);
  assert.doesNotThrow(() => systemHealth(db));
  assert.deepEqual(
    health.subsystems.map((s) => s.name),
    ['database', 'travel_graph', 'truth_layer', 'radar', 'freshness', 'rewards'],
  );
  assert.equal(health.providers.length, 0);
  assert.equal(health.openIncidents, 0);
  assert.equal(health.latencyBudgetMs, LATENCY_BUDGET_MS);
  const database = health.subsystems.find((s) => s.name === 'database')!;
  assert.equal(database.status, 'up', 'the schema itself is fine');
  for (const subsystem of health.subsystems.filter((s) => s.name !== 'database')) {
    assert.equal(subsystem.status, 'degraded', `${subsystem.name} must degrade, not fail`);
    assert.ok(subsystem.detail.length > 0);
  }
  assert.equal(health.status, 'degraded');
  assert.equal(isHealthy(health), true, 'an empty dev database is not a failing one');
  assert.match(healthSummaryLine(health), /DEGRADED/);

  // Unpolled providers show up as unconfigured, which does not fail the report.
  health = systemHealth(db, { providers: [stubProvider({ id: 'provider:never-polled' })] });
  assert.equal(health.providers.length, 1);
  assert.equal(health.providers[0]!.status, 'unconfigured');
  assert.equal(health.status, 'degraded');
  db.close();
});

test('systemHealth reports the latest stored check per provider and counts open incidents', async () => {
  const db = makeDb();
  const ctx = makeCtx();
  let status: ProviderHealth['status'] = 'down';
  const provider = stubProvider({
    id: 'provider:reported',
    kind: 'weather',
    healthFn: () => ({
      providerId: 'provider:reported',
      status,
      checkedAt: nowIso(),
      latencyMs: status === 'down' ? null : 45,
      httpStatus: status === 'down' ? 500 : 200,
      authOk: true,
      schemaOk: status !== 'down',
      schemaFingerprint: null,
      error: status === 'down' ? 'boom' : null,
    }),
  });

  freezeClock('2026-08-19T09:00:00.000Z');
  await checkProvider(db, provider, ctx);
  assert.equal(systemHealth(db).providers[0]!.status, 'down');
  assert.equal(systemHealth(db).openIncidents, 1);
  assert.equal(isHealthy(systemHealth(db)), false, 'a down provider fails the report');

  freezeClock('2026-08-19T10:00:00.000Z');
  status = 'up';
  await checkProvider(db, provider, ctx);
  const health = systemHealth(db);
  assert.equal(health.providers.length, 1, 'one row per provider: the latest');
  assert.equal(health.providers[0]!.status, 'up');
  assert.equal(health.providers[0]!.kind, 'weather');
  assert.equal(health.providers[0]!.latencyMs, 45);
  assert.equal(health.openIncidents, 0);
  unfreezeClock();
  db.close();
});

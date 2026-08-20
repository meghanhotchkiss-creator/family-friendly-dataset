import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi, listen, replyFromResult, type Route } from '../../scout/api/server.ts';
import { ok, err } from '../../scout/contracts/index.ts';

const routes: Route[] = [
  { method: 'GET', path: '/ping', description: 'ping', handler: () => ({ status: 200, body: { pong: true } }) },
  { method: 'GET', path: '/boom', description: 'throws', handler: () => { throw new Error('kaboom') } },
  { method: 'POST', path: '/echo', description: 'echo', handler: (req) => ({ status: 200, body: req.body }) },
  { method: 'GET', path: '/q', description: 'query', handler: (req) => ({ status: 200, body: req.query }) },
];

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const server = createApi(routes);
  const port = await listen(server, 0);
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test('serves a route and reports response time', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/ping`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { pong: true });
    assert.ok(res.headers.get('x-response-time-ms') !== null);
  });
});

test('root lists the route table', async () => {
  await withServer(async (base) => {
    const body = (await (await fetch(`${base}/`)).json()) as { service: string; routes: unknown[] };
    assert.equal(body.service, 'scout');
    assert.equal(body.routes.length, routes.length);
  });
});

test('unknown route is 404, not a crash', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error: string }).error, 'not_found');
  });
});

test('a throwing handler becomes a 500 rather than killing the server', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/boom`);
    assert.equal(res.status, 500);
    assert.equal(((await res.json()) as { message: string }).message, 'kaboom');
    // server still alive
    assert.equal((await fetch(`${base}/ping`)).status, 200);
  });
});

test('parses JSON bodies and query strings', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/echo`, {
      method: 'POST',
      body: JSON.stringify({ a: 1 }),
      headers: { 'content-type': 'application/json' },
    });
    assert.deepEqual(await res.json(), { a: 1 });

    const q = await (await fetch(`${base}/q?city=city:us-ca-san-francisco&limit=3`)).json();
    assert.deepEqual(q, { city: 'city:us-ca-san-francisco', limit: '3' });
  });
});

test('replyFromResult maps every ErrorKind onto a sensible status', () => {
  assert.equal(replyFromResult(ok({ a: 1 })).status, 200);
  assert.equal(replyFromResult(ok({}), 201).status, 201);
  const cases: [Parameters<typeof err>[0], number][] = [
    ['not_found', 404], ['invalid_input', 400], ['conflict', 409],
    ['upstream_auth', 502], ['upstream_rate_limited', 429], ['timeout', 504],
    ['not_configured', 501], ['upstream_unavailable', 503], ['internal', 500],
    ['upstream_schema_drift', 500], ['stale_data', 500],
  ];
  for (const [kind, status] of cases) {
    assert.equal(replyFromResult(err(kind, 'x')).status, status, `${kind} -> ${status}`);
  }
});

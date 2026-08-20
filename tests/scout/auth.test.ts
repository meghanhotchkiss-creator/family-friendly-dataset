/**
 * Source authentication. Credentials are named in the spec and read from the
 * environment; a spec is a committed file and a committed file is the wrong
 * place for a password.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authHeaders, isAuthConfigured, describeAuth, clearAuthCache, type AuthSpec,
} from '../../scout/sourcemesh/auth.ts';
import { loadSpecs } from '../../scout/sourcemesh/registry.ts';
import type { Transport } from '../../scout/contracts/index.ts';

function stub(responses: { status: number; body: string }[]): Transport & { calls: number } {
  let calls = 0;
  return {
    mode: 'fixture',
    get calls() { return calls; },
    async request() {
      const r = responses[Math.min(calls, responses.length - 1)]!;
      calls += 1;
      return { ok: true as const, value: { ...r, headers: {}, replayed: true, latencyMs: 1 } };
    },
  } as Transport & { calls: number };
}

const jwtAuth: AuthSpec = {
  type: 'jwt_login',
  loginUrl: 'https://auth.example.test/v1/login',
  usernameEnv: 'TEST_WME_USER',
  passwordEnv: 'TEST_WME_PASS',
  tokenPath: 'access_token',
  expiresInPath: 'expires_in',
};

test('no credentials means unconfigured, not an outage', async () => {
  delete process.env.TEST_WME_USER;
  delete process.env.TEST_WME_PASS;
  clearAuthCache();

  assert.equal(isAuthConfigured(jwtAuth), false);
  const result = await authHeaders('t', jwtAuth, stub([{ status: 200, body: '{}' }]));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.kind, 'not_configured',
    'a missing key must never look like a broken upstream');
});

test('an anonymous source needs no headers', async () => {
  const result = await authHeaders('t', { type: 'none' }, stub([{ status: 200, body: '{}' }]));
  assert.ok(result.ok);
  assert.deepEqual(result.value, {});
  assert.equal(isAuthConfigured(undefined), true);
});

test('a static key is sent in the declared header and scheme', async () => {
  process.env.TEST_KEY = 'k-123';
  const bearer = await authHeaders('t', { type: 'bearer', tokenEnv: 'TEST_KEY' }, stub([{ status: 200, body: '{}' }]));
  assert.ok(bearer.ok);
  assert.deepEqual(bearer.value, { authorization: 'Bearer k-123' });

  const raw = await authHeaders('t', { type: 'api_key', tokenEnv: 'TEST_KEY', header: 'X-Api-Key', scheme: '' }, stub([{ status: 200, body: '{}' }]));
  assert.ok(raw.ok);
  assert.deepEqual(raw.value, { 'x-api-key': 'k-123' });
  delete process.env.TEST_KEY;
});

test('jwt login exchanges credentials once and reuses the token', async () => {
  process.env.TEST_WME_USER = 'user';
  process.env.TEST_WME_PASS = 'pass';
  clearAuthCache();

  const transport = stub([{ status: 200, body: JSON.stringify({ access_token: 'jwt-abc', expires_in: 3600 }) }]);
  const first = await authHeaders('wme', jwtAuth, transport);
  assert.ok(first.ok);
  assert.deepEqual(first.value, { authorization: 'Bearer jwt-abc' });
  assert.equal(transport.calls, 1);

  // Re-authenticating per request is how a login endpoint gets rate limited.
  const second = await authHeaders('wme', jwtAuth, transport);
  assert.ok(second.ok);
  assert.equal(transport.calls, 1, 'the cached token must be reused');

  clearAuthCache();
  delete process.env.TEST_WME_USER;
  delete process.env.TEST_WME_PASS;
});

test('a rejected login is upstream_auth, and a malformed one is schema drift', async () => {
  process.env.TEST_WME_USER = 'user';
  process.env.TEST_WME_PASS = 'wrong';
  clearAuthCache();

  const rejected = await authHeaders('wme', jwtAuth, stub([{ status: 401, body: '{"error":"bad"}' }]));
  assert.equal(rejected.ok === false && rejected.error.kind, 'upstream_auth');

  clearAuthCache();
  const noToken = await authHeaders('wme', jwtAuth, stub([{ status: 200, body: '{"unexpected":1}' }]));
  assert.equal(noToken.ok === false && noToken.error.kind, 'upstream_schema_drift');

  clearAuthCache();
  delete process.env.TEST_WME_USER;
  delete process.env.TEST_WME_PASS;
});

test('no shipped spec embeds a credential', () => {
  for (const spec of loadSpecs(undefined, { includeDemo: true })) {
    const text = JSON.stringify(spec);
    assert.doesNotMatch(text, /"password"\s*:\s*"[^"]+"/i, `${spec.id} embeds a password`);
    if (spec.auth && spec.auth.type !== 'none') {
      // Auth must reference environment variable NAMES, never values.
      assert.ok(
        spec.auth.tokenEnv || (spec.auth.usernameEnv && spec.auth.passwordEnv),
        `${spec.id} declares auth without naming its credential env vars`,
      );
      assert.match(describeAuth(spec.auth), /\$[A-Z_]+/, `${spec.id} should describe env vars`);
    }
  }
});

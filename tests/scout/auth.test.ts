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
import { credentialReport, formatCredentials, capabilityChecks } from '../../scout/sourcemesh/credentials.ts';
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

test('the credential report names variables and never prints values', () => {
  process.env.WME_USERNAME = 'a-real-username';
  process.env.WME_PASSWORD = 'a-real-password';
  process.env.NPS_API_KEY = 'KGAT-style-secret-value';
  try {
    const report = credentialReport();
    const rendered = formatCredentials(report);

    // The whole point: a preflight that leaks the thing it is checking for
    // would be worse than no preflight.
    assert.doesNotMatch(rendered, /a-real-username/);
    assert.doesNotMatch(rendered, /a-real-password/);
    assert.doesNotMatch(rendered, /KGAT-style-secret-value/);

    // It must still be useful: names, and whether they are set.
    assert.match(rendered, /WME_USERNAME/);
    assert.match(rendered, /NPS_API_KEY/);
    const wme = report.find((r) => r.source === 'wikimedia-enterprise');
    assert.equal(wme?.satisfied, true, 'both variables are set, so it is satisfied');
    const nps = report.find((r) => r.source === 'nps');
    assert.equal(nps?.satisfied, true);

    for (const requirement of report) {
      for (const value of [process.env.WME_PASSWORD!, process.env.NPS_API_KEY!]) {
        assert.ok(!JSON.stringify(requirement).includes(value),
          `${requirement.source} carries a credential value in its payload`);
      }
    }
  } finally {
    delete process.env.WME_USERNAME;
    delete process.env.WME_PASSWORD;
    delete process.env.NPS_API_KEY;
  }
});

test('an unsatisfied requirement is reported without inventing one', () => {
  delete process.env.WME_USERNAME;
  delete process.env.WME_PASSWORD;
  const report = credentialReport();
  const wme = report.find((r) => r.source === 'wikimedia-enterprise');
  assert.equal(wme?.satisfied, false);
  assert.deepEqual(wme?.needs, ['WME_USERNAME', 'WME_PASSWORD']);
  assert.ok(wme?.alsoNeeds?.includes('egress'), 'a credential alone is not enough here');
});

/** Set some variables, read the capabilities, and put the environment back. */
function withEnv<T>(vars: Record<string, string>, run: () => T): T {
  const before = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return run();
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const MODEL_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'DEEPSEEK_API_KEY'];
const cleared = (): Record<string, string> =>
  Object.fromEntries(MODEL_KEYS.map((k) => [k, '']));

test('a text-only model provider does not enable Scout Lens', () => {
  // The failure this exists to catch: every key the deployment holds is valid,
  // every check for a set variable passes, and photo reading silently cannot
  // work because the one provider configured has no vision.
  const capability = withEnv(
    { ...cleared(), SCOUT_EXTERNAL_MODELS: '1', DEEPSEEK_API_KEY: 'sk-not-a-real-key' },
    () => capabilityChecks(credentialReport()),
  );
  const text = capability.find((c) => c.name === 'text generation');
  const lens = capability.find((c) => c.name.startsWith('Scout Lens'));

  assert.equal(text?.available, true, 'DeepSeek can generate text');
  assert.equal(lens?.available, false, 'DeepSeek cannot read a photo');
  assert.match(lens?.detail ?? '', /text only/);
});

test('a vision provider enables Scout Lens, but only behind the external-models switch', () => {
  const withoutSwitch = withEnv(
    { ...cleared(), SCOUT_EXTERNAL_MODELS: '', ANTHROPIC_API_KEY: 'sk-not-a-real-key' },
    () => capabilityChecks(credentialReport()),
  );
  assert.equal(withoutSwitch.find((c) => c.name.startsWith('Scout Lens'))?.available, false);
  assert.equal(withoutSwitch.find((c) => c.name === 'text generation')?.available, false,
    'a key without the switch buys nothing');

  const withSwitch = withEnv(
    { ...cleared(), SCOUT_EXTERNAL_MODELS: '1', ANTHROPIC_API_KEY: 'sk-not-a-real-key' },
    () => capabilityChecks(credentialReport()),
  );
  assert.equal(withSwitch.find((c) => c.name.startsWith('Scout Lens'))?.available, true);
});

test('email needs a sender address and at least one of the two vendors', () => {
  const only = (vars: Record<string, string>): boolean =>
    withEnv({ EMAIL_FROM: '', RESEND_API_KEY: '', SENDGRID_API_KEY: '', ...vars }, () =>
      credentialReport().find((r) => r.source === 'email')?.satisfied ?? false);

  assert.equal(only({ RESEND_API_KEY: 'k' }), false, 'a vendor without a from-address is not enough');
  assert.equal(only({ EMAIL_FROM: 'hi@example.test' }), false, 'a from-address without a vendor is not enough');
  assert.equal(only({ EMAIL_FROM: 'hi@example.test', RESEND_API_KEY: 'k' }), true);
  assert.equal(only({ EMAIL_FROM: 'hi@example.test', SENDGRID_API_KEY: 'k' }), true,
    'either vendor satisfies it');
});

test('platform credentials are reported without their values, like every other kind', () => {
  const secret = 'sk_live_this_would_be_a_real_stripe_key';
  const rendered = withEnv(
    { STRIPE_SECRET_KEY: secret, DATABASE_URL: 'postgres://user:hunter2@host/db' },
    () => formatCredentials(credentialReport()),
  );
  assert.doesNotMatch(rendered, /sk_live_/);
  assert.doesNotMatch(rendered, /hunter2/);
  assert.match(rendered, /STRIPE_SECRET_KEY/);
  assert.match(rendered, /DATABASE_URL/);
});

test('the report says the platform list is second-hand rather than implying it was read', () => {
  // It was transcribed from a message, not from config.py, which this session
  // cannot open. Saying so is the difference between a report and a guess.
  const rendered = formatCredentials(credentialReport());
  assert.match(rendered, /config\.py/);
  assert.match(rendered, /unverified/);
});

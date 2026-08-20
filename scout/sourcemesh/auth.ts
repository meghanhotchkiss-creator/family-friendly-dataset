/**
 * Source authentication.
 *
 * Every source so far has been anonymous, which is not what commercial feeds
 * look like. Wikimedia Enterprise exchanges a username and password for a JWT
 * and then expects it as a bearer token; others want a static API key. Both are
 * declared in the spec, so adding an authenticated source stays a config change.
 *
 * Credentials themselves are NEVER in the spec. The spec names an environment
 * variable and the value is read at run time -- a spec is a committed file, and
 * a committed file is the wrong place for a password.
 */

import type { Transport, Result } from '../contracts/index.ts';
import { ok, err } from '../contracts/index.ts';
import { nowIso } from '../runtime/clock.ts';
import { readPath } from './spec.ts';

export const AUTH_TYPES = ['none', 'api_key', 'bearer', 'jwt_login'] as const;
export type AuthType = (typeof AUTH_TYPES)[number];

export interface AuthSpec {
  type: AuthType;
  /** Env var holding a static key or token. */
  tokenEnv?: string;
  /** Header the credential is sent in. Defaults to Authorization. */
  header?: string;
  /** Prefix, e.g. "Bearer". Empty for a raw API key header. */
  scheme?: string;

  /** jwt_login only: where to exchange credentials. */
  loginUrl?: string;
  usernameEnv?: string;
  passwordEnv?: string;
  /** Dotted path to the token in the login response. */
  tokenPath?: string;
  /** Dotted path to a lifetime in seconds, if the response carries one. */
  expiresInPath?: string;
}

export interface AuthState {
  headers: Record<string, string>;
  /** Null when the credential does not expire. */
  expiresAt: string | null;
}

/** Tokens are cached per spec id so one login serves a whole run. */
const cache = new Map<string, AuthState>();

export function clearAuthCache(): void {
  cache.clear();
}

function missing(name: string | undefined): boolean {
  return !name || !process.env[name];
}

/**
 * Is this source usable right now? Reported rather than attempted, so a missing
 * credential is `unconfigured` and not a spurious outage.
 */
export function isAuthConfigured(auth: AuthSpec | undefined): boolean {
  if (!auth || auth.type === 'none') return true;
  if (auth.type === 'api_key' || auth.type === 'bearer') return !missing(auth.tokenEnv);
  if (auth.type === 'jwt_login') {
    return !missing(auth.usernameEnv) && !missing(auth.passwordEnv) && Boolean(auth.loginUrl);
  }
  return false;
}

export function describeAuth(auth: AuthSpec | undefined): string {
  if (!auth || auth.type === 'none') return 'anonymous';
  if (auth.type === 'jwt_login') {
    return `jwt_login via ${auth.loginUrl ?? '(no loginUrl)'} using $${auth.usernameEnv}/$${auth.passwordEnv}`;
  }
  return `${auth.type} via $${auth.tokenEnv}`;
}

/**
 * Resolve the headers a request should carry.
 *
 * A jwt_login source performs the exchange once and reuses the token until it
 * expires; re-authenticating per request is how a rate limit gets hit on the
 * login endpoint rather than the data one.
 */
export async function authHeaders(
  specId: string,
  auth: AuthSpec | undefined,
  transport: Transport,
): Promise<Result<Record<string, string>>> {
  if (!auth || auth.type === 'none') return ok({});

  if (!isAuthConfigured(auth)) {
    return err('not_configured', `${specId}: ${describeAuth(auth)} — credentials are not set`, {
      required: [auth.tokenEnv, auth.usernameEnv, auth.passwordEnv].filter(Boolean),
    });
  }

  const header = auth.header ?? 'authorization';
  const scheme = auth.scheme === undefined ? 'Bearer' : auth.scheme;
  const wrap = (value: string) => ({ [header.toLowerCase()]: scheme ? `${scheme} ${value}` : value });

  if (auth.type === 'api_key' || auth.type === 'bearer') {
    return ok(wrap(process.env[auth.tokenEnv!]!));
  }

  const cached = cache.get(specId);
  if (cached && (!cached.expiresAt || Date.parse(cached.expiresAt) > Date.parse(nowIso()) + 30_000)) {
    return ok(cached.headers);
  }

  const response = await transport.request({
    url: auth.loginUrl!,
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      username: process.env[auth.usernameEnv!],
      password: process.env[auth.passwordEnv!],
    }),
  });
  if (!response.ok) return response;

  if (response.value.status === 401 || response.value.status === 403) {
    return err('upstream_auth', `${specId}: login rejected (HTTP ${response.value.status})`, {
      loginUrl: auth.loginUrl,
    });
  }
  if (response.value.status >= 400) {
    return err('upstream_unavailable', `${specId}: login failed (HTTP ${response.value.status})`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(response.value.body);
  } catch (cause) {
    return err('upstream_schema_drift', `${specId}: login response is not JSON`, {}, cause);
  }

  const token = readPath(payload, auth.tokenPath ?? 'access_token');
  if (typeof token !== 'string' || !token) {
    return err('upstream_schema_drift', `${specId}: no token at ${auth.tokenPath ?? 'access_token'}`, {
      keys: payload && typeof payload === 'object' ? Object.keys(payload) : [],
    });
  }

  const expiresIn = auth.expiresInPath ? Number(readPath(payload, auth.expiresInPath)) : NaN;
  const state: AuthState = {
    headers: wrap(token),
    expiresAt: Number.isFinite(expiresIn)
      ? new Date(Date.parse(nowIso()) + expiresIn * 1000).toISOString()
      : null,
  };
  cache.set(specId, state);
  return ok(state.headers);
}

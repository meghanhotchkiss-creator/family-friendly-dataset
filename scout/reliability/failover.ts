/**
 * Provider failover chains.
 *
 * Answering a question with the second-best source beats not answering it, so
 * a chain walks providers in preference order and returns the first success,
 * flagged `degraded` when the winner was not the first choice. Every failure
 * is kept in `attempts` -- an answer that silently came from the fallback is
 * indistinguishable from a healthy system, which is how outages hide.
 *
 * Retry policy is by error kind, not by count:
 *   upstream_auth / not_configured  never retried on the SAME provider (the
 *                                   answer will not change this second), but
 *                                   they do fall through to the next one
 *   retryable kinds                 one extra try on the same provider
 *   everything else                 one try, then move on
 */

import type { Db } from '../db/index.ts';
import type { Provider, ProviderContext, Result, ScoutError, ErrorKind } from '../contracts/index.ts';
import { ok, err, isRetryable } from '../contracts/index.ts';
import { ensureProviderRow, openIncident } from './sentinel.ts';
import { logger } from './logging.ts';

const log = logger('failover');

/** Extra attempts on the same provider for kinds where retrying can help. */
export const MAX_TRIES_PER_PROVIDER = 2;

export interface FailoverAttempt {
  providerId: string;
  error?: ScoutError;
}

export interface FailoverResult<T> {
  value: T;
  providerId: string;
  attempts: FailoverAttempt[];
  degraded: boolean;
}

/**
 * Deterministic preference order: configured first, then most authoritative,
 * then id. `ctx` is optional -- without it nothing can be asked whether it is
 * configured, so the ordering falls back to authority and id alone (still
 * stable, still deterministic).
 */
export function orderByPreference(providers: Provider[], ctx?: ProviderContext): Provider[] {
  const configured = new Map<string, boolean>();
  for (const p of providers) {
    let isConfigured = true;
    if (ctx) {
      try {
        isConfigured = p.isConfigured(ctx);
      } catch {
        isConfigured = false;
      }
    }
    configured.set(p.id, isConfigured);
  }
  return [...providers].sort((a, b) => {
    const ca = configured.get(a.id) === true ? 0 : 1;
    const cb = configured.get(b.id) === true ? 0 : 1;
    if (ca !== cb) return ca - cb;
    if (b.authority !== a.authority) return b.authority - a.authority;
    return a.id.localeCompare(b.id);
  });
}

/** Error kinds that must not be retried against the same provider. */
export function isTerminalForProvider(kind: ErrorKind): boolean {
  return kind === 'upstream_auth' || kind === 'not_configured';
}

/** Best-effort incident bookkeeping. A DB problem must never break a fetch. */
function noteFailure(db: Db, provider: Provider, error: ScoutError): void {
  try {
    if (error.kind === 'not_configured') return;
    const map: Partial<Record<ErrorKind, { kind: 'unreachable' | 'auth_failure' | 'rate_limited' | 'schema_drift'; severity: 'warning' | 'critical' }>> = {
      upstream_auth: { kind: 'auth_failure', severity: 'critical' },
      upstream_rate_limited: { kind: 'rate_limited', severity: 'warning' },
      upstream_unavailable: { kind: 'unreachable', severity: 'critical' },
      timeout: { kind: 'unreachable', severity: 'critical' },
      upstream_schema_drift: { kind: 'schema_drift', severity: 'warning' },
    };
    const mapped = map[error.kind];
    if (!mapped) return;
    ensureProviderRow(db, provider);
    openIncident(db, provider.id, mapped.kind, mapped.severity, error.message);
  } catch (cause) {
    log.debug('incident bookkeeping skipped', {
      providerId: provider.id,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

/**
 * Try each provider in preference order until one succeeds. On total failure
 * the LAST error is returned, carrying every attempt in its detail so the
 * caller can see the whole chain rather than only its tail.
 */
export async function withFailover<T>(
  db: Db,
  providers: Provider[],
  ctx: ProviderContext,
  call: (p: Provider) => Promise<Result<T>>,
): Promise<Result<FailoverResult<T>>> {
  const ordered = orderByPreference(providers, ctx);
  const attempts: FailoverAttempt[] = [];
  let lastError: ScoutError | null = null;

  if (ordered.length === 0) {
    return err('not_configured', 'no providers in failover chain', { attempts });
  }

  for (const provider of ordered) {
    for (let attempt = 1; attempt <= MAX_TRIES_PER_PROVIDER; attempt += 1) {
      let result: Result<T>;
      try {
        result = await call(provider);
      } catch (cause) {
        result = err<T>(
          'internal',
          `provider ${provider.id} threw: ${cause instanceof Error ? cause.message : String(cause)}`,
          { providerId: provider.id },
          cause,
        );
      }

      if (result.ok) {
        const first = ordered[0];
        const degraded = attempts.length > 0 || (first !== undefined && first.id !== provider.id);
        if (degraded) {
          log.warn('failover served a degraded answer', {
            providerId: provider.id,
            failed: attempts.map((a) => a.providerId),
          });
        }
        return ok({ value: result.value, providerId: provider.id, attempts, degraded });
      }

      lastError = result.error;
      attempts.push({ providerId: provider.id, error: result.error });
      noteFailure(db, provider, result.error);
      log.warn('provider attempt failed', {
        providerId: provider.id,
        kind: result.error.kind,
        message: result.error.message,
        attempt,
      });

      // Auth and configuration failures will not change on a retry; move on.
      if (isTerminalForProvider(result.error.kind)) break;
      if (!isRetryable(result.error)) break;
    }
  }

  const error: ScoutError = lastError ?? {
    kind: 'upstream_unavailable',
    message: 'every provider in the chain failed',
  };
  return err(error.kind, error.message, {
    ...(error.detail ?? {}),
    chain: ordered.map((p) => p.id),
    attempts: attempts.map((a) => ({ providerId: a.providerId, kind: a.error?.kind, message: a.error?.message })),
  }, error.cause);
}

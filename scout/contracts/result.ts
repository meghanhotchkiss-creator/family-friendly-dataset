/**
 * One error and result shape for the whole platform.
 *
 * Every fallible operation returns Result<T> rather than throwing, so failures
 * from a provider, a migration or the truth engine all read the same way and
 * can be logged and counted by one piece of code.
 */

export const ERROR_KINDS = [
  'not_found',
  'invalid_input',
  'conflict',
  'upstream_unavailable',
  'upstream_auth',
  'upstream_rate_limited',
  'upstream_schema_drift',
  'timeout',
  'stale_data',
  'not_configured',
  'internal',
] as const;

export type ErrorKind = (typeof ERROR_KINDS)[number];

export interface ScoutError {
  readonly kind: ErrorKind;
  readonly message: string;
  /** Machine-readable context: provider id, entity id, field, http status... */
  readonly detail?: Record<string, unknown>;
  readonly cause?: unknown;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: ScoutError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T = never>(
  kind: ErrorKind,
  message: string,
  detail?: Record<string, unknown>,
  cause?: unknown,
): Result<T> {
  return { ok: false, error: { kind, message, detail, cause } };
}

/** Unwrap or throw. Only for CLI entry points and tests, never in library code. */
export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  const detail = result.error.detail ? ` ${JSON.stringify(result.error.detail)}` : '';
  throw new Error(`[${result.error.kind}] ${result.error.message}${detail}`);
}

export function isOk<T>(result: Result<T>): result is { ok: true; value: T } {
  return result.ok;
}

/** True when retrying the same call later could plausibly succeed. */
export function isRetryable(error: ScoutError): boolean {
  return (
    error.kind === 'upstream_unavailable' ||
    error.kind === 'upstream_rate_limited' ||
    error.kind === 'timeout'
  );
}

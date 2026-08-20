/**
 * One structured logger for the whole platform.
 *
 * Rules that make this safe to call from anywhere:
 *
 *   - one line of JSON per event, on STDERR, so CLI stdout stays machine
 *     readable (a `--json` CLI can be piped while logging still happens)
 *   - timestamps come from `nowIso()`, so a frozen clock freezes the logs too
 *   - secrets never reach the sink: any field whose KEY looks like a
 *     credential is replaced with '[redacted]' before serialisation, at every
 *     depth. Redaction is on the key, not the value, because we cannot
 *     recognise a secret by looking at it.
 *   - `captureLogs` buffers instead of writing, so tests assert on events
 *     rather than scraping stderr.
 */

import { nowIso } from '../runtime/clock.ts';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogEvent {
  level: LogLevel;
  msg: string;
  at: string;
  [k: string]: unknown;
}

const RANK: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Key names that must never have their values logged. */
export const SECRET_KEY_PATTERN = /key|secret|token|password|authorization/i;
export const REDACTED = '[redacted]';

const RESERVED = new Set(['level', 'msg', 'at']);

let configuredLevel: LogLevel | null = null;

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

function envLevel(): LogLevel {
  const raw = (process.env.SCOUT_LOG_LEVEL ?? '').trim().toLowerCase();
  return isLogLevel(raw) ? raw : 'info';
}

/** Explicit `setLogLevel` wins; otherwise SCOUT_LOG_LEVEL; otherwise 'info'. */
export function currentLogLevel(): LogLevel {
  return configuredLevel ?? envLevel();
}

export function setLogLevel(level: LogLevel): void {
  configuredLevel = level;
}

/** Drop the explicit override and fall back to SCOUT_LOG_LEVEL again. */
export function resetLogLevel(): void {
  configuredLevel = null;
}

export function shouldLog(level: LogLevel): boolean {
  return RANK[level] >= RANK[currentLogLevel()];
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 6) return '…';
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY_PATTERN.test(k) ? REDACTED : redactValue(v, depth + 1);
  }
  return out;
}

/** Redact credential-looking keys at every depth. Exported so callers can pre-scrub. */
export function redact(fields: Record<string, unknown>): Record<string, unknown> {
  return redactValue(fields, 0) as Record<string, unknown>;
}

/** Capture buffers, innermost last. Non-empty means we are inside captureLogs(). */
const buffers: LogEvent[][] = [];

function emit(event: LogEvent): void {
  const target = buffers[buffers.length - 1];
  if (target) {
    target.push(event);
    return;
  }
  let line: string;
  try {
    line = JSON.stringify(event);
  } catch {
    line = JSON.stringify({ level: event.level, msg: event.msg, at: event.at, fields: 'unserialisable' });
  }
  process.stderr.write(`${line}\n`);
}

export function log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;
  const event: LogEvent = { level, msg, at: nowIso() };
  if (fields) {
    for (const [k, v] of Object.entries(redact(fields))) {
      if (!RESERVED.has(k)) event[k] = v;
    }
  }
  emit(event);
}

export interface ScopedLogger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** A logger that stamps every event with `scope`, e.g. logger('sentinel'). */
export function logger(scope: string): ScopedLogger {
  const at = (level: LogLevel) => (msg: string, fields?: Record<string, unknown>) =>
    log(level, msg, { scope, ...(fields ?? {}) });
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/**
 * Run `fn` with logging buffered rather than written. Returns everything that
 * passed the level filter, so tests can assert on level filtering too.
 */
export function captureLogs(fn: () => void): LogEvent[] {
  const buffer: LogEvent[] = [];
  buffers.push(buffer);
  try {
    fn();
  } finally {
    buffers.pop();
  }
  return buffer;
}

/** Same as captureLogs for async work. */
export async function captureLogsAsync(fn: () => Promise<void>): Promise<LogEvent[]> {
  const buffer: LogEvent[] = [];
  buffers.push(buffer);
  try {
    await fn();
  } finally {
    buffers.pop();
  }
  return buffer;
}

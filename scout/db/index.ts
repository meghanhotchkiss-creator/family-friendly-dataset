/**
 * One database handle for the whole platform.
 *
 * Uses node:sqlite so the platform has zero runtime dependencies. The SQL is
 * kept portable (no SQLite-only syntax beyond the pragmas) so the same schema
 * can be pointed at Postgres later.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');
export const DEFAULT_DB_PATH = resolve(REPO_ROOT, 'data', 'processed', 'scout.db');

export type Row = Record<string, unknown>;

export interface Db {
  readonly path: string;
  exec(sql: string): void;
  all<T = Row>(sql: string, ...params: unknown[]): T[];
  get<T = Row>(sql: string, ...params: unknown[]): T | undefined;
  run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number };
  transaction<T>(fn: () => T): T;
  close(): void;
  raw: DatabaseSync;
}

function toParams(params: unknown[]): unknown[] {
  // node:sqlite accepts null/number/string/bigint/Uint8Array. Everything else
  // is stored as JSON text, which keeps the JSON columns honest.
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (typeof p === 'number' || typeof p === 'string' || typeof p === 'bigint') return p;
    if (p instanceof Uint8Array) return p;
    return JSON.stringify(p);
  });
}

export function openDb(path: string = process.env.SCOUT_DB_PATH ?? DEFAULT_DB_PATH): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('PRAGMA busy_timeout = 5000');

  let depth = 0;

  return {
    path,
    raw,
    exec(sql) {
      raw.exec(sql);
    },
    all<T>(sql: string, ...params: unknown[]) {
      return raw.prepare(sql).all(...(toParams(params) as never[])) as T[];
    },
    get<T>(sql: string, ...params: unknown[]) {
      return raw.prepare(sql).get(...(toParams(params) as never[])) as T | undefined;
    },
    run(sql, ...params) {
      const r = raw.prepare(sql).run(...(toParams(params) as never[]));
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    transaction<T>(fn: () => T): T {
      // Nested transactions become savepoints so callers can compose freely.
      const isOuter = depth === 0;
      const name = `sp_${depth}`;
      depth += 1;
      raw.exec(isOuter ? 'BEGIN' : `SAVEPOINT ${name}`);
      try {
        const out = fn();
        raw.exec(isOuter ? 'COMMIT' : `RELEASE ${name}`);
        return out;
      } catch (error) {
        raw.exec(isOuter ? 'ROLLBACK' : `ROLLBACK TO ${name}`);
        throw error;
      } finally {
        depth -= 1;
      }
    },
    close() {
      raw.close();
    },
  };
}

/** Parse a JSON column that may be null. */
export function jsonColumn<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

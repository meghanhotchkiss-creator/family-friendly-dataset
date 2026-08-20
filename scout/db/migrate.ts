/**
 * Migration runner. Applies scout/db/migrations/*.sql in filename order inside
 * a transaction each, recording a checksum so an edited migration is caught
 * rather than silently diverging.
 *
 * A migration whose first line is `-- no-transaction` runs outside one, because
 * `PRAGMA foreign_keys` is ignored while a transaction is open -- and a table
 * rebuild that needs it off for the swap otherwise produces a schema that looks
 * right and is not. Such a migration is responsible for leaving the database
 * consistent on its own.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../runtime/hash.ts';
import { nowIso } from '../runtime/clock.ts';
import type { Db } from './index.ts';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

const NO_TRANSACTION = /^\s*--\s*no-transaction\b/;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
  total: number;
}

export function listMigrations(): { name: string; sql: string; checksum: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
      return { name, sql, checksum: sha256(sql) };
    });
}

export function migrate(db: Db): MigrationResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied: string[] = [];
  const skipped: string[] = [];
  const migrations = listMigrations();

  for (const migration of migrations) {
    const existing = db.get<{ checksum: string }>(
      'SELECT checksum FROM migrations WHERE name = ?',
      migration.name,
    );
    if (existing) {
      if (existing.checksum !== migration.checksum) {
        throw new Error(
          `migration ${migration.name} changed after it was applied ` +
            `(recorded ${existing.checksum.slice(0, 12)}, file ${migration.checksum.slice(0, 12)}). ` +
            'Add a new migration instead of editing an applied one, or run db:reset.',
        );
      }
      skipped.push(migration.name);
      continue;
    }
    const record = (): void => {
      db.run(
        'INSERT INTO migrations (name, checksum, applied_at) VALUES (?, ?, ?)',
        migration.name,
        migration.checksum,
        nowIso(),
      );
    };
    if (NO_TRANSACTION.test(migration.sql)) {
      db.exec(migration.sql);
      record();
    } else {
      db.transaction(() => {
        db.exec(migration.sql);
        record();
      });
    }
    applied.push(migration.name);
  }

  return { applied, skipped, total: migrations.length };
}

export function migrationStatus(db: Db): { name: string; applied: boolean; drifted: boolean }[] {
  const rows = db.all<{ name: string; checksum: string }>('SELECT name, checksum FROM migrations');
  const byName = new Map(rows.map((r) => [r.name, r.checksum]));
  return listMigrations().map((m) => ({
    name: m.name,
    applied: byName.has(m.name),
    drifted: byName.has(m.name) && byName.get(m.name) !== m.checksum,
  }));
}

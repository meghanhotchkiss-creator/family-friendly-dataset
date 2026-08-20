/**
 * Static guard on every INSERT in the codebase.
 *
 * A column list that has drifted from its placeholder list is the one bug this
 * project has shipped twice: adding a column to an INSERT and forgetting the
 * matching `?` binds every value one position to the left, which SQLite accepts
 * silently for TEXT columns. It is invisible in review and invisible at
 * runtime, so it is checked mechanically instead.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../scout/', import.meta.url).pathname;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

/** `(a, b, c)` -> 3, ignoring anything nested in parentheses. */
function countTopLevel(list: string): number {
  let depth = 0;
  let n = 1;
  for (const ch of list) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) n += 1;
  }
  return n;
}

interface Insert { file: string; table: string; columns: number; placeholders: number }

function insertsIn(source: string, file: string): Insert[] {
  const out: Insert[] = [];
  const pattern = /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)\s*\(([^;]*?)\)\s*\n?\s*VALUES\s*\(([^)]*)\)/gi;
  for (const match of source.matchAll(pattern)) {
    const [, table = '', columnList = '', valueList = ''] = match;
    out.push({
      file,
      table,
      columns: countTopLevel(columnList),
      placeholders: countTopLevel(valueList),
    });
  }
  return out;
}

test('every INSERT binds exactly as many values as it names columns', () => {
  const inserts = walk(ROOT).flatMap((file) => insertsIn(readFileSync(file, 'utf8'), file));
  // If the scan finds nothing the guard is vacuous, which is worse than absent.
  assert.ok(inserts.length > 20, `expected to find INSERTs to check, found ${inserts.length}`);

  const wrong = inserts.filter((i) => i.columns !== i.placeholders);
  assert.deepEqual(
    wrong.map((i) => `${i.file.replace(ROOT, '')}: INSERT INTO ${i.table} names ${i.columns} columns but binds ${i.placeholders}`),
    [],
  );
});

test('a freshly migrated database has no dangling foreign key references', async () => {
  const { openDb } = await import('../../scout/db/index.ts');
  const { migrate } = await import('../../scout/db/migrate.ts');
  const db = openDb(':memory:');
  try {
    migrate(db);

    // A table rebuild that renames the original out of the way rewrites every
    // REFERENCES clause pointing at it, leaving foreign keys aimed at a table
    // the same migration then drops. SQLite accepts the schema and only fails
    // later, at the first insert.
    const tables = new Set(
      db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name),
    );
    const dangling: string[] = [];
    for (const table of tables) {
      for (const fk of db.all<{ table: string }>(`PRAGMA foreign_key_list(${table})`)) {
        if (!tables.has(fk.table)) dangling.push(`${table} -> ${fk.table}`);
      }
    }
    assert.deepEqual(dangling, []);
    assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
  } finally {
    db.close();
  }
});

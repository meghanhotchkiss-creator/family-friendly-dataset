/** npm run db:migrate | db:reset | db:status */

import { rmSync } from 'node:fs';
import { openDb, DEFAULT_DB_PATH } from '../db/index.ts';
import { migrate, migrationStatus } from '../db/migrate.ts';

const args = new Set(process.argv.slice(2));
const dbPath = process.env.SCOUT_DB_PATH ?? DEFAULT_DB_PATH;

if (args.has('--reset')) {
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
  console.log(`reset ${dbPath}`);
}

const db = openDb(dbPath);

if (args.has('--status')) {
  const rows = migrationStatus(db);
  for (const row of rows) {
    const state = row.drifted ? 'DRIFTED' : row.applied ? 'applied' : 'pending';
    console.log(`  ${state.padEnd(8)} ${row.name}`);
  }
  const pending = rows.filter((r) => !r.applied).length;
  console.log(`${rows.length} migrations, ${pending} pending`);
  db.close();
  process.exit(rows.some((r) => r.drifted) ? 1 : 0);
}

const result = migrate(db);
for (const name of result.applied) console.log(`  applied  ${name}`);
for (const name of result.skipped) console.log(`  current  ${name}`);

const tables = db.all<{ name: string }>(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
);
console.log(
  `\n${result.applied.length} applied, ${result.skipped.length} already current ` +
    `-> ${tables.length} tables at ${db.path}`,
);
db.close();

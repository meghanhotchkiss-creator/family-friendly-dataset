/**
 * npm run travel:import:geography | :airports | :places | :gtfs | :all
 *
 * Runs the global import framework against whichever transport
 * SCOUT_TRANSPORT selects (fixture by default, network when egress and
 * credentials exist) and prints what landed in the Travel Graph.
 */

import { openDb, DEFAULT_DB_PATH } from '../db/index.ts';
import type { Db } from '../db/index.ts';
import type { Result } from '../contracts/index.ts';
import { importAirports, importAll, importGeography, importGtfs, importPlaces } from '../connectors/import.ts';
import { allProviders, providerContext, registerProvidersInDb } from '../connectors/registry.ts';

const TARGETS = ['geography', 'airports', 'places', 'gtfs', 'all'] as const;
type Target = (typeof TARGETS)[number];

function usage(): never {
  console.error(`usage: travel-import.ts <${TARGETS.join('|')}>`);
  process.exit(1);
}

const target = process.argv[2];
if (!target || !TARGETS.includes(target as Target)) usage();

const dbPath = process.env.SCOUT_DB_PATH ?? DEFAULT_DB_PATH;
const db: Db = openDb(dbPath);

// A clear message beats a raw "no such table" from sqlite.
const schema = db.get<{ name: string }>(
  "SELECT name FROM sqlite_master WHERE type='table' AND name = 'places'",
);
if (!schema) {
  console.error(`no Scout schema at ${dbPath} -- run: npm run db:migrate`);
  db.close();
  process.exit(1);
}

const ctx = providerContext();
console.log(`transport: ${ctx.transport.mode}  db: ${dbPath}`);

const registered = registerProvidersInDb(db);
if (registered.ok) {
  console.log(
    `providers: ${registered.value.providers} registered, ${registered.value.sources} sources ` +
      `(${allProviders().map((p) => p.kind).join(', ')})`,
  );
}

function printCounts(label: string, value: unknown, indent = '  '): void {
  if (value === null || typeof value !== 'object') {
    console.log(`${indent}${label}: ${String(value)}`);
    return;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const flat = entries.every(([, v]) => v === null || typeof v !== 'object');
  if (flat) {
    console.log(`${indent}${label}: ${entries.map(([k, v]) => `${k}=${String(v)}`).join(' ')}`);
    return;
  }
  console.log(`${indent}${label}:`);
  for (const [key, entry] of entries) printCounts(key, entry, `${indent}  `);
}

async function run(): Promise<number> {
  const started = Date.now();
  let result: Result<Record<string, unknown>>;

  switch (target as Target) {
    case 'geography':
      result = await importGeography(db, ctx);
      break;
    case 'airports':
      result = (await importAirports(db, ctx)) as Result<Record<string, unknown>>;
      break;
    case 'places':
      result = await importPlaces(db, ctx);
      break;
    case 'gtfs':
      result = await importGtfs(db, ctx);
      break;
    default:
      result = await importAll(db, ctx);
      break;
  }

  if (!result.ok) {
    console.error(`\nimport ${target} failed [${result.error.kind}] ${result.error.message}`);
    if (result.error.detail) console.error(`  ${JSON.stringify(result.error.detail)}`);
    return 1;
  }

  console.log(`\nimport ${target} ok in ${Date.now() - started}ms`);
  printCounts(target as string, result.value);

  for (const table of ['regions', 'countries', 'cities', 'airports', 'places', 'source_records', 'gtfs_stops']) {
    const row = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
    console.log(`  ${table.padEnd(15)} ${row ? Number(row.n) : 0}`);
  }
  return 0;
}

const code = await run();
db.close();
process.exit(code);

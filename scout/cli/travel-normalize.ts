/** npm run travel:normalize */

import { openDb, DEFAULT_DB_PATH } from '../db/index.ts';
import { normalizePlaces } from '../travel/normalize.ts';
import { lastJobRun } from '../travel/jobs.ts';

const dbPath = process.env.SCOUT_DB_PATH ?? DEFAULT_DB_PATH;
const db = openDb(dbPath);

const result = normalizePlaces(db);

if (!result.ok) {
  console.error(`travel:normalize [${result.error.kind}] ${result.error.message}`);
  if (result.error.detail) console.error(`  detail ${JSON.stringify(result.error.detail)}`);
  db.close();
  process.exit(1);
}

const stats = result.value;
console.log(`travel:normalize on ${db.path}`);
console.log(`  scanned              ${stats.scanned}`);
console.log(`  duplicates merged    ${stats.deduped}`);
console.log(`  enriched             ${stats.enriched}`);
console.log(`  hashes rewritten     ${stats.hashed}`);
console.log(`  neighborhoods linked ${stats.neighborhoodsLinked}`);

if (stats.issues.length > 0) {
  console.log(`\n${stats.issues.length} issue(s):`);
  for (const issue of stats.issues) console.log(`  - ${issue}`);
}

const run = lastJobRun(db, 'travel:normalize');
console.log(`\nrecorded as ${run?.status ?? 'unknown'} at ${run?.finishedAt ?? '-'}`);
db.close();

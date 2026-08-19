/** npm run truth:resolve -- resolve every claimed field and apply the winners. */

import { openDb } from '../db/index.ts';
import { resolveAll } from '../intelligence/truth-engine.ts';

const db = openDb();
const result = resolveAll(db);

if (!result.ok) {
  console.error(`truth:resolve failed [${result.error.kind}] ${result.error.message}`);
  db.close();
  process.exit(1);
}

const { resolved, applied, conflicts, skipped } = result.value;
console.log(`  resolved   ${resolved}`);
console.log(`  applied    ${applied}`);
console.log(`  conflicts  ${conflicts}`);
console.log(`  skipped    ${skipped}  (no column to apply onto)`);
console.log(`\n${resolved} fields resolved, ${applied} written back to entities at ${db.path}`);
db.close();

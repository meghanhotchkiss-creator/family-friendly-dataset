/** npm run graph:user:build [-- --user=<id>] */

import { openDb } from '../db/index.ts';
import { buildUserGraph, rebuildAllUserGraphs } from '../intelligence/user-graph.ts';

const args = process.argv.slice(2);
const userArg = args.find((a) => a.startsWith('--user='));
const userId = userArg ? userArg.slice('--user='.length) : null;

const db = openDb();

if (userId) {
  const result = buildUserGraph(db, userId);
  if (!result.ok) {
    console.error(`graph:user:build failed [${result.error.kind}] ${result.error.message}`);
    db.close();
    process.exit(1);
  }
  const graph = result.value;
  console.log(`${graph.userId}: ${graph.signalCount} signals -> ${graph.preferences.length} preferences`);
  for (const pref of graph.preferences) {
    const sign = pref.weight >= 0 ? '+' : '';
    console.log(
      `  ${pref.dimension.padEnd(22)} ${pref.value.padEnd(24)} ${sign}${pref.weight.toFixed(2)}` +
        `  confidence ${pref.confidence.value.toFixed(2)}  from ${pref.evidenceCount} signal${pref.evidenceCount === 1 ? '' : 's'}`,
    );
  }
  db.close();
} else {
  const result = rebuildAllUserGraphs(db);
  if (!result.ok) {
    console.error(`graph:user:build failed [${result.error.kind}] ${result.error.message}`);
    db.close();
    process.exit(1);
  }
  console.log(
    `rebuilt ${result.value.users} user graph${result.value.users === 1 ? '' : 's'} -> ` +
      `${result.value.preferences} preferences at ${db.path}`,
  );
  db.close();
}

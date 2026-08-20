/** npm run graph:topic:build [-- --discover] */

import { openDb } from '../db/index.ts';
import { buildTopicGraph, discoverCandidates } from '../intelligence/topic-graph.ts';

const args = new Set(process.argv.slice(2));
const discover = args.has('--discover');

const db = openDb();
const result = buildTopicGraph(db, { discover });

if (!result.ok) {
  console.error(`graph:topic:build failed [${result.error.kind}] ${result.error.message}`);
  db.close();
  process.exit(1);
}

const { core, links, candidates, promoted } = result.value;
console.log(`  core topics created  ${core}`);
console.log(`  place-topic links    ${links}`);

if (discover) {
  console.log(`  candidates found     ${candidates}`);
  console.log(`  promoted             ${promoted}`);
  const found = discoverCandidates(db);
  if (found.ok) {
    console.log('\n  top candidate terms');
    for (const candidate of found.value.slice(0, 15)) {
      console.log(
        `    ${candidate.term.padEnd(24)} support ${String(candidate.support.length).padStart(3)}` +
          `  distinctiveness ${candidate.distinctiveness.toFixed(2)}  score ${candidate.score.toFixed(3)}`,
      );
    }
  }
}

const total = db.all<{ status: string; n: number }>(
  'SELECT status, COUNT(*) AS n FROM topics GROUP BY status ORDER BY status',
);
console.log(`\n${total.map((r) => `${r.n} ${r.status}`).join(', ')} topics at ${db.path}`);
db.close();

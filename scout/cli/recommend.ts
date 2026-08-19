/** npm run recommend -- --user=<id> --city=<id> --intent="..." [--limit=n] */

import { openDb } from '../db/index.ts';
import { recommend } from '../intelligence/scoring.ts';

function arg(name: string): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

const userId = arg('user');
const cityId = arg('city');
const intent = arg('intent') ?? '';
const limitArg = arg('limit');
const limit = limitArg ? Number(limitArg) : 10;

if (!userId || !cityId) {
  console.error('usage: recommend --user=<id> --city=<id> [--intent="..."] [--limit=n]');
  process.exit(1);
}

const db = openDb();
const result = recommend(db, { userId, cityId, intent, limit });

if (!result.ok) {
  console.error(`recommend failed [${result.error.kind}] ${result.error.message}`);
  db.close();
  process.exit(1);
}

const response = result.value;
const parsed = response.parsedIntent;
console.log(`intent: "${parsed.raw}"`);
console.log(
  `  understood: familyFriendly=${parsed.familyFriendly} wantsLocal=${parsed.wantsLocal} ` +
    `avoidsTouristy=${parsed.avoidsTouristy}`,
);
if (parsed.topics.length) console.log(`  topics: ${parsed.topics.join(', ')}`);
for (const bias of parsed.dimensionBias) {
  console.log(`  bias: ${bias.dimension}=${bias.value} ${bias.weight > 0 ? '+' : ''}${bias.weight.toFixed(2)}`);
}

console.log(`\n${response.results.length} results\n`);
for (const rec of response.results) {
  console.log(
    `${String(rec.rank).padStart(2)}. ${rec.place.name}  score ${rec.score.toFixed(2)}  ` +
      `facts ${rec.confidence.value.toFixed(2)} (${rec.confidence.observations} source${rec.confidence.observations === 1 ? '' : 's'})`,
  );
  console.log(`    ${rec.explanation}`);
  for (const factor of rec.factors) {
    const sign = factor.contribution >= 0 ? '+' : '';
    console.log(`      ${sign}${factor.contribution.toFixed(2).padStart(6)}  ${factor.label}: ${factor.detail}`);
  }
  console.log('');
}

db.close();

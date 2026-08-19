/**
 * npm run radar:verify [-- --limit=n]
 *
 * Runs the verification workflow over every pending (non-cosmetic, unverified)
 * delta and prints what each method concluded.
 */

import { pathToFileURL } from 'node:url';
import { openDb, DEFAULT_DB_PATH } from '../db/index.ts';
import { listVerifications, pendingDeltas, verifyPending } from '../radar/verify.ts';

function parseLimit(argv: string[]): number {
  for (const arg of argv) {
    if (arg.startsWith('--limit=')) {
      const n = Number(arg.slice('--limit='.length));
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
  }
  return 100;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const limit = parseLimit(argv);
  const db = openDb(process.env.SCOUT_DB_PATH ?? DEFAULT_DB_PATH);
  try {
    const pending = pendingDeltas(db, limit);
    console.log(`radar verify -- ${pending.length} pending delta(s)`);

    const result = await verifyPending(db, { limit });
    if (!result.ok) {
      console.error(`verify failed: [${result.error.kind}] ${result.error.message}`);
      return 1;
    }

    for (const delta of pending) {
      const latest = listVerifications(db, delta.id).at(-1);
      const head = `${delta.kind.padEnd(10)} ${delta.entityId}.${delta.field}`;
      if (!latest) {
        console.log(`  ${head} -- no verification recorded`);
        continue;
      }
      console.log(
        `  ${head}\n      ${latest.method} -> ${latest.outcome}${latest.notes ? ` (${latest.notes})` : ''}`,
      );
    }

    const s = result.value;
    console.log(
      `\n${s.verified} verified, ${s.disputed} disputed, ${s.rejected} rejected, ` +
        `${s.unresolved} still unverified`,
    );
    return 0;
  } finally {
    db.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) process.exit(await main());

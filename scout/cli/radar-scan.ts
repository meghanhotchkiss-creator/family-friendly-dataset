/**
 * npm run radar:scan [-- --limit=n --force]
 *
 * Scans every due watch and reports what each one cost. The line to watch is
 * `conditional hits`: a healthy Radar spends most of its scans on 304s.
 */

import { pathToFileURL } from 'node:url';
import { openDb, DEFAULT_DB_PATH } from '../db/index.ts';
import { scanDue } from '../radar/scan.ts';
import { dueWatches, listWatches } from '../radar/watches.ts';
import { nowIso } from '../runtime/clock.ts';

interface ScanRow {
  id: string;
  watch_id: string;
  entity_id: string;
  status: string;
  http_status: number | null;
  bytes: number | null;
  conditional_hit: number;
  error: string | null;
  deltas: number;
}

function parseArgs(argv: string[]): { limit?: number; force: boolean } {
  let limit: number | undefined;
  let force = false;
  for (const arg of argv) {
    if (arg === '--force') force = true;
    else if (arg.startsWith('--limit=')) {
      const n = Number(arg.slice('--limit='.length));
      if (Number.isFinite(n) && n > 0) limit = Math.floor(n);
    }
  }
  return { limit, force };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { limit, force } = parseArgs(argv);
  const db = openDb(process.env.SCOUT_DB_PATH ?? DEFAULT_DB_PATH);
  try {
    const now = nowIso();
    const candidates = force ? listWatches(db, { enabled: true }) : dueWatches(db, now);
    console.log(
      `radar scan at ${now} -- ${candidates.length} watch(es) ${force ? 'forced' : 'due'}` +
        (limit ? `, limit ${limit}` : ''),
    );

    const before = Number(
      db.get<{ m: number }>('SELECT COALESCE(MAX(rowid), 0) AS m FROM radar_scans')?.m ?? 0,
    );

    const result = await scanDue(db, { limit, force, now });
    if (!result.ok) {
      console.error(`scan failed: [${result.error.kind}] ${result.error.message}`);
      return 1;
    }

    const rows = db.all<ScanRow>(
      `SELECT s.id, s.watch_id, w.entity_id, s.status, s.http_status, s.bytes,
              s.conditional_hit, s.error,
              (SELECT COUNT(*) FROM radar_deltas d WHERE d.scan_id = s.id) AS deltas
       FROM radar_scans s JOIN watches w ON w.id = s.watch_id
       WHERE s.rowid > ? ORDER BY s.rowid`,
      before,
    );

    for (const row of rows) {
      const bits = [
        row.status.padEnd(9),
        String(row.entity_id).padEnd(28),
        row.http_status === null ? '   -' : String(row.http_status).padStart(4),
        Number(row.conditional_hit) === 1 ? '304-hit' : '       ',
        row.bytes === null ? '' : `${row.bytes}B`,
      ];
      if (row.deltas > 0) bits.push(`${row.deltas} delta(s)`);
      if (row.error) bits.push(`! ${row.error}`);
      console.log(`  ${bits.join(' ')}`.trimEnd());
    }

    const s = result.value;
    const hits = rows.filter((r) => Number(r.conditional_hit) === 1).length;
    console.log(
      `\n${s.scanned} scanned: ${s.changed} changed, ${s.unchanged} unchanged, ` +
        `${s.errors} error, ${s.skipped} skipped -- ${s.deltas} delta(s), ${hits} conditional hit(s)`,
    );
    return s.scanned > 0 && s.errors === s.scanned ? 1 : 0;
  } finally {
    db.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) process.exit(await main());

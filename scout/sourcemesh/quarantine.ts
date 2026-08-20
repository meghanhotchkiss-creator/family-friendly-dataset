/**
 * Quarantine: rejected rows are kept, not counted.
 *
 * A rejection reason without the row it applies to cannot be acted on. Every
 * quarantined record retains its source, its own identifier, a machine-readable
 * reason code and the raw record, so a run can be re-driven once a mapping is
 * repaired instead of re-fetched and re-guessed.
 */

import type { Db } from '../db/index.ts';
import { nowIso } from '../runtime/clock.ts';
import { canonicalHash, shortHash } from '../runtime/hash.ts';
import type { RowAccounting } from './accounting.ts';
import type { SinkRejection } from './sink.ts';
import type { ValidationRejection } from './adapter.ts';

const RAW_CAP = 4000;

export function quarantineRecords(
  db: Db,
  runId: string,
  sourceId: string,
  rejections: (SinkRejection | ValidationRejection)[],
  stage: 'validate' | 'persist' = 'persist',
): number {
  let n = 0;
  db.transaction(() => {
    for (const [index, rejection] of rejections.entries()) {
      const raw = JSON.stringify(rejection.record.raw).slice(0, RAW_CAP);
      db.run(
        `INSERT INTO quarantine (id, run_id, source_id, source_record_id, stage, reason_code,
           details, raw_record, raw_record_hash, quarantined_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO NOTHING`,
        `${runId}_${stage[0]}${index}`, runId, sourceId,
        rejection.record.identity || null, stage, rejection.reasonCode,
        rejection.details, raw, canonicalHash(rejection.record.raw), nowIso(),
      );
      n += 1;
    }
  });
  return n;
}

export function quarantineSummary(db: Db, runId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of db.all<{ reason_code: string; n: number }>(
    'SELECT reason_code, COUNT(*) n FROM quarantine WHERE run_id = ? GROUP BY reason_code ORDER BY n DESC',
    runId,
  )) {
    out[row.reason_code] = Number(row.n);
  }
  return out;
}

export interface QuarantineRow {
  id: string; sourceRecordId: string | null; reasonCode: string;
  details: string | null; rawRecord: string; quarantinedAt: string;
}

export function listQuarantine(db: Db, sourceId: string, limit = 10): QuarantineRow[] {
  return db
    .all<Record<string, unknown>>(
      `SELECT * FROM quarantine WHERE source_id = ? AND released_at IS NULL
       ORDER BY quarantined_at DESC LIMIT ?`,
      sourceId, limit,
    )
    .map((r) => ({
      id: String(r.id),
      sourceRecordId: (r.source_record_id as string) ?? null,
      reasonCode: String(r.reason_code),
      details: (r.details as string) ?? null,
      rawRecord: String(r.raw_record),
      quarantinedAt: String(r.quarantined_at),
    }));
}

/** Mark quarantined rows as recovered by a later, repaired run. */
export function releaseQuarantine(db: Db, sourceId: string, byRunId: string): number {
  return db.run(
    `UPDATE quarantine SET released_at = ?, released_by_run_id = ?
     WHERE source_id = ? AND released_at IS NULL`,
    nowIso(), byRunId, sourceId,
  ).changes;
}

export function recordAccounting(db: Db, runId: string, a: RowAccounting, balanced: boolean): void {
  db.run(
    `UPDATE ingestion_runs SET validated_rows = ?, matched_rows = ?, inserted_rows = ?,
       updated_rows = ?, unchanged_rows = ?, quarantined_rows = ?, accounting_balanced = ?
     WHERE run_id = ?`,
    a.validated_rows, a.matched_rows, a.inserted_rows, a.updated_rows,
    a.unchanged_rows, a.quarantined_rows, balanced ? 1 : 0, runId,
  );
}

export { shortHash };

/**
 * Job / queue ledger over `job_runs`.
 *
 * Stand-in for the AWS jobs+queues layer: every batch run (imports,
 * normalisation, radar scans, truth resolution) opens a `running` row, and
 * closes it as `ok` or `failed` with its stats. That gives one place to answer
 * "did the nightly normalise run, and what did it do" without a log grep.
 *
 * `runJob` never swallows the Result — it records the outcome and hands the
 * caller exactly what the job returned.
 */

import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.ts';
import { jsonColumn } from '../db/index.ts';
import type { Result } from '../contracts/index.ts';
import { err, slugify } from '../contracts/index.ts';
import { canonicalJson } from '../runtime/hash.ts';
import { nowIso } from '../runtime/clock.ts';

export interface JobRunRow {
  id: string;
  job: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  stats: Record<string, unknown>;
  error: string | null;
}

/**
 * Ids are unique per call rather than derived from the clock: `nowIso()` is
 * frozen in tests, so two runs in the same test would otherwise collide on the
 * primary key.
 */
function jobRunId(job: string): string {
  return `run:${slugify(job) || 'job'}:${randomUUID()}`;
}

export function startJob(db: Db, job: string): string {
  const id = jobRunId(job);
  db.run(
    `INSERT INTO job_runs (id, job, started_at, finished_at, status, stats_json, error)
     VALUES (?, ?, ?, NULL, 'running', '{}', NULL)`,
    id,
    job,
    nowIso(),
  );
  return id;
}

export function finishJob(
  db: Db,
  id: string,
  status: 'ok' | 'failed',
  stats?: Record<string, unknown>,
  error?: string | null,
): void {
  db.run(
    `UPDATE job_runs SET finished_at = ?, status = ?, stats_json = ?, error = ? WHERE id = ?`,
    nowIso(),
    status,
    canonicalJson(stats ?? {}),
    error ?? null,
    id,
  );
}

/** Stats recorded for a successful run: the value itself when it is a plain object. */
function statsOf(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return value === undefined ? {} : { value };
}

export async function runJob<T>(
  db: Db,
  job: string,
  fn: () => Result<T> | Promise<Result<T>>,
): Promise<Result<T>> {
  const id = startJob(db, job);
  let result: Result<T>;
  try {
    result = await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finishJob(db, id, 'failed', { threw: true }, message);
    return err<T>('internal', `job ${job} threw: ${message}`, { job, runId: id }, error);
  }
  if (result.ok) {
    finishJob(db, id, 'ok', statsOf(result.value), null);
  } else {
    finishJob(db, id, 'failed', { kind: result.error.kind }, result.error.message);
  }
  return result;
}

function rowToJobRun(row: Record<string, unknown>): JobRunRow {
  return {
    id: String(row.id),
    job: String(row.job),
    status: String(row.status),
    startedAt: String(row.started_at),
    finishedAt: (row.finished_at as string) ?? null,
    stats: jsonColumn<Record<string, unknown>>(row.stats_json, {}),
    error: (row.error as string) ?? null,
  };
}

export function recentJobs(db: Db, job?: string, limit = 20): JobRunRow[] {
  const rows = job
    ? db.all<Record<string, unknown>>(
        'SELECT * FROM job_runs WHERE job = ? ORDER BY started_at DESC, rowid DESC LIMIT ?',
        job,
        limit,
      )
    : db.all<Record<string, unknown>>(
        'SELECT * FROM job_runs ORDER BY started_at DESC, rowid DESC LIMIT ?',
        limit,
      );
  return rows.map(rowToJobRun);
}

export function lastJobRun(db: Db, job: string): { status: string; finishedAt: string | null } | null {
  const row = db.get<Record<string, unknown>>(
    'SELECT status, finished_at FROM job_runs WHERE job = ? ORDER BY started_at DESC, rowid DESC LIMIT 1',
    job,
  );
  if (!row) return null;
  return { status: String(row.status), finishedAt: (row.finished_at as string) ?? null };
}

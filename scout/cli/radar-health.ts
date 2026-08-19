/**
 * npm run radar:health
 *
 * Radar's own vital signs. Exits 0 when healthy, 1 when not.
 *
 * UNHEALTHY CRITERIA (each is a separate reason; any one of them trips it):
 *
 *   1. error rate  > 25% of scans in the last 24h, once there are at least
 *                  MIN_SCANS_FOR_RATE scans to average over. Below that a single
 *                  failure would read as a 100% error rate.
 *   2. overdue     an enabled watch is more than 24h past its due time. Measured
 *                  from `last_checked_at`, or from `created_at` for a watch that
 *                  has never run, so a freshly registered watch is not instantly
 *                  "unhealthy" -- it just has not been scanned yet.
 *   3. stalled     enabled watches are due but nothing has been scanned in 24h.
 *
 * The conditional-hit rate is REPORTED but never fails the check: a low rate
 * means the sources do not send validators, which is their problem, not Radar's.
 */

import { pathToFileURL } from 'node:url';
import { openDb, DEFAULT_DB_PATH } from '../db/index.ts';
import type { Db } from '../db/index.ts';
import { dueWatches } from '../radar/watches.ts';
import { nowIso, plusSeconds } from '../runtime/clock.ts';

export const ERROR_RATE_LIMIT = 0.25;
export const MIN_SCANS_FOR_RATE = 4;
export const OVERDUE_LIMIT_MINUTES = 24 * 60;

export interface RadarHealth {
  now: string;
  watches: { total: number; enabled: number; due: number };
  scans24h: { total: number; changed: number; unchanged: number; error: number; skipped: number };
  errorRate: number;
  conditionalHits: number;
  conditionalHitRate: number;
  deltasByKind: { cosmetic: number; material: number; structural: number };
  pendingVerifications: number;
  oldestOverdue: { watchId: string; entityId: string; overdueMinutes: number } | null;
}

export interface HealthVerdict {
  healthy: boolean;
  reasons: string[];
}

export function collectHealth(db: Db, now: string = nowIso()): RadarHealth {
  const since = plusSeconds(now, -24 * 60 * 60);

  const watchCounts = db.get<{ total: number; enabled: number }>(
    'SELECT COUNT(*) AS total, COALESCE(SUM(enabled), 0) AS enabled FROM watches',
  );

  const statusRows = db.all<{ status: string; n: number; hits: number }>(
    `SELECT status, COUNT(*) AS n, COALESCE(SUM(conditional_hit), 0) AS hits
     FROM radar_scans WHERE started_at >= ? GROUP BY status`,
    since,
  );
  const scans24h = { total: 0, changed: 0, unchanged: 0, error: 0, skipped: 0 };
  let conditionalHits = 0;
  for (const row of statusRows) {
    const n = Number(row.n);
    scans24h.total += n;
    conditionalHits += Number(row.hits);
    if (row.status === 'changed') scans24h.changed = n;
    else if (row.status === 'unchanged') scans24h.unchanged = n;
    else if (row.status === 'error') scans24h.error = n;
    else if (row.status === 'skipped') scans24h.skipped = n;
  }

  const kindRows = db.all<{ kind: string; n: number }>(
    'SELECT kind, COUNT(*) AS n FROM radar_deltas GROUP BY kind',
  );
  const deltasByKind = { cosmetic: 0, material: 0, structural: 0 };
  for (const row of kindRows) {
    if (row.kind === 'cosmetic') deltasByKind.cosmetic = Number(row.n);
    else if (row.kind === 'material') deltasByKind.material = Number(row.n);
    else if (row.kind === 'structural') deltasByKind.structural = Number(row.n);
  }

  const pending = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM radar_deltas
     WHERE verification = 'unverified' AND kind != 'cosmetic'`,
  );

  // Overdue is measured from created_at for never-checked watches, so a watch
  // registered a minute ago is "due" but not yet "late".
  const at = Date.parse(now);
  let oldestOverdue: RadarHealth['oldestOverdue'] = null;
  const rows = db.all<Record<string, unknown>>(
    `SELECT id, entity_id, check_interval_minutes, last_checked_at, created_at
     FROM watches WHERE enabled = 1`,
  );
  for (const row of rows) {
    const baseline = (row.last_checked_at as string) ?? String(row.created_at);
    const dueAt = Date.parse(baseline) + Number(row.check_interval_minutes) * 60_000;
    const overdue = (at - dueAt) / 60_000;
    if (overdue <= 0) continue;
    if (!oldestOverdue || overdue > oldestOverdue.overdueMinutes) {
      oldestOverdue = {
        watchId: String(row.id),
        entityId: String(row.entity_id),
        overdueMinutes: overdue,
      };
    }
  }

  return {
    now,
    watches: {
      total: Number(watchCounts?.total ?? 0),
      enabled: Number(watchCounts?.enabled ?? 0),
      due: dueWatches(db, now).length,
    },
    scans24h,
    errorRate: scans24h.total === 0 ? 0 : scans24h.error / scans24h.total,
    conditionalHits,
    conditionalHitRate: scans24h.total === 0 ? 0 : conditionalHits / scans24h.total,
    deltasByKind,
    pendingVerifications: Number(pending?.n ?? 0),
    oldestOverdue,
  };
}

/** Pure grading of a snapshot, so the criteria are testable without a CLI. */
export function healthVerdict(health: RadarHealth): HealthVerdict {
  const reasons: string[] = [];

  if (health.scans24h.total >= MIN_SCANS_FOR_RATE && health.errorRate > ERROR_RATE_LIMIT) {
    reasons.push(
      `error rate ${(health.errorRate * 100).toFixed(0)}% over ${health.scans24h.total} scans ` +
        `exceeds ${(ERROR_RATE_LIMIT * 100).toFixed(0)}%`,
    );
  }
  if (health.oldestOverdue && health.oldestOverdue.overdueMinutes > OVERDUE_LIMIT_MINUTES) {
    reasons.push(
      `watch ${health.oldestOverdue.watchId} (${health.oldestOverdue.entityId}) is ` +
        `${Math.round(health.oldestOverdue.overdueMinutes)}min overdue`,
    );
  }
  if (health.watches.enabled > 0 && health.watches.due > 0 && health.scans24h.total === 0) {
    reasons.push(`${health.watches.due} watch(es) due but no scans in the last 24h`);
  }

  return { healthy: reasons.length === 0, reasons };
}

export function formatHealth(health: RadarHealth, verdict: HealthVerdict): string {
  const lines = [
    `radar health at ${health.now}`,
    `  watches            ${health.watches.total} total, ${health.watches.enabled} enabled, ${health.watches.due} due`,
    `  scans (24h)        ${health.scans24h.total} total: ${health.scans24h.changed} changed, ` +
      `${health.scans24h.unchanged} unchanged, ${health.scans24h.error} error, ${health.scans24h.skipped} skipped`,
    `  error rate         ${(health.errorRate * 100).toFixed(1)}% (limit ${(ERROR_RATE_LIMIT * 100).toFixed(0)}%)`,
    `  conditional hits   ${health.conditionalHits} (${(health.conditionalHitRate * 100).toFixed(1)}% of scans)`,
    `  deltas             ${health.deltasByKind.structural} structural, ` +
      `${health.deltasByKind.material} material, ${health.deltasByKind.cosmetic} cosmetic`,
    `  pending verify     ${health.pendingVerifications}`,
    `  oldest overdue     ${
      health.oldestOverdue
        ? `${health.oldestOverdue.entityId} by ${Math.round(health.oldestOverdue.overdueMinutes)}min`
        : 'none'
    }`,
    '',
    verdict.healthy ? 'HEALTHY' : 'UNHEALTHY',
  ];
  for (const reason of verdict.reasons) lines.push(`  - ${reason}`);
  return lines.join('\n');
}

export function main(): number {
  const db = openDb(process.env.SCOUT_DB_PATH ?? DEFAULT_DB_PATH);
  try {
    const health = collectHealth(db);
    const verdict = healthVerdict(health);
    console.log(formatHealth(health, verdict));
    return verdict.healthy ? 0 : 1;
  } finally {
    db.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) process.exit(main());

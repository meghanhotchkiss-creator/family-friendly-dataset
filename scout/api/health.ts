/**
 * The health/status report.
 *
 * This is the endpoint a load balancer, a cron or a human hits, so it is READ
 * ONLY and cheap: it reports the LATEST stored `provider_health_checks` row
 * per provider rather than polling anything. Polling belongs to
 * `sentinel.checkAll`; reporting belongs here. Mixing the two would make the
 * status page take as long as the slowest upstream, which is precisely when
 * you most need it to answer.
 *
 * Every query is defensive. A subsystem another track has not populated yet
 * reports `degraded` with a useful sentence; it never throws. A status page
 * that 500s because a table is empty is worse than no status page.
 */

import type { Db } from '../db/index.ts';
import type { Provider, ProviderStatus, SystemHealth } from '../contracts/index.ts';
import { LATENCY_BUDGET_MS } from '../contracts/index.ts';
import { nowIso } from '../runtime/clock.ts';
import { detectStaleData } from '../reliability/sentinel.ts';
import { logger } from '../reliability/logging.ts';

const log = logger('health');

const STATUS_RANK: Readonly<Record<ProviderStatus, number>> = {
  up: 0,
  degraded: 1,
  down: 2,
  // Not a failure: an unconfigured provider is a deployment choice.
  unconfigured: -1,
};

function worst(statuses: ProviderStatus[]): ProviderStatus {
  let out: ProviderStatus = 'up';
  for (const status of statuses) {
    if (STATUS_RANK[status] > STATUS_RANK[out]) out = status;
  }
  return out;
}

/** COUNT(*) that answers `null` instead of throwing when the table is missing. */
function safeCount(db: Db, table: string, where?: string, ...params: unknown[]): number | null {
  try {
    const sql = `SELECT COUNT(*) AS n FROM ${table}${where ? ` WHERE ${where}` : ''}`;
    const row = db.get<{ n: number }>(sql, ...params);
    return row ? Number(row.n) : 0;
  } catch (cause) {
    log.debug('count failed', { table, error: cause instanceof Error ? cause.message : String(cause) });
    return null;
  }
}

function n(value: number | null): number {
  return value ?? 0;
}

interface Subsystem {
  name: string;
  status: ProviderStatus;
  detail: string;
}

function databaseSubsystem(db: Db): Subsystem {
  const migrations = safeCount(db, 'migrations');
  let tables: number | null = null;
  try {
    const row = db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    );
    tables = row ? Number(row.n) : 0;
  } catch {
    tables = null;
  }
  if (migrations === null || tables === null) {
    return { name: 'database', status: 'down', detail: 'schema metadata unreadable' };
  }
  const status: ProviderStatus = migrations > 0 && tables > 0 ? 'up' : 'down';
  return {
    name: 'database',
    status,
    detail: `${migrations} migrations applied, ${tables} tables`,
  };
}

function travelGraphSubsystem(db: Db): Subsystem {
  const places = safeCount(db, 'places');
  const cities = safeCount(db, 'cities');
  const airports = safeCount(db, 'airports');
  const detail = `${n(places)} places, ${n(cities)} cities, ${n(airports)} airports`;
  if (places === null || cities === null || airports === null) {
    return { name: 'travel_graph', status: 'degraded', detail: `${detail} (some tables unreadable)` };
  }
  if (places === 0 && cities === 0 && airports === 0) {
    return { name: 'travel_graph', status: 'degraded', detail: `${detail} - not imported yet` };
  }
  if (places === 0 || cities === 0) {
    return { name: 'travel_graph', status: 'degraded', detail: `${detail} - partially imported` };
  }
  return { name: 'travel_graph', status: 'up', detail };
}

function truthLayerSubsystem(db: Db): Subsystem {
  const resolutions = safeCount(db, 'truth_resolutions');
  const claims = safeCount(db, 'source_records');
  let unresolved: number | null = null;
  try {
    const row = db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM (
         SELECT sr.entity_type, sr.entity_id, sr.field
         FROM source_records sr
         LEFT JOIN truth_resolutions tr
           ON tr.entity_type = sr.entity_type AND tr.entity_id = sr.entity_id AND tr.field = sr.field
         WHERE tr.id IS NULL
         GROUP BY sr.entity_type, sr.entity_id, sr.field
       )`,
    );
    unresolved = row ? Number(row.n) : 0;
  } catch {
    unresolved = null;
  }
  const detail = `${n(resolutions)} resolutions, ${n(claims)} claims, ${unresolved === null ? '?' : unresolved} unresolved`;
  if (resolutions === null || claims === null || unresolved === null) {
    return { name: 'truth_layer', status: 'degraded', detail: `${detail} (query unavailable)` };
  }
  if (claims === 0) return { name: 'truth_layer', status: 'degraded', detail: `${detail} - no claims recorded yet` };
  if (resolutions === 0) return { name: 'truth_layer', status: 'degraded', detail: `${detail} - nothing resolved yet` };
  // Some backlog is normal; a backlog larger than what is resolved is not.
  if (unresolved > resolutions) {
    return { name: 'truth_layer', status: 'degraded', detail: `${detail} - resolver is behind` };
  }
  return { name: 'truth_layer', status: 'up', detail };
}

function radarSubsystem(db: Db, now: string): Subsystem {
  const watches = safeCount(db, 'watches', 'enabled = 1');
  const since = new Date(Date.parse(now) - 86_400_000).toISOString();
  const scans = safeCount(db, 'radar_scans', 'started_at >= ?', since);
  const pending = safeCount(db, 'radar_deltas', "verification = 'unverified'");
  const detail = `${n(watches)} watches, ${n(scans)} scans in 24h, ${n(pending)} deltas pending verification`;
  if (watches === null || scans === null || pending === null) {
    return { name: 'radar', status: 'degraded', detail: `${detail} (some tables unreadable)` };
  }
  if (watches === 0) return { name: 'radar', status: 'degraded', detail: `${detail} - nothing watched yet` };
  if (scans === 0) return { name: 'radar', status: 'degraded', detail: `${detail} - radar has not run in 24h` };
  return { name: 'radar', status: 'up', detail };
}

function freshnessSubsystem(db: Db, now: string): Subsystem {
  const entries = safeCount(db, 'live_data_cache');
  const stale = detectStaleData(db, now);
  const detail =
    `${n(entries)} cache entries, ${stale.staleCacheEntries} stale, ` +
    `${stale.staleSources.length} sources past their half-life`;
  if (entries === null) {
    return { name: 'freshness', status: 'degraded', detail: `${detail} (cache unreadable)` };
  }
  if (entries === 0) return { name: 'freshness', status: 'degraded', detail: `${detail} - cache is empty` };
  // Mostly-stale cache means somebody stopped refreshing, which is a real fault.
  if (stale.staleCacheEntries > entries / 2) {
    return { name: 'freshness', status: 'down', detail: `${detail} - majority stale` };
  }
  if (stale.staleCacheEntries > 0 || stale.staleSources.length > 0) {
    return { name: 'freshness', status: 'degraded', detail };
  }
  return { name: 'freshness', status: 'up', detail };
}

function rewardsSubsystem(db: Db): Subsystem {
  const programs = safeCount(db, 'loyalty_programs');
  const quotes = safeCount(db, 'award_quotes');
  const detail = `${n(programs)} programs, ${n(quotes)} quotes`;
  if (programs === null || quotes === null) {
    return { name: 'rewards', status: 'degraded', detail: `${detail} (some tables unreadable)` };
  }
  if (programs === 0) return { name: 'rewards', status: 'degraded', detail: `${detail} - no programs loaded` };
  if (quotes === 0) return { name: 'rewards', status: 'degraded', detail: `${detail} - no quotes computed yet` };
  return { name: 'rewards', status: 'up', detail };
}

interface HealthCheckRow {
  provider_id: string;
  kind: string | null;
  checked_at: string;
  status: string;
  latency_ms: number | null;
  schema_ok: number;
  error: string | null;
}

function latestProviderChecks(db: Db): SystemHealth['providers'] {
  const out: SystemHealth['providers'] = [];
  const seen = new Set<string>();
  try {
    const rows = db.all<HealthCheckRow>(
      `SELECT h.provider_id, p.kind AS kind, h.checked_at, h.status, h.latency_ms, h.schema_ok, h.error
       FROM provider_health_checks h
       LEFT JOIN providers p ON p.id = h.provider_id
       ORDER BY h.checked_at DESC, h.rowid DESC`,
    );
    for (const row of rows) {
      const id = String(row.provider_id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        kind: row.kind === null ? 'unknown' : String(row.kind),
        status: row.status as ProviderStatus,
        latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
        schemaOk: Number(row.schema_ok) === 1,
        error: (row.error as string | null) ?? null,
      });
    }
  } catch (cause) {
    log.warn('provider health unreadable', { error: cause instanceof Error ? cause.message : String(cause) });
  }
  return out;
}

/**
 * Registered providers that have never been checked. They are reported as
 * `unconfigured` (i.e. "no verdict"), which by design does not fail the
 * overall status -- an unpolled provider is not a broken one.
 */
function unpolledProviders(db: Db, seen: Set<string>, extra: Provider[]): SystemHealth['providers'] {
  const out: SystemHealth['providers'] = [];
  const add = (id: string, kind: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, kind, status: 'unconfigured', latencyMs: null, schemaOk: false, error: 'never checked' });
  };
  try {
    for (const row of db.all<{ id: string; kind: string }>('SELECT id, kind FROM providers ORDER BY id')) {
      add(String(row.id), String(row.kind));
    }
  } catch (cause) {
    log.debug('providers table unreadable', { error: String(cause) });
  }
  for (const provider of extra) add(provider.id, provider.kind);
  return out;
}

/** Build the rolled-up platform status. Read-only, fast, never throws. */
export function systemHealth(db: Db, opts?: { providers?: Provider[] }): SystemHealth {
  const checkedAt = nowIso();
  const polled = latestProviderChecks(db);
  const seen = new Set(polled.map((p) => p.id));
  const providers = [...polled, ...unpolledProviders(db, seen, opts?.providers ?? [])].sort((a, b) =>
    a.id.localeCompare(b.id),
  );

  const subsystems: Subsystem[] = [
    databaseSubsystem(db),
    travelGraphSubsystem(db),
    truthLayerSubsystem(db),
    radarSubsystem(db, checkedAt),
    freshnessSubsystem(db, checkedAt),
    rewardsSubsystem(db),
  ];

  const openIncidentCount = safeCount(db, 'incidents', 'closed_at IS NULL') ?? 0;

  return {
    status: worst([...subsystems.map((s) => s.status), ...providers.map((p) => p.status)]),
    checkedAt,
    providers,
    subsystems,
    openIncidents: openIncidentCount,
    latencyBudgetMs: LATENCY_BUDGET_MS,
  };
}

/** One line for a log, a Slack message or the top of the CLI table. */
export function healthSummaryLine(h: SystemHealth): string {
  const providerCounts = h.providers.reduce<Record<string, number>>((acc, p) => {
    acc[p.status] = (acc[p.status] ?? 0) + 1;
    return acc;
  }, {});
  const providerPart = h.providers.length
    ? `${h.providers.length} providers (${Object.entries(providerCounts)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${v} ${k}`)
        .join(', ')})`
    : 'no providers registered';
  const degraded = h.subsystems.filter((s) => s.status !== 'up').map((s) => s.name);
  const subsystemPart = degraded.length
    ? `${h.subsystems.length} subsystems, ${degraded.length} not up: ${degraded.join(', ')}`
    : `${h.subsystems.length} subsystems all up`;
  return `${h.status.toUpperCase()} at ${h.checkedAt} - ${providerPart}; ${subsystemPart}; ${h.openIncidents} open incident${h.openIncidents === 1 ? '' : 's'}`;
}

/**
 * Healthy means "not failing". `degraded` stays healthy on purpose: a
 * half-populated dev database or a slow provider should not take the process
 * down, only a `down` subsystem or provider should.
 */
export function isHealthy(h: SystemHealth): boolean {
  return h.status !== 'down';
}

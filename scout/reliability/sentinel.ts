/**
 * The Connection Sentinel.
 *
 * Every external dependency is polled through the one `Provider` interface,
 * and each poll answers four questions with one row in
 * `provider_health_checks`: is it reachable, is it fast enough, do our
 * credentials still work, and does its payload still have the shape we parse.
 *
 * Incidents are the durable half. The lifecycle is IDEMPOTENT by construction:
 * an incident is keyed by (provider, kind) while open, so a provider that is
 * down for three checks in a row has ONE open incident with a stable
 * `openedAt` -- which is what makes "how long has this been broken" answerable
 * -- and recovering closes it. Nothing here alerts on a transition it already
 * alerted on.
 */

import type { Db } from '../db/index.ts';
import type {
  Provider,
  ProviderContext,
  ProviderHealth,
  ProviderStatus,
  ProviderKind,
  Incident,
  IncidentKind,
  Severity,
  Result,
  FreshnessTier,
} from '../contracts/index.ts';
import { ok, err, LATENCY_BUDGET_MS, LATENCY_CRITICAL_MS, policyFor } from '../contracts/index.ts';
import { nowIso, daysBetween } from '../runtime/clock.ts';
import { shortHash } from '../runtime/hash.ts';
import { detectDrift, recordFingerprint, fingerprintDiff } from './drift.ts';
import { logger } from './logging.ts';

const log = logger('sentinel');

/** Monotonic within a process so ids stay unique under a frozen clock. */
let sequence = 0;
function uniqueId(prefix: string, ...parts: string[]): string {
  sequence += 1;
  return `${prefix}:${shortHash([...parts, String(sequence), String(process.pid)].join('|'))}`;
}

/**
 * Health checks, fingerprints and incidents all carry a FK to `providers`.
 * Track D's `registerProvidersInDb` is the normal way that row appears; this
 * is the safety net so a provider handed to us directly (tests, an ad-hoc
 * failover chain) cannot blow up on a foreign key.
 */
export function ensureProviderRow(db: Db, provider: Provider): void {
  db.run(
    `INSERT INTO providers (id, kind, source_class, authority, freshness_tier, region_scope, enabled)
     VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT(id) DO NOTHING`,
    provider.id,
    provider.kind,
    provider.sourceClass,
    provider.authority,
    provider.freshnessTier,
    JSON.stringify(provider.regionScope ?? []),
  );
}

/**
 * Latency verdict on its own axis.
 *   < LATENCY_BUDGET_MS    up
 *   >= LATENCY_BUDGET_MS   degraded
 *   >= LATENCY_CRITICAL_MS down
 * A null latency means nothing was measured, which is not a latency verdict:
 * it reports 'unconfigured' rather than inventing a failure.
 */
export function latencyStatus(latencyMs: number | null): ProviderStatus {
  if (latencyMs === null || !Number.isFinite(latencyMs)) return 'unconfigured';
  if (latencyMs >= LATENCY_CRITICAL_MS) return 'down';
  if (latencyMs >= LATENCY_BUDGET_MS) return 'degraded';
  return 'up';
}

interface IncidentRow {
  id: string;
  provider_id: string;
  kind: string;
  severity: string;
  opened_at: string;
  closed_at: string | null;
  detail: string;
}

function rowToIncident(row: IncidentRow): Incident {
  return {
    id: String(row.id),
    providerId: String(row.provider_id),
    kind: row.kind as IncidentKind,
    severity: row.severity as Severity,
    openedAt: String(row.opened_at),
    closedAt: (row.closed_at as string | null) ?? null,
    detail: String(row.detail),
  };
}

export function openIncidents(db: Db, providerId?: string): Incident[] {
  const rows = providerId
    ? db.all<IncidentRow>(
        'SELECT * FROM incidents WHERE closed_at IS NULL AND provider_id = ? ORDER BY opened_at ASC, id ASC',
        providerId,
      )
    : db.all<IncidentRow>(
        'SELECT * FROM incidents WHERE closed_at IS NULL ORDER BY opened_at ASC, id ASC',
      );
  return rows.map(rowToIncident);
}

/**
 * Open an incident, or return the id of the one already open for this
 * (provider, kind). This is THE dedup point: nothing else in the platform may
 * insert into `incidents`.
 */
export function openIncident(
  db: Db,
  providerId: string,
  kind: IncidentKind,
  severity: Severity,
  detail: string,
): string {
  const existing = db.get<{ id: string; severity: string }>(
    'SELECT id, severity FROM incidents WHERE provider_id = ? AND kind = ? AND closed_at IS NULL ORDER BY opened_at ASC LIMIT 1',
    providerId,
    kind,
  );
  if (existing) {
    // Escalation is allowed to update an open incident; de-escalation is not,
    // so a flapping provider cannot quietly downgrade a critical incident.
    if (SEVERITY_RANK[severity] > SEVERITY_RANK[existing.severity as Severity]) {
      db.run('UPDATE incidents SET severity = ?, detail = ? WHERE id = ?', severity, detail, existing.id);
      log.warn('incident escalated', { providerId, kind, severity, incidentId: existing.id });
    }
    return String(existing.id);
  }
  const id = uniqueId('incident', providerId, kind);
  db.run(
    'INSERT INTO incidents (id, provider_id, kind, severity, opened_at, closed_at, detail) VALUES (?, ?, ?, ?, ?, NULL, ?)',
    id,
    providerId,
    kind,
    severity,
    nowIso(),
    detail,
  );
  log.warn('incident opened', { providerId, kind, severity, incidentId: id, detail });
  return id;
}

const SEVERITY_RANK: Readonly<Record<Severity, number>> = { info: 1, warning: 2, critical: 3 };

export function closeIncident(db: Db, id: string): boolean {
  const changes = db.run(
    'UPDATE incidents SET closed_at = ? WHERE id = ? AND closed_at IS NULL',
    nowIso(),
    id,
  ).changes;
  if (changes > 0) log.info('incident closed', { incidentId: id });
  return changes > 0;
}

interface DesiredIncident {
  kind: IncidentKind;
  severity: Severity;
  detail: string;
}

/** Map a health result (plus drift) onto the incidents that SHOULD be open. */
export function incidentsFor(
  health: ProviderHealth,
  drift: { drifted: boolean; previous: string | null },
): DesiredIncident[] {
  const wanted: DesiredIncident[] = [];
  // An unconfigured provider is a deployment fact, not an outage.
  if (health.status === 'unconfigured') return wanted;

  if (health.status === 'down') {
    wanted.push({
      kind: 'unreachable',
      severity: 'critical',
      detail: health.error ?? `provider ${health.providerId} is down`,
    });
  }
  if (!health.authOk) {
    wanted.push({
      kind: 'auth_failure',
      severity: 'critical',
      detail: health.error ?? `credentials rejected by ${health.providerId}`,
    });
  }
  if (drift.drifted) {
    const diff = fingerprintDiff(drift.previous ?? '', health.schemaFingerprint ?? '');
    wanted.push({
      kind: 'schema_drift',
      severity: 'warning',
      detail:
        `payload shape changed: +[${diff.added.join(', ')}] -[${diff.removed.join(', ')}]`.slice(0, 500),
    });
  }
  const latency = latencyStatus(health.latencyMs);
  if (latency === 'degraded' || latency === 'down') {
    wanted.push({
      kind: 'latency_regression',
      severity: latency === 'down' ? 'critical' : 'warning',
      detail: `latency ${health.latencyMs}ms over budget ${LATENCY_BUDGET_MS}ms`,
    });
  }
  return wanted;
}

/** Bring the open-incident set for a provider into line with `wanted`. */
function reconcileIncidents(
  db: Db,
  providerId: string,
  wanted: DesiredIncident[],
): { opened: number; closed: number } {
  let opened = 0;
  let closed = 0;
  const before = openIncidents(db, providerId);
  const openKinds = new Set(before.map((i) => i.kind));
  const wantedKinds = new Set(wanted.map((w) => w.kind));

  for (const want of wanted) {
    if (!openKinds.has(want.kind)) opened += 1;
    // openIncident is the dedup point: a second call for the same open
    // (provider, kind) returns the existing id and inserts nothing.
    openIncident(db, providerId, want.kind, want.severity, want.detail);
  }
  for (const incident of before) {
    if (!wantedKinds.has(incident.kind) && closeIncident(db, incident.id)) closed += 1;
  }
  return { opened, closed };
}

function recordHealthCheck(db: Db, health: ProviderHealth): void {
  db.run(
    `INSERT INTO provider_health_checks
       (id, provider_id, checked_at, status, latency_ms, http_status, auth_ok, schema_ok, schema_fingerprint, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    uniqueId('healthcheck', health.providerId, health.checkedAt),
    health.providerId,
    health.checkedAt,
    health.status,
    health.latencyMs,
    health.httpStatus,
    health.authOk ? 1 : 0,
    health.schemaOk ? 1 : 0,
    health.schemaFingerprint,
    health.error,
  );
}

async function runCheck(
  db: Db,
  provider: Provider,
  ctx: ProviderContext,
): Promise<{ health: ProviderHealth; opened: number; closed: number }> {
  ensureProviderRow(db, provider);

  let health: ProviderHealth;
  try {
    health = await provider.health(ctx);
  } catch (cause) {
    // A provider that throws is exactly the failure Sentinel exists to catch,
    // so it becomes a health result rather than an exception up the stack.
    health = {
      providerId: provider.id,
      status: 'down',
      checkedAt: nowIso(),
      latencyMs: null,
      httpStatus: null,
      authOk: false,
      schemaOk: false,
      schemaFingerprint: null,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }

  recordHealthCheck(db, health);

  let drift = { drifted: false, previous: null as string | null, knownCount: 0 };
  if (health.schemaFingerprint) {
    drift = detectDrift(db, provider.id, health.schemaFingerprint);
    recordFingerprint(db, provider.id, health.schemaFingerprint);
    if (drift.drifted) {
      log.warn('schema drift', {
        providerId: provider.id,
        previous: drift.previous,
        current: health.schemaFingerprint,
      });
    }
  }

  const { opened, closed } = reconcileIncidents(db, provider.id, incidentsFor(health, drift));
  log.debug('provider checked', {
    providerId: provider.id,
    status: health.status,
    latencyMs: health.latencyMs,
    opened,
    closed,
  });
  return { health, opened, closed };
}

/**
 * Check one provider: poll it, persist the result, detect drift, reconcile
 * incidents. Never throws.
 */
export async function checkProvider(
  db: Db,
  provider: Provider,
  ctx: ProviderContext,
): Promise<ProviderHealth> {
  const outcome = await runCheck(db, provider, ctx);
  return outcome.health;
}

export interface CheckAllSummary {
  checked: number;
  up: number;
  degraded: number;
  down: number;
  unconfigured: number;
  incidentsOpened: number;
  incidentsClosed: number;
}

interface RegistryModule {
  allProviders(): Provider[];
  providerById(id: string): Provider | undefined;
  providersByKind(kind: ProviderKind): Provider[];
  registerProvidersInDb(db: Db): Result<{ providers: number; sources: number }>;
  providerContext(overrides?: Partial<ProviderContext>): ProviderContext;
}

/**
 * The connector registry is loaded lazily and defensively: Sentinel is useful
 * (and testable) without it, and a registry that is missing or broken must
 * degrade into a Result, not an import-time crash.
 */
async function loadRegistry(): Promise<RegistryModule | null> {
  try {
    return (await import('../connectors/registry.ts')) as unknown as RegistryModule;
  } catch {
    return null;
  }
}

/** Check every registered provider. Returns counts, never throws. */
export async function checkAll(db: Db, ctx?: ProviderContext): Promise<Result<CheckAllSummary>> {
  const registry = await loadRegistry();
  if (!registry) {
    return err('not_configured', 'connector registry unavailable', {
      module: 'scout/connectors/registry.ts',
    });
  }
  let providers: Provider[];
  let context: ProviderContext;
  try {
    providers = registry.allProviders();
    context = ctx ?? registry.providerContext();
  } catch (cause) {
    return err('internal', 'connector registry failed to initialise', {}, cause);
  }

  const summary: CheckAllSummary = {
    checked: 0,
    up: 0,
    degraded: 0,
    down: 0,
    unconfigured: 0,
    incidentsOpened: 0,
    incidentsClosed: 0,
  };

  for (const provider of providers) {
    try {
      const { health, opened, closed } = await runCheck(db, provider, context);
      summary.checked += 1;
      summary[health.status] += 1;
      summary.incidentsOpened += opened;
      summary.incidentsClosed += closed;
    } catch (cause) {
      log.error('provider check failed', {
        providerId: provider.id,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return err('internal', `checking ${provider.id} failed`, { providerId: provider.id }, cause);
    }
  }
  log.info('sentinel sweep complete', { ...summary });
  return ok(summary);
}

export interface StaleDataReport {
  staleCacheEntries: number;
  staleSources: { sourceId: string; field: string; ageDays: number }[];
}

/**
 * The "provider silently stopped updating" detector.
 *
 * Two independent signals:
 *   1. cache entries past their tier's `staleAfterSeconds`
 *   2. a source whose newest observation of a field is older than that
 *      source's tier half-life -- nothing errored, the data just stopped
 *      arriving, which no health check would ever notice.
 * Both queries are defensive: an unpopulated table reports zero, not a throw.
 */
export function detectStaleData(db: Db, now: string = nowIso()): StaleDataReport {
  let staleCacheEntries = 0;
  try {
    const rows = db.all<{ tier: string; fetched_at: string }>(
      'SELECT tier, fetched_at FROM live_data_cache',
    );
    for (const row of rows) {
      const policy = policyFor(row.tier as FreshnessTier);
      if (!policy) continue;
      const ageSec = Math.max(0, (Date.parse(now) - Date.parse(row.fetched_at)) / 1000);
      if (ageSec >= policy.staleAfterSeconds) staleCacheEntries += 1;
    }
  } catch (cause) {
    log.warn('stale cache scan failed', { error: String(cause) });
  }

  const staleSources: { sourceId: string; field: string; ageDays: number }[] = [];
  try {
    const rows = db.all<{ source_id: string; field: string; newest: string; freshness_tier: string }>(
      `SELECT sr.source_id AS source_id, sr.field AS field,
              MAX(sr.observed_at) AS newest, s.freshness_tier AS freshness_tier
       FROM source_records sr
       JOIN sources s ON s.id = sr.source_id
       GROUP BY sr.source_id, sr.field`,
    );
    for (const row of rows) {
      const policy = policyFor(row.freshness_tier as FreshnessTier);
      const halfLife = policy?.confidenceHalfLifeDays ?? null;
      // 'base' facts have no half-life: structural data is allowed to sit still.
      if (halfLife === null) continue;
      const ageDays = daysBetween(row.newest, now);
      if (ageDays > halfLife) {
        staleSources.push({
          sourceId: String(row.source_id),
          field: String(row.field),
          ageDays: Math.round(ageDays * 100) / 100,
        });
      }
    }
  } catch (cause) {
    log.warn('stale source scan failed', { error: String(cause) });
  }
  staleSources.sort((a, b) =>
    b.ageDays - a.ageDays || a.sourceId.localeCompare(b.sourceId) || a.field.localeCompare(b.field),
  );
  return { staleCacheEntries, staleSources };
}

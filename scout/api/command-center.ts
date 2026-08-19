/**
 * Command Center: one operational endpoint (GET /api/command-center).
 *
 * Everything here is DERIVED from live state -- file presence, run history,
 * health checks, table counts, test coverage. A status board that is authored
 * rather than computed drifts from reality within a week, and a drifted status
 * board is worse than none: it is the same failure as the airport import
 * reporting success while discarding 85% of its rows.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db/index.ts';
import type { ProviderStatus } from '../contracts/index.ts';
import { nowIso, daysBetween } from '../runtime/clock.ts';
import { statusReport, type SourceStatus } from '../sourcemesh/status.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEST_DIR = join(ROOT, 'tests', 'scout');

/* ------------------------------------------------------------------ *
 * Component matrix: BUILT -> CONNECTED -> TESTED -> LIVE
 * ------------------------------------------------------------------ */

export interface ComponentStatus {
  component: string;
  /** Source exists in this repository. */
  built: boolean;
  /** Reachable through the API or a CLI, not just importable. */
  connected: boolean;
  /** Covered by the automated suite. */
  tested: boolean;
  /** Has run against real data / is serving. */
  live: boolean;
  detail: string;
}

interface ComponentProbe {
  component: string;
  /** Files whose presence means BUILT. */
  files: string[];
  /** Substrings whose presence in the API/CLI wiring means CONNECTED. */
  wiredBy?: string[];
  /** Test-file substring meaning TESTED. */
  testToken?: string;
  /** Live when this returns true. */
  live?: (db: Db) => boolean;
  detail?: (db: Db) => string;
}

function count(db: Db, table: string): number {
  try {
    return Number(db.get<{ n: number }>(`SELECT COUNT(*) n FROM ${table}`)?.n ?? 0);
  } catch {
    return 0;
  }
}

const COMPONENTS: ComponentProbe[] = [
  {
    component: 'Scout Brain (decision engine)',
    files: ['scout/intelligence/scoring.ts', 'scout/intelligence/intent.ts'],
    wiredBy: ['scout/cli/api-serve.ts', 'scout/cli/recommend.ts'],
    testToken: 'intelligence',
    live: (db) => count(db, 'places') > 0,
    detail: (db) => `${count(db, 'places').toLocaleString()} places retrievable`,
  },
  {
    component: 'Travel graph',
    files: ['scout/db/migrations/002_travel_graph.sql', 'scout/intelligence/topic-graph.ts'],
    wiredBy: ['scout/cli/graph-topic-build.ts'],
    testToken: 'topic',
    live: (db) => count(db, 'place_topics') > 0,
    detail: (db) => `${count(db, 'topics')} topics, ${count(db, 'place_topics').toLocaleString()} links`,
  },
  {
    component: 'User graph / learning',
    files: ['scout/intelligence/user-graph.ts'],
    wiredBy: ['scout/cli/graph-user-build.ts', 'scout/cli/api-serve.ts'],
    testToken: 'user-graph',
    live: (db) => count(db, 'user_signals') > 0,
    detail: (db) => `${count(db, 'user_preferences')} learned preferences from ${count(db, 'user_signals')} signals`,
  },
  {
    component: 'Truth / confidence layer',
    files: ['scout/intelligence/truth-engine.ts', 'scout/db/repo-truth.ts'],
    wiredBy: ['scout/cli/truth-resolve.ts'],
    testToken: 'truth',
    live: (db) => count(db, 'truth_resolutions') > 0,
    detail: (db) => `${count(db, 'truth_resolutions').toLocaleString()} resolutions over ${count(db, 'source_records').toLocaleString()} claims`,
  },
  {
    component: 'Watch graph / freshness',
    files: ['scout/radar/watches.ts', 'scout/radar/scan.ts'],
    wiredBy: ['scout/cli/radar-scan.ts'],
    testToken: 'radar',
    live: (db) => count(db, 'radar_scans') > 0,
    detail: (db) => `${count(db, 'watches')} watches, ${count(db, 'radar_deltas')} deltas`,
  },
  {
    component: 'Provider adapters',
    files: ['scout/connectors/registry.ts', 'scout/contracts/provider.ts'],
    wiredBy: ['scout/cli/travel-import.ts'],
    testToken: 'connectors',
    live: (db) => count(db, 'provider_health_checks') > 0,
    detail: (db) => `${count(db, 'providers')} registered`,
  },
  {
    component: 'Provider health / Sentinel',
    files: ['scout/reliability/sentinel.ts'],
    wiredBy: ['scout/cli/sentinel-check.ts'],
    testToken: 'reliability',
    live: (db) => count(db, 'provider_health_checks') > 0,
    detail: (db) => `${count(db, 'provider_health_checks')} checks, ${count(db, 'incidents')} incidents`,
  },
  {
    component: 'SourceMesh ingestion',
    files: ['scout/sourcemesh/adapter.ts', 'scout/sourcemesh/spec.ts'],
    wiredBy: ['scout/cli/sourcemesh.ts'],
    testToken: 'sourcemesh',
    live: (db) => count(db, 'ingestion_runs') > 0,
    detail: (db) => `${count(db, 'source_registry')} sources, ${count(db, 'ingestion_runs')} runs`,
  },
  {
    component: 'Data provenance / evidence',
    files: ['scout/db/migrations/004_truth_layer.sql'],
    wiredBy: ['scout/cli/api-serve.ts'],
    testToken: 'integration',
    live: (db) => count(db, 'source_records') > 0,
    detail: (db) => `${count(db, 'source_records').toLocaleString()} evidence rows`,
  },
  {
    component: 'Rewards / friction',
    files: ['scout/rewards/points.ts', 'scout/rewards/friction.ts'],
    wiredBy: ['scout/cli/rewards-quote.ts'],
    testToken: 'rewards',
    live: (db) => count(db, 'loyalty_programs') > 0,
    detail: (db) => `${count(db, 'loyalty_programs')} programs`,
  },
  {
    component: 'Scout API',
    files: ['scout/api/server.ts', 'scout/cli/api-serve.ts'],
    wiredBy: ['scout/cli/api-serve.ts'],
    testToken: 'api-server',
    live: () => false,
    detail: () => 'routes defined; not verified as a running deployment here',
  },
  {
    component: 'Command Center API',
    files: ['scout/api/command-center.ts'],
    wiredBy: ['scout/cli/api-serve.ts'],
    testToken: 'command-center',
    live: () => false,
    detail: () => 'endpoint defined; not verified as a running deployment here',
  },
  // Architecture components with no implementation in THIS repository.
  { component: 'Chat / consumer UI', files: [], detail: () => 'no UI code in this repository' },
  { component: 'PHP action layer', files: [], detail: () => 'no PHP in this repository (never has been)' },
  { component: 'Map / graph visualisation', files: [], detail: () => 'not built here' },
  { component: 'Booking / action layer', files: [], detail: () => 'not built here' },
  { component: 'Feedback capture UI', files: [], detail: () => 'API accepts signals; no UI here' },
];

function wiringBlob(paths: string[]): string {
  return paths
    .filter((p) => existsSync(join(ROOT, p)))
    .map((p) => readFileSync(join(ROOT, p), 'utf8'))
    .join('\n');
}

/**
 * Test file CONTENTS, not just names. Matching on filenames alone reported
 * well-covered modules as untested whenever the token was a symbol inside a
 * differently-named file -- a false negative on a status board is still a lie.
 */
function testBlob(): string {
  if (!existsSync(TEST_DIR)) return '';
  return readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `${f}\n${readFileSync(join(TEST_DIR, f), 'utf8')}`)
    .join('\n');
}

export function componentMatrix(db: Db): ComponentStatus[] {
  const tests = testBlob();
  return COMPONENTS.map((probe) => {
    const built = probe.files.length > 0 && probe.files.every((f) => existsSync(join(ROOT, f)));
    const connected = built && Boolean(probe.wiredBy && wiringBlob(probe.wiredBy).length > 0);
    const tested = built && Boolean(probe.testToken && tests.includes(probe.testToken));
    const live = built && Boolean(probe.live?.(db));
    return {
      component: probe.component,
      built, connected, tested, live,
      detail: probe.detail ? probe.detail(db) : built ? 'present' : 'not built here',
    };
  });
}

/* ------------------------------------------------------------------ *
 * The endpoint payload
 * ------------------------------------------------------------------ */

export interface Blocker {
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  area: string;
  detail: string;
}

export interface CommandCenter {
  generatedAt: string;
  system: Record<string, string>;
  providers: {
    id: string; status: ProviderStatus; latencyMs: number | null;
    lastSuccess: string | null; error: string | null;
  }[];
  datasets: Record<string, number>;
  watchGraph: Record<string, number>;
  sources: SourceStatus[];
  features: ComponentStatus[];
  blockers: Blocker[];
}

export function commandCenter(db: Db): CommandCenter {
  const migrations = count(db, 'migrations');
  const tables = Number(
    db.get<{ n: number }>(
      "SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )?.n ?? 0,
  );

  const providers = db
    .all<Record<string, unknown>>(
      `SELECT p.id, h.status, h.latency_ms, h.checked_at, h.error
       FROM providers p
       LEFT JOIN provider_health_checks h ON h.id = (
         SELECT id FROM provider_health_checks WHERE provider_id = p.id
         ORDER BY checked_at DESC LIMIT 1
       ) ORDER BY p.id`,
    )
    .map((r) => ({
      id: String(r.id),
      status: (r.status as ProviderStatus) ?? 'unconfigured',
      latencyMs: r.latency_ms === null ? null : Number(r.latency_ms),
      lastSuccess: (r.checked_at as string) ?? null,
      error: (r.error as string) ?? null,
    }));

  const unresolved = count(db, 'quarantine');
  const datasets = {
    countries: count(db, 'countries'),
    regions: count(db, 'regions'),
    cities: count(db, 'cities'),
    airports: count(db, 'airports'),
    places: count(db, 'places'),
    topics: count(db, 'topics'),
    evidence: count(db, 'source_records'),
    resolutions: count(db, 'truth_resolutions'),
    quarantined: unresolved,
  };

  const since = new Date(Date.parse(nowIso()) - 86_400_000).toISOString();
  const watchGraph = {
    sourcesWatched: count(db, 'source_registry'),
    entitiesWatched: count(db, 'watches'),
    changesDetectedToday: Number(
      db.get<{ n: number }>(
        "SELECT COUNT(*) n FROM radar_scans WHERE status = 'changed' AND started_at >= ?",
        since,
      )?.n ?? 0,
    ),
    verificationQueue: Number(
      db.get<{ n: number }>(
        "SELECT COUNT(*) n FROM radar_deltas WHERE verification = 'unverified'",
      )?.n ?? 0,
    ),
    failedChecks: Number(
      db.get<{ n: number }>(
        "SELECT COUNT(*) n FROM radar_scans WHERE status = 'error' AND started_at >= ?",
        since,
      )?.n ?? 0,
    ),
  };

  const sources = statusReport(db);
  const features = componentMatrix(db);

  const blockers: Blocker[] = [];
  if (datasets.countries === 0) {
    blockers.push({ severity: 'CRITICAL', area: 'data', detail: 'countries table is empty; geography cannot resolve' });
  }
  if (unresolved > 0) {
    blockers.push({
      severity: 'HIGH', area: 'ingestion',
      detail: `${unresolved.toLocaleString()} records quarantined and unreleased`,
    });
  }
  const brokenSources = sources.filter((s) => s.state === 'BROKEN');
  for (const source of brokenSources) {
    blockers.push({ severity: 'HIGH', area: 'ingestion', detail: `${source.id}: ${source.detail}` });
  }
  const notStarted = sources.filter((s) => s.state === 'NOT STARTED');
  if (notStarted.length > 0) {
    blockers.push({
      severity: 'MEDIUM', area: 'sources',
      detail: `${notStarted.length} designed sources not connected: ${notStarted.map((s) => s.id).join(', ')}`,
    });
  }
  for (const feature of features.filter((f) => !f.built)) {
    blockers.push({ severity: 'HIGH', area: 'product', detail: `${feature.component}: ${feature.detail}` });
  }
  const staleProviders = providers.filter(
    (p) => p.lastSuccess && daysBetween(p.lastSuccess, nowIso()) > 1,
  );
  if (staleProviders.length > 0) {
    blockers.push({
      severity: 'LOW', area: 'providers',
      detail: `${staleProviders.length} providers not checked in over a day`,
    });
  }

  return {
    generatedAt: nowIso(),
    system: {
      database: migrations > 0 ? `ONLINE (${migrations} migrations, ${tables} tables)` : 'NOT MIGRATED',
      scoutBrain: features.find((f) => f.component.startsWith('Scout Brain'))?.live ? 'ONLINE' : 'NO DATA',
      api: 'DEFINED (not verified running here)',
      webApp: 'NOT BUILT IN THIS REPOSITORY',
      phpLayer: 'NOT BUILT IN THIS REPOSITORY',
    },
    providers, datasets, watchGraph, sources, features, blockers,
  };
}

export function formatCommandCenter(cc: CommandCenter): string {
  const lines: string[] = [`SCOUT COMMAND CENTER — ${cc.generatedAt}`, ''];

  lines.push('SYSTEM');
  for (const [k, v] of Object.entries(cc.system)) lines.push(`  ${k.padEnd(14)} ${v}`);

  lines.push('', 'PROVIDERS');
  for (const p of cc.providers) {
    lines.push(`  ${p.id.padEnd(26)} ${p.status.padEnd(13)} ${p.latencyMs !== null ? `${p.latencyMs}ms`.padEnd(8) : '—'.padEnd(8)} ${p.lastSuccess ?? 'never'}`);
  }
  if (cc.providers.length === 0) lines.push('  (none registered)');

  lines.push('', 'DATA');
  for (const [k, v] of Object.entries(cc.datasets)) {
    lines.push(`  ${k.padEnd(14)} ${v.toLocaleString().padStart(10)}`);
  }

  lines.push('', 'WATCH GRAPH');
  for (const [k, v] of Object.entries(cc.watchGraph)) {
    lines.push(`  ${k.padEnd(22)} ${String(v).padStart(6)}`);
  }

  lines.push('', 'COMPONENTS                        BUILT  CONN   TEST   LIVE');
  const tick = (b: boolean) => (b ? ' yes ' : '  -  ');
  for (const f of cc.features) {
    lines.push(`  ${f.component.padEnd(32)}${tick(f.built)}  ${tick(f.connected)}  ${tick(f.tested)}  ${tick(f.live)}   ${f.detail}`);
  }

  lines.push('', 'BLOCKERS');
  for (const severity of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const) {
    for (const b of cc.blockers.filter((x) => x.severity === severity)) {
      lines.push(`  ${severity.padEnd(9)} [${b.area}] ${b.detail}`);
    }
  }
  if (cc.blockers.length === 0) lines.push('  (none)');

  return lines.join('\n');
}

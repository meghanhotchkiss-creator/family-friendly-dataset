/**
 * npm run sentinel:check [-- --json] [--no-poll]
 *
 * Registers the connector registry's providers, polls every one of them, then
 * prints the rolled-up system health. Exits 1 when the platform is unhealthy
 * so this doubles as a CI / cron gate.
 */

import { openDb, DEFAULT_DB_PATH } from '../db/index.ts';
import { migrate } from '../db/migrate.ts';
import { checkAll, openIncidents } from '../reliability/sentinel.ts';
import { systemHealth, healthSummaryLine, isHealthy } from '../api/health.ts';
import { registerProvidersInDb, allProviders, providerContext } from '../connectors/registry.ts';

const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');
const poll = !args.has('--no-poll');
const dbPath = process.env.SCOUT_DB_PATH ?? DEFAULT_DB_PATH;

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width);
}

const db = openDb(dbPath);

try {
  migrate(db);
} catch (cause) {
  console.error(`migrations not current: ${cause instanceof Error ? cause.message : String(cause)}`);
}

let registered = { providers: 0, sources: 0 };
const registration = registerProvidersInDb(db);
if (registration.ok) {
  registered = registration.value;
} else if (!asJson) {
  console.error(`provider registration failed: ${registration.error.message}`);
}

let summary: Record<string, number> | null = null;
if (poll) {
  const result = await checkAll(db);
  if (result.ok) {
    summary = { ...result.value };
  } else if (!asJson) {
    console.error(`sentinel sweep failed: [${result.error.kind}] ${result.error.message}`);
  }
}

const health = systemHealth(db, { providers: allProviders() });
const incidents = openIncidents(db);

if (asJson) {
  console.log(JSON.stringify({ registered, summary, health, incidents }, null, 2));
} else {
  console.log(healthSummaryLine(health));
  console.log(
    `\nregistered ${registered.providers} providers / ${registered.sources} sources ` +
      `(transport ${providerContext().transport.mode})`,
  );

  console.log('\nPROVIDERS');
  console.log(`  ${pad('id', 28)}${pad('kind', 12)}${pad('status', 14)}${pad('latency', 10)}schema`);
  if (health.providers.length === 0) console.log('  (none registered)');
  for (const p of health.providers) {
    const latency = p.latencyMs === null ? '-' : `${p.latencyMs}ms`;
    console.log(
      `  ${pad(p.id, 28)}${pad(p.kind, 12)}${pad(p.status, 14)}${pad(latency, 10)}${p.schemaOk ? 'ok' : 'drift?'}` +
        (p.error ? `  ${p.error}` : ''),
    );
  }

  console.log('\nSUBSYSTEMS');
  for (const s of health.subsystems) {
    console.log(`  ${pad(s.name, 16)}${pad(s.status, 14)}${s.detail}`);
  }

  console.log(`\nOPEN INCIDENTS (${incidents.length})`);
  for (const incident of incidents) {
    console.log(
      `  ${pad(incident.severity, 10)}${pad(incident.kind, 20)}${pad(incident.providerId, 28)}${incident.detail}`,
    );
  }
  if (summary) {
    console.log(
      `\nchecked ${summary.checked}: ${summary.up} up, ${summary.degraded} degraded, ` +
        `${summary.down} down, ${summary.unconfigured} unconfigured; ` +
        `incidents +${summary.incidentsOpened} / -${summary.incidentsClosed}`,
    );
  }
}

db.close();
process.exit(isHealthy(health) ? 0 : 1);

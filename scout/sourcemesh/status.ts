/**
 * Source status: BUILT / CONNECTED / SEEDED / TESTED / BROKEN / NOT STARTED.
 *
 * Computed from live state -- the spec registry, the run history, the domain
 * tables and the test suite -- rather than maintained by hand, because a status
 * document that is written rather than derived is wrong within a week.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db/index.ts';
import { loadSpecs } from './registry.ts';
import type { SourceSpec } from './spec.ts';

const TEST_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'scout');

export const SOURCE_STATES = ['NOT STARTED', 'BUILT', 'CONNECTED', 'SEEDED', 'TESTED', 'BROKEN'] as const;
export type SourceState = (typeof SOURCE_STATES)[number];

/**
 * Sources that are designed but not connected, so gaps are visible rather than
 * absent. Priorities are as specified for Scout Fox Go.
 */
export const DESIGNED_SOURCES: { id: string; name: string; priority: 1 | 2 | 3; blocker: string }[] = [
  { id: 'nps', name: 'US National Park Service', priority: 1, blocker: 'egress blocked + API key required' },
  { id: 'ridb', name: 'Recreation.gov RIDB', priority: 2, blocker: 'egress blocked + API key required' },
  { id: 'wikidata', name: 'Wikidata', priority: 2, blocker: 'egress blocked (dumps/SPARQL)' },
  { id: 'gtfs-mobilitydatabase', name: 'MobilityDatabase GTFS', priority: 2, blocker: 'egress blocked' },
  { id: 'openstreetmap', name: 'OpenStreetMap (regional PBF)', priority: 3, blocker: 'egress blocked; PBF parser not built' },
  { id: 'wikivoyage', name: 'Wikivoyage', priority: 3, blocker: 'egress blocked (dumps)' },
  { id: 'naturalearth', name: 'Natural Earth', priority: 3, blocker: 'egress blocked' },
  { id: 'geojson-portals', name: 'GeoJSON municipal portals', priority: 3, blocker: 'no GeoJSON format handler yet' },
];

export interface SourceStatus {
  id: string;
  name: string;
  state: SourceState;
  /** Every state reached, so partial progress is visible. */
  reached: SourceState[];
  entity: string | null;
  rows: number | null;
  lastRun: string | null;
  lastRunStatus: string | null;
  balanced: boolean | null;
  quarantined: number;
  tested: boolean;
  detail: string;
}

const ENTITY_TABLE: Readonly<Record<string, string>> = {
  country: 'countries', city: 'cities', airport: 'airports', place: 'places',
  admin_region: 'admin_regions', runway: 'runways',
  frequency: 'airport_frequencies', navaid: 'navaids',
};

function testCoverage(): Set<string> {
  const covered = new Set<string>();
  if (!existsSync(TEST_DIR)) return covered;
  const blob = readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => readFileSync(join(TEST_DIR, f), 'utf8'))
    .join('\n');
  for (const spec of loadSpecs(undefined, { includeDemo: true })) {
    // A source counts as tested when its id or its entity sink is exercised.
    if (blob.includes(spec.id) || blob.includes(`entity: '${spec.entity}'`)) covered.add(spec.id);
  }
  if (blob.includes('sourcemesh')) for (const s of loadSpecs()) covered.add(s.id);
  return covered;
}

export function statusFor(db: Db, spec: SourceSpec, tested: Set<string>): SourceStatus {
  const reached: SourceState[] = ['BUILT'];

  const run = db.get<Record<string, unknown>>(
    `SELECT status, started_at, imported, accounting_balanced, source_rows
     FROM ingestion_runs WHERE source_id = ? ORDER BY started_at DESC LIMIT 1`,
    spec.id,
  );
  const quarantined = Number(
    db.get<{ n: number }>(
      'SELECT COUNT(*) n FROM quarantine WHERE source_id = ? AND released_at IS NULL',
      spec.id,
    )?.n ?? 0,
  );

  if (run) reached.push('CONNECTED');

  const table = ENTITY_TABLE[spec.entity];
  const rows = table
    ? Number(db.get<{ n: number }>(`SELECT COUNT(*) n FROM ${table}`)?.n ?? 0)
    : null;
  if (rows && rows > 0 && run && Number(run.imported) > 0) reached.push('SEEDED');

  // TESTED is not a stage beyond SEEDED, it is a property of a seeded source.
  // Treating coverage as progress reported a never-run source as TESTED on an
  // empty database, which is exactly the kind of green tick this file exists
  // to prevent.
  const isTested = tested.has(spec.id);
  if (isTested && reached.includes('SEEDED')) reached.push('TESTED');

  const balanced = run ? Number(run.accounting_balanced) === 1 : null;
  const broken = Boolean(run && (run.status === 'failed' || balanced === false));
  if (broken) reached.push('BROKEN');

  const state: SourceState = broken ? 'BROKEN' : (reached[reached.length - 1] ?? 'BUILT');

  const detail = broken
    ? `last run ${String(run?.status)}${balanced === false ? ', accounting unbalanced' : ''}`
    : run
      ? `${Number(run.imported).toLocaleString()}/${Number(run.source_rows).toLocaleString()} rows imported`
      : 'spec valid, never run';

  return {
    id: spec.id, name: spec.name, state, reached,
    entity: spec.entity, rows,
    lastRun: (run?.started_at as string) ?? null,
    lastRunStatus: (run?.status as string) ?? null,
    balanced, quarantined, tested: isTested, detail,
  };
}

export function statusReport(db: Db): SourceStatus[] {
  const tested = testCoverage();
  const built = loadSpecs(undefined, { includeDemo: true }).map((spec) => statusFor(db, spec, tested));
  const builtIds = new Set(built.map((s) => s.id));

  const notStarted: SourceStatus[] = DESIGNED_SOURCES.filter((d) => !builtIds.has(d.id)).map((d) => ({
    id: d.id, name: d.name, state: 'NOT STARTED' as SourceState, reached: [],
    entity: null, rows: null, lastRun: null, lastRunStatus: null,
    balanced: null, quarantined: 0, tested: false,
    detail: `priority ${d.priority} — ${d.blocker}`,
  }));

  return [...built, ...notStarted];
}

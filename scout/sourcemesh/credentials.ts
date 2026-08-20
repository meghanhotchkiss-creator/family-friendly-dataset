/**
 * Credential preflight.
 *
 * Answers "what do you need from me to make this run" without anyone reading
 * source. Every requirement is derived: spec `auth` blocks name their
 * environment variables, and the blocked-source registry names the rest.
 *
 * This module reports whether a variable is SET. It never prints a value, and
 * never writes one anywhere.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Db } from '../db/index.ts';
import { loadSpecs } from './registry.ts';
import { describeAuth, isAuthConfigured } from './auth.ts';
import { DESIGNED_SOURCES } from './status.ts';

export interface CredentialRequirement {
  source: string;
  what: string;
  /** Environment variables, or a file path for tools with their own store. */
  needs: string[];
  satisfied: boolean;
  /** What becomes possible once this is satisfied. */
  unlocks: string;
  /** Anything besides the credential that is also required. */
  alsoNeeds: string | null;
}

function envSet(name: string): boolean {
  return Boolean(process.env[name]);
}

/** Extra requirements that are not expressible as a spec `auth` block. */
const TOOL_CREDENTIALS: Omit<CredentialRequirement, 'satisfied'>[] = [
  {
    source: 'kaggle',
    what: 'Kaggle API token (username + key)',
    needs: ['~/.kaggle/kaggle.json'],
    unlocks: 'kaggle datasets download -d <owner>/<dataset>',
    alsoNeeds: 'egress to kaggle.com; a NAMED dataset with a readable licence',
  },
  {
    source: 'nps',
    what: 'National Park Service API key',
    needs: ['NPS_API_KEY'],
    unlocks: 'parks, visitor centres, campgrounds, alerts and closures',
    alsoNeeds: 'egress to developer.nps.gov',
  },
  {
    source: 'ridb',
    what: 'Recreation.gov RIDB API key',
    needs: ['RIDB_API_KEY'],
    unlocks: 'campgrounds, recreation areas, facilities',
    alsoNeeds: 'egress to ridb.recreation.gov',
  },
  {
    source: 'osm-nominatim',
    what: 'contact email (Nominatim requires an identifiable client)',
    needs: ['SCOUT_GEOCODE_EMAIL'],
    unlocks: 'npm run travel:geocode — upgrades 120 city-centroid coordinates',
    alsoNeeds: 'egress to nominatim.openstreetmap.org',
  },
];

export function credentialReport(_db?: Db): CredentialRequirement[] {
  const out: CredentialRequirement[] = [];

  // Derived from the specs themselves, so a new authenticated source appears
  // here automatically.
  for (const spec of loadSpecs(undefined, { includeDemo: true })) {
    if (!spec.auth || spec.auth.type === 'none') continue;
    const needs = [spec.auth.tokenEnv, spec.auth.usernameEnv, spec.auth.passwordEnv]
      .filter((v): v is string => Boolean(v));
    out.push({
      source: spec.id,
      what: describeAuth(spec.auth),
      needs,
      satisfied: isAuthConfigured(spec.auth),
      unlocks: `npm run sourcemesh -- ingest --source=${spec.id}`,
      alsoNeeds: `egress to ${new URL(spec.locator).hostname}`,
    });
  }

  const designed = new Set(DESIGNED_SOURCES.map((d) => d.id));
  for (const tool of TOOL_CREDENTIALS) {
    const satisfied = tool.needs.every((need) =>
      need.startsWith('~/')
        ? existsSync(join(homedir(), need.slice(2)))
        : envSet(need),
    );
    out.push({ ...tool, satisfied });
    designed.delete(tool.source);
  }

  return out;
}

export function formatCredentials(reqs: CredentialRequirement[]): string {
  const lines = ['CREDENTIALS SCOUT NEEDS', ''];
  const missing = reqs.filter((r) => !r.satisfied);
  const have = reqs.filter((r) => r.satisfied);

  if (have.length > 0) {
    lines.push('SATISFIED');
    for (const r of have) lines.push(`  ${r.source.padEnd(22)} ${r.needs.join(', ')}`);
    lines.push('');
  }

  lines.push('MISSING');
  for (const r of missing) {
    lines.push(`  ${r.source}`);
    lines.push(`    what     ${r.what}`);
    lines.push(`    set      ${r.needs.join('  ')}`);
    lines.push(`    unlocks  ${r.unlocks}`);
    if (r.alsoNeeds) lines.push(`    also     ${r.alsoNeeds}`);
    lines.push('');
  }

  lines.push(
    `${have.length}/${reqs.length} satisfied.`,
    '',
    'Values are read from the environment at run time and are never stored in a',
    'spec, a database row or a commit. Never paste a credential into a chat or a',
    'ticket -- rotate any that has been.',
  );
  return lines.join('\n');
}

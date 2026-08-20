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

/**
 * What a credential is for. Model keys, a Stripe secret and an airport dataset
 * are all "credentials", but confusing them is how a deploy goes out with
 * payments configured and nothing to read a photo with.
 */
export type CredentialCategory = 'data source' | 'model provider' | 'platform service';

export interface CredentialRequirement {
  source: string;
  category: CredentialCategory;
  what: string;
  /** Environment variables (all required), or a file path for tools with their own store. */
  needs: string[];
  /** Alternatives where at least one is required -- two email vendors, say. */
  anyOf?: string[];
  satisfied: boolean;
  /** What becomes possible once this is satisfied. */
  unlocks: string;
  /** Anything besides the credential that is also required. */
  alsoNeeds: string | null;
  /**
   * Model providers only: can this one read an image?
   *
   * DeepSeek is text-only, so a deployment holding DEEPSEEK_API_KEY and nothing
   * else has a working assistant and a Scout Lens that cannot see. That is a
   * capability gap, not a missing key, and no per-variable check finds it.
   */
  vision?: boolean;
}

function envSet(name: string): boolean {
  return Boolean(process.env[name]);
}

function isSatisfied(r: Omit<CredentialRequirement, 'satisfied'>): boolean {
  const all = r.needs.every((need) =>
    need.startsWith('~/') ? existsSync(join(homedir(), need.slice(2))) : envSet(need),
  );
  const any = !r.anyOf || r.anyOf.length === 0 || r.anyOf.some((v) => envSet(v));
  return all && any;
}

/** Extra data-source requirements that are not expressible as a spec `auth` block. */
const TOOL_CREDENTIALS: Omit<CredentialRequirement, 'satisfied'>[] = [
  {
    source: 'kaggle',
    category: 'data source',
    what: 'Kaggle API token (username + key)',
    needs: ['~/.kaggle/kaggle.json'],
    unlocks: 'kaggle datasets download -d <owner>/<dataset>',
    alsoNeeds: 'egress to kaggle.com; a NAMED dataset with a readable licence',
  },
  {
    source: 'nps',
    category: 'data source',
    what: 'National Park Service API key',
    needs: ['NPS_API_KEY'],
    unlocks: 'parks, visitor centres, campgrounds, alerts and closures',
    alsoNeeds: 'egress to developer.nps.gov',
  },
  {
    source: 'ridb',
    category: 'data source',
    what: 'Recreation.gov RIDB API key',
    needs: ['RIDB_API_KEY'],
    unlocks: 'campgrounds, recreation areas, facilities',
    alsoNeeds: 'egress to ridb.recreation.gov',
  },
  {
    source: 'google-places',
    category: 'data source',
    what: 'Google Places API key',
    needs: ['GOOGLE_PLACES_API_KEY'],
    unlocks: 'place details, opening hours, ratings — the fields no open dataset carries',
    alsoNeeds:
      'egress to places.googleapis.com. A spec for it must declare ' +
      "redistribution: 'restricted' with cacheDays, and the sink will then refuse to " +
      'persist it into the shared graph — query it at display time instead.',
  },
  {
    source: 'osm-nominatim',
    category: 'data source',
    what: 'contact email (Nominatim requires an identifiable client)',
    needs: ['SCOUT_GEOCODE_EMAIL'],
    unlocks: 'npm run travel:geocode — upgrades 120 city-centroid coordinates',
    alsoNeeds: 'egress to nominatim.openstreetmap.org',
  },
];

/**
 * The model providers and platform services the Scout Fox Go runtime reads.
 *
 * Taken from the variable list supplied for
 * `scoutfox-platform/packages/scout-fox-ai/app/core/config.py`, which this
 * session cannot open: GitHub access here is scoped to one owner and
 * ScoutFoxGo/ScoutFoxAI is refused as a cross-tier add. So this list is
 * SECOND-HAND and may be incomplete -- `npm run sourcemesh -- credentials`
 * says so rather than implying it was read from the source.
 */
export const PLATFORM_CONFIG_SOURCE =
  'scoutfox-platform/packages/scout-fox-ai/app/core/config.py (not readable from this session)';

const PLATFORM_CREDENTIALS: Omit<CredentialRequirement, 'satisfied'>[] = [
  {
    source: 'database',
    category: 'platform service',
    what: 'Postgres connection string',
    needs: ['DATABASE_URL'],
    unlocks: 'the platform datastore; Scout itself runs on node:sqlite and does not need it',
    alsoNeeds: 'network reachability from wherever the service runs',
  },
  {
    source: 'external-models',
    category: 'platform service',
    what: 'the switch that permits calling an external model at all',
    needs: ['SCOUT_EXTERNAL_MODELS'],
    unlocks: 'every model provider below; without it their keys are inert',
    alsoNeeds: null,
  },
  {
    source: 'anthropic',
    category: 'model provider',
    what: 'Anthropic API key',
    needs: ['ANTHROPIC_API_KEY'],
    unlocks: 'text generation and Scout Lens photo reading',
    alsoNeeds: 'SCOUT_EXTERNAL_MODELS; egress to api.anthropic.com',
    vision: true,
  },
  {
    source: 'openai',
    category: 'model provider',
    what: 'OpenAI API key',
    needs: ['OPENAI_API_KEY'],
    unlocks: 'text generation and Scout Lens photo reading',
    alsoNeeds: 'SCOUT_EXTERNAL_MODELS; egress to api.openai.com',
    vision: true,
  },
  {
    source: 'gemini',
    category: 'model provider',
    what: 'Google AI (Gemini) API key',
    needs: ['GOOGLE_API_KEY'],
    unlocks: 'text generation and Scout Lens photo reading',
    alsoNeeds: 'SCOUT_EXTERNAL_MODELS; egress to generativelanguage.googleapis.com',
    vision: true,
  },
  {
    source: 'deepseek',
    category: 'model provider',
    what: 'DeepSeek API key',
    needs: ['DEEPSEEK_API_KEY'],
    unlocks: 'text generation ONLY — this provider cannot serve Scout Lens',
    alsoNeeds: 'SCOUT_EXTERNAL_MODELS; egress to api.deepseek.com',
    vision: false,
  },
  {
    source: 'email',
    category: 'platform service',
    what: 'a transactional email vendor, plus the address it sends from',
    needs: ['EMAIL_FROM'],
    anyOf: ['RESEND_API_KEY', 'SENDGRID_API_KEY'],
    unlocks: 'trip summaries, invitations, alerts',
    alsoNeeds: 'a verified sending domain at the vendor',
  },
  {
    source: 'stripe',
    category: 'platform service',
    what: 'Stripe secret key',
    needs: ['STRIPE_SECRET_KEY'],
    unlocks: 'payments and subscription state',
    alsoNeeds: 'egress to api.stripe.com; use a test-mode key outside production',
  },
];

/**
 * What the deployment can actually DO, which is not the same question as which
 * variables are set. A capability can be missing while every key it might have
 * used is present but wrong for the job -- see `vision` above.
 */
export interface CapabilityCheck {
  name: string;
  available: boolean;
  detail: string;
}

export function capabilityChecks(reqs: CredentialRequirement[]): CapabilityCheck[] {
  const by = (id: string): CredentialRequirement | undefined => reqs.find((r) => r.source === id);
  const models = reqs.filter((r) => r.category === 'model provider');
  const ready = models.filter((r) => r.satisfied);
  const seeing = ready.filter((r) => r.vision);
  const gate = by('external-models')?.satisfied ?? false;

  const modelNames = (list: CredentialRequirement[]): string =>
    list.length === 0 ? 'none' : list.map((r) => r.source).join(', ');

  return [
    {
      name: 'text generation',
      available: gate && ready.length > 0,
      detail: !gate
        ? 'SCOUT_EXTERNAL_MODELS is unset, so no provider is called regardless of keys'
        : `providers ready: ${modelNames(ready)}`,
    },
    {
      name: 'Scout Lens (photo reading)',
      available: gate && seeing.length > 0,
      detail: !gate
        ? 'SCOUT_EXTERNAL_MODELS is unset'
        : seeing.length > 0
          ? `vision providers ready: ${modelNames(seeing)}`
          : ready.length > 0
            ? `${modelNames(ready)} configured, but ${ready.length === 1 ? 'it reads' : 'they read'} text only`
            : 'no model provider configured',
    },
    {
      name: 'email delivery',
      available: by('email')?.satisfied ?? false,
      detail: 'needs EMAIL_FROM and one of RESEND_API_KEY / SENDGRID_API_KEY',
    },
    {
      name: 'payments',
      available: by('stripe')?.satisfied ?? false,
      detail: 'needs STRIPE_SECRET_KEY',
    },
    {
      name: 'platform datastore',
      available: by('database')?.satisfied ?? false,
      detail: 'needs DATABASE_URL; the Scout travel graph itself runs on node:sqlite',
    },
  ];
}

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
      category: 'data source',
      what: describeAuth(spec.auth),
      needs,
      satisfied: isAuthConfigured(spec.auth),
      unlocks: `npm run sourcemesh -- ingest --source=${spec.id}`,
      alsoNeeds: `egress to ${new URL(spec.locator).hostname}`,
    });
  }

  const designed = new Set(DESIGNED_SOURCES.map((d) => d.id));
  for (const requirement of [...TOOL_CREDENTIALS, ...PLATFORM_CREDENTIALS]) {
    out.push({ ...requirement, satisfied: isSatisfied(requirement) });
    designed.delete(requirement.source);
  }

  return out;
}

export function formatCredentials(reqs: CredentialRequirement[]): string {
  const lines = ['CREDENTIALS SCOUT NEEDS', ''];

  // Capabilities come first: "is Scout Lens working" is the question, and a
  // list of set variables does not answer it.
  lines.push('CAPABILITIES');
  for (const c of capabilityChecks(reqs)) {
    lines.push(`  ${(c.available ? 'yes' : 'no ').padEnd(4)} ${c.name.padEnd(26)} ${c.detail}`);
  }
  lines.push('');

  const CATEGORIES: CredentialCategory[] = ['model provider', 'platform service', 'data source'];
  const label = (r: CredentialRequirement): string =>
    [...r.needs, ...(r.anyOf ? [r.anyOf.join(' | ')] : [])].join('  ');

  for (const category of CATEGORIES) {
    const group = reqs.filter((r) => r.category === category);
    if (group.length === 0) continue;
    const ready = group.filter((r) => r.satisfied).length;
    lines.push(`${category.toUpperCase()}  (${ready}/${group.length} satisfied)`);
    for (const r of group) {
      lines.push(`  ${(r.satisfied ? 'set ' : 'MISS').padEnd(5)} ${r.source.padEnd(22)} ${label(r)}`);
      if (!r.satisfied) {
        lines.push(`        what     ${r.what}`);
        lines.push(`        unlocks  ${r.unlocks}`);
        if (r.alsoNeeds) lines.push(`        also     ${r.alsoNeeds}`);
      }
    }
    lines.push('');
  }

  const have = reqs.filter((r) => r.satisfied).length;
  lines.push(
    `${have}/${reqs.length} satisfied.`,
    '',
    `Model-provider and platform entries are transcribed from a supplied variable`,
    `list, not read from ${PLATFORM_CONFIG_SOURCE}.`,
    'Treat that part as unverified until the file can be diffed against it.',
    '',
    'Values are read from the environment at run time and are never stored in a',
    'spec, a database row or a commit. Never paste a credential into a chat or a',
    'ticket -- rotate any that has been.',
  );
  return lines.join('\n');
}

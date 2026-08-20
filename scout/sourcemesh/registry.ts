/**
 * The source registry.
 *
 * A source cannot be ingested until its licence and attribution are recorded --
 * that is enforced here, not left to a checklist, because provenance that is
 * optional is provenance that goes missing.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db/index.ts';
import type { Result } from '../contracts/index.ts';
import { ok, err } from '../contracts/index.ts';
import { canonicalHash } from '../runtime/hash.ts';
import { nowIso } from '../runtime/clock.ts';
import { validateSpec, redistributionOf, type Redistribution, type SourceSpec } from './spec.ts';

const SPEC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'specs');

/**
 * Ingestion order is a dependency order, not alphabetical.
 *
 * Geography resolvers look values up in tables earlier sources populate: an
 * airport resolves its region through `countries`, so countries must land
 * first. Sorting by filename put restcountries last and quietly cost ~15% of
 * both other datasets.
 */
const ENTITY_ORDER: Readonly<Record<string, number>> = {
  country: 0, admin_region: 1, city: 2, airport: 3, place: 4,
  // These three reference an airport by its OurAirports `ident`, so they can
  // only resolve once airports.csv has landed.
  runway: 5, frequency: 5, navaid: 5,
};

export function loadSpecs(dir: string = SPEC_DIR, opts: { includeDemo?: boolean } = {}): SourceSpec[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    // `_`-prefixed specs are demonstrations (deliberately broken); they are
    // opt-in by id so a normal sweep is not polluted by an expected failure.
    .filter((f) => (opts.includeDemo ? true : !f.startsWith('_')))
    .sort()
    .map((f) => validateSpec(JSON.parse(readFileSync(join(dir, f), 'utf8'))))
    .sort((a, b) => (ENTITY_ORDER[a.entity] ?? 9) - (ENTITY_ORDER[b.entity] ?? 9));
}

export function loadSpec(id: string, dir: string = SPEC_DIR): SourceSpec | undefined {
  return loadSpecs(dir, { includeDemo: true }).find((s) => s.id === id);
}

export function registerSpec(db: Db, spec: SourceSpec): Result<string> {
  if (!spec.license?.name || !spec.license?.attribution) {
    return err('invalid_input', `${spec.id}: refusing to register a source without licence and attribution`);
  }
  const redistribution = redistributionOf(spec.license);
  if (redistribution === 'restricted' && typeof spec.license.cacheDays !== 'number') {
    return err('invalid_input',
      `${spec.id}: a restricted source must state cacheDays before it can be registered`);
  }
  db.run(
    `INSERT INTO source_registry (source_id, name, source_type, entity, license, attribution,
       commercial_use_allowed, share_alike, redistribution, cache_days,
       homepage, locator, update_frequency, trust_tier, spec_hash, enabled)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
     ON CONFLICT(source_id) DO UPDATE SET
       name = excluded.name, license = excluded.license, attribution = excluded.attribution,
       commercial_use_allowed = excluded.commercial_use_allowed, share_alike = excluded.share_alike,
       redistribution = excluded.redistribution, cache_days = excluded.cache_days,
       locator = excluded.locator, update_frequency = excluded.update_frequency,
       trust_tier = excluded.trust_tier, spec_hash = excluded.spec_hash`,
    spec.id, spec.name, spec.format, spec.entity, spec.license.name, spec.license.attribution,
    spec.license.commercialUse ? 1 : 0, spec.license.shareAlike ? 1 : 0,
    redistribution, spec.license.cacheDays ?? null,
    spec.homepage ?? null, spec.locator, spec.updateFrequency ?? null, spec.trustTier,
    canonicalHash(spec),
  );
  return ok(spec.id);
}

export function registerAll(db: Db, dir: string = SPEC_DIR): Result<number> {
  let n = 0;
  for (const spec of loadSpecs(dir, { includeDemo: true })) {
    const registered = registerSpec(db, spec);
    if (!registered.ok) return registered;
    n += 1;
  }
  return ok(n);
}

export interface RegisteredSource {
  sourceId: string; name: string; license: string; attribution: string;
  commercialUse: boolean; shareAlike: boolean; trustTier: string;
  redistribution: Redistribution; cacheDays: number | null;
  lastChecked: string | null; lastSuccessfulIngestion: string | null;
}

export function listRegistered(db: Db): RegisteredSource[] {
  return db
    .all<Record<string, unknown>>('SELECT * FROM source_registry ORDER BY source_id')
    .map((r) => ({
      sourceId: String(r.source_id), name: String(r.name), license: String(r.license),
      attribution: String(r.attribution),
      commercialUse: Number(r.commercial_use_allowed) === 1,
      shareAlike: Number(r.share_alike) === 1,
      trustTier: String(r.trust_tier),
      redistribution: (r.redistribution as Redistribution) ?? 'attributed',
      cacheDays: r.cache_days === null || r.cache_days === undefined ? null : Number(r.cache_days),
      lastChecked: (r.last_checked as string) ?? null,
      lastSuccessfulIngestion: (r.last_successful_ingestion as string) ?? null,
    }));
}

export interface AttributionNotice {
  /** Lines that must accompany any published output. */
  required: string[];
  /**
   * Sources whose values must NOT be redistributed at all. Listed separately
   * because the remedy is different: an attribution line does not make a
   * restricted source publishable, and printing one next to the others implies
   * it does.
   */
  notRedistributable: string[];
}

function line(s: RegisteredSource): string {
  return `${s.name} — ${s.attribution} (${s.license}${s.shareAlike ? ', share-alike' : ''})`;
}

export function attributionNotice(db: Db): AttributionNotice {
  const sources = listRegistered(db);
  return {
    required: sources
      .filter((s) => s.redistribution !== 'restricted')
      .map(line),
    notRedistributable: sources
      .filter((s) => s.redistribution === 'restricted')
      .map((s) => `${line(s)} — display-time only` +
        (s.cacheDays === null ? '' : `, cache at most ${s.cacheDays} day${s.cacheDays === 1 ? '' : 's'}`)),
  };
}

export function markChecked(db: Db, sourceId: string): void {
  db.run('UPDATE source_registry SET last_checked = ? WHERE source_id = ?', nowIso(), sourceId);
}

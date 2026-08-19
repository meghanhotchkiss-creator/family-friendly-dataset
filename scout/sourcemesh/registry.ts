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
import { validateSpec, type SourceSpec } from './spec.ts';

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
  country: 0, city: 1, airport: 2, place: 3,
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
  db.run(
    `INSERT INTO source_registry (source_id, name, source_type, entity, license, attribution,
       commercial_use_allowed, share_alike, homepage, locator, update_frequency, trust_tier, spec_hash, enabled)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)
     ON CONFLICT(source_id) DO UPDATE SET
       name = excluded.name, license = excluded.license, attribution = excluded.attribution,
       commercial_use_allowed = excluded.commercial_use_allowed, share_alike = excluded.share_alike,
       locator = excluded.locator, update_frequency = excluded.update_frequency,
       trust_tier = excluded.trust_tier, spec_hash = excluded.spec_hash`,
    spec.id, spec.name, spec.format, spec.entity, spec.license.name, spec.license.attribution,
    spec.license.commercialUse ? 1 : 0, spec.license.shareAlike ? 1 : 0,
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
      lastChecked: (r.last_checked as string) ?? null,
      lastSuccessfulIngestion: (r.last_successful_ingestion as string) ?? null,
    }));
}

/** Attribution lines that must accompany any published output. */
export function attributionNotice(db: Db): string[] {
  return listRegistered(db).map(
    (s) => `${s.name} — ${s.attribution} (${s.license}${s.shareAlike ? ', share-alike' : ''})`,
  );
}

export function markChecked(db: Db, sourceId: string): void {
  db.run('UPDATE source_registry SET last_checked = ? WHERE source_id = ?', nowIso(), sourceId);
}

/**
 * Shared access to sources and source_records.
 *
 * Connectors write claims here; the Truth Engine reads them. Owned centrally
 * so "recording a claim" means exactly one thing across the platform.
 */

import type { Db } from './index.ts';
import { jsonColumn } from './index.ts';
import type { Source, SourceRecord, EntityType, VerificationState, FreshnessTier, SourceClass, RegionCode } from '../contracts/index.ts';
import { SOURCE_AUTHORITY } from '../contracts/index.ts';
import { canonicalHash, shortHash } from '../runtime/hash.ts';
import { nowIso } from '../runtime/clock.ts';

export function upsertSource(db: Db, source: Source): string {
  db.run(
    `INSERT INTO sources (id, name, source_class, authority, homepage, region_scope, freshness_tier, enabled)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, source_class = excluded.source_class,
       authority = excluded.authority, homepage = excluded.homepage,
       region_scope = excluded.region_scope, freshness_tier = excluded.freshness_tier,
       enabled = excluded.enabled`,
    source.id, source.name, source.sourceClass, source.authority, source.homepage,
    JSON.stringify(source.regionScope), source.freshnessTier, source.enabled ? 1 : 0,
  );
  return source.id;
}

export function getSource(db: Db, id: string): Source | undefined {
  const row = db.get<Record<string, unknown>>('SELECT * FROM sources WHERE id = ?', id);
  if (!row) return undefined;
  return {
    id: String(row.id), name: String(row.name),
    sourceClass: row.source_class as SourceClass,
    authority: Number(row.authority),
    homepage: (row.homepage as string) ?? null,
    regionScope: jsonColumn<RegionCode[]>(row.region_scope, []),
    freshnessTier: row.freshness_tier as FreshnessTier,
    enabled: Number(row.enabled) === 1,
  };
}

export function defaultAuthorityFor(sourceClass: SourceClass): number {
  return SOURCE_AUTHORITY[sourceClass];
}

export interface ClaimInput {
  sourceId: string;
  entityType: EntityType;
  entityId: string;
  field: string;
  value: unknown;
  observedAt?: string;
  verification?: VerificationState;
}

/**
 * Record one source's claim about one field.
 *
 * Re-asserting the same value from the same source is a no-op (the existing
 * live record is returned), so repeated imports do not inflate corroboration.
 * A different value supersedes that source's previous live record.
 */
export function recordClaim(db: Db, claim: ClaimInput): string {
  const hash = canonicalHash(claim.value);
  const observedAt = claim.observedAt ?? nowIso();

  const existing = db.get<{ id: string; content_hash: string }>(
    `SELECT id, content_hash FROM source_records
     WHERE source_id = ? AND entity_id = ? AND field = ? AND superseded_by IS NULL`,
    claim.sourceId, claim.entityId, claim.field,
  );

  if (existing && existing.content_hash === hash) return existing.id;

  const id = `sr_${shortHash(`${claim.sourceId}|${claim.entityId}|${claim.field}|${hash}|${observedAt}`)}`;
  db.run(
    `INSERT INTO source_records (id, source_id, entity_type, entity_id, field, value_json,
       observed_at, content_hash, verification, superseded_by)
     VALUES (?,?,?,?,?,?,?,?,?,NULL)
     ON CONFLICT(id) DO NOTHING`,
    id, claim.sourceId, claim.entityType, claim.entityId, claim.field,
    JSON.stringify(claim.value ?? null), observedAt, hash,
    claim.verification ?? 'unverified',
  );
  if (existing) {
    db.run('UPDATE source_records SET superseded_by = ? WHERE id = ?', id, existing.id);
  }
  return id;
}

export function rowToSourceRecord(row: Record<string, unknown>): SourceRecord {
  return {
    id: String(row.id), sourceId: String(row.source_id),
    entityType: row.entity_type as EntityType, entityId: String(row.entity_id),
    field: String(row.field), value: jsonColumn<unknown>(row.value_json, null),
    observedAt: String(row.observed_at), contentHash: String(row.content_hash),
    verification: row.verification as VerificationState,
    supersededBy: (row.superseded_by as string) ?? null,
  };
}

/** Live (non-superseded) claims for one entity field. */
export function liveClaims(db: Db, entityId: string, field: string): SourceRecord[] {
  return db
    .all<Record<string, unknown>>(
      `SELECT * FROM source_records
       WHERE entity_id = ? AND field = ? AND superseded_by IS NULL
       ORDER BY observed_at DESC`,
      entityId, field,
    )
    .map(rowToSourceRecord);
}

/** Every (entityType, entityId, field) that currently has at least one live claim. */
export function claimedFields(db: Db): { entityType: EntityType; entityId: string; field: string }[] {
  return db
    .all<Record<string, unknown>>(
      `SELECT DISTINCT entity_type, entity_id, field FROM source_records
       WHERE superseded_by IS NULL ORDER BY entity_id, field`,
    )
    .map((r) => ({
      entityType: r.entity_type as EntityType,
      entityId: String(r.entity_id),
      field: String(r.field),
    }));
}

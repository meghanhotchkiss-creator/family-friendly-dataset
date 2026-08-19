/**
 * One ID scheme. Every entity id is `<type>:<slug>` so an id is self-describing
 * in logs, in source_records and in Radar deltas without a lookup.
 */

export const ENTITY_TYPES = [
  'region',
  'country',
  'city',
  'neighborhood',
  'airport',
  'place',
  'topic',
  'vibe',
  'user',
  'trip',
  'source',
  'provider',
  'program',
  'route',
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export type EntityId = string;

const ENTITY_TYPE_SET: ReadonlySet<string> = new Set(ENTITY_TYPES);

/** Lowercase, ASCII, hyphen-separated. Deterministic: same input, same slug. */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

export function makeId(type: EntityType, ...parts: string[]): EntityId {
  const slug = parts.map((p) => slugify(p)).filter(Boolean).join('-');
  if (!slug) throw new Error(`makeId(${type}) produced an empty slug from ${JSON.stringify(parts)}`);
  return `${type}:${slug}`;
}

export function parseId(id: EntityId): { type: EntityType; slug: string } | null {
  const index = id.indexOf(':');
  if (index <= 0) return null;
  const type = id.slice(0, index);
  const slug = id.slice(index + 1);
  if (!ENTITY_TYPE_SET.has(type) || !slug) return null;
  return { type: type as EntityType, slug };
}

export function isEntityId(id: string, type?: EntityType): boolean {
  const parsed = parseId(id);
  if (!parsed) return false;
  return type === undefined || parsed.type === type;
}

export function entityTypeOf(id: EntityId): EntityType | null {
  return parseId(id)?.type ?? null;
}

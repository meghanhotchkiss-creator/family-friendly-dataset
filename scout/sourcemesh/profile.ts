/**
 * Schema profiling and auto field-mapping.
 *
 * Before a dataset is trusted, SourceMesh looks at it: what fields exist, how
 * often they are populated, what they look like. That profile is what lets the
 * engine PROPOSE a mapping instead of a human writing one, and it is what makes
 * a later anomaly explainable ("continent is blank for 24,103 records").
 */

import { parseCsv } from '../connectors/adapters/gtfs.ts';
import { readPath, type SourceFormat, type SourceSpec } from './spec.ts';

export type RawRecord = Record<string, unknown>;

export interface FieldProfile {
  name: string;
  /** Share of records where the field is present and non-empty, 0..1. */
  populated: number;
  inferredType: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'empty';
  distinctSample: string[];
  examples: unknown[];
}

export interface SchemaProfile {
  format: SourceFormat;
  recordCount: number;
  fields: FieldProfile[];
  /** Fields present on every record. */
  alwaysPopulated: string[];
  /** Fields that are entirely empty -- the usual cause of a silent mass drop. */
  neverPopulated: string[];
}

function isEmpty(value: unknown): boolean {
  return (
    value === null || value === undefined || value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

function inferType(values: unknown[]): FieldProfile['inferredType'] {
  const present = values.filter((v) => !isEmpty(v));
  if (present.length === 0) return 'empty';
  if (present.every((v) => Array.isArray(v))) return 'array';
  if (present.every((v) => typeof v === 'boolean' || v === 'true' || v === 'false')) return 'boolean';
  if (present.every((v) => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))))) {
    return present.every((v) => Number.isInteger(Number(v))) ? 'integer' : 'number';
  }
  if (present.every((v) => v !== null && typeof v === 'object' && !Array.isArray(v))) return 'object';
  return 'string';
}

/** Flatten one level of nesting so `name.common` shows up as a field. */
function flatten(record: RawRecord, prefix = '', depth = 0): RawRecord {
  const out: RawRecord = {};
  for (const [key, value] of Object.entries(record)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (depth < 2 && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flatten(value as RawRecord, path, depth + 1));
    } else {
      out[path] = value;
    }
  }
  return out;
}

export function parseRecords(body: string, spec: SourceSpec): RawRecord[] {
  switch (spec.format) {
    case 'csv':
      return parseCsv(body) as RawRecord[];
    case 'tsv':
      return parseCsv(body.replace(/\t/g, ',')) as RawRecord[];
    case 'jsonl':
      return body.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as RawRecord);
    case 'json': {
      const parsed: unknown = JSON.parse(body);
      const root = spec.recordsAt ? readPath(parsed, spec.recordsAt) : parsed;
      if (!Array.isArray(root)) throw new Error(`${spec.id}: expected an array at ${spec.recordsAt ?? 'root'}`);
      return root as RawRecord[];
    }
    case 'json-map': {
      const parsed: unknown = JSON.parse(body);
      const root = spec.recordsAt ? readPath(parsed, spec.recordsAt) : parsed;
      if (!root || typeof root !== 'object' || Array.isArray(root)) {
        throw new Error(`${spec.id}: expected an object map at ${spec.recordsAt ?? 'root'}`);
      }
      // Keep the map key: it is usually the source's own identifier.
      return Object.entries(root as Record<string, RawRecord>).map(([key, value]) => ({
        _key: key,
        ...value,
      }));
    }
    default:
      throw new Error(`${spec.id}: unsupported format`);
  }
}

export function profileRecords(records: RawRecord[], format: SourceFormat, sampleSize = 2000): SchemaProfile {
  const sample = records.slice(0, sampleSize).map((r) => flatten(r));
  const names = new Set<string>();
  for (const record of sample) for (const key of Object.keys(record)) names.add(key);

  const fields: FieldProfile[] = [];
  for (const name of [...names].sort()) {
    const values = sample.map((r) => r[name]);
    const populatedCount = values.filter((v) => !isEmpty(v)).length;
    const distinct = new Set<string>();
    for (const v of values) {
      if (isEmpty(v)) continue;
      distinct.add(typeof v === 'object' ? JSON.stringify(v).slice(0, 40) : String(v).slice(0, 40));
      if (distinct.size >= 6) break;
    }
    fields.push({
      name,
      populated: sample.length === 0 ? 0 : populatedCount / sample.length,
      inferredType: inferType(values),
      distinctSample: [...distinct],
      examples: values.filter((v) => !isEmpty(v)).slice(0, 2),
    });
  }

  return {
    format,
    recordCount: records.length,
    fields,
    alwaysPopulated: fields.filter((f) => f.populated === 1).map((f) => f.name),
    neverPopulated: fields.filter((f) => f.populated === 0).map((f) => f.name),
  };
}

/* ------------------------------------------------------------------ *
 * Auto field-mapping
 * ------------------------------------------------------------------ */

/** Canonical field -> the source names that usually mean it. */
const SYNONYMS: Readonly<Record<string, string[]>> = {
  name: ['name', 'title', 'label', 'name.common', 'asciiname', 'official_name'],
  lat: ['lat', 'latitude', 'latitude_deg', 'y', 'coord.lat'],
  lon: ['lon', 'lng', 'long', 'longitude', 'longitude_deg', 'x', 'coord.lon'],
  countryIso2: ['iso_country', 'countrycode', 'country_code', 'cca2', 'iso2', 'country'],
  countryIso3: ['cca3', 'iso3', 'iso_a3'],
  city: ['city', 'municipality', 'town', 'place', 'locality'],
  admin1: ['admin1', 'admin1code', 'subd', 'state', 'region', 'iso_region', 'province'],
  population: ['population', 'pop'],
  timezone: ['timezone', 'tz', 'time_zone'],
  iata: ['iata', 'iata_code'],
  icao: ['icao', 'icao_code', 'gps_code', 'ident'],
  elevation: ['elevation', 'elevation_ft', 'alt', 'altitude'],
  externalId: ['geonameid', 'id', '_key', 'osm_id', 'wikidata', 'qid'],
  aliases: ['alternatenames', 'alt_names', 'aliases', 'altSpellings'],
  website: ['home_link', 'website', 'url', 'official_website'],
  category: ['type', 'category', 'class', 'feature_class'],
};

export interface MappingProposal {
  /** canonical field -> chosen source field */
  mapping: Record<string, string>;
  /** Canonical fields nothing plausible was found for. */
  unmapped: string[];
  /** Source fields nothing claimed -- candidates for enrichment. */
  unclaimed: string[];
  confidence: Record<string, number>;
}

/** Split on separators and camelCase: `latitude_deg` -> [latitude, deg]. */
function tokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Name similarity, deliberately stricter than substring containment.
 *
 * Bare containment matched the synonym `alt` (elevation) inside
 * `alternatenames`, proposing that a list of place names was an altitude. A
 * wrong mapping is worse than an absent one, so containment now has to clear a
 * length ratio, and a whole-token hit is what actually scores well.
 */
function similarity(a: string, b: string): number {
  const x = a.toLowerCase().replace(/[^a-z0-9]/g, '');
  const y = b.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (x === y) return 1;

  const at = tokens(a);
  const bt = tokens(b);
  if (bt.length === 1 && at.includes(bt[0]!)) return 0.85;
  if (at.length === 1 && bt.includes(at[0]!)) return 0.85;

  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  if (longer.includes(shorter) && shorter.length / longer.length >= 0.6) return 0.7;
  return 0;
}

/**
 * Propose a canonical mapping from a profile alone.
 *
 * A field that is never populated is never proposed, however good its name --
 * that is exactly the trap that made a `continent` column look like a usable
 * region source while being blank for 85% of the feed.
 */
export function proposeMapping(profile: SchemaProfile, wanted: string[] = Object.keys(SYNONYMS)): MappingProposal {
  const usable = profile.fields.filter((f) => f.populated > 0);
  const mapping: Record<string, string> = {};
  const confidence: Record<string, number> = {};
  const unmapped: string[] = [];
  const claimed = new Set<string>();

  for (const canonical of wanted) {
    const synonyms = SYNONYMS[canonical] ?? [canonical];
    let best: { field: string; score: number } | null = null;
    for (const field of usable) {
      let score = 0;
      for (const [index, synonym] of synonyms.entries()) {
        const s = similarity(field.name, synonym) * (1 - index * 0.05);
        if (s > score) score = s;
      }
      if (score === 0) continue;
      // Prefer a field that is actually populated.
      score *= 0.6 + 0.4 * field.populated;
      if (!best || score > best.score) best = { field: field.name, score };
    }
    if (best && best.score >= 0.5) {
      mapping[canonical] = best.field;
      confidence[canonical] = Number(best.score.toFixed(3));
      claimed.add(best.field);
    } else {
      unmapped.push(canonical);
    }
  }

  return {
    mapping,
    unmapped,
    unclaimed: usable.map((f) => f.name).filter((n) => !claimed.has(n)),
    confidence,
  };
}

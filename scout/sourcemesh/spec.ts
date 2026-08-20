/**
 * A source is a SPEC, not a code module.
 *
 * The commercial test for this engine is: can a new dataset be added without
 * anyone editing importer code? So everything a dataset needs -- how to find
 * it, which fields matter, how geography resolves, what makes a row
 * unacceptable, how to notice it changed -- lives in one declarative document.
 *
 * Specs are JSON, or the YAML subset in yaml.ts. There is exactly one adapter.
 */

import type { RegionCode } from '../contracts/index.ts';
import type { AuthSpec } from './auth.ts';

export const SOURCE_FORMATS = ['csv', 'tsv', 'json', 'jsonl', 'json-map'] as const;
export type SourceFormat = (typeof SOURCE_FORMATS)[number];

export const TRUST_TIERS = ['official', 'open_dataset', 'aggregator', 'community', 'derived'] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];

/** Where a value comes from: a source field, a constant, or a resolver chain. */
export interface FieldRule {
  /** Source field name, or dotted path for nested JSON (`name.common`). */
  field?: string;
  /** First non-empty wins. */
  anyOf?: string[];
  const?: string | number | boolean | null;
  /** Named transform applied after extraction. */
  transform?: 'upper' | 'lower' | 'trim' | 'number' | 'integer' | 'boolean' | 'first' | 'join';
  /**
   * Pull a capture group out of the raw value before transforming. Real feeds
   * pack several facts into one column -- OPTD's `city_detail_list` is
   * `LAX|5368361|Los Angeles|...` -- and a regex in the spec beats a bespoke
   * parser per source.
   */
  extract?: { pattern: string; group?: number };
  /** Resolver chain, tried in order, for values the source cannot supply. */
  resolver?: ResolverStep[];
  default?: string | number | boolean | null;
}

export interface ResolverStep {
  /** Look the value up in a table: `countries.iso2 -> region_code`. */
  lookup?: { table: string; match: string; from: string; using: string };
  /** Take it from another already-mapped field on the same record. */
  fromField?: string;
  const?: string | number | boolean | null;
}

export interface LicenseSpec {
  name: string;
  attribution: string;
  commercialUse: boolean;
  shareAlike?: boolean;
  url?: string;
}

/**
 * Which rows of a file this spec is about.
 *
 * A source often carries several entity types -- OpenTravelData packs airports,
 * cities and rail stations into one file. Rows this spec does not want are
 * SELECTED OUT, not rejected: they are excluded from the funnel denominator
 * rather than quarantined as failures, because "not for this spec" and "this
 * record is broken" are different facts and conflating them makes the
 * accounting meaningless.
 */
export interface SelectSpec {
  field: string;
  in?: string[];
  startsWith?: string[];
  notIn?: string[];
}

/**
 * One condition, or several ANDed together.
 *
 * One was not enough for a real feed: OpenTravelData needs both "this row is an
 * airport" (fcode) and "this row is not a retired IATA assignment"
 * (envelope_id), and without the second, 498 historical records competed with
 * the current ones for the same code.
 */
export type SelectRule = SelectSpec | SelectSpec[];

export interface QualitySpec {
  /** Canonical field names that must be present and non-empty. */
  rejectIfMissing?: string[];
  /** Present-but-suspect: recorded, not fatal. */
  warnIfMissing?: string[];
  /** Reject when a numeric field falls outside a range. */
  ranges?: { field: string; min?: number; max?: number }[];
  /**
   * Fail the run when the share of source rows that survive drops below this.
   * The airport import silently kept 15% of a real feed; a floor turns that
   * into a failure instead of a green tick.
   */
  minImportRatio?: number;
}

export interface MonitorSpec {
  frequency?: 'hourly' | 'daily' | 'weekly' | 'monthly';
  strategy?: 'hash_diff' | 'etag' | 'always';
}

export interface SourceSpec {
  id: string;
  name: string;
  entity: 'airport' | 'country' | 'city' | 'place' | 'admin_region' | 'runway' | 'frequency' | 'navaid';
  format: SourceFormat;
  locator: string;
  homepage?: string;
  trustTier: TrustTier;
  license: LicenseSpec;
  updateFrequency?: string;
  /** For json/json-map: dotted path to the array or map of records. */
  recordsAt?: string;
  /**
   * Field separator for csv/tsv. Real feeds are not all comma-separated --
   * OpenTravelData uses `^` -- and a per-source parser for each one is exactly
   * what this engine exists to avoid.
   */
  delimiter?: string;
  /** How to authenticate. Credentials are named, never embedded. */
  auth?: AuthSpec;
  /** Restrict the run to the rows this spec is about. */
  select?: SelectRule;
  /** Canonical field name -> how to obtain it. */
  fields: Record<string, FieldRule>;
  /** Stable per-record identity, referencing canonical field names. */
  identity: string[];
  quality?: QualitySpec;
  monitor?: MonitorSpec;
  regionScope?: RegionCode[];
}

export class SpecError extends Error {}

const REQUIRED = ['id', 'name', 'entity', 'format', 'locator', 'trustTier', 'license', 'fields', 'identity'] as const;

export function validateSpec(spec: unknown): SourceSpec {
  if (!spec || typeof spec !== 'object') throw new SpecError('spec must be an object');
  const s = spec as Record<string, unknown>;
  for (const key of REQUIRED) {
    if (s[key] === undefined || s[key] === null) throw new SpecError(`spec is missing ${key}`);
  }
  if (!SOURCE_FORMATS.includes(s.format as SourceFormat)) {
    throw new SpecError(`unknown format ${String(s.format)}`);
  }
  if (!TRUST_TIERS.includes(s.trustTier as TrustTier)) {
    throw new SpecError(`unknown trustTier ${String(s.trustTier)}`);
  }
  const license = s.license as Record<string, unknown>;
  if (!license.name || !license.attribution || typeof license.commercialUse !== 'boolean') {
    // Licence details are mandatory: a source whose terms are unrecorded must
    // not be ingestible at all.
    throw new SpecError(`${String(s.id)}: license needs name, attribution and commercialUse`);
  }
  const fields = s.fields as Record<string, unknown>;
  if (Object.keys(fields).length === 0) throw new SpecError('spec maps no fields');
  for (const key of s.identity as string[]) {
    if (!(key in fields)) throw new SpecError(`identity field ${key} is not mapped`);
  }
  return spec as SourceSpec;
}

/** Read a dotted path out of a nested record. */
export function readPath(record: unknown, path: string): unknown {
  if (record === null || record === undefined) return undefined;
  let current: unknown = record;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

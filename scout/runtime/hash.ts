/**
 * One hashing rule. Radar change detection, canonical place hashes, cache keys
 * and schema fingerprints all use these, so a hash means the same thing
 * everywhere.
 */

import { createHash } from 'node:crypto';

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Short hash for logs and ids. */
export function shortHash(input: string): string {
  return sha256(input).slice(0, 16);
}

/**
 * Hash of a value that ignores key order and formatting, so re-serialising an
 * unchanged payload does not register as a change.
 */
export function canonicalHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortValue);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortValue((value as Record<string, unknown>)[key]);
  }
  return out;
}

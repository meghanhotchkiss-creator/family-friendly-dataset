/**
 * Semantic change classification.
 *
 * The point of Radar is not "the bytes changed" -- that is what the hash is
 * for. The point is "did the meaning change, and does anything downstream have
 * to care". Every change is scored 0..1 and bucketed into one of three kinds:
 *
 *   cosmetic    reformatting, whitespace, casing, punctuation. Never re-ranked,
 *               never verified, never recorded as a claim.
 *   material    a real value moved. Worth a claim and a verification pass.
 *   structural  the entity's identity or classification moved. Always acted on.
 *
 * CLASSIFICATION PRECEDENCE (checked strictly in this order):
 *
 *   1. score === 0                -> cosmetic. A whitespace/case/punctuation-only
 *                                   edit is cosmetic EVEN ON A STRUCTURAL FIELD,
 *                                   because normalisation collapsed it to no
 *                                   change at all. "The Exploratorium " and
 *                                   "the exploratorium" are the same name.
 *   2. field in STRUCTURAL_FIELDS -> structural, for ANY score > 0. A category
 *                                   flipping museum -> market is a five-character
 *                                   edit (distance 5/6) but even a one-character
 *                                   one would be structural: the field's meaning,
 *                                   not the string distance, decides. This is why
 *                                   the field check outranks the thresholds.
 *   3. score >= DELTA_STRUCTURAL_THRESHOLD -> structural
 *   4. score >= DELTA_MATERIAL_THRESHOLD   -> material
 *   5. otherwise                           -> cosmetic
 *
 * Rule 1 outranking rule 2 is deliberate: without it every source that
 * re-serialised a name with different spacing would raise a structural alarm.
 */

import type { DeltaKind } from '../contracts/index.ts';
import {
  DELTA_MATERIAL_THRESHOLD,
  DELTA_STRUCTURAL_THRESHOLD,
  STRUCTURAL_FIELDS,
  clamp01,
} from '../contracts/index.ts';
import { canonicalJson } from '../runtime/hash.ts';

/** Beyond this, Levenshtein on serialised structures stops being worth it. */
const STRUCTURE_DISTANCE_LIMIT = 4096;

export interface FieldDelta {
  field: string;
  oldValue: unknown;
  newValue: unknown;
  semanticScore: number;
  kind: DeltaKind;
}

/**
 * Levenshtein distance normalised by the longer input, 0..1.
 *
 * Two-row dynamic programming: O(min(n,m)) memory, not O(n*m).
 */
export function normalizedEditDistance(a: string, b: string): number {
  if (a === b) return 0;
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 0;
  return clamp01(levenshtein(a, b) / longest);
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Iterate over the shorter string so the rows stay small.
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];

  let previous = new Array<number>(short.length + 1);
  let current = new Array<number>(short.length + 1);
  for (let i = 0; i <= short.length; i += 1) previous[i] = i;

  for (let j = 1; j <= long.length; j += 1) {
    current[0] = j;
    const longChar = long.charCodeAt(j - 1);
    for (let i = 1; i <= short.length; i += 1) {
      const cost = short.charCodeAt(i - 1) === longChar ? 0 : 1;
      const deletion = previous[i]! + 1;
      const insertion = current[i - 1]! + 1;
      const substitution = previous[i - 1]! + cost;
      current[i] = Math.min(deletion, insertion, substitution);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[short.length]!;
}

/**
 * Case, whitespace and punctuation are formatting, not meaning. Collapsing them
 * before measuring distance is what makes a cosmetic change score exactly 0.
 */
export function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

type ValueKind = 'null' | 'string' | 'number' | 'boolean' | 'structure';

function kindOf(value: unknown): ValueKind {
  if (value === null || value === undefined) return 'null';
  const t = typeof value;
  if (t === 'string') return 'string';
  if (t === 'number' || t === 'bigint') return 'number';
  if (t === 'boolean') return 'boolean';
  return 'structure';
}

/**
 * 0..1 distance between two values of the same field.
 *
 *   strings      normalised edit distance (so formatting scores 0)
 *   numbers      |a-b| / max(|a|,|b|,1), clamped
 *   booleans     0 or 1
 *   null         0 against null, otherwise a type change
 *   structures   edit distance over canonicalJson, so key order never matters
 *   type change  1 -- a field that changed shape changed meaning
 */
export function semanticDistance(oldValue: unknown, newValue: unknown): number {
  const oldKind = kindOf(oldValue);
  const newKind = kindOf(newValue);

  if (oldKind === 'null' && newKind === 'null') return 0;
  if (oldKind !== newKind) return 1;

  switch (oldKind) {
    case 'string':
      return normalizedEditDistance(
        normalizeText(oldValue as string),
        normalizeText(newValue as string),
      );
    case 'number': {
      const a = Number(oldValue);
      const b = Number(newValue);
      if (Number.isNaN(a) && Number.isNaN(b)) return 0;
      if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b ? 0 : 1;
      if (a === b) return 0;
      return clamp01(Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1));
    }
    case 'boolean':
      return oldValue === newValue ? 0 : 1;
    default: {
      const a = canonicalJson(oldValue);
      const b = canonicalJson(newValue);
      if (a === b) return 0;
      // Very large structures: knowing they differ is enough, and quadratic
      // string alignment on megabytes of JSON is not worth the CPU.
      if (a.length > STRUCTURE_DISTANCE_LIMIT || b.length > STRUCTURE_DISTANCE_LIMIT) return 1;
      return normalizedEditDistance(a, b);
    }
  }
}

/** Score a change and bucket it. See the precedence comment at the top. */
export function classifyDelta(
  field: string,
  oldValue: unknown,
  newValue: unknown,
): { semanticScore: number; kind: DeltaKind } {
  const semanticScore = semanticDistance(oldValue, newValue);
  return { semanticScore, kind: kindFor(field, semanticScore) };
}

export function kindFor(field: string, semanticScore: number): DeltaKind {
  if (semanticScore <= 0) return 'cosmetic';
  if (STRUCTURAL_FIELDS.has(field)) return 'structural';
  if (semanticScore >= DELTA_STRUCTURAL_THRESHOLD) return 'structural';
  if (semanticScore >= DELTA_MATERIAL_THRESHOLD) return 'material';
  return 'cosmetic';
}

/**
 * Diff two flat entity states.
 *
 * Only fields the NEW object actually mentions are considered: a payload that
 * omits a field is silent about it, not asserting it was deleted. Fields whose
 * canonical serialisation is byte-identical produce no entry at all; everything
 * else is returned WITH its kind, cosmetic included, so callers decide what to
 * persist.
 */
export function diffEntities(
  oldObj: Record<string, unknown>,
  newObj: Record<string, unknown>,
  fields?: string[],
): FieldDelta[] {
  const candidates = fields ?? Object.keys(newObj);
  const out: FieldDelta[] = [];
  for (const field of candidates) {
    if (!(field in newObj)) continue;
    const oldValue = oldObj[field] ?? null;
    const newValue = newObj[field] ?? null;
    if (canonicalJson(oldValue) === canonicalJson(newValue)) continue;
    const { semanticScore, kind } = classifyDelta(field, oldValue, newValue);
    out.push({ field, oldValue, newValue, semanticScore, kind });
  }
  return out;
}

/** True when a delta is worth persisting and adjudicating. */
export function isActionable(kind: DeltaKind): boolean {
  return kind !== 'cosmetic';
}

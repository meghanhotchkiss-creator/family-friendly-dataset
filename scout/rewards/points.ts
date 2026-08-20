/**
 * Award valuation.
 *
 * The only number that matters when comparing redemptions is cents per point,
 * and the only honest way to compare cents-per-point figures is to weight them
 * by how much you trust the quote. A screenshot from a forum showing 4.1 cpp
 * on a route nobody can rebook is worth less than an official 1.8 cpp quote
 * pulled an hour ago, so `compareQuotes` ranks on `centsPerPoint * confidence`
 * and never on raw cents per point.
 *
 * Award availability is the most volatile fact in the platform, so quotes decay
 * with a 7-day half-life: a two-week-old quote has already lost most of its
 * weight even if its source was excellent.
 */

import type { Db } from '../db/index.ts';
import type { AwardQuote, Confidence, Result } from '../contracts/index.ts';
import { ok, err, computeConfidence, SOURCE_AUTHORITY } from '../contracts/index.ts';
import { jsonColumn } from '../db/index.ts';
import { shortHash } from '../runtime/hash.ts';
import { nowIso } from '../runtime/clock.ts';

/** Award space moves daily; a week-old quote is half as believable. */
export const QUOTE_HALF_LIFE_DAYS = 7;

/**
 * Cents of value per point: `(cashCents - taxesCents) / pointsCost`.
 *
 * Two guards, both deliberate:
 *   - `pointsCost <= 0` (or any non-finite input) returns 0 rather than
 *     dividing by zero and poisoning every downstream comparison with
 *     Infinity/NaN.
 *   - when taxes and fees exceed the cash fare the redemption is worth
 *     *nothing*, not a negative amount. A negative cpp would sort below a
 *     0-value quote in a way that implies the points still bought something.
 *     Returning 0 says the truth: burning points here buys you nothing.
 */
export function centsPerPoint(pointsCost: number, cashCents: number, taxesCents: number): number {
  if (!Number.isFinite(pointsCost) || pointsCost <= 0) return 0;
  if (!Number.isFinite(cashCents) || !Number.isFinite(taxesCents)) return 0;
  const net = cashCents - taxesCents;
  if (net <= 0) return 0;
  return net / pointsCost;
}

/** Cash value, in cents, of a pile of points at a given cents-per-point. */
export function valuePoints(points: number, centsPerPointValue: number): number {
  if (!Number.isFinite(points) || !Number.isFinite(centsPerPointValue)) return 0;
  if (points <= 0 || centsPerPointValue <= 0) return 0;
  return Math.round(points * centsPerPointValue);
}

export interface QuoteInput {
  userId?: string | null;
  originAirportId: string;
  destinationAirportId: string;
  programId: string;
  pointsCost: number;
  cashCents: number;
  taxesCents: number;
  /** Authority of each independent source, from SOURCE_AUTHORITY. */
  sourceAuthorities?: number[];
  ageDays?: number;
}

/** Deterministic quote id: re-recording the identical quote is a no-op. */
export function quoteIdFor(q: QuoteInput, quotedAt: string): string {
  return `aq_${shortHash(
    [
      q.userId ?? '-', q.originAirportId, q.destinationAirportId, q.programId,
      q.pointsCost, q.cashCents, q.taxesCents, quotedAt,
    ].join('|'),
  )}`;
}

export function rowToQuote(row: Record<string, unknown>): AwardQuote {
  return {
    id: String(row.id),
    userId: (row.user_id as string) ?? null,
    originAirportId: String(row.origin_airport_id),
    destinationAirportId: String(row.destination_airport_id),
    programId: String(row.program_id),
    pointsCost: Number(row.points_cost),
    taxesCents: Number(row.taxes_cents),
    cashCents: Number(row.cash_cents),
    centsPerPoint: Number(row.cents_per_point),
    confidence: jsonColumn<Confidence>(row.confidence_json, {
      value: Number(row.confidence), authority: 0, corroboration: 0, freshness: 1,
      verification: 'unverified', verificationWeight: 0.85, observations: 0,
    }),
    quotedAt: String(row.quoted_at),
  };
}

/**
 * Persist one award quote.
 *
 * Both the scalar `confidence` and the full `confidence_json` are written: the
 * scalar so SQL can order by it without parsing JSON, the JSON so any ranking
 * can be explained after the fact without re-deriving it.
 */
export function recordQuote(db: Db, q: QuoteInput): Result<AwardQuote> {
  if (!Number.isFinite(q.pointsCost) || q.pointsCost <= 0) {
    return err('invalid_input', `pointsCost must be > 0, got ${q.pointsCost}`, { pointsCost: q.pointsCost });
  }
  if (!Number.isFinite(q.cashCents) || q.cashCents < 0) {
    return err('invalid_input', `cashCents must be >= 0, got ${q.cashCents}`);
  }
  if (!Number.isFinite(q.taxesCents) || q.taxesCents < 0) {
    return err('invalid_input', `taxesCents must be >= 0, got ${q.taxesCents}`);
  }

  const origin = db.get<{ id: string }>('SELECT id FROM airports WHERE id = ?', q.originAirportId);
  if (!origin) return err('not_found', `unknown origin airport ${q.originAirportId}`, { originAirportId: q.originAirportId });
  const dest = db.get<{ id: string }>('SELECT id FROM airports WHERE id = ?', q.destinationAirportId);
  if (!dest) return err('not_found', `unknown destination airport ${q.destinationAirportId}`, { destinationAirportId: q.destinationAirportId });
  const program = db.get<{ id: string }>('SELECT id FROM loyalty_programs WHERE id = ?', q.programId);
  if (!program) return err('not_found', `unknown program ${q.programId}`, { programId: q.programId });
  if (q.userId) {
    const user = db.get<{ id: string }>('SELECT id FROM users WHERE id = ?', q.userId);
    if (!user) return err('not_found', `unknown user ${q.userId}`, { userId: q.userId });
  }

  const quotedAt = nowIso();
  const confidence = computeConfidence({
    authorities: q.sourceAuthorities ?? [SOURCE_AUTHORITY.inferred],
    ageDays: q.ageDays,
    halfLifeDays: QUOTE_HALF_LIFE_DAYS,
  });
  const cpp = centsPerPoint(q.pointsCost, q.cashCents, q.taxesCents);
  const id = quoteIdFor(q, quotedAt);

  const quote: AwardQuote = {
    id,
    userId: q.userId ?? null,
    originAirportId: q.originAirportId,
    destinationAirportId: q.destinationAirportId,
    programId: q.programId,
    pointsCost: Math.floor(q.pointsCost),
    taxesCents: Math.round(q.taxesCents),
    cashCents: Math.round(q.cashCents),
    centsPerPoint: cpp,
    confidence,
    quotedAt,
  };

  try {
    db.run(
      `INSERT INTO award_quotes
         (id, user_id, origin_airport_id, destination_airport_id, program_id,
          points_cost, taxes_cents, cash_cents, cents_per_point,
          confidence, confidence_json, quoted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         points_cost = excluded.points_cost, taxes_cents = excluded.taxes_cents,
         cash_cents = excluded.cash_cents, cents_per_point = excluded.cents_per_point,
         confidence = excluded.confidence, confidence_json = excluded.confidence_json,
         quoted_at = excluded.quoted_at`,
      quote.id, quote.userId, quote.originAirportId, quote.destinationAirportId, quote.programId,
      quote.pointsCost, quote.taxesCents, quote.cashCents, quote.centsPerPoint,
      confidence.value, JSON.stringify(confidence), quote.quotedAt,
    );
  } catch (error) {
    return err('internal', `failed to write quote ${id}`, { id }, error);
  }

  return ok(quote);
}

/**
 * Best recorded quotes for a route, already ranked the way `compareQuotes`
 * ranks: confidence-adjusted cents per point, not raw cents per point.
 */
export function bestQuotes(
  db: Db,
  originAirportId: string,
  destinationAirportId: string,
  limit = 10,
): AwardQuote[] {
  const capped = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 10;
  return db
    .all<Record<string, unknown>>(
      `SELECT * FROM award_quotes
       WHERE origin_airport_id = ? AND destination_airport_id = ?
       ORDER BY (cents_per_point * confidence) DESC, points_cost ASC, quoted_at DESC
       LIMIT ?`,
      originAirportId, destinationAirportId, capped,
    )
    .map(rowToQuote);
}

export interface RankedQuote {
  quote: AwardQuote;
  centsPerPoint: number;
  /** centsPerPoint * confidence.value — the number the ranking uses. */
  confidenceAdjusted: number;
}

/**
 * Rank quotes by `centsPerPoint * confidence.value`.
 *
 * This is the single most important behaviour in this file. A spectacular
 * cents-per-point number from a stale, weakly-sourced quote must not outrank a
 * merely-good number from a fresh official one, because the user pays for the
 * difference in cancelled plans, not in spreadsheet cells.
 *
 * `db` is accepted for symmetry with the rest of the module; ranking is pure.
 */
export function compareQuotes(
  db: Db,
  quotes: AwardQuote[],
): { best: AwardQuote | null; ranked: RankedQuote[] } {
  void db;
  const ranked: RankedQuote[] = quotes.map((quote) => {
    const cpp = Number.isFinite(quote.centsPerPoint) ? quote.centsPerPoint : 0;
    return {
      quote,
      centsPerPoint: cpp,
      confidenceAdjusted: cpp * (quote.confidence?.value ?? 0),
    };
  });

  ranked.sort((a, b) => {
    if (b.confidenceAdjusted !== a.confidenceAdjusted) return b.confidenceAdjusted - a.confidenceAdjusted;
    if (b.centsPerPoint !== a.centsPerPoint) return b.centsPerPoint - a.centsPerPoint;
    if (a.quote.pointsCost !== b.quote.pointsCost) return a.quote.pointsCost - b.quote.pointsCost;
    return a.quote.id < b.quote.id ? -1 : a.quote.id > b.quote.id ? 1 : 0;
  });

  const top = ranked[0];
  return { best: top ? top.quote : null, ranked };
}

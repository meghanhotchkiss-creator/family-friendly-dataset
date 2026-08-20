/**
 * The loyalty graph: programs, the transfer edges between them, and the
 * balances a user actually holds.
 *
 * Programs are nodes and transfer partners are directed, weighted edges
 * (`ratioNum` points out produce `ratioDen` points in). Banks sit at the root
 * of most useful paths, hotels sit in the middle and airlines are almost
 * always the sink, which is why the graph is genuinely multi-hop: Chase ->
 * Marriott -> ANA is a real (if lossy) route that no single edge expresses.
 *
 * Everything here is idempotent. Seeding twice leaves the same rows, because
 * both program ids and transfer-edge ids are derived from their content, never
 * generated.
 */

import type { Db } from '../db/index.ts';
import type {
  LoyaltyProgram,
  ProgramKind,
  RegionCode,
  Result,
  TransferPartner,
  UserBalance,
} from '../contracts/index.ts';
import { ok, err, makeId, PROGRAM_KINDS } from '../contracts/index.ts';
import { ensureRegions } from '../db/repo-core.ts';
import { shortHash } from '../runtime/hash.ts';
import { nowIso } from '../runtime/clock.ts';

const PROGRAM_KIND_SET: ReadonlySet<string> = new Set(PROGRAM_KINDS);

export interface SeedProgram {
  slug: string;
  name: string;
  kind: ProgramKind;
  currencyName: string;
  regionCode: RegionCode | null;
}

export interface SeedTransfer {
  from: string;
  to: string;
  ratioNum: number;
  ratioDen: number;
  minTransfer: number;
  transferTimeHours: number;
}

/**
 * Eighteen real-world-shaped programs across all four kinds and six regions.
 * `slug` is the seed-local key; the persisted id is always
 * `makeId('program', slug)`.
 */
export const SEED_PROGRAMS: SeedProgram[] = [
  // Bank currencies: the roots of the graph.
  { slug: 'chase-ultimate-rewards', name: 'Chase Ultimate Rewards', kind: 'bank', currencyName: 'Ultimate Rewards points', regionCode: 'NA' },
  { slug: 'amex-membership-rewards', name: 'Amex Membership Rewards', kind: 'bank', currencyName: 'Membership Rewards points', regionCode: 'NA' },
  { slug: 'capital-one-miles', name: 'Capital One Miles', kind: 'bank', currencyName: 'Capital One miles', regionCode: 'NA' },
  { slug: 'bilt-rewards', name: 'Bilt Rewards', kind: 'bank', currencyName: 'Bilt points', regionCode: 'NA' },

  // Airlines: almost always the sink.
  { slug: 'united-mileageplus', name: 'United MileagePlus', kind: 'airline', currencyName: 'MileagePlus miles', regionCode: 'NA' },
  { slug: 'delta-skymiles', name: 'Delta SkyMiles', kind: 'airline', currencyName: 'SkyMiles', regionCode: 'NA' },
  { slug: 'flying-blue', name: 'Air France/KLM Flying Blue', kind: 'airline', currencyName: 'Flying Blue miles', regionCode: 'EU' },
  { slug: 'british-airways-executive-club', name: 'British Airways Executive Club', kind: 'airline', currencyName: 'Avios', regionCode: 'EU' },
  { slug: 'singapore-krisflyer', name: 'Singapore KrisFlyer', kind: 'airline', currencyName: 'KrisFlyer miles', regionCode: 'AS' },
  { slug: 'ana-mileage-club', name: 'ANA Mileage Club', kind: 'airline', currencyName: 'ANA miles', regionCode: 'AS' },
  { slug: 'avianca-lifemiles', name: 'Avianca LifeMiles', kind: 'airline', currencyName: 'LifeMiles', regionCode: 'SA' },
  { slug: 'qantas-frequent-flyer', name: 'Qantas Frequent Flyer', kind: 'airline', currencyName: 'Qantas points', regionCode: 'OC' },
  { slug: 'emirates-skywards', name: 'Emirates Skywards', kind: 'airline', currencyName: 'Skywards miles', regionCode: 'ME' },

  // Hotels: the middle of the graph, and the source of most value destruction.
  { slug: 'marriott-bonvoy', name: 'Marriott Bonvoy', kind: 'hotel', currencyName: 'Bonvoy points', regionCode: 'NA' },
  { slug: 'hilton-honors', name: 'Hilton Honors', kind: 'hotel', currencyName: 'Honors points', regionCode: 'NA' },
  { slug: 'world-of-hyatt', name: 'World of Hyatt', kind: 'hotel', currencyName: 'Hyatt points', regionCode: 'NA' },

  // Rail.
  { slug: 'eurostar-club', name: 'Eurostar Club Europe', kind: 'rail', currencyName: 'Eurostar Club points', regionCode: 'EU' },
  { slug: 'amtrak-guest-rewards', name: 'Amtrak Guest Rewards', kind: 'rail', currencyName: 'Amtrak points', regionCode: 'NA' },
];

/**
 * Transfer edges. Ratios are written as `ratioNum:ratioDen` in raw points so
 * the non-1:1 cases stay legible:
 *
 *   1000:1000  1:1   the normal bank -> airline edge
 *   1000:2000  1:2   Amex -> Hilton, one of the few edges that multiplies
 *   3000:1000  3:1   Marriott -> airline, a 67% haircut
 *   5000:2000  2.5:1 Hyatt -> airline
 *   10000:1000 10:1  Hilton -> airline, the classic value bonfire
 */
export const SEED_TRANSFERS: SeedTransfer[] = [
  // Chase Ultimate Rewards
  { from: 'chase-ultimate-rewards', to: 'united-mileageplus', ratioNum: 1000, ratioDen: 1000, minTransfer: 1000, transferTimeHours: 0 },
  { from: 'chase-ultimate-rewards', to: 'flying-blue', ratioNum: 1000, ratioDen: 1000, minTransfer: 1000, transferTimeHours: 1 },
  { from: 'chase-ultimate-rewards', to: 'british-airways-executive-club', ratioNum: 1000, ratioDen: 1000, minTransfer: 1000, transferTimeHours: 0 },
  { from: 'chase-ultimate-rewards', to: 'singapore-krisflyer', ratioNum: 1000, ratioDen: 1000, minTransfer: 1000, transferTimeHours: 24 },
  { from: 'chase-ultimate-rewards', to: 'emirates-skywards', ratioNum: 1000, ratioDen: 1000, minTransfer: 1000, transferTimeHours: 12 },
  { from: 'chase-ultimate-rewards', to: 'world-of-hyatt', ratioNum: 1000, ratioDen: 1000, minTransfer: 1000, transferTimeHours: 0 },
  { from: 'chase-ultimate-rewards', to: 'marriott-bonvoy', ratioNum: 1000, ratioDen: 1000, minTransfer: 1000, transferTimeHours: 2 },
  { from: 'chase-ultimate-rewards', to: 'amtrak-guest-rewards', ratioNum: 1000, ratioDen: 1000, minTransfer: 1000, transferTimeHours: 2 },

  // Amex Membership Rewards
  { from: 'amex-membership-rewards', to: 'delta-skymiles', ratioNum: 1000, ratioDen: 1000, minTransfer: 1000, transferTimeHours: 0 },
  { from: 'amex-membership-rewards', to: 'flying-blue', ratioNum: 1000, ratioDen: 1000, minTransfer: 1000, transferTimeHours: 0 },
  { from: 'amex-membership-rewards', to: 'british-airways-executive-club', ratioNum: 1000, ratioDen: 1000, minTransfer: 1000, transferTimeHours: 0 },
  { from: 'amex-membership-rewards', to: 'singapore-krisflyer', ratioNum: 1000, ratioDen: 1000, minTransfer: 1000, transferTimeHours: 24 },
  { from: 'amex-membership-rewards', to: 'ana-mileage-club', ratioNum: 1000, ratioDen: 1000, minTransfer: 1000, transferTimeHours: 48 },
  { from: 'amex-membership-rewards', to: 'avianca-lifemiles', ratioNum: 1000, ratioDen: 1000, minTransfer: 1000, transferTimeHours: 12 },
  { from: 'amex-membership-rewards', to: 'qantas-frequent-flyer', ratioNum: 1000, ratioDen: 1000, minTransfer: 1000, transferTimeHours: 24 },
  { from: 'amex-membership-rewards', to: 'emirates-skywards', ratioNum: 1000, ratioDen: 1000, minTransfer: 1000, transferTimeHours: 12 },
  { from: 'amex-membership-rewards', to: 'hilton-honors', ratioNum: 1000, ratioDen: 2000, minTransfer: 1000, transferTimeHours: 0 },
  { from: 'amex-membership-rewards', to: 'marriott-bonvoy', ratioNum: 1000, ratioDen: 1000, minTransfer: 1000, transferTimeHours: 2 },
  { from: 'amex-membership-rewards', to: 'eurostar-club', ratioNum: 1000, ratioDen: 1000, minTransfer: 1000, transferTimeHours: 24 },

  // Capital One
  { from: 'capital-one-miles', to: 'flying-blue', ratioNum: 1000, ratioDen: 1000, minTransfer: 1000, transferTimeHours: 2 },
  { from: 'capital-one-miles', to: 'british-airways-executive-club', ratioNum: 1000, ratioDen: 1000, minTransfer: 1000, transferTimeHours: 2 },
  { from: 'capital-one-miles', to: 'singapore-krisflyer', ratioNum: 1000, ratioDen: 1000, minTransfer: 1000, transferTimeHours: 36 },
  { from: 'capital-one-miles', to: 'avianca-lifemiles', ratioNum: 1000, ratioDen: 1000, minTransfer: 1000, transferTimeHours: 4 },
  { from: 'capital-one-miles', to: 'qantas-frequent-flyer', ratioNum: 1000, ratioDen: 1000, minTransfer: 1000, transferTimeHours: 24 },
  { from: 'capital-one-miles', to: 'emirates-skywards', ratioNum: 1000, ratioDen: 1000, minTransfer: 1000, transferTimeHours: 12 },

  // Bilt
  { from: 'bilt-rewards', to: 'united-mileageplus', ratioNum: 1000, ratioDen: 1000, minTransfer: 1000, transferTimeHours: 0 },
  { from: 'bilt-rewards', to: 'flying-blue', ratioNum: 1000, ratioDen: 1000, minTransfer: 1000, transferTimeHours: 0 },
  { from: 'bilt-rewards', to: 'british-airways-executive-club', ratioNum: 1000, ratioDen: 1000, minTransfer: 1000, transferTimeHours: 0 },
  { from: 'bilt-rewards', to: 'avianca-lifemiles', ratioNum: 1000, ratioDen: 1000, minTransfer: 1000, transferTimeHours: 4 },
  { from: 'bilt-rewards', to: 'emirates-skywards', ratioNum: 1000, ratioDen: 1000, minTransfer: 1000, transferTimeHours: 12 },
  { from: 'bilt-rewards', to: 'world-of-hyatt', ratioNum: 1000, ratioDen: 1000, minTransfer: 1000, transferTimeHours: 0 },
  { from: 'bilt-rewards', to: 'marriott-bonvoy', ratioNum: 1000, ratioDen: 1000, minTransfer: 1000, transferTimeHours: 24 },

  // Marriott Bonvoy -> airline, 3:1 in 3000-point blocks.
  { from: 'marriott-bonvoy', to: 'united-mileageplus', ratioNum: 3000, ratioDen: 1000, minTransfer: 3000, transferTimeHours: 48 },
  { from: 'marriott-bonvoy', to: 'british-airways-executive-club', ratioNum: 3000, ratioDen: 1000, minTransfer: 3000, transferTimeHours: 48 },
  { from: 'marriott-bonvoy', to: 'flying-blue', ratioNum: 3000, ratioDen: 1000, minTransfer: 3000, transferTimeHours: 48 },
  { from: 'marriott-bonvoy', to: 'singapore-krisflyer', ratioNum: 3000, ratioDen: 1000, minTransfer: 3000, transferTimeHours: 48 },
  { from: 'marriott-bonvoy', to: 'ana-mileage-club', ratioNum: 3000, ratioDen: 1000, minTransfer: 3000, transferTimeHours: 48 },
  { from: 'marriott-bonvoy', to: 'qantas-frequent-flyer', ratioNum: 3000, ratioDen: 1000, minTransfer: 3000, transferTimeHours: 48 },
  { from: 'marriott-bonvoy', to: 'emirates-skywards', ratioNum: 3000, ratioDen: 1000, minTransfer: 3000, transferTimeHours: 48 },

  // Hilton Honors -> airline, 10:1. Almost never worth doing.
  { from: 'hilton-honors', to: 'united-mileageplus', ratioNum: 10000, ratioDen: 1000, minTransfer: 10000, transferTimeHours: 24 },
  { from: 'hilton-honors', to: 'british-airways-executive-club', ratioNum: 10000, ratioDen: 1000, minTransfer: 10000, transferTimeHours: 24 },
  { from: 'hilton-honors', to: 'qantas-frequent-flyer', ratioNum: 10000, ratioDen: 1000, minTransfer: 10000, transferTimeHours: 24 },

  // World of Hyatt -> airline, 2.5:1.
  { from: 'world-of-hyatt', to: 'united-mileageplus', ratioNum: 5000, ratioDen: 2000, minTransfer: 5000, transferTimeHours: 48 },
];

/** Deterministic edge id: the same pair always produces the same row. */
export function transferIdFor(fromProgramId: string, toProgramId: string): string {
  return `tp_${shortHash(`${fromProgramId}|${toProgramId}`)}`;
}

/** Deterministic balance id: one row per (user, program), forever. */
export function balanceIdFor(userId: string, programId: string): string {
  return `bal_${shortHash(`${userId}|${programId}`)}`;
}

export function programIdFor(slug: string): string {
  return makeId('program', slug);
}

export function rowToProgram(row: Record<string, unknown>): LoyaltyProgram {
  return {
    id: String(row.id),
    name: String(row.name),
    kind: row.kind as ProgramKind,
    currencyName: String(row.currency_name),
    regionCode: (row.region_code as RegionCode) ?? null,
  };
}

export function rowToTransferPartner(row: Record<string, unknown>): TransferPartner {
  return {
    id: String(row.id),
    fromProgramId: String(row.from_program_id),
    toProgramId: String(row.to_program_id),
    ratioNum: Number(row.ratio_num),
    ratioDen: Number(row.ratio_den),
    minTransfer: Number(row.min_transfer),
    transferTimeHours: Number(row.transfer_time_hours),
    active: Number(row.active) === 1,
  };
}

export function rowToBalance(row: Record<string, unknown>): UserBalance {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    programId: String(row.program_id),
    balance: Number(row.balance),
    updatedAt: String(row.updated_at),
  };
}

export interface ProgramInput {
  id?: string;
  slug?: string;
  name: string;
  kind: ProgramKind;
  currencyName: string;
  regionCode?: RegionCode | null;
}

/** Insert or refresh one program. Idempotent on the derived id. */
export function upsertProgram(db: Db, p: ProgramInput): Result<string> {
  const id = p.id ?? (p.slug ? programIdFor(p.slug) : programIdFor(p.name));
  if (!PROGRAM_KIND_SET.has(p.kind)) {
    return err('invalid_input', `unknown program kind ${p.kind}`, { kind: p.kind });
  }
  try {
    db.run(
      `INSERT INTO loyalty_programs (id, name, kind, currency_name, region_code)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, kind = excluded.kind,
         currency_name = excluded.currency_name, region_code = excluded.region_code`,
      id, p.name, p.kind, p.currencyName, p.regionCode ?? null,
    );
  } catch (error) {
    return err('internal', `failed to write program ${id}`, { id }, error);
  }
  return ok(id);
}

export interface TransferInput {
  fromProgramId: string;
  toProgramId: string;
  ratioNum: number;
  ratioDen: number;
  minTransfer?: number;
  transferTimeHours?: number;
  active?: boolean;
}

/** Insert or refresh one transfer edge. Idempotent on (from, to). */
export function upsertTransferPartner(db: Db, t: TransferInput): Result<string> {
  if (t.fromProgramId === t.toProgramId) {
    return err('invalid_input', 'a program cannot transfer to itself', { programId: t.fromProgramId });
  }
  if (!Number.isFinite(t.ratioNum) || t.ratioNum <= 0 || !Number.isFinite(t.ratioDen) || t.ratioDen <= 0) {
    return err('invalid_input', `ratio must be positive, got ${t.ratioNum}:${t.ratioDen}`);
  }
  const id = transferIdFor(t.fromProgramId, t.toProgramId);
  try {
    db.run(
      `INSERT INTO transfer_partners
         (id, from_program_id, to_program_id, ratio_num, ratio_den, min_transfer, transfer_time_hours, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(from_program_id, to_program_id) DO UPDATE SET
         ratio_num = excluded.ratio_num, ratio_den = excluded.ratio_den,
         min_transfer = excluded.min_transfer,
         transfer_time_hours = excluded.transfer_time_hours,
         active = excluded.active`,
      id, t.fromProgramId, t.toProgramId, t.ratioNum, t.ratioDen,
      t.minTransfer ?? 1000, t.transferTimeHours ?? 0, t.active === false ? 0 : 1,
    );
  } catch (error) {
    return err('internal', `failed to write transfer ${t.fromProgramId} -> ${t.toProgramId}`,
      { fromProgramId: t.fromProgramId, toProgramId: t.toProgramId }, error);
  }
  return ok(id);
}

/**
 * Seed the whole loyalty graph. Safe to call on every CLI run: ids are derived
 * from content, so a second run rewrites the same rows rather than adding new
 * ones. The counts returned are rows written, not rows created.
 */
export function seedPrograms(db: Db): Result<{ programs: number; transfers: number }> {
  try {
    return db.transaction(() => {
      // loyalty_programs.region_code has an FK onto regions(code).
      ensureRegions(db);

      let programs = 0;
      for (const p of SEED_PROGRAMS) {
        const written = upsertProgram(db, {
          slug: p.slug, name: p.name, kind: p.kind,
          currencyName: p.currencyName, regionCode: p.regionCode,
        });
        if (!written.ok) return written as Result<{ programs: number; transfers: number }>;
        programs += 1;
      }

      let transfers = 0;
      for (const t of SEED_TRANSFERS) {
        const written = upsertTransferPartner(db, {
          fromProgramId: programIdFor(t.from),
          toProgramId: programIdFor(t.to),
          ratioNum: t.ratioNum,
          ratioDen: t.ratioDen,
          minTransfer: t.minTransfer,
          transferTimeHours: t.transferTimeHours,
          active: true,
        });
        if (!written.ok) return written as Result<{ programs: number; transfers: number }>;
        transfers += 1;
      }

      return ok({ programs, transfers });
    });
  } catch (error) {
    return err('internal', 'seedPrograms failed', undefined, error);
  }
}

export function getProgram(db: Db, id: string): LoyaltyProgram | null {
  const row = db.get<Record<string, unknown>>('SELECT * FROM loyalty_programs WHERE id = ?', id);
  return row ? rowToProgram(row) : null;
}

export function listPrograms(db: Db, kind?: ProgramKind): LoyaltyProgram[] {
  const rows = kind
    ? db.all<Record<string, unknown>>(
        'SELECT * FROM loyalty_programs WHERE kind = ? ORDER BY name', kind)
    : db.all<Record<string, unknown>>('SELECT * FROM loyalty_programs ORDER BY kind, name');
  return rows.map(rowToProgram);
}

/**
 * Set (not increment) a user's balance in one program. Balances are snapshots
 * of what the user reports holding, so the last write wins.
 */
export function setBalance(db: Db, userId: string, programId: string, balance: number): Result<string> {
  if (!Number.isFinite(balance) || balance < 0) {
    return err('invalid_input', `balance must be >= 0, got ${balance}`, { userId, programId, balance });
  }
  const points = Math.floor(balance);
  const user = db.get<{ id: string }>('SELECT id FROM users WHERE id = ?', userId);
  if (!user) return err('not_found', `unknown user ${userId}`, { userId });
  const program = db.get<{ id: string }>('SELECT id FROM loyalty_programs WHERE id = ?', programId);
  if (!program) return err('not_found', `unknown program ${programId}`, { programId });

  const id = balanceIdFor(userId, programId);
  try {
    db.run(
      `INSERT INTO user_balances (id, user_id, program_id, balance, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, program_id) DO UPDATE SET
         balance = excluded.balance, updated_at = excluded.updated_at`,
      id, userId, programId, points, nowIso(),
    );
  } catch (error) {
    return err('internal', `failed to write balance for ${userId}`, { userId, programId }, error);
  }
  return ok(id);
}

/** Balances the user holds, richest first. Zero balances are included. */
export function getBalances(db: Db, userId: string): UserBalance[] {
  return db
    .all<Record<string, unknown>>(
      `SELECT b.* FROM user_balances b
       JOIN loyalty_programs p ON p.id = b.program_id
       WHERE b.user_id = ?
       ORDER BY b.balance DESC, p.name ASC`,
      userId,
    )
    .map(rowToBalance);
}

/**
 * Outgoing edges from a program, active ones first. Inactive edges are
 * returned too (with `active: false`) so callers can explain why a route the
 * user remembers no longer works; routing itself ignores them.
 */
export function transferPartnersOf(db: Db, programId: string): TransferPartner[] {
  return db
    .all<Record<string, unknown>>(
      `SELECT * FROM transfer_partners WHERE from_program_id = ?
       ORDER BY active DESC, transfer_time_hours ASC, to_program_id ASC`,
      programId,
    )
    .map(rowToTransferPartner);
}

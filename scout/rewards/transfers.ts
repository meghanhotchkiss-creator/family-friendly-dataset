/**
 * Transfer routing, and the safety rail around it.
 *
 * Transferring points is the only irreversible action in this platform. Once
 * 60,000 Bonvoy points become 20,000 airline miles they can never go back, and
 * if the award seat vanishes during a 48-hour transfer window the user is left
 * holding a currency they did not want. So routing is only half the job: the
 * other half is `warnings`, and a plan without them is not a plan.
 *
 * Routing rules:
 *   - only ACTIVE edges are traversable
 *   - no program appears twice in a path (no cycles, no laundering loops)
 *   - default depth is 2 hops, because 3-hop routes exist on paper and are
 *     almost never worth the ratio loss
 *   - partial points are never credited anywhere: every hop floors
 */

import type { Db } from '../db/index.ts';
import type { Result, TransferPartner, TransferPlan, UserBalance } from '../contracts/index.ts';
import { ok, err } from '../contracts/index.ts';
import { getBalances, rowToTransferPartner } from './programs.ts';

export interface TransferRoute {
  path: TransferPartner[];
  /** Product of the hop ratios: points in per point out, end to end. */
  effectiveRatio: number;
  totalTimeHours: number;
}

/** Hops longer than this are the ones that eat award space. */
export const SLOW_TRANSFER_HOURS = 24;

/** Hard cap on search depth regardless of what the caller asks for. */
export const MAX_SEARCH_HOPS = 4;

/**
 * Apply one hop's ratio. `ratioNum` points out produce `ratioDen` points in,
 * and the result is FLOORED: no program on earth credits a partial point, and
 * rounding up here would quietly promise the user miles that never arrive.
 */
export function applyRatio(points: number, ratioNum: number, ratioDen: number): number {
  if (!Number.isFinite(points) || points <= 0) return 0;
  if (!Number.isFinite(ratioNum) || ratioNum <= 0) return 0;
  if (!Number.isFinite(ratioDen) || ratioDen <= 0) return 0;
  return Math.floor((points * ratioDen) / ratioNum);
}

function activeEdgesFrom(db: Db, programId: string): TransferPartner[] {
  return db
    .all<Record<string, unknown>>(
      `SELECT * FROM transfer_partners
       WHERE from_program_id = ? AND active = 1
       ORDER BY to_program_id ASC`,
      programId,
    )
    .map(rowToTransferPartner);
}

function routeRatio(path: TransferPartner[]): number {
  let ratio = 1;
  for (const hop of path) ratio *= hop.ratioDen / hop.ratioNum;
  return ratio;
}

function routeTime(path: TransferPartner[]): number {
  let hours = 0;
  for (const hop of path) hours += hop.transferTimeHours;
  return hours;
}

/**
 * Every acyclic active route from one program to another, up to `maxHops`.
 * Sorted the way `planTransfer` prefers them: fewest hops, then best effective
 * ratio, then fastest.
 */
export function findTransferRoutes(
  db: Db,
  fromProgramId: string,
  toProgramId: string,
  maxHops = 2,
): TransferRoute[] {
  if (fromProgramId === toProgramId) return [];
  const depth = Math.min(
    MAX_SEARCH_HOPS,
    Number.isFinite(maxHops) && maxHops >= 1 ? Math.floor(maxHops) : 2,
  );

  const routes: TransferRoute[] = [];
  const visited = new Set<string>([fromProgramId]);
  const path: TransferPartner[] = [];

  const walk = (current: string): void => {
    if (path.length >= depth) return;
    for (const edge of activeEdgesFrom(db, current)) {
      // No cycles: a program may appear at most once in a path.
      if (visited.has(edge.toProgramId)) continue;
      path.push(edge);
      if (edge.toProgramId === toProgramId) {
        const found = [...path];
        routes.push({
          path: found,
          effectiveRatio: routeRatio(found),
          totalTimeHours: routeTime(found),
        });
      } else {
        visited.add(edge.toProgramId);
        walk(edge.toProgramId);
        visited.delete(edge.toProgramId);
      }
      path.pop();
    }
  };

  walk(fromProgramId);

  routes.sort((a, b) => {
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;
    if (b.effectiveRatio !== a.effectiveRatio) return b.effectiveRatio - a.effectiveRatio;
    return a.totalTimeHours - b.totalTimeHours;
  });
  return routes;
}

/** Reduce a ratio for display: 3000:1000 -> "3:1", 1000:2000 -> "1:2". */
export function formatRatio(ratioNum: number, ratioDen: number): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(Math.abs(Math.round(ratioNum)), Math.abs(Math.round(ratioDen))) || 1;
  return `${Math.round(ratioNum) / divisor}:${Math.round(ratioDen) / divisor}`;
}

/** Percentage of value destroyed by a worse-than-1:1 hop. 3:1 -> 67. */
export function ratioLossPercent(ratioNum: number, ratioDen: number): number {
  if (ratioNum <= 0 || ratioDen <= 0) return 100;
  return Math.round((1 - ratioDen / ratioNum) * 100);
}

/**
 * Smallest `pointsOut` at the head of a route that keeps EVERY hop at or above
 * its minimum transfer. Computed backwards from the last hop, because a
 * 3000-point Bonvoy minimum on hop 2 forces a much larger hop 1.
 */
function minimumOutFor(path: TransferPartner[]): number {
  let required = 0;
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const hop = path[i];
    if (!hop) continue;
    // This hop must move at least its own minimum, and at least enough to
    // satisfy whatever the following hop demands.
    const forNext = required > 0 ? Math.ceil((required * hop.ratioNum) / hop.ratioDen) : 0;
    required = Math.max(hop.minTransfer, forNext);
  }
  return Math.max(1, required);
}

interface SimulatedStep {
  fromProgramId: string;
  toProgramId: string;
  pointsOut: number;
  pointsIn: number;
  transferTimeHours: number;
}

function simulate(path: TransferPartner[], pointsOut: number): SimulatedStep[] {
  const steps: SimulatedStep[] = [];
  let carry = Math.floor(pointsOut);
  for (const hop of path) {
    const pointsIn = applyRatio(carry, hop.ratioNum, hop.ratioDen);
    steps.push({
      fromProgramId: hop.fromProgramId,
      toProgramId: hop.toProgramId,
      pointsOut: carry,
      pointsIn,
      transferTimeHours: hop.transferTimeHours,
    });
    carry = pointsIn;
  }
  return steps;
}

function deliveredBy(path: TransferPartner[], pointsOut: number): number {
  const steps = simulate(path, pointsOut);
  const last = steps[steps.length - 1];
  return last ? last.pointsIn : 0;
}

/**
 * Smallest head-of-route `pointsOut` that actually delivers `target` points,
 * accounting for the floor at every hop. Starts from the ideal ratio-derived
 * figure and nudges upward; bounded so a pathological ratio cannot spin.
 */
function outForTarget(route: TransferRoute, target: number, cap: number): number {
  const ideal = Math.ceil(target / route.effectiveRatio);
  let out = Math.min(Math.max(ideal, 1), cap);
  const step = Math.max(1, Math.ceil(1 / route.effectiveRatio));
  for (let i = 0; i < 64 && out < cap && deliveredBy(route.path, out) < target; i += 1) {
    out = Math.min(cap, out + step);
  }
  return out;
}

interface Candidate {
  balance: UserBalance;
  route: TransferRoute;
}

/**
 * Build a transfer plan from the balances the user ACTUALLY holds toward the
 * program that can book the award.
 *
 * Preference order for sources: fewest hops, then best effective ratio, then
 * fastest, then largest balance. A direct balance in the target program always
 * wins over any transfer and is reported as such rather than being converted
 * into a pointless step.
 *
 * Field meanings on the returned plan:
 *   totalPointsFromUser  points leaving the user's OTHER programs (hop-1 outs)
 *   pointsDelivered      points standing in the target program once the plan
 *                        completes, including any direct balance
 *   shortfall            pointsNeeded - pointsDelivered, floored at 0
 */
export function planTransfer(
  db: Db,
  userId: string,
  toProgramId: string,
  pointsNeeded: number,
): Result<TransferPlan> {
  if (!Number.isFinite(pointsNeeded) || pointsNeeded <= 0) {
    return err('invalid_input', `pointsNeeded must be > 0, got ${pointsNeeded}`, { pointsNeeded });
  }
  const user = db.get<{ id: string }>('SELECT id FROM users WHERE id = ?', userId);
  if (!user) return err('not_found', `unknown user ${userId}`, { userId });
  const target = db.get<{ id: string; name: string; currency_name: string }>(
    'SELECT id, name, currency_name FROM loyalty_programs WHERE id = ?', toProgramId);
  if (!target) return err('not_found', `unknown program ${toProgramId}`, { toProgramId });

  const needed = Math.ceil(pointsNeeded);
  const names = new Map<string, string>();
  for (const row of db.all<{ id: string; name: string }>('SELECT id, name FROM loyalty_programs')) {
    names.set(row.id, row.name);
  }
  const nameOf = (id: string): string => names.get(id) ?? id;

  const balances = getBalances(db, userId);
  const direct = balances.find((b) => b.programId === toProgramId)?.balance ?? 0;

  const warnings: string[] = [];
  const steps: SimulatedStep[] = [];
  /** Points that actually leave the user's own accounts (head-of-route only). */
  let totalPointsFromUser = 0;
  let remaining = needed - direct;

  if (direct > 0) {
    warnings.push(
      remaining <= 0
        ? `No transfer needed: you already hold ${direct.toLocaleString('en-US')} ${target.currency_name} in ${target.name}, ` +
          `covering all ${needed.toLocaleString('en-US')} required.`
        : `Using ${direct.toLocaleString('en-US')} ${target.currency_name} already held in ${target.name}; ` +
          `${remaining.toLocaleString('en-US')} more needed.`,
    );
  }

  if (remaining > 0) {
    // Rank every program the user holds by how good its best route is.
    const candidates: Candidate[] = [];
    for (const balance of balances) {
      if (balance.programId === toProgramId || balance.balance <= 0) continue;
      const route = findTransferRoutes(db, balance.programId, toProgramId)[0];
      if (route) candidates.push({ balance, route });
    }
    candidates.sort((a, b) => {
      if (a.route.path.length !== b.route.path.length) return a.route.path.length - b.route.path.length;
      if (b.route.effectiveRatio !== a.route.effectiveRatio) return b.route.effectiveRatio - a.route.effectiveRatio;
      if (a.route.totalTimeHours !== b.route.totalTimeHours) return a.route.totalTimeHours - b.route.totalTimeHours;
      return b.balance.balance - a.balance.balance;
    });

    for (const candidate of candidates) {
      if (remaining <= 0) break;
      const { route, balance } = candidate;
      const head = route.path[0];
      if (!head) continue;

      const minOut = minimumOutFor(route.path);
      if (balance.balance < minOut) {
        warnings.push(
          `Skipped ${nameOf(balance.programId)}: balance ${balance.balance.toLocaleString('en-US')} is below the ` +
            `${minOut.toLocaleString('en-US')} minimum transfer required by ${routeLabel(route, nameOf)}.`,
        );
        continue;
      }

      const wanted = outForTarget(route, remaining, balance.balance);
      const pointsOut = Math.max(minOut, Math.min(wanted, balance.balance));
      const simulated = simulate(route.path, pointsOut);
      const delivered = simulated[simulated.length - 1]?.pointsIn ?? 0;
      if (delivered <= 0) continue;

      if (pointsOut > wanted) {
        warnings.push(
          `${nameOf(balance.programId)} enforces a ${minOut.toLocaleString('en-US')}-point minimum, so this plan moves ` +
            `${pointsOut.toLocaleString('en-US')} instead of the ${wanted.toLocaleString('en-US')} actually needed.`,
        );
      }

      for (const hop of route.path) {
        if (hop.ratioDen < hop.ratioNum) {
          warnings.push(
            `${nameOf(hop.fromProgramId)} -> ${nameOf(hop.toProgramId)} transfers at ` +
              `${formatRatio(hop.ratioNum, hop.ratioDen)} — you lose ` +
              `${ratioLossPercent(hop.ratioNum, hop.ratioDen)}% of value.`,
          );
        }
        if (hop.transferTimeHours > SLOW_TRANSFER_HOURS) {
          warnings.push(
            `${nameOf(hop.fromProgramId)} -> ${nameOf(hop.toProgramId)} takes about ` +
              `${hop.transferTimeHours} hours — award space may disappear before points arrive.`,
          );
        }
      }

      steps.push(...simulated);
      totalPointsFromUser += pointsOut;
      remaining -= delivered;
    }
  }

  const transferred = steps.length
    ? steps.filter((s) => s.toProgramId === toProgramId).reduce((sum, s) => sum + s.pointsIn, 0)
    : 0;
  const pointsDelivered = direct + transferred;
  const shortfall = Math.max(0, needed - pointsDelivered);

  if (steps.length > 0) {
    // Always. This is the one warning that is never conditional.
    warnings.unshift(
      'Transfers are irreversible — once these points leave, they cannot be moved back or refunded.',
    );
  }

  if (pointsDelivered > needed) {
    warnings.push(
      `Speculative transfer: this plan puts ${pointsDelivered.toLocaleString('en-US')} points in ${target.name} ` +
        `when only ${needed.toLocaleString('en-US')} are needed — ` +
        `${(pointsDelivered - needed).toLocaleString('en-US')} points are stranded there if the award disappears.`,
    );
  }

  if (shortfall > 0) {
    warnings.push(
      `Shortfall: ${shortfall.toLocaleString('en-US')} ${target.currency_name} short of the ` +
        `${needed.toLocaleString('en-US')} needed even after every available transfer. Do not start these transfers.`,
    );
  }

  return ok({
    toProgramId,
    steps: steps.map((s) => ({
      fromProgramId: s.fromProgramId,
      toProgramId: s.toProgramId,
      pointsOut: s.pointsOut,
      pointsIn: s.pointsIn,
      transferTimeHours: s.transferTimeHours,
    })),
    totalPointsFromUser,
    pointsDelivered,
    shortfall,
    warnings,
    feasible: shortfall === 0,
  });
}

function routeLabel(route: TransferRoute, nameOf: (id: string) => string): string {
  const head = route.path[0];
  if (!head) return 'this route';
  const parts = [nameOf(head.fromProgramId), ...route.path.map((h) => nameOf(h.toProgramId))];
  return parts.join(' -> ');
}

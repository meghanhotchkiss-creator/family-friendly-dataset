/**
 * npm run rewards:quote -- --origin=SFO --dest=LHR --user=user:demo
 *
 * Prints, for one user and one route: what they hold, the best award quotes
 * with cents-per-point AND confidence, the transfer plan with every warning it
 * carries, and the friction score broken down into its factors.
 *
 * Degrades rather than crashes: the airports table belongs to the travel-graph
 * import, and this CLI is useful (balances, programs, transfer plans) even
 * before that import has ever run.
 */

import { openDb, DEFAULT_DB_PATH } from '../db/index.ts';
import { explainConfidence, SOURCE_AUTHORITY, makeId } from '../contracts/index.ts';
import type { Airport, AwardQuote, LoyaltyProgram } from '../contracts/index.ts';
import { rowToAirport } from '../db/repo-core.ts';
import { seedPrograms, getProgram, getBalances, listPrograms } from '../rewards/programs.ts';
import { bestQuotes, compareQuotes, recordQuote } from '../rewards/points.ts';
import { planTransfer } from '../rewards/transfers.ts';
import { computeFriction, haversineKm, recordFriction } from '../rewards/friction.ts';

function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq === -1) out.set(arg.slice(2), 'true');
    else out.set(arg.slice(2, eq), arg.slice(eq + 1));
  }
  return out;
}

function fail(message: string): never {
  console.error(`rewards:quote: ${message}`);
  process.exit(1);
}

function num(args: Map<string, string>, key: string): number | undefined {
  const raw = args.get(key);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const args = parseArgs(process.argv.slice(2));
const dbPath = process.env.SCOUT_DB_PATH ?? DEFAULT_DB_PATH;
const db = openDb(dbPath);

const hasRewards = db.get<{ name: string }>(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='loyalty_programs'",
);
if (!hasRewards) fail(`no rewards schema at ${dbPath}. Run: npm run db:migrate`);

// ---------------------------------------------------------------- programs --
const programCount = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM loyalty_programs');
if (!programCount || Number(programCount.n) === 0) {
  const seeded = seedPrograms(db);
  if (!seeded.ok) fail(`could not seed programs: ${seeded.error.message}`);
  console.log(`seeded ${seeded.value.programs} programs, ${seeded.value.transfers} transfer edges`);
}

// ------------------------------------------------------------------- user --
const userId = args.get('user');
if (!userId) fail('missing --user=<userId>');
const user = db.get<{ id: string; display_name: string }>(
  'SELECT id, display_name FROM users WHERE id = ?', userId,
);
if (!user) {
  const known = db.all<{ id: string }>('SELECT id FROM users ORDER BY id LIMIT 5').map((u) => u.id);
  fail(`unknown user ${userId}${known.length ? ` (known: ${known.join(', ')})` : ' (no users yet)'}`);
}

console.log(`\nScout rewards — ${user.display_name} (${user.id})`);
console.log(`db: ${db.path}`);

// --------------------------------------------------------------- balances --
const balances = getBalances(db, user.id);
console.log('\nBalances');
if (balances.length === 0) {
  console.log('  (none recorded — set them with setBalance())');
} else {
  for (const balance of balances) {
    const program: LoyaltyProgram | null = getProgram(db, balance.programId);
    const label = program ? `${program.name} (${program.currencyName})` : balance.programId;
    console.log(`  ${String(balance.balance).padStart(9)}  ${label}`);
  }
}

// --------------------------------------------------------------- airports --
function resolveAirport(token: string | undefined): Airport | null {
  if (!token) return null;
  const direct = db.get<Record<string, unknown>>('SELECT * FROM airports WHERE id = ?', token);
  if (direct) return rowToAirport(direct);
  const code = token.trim().toUpperCase();
  const byIata = db.get<Record<string, unknown>>('SELECT * FROM airports WHERE iata = ?', code);
  if (byIata) return rowToAirport(byIata);
  const byDerivedId = db.get<Record<string, unknown>>(
    'SELECT * FROM airports WHERE id = ?', makeId('airport', code),
  );
  return byDerivedId ? rowToAirport(byDerivedId) : null;
}

const airportCount = Number(
  db.get<{ n: number }>('SELECT COUNT(*) AS n FROM airports')?.n ?? 0,
);
const originArg = args.get('origin');
const destArg = args.get('dest');
const origin = resolveAirport(originArg);
const dest = resolveAirport(destArg);

let routeUsable = true;
if (!originArg || !destArg) {
  console.log('\nRoute: skipped — pass --origin=<IATA|airportId> and --dest=<IATA|airportId>.');
  routeUsable = false;
} else if (airportCount === 0) {
  console.log(
    '\nRoute: skipped — the airports table is empty. Run `npm run travel:import:airports` first;' +
      ' balances and transfer plans above do not need it.',
  );
  routeUsable = false;
} else if (!origin || !dest) {
  const missing = [!origin ? originArg : null, !dest ? destArg : null].filter(Boolean).join(', ');
  console.error(`\nrewards:quote: unknown airport(s): ${missing} (${airportCount} airports loaded)`);
  db.close();
  process.exit(1);
}

// ----------------------------------------------------------------- quotes --
let chosen: AwardQuote | null = null;

if (routeUsable && origin && dest) {
  console.log(`\nRoute: ${origin.iata ?? origin.id} -> ${dest.iata ?? dest.id}  (${origin.name} -> ${dest.name})`);

  if (args.has('demo')) {
    // Sample quotes so the CLI is demonstrable before any real feed exists.
    // Marked `seed` authority so they can never outrank a real quote.
    const samples = [
      { slug: 'united-mileageplus', pointsCost: 60000, cashCents: 98000, taxesCents: 5600, auth: [SOURCE_AUTHORITY.official] },
      { slug: 'flying-blue', pointsCost: 50000, cashCents: 98000, taxesCents: 24000, auth: [SOURCE_AUTHORITY.major_aggregator] },
      { slug: 'ana-mileage-club', pointsCost: 44000, cashCents: 98000, taxesCents: 9000, auth: [SOURCE_AUTHORITY.seed] },
    ];
    for (const sample of samples) {
      const recorded = recordQuote(db, {
        userId: user.id,
        originAirportId: origin.id,
        destinationAirportId: dest.id,
        programId: makeId('program', sample.slug),
        pointsCost: sample.pointsCost,
        cashCents: sample.cashCents,
        taxesCents: sample.taxesCents,
        sourceAuthorities: sample.auth,
        ageDays: 1,
      });
      if (!recorded.ok) console.error(`  demo quote skipped: ${recorded.error.message}`);
    }
  }

  const quotes = bestQuotes(db, origin.id, dest.id, Number(args.get('limit') ?? 5));
  const { best, ranked } = compareQuotes(db, quotes);
  chosen = best;

  console.log('\nAward quotes (ranked by cents-per-point x confidence)');
  if (ranked.length === 0) {
    console.log('  (no quotes recorded for this route — add them with recordQuote(), or pass --demo)');
  } else {
    for (const [index, entry] of ranked.entries()) {
      const program = getProgram(db, entry.quote.programId);
      console.log(
        `  ${index + 1}. ${(program?.name ?? entry.quote.programId).padEnd(34)} ` +
          `${String(entry.quote.pointsCost).padStart(7)} pts + $${(entry.quote.taxesCents / 100).toFixed(2)}`,
      );
      console.log(
        `     ${entry.centsPerPoint.toFixed(2)} cpp -> ${entry.confidenceAdjusted.toFixed(2)} adjusted   ` +
          `confidence ${explainConfidence(entry.quote.confidence)}`,
      );
    }
  }
}

// --------------------------------------------------------- transfer plan --
const targetProgramId = args.get('program') ?? chosen?.programId ?? null;
const pointsNeeded = num(args, 'points') ?? chosen?.pointsCost ?? null;

console.log('\nTransfer plan');
if (!targetProgramId || !pointsNeeded) {
  console.log('  (skipped — needs a target program and a points target; pass --program=<id> --points=<n>)');
} else {
  const target = getProgram(db, targetProgramId);
  const plan = planTransfer(db, user.id, targetProgramId, pointsNeeded);
  if (!plan.ok) {
    console.error(`  ${plan.error.kind}: ${plan.error.message}`);
  } else {
    const value = plan.value;
    console.log(
      `  target: ${target?.name ?? targetProgramId}, need ${pointsNeeded} ` +
        `-> delivers ${value.pointsDelivered} (${value.feasible ? 'FEASIBLE' : `SHORT by ${value.shortfall}`})`,
    );
    if (value.steps.length === 0) {
      console.log(
        value.shortfall > 0
          ? '  no viable transfer steps (see warnings)'
          : '  no transfer steps required',
      );
    } else {
      for (const step of value.steps) {
        console.log(
          `  ${getProgram(db, step.fromProgramId)?.name ?? step.fromProgramId} -> ` +
            `${getProgram(db, step.toProgramId)?.name ?? step.toProgramId}: ` +
            `${step.pointsOut} out -> ${step.pointsIn} in, ~${step.transferTimeHours}h`,
        );
      }
      console.log(`  total leaving your accounts: ${value.totalPointsFromUser}`);
    }
    if (value.warnings.length > 0) {
      console.log('  warnings:');
      for (const warning of value.warnings) console.log(`    ! ${warning}`);
    }
  }
}

// --------------------------------------------------------------- friction --
if (routeUsable && origin && dest) {
  const km = haversineKm(origin, dest);
  // Rough block time when the caller does not supply one: 45 minutes of
  // ground time plus 850 km/h of cruise, then an hour per connection.
  const stops = Math.max(0, Math.round(num(args, 'stops') ?? 0));
  const estimated = Math.round(45 + (km / 850) * 60 + stops * 90);
  const input = {
    stops,
    totalMinutes: Math.round(num(args, 'minutes') ?? estimated),
    departureHour: num(args, 'depart'),
    arrivalHour: num(args, 'arrive'),
    overnight: args.get('overnight') === 'true',
  };

  const recorded = recordFriction(db, origin.id, dest.id, input);
  const friction = recorded.ok ? recorded.value : { ...computeFriction(input) };
  if (!recorded.ok) console.error(`  friction not persisted: ${recorded.error.message}`);

  console.log('\nFriction');
  console.log(`  great-circle ${km.toFixed(0)} km, ${friction.totalMinutes} min, ${friction.stops} stop(s)`);
  console.log(`  score ${friction.score.toFixed(3)}  (0 = civilised nonstop, 1 = overnight ordeal)`);
  if (friction.factors.length === 0) {
    console.log('    (no friction factors — this is as easy as flying gets)');
  } else {
    for (const factor of friction.factors) {
      console.log(`    +${factor.contribution.toFixed(3)}  ${factor.label}`);
    }
  }
}

console.log(`\n${listPrograms(db).length} loyalty programs known.`);
db.close();

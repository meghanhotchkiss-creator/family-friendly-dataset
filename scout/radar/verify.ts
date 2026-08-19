/**
 * The verification workflow.
 *
 * A detected change is a hypothesis, not a fact. Before the Truth Engine gives
 * a Radar-observed value full weight, Radar tries -- in order of how much
 * evidence each method actually carries -- to corroborate it:
 *
 *   1. corroboration  another independent source already claims the new value.
 *                     Strongest signal, costs nothing, so it is tried first.
 *                     A source actively claiming something else -> disputed.
 *   2. refetch        ask the origin again. Catches the transient blip: a value
 *                     that has reverted was never a change, so -> rejected.
 *   3. heuristic      no corroboration available. A material change from a
 *                     high-authority source is accepted; a structural change on
 *                     a single unsupported source stays `unverified` and waits
 *                     for a human. Structure is where a wrong auto-accept does
 *                     the most damage, so the heuristic never grants it.
 *
 * The outcome is written three places: the `verifications` audit row, the delta,
 * and the `source_records` claim Radar filed for that change -- the last one is
 * what actually moves the confidence number, since VERIFICATION_WEIGHT is
 * applied by the Truth Engine to the claim, not to the delta.
 */

import type { Db } from '../db/index.ts';
import type {
  RadarDelta,
  Result,
  Transport,
  Verification,
  VerificationState,
  Watch,
} from '../contracts/index.ts';
import { ok, err, DELTA_MATERIAL_THRESHOLD } from '../contracts/index.ts';
import { defaultTransport } from '../connectors/transport.ts';
import { getSource, liveClaims } from '../db/repo-truth.ts';
import { canonicalHash, shortHash } from '../runtime/hash.ts';
import { nowIso } from '../runtime/clock.ts';
import { semanticDistance } from './delta.ts';
import { getDelta, normalizePayload, payloadOf, rowToDelta } from './scan.ts';
import { getWatch } from './watches.ts';

/** Authority at or above which the heuristic may accept a material change. */
export const HEURISTIC_AUTHORITY_THRESHOLD = 0.8;

export interface VerifyOptions {
  transport?: Transport;
  verifier?: string;
}

export interface VerifySummary {
  verified: number;
  disputed: number;
  rejected: number;
  unresolved: number;
}

let sequence = 0;

type Method = Verification['method'];

interface Attempt {
  method: Method;
  outcome: VerificationState;
  notes: string;
}

export function pendingDeltas(db: Db, limit = 100): RadarDelta[] {
  return db
    .all<Record<string, unknown>>(
      `SELECT * FROM radar_deltas
       WHERE verification = 'unverified' AND kind != 'cosmetic'
       ORDER BY created_at ASC, id ASC LIMIT ?`,
      limit,
    )
    .map(rowToDelta);
}

export function listVerifications(db: Db, deltaId: string): Verification[] {
  return db
    .all<Record<string, unknown>>(
      'SELECT * FROM verifications WHERE delta_id = ? ORDER BY created_at ASC, id ASC',
      deltaId,
    )
    .map((row) => ({
      id: String(row.id),
      deltaId: String(row.delta_id),
      verifier: String(row.verifier),
      method: row.method as Method,
      outcome: row.outcome as VerificationState,
      notes: (row.notes as string) ?? null,
      createdAt: String(row.created_at),
    }));
}

/** Agreement is exact-after-normalisation; contradiction is a material gap. */
function corroborate(db: Db, delta: RadarDelta, watch: Watch): Attempt | null {
  const others = liveClaims(db, delta.entityId, delta.field).filter(
    (claim) => claim.sourceId !== watch.sourceId,
  );
  if (others.length === 0) return null;

  const agreeing = others.filter((claim) => semanticDistance(claim.value, delta.newValue) === 0);
  if (agreeing.length > 0) {
    return {
      method: 'corroboration',
      outcome: 'auto_verified',
      notes: `${agreeing.length} independent source(s) claim the same value: ${agreeing
        .map((c) => c.sourceId)
        .join(', ')}`,
    };
  }

  const contradicting = others.filter(
    (claim) => semanticDistance(claim.value, delta.newValue) >= DELTA_MATERIAL_THRESHOLD,
  );
  if (contradicting.length > 0) {
    return {
      method: 'corroboration',
      outcome: 'disputed',
      notes: `${contradicting.length} source(s) claim something materially different: ${contradicting
        .map((c) => c.sourceId)
        .join(', ')}`,
    };
  }
  return null;
}

async function refetch(
  db: Db,
  delta: RadarDelta,
  watch: Watch,
  transport: Transport,
): Promise<Attempt | null> {
  // Unconditional on purpose: a 304 would prove nothing about the value.
  const response = await transport.request({
    url: watch.locator,
    method: 'GET',
    headers: { accept: 'application/json', 'cache-control': 'no-cache' },
  });
  if (!response.ok) return null;
  const res = response.value;
  if (res.status < 200 || res.status >= 300) return null;

  const payload = normalizePayload(watch, payloadOf(res.body ?? ''));
  if (!(delta.field in payload)) return null;

  const seen = payload[delta.field] ?? null;
  const toNew = semanticDistance(seen, delta.newValue);
  const toOld = semanticDistance(seen, delta.oldValue);

  if (toNew === 0 || toNew < toOld) {
    return {
      method: 'refetch',
      outcome: 'auto_verified',
      notes: `origin still serves the new value (distance ${toNew.toFixed(3)} vs old ${toOld.toFixed(3)})`,
    };
  }
  if (toOld === 0 || toOld < toNew) {
    return {
      method: 'refetch',
      outcome: 'rejected',
      notes: `origin reverted to the previous value (distance ${toOld.toFixed(3)} vs new ${toNew.toFixed(3)})`,
    };
  }
  return null;
}

function heuristic(db: Db, delta: RadarDelta, watch: Watch): Attempt {
  const source = getSource(db, watch.sourceId);
  const authority = source?.authority ?? 0;

  if (delta.kind === 'structural') {
    return {
      method: 'heuristic',
      outcome: 'unverified',
      notes: `structural change on a single unsupported source (authority ${authority.toFixed(2)}); held for review`,
    };
  }
  if (authority >= HEURISTIC_AUTHORITY_THRESHOLD) {
    return {
      method: 'heuristic',
      outcome: 'auto_verified',
      notes: `material change from a high-authority source (${authority.toFixed(2)} >= ${HEURISTIC_AUTHORITY_THRESHOLD})`,
    };
  }
  return {
    method: 'heuristic',
    outcome: 'unverified',
    notes: `no corroboration and source authority ${authority.toFixed(2)} is below ${HEURISTIC_AUTHORITY_THRESHOLD}`,
  };
}

/**
 * Push the outcome onto the source_record Radar filed for this change.
 *
 * The schema has no delta -> source_record foreign key (and the schema is
 * frozen), so the claim is re-identified the same way it was created: same
 * source, same entity, same field, same canonical value hash. Newest wins.
 */
export function propagateToSourceRecord(
  db: Db,
  delta: RadarDelta,
  sourceId: string,
  outcome: VerificationState,
): string | null {
  const hash = canonicalHash(delta.newValue ?? null);
  const row = db.get<{ id: string }>(
    `SELECT id FROM source_records
     WHERE source_id = ? AND entity_id = ? AND field = ? AND content_hash = ?
     ORDER BY observed_at DESC, id DESC LIMIT 1`,
    sourceId, delta.entityId, delta.field, hash,
  );
  if (!row) return null;
  db.run('UPDATE source_records SET verification = ? WHERE id = ?', outcome, row.id);
  return row.id;
}

export async function verifyDelta(
  db: Db,
  deltaId: string,
  opts: VerifyOptions = {},
): Promise<Result<Verification>> {
  const delta = getDelta(db, deltaId);
  if (!delta) return err('not_found', `unknown delta ${deltaId}`, { deltaId });
  const watch = getWatch(db, delta.watchId);
  if (!watch) return err('not_found', `delta ${deltaId} has no watch ${delta.watchId}`);

  const transport = opts.transport ?? defaultTransport();
  const verifier = opts.verifier ?? 'radar';

  let attempt = corroborate(db, delta, watch);
  if (!attempt) attempt = await refetch(db, delta, watch, transport);
  if (!attempt) attempt = heuristic(db, delta, watch);

  const createdAt = nowIso();
  sequence += 1;
  const id = `vf_${shortHash(`${deltaId}|${attempt.method}|${createdAt}|${sequence}`)}`;

  const verification: Verification = {
    id,
    deltaId,
    verifier,
    method: attempt.method,
    outcome: attempt.outcome,
    notes: attempt.notes,
    createdAt,
  };

  db.transaction(() => {
    db.run(
      `INSERT INTO verifications (id, delta_id, verifier, method, outcome, notes, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      verification.id, verification.deltaId, verification.verifier, verification.method,
      verification.outcome, verification.notes, verification.createdAt,
    );
    db.run('UPDATE radar_deltas SET verification = ? WHERE id = ?', verification.outcome, deltaId);
    propagateToSourceRecord(db, delta, watch.sourceId, verification.outcome);
  });

  return ok(verification);
}

export async function verifyPending(
  db: Db,
  opts: { limit?: number; transport?: Transport } = {},
): Promise<Result<VerifySummary>> {
  const summary: VerifySummary = { verified: 0, disputed: 0, rejected: 0, unresolved: 0 };
  const batch = pendingDeltas(db, opts.limit ?? 100);

  for (const delta of batch) {
    const result = await verifyDelta(db, delta.id, { transport: opts.transport });
    if (!result.ok) {
      summary.unresolved += 1;
      continue;
    }
    const outcome = result.value.outcome;
    if (outcome === 'auto_verified' || outcome === 'human_verified') summary.verified += 1;
    else if (outcome === 'disputed') summary.disputed += 1;
    else if (outcome === 'rejected') summary.rejected += 1;
    else summary.unresolved += 1;
  }

  return ok(summary);
}

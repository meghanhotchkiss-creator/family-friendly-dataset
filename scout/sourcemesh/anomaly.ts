/**
 * Anomaly detection over the ingestion funnel.
 *
 * This is the difference between a data pipeline and a data product. A run that
 * accepts 4,213 of 28,417 rows and reports success is worse than one that
 * fails: nobody investigates a green tick. SourceMesh compares the funnel
 * stages, finds where the population collapsed, works out WHY from the rejected
 * rows, and checks whether something already in the database could repair it.
 *
 * The airport case is the worked example: `continent` was blank for most of a
 * real feed, the region flag was derived from it, and 85% of rows vanished --
 * while `countries.iso2` could have answered for nearly all of them.
 */

import type { Db } from '../db/index.ts';
import type { SchemaProfile } from './profile.ts';

export interface FunnelStage {
  name: string;
  count: number;
}

export interface Anomaly {
  severity: 'info' | 'warning' | 'critical';
  stage: string;
  /** Share of rows lost at this stage, 0..1. */
  lossRatio: number;
  message: string;
  /** Field most likely responsible. */
  likelyCause: string | null;
  /** A concrete, checkable proposal -- not "investigate further". */
  repair: RepairProposal | null;
}

export interface RepairProposal {
  description: string;
  /** e.g. airport.iso_country -> countries.iso2 -> countries.region_code */
  chain: string;
  /** Rejected rows this would recover, extrapolated from the sample. */
  recoverable: number;
  /** How many rejects were actually examined. */
  sampled: number;
  /** Recoveries observed within that sample. */
  recoverableInSample: number;
  /** The spec change that would apply it. */
  specPatch: Record<string, unknown>;
}

/** Loss at a single stage above this share is treated as systemic, not noise. */
export const SYSTEMIC_LOSS = 0.2;

export function detectFunnelAnomalies(stages: FunnelStage[]): Anomaly[] {
  const anomalies: Anomaly[] = [];
  for (let i = 1; i < stages.length; i += 1) {
    const before = stages[i - 1];
    const after = stages[i];
    if (!before || !after || before.count === 0) continue;
    const lost = before.count - after.count;
    if (lost <= 0) continue;
    const ratio = lost / before.count;
    if (ratio < SYSTEMIC_LOSS) continue;
    anomalies.push({
      severity: ratio >= 0.5 ? 'critical' : 'warning',
      stage: after.name,
      lossRatio: ratio,
      message:
        `${(ratio * 100).toFixed(1)}% of otherwise-valid records were rejected at ` +
        `"${after.name}" (${before.count.toLocaleString()} -> ${after.count.toLocaleString()}).`,
      likelyCause: null,
      repair: null,
    });
  }
  return anomalies;
}

export interface RejectionSample {
  reason: string;
  field: string | null;
  record: Record<string, unknown>;
}

/**
 * Explain a geography-stage anomaly and propose a repair.
 *
 * Deliberately concrete: it counts how many rejected rows carry a country code
 * that the `countries` table can already resolve, and reports that number.
 */
export function diagnoseGeoAnomaly(
  db: Db,
  anomaly: Anomaly,
  rejects: RejectionSample[],
  profile: SchemaProfile | null,
  totalRejected?: number,
): Anomaly {
  if (rejects.length === 0) return anomaly;

  // Which mapped field was blank on the rejected rows?
  const blankCounts = new Map<string, number>();
  for (const reject of rejects) {
    for (const [key, value] of Object.entries(reject.record)) {
      if (value === null || value === undefined || value === '') {
        blankCounts.set(key, (blankCounts.get(key) ?? 0) + 1);
      }
    }
  }
  const ranked = [...blankCounts.entries()].sort((a, b) => b[1] - a[1]);
  const culprit = ranked[0];
  const likelyCause = culprit ? culprit[0] : null;

  // Could the existing country graph answer for these rows?
  let recoverable = 0;
  const isoField = ['iso_country', 'countrycode', 'country_code', 'country', 'cca2']
    .find((f) => rejects.some((r) => r.record[f]));

  if (isoField) {
    const seen = new Map<string, boolean>();
    for (const reject of rejects) {
      const iso = String(reject.record[isoField] ?? '').toUpperCase();
      if (!iso) continue;
      if (!seen.has(iso)) {
        const row = db.get<{ n: number }>(
          'SELECT COUNT(*) n FROM countries WHERE iso2 = ?',
          iso,
        );
        seen.set(iso, Boolean(row && row.n > 0));
      }
      if (seen.get(iso)) recoverable += 1;
    }
  }

  // Rejects are sampled, so report the sample AND what it implies for the run.
  // Quoting the sample cap as if it were the population is how a diagnosis
  // becomes misleading.
  const sampled = rejects.length;
  const scale = totalRejected && sampled > 0 ? totalRejected / sampled : 1;
  const blankNote =
    culprit && profile
      ? ` Likely cause: ${culprit[0]} is blank for ${culprit[1].toLocaleString()} of ` +
        `${sampled.toLocaleString()} sampled rejects` +
        (scale > 1 ? ` (~${Math.round(culprit[1] * scale).toLocaleString()} of ${totalRejected!.toLocaleString()} rejected).` : '.')
      : '';

  return {
    ...anomaly,
    likelyCause,
    message: anomaly.message + blankNote,
    repair:
      isoField && recoverable > 0
        ? {
            description:
              `Resolve the region from the existing countries table instead of the ` +
              `source's own column.`,
            chain: `source.${isoField} -> countries.iso2 -> countries.region_code`,
            recoverable: Math.round(recoverable * scale),
            sampled,
            recoverableInSample: recoverable,
            specPatch: {
              fields: {
                regionCode: {
                  resolver: [
                    { lookup: { table: 'countries', match: 'iso2', using: isoField, from: 'region_code' } },
                  ],
                },
              },
            },
          }
        : null,
  };
}

/** Render an anomaly the way an operator should see it. */
export function formatAnomaly(anomaly: Anomaly): string {
  const lines = [`[${anomaly.severity.toUpperCase()}] ${anomaly.message}`];
  if (anomaly.repair) {
    lines.push(`  Suggested repair: ${anomaly.repair.description}`);
    lines.push(`    ${anomaly.repair.chain}`);
    lines.push(
      `    would recover ~${anomaly.repair.recoverable.toLocaleString()} rejected rows ` +
        `(${anomaly.repair.recoverableInSample.toLocaleString()}/${anomaly.repair.sampled.toLocaleString()} of the examined sample)`,
    );
  }
  return lines.join('\n');
}

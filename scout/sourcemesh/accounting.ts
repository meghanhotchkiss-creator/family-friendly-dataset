/**
 * Row accounting: every source row ends in exactly one terminal bucket.
 *
 * "No silent drops" is only enforceable if the buckets are checked against the
 * source count. If they do not sum, the run is defective regardless of how many
 * rows it inserted -- the missing rows went somewhere nobody is looking.
 */

export const REASON_CODES = [
  'MISSING_REQUIRED_FIELD',
  'OUT_OF_RANGE',
  'UNRESOLVED_GEOGRAPHY',
  'NO_MATCHING_COUNTRY',
  'DUPLICATE_IDENTITY',
  'UNPARSEABLE_RECORD',
  'UNSUPPORTED_ENTITY',
  'PERSIST_FAILED',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** Human text for an operator; the code is what machines branch on. */
export const REASON_TEXT: Readonly<Record<ReasonCode, string>> = {
  MISSING_REQUIRED_FIELD: 'a field the spec marks required was empty',
  OUT_OF_RANGE: 'a numeric field fell outside the range the spec allows',
  UNRESOLVED_GEOGRAPHY: 'the geography resolver chain produced nothing',
  NO_MATCHING_COUNTRY: 'the country code matches no row in the countries table',
  DUPLICATE_IDENTITY: 'another record in this run claims the same identity',
  UNPARSEABLE_RECORD: 'the record could not be read in the declared format',
  UNSUPPORTED_ENTITY: 'no sink is implemented for this entity type',
  PERSIST_FAILED: 'the record mapped cleanly but the write failed',
};

export interface RowAccounting {
  source_rows: number;
  parsed_rows: number;
  /**
   * Rows this spec is deliberately not about (see SelectSpec). A terminal
   * bucket, because they are a destination like any other -- but distinct from
   * `rejected`, which means the row was wanted and found wanting.
   */
  selected_out_rows: number;
  mapped_rows: number;
  validated_rows: number;
  matched_rows: number;
  inserted_rows: number;
  updated_rows: number;
  unchanged_rows: number;
  quarantined_rows: number;
  rejected_rows: number;
}

export function emptyAccounting(): RowAccounting {
  return {
    source_rows: 0, parsed_rows: 0, selected_out_rows: 0, mapped_rows: 0, validated_rows: 0, matched_rows: 0,
    inserted_rows: 0, updated_rows: 0, unchanged_rows: 0, quarantined_rows: 0, rejected_rows: 0,
  };
}

export interface AccountingCheck {
  balanced: boolean;
  terminal: number;
  unaccounted: number;
  explanation: string;
}

/**
 * Terminal buckets are the ones a row can finish in. `parsed`, `mapped`,
 * `validated` and `matched` are progress gauges, not destinations, so they are
 * deliberately excluded from the sum.
 */
export function checkAccounting(a: RowAccounting): AccountingCheck {
  const terminal =
    a.inserted_rows + a.updated_rows + a.unchanged_rows +
    a.quarantined_rows + a.rejected_rows + a.selected_out_rows;
  const unaccounted = a.source_rows - terminal;
  return {
    balanced: unaccounted === 0,
    terminal,
    unaccounted,
    explanation:
      unaccounted === 0
        ? `all ${a.source_rows.toLocaleString()} source rows accounted for`
        : `${Math.abs(unaccounted).toLocaleString()} rows ${unaccounted > 0 ? 'unaccounted for' : 'counted twice'} ` +
          `(source ${a.source_rows.toLocaleString()}, terminal ${terminal.toLocaleString()})`,
  };
}

export function formatAccounting(a: RowAccounting): string {
  const rows: [string, number][] = [
    ['source_rows', a.source_rows],
    ['parsed_rows', a.parsed_rows],
    ['selected_out_rows', a.selected_out_rows],
    ['mapped_rows', a.mapped_rows],
    ['validated_rows', a.validated_rows],
    ['matched_rows', a.matched_rows],
    ['inserted_rows', a.inserted_rows],
    ['updated_rows', a.updated_rows],
    ['unchanged_rows', a.unchanged_rows],
    ['quarantined_rows', a.quarantined_rows],
    ['rejected_rows', a.rejected_rows],
  ];
  const check = checkAccounting(a);
  return [
    ...rows.map(([k, v]) => `  ${k.padEnd(18)} ${String(v).padStart(8)}`),
    `  ${'—'.repeat(27)}`,
    `  ${(check.balanced ? 'BALANCED' : 'UNBALANCED').padEnd(18)} ${check.explanation}`,
  ].join('\n');
}

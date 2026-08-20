/**
 * npm run sourcemesh -- <command> [--source=id]
 *
 *   list      registered sources with licence and last ingestion
 *   inspect   schema profile + proposed mapping for a source
 *   validate  check the spec against the real data before a run
 *   ingest    run the funnel, report anomalies and repairs
 *   report    last run per source
 *   health    reachability and parseability per source
 */

import { openDb } from '../db/index.ts';
import { loadSpecs, loadSpec, registerAll, listRegistered, attributionNotice } from '../sourcemesh/registry.ts';
import { createSourceAdapter, formatAnomaly } from '../sourcemesh/adapter.ts';
import { writeRecords } from '../sourcemesh/sink.ts';
import {
  emptyAccounting, checkAccounting, formatAccounting, REASON_TEXT, type ReasonCode,
} from '../sourcemesh/accounting.ts';
import { quarantineRecords, quarantineSummary, recordAccounting, listQuarantine } from '../sourcemesh/quarantine.ts';
import { statusReport } from '../sourcemesh/status.ts';
import { resolveCities, mergeMatches, linkAirportsByGeonameId, MATCH_KM, NO_MATCH_KM } from '../sourcemesh/entity-resolution.ts';
import { unwrap } from '../contracts/index.ts';

const [command = 'list', ...rest] = process.argv.slice(2);
const sourceArg = rest.find((a) => a.startsWith('--source='))?.slice(9);
const limitArg = rest.find((a) => a.startsWith('--limit='))?.slice(8);
const dryRun = rest.includes('--dry-run');
const force = rest.includes('--force');

const db = openDb();
unwrap(registerAll(db));

const specs = sourceArg ? [loadSpec(sourceArg)].filter(Boolean) : loadSpecs();
if (specs.length === 0) {
  console.error(`no such source: ${sourceArg}`);
  process.exit(1);
}

function bar(count: number, max: number, width = 28): string {
  const n = max === 0 ? 0 : Math.round((count / max) * width);
  return '█'.repeat(n).padEnd(width, '·');
}

if (command === 'list') {
  console.log('registered sources\n');
  for (const s of listRegistered(db)) {
    console.log(`  ${s.sourceId.padEnd(24)} ${s.license.padEnd(10)} ${s.trustTier.padEnd(13)} ` +
      `last ingest: ${s.lastSuccessfulIngestion ?? 'never'}`);
  }
  console.log('\nattribution required when publishing:');
  for (const line of attributionNotice(db)) console.log(`  ${line}`);
} else if (command === 'health') {
  for (const spec of specs) {
    const health = await createSourceAdapter(db, spec!).healthCheck();
    console.log(`  ${health.status.padEnd(12)} ${spec!.id.padEnd(24)} ` +
      `${health.bytes !== null ? (health.bytes / 1024 / 1024).toFixed(1) + ' MB' : '—'} ${health.error ?? ''}`);
  }
} else if (command === 'inspect') {
  for (const spec of specs) {
    const adapter = createSourceAdapter(db, spec!);
    console.log(`\n=== ${spec!.id} (${spec!.format}) ===`);
    const profile = unwrap(await adapter.inspect());
    console.log(`  ${profile.recordCount.toLocaleString()} records, ${profile.fields.length} fields`);
    for (const f of profile.fields) {
      const pct = (f.populated * 100).toFixed(0).padStart(3);
      console.log(`    ${pct}%  ${f.name.padEnd(22)} ${f.inferredType.padEnd(8)} ${f.distinctSample.slice(0, 3).join(' | ').slice(0, 56)}`);
    }
    if (profile.neverPopulated.length > 0) {
      console.log(`  never populated: ${profile.neverPopulated.join(', ')}`);
    }
    const proposal = unwrap(await adapter.proposeMapping());
    console.log('  proposed mapping:');
    for (const [canonical, field] of Object.entries(proposal.mapping)) {
      console.log(`    ${canonical.padEnd(16)} <- ${field.padEnd(20)} (${proposal.confidence[canonical]})`);
    }
  }
} else if (command === 'validate') {
  let bad = 0;
  for (const spec of specs) {
    const result = unwrap(await createSourceAdapter(db, spec!).validateMapping());
    console.log(`\n=== ${spec!.id} === ${result.valid ? 'OK' : 'INVALID'}`);
    for (const issue of result.issues) console.log(`  - ${issue}`);
    if (!result.valid) bad += 1;
  }
  if (bad > 0) process.exit(1);
} else if (command === 'ingest') {
  let failed = 0;
  for (const spec of specs) {
    const adapter = createSourceAdapter(db, spec!);
    const started = Date.now();
    const result = unwrap(await adapter.ingest({
      dryRun, force,
      limit: limitArg ? Number(limitArg) : undefined,
    }));
    console.log(`\n=== ${spec!.id} === ${result.status} in ${Date.now() - started}ms`);
    if (result.unchanged) {
      console.log('  unchanged since the last run; skipped');
      continue;
    }
    const max = Math.max(...result.stages.map((s) => s.count), 1);
    for (const stage of result.stages) {
      const flag = stage.name === 'IMPORTED' && result.anomalies.length > 0 ? '  <- anomaly' : '';
      console.log(`  ${stage.name.padEnd(14)} ${String(stage.count).padStart(7)}  ${bar(stage.count, max)}${flag}`);
    }
    // Full row accounting: every source row lands in exactly one terminal
    // bucket, and the buckets are checked against the source count.
    const acct = emptyAccounting();
    acct.source_rows = result.stages.find((x) => x.name === 'SOURCE ROWS')?.count ?? 0;
    acct.parsed_rows = result.stages.find((x) => x.name === 'PARSED')?.count ?? 0;
    acct.mapped_rows = result.stages.find((x) => x.name === 'MAPPED')?.count ?? 0;
    const selected = result.stages.find((x) => x.name === 'SELECTED')?.count;
    acct.selected_out_rows = selected === undefined ? 0 : acct.source_rows - selected;
    acct.matched_rows = result.stages.find((x) => x.name === 'COUNTRY MATCHED')?.count ?? acct.mapped_rows;
    acct.validated_rows = result.imported;
    acct.rejected_rows = 0;

    // Validation rejects are retained in full so the run can be re-driven.
    if (!dryRun && result.rejections.length > 0) {
      quarantineRecords(db, result.runId, spec!.id, result.rejections, 'validate');
      acct.quarantined_rows += result.rejections.length;
    } else {
      acct.rejected_rows = result.rejected;
    }

    if (!dryRun && result.records.length > 0) {
      const written = writeRecords(db, spec!, result.records);
      if (written.ok) {
        acct.inserted_rows = written.value.inserted;
        acct.updated_rows = written.value.updated;
        acct.unchanged_rows = written.value.unchanged;
        acct.quarantined_rows += written.value.rejections.length;
        quarantineRecords(db, result.runId, spec!.id, written.value.rejections);
      } else {
        console.log(`  PERSIST FAILED: ${written.error.message}`);
        failed += 1;
      }
    }

    const check = checkAccounting(acct);
    if (!dryRun) recordAccounting(db, result.runId, acct, check.balanced);
    console.log(formatAccounting(acct));
    if (!check.balanced) {
      console.log(`  [CRITICAL] accounting does not balance: ${check.explanation}`);
      failed += 1;
    }
    if (acct.quarantined_rows > 0) {
      for (const [code, n] of Object.entries(quarantineSummary(db, result.runId))) {
        console.log(`  quarantined ${String(n).padStart(6)}  ${code}: ${REASON_TEXT[code as ReasonCode] ?? ''}`);
      }
    }
    for (const warning of result.warnings) console.log(`  warn: ${warning}`);
    for (const anomaly of result.anomalies) {
      console.log(formatAnomaly(anomaly).split('\n').map((l) => `  ${l}`).join('\n'));
    }
    if (result.status === 'failed') failed += 1;
  }
  if (failed > 0) process.exit(1);
} else if (command === 'status') {
  const report = statusReport(db);
  const width = Math.max(...report.map((r) => r.id.length));
  console.log('SCOUT SOURCE STATUS\n');
  for (const state of ['SEEDED', 'TESTED', 'CONNECTED', 'BUILT', 'BROKEN', 'NOT STARTED'] as const) {
    const group = report.filter((r) => r.state === state);
    if (group.length === 0) continue;
    console.log(`${state}`);
    for (const row of group) {
      console.log(`  ${row.id.padEnd(width)}  ${String(row.entity ?? '—').padEnd(8)} ${row.detail}` +
        (row.quarantined > 0 ? `  [${row.quarantined.toLocaleString()} quarantined]` : ''));
    }
    console.log();
  }
  const seeded = report.filter((r) => r.state === 'SEEDED' || r.state === 'TESTED').length;
  console.log(`${seeded}/${report.length} sources seeded; ` +
    `${report.filter((r) => r.state === 'BROKEN').length} broken; ` +
    `${report.filter((r) => r.state === 'NOT STARTED').length} not started`);
} else if (command === 'resolve') {
  // Identity first: a published GeoNames id leaves nothing to infer.
  const exact = unwrap(linkAirportsByGeonameId(db));
  console.log('exact linkage — airports to cities by GeoNames id\n');
  console.log(`  linked            ${String(exact.linked).padStart(7)}`);
  console.log(`  already correct   ${String(exact.alreadyCorrect).padStart(7)}`);
  console.log(`  no matching city  ${String(exact.noCityRow).padStart(7)}\n`);

  const stats = unwrap(resolveCities(db));
  console.log('entity resolution — cities\n');
  console.log(`  candidate pairs   ${String(stats.candidatePairs).padStart(7)}  (blocked on country + name)`);
  console.log(`  MATCH             ${String(stats.match).padStart(7)}  <= ${MATCH_KM}km apart`);
  console.log(`  POSSIBLE_MATCH    ${String(stats.possibleMatch).padStart(7)}  ${MATCH_KM}-${NO_MATCH_KM}km — left for review`);
  console.log(`  NO_MATCH          ${String(stats.noMatch).padStart(7)}  > ${NO_MATCH_KM}km — same name, different city`);
} else if (command === 'dedupe') {
  const before = db.get<{ n: number }>('SELECT COUNT(*) n FROM cities')?.n ?? 0;
  const stats = unwrap(mergeMatches(db));
  const after = db.get<{ n: number }>('SELECT COUNT(*) n FROM cities')?.n ?? 0;
  console.log('deduplication — cities\n');
  console.log(`  merged            ${String(stats.merged).padStart(7)}`);
  console.log(`  airports repointed${String(stats.airportsRepointed).padStart(7)}`);
  console.log(`  places repointed  ${String(stats.placesRepointed).padStart(7)}`);
  console.log(`  skipped           ${String(stats.skipped).padStart(7)}`);
  console.log(`\n  cities ${before.toLocaleString()} -> ${after.toLocaleString()}`);
  console.log('  POSSIBLE_MATCH pairs were NOT merged; an automatic decision there is what corrupts a graph.');
} else if (command === 'quarantine') {
  for (const spec of specs) {
    const rows = listQuarantine(db, spec!.id, limitArg ? Number(limitArg) : 10);
    console.log(`\n=== ${spec!.id} === ${rows.length} shown`);
    for (const row of rows) {
      console.log(`  ${row.reasonCode.padEnd(24)} ${String(row.sourceRecordId ?? '—').padEnd(12)} ${row.details}`);
      console.log(`    raw: ${row.rawRecord.slice(0, 120)}`);
    }
  }
} else if (command === 'report') {
  for (const row of db.all<Record<string, unknown>>(
    `SELECT source_id, status, source_rows, imported, rejected, started_at
     FROM ingestion_runs WHERE run_id IN (
       SELECT run_id FROM ingestion_runs r2 WHERE r2.source_id = ingestion_runs.source_id
       ORDER BY started_at DESC LIMIT 1
     ) ORDER BY source_id`,
  )) {
    console.log(`  ${String(row.source_id).padEnd(24)} ${String(row.status).padEnd(19)} ` +
      `${String(row.imported).padStart(7)} imported / ${String(row.source_rows).padStart(7)} rows`);
  }
} else {
  console.error(`unknown command: ${command}`);
  process.exit(1);
}

db.close();

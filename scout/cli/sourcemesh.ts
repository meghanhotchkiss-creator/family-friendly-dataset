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
    if (!dryRun && result.records.length > 0) {
      const written = writeRecords(db, spec!, result.records);
      if (written.ok) {
        const total = written.value.written + written.value.skipped;
        console.log(`  PERSISTED      ${String(written.value.written).padStart(7)}` +
          (written.value.skipped > 0
            ? `  (${written.value.skipped} not written: ${Object.entries(written.value.reasons).map(([k, n]) => `${k} x${n}`).join(', ')})`
            : ''));
        // Loss at the persistence stage is loss like any other.
        if (total > 0 && written.value.skipped / total >= 0.2) {
          console.log(`  [WARNING] ${((written.value.skipped / total) * 100).toFixed(1)}% of mapped records could not be persisted; ` +
            `check that upstream entities (countries, cities) were ingested first`);
        }
      } else {
        console.log(`  PERSIST FAILED: ${written.error.message}`);
        failed += 1;
      }
    }
    for (const warning of result.warnings) console.log(`  warn: ${warning}`);
    for (const anomaly of result.anomalies) {
      console.log(formatAnomaly(anomaly).split('\n').map((l) => `  ${l}`).join('\n'));
    }
    if (result.status === 'failed') failed += 1;
  }
  if (failed > 0) process.exit(1);
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

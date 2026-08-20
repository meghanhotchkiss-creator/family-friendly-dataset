/**
 * What a fresh clone gets.
 *
 * The upstream datasets are gitignored -- they carry their own licences -- so
 * the first thing anyone runs is against an empty `data/upstream`. That path
 * used to report nine failed countries and a wall of "credentials or egress not
 * available", which is wrong twice over: the cause was a missing file, not a
 * missing key, and it is one problem rather than nine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { openDb } from '../../scout/db/index.ts';
import { migrate } from '../../scout/db/migrate.ts';
import { ensureRegions } from '../../scout/db/repo-core.ts';
import { createOfflineTransport } from '../../scout/connectors/offline.ts';
import { createSourceAdapter, skipCause, SKIP_REMEDY } from '../../scout/sourcemesh/adapter.ts';
import { loadSpec, loadSpecs, registerAll } from '../../scout/sourcemesh/registry.ts';
import { geographyReport, formatGeographyReport } from '../../scout/api/data-validate.ts';
import { unwrap } from '../../scout/contracts/index.ts';

function db0() {
  const db = openDb(':memory:');
  migrate(db);
  ensureRegions(db);
  unwrap(registerAll(db));
  return db;
}

test('a missing local file is not reported as a missing credential', async () => {
  const db = db0();
  try {
    // Points at a directory that holds nothing, which is a fresh clone.
    const transport = createOfflineTransport('/nonexistent/upstream');
    const spec = loadSpec('ourairports');
    assert.ok(spec);

    const attempt = await createSourceAdapter(db, spec).ingest({ transport, force: true });
    assert.equal(attempt.ok, false);
    if (attempt.ok) return;

    // ourairports needs no credentials at all, so a credential message here
    // would send someone hunting for a key that does not exist.
    const cause = skipCause(spec, attempt.error);
    assert.equal(cause, 'no_local_data');
    assert.match(SKIP_REMEDY[cause], /data:fetch/);
    assert.doesNotMatch(SKIP_REMEDY[cause], /credential/i);
  } finally {
    db.close();
  }
});

test('a source that really is missing a credential still says so', async () => {
  const db = db0();
  try {
    const spec = loadSpec('wikimedia-enterprise');
    assert.ok(spec);
    const attempt = await createSourceAdapter(db, spec)
      .ingest({ transport: createOfflineTransport('/nonexistent/upstream'), force: true });
    assert.equal(attempt.ok, false);
    if (attempt.ok) return;

    // Even with no local file present, the credential is the blocking cause:
    // fetching would not help until the account exists.
    assert.equal(skipCause(spec, attempt.error), 'credentials');
  } finally {
    db.close();
  }
});

test('an empty travel graph is one failure naming the remedy, not nine country errors', () => {
  const db = db0();
  try {
    const report = geographyReport(db);
    assert.equal(report.failures.length, 1);
    assert.match(report.failures[0] ?? '', /empty/);
    assert.match(report.failures[0] ?? '', /data:fetch/);

    const text = formatGeographyReport(report);
    assert.match(text, /The travel graph is empty/);
    // The per-country table is noise when nothing has been loaded.
    assert.doesNotMatch(text, /no row in the countries table/);
  } finally {
    db.close();
  }
});

test('data:seed fetches before it ingests', () => {
  // The whole failure was a seed command that could not seed: it migrated,
  // ingested nothing, and validated the nothing.
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const seed = pkg.scripts['data:seed'] ?? '';
  assert.match(seed, /data:fetch/, 'data:seed must fetch the upstream datasets first');
  assert.ok(
    seed.indexOf('data:fetch') < seed.indexOf('data:ingest'),
    'the fetch has to come before the ingest',
  );
});

test('every spec can name a remedy for producing nothing', () => {
  // A skip with no stated remedy is the shape of the original bug.
  for (const spec of loadSpecs()) {
    for (const kind of ['not_configured', 'upstream_unavailable']) {
      const cause = skipCause(spec, { kind });
      assert.ok(SKIP_REMEDY[cause], `${spec.id} has no remedy for ${kind}`);
    }
  }
});

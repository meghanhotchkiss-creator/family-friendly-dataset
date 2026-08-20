/**
 * The offline transport exists so a closed egress policy is a constraint to
 * work within, not a dead end: real upstream files, same parsers, same claims.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOfflineTransport, candidatePaths, loadManifest } from '../../scout/connectors/offline.ts';

/**
 * Awaits the callback before cleaning up. Returning the promise from a `try`
 * and deleting the directory in `finally` would delete it at the callback's
 * first suspension point, not at its end.
 */
async function withDir(fn: (dir: string) => unknown | Promise<unknown>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'scout-offline-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('serves a raw upstream file by its URL path', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, 'ourairports-data'), { recursive: true });
    writeFileSync(join(dir, 'ourairports-data', 'airports.csv'), 'ident,name\nKORD,OHare\n');

    const t = createOfflineTransport(dir);
    assert.equal(t.mode, 'offline');
    const r = await t.request({ url: 'https://davidmegginson.github.io/ourairports-data/airports.csv' });
    assert.ok(r.ok);
    assert.equal(r.value.status, 200);
    assert.equal(r.value.headers['content-type'], 'text/csv');
    assert.match(r.value.body, /KORD/);
  });
});

test('a manifest maps an awkward URL onto a plain filename', async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ 'https://restcountries.com/v3.1/all': 'countries.json' }));
    writeFileSync(join(dir, 'countries.json'), JSON.stringify([{ cca2: 'US' }]));

    assert.deepEqual(loadManifest(dir), { 'https://restcountries.com/v3.1/all': 'countries.json' });
    const r = await createOfflineTransport(dir).request({ url: 'https://restcountries.com/v3.1/all?fields=cca2' });
    assert.ok(r.ok, 'a manifest prefix must match a URL carrying a query string');
    assert.match(r.value.body, /US/);
  });
});

test('a recorded fixture envelope is unwrapped, a raw JSON file is not', async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, 'enveloped.json'), JSON.stringify({ status: 201, headers: { 'content-type': 'application/json' }, body: { hello: 'world' } }));
    writeFileSync(join(dir, 'raw.json'), JSON.stringify({ hello: 'world' }));
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ 'https://x.test/a': 'enveloped.json', 'https://x.test/b': 'raw.json' }));

    const t = createOfflineTransport(dir);
    const enveloped = await t.request({ url: 'https://x.test/a' });
    assert.ok(enveloped.ok);
    assert.equal(enveloped.value.status, 201);
    assert.deepEqual(JSON.parse(enveloped.value.body), { hello: 'world' });

    const raw = await t.request({ url: 'https://x.test/b' });
    assert.ok(raw.ok);
    assert.equal(raw.value.status, 200);
    assert.deepEqual(JSON.parse(raw.value.body), { hello: 'world' });
  });
});

test('a missing file is an honest error naming every path tried', async () => {
  await withDir(async (dir) => {
    const r = await createOfflineTransport(dir).request({ url: 'https://api.example.test/v1/things?x=1' });
    assert.ok(!r.ok);
    assert.equal(r.error.kind, 'not_configured', 'must never fabricate a response');
    const tried = r.error.detail?.tried as string[];
    assert.ok(Array.isArray(tried) && tried.length >= 2, 'must say where it looked');
    assert.ok(tried.some((p) => p.includes('things')));
  });
});

test('candidate paths are ordered most specific first and de-duplicated', () => {
  const paths = candidatePaths('/base', 'https://h.test/a/b.csv', { 'https://h.test/a/b.csv': 'exact.csv' });
  assert.ok(paths[0]?.endsWith('exact.csv'), 'an exact manifest hit wins');
  assert.equal(new Set(paths).size, paths.length, 'no duplicates');
  assert.ok(paths.some((p) => p.endsWith(join('a', 'b.csv'))));
  assert.ok(paths.some((p) => p.endsWith('b.csv')));
});

test('a corrupt manifest degrades to path conventions instead of throwing', async () => {
  await withDir((dir) => {
    writeFileSync(join(dir, 'manifest.json'), '{ not json');
    assert.deepEqual(loadManifest(dir), {});
  });
});

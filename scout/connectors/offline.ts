/**
 * Offline transport: import REAL upstream datasets from local files.
 *
 * This exists because a closed egress policy is a legitimate constraint, not a
 * puzzle to solve. The operator obtains the upstream files through whatever
 * channel their environment permits -- an approved mirror, a vendor export, a
 * download on an unrestricted machine, an internal artifact store -- drops them
 * in a directory, and every adapter parses them exactly as it would parse a
 * live response. Same normalisation, same claims, same provenance, same
 * confidence maths. Only the byte source differs.
 *
 *   export SCOUT_TRANSPORT=offline
 *   export SCOUT_OFFLINE_DIR=./data/upstream      # default
 *   npm run travel:import:all
 *
 * Resolution order for a request URL:
 *   1. an explicit entry in <dir>/manifest.json  ({ "<url or url prefix>": "file" })
 *   2. a file named for the URL's own path, e.g.
 *      https://davidmegginson.github.io/ourairports-data/airports.csv
 *        -> <dir>/ourairports-data/airports.csv, or <dir>/airports.csv
 *   3. the fixture-style flattened name, so recorded fixtures still work
 *
 * A miss is `not_configured` naming the paths tried -- never a fabricated
 * response. An empty directory imports nothing rather than inventing anything.
 */

import { readFileSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Transport, TransportRequest, TransportResponse, Result } from '../contracts/index.ts';
import { ok, err } from '../contracts/index.ts';
import { fixtureNameFor } from './naming.ts';

export const DEFAULT_OFFLINE_DIR = resolve(process.cwd(), 'data', 'upstream');

export interface OfflineManifest {
  [urlOrPrefix: string]: string;
}

export function loadManifest(dir: string): OfflineManifest {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as OfflineManifest) : {};
  } catch {
    return {};
  }
}

/** Candidate local paths for a URL, most specific first. */
export function candidatePaths(dir: string, url: string, manifest: OfflineManifest = {}): string[] {
  const out: string[] = [];

  const exact = manifest[url];
  if (exact) out.push(resolve(dir, exact));
  for (const [key, file] of Object.entries(manifest)) {
    if (key !== url && url.startsWith(key)) out.push(resolve(dir, file));
  }

  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (parsed) {
    const path = parsed.pathname.replace(/^\/+/, '');
    if (path) {
      out.push(join(dir, path));
      out.push(join(dir, basename(path)));
    }
  }

  out.push(join(dir, fixtureNameFor({ url })));
  return [...new Set(out)];
}

function contentTypeFor(path: string): string {
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.csv')) return 'text/csv';
  if (path.endsWith('.txt')) return 'text/plain';
  return 'application/octet-stream';
}

/**
 * A file may be either the raw upstream payload (airports.csv, countries.json)
 * or a recorded fixture envelope. Raw is the normal case for a real download.
 */
function readAsResponse(path: string, startedAt: number): Result<TransportResponse> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    return err('internal', `could not read ${path}`, { path }, cause);
  }

  if (path.endsWith('.json')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
        'status' in (parsed as Record<string, unknown>) &&
        ('body' in (parsed as Record<string, unknown>) || 'bodyText' in (parsed as Record<string, unknown>))
      ) {
        const env = parsed as { status: number; headers?: Record<string, string>; body?: unknown; bodyText?: string };
        const body = env.bodyText ?? (typeof env.body === 'string' ? env.body : JSON.stringify(env.body ?? null));
        return ok({
          status: env.status ?? 200,
          headers: env.headers ?? { 'content-type': 'application/json' },
          body,
          replayed: true,
          latencyMs: Math.max(1, Date.now() - startedAt),
        });
      }
    } catch {
      // Not JSON at all -- fall through and serve it verbatim.
    }
  }

  return ok({
    status: 200,
    headers: { 'content-type': contentTypeFor(path) },
    body: raw,
    replayed: true,
    latencyMs: Math.max(1, Date.now() - startedAt),
  });
}

export function createOfflineTransport(dir: string = DEFAULT_OFFLINE_DIR): Transport {
  const manifest = loadManifest(dir);
  return {
    mode: 'offline',
    async request(req: TransportRequest): Promise<Result<TransportResponse>> {
      const startedAt = Date.now();
      const candidates = candidatePaths(dir, req.url, manifest);
      const found = candidates.find((p) => existsSync(p));
      if (!found) {
        return err('not_configured', `no local file for ${req.url}`, {
          offlineDir: dir,
          tried: candidates,
          hint: 'place the upstream file at one of these paths, or map it in manifest.json',
        });
      }
      return readAsResponse(found, startedAt);
    },
  };
}

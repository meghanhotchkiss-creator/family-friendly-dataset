/**
 * The single seam between Scout and the outside world.
 *
 * Every adapter goes through Transport, so adapter code -- request building,
 * parsing, normalisation, schema fingerprinting, error mapping -- is identical
 * whether the bytes came from the network or from a recorded fixture.
 *
 *   FixtureTransport  replays scout/connectors/fixtures/*.json (the default:
 *                     this environment's egress policy blocks external hosts
 *                     and commercial providers need credentials)
 *   HttpTransport     real network via fetch()
 *
 * Selection is by SCOUT_TRANSPORT=fixture|network. No adapter changes when the
 * switch flips -- that is the whole point of the seam.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Transport, TransportRequest, TransportResponse } from '../contracts/index.ts';
import { ok, err } from '../contracts/index.ts';
import type { Result } from '../contracts/index.ts';
import { shortHash } from '../runtime/hash.ts';

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Map a request to its fixture filename. Stable across runs. */
export function fixtureNameFor(req: TransportRequest): string {
  const url = new URL(req.url);
  const host = url.hostname.replace(/[^a-z0-9]+/gi, '-');
  const path = url.pathname.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'root';
  const query = url.search ? `-${shortHash(url.search + (req.body ?? ''))}` : '';
  return `${host}__${path}${query}.json`;
}

export interface FixtureEnvelope {
  status: number;
  headers?: Record<string, string>;
  /** Either a raw string body or a JSON value that will be stringified. */
  body?: unknown;
  bodyText?: string;
}

export function createFixtureTransport(fixtureDir: string = FIXTURE_DIR): Transport {
  return {
    mode: 'fixture',
    async request(req: TransportRequest): Promise<Result<TransportResponse>> {
      const started = Date.now();
      const name = fixtureNameFor(req);
      const path = join(fixtureDir, name);
      if (!existsSync(path)) {
        return err('not_configured', `no fixture for ${req.url}`, {
          expectedFixture: name,
          hint: 'record it, or set SCOUT_TRANSPORT=network once egress and credentials exist',
        });
      }
      let envelope: FixtureEnvelope;
      try {
        envelope = JSON.parse(readFileSync(path, 'utf8')) as FixtureEnvelope;
      } catch (cause) {
        return err('internal', `malformed fixture ${name}`, { path }, cause);
      }
      const body =
        envelope.bodyText ??
        (typeof envelope.body === 'string' ? envelope.body : JSON.stringify(envelope.body ?? null));
      return ok({
        status: envelope.status ?? 200,
        headers: envelope.headers ?? { 'content-type': 'application/json' },
        body,
        replayed: true,
        latencyMs: Math.max(1, Date.now() - started),
      });
    },
  };
}

export function createHttpTransport(): Transport {
  return {
    mode: 'network',
    async request(req: TransportRequest): Promise<Result<TransportResponse>> {
      const started = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), req.timeoutMs ?? 10_000);
      try {
        const response = await fetch(req.url, {
          method: req.method ?? 'GET',
          headers: req.headers as Record<string, string> | undefined,
          body: req.body,
          signal: controller.signal,
        });
        const body = await response.text();
        const headers: Record<string, string> = {};
        response.headers.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
        return ok({
          status: response.status,
          headers,
          body,
          replayed: false,
          latencyMs: Date.now() - started,
        });
      } catch (cause) {
        const aborted = cause instanceof Error && cause.name === 'AbortError';
        return err(
          aborted ? 'timeout' : 'upstream_unavailable',
          aborted ? `timed out after ${req.timeoutMs ?? 10_000}ms` : `request to ${req.url} failed`,
          { url: req.url },
          cause,
        );
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

/** Pick the transport for this process. Fixture unless explicitly told otherwise. */
export function defaultTransport(): Transport {
  return process.env.SCOUT_TRANSPORT === 'network' ? createHttpTransport() : createFixtureTransport();
}

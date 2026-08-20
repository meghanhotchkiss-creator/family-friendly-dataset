/**
 * Zero-dependency HTTP server for the Scout APIs.
 *
 * Deliberately knows nothing about the Truth Layer, Scout Mind or Sentinel: it
 * takes a route table, so the wiring lives in one place (scout/cli/api-serve.ts)
 * and this file stays testable without a database.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { Result } from '../contracts/index.ts';
import { nowIso } from '../runtime/clock.ts';

export interface ApiRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

export interface ApiReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export type ApiHandler = (req: ApiRequest) => ApiReply | Promise<ApiReply>;

export interface Route {
  method: 'GET' | 'POST';
  path: string;
  handler: ApiHandler;
  description: string;
}

/** Map a Result onto an HTTP reply using the one ErrorKind taxonomy. */
export function replyFromResult<T>(result: Result<T>, okStatus = 200): ApiReply {
  if (result.ok) return { status: okStatus, body: result.value };
  const status =
    result.error.kind === 'not_found' ? 404
    : result.error.kind === 'invalid_input' ? 400
    : result.error.kind === 'conflict' ? 409
    : result.error.kind === 'upstream_auth' ? 502
    : result.error.kind === 'upstream_rate_limited' ? 429
    : result.error.kind === 'timeout' ? 504
    : result.error.kind === 'not_configured' ? 501
    : result.error.kind === 'upstream_unavailable' ? 503
    : 500;
  return {
    status,
    body: { error: result.error.kind, message: result.error.message, detail: result.error.detail },
  };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function createApi(routes: Route[]): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const started = Date.now();
      const url = new URL(req.url ?? '/', 'http://localhost');
      const query: Record<string, string> = {};
      url.searchParams.forEach((v, k) => {
        query[k] = v;
      });

      const route = routes.find((r) => r.method === req.method && r.path === url.pathname);
      let reply: ApiReply;

      if (!route) {
        reply =
          url.pathname === '/'
            ? {
                status: 200,
                body: {
                  service: 'scout',
                  at: nowIso(),
                  routes: routes.map((r) => ({
                    method: r.method, path: r.path, description: r.description,
                  })),
                },
              }
            : { status: 404, body: { error: 'not_found', message: `no route ${req.method} ${url.pathname}` } };
      } else {
        try {
          reply = await route.handler({
            method: req.method ?? 'GET',
            path: url.pathname,
            query,
            body: req.method === 'POST' ? await readBody(req) : null,
          });
        } catch (cause) {
          reply = {
            status: 500,
            body: { error: 'internal', message: cause instanceof Error ? cause.message : String(cause) },
          };
        }
      }

      const payload = JSON.stringify(reply.body ?? null, null, 2);
      res.writeHead(reply.status, {
        'content-type': 'application/json; charset=utf-8',
        'x-response-time-ms': String(Date.now() - started),
        ...(reply.headers ?? {}),
      });
      res.end(payload);
    })();
  });
}

export function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve) => {
    server.listen(port, () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : port);
    });
  });
}

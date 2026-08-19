/**
 * npm run api:serve -- the Recommendation API and health/status endpoints.
 *
 * All the cross-subsystem wiring lives here, so scout/api/server.ts stays a
 * plain HTTP shell and every handler is a thin adapter over one track's
 * exported function.
 */

import { openDb } from '../db/index.ts';
import { createApi, listen, replyFromResult, type Route } from '../api/server.ts';
import { systemHealth, healthSummaryLine, isHealthy } from '../api/health.ts';
import { recommend } from '../intelligence/scoring.ts';
import { parseIntent } from '../intelligence/intent.ts';
import { recordSignal, buildUserGraph } from '../intelligence/user-graph.ts';
import { listResolutions } from '../intelligence/truth-engine.ts';
import { collectHealth, healthVerdict } from './radar-health.ts';
import { getPlace } from '../db/repo-places.ts';
import { err, ok } from '../contracts/index.ts';
import type { SignalKind, SignalContext } from '../contracts/index.ts';
import { nowIso } from '../runtime/clock.ts';

const db = openDb();
const port = Number(process.env.PORT ?? process.argv.find((a) => a.startsWith('--port='))?.slice(7) ?? 8787);

const routes: Route[] = [
  {
    method: 'GET', path: '/health', description: 'platform health across all subsystems',
    handler: () => {
      const health = systemHealth(db);
      return { status: isHealthy(health) ? 200 : 503, body: health };
    },
  },
  {
    method: 'GET', path: '/health/summary', description: 'one-line health summary',
    handler: () => {
      const health = systemHealth(db);
      return { status: isHealthy(health) ? 200 : 503, body: { summary: healthSummaryLine(health), status: health.status } };
    },
  },
  {
    method: 'GET', path: '/radar/health', description: 'radar scan and verification health',
    handler: () => {
      const health = collectHealth(db);
      const verdict = healthVerdict(health);
      return { status: verdict.healthy ? 200 : 503, body: { verdict, health } };
    },
  },
  {
    method: 'GET', path: '/recommend', description: 'ranked recommendations with explanations',
    handler: (req) => {
      const userId = req.query.user;
      const cityId = req.query.city;
      if (!userId || !cityId) {
        return replyFromResult(err('invalid_input', 'user and city query parameters are required'));
      }
      return replyFromResult(
        recommend(db, {
          userId,
          cityId,
          intent: req.query.intent ?? '',
          limit: req.query.limit ? Number(req.query.limit) : 10,
          exclude: req.query.exclude ? req.query.exclude.split(',').filter(Boolean) : [],
        }),
      );
    },
  },
  {
    method: 'GET', path: '/intent', description: 'parse a free-text intent',
    handler: (req) => ({ status: 200, body: parseIntent(req.query.q ?? '') }),
  },
  {
    method: 'POST', path: '/signal', description: 'record a user signal and relearn preferences',
    handler: (req) => {
      const body = (req.body ?? {}) as {
        userId?: string; placeId?: string; kind?: SignalKind;
        rating?: number | null; context?: SignalContext;
      };
      if (!body.userId || !body.placeId || !body.kind) {
        return replyFromResult(err('invalid_input', 'userId, placeId and kind are required'));
      }
      const recorded = recordSignal(db, {
        userId: body.userId, placeId: body.placeId, kind: body.kind,
        rating: body.rating ?? null, context: body.context ?? {},
      });
      if (!recorded.ok) return replyFromResult(recorded);
      const graph = buildUserGraph(db, body.userId);
      if (!graph.ok) return replyFromResult(graph);
      return {
        status: 201,
        body: { signalId: recorded.value, preferences: graph.value.preferences.length, at: nowIso() },
      };
    },
  },
  {
    method: 'GET', path: '/place', description: 'one place with its truth-layer provenance',
    handler: (req) => {
      const id = req.query.id;
      if (!id) return replyFromResult(err('invalid_input', 'id query parameter is required'));
      const place = getPlace(db, id);
      if (!place) return replyFromResult(err('not_found', `no place ${id}`));
      return replyFromResult(
        ok({
          place,
          provenance: listResolutions(db, id).map((r) => ({
            field: r.field, value: r.value, confidence: r.confidence.value,
            rationale: r.rationale, resolvedAt: r.resolvedAt,
          })),
        }),
      );
    },
  },
];

const server = createApi(routes);
const bound = await listen(server, port);
console.log(`scout api listening on http://127.0.0.1:${bound}`);
console.log(healthSummaryLine(systemHealth(db)));
for (const route of routes) console.log(`  ${route.method.padEnd(4)} ${route.path.padEnd(18)} ${route.description}`);

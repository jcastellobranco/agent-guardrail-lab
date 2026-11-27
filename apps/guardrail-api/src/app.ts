import type { AuditEvent } from '@lab/contracts';
import Fastify, { type FastifyRequest } from 'fastify';
import { performance } from 'node:perf_hooks';
import { CheckToolCall } from './application/check-tool-call.js';
import type {
  PolicyStore,
  TokenVerifier,
  InferenceClient,
  ToolUpstream,
} from './application/ports.js';
import { ProxyToolCall, type FlaggedCallMode } from './application/proxy-tool-call.js';
import { HttpError } from './domain/errors.js';
import { PromMetrics } from './infrastructure/metrics.js';

const noUpstreams: ToolUpstream = {
  has: () => false,
  forward: () => Promise.reject(new HttpError(404, 'TOOL_NOT_REGISTERED')),
};

export function buildApp(deps: {
  auth: TokenVerifier;
  store: PolicyStore;
  metrics?: PromMetrics;
  budgetMs?: number;
  logger?: boolean;
  inference?: InferenceClient;
  headroomMs?: number;
  audit?: { offer(event: AuditEvent): void };
  toolUpstream?: ToolUpstream;
  flaggedCalls?: FlaggedCallMode;
}) {
  const app = Fastify({
    logger: deps.logger ?? false,
    bodyLimit: 65536,
    requestTimeout: 10000,
    disableRequestLogging: true,
  });
  const metrics = deps.metrics ?? new PromMetrics();
  const check = new CheckToolCall({
    auth: deps.auth,
    store: deps.store,
    metrics,
    maxBudgetMs: deps.budgetMs,
    inference: deps.inference,
    headroomMs: deps.headroomMs,
  });
  const proxy = new ProxyToolCall({
    upstream: deps.toolUpstream ?? noUpstreams,
    flaggedCalls: deps.flaggedCalls ?? 'forward',
  });
  const pending = new WeakMap<object, AuditEvent>();
  app.addHook('onResponse', async (request) => {
    const event = pending.get(request);
    if (event) {
      pending.delete(request);
      deps.audit?.offer(event);
    }
  });
  const starts = new WeakMap<object, number>();
  app.addHook('onRequest', async (request) => {
    starts.set(request, performance.now());
  });
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500)
      return reply
        .code(status)
        .send({ error: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST' });
    req.log.error({ code: 'INTERNAL_ERROR' }, 'Guardrail request failed');
    return reply.code(503).send({ error: 'EVALUATION_UNAVAILABLE' });
  });

  /** Runs the guardrail check for this request; the audit event is offered after the response. */
  const evaluate = (request: FastifyRequest, body: unknown) =>
    check.execute(
      bearerToken(request),
      body,
      starts.get(request),
      deps.audit
        ? (event) => {
            pending.set(request, event);
          }
        : undefined,
    );

  app.post('/v1/check', async (request, reply) => {
    const decision = await evaluate(request, request.body);
    return reply.code(200).send(decision);
  });

  // Enforcement mode: the caller never talks to the tool directly, so a block cannot be ignored.
  app.post<{ Params: { tool: string } }>('/v1/proxy/:tool', async (request, reply) => {
    const result = await proxy.execute(request.params.tool, request.body, (call) =>
      evaluate(request, call),
    );
    return reply.code(result.forwarded ? 200 : 403).send(result);
  });

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_req, reply) => {
    const ready = deps.store.ready();
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready' });
  });
  app.get('/health/serving', async (_req, reply) => {
    const loaded = deps.store.hasSnapshot?.() ?? deps.store.ready();
    return reply
      .code(loaded ? 200 : 503)
      .send({ status: loaded ? 'serving' : 'not_ready', fresh: deps.store.ready() });
  });
  app.get('/metrics', async (_req, reply) =>
    reply.type(metrics.registry.contentType).send(await metrics.registry.metrics()),
  );
  return app;
}

function bearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!token) throw new HttpError(401, 'TOKEN_REQUIRED');
  return token;
}

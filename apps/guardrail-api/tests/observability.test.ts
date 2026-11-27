import { afterEach, describe, expect, it } from 'vitest';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { buildApp } from '../src/app.js';
import { HttpError } from '../src/domain/errors.js';
import { MemoryPolicyStore } from '../src/infrastructure/memory-policy-store.js';
import { PromMetrics } from '../src/infrastructure/metrics.js';
import { bundle, call, policy } from './fixtures.js';

const tokenVerifier = {
  verify: async (token: string) => {
    if (token !== 'valid') throw new HttpError(401, 'INVALID_TOKEN');
    return {
      sub: 'agent-a',
      tenantId: 'tenant-a',
      agentId: 'agent-a',
      jti: 'token',
      iss: 'i',
      aud: 'a',
      iat: 0,
      exp: 9999999999,
    };
  },
};

let app: ReturnType<typeof buildApp> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function setup(metrics?: PromMetrics) {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const store = new MemoryPolicyStore();
  store.replace(bundle(policy));
  app = buildApp({ auth: tokenVerifier, store, metrics, tracer: provider.getTracer('test') });
  const check = (payload: unknown, token = 'valid') =>
    app!.inject({
      method: 'POST',
      url: '/v1/check',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });
  // Exports are asynchronous; flush before reading finished spans.
  const spans = async () => {
    await provider.forceFlush();
    return exporter.getFinishedSpans();
  };
  return { spans, check };
}

describe('tracing', () => {
  it('emits one root span with a child span per stage', async () => {
    const { spans: finished, check } = setup();
    await check(call);

    const spans = await finished();
    const root = spans.find((span) => span.name === 'guardrail.check')!;
    const children = spans.filter(
      (span) => span.parentSpanContext?.spanId === root.spanContext().spanId,
    );

    expect(children.map((span) => span.name)).toEqual([
      'guardrail.auth',
      'guardrail.policy',
      'guardrail.rules',
      'guardrail.decision',
    ]);
    expect(
      children.every((span) => span.spanContext().traceId === root.spanContext().traceId),
    ).toBe(true);
    expect(root.attributes).toMatchObject({
      'guardrail.outcome': 'allow',
      'guardrail.degraded': false,
      'guardrail.policy_id': 'p',
      'guardrail.policy_version': 1,
    });
  });

  it('marks failures with the error code and keeps arguments out of the trace', async () => {
    const { spans: finished, check } = setup();
    await check({ ...call, arguments: { amount: 5, note: 'PRIVATE' } }, 'forged');

    const spans = await finished();
    const root = spans.find((span) => span.name === 'guardrail.check')!;
    expect(root.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(root.attributes['guardrail.error']).toBe('INVALID_TOKEN');
    expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain('PRIVATE');
  });
});

describe('metrics', () => {
  it('exposes event-loop delay and policy cache age', async () => {
    const metrics = new PromMetrics(() => ({ age: 12, version: 3, stale: false }));
    setup(metrics);

    const body = await (await app!.inject({ method: 'GET', url: '/metrics' })).body;

    expect(body).toContain('nodejs_eventloop_lag_p99_seconds');
    expect(body).toMatch(/^guardrail_policy_cache_age_seconds 12$/m);
    expect(body).toMatch(/^guardrail_policy_bundle_version 3$/m);
  });
});

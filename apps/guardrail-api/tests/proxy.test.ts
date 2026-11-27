import { afterEach, describe, expect, it } from 'vitest';
import type { AgentPolicy, Decision, ToolCall } from '@lab/contracts';
import { buildApp } from '../src/app.js';
import type { FlaggedCallMode } from '../src/application/proxy-tool-call.js';
import type { InferenceClient, ToolUpstream } from '../src/application/ports.js';
import { HttpError } from '../src/domain/errors.js';
import { MemoryPolicyStore } from '../src/infrastructure/memory-policy-store.js';
import { bundle, policy } from './fixtures.js';

const proxyPolicy: AgentPolicy = {
  ...policy,
  rules: [
    ...policy.rules,
    {
      id: 'sensitive-note',
      type: 'regex',
      targetPath: 'arguments.note',
      pattern: 'SECRET-[0-9]+',
      action: 'flag',
    },
  ],
};

const probePolicy = (failMode: AgentPolicy['failMode']): AgentPolicy => ({
  ...proxyPolicy,
  failMode,
  probes: {
    enabled: true,
    configurations: [
      { probeId: 'jailbreak', version: '1.0.0', flagThreshold: 0.5, blockThreshold: 0.8 },
    ],
  },
});

/** An inference service that never answers; only the guardrail deadline ends the request. */
const hangingInference: InferenceClient = {
  score: (_request, signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
};

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

class RecordingUpstream implements ToolUpstream {
  readonly calls: { call: ToolCall; decision: Decision }[] = [];
  constructor(private readonly tools = new Set(['transfer'])) {}
  has(tool: string) {
    return this.tools.has(tool);
  }
  async forward(call: ToolCall, decision: Decision) {
    this.calls.push({ call, decision });
    return { status: 200, body: { executed: call.tool } };
  }
}

let app: ReturnType<typeof buildApp> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function setup(
  options: {
    agentPolicy?: AgentPolicy;
    upstream?: ToolUpstream;
    inference?: InferenceClient;
    flaggedCalls?: FlaggedCallMode;
  } = {},
) {
  const store = new MemoryPolicyStore();
  store.replace(bundle(options.agentPolicy ?? proxyPolicy));
  const upstream = options.upstream ?? new RecordingUpstream();
  const recorded = upstream instanceof RecordingUpstream ? upstream : new RecordingUpstream();
  app = buildApp({
    auth: tokenVerifier,
    store,
    budgetMs: 100,
    inference: options.inference,
    toolUpstream: upstream,
    flaggedCalls: options.flaggedCalls,
  });
  const send = (body: unknown, tool = 'transfer', token = 'valid') =>
    app!.inject({
      method: 'POST',
      url: `/v1/proxy/${tool}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
  return { upstream: recorded, send };
}

// The regex rule fails closed on a missing `note`, so every call carries one.
const transfer = (args: Record<string, unknown>) => ({
  agentId: 'agent-a',
  arguments: { note: 'ordinary', ...args },
});

describe('proxy mode', () => {
  it('forwards an allowed call and returns the upstream response', async () => {
    const { upstream, send } = setup();
    const res = await send(transfer({ amount: 5 }));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      forwarded: true,
      decision: { outcome: 'allow' },
      upstream: { status: 200, body: { executed: 'transfer' } },
    });
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.call).toEqual({
      agentId: 'agent-a',
      tool: 'transfer',
      arguments: { note: 'ordinary', amount: 5 },
    });
  });

  it('never forwards a blocked call', async () => {
    const { upstream, send } = setup();
    const res = await send(transfer({ amount: 101 }));

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ forwarded: false, decision: { outcome: 'block' } });
    expect(upstream.calls).toHaveLength(0);
  });

  it('forwards flagged calls by default and passes the decision upstream', async () => {
    const { upstream, send } = setup();
    const res = await send(transfer({ amount: 5, note: 'SECRET-1' }));

    expect(res.statusCode).toBe(200);
    expect(upstream.calls[0]!.decision.outcome).toBe('flag');
  });

  it('holds flagged calls when configured to block them', async () => {
    const { upstream, send } = setup({ flaggedCalls: 'block' });
    const res = await send(transfer({ amount: 5, note: 'SECRET-1' }));

    expect(res.statusCode).toBe(403);
    expect(res.json().decision.outcome).toBe('flag');
    expect(upstream.calls).toHaveLength(0);
  });

  it('does not forward when inference times out under fail-closed', async () => {
    const { upstream, send } = setup({
      agentPolicy: probePolicy('closed'),
      inference: hangingInference,
    });
    const res = await send(transfer({ amount: 5 }));

    expect(res.statusCode).toBe(403);
    expect(res.json().decision).toMatchObject({ outcome: 'block', degraded: true });
    expect(res.json().decision.reasons).toContainEqual({
      code: 'INFERENCE_TIMEOUT',
      source: 'system',
    });
    expect(upstream.calls).toHaveLength(0);
  });

  it('forwards a degraded allow when inference times out under fail-open', async () => {
    const { upstream, send } = setup({
      agentPolicy: probePolicy('open'),
      inference: hangingInference,
    });
    const res = await send(transfer({ amount: 5 }));

    expect(res.statusCode).toBe(200);
    expect(res.json().decision).toMatchObject({ outcome: 'allow', degraded: true });
    expect(upstream.calls).toHaveLength(1);
  });

  it('does not forward unauthenticated calls', async () => {
    const { upstream, send } = setup();
    const res = await send(transfer({ amount: 5 }), 'transfer', 'forged');

    expect(res.statusCode).toBe(401);
    expect(upstream.calls).toHaveLength(0);
  });

  it('rejects a body that names a different tool than the URL', async () => {
    const { upstream, send } = setup();
    const res = await send({ ...transfer({ amount: 5 }), tool: 'delete' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'TOOL_MISMATCH' });
    expect(upstream.calls).toHaveLength(0);
  });

  it('returns 404 for an allowed tool with no configured upstream', async () => {
    const { upstream, send } = setup({ upstream: new RecordingUpstream(new Set()) });
    const res = await send(transfer({ amount: 5 }));

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'TOOL_NOT_REGISTERED' });
    expect(upstream.calls).toHaveLength(0);
  });

  it('reports an unreachable upstream as 502', async () => {
    const failing: ToolUpstream = {
      has: () => true,
      forward: () => Promise.reject(new HttpError(502, 'UPSTREAM_UNAVAILABLE')),
    };
    const { send } = setup({ upstream: failing });
    const res = await send(transfer({ amount: 5 }));

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'UPSTREAM_UNAVAILABLE' });
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { Decision } from '@lab/contracts';
import {
  GuardrailBlockedError,
  GuardrailClient,
  GuardrailError,
  isPermitted,
} from '../src/index.js';

const call = { agentId: 'agent-a', tool: 'transfer', arguments: { amount: 5 } };
const decision = (outcome: Decision['outcome']): Decision => ({
  decisionId: '00000000-0000-4000-8000-000000000001',
  outcome,
  policyId: 'p',
  policyVersion: 1,
  reasons: [
    { code: outcome === 'block' ? 'NUMERIC_LIMIT_EXCEEDED' : 'POLICY_ALLOWED', source: 'rule' },
  ],
  degraded: false,
  latencyMs: 1,
});
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function client(responses: (Response | Error)[], options: { timeoutMs?: number } = {}) {
  const fetchMock = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  });
  const sleeps: number[] = [];
  const guardrail = new GuardrailClient({
    baseUrl: 'http://guardrail.test',
    token: 'jwt',
    fetch: fetchMock as unknown as typeof fetch,
    random: () => 1,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    initialBackoffMs: 10,
    ...options,
  });
  return { guardrail, fetchMock, sleeps };
}

describe('GuardrailClient.check', () => {
  it('returns a validated decision and sends the bearer token', async () => {
    const { guardrail, fetchMock } = client([json(200, decision('allow'))]);

    await expect(guardrail.check(call)).resolves.toMatchObject({ outcome: 'allow' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe('http://guardrail.test/v1/check');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer jwt');
  });

  it('returns block decisions as decisions, not errors', async () => {
    const { guardrail } = client([json(200, decision('block'))]);
    await expect(guardrail.check(call)).resolves.toMatchObject({ outcome: 'block' });
  });

  it('retries 503 with exponential backoff, then succeeds', async () => {
    const { guardrail, fetchMock, sleeps } = client([
      json(503, { error: 'EVALUATION_UNAVAILABLE' }),
      json(503, { error: 'EVALUATION_UNAVAILABLE' }),
      json(200, decision('allow')),
    ]);

    await expect(guardrail.check(call)).resolves.toMatchObject({ outcome: 'allow' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([10, 20]);
  });

  it('throws after exhausting retries instead of returning allow', async () => {
    const { guardrail, fetchMock } = client([
      json(503, { error: 'EVALUATION_UNAVAILABLE' }),
      json(503, { error: 'EVALUATION_UNAVAILABLE' }),
      json(503, { error: 'EVALUATION_UNAVAILABLE' }),
    ]);

    await expect(guardrail.check(call)).rejects.toMatchObject({
      code: 'EVALUATION_UNAVAILABLE',
      status: 503,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    [401, 'INVALID_TOKEN'],
    [403, 'REVOKED_IDENTITY'],
    [400, 'INVALID_TOOL_CALL'],
  ])('does not retry %i', async (status, code) => {
    const { guardrail, fetchMock } = client([json(status, { error: code })]);

    await expect(guardrail.check(call)).rejects.toMatchObject({ code, status });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('retries connection failures', async () => {
    const { guardrail, fetchMock } = client([
      new TypeError('fetch failed'),
      json(200, decision('allow')),
    ]);

    await expect(guardrail.check(call)).resolves.toMatchObject({ outcome: 'allow' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects a 200 whose body is not a valid decision', async () => {
    const { guardrail } = client([json(200, { outcome: 'allow' })]);
    await expect(guardrail.check(call)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('times out against a guardrail that never answers', async () => {
    const guardrail = new GuardrailClient({
      baseUrl: 'http://guardrail.test',
      token: 'jwt',
      timeoutMs: 30,
      fetch: ((_url: URL, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason)),
        )) as unknown as typeof fetch,
    });

    const error = await guardrail.check(call).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GuardrailError);
    expect((error as GuardrailError).code).toBe('TIMEOUT');
  });

  it('asks for a fresh token on every attempt', async () => {
    const token = vi.fn(async () => 'fresh');
    const guardrail = new GuardrailClient({
      baseUrl: 'http://guardrail.test',
      token,
      fetch: vi
        .fn()
        .mockResolvedValueOnce(json(503, {}))
        .mockResolvedValueOnce(json(200, decision('allow'))) as unknown as typeof fetch,
      sleep: async () => {},
    });

    await guardrail.check(call);
    expect(token).toHaveBeenCalledTimes(2);
  });
});

describe('GuardrailClient.guard', () => {
  it('runs the tool when allowed', async () => {
    const { guardrail } = client([json(200, decision('allow'))]);
    const execute = vi.fn(async () => 'done');

    await expect(guardrail.guard(call, execute)).resolves.toBe('done');
  });

  it('never runs the tool when blocked', async () => {
    const { guardrail } = client([json(200, decision('block'))]);
    const execute = vi.fn(async () => 'done');

    await expect(guardrail.guard(call, execute)).rejects.toBeInstanceOf(GuardrailBlockedError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('never runs the tool when the guardrail fails', async () => {
    const { guardrail } = client([json(500, { error: 'EVALUATION_UNAVAILABLE' })]);
    const execute = vi.fn(async () => 'done');

    await expect(guardrail.guard(call, execute)).rejects.toBeInstanceOf(GuardrailError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('can refuse flagged calls', async () => {
    const { guardrail } = client([json(200, decision('flag'))]);
    const execute = vi.fn(async () => 'done');

    await expect(guardrail.guard(call, execute, { allowFlagged: false })).rejects.toBeInstanceOf(
      GuardrailBlockedError,
    );
    expect(isPermitted(decision('flag'))).toBe(true);
  });
});

describe('GuardrailClient.proxy', () => {
  it('treats a 403 "not forwarded" body as a decision', async () => {
    const { guardrail, fetchMock } = client([
      json(403, { forwarded: false, decision: decision('block') }),
    ]);

    await expect(
      guardrail.proxy('transfer', { agentId: 'agent-a', arguments: {} }),
    ).resolves.toMatchObject({
      forwarded: false,
      decision: { outcome: 'block' },
    });
    expect((fetchMock.mock.calls[0] as unknown as [URL])[0].pathname).toBe('/v1/proxy/transfer');
  });

  it('treats a 403 auth error as an error', async () => {
    const { guardrail } = client([json(403, { error: 'AGENT_MISMATCH' })]);
    await expect(
      guardrail.proxy('transfer', { agentId: 'agent-a', arguments: {} }),
    ).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });
});

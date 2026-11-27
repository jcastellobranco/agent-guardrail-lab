import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Decision } from '@lab/contracts';
import { HttpToolUpstream } from '../src/infrastructure/http-tool-upstream.js';

const decision: Decision = {
  decisionId: '00000000-0000-4000-8000-000000000001',
  outcome: 'allow',
  policyId: 'p',
  policyVersion: 1,
  reasons: [],
  degraded: false,
  latencyMs: 1,
};
const call = { agentId: 'agent-a', tool: 'transfer', arguments: { amount: 5 } };

let server: Server | undefined;
afterEach(async () => {
  await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined));
  server = undefined;
});

/** Starts a real HTTP tool server and returns its base URL. */
async function startTool(handler: Parameters<typeof createServer>[1] & {}): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

describe('HttpToolUpstream', () => {
  it('posts the evaluated call with decision headers and no credentials', async () => {
    let received: { headers: IncomingHttpHeaders; body: string } | undefined;
    const base = await startTool(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      received = { headers: req.headers, body };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    const upstream = new HttpToolUpstream({ urls: { transfer: `${base}/run` }, timeoutMs: 1000 });

    const result = await upstream.forward(call, decision);

    expect(result).toEqual({ status: 200, body: { ok: true } });
    expect(JSON.parse(received!.body)).toEqual(call);
    expect(received!.headers['x-guardrail-decision-id']).toBe(decision.decisionId);
    expect(received!.headers['x-guardrail-outcome']).toBe('allow');
    expect(received!.headers.authorization).toBeUndefined();
  });

  it('passes through non-2xx statuses and text bodies', async () => {
    const base = await startTool((_req, res) => {
      res.statusCode = 409;
      res.end('conflict');
    });
    const upstream = new HttpToolUpstream({ urls: { transfer: base }, timeoutMs: 1000 });

    expect(await upstream.forward(call, decision)).toEqual({ status: 409, body: 'conflict' });
  });

  it('maps a slow tool to UPSTREAM_UNAVAILABLE', async () => {
    const base = await startTool(() => {
      // Never respond.
    });
    const upstream = new HttpToolUpstream({ urls: { transfer: base }, timeoutMs: 50 });

    await expect(upstream.forward(call, decision)).rejects.toMatchObject({
      status: 502,
      code: 'UPSTREAM_UNAVAILABLE',
    });
  });

  it('rejects oversized responses', async () => {
    const base = await startTool((_req, res) => {
      res.end('x'.repeat(2048));
    });
    const upstream = new HttpToolUpstream({
      urls: { transfer: base },
      timeoutMs: 1000,
      maxResponseBytes: 1024,
    });

    await expect(upstream.forward(call, decision)).rejects.toMatchObject({
      code: 'UPSTREAM_RESPONSE_TOO_LARGE',
    });
  });

  it('only knows tools from its allowlist', () => {
    const upstream = new HttpToolUpstream({
      urls: { transfer: 'http://127.0.0.1:1' },
      timeoutMs: 1000,
    });
    expect(upstream.has('transfer')).toBe(true);
    expect(upstream.has('delete')).toBe(false);
  });
});

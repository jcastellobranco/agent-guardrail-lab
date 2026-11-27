import { describe, expect, it } from 'vitest';
import type { AgentPolicy, InferenceRequest } from '@lab/contracts';
import { buildApp } from '../src/app.js';
import type { InferenceClient } from '../src/application/ports.js';
import { MemoryPolicyStore } from '../src/infrastructure/memory-policy-store.js';
import { PromMetrics } from '../src/infrastructure/metrics.js';
import { bundle, call, policy } from './fixtures.js';

const shadowPolicy: AgentPolicy = {
  ...policy,
  latencyBudgetMs: 200,
  probes: {
    enabled: true,
    configurations: [
      {
        probeId: 'jailbreak',
        version: '1.0.0',
        flagThreshold: 0.5,
        blockThreshold: 0.8,
        shadow: { version: '2.0.0', flagThreshold: 0.5, blockThreshold: 0.8 },
      },
    ],
  },
};

const tokenVerifier = {
  verify: async () => ({
    sub: 'agent-a',
    tenantId: 'tenant-a',
    agentId: 'agent-a',
    jti: 'token',
    iss: 'i',
    aud: 'a',
    iat: 0,
    exp: 9999999999,
  }),
};

async function checkWithScores(current: number, candidate: number) {
  const requests: InferenceRequest[] = [];
  const inference: InferenceClient = {
    score: async (request) => {
      requests.push(request);
      return {
        scores: { 'jailbreak:1.0.0': current, 'jailbreak:2.0.0': candidate },
        modelVersion: 'test:v1',
        latencyMs: 1,
      };
    },
  };
  const metrics = new PromMetrics();
  const store = new MemoryPolicyStore();
  store.replace(bundle(shadowPolicy));
  const app = buildApp({ auth: tokenVerifier, store, metrics, inference, budgetMs: 200 });
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/check',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      payload: JSON.stringify(call),
    });
    const exported = await (await app.inject({ method: 'GET', url: '/metrics' })).body;
    return { decision: res.json(), requests, exported };
  } finally {
    await app.close();
  }
}

describe('shadow probe versions', () => {
  it('scores current and candidate in one inference request', async () => {
    const { requests } = await checkWithScores(0.1, 0.1);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.probeIds).toEqual(['jailbreak:1.0.0', 'jailbreak:2.0.0']);
  });

  it('decides with the current version even when the candidate would block', async () => {
    const { decision, exported } = await checkWithScores(0.1, 0.95);

    expect(decision.outcome).toBe('allow');
    expect(decision.reasons).toContainEqual({
      source: 'probe',
      code: 'PROBE_ALLOWED',
      probeId: 'jailbreak:1.0.0',
      score: 0.1,
    });
    expect(JSON.stringify(decision.reasons)).not.toContain('2.0.0');
    expect(exported).toContain(
      'guardrail_probe_shadow_outcomes_total{probe="jailbreak",version="1.0.0",role="current",outcome="allow"} 1',
    );
    expect(exported).toContain(
      'guardrail_probe_shadow_outcomes_total{probe="jailbreak",version="2.0.0",role="candidate",outcome="block"} 1',
    );
    expect(exported).toContain(
      'guardrail_probe_shadow_disagreements_total{probe="jailbreak",current_outcome="allow",candidate_outcome="block"} 1',
    );
  });

  it('still blocks when the current version blocks and the candidate allows', async () => {
    const { decision, exported } = await checkWithScores(0.95, 0.1);

    expect(decision.outcome).toBe('block');
    expect(exported).toContain('candidate_outcome="allow"} 1');
  });

  it('records no disagreement when both versions agree', async () => {
    const { exported } = await checkWithScores(0.6, 0.6);

    expect(exported).not.toMatch(/guardrail_probe_shadow_disagreements_total\{/);
    expect(exported).toContain('role="candidate",outcome="flag"} 1');
  });
});

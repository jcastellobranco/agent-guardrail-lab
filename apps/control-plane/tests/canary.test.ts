import { describe, expect, it } from 'vitest';
import { AgentPolicySchema, type AgentPolicy, type TelemetryWindow } from '@lab/contracts';
import {
  applyRollouts,
  evaluateRollout,
  inCanary,
  promote,
  type Rollout,
} from '../src/rollouts/canary.js';

const rollout: Rollout = {
  tenantId: 'tenant-a',
  probeId: 'jailbreak',
  stableVersion: '1.0.0',
  canaryVersion: '2.0.0',
  flagThreshold: 0.4,
  blockThreshold: 0.9,
  percent: 30,
  maxBlockRateIncrease: 0.05,
  minSamples: 100,
  status: 'active',
};

const policyFor = (agentId: string): AgentPolicy => ({
  schemaVersion: 1,
  policyId: 'p',
  version: 3,
  tenantId: 'tenant-a',
  agentId,
  defaultAction: 'block',
  tools: { allowlist: ['transfer'], denylist: [] },
  rules: [],
  probes: {
    enabled: true,
    configurations: [
      { probeId: 'jailbreak', version: '1.0.0', flagThreshold: 0.5, blockThreshold: 0.8 },
      { probeId: 'pii', version: '1.0.0', flagThreshold: 0.5, blockThreshold: 0.8 },
    ],
  },
  latencyBudgetMs: 50,
  failMode: 'closed',
});

const agents = Array.from({ length: 2000 }, (_, i) => `agent-${i}`);

describe('canary bucketing', () => {
  it('assigns roughly the configured share of agents, deterministically', () => {
    const selected = agents.filter((agent) => inCanary(rollout, agent));

    expect(selected.length / agents.length).toBeGreaterThan(0.25);
    expect(selected.length / agents.length).toBeLessThan(0.35);
    expect(agents.filter((agent) => inCanary(rollout, agent))).toEqual(selected);
  });

  it('keeps canary agents when ramping up', () => {
    const at30 = agents.filter((agent) => inCanary(rollout, agent));
    const at60 = new Set(agents.filter((agent) => inCanary({ ...rollout, percent: 60 }, agent)));

    expect(at30.every((agent) => at60.has(agent))).toBe(true);
  });

  it('selects nobody at 0% and everybody at 100%', () => {
    expect(agents.some((agent) => inCanary({ ...rollout, percent: 0 }, agent))).toBe(false);
    expect(agents.every((agent) => inCanary({ ...rollout, percent: 100 }, agent))).toBe(true);
  });
});

describe('applyRollouts', () => {
  const canaryAgent = agents.find((agent) => inCanary(rollout, agent))!;
  const stableAgent = agents.find((agent) => !inCanary(rollout, agent))!;

  it('gives canary agents the canary version and its thresholds, and nothing else changes', () => {
    const result = applyRollouts(policyFor(canaryAgent), [rollout]);

    expect(result.probes.configurations).toEqual([
      { probeId: 'jailbreak', version: '2.0.0', flagThreshold: 0.4, blockThreshold: 0.9 },
      { probeId: 'pii', version: '1.0.0', flagThreshold: 0.5, blockThreshold: 0.8 },
    ]);
    expect(AgentPolicySchema.safeParse(result).success).toBe(true);
  });

  it('leaves other agents on the stable version', () => {
    expect(applyRollouts(policyFor(stableAgent), [rollout])).toEqual(policyFor(stableAgent));
  });

  it.each(['rolled_back', 'aborted', 'promoted'] as const)(
    'stops substituting once a rollout is %s',
    (status) => {
      const policy = policyFor(canaryAgent);
      expect(applyRollouts(policy, [{ ...rollout, status }])).toEqual(policy);
    },
  );

  it('drops a shadow that would duplicate the canary version', () => {
    const policy = policyFor(canaryAgent);
    policy.probes.configurations[0]!.shadow = {
      version: '2.0.0',
      flagThreshold: 0.4,
      blockThreshold: 0.9,
    };

    const result = applyRollouts(policy, [rollout]);
    expect(result.probes.configurations[0]!.shadow).toBeUndefined();
    expect(AgentPolicySchema.safeParse(result).success).toBe(true);
  });

  it('promotes every agent', () => {
    expect(promote(policyFor(stableAgent), rollout).probes.configurations[0]!.version).toBe(
      '2.0.0',
    );
  });
});

describe('evaluateRollout', () => {
  const window = (counts: Record<string, { block: number; allow: number }>): TelemetryWindow => ({
    schemaVersion: 1,
    tenantId: 'tenant-a',
    deploymentId: 'd',
    windowStart: new Date(0).toISOString(),
    windowEnd: new Date(60000).toISOString(),
    decisions: [],
    probeMetrics: Object.entries(counts).map(([version, { block, allow }]) => ({
      probeId: 'jailbreak',
      version,
      histogram: [],
      decisions: [
        { outcome: 'allow', count: allow },
        { outcome: 'flag', count: 0 },
        { outcome: 'block', count: block },
      ],
    })),
    stageLatencies: [],
    cacheAgeSeconds: 0,
    stalePolicyCount: 0,
    versions: { guardrail: 'v', policyBundle: 1, probes: {} },
  });

  it('rolls back when the canary blocks more than the allowed increase', () => {
    const verdict = evaluateRollout(rollout, [
      window({ '1.0.0': { block: 10, allow: 190 }, '2.0.0': { block: 30, allow: 70 } }),
    ]);

    expect(verdict.action).toBe('rollback');
    expect(verdict.canary.rate).toBeCloseTo(0.3);
    expect(verdict.stable.rate).toBeCloseTo(0.05);
  });

  it('continues within the allowed increase', () => {
    const verdict = evaluateRollout(rollout, [
      window({ '1.0.0': { block: 10, allow: 190 }, '2.0.0': { block: 9, allow: 91 } }),
    ]);
    expect(verdict.action).toBe('continue');
  });

  it('waits for enough samples on both sides, summed across windows', () => {
    const early = window({ '1.0.0': { block: 1, allow: 49 }, '2.0.0': { block: 25, allow: 25 } });

    expect(evaluateRollout(rollout, [early]).action).toBe('continue');
    expect(evaluateRollout(rollout, [early, early]).action).toBe('rollback');
  });
});

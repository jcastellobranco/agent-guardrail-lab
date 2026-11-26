import { describe, it, expect } from 'vitest';
import { aggregate, BufferedAuditSink } from '../src/index.js';
import { TelemetryWindowSchema, type AuditEvent } from '@lab/contracts';
const event: AuditEvent = {
  tenantId: 'tenant',
  agentId: 'agent',
  timestamp: new Date().toISOString(),
  call: {
    agentId: 'agent',
    tool: 'transfer',
    arguments: { secret: 'PRIVATE_ARGUMENT' },
    context: { prompt: 'PRIVATE_PROMPT' },
  },
  decision: {
    decisionId: '00000000-0000-4000-8000-000000000001',
    outcome: 'flag',
    policyId: 'p',
    policyVersion: 1,
    reasons: [{ code: 'PROBE_FLAG', source: 'probe', probeId: 'jailbreak:1', score: 0.65 }],
    degraded: false,
    latencyMs: 5,
  },
  stages: [{ stage: 'rules', ms: 3 }],
  bundleVersion: 2,
  cacheAgeSeconds: 4,
};
describe('local audit and telemetry', () => {
  it('exports only allowlisted aggregate fields', () => {
    const t = aggregate('tenant', 'deployment', new Date(0), [event]);
    const raw = JSON.stringify(t);
    for (const forbidden of [
      'PRIVATE_ARGUMENT',
      'PRIVATE_PROMPT',
      'arguments',
      'prompt',
      'decisionId',
      'agentId',
      'call',
    ])
      expect(raw).not.toContain(forbidden);
    expect(TelemetryWindowSchema.safeParse({ ...t, call: event.call }).success).toBe(false);
    expect(
      TelemetryWindowSchema.safeParse({
        ...t,
        decisions: [{ policyId: 'p', outcome: 'flag', count: 1, prompt: 'x' }],
      }).success,
    ).toBe(false);
    expect(t.probeMetrics[0]?.histogram.reduce((a, b) => a + b.count, 0)).toBe(1);
  });
  it('does not mix tenants', () =>
    expect(() => aggregate('another', 'deployment', new Date(0), [event])).toThrow());
  it('drops excess events without waiting', async () => {
    let written = 0,
      dropped = 0;
    const sink = new BufferedAuditSink(
      async () => {
        written++;
      },
      () => {
        dropped++;
      },
      1,
    );
    sink.offer(event);
    sink.offer(event);
    await sink.close();
    expect(written).toBe(1);
    expect(dropped).toBe(1);
  });
});

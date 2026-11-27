import { describe, expect, it } from 'vitest';
import {
  ToolCallSchema,
  TelemetryWindowSchema,
  ProbeConfigurationSchema,
  probeKeys,
} from '../src/index.js';
const call = { agentId: 'agent', tool: 'read', arguments: { amount: 3 } };
describe('contracts', () => {
  it('accepts a valid call', () => expect(ToolCallSchema.safeParse(call).success).toBe(true));
  it('rejects tenant injection', () =>
    expect(ToolCallSchema.safeParse({ ...call, tenantId: 'other' }).success).toBe(false));
  it('rejects prototype keys', () =>
    expect(
      ToolCallSchema.safeParse(
        JSON.parse('{"agentId":"a","tool":"read","arguments":{"__proto__":{}}}'),
      ).success,
    ).toBe(false));
  it('rejects excessively deep input', () => {
    let x: unknown = 0;
    for (let i = 0; i < 20; i++) x = { x };
    expect(ToolCallSchema.safeParse({ ...call, arguments: { x } }).success).toBe(false);
  });
  it('rejects unordered probe thresholds', () =>
    expect(
      ProbeConfigurationSchema.safeParse({
        probeId: 'p',
        version: 'v1',
        flagThreshold: 0.9,
        blockThreshold: 0.8,
      }).success,
    ).toBe(false));
  it('accepts a shadow candidate and lists its key after the current versions', () => {
    const config = {
      probeId: 'jailbreak',
      version: '1.0.0',
      flagThreshold: 0.5,
      blockThreshold: 0.8,
      shadow: { version: '2.0.0', flagThreshold: 0.4, blockThreshold: 0.7 },
    };
    expect(ProbeConfigurationSchema.safeParse(config).success).toBe(true);
    expect(
      probeKeys({
        probes: { configurations: [config, { ...config, probeId: 'pii', shadow: undefined }] },
      }),
    ).toEqual(['jailbreak:1.0.0', 'pii:1.0.0', 'jailbreak:2.0.0']);
  });
  it('rejects a shadow identical to the current version', () =>
    expect(
      ProbeConfigurationSchema.safeParse({
        probeId: 'p',
        version: 'v1',
        flagThreshold: 0.5,
        blockThreshold: 0.8,
        shadow: { version: 'v1', flagThreshold: 0.5, blockThreshold: 0.8 },
      }).success,
    ).toBe(false));
  it('rejects raw trace fields in nested telemetry', () => {
    const sample = {
      schemaVersion: 1,
      tenantId: 't',
      deploymentId: 'd',
      windowStart: new Date(0).toISOString(),
      windowEnd: new Date(60000).toISOString(),
      decisions: [{ policyId: 'p', outcome: 'allow', count: 1 }],
      probeMetrics: [],
      stageLatencies: [],
      cacheAgeSeconds: 0,
      stalePolicyCount: 0,
      versions: { guardrail: 'v1', policyBundle: 1, probes: {} },
    };
    expect(TelemetryWindowSchema.safeParse(sample).success).toBe(true);
    expect(
      TelemetryWindowSchema.safeParse({
        ...sample,
        decisions: [{ ...sample.decisions[0], arguments: { secret: 'x' } }],
      }).success,
    ).toBe(false);
    expect(TelemetryWindowSchema.safeParse({ ...sample, prompt: 'secret' }).success).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { compilePolicy, decide, type Finding } from '../src/index.js';
import type { AgentPolicy, ToolCall } from '@lab/contracts';
const policy: AgentPolicy = {
  schemaVersion: 1,
  policyId: 'p',
  version: 1,
  tenantId: 't',
  agentId: 'a',
  defaultAction: 'block',
  tools: { allowlist: ['transfer'], denylist: ['delete', 'transfer_denied'] },
  rules: [
    {
      id: 'limit',
      type: 'numeric_limit',
      tool: 'transfer',
      argumentPath: 'amount',
      operator: 'gt',
      value: 100,
      action: 'block',
    },
    {
      id: 'note',
      type: 'regex',
      targetPath: 'arguments.note',
      pattern: 'SECRET-[0-9]+',
      action: 'flag',
    },
  ],
  probes: { enabled: false, configurations: [] },
  latencyBudgetMs: 50,
  failMode: 'closed',
};
const call = (args: ToolCall['arguments'], tool = 'transfer'): ToolCall => ({
  agentId: 'a',
  tool,
  arguments: args,
});
const run = (c: ToolCall, p = policy) => decide(compilePolicy(p).evaluate(c, () => false));
describe('deterministic rules', () => {
  it('allows an amount at the threshold', () =>
    expect(run(call({ amount: 100, note: 'ok' }))).toBe('allow'));
  it('blocks an excessive amount', () =>
    expect(run(call({ amount: 101, note: 'ok' }))).toBe('block'));
  it('flags sensitive text', () =>
    expect(run(call({ amount: 1, note: 'SECRET-123' }))).toBe('flag'));
  it('block takes precedence over flag', () =>
    expect(run(call({ amount: 101, note: 'SECRET-123' }))).toBe('block'));
  it('blocks unknown tools', () => expect(run(call({}, 'unknown'))).toBe('block'));
  it('denylist overrides allowlist', () =>
    expect(
      run(call({}, 'delete'), {
        ...policy,
        tools: { allowlist: ['delete'], denylist: ['delete'] },
      }),
    ).toBe('block'));
  it('fails closed on missing and invalid numeric values', () => {
    for (const args of [{ note: 'ok' }, { amount: '5', note: 'ok' }] as ToolCall['arguments'][])
      expect(run(call(args))).toBe('block');
  });
  it('fails closed on invalid regex target', () => expect(run(call({ amount: 1 }))).toBe('block'));
  it('rejects unsupported regex constructs when loading', () =>
    expect(() =>
      compilePolicy({
        ...policy,
        rules: [
          {
            id: 'x',
            type: 'regex',
            targetPath: 'arguments.note',
            pattern: '(?=x)',
            action: 'block',
          },
        ],
      }),
    ).toThrow());
  it('fails closed when rule evaluation deadline is exhausted', () =>
    expect(
      decide(compilePolicy(policy).evaluate(call({ amount: 1, note: 'ok' }), () => true)),
    ).toBe('block'));
  it('decides without changing order-dependent precedence', () => {
    const findings: Finding[] = [
      { outcome: 'block', reason: { code: 'A', source: 'rule' } },
      { outcome: 'allow', reason: { code: 'B', source: 'policy' } },
    ];
    expect(decide(findings)).toBe('block');
    expect(decide(findings.reverse())).toBe('block');
  });
});

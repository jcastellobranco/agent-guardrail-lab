import { describe, expect, it, vi } from 'vitest';
import type { Decision } from '@lab/contracts';
import { executeTool } from '../src/application/execute-tool.js';

const call = { agentId: 'agent', tool: 'echo', arguments: { value: 'hello' } };
function decision(outcome: Decision['outcome']): Decision {
  return {
    decisionId: '00000000-0000-4000-8000-000000000000',
    outcome,
    policyId: 'policy',
    policyVersion: 1,
    reasons: [],
    degraded: false,
    latencyMs: 1,
  };
}

describe('tool execution proxy', () => {
  it('never executes blocked calls', async () => {
    const handler = vi.fn(async () => 'hello');
    const result = await executeTool(
      call,
      async () => decision('block'),
      new Map([['echo', handler]]),
    );
    expect(result.executed).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(['allow', 'flag'] as const)('executes %s calls', async (outcome) => {
    const handler = vi.fn(async () => 'hello');
    const result = await executeTool(
      call,
      async () => decision(outcome),
      new Map([['echo', handler]]),
    );
    expect(result.executed).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('does not execute when evaluation fails', async () => {
    const handler = vi.fn(async () => 'hello');
    await expect(
      executeTool(
        call,
        async () => {
          throw new Error('unavailable');
        },
        new Map([['echo', handler]]),
      ),
    ).rejects.toThrow('unavailable');
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects unregistered tools', async () => {
    await expect(executeTool(call, async () => decision('allow'), new Map())).rejects.toThrow();
  });
});

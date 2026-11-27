import { ToolCallSchema, type Decision } from '@lab/contracts';
import { HttpError } from '../domain/errors.js';
import type { ToolUpstream, UpstreamResponse } from './ports.js';

/** What the proxy does with a call the policy marked as `flag`. */
export type FlaggedCallMode = 'forward' | 'block';

export interface ProxyToolCallOptions {
  upstream: ToolUpstream;
  flaggedCalls: FlaggedCallMode;
}

export type ProxyResult =
  | { forwarded: false; decision: Decision }
  | { forwarded: true; decision: Decision; upstream: UpstreamResponse };

/** Evaluates a tool call and forwards it upstream only when the decision permits execution. */
export type EvaluateCall = (call: unknown) => Promise<Decision>;

export class ProxyToolCall {
  private readonly upstream: ToolUpstream;
  private readonly flaggedCalls: FlaggedCallMode;

  constructor(options: ProxyToolCallOptions) {
    this.upstream = options.upstream;
    this.flaggedCalls = options.flaggedCalls;
  }

  async execute(tool: string, body: unknown, evaluate: EvaluateCall): Promise<ProxyResult> {
    const callWithTool = bindToolFromPath(tool, body);

    // Any evaluation error (auth, validation, 503) propagates, so nothing reaches the tool.
    const decision = await evaluate(callWithTool);
    if (!this.permits(decision.outcome)) {
      return { forwarded: false, decision };
    }

    // Unknown tools are rejected after authentication so callers cannot enumerate upstreams.
    if (!this.upstream.has(tool)) {
      throw new HttpError(404, 'TOOL_NOT_REGISTERED');
    }

    const call = ToolCallSchema.parse(callWithTool);
    const upstream = await this.upstream.forward(call, decision);
    return { forwarded: true, decision, upstream };
  }

  private permits(outcome: Decision['outcome']): boolean {
    if (outcome === 'allow') return true;
    if (outcome === 'flag') return this.flaggedCalls === 'forward';
    return false;
  }
}

/**
 * The tool name comes from the URL, so the call that is evaluated is the call that is forwarded.
 * A body naming a different tool is rejected instead of silently overwritten.
 */
function bindToolFromPath(tool: string, body: unknown): unknown {
  const isObject = typeof body === 'object' && body !== null && !Array.isArray(body);
  if (!isObject) return body;

  const bodyTool = (body as { tool?: unknown }).tool;
  if (bodyTool !== undefined && bodyTool !== tool) {
    throw new HttpError(400, 'TOOL_MISMATCH');
  }
  return { ...body, tool };
}

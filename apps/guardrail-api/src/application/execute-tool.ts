import { ToolCallSchema, type Decision, type ToolCall } from '@lab/contracts';
import { HttpError } from '../domain/errors.js';

export type ToolHandler = (call: ToolCall) => Promise<unknown>;

export async function executeTool(
  body: unknown,
  evaluate: (body: unknown) => Promise<Decision>,
  handlers: ReadonlyMap<string, ToolHandler>,
) {
  const decision = await evaluate(body);
  if (decision.outcome === 'block') return { decision, executed: false };
  const call = ToolCallSchema.parse(body);
  const handler = handlers.get(call.tool);
  if (!handler) throw new HttpError(404, 'TOOL_NOT_REGISTERED');
  const result = await handler(call);
  return { decision, executed: true, result };
}

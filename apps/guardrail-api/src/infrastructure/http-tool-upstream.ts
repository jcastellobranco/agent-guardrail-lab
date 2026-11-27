import type { Decision, ToolCall } from '@lab/contracts';
import type { ToolUpstream, UpstreamResponse } from '../application/ports.js';
import { HttpError } from '../domain/errors.js';

export interface HttpToolUpstreamOptions {
  /** Allowlist of tool name to upstream URL. Only these URLs are ever contacted. */
  urls: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxResponseBytes?: number;
  transport?: typeof fetch;
}

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

export class HttpToolUpstream implements ToolUpstream {
  private readonly urls: ReadonlyMap<string, URL>;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly transport: typeof fetch;

  constructor(options: HttpToolUpstreamOptions) {
    this.urls = new Map(Object.entries(options.urls).map(([tool, url]) => [tool, new URL(url)]));
    this.timeoutMs = options.timeoutMs;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.transport = options.transport ?? fetch;
  }

  has(tool: string): boolean {
    return this.urls.has(tool);
  }

  async forward(call: ToolCall, decision: Decision): Promise<UpstreamResponse> {
    const url = this.urls.get(call.tool);
    if (!url) throw new HttpError(404, 'TOOL_NOT_REGISTERED');

    let response: Response;
    try {
      response = await this.transport(url, {
        method: 'POST',
        // The agent's JWT is deliberately not forwarded: the tool never sees guardrail credentials.
        headers: {
          'content-type': 'application/json',
          'x-guardrail-decision-id': decision.decisionId,
          'x-guardrail-outcome': decision.outcome,
        },
        body: JSON.stringify(call),
        // This timeout covers tool execution, which is separate from the decision latency budget.
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch {
      throw new HttpError(502, 'UPSTREAM_UNAVAILABLE');
    }

    const text = await this.readBoundedText(response);
    return { status: response.status, body: parseBody(text, response.headers.get('content-type')) };
  }

  private async readBoundedText(response: Response): Promise<string> {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > this.maxResponseBytes) {
          await reader.cancel();
          throw new HttpError(502, 'UPSTREAM_RESPONSE_TOO_LARGE');
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, 'UPSTREAM_UNAVAILABLE');
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}

function parseBody(text: string, contentType: string | null): unknown {
  if (!contentType?.includes('application/json')) return text;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(502, 'UPSTREAM_INVALID_RESPONSE');
  }
}

import { DecisionSchema, type Decision, type ToolCall } from '@lab/contracts';
import { z } from 'zod';

export type { Decision, ToolCall };

export interface GuardrailClientOptions {
  baseUrl: string;
  /** A token, or a function that returns a fresh one (called once per attempt). */
  token: string | (() => string | Promise<string>);
  /** Total deadline for one check, across all retries. */
  timeoutMs?: number;
  /** Retries after the first attempt, only for 503 and connection failures. */
  maxRetries?: number;
  /** First backoff; doubles each retry, with full jitter. */
  initialBackoffMs?: number;
  fetch?: typeof fetch;
  /** Injected for deterministic tests. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Every failure is an exception. There is no code path that turns an error, timeout or
 * unexpected response into a decision, so a caller cannot accidentally treat it as allow.
 */
export class GuardrailError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    super(code);
    this.name = 'GuardrailError';
  }
}

/** Thrown by `guard` when the decision does not permit execution. */
export class GuardrailBlockedError extends Error {
  constructor(readonly decision: Decision) {
    super(`Tool call ${decision.outcome}: ${decision.reasons.map((r) => r.code).join(', ')}`);
    this.name = 'GuardrailBlockedError';
  }
}

const ProxyResponseSchema = z.union([
  z.object({ forwarded: z.literal(false), decision: DecisionSchema }),
  z.object({
    forwarded: z.literal(true),
    decision: DecisionSchema,
    upstream: z.object({ status: z.number().int(), body: z.unknown() }),
  }),
]);
export type ProxyResponse = z.infer<typeof ProxyResponseSchema>;

/** `flag` permits execution with a review marker unless the caller opts out. */
export function isPermitted(decision: Decision, options: { allowFlagged?: boolean } = {}) {
  if (decision.outcome === 'allow') return true;
  return decision.outcome === 'flag' && (options.allowFlagged ?? true);
}

export class GuardrailClient {
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly initialBackoffMs: number;
  private readonly transport: typeof fetch;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly token: () => Promise<string>;

  constructor(options: GuardrailClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? 250;
    this.maxRetries = options.maxRetries ?? 2;
    this.initialBackoffMs = options.initialBackoffMs ?? 25;
    this.transport = options.fetch ?? fetch;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const token = options.token;
    this.token = async () => (typeof token === 'string' ? token : await token());
  }

  /** Advisory check: returns the decision; the caller must enforce it. */
  async check(call: ToolCall): Promise<Decision> {
    const body = await this.post('/v1/check', call, [200]);
    return parse(DecisionSchema, body);
  }

  /** Enforcing mode: the guardrail forwards the call to the tool only if permitted. */
  async proxy(tool: string, call: Omit<ToolCall, 'tool'>): Promise<ProxyResponse> {
    // 403 carries a valid "not forwarded" body; it is a decision, not a transport failure.
    const body = await this.post(`/v1/proxy/${encodeURIComponent(tool)}`, call, [200, 403]);
    return parse(ProxyResponseSchema, body);
  }

  /** Checks the call and runs `execute` only when the decision permits it. */
  async guard<T>(
    call: ToolCall,
    execute: (decision: Decision) => Promise<T>,
    options: { allowFlagged?: boolean } = {},
  ): Promise<T> {
    const decision = await this.check(call);
    if (!isPermitted(decision, options)) throw new GuardrailBlockedError(decision);
    return execute(decision);
  }

  private async post(path: string, payload: unknown, accepted: number[]): Promise<unknown> {
    const deadline = Date.now() + this.timeoutMs;
    for (let attempt = 0; ; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new GuardrailError('TIMEOUT');

      const outcome = await this.attempt(path, payload, remaining);
      if ('body' in outcome && accepted.includes(outcome.status)) return outcome.body;

      const retryable = 'networkError' in outcome || outcome.status === 503;
      if (!retryable || attempt >= this.maxRetries) {
        throw 'networkError' in outcome
          ? new GuardrailError(outcome.networkError)
          : new GuardrailError(errorCode(outcome.body) ?? `HTTP_${outcome.status}`, outcome.status);
      }

      const backoff = this.random() * this.initialBackoffMs * 2 ** attempt;
      if (Date.now() + backoff >= deadline) throw new GuardrailError('TIMEOUT');
      await this.sleep(backoff);
    }
  }

  private async attempt(
    path: string,
    payload: unknown,
    remainingMs: number,
  ): Promise<{ status: number; body: unknown } | { networkError: string }> {
    let response: Response;
    try {
      response = await this.transport(new URL(path, this.baseUrl), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await this.token()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(remainingMs),
        redirect: 'error',
      });
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
      if (timedOut) throw new GuardrailError('TIMEOUT');
      return { networkError: 'UNREACHABLE' };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    return { status: response.status, body };
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new GuardrailError('INVALID_RESPONSE');
  return parsed.data;
}

function errorCode(body: unknown): string | undefined {
  const code = (body as { error?: unknown } | undefined)?.error;
  return typeof code === 'string' ? code : undefined;
}

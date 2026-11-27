import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { context, trace, SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api';
import { ToolCallSchema, type Decision, type StageName, type AuditEvent } from '@lab/contracts';
import { decide, type Finding } from '@lab/policy-engine';
import type { Metrics, PolicyStore, TokenVerifier, InferenceClient } from './ports.js';
import { evaluateProbes, InferenceFailure } from './evaluate-probes.js';
import { HttpError } from '../domain/errors.js';
export interface CheckToolCallOptions {
  auth: TokenVerifier;
  store: PolicyStore;
  metrics: Metrics;
  maxBudgetMs?: number;
  now?: () => number;
  inference?: InferenceClient;
  headroomMs?: number;
  /** Defaults to the global tracer, which is a no-op unless tracing is configured. */
  tracer?: Tracer;
}

/** performance.now() is relative to process start; spans need wall-clock milliseconds. */
const toEpochMs = (monotonicMs: number) => performance.timeOrigin + monotonicMs;

export class CheckToolCall {
  private readonly auth: TokenVerifier;
  private readonly store: PolicyStore;
  private readonly metrics: Metrics;
  private readonly maxBudgetMs: number;
  private readonly now: () => number;
  private readonly inference?: InferenceClient;
  private readonly headroomMs: number;
  private readonly tracer: Tracer;

  constructor(options: CheckToolCallOptions) {
    this.auth = options.auth;
    this.store = options.store;
    this.metrics = options.metrics;
    this.maxBudgetMs = options.maxBudgetMs ?? 50;
    this.now = options.now ?? (() => performance.now());
    this.inference = options.inference;
    this.headroomMs = options.headroomMs ?? 5;
    this.tracer = options.tracer ?? trace.getTracer('guardrail-api');
  }

  async execute(
    token: string,
    body: unknown,
    startedAt = this.now(),
    onAudit?: (event: AuditEvent) => void,
  ): Promise<Decision> {
    const root = this.tracer.startSpan('guardrail.check', { startTime: toEpochMs(startedAt) });
    try {
      const decision = await this.evaluate(root, token, body, startedAt, onAudit);
      root.setAttributes({
        'guardrail.outcome': decision.outcome,
        'guardrail.degraded': decision.degraded,
        'guardrail.policy_id': decision.policyId,
        'guardrail.policy_version': decision.policyVersion,
      });
      return decision;
    } catch (error) {
      // Only the error code is recorded: messages and arguments never enter a trace.
      const code = error instanceof HttpError ? error.code : 'EVALUATION_UNAVAILABLE';
      root.setAttribute('guardrail.error', code);
      root.setStatus({ code: SpanStatusCode.ERROR, message: code });
      throw error;
    } finally {
      root.end();
    }
  }

  private async evaluate(
    root: Span,
    token: string,
    body: unknown,
    startedAt: number,
    onAudit?: (event: AuditEvent) => void,
  ): Promise<Decision> {
    const stages: AuditEvent['stages'] = [];
    let modelVersion: string | undefined;
    const parent = trace.setSpan(context.active(), root);
    // One measurement feeds the Prometheus histogram, the audit trace and a child span.
    const record = (stage: StageName, start: number) => {
      const end = this.now();
      this.metrics.stage(stage, end - start);
      if (onAudit) stages.push({ stage, ms: end - start });
      this.tracer
        .startSpan(`guardrail.${stage}`, { startTime: toEpochMs(start) }, parent)
        .end(toEpochMs(end));
    };
    const timed = <T>(stage: StageName, fn: () => T): T => {
      const start = this.now();
      try {
        return fn();
      } finally {
        record(stage, start);
      }
    };
    const authStart = this.now();
    let claims;
    try {
      claims = await this.auth.verify(token);
    } finally {
      record('auth', authStart);
    }
    const parsed = ToolCallSchema.safeParse(body);
    if (!parsed.success) throw new HttpError(400, 'INVALID_TOOL_CALL');
    const call = parsed.data;
    if (claims.agentId !== call.agentId) throw new HttpError(403, 'AGENT_MISMATCH');
    const cached = timed('policy', () =>
      this.store.lookup(claims.tenantId, claims.agentId, claims.jti),
    );
    if (cached.revoked) throw new HttpError(403, 'REVOKED_IDENTITY');
    if (!cached.policy) throw new HttpError(403, 'POLICY_NOT_FOUND');
    const compiled = cached.policy;
    const policy = compiled.policy;
    const deadline = startedAt + Math.min(policy.latencyBudgetMs, this.maxBudgetMs);
    const expired = () => this.now() >= deadline;
    let degraded = false;
    const findings: Finding[] = timed('rules', () => compiled.evaluate(call, expired));
    if (cached.stale) {
      degraded = true;
      this.metrics.stale();
      findings.push({
        outcome: policy.failMode === 'closed' ? 'block' : 'allow',
        reason: { code: 'STALE_POLICY', source: 'system' },
      });
    }
    // Incomplete deterministic evaluation must fail closed, regardless of inference fail mode.
    if (expired() || findings.some((finding) => finding.reason.code === 'RULE_DEADLINE_EXCEEDED')) {
      degraded = true;
      findings.push({
        outcome: 'block',
        reason: { code: 'REQUEST_DEADLINE_EXCEEDED', source: 'system' },
      });
    }
    if (policy.probes.enabled && decide(findings) !== 'block') {
      const start = this.now();
      try {
        findings.push(
          ...(await evaluateProbes(
            call,
            policy,
            this.inference,
            deadline - this.now() - this.headroomMs,
            {
              onModelVersion: (version) => {
                modelVersion = version;
              },
              onShadow: (comparisons) => this.metrics.shadow?.(comparisons),
            },
          )),
        );
      } catch (error) {
        degraded = true;
        findings.push({
          outcome: policy.failMode === 'closed' ? 'block' : 'allow',
          reason: {
            code: error instanceof InferenceFailure ? error.code : 'INFERENCE_UNAVAILABLE',
            source: 'system',
          },
        });
      } finally {
        record('inference', start);
      }
    }
    const result = timed('decision', () => ({
      decisionId: randomUUID(),
      outcome: decide(findings),
      policyId: policy.policyId,
      policyVersion: policy.version,
      reasons: findings.map((finding) => finding.reason),
      degraded,
      latencyMs: 0,
    }));
    result.latencyMs = this.now() - startedAt;
    this.metrics.decision(result.outcome, degraded);
    onAudit?.({
      tenantId: claims.tenantId,
      agentId: claims.agentId,
      timestamp: new Date().toISOString(),
      call,
      decision: result,
      stages,
      modelVersion,
      bundleVersion: cached.bundleVersion ?? 0,
      cacheAgeSeconds: cached.cacheAgeSeconds ?? 0,
    });
    return result;
  }
}

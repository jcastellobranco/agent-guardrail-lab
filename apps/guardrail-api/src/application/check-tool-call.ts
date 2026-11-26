import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
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
}

export class CheckToolCall {
  private readonly auth: TokenVerifier;
  private readonly store: PolicyStore;
  private readonly metrics: Metrics;
  private readonly maxBudgetMs: number;
  private readonly now: () => number;
  private readonly inference?: InferenceClient;
  private readonly headroomMs: number;

  constructor(options: CheckToolCallOptions) {
    this.auth = options.auth;
    this.store = options.store;
    this.metrics = options.metrics;
    this.maxBudgetMs = options.maxBudgetMs ?? 50;
    this.now = options.now ?? (() => performance.now());
    this.inference = options.inference;
    this.headroomMs = options.headroomMs ?? 5;
  }
  async execute(
    token: string,
    body: unknown,
    startedAt = this.now(),
    onAudit?: (event: AuditEvent) => void,
  ): Promise<Decision> {
    const stages: AuditEvent['stages'] = [];
    let modelVersion: string | undefined;
    const record = (stage: StageName, ms: number) => {
      this.metrics.stage(stage, ms);
      if (onAudit) stages.push({ stage, ms });
    };
    const timed = <T>(stage: StageName, fn: () => T): T => {
      const start = this.now();
      try {
        return fn();
      } finally {
        record(stage, this.now() - start);
      }
    };
    const authStart = this.now();
    let claims;
    try {
      claims = await this.auth.verify(token);
    } finally {
      record('auth', this.now() - authStart);
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
            (v) => {
              modelVersion = v;
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
        record('inference', this.now() - start);
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

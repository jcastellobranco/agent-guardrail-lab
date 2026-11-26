import { z } from 'zod';

export const Id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/);
export const Outcome = z.enum(['allow', 'flag', 'block']);
export const FailMode = z.enum(['open', 'closed']);
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(JsonValueSchema), z.record(JsonValueSchema),
]));
// Inspect iteratively before recursive Zod parsing; cap both depth and total nodes.
export function boundedJson(input: unknown): boolean {
  const stack: { value: unknown; depth: number }[] = [{ value: input, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (++nodes > 4096 || depth > 10) return false;
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) return false;
        stack.push({ value: child, depth: depth + 1 });
      }
    }
  }
  return true;
}
export const ToolCallSchema = z.unknown().refine(boundedJson, 'JSON complexity limit exceeded').pipe(z.object({
  agentId: Id, tool: Id, arguments: z.record(JsonValueSchema),
  context: z.object({ sessionId: Id.optional(), conversationId: Id.optional(), prompt: z.string().max(8192).optional(), metadata: z.record(JsonValueSchema).optional() }).strict().optional(),
}).strict());
export type ToolCall = z.infer<typeof ToolCallSchema>;
export const AgentClaimsSchema = z.object({ sub: Id, tenantId: Id, agentId: Id, iss: z.string(), aud: z.union([z.string(), z.array(z.string())]), iat: z.number().int(), exp: z.number().int(), jti: Id }).passthrough();
export type AgentClaims = z.infer<typeof AgentClaimsSchema>;
const Path = z.string().max(256).regex(/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+){0,9}$/).refine(s => !s.split('.').some(p => ['__proto__','constructor','prototype'].includes(p)));
const RuleAction = z.enum(['flag','block']);
export const RuleSchema = z.discriminatedUnion('type', [
  z.object({ id: Id, type: z.literal('numeric_limit'), tool: Id, argumentPath: Path, operator: z.enum(['gt','gte','lt','lte']), value: z.number().finite(), action: RuleAction }).strict(),
  z.object({ id: Id, type: z.literal('regex'), targetPath: Path, pattern: z.string().min(1).max(256), action: RuleAction }).strict(),
]);
export type Rule = z.infer<typeof RuleSchema>;
export const ProbeSegment = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/);
export const ProbeKey = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}:[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/);
export const ProbeConfigurationSchema = z.object({ probeId: ProbeSegment, version: ProbeSegment, flagThreshold: z.number().min(0).max(1), blockThreshold: z.number().min(0).max(1) }).strict().refine(p => p.flagThreshold < p.blockThreshold);
export const AgentPolicySchema = z.object({
  schemaVersion: z.literal(1), policyId: Id, version: z.number().int().positive(), tenantId: Id, agentId: Id,
  defaultAction: z.enum(['allow','block']), tools: z.object({ allowlist: z.array(Id).max(100), denylist: z.array(Id).max(100) }).strict(),
  rules: z.array(RuleSchema).max(100), probes: z.object({ enabled: z.boolean(), configurations: z.array(ProbeConfigurationSchema).max(32) }).strict(),
  latencyBudgetMs: z.number().int().min(1).max(5000).default(50), failMode: FailMode,
}).strict().superRefine((p, ctx) => {
  if (new Set(p.rules.map(r => r.id)).size !== p.rules.length) ctx.addIssue({ code: 'custom', message: 'Duplicate rule id' });
  if (new Set(p.probes.configurations.map(c => c.probeId)).size !== p.probes.configurations.length) ctx.addIssue({code:'custom',message:'Duplicate probe id'});
  if (p.probes.enabled && !p.probes.configurations.length) ctx.addIssue({ code: 'custom', message: 'Enabled probes require configurations' });
});
export type AgentPolicy = z.infer<typeof AgentPolicySchema>;
export const ReasonSchema = z.object({ code: Id, source: z.enum(['policy','rule','probe','system']), ruleId: Id.optional(), probeId: Id.optional(), score: z.number().min(0).max(1).optional() }).strict();
export type Reason = z.infer<typeof ReasonSchema>;
export const DecisionSchema = z.object({ decisionId: z.string().uuid(), outcome: Outcome, policyId: Id, policyVersion: z.number().int().positive(), reasons: z.array(ReasonSchema), degraded: z.boolean(), latencyMs: z.number().nonnegative() }).strict();
export type Decision = z.infer<typeof DecisionSchema>;
export const InferenceRequestSchema = z.object({ text: z.string().min(1).max(8192), probeIds: z.array(ProbeKey).min(1).max(32).refine(ids => new Set(ids).size === ids.length) }).strict();
export type InferenceRequest = z.infer<typeof InferenceRequestSchema>;
export const InferenceResponseSchema = z.object({ scores: z.record(ProbeKey,z.number().finite().min(0).max(1)).refine(scores => Object.keys(scores).length >= 1 && Object.keys(scores).length <= 32), modelVersion: Id, latencyMs: z.number().finite().nonnegative() }).strict();
export type InferenceResponse = z.infer<typeof InferenceResponseSchema>;
export const PolicyBundleSchema = z.object({ schemaVersion: z.literal(1), bundleId: Id, version: z.number().int().positive(), tenantId: Id, issuedAt: z.string().datetime(), expiresAt: z.string().datetime(), policies: z.array(AgentPolicySchema).max(1000), revokedTokenIds: z.array(Id).max(10000), revokedAgentIds: z.array(Id).max(1000), probeVersions: z.record(Id,Id) }).strict().superRefine((b,ctx) => {
  if (b.policies.some(p => p.tenantId !== b.tenantId) || new Set(b.policies.map(p => p.agentId)).size !== b.policies.length || Date.parse(b.expiresAt) <= Date.parse(b.issuedAt)) ctx.addIssue({code:'custom',message:'Invalid bundle scope, lifetime or duplicate agent'});
});
export type PolicyBundle = z.infer<typeof PolicyBundleSchema>;
export const SignedPolicyBundleSchema = z.object({ payload: z.string().max(4000000), signature: z.string().regex(/^[A-Za-z0-9_-]+$/).max(128), keyId: Id, algorithm: z.literal('Ed25519') }).strict();
const Count = z.number().int().nonnegative();
export const Stage = z.enum(['auth','policy','rules','inference','decision']);
export type StageName = z.infer<typeof Stage>;
export const TelemetryWindowSchema = z.object({ schemaVersion: z.literal(1), tenantId: Id, deploymentId: Id, windowStart: z.string().datetime(), windowEnd: z.string().datetime(), decisions: z.array(z.object({policyId:Id, outcome:Outcome,count:Count}).strict()).max(3000), probeMetrics: z.array(z.object({probeId:Id,version:Id,decisions:z.array(z.object({outcome:Outcome,count:Count}).strict()).optional(),histogram:z.array(z.object({upperBound:z.number().min(0).max(1),count:Count}).strict())}).strict()).max(1000), stageLatencies: z.array(z.object({stage:Stage,p50:z.number().nonnegative(),p95:z.number().nonnegative(),p99:z.number().nonnegative()}).strict()).max(5), cacheAgeSeconds:z.number().nonnegative(),stalePolicyCount:Count,versions:z.object({guardrail:Id,model:Id.optional(),policyBundle:Count,probes:z.record(Id,Id)}).strict() }).strict();
export type TelemetryWindow = z.infer<typeof TelemetryWindowSchema>;
export const AuditTraceSchema = z.object({ tenantId:Id, agentId:Id, timestamp:z.string().datetime(), call:ToolCallSchema, decision:DecisionSchema }).strict();

export const AuditEventSchema=AuditTraceSchema.extend({stages:z.array(z.object({stage:Stage,ms:z.number().finite().nonnegative()}).strict()).max(5),bundleVersion:z.number().int().nonnegative(),cacheAgeSeconds:z.number().finite().nonnegative(),modelVersion:Id.optional()}).strict();
export type AuditEvent=z.infer<typeof AuditEventSchema>;

export const TelemetryObservationSchema=AuditEventSchema.pick({tenantId:true,decision:true,stages:true,bundleVersion:true,cacheAgeSeconds:true,modelVersion:true}).strict();
export type TelemetryObservation=z.infer<typeof TelemetryObservationSchema>;

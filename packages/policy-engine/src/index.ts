import { AgentPolicySchema, type AgentPolicy, type ToolCall, type Reason } from '@lab/contracts';
import { RE2JS } from 're2js';
export type Finding = { outcome: 'allow' | 'flag' | 'block'; reason: Reason };
export type CompiledPolicy = Readonly<{ policy: AgentPolicy; evaluate: (call: ToolCall, expired: () => boolean) => Finding[] }>;
const rank = { allow: 0, flag: 1, block: 2 } as const;
export function decide(findings: readonly Finding[]): Finding['outcome'] {
  return findings.reduce<Finding['outcome']>((a, f) => rank[f.outcome] > rank[a] ? f.outcome : a, 'allow');
}
function readPath(input: unknown, path: string): unknown {
  let current = input;
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current,part)) return undefined;
    current = (current as Record<string,unknown>)[part];
  }
  return current;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function compilePolicy(input: unknown): CompiledPolicy {
  const policy = freeze(AgentPolicySchema.parse(input));
  const allow = new Set(policy.tools.allowlist), deny = new Set(policy.tools.denylist);
  const rules = policy.rules.map(rule => ({rule, regex: rule.type === 'regex' ? RE2JS.compile(rule.pattern) : undefined}));
  return Object.freeze({ policy, evaluate(call: ToolCall, expired: () => boolean): Finding[] {
    const findings: Finding[] = [];
    const add = (outcome: Finding['outcome'], code: string, source: Reason['source'], ruleId?: string) => findings.push({outcome,reason:{code,source,...(ruleId ? {ruleId} : {})}});
    if (deny.has(call.tool)) { add('block','TOOL_DENIED','policy'); return findings; }
    if (!allow.has(call.tool) && policy.defaultAction === 'block') { add('block','TOOL_NOT_ALLOWED','policy'); return findings; }
    for (const {rule,regex} of rules) {
      if (expired()) { add('block','RULE_DEADLINE_EXCEEDED','system'); return findings; }
      if (rule.type === 'numeric_limit') {
        if (rule.tool !== call.tool) continue;
        const value = readPath(call.arguments, rule.argumentPath);
        if (typeof value !== 'number' || !Number.isFinite(value)) { add('block','INVALID_NUMERIC_ARGUMENT','rule',rule.id); continue; }
        const hit = {gt:value > rule.value,gte:value >= rule.value,lt:value < rule.value,lte:value <= rule.value}[rule.operator];
        if (hit) add(rule.action,'NUMERIC_LIMIT_EXCEEDED','rule',rule.id);
      } else {
        const value = readPath(call, rule.targetPath);
        // Missing or non-string targets cannot silently bypass a sensitive-data rule.
        if (typeof value !== 'string') { add('block','INVALID_REGEX_TARGET','rule',rule.id); continue; }
        if (regex!.matcher(value).find()) add(rule.action,'REGEX_MATCH','rule',rule.id);
      }
    }
    if (expired()) add('block','RULE_DEADLINE_EXCEEDED','system');
    if (!findings.length) add('allow','POLICY_ALLOWED','policy');
    return findings;
  }});
}

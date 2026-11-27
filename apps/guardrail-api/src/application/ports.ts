import type {
  AgentClaims,
  Decision,
  StageName,
  InferenceRequest,
  InferenceResponse,
  ToolCall,
} from '@lab/contracts';
import type { CompiledPolicy } from '@lab/policy-engine';
import type { ShadowComparison } from './evaluate-probes.js';
export interface TokenVerifier {
  verify(token: string): Promise<AgentClaims>;
}
export interface PolicyStore {
  lookup(
    tenantId: string,
    agentId: string,
    tokenId: string,
  ): {
    policy: CompiledPolicy | undefined;
    stale: boolean;
    revoked: boolean;
    bundleVersion?: number;
    cacheAgeSeconds?: number;
  };
  ready(): boolean;
  hasSnapshot?(): boolean;
  version?(tenantId: string): number;
  cacheAgeSeconds?(tenantId: string): number;
}
export interface Metrics {
  stage(stage: StageName, elapsedMs: number): void;
  decision(outcome: 'allow' | 'flag' | 'block', degraded: boolean): void;
  stale(): void;
  shadow?(comparisons: readonly ShadowComparison[]): void;
}

export interface InferenceClient {
  score(request: InferenceRequest, signal: AbortSignal): Promise<InferenceResponse>;
}

export interface UpstreamResponse {
  status: number;
  body: unknown;
}

export interface ToolUpstream {
  has(tool: string): boolean;
  forward(call: ToolCall, decision: Decision): Promise<UpstreamResponse>;
}

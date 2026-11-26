import { PolicyBundleSchema } from '@lab/contracts';
import { compilePolicy, type CompiledPolicy } from '@lab/policy-engine';
import type { PolicyStore } from '../application/ports.js';
type Snapshot = {
  version: number;
  expiresAt: number;
  loadedAt: number;
  policies: Map<string, CompiledPolicy>;
  tokens: Set<string>;
  agents: Set<string>;
};
export class MemoryPolicyStore implements PolicyStore {
  private readonly tenants = new Map<string, Snapshot>();
  constructor(
    private readonly maxAgeMs = 300_000,
    private readonly now = Date.now,
    private readonly siloTenant?: string,
  ) {
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new Error('Invalid cache age');
  }
  // Trusted input only. Milestone 3 adds signature verification before this boundary.
  replace(input: unknown): void {
    const b = PolicyBundleSchema.parse(input);
    if (this.siloTenant && b.tenantId !== this.siloTenant) throw new Error('Tenant outside silo');
    const previous = this.tenants.get(b.tenantId);
    if (previous && b.version <= previous.version) throw new Error('Non-increasing bundle version');
    if (Date.parse(b.issuedAt) > this.now()) throw new Error('Future bundle');
    const policies = new Map<string, CompiledPolicy>();
    for (const p of b.policies) {
      policies.set(p.agentId, compilePolicy(p));
    }
    this.tenants.set(b.tenantId, {
      version: b.version,
      expiresAt: Date.parse(b.expiresAt),
      loadedAt: Math.min(this.now(), Date.parse(b.issuedAt)),
      policies,
      tokens: new Set(b.revokedTokenIds),
      agents: new Set(b.revokedAgentIds),
    });
  }
  private isStale(s: Snapshot) {
    const now = this.now();
    return now >= s.expiresAt || now - s.loadedAt >= this.maxAgeMs;
  }
  lookup(tenantId: string, agentId: string, tokenId: string) {
    const s = this.tenants.get(tenantId);
    return {
      bundleVersion: s?.version ?? 0,
      cacheAgeSeconds: s ? Math.max(0, (this.now() - s.loadedAt) / 1000) : 0,
      policy: s?.policies.get(agentId),
      stale: !s || this.isStale(s),
      revoked: !!s && (s.tokens.has(tokenId) || s.agents.has(agentId)),
    };
  }
  version(tenantId: string) {
    return this.tenants.get(tenantId)?.version ?? 0;
  }
  cacheAgeSeconds(tenantId: string) {
    const s = this.tenants.get(tenantId);
    return s ? Math.max(0, (this.now() - s.loadedAt) / 1000) : 0;
  }
  hasSnapshot() {
    return this.tenants.size > 0;
  }
  ready() {
    return this.tenants.size > 0 && [...this.tenants.values()].every((s) => !this.isStale(s));
  }
}

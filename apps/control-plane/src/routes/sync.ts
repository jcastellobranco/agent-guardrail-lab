import type { FastifyInstance } from 'fastify';
import type { ControlDatabase } from '../config.js';
import { randomUUID } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import {
  Id,
  AgentPolicySchema,
  TelemetryWindowSchema,
  PolicyBundleSchema,
  probeKeys,
} from '@lab/contracts';
import { signBundle } from '@lab/bundles';
import { tenants, agents, policies, revocations, telemetry } from '@lab/database';
import type { Config } from '../config.js';

export function registerSyncRoutes(sync: FastifyInstance, db: ControlDatabase, c: Config) {
  sync.get('/:tenantId/bundle', async (req, reply) => {
    const tenantId = Id.parse((req.params as { tenantId: string }).tenantId);
    const bundle = await db.transaction(
      async (tx) => {
        // Repeatable read plus retry by next poll on concurrent writer conflict; monotonic version persisted in Postgres.
        const [tenant] = await tx
          .update(tenants)
          .set({ bundleVersion: sql`${tenants.bundleVersion}+1` })
          .where(eq(tenants.id, tenantId))
          .returning();
        if (!tenant) return null;
        const as = await tx.select().from(agents).where(eq(agents.tenantId, tenantId)),
          ps = await tx.select().from(policies).where(eq(policies.tenantId, tenantId)),
          rs = await tx
            .select()
            .from(revocations)
            .where(and(eq(revocations.tenantId, tenantId), gt(revocations.expiresAt, new Date())));
        const active = new Set(as.filter((a) => a.active && tenant.active).map((a) => a.id));
        const parsed = ps
          .filter((p) => p.active && active.has(p.agentId))
          .map((p) => AgentPolicySchema.parse(p.body));
        const now = Date.now();
        // Includes shadow versions, so data planes provision every artifact they will score.
        const probeVersions: Record<string, string> = {};
        for (const key of parsed.flatMap(probeKeys)) probeVersions[key] = key.split(':')[1]!;
        return PolicyBundleSchema.parse({
          schemaVersion: 1,
          bundleId: randomUUID(),
          version: tenant.bundleVersion,
          tenantId,
          issuedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + c.bundleTtlMs).toISOString(),
          policies: parsed,
          revokedTokenIds: rs.map((r) => r.jti),
          revokedAgentIds: as.filter((a) => !a.active || !tenant.active).map((a) => a.id),
          probeVersions,
        });
      },
      { isolationLevel: 'repeatable read' },
    );
    return bundle
      ? signBundle(bundle, c.bundlePem, c.bundleKid)
      : reply.code(404).send({ error: 'NOT_FOUND' });
  });
  sync.get('/:tenantId/probe-versions', async (req) => {
    const tenantId = Id.parse((req.params as { tenantId: string }).tenantId);
    const rows = await db
      .select({ body: policies.body })
      .from(policies)
      .innerJoin(
        agents,
        and(eq(agents.tenantId, policies.tenantId), eq(agents.id, policies.agentId)),
      )
      .innerJoin(tenants, eq(tenants.id, policies.tenantId))
      .where(
        and(
          eq(policies.tenantId, tenantId),
          eq(policies.active, true),
          eq(agents.active, true),
          eq(tenants.active, true),
        ),
      );
    return {
      probeVersions: [...new Set(rows.flatMap((r) => probeKeys(AgentPolicySchema.parse(r.body))))],
    };
  });
  sync.post('/:tenantId/telemetry', async (req, reply) => {
    const tenantId = Id.parse((req.params as { tenantId: string }).tenantId),
      b = TelemetryWindowSchema.parse(req.body);
    if (b.tenantId !== tenantId || Date.parse(b.windowEnd) - Date.parse(b.windowStart) !== 60000)
      return reply.code(400).send({ error: 'SCOPE_OR_WINDOW' });
    await db
      .insert(telemetry)
      .values({
        tenantId,
        deploymentId: b.deploymentId,
        windowStart: new Date(b.windowStart),
        body: b,
      })
      .onConflictDoNothing();
    return reply.code(204).send();
  });
}

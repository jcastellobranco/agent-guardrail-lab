import type { FastifyInstance } from 'fastify';
import type { ControlDatabase } from '../config.js';
import { and, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Id, AgentPolicySchema } from '@lab/contracts';
import { compilePolicy } from '@lab/policy-engine';
import { policies } from '@lab/database';

const params = z.object({ tenantId: Id, agentId: Id });

export function registerPoliciesRoutes(admin: FastifyInstance, db: ControlDatabase) {
  admin.get('/tenants/:tenantId/policies', async (req) =>
    db
      .select()
      .from(policies)
      .where(eq(policies.tenantId, Id.parse((req.params as { tenantId: string }).tenantId))),
  );
  admin.put('/tenants/:tenantId/agents/:agentId/policy', async (req, reply) => {
    const p = params.parse(req.params),
      b = AgentPolicySchema.parse(req.body);
    if (b.tenantId !== p.tenantId || b.agentId !== p.agentId)
      return reply.code(400).send({ error: 'SCOPE' });
    try {
      compilePolicy(b);
    } catch {
      return reply.code(400).send({ error: 'INVALID_RULE' });
    }
    const [row] = await db
      .insert(policies)
      .values({ tenantId: p.tenantId, agentId: p.agentId, version: b.version, body: b })
      .onConflictDoUpdate({
        target: [policies.tenantId, policies.agentId],
        set: { version: b.version, body: b, active: true },
        setWhere: gt(sql`${b.version}`, policies.version),
      })
      .returning();
    return row ?? reply.code(409).send({ error: 'VERSION_CONFLICT' });
  });
  // Disabling preserves version history: a deleted policy cannot be recreated at an older version.
  admin.delete('/tenants/:tenantId/agents/:agentId/policy', async (req, reply) => {
    const p = params.parse(req.params);
    await db
      .update(policies)
      .set({ active: false })
      .where(and(eq(policies.tenantId, p.tenantId), eq(policies.agentId, p.agentId)));
    return reply.code(204).send();
  });
}

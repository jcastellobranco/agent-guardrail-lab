import type { FastifyInstance } from 'fastify';
import type { ControlDatabase } from '../config.js';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { Id } from '@lab/contracts';
import { agents } from '@lab/database';

const agentBody = z.object({ id: Id, active: z.boolean().default(true) }).strict();
const params = z.object({ tenantId: Id, agentId: Id });

export function registerAgentsRoutes(admin: FastifyInstance, db: ControlDatabase) {
  admin.get('/tenants/:tenantId/agents', async (req) =>
    db
      .select()
      .from(agents)
      .where(eq(agents.tenantId, Id.parse((req.params as { tenantId: string }).tenantId))),
  );
  admin.post('/tenants/:tenantId/agents', async (req, reply) => {
    const tenantId = Id.parse((req.params as { tenantId: string }).tenantId),
      b = agentBody.parse(req.body);
    const [row] = await db
      .insert(agents)
      .values({ tenantId, ...b })
      .onConflictDoNothing()
      .returning();
    return row ? reply.code(201).send(row) : reply.code(409).send({ error: 'EXISTS' });
  });
  admin.put('/tenants/:tenantId/agents/:agentId', async (req, reply) => {
    const p = params.parse(req.params),
      b = agentBody.parse(req.body);
    if (b.id !== p.agentId) return reply.code(400).send({ error: 'SCOPE' });
    const [row] = await db
      .update(agents)
      .set({ active: b.active })
      .where(and(eq(agents.tenantId, p.tenantId), eq(agents.id, p.agentId)))
      .returning();
    return row ?? reply.code(404).send({ error: 'NOT_FOUND' });
  });
  admin.delete('/tenants/:tenantId/agents/:agentId', async (req, reply) => {
    const p = params.parse(req.params);
    await db
      .update(agents)
      .set({ active: false })
      .where(and(eq(agents.tenantId, p.tenantId), eq(agents.id, p.agentId)));
    return reply.code(204).send();
  });
}

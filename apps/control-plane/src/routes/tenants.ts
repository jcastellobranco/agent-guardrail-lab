import type { FastifyInstance } from 'fastify';
import type { ControlDatabase } from '../config.js';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { Id } from '@lab/contracts';
import { tenants } from '@lab/database';

const tenantBody = z.object({ id: Id, name: z.string().min(1).max(200) }).strict();

export function registerTenantsRoutes(admin: FastifyInstance, db: ControlDatabase) {
  admin.get('/tenants', async () => db.select().from(tenants));
  admin.post('/tenants', async (req, reply) => {
    const b = tenantBody.parse(req.body);
    const [row] = await db
      .insert(tenants)
      .values({ ...b, displayName: b.name })
      .onConflictDoNothing()
      .returning();
    return row ? reply.code(201).send(row) : reply.code(409).send({ error: 'EXISTS' });
  });
  admin.put('/tenants/:tenantId', async (req, reply) => {
    const id = Id.parse((req.params as { tenantId: string }).tenantId),
      b = tenantBody.parse(req.body);
    if (id !== b.id) return reply.code(400).send({ error: 'SCOPE' });
    const [row] = await db
      .update(tenants)
      .set({ name: b.name, displayName: b.name, active: true })
      .where(eq(tenants.id, id))
      .returning();
    return row ?? reply.code(404).send({ error: 'NOT_FOUND' });
  });
  admin.delete('/tenants/:tenantId', async (req, reply) => {
    const id = Id.parse((req.params as { tenantId: string }).tenantId); // Soft removal: disable all agents; retain audit and revocation scope.
    await db.update(tenants).set({ active: false }).where(eq(tenants.id, id));
    return reply.code(204).send();
  });
}

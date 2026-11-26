import type { FastifyInstance } from 'fastify';
import type { ControlDatabase } from '../config.js';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';
import { Id } from '@lab/contracts';
import { agents, tenants, policies, revocations } from '@lab/database';
import type { Config } from '../config.js';

const params = z.object({ tenantId: Id, agentId: Id });

export function registerTokensRoutes(
  admin: FastifyInstance,
  db: ControlDatabase,
  c: Config,
  jwtKey: Awaited<ReturnType<typeof importPKCS8>>,
) {
  admin.post('/tenants/:tenantId/agents/:agentId/token', async (req, reply) => {
    const p = params.parse(req.params);
    const [a] = await db
      .select({ id: agents.id })
      .from(agents)
      .innerJoin(tenants, eq(tenants.id, agents.tenantId))
      .innerJoin(
        policies,
        and(eq(policies.tenantId, agents.tenantId), eq(policies.agentId, agents.id)),
      )
      .where(
        and(
          eq(agents.tenantId, p.tenantId),
          eq(agents.id, p.agentId),
          eq(agents.active, true),
          eq(tenants.active, true),
          eq(policies.active, true),
        ),
      );
    if (!a) return reply.code(404).send({ error: 'NOT_FOUND' });
    const jti = randomUUID();
    const token = await new SignJWT({ tenantId: p.tenantId, agentId: p.agentId })
      .setProtectedHeader({ alg: 'EdDSA', kid: c.jwtKid })
      .setIssuer(c.issuer)
      .setAudience(c.audience)
      .setSubject(p.agentId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .setJti(jti)
      .sign(jwtKey);
    return { token, jti, expiresIn: 300 };
  });
  admin.post('/tenants/:tenantId/revoke', async (req, reply) => {
    const tenantId = Id.parse((req.params as { tenantId: string }).tenantId),
      jti = z.object({ jti: Id }).strict().parse(req.body).jti;
    await db
      .insert(revocations)
      .values({ tenantId, jti, expiresAt: new Date(Date.now() + 300000) })
      .onConflictDoNothing();
    return reply.code(204).send();
  });
}

import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';

function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function requireAdmin(app: FastifyInstance, config: Config) {
  app.addHook('onRequest', async (req, reply) => {
    if (!equal(req.headers.authorization ?? '', `Bearer ${config.adminToken}`))
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
  });
}

export function requireSync(app: FastifyInstance, config: Config) {
  app.addHook('onRequest', async (req, reply) => {
    const tenantId = (req.params as { tenantId?: string }).tenantId;
    const secret = tenantId ? config.syncTokens.get(tenantId) : undefined;
    if (!secret || !equal(req.headers.authorization ?? '', `Bearer ${secret}`))
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
  });
}

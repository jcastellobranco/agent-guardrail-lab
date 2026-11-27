import Fastify from 'fastify';
import { importPKCS8 } from 'jose';
import { z } from 'zod';
import type { Config, ControlDatabase } from './config.js';
import { requireAdmin, requireSync } from './security/authentication.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerTenantsRoutes } from './routes/tenants.js';
import { registerAgentsRoutes } from './routes/agents.js';
import { registerPoliciesRoutes } from './routes/policies.js';
import { registerTokensRoutes } from './routes/tokens.js';
import { registerSyncRoutes } from './routes/sync.js';
import { registerRolloutRoutes } from './routes/rollouts.js';

export async function buildControl(db: ControlDatabase, c: Config) {
  const app = Fastify({ bodyLimit: 4_000_000, logger: false });
  const jwtKey = await importPKCS8(c.jwtPem, 'EdDSA');
  app.setErrorHandler((err, _req, reply) => {
    const status =
      err instanceof z.ZodError ? 400 : ((err as { statusCode?: number }).statusCode ?? 500);
    return reply
      .code(status)
      .send({ error: status < 500 ? 'INVALID_REQUEST' : 'CONTROL_PLANE_ERROR' });
  });
  registerHealthRoutes(app, db);
  app.register(
    async (admin) => {
      requireAdmin(admin, c);
      registerTenantsRoutes(admin, db);
      registerAgentsRoutes(admin, db);
      registerPoliciesRoutes(admin, db);
      registerTokensRoutes(admin, db, c, jwtKey);
      registerRolloutRoutes(admin, db);
    },
    { prefix: '/v1/admin' },
  );
  app.register(
    async (sync) => {
      requireSync(sync, c);
      registerSyncRoutes(sync, db, c);
    },
    { prefix: '/v1/sync' },
  );
  return app;
}

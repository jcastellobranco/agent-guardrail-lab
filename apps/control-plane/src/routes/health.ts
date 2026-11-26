import type { FastifyInstance } from 'fastify';
import type { ControlDatabase } from '../config.js';
import { sql } from 'drizzle-orm';

export function registerHealthRoutes(app: FastifyInstance, db: ControlDatabase) {
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async () => {
    await db.execute(sql`select 1`);
    return { status: 'ready' };
  });
}

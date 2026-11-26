import Fastify from 'fastify';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';
import { Id, AgentPolicySchema, TelemetryWindowSchema, PolicyBundleSchema } from '@lab/contracts';
import { compilePolicy } from '@lab/policy-engine';
import { signBundle } from '@lab/bundles';
import { database, tenants, agents, policies, revocations, telemetry } from '@lab/database';
type Config = {
  adminToken: string;
  syncTokens: ReadonlyMap<string, string>;
  jwtPem: string;
  bundlePem: string;
  jwtKid: string;
  bundleKid: string;
  issuer: string;
  audience: string;
  bundleTtlMs: number;
};
function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
const tenantBody = z.object({ id: Id, name: z.string().min(1).max(200) }).strict();
const agentBody = z.object({ id: Id, active: z.boolean().default(true) }).strict();
const params = z.object({ tenantId: Id, agentId: Id });
export async function buildControl(db: ReturnType<typeof database>['db'], c: Config) {
  const app = Fastify({ bodyLimit: 4_000_000, logger: false });
  const jwtKey = await importPKCS8(c.jwtPem, 'EdDSA');
  app.setErrorHandler((err, _req, reply) => {
    const status =
      err instanceof z.ZodError ? 400 : ((err as { statusCode?: number }).statusCode ?? 500);
    return reply
      .code(status)
      .send({ error: status < 500 ? 'INVALID_REQUEST' : 'CONTROL_PLANE_ERROR' });
  });
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async () => {
    await db.execute(sql`select 1`);
    return { status: 'ready' };
  });
  app.register(
    async (admin) => {
      admin.addHook('onRequest', async (req, reply) => {
        if (!equal(req.headers.authorization ?? '', `Bearer ${c.adminToken}`))
          return reply.code(401).send({ error: 'UNAUTHORIZED' });
      });
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
    },
    { prefix: '/v1/admin' },
  );
  app.register(
    async (sync) => {
      sync.addHook('onRequest', async (req, reply) => {
        const tenantId = (req.params as { tenantId?: string }).tenantId,
          secret = tenantId ? c.syncTokens.get(tenantId) : undefined;
        if (!secret || !equal(req.headers.authorization ?? '', `Bearer ${secret}`))
          return reply.code(401).send({ error: 'UNAUTHORIZED' });
      });
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
                .where(
                  and(eq(revocations.tenantId, tenantId), gt(revocations.expiresAt, new Date())),
                );
            const active = new Set(as.filter((a) => a.active && tenant.active).map((a) => a.id));
            const parsed = ps
              .filter((p) => p.active && active.has(p.agentId))
              .map((p) => AgentPolicySchema.parse(p.body));
            const now = Date.now();
            const probeVersions: Record<string, string> = {};
            for (const p of parsed)
              for (const v of p.probes.configurations)
                probeVersions[`${v.probeId}:${v.version}`] = v.version;
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
          probeVersions: [
            ...new Set(
              rows.flatMap((r) =>
                AgentPolicySchema.parse(r.body).probes.configurations.map(
                  (p) => `${p.probeId}:${p.version}`,
                ),
              ),
            ),
          ],
        };
      });
      sync.post('/:tenantId/telemetry', async (req, reply) => {
        const tenantId = Id.parse((req.params as { tenantId: string }).tenantId),
          b = TelemetryWindowSchema.parse(req.body);
        if (
          b.tenantId !== tenantId ||
          Date.parse(b.windowEnd) - Date.parse(b.windowStart) !== 60000
        )
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
    },
    { prefix: '/v1/sync' },
  );
  return app;
}

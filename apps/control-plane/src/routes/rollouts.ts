import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AgentPolicySchema, Id, ProbeSegment } from '@lab/contracts';
import { policies, probeRollouts } from '@lab/database';
import { promote } from '../rollouts/canary.js';
import type { ControlDatabase } from '../config.js';

const params = z.object({ tenantId: Id, probeId: ProbeSegment });
const Threshold = z.number().min(0).max(1);
const RolloutRequest = z
  .object({
    stableVersion: ProbeSegment,
    canaryVersion: ProbeSegment,
    flagThreshold: Threshold,
    blockThreshold: Threshold,
    percent: z.number().int().min(0).max(100),
    maxBlockRateIncrease: Threshold,
    minSamples: z.number().int().min(1).max(1_000_000),
  })
  .strict()
  .refine((r) => r.stableVersion !== r.canaryVersion, 'Canary must differ from stable')
  .refine((r) => r.flagThreshold < r.blockThreshold, 'Flag threshold must be below block');

export function registerRolloutRoutes(admin: FastifyInstance, db: ControlDatabase) {
  const base = '/tenants/:tenantId/probe-rollouts';

  admin.get(base, async (req) => {
    const tenantId = Id.parse((req.params as { tenantId: string }).tenantId);
    return db.select().from(probeRollouts).where(eq(probeRollouts.tenantId, tenantId));
  });

  /**
   * Starts a rollout, or changes the percentage or thresholds of the active one (ramping up).
   * Changing versions while a rollout is active is rejected: finish it first.
   */
  admin.put(`${base}/:probeId`, async (req, reply) => {
    const { tenantId, probeId } = params.parse(req.params);
    const body = RolloutRequest.parse(req.body);
    const [existing] = await db
      .select()
      .from(probeRollouts)
      .where(and(eq(probeRollouts.tenantId, tenantId), eq(probeRollouts.probeId, probeId)));

    const sameVersions =
      existing?.stableVersion === body.stableVersion &&
      existing?.canaryVersion === body.canaryVersion;
    if (existing?.status === 'active' && !sameVersions) {
      return reply.code(409).send({ error: 'ROLLOUT_ACTIVE' });
    }
    // Ramping an active rollout keeps its start time, so earlier telemetry still counts.
    const restart = existing?.status !== 'active';
    const values = {
      ...body,
      status: 'active' as const,
      reason: null,
      decidedAt: null,
      ...(restart ? { startedAt: new Date() } : {}),
    };
    const [row] = await db
      .insert(probeRollouts)
      .values({ tenantId, probeId, ...values })
      .onConflictDoUpdate({ target: [probeRollouts.tenantId, probeRollouts.probeId], set: values })
      .returning();
    return row;
  });

  admin.post(`${base}/:probeId/abort`, async (req, reply) => {
    const { tenantId, probeId } = params.parse(req.params);
    const [row] = await db
      .update(probeRollouts)
      .set({ status: 'aborted', reason: 'manual abort', decidedAt: new Date() })
      .where(activeRollout(tenantId, probeId))
      .returning();
    return row ?? reply.code(409).send({ error: 'NO_ACTIVE_ROLLOUT' });
  });

  /**
   * Promotion rewrites every policy that uses the stable version, bumping its version.
   * The rollout row alone is not the source of truth: the next rollout replaces it.
   */
  admin.post(`${base}/:probeId/promote`, async (req, reply) => {
    const { tenantId, probeId } = params.parse(req.params);
    const promoted = await db.transaction(async (tx) => {
      const [rollout] = await tx
        .update(probeRollouts)
        .set({ status: 'promoted', reason: 'manual promote', decidedAt: new Date() })
        .where(activeRollout(tenantId, probeId))
        .returning();
      if (!rollout) return undefined;

      const rows = await tx.select().from(policies).where(eq(policies.tenantId, tenantId));
      for (const row of rows) {
        const current = AgentPolicySchema.parse(row.body);
        const next = promote(current, rollout);
        if (JSON.stringify(next) === JSON.stringify(current)) continue;
        const body = AgentPolicySchema.parse({ ...next, version: current.version + 1 });
        await tx
          .update(policies)
          .set({ version: body.version, body })
          .where(and(eq(policies.tenantId, tenantId), eq(policies.agentId, row.agentId)));
      }
      return rollout;
    });
    return promoted ?? reply.code(409).send({ error: 'NO_ACTIVE_ROLLOUT' });
  });
}

function activeRollout(tenantId: string, probeId: string) {
  return and(
    eq(probeRollouts.tenantId, tenantId),
    eq(probeRollouts.probeId, probeId),
    eq(probeRollouts.status, 'active'),
  );
}

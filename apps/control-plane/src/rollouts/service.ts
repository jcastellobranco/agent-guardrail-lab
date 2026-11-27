import { and, eq, gte } from 'drizzle-orm';
import type { TelemetryWindow } from '@lab/contracts';
import { probeRollouts, telemetry } from '@lab/database';
import type { ControlDatabase } from '../config.js';
import { evaluateRollout } from './canary.js';

/**
 * Checks every active rollout for the tenant against telemetry received since it started,
 * and rolls back the ones whose canary blocks too much. Called after each telemetry ingest,
 * so a rollback reaches data planes on their next bundle pull.
 */
export async function evaluateActiveRollouts(db: ControlDatabase, tenantId: string) {
  const active = await db
    .select()
    .from(probeRollouts)
    .where(and(eq(probeRollouts.tenantId, tenantId), eq(probeRollouts.status, 'active')));

  for (const rollout of active) {
    const rows = await db
      .select({ body: telemetry.body })
      .from(telemetry)
      .where(and(eq(telemetry.tenantId, tenantId), gte(telemetry.windowStart, rollout.startedAt)));
    // Bodies were validated against TelemetryWindowSchema at ingest.
    const verdict = evaluateRollout(
      rollout,
      rows.map((row) => row.body as TelemetryWindow),
    );
    if (verdict.action !== 'rollback') continue;

    // Guarded by status: a concurrent promote or abort wins, and the update becomes a no-op.
    await db
      .update(probeRollouts)
      .set({ status: 'rolled_back', reason: verdict.reason, decidedAt: new Date() })
      .where(
        and(
          eq(probeRollouts.tenantId, tenantId),
          eq(probeRollouts.probeId, rollout.probeId),
          eq(probeRollouts.status, 'active'),
        ),
      );
  }
}

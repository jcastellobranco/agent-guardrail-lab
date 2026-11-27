import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { verifyBundle } from '@lab/bundles';
import { database, agents, policies, probeRollouts, telemetry, tenants } from '@lab/database';
import { buildControl } from '../src/app.js';

const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_DATABASE_TESTS === '1' && !url) {
  throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests');
}
const suite = url ? describe : describe.skip;

suite('probe canary rollout on postgres', () => {
  const tenantId = `rollout-${randomUUID()}`;
  const agentIds = Array.from({ length: 40 }, (_, i) => `agent-${i}`);
  const admin = { authorization: 'Bearer admin' };
  const sync = { authorization: 'Bearer sync' };
  const key = generateKeyPairSync('ed25519');
  const publicKeys = new Map([
    ['b', key.publicKey.export({ type: 'spki', format: 'pem' }).toString()],
  ]);
  let handle: ReturnType<typeof database>;
  let app: Awaited<ReturnType<typeof buildControl>>;

  const policy = (agentId: string) => ({
    schemaVersion: 1,
    tenantId,
    agentId,
    policyId: 'p',
    version: 1,
    defaultAction: 'block',
    tools: { allowlist: ['transfer'], denylist: [] },
    rules: [],
    probes: {
      enabled: true,
      configurations: [
        { probeId: 'jailbreak', version: '1.0.0', flagThreshold: 0.5, blockThreshold: 0.8 },
      ],
    },
    failMode: 'closed',
    latencyBudgetMs: 50,
  });

  const versionsByAgent = async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/sync/${tenantId}/bundle`,
      headers: sync,
    });
    const bundle = verifyBundle(res.json(), publicKeys, tenantId);
    return new Map(bundle.policies.map((p) => [p.agentId, p.probes.configurations[0]!.version]));
  };

  let minute = 0;
  const sendTelemetry = async (counts: Record<string, { block: number; allow: number }>) => {
    const start = new Date(Date.now() + minute++ * 60000);
    start.setUTCSeconds(0, 0);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/sync/${tenantId}/telemetry`,
      headers: sync,
      payload: {
        schemaVersion: 1,
        tenantId,
        deploymentId: 'd1',
        windowStart: start.toISOString(),
        windowEnd: new Date(start.getTime() + 60000).toISOString(),
        decisions: [],
        probeMetrics: Object.entries(counts).map(([version, { block, allow }]) => ({
          probeId: 'jailbreak',
          version,
          histogram: [],
          decisions: [
            { outcome: 'allow', count: allow },
            { outcome: 'block', count: block },
          ],
        })),
        stageLatencies: [],
        cacheAgeSeconds: 0,
        stalePolicyCount: 0,
        versions: { guardrail: 'v', policyBundle: 1, probes: {} },
      },
    });
    expect(res.statusCode).toBe(204);
  };

  const rollout = async () =>
    (
      await app.inject({
        method: 'GET',
        url: `/v1/admin/tenants/${tenantId}/probe-rollouts`,
        headers: admin,
      })
    ).json()[0];

  beforeAll(async () => {
    handle = database(url!);
    const privatePem = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    app = await buildControl(handle.db, {
      adminToken: 'admin',
      syncTokens: new Map([[tenantId, 'sync']]),
      jwtPem: privatePem,
      bundlePem: privatePem,
      jwtKid: 'jwt',
      bundleKid: 'b',
      issuer: 'issuer',
      audience: 'audience',
      bundleTtlMs: 300000,
    });
    await app.inject({
      method: 'POST',
      url: '/v1/admin/tenants',
      headers: admin,
      payload: { id: tenantId, name: 'Rollout' },
    });
    for (const agentId of agentIds) {
      await app.inject({
        method: 'POST',
        url: `/v1/admin/tenants/${tenantId}/agents`,
        headers: admin,
        payload: { id: agentId },
      });
      const res = await app.inject({
        method: 'PUT',
        url: `/v1/admin/tenants/${tenantId}/agents/${agentId}/policy`,
        headers: admin,
        payload: policy(agentId),
      });
      expect(res.statusCode).toBe(200);
    }
  });

  afterAll(async () => {
    await app.close();
    const { db } = handle;
    await db.delete(telemetry).where(eq(telemetry.tenantId, tenantId));
    await db.delete(probeRollouts).where(eq(probeRollouts.tenantId, tenantId));
    await db.delete(policies).where(eq(policies.tenantId, tenantId));
    await db.delete(agents).where(eq(agents.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
    await handle.pool.end();
  });

  it('sends the canary to a share of agents and rolls back automatically', async () => {
    const start = await app.inject({
      method: 'PUT',
      url: `/v1/admin/tenants/${tenantId}/probe-rollouts/jailbreak`,
      headers: admin,
      payload: {
        stableVersion: '1.0.0',
        canaryVersion: '2.0.0',
        flagThreshold: 0.5,
        blockThreshold: 0.8,
        percent: 50,
        maxBlockRateIncrease: 0.05,
        minSamples: 100,
      },
    });
    expect(start.statusCode).toBe(200);

    const during = await versionsByAgent();
    const canaryAgents = [...during.values()].filter((v) => v === '2.0.0').length;
    expect(canaryAgents).toBeGreaterThan(5);
    expect(canaryAgents).toBeLessThan(35);

    // Healthy traffic does not trigger a rollback.
    await sendTelemetry({ '1.0.0': { block: 5, allow: 95 }, '2.0.0': { block: 6, allow: 94 } });
    expect((await rollout()).status).toBe('active');

    // The canary starts blocking far more than stable.
    await sendTelemetry({ '1.0.0': { block: 5, allow: 95 }, '2.0.0': { block: 60, allow: 40 } });
    const rolledBack = await rollout();
    expect(rolledBack.status).toBe('rolled_back');
    expect(rolledBack.reason).toContain('canary block rate');

    const after = await versionsByAgent();
    expect([...after.values()].every((v) => v === '1.0.0')).toBe(true);
  });

  it('rejects version changes during a rollout, and promotion rewrites policies', async () => {
    const body = {
      stableVersion: '1.0.0',
      canaryVersion: '3.0.0',
      flagThreshold: 0.6,
      blockThreshold: 0.9,
      percent: 10,
      maxBlockRateIncrease: 0.05,
      minSamples: 100,
    };
    const path = `/v1/admin/tenants/${tenantId}/probe-rollouts/jailbreak`;
    expect(
      (await app.inject({ method: 'PUT', url: path, headers: admin, payload: body })).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: path,
          headers: admin,
          payload: { ...body, canaryVersion: '4.0.0' },
        })
      ).statusCode,
    ).toBe(409);

    expect(
      (await app.inject({ method: 'POST', url: `${path}/promote`, headers: admin })).statusCode,
    ).toBe(200);

    const stored = await handle.db.select().from(policies).where(eq(policies.tenantId, tenantId));
    expect(stored.every((row) => row.version === 2)).toBe(true);
    const after = await versionsByAgent();
    expect([...after.values()].every((v) => v === '3.0.0')).toBe(true);
    expect(
      (await app.inject({ method: 'POST', url: `${path}/promote`, headers: admin })).statusCode,
    ).toBe(409);
  });
});

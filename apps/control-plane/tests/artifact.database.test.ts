import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { verifyProbeArtifact } from '@lab/bundles';
import { database, agents, policies, probeArtifacts, tenants } from '@lab/database';
import { buildControl } from '../src/app.js';

const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_DATABASE_TESTS === '1' && !url) {
  throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests');
}
const suite = url ? describe : describe.skip;

suite('signed probe artifacts on postgres', () => {
  const tenantId = `artifacts-${randomUUID()}`;
  const probeId = `probe-${randomUUID().slice(0, 8)}`;
  const admin = { authorization: 'Bearer admin' };
  const sync = { authorization: 'Bearer sync' };
  const key = generateKeyPairSync('ed25519');
  const publicKeys = new Map([
    ['b', key.publicKey.export({ type: 'spki', format: 'pem' }).toString()],
  ]);
  let handle: ReturnType<typeof database>;
  let app: Awaited<ReturnType<typeof buildControl>>;

  const artifact = (version: string, weights = [0.5, -0.25]) => ({
    schemaVersion: 1,
    probeId,
    version,
    modelVersion: 'distilgpt2:abc',
    inputFormat: 'tool-json-v1',
    weights,
    bias: 0.1,
    metrics: {
      precision: 0.9,
      recall: 0.8,
      false_positive_rate: 0.1,
      threshold: 0.5,
      train_size: 32,
      test_size: 8,
      true_negatives: 3,
      false_positives: 1,
      false_negatives: 1,
      true_positives: 3,
    },
    datasetSha256: 'a'.repeat(64),
    seed: 42,
  });
  const upload = (version: string, body: unknown) =>
    app.inject({
      method: 'PUT',
      url: `/v1/admin/probes/${probeId}/versions/${version}`,
      headers: admin,
      payload: body as object,
    });
  const download = (version: string, headers = sync) =>
    app.inject({
      method: 'GET',
      url: `/v1/sync/${tenantId}/probes/${probeId}/${version}`,
      headers,
    });

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
      payload: { id: tenantId, name: 'Artifacts' },
    });
    await app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${tenantId}/agents`,
      headers: admin,
      payload: { id: 'a' },
    });
    // The policy uses 1.0.0 and shadows 2.0.0; 3.0.0 is published but unused by this tenant.
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/admin/tenants/${tenantId}/agents/a/policy`,
      headers: admin,
      payload: {
        schemaVersion: 1,
        tenantId,
        agentId: 'a',
        policyId: 'p',
        version: 1,
        defaultAction: 'block',
        tools: { allowlist: ['transfer'], denylist: [] },
        rules: [],
        probes: {
          enabled: true,
          configurations: [
            {
              probeId,
              version: '1.0.0',
              flagThreshold: 0.5,
              blockThreshold: 0.8,
              shadow: { version: '2.0.0', flagThreshold: 0.5, blockThreshold: 0.8 },
            },
          ],
        },
        failMode: 'closed',
        latencyBudgetMs: 50,
      },
    });
    expect(res.statusCode).toBe(200);
  });

  afterAll(async () => {
    await app.close();
    const { db } = handle;
    await db.delete(probeArtifacts).where(eq(probeArtifacts.probeId, probeId));
    await db.delete(policies).where(eq(policies.tenantId, tenantId));
    await db.delete(agents).where(eq(agents.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
    await handle.pool.end();
  });

  it('publishes immutable versions', async () => {
    expect((await upload('2.0.0', artifact('2.0.0'))).statusCode).toBe(200);
    expect((await upload('2.0.0', artifact('2.0.0'))).statusCode).toBe(200);
    const changed = await upload('2.0.0', artifact('2.0.0', [9, 9]));
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toEqual({ error: 'ARTIFACT_IMMUTABLE' });
    expect((await upload('9.9.9', artifact('2.0.0'))).statusCode).toBe(400);
    expect((await upload('3.0.0', { ...artifact('3.0.0'), weights: [] })).statusCode).toBe(400);
  });

  it('serves a signed artifact the tenant uses, and nothing else', async () => {
    expect((await upload('3.0.0', artifact('3.0.0'))).statusCode).toBe(200);

    const res = await download('2.0.0');
    expect(res.statusCode).toBe(200);
    const { artifact: verified } = verifyProbeArtifact(res.json(), publicKeys, `${probeId}:2.0.0`);
    expect(verified.weights).toEqual([0.5, -0.25]);

    expect((await download('3.0.0')).statusCode).toBe(404); // published, not used by tenant
    expect((await download('1.0.0')).statusCode).toBe(404); // used, never published
    expect((await download('2.0.0', { authorization: 'Bearer wrong' })).statusCode).toBe(401);
  });
});

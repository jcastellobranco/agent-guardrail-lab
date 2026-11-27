import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signBundle, signProbeArtifact } from '@lab/bundles';
import { pull } from '../src/sync.js';

const key = generateKeyPairSync('ed25519');
const privatePem = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const keys = new Map([['k', key.publicKey.export({ type: 'spki', format: 'pem' }).toString()]]);

const artifactPayload = (version: string) =>
  JSON.stringify({
    schemaVersion: 1,
    probeId: 'jailbreak',
    version,
    modelVersion: 'distilgpt2:abc',
    inputFormat: 'tool-json-v1',
    weights: [0.5, -0.25],
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

const signedBundle = (version: number, probeVersions: Record<string, string>) => {
  const now = Date.now();
  return signBundle(
    {
      schemaVersion: 1,
      bundleId: 'b',
      tenantId: 't',
      version,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60000).toISOString(),
      policies: [],
      revokedAgentIds: [],
      revokedTokenIds: [],
      probeVersions,
    },
    privatePem,
    'k',
  );
};

/** A fake control plane: one bundle plus whatever artifact responses the test provides. */
function controlPlane(bundle: unknown, artifacts: Record<string, () => Response>) {
  const requested: string[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const path = new URL(input as URL).pathname;
    requested.push(path);
    if (path === '/v1/sync/t/bundle') return Response.json(bundle);
    const artifact = artifacts[path];
    return artifact ? artifact() : new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return requested;
}

describe('signed probe artifact sync', () => {
  let dir: string;
  let config: Parameters<typeof pull>[0];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'artifacts-'));
    config = {
      url: 'https://control.example',
      tenantId: 't',
      token: 'secret',
      keys,
      path: join(dir, 'cache', 'bundle.json'),
      artifactDir: join(dir, 'probes'),
    };
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  it('downloads and verifies missing artifacts before accepting the bundle', async () => {
    const requested = controlPlane(signedBundle(1, { 'jailbreak:2.0.0': '2.0.0' }), {
      '/v1/sync/t/probes/jailbreak/2.0.0': () =>
        Response.json(signProbeArtifact(artifactPayload('2.0.0'), privatePem, 'k')),
    });

    expect(await pull(config)).toBe(1);
    expect(await readFile(join(dir, 'probes', 'jailbreak-2.0.0.json'), 'utf8')).toBe(
      artifactPayload('2.0.0'),
    );
    expect(requested).toContain('/v1/sync/t/probes/jailbreak/2.0.0');
  });

  it('rejects the bundle when an artifact signature is invalid', async () => {
    controlPlane(signedBundle(1, { 'jailbreak:2.0.0': '2.0.0' }), {
      '/v1/sync/t/probes/jailbreak/2.0.0': () => {
        const envelope = signProbeArtifact(artifactPayload('2.0.0'), privatePem, 'k');
        return Response.json({ ...envelope, payload: envelope.payload.replace('0.5', '7.5') });
      },
    });

    await expect(pull(config)).rejects.toThrow('signature');
    await expect(readFile(config.path)).rejects.toThrow();
    await expect(readFile(join(dir, 'probes', 'jailbreak-2.0.0.json'))).rejects.toThrow();
  });

  it('rejects a validly signed artifact served for the wrong version', async () => {
    controlPlane(signedBundle(1, { 'jailbreak:2.0.0': '2.0.0' }), {
      '/v1/sync/t/probes/jailbreak/2.0.0': () =>
        Response.json(signProbeArtifact(artifactPayload('1.0.0'), privatePem, 'k')),
    });

    await expect(pull(config)).rejects.toThrow('match');
    await expect(readFile(config.path)).rejects.toThrow();
  });

  it('keeps the previous bundle when an artifact is unavailable', async () => {
    controlPlane(signedBundle(1, {}), {});
    expect(await pull(config)).toBe(1);
    const accepted = await readFile(config.path, 'utf8');

    controlPlane(signedBundle(2, { 'jailbreak:3.0.0': '3.0.0' }), {});
    await expect(pull(config)).rejects.toThrow('Fetch failed');
    expect(await readFile(config.path, 'utf8')).toBe(accepted);
  });

  it('does not download artifacts that are already present', async () => {
    const local = { ...config, artifactDir: dir };
    await writeFile(join(dir, 'jailbreak-1.0.0.json'), 'provisioned locally');
    const requested = controlPlane(signedBundle(1, { 'jailbreak:1.0.0': '1.0.0' }), {});

    expect(await pull(local)).toBe(1);
    expect(requested).toEqual(['/v1/sync/t/bundle']);
  });

  it('skips artifact sync entirely when no directory is configured', async () => {
    const requested = controlPlane(signedBundle(1, { 'jailbreak:2.0.0': '2.0.0' }), {});
    expect(await pull({ ...config, artifactDir: undefined })).toBe(1);
    expect(requested).toEqual(['/v1/sync/t/bundle']);
  });
});

import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { signBundle } from '@lab/bundles';
import { pull } from '../src/sync.js';
describe('pull-only sync', () => {
  it('keeps last valid signed file on outage, invalid signature and rollback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sync-')),
      path = join(dir, 'bundle.json'),
      k = generateKeyPairSync('ed25519');
    const priv = k.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      pub = k.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      now = Date.now();
    const envelope = signBundle(
      {
        schemaVersion: 1,
        bundleId: 'b',
        tenantId: 't',
        version: 2,
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60000).toISOString(),
        policies: [],
        revokedAgentIds: [],
        revokedTokenIds: [],
        probeVersions: {},
      },
      priv,
      'k',
    );
    const c = {
      url: 'https://control.example',
      tenantId: 't',
      token: 'secret',
      keys: new Map([['k', pub]]),
      path,
    };
    try {
      const mock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(envelope))
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce(Response.json({ ...envelope, signature: 'invalid' }))
        .mockResolvedValueOnce(Response.json(envelope));
      vi.stubGlobal('fetch', mock);
      expect(await pull(c)).toBe(2);
      const original = await readFile(path, 'utf8');
      for (let i = 0; i < 3; i++) {
        await expect(pull(c)).rejects.toThrow();
        expect(await readFile(path, 'utf8')).toBe(original);
      }
    } finally {
      vi.unstubAllGlobals();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

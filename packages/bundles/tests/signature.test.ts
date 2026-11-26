import { generateKeyPairSync } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { signBundle, verifyBundle } from '../src/index.js';
const k = generateKeyPairSync('ed25519'),
  priv = k.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  pub = k.publicKey.export({ format: 'pem', type: 'spki' }).toString();
const now = Date.now(),
  b = {
    schemaVersion: 1 as const,
    bundleId: 'b',
    version: 1,
    tenantId: 'a',
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 1000).toISOString(),
    policies: [],
    revokedTokenIds: [],
    revokedAgentIds: [],
    probeVersions: {},
  };
describe('signed bundles', () => {
  it('round trips exact bytes', () =>
    expect(verifyBundle(signBundle(b, priv, 'k'), new Map([['k', pub]]), 'a')).toEqual(b));
  it('rejects tampering and cross-tenant replay', () => {
    const e = signBundle(b, priv, 'k');
    expect(() =>
      verifyBundle({ ...e, payload: e.payload.replace('"a"', '"b"') }, new Map([['k', pub]]), 'a'),
    ).toThrow();
    expect(() => verifyBundle(e, new Map([['k', pub]]), 'b')).toThrow();
  });
});

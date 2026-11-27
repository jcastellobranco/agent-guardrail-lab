import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signBundle, signProbeArtifact, verifyBundle, verifyProbeArtifact } from '../src/index.js';

const key = generateKeyPairSync('ed25519');
const privatePem = key.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const keys = new Map([['k', key.publicKey.export({ format: 'pem', type: 'spki' }).toString()]]);

const artifact = {
  schemaVersion: 1,
  probeId: 'jailbreak',
  version: '2.0.0',
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
};
const payload = JSON.stringify(artifact);

describe('signed probe artifacts', () => {
  it('round-trips and returns the exact signed payload', () => {
    const envelope = signProbeArtifact(payload, privatePem, 'k');
    const verified = verifyProbeArtifact(envelope, keys, 'jailbreak:2.0.0');

    expect(verified.payload).toBe(payload);
    expect(verified.artifact.weights).toEqual([0.5, -0.25]);
  });

  it('rejects tampered weights', () => {
    const envelope = signProbeArtifact(payload, privatePem, 'k');
    const tampered = { ...envelope, payload: payload.replace('0.5', '9.5') };
    expect(() => verifyProbeArtifact(tampered, keys, 'jailbreak:2.0.0')).toThrow('signature');
  });

  it('rejects a validly signed artifact for a different version', () => {
    const envelope = signProbeArtifact(payload, privatePem, 'k');
    expect(() => verifyProbeArtifact(envelope, keys, 'jailbreak:1.0.0')).toThrow('match');
  });

  it('rejects unknown keys', () => {
    const envelope = signProbeArtifact(payload, privatePem, 'other');
    expect(() => verifyProbeArtifact(envelope, keys, 'jailbreak:2.0.0')).toThrow('Unknown');
  });

  it('refuses to sign an invalid artifact', () => {
    expect(() =>
      signProbeArtifact(JSON.stringify({ ...artifact, weights: [] }), privatePem, 'k'),
    ).toThrow();
  });

  it('keeps bundle and artifact signatures in separate domains', () => {
    const now = Date.now();
    const bundleEnvelope = signBundle(
      {
        schemaVersion: 1,
        bundleId: 'b',
        version: 1,
        tenantId: 't',
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 1000).toISOString(),
        policies: [],
        revokedTokenIds: [],
        revokedAgentIds: [],
        probeVersions: {},
      },
      privatePem,
      'k',
    );
    expect(() => verifyProbeArtifact(bundleEnvelope, keys, 'jailbreak:2.0.0')).toThrow('signature');
    const artifactEnvelope = signProbeArtifact(payload, privatePem, 'k');
    expect(() => verifyBundle(artifactEnvelope, keys, 't')).toThrow();
  });
});

import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import {
  PolicyBundleSchema,
  ProbeArtifactSchema,
  SignedPolicyBundleSchema,
  SignedProbeArtifactSchema,
  type PolicyBundle,
  type ProbeArtifact,
} from '@lab/contracts';
export function signBundle(bundle: PolicyBundle, pem: string, keyId: string) {
  const payload = JSON.stringify(PolicyBundleSchema.parse(bundle));
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Wrong signing key type');
  return SignedPolicyBundleSchema.parse({
    payload,
    signature: sign(null, Buffer.from(payload), key).toString('base64url'),
    keyId,
    algorithm: 'Ed25519',
  });
}
export function verifyBundle(
  input: unknown,
  keys: ReadonlyMap<string, string>,
  tenantId: string,
  now = Date.now(),
): PolicyBundle {
  const envelope = SignedPolicyBundleSchema.parse(input),
    pem = keys.get(envelope.keyId);
  if (!pem) throw new Error('Unknown signing key');
  const key = createPublicKey(pem);
  if (
    key.asymmetricKeyType !== 'ed25519' ||
    !verify(null, Buffer.from(envelope.payload), key, Buffer.from(envelope.signature, 'base64url'))
  )
    throw new Error('Invalid bundle signature');
  const bundle = PolicyBundleSchema.parse(JSON.parse(envelope.payload));
  if (bundle.tenantId !== tenantId || Date.parse(bundle.issuedAt) > now)
    throw new Error('Invalid bundle scope or time');
  return bundle;
}

/**
 * Domain separation: artifact signatures cover this prefix plus the payload, so a signature
 * made for a probe artifact can never verify as a policy bundle signature, or the reverse,
 * even though both use the same Ed25519 key.
 */
const ARTIFACT_SIGNING_CONTEXT = 'agent-guardrail-lab/probe-artifact/v1\n';

export function signProbeArtifact(payload: string, pem: string, keyId: string) {
  ProbeArtifactSchema.parse(JSON.parse(payload));
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Wrong signing key type');
  const message = Buffer.from(ARTIFACT_SIGNING_CONTEXT + payload);
  return SignedProbeArtifactSchema.parse({
    payload,
    signature: sign(null, message, key).toString('base64url'),
    keyId,
    algorithm: 'Ed25519',
  });
}

/**
 * Verifies the signature over the exact payload bytes, then checks the artifact is the one
 * requested (`probeId:version`), so a validly signed artifact cannot be swapped for another.
 */
export function verifyProbeArtifact(
  input: unknown,
  keys: ReadonlyMap<string, string>,
  expectedKey: string,
): { artifact: ProbeArtifact; payload: string } {
  const envelope = SignedProbeArtifactSchema.parse(input);
  const pem = keys.get(envelope.keyId);
  if (!pem) throw new Error('Unknown signing key');
  const key = createPublicKey(pem);
  const message = Buffer.from(ARTIFACT_SIGNING_CONTEXT + envelope.payload);
  const signature = Buffer.from(envelope.signature, 'base64url');
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, message, key, signature))
    throw new Error('Invalid artifact signature');
  const artifact = ProbeArtifactSchema.parse(JSON.parse(envelope.payload));
  if (`${artifact.probeId}:${artifact.version}` !== expectedKey)
    throw new Error('Artifact does not match the requested probe version');
  return { artifact, payload: envelope.payload };
}

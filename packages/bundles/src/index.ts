import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { PolicyBundleSchema, SignedPolicyBundleSchema, type PolicyBundle } from '@lab/contracts';
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

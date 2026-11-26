import { readFile } from 'node:fs/promises';
import { database } from '@lab/database';
import { buildControl } from './app.js';
const required = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
};
const { pool, db } = database(required('DATABASE_URL'));
const syncTokens = new Map<string, string>(
  Object.entries(JSON.parse(required('SYNC_TOKENS_JSON'))),
);
const adminToken = required('ADMIN_TOKEN');
if (
  adminToken.length < 24 ||
  [...syncTokens.values()].some((t) => typeof t !== 'string' || t.length < 24) ||
  new Set([adminToken, ...syncTokens.values()]).size !== syncTokens.size + 1
)
  throw new Error('Use distinct long credentials');
const app = await buildControl(db, {
  adminToken,
  syncTokens,
  jwtPem: await readFile(required('JWT_PRIVATE_KEY_PATH'), 'utf8'),
  bundlePem: await readFile(required('BUNDLE_PRIVATE_KEY_PATH'), 'utf8'),
  jwtKid: process.env.JWT_KEY_ID ?? 'dev-key',
  bundleKid: process.env.BUNDLE_KEY_ID ?? 'bundle-key',
  issuer: 'agent-guardrail-lab',
  audience: 'guardrail-api',
  bundleTtlMs: 300000,
});
app.addHook('onClose', async () => pool.end());
for (const s of ['SIGTERM', 'SIGINT'] as const)
  process.once(s, () => {
    void app.close();
  });
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 8002) });

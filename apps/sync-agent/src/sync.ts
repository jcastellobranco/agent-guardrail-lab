import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { verifyBundle } from '@lab/bundles';
import { compilePolicy } from '@lab/policy-engine';
export async function pull(c: {
  url: string;
  tenantId: string;
  token: string;
  keys: ReadonlyMap<string, string>;
  path: string;
  allowHttp?: boolean;
}) {
  const url = new URL(`/v1/sync/${encodeURIComponent(c.tenantId)}/bundle`, c.url);
  if (url.protocol !== 'https:' && !(c.allowHttp && url.protocol === 'http:'))
    throw new Error('HTTPS required');
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${c.token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok || !res.body) throw new Error('Bundle fetch failed');
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.length;
      if (size > 8_100_000) {
        await reader.cancel();
        throw new Error('Bundle too large');
      }
      parts.push(r.value);
    }
  } finally {
    reader.releaseLock();
  }
  const raw = Buffer.concat(parts).toString('utf8'),
    next = verifyBundle(JSON.parse(raw), c.keys, c.tenantId);
  if (Date.parse(next.expiresAt) <= Date.now()) throw new Error('Expired incoming bundle');
  next.policies.forEach(compilePolicy);
  let previous;
  try {
    previous = verifyBundle(JSON.parse(await readFile(c.path, 'utf8')), c.keys, c.tenantId);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (previous && next.version <= previous.version) throw new Error('Rollback or replay');
  await mkdir(dirname(c.path), { recursive: true });
  const temp = `${c.path}.tmp`;
  await writeFile(temp, raw, { mode: 0o600 });
  await rename(temp, c.path);
  return next.version;
}

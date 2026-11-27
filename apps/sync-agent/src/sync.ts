import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { verifyBundle, verifyProbeArtifact } from '@lab/bundles';
import { compilePolicy } from '@lab/policy-engine';

export interface SyncConfig {
  url: string;
  tenantId: string;
  token: string;
  keys: ReadonlyMap<string, string>;
  path: string;
  allowHttp?: boolean;
  /** When set, every probe artifact the bundle needs is downloaded here before acceptance. */
  artifactDir?: string;
}

const MAX_BUNDLE_BYTES = 8_100_000;
const MAX_ARTIFACT_BYTES = 2_100_000;

export async function pull(c: SyncConfig) {
  const raw = await fetchBounded(
    c,
    `/v1/sync/${encodeURIComponent(c.tenantId)}/bundle`,
    MAX_BUNDLE_BYTES,
  );
  const next = verifyBundle(JSON.parse(raw), c.keys, c.tenantId);
  if (Date.parse(next.expiresAt) <= Date.now()) throw new Error('Expired incoming bundle');
  next.policies.forEach(compilePolicy);

  let previous;
  try {
    previous = verifyBundle(JSON.parse(await readFile(c.path, 'utf8')), c.keys, c.tenantId);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (previous && next.version <= previous.version) throw new Error('Rollback or replay');

  // Artifacts first: a bundle must never reference a probe version the data plane lacks.
  // Any download or verification failure rejects the bundle and keeps the previous one.
  if (c.artifactDir) await syncProbeArtifacts(c, Object.keys(next.probeVersions), c.artifactDir);

  await atomicWrite(c.path, raw, 0o600);
  return next.version;
}

/**
 * Downloads and verifies each missing `probeId:version` artifact. Versions are immutable,
 * so an artifact already on disk (downloaded earlier or provisioned locally) is kept.
 */
export async function syncProbeArtifacts(c: SyncConfig, probeKeys: readonly string[], dir: string) {
  const downloaded: string[] = [];
  for (const key of probeKeys) {
    const [probeId, version] = key.split(':') as [string, string];
    const file = join(dir, `${probeId}-${version}.json`);
    if (await exists(file)) continue;

    const segments = [c.tenantId, 'probes', probeId, version].map(encodeURIComponent);
    const path = `/v1/sync/${segments.join('/')}`;
    const raw = await fetchBounded(c, path, MAX_ARTIFACT_BYTES);
    const { payload } = verifyProbeArtifact(JSON.parse(raw), c.keys, key);
    // Written world-readable: the inference service runs as a different user.
    await atomicWrite(file, payload, 0o644);
    downloaded.push(key);
  }
  return downloaded;
}

async function fetchBounded(c: SyncConfig, path: string, maxBytes: number): Promise<string> {
  const url = new URL(path, c.url);
  if (url.protocol !== 'https:' && !(c.allowHttp && url.protocol === 'http:'))
    throw new Error('HTTPS required');
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${c.token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok || !res.body) throw new Error(`Fetch failed: ${url.pathname}`);

  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error('Response too large');
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(parts).toString('utf8');
}

/** Write to a temporary file, then rename: readers see the old file or the new one, never half. */
async function atomicWrite(path: string, content: string, mode: number) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, content, { mode });
  await rename(temp, path);
}

async function exists(path: string) {
  return access(path).then(
    () => true,
    () => false,
  );
}

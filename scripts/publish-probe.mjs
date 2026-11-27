// Publishes a trained probe artifact to the control plane, e.g.:
//   node scripts/publish-probe.mjs apps/inference-service/artifacts/jailbreak-1.0.0.json
// Versions are immutable: re-publishing identical content is a no-op, different content is a 409.
import { readFile } from 'node:fs/promises';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/publish-probe.mjs <artifact.json>');
  process.exit(2);
}
const control = process.env.CONTROL_PLANE_URL ?? 'http://127.0.0.1:8002';
const admin = process.env.ADMIN_TOKEN ?? 'local-only-admin-change-me-1234';

const artifact = JSON.parse(await readFile(file, 'utf8'));
const path = `/v1/admin/probes/${encodeURIComponent(artifact.probeId)}/versions/${encodeURIComponent(artifact.version)}`;
const res = await fetch(new URL(path, control), {
  method: 'PUT',
  headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
  body: JSON.stringify(artifact),
  signal: AbortSignal.timeout(10000),
});
console.log(res.status, await res.text());
process.exitCode = res.ok ? 0 : 1;

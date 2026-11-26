import { setTimeout as sleep } from 'node:timers/promises';
import { localPool, aggregate, sendTelemetry } from '@lab/local-audit';
import { TelemetryObservationSchema, Id } from '@lab/contracts';
const get = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing ${k}`);
  return v;
};
const pool = localPool(get('LOCAL_AUDIT_DATABASE_URL')),
  tenant = Id.parse(get('SILO_TENANT')),
  deployment = Id.parse(get('DEPLOYMENT_ID')),
  url = get('CONTROL_PLANE_URL'),
  token = get('SYNC_TOKEN');
let running = true;
for (const s of ['SIGINT', 'SIGTERM'] as const)
  process.once(s, () => {
    running = false;
  });
async function tick() {
  // Use processing-time windows. A 10s grace absorbs ordinary short worker transactions.
  await pool.query(
    `INSERT INTO telemetry_cursor(tenant_id,deployment_id,next_window) VALUES($1,$2,date_trunc('minute',now())-interval '1 minute') ON CONFLICT DO NOTHING`,
    [tenant, deployment],
  );
  const cursor = await pool.query(
    'SELECT next_window FROM telemetry_cursor WHERE tenant_id=$1 AND deployment_id=$2',
    [tenant, deployment],
  );
  const start: Date = cursor.rows[0].next_window,
    end = new Date(start.getTime() + 60000);
  if (end.getTime() + 10000 > Date.now()) return;
  // Explicit bound: never silently truncate a window. Oversize windows need operator intervention/SQL aggregation.
  const rows = await pool.query(
    "SELECT event - 'call' - 'agentId' - 'timestamp' AS event FROM audit_records WHERE tenant_id=$1 AND processed_at >=$2 AND processed_at <$3 ORDER BY processed_at,decision_id LIMIT 10001",
    [tenant, start, end],
  );
  if (rows.rowCount! > 10000) throw new Error('Telemetry window exceeded lab capacity');
  const window = aggregate(
    tenant,
    deployment,
    start,
    rows.rows.map((r) => TelemetryObservationSchema.parse(r.event)),
  );
  await sendTelemetry(url, token, window, process.env.ALLOW_INSECURE_LOCAL_HTTP === '1');
  await pool.query(
    'UPDATE telemetry_cursor SET next_window=$3 WHERE tenant_id=$1 AND deployment_id=$2 AND next_window=$4',
    [tenant, deployment, end, start],
  );
}
try {
  while (running) {
    try {
      await tick();
    } catch {
      console.warn('Telemetry export delayed');
    }
    await sleep(5000);
  }
} finally {
  await pool.end();
}

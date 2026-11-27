import pg from 'pg';
import {
  AuditEventSchema,
  TelemetryWindowSchema,
  type AuditEvent,
  type TelemetryObservation,
  type TelemetryWindow,
  type StageName,
  type Decision,
} from '@lab/contracts';
export function localPool(url: string) {
  if (!url) throw new Error('Local audit database URL required');
  return new pg.Pool({
    connectionString: url,
    max: 4,
    connectionTimeoutMillis: 2000,
    statement_timeout: 5000,
  });
}
/** A dedicated session for LISTEN; never taken from the pool. */
export function listenerClient(url: string, options: pg.ClientConfig = {}) {
  if (!url) throw new Error('Local audit database URL required');
  return new pg.Client({
    connectionString: url,
    application_name: 'audit-listener',
    keepAlive: true,
    connectionTimeoutMillis: 2000,
    ...options,
  });
}

/** Channel used to wake the audit worker. The payload is empty: NOTIFY never carries trace data. */
export const AUDIT_CHANNEL = 'audit_events';

export async function enqueue(pool: pg.Pool, event: AuditEvent) {
  // One autocommit statement: the notification is delivered only if the row commits,
  // and duplicates (ON CONFLICT) do not wake the worker.
  await pool.query(
    `WITH inserted AS (
       INSERT INTO audit_queue(decision_id, event) VALUES ($1, $2)
       ON CONFLICT DO NOTHING
       RETURNING 1
     )
     SELECT pg_notify('${AUDIT_CHANNEL}', '') FROM inserted`,
    [event.decision.decisionId, JSON.stringify(event)],
  );
}
// The hot path only schedules in RAM. Queue saturation and crash loss are explicit trade-offs.
export class BufferedAuditSink {
  private queue: AuditEvent[] = [];
  private active = false;
  private closing = false;
  private idle: Promise<void> = Promise.resolve();
  constructor(
    private readonly write: (event: AuditEvent) => Promise<void>,
    private readonly drop: () => void,
    private readonly capacity = 256,
  ) {}
  offer(event: AuditEvent) {
    if (this.closing || this.queue.length >= this.capacity) {
      this.drop();
      return;
    }
    this.queue.push(event);
    if (!this.active) {
      this.active = true;
      this.idle = new Promise((resolve) =>
        setImmediate(() => {
          void this.flush().finally(resolve);
        }),
      );
    }
  }
  private async flush() {
    try {
      while (this.queue.length) {
        const event = this.queue.shift()!;
        try {
          await this.write(event);
        } catch {
          this.drop();
        }
      }
    } finally {
      this.active = false;
    }
  }
  async close() {
    this.closing = true;
    await this.idle;
  }
}
export async function processOne(pool: pg.Pool, maxAttempts = 3): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      'SELECT decision_id,event,attempts FROM audit_queue WHERE available_at<=now() ORDER BY available_at,decision_id LIMIT 1 FOR UPDATE SKIP LOCKED',
    );
    const row = r.rows[0];
    if (!row) {
      await client.query('COMMIT');
      return false;
    }
    await client.query('SAVEPOINT processing');
    try {
      const e = AuditEventSchema.parse(row.event);
      if (e.decision.decisionId !== row.decision_id) throw new Error('Decision ID mismatch');
      // Idempotent side effect and acknowledgment share a transaction.
      await client.query(
        'INSERT INTO audit_records(decision_id,tenant_id,event,processed_at) VALUES($1,$2,$3,clock_timestamp()) ON CONFLICT DO NOTHING',
        [row.decision_id, e.tenantId, JSON.stringify(e)],
      );
      await client.query('DELETE FROM audit_queue WHERE decision_id=$1', [row.decision_id]);
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT processing');
      const attempts = Number(row.attempts) + 1;
      if (attempts >= maxAttempts) {
        await client.query(
          'INSERT INTO audit_dead_letter(decision_id,event,attempts) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [row.decision_id, row.event, attempts],
        );
        await client.query('DELETE FROM audit_queue WHERE decision_id=$1', [row.decision_id]);
      } else
        await client.query(
          "UPDATE audit_queue SET attempts=$2,available_at=now()+($2*interval '5 seconds') WHERE decision_id=$1",
          [row.decision_id, attempts],
        );
    }
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
export { AuditWorker, type AuditWorkerOptions, type ListenerClient } from './worker.js';

export function percentile(values: number[], p: number) {
  if (!values.length) return 0;
  const a = [...values].sort((x, y) => x - y);
  return a[Math.max(0, Math.ceil(p * a.length) - 1)]!;
}
// Only explicit projections leave the data plane. No arbitrary string or object spreading from a trace.
export function aggregate(
  tenantId: string,
  deploymentId: string,
  start: Date,
  events: readonly TelemetryObservation[],
): TelemetryWindow {
  const decisions = new Map<
    string,
    { policyId: string; outcome: Decision['outcome']; count: number }
  >();
  const probes = new Map<
    string,
    {
      probeId: string;
      version: string;
      histogram: { upperBound: number; count: number }[];
      decisions: { outcome: Decision['outcome']; count: number }[];
    }
  >();
  const stages = new Map<StageName, number[]>();
  let stale = 0,
    age = 0,
    bundle = 0,
    model: string | undefined;
  const versions: Record<string, string> = {};
  for (const e of events) {
    if (e.tenantId !== tenantId) throw new Error('Tenant mismatch');
    const d = e.decision,
      key = JSON.stringify([d.policyId, d.outcome]);
    const prev = decisions.get(key);
    decisions.set(key, { policyId: d.policyId, outcome: d.outcome, count: (prev?.count ?? 0) + 1 });
    if (d.reasons.some((r) => r.code === 'STALE_POLICY')) stale++;
    age = Math.max(age, e.cacheAgeSeconds);
    bundle = Math.max(bundle, e.bundleVersion);
    if (e.modelVersion) model = e.modelVersion;
    for (const s of e.stages) {
      const v = stages.get(s.stage) ?? [];
      v.push(s.ms);
      stages.set(s.stage, v);
    }
    for (const r of d.reasons) {
      if (r.source !== 'probe' || !r.probeId || r.score === undefined) continue;
      const [probeId, version] = r.probeId.split(':');
      if (!probeId || !version) continue;
      versions[r.probeId] = version;
      let p = probes.get(r.probeId);
      if (!p) {
        p = {
          probeId,
          version,
          histogram: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1].map((upperBound) => ({
            upperBound,
            count: 0,
          })),
          decisions: ['allow', 'flag', 'block'].map((outcome) => ({
            outcome: outcome as Decision['outcome'],
            count: 0,
          })),
        };
        probes.set(r.probeId, p);
      }
      p.histogram.find((b) => r.score! <= b.upperBound)!.count++;
      const outcome =
        r.code === 'PROBE_BLOCK' ? 'block' : r.code === 'PROBE_FLAG' ? 'flag' : 'allow';
      p.decisions.find((d) => d.outcome === outcome)!.count++;
    }
  }
  return TelemetryWindowSchema.parse({
    schemaVersion: 1,
    tenantId,
    deploymentId,
    windowStart: start.toISOString(),
    windowEnd: new Date(start.getTime() + 60000).toISOString(),
    decisions: [...decisions.values()],
    probeMetrics: [...probes.values()],
    stageLatencies: [...stages].map(([stage, v]) => ({
      stage,
      p50: percentile(v, 0.5),
      p95: percentile(v, 0.95),
      p99: percentile(v, 0.99),
    })),
    cacheAgeSeconds: age,
    stalePolicyCount: stale,
    versions: { guardrail: '0.6.0', model, policyBundle: bundle, probes: versions },
  });
}
export async function sendTelemetry(
  url: string,
  token: string,
  window: TelemetryWindow,
  allowHttp = false,
) {
  const body = TelemetryWindowSchema.parse(window);
  const target = new URL(`/v1/sync/${encodeURIComponent(body.tenantId)}/telemetry`, url);
  if (target.protocol !== 'https:' && !(allowHttp && target.protocol === 'http:'))
    throw new Error('HTTPS required');
  const res = await fetch(target, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error('Telemetry ingest failed');
}

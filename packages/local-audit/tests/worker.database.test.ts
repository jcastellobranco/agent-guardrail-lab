import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuditEvent } from '@lab/contracts';
import { AUDIT_CHANNEL, AuditWorker, enqueue, listenerClient, processOne } from '../src/index.js';

const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_DATABASE_TESTS === '1' && !url) {
  throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests');
}
const suite = url ? describe : describe.skip;

// Long enough that a test passing quickly proves NOTIFY woke the worker, not the poll timer.
const POLL_INTERVAL_MS = 30_000;
const schema = `audit_test_${randomUUID().replaceAll('-', '')}`;
const searchPath = { options: `-c search_path=${schema}` };

function auditEvent(decisionId = randomUUID()): AuditEvent {
  return {
    tenantId: 'tenant-a',
    agentId: 'agent-a',
    timestamp: new Date().toISOString(),
    call: { agentId: 'agent-a', tool: 'transfer', arguments: { amount: 5 } },
    decision: {
      decisionId,
      outcome: 'allow',
      policyId: 'p',
      policyVersion: 1,
      reasons: [],
      degraded: false,
      latencyMs: 1,
    },
    stages: [],
    bundleVersion: 1,
    cacheAgeSeconds: 0,
  };
}

suite('audit worker with LISTEN/NOTIFY', () => {
  let pool: pg.Pool;
  const running: { abort: AbortController; done: Promise<void> }[] = [];

  const count = async (table: string, decisionId: string) =>
    Number(
      (await pool.query(`SELECT count(*) FROM ${table} WHERE decision_id=$1`, [decisionId])).rows[0]
        .count,
    );

  async function eventually(check: () => Promise<boolean>, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await sleep(25);
    }
    throw new Error(`Condition not met within ${timeoutMs} ms`);
  }

  async function startWorker() {
    const worker = new AuditWorker({
      processNext: () => processOne(pool),
      createListener: () => listenerClient(url!, searchPath),
      channel: AUDIT_CHANNEL,
      pollIntervalMs: POLL_INTERVAL_MS,
      reconnectDelayMs: 200,
    });
    const abort = new AbortController();
    running.push({ abort, done: worker.run(abort.signal) });
    await eventually(async () => worker.isListening, 5000);
    return worker;
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4, ...searchPath });
    const ddl = await readFile(new URL('../sql/001_queue.sql', import.meta.url), 'utf8');
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(ddl);
  });

  afterEach(async () => {
    for (const { abort, done } of running.splice(0)) {
      abort.abort();
      await done;
    }
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  });

  it('processes an event within a second of enqueue instead of waiting for the poll', async () => {
    await startWorker();
    const event = auditEvent();
    const started = Date.now();

    await enqueue(pool, event);
    await eventually(
      async () => (await count('audit_records', event.decision.decisionId)) === 1,
      1000,
    );

    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('processes events enqueued while the worker was down once it starts', async () => {
    const event = auditEvent();
    await enqueue(pool, event); // nobody is listening: this NOTIFY is lost

    await startWorker();

    await eventually(
      async () => (await count('audit_records', event.decision.decisionId)) === 1,
      2000,
    );
  });

  it('reconciles after the LISTEN connection drops', async () => {
    await startWorker();
    await pool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE application_name = 'audit-listener' AND datname = current_database()`,
    );
    const event = auditEvent();
    await enqueue(pool, event); // sent while the listener is reconnecting

    await eventually(
      async () => (await count('audit_records', event.decision.decisionId)) === 1,
      3000,
    );
  });

  it('keeps duplicates idempotent', async () => {
    await startWorker();
    const event = auditEvent();

    await enqueue(pool, event);
    await enqueue(pool, event);
    await eventually(
      async () => (await count('audit_records', event.decision.decisionId)) === 1,
      1000,
    );

    // Redelivery of an already-recorded event (e.g. a crash after insert, before ack).
    await pool.query('INSERT INTO audit_queue(decision_id, event) VALUES ($1, $2)', [
      event.decision.decisionId,
      JSON.stringify(event),
    ]);
    await pool.query(`NOTIFY ${AUDIT_CHANNEL}`);
    await eventually(
      async () => (await count('audit_queue', event.decision.decisionId)) === 0,
      1000,
    );

    expect(await count('audit_records', event.decision.decisionId)).toBe(1);
  });
});

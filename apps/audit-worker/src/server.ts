import {
  AUDIT_CHANNEL,
  AuditWorker,
  listenerClient,
  localPool,
  processOne,
} from '@lab/local-audit';

const url = process.env.LOCAL_AUDIT_DATABASE_URL ?? '';
const pollIntervalMs = Number(process.env.AUDIT_POLL_INTERVAL_MS ?? 5000);
if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 100) {
  throw new Error('AUDIT_POLL_INTERVAL_MS must be an integer >= 100');
}

const pool = localPool(url);
const worker = new AuditWorker({
  processNext: () => processOne(pool),
  createListener: () => listenerClient(url),
  channel: AUDIT_CHANNEL,
  pollIntervalMs,
  onError: (stage) => {
    // Never log the error object: it can include queued event content.
    console.warn(
      stage === 'listen' ? 'Audit LISTEN unavailable; polling' : 'Audit processing unavailable',
    );
  },
});

const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => shutdown.abort());
}

try {
  await worker.run(shutdown.signal);
} finally {
  await pool.end();
}

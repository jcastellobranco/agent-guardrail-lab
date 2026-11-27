# ADR 0013 — LISTEN/NOTIFY wake-up for the audit worker

## Context

The audit worker polled `audit_queue` and slept when it was empty. The poll interval is a direct trade-off: a short interval wastes queries on an idle queue, and a long one delays audit records. ADR 0010 left LISTEN/NOTIFY as a possible optimization.

## Decision

- `enqueue` inserts the row and calls `pg_notify('audit_events', '')` in the same statement. NOTIFY is transactional, so the notification is delivered only if the row commits, and a duplicate insert (`ON CONFLICT DO NOTHING`) sends nothing. The payload is empty, so no trace data travels over the notification channel.
- The worker keeps one dedicated `pg.Client` (`application_name=audit-listener`) running `LISTEN audit_events`. A notification wakes the drain loop immediately.
- Polling stays, as reconciliation, at a longer default of 5 s (`AUDIT_POLL_INTERVAL_MS`). Retries with `available_at` in the future, rows inserted by other writers, and notifications sent while the listener was down all rely on it.
- On every (re)connect the worker drains once, because any NOTIFY sent while it was disconnected was lost.
- Wake-ups are level-triggered: a notification that arrives while the worker is draining sets a pending flag, so the next wait returns at once. This closes the window between "queue looked empty" and "start waiting".

## Consequences

- Audit latency drops from up to one poll interval to milliseconds. The database test asserts processing in under 1 s with a 30 s poll interval.
- NOTIFY is not durable. Correctness still comes from the table and the poll. NOTIFY is only a latency hint, and losing one only costs latency.
- LISTEN is tied to one backend session, so it needs a direct connection. It does not work through a transaction-mode pooler (PgBouncer, Neon's pooled endpoint), which can switch backends between statements. Use a session-mode or direct URL for the worker.
- The listener is one extra idle connection per worker. With N workers, every NOTIFY wakes all of them, and `FOR UPDATE SKIP LOCKED` keeps them from processing the same row. That's acceptable at lab scale; at high throughput you'd batch or coalesce notifications.
- Rejected alternatives: a trigger-based NOTIFY would also cover raw SQL inserts, but it hides behavior inside the schema and wouldn't apply to volumes already initialized. An external broker (Redis or SQS) adds a dependency without removing the need for reconciliation.

import { setTimeout as sleep } from 'node:timers/promises';

/** The subset of `pg.Client` the worker needs to hold a LISTEN session. */
export interface ListenerClient {
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: 'notification', listener: () => void): unknown;
  on(event: 'error' | 'end', listener: (error?: Error) => void): unknown;
}

export interface AuditWorkerOptions {
  /** Processes at most one available queue row; resolves false when the queue is empty. */
  processNext: () => Promise<boolean>;
  /**
   * Opens a dedicated, non-pooled session. LISTEN is bound to one backend connection,
   * so it must not go through a pool or a transaction-mode pooler such as PgBouncer.
   */
  createListener: () => ListenerClient;
  channel: string;
  /** Reconciliation interval. NOTIFY is not durable, so polling remains the safety net. */
  pollIntervalMs: number;
  reconnectDelayMs?: number;
  processingErrorDelayMs?: number;
  onError?: (stage: 'listen' | 'process', error: unknown) => void;
}

/**
 * Drains the audit queue, waking on NOTIFY for low latency and on a timer for correctness.
 *
 * Wake-ups are level-triggered: a notification that arrives while the worker is draining
 * sets a pending flag, so it is never lost between "queue looked empty" and "start waiting".
 */
export class AuditWorker {
  private readonly options: Required<Omit<AuditWorkerOptions, 'onError'>> &
    Pick<AuditWorkerOptions, 'onError'>;
  private wakePending = false;
  private wakeWaiter: (() => void) | undefined;
  private listening = false;

  constructor(options: AuditWorkerOptions) {
    this.options = { reconnectDelayMs: 1000, processingErrorDelayMs: 2000, ...options };
  }

  /** True while a LISTEN session is established. */
  get isListening(): boolean {
    return this.listening;
  }

  async run(signal: AbortSignal): Promise<void> {
    const listener = this.maintainListener(signal);
    try {
      while (!signal.aborted) {
        await this.drain(signal);
        await this.waitForWake(this.options.pollIntervalMs, signal);
      }
    } finally {
      this.wake();
      await listener;
    }
  }

  /** Schedules an immediate drain (used by NOTIFY, reconnects and tests). */
  wake(): void {
    this.wakePending = true;
    this.wakeWaiter?.();
  }

  private async drain(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        if (!(await this.options.processNext())) return;
      } catch (error) {
        this.options.onError?.('process', error);
        await pause(this.options.processingErrorDelayMs, signal);
        return;
      }
    }
  }

  private async waitForWake(timeoutMs: number, signal: AbortSignal): Promise<void> {
    if (this.wakePending || signal.aborted) {
      this.wakePending = false;
      return;
    }
    const timeout = new AbortController();
    const onAbort = () => timeout.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await new Promise<void>((resolve) => {
        this.wakeWaiter = resolve;
        sleep(timeoutMs, undefined, { signal: timeout.signal }).then(resolve, resolve);
      });
    } finally {
      this.wakeWaiter = undefined;
      this.wakePending = false;
      timeout.abort();
      signal.removeEventListener('abort', onAbort);
    }
  }

  private async maintainListener(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const client = this.options.createListener();
      const closed = new Promise<void>((resolve) => {
        client.on('error', (error) => {
          this.options.onError?.('listen', error);
          resolve();
        });
        client.on('end', () => resolve());
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      client.on('notification', () => this.wake());
      try {
        await client.connect();
        await client.query(`LISTEN ${this.options.channel}`);
        this.listening = true;
        // Anything enqueued while we were disconnected sent a NOTIFY nobody heard.
        this.wake();
        await closed;
      } catch (error) {
        this.options.onError?.('listen', error);
      } finally {
        this.listening = false;
        await client.end().catch(() => {});
      }
      await pause(this.options.reconnectDelayMs, signal);
    }
  }
}

async function pause(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await sleep(ms, undefined, { signal });
  } catch {
    // Aborted: the caller's loop condition ends the work.
  }
}

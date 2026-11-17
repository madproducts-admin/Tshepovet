import type { Client } from 'pg';
import type { Logger } from '../lib/logger';

export const JOBS_CHANNEL = 'tv_jobs';

/**
 * Wakes the worker when a transaction commits work for it: triggers on the webhook and email
 * outboxes call pg_notify('tv_jobs', '<kind>'), which PostgreSQL delivers only on commit
 * (migration 0006). Holds one connection of its own; on any error it reconnects with backoff
 * and runs every handler once, to catch up on what was committed while it was away.
 */
export class JobsListener {
  private client: Client | null = null;
  private stopped = false;
  private delay = 1000;
  private retry: NodeJS.Timeout | null = null;

  constructor(
    private readonly connect: () => Promise<Client>,
    private readonly handlers: Record<string, () => void>,
    private readonly log: Logger,
  ) {}

  async start(): Promise<void> {
    await this.open();
  }

  private async open(): Promise<void> {
    if (this.stopped) return;
    try {
      const c = await this.connect();
      c.on('notification', (n) => {
        if (n.channel === JOBS_CHANNEL && n.payload) this.handlers[n.payload]?.();
      });
      c.on('error', (err) => this.lost(err));
      c.on('end', () => this.lost(new Error('connection ended')));
      await c.query(`LISTEN ${JOBS_CHANNEL}`);
      this.client = c;
      this.delay = 1000;
      for (const h of Object.values(this.handlers)) h();
    } catch (err) {
      this.lost(err);
    }
  }

  private lost(err: unknown) {
    if (this.stopped || this.retry) return;
    this.log.warn({ err }, 'jobs listener lost its connection; reconnecting');
    const old = this.client;
    this.client = null;
    old?.end().catch(() => undefined);
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.open();
    }, this.delay);
    this.delay = Math.min(this.delay * 2, 30_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    const c = this.client;
    this.client = null;
    await c?.end().catch(() => undefined);
  }
}

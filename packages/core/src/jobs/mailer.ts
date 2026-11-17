import type { Pool } from 'pg';

/**
 * Email delivery from email_outbox. The sandbox delivers nothing (docs/PLAN.md §6): each
 * queued message is marked 'sandbox', held for the staff console's outbox viewer. Real
 * delivery (the Cloud mail gateway or an SMTP account) is an owner decision (PLAN §8).
 */
export interface Mailer {
  /** Handles what is queued; returns how many messages it handled. */
  flush(): Promise<number>;
}

export class SandboxMailer implements Mailer {
  constructor(private readonly pool: Pool) {}

  async flush(): Promise<number> {
    let total = 0;
    for (;;) {
      const r = await this.pool.query(
        `UPDATE email_outbox SET status = 'sandbox', attempts = attempts + 1
          WHERE id IN (SELECT id FROM email_outbox WHERE status = 'queued' ORDER BY created_at LIMIT 500 FOR UPDATE SKIP LOCKED)`,
      );
      total += r.rowCount ?? 0;
      if ((r.rowCount ?? 0) < 500) return total;
    }
  }
}

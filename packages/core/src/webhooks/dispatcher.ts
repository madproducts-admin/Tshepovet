import type { Pool } from 'pg';
import type { Crypto } from '../lib/crypto';
import type { Logger } from '../lib/logger';
import { guardedWebhookFetch, type WebhookFetch } from './safeTarget';
import { signWebhook } from './signing';

type Claimed = {
  id: string;
  attempts: number;
  url: string;
  secret_enc: Buffer;
  previous_secret_enc: Buffer | null;
  previous_secret_expires_at: Date | null;
  endpoint_id: string;
  tenant_id: string;
  event_id: string;
  event_type: string;
  payload: unknown;
};

/**
 * Delivers outbox rows. Runs as tshepovet_worker (BYPASSRLS) because it
 * serves every tenant. Concurrency-safe across replicas via SKIP LOCKED.
 *
 * Retry schedule: 30s, 1m, 2m, 4m ... capped at 6h, with +/-20% jitter;
 * after 15 attempts (~ 1.5 days) the delivery is dead-lettered and visible
 * in the dashboard for manual replay. An endpoint that fails 50 deliveries in
 * a row is disabled and the tenant's admins are emailed.
 */
const MAX_ATTEMPTS = 15;
const DISABLE_AFTER_CONSECUTIVE = 50;

export function backoffMs(attempt: number, random = Math.random): number {
  const base = Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 6 * 3_600_000);
  return Math.round(base * (0.8 + 0.4 * random()));
}

export class WebhookDispatcher {
  constructor(
    private readonly pool: Pool,
    private readonly crypto: Crypto,
    private readonly log: Logger,
    /** The HTTP client. Default: HTTPS to public addresses only (safeTarget.ts). */
    private readonly fetchImpl: WebhookFetch = guardedWebhookFetch(),
  ) {}

  /** When the next delivery (or retry) falls due; null when nothing is waiting. */
  async nextDueAt(): Promise<Date | null> {
    const r = await this.pool.query<{ at: Date | null }>(`SELECT min(next_attempt_at) AS at FROM webhook_deliveries WHERE status IN ('pending','failed')`);
    return r.rows[0]?.at ?? null;
  }

  async runOnce(batchSize = 50): Promise<number> {
    const client = await this.pool.connect();
    let claimed: Claimed[];
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `SELECT d.id, d.attempts, d.endpoint_id, d.tenant_id, d.event_id, e.event_type, e.payload, w.url, w.secret_enc,
                w.previous_secret_enc, w.previous_secret_expires_at
           FROM webhook_deliveries d
           JOIN webhook_events e ON e.id = d.event_id
           JOIN webhook_endpoints w ON w.id = d.endpoint_id AND w.status = 'active'
          WHERE d.status IN ('pending','failed') AND d.next_attempt_at <= now()
          ORDER BY d.next_attempt_at
          LIMIT $1
          FOR UPDATE OF d SKIP LOCKED`,
        [batchSize],
      );
      claimed = r.rows;
      if (claimed.length) {
        await client.query(`UPDATE webhook_deliveries SET status = 'delivering' WHERE id = ANY($1::uuid[])`, [claimed.map((c) => c.id)]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    await Promise.all(claimed.map((d) => this.deliver(d)));
    return claimed.length;
  }

  private async deliver(d: Claimed) {
    const body = JSON.stringify(d.payload);
    const attempt = d.attempts + 1;
    let status: number | null = null;
    let error: string | null = null;
    try {
      const aad = `webhook_secret:${d.tenant_id}`;
      // During a rotation the previous secret keeps signing (one v1= each) until it expires.
      const secrets = [await this.crypto.decryptString(d.secret_enc, aad)];
      if (d.previous_secret_enc && d.previous_secret_expires_at && d.previous_secret_expires_at > new Date()) {
        secrets.push(await this.crypto.decryptString(d.previous_secret_enc, aad));
      }
      const res = await this.fetchImpl(d.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'TshepoVet-Webhooks/1.0',
          'tshepovet-event-id': d.event_id,
          'tshepovet-event-type': d.event_type,
          'tshepovet-delivery-attempt': String(attempt),
          'tshepovet-signature': signWebhook(secrets, body),
        },
        body,
        redirect: 'manual', // never follow redirects with signed payloads
        signal: AbortSignal.timeout(10_000),
      });
      status = res.status;
    } catch (err) {
      error = (err as Error).message.slice(0, 500);
    }

    const ok = status !== null && status >= 200 && status < 300;
    if (ok) {
      await this.pool.query(
        `UPDATE webhook_deliveries SET status = 'succeeded', attempts = $2, last_http_status = $3, delivered_at = now(), last_error = NULL WHERE id = $1`,
        [d.id, attempt, status],
      );
      await this.pool.query(`UPDATE webhook_endpoints SET consecutive_failures = 0 WHERE id = $1`, [d.endpoint_id]);
      return;
    }
    const dead = attempt >= MAX_ATTEMPTS;
    await this.pool.query(
      `UPDATE webhook_deliveries
          SET status = $2, attempts = $3, last_http_status = $4, last_error = $5,
              next_attempt_at = now() + ($6 || ' milliseconds')::interval
        WHERE id = $1`,
      [d.id, dead ? 'dead' : 'failed', attempt, status, error ?? `HTTP ${status}`, String(backoffMs(attempt))],
    );
    const ep = await this.pool.query<{ consecutive_failures: number }>(
      `UPDATE webhook_endpoints SET consecutive_failures = consecutive_failures + 1 WHERE id = $1 RETURNING consecutive_failures`,
      [d.endpoint_id],
    );
    if ((ep.rows[0]?.consecutive_failures ?? 0) >= DISABLE_AFTER_CONSECUTIVE) {
      await this.pool.query(`UPDATE webhook_endpoints SET status = 'disabled', disabled_at = now() WHERE id = $1`, [d.endpoint_id]);
      this.log.warn({ endpoint: d.endpoint_id, tenant: d.tenant_id }, 'webhook endpoint disabled after consecutive failures');
    }
  }
}

import type { Pool } from 'pg';
import type { Crypto } from '../lib/crypto';
import type { Logger } from '../lib/logger';
import { claimVerification, failVerification, releaseClaim, type VerificationJobs } from '../services/lifecycle';

export class VerificationBusyError extends Error {
  constructor(id: string, until: Date) {
    super(`verification ${id} is being run elsewhere until ${until.toISOString()}`);
    this.name = 'VerificationBusyError';
  }
}

interface Resumable {
  resume(payload: unknown): Promise<void>;
}

/**
 * Runs a verification in a worker: an async one from the start, or one whose runner (the API,
 * or another worker) stopped. It takes the claim, runs the checks from the stored input and
 * finalises (once only: finalizeVerification). One that cannot be run, because its input was
 * never stored or it failed too often, is ended as failed with nothing charged.
 */
export class VerificationRunner {
  constructor(
    private readonly d: {
      pool: Pool;
      crypto: Crypto;
      log: Logger;
      company: Resumable;
      driver: Resumable;
      /** How long a worker run may take before another may take over. */
      claimMs?: number;
      /** Worker runs before giving up. */
      maxRuns?: number;
    },
  ) {}

  async run(verificationId: string): Promise<'final' | 'completed' | 'failed'> {
    const claim = await claimVerification(this.d.pool, this.d.crypto, verificationId, this.d.claimMs ?? 120_000);
    if (claim.state === 'final') return 'final';
    if (claim.state === 'busy') throw new VerificationBusyError(verificationId, claim.until);
    if (!claim.envelope || claim.runs > (this.d.maxRuns ?? 3)) {
      const reason = claim.envelope ? 'gave_up_after_retries' : 'not_resumable';
      this.d.log.warn({ verificationId, reason }, 'verification ended as failed');
      await failVerification(this.d.pool, this.d.crypto, verificationId, reason);
      return 'failed';
    }
    try {
      const service = claim.envelope.kind === 'company' ? this.d.company : this.d.driver;
      await service.resume(claim.envelope.payload);
      return 'completed';
    } catch (err) {
      // The next attempt (BullMQ backoff) may claim it at once.
      await releaseClaim(this.d.pool, verificationId);
      throw err;
    }
  }
}

/**
 * The safety net: a verification still processing two minutes after it was asked for, with
 * no live claim, lost its runner (a restart, a crash). Each is handed to the queue again.
 */
export async function resumeStalledVerifications(pool: Pool, jobs: VerificationJobs): Promise<number> {
  const r = await pool.query<{ id: string; tenant_id: string }>(
    `SELECT id, tenant_id FROM verifications
      WHERE status = 'processing' AND requested_at < now() - interval '2 minutes'
        AND (claimed_until IS NULL OR claimed_until < now())
      ORDER BY requested_at LIMIT 200`,
  );
  for (const v of r.rows) await jobs.schedule(v.id, v.tenant_id, 0);
  return r.rows.length;
}

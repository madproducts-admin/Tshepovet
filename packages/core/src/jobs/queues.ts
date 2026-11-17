import { type ConnectionOptions, Queue } from 'bullmq';
import type { VerificationJobs } from '../services/lifecycle';

/**
 * The job queues (docs/PLAN.md §3, M7): BullMQ on tshepovet-redis, keys under `tv:<queue>`.
 *   verification  runs and resumes verifications in a worker
 *   monitoring    the 15-minute sweep and the per-supplier re-checks it queues
 *   maintenance   the watchdog (5 min), the retention purge (hourly), the webhook backstop (1 min)
 * Webhook and email delivery are woken by NOTIFY on commit (jobs/listener.ts), not by a queue.
 */
export const JOB_PREFIX = 'tv';
export const QUEUES = { verification: 'verification', monitoring: 'monitoring', maintenance: 'maintenance' } as const;

/** BullMQ needs its own connections (blocking commands), with no per-request retry limit. */
export function jobsConnection(redisUrl: string): ConnectionOptions {
  return { url: redisUrl, maxRetriesPerRequest: null };
}

/**
 * The producer side of verification runs, used by the API and the worker. One job per
 * verification (the job id): asking again while one waits does nothing. A run that finds the
 * verification still claimed by the API fails and is retried with backoff.
 */
export class VerificationQueue implements VerificationJobs {
  readonly queue: Queue;

  constructor(connection: ConnectionOptions, prefix = JOB_PREFIX) {
    this.queue = new Queue(QUEUES.verification, { connection, prefix });
  }

  async schedule(verificationId: string, tenantId: string, delayMs: number): Promise<void> {
    await this.queue.add(
      'run',
      { verificationId, tenantId },
      {
        jobId: `verify-${verificationId}`,
        delay: Math.max(0, Math.round(delayMs)),
        attempts: 6,
        backoff: { type: 'exponential', delay: 15_000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  close(): Promise<void> {
    return this.queue.close();
  }
}

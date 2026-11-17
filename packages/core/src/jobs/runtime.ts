import { randomUUID } from 'node:crypto';
import { type ConnectionOptions, Queue, Worker } from 'bullmq';
import type { Client, Pool } from 'pg';
import type { ConsentService } from '../consent/consentService';
import type { Crypto } from '../lib/crypto';
import type { Logger } from '../lib/logger';
import type { RedisClient } from '../lib/redis';
import { SandboxDocumentExtractor } from '../ocr/sandboxExtractor';
import type { CheckResolver } from '../services/checkResolver';
import type { CompanyVerificationService } from '../services/companyVerification';
import type { DriverLicenceVerificationService } from '../services/driverLicenceVerification';
import { LocalEncryptedStore } from '../storage/localStore';
import { WebhookDispatcher } from '../webhooks/dispatcher';
import type { WebhookFetch } from '../webhooks/safeTarget';
import { ConversationWorker } from '../whatsapp/conversationWorker';
import type { GraphClient } from '../whatsapp/graphClient';
import { purgeOnce } from '../workers/retentionPurge';
import { JobsListener } from './listener';
import { type Mailer } from './mailer';
import { MonitoringScheduler } from './monitoring';
import { Pump } from './pump';
import { JOB_PREFIX, QUEUES, VerificationQueue } from './queues';
import { resumeStalledVerifications, VerificationRunner } from './verificationRunner';

/**
 * The worker process's jobs (docs/PLAN.md §3, M7), in one place so the tests can start them
 * the way the service does. The schedule, and the database queries it costs when idle (the
 * estimate the owner approved on 2026-11-17):
 *   webhooks      on commit (NOTIFY) and when a retry falls due, plus a 60 s backstop (~1 440/day)
 *   email         on commit only (none while idle)
 *   monitoring    every 15 minutes (~300/day, plus the work it finds)
 *   watchdog      every 5 minutes (~290/day)
 *   purge         hourly (~150/day)
 *   whatsapp      when a message arrives (the Redis stream; none while idle)
 */
export const SCHEDULE = {
  webhooksBackstopMs: 60_000,
  monitoringEveryMs: 15 * 60_000,
  watchdogEveryMs: 5 * 60_000,
  purgeEveryMs: 60 * 60_000,
} as const;

export interface JobsDeps {
  pool: Pool; // tshepovet_worker (BYPASSRLS)
  redis: RedisClient;
  crypto: Crypto;
  log: Logger;
  connection: ConnectionOptions; // BullMQ
  /** A dedicated connection for LISTEN. */
  listen: () => Promise<Client>;
  company: CompanyVerificationService;
  driver: DriverLicenceVerificationService;
  resolvers: { live: CheckResolver; test: CheckResolver };
  consent: ConsentService;
  verificationQueue: VerificationQueue;
  appUrl: string;
  sandbox: boolean;
  webhookFetch: WebhookFetch;
  mailer: Mailer | null;
  /** WhatsApp: the sandbox's Graph client, or none (live WhatsApp waits for the Cloud OCR gateway). */
  whatsapp: { graph: GraphClient; documentsDir: string } | null;
  /** Keys prefix (tests use their own). */
  prefix?: string;
  /** Install the repeatable schedules (off in tests that drive the jobs by hand). */
  schedules?: boolean;
}

export interface JobsRuntime {
  runner: VerificationRunner;
  monitoring: MonitoringScheduler;
  webhooks: Pump;
  email: Pump | null;
  conversations: ConversationWorker | null;
  watchdog: () => Promise<{ resumed: number; reclaimed: number }>;
  stop: () => Promise<void>;
}

export async function startJobs(d: JobsDeps): Promise<JobsRuntime> {
  const prefix = d.prefix ?? JOB_PREFIX;
  const consumer = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
  const log = d.log;

  const runner = new VerificationRunner({ pool: d.pool, crypto: d.crypto, log, company: d.company, driver: d.driver });
  const monitoringQueue = new Queue(QUEUES.monitoring, { connection: d.connection, prefix });
  const maintenanceQueue = new Queue(QUEUES.maintenance, { connection: d.connection, prefix });
  const monitoring = new MonitoringScheduler({
    pool: d.pool,
    log,
    appUrl: d.appUrl,
    company: d.company,
    environment: d.sandbox ? 'test' : 'live',
    queueRecheck: async (tenantId, tenantVendorId) => {
      // At most one re-check per supplier per day, whatever the sweeps find.
      const day = new Date().toISOString().slice(0, 10);
      await monitoringQueue.add('recheck', { tenantId, tenantVendorId }, { jobId: `recheck-${tenantVendorId}-${day}`, attempts: 3, backoff: { type: 'exponential', delay: 60_000 }, removeOnComplete: 1000, removeOnFail: 1000 });
    },
  });

  // Webhooks: deliver what is due, then sleep until the next retry falls due (or a NOTIFY).
  const dispatcher = new WebhookDispatcher(d.pool, d.crypto, log, d.webhookFetch);
  const webhooks = new Pump(
    'webhooks',
    async () => {
      while ((await dispatcher.runOnce(50)) === 50);
      return dispatcher.nextDueAt();
    },
    log,
  );
  const email = d.mailer
    ? new Pump(
        'email',
        async () => {
          await d.mailer!.flush();
          return null;
        },
        log,
      )
    : null;

  // WhatsApp: the conversation worker on the inbound stream.
  let conversations: ConversationWorker | null = null;
  const waAbort = new AbortController();
  let waRedis: RedisClient | null = null;
  let waLoop: Promise<void> | null = null;
  if (d.whatsapp) {
    conversations = new ConversationWorker({
      pool: d.pool,
      redis: d.redis,
      crypto: d.crypto,
      log,
      graph: d.whatsapp.graph,
      store: new LocalEncryptedStore(d.whatsapp.documentsDir, d.crypto),
      extractor: new SandboxDocumentExtractor(),
      resolver: d.resolvers[d.sandbox ? 'test' : 'live'],
      company: d.company,
      consent: d.consent,
      passportBaseUrl: `${d.appUrl}/passport`,
      secureLinkBaseUrl: `${d.appUrl}/wa`,
    });
    waRedis = d.redis.duplicate();
    const cw = conversations;
    const r = waRedis;
    // Our clients do not queue commands while offline: wait for this one to connect (or for stop).
    const ready = () =>
      new Promise<void>((resolve) => {
        if (r.status === 'ready' || waAbort.signal.aborted) return resolve();
        const done = () => {
          r.off('ready', done);
          waAbort.signal.removeEventListener('abort', done);
          resolve();
        };
        r.once('ready', done);
        waAbort.signal.addEventListener('abort', done, { once: true });
      });
    waLoop = (async () => {
      while (!waAbort.signal.aborted) {
        try {
          await ready();
          if (waAbort.signal.aborted) break;
          await cw.run(consumer, waAbort.signal, r);
        } catch (err) {
          if (waAbort.signal.aborted) break;
          log.error({ err }, 'whatsapp conversation loop failed; restarting');
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    })();
  }

  const watchdog = async () => {
    const resumed = await resumeStalledVerifications(d.pool, d.verificationQueue);
    const reclaimed = conversations ? await conversations.reclaimStale(consumer) : 0;
    if (resumed || reclaimed) log.warn({ resumed, reclaimed }, 'watchdog handed on stalled work');
    return { resumed, reclaimed };
  };

  const workers = [
    new Worker(QUEUES.verification, async (job) => runner.run(job.data.verificationId as string), { connection: d.connection, prefix, concurrency: 4 }),
    new Worker(
      QUEUES.monitoring,
      async (job) => {
        if (job.name === 'sweep') return monitoring.sweep();
        if (job.name === 'recheck') return monitoring.recheck(job.data.tenantId as string, job.data.tenantVendorId as string);
        return null;
      },
      { connection: d.connection, prefix, concurrency: 2 },
    ),
    new Worker(
      QUEUES.maintenance,
      async (job) => {
        if (job.name === 'watchdog') return watchdog();
        if (job.name === 'purge') return purgeOnce(d.pool, async () => undefined);
        if (job.name === 'webhooks') webhooks.kick();
        return null;
      },
      { connection: d.connection, prefix, concurrency: 1 },
    ),
  ];
  for (const w of workers) w.on('failed', (job, err) => log.warn({ err, queue: w.name, job: job?.name, attempts: job?.attemptsMade }, 'job failed'));

  if (d.schedules !== false) {
    await maintenanceQueue.upsertJobScheduler('webhooks-backstop', { every: SCHEDULE.webhooksBackstopMs }, { name: 'webhooks', opts: { removeOnComplete: true, removeOnFail: 100 } });
    await maintenanceQueue.upsertJobScheduler('watchdog', { every: SCHEDULE.watchdogEveryMs }, { name: 'watchdog', opts: { removeOnComplete: 100, removeOnFail: 100 } });
    await maintenanceQueue.upsertJobScheduler('purge', { every: SCHEDULE.purgeEveryMs }, { name: 'purge', opts: { removeOnComplete: 100, removeOnFail: 100 } });
    await monitoringQueue.upsertJobScheduler('monitoring-sweep', { every: SCHEDULE.monitoringEveryMs }, { name: 'sweep', opts: { removeOnComplete: 100, removeOnFail: 100 } });
  }

  const listener = new JobsListener(d.listen, { webhooks: () => webhooks.kick(), ...(email ? { email: () => email.kick() } : {}) }, log);
  await listener.start();

  return {
    runner,
    monitoring,
    webhooks,
    email,
    conversations,
    watchdog,
    stop: async () => {
      waAbort.abort();
      await listener.stop();
      await Promise.all(workers.map((w) => w.close()));
      await Promise.all([webhooks.stop(), email?.stop()]);
      await waLoop?.catch(() => undefined);
      waRedis?.disconnect();
      await Promise.all([monitoringQueue.close(), maintenanceQueue.close()]);
    },
  };
}

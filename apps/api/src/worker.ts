import { Client } from 'pg';
import {
  createPool,
  createRedis,
  guardedWebhookFetch,
  jobsConnection,
  loadConfig,
  logger,
  SandboxGraphClient,
  SandboxMailer,
  startJobs,
  VerificationQueue,
} from '@tshepovet/core';
import { buildContainer } from './container';

/**
 * The background process (service tshepovet-worker), as the tshepovet_jobs login (BYPASSRLS,
 * member of tshepovet_worker). Everything it runs is in packages/core/src/jobs/runtime.ts:
 * verification runs and the watchdog, webhook and email delivery woken on commit, the
 * monitoring sweep, the retention purge, and (in the sandbox) the WhatsApp conversation
 * worker with the sandbox Graph client. Stops cleanly on SIGINT (WinSW's stop sends Ctrl+C)
 * and SIGTERM.
 */
async function main() {
  const config = loadConfig();
  const dbUrl = config.WORKER_DATABASE_URL ?? config.DATABASE_URL;
  const pool = createPool(dbUrl, 10);
  const redis = createRedis(config.REDIS_URL);
  const connection = jobsConnection(config.REDIS_URL);
  const verificationQueue = new VerificationQueue(connection);
  const c = buildContainer(config, pool, redis, logger, { jobs: verificationQueue });
  const sandbox = config.SANDBOX === 'true';

  const jobs = await startJobs({
    pool,
    redis,
    crypto: c.crypto,
    log: logger,
    connection,
    listen: async () => {
      const client = new Client({ connectionString: dbUrl, application_name: 'tshepovet-worker-listen' });
      await client.connect();
      return client;
    },
    company: c.company,
    driver: c.driver,
    resolvers: c.resolvers,
    consent: c.consent,
    verificationQueue,
    appUrl: config.APP_URL,
    sandbox,
    // Deliveries go to public addresses only, and never to the addresses in WEBHOOK_DENY_IPS.
    webhookFetch: guardedWebhookFetch(config.WEBHOOK_DENY_IPS),
    mailer: sandbox ? new SandboxMailer(pool) : null,
    // Live WhatsApp waits for document reading through the Cloud gateway (fleet rule: no AI keys on the box).
    whatsapp: sandbox ? { graph: new SandboxGraphClient(pool, c.crypto), documentsDir: config.DOCUMENT_STORE_DIR } : null,
  });
  await jobs.watchdog().catch((err) => logger.error({ err }, 'start-up watchdog failed'));
  logger.info({ sandbox }, 'worker running');

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'worker stopping');
    setTimeout(() => process.exit(1), 20_000).unref();
    jobs
      .stop()
      .then(() => Promise.allSettled([verificationQueue.close(), pool.end(), redis.quit()]))
      .finally(() => {
        logger.info('worker stopped');
        process.exit(0);
      });
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});

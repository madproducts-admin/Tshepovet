import { createPool, Crypto, guardedWebhookFetch, loadConfig, LocalKeyProvider, logger, purgeOnce, WebhookDispatcher } from '@tshepovet/core';

/**
 * The background process (service tshepovet-worker), as the tshepovet_jobs login
 * (BYPASSRLS, member of tshepovet_worker):
 *   - the webhook outbox dispatcher, polling continuously;
 *   - the POPIA retention purge, at start and then hourly.
 * Durable queues (BullMQ) and the other jobs in docs/PLAN.md §3 replace these loops in M7.
 * Stops cleanly on SIGINT (WinSW's stop sends Ctrl+C) and SIGTERM.
 */
const PURGE_EVERY_MS = 60 * 60 * 1000;

async function main() {
  const config = loadConfig();
  const pool = createPool(config.WORKER_DATABASE_URL ?? config.DATABASE_URL, 10);
  const crypto = new Crypto(new LocalKeyProvider(config.KEK_KEYS), Buffer.from(config.BLIND_INDEX_ROOT_KEY, 'base64'));
  // Deliveries go to public addresses only, and never to the addresses in WEBHOOK_DENY_IPS.
  const dispatcher = new WebhookDispatcher(pool, crypto, logger, guardedWebhookFetch(config.WEBHOOK_DENY_IPS));

  let stopping = false;
  let wake: (() => void) | null = null;
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'worker stopping');
    wake?.();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  const purge = async () => {
    try {
      // Documents are not stored in object storage yet (docs/PLAN.md §6): nothing to delete.
      const r = await purgeOnce(pool, async () => undefined);
      logger.info(r, 'retention purge complete');
    } catch (err) {
      logger.error({ err }, 'retention purge failed');
    }
  };
  await purge();
  let nextPurge = Date.now() + PURGE_EVERY_MS;

  logger.info('worker running: webhook dispatcher + hourly retention purge');
  while (!stopping) {
    const n = await dispatcher.runOnce(50).catch((err) => {
      logger.error({ err }, 'dispatch cycle failed');
      return 0;
    });
    if (Date.now() >= nextPurge) {
      await purge();
      nextPurge = Date.now() + PURGE_EVERY_MS;
    }
    if (n === 0 && !stopping) await sleep(1000);
  }
  await pool.end();
  logger.info('worker stopped');
}

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});

import { loadConfig } from '../config';
import { Crypto, LocalKeyProvider } from '../lib/crypto';
import { createPool } from '../lib/db';
import { logger } from '../lib/logger';
import { WebhookDispatcher } from '../webhooks/dispatcher';

async function main() {
  const config = loadConfig();
  const pool = createPool(config.WORKER_DATABASE_URL ?? config.DATABASE_URL, 10);
  const crypto = new Crypto(new LocalKeyProvider(config.KEK_KEYS), Buffer.from(config.BLIND_INDEX_ROOT_KEY, 'base64'));
  const dispatcher = new WebhookDispatcher(pool, crypto, logger);
  let stopping = false;
  process.on('SIGTERM', () => (stopping = true));
  while (!stopping) {
    const n = await dispatcher.runOnce(50).catch((err) => {
      logger.error({ err }, 'dispatch cycle failed');
      return 0;
    });
    if (n === 0) await new Promise((r) => setTimeout(r, 1000));
  }
  await pool.end();
}

main();

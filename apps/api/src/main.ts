import { createPool, createRedis, loadConfig, logger } from '@tshepovet/core';
import { buildContainer } from './container';
import { createHttpApp } from './create-http-app';

/** The API process (service tshepovet-api): HTTP only. Background work runs in worker.ts. */
async function main() {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);
  const redis = createRedis(config.REDIS_URL);
  const container = buildContainer(config, pool, redis, logger);
  const app = await createHttpApp(container);
  await app.listen(config.PORT, config.HOST);
  logger.info({ host: config.HOST, port: config.PORT }, 'tshepovet api listening');

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    setTimeout(() => process.exit(1), 15_000).unref();
    app
      .close()
      .then(() => Promise.allSettled([pool.end(), redis.quit()]))
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});

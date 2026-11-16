import { buildContainer, createApp } from './app';
import { loadConfig } from './config';
import { createPool } from './lib/db';
import { logger } from './lib/logger';
import { createRedis } from './lib/redis';
import { whatsappRouter } from './whatsapp/webhook';

async function main() {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);
  const redis = createRedis(config.REDIS_URL);
  const container = buildContainer(config, pool, redis, logger);

  const extra = [];
  if (config.WHATSAPP_APP_SECRET && config.WHATSAPP_VERIFY_TOKEN) {
    extra.push({ path: '/webhooks/whatsapp', router: whatsappRouter({ appSecret: config.WHATSAPP_APP_SECRET, verifyToken: config.WHATSAPP_VERIFY_TOKEN, redis, log: logger }) });
  }
  const app = createApp(container, extra);
  const server = app.listen(config.PORT, config.HOST, () => logger.info({ host: config.HOST, port: config.PORT }, 'tshepovet api listening'));

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close(async () => {
      await Promise.allSettled([pool.end(), redis.quit()]);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 15_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      TEST_OWNER_DATABASE_URL: process.env.TEST_OWNER_DATABASE_URL ?? 'postgres://tshepovet_owner:devpass@localhost:5432/tshepovet_test',
      TEST_APP_DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? 'postgres://tshepovet_api:apipass@localhost:5432/tshepovet_test',
      TEST_REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15',
    },
  },
});

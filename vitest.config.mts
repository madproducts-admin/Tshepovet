import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against the workspace packages' sources, never a stale dist/.
    alias: {
      '@tshepovet/core': src('./packages/core/src/index.ts'),
      '@tshepovet/contracts': src('./packages/contracts/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/dist/**', 'tests/smoke/**'],
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

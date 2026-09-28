import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 120_000,
    env: { NODE_ENV: 'test' },
  },
});

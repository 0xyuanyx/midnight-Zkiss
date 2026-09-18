import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.e2e.test.ts'],
    testTimeout: 30 * 60 * 1000,
    hookTimeout: 30 * 60 * 1000,
    fileParallelism: false,
  },
});

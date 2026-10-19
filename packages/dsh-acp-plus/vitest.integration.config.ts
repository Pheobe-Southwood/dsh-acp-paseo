import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'dsh-acp-plus-integration',
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});

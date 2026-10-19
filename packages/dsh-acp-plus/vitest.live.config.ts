import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'dsh-acp-plus-live',
    include: ['test/live/**/*.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});

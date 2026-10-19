import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'dsh-acp-plus',
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**', 'test/live/**'],
  },
});

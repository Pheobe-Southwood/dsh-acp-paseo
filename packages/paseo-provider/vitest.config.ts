import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'paseo-provider',
    include: ['test/**/*.test.ts'],
  },
});

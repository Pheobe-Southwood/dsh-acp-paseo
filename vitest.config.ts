import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/dsh-acp-plus', 'packages/paseo-provider', 'contract'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

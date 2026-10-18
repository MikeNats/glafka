import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: ['test/real/**'],
          globalSetup: ['test/support/buildPlugin.ts'],
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: 'real',
          include: ['test/real/**/*.test.ts'],
          globalSetup: ['test/support/buildPlugin.ts'],
          // Runs the real glafka CLI on a temp git repo.
          testTimeout: 60_000,
        },
      },
    ],
  },
});

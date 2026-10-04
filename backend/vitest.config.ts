import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    fileParallelism: false, // test files share one database
    testTimeout: 15000,
    coverage: { provider: 'v8', include: ['src/**'], reporter: ['text', 'html'] },
  },
});
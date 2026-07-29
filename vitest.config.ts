import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@neon/shared': resolve(__dirname, 'packages/shared/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/src/**/__tests__/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    reporters: 'default',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/__tests__/**', '**/*.d.ts'],
    },
  },
});

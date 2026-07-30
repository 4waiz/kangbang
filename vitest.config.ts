import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@kang/shared': resolve(__dirname, 'packages/shared/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/src/**/__tests__/**/*.test.ts'],
    environment: 'node',
    server: {
      deps: {
        // `node:sqlite` is not in Vite's builtin list on every Node release, and
        // `pg` is an optional production-only dependency. Both must be left for
        // Node to resolve at runtime rather than bundled by Vite.
        external: ['node:sqlite', 'pg'],
      },
    },
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

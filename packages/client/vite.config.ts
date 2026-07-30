import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * Client build.
 *
 * `@kang/shared` is aliased to its TypeScript source so the simulation code the
 * server runs is the exact same code the client predicts with - no compiled
 * artefact in between that could drift.
 */
export default defineConfig(({ mode }) => ({
  resolve: {
    alias: {
      '@kang/shared': resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    host: true,
  },
  preview: {
    port: 4173,
  },
  build: {
    target: 'es2022',
    sourcemap: mode !== 'production',
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // Three.js is large and stable; keeping it in its own chunk means a
        // gameplay patch does not invalidate 600KB of cached vendor code.
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('packages/shared')) return 'shared';
          return undefined;
        },
      },
    },
  },
  esbuild: {
    legalComments: 'none',
  },
  define: {
    __BUILD_LABEL__: JSON.stringify(process.env.VITE_BUILD_LABEL ?? 'local'),
  },
}));

/**
 * Production server bundle.
 *
 * esbuild rather than tsc: it resolves the TypeScript source of @neon/shared
 * directly (no separate build step for the shared package) and emits a single
 * ESM file, which keeps the runtime image tiny and startup fast.
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const result = await build({
  entryPoints: [resolve(here, 'src/index.ts')],
  outfile: resolve(here, 'dist/index.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  minify: false,
  // `ws` has optional native accelerators; leave it external so npm decides.
  external: ['ws', 'pg', 'node:sqlite'],
  banner: {
    js: [
      "import { createRequire as __neonCreateRequire } from 'node:module';",
      'const require = __neonCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
console.log(`server bundle: ${(bytes / 1024).toFixed(1)} KB`);

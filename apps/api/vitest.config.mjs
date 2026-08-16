import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: {
      '@emdo/agent-core': fileURLToPath(
        new URL('../../packages/agent-core/src/index.ts', import.meta.url),
      ),
    },
  },
  // Vitest 2's bundled esbuild predates the ES2024 target. Production still
  // bundles explicitly for Node 24 in build.mjs.
  esbuild: {
    target: 'es2023',
    tsconfigRaw: {
      compilerOptions: {
        target: 'ES2023',
      },
    },
  },
  test: {
    name: 'api',
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
});

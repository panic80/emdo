import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'workspace',
      environment: 'node',
      include: ['**/*.{test,spec}.ts'],
      exclude: [
        'apps/web/**',
        'apps/worker/**',
        '**/node_modules/**',
        '**/dist/**',
      ],
    },
  },
  './apps/web/vitest.config.ts',
  './apps/worker/vitest.config.mjs',
]);

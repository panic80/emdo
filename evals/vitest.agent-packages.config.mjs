import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

export default defineConfig({
  root: repositoryRoot,
  esbuild: {
    target: 'esnext',
    tsconfigRaw: JSON.stringify({ compilerOptions: { target: 'ESNext' } }),
  },
  test: {
    include: [
      'packages/agents/scheduler/src/evals/deterministic-cases.test.ts',
      'packages/agents/shopping/src/evals/cases.test.ts',
    ],
    passWithNoTests: false,
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { target: 'es2022', jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
  },
});

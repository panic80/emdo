import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const powerSyncPackageEntry = require.resolve('@powersync/web');
const powerSyncStaticWorkerEntry = resolve(
  dirname(powerSyncPackageEntry),
  '../dist/index.react_native_web.js',
);
const disabledInProcessSqliteEntry = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'src/features/domains/disabled-in-process-sqlite.ts',
);

export default defineConfig({
  resolve: {
    alias: [
      {
        // PowerSync 2.1.1's normal entry bundles a second default worker and
        // unencrypted WASM. EMDO always supplies the pinned static encrypted
        // worker URL, so use the package's supported custom-worker build.
        find: '@powersync/web',
        replacement: powerSyncStaticWorkerEntry,
      },
      {
        // The custom-worker build retains dormant in-process factories. EMDO
        // mandates useWebWorker:true, so fail closed instead of publishing four
        // unused (including unencrypted) SQLite WASM binaries.
        find: /^@journeyapps\/wa-sqlite\/dist\/(?:mc-)?wa-sqlite(?:-async)?\.mjs$/u,
        replacement: disabledInProcessSqliteEntry,
      },
    ],
  },
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      registerType: 'prompt',
      srcDir: 'src',
      filename: 'sw.ts',
      manifest: false,
      includeAssets: [
        'icons/emdo-mark.svg',
        'icons/emdo-192.png',
        'icons/emdo-512.png',
        'icons/emdo-maskable-512.png',
        'icons/apple-touch-icon.png',
      ],
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webp,woff2,wasm}'],
        maximumFileSizeToCacheInBytes: 3_000_000,
      },
    }),
  ],
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});

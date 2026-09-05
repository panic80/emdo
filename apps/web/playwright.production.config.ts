import { defineConfig, devices } from '@playwright/test';

const evidenceReport = process.env.EMDO_PLAYWRIGHT_EVIDENCE_REPORT;
const productionPortRaw = process.env.EMDO_PLAYWRIGHT_PRODUCTION_PORT ?? '4173';
if (!/^[1-9][0-9]{3,4}$/u.test(productionPortRaw)) {
  throw new Error('Invalid Playwright production port');
}
const productionPort = Number(productionPortRaw);
if (productionPort < 1024 || productionPort > 65_535) {
  throw new Error('Invalid Playwright production port');
}
const productionOrigin = `http://127.0.0.1:${productionPort}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  // The real update evidence atomically swaps the built sw.js during its test.
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: evidenceReport
    ? [['line'], ['json', { outputFile: evidenceReport }]]
    : [['line']],
  outputDir: '../../output/playwright/production-results',
  use: {
    baseURL: productionOrigin,
    colorScheme: 'light',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `pnpm build && pnpm preview --port ${productionPort}`,
    url: `${productionOrigin}/manifest.webmanifest`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'production-chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(process.env.CI ? {} : { channel: 'chrome' as const }),
      },
    },
  ],
});

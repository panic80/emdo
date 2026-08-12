import { defineConfig, devices } from '@playwright/test';

const evidenceReport = process.env.EMDO_PLAYWRIGHT_EVIDENCE_REPORT;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: evidenceReport
    ? [['line'], ['json', { outputFile: evidenceReport }]]
    : [['line']],
  outputDir: '../../output/playwright/production-results',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    colorScheme: 'light',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm build && pnpm preview --port 4173',
    url: 'http://127.0.0.1:4173/manifest.webmanifest',
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

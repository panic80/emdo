import { existsSync } from 'node:fs';

import { defineConfig, devices, webkit } from '@playwright/test';

const localBrowser = process.env.CI ? {} : { channel: 'chrome' as const };
const webkitAvailable = existsSync(webkit.executablePath());

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [['line']],
  outputDir: '../../output/playwright/test-results',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    colorScheme: 'light',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm dev',
    url: 'http://127.0.0.1:5173/healthz-not-required',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    {
      name: 'desktop-chromium',
      testIgnore: /mobile\.spec\.ts|production\.spec\.ts/u,
      use: {
        ...devices['Desktop Chrome'],
        ...localBrowser,
      },
    },
    {
      name: 'touch-chromium',
      testMatch: /mobile\.spec\.ts/u,
      use: {
        ...devices['Pixel 7'],
        ...localBrowser,
        // Match the accepted 852x1846 concept at a deterministic 2x scale.
        viewport: { width: 426, height: 923 },
        deviceScaleFactor: 2,
      },
    },
    ...(webkitAvailable
      ? [
          {
            name: 'touch-webkit',
            testMatch: /mobile\.spec\.ts/u,
            use: { ...devices['iPhone 13'] },
          },
        ]
      : []),
  ],
});

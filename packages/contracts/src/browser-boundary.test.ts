import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import * as browserContracts from './browser.js';

const source = (name: string): Promise<string> =>
  readFile(new URL(name, import.meta.url), 'utf8');

describe('browser-safe contracts boundary', () => {
  it('exports only public experience, sync, and JSON contracts', () => {
    expect(Object.keys(browserContracts).sort()).toEqual(
      [
        'ActivityPageSchema',
        'FinancePageSchema',
        'IdentifierSchema',
        'IsoDateTimeSchema',
        'JsonValueSchema',
        'NotificationPreferencesUpdateRequestSchema',
        'NotificationPreferencesViewSchema',
        'OpaqueReferenceSchema',
        'SchedulePageSchema',
        'SettingsViewSchema',
        'ShoppingPageSchema',
        'SyncOperationSchema',
        'TodayViewSchema',
        'UuidSchema',
        'deepFreeze',
      ].sort(),
    );
  });

  it('does not transitively load the server capability contract module', async () => {
    const [browser, experience, sync] = await Promise.all([
      source('browser.ts'),
      source('experience.ts'),
      source('sync.ts'),
    ]);

    expect(browser).not.toContain('./capability.js');
    expect(experience).not.toContain('./capability.js');
    expect(sync).not.toContain('./capability.js');
  });

  it('publishes explicit browser and server package subpaths', async () => {
    const packageJson = JSON.parse(
      await source('../package.json'),
    ) as Readonly<{ exports?: Readonly<Record<string, unknown>> }>;

    expect(packageJson.exports).toMatchObject({
      './browser': './src/browser.ts',
      './server': './src/index.ts',
    });
  });
});

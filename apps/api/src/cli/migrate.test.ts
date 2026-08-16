import { describe, expect, it, vi } from 'vitest';

import { runMigrationCommand } from './migrate.js';

describe('API migration CLI', () => {
  it('requires the exact backward-compatible mode and dedicated migration DSN', async () => {
    const migrate = vi.fn(async () => undefined);
    await expect(
      runMigrationCommand({
        argv: ['--require-backward-compatible'],
        environment: {
          EMDO_ENVIRONMENT: 'staging',
          EMDO_MIGRATION_MODE: 'expand-contract',
          EMDO_MIGRATION_DATABASE_URL:
            'postgresql://migration:secret@postgres/emdo_app',
        },
        migrate,
      }),
    ).resolves.toEqual({ status: 'migrated' });
    expect(migrate).toHaveBeenCalledWith({
      databaseUrl: 'postgresql://migration:secret@postgres/emdo_app',
      migrationsFolder: expect.stringMatching(/\/drizzle\/?$/u),
    });

    for (const invalid of [
      { argv: [], environment: {} },
      {
        argv: ['--require-backward-compatible', '--unknown'],
        environment: {
          EMDO_MIGRATION_DATABASE_URL:
            'postgresql://migration:secret@postgres/emdo_app',
          EMDO_MIGRATION_MODE: 'expand-contract',
        },
      },
      {
        argv: ['--require-backward-compatible'],
        environment: {
          EMDO_MIGRATION_DATABASE_URL: 'https://not-postgres.example',
          EMDO_MIGRATION_MODE: 'expand-contract',
        },
      },
      {
        argv: ['--require-backward-compatible'],
        environment: {
          EMDO_MIGRATION_DATABASE_URL:
            'postgresql://migration:secret@postgres/emdo_app',
          EMDO_MIGRATION_MODE: 'destructive',
        },
      },
    ]) {
      await expect(
        runMigrationCommand({ ...invalid, migrate }),
      ).rejects.toThrow('Migration CLI configuration is invalid');
    }
    expect(migrate).toHaveBeenCalledOnce();
  });
});

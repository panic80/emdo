import { describe, expect, it } from 'vitest';

import { runJobSchemaCli } from './migrate-jobs.js';

describe('job schema CLI', () => {
  it('requires the exact install-only mode and dedicated migration DSN', async () => {
    const calls: unknown[] = [];
    const installer = async (input: unknown) => {
      calls.push(input);
      return { schemaVersion: 37 };
    };

    await expect(
      runJobSchemaCli({
        argv: ['--install-only'],
        environment: {
          EMDO_JOB_MIGRATION_DATABASE_URL:
            'postgresql://migration:secret@postgres/emdo_app',
        },
        installer,
      }),
    ).resolves.toEqual({ schemaVersion: 37 });
    expect(calls).toEqual([
      {
        databaseUrl: 'postgresql://migration:secret@postgres/emdo_app',
      },
    ]);

    await expect(
      runJobSchemaCli({
        argv: [],
        environment: {},
        installer,
      }),
    ).rejects.toThrow('Job schema CLI configuration is invalid');
    await expect(
      runJobSchemaCli({
        argv: ['--install-only', '--unknown'],
        environment: {
          EMDO_JOB_MIGRATION_DATABASE_URL:
            'postgresql://migration:secret@postgres/emdo_app',
        },
        installer,
      }),
    ).rejects.toThrow('Job schema CLI configuration is invalid');
    expect(calls).toHaveLength(1);
  });
});

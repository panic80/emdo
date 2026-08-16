import { describe, expect, it, vi } from 'vitest';

import { runFinanceImportRetentionCommand } from './purge-finance-imports.js';

const validEnvironment = Object.freeze({
  EMDO_ENVIRONMENT: 'production',
  EMDO_FINANCE_IMPORT_RETENTION_DATABASE_URL:
    'postgresql://emdo_finance_import_retention_login:secret@postgres:5432/emdo_app?sslmode=disable',
  EMDO_FINANCE_IMPORT_RETENTION_LIMIT: '100',
});

describe('finance import retention CLI', () => {
  it('preflights the exact login lattice, assumes only the retention role, and purges a bounded batch', async () => {
    const queries: {
      readonly text: string;
      readonly values?: readonly unknown[];
    }[] = [];
    const release = vi.fn();
    const end = vi.fn(async () => undefined);
    const client = {
      async query(text: string, values?: readonly unknown[]) {
        queries.push({ text, values });
        if (text.includes('finance_import_retention_runner_ready')) {
          return { rows: [{ ready: true }], rowCount: 1 };
        }
        if (text.includes('session_user::text')) {
          return {
            rows: [
              {
                current_user_name: 'emdo_finance_import_retention',
                session_user_name: 'emdo_finance_import_retention_login',
              },
            ],
            rowCount: 1,
          };
        }
        if (text.includes('purge_expired_finance_import_plans')) {
          return { rows: [{ purged: 7 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release,
    };
    const createPool = vi.fn(() => ({
      connect: vi.fn(async () => client),
      end,
    }));

    await expect(
      runFinanceImportRetentionCommand({
        argv: ['--purge-expired-plans'],
        environment: validEnvironment,
        createPool,
      }),
    ).resolves.toEqual({ purged: 7, status: 'purged' });

    expect(createPool).toHaveBeenCalledWith({
      allowExitOnIdle: true,
      application_name: 'emdo-finance-import-retention',
      connectionString:
        validEnvironment.EMDO_FINANCE_IMPORT_RETENTION_DATABASE_URL,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 10_000,
      max: 1,
    });
    expect(queries).toEqual([
      { text: 'begin', values: undefined },
      {
        text: "set local statement_timeout = '30s'",
        values: undefined,
      },
      { text: "set local lock_timeout = '5s'", values: undefined },
      {
        text: 'select emdo.finance_import_retention_runner_ready() as ready',
        values: undefined,
      },
      {
        text: 'set local role emdo_finance_import_retention',
        values: undefined,
      },
      {
        text: expect.stringContaining('session_user::text'),
        values: undefined,
      },
      {
        text: 'select emdo.purge_expired_finance_import_plans($1::integer) as purged',
        values: [100],
      },
      { text: 'commit', values: undefined },
    ]);
    expect(release).toHaveBeenCalledWith();
    expect(end).toHaveBeenCalledOnce();
  });

  it('destroys the session and fails with a bounded error when readiness or results are invalid', async () => {
    for (const rows of [[{ ready: false }], [{ ready: true }]]) {
      const release = vi.fn();
      let calls = 0;
      const client = {
        async query(text: string) {
          calls += 1;
          if (text.includes('finance_import_retention_runner_ready')) {
            return { rows, rowCount: 1 };
          }
          if (text.includes('session_user::text')) {
            return {
              rows:
                rows[0]?.ready === true
                  ? [
                      {
                        current_user_name: 'emdo_finance_import_retention',
                        session_user_name:
                          'emdo_finance_import_retention_login',
                      },
                    ]
                  : [],
              rowCount: rows[0]?.ready === true ? 1 : 0,
            };
          }
          if (text.includes('purge_expired_finance_import_plans')) {
            return { rows: [{ purged: 'not-an-integer' }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
        release,
      };
      const end = vi.fn(async () => undefined);

      await expect(
        runFinanceImportRetentionCommand({
          argv: ['--purge-expired-plans'],
          environment: validEnvironment,
          createPool: () => ({
            connect: async () => client,
            end,
          }),
        }),
      ).rejects.toThrow('Finance import retention failed');
      expect(calls).toBeGreaterThan(3);
      expect(release).toHaveBeenCalledWith(true);
      expect(end).toHaveBeenCalledOnce();
    }
  });

  it('rejects every non-production, shared, external, or unbounded configuration before connecting', async () => {
    const createPool = vi.fn();
    const invalidInputs = [
      { argv: [], environment: validEnvironment },
      {
        argv: ['--purge-expired-plans'],
        environment: { ...validEnvironment, EMDO_ENVIRONMENT: 'staging' },
      },
      {
        argv: ['--purge-expired-plans'],
        environment: {
          ...validEnvironment,
          EMDO_FINANCE_IMPORT_RETENTION_DATABASE_URL:
            'postgresql://emdo_api_login:secret@postgres:5432/emdo_app?sslmode=disable',
        },
      },
      {
        argv: ['--purge-expired-plans'],
        environment: {
          ...validEnvironment,
          EMDO_FINANCE_IMPORT_RETENTION_DATABASE_URL:
            'postgresql://emdo_finance_import_retention_login:secret@database.example:5432/emdo_app?sslmode=disable',
        },
      },
      {
        argv: ['--purge-expired-plans'],
        environment: {
          ...validEnvironment,
          EMDO_FINANCE_IMPORT_RETENTION_DATABASE_URL:
            'postgresql://emdo_finance_import_retention_login:secret@postgres:5432/emdo_powersync?sslmode=disable',
        },
      },
      {
        argv: ['--purge-expired-plans'],
        environment: {
          ...validEnvironment,
          EMDO_FINANCE_IMPORT_RETENTION_DATABASE_URL:
            'postgresql://emdo_finance_import_retention_login:secret@postgres:5432/emdo_app?sslmode=require',
        },
      },
      {
        argv: ['--purge-expired-plans'],
        environment: {
          ...validEnvironment,
          EMDO_FINANCE_IMPORT_RETENTION_DATABASE_URL:
            'postgresql://emdo_finance_import_retention_login:secret@postgres:5432/emdo_app?sslmode=disable&application_name=forged',
        },
      },
      {
        argv: ['--purge-expired-plans'],
        environment: {
          ...validEnvironment,
          EMDO_FINANCE_IMPORT_RETENTION_LIMIT: '0',
        },
      },
      {
        argv: ['--purge-expired-plans'],
        environment: {
          ...validEnvironment,
          EMDO_FINANCE_IMPORT_RETENTION_LIMIT: '1001',
        },
      },
      {
        argv: ['--purge-expired-plans'],
        environment: {
          ...validEnvironment,
          EMDO_FINANCE_IMPORT_RETENTION_LIMIT: '10.5',
        },
      },
    ] as const;

    for (const invalid of invalidInputs) {
      await expect(
        runFinanceImportRetentionCommand({ ...invalid, createPool }),
      ).rejects.toThrow('Finance import retention configuration is invalid');
    }
    expect(createPool).not.toHaveBeenCalled();
  });
});

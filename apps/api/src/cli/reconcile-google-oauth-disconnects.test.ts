import { describe, expect, it, vi } from 'vitest';

import { runGoogleOAuthDisconnectReconciliationCommand } from './reconcile-google-oauth-disconnects.js';

const validEnvironment = Object.freeze({
  EMDO_ENVIRONMENT: 'production',
  EMDO_GOOGLE_OAUTH_DISCONNECT_RECONCILIATION_DATABASE_URL:
    'postgresql://emdo_google_oauth_disconnect_reconciliation_login:secret@postgres:5432/emdo_app?sslmode=disable',
  EMDO_GOOGLE_OAUTH_DISCONNECT_RECONCILIATION_LIMIT: '25',
});

describe('Google OAuth disconnect reconciliation CLI', () => {
  it('preflights the exact login, assumes only the reconciliation role, and settles a bounded batch', async () => {
    const queries: {
      readonly text: string;
      readonly values?: readonly unknown[];
    }[] = [];
    const release = vi.fn();
    const end = vi.fn(async () => undefined);
    const client = {
      async query(text: string, values?: readonly unknown[]) {
        queries.push({ text, values });
        if (
          text.includes('google_oauth_disconnect_reconciliation_runner_ready')
        ) {
          return { rows: [{ ready: true }], rowCount: 1 };
        }
        if (text.includes('session_user::text')) {
          return {
            rows: [
              {
                current_user_name:
                  'emdo_google_oauth_disconnect_reconciliation',
                session_user_name:
                  'emdo_google_oauth_disconnect_reconciliation_login',
              },
            ],
            rowCount: 1,
          };
        }
        if (text.includes('reconcile_stranded_google_oauth_disconnects')) {
          return { rows: [{ reconciled: 3 }], rowCount: 1 };
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
      runGoogleOAuthDisconnectReconciliationCommand({
        argv: ['--reconcile-stranded-disconnects'],
        environment: validEnvironment,
        createPool,
      }),
    ).resolves.toEqual({ reconciled: 3, status: 'reconciled' });

    expect(createPool).toHaveBeenCalledWith({
      allowExitOnIdle: true,
      application_name: 'emdo-google-oauth-disconnect-reconciliation',
      connectionString:
        validEnvironment.EMDO_GOOGLE_OAUTH_DISCONNECT_RECONCILIATION_DATABASE_URL,
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
        text: 'select emdo.google_oauth_disconnect_reconciliation_runner_ready() as ready',
        values: undefined,
      },
      {
        text: 'set local role emdo_google_oauth_disconnect_reconciliation',
        values: undefined,
      },
      {
        text: expect.stringContaining('session_user::text'),
        values: undefined,
      },
      {
        text: 'select emdo.reconcile_stranded_google_oauth_disconnects($1::integer) as reconciled',
        values: [25],
      },
      { text: 'commit', values: undefined },
    ]);
    expect(release).toHaveBeenCalledWith();
    expect(end).toHaveBeenCalledOnce();
  });

  it('destroys the session and reports one bounded error when readiness or results are invalid', async () => {
    for (const scenario of ['not-ready', 'invalid-result'] as const) {
      const release = vi.fn();
      const end = vi.fn(async () => undefined);
      const client = {
        async query(text: string) {
          if (
            text.includes('google_oauth_disconnect_reconciliation_runner_ready')
          ) {
            return {
              rows: [{ ready: scenario === 'invalid-result' }],
              rowCount: 1,
            };
          }
          if (text.includes('session_user::text')) {
            return {
              rows: [
                {
                  current_user_name:
                    'emdo_google_oauth_disconnect_reconciliation',
                  session_user_name:
                    'emdo_google_oauth_disconnect_reconciliation_login',
                },
              ],
              rowCount: 1,
            };
          }
          if (text.includes('reconcile_stranded_google_oauth_disconnects')) {
            return { rows: [{ reconciled: 'invalid' }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
        release,
      };

      await expect(
        runGoogleOAuthDisconnectReconciliationCommand({
          argv: ['--reconcile-stranded-disconnects'],
          environment: validEnvironment,
          createPool: () => ({ connect: async () => client, end }),
        }),
      ).rejects.toThrow('Google OAuth disconnect reconciliation failed');
      expect(release).toHaveBeenCalledWith(true);
      expect(end).toHaveBeenCalledOnce();
    }
  });

  it('rejects non-production, shared, external, and unbounded inputs before connecting', async () => {
    const createPool = vi.fn();
    const invalidInputs = [
      { argv: [], environment: validEnvironment },
      {
        argv: ['--reconcile-stranded-disconnects'],
        environment: { ...validEnvironment, EMDO_ENVIRONMENT: 'staging' },
      },
      {
        argv: ['--reconcile-stranded-disconnects'],
        environment: {
          ...validEnvironment,
          EMDO_GOOGLE_OAUTH_DISCONNECT_RECONCILIATION_DATABASE_URL:
            'postgresql://emdo_api_login:secret@postgres:5432/emdo_app?sslmode=disable',
        },
      },
      {
        argv: ['--reconcile-stranded-disconnects'],
        environment: {
          ...validEnvironment,
          EMDO_GOOGLE_OAUTH_DISCONNECT_RECONCILIATION_DATABASE_URL:
            'postgresql://emdo_google_oauth_disconnect_reconciliation_login:secret@provider.example:5432/emdo_app?sslmode=disable',
        },
      },
      {
        argv: ['--reconcile-stranded-disconnects'],
        environment: {
          ...validEnvironment,
          EMDO_GOOGLE_OAUTH_DISCONNECT_RECONCILIATION_DATABASE_URL:
            'postgresql://emdo_google_oauth_disconnect_reconciliation_login:secret@postgres:5432/emdo_powersync?sslmode=disable',
        },
      },
      {
        argv: ['--reconcile-stranded-disconnects'],
        environment: {
          ...validEnvironment,
          EMDO_GOOGLE_OAUTH_DISCONNECT_RECONCILIATION_LIMIT: '0',
        },
      },
      {
        argv: ['--reconcile-stranded-disconnects'],
        environment: {
          ...validEnvironment,
          EMDO_GOOGLE_OAUTH_DISCONNECT_RECONCILIATION_LIMIT: '101',
        },
      },
      {
        argv: ['--reconcile-stranded-disconnects'],
        environment: {
          ...validEnvironment,
          EMDO_GOOGLE_OAUTH_DISCONNECT_RECONCILIATION_LIMIT: '1.5',
        },
      },
    ] as const;

    for (const invalid of invalidInputs) {
      await expect(
        runGoogleOAuthDisconnectReconciliationCommand({
          ...invalid,
          createPool,
        }),
      ).rejects.toThrow(
        'Google OAuth disconnect reconciliation configuration is invalid',
      );
    }
    expect(createPool).not.toHaveBeenCalled();
  });
});

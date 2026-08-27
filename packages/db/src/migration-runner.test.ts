import { beforeEach, describe, expect, it, vi } from 'vitest';

const migrate = vi.hoisted(() => vi.fn(async () => undefined));
const drizzle = vi.hoisted(() => vi.fn((client: unknown) => ({ client })));

vi.mock('drizzle-orm/node-postgres/migrator', () => ({ migrate }));
vi.mock('drizzle-orm/node-postgres', () => ({ drizzle }));

import {
  applyDatabaseMigrations,
  applyLockedDatabaseMigrations,
  loadOrderedMigrations,
} from './migrations.js';

describe('database migration runner', () => {
  beforeEach(() => {
    migrate.mockClear();
    drizzle.mockClear();
  });
  it('loads every journal entry in strict order, including deployment bootstrap', async () => {
    const migrations = await loadOrderedMigrations();
    const ids = migrations.map(({ id }) => id);

    expect(ids).toEqual([
      '0000_household_foundation',
      '0001_identity_onboarding',
      '0002_owner_bootstrap',
      '0003_durable_runtime_repositories',
      '0004_audio_request_receipts',
      '0005_household_administration',
      '0006_sync_conflict_outcomes',
      '0007_experience_notification_preferences',
      '0008_finance_import_receipts',
      '0009_google_oauth_authorization_starts',
      '0010_google_oauth_disconnect_operations',
      '0011_finance_import_retention_runner',
      '0012_google_oauth_disconnect_reconciliation_runner',
      '0013_google_oauth_disconnect_retention_runner',
      '0014_audio_spend_readiness',
      '0015_single_household_session_activation',
      '0016_finance_document_knowledge',
    ]);
    expect(migrations.map(({ index }) => index)).toEqual(
      migrations.map((_, index) => index),
    );
    expect(migrations[0]?.sql).toContain('CREATE SCHEMA "emdo"');
    expect(migrations[1]?.sql).toContain(
      'CREATE OR REPLACE FUNCTION "emdo"."provision_invited_account"',
    );
    expect(migrations[2]?.sql).toContain(
      'CREATE OR REPLACE FUNCTION "emdo"."bootstrap_initial_owner"',
    );
    expect(migrations[4]?.sql).toContain(
      'CREATE TABLE "emdo"."audio_request_receipts"',
    );
    expect(migrations[5]?.sql).toContain(
      'CREATE OR REPLACE FUNCTION emdo.issue_household_invitation',
    );
    expect(migrations[6]?.sql).toContain(
      'CREATE TABLE "emdo"."sync_entity_revisions"',
    );
    expect(migrations[7]?.sql).toContain(
      'CREATE TABLE "emdo"."notification_preferences"',
    );
    expect(migrations[8]?.sql).toContain(
      'CREATE TABLE emdo.finance_import_receipts',
    );
    expect(migrations[9]?.sql).toContain(
      'CREATE TABLE "emdo"."google_oauth_authorization_starts"',
    );
    expect(migrations[10]?.sql).toContain(
      'CREATE TABLE "emdo"."google_oauth_disconnect_operations"',
    );
    expect(migrations[11]?.sql).toContain(
      'CREATE OR REPLACE FUNCTION emdo.finance_import_retention_runner_ready',
    );
    expect(migrations[12]?.sql).toContain(
      'CREATE OR REPLACE FUNCTION emdo.google_oauth_disconnect_reconciliation_runner_ready',
    );
    expect(migrations[13]?.sql).toContain(
      'CREATE OR REPLACE FUNCTION emdo.google_oauth_disconnect_retention_runner_ready',
    );
    expect(migrations[14]?.sql).toContain(
      'CREATE OR REPLACE FUNCTION emdo.audio_spend_ready',
    );
    expect(migrations[15]?.sql).toContain(
      'CREATE OR REPLACE FUNCTION emdo.resolve_exactly_one_active_household_for_auth_session',
    );
    expect(migrations[16]?.sql).toContain(
      'CREATE TABLE "emdo"."finance_documents"',
    );
  });

  it('holds one session-level advisory lock around the tracked migrator and always unlocks', async () => {
    const queries: {
      readonly text: string;
      readonly values?: readonly unknown[];
    }[] = [];
    let releases = 0;
    const client = {
      async query(text: string, values?: readonly unknown[]) {
        queries.push({ text, values });
        return { rows: [], rowCount: 0 };
      },
      release() {
        releases += 1;
      },
    };

    await applyLockedDatabaseMigrations({
      async connect() {
        return client;
      },
    });

    expect(queries.map(({ text }) => text)).toEqual([
      'begin',
      expect.stringContaining('statement_timeout'),
      expect.stringContaining('pg_advisory_lock'),
      'commit',
      expect.stringContaining('pg_advisory_unlock'),
    ]);
    expect(queries[2]?.values).toEqual(['emdo.database.migrations.v1']);
    expect(drizzle).toHaveBeenCalledWith(client);
    expect(migrate).toHaveBeenCalledWith(
      { client },
      expect.objectContaining({
        migrationsFolder: expect.stringMatching(/packages\/db\/drizzle\/?$/),
      }),
    );
    expect(releases).toBe(1);
  });

  it('unlocks and releases the dedicated migration session when migration fails', async () => {
    const queries: string[] = [];
    let releases = 0;
    const client = {
      async query(text: string) {
        queries.push(text);
        return { rows: [], rowCount: 0 };
      },
      release() {
        releases += 1;
      },
    };
    migrate.mockRejectedValueOnce(new Error('private database failure'));

    await expect(
      applyLockedDatabaseMigrations({
        async connect() {
          return client;
        },
      }),
    ).rejects.toThrow('Database migration failed');

    expect(queries.at(-1)).toContain('pg_advisory_unlock');
    expect(releases).toBe(1);
  });

  it('delegates deployment execution to the journal-aware Drizzle migrator', async () => {
    const database = { marker: 'database' };

    await applyDatabaseMigrations(database as never);

    expect(migrate).toHaveBeenCalledOnce();
    expect(migrate).toHaveBeenCalledWith(
      database,
      expect.objectContaining({
        migrationsFolder: expect.stringMatching(/packages\/db\/drizzle\/?$/),
      }),
    );
  });

  it('uses an explicit absolute migrations folder copied beside a runtime bundle', async () => {
    const database = { marker: 'bundled-database' };
    const migrationsFolder = '/opt/emdo/api/dist/migrations';

    await applyDatabaseMigrations(database as never, { migrationsFolder });

    expect(migrate).toHaveBeenCalledWith(database, { migrationsFolder });
  });

  it('rejects relative or nul-containing migration folder overrides', async () => {
    await expect(
      applyDatabaseMigrations({} as never, {
        migrationsFolder: '../migrations',
      }),
    ).rejects.toThrow('absolute path');
    await expect(
      applyDatabaseMigrations({} as never, {
        migrationsFolder: '/tmp/migrations\0hidden',
      }),
    ).rejects.toThrow('absolute path');
  });
});

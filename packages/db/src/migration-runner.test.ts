import { describe, expect, it, vi } from 'vitest';

const migrate = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('drizzle-orm/node-postgres/migrator', () => ({ migrate }));

import {
  applyDatabaseMigrations,
  loadOrderedMigrations,
} from './migrations.js';

describe('database migration runner', () => {
  it('loads every journal entry in strict order, including deployment bootstrap', async () => {
    const migrations = await loadOrderedMigrations();

    expect(migrations.map(({ id }) => id)).toEqual([
      '0000_household_foundation',
      '0001_identity_onboarding',
      '0002_owner_bootstrap',
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
});

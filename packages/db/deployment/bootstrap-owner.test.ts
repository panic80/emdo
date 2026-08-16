import { describe, expect, it, vi } from 'vitest';

import {
  OWNER_BOOTSTRAP_CONFIRMATION,
  runOwnerBootstrapCommand,
  type BootstrapOwnerDependencies,
  type BootstrapOwnerEnvironment,
  type BootstrapOwnerLogger,
  type BootstrapOwnerPool,
} from './bootstrap-owner-command.js';

const password = 'correct horse battery staple';
const passwordHash = `${'a'.repeat(32)}:${'b'.repeat(128)}`;

const environment = (): BootstrapOwnerEnvironment => ({
  EMDO_BOOTSTRAP_CONFIRM: OWNER_BOOTSTRAP_CONFIRMATION,
  EMDO_BOOTSTRAP_DATABASE_URL:
    'postgresql://bootstrap:secret@localhost:5432/emdo',
  EMDO_BOOTSTRAP_HOUSEHOLD_NAME: 'Example Household',
  EMDO_BOOTSTRAP_HOUSEHOLD_SLUG: 'example-household',
  EMDO_BOOTSTRAP_OWNER_EMAIL: ' OWNER@EXAMPLE.COM ',
  EMDO_BOOTSTRAP_OWNER_NAME: 'Initial Owner',
  EMDO_BOOTSTRAP_OWNER_PASSWORD: password,
});

const fakeDatabase = (input?: {
  readonly functionError?: unknown;
  readonly role?: {
    readonly is_member: boolean;
    readonly rolbypassrls: boolean;
    readonly rolsuper: boolean;
  };
}) => {
  const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
    void values;
    if (text.includes('pg_catalog.pg_has_role')) {
      return {
        rowCount: 1,
        rows: [
          input?.role ?? {
            is_member: true,
            rolbypassrls: false,
            rolsuper: false,
          },
        ],
      };
    }
    if (text.includes('emdo.bootstrap_initial_owner')) {
      if (input?.functionError !== undefined) throw input.functionError;
      return {
        rowCount: 1,
        rows: [
          {
            user_id: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f001',
            household_id: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f002',
            membership_id: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f003',
            private_space_id: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f004',
            completed_at: new Date('2026-08-09T20:00:00.000Z'),
          },
        ],
      };
    }
    return { rowCount: null, rows: [] };
  });
  const release = vi.fn();
  const end = vi.fn(async () => undefined);
  const pool: BootstrapOwnerPool = {
    connect: vi.fn(async () => ({ query, release })),
    end,
  };
  return { end, pool, query, release };
};

const harness = (database = fakeDatabase()) => {
  const messages: string[] = [];
  const logger: BootstrapOwnerLogger = {
    error: (message) => messages.push(message),
    info: (message) => messages.push(message),
  };
  const hashPassword = vi.fn(async () => passwordHash);
  const createPool = vi.fn(() => database.pool);
  const dependencies: BootstrapOwnerDependencies = {
    createPool,
    hashPassword,
  };
  return { createPool, database, dependencies, hashPassword, logger, messages };
};

describe('deployment-only initial owner bootstrap command', () => {
  it('hashes the trusted-env password and calls only the narrow SQL function', async () => {
    const test = harness();
    const env = environment();

    await expect(
      runOwnerBootstrapCommand({
        dependencies: test.dependencies,
        environment: env,
        logger: test.logger,
      }),
    ).resolves.toBe(0);

    expect(env.EMDO_BOOTSTRAP_OWNER_PASSWORD).toBeUndefined();
    expect(test.hashPassword).toHaveBeenCalledWith(password);
    expect(test.createPool).toHaveBeenCalledWith({
      application_name: 'emdo-owner-bootstrap',
      connectionString: environment().EMDO_BOOTSTRAP_DATABASE_URL,
      connectionTimeoutMillis: 10_000,
      max: 1,
    });
    expect(test.database.query.mock.calls.map(([text]) => text)).toEqual([
      expect.stringContaining('pg_catalog.pg_has_role'),
      'begin',
      'set local role emdo_owner_bootstrap',
      expect.stringContaining('emdo.bootstrap_initial_owner'),
      'commit',
    ]);

    const functionCall = test.database.query.mock.calls.find(([text]) =>
      text.includes('emdo.bootstrap_initial_owner'),
    );
    expect(functionCall?.[1]).toEqual([
      'owner@example.com',
      'Initial Owner',
      passwordHash,
      'Example Household',
      'example-household',
    ]);
    for (const [text, values] of test.database.query.mock.calls) {
      expect(text).not.toContain(password);
      expect(values ?? []).not.toContain(password);
    }
    expect(test.database.release).toHaveBeenCalledOnce();
    expect(test.database.end).toHaveBeenCalledOnce();
    expect(test.messages).toEqual(['EMDO initial owner bootstrap completed.']);
  });

  it('fails before hashing or connecting unless exact confirmation is present', async () => {
    const test = harness();
    const env = environment();
    env.EMDO_BOOTSTRAP_CONFIRM = 'yes';

    await expect(
      runOwnerBootstrapCommand({
        dependencies: test.dependencies,
        environment: env,
        logger: test.logger,
      }),
    ).resolves.toBe(64);

    expect(env.EMDO_BOOTSTRAP_OWNER_PASSWORD).toBeUndefined();
    expect(test.hashPassword).not.toHaveBeenCalled();
    expect(test.createPool).not.toHaveBeenCalled();
    expect(test.messages).toEqual([
      'Owner bootstrap configuration is invalid.',
    ]);
  });

  it('rejects privileged or non-member database credentials', async () => {
    for (const role of [
      { is_member: true, rolbypassrls: false, rolsuper: true },
      { is_member: true, rolbypassrls: true, rolsuper: false },
      { is_member: false, rolbypassrls: false, rolsuper: false },
    ]) {
      const test = harness(fakeDatabase({ role }));

      await expect(
        runOwnerBootstrapCommand({
          dependencies: test.dependencies,
          environment: environment(),
          logger: test.logger,
        }),
      ).resolves.toBe(64);

      expect(test.database.query).not.toHaveBeenCalledWith('begin');
      expect(test.messages).toEqual([
        'A dedicated owner-bootstrap database credential is required.',
      ]);
    }
  });

  it('rolls back and reports an already-complete replay without raw error data', async () => {
    const rawMessage = `already complete for ${password}`;
    const test = harness(
      fakeDatabase({
        functionError: Object.assign(new Error(rawMessage), { code: '55000' }),
      }),
    );

    await expect(
      runOwnerBootstrapCommand({
        dependencies: test.dependencies,
        environment: environment(),
        logger: test.logger,
      }),
    ).resolves.toBe(2);

    expect(test.database.query).toHaveBeenCalledWith('rollback');
    expect(test.database.query).not.toHaveBeenCalledWith('commit');
    expect(test.messages).toEqual([
      'EMDO initial owner bootstrap is already complete.',
    ]);
    expect(test.messages.join(' ')).not.toContain(rawMessage);
    expect(test.messages.join(' ')).not.toContain(password);
  });

  it('rolls back and emits a generic failure for unexpected database errors', async () => {
    const secret = environment().EMDO_BOOTSTRAP_DATABASE_URL ?? '';
    const test = harness(
      fakeDatabase({
        functionError: new Error(`connection failed: ${secret}`),
      }),
    );

    await expect(
      runOwnerBootstrapCommand({
        dependencies: test.dependencies,
        environment: environment(),
        logger: test.logger,
      }),
    ).resolves.toBe(1);

    expect(test.database.query).toHaveBeenCalledWith('rollback');
    expect(test.messages).toEqual(['EMDO initial owner bootstrap failed.']);
    expect(test.messages.join(' ')).not.toContain(secret);
  });

  it('refuses a non-empty identity database with a distinct sanitized result', async () => {
    const test = harness(
      fakeDatabase({
        functionError: Object.assign(new Error(`existing user: ${password}`), {
          code: 'P0001',
        }),
      }),
    );

    await expect(
      runOwnerBootstrapCommand({
        dependencies: test.dependencies,
        environment: environment(),
        logger: test.logger,
      }),
    ).resolves.toBe(4);

    expect(test.database.query).toHaveBeenCalledWith('rollback');
    expect(test.messages).toEqual([
      'EMDO initial owner bootstrap requires an empty identity database.',
    ]);
    expect(test.messages.join(' ')).not.toContain(password);
  });
});

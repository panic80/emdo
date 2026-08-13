import type {
  DBAdapter,
  BetterAuthOptions,
  DBAdapterInstance,
  DBTransactionAdapter,
} from 'better-auth';
import { describe, expect, it, vi } from 'vitest';

import { createPostgresBetterAuthOrganizationClaimBridge } from './better-auth-claim-transaction.js';

const userId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f001';
const sessionId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f002';
const requestId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f003';

const validRole = {
  auth_parent_admin_option: false,
  auth_parent_inherit_option: true,
  auth_parent_set_option: true,
  direct_parent_count: 1,
  has_direct_emdo_acl: false,
  login_role: 'emdo_auth_login',
  only_auth_parent: true,
  owns_emdo_objects: false,
  rolbypassrls: false,
  rolcanlogin: true,
  rolcreatedb: false,
  rolcreaterole: false,
  rolinherit: true,
  rolreplication: false,
  rolsuper: false,
  unassumed: true,
};

interface FakeClientOptions {
  readonly commitError?: Error;
  readonly events: string[];
  readonly label: string;
  readonly role?: typeof validRole;
  readonly sessionRows?: readonly Record<string, unknown>[];
  readonly rollbackError?: Error;
}

const fakeClient = (options: FakeClientOptions) => {
  const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
    if (text.includes('from pg_catalog.pg_roles')) {
      options.events.push(`${options.label}:verify-role`);
      return { rowCount: 1, rows: [options.role ?? validRole] };
    }
    if (text === 'begin') options.events.push(`${options.label}:begin`);
    else if (text === 'set local role emdo_auth')
      options.events.push(`${options.label}:set-role`);
    else if (text === 'set local row_security = on')
      options.events.push(`${options.label}:set-row-security`);
    else if (text.includes('from emdo.auth_sessions')) {
      options.events.push(`${options.label}:revalidate`);
      return {
        rowCount: options.sessionRows?.length ?? 1,
        rows: options.sessionRows ?? [
          { session_id: sessionId, user_id: userId },
        ],
      };
    } else if (text.includes("set_config('emdo.user_id'")) {
      options.events.push(`${options.label}:set-claims`);
      expect(values).toEqual([userId, sessionId, requestId]);
    } else if (text === 'commit') {
      options.events.push(`${options.label}:commit`);
      if (options.commitError !== undefined) throw options.commitError;
    } else if (text === 'rollback') {
      options.events.push(`${options.label}:rollback`);
      if (options.rollbackError !== undefined) throw options.rollbackError;
    }
    return { rowCount: null, rows: [] };
  });
  const release = vi.fn((error?: Error | boolean) => {
    options.events.push(
      `${options.label}:release${error === undefined ? '' : ':destroy'}`,
    );
  });
  return { query, release };
};

const harness = (input?: {
  readonly adapterFindMany?: () => Promise<readonly unknown[]>;
  readonly runClient?: ReturnType<typeof fakeClient>;
}) => {
  const events: string[] = [];
  const preflightClient = fakeClient({ events, label: 'preflight' });
  const runClient =
    input?.runClient ?? fakeClient({ events, label: 'transaction' });
  const clients = [preflightClient, runClient];
  const pool = {
    connect: vi.fn(async () => {
      const client = clients.shift();
      if (client === undefined) throw new Error('unexpected pool checkout');
      events.push(
        client === preflightClient
          ? 'preflight:connect'
          : 'transaction:connect',
      );
      return client;
    }),
  };
  const databaseAdapter = Object.freeze({
    id: 'database-adapter',
  }) as unknown as DBAdapter;
  const database = vi.fn(() => databaseAdapter) as unknown as DBAdapterInstance;
  const adapterFindMany = vi.fn(input?.adapterFindMany ?? (async () => []));
  const adapter = Object.freeze({
    findMany: adapterFindMany,
    id: 'transaction-adapter',
  }) as unknown as DBTransactionAdapter;
  const createDatabaseAdapter = vi.fn(() => database);
  const createTransactionAdapter = vi.fn(
    (client: unknown, options: BetterAuthOptions): DBTransactionAdapter => {
      void options;
      expect(client).toBe(runClient);
      events.push('transaction:create-adapter');
      return adapter;
    },
  );
  const createRequestId = vi.fn(() => requestId);

  return {
    adapter,
    adapterFindMany,
    createDatabaseAdapter,
    createRequestId,
    createTransactionAdapter,
    database,
    databaseAdapter,
    events,
    pool,
    preflightClient,
    runClient,
  };
};

describe('PostgreSQL Better Auth organization claim bridge', () => {
  it('re-probes the dedicated auth login without opening a claim transaction', async () => {
    const test = harness();
    const bridge = await createPostgresBetterAuthOrganizationClaimBridge(
      test.pool as never,
      {
        createDatabaseAdapter: test.createDatabaseAdapter,
        createRequestId: test.createRequestId,
        createTransactionAdapter: test.createTransactionAdapter,
      },
    );

    await expect(bridge.checkReady()).resolves.toBe(true);
    expect(test.events).toEqual([
      'preflight:connect',
      'preflight:verify-role',
      'preflight:release',
      'transaction:connect',
      'transaction:verify-role',
      'transaction:release',
    ]);
    expect(test.runClient.query).not.toHaveBeenCalledWith('begin');
  });

  it('reports auth readiness false if the checked-out login drifts', async () => {
    const events: string[] = [];
    const runClient = fakeClient({
      events,
      label: 'transaction',
      role: { ...validRole, rolsuper: true },
    });
    const test = harness({ runClient });
    const bridge = await createPostgresBetterAuthOrganizationClaimBridge(
      test.pool as never,
      {
        createDatabaseAdapter: test.createDatabaseAdapter,
        createRequestId: test.createRequestId,
        createTransactionAdapter: test.createTransactionAdapter,
      },
    );

    await expect(bridge.checkReady()).resolves.toBe(false);
    expect(runClient.release).toHaveBeenCalledOnce();
  });

  it('destroys a readiness connection whose otherwise-safe login identity changed', async () => {
    const events: string[] = [];
    const runClient = fakeClient({
      events,
      label: 'transaction',
      role: { ...validRole, login_role: 'emdo_auth_rotated_login' },
    });
    const test = harness({ runClient });
    const bridge = await createPostgresBetterAuthOrganizationClaimBridge(
      test.pool as never,
      {
        createDatabaseAdapter: test.createDatabaseAdapter,
        createRequestId: test.createRequestId,
        createTransactionAdapter: test.createTransactionAdapter,
      },
    );

    await expect(bridge.checkReady()).resolves.toBe(false);
    expect(runClient.release).toHaveBeenCalledWith(true);
  });

  it('pins role, adapter, revalidation, claims, and work to one transaction', async () => {
    const test = harness();
    const bridge = await createPostgresBetterAuthOrganizationClaimBridge(
      test.pool as never,
      {
        createDatabaseAdapter: test.createDatabaseAdapter,
        createRequestId: test.createRequestId,
        createTransactionAdapter: test.createTransactionAdapter,
      },
    );

    const result = await bridge.run({} as BetterAuthOptions, async (tx) => {
      test.events.push('transaction:work-start');
      expect(tx.adapter).not.toBe(test.adapter);
      expect(Object.isFrozen(tx)).toBe(true);
      await tx.revalidateAndActivateClaims({ sessionId, userId });
      await tx.adapter.findMany({ model: 'organization' });
      test.events.push('transaction:work-end');
      return 'visible household';
    });

    expect(result).toBe('visible household');
    expect(bridge.database).not.toBe(test.database);
    expect(bridge.database({} as BetterAuthOptions)).toBe(test.databaseAdapter);
    expect(test.adapterFindMany).toHaveBeenCalledOnce();
    expect(Object.isFrozen(bridge)).toBe(true);
    expect(test.events).toEqual([
      'preflight:connect',
      'preflight:verify-role',
      'preflight:release',
      'transaction:connect',
      'transaction:begin',
      'transaction:verify-role',
      'transaction:set-role',
      'transaction:set-row-security',
      'transaction:create-adapter',
      'transaction:work-start',
      'transaction:revalidate',
      'transaction:set-claims',
      'transaction:work-end',
      'transaction:commit',
      'transaction:release',
    ]);
    const sessionQuery = test.runClient.query.mock.calls.find(([text]) =>
      text.includes('from emdo.auth_sessions'),
    );
    expect(sessionQuery?.[0]).toContain('for update of session, auth_user');
    expect(sessionQuery?.[0]).toContain('pg_catalog.clock_timestamp()');
    expect(sessionQuery?.[0]).toContain('auth_user.email_verified is true');
    expect(sessionQuery?.[1]).toEqual([sessionId, userId]);
    expect(test.pool.connect).toHaveBeenCalledTimes(2);
    expect(test.runClient.release).toHaveBeenCalledOnce();
  });

  it('creates an independent base adapter factory closure for each auth runtime', async () => {
    const test = harness();
    const adapterA = Object.freeze({
      id: 'database-a',
    }) as unknown as DBAdapter;
    const adapterB = Object.freeze({
      id: 'database-b',
    }) as unknown as DBAdapter;
    const factoryA = vi.fn(() => adapterA) as unknown as DBAdapterInstance;
    const factoryB = vi.fn(() => adapterB) as unknown as DBAdapterInstance;
    const createDatabaseAdapter = vi
      .fn()
      .mockReturnValueOnce(factoryA)
      .mockReturnValueOnce(factoryB);
    const bridge = await createPostgresBetterAuthOrganizationClaimBridge(
      test.pool as never,
      {
        createDatabaseAdapter,
        createRequestId: test.createRequestId,
        createTransactionAdapter: test.createTransactionAdapter,
      },
    );
    const optionsA = { appName: 'A' } as BetterAuthOptions;
    const optionsB = { appName: 'B' } as BetterAuthOptions;

    expect(bridge.database(optionsA)).toBe(adapterA);
    expect(bridge.database(optionsB)).toBe(adapterB);
    expect(createDatabaseAdapter).toHaveBeenCalledTimes(2);
    expect(factoryA).toHaveBeenCalledWith(optionsA);
    expect(factoryB).toHaveBeenCalledWith(optionsB);
  });

  it('rolls back if work completes without activating verified claims', async () => {
    const test = harness();
    const bridge = await createPostgresBetterAuthOrganizationClaimBridge(
      test.pool as never,
      {
        createDatabaseAdapter: test.createDatabaseAdapter,
        createRequestId: test.createRequestId,
        createTransactionAdapter: test.createTransactionAdapter,
      },
    );

    await expect(
      bridge.run({} as BetterAuthOptions, async () => 'unsafe result'),
    ).rejects.toThrow('Verified organization claims were not activated.');

    expect(test.events).toContain('transaction:rollback');
    expect(test.events).not.toContain('transaction:commit');
    expect(test.runClient.release).toHaveBeenCalledOnce();
  });

  it('fails closed when the locked session/user is absent, expired, or unverified', async () => {
    const events: string[] = [];
    const runClient = fakeClient({
      events,
      label: 'transaction',
      sessionRows: [],
    });
    const test = harness({ runClient });
    events.push(...test.events);
    const bridge = await createPostgresBetterAuthOrganizationClaimBridge(
      test.pool as never,
      {
        createDatabaseAdapter: test.createDatabaseAdapter,
        createRequestId: test.createRequestId,
        createTransactionAdapter: test.createTransactionAdapter,
      },
    );

    await expect(
      bridge.run({} as BetterAuthOptions, ({ revalidateAndActivateClaims }) =>
        revalidateAndActivateClaims({ sessionId, userId }),
      ),
    ).rejects.toThrow('The authenticated session is no longer eligible.');

    expect(
      runClient.query.mock.calls.some(([text]) => text.includes('set_config')),
    ).toBe(false);
    expect(runClient.query).toHaveBeenCalledWith('rollback');
    expect(runClient.release).toHaveBeenCalledOnce();
  });

  it('preserves the original failure and destroys the connection if rollback fails', async () => {
    const events: string[] = [];
    const rollbackError = new Error('rollback transport failure');
    const runClient = fakeClient({
      events,
      label: 'transaction',
      rollbackError,
    });
    const test = harness({ runClient });
    const original = new Error('work failure');
    const bridge = await createPostgresBetterAuthOrganizationClaimBridge(
      test.pool as never,
      {
        createDatabaseAdapter: test.createDatabaseAdapter,
        createRequestId: test.createRequestId,
        createTransactionAdapter: test.createTransactionAdapter,
      },
    );

    await expect(
      bridge.run(
        {} as BetterAuthOptions,
        async ({ revalidateAndActivateClaims }) => {
          await revalidateAndActivateClaims({ sessionId, userId });
          throw original;
        },
      ),
    ).rejects.toBe(original);

    expect(runClient.release).toHaveBeenCalledWith(rollbackError);
    expect(runClient.release).toHaveBeenCalledOnce();
  });

  it('rolls back a failed commit before releasing the connection', async () => {
    const events: string[] = [];
    const commitError = new Error('commit transport failure');
    const runClient = fakeClient({
      commitError,
      events,
      label: 'transaction',
    });
    const test = harness({ runClient });
    const bridge = await createPostgresBetterAuthOrganizationClaimBridge(
      test.pool as never,
      {
        createDatabaseAdapter: test.createDatabaseAdapter,
        createRequestId: test.createRequestId,
        createTransactionAdapter: test.createTransactionAdapter,
      },
    );

    await expect(
      bridge.run(
        {} as BetterAuthOptions,
        async ({ revalidateAndActivateClaims }) => {
          await revalidateAndActivateClaims({ sessionId, userId });
          return true;
        },
      ),
    ).rejects.toBe(commitError);

    expect(runClient.query).toHaveBeenCalledWith('rollback');
    expect(runClient.release).toHaveBeenCalledWith(undefined);
    expect(runClient.release).toHaveBeenCalledOnce();
  });

  it('captures dependencies before callers can mutate their objects', async () => {
    const test = harness();
    const dependencies = {
      createDatabaseAdapter: test.createDatabaseAdapter,
      createRequestId: test.createRequestId,
      createTransactionAdapter: test.createTransactionAdapter,
    };
    const bridgePromise = createPostgresBetterAuthOrganizationClaimBridge(
      test.pool as never,
      dependencies,
    );
    dependencies.createDatabaseAdapter = vi.fn(() => {
      throw new Error('mutated database factory');
    });
    dependencies.createRequestId = vi.fn(() => crypto.randomUUID());
    dependencies.createTransactionAdapter = vi.fn(() => {
      throw new Error('mutated transaction factory');
    });
    test.pool.connect = vi.fn(async () => {
      throw new Error('mutated pool connector');
    });

    const bridge = await bridgePromise;
    expect(bridge.database({} as BetterAuthOptions)).toBe(test.databaseAdapter);
    await expect(
      bridge.run(
        {} as BetterAuthOptions,
        async ({ revalidateAndActivateClaims }) => {
          await revalidateAndActivateClaims({ sessionId, userId });
          return true;
        },
      ),
    ).resolves.toBe(true);

    expect(test.createDatabaseAdapter).toHaveBeenCalledOnce();
    expect(test.createTransactionAdapter).toHaveBeenCalledOnce();
    expect(test.createRequestId).toHaveBeenCalledOnce();
  });

  it('revokes escaped adapter and activation capabilities after success', async () => {
    const test = harness();
    const bridge = await createPostgresBetterAuthOrganizationClaimBridge(
      test.pool as never,
      {
        createDatabaseAdapter: test.createDatabaseAdapter,
        createRequestId: test.createRequestId,
        createTransactionAdapter: test.createTransactionAdapter,
      },
    );
    let escapedRead: DBTransactionAdapter['findMany'] | undefined;
    let escapedAdapter: DBTransactionAdapter | undefined;
    let escapedActivation:
      | ((identity: { sessionId: string; userId: string }) => Promise<void>)
      | undefined;

    await bridge.run(
      {} as BetterAuthOptions,
      async ({ adapter, revalidateAndActivateClaims }) => {
        escapedAdapter = adapter;
        escapedRead = adapter.findMany;
        escapedActivation = revalidateAndActivateClaims;
        await revalidateAndActivateClaims({ sessionId, userId });
      },
    );

    expect(() => escapedAdapter?.findMany).toThrow(
      'The Better Auth claim transaction is closed.',
    );
    expect(() => escapedRead?.({ model: 'organization' })).toThrow(
      'The Better Auth claim transaction is closed.',
    );
    await expect(escapedActivation?.({ sessionId, userId })).rejects.toThrow(
      'The Better Auth claim transaction is closed.',
    );
    expect(test.adapterFindMany).not.toHaveBeenCalled();
  });

  it('waits for detached adapter work, rolls back, and revokes capabilities', async () => {
    let resolveDetached: ((value: readonly unknown[]) => void) | undefined;
    const detached = new Promise<readonly unknown[]>((resolve) => {
      resolveDetached = resolve;
    });
    const test = harness({ adapterFindMany: () => detached });
    const bridge = await createPostgresBetterAuthOrganizationClaimBridge(
      test.pool as never,
      {
        createDatabaseAdapter: test.createDatabaseAdapter,
        createRequestId: test.createRequestId,
        createTransactionAdapter: test.createTransactionAdapter,
      },
    );
    let escapedRead: DBTransactionAdapter['findMany'] | undefined;
    let escapedActivation:
      | ((identity: { sessionId: string; userId: string }) => Promise<void>)
      | undefined;

    const run = bridge.run(
      {} as BetterAuthOptions,
      async ({ adapter, revalidateAndActivateClaims }) => {
        escapedRead = adapter.findMany;
        escapedActivation = revalidateAndActivateClaims;
        await revalidateAndActivateClaims({ sessionId, userId });
        void adapter.findMany({ model: 'organization' });
      },
    );
    await vi.waitFor(() => expect(test.adapterFindMany).toHaveBeenCalledOnce());
    expect(test.runClient.release).not.toHaveBeenCalled();
    resolveDetached?.([]);

    await expect(run).rejects.toThrow(
      'Better Auth work must await every transaction-bound operation.',
    );
    expect(test.runClient.query).toHaveBeenCalledWith('rollback');
    expect(test.runClient.release).toHaveBeenCalledOnce();
    expect(() => escapedRead?.({ model: 'organization' })).toThrow(
      'The Better Auth claim transaction is closed.',
    );
    await expect(escapedActivation?.({ sessionId, userId })).rejects.toThrow(
      'The Better Auth claim transaction is closed.',
    );
  });

  it('revokes escaped capabilities when user work throws', async () => {
    const test = harness();
    const bridge = await createPostgresBetterAuthOrganizationClaimBridge(
      test.pool as never,
      {
        createDatabaseAdapter: test.createDatabaseAdapter,
        createRequestId: test.createRequestId,
        createTransactionAdapter: test.createTransactionAdapter,
      },
    );
    let escapedRead: DBTransactionAdapter['findMany'] | undefined;
    const workError = new Error('user work failed');

    await expect(
      bridge.run(
        {} as BetterAuthOptions,
        async ({ adapter, revalidateAndActivateClaims }) => {
          escapedRead = adapter.findMany;
          await revalidateAndActivateClaims({ sessionId, userId });
          throw workError;
        },
      ),
    ).rejects.toBe(workError);

    expect(() => escapedRead?.({ model: 'organization' })).toThrow(
      'The Better Auth claim transaction is closed.',
    );
    expect(test.runClient.query).toHaveBeenCalledWith('rollback');
  });

  it('rejects invalid claim IDs before querying session state', async () => {
    const test = harness();
    const bridge = await createPostgresBetterAuthOrganizationClaimBridge(
      test.pool as never,
      {
        createDatabaseAdapter: test.createDatabaseAdapter,
        createRequestId: test.createRequestId,
        createTransactionAdapter: test.createTransactionAdapter,
      },
    );

    await expect(
      bridge.run({} as BetterAuthOptions, ({ revalidateAndActivateClaims }) =>
        revalidateAndActivateClaims({ sessionId: 'not-a-uuid', userId }),
      ),
    ).rejects.toThrow('Session and user IDs must be valid UUIDs.');

    expect(
      test.runClient.query.mock.calls.some(([text]) =>
        text.includes('auth_sessions'),
      ),
    ).toBe(false);
  });

  it('allows claim activation only once in a transaction', async () => {
    const test = harness();
    const bridge = await createPostgresBetterAuthOrganizationClaimBridge(
      test.pool as never,
      {
        createDatabaseAdapter: test.createDatabaseAdapter,
        createRequestId: test.createRequestId,
        createTransactionAdapter: test.createTransactionAdapter,
      },
    );

    await expect(
      bridge.run(
        {} as BetterAuthOptions,
        async ({ revalidateAndActivateClaims }) => {
          await revalidateAndActivateClaims({ sessionId, userId });
          await revalidateAndActivateClaims({ sessionId, userId });
        },
      ),
    ).rejects.toThrow(
      'Organization claims can be activated only once per transaction.',
    );

    expect(
      test.runClient.query.mock.calls.filter(([text]) =>
        text.includes('from emdo.auth_sessions'),
      ),
    ).toHaveLength(1);
    expect(test.runClient.query).toHaveBeenCalledWith('rollback');
  });

  it('revalidates the same hardened login on every pool checkout', async () => {
    const events: string[] = [];
    const runClient = fakeClient({
      events,
      label: 'transaction',
      role: { ...validRole, login_role: 'different_auth_login' },
    });
    const test = harness({ runClient });
    const bridge = await createPostgresBetterAuthOrganizationClaimBridge(
      test.pool as never,
      {
        createDatabaseAdapter: test.createDatabaseAdapter,
        createRequestId: test.createRequestId,
        createTransactionAdapter: test.createTransactionAdapter,
      },
    );

    await expect(
      bridge.run({} as BetterAuthOptions, async () => undefined),
    ).rejects.toThrow('A dedicated EMDO auth database login is required.');

    expect(runClient.query).not.toHaveBeenCalledWith(
      'set local role emdo_auth',
    );
    expect(runClient.query).toHaveBeenCalledWith('rollback');
    expect(runClient.release).toHaveBeenCalledOnce();
  });

  it('rejects a privileged, differently assumed, or multi-parent login at preflight', async () => {
    for (const role of [
      { ...validRole, rolsuper: true },
      { ...validRole, rolbypassrls: true },
      { ...validRole, rolcreatedb: true },
      { ...validRole, rolcreaterole: true },
      { ...validRole, rolreplication: true },
      { ...validRole, rolcanlogin: false },
      { ...validRole, rolinherit: false },
      { ...validRole, unassumed: false },
      { ...validRole, only_auth_parent: false },
      { ...validRole, direct_parent_count: 2 },
      { ...validRole, owns_emdo_objects: true },
      { ...validRole, has_direct_emdo_acl: true },
      { ...validRole, auth_parent_inherit_option: false },
      { ...validRole, auth_parent_set_option: false },
      { ...validRole, auth_parent_admin_option: true },
    ]) {
      const events: string[] = [];
      const preflightClient = fakeClient({ events, label: 'preflight', role });
      const pool = { connect: vi.fn(async () => preflightClient) };

      await expect(
        createPostgresBetterAuthOrganizationClaimBridge(pool as never, {
          createDatabaseAdapter: vi.fn(() => vi.fn() as never),
          createRequestId: vi.fn(() => requestId),
          createTransactionAdapter: vi.fn(() => ({}) as never),
        }),
      ).rejects.toThrow('A dedicated EMDO auth database login is required.');
      expect(preflightClient.release).toHaveBeenCalledOnce();
    }
  });
});

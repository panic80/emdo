import { randomUUID } from 'node:crypto';

import type {
  BetterAuthOptions,
  DBAdapterInstance,
  DBTransactionAdapter,
} from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import { betterAuthSchema } from './schema.js';

const UuidSchema = z.uuid();

const VERIFY_DEDICATED_LOGIN_SQL = `
select
  login.rolname as login_role,
  login.rolcanlogin,
  login.rolsuper,
  login.rolinherit,
  login.rolcreaterole,
  login.rolcreatedb,
  login.rolreplication,
  login.rolbypassrls,
  current_user = session_user as unassumed,
  count(parent.oid)::integer as direct_parent_count,
  coalesce(
    bool_and(parent.rolname = 'emdo_auth'),
    false
  ) as only_auth_parent,
  coalesce(bool_and(membership.inherit_option), false)
    as auth_parent_inherit_option,
  coalesce(bool_and(membership.set_option), false)
    as auth_parent_set_option,
  coalesce(bool_or(membership.admin_option), false)
    as auth_parent_admin_option,
  exists (
    select 1
    from pg_catalog.pg_namespace as owned_namespace
    where owned_namespace.nspname = 'emdo'
      and owned_namespace.nspowner = login.oid
    union all
    select 1
    from pg_catalog.pg_class as owned_relation
    inner join pg_catalog.pg_namespace as relation_namespace
      on relation_namespace.oid = owned_relation.relnamespace
    where relation_namespace.nspname = 'emdo'
      and owned_relation.relowner = login.oid
    union all
    select 1
    from pg_catalog.pg_proc as owned_routine
    inner join pg_catalog.pg_namespace as routine_namespace
      on routine_namespace.oid = owned_routine.pronamespace
    where routine_namespace.nspname = 'emdo'
      and owned_routine.proowner = login.oid
  ) as owns_emdo_objects,
  exists (
    select 1
    from pg_catalog.pg_namespace as acl_namespace
    cross join lateral pg_catalog.aclexplode(acl_namespace.nspacl) as acl
    where acl_namespace.nspname = 'emdo'
      and acl.grantee = login.oid
    union all
    select 1
    from pg_catalog.pg_class as acl_relation
    inner join pg_catalog.pg_namespace as relation_namespace
      on relation_namespace.oid = acl_relation.relnamespace
    cross join lateral pg_catalog.aclexplode(acl_relation.relacl) as acl
    where relation_namespace.nspname = 'emdo'
      and acl.grantee = login.oid
    union all
    select 1
    from pg_catalog.pg_attribute as acl_column
    inner join pg_catalog.pg_class as column_relation
      on column_relation.oid = acl_column.attrelid
    inner join pg_catalog.pg_namespace as column_namespace
      on column_namespace.oid = column_relation.relnamespace
    cross join lateral pg_catalog.aclexplode(acl_column.attacl) as acl
    where column_namespace.nspname = 'emdo'
      and acl.grantee = login.oid
    union all
    select 1
    from pg_catalog.pg_proc as acl_routine
    inner join pg_catalog.pg_namespace as routine_namespace
      on routine_namespace.oid = acl_routine.pronamespace
    cross join lateral pg_catalog.aclexplode(acl_routine.proacl) as acl
    where routine_namespace.nspname = 'emdo'
      and acl.grantee = login.oid
    union all
    select 1
    from pg_catalog.pg_default_acl as default_acl
    cross join lateral pg_catalog.aclexplode(default_acl.defaclacl) as acl
    where default_acl.defaclnamespace = (
      select oid from pg_catalog.pg_namespace where nspname = 'emdo'
    )
      and acl.grantee = login.oid
  ) as has_direct_emdo_acl
from pg_catalog.pg_roles as login
left join pg_catalog.pg_auth_members as membership
  on membership.member = login.oid
left join pg_catalog.pg_roles as parent
  on parent.oid = membership.roleid
where login.rolname = session_user
group by
  login.oid,
  login.rolname,
  login.rolcanlogin,
  login.rolsuper,
  login.rolinherit,
  login.rolcreaterole,
  login.rolcreatedb,
  login.rolreplication,
  login.rolbypassrls
`;

const REVALIDATE_SESSION_SQL = `
select
  session.id::text as session_id,
  session.user_id::text as user_id
from emdo.auth_sessions as session
inner join emdo.auth_users as auth_user
  on auth_user.id = session.user_id
where session.id = $1::uuid
  and session.user_id = $2::uuid
  and auth_user.id = $2::uuid
  and session.expires_at > pg_catalog.clock_timestamp()
  and auth_user.email_verified is true
for update of session, auth_user
`;

const ACTIVATE_CLAIMS_SQL = `
select
  pg_catalog.set_config('emdo.user_id', $1, true),
  pg_catalog.set_config('emdo.session_id', $2, true),
  pg_catalog.set_config('emdo.request_id', $3, true)
`;

interface DedicatedLoginRow {
  readonly auth_parent_admin_option: boolean;
  readonly auth_parent_inherit_option: boolean;
  readonly auth_parent_set_option: boolean;
  readonly direct_parent_count: number;
  readonly has_direct_emdo_acl: boolean;
  readonly login_role: string;
  readonly only_auth_parent: boolean;
  readonly owns_emdo_objects: boolean;
  readonly rolbypassrls: boolean;
  readonly rolcanlogin: boolean;
  readonly rolcreatedb: boolean;
  readonly rolcreaterole: boolean;
  readonly rolinherit: boolean;
  readonly rolreplication: boolean;
  readonly rolsuper: boolean;
  readonly unassumed: boolean;
}

interface RevalidatedSessionRow {
  readonly session_id: string;
  readonly user_id: string;
}

export interface BetterAuthOrganizationClaimIdentity {
  readonly sessionId: string;
  readonly userId: string;
}

export interface PostgresBetterAuthOrganizationClaimTransaction {
  readonly adapter: DBTransactionAdapter;
  readonly revalidateAndActivateClaims: (
    identity: BetterAuthOrganizationClaimIdentity,
  ) => Promise<void>;
}

/**
 * Structurally matches @emdo/auth's claim bridge without importing that package
 * at runtime, so the auth and database packages do not form a dependency cycle.
 */
export interface PostgresBetterAuthOrganizationClaimBridge {
  readonly database: DBAdapterInstance;
  readonly run: <Result>(
    options: BetterAuthOptions,
    work: (
      transaction: PostgresBetterAuthOrganizationClaimTransaction,
    ) => Promise<Result>,
  ) => Promise<Result>;
}

export interface PostgresBetterAuthOrganizationClaimBridgeDependencies {
  readonly createDatabaseAdapter?: (pool: Pool) => DBAdapterInstance;
  readonly createRequestId?: () => string;
  readonly createTransactionAdapter?: (
    client: PoolClient,
    options: BetterAuthOptions,
  ) => DBTransactionAdapter;
}

class DedicatedAuthLoginRequiredError extends Error {
  override readonly name = 'DedicatedAuthLoginRequiredError';

  constructor() {
    super('A dedicated EMDO auth database login is required.');
  }
}

class IneligibleSessionError extends Error {
  override readonly name = 'IneligibleSessionError';

  constructor() {
    super('The authenticated session is no longer eligible.');
  }
}

class ClaimsNotActivatedError extends Error {
  override readonly name = 'ClaimsNotActivatedError';

  constructor() {
    super('Verified organization claims were not activated.');
  }
}

class InvalidClaimIdentityError extends Error {
  override readonly name = 'InvalidClaimIdentityError';

  constructor(message = 'Session and user IDs must be valid UUIDs.') {
    super(message);
  }
}

class ClaimsAlreadyActivatedError extends Error {
  override readonly name = 'ClaimsAlreadyActivatedError';

  constructor() {
    super('Organization claims can be activated only once per transaction.');
  }
}

class ClaimTransactionClosedError extends Error {
  override readonly name = 'ClaimTransactionClosedError';

  constructor() {
    super('The Better Auth claim transaction is closed.');
  }
}

class UnawaitedClaimOperationError extends Error {
  override readonly name = 'UnawaitedClaimOperationError';

  constructor() {
    super('Better Auth work must await every transaction-bound operation.');
  }
}

const asError = (value: unknown): Error =>
  value instanceof Error ? value : new Error('PostgreSQL transaction failed.');

const defaultCreateDatabaseAdapter = (pool: Pool): DBAdapterInstance =>
  drizzleAdapter(drizzle(pool, { schema: betterAuthSchema }), {
    provider: 'pg',
    schema: betterAuthSchema,
    transaction: true,
  });

const defaultCreateTransactionAdapter = (
  client: PoolClient,
  options: BetterAuthOptions,
): DBTransactionAdapter =>
  drizzleAdapter(drizzle(client, { schema: betterAuthSchema }), {
    provider: 'pg',
    schema: betterAuthSchema,
    transaction: false,
  })(options);

const inspectDedicatedLogin = async (
  client: Pick<PoolClient, 'query'>,
): Promise<DedicatedLoginRow> => {
  const result = await client.query<DedicatedLoginRow>(
    VERIFY_DEDICATED_LOGIN_SQL,
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    row === undefined ||
    !row.rolcanlogin ||
    !row.rolinherit ||
    row.rolsuper ||
    row.rolbypassrls ||
    row.rolcreatedb ||
    row.rolcreaterole ||
    row.rolreplication ||
    row.owns_emdo_objects ||
    row.has_direct_emdo_acl ||
    !row.unassumed ||
    row.direct_parent_count !== 1 ||
    !row.only_auth_parent ||
    !row.auth_parent_inherit_option ||
    !row.auth_parent_set_option ||
    row.auth_parent_admin_option
  ) {
    throw new DedicatedAuthLoginRequiredError();
  }
  return row;
};

const normalizeUuid = (value: string): string => {
  const parsed = UuidSchema.safeParse(value);
  if (!parsed.success) throw new InvalidClaimIdentityError();
  return parsed.data.toLowerCase();
};

/**
 * Creates the production Better Auth database/claim bundle. Construction runs
 * a fail-closed credential preflight so even non-organization auth routes do
 * not start with an administrative, BYPASSRLS, or multi-purpose login.
 */
export const createPostgresBetterAuthOrganizationClaimBridge = async (
  pool: Pool,
  dependencyOverrides: PostgresBetterAuthOrganizationClaimBridgeDependencies = {},
): Promise<PostgresBetterAuthOrganizationClaimBridge> => {
  // Capture callable dependencies before the first await. Callers cannot swap
  // the pool connector or factories while credential preflight is in flight.
  const connect = pool.connect.bind(pool);
  const createDatabaseAdapter =
    dependencyOverrides.createDatabaseAdapter ?? defaultCreateDatabaseAdapter;
  const createRequestId = dependencyOverrides.createRequestId ?? randomUUID;
  const createTransactionAdapter =
    dependencyOverrides.createTransactionAdapter ??
    defaultCreateTransactionAdapter;

  const preflightClient = await connect();
  let preflightReleaseError: Error | undefined;
  let loginRole: string;
  try {
    loginRole = (await inspectDedicatedLogin(preflightClient)).login_role;
  } catch (error) {
    if (!(error instanceof DedicatedAuthLoginRequiredError)) {
      preflightReleaseError = asError(error);
    }
    throw error;
  } finally {
    preflightClient.release(preflightReleaseError);
  }

  // Better Auth's Drizzle adapter factory retains its most recent options in a
  // closure. Create a fresh factory for every consumer so one auth runtime
  // cannot mutate another runtime's future transaction behavior.
  const database: DBAdapterInstance = Object.freeze((options) =>
    createDatabaseAdapter(pool)(options),
  );

  const run = async <Result>(
    options: BetterAuthOptions,
    work: (
      transaction: PostgresBetterAuthOrganizationClaimTransaction,
    ) => Promise<Result>,
  ): Promise<Result> => {
    const requestIdResult = UuidSchema.safeParse(createRequestId());
    if (!requestIdResult.success) {
      throw new InvalidClaimIdentityError(
        'The server-generated request ID must be a valid UUID.',
      );
    }
    const requestId = requestIdResult.data.toLowerCase();
    const client = await connect();
    let transactionOpen = false;
    let releaseError: Error | undefined;
    let closeTransactionCapabilities: (() => Promise<void>) | undefined;
    try {
      await client.query('begin');
      transactionOpen = true;

      const currentLogin = await inspectDedicatedLogin(client);
      if (currentLogin.login_role !== loginRole) {
        throw new DedicatedAuthLoginRequiredError();
      }

      await client.query('set local role emdo_auth');
      await client.query('set local row_security = on');

      const rawAdapter = createTransactionAdapter(client, options);
      let capabilitiesLive = true;
      const pendingOperations = new Set<Promise<unknown>>();
      const methodWrappers = new Map<PropertyKey, unknown>();

      const assertCapabilitiesLive = (): void => {
        if (!capabilitiesLive) throw new ClaimTransactionClosedError();
      };
      const trackOperation = <Value>(
        operation: Promise<Value>,
      ): Promise<Value> => {
        pendingOperations.add(operation);
        void operation.then(
          () => pendingOperations.delete(operation),
          () => pendingOperations.delete(operation),
        );
        return operation;
      };
      closeTransactionCapabilities = async (): Promise<void> => {
        capabilitiesLive = false;
        if (pendingOperations.size > 0) {
          await Promise.allSettled([...pendingOperations]);
        }
      };

      const adapter = new Proxy(Object.create(null) as DBTransactionAdapter, {
        get(_target, property) {
          // DBTransactionAdapter deliberately omits nested transactions. The
          // raw Better Auth object still carries this method at runtime and
          // would otherwise hand its unguarded adapter to a nested callback.
          if (property === 'transaction') return undefined;

          assertCapabilitiesLive();
          const value = Reflect.get(
            rawAdapter,
            property,
            rawAdapter,
          ) as unknown;
          if (typeof value !== 'function') return value;
          const existing = methodWrappers.get(property);
          if (existing !== undefined) return existing;

          const wrapped = (...arguments_: unknown[]): unknown => {
            assertCapabilitiesLive();
            const result = Reflect.apply(
              value,
              rawAdapter,
              arguments_,
            ) as unknown;
            if (
              (typeof result === 'object' || typeof result === 'function') &&
              result !== null &&
              'then' in result &&
              typeof result.then === 'function'
            ) {
              return trackOperation(Promise.resolve(result));
            }
            return result;
          };
          methodWrappers.set(property, wrapped);
          return wrapped;
        },
      }) as DBTransactionAdapter;
      let activationStarted = false;
      let claimsActivated = false;

      const revalidateAndActivateClaims = (
        identity: BetterAuthOrganizationClaimIdentity,
      ): Promise<void> => {
        try {
          assertCapabilitiesLive();
          if (activationStarted) throw new ClaimsAlreadyActivatedError();
          activationStarted = true;
        } catch (error) {
          return Promise.reject(error);
        }
        return trackOperation(
          (async () => {
            const normalizedSessionId = normalizeUuid(identity.sessionId);
            const normalizedUserId = normalizeUuid(identity.userId);
            const result = await client.query<RevalidatedSessionRow>(
              REVALIDATE_SESSION_SQL,
              [normalizedSessionId, normalizedUserId],
            );
            const row = result.rows[0];
            if (
              result.rows.length !== 1 ||
              row === undefined ||
              row.session_id.toLowerCase() !== normalizedSessionId ||
              row.user_id.toLowerCase() !== normalizedUserId
            ) {
              throw new IneligibleSessionError();
            }

            assertCapabilitiesLive();
            await client.query(ACTIVATE_CLAIMS_SQL, [
              normalizedUserId,
              normalizedSessionId,
              requestId,
            ]);
            claimsActivated = true;
          })(),
        );
      };

      const transaction = Object.freeze({
        adapter,
        revalidateAndActivateClaims,
      });
      const result = await work(transaction);
      const hadUnawaitedOperations = pendingOperations.size > 0;
      await closeTransactionCapabilities();
      if (hadUnawaitedOperations) throw new UnawaitedClaimOperationError();
      if (!claimsActivated) throw new ClaimsNotActivatedError();

      await client.query('commit');
      transactionOpen = false;
      return result;
    } catch (error) {
      await closeTransactionCapabilities?.();
      if (transactionOpen) {
        try {
          await client.query('rollback');
          transactionOpen = false;
        } catch (rollbackError) {
          releaseError = asError(rollbackError);
        }
      }
      throw error;
    } finally {
      client.release(releaseError);
    }
  };

  return Object.freeze({ database, run });
};

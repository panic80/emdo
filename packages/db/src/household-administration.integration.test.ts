import { Buffer } from 'node:buffer';
import {
  constants,
  createHash,
  generateKeyPairSync,
  publicEncrypt,
  type KeyObject,
} from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadOrderedMigrations, type OrderedMigration } from './migrations.js';

const databaseUrl = process.env.TEST_HOUSEHOLD_ADMIN_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

const applicationRole = 'emdo_api_login';
const sessionAuthorizationSql = Object.freeze({
  emdo_api_login: 'set session authorization emdo_api_login',
  emdo_worker_dispatch_executor:
    'set session authorization emdo_worker_dispatch_executor',
  emdo_worker_executor: 'set session authorization emdo_worker_executor',
});

const ids = Object.freeze({
  household: '86000000-0000-4000-8000-000000000001',
  ownerUser: '86000000-0000-4000-8000-000000000002',
  ownerMembership: '86000000-0000-4000-8000-000000000003',
  ownerSession: '86000000-0000-4000-8000-000000000004',
  ownerSpace: '86000000-0000-4000-8000-000000000005',
  secondOwnerUser: '86000000-0000-4000-8000-000000000006',
  secondOwnerMembership: '86000000-0000-4000-8000-000000000007',
  secondOwnerSession: '86000000-0000-4000-8000-000000000008',
  secondOwnerSpace: '86000000-0000-4000-8000-000000000009',
  deniedMemberUser: '86000000-0000-4000-8000-000000000010',
  deniedMemberMembership: '86000000-0000-4000-8000-000000000011',
  deniedMemberSession: '86000000-0000-4000-8000-000000000012',
  deniedMemberSpace: '86000000-0000-4000-8000-000000000013',
  roleTargetUser: '86000000-0000-4000-8000-000000000014',
  roleTargetMembership: '86000000-0000-4000-8000-000000000015',
  roleTargetSession: '86000000-0000-4000-8000-000000000016',
  roleTargetSpace: '86000000-0000-4000-8000-000000000017',
  deactivateTargetUser: '86000000-0000-4000-8000-000000000018',
  deactivateTargetMembership: '86000000-0000-4000-8000-000000000019',
  deactivateTargetSession: '86000000-0000-4000-8000-000000000020',
  deactivateTargetSpace: '86000000-0000-4000-8000-000000000021',
  expiredOwnerUser: '86000000-0000-4000-8000-000000000022',
  expiredOwnerMembership: '86000000-0000-4000-8000-000000000023',
  expiredOwnerSession: '86000000-0000-4000-8000-000000000024',
  expiredOwnerSpace: '86000000-0000-4000-8000-000000000025',
  soleHousehold: '86000000-0000-4000-8000-000000000026',
  soleOwnerUser: '86000000-0000-4000-8000-000000000027',
  soleOwnerMembership: '86000000-0000-4000-8000-000000000028',
  soleOwnerSession: '86000000-0000-4000-8000-000000000029',
  soleOwnerSpace: '86000000-0000-4000-8000-000000000030',
  invitation: '86000000-0000-4000-8000-000000000031',
  invitationSecret: '86000000-0000-4000-8000-000000000032',
  workerInvitation: '86000000-0000-4000-8000-000000000033',
  workerInvitationSecret: '86000000-0000-4000-8000-000000000034',
  invalidInvitation: '86000000-0000-4000-8000-000000000035',
  invalidInvitationSecret: '86000000-0000-4000-8000-000000000036',
  workerQueueJob: '86000000-0000-4000-8000-000000000037',
  ownerRequest: '86000000-0000-4000-8000-000000000090',
  deniedRequest: '86000000-0000-4000-8000-000000000091',
  expiredRequest: '86000000-0000-4000-8000-000000000092',
  soleOwnerRequest: '86000000-0000-4000-8000-000000000093',
  secondOwnerRequest: '86000000-0000-4000-8000-000000000094',
});

const migrationIds = Object.freeze([
  '0000_household_foundation',
  '0001_identity_onboarding',
  '0002_owner_bootstrap',
  '0003_durable_runtime_repositories',
  '0004_audio_request_receipts',
  '0005_household_administration',
]);
const statementBreakpoint = '--> statement-breakpoint';

const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

const errorRecord = (error: unknown): Readonly<Record<string, unknown>> =>
  typeof error === 'object' && error !== null
    ? (error as Readonly<Record<string, unknown>>)
    : Object.freeze({});

const errorMessage = (error: unknown): string => {
  const message = errorRecord(error).message;
  return typeof message === 'string' ? message : String(error);
};

const loadHouseholdAdministrationMigrations = async (): Promise<
  readonly OrderedMigration[]
> => {
  const journaled = await loadOrderedMigrations();
  const required = journaled.slice(0, migrationIds.length);
  if (required.length !== migrationIds.length) {
    throw new Error(
      'Household administration migration is absent from the deployment journal',
    );
  }
  return required.map((migration, index) => {
    const expectedId = migrationIds[index];
    if (migration.id !== expectedId || migration.index !== index) {
      throw new Error(
        `Required ordered migration ${index}:${String(expectedId)} is missing`,
      );
    }
    return migration;
  });
};

const applyMigrationWithStatementContext = async (
  client: import('pg').Client,
  migration: OrderedMigration,
): Promise<void> => {
  const fragments = migration.sql.split(statementBreakpoint);
  let sourceOffset = 0;
  await client.query('begin');
  try {
    for (const [index, fragment] of fragments.entries()) {
      const statement = fragment.trim();
      const line = migration.sql.slice(0, sourceOffset).split('\n').length;
      sourceOffset += fragment.length + statementBreakpoint.length;
      if (statement.length === 0) continue;
      try {
        await client.query(statement);
      } catch (error) {
        const preview = statement.replace(/\s+/gu, ' ').slice(0, 240);
        throw new Error(
          `${migration.id} statement ${index + 1} near line ${line} failed: ` +
            `${preview}\nPostgreSQL: ${errorMessage(error)}`,
        );
      }
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
};

const connectAs = async (
  role: keyof typeof sessionAuthorizationSql,
): Promise<import('pg').Client> => {
  const { Client } = await import('pg');
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(sessionAuthorizationSql[role]);
    return client;
  } catch (error) {
    await client.end();
    throw error;
  }
};

const withPrincipal = async <Result>(
  client: import('pg').Client,
  principal: {
    readonly userId: string;
    readonly sessionId: string;
    readonly requestId: string;
  },
  work: () => Promise<Result>,
): Promise<Result> => {
  await client.query('begin');
  try {
    await client.query('set local row_security = on');
    await client.query("set local statement_timeout = '30s'");
    await client.query("set local lock_timeout = '5s'");
    await client.query(
      `select pg_catalog.set_config('emdo.user_id', $1, true),
              pg_catalog.set_config('emdo.session_id', $2, true),
              pg_catalog.set_config('emdo.request_id', $3, true)`,
      [principal.userId, principal.sessionId, principal.requestId],
    );
    const result = await work();
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
};

const expectDatabaseError = async (
  operation: () => Promise<unknown>,
  expected: { readonly code: string; readonly message?: string },
): Promise<void> => {
  try {
    await operation();
  } catch (error) {
    const record = errorRecord(error);
    expect(record.code).toBe(expected.code);
    if (expected.message !== undefined) {
      expect(record.message).toBe(expected.message);
    }
    return;
  }
  throw new Error(`Expected PostgreSQL error ${expected.code}`);
};

const ownerPrincipal = Object.freeze({
  userId: ids.ownerUser,
  sessionId: ids.ownerSession,
  requestId: ids.ownerRequest,
});
const secondOwnerPrincipal = Object.freeze({
  userId: ids.secondOwnerUser,
  sessionId: ids.secondOwnerSession,
  requestId: ids.secondOwnerRequest,
});

interface IssuedInvitationFixture {
  readonly invitationId: string;
  readonly deliverySecretId: string;
  readonly operationId: string;
  readonly payloadHash: string;
  readonly plaintextToken: string;
  readonly tokenHash: string;
  readonly envelope: Readonly<{
    schemaVersion: 1;
    algorithm: 'RSA-OAEP-256';
    keyId: string;
    ciphertext: string;
    bindingHash: string;
  }>;
  readonly rows: readonly Record<string, unknown>[];
}

let invitationPublicKey: KeyObject | undefined;
const getInvitationPublicKey = (): KeyObject => {
  if (invitationPublicKey === undefined) {
    invitationPublicKey = generateKeyPairSync('rsa', {
      modulusLength: 2_048,
      publicExponent: 0x10001,
    }).publicKey;
  }
  return invitationPublicKey;
};

const invitationPayloadHash = (
  operationId: string,
  invitationId: string,
  deliverySecretId: string,
): string =>
  sha256(
    `emdo.invitation.delivery.v1\0${JSON.stringify({
      deliverySecretId,
      invitationId,
      operationId,
      origin: 'deterministic-worker',
      schemaVersion: 1,
    })}`,
  );

const issueInvitation = async (
  app: import('pg').Client,
  input: {
    readonly invitationId: string;
    readonly deliverySecretId: string;
    readonly recipient: string;
    readonly expiresInSeconds?: number;
  },
): Promise<IssuedInvitationFixture> => {
  const operationId = `invitation:${input.invitationId}`;
  const plaintextToken = `EmdoInviteToken_${input.invitationId.replace(/-/gu, '')}`;
  const tokenHash = sha256(plaintextToken);
  const binding = Object.freeze({
    invitationId: input.invitationId,
    normalizedRecipient: input.recipient,
    role: 'member' as const,
    tokenHash,
    templateVersion: 'invitation-redemption.v1' as const,
  });
  const envelope = Object.freeze({
    schemaVersion: 1 as const,
    algorithm: 'RSA-OAEP-256' as const,
    keyId: 'household-admin-integration-key-v1',
    ciphertext: publicEncrypt(
      {
        key: getInvitationPublicKey(),
        oaepHash: 'sha256',
        padding: constants.RSA_PKCS1_OAEP_PADDING,
      },
      Buffer.from(plaintextToken, 'utf8'),
    ).toString('base64url'),
    bindingHash: sha256(
      `emdo.invitation.delivery.binding.v1\0${JSON.stringify(binding)}`,
    ),
  });
  const payloadHash = invitationPayloadHash(
    operationId,
    input.invitationId,
    input.deliverySecretId,
  );
  const requestHash = sha256(
    JSON.stringify({
      email: input.recipient,
      expiresInSeconds: input.expiresInSeconds ?? 604_800,
      invitationId: input.invitationId,
      role: 'member',
    }),
  );
  const result = await withPrincipal(app, ownerPrincipal, async () =>
    app.query(
      `select *
         from emdo.issue_household_invitation(
           $1::text, $2::text, $3::integer, $4::text, $5::text, $6::text,
           $7::uuid, $8::text, $9::uuid, $10::text, $11::jsonb, $12::text
         )`,
      [
        input.recipient,
        'member',
        input.expiresInSeconds ?? 604_800,
        tokenHash,
        `issue-invitation:${input.invitationId}`,
        requestHash,
        input.invitationId,
        operationId,
        input.deliverySecretId,
        'invitation-redemption.v1',
        envelope,
        payloadHash,
      ],
    ),
  );
  return Object.freeze({
    invitationId: input.invitationId,
    deliverySecretId: input.deliverySecretId,
    operationId,
    payloadHash,
    plaintextToken,
    tokenHash,
    envelope,
    rows: result.rows as readonly Record<string, unknown>[],
  });
};

describeDatabase(
  'PostgreSQL 17 household administration authority (requires isolated TEST_HOUSEHOLD_ADMIN_DATABASE_URL)',
  () => {
    let admin: import('pg').Client;
    let app: import('pg').Client;
    let concurrentApp: import('pg').Client;
    let dispatcher: import('pg').Client;
    let worker: import('pg').Client;
    let createdApplicationRole = false;
    let grantedApplicationMembership = false;

    beforeAll(async () => {
      const { Client } = await import('pg');
      admin = new Client({ connectionString: databaseUrl });
      await admin.connect();

      const identity = await admin.query(
        `select pg_catalog.current_setting('server_version_num')::integer
                  as server_version_num,
                current_user::text as current_user_name,
                role.rolsuper as is_superuser
           from pg_catalog.pg_roles as role
          where role.rolname = current_user`,
      );
      const serverVersion = Number(identity.rows[0]?.server_version_num);
      if (serverVersion < 170_000 || serverVersion >= 180_000) {
        throw new Error(
          'TEST_HOUSEHOLD_ADMIN_DATABASE_URL must use PostgreSQL 17',
        );
      }
      if (identity.rows[0]?.is_superuser !== true) {
        throw new Error(
          'TEST_HOUSEHOLD_ADMIN_DATABASE_URL must use a disposable superuser database',
        );
      }
      const existingSchema = await admin.query(
        `select 1 from pg_catalog.pg_namespace where nspname = 'emdo'`,
      );
      if (existingSchema.rowCount !== 0) {
        throw new Error(
          'TEST_HOUSEHOLD_ADMIN_DATABASE_URL must point at an isolated empty database',
        );
      }

      for (const migration of await loadHouseholdAdministrationMigrations()) {
        await applyMigrationWithStatementContext(admin, migration);
      }
      const vector = await admin.query(
        `select extversion from pg_catalog.pg_extension where extname = 'vector'`,
      );
      if (vector.rowCount !== 1) {
        throw new Error('PostgreSQL 17 pgvector extension is required');
      }

      const existingApplicationRole = await admin.query(
        `select rolcanlogin, rolsuper, rolinherit, rolbypassrls
           from pg_catalog.pg_roles
          where rolname = $1`,
        [applicationRole],
      );
      if (existingApplicationRole.rowCount === 0) {
        await admin.query(
          `create role emdo_api_login login nosuperuser nocreatedb
             nocreaterole inherit nobypassrls noreplication`,
        );
        createdApplicationRole = true;
      } else if (
        existingApplicationRole.rows[0]?.rolsuper === true ||
        existingApplicationRole.rows[0]?.rolinherit !== true ||
        existingApplicationRole.rows[0]?.rolbypassrls === true
      ) {
        throw new Error('Existing emdo_api_login role is unsafe for this test');
      }
      const existingMembership = await admin.query(
        `select 1
           from pg_catalog.pg_auth_members as membership
           join pg_catalog.pg_roles as parent on parent.oid = membership.roleid
           join pg_catalog.pg_roles as child on child.oid = membership.member
          where parent.rolname = 'emdo_app'
            and child.rolname = 'emdo_api_login'`,
      );
      if (existingMembership.rowCount === 0) {
        await admin.query(`grant emdo_app to emdo_api_login`);
        grantedApplicationMembership = true;
      }

      const users = [
        [ids.ownerUser, 'Household Owner', 'owner@household.test'],
        [ids.secondOwnerUser, 'Second Owner', 'owner2@household.test'],
        [ids.deniedMemberUser, 'Denied Member', 'denied@household.test'],
        [ids.roleTargetUser, 'Role Target', 'role-target@household.test'],
        [
          ids.deactivateTargetUser,
          'Deactivate Target',
          'deactivate-target@household.test',
        ],
        [ids.expiredOwnerUser, 'Expired Owner', 'expired@household.test'],
        [ids.soleOwnerUser, 'Sole Owner', 'sole-owner@household.test'],
      ] as const;
      for (const [id, name, email] of users) {
        await admin.query(
          `insert into emdo.auth_users (id, name, email, email_verified)
           values ($1, $2, $3, true)`,
          [id, name, email],
        );
      }
      await admin.query(
        `insert into emdo.households (id, name, slug, created_by_user_id)
         values ($1, 'Household Administration', 'household-administration', $2),
                ($3, 'Sole Owner Household', 'sole-owner-household', $4)`,
        [ids.household, ids.ownerUser, ids.soleHousehold, ids.soleOwnerUser],
      );

      const memberships = [
        [ids.ownerMembership, ids.household, ids.ownerUser, 'owner'],
        [
          ids.secondOwnerMembership,
          ids.household,
          ids.secondOwnerUser,
          'owner',
        ],
        [
          ids.deniedMemberMembership,
          ids.household,
          ids.deniedMemberUser,
          'member',
        ],
        [ids.roleTargetMembership, ids.household, ids.roleTargetUser, 'member'],
        [
          ids.deactivateTargetMembership,
          ids.household,
          ids.deactivateTargetUser,
          'member',
        ],
        [
          ids.expiredOwnerMembership,
          ids.household,
          ids.expiredOwnerUser,
          'owner',
        ],
        [
          ids.soleOwnerMembership,
          ids.soleHousehold,
          ids.soleOwnerUser,
          'owner',
        ],
      ] as const;
      for (const [id, householdId, userId, role] of memberships) {
        await admin.query(
          `insert into emdo.household_memberships
             (id, household_id, user_id, role, status, joined_at)
           values ($1, $2, $3, $4, 'active', pg_catalog.clock_timestamp())`,
          [id, householdId, userId, role],
        );
      }

      const spaces = [
        [ids.ownerSpace, ids.household, ids.ownerUser, 'Owner Private'],
        [
          ids.secondOwnerSpace,
          ids.household,
          ids.secondOwnerUser,
          'Second Owner Private',
        ],
        [
          ids.deniedMemberSpace,
          ids.household,
          ids.deniedMemberUser,
          'Denied Member Private',
        ],
        [
          ids.roleTargetSpace,
          ids.household,
          ids.roleTargetUser,
          'Role Target Private',
        ],
        [
          ids.deactivateTargetSpace,
          ids.household,
          ids.deactivateTargetUser,
          'Deactivate Target Private',
        ],
        [
          ids.expiredOwnerSpace,
          ids.household,
          ids.expiredOwnerUser,
          'Expired Owner Private',
        ],
        [
          ids.soleOwnerSpace,
          ids.soleHousehold,
          ids.soleOwnerUser,
          'Sole Owner Private',
        ],
      ] as const;
      for (const [id, householdId, userId, name] of spaces) {
        await admin.query(
          `insert into emdo.spaces
             (id, household_id, original_owner_user_id, name, visibility)
           values ($1, $2, $3, $4, 'private')`,
          [id, householdId, userId, name],
        );
      }

      const sessions = [
        [ids.ownerSession, ids.ownerUser, ids.household, '1 hour'],
        [ids.secondOwnerSession, ids.secondOwnerUser, ids.household, '1 hour'],
        [
          ids.deniedMemberSession,
          ids.deniedMemberUser,
          ids.household,
          '1 hour',
        ],
        [ids.roleTargetSession, ids.roleTargetUser, ids.household, '1 hour'],
        [
          ids.deactivateTargetSession,
          ids.deactivateTargetUser,
          ids.household,
          '1 hour',
        ],
        [
          ids.expiredOwnerSession,
          ids.expiredOwnerUser,
          ids.household,
          '-1 hour',
        ],
        [ids.soleOwnerSession, ids.soleOwnerUser, ids.soleHousehold, '1 hour'],
      ] as const;
      for (const [id, userId, householdId, lifetime] of sessions) {
        await admin.query(
          `insert into emdo.auth_sessions
             (id, user_id, token, expires_at, active_household_id)
           values ($1, $2, $3,
                   pg_catalog.clock_timestamp() + $4::interval, $5)`,
          [id, userId, `integration-session-${id}`, lifetime, householdId],
        );
      }
      for (const [id, userId] of [
        [ids.roleTargetSession, ids.roleTargetUser],
        [ids.deactivateTargetSession, ids.deactivateTargetUser],
      ] as const) {
        await admin.query(
          `insert into emdo.rotating_sessions
             (id, user_id, token_hash, rotation, created_at, expires_at)
           values ($1, $2, $3, 0, pg_catalog.clock_timestamp(),
                   pg_catalog.clock_timestamp() + interval '1 hour')`,
          [id, userId, sha256(`rotating-session:${id}`)],
        );
      }

      app = await connectAs('emdo_api_login');
      concurrentApp = await connectAs('emdo_api_login');
      dispatcher = await connectAs('emdo_worker_dispatch_executor');
      worker = await connectAs('emdo_worker_executor');
    }, 60_000);

    afterAll(async () => {
      await Promise.all(
        [app, concurrentApp, dispatcher, worker]
          .filter(
            (client): client is import('pg').Client => client !== undefined,
          )
          .map(async (client) => client.end()),
      );
      if (admin !== undefined) {
        if (grantedApplicationMembership) {
          await admin
            .query(`revoke emdo_app from emdo_api_login`)
            .catch(() => undefined);
        }
        if (createdApplicationRole) {
          await admin
            .query(`drop role if exists emdo_api_login`)
            .catch(() => undefined);
        }
        await admin.end();
      }
    });

    it('reports ready only for the fixed API identity and denies raw administration storage', async () => {
      await expect(
        app.query(`select emdo.household_administration_ready() as ready`),
      ).resolves.toMatchObject({ rows: [{ ready: true }] });

      const deniedStatements = [
        `select id from emdo.invitations limit 1`,
        `select id from emdo.household_memberships limit 1`,
        `select envelope from emdo.invitation_delivery_secrets limit 1`,
        `select payload from emdo.worker_operation_outbox limit 1`,
        `update emdo.household_memberships set role = role where false`,
        `insert into emdo.households (name, slug, created_by_user_id)
         values ('Forbidden', 'forbidden-public-household',
                 '${ids.ownerUser}')`,
      ];
      for (const statement of deniedStatements) {
        await expectDatabaseError(() => app.query(statement), {
          code: '42501',
        });
      }
    });

    it('derives owner authority from the live session and rejects members and expired owners', async () => {
      await expectDatabaseError(
        () =>
          withPrincipal(
            app,
            {
              userId: ids.deniedMemberUser,
              sessionId: ids.deniedMemberSession,
              requestId: ids.deniedRequest,
            },
            () => app.query(`select * from emdo.list_household_invitations()`),
          ),
        { code: '42501', message: 'EMDO:authorization-revoked' },
      );
      await expectDatabaseError(
        () =>
          withPrincipal(
            app,
            {
              userId: ids.expiredOwnerUser,
              sessionId: ids.expiredOwnerSession,
              requestId: ids.expiredRequest,
            },
            () => app.query(`select * from emdo.list_household_memberships()`),
          ),
        { code: '42501', message: 'EMDO:authorization-revoked' },
      );
    });

    it('issues, lists, and revokes a seven-day invitation without persisting its plaintext token', async () => {
      const issued = await issueInvitation(app, {
        invitationId: ids.invitation,
        deliverySecretId: ids.invitationSecret,
        recipient: 'invitee@household.test',
      });
      expect(issued.rows).toHaveLength(1);
      expect(issued.rows[0]).toMatchObject({
        invitation_id: ids.invitation,
        household_id: ids.household,
        email: 'invitee@household.test',
        role: 'member',
        state: 'pending',
        version: 1,
        replayed: false,
        delivery_queued: true,
      });
      const createdAt = new Date(String(issued.rows[0]?.created_at));
      const expiresAt = new Date(String(issued.rows[0]?.expires_at));
      expect(expiresAt.getTime() - createdAt.getTime()).toBeLessThanOrEqual(
        604_800_000,
      );
      expect(expiresAt.getTime()).toBeGreaterThan(createdAt.getTime());

      const listed = await withPrincipal(app, ownerPrincipal, () =>
        app.query(`select * from emdo.list_household_invitations()`),
      );
      expect(listed.rows).toContainEqual(
        expect.objectContaining({
          invitation_id: ids.invitation,
          state: 'pending',
          version: 1,
        }),
      );
      expect(JSON.stringify(listed.rows)).not.toContain(issued.plaintextToken);

      const invitationStorage = await admin.query(
        `select pg_catalog.row_to_json(invitation) as invitation
           from emdo.invitations as invitation
          where invitation.id = $1`,
        [ids.invitation],
      );
      const outboxStorage = await admin.query(
        `select pg_catalog.row_to_json(outbox) as outbox
           from emdo.worker_operation_outbox as outbox
          where outbox.job_name = 'emdo.invitation.delivery.v1'
            and outbox.operation_id = $1`,
        [issued.operationId],
      );
      const secretStorage = await admin.query(
        `select pg_catalog.row_to_json(secret) as secret
           from emdo.invitation_delivery_secrets as secret
          where secret.id = $1`,
        [ids.invitationSecret],
      );
      const invitationRecord = invitationStorage.rows[0]?.invitation as Record<
        string,
        unknown
      >;
      const outboxRecord = outboxStorage.rows[0]?.outbox as Record<
        string,
        unknown
      >;
      const secretRecord = secretStorage.rows[0]?.secret as Record<
        string,
        unknown
      >;
      expect(invitationRecord.token_hash).toBe(issued.tokenHash);
      expect(outboxRecord.payload).toEqual({
        schemaVersion: 1,
        origin: 'deterministic-worker',
        operationId: issued.operationId,
        invitationId: ids.invitation,
        deliverySecretId: ids.invitationSecret,
      });
      expect(Object.keys(outboxRecord.payload as object).sort()).toEqual([
        'deliverySecretId',
        'invitationId',
        'operationId',
        'origin',
        'schemaVersion',
      ]);
      expect(secretRecord).toMatchObject({
        invitation_id: ids.invitation,
        recipient: 'invitee@household.test',
        token_hash: issued.tokenHash,
        template_version: 'invitation-redemption.v1',
        algorithm: 'RSA-OAEP-256',
        state: 'pending',
        envelope: issued.envelope,
      });
      expect(
        JSON.stringify({ invitationRecord, outboxRecord, secretRecord }),
      ).not.toContain(issued.plaintextToken);
      expect(String(issued.envelope.ciphertext)).not.toContain(
        issued.plaintextToken,
      );

      const invalid = await issueInvitation(app, {
        invitationId: ids.invalidInvitation,
        deliverySecretId: ids.invalidInvitationSecret,
        recipient: 'too-long@household.test',
        expiresInSeconds: 604_801,
      });
      expect(invalid.rows).toHaveLength(0);
      await expect(
        admin.query(`select 1 from emdo.invitations where id = $1`, [
          ids.invalidInvitation,
        ]),
      ).resolves.toMatchObject({ rowCount: 0 });

      const revoked = await withPrincipal(app, ownerPrincipal, () =>
        app.query(
          `select *
             from emdo.revoke_household_invitation(
               $1::uuid, $2::integer, $3::text, $4::text
             )`,
          [
            ids.invitation,
            1,
            `revoke-invitation:${ids.invitation}`,
            sha256(`revoke:${ids.invitation}:1`),
          ],
        ),
      );
      expect(revoked.rows).toEqual([
        expect.objectContaining({
          invitation_id: ids.invitation,
          state: 'revoked',
          version: 2,
          replayed: false,
        }),
      ]);
      await expect(
        admin.query(
          `select state, envelope, erased_at
             from emdo.invitation_delivery_secrets
            where id = $1`,
          [ids.invitationSecret],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            state: 'cancelled',
            envelope: null,
            erased_at: expect.any(Date),
          },
        ],
      });
    });

    it('uses exact +1 CAS under a same-target owner race and revokes every target session', async () => {
      const roleMutation = (
        client: import('pg').Client,
        principal: {
          readonly userId: string;
          readonly sessionId: string;
          readonly requestId: string;
        },
        contender: string,
      ) =>
        withPrincipal(client, principal, () =>
          client.query(
            `select *
               from emdo.change_household_membership_role(
                 $1::uuid, $2::integer, $3::text, $4::text, $5::text
               )`,
            [
              ids.roleTargetMembership,
              1,
              'owner',
              `change-role:${contender}:${ids.roleTargetMembership}`,
              sha256(
                `change-role:${contender}:${ids.roleTargetMembership}:1:owner`,
              ),
            ],
          ),
        );
      const contenders = await Promise.all([
        roleMutation(app, ownerPrincipal, 'owner-one'),
        roleMutation(concurrentApp, secondOwnerPrincipal, 'owner-two'),
      ]);
      const winners = contenders.filter((result) => result.rowCount === 1);
      const conflicts = contenders.filter((result) => result.rowCount === 0);
      expect(winners).toHaveLength(1);
      expect(conflicts).toHaveLength(1);
      expect(winners[0]?.rows).toEqual([
        expect.objectContaining({
          membership_id: ids.roleTargetMembership,
          role: 'owner',
          status: 'active',
          version: 2,
          replayed: false,
        }),
      ]);

      const deactivated = await withPrincipal(app, ownerPrincipal, () =>
        app.query(
          `select *
             from emdo.deactivate_household_membership(
               $1::uuid, $2::integer, $3::text, $4::text
             )`,
          [
            ids.deactivateTargetMembership,
            1,
            `deactivate:${ids.deactivateTargetMembership}`,
            sha256(`deactivate:${ids.deactivateTargetMembership}:1`),
          ],
        ),
      );
      expect(deactivated.rows).toEqual([
        expect.objectContaining({
          membership_id: ids.deactivateTargetMembership,
          status: 'inactive',
          version: 2,
          ended_at: expect.any(Date),
          replayed: false,
        }),
      ]);

      const sessions = await admin.query(
        `select user_id, pg_catalog.count(*)::integer as count
           from (
             select user_id from emdo.auth_sessions
             union all
             select user_id from emdo.rotating_sessions
           ) as target_sessions
          where user_id = any($1::uuid[])
          group by user_id`,
        [[ids.roleTargetUser, ids.deactivateTargetUser]],
      );
      expect(sessions.rows).toEqual([]);
      const ownerCount = await admin.query(
        `select pg_catalog.count(*)::integer as active_owner_count
           from emdo.household_memberships
          where household_id = $1
            and role = 'owner'
            and status = 'active'`,
        [ids.household],
      );
      expect(ownerCount.rows[0]?.active_owner_count).toBeGreaterThanOrEqual(1);
      await expect(
        admin.query(
          `select id, role, status, administration_version, ended_at
             from emdo.household_memberships
            where id = any($1::uuid[])
            order by id`,
          [[ids.roleTargetMembership, ids.deactivateTargetMembership]],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            id: ids.roleTargetMembership,
            role: 'owner',
            status: 'active',
            administration_version: 2,
            ended_at: null,
          },
          {
            id: ids.deactivateTargetMembership,
            role: 'member',
            status: 'inactive',
            administration_version: 2,
            ended_at: expect.any(Date),
          },
        ],
      });
    });

    it('rejects self lockout and preserves the last active owner', async () => {
      const solePrincipal = Object.freeze({
        userId: ids.soleOwnerUser,
        sessionId: ids.soleOwnerSession,
        requestId: ids.soleOwnerRequest,
      });
      await expectDatabaseError(
        () =>
          withPrincipal(app, solePrincipal, () =>
            app.query(
              `select *
                 from emdo.change_household_membership_role(
                   $1::uuid, 1, 'member', $2::text, $3::text
                 )`,
              [
                ids.soleOwnerMembership,
                `self-role:${ids.soleOwnerMembership}`,
                sha256(`self-role:${ids.soleOwnerMembership}`),
              ],
            ),
          ),
        { code: '55000', message: 'EMDO:self-lockout' },
      );
      await expectDatabaseError(
        () =>
          withPrincipal(app, solePrincipal, () =>
            app.query(
              `select *
                 from emdo.deactivate_household_membership(
                   $1::uuid, 1, $2::text, $3::text
                 )`,
              [
                ids.soleOwnerMembership,
                `self-deactivate:${ids.soleOwnerMembership}`,
                sha256(`self-deactivate:${ids.soleOwnerMembership}`),
              ],
            ),
          ),
        { code: '55000', message: 'EMDO:self-lockout' },
      );
      await expect(
        admin.query(
          `select pg_catalog.count(*)::integer as active_owner_count
             from emdo.household_memberships
            where household_id = $1
              and role = 'owner'
              and status = 'active'`,
          [ids.soleHousehold],
        ),
      ).resolves.toMatchObject({ rows: [{ active_owner_count: 1 }] });
    });

    it('keeps worker jobs reference-only and erases the sealed secret only after confirmed delivery', async () => {
      const issued = await issueInvitation(app, {
        invitationId: ids.workerInvitation,
        deliverySecretId: ids.workerInvitationSecret,
        recipient: 'worker-invitee@household.test',
      });
      expect(issued.rows).toHaveLength(1);

      const claims = await dispatcher.query(
        `select * from emdo.claim_due_worker_outbox($1::text, 100, 60000)`,
        ['household-admin-integration-dispatcher'],
      );
      const claimed = (claims.rows as readonly Record<string, unknown>[]).find(
        (row) =>
          (row.payload as Record<string, unknown> | undefined)?.invitationId ===
          ids.workerInvitation,
      );
      expect(claimed).toBeDefined();
      const outboxId = String(claimed?.outbox_id);
      const dispatchLeaseToken = String(claimed?.lease_token);
      expect(
        await dispatcher.query(
          `select emdo.bind_worker_outbox_queue_job(
                    $1::uuid, $2::uuid, $3::uuid, $4::text
                  ) as bound`,
          [
            outboxId,
            dispatchLeaseToken,
            ids.workerQueueJob,
            issued.payloadHash,
          ],
        ),
      ).toMatchObject({ rows: [{ bound: true }] });
      expect(
        await dispatcher.query(
          `select emdo.mark_worker_outbox_enqueued(
                    $1::uuid, $2::uuid, $3::uuid
                  ) as enqueued`,
          [outboxId, dispatchLeaseToken, ids.workerQueueJob],
        ),
      ).toMatchObject({ rows: [{ enqueued: true }] });

      await worker.query('begin');
      let workerLeaseToken: string;
      try {
        const acquired = await worker.query(
          `select *
             from emdo.acquire_worker_job_execution(
               $1::text, $2::text, $3::uuid, $4::text
             )`,
          [
            'emdo.invitation.delivery.v1',
            issued.operationId,
            ids.workerQueueJob,
            issued.payloadHash,
          ],
        );
        expect(acquired.rows).toEqual([
          expect.objectContaining({ status: 'acquired' }),
        ]);
        workerLeaseToken = String(acquired.rows[0]?.lease_token);
        const claimedScope = await worker.query(
          `select emdo.claim_worker_operation_scope(
                    $1::text, $2::text, $3::uuid, $4::text, $5::uuid,
                    'invitation', $6::text, 1, null::text, null::integer
                  ) as claimed`,
          [
            'emdo.invitation.delivery.v1',
            issued.operationId,
            ids.workerQueueJob,
            issued.payloadHash,
            workerLeaseToken,
            ids.workerInvitation,
          ],
        );
        expect(claimedScope.rows).toEqual([{ claimed: true }]);
        const capture = await worker.query(
          `select emdo.capture_invitation_delivery_secret(
                    $1::uuid, $2::uuid
                  ) as delivery`,
          [ids.workerInvitation, ids.workerInvitationSecret],
        );
        expect(capture.rows).toEqual([
          {
            delivery: {
              schemaVersion: 1,
              status: 'active',
              invitationId: ids.workerInvitation,
              deliverySecretId: ids.workerInvitationSecret,
              recipient: 'worker-invitee@household.test',
              role: 'member',
              tokenHash: issued.tokenHash,
              templateVersion: 'invitation-redemption.v1',
              envelope: issued.envelope,
            },
          },
        ]);
        expect(JSON.stringify(capture.rows)).not.toContain(
          issued.plaintextToken,
        );
        const indeterminate = await worker.query(
          `select emdo.settle_invitation_delivery_secret(
                    $1::uuid, $2::uuid, 'indeterminate'
                  ) as settlement`,
          [ids.workerInvitation, ids.workerInvitationSecret],
        );
        expect(indeterminate.rows).toEqual([
          { settlement: { status: 'settled' } },
        ]);
        await worker.query('commit');
      } catch (error) {
        await worker.query('rollback').catch(() => undefined);
        throw error;
      }

      await expect(
        admin.query(
          `select state, envelope, indeterminate_at, settled_at, erased_at
             from emdo.invitation_delivery_secrets
            where id = $1`,
          [ids.workerInvitationSecret],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            state: 'indeterminate',
            envelope: issued.envelope,
            indeterminate_at: expect.any(Date),
            settled_at: null,
            erased_at: null,
          },
        ],
      });

      await worker.query('begin');
      try {
        const reclaimed = await worker.query(
          `select emdo.claim_worker_operation_scope(
                    $1::text, $2::text, $3::uuid, $4::text, $5::uuid,
                    'invitation', $6::text, 1, null::text, null::integer
                  ) as claimed`,
          [
            'emdo.invitation.delivery.v1',
            issued.operationId,
            ids.workerQueueJob,
            issued.payloadHash,
            workerLeaseToken!,
            ids.workerInvitation,
          ],
        );
        expect(reclaimed.rows).toEqual([{ claimed: true }]);
        const confirmed = await worker.query(
          `select emdo.settle_invitation_delivery_secret(
                    $1::uuid, $2::uuid, 'confirmed'
                  ) as settlement`,
          [ids.workerInvitation, ids.workerInvitationSecret],
        );
        expect(confirmed.rows).toEqual([{ settlement: { status: 'settled' } }]);
        await worker.query('commit');
      } catch (error) {
        await worker.query('rollback').catch(() => undefined);
        throw error;
      }

      await expect(
        admin.query(
          `select state, envelope, settled_at, erased_at
             from emdo.invitation_delivery_secrets
            where id = $1`,
          [ids.workerInvitationSecret],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            state: 'confirmed',
            envelope: null,
            settled_at: expect.any(Date),
            erased_at: expect.any(Date),
          },
        ],
      });

      const replay = await issueInvitation(app, {
        invitationId: ids.workerInvitation,
        deliverySecretId: ids.workerInvitationSecret,
        recipient: 'worker-invitee@household.test',
      });
      expect(replay.rows).toHaveLength(1);
      expect(replay.rows[0]).toMatchObject({
        invitation_id: ids.workerInvitation,
        household_id: ids.household,
        email: 'worker-invitee@household.test',
        role: 'member',
        state: 'pending',
        version: 1,
        replayed: true,
        delivery_queued: true,
      });
      expect(replay.rows[0]?.created_at).toEqual(issued.rows[0]?.created_at);
      expect(replay.rows[0]?.expires_at).toEqual(issued.rows[0]?.expires_at);
      const durableArtifacts = await admin.query(
        `select
           (select pg_catalog.count(*)::integer
              from emdo.worker_operation_outbox
             where job_name = 'emdo.invitation.delivery.v1'
               and operation_id = $1) as outbox_count,
           (select pg_catalog.count(*)::integer
              from emdo.invitation_delivery_secrets
             where invitation_id = $2) as secret_count,
           (select state
              from emdo.invitation_delivery_secrets
             where invitation_id = $2) as secret_state,
           (select envelope
              from emdo.invitation_delivery_secrets
             where invitation_id = $2) as secret_envelope`,
        [issued.operationId, ids.workerInvitation],
      );
      expect(durableArtifacts.rows).toEqual([
        {
          outbox_count: 1,
          secret_count: 1,
          secret_state: 'confirmed',
          secret_envelope: null,
        },
      ]);
    });
  },
);

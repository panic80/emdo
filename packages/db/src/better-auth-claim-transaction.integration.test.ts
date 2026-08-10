import { randomUUID } from 'node:crypto';

import type { BetterAuthOptions } from 'better-auth';
import { makeSignature } from 'better-auth/crypto';
import { organization } from 'better-auth/plugins';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPostgresBetterAuthOrganizationClaimBridge,
  type PostgresBetterAuthOrganizationClaimBridge,
} from './better-auth-claim-transaction.js';
import { createEmdoBetterAuth } from '../../auth/src/better-auth.js';
import { loadOrderedMigrations } from './migrations.js';
import { betterAuthOrganizationPluginSchema } from './schema.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe.sequential : describe.skip;
const requiredDatabaseUrl =
  databaseUrl ?? 'postgresql://integration-test-unavailable.invalid/postgres';
const emdoRoles = [
  'emdo_app',
  'emdo_auth',
  'emdo_identity_reader',
  'emdo_onboarding',
  'emdo_onboarding_executor',
  'emdo_owner_bootstrap',
  'emdo_owner_bootstrap_executor',
  'emdo_policy_reader',
  'emdo_worker',
  'emdo_workflow',
] as const;

const userA = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f101';
const sessionA = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f102';
const householdA = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f103';
const userB = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f201';
const sessionB = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f202';
const householdB = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f203';
const unverifiedUser = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f301';
const unverifiedSession = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f302';
const invitationA = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f401';
const invitationB = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f402';
const authSecret = 'claim-bridge-integration-secret-at-least-32-bytes';

interface LiveEmdoAuth {
  readonly api: {
    readonly listOrganizations: (input: {
      readonly headers: Headers;
    }) => Promise<unknown>;
  };
  readonly handler: (request: Request) => Promise<Response>;
}

const quoteIdentifier = (value: string): string => {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new Error('Unsafe test-only PostgreSQL identifier.');
  }
  return `"${value}"`;
};

describeDatabase(
  'PostgreSQL Better Auth claim bridge (requires isolated PostgreSQL 17 TEST_DATABASE_URL)',
  () => {
    let adminPool: import('pg').Pool;
    let authPool: import('pg').Pool;
    let bridge: PostgresBetterAuthOrganizationClaimBridge;
    let emdoAuth: LiveEmdoAuth;
    let testDatabaseName = '';
    let authLoginRole = '';
    let ownsEmdoRoles = false;
    const generatedRequestIds: string[] = [];

    beforeAll(async () => {
      const { Pool } = await import('pg');
      adminPool = new Pool({
        allowExitOnIdle: true,
        connectionString: requiredDatabaseUrl,
        max: 1,
      });
      const server = await adminPool.query<{
        server_version_num: string;
      }>("select current_setting('server_version_num') as server_version_num");
      expect(Number(server.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(
        170_000,
      );

      const preexistingRoles = await adminPool.query<{ rolname: string }>(
        `select rolname from pg_catalog.pg_roles where rolname = any($1::text[])`,
        [emdoRoles],
      );
      if (preexistingRoles.rows.length > 0) {
        throw new Error(
          'Claim-bridge live tests require an isolated PostgreSQL cluster without preexisting EMDO roles.',
        );
      }

      const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
      testDatabaseName = `emdo_claim_${suffix}`;
      authLoginRole = `emdo_auth_login_${suffix}`;
      const authPassword = `claim_${suffix}_${randomUUID().replaceAll('-', '')}`;
      await adminPool.query(
        `create database ${quoteIdentifier(testDatabaseName)}`,
      );

      const setupUrl = new URL(requiredDatabaseUrl);
      setupUrl.pathname = `/${testDatabaseName}`;
      const setupPool = new Pool({
        allowExitOnIdle: true,
        connectionString: setupUrl.toString(),
        max: 1,
      });
      try {
        ownsEmdoRoles = true;
        for (const migration of await loadOrderedMigrations()) {
          await setupPool.query(migration.sql);
        }

        await setupPool.query(
          `insert into emdo.auth_users (id, name, email, email_verified)
           values
             ($1, 'Owner A', 'owner-a@example.test', true),
             ($2, 'Owner B', 'owner-b@example.test', true),
             ($3, 'Unverified', 'unverified@example.test', false)`,
          [userA, userB, unverifiedUser],
        );
        await setupPool.query(
          `insert into emdo.households (id, name, slug, created_by_user_id)
           values
             ($1, 'Household A', 'claim-household-a', $2),
             ($3, 'Household B', 'claim-household-b', $4)`,
          [householdA, userA, householdB, userB],
        );
        await setupPool.query(
          `insert into emdo.household_memberships
             (household_id, user_id, role, status)
           values
             ($1, $2, 'owner', 'active'),
             ($3, $4, 'owner', 'active')`,
          [householdA, userA, householdB, userB],
        );
        await setupPool.query(
          `insert into emdo.auth_sessions
             (id, user_id, token, expires_at)
           values
             ($1, $2, 'claim-session-a', pg_catalog.clock_timestamp() + interval '1 hour'),
             ($3, $4, 'claim-session-b', pg_catalog.clock_timestamp() + interval '1 hour'),
             ($5, $6, 'claim-session-unverified', pg_catalog.clock_timestamp() + interval '1 hour')`,
          [sessionA, userA, sessionB, userB, unverifiedSession, unverifiedUser],
        );
        await setupPool.query(
          `insert into emdo.invitations
             (id, household_id, invited_by_user_id, email, role, token_hash,
              created_at, expires_at)
           values
             ($1, $2, $3, 'invite-a@example.test', 'member', $4,
              pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp() + interval '6 days'),
             ($5, $6, $7, 'invite-b@example.test', 'member', $8,
              pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp() + interval '6 days')`,
          [
            invitationA,
            householdA,
            userA,
            'a'.repeat(64),
            invitationB,
            householdB,
            userB,
            'b'.repeat(64),
          ],
        );
      } finally {
        await setupPool.end();
      }

      await adminPool.query(
        `create role ${quoteIdentifier(authLoginRole)}
           login nosuperuser nocreatedb nocreaterole inherit nobypassrls noreplication
           password '${authPassword}'`,
      );
      await adminPool.query(
        `grant emdo_auth to ${quoteIdentifier(authLoginRole)}
           with admin false, inherit true, set true`,
      );

      const authUrl = new URL(requiredDatabaseUrl);
      authUrl.pathname = `/${testDatabaseName}`;
      authUrl.username = authLoginRole;
      authUrl.password = authPassword;
      authPool = new Pool({
        allowExitOnIdle: true,
        connectionString: authUrl.toString(),
        max: 2,
      });
      bridge = await createPostgresBetterAuthOrganizationClaimBridge(authPool, {
        createRequestId: () => {
          const id = randomUUID();
          generatedRequestIds.push(id);
          return id;
        },
      });
      emdoAuth = createEmdoBetterAuth({
        appName: 'EMDO claim bridge PostgreSQL integration',
        baseURL: 'https://claim-bridge.emdo.test',
        googleIdentity: {
          clientId: 'claim-bridge-google-client',
          clientSecret: 'claim-bridge-google-secret',
        },
        organizationClaimBridge: bridge,
        secret: authSecret,
        sendInvitationEmail: async () => undefined,
        sendPasswordResetEmail: async () => undefined,
        sendVerificationEmail: async () => undefined,
        trustedOrigins: ['https://claim-bridge.emdo.test'],
      }) as unknown as LiveEmdoAuth;
    }, 60_000);

    afterAll(async () => {
      if (authPool !== undefined) await authPool.end();
      if (adminPool === undefined) return;
      if (testDatabaseName !== '') {
        await adminPool.query(
          `drop database if exists ${quoteIdentifier(testDatabaseName)} with (force)`,
        );
      }
      if (authLoginRole !== '') {
        await adminPool.query(
          `drop role if exists ${quoteIdentifier(authLoginRole)}`,
        );
      }
      if (ownsEmdoRoles) {
        for (const role of [...emdoRoles].reverse()) {
          await adminPool.query(`drop role if exists ${quoteIdentifier(role)}`);
        }
      }
      await adminPool.end();
    }, 60_000);

    const authOptions = (): BetterAuthOptions => ({
      appName: 'EMDO claim bridge PostgreSQL integration',
      baseURL: 'https://claim-bridge.emdo.test',
      database: bridge.database,
      plugins: [
        organization({
          allowUserToCreateOrganization: false,
          dynamicAccessControl: { enabled: false },
          schema: betterAuthOrganizationPluginSchema,
        }),
      ],
      secret: authSecret,
    });

    const sessionHeaders = async (token: string): Promise<Headers> => {
      const signature = await makeSignature(token, authSecret);
      return new Headers({
        cookie: `__Secure-emdo.session_token=${token}.${signature}`,
      });
    };

    it('uses the claimed PoolClient adapter and fails closed before activation', async () => {
      const result = await bridge.run(authOptions(), async (transaction) => {
        const before: { id: string }[][] = [];
        for (const model of ['organization', 'member', 'invitation']) {
          before.push(
            await transaction.adapter.findMany<{ id: string }>({ model }),
          );
        }
        await transaction.revalidateAndActivateClaims({
          sessionId: sessionA,
          userId: userA,
        });
        const organizations = await transaction.adapter.findMany<{
          id: string;
          slug: string;
        }>({ model: 'organization' });
        const member = await transaction.adapter.findOne<{
          id: string;
          organizationId: string;
          userId: string;
        }>({
          model: 'member',
          where: [
            { field: 'organizationId', value: householdA },
            { field: 'userId', value: userA },
          ],
        });
        const invitation = await transaction.adapter.findOne<{
          email: string;
          id: string;
          organizationId: string;
        }>({
          model: 'invitation',
          where: [{ field: 'id', value: invitationA }],
        });
        const foreignOrganization = await transaction.adapter.findOne<{
          id: string;
        }>({
          model: 'organization',
          where: [{ field: 'id', value: householdB }],
        });
        return {
          before,
          foreignOrganization,
          invitation,
          member,
          organizations,
        };
      });

      expect(result.before).toEqual([[], [], []]);
      expect(result.organizations).toEqual([
        expect.objectContaining({ id: householdA, slug: 'claim-household-a' }),
      ]);
      expect(result.member).toEqual(
        expect.objectContaining({
          organizationId: householdA,
          userId: userA,
        }),
      );
      expect(result.invitation).toEqual(
        expect.objectContaining({
          email: 'invite-a@example.test',
          id: invitationA,
          organizationId: householdA,
        }),
      );
      expect(result.invitation).not.toHaveProperty('tokenHash');
      expect(result.foreignOrganization).toBeNull();
    });

    it('composes the real HTTP and direct Better Auth organization facades with the bridge', async () => {
      const headers = await sessionHeaders('claim-session-a');
      const response = await emdoAuth.handler(
        new Request(
          'https://claim-bridge.emdo.test/api/auth/organization/list',
          { headers },
        ),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual([
        expect.objectContaining({ id: householdA, slug: 'claim-household-a' }),
      ]);
      await expect(
        emdoAuth.api.listOrganizations({ headers }),
      ).resolves.toEqual([
        expect.objectContaining({ id: householdA, slug: 'claim-household-a' }),
      ]);
    });

    it('rolls back an unverified identity and clears local role/claims on reuse', async () => {
      await expect(
        bridge.run(authOptions(), async ({ revalidateAndActivateClaims }) => {
          await revalidateAndActivateClaims({
            sessionId: unverifiedSession,
            userId: unverifiedUser,
          });
        }),
      ).rejects.toThrow('The authenticated session is no longer eligible.');

      const clients = await Promise.all([
        authPool.connect(),
        authPool.connect(),
      ]);
      try {
        for (const client of clients) {
          const state = await client.query<{
            request_id: string | null;
            role_reset: boolean;
            session_id: string | null;
            user_id: string | null;
          }>(`select
               current_user = session_user as role_reset,
               nullif(pg_catalog.current_setting('emdo.user_id', true), '') as user_id,
               nullif(pg_catalog.current_setting('emdo.session_id', true), '') as session_id,
               nullif(pg_catalog.current_setting('emdo.request_id', true), '') as request_id`);
          expect(state.rows[0]).toEqual({
            request_id: null,
            role_reset: true,
            session_id: null,
            user_id: null,
          });
        }
      } finally {
        for (const client of clients) client.release();
      }
    });

    it('keeps two interleaved household claims isolated and request IDs unique', async () => {
      let arrivals = 0;
      let releaseBarrier: (() => void) | undefined;
      const barrier = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
      const runFor = async (identity: {
        readonly sessionId: string;
        readonly userId: string;
      }) =>
        bridge.run(authOptions(), async (transaction) => {
          await transaction.revalidateAndActivateClaims(identity);
          arrivals += 1;
          if (arrivals === 2) releaseBarrier?.();
          await barrier;
          return transaction.adapter.findMany<{ id: string }>({
            model: 'organization',
          });
        });
      const requestCountBefore = generatedRequestIds.length;

      const [organizationsA, organizationsB] = await Promise.all([
        runFor({ sessionId: sessionA, userId: userA }),
        runFor({ sessionId: sessionB, userId: userB }),
      ]);

      expect(organizationsA.map(({ id }) => id)).toEqual([householdA]);
      expect(organizationsB.map(({ id }) => id)).toEqual([householdB]);
      const concurrentRequestIds =
        generatedRequestIds.slice(requestCountBefore);
      expect(concurrentRequestIds).toHaveLength(2);
      expect(new Set(concurrentRequestIds).size).toBe(2);
    });
  },
);

import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadOrderedMigrations } from './migrations.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const sessionId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f002';
const requestId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f003';
const foundationRoleNames = [
  'emdo_app',
  'emdo_auth',
  'emdo_worker',
  'emdo_workflow',
  'emdo_policy_reader',
] as const;

describeDatabase(
  'PostgreSQL RLS integration (requires TEST_DATABASE_URL)',
  () => {
    let client: import('pg').Client;

    beforeAll(async () => {
      const { Client } = await import('pg');
      client = new Client({ connectionString: databaseUrl });
      await client.connect();
      await client.query('begin');
      for (const roleName of foundationRoleNames) {
        await client.query(`do $role$
          begin
            if exists (
              select 1 from pg_catalog.pg_roles where rolname = '${roleName}'
            ) then
              alter role ${roleName} login superuser createdb createrole inherit bypassrls replication;
            else
              create role ${roleName} login superuser createdb createrole inherit bypassrls replication;
            end if;
          end
        $role$`);
      }
      await client.query(
        'create role emdo_test_bypass_parent nologin bypassrls',
      );
      await client.query('grant emdo_test_bypass_parent to emdo_app');
      for (const migration of await loadOrderedMigrations()) {
        await client.query(migration.sql);
        if (migration.id === '0000_household_foundation') {
          await client.query(`
            grant select (token_hash),
              insert (consumed_at, consumed_by_user_id, consumed_session_id, revoked_at),
              update (email, role, token_hash, expires_at, consumed_at,
                consumed_by_user_id, consumed_session_id)
            on emdo.invitations to emdo_app, emdo_auth
          `);
        }
      }
    });

    afterAll(async () => {
      if (client !== undefined) {
        await client.query('rollback');
        await client.end();
      }
    });

    it('lets an owner administer membership without reading another member private content', async () => {
      const owner = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f001';
      const member = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f002';
      const outsider = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f003';
      const household = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f010';
      const otherHousehold = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f011';
      const ownerSpace = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f020';
      const memberSpace = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f021';
      const sharedSpace = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f022';

      await client.query(
        `insert into emdo.auth_users (id, name, email, email_verified)
       values ($1, 'Owner', 'owner@example.test', true),
              ($2, 'Member', 'member@example.test', true),
              ($3, 'Outsider', 'outsider@example.test', true)`,
        [owner, member, outsider],
      );
      await client.query(
        `insert into emdo.households (id, name, slug, created_by_user_id)
       values ($1, 'Household A', 'household-a', $2),
              ($3, 'Household B', 'household-b', $4)`,
        [household, owner, otherHousehold, outsider],
      );
      await client.query(
        `insert into emdo.household_memberships
         (household_id, user_id, role, status, joined_at)
       values ($1, $2, 'owner', 'active', now()),
              ($1, $3, 'member', 'active', now()),
              ($4, $5, 'owner', 'active', now())`,
        [household, owner, member, otherHousehold, outsider],
      );
      await client.query(
        `insert into emdo.spaces
         (id, household_id, original_owner_user_id, name, visibility)
       values ($1, $4, $5, 'Owner private', 'private'),
              ($2, $4, $6, 'Member private', 'private'),
              ($3, $4, $6, 'Shared', 'shared')`,
        [ownerSpace, memberSpace, sharedSpace, household, owner, member],
      );
      await client.query(
        `insert into emdo.auth_sessions
           (id, user_id, token, expires_at, active_household_id)
         values ($1, $2, 'rls-foundation-owner-session',
                 pg_catalog.clock_timestamp() + interval '1 hour', $3)`,
        [sessionId, owner, household],
      );

      await client.query('set local role emdo_app');
      await client.query(
        "select set_config('emdo.user_id', $1, true), set_config('emdo.session_id', $2, true), set_config('emdo.request_id', $3, true)",
        [owner, sessionId, requestId],
      );

      const spaces = await client.query<{ id: string }>(
        'select id from emdo.spaces order by id',
      );
      expect(spaces.rows.map(({ id }) => id)).toEqual([
        ownerSpace,
        sharedSpace,
      ]);

      await client.query('savepoint raw_membership_read');
      await expect(
        client.query(
          'select user_id from emdo.household_memberships where household_id = $1 order by user_id',
          [household],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('rollback to savepoint raw_membership_read');

      const memberships = await client.query<{ user_id: string }>(
        'select user_id from emdo.list_household_memberships() order by user_id',
      );
      expect(memberships.rows.map(({ user_id }) => user_id)).toEqual([
        owner,
        member,
      ]);

      await client.query('reset role');
    });

    it('fails closed when the transaction identity claim is absent', async () => {
      await client.query('set local role emdo_app');
      await client.query("select set_config('emdo.user_id', '', true)");
      const result = await client.query('select id from emdo.spaces');
      expect(result.rows).toEqual([]);
      await client.query('reset role');
    });

    it('keeps identity views read-only and onboarding callable only through its routine', async () => {
      const privileges = await client.query<{
        auth_can_read_invitation_base: boolean;
        auth_can_read_invitation_token: boolean;
        auth_can_read_invitation_view: boolean;
        auth_can_update_invitation_email: boolean;
        auth_can_write_invitation_base: boolean;
        auth_can_write_membership_base: boolean;
        onboarding_can_execute: boolean;
        onboarding_can_execute_raw: boolean;
        onboarding_can_read_invitation_base: boolean;
        onboarding_can_write_user_base: boolean;
      }>(`select
        has_table_privilege('emdo_auth', 'emdo.invitations', 'SELECT')
          as auth_can_read_invitation_base,
        has_table_privilege('emdo_auth', 'emdo.better_auth_invitations', 'SELECT')
          as auth_can_read_invitation_view,
        has_column_privilege(
          'emdo_auth', 'emdo.invitations', 'token_hash', 'SELECT'
        ) as auth_can_read_invitation_token,
        has_column_privilege(
          'emdo_auth', 'emdo.invitations', 'email', 'UPDATE'
        ) as auth_can_update_invitation_email,
        (
          has_table_privilege('emdo_auth', 'emdo.invitations', 'INSERT')
          or has_table_privilege('emdo_auth', 'emdo.invitations', 'UPDATE')
          or has_table_privilege('emdo_auth', 'emdo.invitations', 'DELETE')
        )
          as auth_can_write_invitation_base,
        (
          has_table_privilege('emdo_auth', 'emdo.household_memberships', 'INSERT')
          or has_table_privilege('emdo_auth', 'emdo.household_memberships', 'UPDATE')
          or has_table_privilege('emdo_auth', 'emdo.household_memberships', 'DELETE')
        )
          as auth_can_write_membership_base,
        has_function_privilege(
          'emdo_onboarding',
          'emdo.redeem_household_invitation(integer,uuid,text,text,text,text,text,uuid)',
          'EXECUTE'
        ) as onboarding_can_execute,
        has_function_privilege(
          'emdo_onboarding',
          'emdo.provision_invited_account(uuid,text,text,text,text)',
          'EXECUTE'
        ) as onboarding_can_execute_raw,
        has_table_privilege('emdo_onboarding', 'emdo.invitations', 'SELECT')
          as onboarding_can_read_invitation_base,
        has_table_privilege('emdo_onboarding', 'emdo.auth_users', 'INSERT')
          as onboarding_can_write_user_base`);

      expect(privileges.rows[0]).toEqual({
        auth_can_read_invitation_base: false,
        auth_can_read_invitation_token: false,
        auth_can_read_invitation_view: true,
        auth_can_update_invitation_email: false,
        auth_can_write_invitation_base: false,
        auth_can_write_membership_base: false,
        onboarding_can_execute: true,
        onboarding_can_execute_raw: false,
        onboarding_can_read_invitation_base: false,
        onboarding_can_write_user_base: false,
      });

      const roles = await client.query<{
        role_memberships: string;
        rolbypassrls: boolean;
        rolcanlogin: boolean;
        rolname: string;
        rolsuper: boolean;
      }>(`select role.rolname, role.rolcanlogin, role.rolsuper,
                 role.rolbypassrls,
                 (
                   select count(*)::text
                     from pg_catalog.pg_auth_members membership
                    where membership.roleid = role.oid
                       or membership.member = role.oid
                 ) as role_memberships
            from pg_catalog.pg_roles role
           where role.rolname in (
             'emdo_identity_reader',
             'emdo_onboarding',
             'emdo_onboarding_executor'
           )
           order by role.rolname`);
      expect(roles.rows).toHaveLength(3);
      for (const role of roles.rows) {
        expect(role).toMatchObject({
          role_memberships: '0',
          rolbypassrls: false,
          rolcanlogin: false,
          rolsuper: false,
        });
      }

      const parentAccess = await client.query<{
        can_set_bypass_parent: boolean;
        direct_parent_memberships: string;
      }>(`select
        pg_catalog.pg_has_role(
          'emdo_app', 'emdo_test_bypass_parent', 'SET'
        ) as can_set_bypass_parent,
        (
          select count(*)::text
            from pg_catalog.pg_auth_members membership
            join pg_catalog.pg_roles child on child.oid = membership.member
           where child.rolname = 'emdo_app'
        ) as direct_parent_memberships`);
      expect(parentAccess.rows[0]).toEqual({
        can_set_bypass_parent: false,
        direct_parent_memberships: '0',
      });
    });

    it('rehardens preexisting foundation roles against login and RLS bypass', async () => {
      const roles = await client.query<{
        rolbypassrls: boolean;
        rolcanlogin: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolinherit: boolean;
        rolname: string;
        rolreplication: boolean;
        rolsuper: boolean;
      }>(
        `select rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
                 rolinherit, rolbypassrls, rolreplication
            from pg_catalog.pg_roles
           where rolname = any($1::text[])
           order by rolname`,
        [foundationRoleNames],
      );

      expect(roles.rows).toHaveLength(foundationRoleNames.length);
      for (const role of roles.rows) {
        expect(role).toMatchObject({
          rolbypassrls: false,
          rolcanlogin: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolinherit: false,
          rolreplication: false,
          rolsuper: false,
        });
      }
    });

    it('fails closed and prevents direct identity-view enumeration across households', async () => {
      const owner = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f001';
      const member = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f002';
      const outsider = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f003';
      const household = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f010';
      const otherHousehold = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f011';

      await client.query(
        `insert into emdo.invitations
           (id, household_id, invited_by_user_id, email, role, token_hash,
            created_at, expires_at)
         values
           ('018f1f5e-6f47-7d61-a6dd-1e86f8b8f041', $1, $2,
            'household-a-invite@example.test', 'member', $3,
            now(), now() + interval '7 days'),
           ('018f1f5e-6f47-7d61-a6dd-1e86f8b8f042', $4, $5,
            'household-b-invite@example.test', 'member', $6,
            now(), now() + interval '7 days')`,
        [
          household,
          owner,
          'a'.repeat(64),
          otherHousehold,
          outsider,
          'b'.repeat(64),
        ],
      );

      await client.query('set local role emdo_auth');
      await client.query("select set_config('emdo.user_id', '', true)");
      for (const view of [
        'better_auth_organizations',
        'active_household_memberships',
        'better_auth_invitations',
      ]) {
        const unscoped = await client.query(`select * from emdo.${view}`);
        expect(unscoped.rows, `${view} must fail closed`).toEqual([]);
      }

      await client.query("select set_config('emdo.user_id', $1, true)", [
        owner,
      ]);
      const ownerOrganizations = await client.query<{ id: string }>(
        'select id from emdo.better_auth_organizations order by id',
      );
      const ownerMemberships = await client.query<{ user_id: string }>(
        'select user_id from emdo.active_household_memberships order by user_id',
      );
      const ownerInvitations = await client.query<{ email: string }>(
        'select email from emdo.better_auth_invitations order by email',
      );
      expect(ownerOrganizations.rows.map(({ id }) => id)).toEqual([household]);
      expect(ownerMemberships.rows.map(({ user_id }) => user_id)).toEqual([
        owner,
        member,
      ]);
      expect(ownerInvitations.rows.map(({ email }) => email)).toEqual([
        'household-a-invite@example.test',
      ]);

      await client.query("select set_config('emdo.user_id', $1, true)", [
        outsider,
      ]);
      const outsiderOrganizations = await client.query<{ id: string }>(
        'select id from emdo.better_auth_organizations order by id',
      );
      const outsiderInvitations = await client.query<{ email: string }>(
        'select email from emdo.better_auth_invitations order by email',
      );
      expect(outsiderOrganizations.rows.map(({ id }) => id)).toEqual([
        otherHousehold,
      ]);
      expect(outsiderInvitations.rows.map(({ email }) => email)).toEqual([
        'household-b-invite@example.test',
      ]);
      await client.query('reset role');
    });

    it('provisions an invitation exactly once without exposing the new private space to the owner', async () => {
      const owner = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f001';
      const household = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f010';
      const invitation = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f040';
      const deliverySecret = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f042';
      const tokenHash = 'd'.repeat(64);
      const passwordHash = `${'e'.repeat(32)}:${'f'.repeat(128)}`;
      const operationId = `invitation:${invitation}`;
      const payloadHash = createHash('sha256')
        .update('emdo.invitation.delivery.v1')
        .update('\0')
        .update(
          JSON.stringify({
            deliverySecretId: deliverySecret,
            invitationId: invitation,
            operationId,
            origin: 'deterministic-worker',
            schemaVersion: 1,
          }),
        )
        .digest('hex');

      await client.query('set local role emdo_app');
      await client.query(
        "select set_config('emdo.user_id', $1, true), set_config('emdo.session_id', $2, true), set_config('emdo.request_id', $3, true)",
        [owner, sessionId, requestId],
      );
      const issued = await client.query<{ invitation_id: string }>(
        `select invitation_id
           from emdo.issue_household_invitation(
             'new-member@example.test', 'member', 604800, $1, $2, $3,
             $4::uuid, $5, $6::uuid, 'invitation-redemption.v1',
             $7::jsonb, $8
           )`,
        [
          tokenHash,
          'invitation-issue:rls-0001',
          'a'.repeat(64),
          invitation,
          operationId,
          deliverySecret,
          JSON.stringify({
            algorithm: 'RSA-OAEP-256',
            bindingHash: 'b'.repeat(64),
            ciphertext: 'A'.repeat(64),
            keyId: 'rls-foundation-test-key',
            schemaVersion: 1,
          }),
          payloadHash,
        ],
      );
      expect(issued.rows).toEqual([{ invitation_id: invitation }]);
      await client.query('reset role');

      await client.query('set local role emdo_onboarding');
      const provisioned = await client.query<{
        result: {
          emailVerified: boolean;
          householdId: string;
          role: string;
          schemaVersion: number;
          userId: string;
        };
        status: string;
      }>(
        `select * from emdo.redeem_household_invitation(
           1, $1::uuid, $2::text, 'new-member@example.test'::text,
           'New Member'::text, $3::text, $4::text, $5::uuid
         )`,
        [
          invitation,
          tokenHash,
          passwordHash,
          'invitation-redemption:rls-0001',
          '018f1f5e-6f47-7d61-a6dd-1e86f8b8f041',
        ],
      );
      expect(provisioned.rows).toHaveLength(1);
      expect(provisioned.rows[0]).toMatchObject({
        status: 'provisioned',
        result: {
          emailVerified: true,
          householdId: household,
          role: 'member',
          schemaVersion: 1,
        },
      });
      const replay = await client.query(
        `select * from emdo.redeem_household_invitation(
           1, $1::uuid, $2::text, 'new-member@example.test'::text,
           'New Member'::text, $3::text, $4::text, $5::uuid
         )`,
        [
          invitation,
          tokenHash,
          passwordHash,
          'invitation-redemption:rls-0001',
          '018f1f5e-6f47-7d61-a6dd-1e86f8b8f041',
        ],
      );
      expect(replay.rows).toEqual([
        {
          status: 'replay',
          result: provisioned.rows[0]?.result,
        },
      ]);
      await client.query('reset role');

      await client.query('set local role emdo_app');
      const newUserId = provisioned.rows[0]?.result.userId;
      const hiddenPrivateSpaces = await client.query(
        `select id from emdo.spaces
          where household_id = $1 and original_owner_user_id = $2`,
        [household, newUserId],
      );
      const hiddenPrivateAudit = await client.query(
        `select id from emdo.audit_events
          where household_id = $1 and original_owner_user_id = $2`,
        [household, newUserId],
      );
      expect(hiddenPrivateSpaces.rows).toEqual([]);
      expect(hiddenPrivateAudit.rows).toEqual([]);
      await client.query('reset role');
    });

    it('hides invitation token hashes and permits only one-way owner revocation', async () => {
      const owner = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f001';
      const invitation = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f043';
      const deliverySecret = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f044';
      const tokenHash = 'c'.repeat(64);
      const operationId = `invitation:${invitation}`;
      const payloadHash = createHash('sha256')
        .update('emdo.invitation.delivery.v1')
        .update('\0')
        .update(
          JSON.stringify({
            deliverySecretId: deliverySecret,
            invitationId: invitation,
            operationId,
            origin: 'deterministic-worker',
            schemaVersion: 1,
          }),
        )
        .digest('hex');

      const privileges = await client.query<{
        can_insert_token_hash: boolean;
        can_read_email: boolean;
        can_read_token_hash: boolean;
        can_update_consumed_at: boolean;
        can_update_email: boolean;
        can_update_expires_at: boolean;
        can_update_revoked_at: boolean;
        can_update_role: boolean;
        can_update_token_hash: boolean;
        table_insert: boolean;
        table_select: boolean;
        table_update: boolean;
      }>(`select
        has_table_privilege('emdo_app', 'emdo.invitations', 'SELECT') as table_select,
        has_table_privilege('emdo_app', 'emdo.invitations', 'INSERT') as table_insert,
        has_table_privilege('emdo_app', 'emdo.invitations', 'UPDATE') as table_update,
        has_column_privilege('emdo_app', 'emdo.invitations', 'email', 'SELECT') as can_read_email,
        has_column_privilege('emdo_app', 'emdo.invitations', 'token_hash', 'SELECT') as can_read_token_hash,
        has_column_privilege('emdo_app', 'emdo.invitations', 'token_hash', 'INSERT') as can_insert_token_hash,
        has_column_privilege('emdo_app', 'emdo.invitations', 'email', 'UPDATE') as can_update_email,
        has_column_privilege('emdo_app', 'emdo.invitations', 'role', 'UPDATE') as can_update_role,
        has_column_privilege('emdo_app', 'emdo.invitations', 'token_hash', 'UPDATE') as can_update_token_hash,
        has_column_privilege('emdo_app', 'emdo.invitations', 'expires_at', 'UPDATE') as can_update_expires_at,
        has_column_privilege('emdo_app', 'emdo.invitations', 'consumed_at', 'UPDATE') as can_update_consumed_at,
        has_column_privilege('emdo_app', 'emdo.invitations', 'revoked_at', 'UPDATE') as can_update_revoked_at`);
      expect(privileges.rows[0]).toEqual({
        can_insert_token_hash: false,
        can_read_email: false,
        can_read_token_hash: false,
        can_update_consumed_at: false,
        can_update_email: false,
        can_update_expires_at: false,
        can_update_revoked_at: false,
        can_update_role: false,
        can_update_token_hash: false,
        table_insert: false,
        table_select: false,
        table_update: false,
      });

      await client.query('set local role emdo_app');
      await client.query(
        "select set_config('emdo.user_id', $1, true), set_config('emdo.session_id', $2, true), set_config('emdo.request_id', $3, true)",
        [owner, sessionId, requestId],
      );
      const issued = await client.query<{
        invitation_id: string;
        state: string;
        version: number;
      }>(
        `select invitation_id, state, version
           from emdo.issue_household_invitation(
             'revocable@example.test', 'member', 604800, $1, $2, $3,
             $4::uuid, $5, $6::uuid, 'invitation-redemption.v1',
             $7::jsonb, $8
           )`,
        [
          tokenHash,
          'invitation-issue:rls-0002',
          'c'.repeat(64),
          invitation,
          operationId,
          deliverySecret,
          JSON.stringify({
            algorithm: 'RSA-OAEP-256',
            bindingHash: 'd'.repeat(64),
            ciphertext: 'B'.repeat(64),
            keyId: 'rls-foundation-test-key',
            schemaVersion: 1,
          }),
          payloadHash,
        ],
      );
      expect(issued.rows).toEqual([
        { invitation_id: invitation, state: 'pending', version: 1 },
      ]);
      const safeSummary = await client.query<{
        email: string;
        role: string;
        state: string;
        version: number;
      }>(
        `select email, role, state, version
           from emdo.list_household_invitations()
          where invitation_id = $1`,
        [invitation],
      );
      expect(safeSummary.rows).toEqual([
        {
          email: 'revocable@example.test',
          role: 'member',
          state: 'pending',
          version: 1,
        },
      ]);

      await client.query('savepoint token_read_denied');
      await expect(
        client.query('select token_hash from emdo.invitations where id = $1', [
          invitation,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('rollback to savepoint token_read_denied');

      for (const [savepoint, statement] of [
        [
          'email_update_denied',
          "update emdo.invitations set email = 'changed@example.test' where id = $1",
        ],
        [
          'role_update_denied',
          "update emdo.invitations set role = 'owner' where id = $1",
        ],
        [
          'token_update_denied',
          `update emdo.invitations set token_hash = '${'f'.repeat(64)}' where id = $1`,
        ],
        [
          'expiry_update_denied',
          "update emdo.invitations set expires_at = expires_at - interval '1 day' where id = $1",
        ],
        [
          'consume_update_denied',
          'update emdo.invitations set consumed_at = now() where id = $1',
        ],
        [
          'direct_revoke_denied',
          'update emdo.invitations set revoked_at = now() where id = $1',
        ],
      ] as const) {
        await client.query(`savepoint ${savepoint}`);
        await expect(
          client.query(statement, [invitation]),
        ).rejects.toMatchObject({ code: '42501' });
        await client.query(`rollback to savepoint ${savepoint}`);
      }

      const revoked = await client.query<{
        replayed: boolean;
        state: string;
        version: number;
      }>(
        `select state, version, replayed
           from emdo.revoke_household_invitation($1, 1, $2, $3)`,
        [invitation, 'invitation-revoke:rls-0001', 'e'.repeat(64)],
      );
      expect(revoked.rows).toEqual([
        { replayed: false, state: 'revoked', version: 2 },
      ]);

      const revokeReplay = await client.query<{
        replayed: boolean;
        state: string;
        version: number;
      }>(
        `select state, version, replayed
           from emdo.revoke_household_invitation($1, 1, $2, $3)`,
        [invitation, 'invitation-revoke:rls-0001', 'e'.repeat(64)],
      );
      expect(revokeReplay.rows).toEqual([
        { replayed: true, state: 'revoked', version: 2 },
      ]);

      await client.query('savepoint clear_revocation_denied');
      await expect(
        client.query(
          'update emdo.invitations set revoked_at = null where id = $1',
          [invitation],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('rollback to savepoint clear_revocation_denied');
      await client.query('reset role');

      const stored = await client.query<{
        email: string;
        administration_version: number;
        revoked_at: Date | null;
        token_hash: string;
      }>(
        `select email, token_hash, revoked_at, administration_version
           from emdo.invitations where id = $1`,
        [invitation],
      );
      expect(stored.rows[0]).toMatchObject({
        administration_version: 2,
        email: 'revocable@example.test',
        token_hash: tokenHash,
      });
      expect(stored.rows[0]?.revoked_at).not.toBeNull();

      await client.query('savepoint immutable_envelope');
      await expect(
        client.query(
          "update emdo.invitations set email = 'superuser-change@example.test' where id = $1",
          [invitation],
        ),
      ).rejects.toMatchObject({ code: '55000' });
      await client.query('rollback to savepoint immutable_envelope');
    });

    it('rejects updates and deletes of append-only events', async () => {
      const user = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f001';
      const space = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f020';
      const event = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f030';

      await client.query(
        `insert into emdo.audit_events
         (id, household_id, space_id, original_owner_user_id, actor_user_id,
          event_type, payload)
       select $1, s.household_id, s.id, $2, $2, 'test.append-only', '{}'::jsonb
       from emdo.spaces s where s.id = $3`,
        [event, user, space],
      );
      await expect(
        client.query(
          'update emdo.audit_events set payload = \'{"changed":true}\' where id = $1',
          [event],
        ),
      ).rejects.toMatchObject({ code: '55000' });
    });
  },
);

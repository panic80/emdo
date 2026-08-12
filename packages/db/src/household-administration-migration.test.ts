import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../drizzle/0005_household_administration.sql',
  import.meta.url,
);
const prerequisiteMigrationUrl = new URL(
  '../drizzle/0003_durable_runtime_repositories.sql',
  import.meta.url,
);

describe('household administration migration', () => {
  it('keeps the membership CAS prerequisite in 0003 and invitation versioning in 0005', async () => {
    const [prerequisiteSql, sql] = await Promise.all([
      readFile(prerequisiteMigrationUrl, 'utf8'),
      readFile(migrationUrl, 'utf8'),
    ]);
    const normalizedPrerequisiteSql = prerequisiteSql.toLowerCase();
    const normalizedSql = sql.toLowerCase();

    const membershipVersionIndex = normalizedPrerequisiteSql.indexOf(
      'add column if not exists "administration_version"',
    );
    const proposalAuthorityIndex = normalizedPrerequisiteSql.indexOf(
      'add column "provider_authority_binding_hash"',
    );

    expect(membershipVersionIndex).toBeGreaterThan(-1);
    expect(proposalAuthorityIndex).toBeGreaterThan(membershipVersionIndex);
    expect(normalizedPrerequisiteSql).toContain(
      'household_memberships_administration_version_positive',
    );
    expect(normalizedSql).not.toMatch(
      /alter table emdo\.household_memberships\s+add column(?: if not exists)? administration_version/u,
    );
    expect(normalizedSql).toMatch(
      /alter table emdo\.invitations\s+add column administration_version integer default 1 not null/u,
    );
  });

  it('uses isolated no-login, no-inherit, non-bypass roles with no memberships', async () => {
    const sql = (await readFile(migrationUrl, 'utf8')).toLowerCase();

    expect(sql).toContain('create role emdo_household_admin_executor nologin');
    expect(sql).toContain(
      'alter role emdo_household_admin_executor nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication',
    );
    expect(sql).toContain(
      'household administration executor must not have role memberships',
    );
    expect(sql).toMatch(
      /revoke all privileges on all tables in schema emdo\s+from emdo_household_admin_executor/u,
    );
    expect(sql).toContain(
      'create role emdo_invitation_delivery_executor nologin',
    );
    expect(sql).toContain(
      'invitation delivery executor must not have role memberships',
    );
  });

  it('derives owner authority from locked current session and membership rows', async () => {
    const sql = (await readFile(migrationUrl, 'utf8')).toLowerCase();

    for (const routine of [
      'issue_household_invitation',
      'list_household_invitations',
      'revoke_household_invitation',
      'list_household_memberships',
      'change_household_membership_role',
      'deactivate_household_membership',
    ]) {
      expect(sql).toContain(`function emdo.${routine}`);
    }
    expect(sql).toContain('emdo.current_user_id()');
    expect(sql).toContain('emdo.current_session_id()');
    expect(sql).toContain('emdo.current_request_id()');
    expect(sql).toContain('session.active_household_id');
    expect(sql).toContain("membership.role = 'owner'");
    expect(sql).toContain("membership.status = 'active'");
    expect(sql).toContain('for share of session, membership');
    expect(sql).toMatch(
      /grant update \(updated_at\)\s+on emdo\.auth_sessions to emdo_household_admin_executor/u,
    );
    expect(sql).toContain('emdo.lock_active_request_scope(');
    const householdCommandLockIndex = sql.indexOf(
      "'emdo.household-administration:'",
    );
    const ownerRowLockIndex = sql.indexOf('for share of session, membership');
    expect(householdCommandLockIndex).toBeGreaterThan(-1);
    expect(ownerRowLockIndex).toBeGreaterThan(householdCommandLockIndex);
    expect(sql).toContain("message = 'emdo:authorization-revoked'");
    expect(sql).not.toMatch(/p_(?:user|session|household|space)_id/iu);
  });

  it('enforces seven-day hashed, immutable, versioned, single-use invitations and queues only a sealed secret reference', async () => {
    const sql = (await readFile(migrationUrl, 'utf8')).toLowerCase();

    expect(sql).toContain('p_expires_in_seconds between 60 and 604800');
    expect(sql).toContain("p_token_hash !~ '^[a-f0-9]{64}$'");
    expect(sql).toContain("'emdo.invitation.delivery.v1'");
    expect(sql).toContain('invitation_delivery_secrets');
    expect(sql).toContain("'deliverysecretid'");
    expect(sql).toContain("'invitation-redemption.v1'");
    expect(sql).toContain("'rsa-oaep-256'");
    expect(sql).toMatch(
      /char_length\(p_envelope ->> 'ciphertext'\)\s+not between 64 and 16384/u,
    );
    expect(sql).not.toContain("'^[a-za-z0-9_-]{64,16384}$'");
    expect(sql).not.toContain("'invitationtoken'");
    expect(sql).not.toMatch(/jsonb_build_object\([\s\S]{0,500}'token'/u);
    expect(sql).toContain('worker_operation_outbox');
    expect(sql).toContain('on conflict (job_name, operation_id) do nothing');
    expect(sql).toContain("message = 'emdo:administration-conflict'");
    expect(sql).toContain("'deliveryqueued', true");
    expect(sql).toContain("(v_command.result ->> 'deliveryqueued')::boolean");
    expect(sql).toContain(
      'new.administration_version := old.administration_version + 1',
    );
    expect(sql).toContain('consumed_at is null');
    expect(sql).toContain('revoked_at is null');
    expect(sql).toContain('set envelope = null');
  });

  it('captures and settles encrypted delivery only through an exact claimed worker operation', async () => {
    const sql = (await readFile(migrationUrl, 'utf8')).toLowerCase();

    expect(sql).toContain(
      'create or replace function emdo.capture_invitation_delivery_secret(',
    );
    expect(sql).toContain(
      'create or replace function emdo.settle_invitation_delivery_secret(',
    );
    expect(sql).toMatch(
      /emdo\.current_worker_job_name\(\)\s*<>\s*'emdo\.invitation\.delivery\.v1'/u,
    );
    expect(sql).toMatch(
      /emdo\.current_worker_target_type\(\)\s*<>\s*'invitation'/u,
    );
    expect(sql).toContain('emdo.is_active_worker_operation_scope(');
    expect(sql).toContain('create policy invitation_delivery_invitations_lock');
    expect(sql).toMatch(
      /grant update \(id\) on emdo\.invitations\s+to emdo_invitation_delivery_executor/u,
    );
    expect(sql).toMatch(
      /grant execute on function\s+emdo\.worker_outbox_binding_is_valid\(\s*text, text, text, text, integer, text, integer, jsonb\s*\)\s+to emdo_invitation_delivery_executor/u,
    );
    expect(sql).toContain(
      "p_disposition in ('confirmed', 'indeterminate', 'expired')",
    );
    expect(sql).toContain("state = 'indeterminate'");
    expect(sql).toContain('envelope = null');
    expect(sql).toMatch(
      /grant execute on function emdo\.capture_invitation_delivery_secret\(uuid, uuid\)[^;]+to emdo_worker_executor/u,
    );
    expect(sql).not.toMatch(
      /grant (?:select|insert|update|delete)[^;]+invitation_delivery_secrets[^;]+to emdo_worker/u,
    );
  });

  it('uses durable idempotency, CAS, last-owner, self-lockout, and session revocation guards', async () => {
    const sql = (await readFile(migrationUrl, 'utf8')).toLowerCase();

    expect(sql).toContain('household_administration_commands');
    expect(sql).toMatch(
      /grant update \(created_at\)\s+on emdo\.household_administration_commands\s+to emdo_household_admin_executor/u,
    );
    expect(sql).toContain('idempotency_key');
    expect(sql).toContain('request_hash');
    expect(sql).toContain('p_expected_version');
    expect(sql).toContain('administration_version = p_expected_version');
    expect(sql).toContain('self-lockout');
    expect(sql).toContain('last-owner-required');
    expect(sql).toContain('delete from emdo.auth_sessions as target_session');
    expect(sql).toContain(
      'delete from emdo.rotating_sessions as target_session',
    );
    expect(sql).not.toMatch(
      /delete from emdo\.(?:auth_sessions|rotating_sessions) where user_id/u,
    );
    expect(sql).toContain('administration_version = p_expected_version');
    expect(sql).toContain('administration_version = p_expected_version + 1');
    expect(
      sql.match(/update emdo\.invitations as issued_invitation/gu),
    ).toHaveLength(2);
    expect(sql).toContain(
      'issued_invitation.invited_by_user_id = v_target.user_id',
    );
    expect(sql).toContain('issued_invitation.consumed_at is null');
    expect(sql).toContain('issued_invitation.revoked_at is null');
  });

  it('exposes only routine execution and revokes raw invitation and membership mutation ACL', async () => {
    const sql = (await readFile(migrationUrl, 'utf8')).toLowerCase();

    expect(sql).toContain('security definer');
    expect(sql).toContain('set row_security = on');
    expect(sql).toContain(
      'revoke insert, update, delete on emdo.invitations from emdo_app',
    );
    expect(sql).toContain(
      'revoke insert, update, delete on emdo.household_memberships from emdo_app',
    );
    expect(sql).toContain(
      'revoke select on emdo.worker_operation_outbox from emdo_app',
    );
    expect(sql).toMatch(
      /grant execute on function[\s\S]+issue_household_invitation[\s\S]+to emdo_app/u,
    );
    expect(sql).not.toMatch(
      /grant (?:select|insert|update|delete)[^;]+on emdo\.(?:invitations|household_memberships)[^;]+to emdo_app/u,
    );
  });

  it('exposes a capability-specific readiness proof that checks routines, ownership, ACLs, and runtime identity', async () => {
    const sql = (await readFile(migrationUrl, 'utf8')).toLowerCase();

    expect(sql).toContain(
      'create or replace function emdo.household_administration_ready()',
    );
    expect(sql).toContain("session_user = 'emdo_api_login'");
    expect(sql).toContain(
      "pg_catalog.pg_has_role(session_user, 'emdo_app', 'usage')",
    );
    expect(sql).toContain('pg_catalog.has_function_privilege(');
    expect(sql).toContain('pg_catalog.pg_get_userbyid(routine.proowner)');
    expect(sql).toMatch(
      /has_column_privilege\(\s*current_user, 'emdo\.auth_sessions', 'updated_at', 'update'\s*\)/u,
    );
    expect(sql).toMatch(
      /has_column_privilege\(\s*current_user, 'emdo\.household_administration_commands',\s*'created_at', 'update'\s*\)/u,
    );
    for (const table of [
      'invitations',
      'household_memberships',
      'household_administration_commands',
      'invitation_delivery_secrets',
      'worker_operation_outbox',
    ]) {
      for (const privilege of ['select', 'insert', 'update']) {
        expect(sql).toContain(
          `not pg_catalog.has_any_column_privilege(\n\t\t\tsession_user, 'emdo.${table}', '${privilege}'\n\t\t)`,
        );
      }
      expect(sql).toContain(
        `not pg_catalog.has_table_privilege(\n\t\t\tsession_user, 'emdo.${table}', 'delete'\n\t\t)`,
      );
    }
    expect(sql).toContain(
      "not pg_catalog.has_table_privilege(\n\t\t\tcurrent_user, 'emdo.auth_sessions', 'update'\n\t\t)",
    );
    expect(sql).toContain(
      "not pg_catalog.has_table_privilege(\n\t\t\tcurrent_user, 'emdo.household_administration_commands', 'update'\n\t\t)",
    );
    expect(sql).toMatch(
      /grant execute on function emdo\.household_administration_ready\(\)[^;]+to emdo_app/u,
    );
  });
});

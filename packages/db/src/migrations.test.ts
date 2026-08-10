import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../drizzle/0000_household_foundation.sql',
  import.meta.url,
);
const identityMigrationUrl = new URL(
  '../drizzle/0001_identity_onboarding.sql',
  import.meta.url,
);

const readMigration = async () =>
  (await readFile(migrationUrl, 'utf8')).toLowerCase().replaceAll('"', '');
const readIdentityMigration = async () =>
  (await readFile(identityMigrationUrl, 'utf8'))
    .toLowerCase()
    .replaceAll('"', '');

describe('PostgreSQL household foundation migration', () => {
  it('creates the complete PostgreSQL 17 and pgvector foundation', async () => {
    const sql = await readMigration();

    for (const fragment of [
      'create extension if not exists vector',
      'create table emdo.auth_users',
      'create table emdo.households',
      'create table emdo.household_memberships',
      'create table emdo.spaces',
      'create table emdo.space_records',
      'create table emdo.conversation_events',
      'create table emdo.audit_events',
      'create table emdo.disclosure_grants',
      'create table emdo.action_proposals',
      'create table emdo.action_decisions',
      'create table emdo.provider_attempts',
      'create table emdo.invitations',
      'create table emdo.rotating_sessions',
      'create table emdo.memory_chunks',
    ]) {
      expect(sql).toContain(fragment);
    }
  });

  it('uses household-aware foreign keys for all space-owned content', async () => {
    const sql = await readMigration();

    expect(sql).toMatch(
      /foreign key\s*\(household_id,\s*space_id\)\s*references emdo\.spaces\s*\(household_id,\s*id\)/,
    );
    expect(sql).toMatch(
      /foreign key\s*\(household_id,\s*original_owner_user_id\)\s*references emdo\.household_memberships\s*\(household_id,\s*user_id\)/,
    );
    expect(sql).not.toMatch(
      /foreign key\s*\(space_id\)\s*references emdo\.spaces\s*\(id\)/,
    );
  });

  it('forces fail-closed RLS without granting owners private-content visibility', async () => {
    const sql = await readMigration();

    const scopedTables = [
      'households',
      'household_memberships',
      'spaces',
      'space_records',
      'conversation_events',
      'audit_events',
      'disclosure_grants',
      'agent_runs',
      'action_proposals',
      'action_decisions',
      'provider_attempts',
      'memory_chunks',
    ];

    for (const table of scopedTables) {
      expect(sql).toContain(
        `alter table emdo.${table} enable row level security`,
      );
      expect(sql).toContain(
        `alter table emdo.${table} force row level security`,
      );
    }

    expect(sql).toContain('emdo.can_access_space');
    expect(sql).toMatch(/visibility\s*=\s*'shared'/);
    expect(sql).toMatch(
      /original_owner_user_id\s*=\s*emdo\.current_user_id\(\)/,
    );
    expect(sql).not.toMatch(
      /role\s*=\s*'owner'[\s\S]{0,180}(space_records|conversation_events|memory_chunks)/,
    );
  });

  it('makes audit, conversation, and decision rows append-only', async () => {
    const sql = await readMigration();

    for (const table of [
      'audit_events',
      'conversation_events',
      'action_decisions',
    ]) {
      expect(sql).toMatch(
        new RegExp(
          `create trigger ${table}_append_only[\\s\\S]+before update or delete on emdo\\.${table}`,
        ),
      );
    }
    expect(sql).toContain("raise exception using errcode = '55000'");
  });

  it('creates least-privilege non-login roles and revokes RLS bypass operations', async () => {
    const sql = await readMigration();

    for (const role of [
      'emdo_app',
      'emdo_auth',
      'emdo_worker',
      'emdo_workflow',
      'emdo_policy_reader',
    ]) {
      expect(sql).toMatch(
        new RegExp(
          `create role ${role} nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls`,
        ),
      );
      expect(sql).toMatch(
        new RegExp(
          `alter role ${role} nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication`,
        ),
      );
    }
    expect(sql).not.toMatch(/grant all/);
    expect(sql).toContain('revoke all on schema emdo from public');
    expect(sql).toContain('revoke truncate, references');
    expect(sql).toContain('pg_catalog.pg_auth_members');
    expect(sql).toMatch(/pg_catalog\.format\(\s*'revoke %i from %i'/);
    expect(sql).toContain(
      'unexpected parent role membership on emdo foundation role',
    );
  });

  it('provisions invited identities only through a narrow security-definer boundary', async () => {
    const sql = await readIdentityMigration();

    for (const role of ['emdo_onboarding', 'emdo_onboarding_executor']) {
      expect(sql).toMatch(
        new RegExp(
          `create role ${role} nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls`,
        ),
      );
    }
    expect(sql).toContain(
      'create or replace function emdo.provision_invited_account',
    );
    expect(sql).toContain('security definer');
    expect(sql).toContain('set search_path = pg_catalog');
    expect(sql).toMatch(
      /grant execute on function emdo\.provision_invited_account[\s\S]+to emdo_onboarding/,
    );
    expect(sql).not.toMatch(
      /grant (select|insert|update|delete|truncate|references|trigger|maintain)[^;]+to emdo_onboarding\s*;/,
    );
    expect(sql).toContain(
      'revoke all on function emdo.provision_invited_account',
    );
  });

  it('limits owners to safe invitation reads, issue fields, and one-way revocation', async () => {
    const sql = await readIdentityMigration();

    expect(sql).toContain('revoke all on emdo.invitations from emdo_app');
    expect(sql).toMatch(
      /revoke all \([^)]+token_hash[^)]+consumed_at[^)]+revoked_at[^)]*\)\s+on emdo\.invitations from public, emdo_app, emdo_auth, emdo_worker/,
    );
    expect(sql).not.toMatch(
      /grant select, insert, update on emdo\.invitations to emdo_app/,
    );

    const ownerSelectGrant = sql.match(
      /grant select \([^)]+\)\s+on emdo\.invitations to emdo_app/,
    )?.[0];
    expect(ownerSelectGrant).toBeDefined();
    expect(ownerSelectGrant).not.toContain('token_hash');

    const ownerInsertGrant = sql.match(
      /grant insert \([^)]+\)\s+on emdo\.invitations to emdo_app/,
    )?.[0];
    expect(ownerInsertGrant).toContain('token_hash');
    expect(ownerInsertGrant).not.toContain('consumed_at');
    expect(ownerInsertGrant).not.toContain('consumed_by_user_id');
    expect(ownerInsertGrant).not.toContain('consumed_session_id');
    expect(ownerInsertGrant).not.toContain('revoked_at');

    expect(sql).toMatch(
      /grant update \(revoked_at\)\s+on emdo\.invitations to emdo_app/,
    );
    expect(sql).toContain(
      'create or replace function emdo.enforce_invitation_lifecycle',
    );
    expect(sql).toMatch(
      /create trigger invitations_lifecycle_guard[\s\S]+before update on emdo\.invitations/,
    );
    expect(sql).toMatch(
      /revoke all on function emdo\.enforce_invitation_lifecycle\(\)[\s\S]+from public/,
    );
    expect(sql).toMatch(
      /invitations_owner_update[\s\S]+consumed_at is null[\s\S]+revoked_at is null[\s\S]+with check[\s\S]+revoked_at is not null/,
    );
  });

  it('keeps organization reads canonical and membership reads active-only', async () => {
    const sql = await readIdentityMigration();

    for (const view of [
      'better_auth_organizations',
      'active_household_memberships',
      'better_auth_invitations',
    ]) {
      expect(sql).toMatch(
        new RegExp(
          `create view emdo\\.${view} with \\(security_barrier\\s*=\\s*true\\)`,
        ),
      );
      expect(sql).toMatch(
        new RegExp(`alter view emdo\\.${view} owner to emdo_identity_reader`),
      );
    }
    expect(sql).toMatch(/where status = 'active'/);
    expect(sql).toMatch(
      /households_identity_projection[\s\S]+is_active_member\(id\)/,
    );
    expect(sql).toMatch(
      /memberships_identity_projection[\s\S]+is_active_member\(household_id\)/,
    );
    expect(sql).toMatch(
      /invitations_identity_projection[\s\S]+is_household_owner\(household_id\)/,
    );
    expect(sql).toMatch(
      /grant select on emdo\.better_auth_organizations,\s*emdo\.active_household_memberships,\s*emdo\.better_auth_invitations to emdo_auth/,
    );
    expect(sql).toContain('revoke all on emdo.invitations from emdo_auth');
    const invitationView = sql.match(
      /create view emdo\.better_auth_invitations[\s\S]+?;/,
    )?.[0];
    expect(invitationView).toBeDefined();
    expect(invitationView).not.toContain('token_hash');
    const authBaseGrants = sql
      .split(';')
      .filter(
        (statement) =>
          statement.includes('grant ') &&
          statement.includes('to emdo_auth') &&
          /on emdo\.(households|household_memberships|invitations)(\s|$)/.test(
            statement,
          ),
      );
    expect(authBaseGrants).toEqual([]);
  });

  it('provides Better Auth database rate limiting without public access', async () => {
    const sql = await readIdentityMigration();

    expect(sql).toContain('create table emdo.auth_rate_limits');
    expect(sql).toContain('auth_rate_limits_key_unique');
    expect(sql).toMatch(
      /grant select, insert, update, delete on emdo\.auth_rate_limits to emdo_auth/,
    );
    expect(sql).toMatch(
      /revoke truncate, references, trigger, maintain on emdo\.auth_rate_limits from emdo_auth/,
    );
  });
});

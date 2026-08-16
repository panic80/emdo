import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../drizzle/0003_durable_runtime_repositories.sql',
  import.meta.url,
);

const readMigration = async () =>
  (await readFile(migrationUrl, 'utf8'))
    .replaceAll(/\/\*[\s\S]*?\*\//gu, '')
    .replaceAll(/--[^\n]*/gu, '')
    .toLowerCase()
    .replaceAll('"', '');

const extractFunction = (sql: string, name: string): string => {
  const match = sql.match(
    new RegExp(
      `create or replace function emdo\\.${name}\\s*\\([\\s\\S]+?\\$function\\$;`,
    ),
  );
  expect(match, `${name} must be present`).not.toBeNull();
  return match?.[0] ?? '';
};

const expectHardenedSecurityDefiner = (body: string): void => {
  expect(body).toContain('returns jsonb');
  expect(body).toContain('security definer');
  expect(body).toContain('set search_path = pg_catalog, emdo');
  expect(body).toContain('set row_security = on');
};

const statementPosition = (
  body: string,
  pattern: RegExp,
  label: string,
): number => {
  const match = pattern.exec(body);
  expect(match, `${label} must be present`).not.toBeNull();
  return match?.index ?? -1;
};

const sourceKeys = [
  'id',
  'version',
  'state',
  'capabilityid',
  'payloadhash',
  'approvalhash',
  'approvaldisplay',
  'createdat',
  'expiresat',
] as const;

const forbiddenProposalMaterial = [
  'canonical_arguments',
  'targets',
  'provider_preconditions',
  'provider_authority_binding_hash',
  'provider_sdk_call_id',
  'disclosure_grant',
  'capability_fingerprint',
  'idempotency_key',
] as const;

describe('proposal approval query migration', () => {
  it('declares the two exact hardened JSON query commands', async () => {
    const sql = await readMigration();
    const list = extractFunction(sql, 'list_proposal_approval_sources');
    const detail = extractFunction(sql, 'get_proposal_approval_source');

    expect(list).toMatch(
      /list_proposal_approval_sources\s*\(\s*p_household_id uuid,\s*p_fresh_grant_id uuid,\s*p_state text,\s*p_expected_scope text,\s*p_cursor_created_at timestamptz,\s*p_cursor_id uuid,\s*p_limit (?:integer|int)\s*\)/,
    );
    expect(detail).toMatch(
      /get_proposal_approval_source\s*\(\s*p_household_id uuid,\s*p_fresh_grant_id uuid,\s*p_proposal_id uuid\s*\)/,
    );
    expectHardenedSecurityDefiner(list);
    expectHardenedSecurityDefiner(detail);
    expect(list).toContain('emdo.lock_current_authorization_scope');
    expect(detail).toContain('emdo.lock_current_authorization_scope');
  });

  it('re-proves the exact current session, membership, and fresh space grant under locks', async () => {
    const sql = await readMigration();
    const lock = extractFunction(sql, 'lock_current_authorization_scope');

    expect(lock).toContain('security definer');
    expect(lock).toContain('set search_path = pg_catalog, emdo');
    expect(lock).toContain('set row_security = on');
    for (const relation of [
      'emdo.auth_users',
      'emdo.auth_sessions',
      'emdo.household_memberships',
      'emdo.space_access_grants',
    ]) {
      expect(lock).toContain(relation);
    }
    expect(lock).toContain('emdo.current_user_id()');
    expect(lock).toContain('emdo.current_session_id()');
    expect(lock).toContain('emdo.current_request_id()');
    expect(lock).toContain('p_space_access_grant_id');
    expect(lock).toContain('p_proposal_id');
    expect(lock).toContain('p_run_id');
    expect(lock).toContain('grant_id');
    expect(lock).toContain('writable_space_ids');
    expect(lock).toContain('email_verified = true');
    expect(lock).toContain("membership.status = 'active'");
    expect(lock).toContain('pg_catalog.clock_timestamp()');
    expect(lock).toContain('v_grant.expires_at <= v_now');
    expect(lock).toContain('session.expires_at > v_now');
    expect(lock).toMatch(
      /for (?:no key update|update|key share|share) of [^;]+/,
    );
    expect(lock).not.toContain('p_household_id');
    expect(lock).not.toContain('p_user_id');
    expect(lock).not.toContain('p_session_id');
    expect(lock).not.toContain('p_authorization_scope_fingerprint');
    expect(lock).not.toMatch(/current_timestamp|\bnow\(\)/);
  });

  it('binds cursors to current authorization, requested state, and a versioned sort schema', async () => {
    const sql = await readMigration();
    const list = extractFunction(sql, 'list_proposal_approval_sources');

    expect(list).toContain('authorizationscopefingerprint');
    expect(list).toContain('v_query_fingerprint');
    expect(list).toContain('p_state');
    expect(list).toContain('created-at-desc-id-desc-v1');
    expect(list).toContain('p_expected_scope is null');
    expect(list).toMatch(
      /p_expected_scope is distinct from v_query_fingerprint[\s\S]+jsonb_build_object\(\s*'status',\s*'invalid-cursor'\s*\)/,
    );
    expect(list).toMatch(
      /p_cursor_created_at is null[\s\S]+p_cursor_id is not null|p_cursor_created_at is not null[\s\S]+p_cursor_id is null/,
    );
  });

  it('filters before stable keyset pagination and fetches only one bounded lookahead row', async () => {
    const sql = await readMigration();
    const list = extractFunction(sql, 'list_proposal_approval_sources');

    expect(list).toContain('emdo.action_proposals');
    expect(list).toContain('emdo.proposal_states');
    expect(list).toMatch(/proposal\.household_id\s*=\s*p_household_id/);
    expect(list).toMatch(
      /proposal\.original_owner_user_id\s*=\s*(?:v_user_id|v_scope\.user_id|emdo\.current_user_id\(\))/,
    );
    expect(list).toMatch(
      /proposal\.space_id\s*=\s*any\s*\(\s*(?:v_writable_space_ids|v_scope\.writable_space_ids)\s*\)/,
    );
    expect(list).toMatch(
      /p_state is null[\s\S]+state\.state\s*=\s*p_state|state\.state\s*=\s*p_state/,
    );
    expect(list).toMatch(
      /\(\s*proposal\.created_at\s*,\s*proposal\.id\s*\)\s*<\s*\(\s*p_cursor_created_at\s*,\s*p_cursor_id\s*\)/,
    );

    const householdFilter = statementPosition(
      list,
      /proposal\.household_id\s*=\s*p_household_id/,
      'household filter',
    );
    const keyset = statementPosition(
      list,
      /\(\s*proposal\.created_at\s*,\s*proposal\.id\s*\)\s*</,
      'keyset predicate',
    );
    const order = statementPosition(
      list,
      /order by\s+proposal\.created_at desc\s*,\s*proposal\.id desc/,
      'stable ordering',
    );
    const limit = statementPosition(
      list,
      /limit\s+\(?\s*p_limit\s*\+\s*1\s*\)?/,
      'bounded lookahead',
    );
    expect(keyset).toBeGreaterThan(householdFilter);
    expect(order).toBeGreaterThan(keyset);
    expect(limit).toBeGreaterThan(order);
    expect(list).toMatch(
      /p_limit\s+not between\s+1\s+and\s+50|p_limit\s*<\s*1[\s\S]+p_limit\s*>\s*50/,
    );
    expect(list).toContain('hasmore');
  });

  it('returns strict projector sources and no provider or authority material', async () => {
    const sql = await readMigration();
    const list = extractFunction(sql, 'list_proposal_approval_sources');
    const detail = extractFunction(sql, 'get_proposal_approval_source');

    for (const body of [list, detail]) {
      for (const key of sourceKeys) expect(body).toContain(`'${key}'`);
      for (const forbidden of forbiddenProposalMaterial) {
        expect(body).not.toContain(forbidden);
      }
    }
    expect(list).toContain('authorizationscopefingerprint');
    expect(list).toContain('hasmore');
    expect(detail).toMatch(
      /jsonb_build_object\(\s*'status',\s*'not-found'\s*\)/,
    );
  });

  it('keeps raw proposal tables private and grants the app only command execution', async () => {
    const sql = await readMigration();

    expect(sql).toMatch(
      /create role emdo_proposal_query_executor\s+no(?:login|superuser)[\s\S]+?noinherit nobypassrls noreplication/,
    );
    expect(sql).toContain(
      'proposal query executor must not have role memberships',
    );
    expect(sql).toMatch(
      /alter function emdo\.list_proposal_approval_sources\(\s*uuid, uuid, text, text, timestamptz, uuid, (?:integer|int)\s*\)[^;]+owner to emdo_proposal_query_executor/,
    );
    expect(sql).toMatch(
      /alter function emdo\.get_proposal_approval_source\(uuid, uuid, uuid\)[^;]+owner to emdo_proposal_query_executor/,
    );
    expect(sql).toMatch(
      /create policy proposal_app_owner_only_raw_read[\s\S]+?as restrictive[\s\S]+?to emdo_app[\s\S]+?original_owner_user_id\s*=\s*emdo\.current_user_id\(\)/,
    );
    expect(sql).toMatch(
      /create policy proposal_state_app_owner_only_raw_read[\s\S]+?as restrictive[\s\S]+?to emdo_app[\s\S]+?original_owner_user_id\s*=\s*emdo\.current_user_id\(\)/,
    );
    expect(sql).toMatch(
      /grant select on[^;]+emdo\.action_proposals[^;]+emdo\.proposal_states[^;]+to emdo_proposal_query_executor/,
    );
    expect(sql).toMatch(
      /grant execute on function[^;]+emdo\.list_proposal_approval_sources\(\s*uuid, uuid, text, text, timestamptz, uuid, (?:integer|int)\s*\)[^;]+emdo\.get_proposal_approval_source\(uuid, uuid, uuid\)[^;]+to emdo_app/,
    );
  });
});

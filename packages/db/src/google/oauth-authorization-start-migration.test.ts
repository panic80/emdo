import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { loadOrderedMigrations } from '../migrations.js';

const migrationUrl = new URL(
  '../../drizzle/0009_google_oauth_authorization_starts.sql',
  import.meta.url,
);

const readNormalized = async () =>
  (await readFile(migrationUrl, 'utf8')).toLowerCase().replaceAll('"', '');

describe('Google OAuth authorization-start receipts migration', () => {
  it('is journaled as the narrow 0009 OAuth idempotency upgrade', async () => {
    const migrations = await loadOrderedMigrations();

    expect(migrations.at(-1)?.id).toBe(
      '0009_google_oauth_authorization_starts',
    );
    expect(migrations.at(-1)?.index).toBe(9);
  });

  it('stores exact start receipts behind forced RLS with no raw app DML', async () => {
    const sql = await readNormalized();

    expect(sql).toContain(
      'create table emdo.google_oauth_authorization_starts',
    );
    expect(sql).toContain(
      'alter table emdo.google_oauth_authorization_starts enable row level security',
    );
    expect(sql).toContain(
      'alter table emdo.google_oauth_authorization_starts force row level security',
    );
    expect(sql).toContain('google_oauth_authorization_starts_scope_key_unique');
    expect(sql).not.toMatch(
      /grant (?:select|insert|update|delete)[^;]+google_oauth_authorization_starts[^;]+to emdo_app/u,
    );
    expect(sql).toContain(
      'revoke select, insert, update, delete on emdo.google_oauth_flows from emdo_app',
    );
    expect(sql).toContain('create policy google_oauth_flows_executor_insert');
    expect(sql).toMatch(
      /grant insert on emdo\.google_oauth_flows\s+to emdo_oauth_flow_executor/u,
    );
  });

  it('atomically binds purpose, fingerprint, exact result, and optional PKCE flow', async () => {
    const sql = await readNormalized();

    expect(sql).toContain(
      'create or replace function emdo.commit_google_oauth_authorization_start',
    );
    expect(sql).toContain('emdo.lock_active_request_scope');
    expect(sql).toContain('emdo.current_user_id()');
    expect(sql).toContain('emdo.current_session_id()');
    expect(sql).toContain("domain', 'emdo.google-calendar.oauth-start.v1'");
    expect(sql).toContain('emdo.canonical_json_hash');
    expect(sql).toContain('insert into emdo.google_oauth_flows');
    expect(sql).toContain('insert into emdo.google_oauth_authorization_starts');
    expect(sql).toContain("return query select 'replayed'::text");
    expect(sql).toContain("return query select 'conflict'::text");
    expect(sql).toContain("return query select 'expired'::text");
    expect(sql).toContain(
      "pg_catalog.jsonb_typeof(p_result -> 'authorizationurl') <> 'string'",
    );
    expect(sql).toMatch(/count\(\*\)[^;]+count\(distinct requested\.scope\)/u);
    expect(sql).toMatch(
      /grant execute on function[^;]+canonical_json_hash\(jsonb\)[^;]+jsonb_object_has_exact_keys\(jsonb, text\[\]\)[^;]+to emdo_oauth_flow_executor/u,
    );
  });

  it('exposes only the aggregates and an exact drift-sensitive readiness probe', async () => {
    const sql = await readNormalized();

    expect(sql).toContain(
      'create or replace function emdo.google_oauth_runtime_ready',
    );
    expect(sql).toMatch(
      /grant execute on function emdo\.commit_google_oauth_authorization_start\([^;]+to emdo_app/u,
    );
    expect(sql).toMatch(
      /grant execute on function emdo\.google_oauth_runtime_ready\(\)[^;]+to emdo_app/u,
    );
    expect(sql).toMatch(
      /revoke all on function emdo\.commit_google_oauth_authorization_start\([^;]+from public/u,
    );
    expect(sql).toContain(
      'create or replace function emdo.purge_expired_google_oauth_state',
    );
    expect(sql).toMatch(
      /revoke all on function emdo\.purge_expired_google_oauth_state\(integer\)[^;]+from public, emdo_app/u,
    );
    expect(sql).not.toMatch(
      /grant execute on function emdo\.purge_expired_google_oauth_state\(integer\)[^;]+to emdo_app/u,
    );
    expect(sql).toMatch(
      /not pg_catalog\.has_function_privilege\(\s*session_user,\s*'emdo\.purge_expired_google_oauth_state\(integer\)',\s*'execute'\s*\)/u,
    );
    expect(sql).toContain("'emdo_oauth_flow_executor'");
    expect(sql).toContain("'emdo_oauth_grant_executor'");
    expect(sql).toContain('rolcanlogin = false');
    expect(sql).toContain('rolinherit = false');
    expect(sql).toContain('rolbypassrls = false');
    expect(sql).toMatch(
      /proc\.proconfig @> array\[\s*'row_security=on', 'search_path=pg_catalog, emdo'\s*\]/u,
    );
    expect(sql).toContain(
      "'emdo.consume_google_oauth_flow(text,uuid,uuid,uuid,uuid)'::regprocedure",
    );
    expect(sql).toContain(
      "'emdo.delete_encrypted_google_calendar_grant(text,uuid,uuid,uuid,integer)'::regprocedure",
    );
    expect(sql).toContain(
      "'emdo.is_valid_encrypted_google_calendar_grant_payload(jsonb)'::regprocedure",
    );
    expect(sql).toMatch(
      /not pg_catalog\.has_function_privilege\(\s*session_user,\s*'emdo\.is_valid_encrypted_google_calendar_grant_payload\(jsonb\)',\s*'execute'\s*\)/u,
    );
    expect(sql).toMatch(
      /pg_catalog\.has_function_privilege\(\s*'emdo_oauth_grant_executor',\s*'emdo\.is_valid_encrypted_google_calendar_grant_payload\(jsonb\)',\s*'execute'\s*\)/u,
    );
  });
});

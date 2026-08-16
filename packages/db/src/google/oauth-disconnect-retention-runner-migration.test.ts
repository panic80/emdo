import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { loadOrderedMigrations } from '../migrations.js';

const migrationUrl = new URL(
  '../../drizzle/0013_google_oauth_disconnect_retention_runner.sql',
  import.meta.url,
);

const readNormalized = async (): Promise<string> =>
  (await readFile(migrationUrl, 'utf8')).toLowerCase().replaceAll('"', '');

const extractFunction = (sql: string, name: string): string => {
  const start = sql.indexOf(`create or replace function emdo.${name}`);
  if (start < 0) throw new Error(`missing function ${name}`);
  const end = sql.indexOf('--> statement-breakpoint', start);
  return sql.slice(start, end < 0 ? undefined : end);
};

describe('Google OAuth disconnect retention runner migration', () => {
  it('is journaled as the additive 0013 operational boundary', async () => {
    const migrations = await loadOrderedMigrations();
    expect(
      migrations.find(({ id }) => id.includes('disconnect_retention_runner')),
    ).toMatchObject({
      id: '0013_google_oauth_disconnect_retention_runner',
      index: 13,
    });
  });

  it('creates one upgrade-safe login with exactly one set-only retention membership', async () => {
    const sql = await readNormalized();

    expect(sql).toContain(
      'create role emdo_google_oauth_disconnect_retention_login nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication',
    );
    expect(sql).not.toContain(
      'alter role emdo_google_oauth_disconnect_retention_login login',
    );
    expect(sql).toMatch(
      /grant emdo_google_oauth_disconnect_retention\s+to emdo_google_oauth_disconnect_retention_login\s+with inherit false, set true, admin false/u,
    );
    expect(sql).toContain('membership.inherit_option = false');
    expect(sql).toContain('membership.set_option = true');
    expect(sql).toContain('membership.admin_option = false');
    expect(sql).toContain(') = 2');
  });

  it('exposes only login-specific readiness and no direct data or purge authority', async () => {
    const sql = await readNormalized();
    const readiness = extractFunction(
      sql,
      'google_oauth_disconnect_retention_runner_ready',
    );
    const baseReadiness = extractFunction(sql, 'google_oauth_disconnect_ready');

    expect(readiness).toMatch(
      /session_user\s*=\s*'emdo_google_oauth_disconnect_retention_login'/u,
    );
    expect(readiness).toContain("current_database() = 'emdo_app'");
    expect(readiness).toContain('rolcanlogin = true');
    expect(readiness).toContain(
      'emdo.purge_completed_google_oauth_disconnects(integer)',
    );
    expect(readiness).toContain("'emdo_google_oauth_disconnect_retention'");
    expect(readiness).toMatch(
      /policy\.rolname =\s*'emdo_google_oauth_disconnect_retention'[\s\S]+?policy\.rolcanlogin = false[\s\S]+?policy\.rolbypassrls = false/u,
    );
    expect(readiness).toContain(
      "procedure.pronamespace = 'emdo'::regnamespace",
    );
    expect(readiness).toMatch(
      /procedure\.oid <>\s*'emdo\.google_oauth_disconnect_retention_runner_ready\(\)'::regprocedure/u,
    );
    expect(readiness).toMatch(
      /has_function_privilege\(\s*session_user,\s*procedure\.oid,\s*'execute'\s*\)/u,
    );
    expect(readiness).toMatch(
      /has_table_privilege\(\s*'emdo_google_oauth_disconnect_retention'/u,
    );
    expect(readiness).toContain("'insert,update,truncate,references,trigger'");
    expect(baseReadiness).toContain(
      "'insert,update,truncate,references,trigger'",
    );
    expect(readiness).toMatch(
      /has_sequence_privilege\(\s*'emdo_google_oauth_disconnect_retention'/u,
    );
    expect(readiness).toMatch(
      /has_function_privilege\(\s*'emdo_google_oauth_disconnect_retention',\s*procedure\.oid/u,
    );
    expect(sql).toMatch(
      /grant execute on function emdo\.google_oauth_disconnect_retention_runner_ready\(\)[^;]+to emdo_google_oauth_disconnect_retention_login/u,
    );
    expect(sql).not.toMatch(
      /grant execute on function emdo\.purge_completed_google_oauth_disconnects\(integer\)[^;]+to emdo_google_oauth_disconnect_retention_login/u,
    );
    expect(sql).not.toMatch(
      /grant (?:select|insert|update|delete)[^;]+to emdo_google_oauth_disconnect_retention_login/u,
    );
    expect(sql).not.toMatch(/\b(?:create|alter|drop)\s+table\b/u);
  });

  it('preserves the purge routine and data-table definitions unchanged', async () => {
    const sql = await readNormalized();

    expect(sql).not.toContain(
      'create or replace function emdo.purge_completed_google_oauth_disconnects',
    );
    expect(sql).not.toMatch(/\b(?:create|alter|drop)\s+table\b/u);
  });
});

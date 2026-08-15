import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { loadOrderedMigrations } from '../migrations.js';

const migrationUrl = new URL(
  '../../drizzle/0012_google_oauth_disconnect_reconciliation_runner.sql',
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

describe('Google OAuth disconnect reconciliation runner migration', () => {
  it('is journaled as the additive 0012 operational boundary', async () => {
    const migrations = await loadOrderedMigrations();
    expect(
      migrations.find(({ id }) => id.includes('disconnect_reconciliation')),
    ).toMatchObject({
      id: '0012_google_oauth_disconnect_reconciliation_runner',
      index: 12,
    });
  });

  it('repairs reconciliation to use the same actor-lock-before-row-lock order as interactive paths', async () => {
    const sql = await readNormalized();
    const reconciliation = extractFunction(
      sql,
      'reconcile_stranded_google_oauth_disconnects',
    );
    const enumerate = reconciliation.indexOf('for v_candidate in');
    const actorLock = reconciliation.indexOf('pg_try_advisory_xact_lock');
    const reselect = reconciliation.indexOf(
      'select stored.* into v_existing',
      actorLock,
    );
    const rowLock = reconciliation.indexOf('for update skip locked', reselect);

    expect(enumerate).toBeGreaterThan(0);
    expect(actorLock).toBeGreaterThan(enumerate);
    expect(reconciliation.slice(enumerate, actorLock)).not.toContain(
      'for update',
    );
    expect(reselect).toBeGreaterThan(actorLock);
    expect(rowLock).toBeGreaterThan(reselect);
    expect(reconciliation).toContain("stored.state = 'dispatching'");
    expect(reconciliation).toContain("interval '10 minutes'");
  });

  it('creates one upgrade-safe login with exactly one set-only reconciliation membership', async () => {
    const sql = await readNormalized();

    expect(sql).toContain(
      'create role emdo_google_oauth_disconnect_reconciliation_login nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication',
    );
    expect(sql).not.toContain(
      'alter role emdo_google_oauth_disconnect_reconciliation_login login',
    );
    expect(sql).toMatch(
      /grant emdo_google_oauth_disconnect_reconciliation\s+to emdo_google_oauth_disconnect_reconciliation_login\s+with inherit false, set true, admin false/u,
    );
    expect(sql).toContain('membership.inherit_option = false');
    expect(sql).toContain('membership.set_option = true');
    expect(sql).toContain('membership.admin_option = false');
    expect(sql).toContain(') = 1');
  });

  it('exposes only login-specific readiness and no direct data or reconciliation authority', async () => {
    const sql = await readNormalized();
    const readiness = extractFunction(
      sql,
      'google_oauth_disconnect_reconciliation_runner_ready',
    );

    expect(readiness).toMatch(
      /session_user\s*=\s*'emdo_google_oauth_disconnect_reconciliation_login'/u,
    );
    expect(readiness).toContain("current_database() = 'emdo_app'");
    expect(readiness).toContain('rolcanlogin = true');
    expect(readiness).toContain(
      'emdo.reconcile_stranded_google_oauth_disconnects(integer)',
    );
    expect(readiness).toContain(
      "'emdo_google_oauth_disconnect_reconciliation'",
    );
    expect(readiness).toContain(
      "procedure.pronamespace = 'emdo'::regnamespace",
    );
    expect(readiness).toMatch(
      /procedure\.oid <>\s*'emdo\.google_oauth_disconnect_reconciliation_runner_ready\(\)'::regprocedure/u,
    );
    expect(readiness).toMatch(
      /has_function_privilege\(\s*session_user,\s*procedure\.oid,\s*'execute'\s*\)/u,
    );
    expect(readiness).toMatch(
      /has_table_privilege\(\s*'emdo_google_oauth_disconnect_reconciliation'/u,
    );
    expect(readiness).toMatch(
      /has_sequence_privilege\(\s*'emdo_google_oauth_disconnect_reconciliation'/u,
    );
    expect(readiness).toMatch(
      /has_function_privilege\(\s*'emdo_google_oauth_disconnect_reconciliation',\s*procedure\.oid/u,
    );
    expect(readiness).toMatch(
      /pg_catalog\.acldefault\(\s*\(\s*case when relation\.relkind = 's' then 's' else 'r' end\s*\)::char,/u,
    );
    expect(sql).toMatch(
      /grant execute on function emdo\.google_oauth_disconnect_reconciliation_runner_ready\(\)[^;]+to emdo_google_oauth_disconnect_reconciliation_login/u,
    );
    expect(sql).not.toMatch(
      /grant execute on function emdo\.reconcile_stranded_google_oauth_disconnects\(integer\)[^;]+to emdo_google_oauth_disconnect_reconciliation_login/u,
    );
    expect(sql).not.toMatch(
      /grant (?:select|insert|update|delete)[^;]+to emdo_google_oauth_disconnect_reconciliation_login/u,
    );
    expect(sql).toMatch(
      /revoke all on function[\s\S]+emdo\.is_valid_finance_import_plan\(jsonb, uuid, text, text, text, uuid, uuid\)\s+from public/u,
    );
    expect(sql).toMatch(
      /grant execute on function[\s\S]+emdo\.is_valid_finance_import_plan\(jsonb, uuid, text, text, text, uuid, uuid\)\s+to emdo_finance_import_executor/u,
    );
    expect(sql).not.toMatch(/\b(?:create|alter|drop)\s+table\b/u);
  });
});

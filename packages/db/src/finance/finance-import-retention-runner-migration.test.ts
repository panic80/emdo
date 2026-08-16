import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../drizzle/0011_finance_import_retention_runner.sql',
  import.meta.url,
);

const readNormalized = async (): Promise<string> =>
  (await readFile(migrationUrl, 'utf8')).toLowerCase().replaceAll('\r\n', '\n');

describe('finance import retention runner migration', () => {
  it('creates an upgrade-safe login placeholder and exactly one set-only membership', async () => {
    const sql = await readNormalized();

    expect(sql).toContain(
      'create role emdo_finance_import_retention_login nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication',
    );
    expect(sql).toContain(
      'alter role emdo_finance_import_retention_login nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication',
    );
    expect(sql).not.toContain(
      'alter role emdo_finance_import_retention_login login',
    );
    expect(sql).toContain("execute format('revoke %i from %i'");
    expect(sql).toContain(
      'grant emdo_finance_import_retention to emdo_finance_import_retention_login\n\twith inherit false, set true, admin false',
    );
  });

  it('keeps application readiness independent from login enablement but exact on the role lattice', async () => {
    const sql = await readNormalized();

    expect(sql).toContain(
      'create or replace function emdo.finance_imports_ready()',
    );
    expect(sql).toContain("parent.rolname = 'emdo_finance_import_retention'");
    expect(sql).toContain(
      "child.rolname = 'emdo_finance_import_retention_login'",
    );
    expect(sql).toContain('membership.inherit_option = false');
    expect(sql).toContain('membership.set_option = true');
    expect(sql).toContain('membership.admin_option = false');
    expect(sql).toContain(') = 1');
    expect(sql).not.toContain(
      "rolname = 'emdo_finance_import_retention_login'\n\t\t\tand rolcanlogin = true",
    );
  });

  it('exposes only an exact-login readiness probe before role assumption', async () => {
    const sql = await readNormalized();

    expect(sql).toContain(
      'create or replace function emdo.finance_import_retention_runner_ready()',
    );
    expect(sql).toContain('language sql\nstable\nsecurity definer');
    expect(sql).toContain('set search_path = pg_catalog, emdo');
    expect(sql).toContain('set row_security = on');
    expect(sql).toContain(
      "session_user = 'emdo_finance_import_retention_login'",
    );
    expect(sql).toContain("current_database() = 'emdo_app'");
    expect(sql).toContain('rolcanlogin = true');
    expect(sql).toContain(
      "'emdo.purge_expired_finance_import_plans(integer)'::regprocedure",
    );
    expect(sql).toMatch(
      /alter function emdo\.finance_import_retention_runner_ready\(\)\s+owner to emdo_finance_import_executor/u,
    );
    expect(sql).toContain(
      'grant execute on function emdo.finance_import_retention_runner_ready()\n\tto emdo_finance_import_retention_login',
    );
    expect(sql).toContain(
      'revoke all on function emdo.finance_import_retention_runner_ready() from public',
    );
    expect(sql).not.toMatch(
      /grant execute on function[^;]+purge_expired_finance_import_plans[^;]+to emdo_finance_import_retention_login/u,
    );
  });

  it('does not alter the finance tables or widen raw login data privileges', async () => {
    const sql = await readNormalized();

    expect(sql).not.toMatch(/\b(?:create|alter|drop)\s+table\b/u);
    expect(sql).not.toMatch(
      /grant\s+(?:select|insert|update|delete)[^;]+to emdo_finance_import_retention_login/u,
    );
    expect(sql).toMatch(
      /revoke all privileges on all tables in schema emdo\s+from emdo_finance_import_retention_login/u,
    );
  });
});

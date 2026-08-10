import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../drizzle/0002_owner_bootstrap.sql',
  import.meta.url,
);
const packageUrl = new URL('../package.json', import.meta.url);
const indexUrl = new URL('./index.ts', import.meta.url);

const readMigration = async () =>
  (await readFile(migrationUrl, 'utf8')).toLowerCase().replaceAll('"', '');

describe('deployment-only initial owner bootstrap migration', () => {
  it('creates a durable singleton marker and narrow security-definer boundary', async () => {
    const sql = await readMigration();

    expect(sql).toContain('create table emdo.deployment_bootstraps');
    expect(sql).toContain("bootstrap_key = 'initial-owner-v1'");
    expect(sql).toContain(
      'create or replace function emdo.bootstrap_initial_owner',
    );
    expect(sql).toContain('security definer');
    expect(sql).toContain('set search_path = pg_catalog');
    expect(sql).toContain('set row_security = on');
    expect(sql).toContain('on conflict (bootstrap_key) do nothing');
    expect(sql).toMatch(/raise exception using\s+errcode = '55000'/);
    expect(sql).toMatch(
      /exists\s*\(\s*select 1 from emdo\.auth_users\s*\)[\s\S]+exists\s*\(\s*select 1 from emdo\.households\s*\)[\s\S]+exists\s*\(\s*select 1 from emdo\.household_memberships\s*\)/,
    );
    expect(sql).toContain(
      'initial owner bootstrap requires an empty identity database',
    );
  });

  it('uses separate hardened roles and gives the caller execute only', async () => {
    const sql = await readMigration();

    for (const role of [
      'emdo_owner_bootstrap',
      'emdo_owner_bootstrap_executor',
    ]) {
      expect(sql).toMatch(
        new RegExp(
          `create role ${role} nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls`,
        ),
      );
    }
    expect(sql).toMatch(
      /alter function emdo\.bootstrap_initial_owner\(text, text, text, text, text\)[\s\S]+owner to emdo_owner_bootstrap_executor/,
    );
    expect(sql).toMatch(
      /revoke all on function emdo\.bootstrap_initial_owner\(text, text, text, text, text\)[\s\S]+from public/,
    );
    expect(sql).toMatch(
      /grant execute on function emdo\.bootstrap_initial_owner\(text, text, text, text, text\)[\s\S]+to emdo_owner_bootstrap/,
    );
    expect(sql).toContain(
      'owner bootstrap roles must not have role memberships',
    );
    expect(sql).not.toMatch(
      /grant (select|insert|update|delete|truncate|references|trigger|maintain)[^;]+to emdo_owner_bootstrap\s*;/,
    );
  });

  it('creates the verified credential, canonical household, private space, and redacted audit atomically', async () => {
    const sql = await readMigration();

    for (const fragment of [
      'insert into emdo.auth_users',
      'insert into emdo.auth_accounts',
      'insert into emdo.households',
      'insert into emdo.household_memberships',
      'insert into emdo.spaces',
      'insert into emdo.audit_events',
      "'credential'",
      "'owner'",
      "'active'",
      "'private'",
      "'identity.owner-bootstrapped'",
      "'bootstrapkey', 'initial-owner-v1'",
    ]) {
      expect(sql).toContain(fragment);
    }
    expect(sql).toContain('pg_catalog.clock_timestamp()');
    expect(sql).not.toContain("'email', v_email");
    expect(sql).not.toContain("'password'");
    expect(sql).not.toContain("'passwordhash'");
  });

  it('keeps the marker and domain writes behind forced RLS executor policies', async () => {
    const sql = await readMigration();

    expect(sql).toContain(
      'alter table emdo.deployment_bootstraps enable row level security',
    );
    expect(sql).toContain(
      'alter table emdo.deployment_bootstraps force row level security',
    );
    for (const table of [
      'deployment_bootstraps',
      'households',
      'household_memberships',
      'spaces',
      'audit_events',
    ]) {
      expect(sql).toMatch(
        new RegExp(
          `create policy [^ ]+ on emdo\\.${table}[\\s\\S]+to emdo_owner_bootstrap_executor`,
        ),
      );
    }
  });

  it('keeps the command deployment-only and outside package exports', async () => {
    const packageJson = JSON.parse(await readFile(packageUrl, 'utf8')) as {
      readonly exports: Readonly<Record<string, string>>;
      readonly scripts: Readonly<Record<string, string>>;
    };
    const indexSource = await readFile(indexUrl, 'utf8');

    expect(packageJson.exports).toEqual({ '.': './src/index.ts' });
    expect(packageJson.scripts['deploy:bootstrap-owner']).toBe(
      'node ./deployment/bootstrap-owner.ts',
    );
    expect(indexSource).not.toMatch(/bootstrap-owner|bootstrap_initial_owner/);
  });
});

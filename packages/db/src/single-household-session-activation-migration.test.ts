import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { loadOrderedMigrations } from './migrations.js';

const migrationUrl = new URL(
  '../drizzle/0015_single_household_session_activation.sql',
  import.meta.url,
);

const normalizedSql = async (): Promise<string> =>
  (await readFile(migrationUrl, 'utf8'))
    .replaceAll(/\s+/gu, ' ')
    .trim()
    .toLowerCase();

describe('single-household session activation migration', () => {
  it('remains migration 0015 immediately before Finance document knowledge', async () => {
    const migrations = await loadOrderedMigrations();
    expect(migrations.at(15)).toMatchObject({
      id: '0015_single_household_session_activation',
      index: 15,
    });
    expect(migrations.at(16)).toMatchObject({
      id: '0016_finance_document_knowledge',
      index: 16,
    });
    expect(migrations.at(17)).toMatchObject({
      id: '0017_approval_resume_public_events',
      index: 17,
    });
  });

  it('derives only an exact single active membership behind a private owner boundary', async () => {
    const sql = await normalizedSql();
    expect(sql).toContain(
      'create or replace function emdo.resolve_exactly_one_active_household_for_auth_session( p_user_id uuid )',
    );
    expect(sql).toContain('security definer');
    expect(sql).toContain('set search_path = pg_catalog, emdo');
    expect(sql).toContain('set row_security = on');
    expect(sql).toContain("membership.status = 'active'");
    expect(sql).toContain('membership.ended_at is null');
    expect(sql).toContain(
      'other_membership.household_id <> membership.household_id',
    );
    expect(sql).toContain(
      'alter function emdo.resolve_exactly_one_active_household_for_auth_session(uuid) owner to emdo_policy_reader',
    );
  });

  it('exposes only the aggregate to auth and keeps raw membership authority private', async () => {
    const sql = await normalizedSql();
    expect(sql).toContain(
      'revoke all on function emdo.resolve_exactly_one_active_household_for_auth_session(uuid) from public, emdo_app, emdo_auth, emdo_worker, emdo_workflow, emdo_policy_reader',
    );
    expect(sql).toContain(
      'grant execute on function emdo.resolve_exactly_one_active_household_for_auth_session(uuid) to emdo_auth',
    );
    expect(sql).not.toMatch(
      /grant select on[^;]*household_memberships[^;]*to emdo_auth/u,
    );
  });
});

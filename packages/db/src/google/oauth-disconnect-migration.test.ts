import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { loadOrderedMigrations } from '../migrations.js';

const migrationUrl = new URL(
  '../../drizzle/0010_google_oauth_disconnect_operations.sql',
  import.meta.url,
);

const readNormalized = async () =>
  (await readFile(migrationUrl, 'utf8')).toLowerCase().replaceAll('"', '');

const extractFunction = (sql: string, name: string): string => {
  const start = sql.indexOf(`create or replace function emdo.${name}`);
  if (start < 0) throw new Error(`missing function ${name}`);
  const end = sql.indexOf('--> statement-breakpoint', start);
  return sql.slice(start, end < 0 ? undefined : end);
};

describe('Google OAuth disconnect operations migration', () => {
  it('is journaled as the narrow 0010 provider-side-effect fence', async () => {
    const migrations = await loadOrderedMigrations();
    const migration = migrations.find(
      ({ id }) => id === '0010_google_oauth_disconnect_operations',
    );

    expect(migration).toMatchObject({
      id: '0010_google_oauth_disconnect_operations',
      index: 10,
    });
  });

  it('stores actor-session-key receipts behind forced RLS without raw app DML', async () => {
    const sql = await readNormalized();

    expect(sql).toContain(
      'create table emdo.google_oauth_disconnect_operations',
    );
    expect(sql).toContain(
      'google_oauth_disconnect_operations_scope_key_unique',
    );
    expect(sql).toContain(
      'alter table emdo.google_oauth_disconnect_operations enable row level security',
    );
    expect(sql).toContain(
      'alter table emdo.google_oauth_disconnect_operations force row level security',
    );
    expect(sql).not.toMatch(
      /grant (?:select|insert|update|delete)[^;]+google_oauth_disconnect_operations[^;]+to emdo_app/u,
    );
    expect(sql).toContain(
      "state in ('claimed', 'dispatching', 'linked', 'completed')",
    );
    expect(sql).toContain('providerrevocation');
    expect(sql).not.toContain('refresh_token');
    expect(sql).not.toContain('access_token');
  });

  it('uses one-way claim, dispatch, and local settlement aggregates', async () => {
    const sql = await readNormalized();

    expect(sql).toContain(
      'create or replace function emdo.claim_google_oauth_disconnect',
    );
    expect(sql).toContain(
      'create or replace function emdo.mark_google_oauth_disconnect_dispatching',
    );
    expect(sql).toContain(
      'create or replace function emdo.settle_google_oauth_disconnect',
    );
    expect(sql).toContain(
      "domain', 'emdo.google-calendar.oauth-disconnect.v1'",
    );
    expect(sql).toContain('emdo.lock_active_request_scope');
    expect(sql).toContain('emdo.current_user_id()');
    expect(sql).toContain('emdo.current_session_id()');
    expect(sql).toContain('emdo.current_request_id()');
    expect(sql).toContain("state = 'dispatching'");
    expect(sql).toContain("state = 'completed'");
    expect(sql).toContain('delete from emdo.encrypted_google_calendar_grants');
    expect(sql).toContain('emdo.invalidate_google_oauth_flows');
    expect(sql).toContain("return query select 'replayed'::text");
    expect(sql).toContain("return query select 'conflict'::text");
  });

  it('globally fences one active actor disconnect and links rotated request receipts', async () => {
    const sql = await readNormalized();

    expect(sql).toContain('parent_operation_id');
    expect(sql).toContain('dispatch_session_id');
    expect(sql).toContain('completed_session_id');
    expect(sql).toContain(
      "state in ('claimed', 'dispatching', 'linked', 'completed')",
    );
    expect(sql).toMatch(
      /create unique index google_oauth_disconnect_operations_active_actor_unique[\s\S]+household_id[\s\S]+private_space_id[\s\S]+original_owner_user_id[\s\S]+where parent_operation_id is null[\s\S]+state in \('claimed', 'dispatching'\)/u,
    );
    expect(sql).not.toMatch(
      /create unique index google_oauth_disconnect_operations_active_actor_unique[^;]+credential_revision/u,
    );
    expect(sql).toMatch(
      /where stored\.parent_operation_id is null[\s\S]+stored\.household_id = p_household_id[\s\S]+stored\.private_space_id = p_private_space_id[\s\S]+stored\.original_owner_user_id = p_user_id[\s\S]+stored\.state in \('claimed', 'dispatching'\)/u,
    );
    expect(sql).toMatch(
      /insert into emdo\.google_oauth_disconnect_operations[\s\S]+parent_operation_id[\s\S]+state[\s\S]+linked/u,
    );
    expect(sql).not.toMatch(
      /where stored\.id = p_operation_id[\s\S]{0,320}stored\.session_id = p_session_id/u,
    );
    expect(sql).toMatch(
      /update emdo\.google_oauth_disconnect_operations as linked[\s\S]+where linked\.parent_operation_id = v_existing\.id[\s\S]+linked\.state = 'linked'/u,
    );
  });

  it('removes local authority in the dispatch transaction and fences every credential mutation', async () => {
    const sql = await readNormalized();
    const dispatch = extractFunction(
      sql,
      'mark_google_oauth_disconnect_dispatching',
    );
    const settlement = extractFunction(sql, 'settle_google_oauth_disconnect');

    expect(sql).toContain(
      'create or replace function emdo.enforce_google_calendar_grant_disconnect_fence',
    );
    expect(sql).toMatch(
      /create trigger encrypted_google_calendar_grants_disconnect_fence[\s\S]+before insert or update or delete on emdo\.encrypted_google_calendar_grants/u,
    );
    expect(dispatch).toContain(
      'delete from emdo.encrypted_google_calendar_grants',
    );
    expect(dispatch).toContain('emdo.invalidate_google_oauth_flows');
    expect(
      dispatch.indexOf('delete from emdo.encrypted_google_calendar_grants'),
    ).toBeLessThan(
      dispatch.lastIndexOf("return query select 'dispatching'::text"),
    );
    expect(settlement).not.toContain(
      'delete from emdo.encrypted_google_calendar_grants',
    );
    expect(settlement).toContain(
      'v_current_epoch is distinct from v_existing.authorization_epoch + 1',
    );
  });

  it('provides an isolated no-provider reconciliation aggregate for aged dispatches', async () => {
    const sql = await readNormalized();
    const reconciliation = extractFunction(
      sql,
      'reconcile_stranded_google_oauth_disconnects',
    );

    expect(sql).toMatch(
      /create role emdo_google_oauth_disconnect_reconciliation\s+nologin/u,
    );
    expect(sql).toMatch(
      /create role emdo_google_oauth_disconnect_reconciliation_executor\s+nologin/u,
    );
    expect(reconciliation).toContain("stored.state = 'dispatching'");
    expect(reconciliation).toContain("interval '10 minutes'");
    expect(reconciliation).toContain("'providerrevocation', 'unconfirmed'");
    expect(reconciliation).toContain("completion_source = 'reconciliation'");
    expect(reconciliation).toContain('encrypted_google_calendar_grants');
    expect(reconciliation).not.toContain('for share');
    expect(reconciliation).not.toContain('revoke');
    expect(sql).toMatch(
      /grant execute on function emdo\.reconcile_stranded_google_oauth_disconnects\(integer\)[^;]+to emdo_google_oauth_disconnect_reconciliation/u,
    );
    expect(sql).toMatch(
      /revoke all on function emdo\.reconcile_stranded_google_oauth_disconnects\(integer\)[^;]+from public, emdo_app/u,
    );
  });

  it('exposes only the three actor-scoped aggregates and an exact readiness probe', async () => {
    const sql = await readNormalized();

    for (const routine of [
      'claim_google_oauth_disconnect',
      'mark_google_oauth_disconnect_dispatching',
      'settle_google_oauth_disconnect',
    ]) {
      expect(sql).toMatch(
        new RegExp(
          `grant execute on function emdo\\.${routine}\\([^;]+to emdo_app`,
          'u',
        ),
      );
    }
    expect(sql).toContain(
      'create or replace function emdo.google_oauth_disconnect_ready',
    );
    expect(sql).toContain(
      'create or replace function emdo.purge_completed_google_oauth_disconnects',
    );
    expect(sql).toMatch(
      /revoke all on function emdo\.purge_completed_google_oauth_disconnects\(integer\)[^;]+from public, emdo_app/u,
    );
    expect(sql).toContain('rolcanlogin = false');
    expect(sql).toContain('rolinherit = false');
    expect(sql).toContain('rolbypassrls = false');
    expect(sql).toContain("'row_security=on', 'search_path=pg_catalog, emdo'");
    expect(sql).toContain('emdo_google_oauth_disconnect_retention');
    expect(sql).toMatch(
      /'emdo_google_oauth_disconnect_retention'::regrole\s+in \(membership\.roleid, membership\.member\)/u,
    );
    expect(sql).toMatch(
      /grant execute on function emdo\.purge_completed_google_oauth_disconnects\(integer\)[^;]+to emdo_google_oauth_disconnect_retention/u,
    );
  });
});

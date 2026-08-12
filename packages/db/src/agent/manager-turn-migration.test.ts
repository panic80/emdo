import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../drizzle/0003_durable_runtime_repositories.sql',
  import.meta.url,
);

const readMigration = async () =>
  (await readFile(migrationUrl, 'utf8')).toLowerCase().replaceAll('"', '');

describe('durable manager turn aggregate migration', () => {
  it('stores exact request, origin authority, terminal result, and readback lineage', async () => {
    const sql = await readMigration();

    expect(sql).toContain('create table emdo.manager_turns');
    expect(sql).toContain('create table emdo.manager_turn_operations');
    for (const column of [
      'origin_session_id',
      'origin_request_id',
      'origin_space_access_grant_id',
      'origin_collection_authorization_scope_fingerprint',
      'origin_operation_authorization_scope_fingerprint',
      'request_hash',
      'ownership_token_hash',
      'result_hash',
      'terminal_event_sequence',
      'stored_result',
      'operation_hash',
    ]) {
      expect(sql).toContain(column);
    }
    expect(sql).toContain('manager_turn_operations_append_only');
    expect(sql).toContain('manager_turns_transition');
  });

  it('derives current operation authority in the database and never accepts a fingerprint parameter', async () => {
    const sql = await readMigration();
    const claim = sql.match(
      /create or replace function emdo\.claim_manager_turn[\s\S]+?end\s*\$function\$/u,
    )?.[0];

    expect(claim).toContain('lock_current_authorization_scope');
    expect(claim).toContain(
      'origin_collection_authorization_scope_fingerprint',
    );
    expect(claim).toContain('origin_operation_authorization_scope_fingerprint');
    expect(claim).not.toContain('p_authorization_scope_fingerprint');
    expect(claim).not.toContain('p_collection_authorization_scope_fingerprint');
  });

  it('atomically appends ordered run events and stages the exact approval resume job', async () => {
    const sql = await readMigration();
    const complete = sql.match(
      /create or replace function emdo\.complete_manager_turn[\s\S]+?end\s*\$function\$/u,
    )?.[0];

    expect(complete).toContain('for update');
    expect(complete).toContain('approval_checkpoints');
    expect(complete).toContain('agent_run_events');
    expect(complete).toContain('approval_resume_jobs');
    expect(complete).toContain('with ordinality');
    expect(complete).toContain('approval_event_sequence');
    expect(complete).toContain('disclosure_policy_version');
    expect(complete).toContain('preparation_binding');
    expect(complete).toContain(
      "preparation_binding ->> 'disclosurepolicyversion'",
    );
    expect(complete).not.toContain("version::text || '.0.0'");
    expect(complete).toContain(
      'origin_operation_authorization_scope_fingerprint',
    );
    expect(complete).toContain("'awaiting-decision'");
  });

  it('uses a membership-free executor, narrow security-definer functions, and no app table DML', async () => {
    const sql = await readMigration();

    expect(sql).toContain('create role emdo_manager_turn_executor nologin');
    for (const routine of [
      'claim_manager_turn',
      'complete_manager_turn',
      'mark_manager_turn_indeterminate',
      'read_manager_turn_operation',
      'manager_turn_store_ready',
    ]) {
      expect(sql).toMatch(
        new RegExp(
          `create or replace function emdo\\.${routine}[\\s\\S]+?security definer[\\s\\S]+?set row_security = on`,
          'u',
        ),
      );
    }
    expect(sql).toMatch(
      /alter function emdo\.complete_manager_turn[\s\S]+?owner to emdo_manager_turn_executor/u,
    );
    expect(sql).toMatch(
      /grant execute on function[\s\S]+?claim_manager_turn[\s\S]+?complete_manager_turn[\s\S]+?to emdo_app/u,
    );
    expect(sql).not.toMatch(
      /grant (?:select|insert|update|delete)[^;]+emdo\.manager_turn(?:s|_operations)[^;]+to emdo_app/u,
    );
  });

  it('records exact operation outcomes for fail-closed post-commit readback', async () => {
    const sql = await readMigration();

    expect(sql).toContain(
      'create or replace function emdo.read_manager_turn_operation',
    );
    expect(sql).toContain(
      'v_operation.request_claim_id is distinct from p_request_claim_id',
    );
    expect(sql).toContain(
      'v_operation.request_ownership_token_hash is distinct from',
    );
    expect(sql).toContain(
      'v_operation.operation_hash is distinct from p_operation_hash',
    );
    expect(sql).toContain('v_operation.stored_result');
  });

  it('makes readiness verify every callable boundary and the private helper', async () => {
    const sql = await readMigration();
    const readiness = sql.match(
      /create or replace function emdo\.manager_turn_store_ready[\s\S]+?end\s*\$function\$/u,
    )?.[0];

    expect(readiness).toMatch(
      /has_function_privilege[\s\S]+?claim_manager_turn/u,
    );
    expect(readiness).toMatch(
      /has_function_privilege[\s\S]+?complete_manager_turn/u,
    );
    expect(readiness).toMatch(
      /has_function_privilege[\s\S]+?mark_manager_turn_indeterminate/u,
    );
    expect(readiness).toMatch(
      /has_function_privilege[\s\S]+?read_manager_turn_operation/u,
    );
    expect(readiness).toMatch(
      /not\s+pg_catalog\.has_function_privilege[\s\S]+?record_manager_turn_operation/u,
    );
  });
});

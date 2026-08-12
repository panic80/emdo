import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../drizzle/0003_durable_runtime_repositories.sql',
  import.meta.url,
);

const readMigration = async () =>
  (await readFile(migrationUrl, 'utf8')).toLowerCase().replaceAll('"', '');

describe('durable runtime repository migration', () => {
  it('creates each runtime persistence boundary in one ordered migration', async () => {
    const sql = await readMigration();

    for (const table of [
      'ai_spend_reservations',
      'approval_checkpoints',
      'agent_run_events',
      'sync_clients',
      'sync_entities',
      'sync_operation_receipts',
      'scheduler_execution_receipts',
      'worker_operation_outbox',
      'worker_job_executions',
      'scheduler_reminders',
      'notifications',
      'notification_deliveries',
      'calendar_sync_states',
      'calendar_maintenance_receipts',
      'space_access_grants',
    ]) {
      expect(sql).toContain(`create table emdo.${table}`);
      expect(sql).toContain(
        `alter table emdo.${table} enable row level security`,
      );
      expect(sql).toContain(
        `alter table emdo.${table} force row level security`,
      );
    }
  });

  it('derives worker scope from canonical outbox rows and exposes only narrow dispatch functions', async () => {
    const sql = await readMigration();

    expect(sql).toContain(
      'create or replace function emdo.claim_worker_operation_scope',
    );
    expect(sql).toContain(
      'create or replace function emdo.claim_due_worker_outbox',
    );
    expect(sql).toMatch(/for update(?: of candidate)? skip locked/);
    expect(sql).toContain("set_config('emdo.worker_operation_id'");
    expect(sql).toContain("set_config('emdo.worker_job_name'");
    expect(sql).toContain('create role emdo_worker_executor nologin');
    expect(sql).toContain("child.rolname = 'emdo_worker_executor'");
    expect(sql).toMatch(
      /grant execute on function[\s\S]+emdo\.claim_due_worker_outbox[\s\S]+to emdo_worker_executor/,
    );
    expect(sql).not.toMatch(/grant all/);
  });

  it('keeps worker effects reference-bound, revisioned, and free of raw provider failure bodies', async () => {
    const sql = await readMigration();

    expect(sql).toContain('worker_job_executions_state_check');
    expect(sql).toContain('worker_job_executions_payload_hash_check');
    expect(sql).toContain('scheduler_reminders_due_revision_positive');
    expect(sql).toContain('notifications_source_revision_positive');
    expect(sql).toContain('notification_deliveries_external_payload_check');
    expect(sql).toContain('calendar_sync_states_generation_nonnegative');
    expect(sql).toContain('calendar_maintenance_receipts_safe_code_check');
    expect(sql).not.toContain('provider_error_body');
    expect(sql).not.toContain('raw_error');
  });

  it('uses canonical request claims, database time, and transaction-held authorization locks', async () => {
    const sql = await readMigration();

    expect(sql).toContain(
      'create or replace function emdo.lock_active_request_scope',
    );
    expect(sql).toContain(
      'create or replace function emdo.resolve_sync_access',
    );
    expect(sql).toContain('pg_catalog.clock_timestamp()');
    expect(sql).toContain('for share');
    expect(sql).toContain('emdo.current_user_id()');
    expect(sql).toContain('emdo.current_session_id()');
    expect(sql).toContain('emdo.current_request_id()');
    expect(sql).toContain('session.active_household_id = p_household_id');
    expect(sql).toContain("membership.status = 'active'");
  });

  it('serializes OAuth flow consumption and invalidation against authorization revocation', async () => {
    const sql = await readMigration();

    const consume = sql.match(
      /create or replace function emdo\.consume_google_oauth_flow[\s\S]+?end\s*\$function\$/,
    )?.[0];
    const invalidate = sql.match(
      /create or replace function emdo\.invalidate_google_oauth_flows[\s\S]+?end\s*\$function\$/,
    )?.[0];

    expect(consume).toContain('emdo.lock_active_request_scope');
    expect(invalidate).toContain('emdo.lock_active_request_scope');
    expect(sql).toMatch(
      /grant execute on function[\s\S]+emdo\.lock_active_request_scope\(uuid, uuid, uuid\)[\s\S]+to emdo_oauth_flow_executor/,
    );
  });

  it('binds encrypted Google Calendar grants to a server-derived provider authority reference', async () => {
    const sql = await readMigration();

    expect(sql).toContain('provider_grant_reference text not null');
    expect(sql).toContain(
      'create or replace function emdo.compare_and_set_encrypted_google_calendar_grant',
    );
    expect(sql).toContain(
      'create or replace function emdo.lock_current_google_calendar_authority',
    );
    expect(sql).toContain(
      'create or replace function emdo.resolve_current_google_calendar_authority',
    );
    expect(sql).toContain(
      'create or replace function emdo.advance_google_oauth_authorization_epoch',
    );
    const verifier = sql.match(
      /create or replace function emdo\.lock_current_google_calendar_authority[\s\S]+?end\s*\$function\$/,
    )?.[0];
    expect(verifier).toContain('authorizationepoch');
    expect(verifier).toContain('authorizationscopefingerprint');
    expect(verifier).toContain('providergrantreference');
    expect(verifier).toContain('google-calendar-grant-v2');
    expect(verifier).not.toContain('google-calendar-grant-v1');
    expect(verifier).not.toContain('spaceaccessgrantid');
    expect(verifier).toContain('for share of stored, epoch');
    expect(verifier).toContain('sha256');
    expect(verifier!.indexOf('for share of stored, epoch')).toBeLessThan(
      verifier!.indexOf('v_binding :='),
    );
    expect(verifier!.match(/emdo\.lock_active_request_scope/gu)).toHaveLength(
      2,
    );
    expect(sql).toMatch(
      /compare_and_set_encrypted_google_calendar_grant[\s\S]+?p_provider_grant_reference is null[\s\S]+?p_encrypted_payload is null[\s\S]+?when unique_violation then[\s\S]+?return null/,
    );
    expect(sql).toMatch(
      /if p_expected_revision is null then[\s\S]+?insert into emdo\.encrypted_google_calendar_grants[\s\S]+?else[\s\S]+?update emdo\.encrypted_google_calendar_grants as stored[\s\S]+?stored\.revision = p_expected_revision/,
    );
    expect(sql).toMatch(
      /alter function emdo\.lock_current_google_calendar_authority\(uuid, uuid, uuid, text, text\)[\s\S]+owner to emdo_oauth_grant_executor/,
    );
    expect(sql).toMatch(
      /revoke all on emdo\.google_oauth_flows,\s+emdo\.google_oauth_authorization_epochs,\s+emdo\.encrypted_google_calendar_grants[\s\S]+from public, emdo_app/,
    );
    expect(sql).not.toMatch(
      /grant (?:select|insert|update|delete)(?:, (?:select|insert|update|delete))* on\s+emdo\.encrypted_google_calendar_grants\s+to emdo_app/,
    );
  });

  it('keeps encrypted checkpoint state bounded and enforces one-way CAS lifecycles', async () => {
    const sql = await readMigration();

    expect(sql).toContain('approval_checkpoints_sealed_state_size_check');
    expect(sql).toMatch(/octet_length\(sealed_state\) between 1 and 1400000/);
    expect(sql).toContain('approval_checkpoints_transition');
    expect(sql).toMatch(/old\.revision \+ 1/);
    expect(sql).toContain("old.state = 'pending'");
    expect(sql).toContain(
      "new.state not in ('resumed', 'cancelled', 'expired')",
    );
  });

  it('makes event, sync receipt, and provider receipt histories immutable', async () => {
    const sql = await readMigration();

    for (const table of ['agent_run_events', 'sync_operation_receipts']) {
      expect(sql).toMatch(
        new RegExp(
          `create trigger ${table}_append_only[\\s\\S]+before update or delete on emdo\\.${table}`,
        ),
      );
    }
    expect(sql).toContain('scheduler_execution_receipts_transition');
    expect(sql).toContain("old.state = 'pending' and new.state = 'completed'");
  });

  it('provides a narrow post-dispatch settlement function without table access for callers', async () => {
    const sql = await readMigration();

    expect(sql).toContain('create role emdo_metering_executor nologin');
    expect(sql).toContain('create or replace function emdo.settle_ai_spend');
    expect(sql).toContain('security definer');
    expect(sql).toContain('set row_security = on');
    expect(sql).toMatch(
      /grant execute on function[\s\S]+emdo\.settle_ai_spend[\s\S]+to emdo_app/,
    );
    expect(sql).toContain('ai_spend_metering_executor_update');
    expect(sql).not.toMatch(/grant all/);
  });

  it('derives the locked Toronto billing period and CAD spend thresholds inside PostgreSQL', async () => {
    const sql = await readMigration();
    const reserve = sql.match(
      /create or replace function emdo\.reserve_ai_spend[\s\S]+?end\s*\$function\$/,
    )?.[0];
    const transition = sql.match(
      /create or replace function emdo\.transition_ai_spend[\s\S]+?end\s*\$function\$/,
    )?.[0];
    const settle = sql.match(
      /create or replace function emdo\.settle_ai_spend[\s\S]+?end\s*\$function\$/,
    )?.[0];

    expect(reserve).toContain("at time zone 'america/toronto'");
    expect(reserve).toContain('p_period is distinct from v_period');
    expect(reserve).toContain('p_warning_cad_minor <> 5000');
    expect(reserve).toContain('p_limit_cad_minor <> 7500');
    expect(reserve).toContain('emdo.lock_active_request_scope');
    expect(transition).toContain('emdo.lock_active_request_scope');
    expect(settle).toContain('emdo.lock_active_request_scope');
  });

  it('bounds retention metadata to the approved operational window', async () => {
    const sql = await readMigration();

    expect(sql).toContain(
      "default (pg_catalog.clock_timestamp() + interval '90 days')",
    );
    expect(sql).toMatch(
      /retain_until[^;]+<= [^;]+created_at \+ interval '90 days'/,
    );
  });

  it('constrains replicated entity identity and intent at the database boundary', async () => {
    const sql = await readMigration();

    expect(sql).toContain('sync_entities_entity_type_check');
    expect(sql).toContain(
      "entity_type in ('conversation.event', 'scheduler.item'",
    );
    expect(sql).toContain('sync_entities_entity_id_check');
    expect(sql).toMatch(/length\([^)]*entity_id\) between 1 and 512/);
    expect(sql).toContain('sync_entities_actor_intent_check');
    expect(sql).toMatch(/length\([^)]*actor_intent\) between 3 and 1000/);
  });

  it('issues opaque request-current space grants only through canonical database commands', async () => {
    const sql = await readMigration();

    expect(sql).toContain('create role emdo_space_grant_executor nologin');
    expect(sql).toContain(
      'create or replace function emdo.issue_space_access_grant',
    );
    expect(sql).toContain(
      'create or replace function emdo.resolve_space_access_grant',
    );
    expect(sql).toMatch(
      /issue_space_access_grant[\s\S]+lock_active_request_scope/,
    );
    expect(sql).toMatch(
      /resolve_space_access_grant[\s\S]+lock_active_request_scope/,
    );
    expect(sql).toContain('space_access_grants_immutable');
    expect(sql).toContain('writable_space_ids');
    expect(sql).toMatch(
      /grant execute on function[\s\S]+issue_space_access_grant[\s\S]+to emdo_app/,
    );
    expect(sql).not.toMatch(
      /grant (?:select|insert|update|delete)[^;]+space_access_grants[^;]+to emdo_app/,
    );
  });
});

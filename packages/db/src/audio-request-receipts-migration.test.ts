import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../drizzle/0004_audio_request_receipts.sql',
  import.meta.url,
);

const readMigration = async () =>
  (await readFile(migrationUrl, 'utf8')).toLowerCase().replaceAll('"', '');

describe('audio request receipts migration', () => {
  it('creates a forced-RLS receipt with immutable request and principal bindings', async () => {
    const sql = await readMigration();

    expect(sql).toContain('create table emdo.audio_request_receipts');
    for (const column of [
      'household_id',
      'user_id',
      'authenticated_session_id',
      'idempotency_key',
      'kind',
      'model',
      'input_units',
      'request_fingerprint',
      'claim_generation',
      'claim_id',
      'ownership_token_hash',
      'execution_id',
      'reservation_id',
      'lease_expires_at',
      'state',
      'reconciliation_status',
      'version',
    ]) {
      expect(sql).toContain(column);
    }
    expect(sql).toContain('unique (household_id, user_id, idempotency_key)');
    expect(sql).toContain(
      'alter table emdo.audio_request_receipts enable row level security',
    );
    expect(sql).toContain(
      'alter table emdo.audio_request_receipts force row level security',
    );
    expect(sql).toContain('audio_request_receipts_immutable_binding');
  });

  it('provides one transactional owner and exact conflict/replay/crash outcomes', async () => {
    const sql = await readMigration();
    const claim = sql.match(
      /create or replace function emdo\.claim_audio_request[\s\S]+?end\s*\$function\$/,
    )?.[0];
    const scopeGuard = sql.match(
      /create or replace function emdo\.audio_request_scope_is_current[\s\S]+?end\s*\$function\$/,
    )?.[0];

    expect(claim).toContain('pg_advisory_xact_lock');
    expect(claim).toContain('for update');
    expect(claim).toContain('audio_request_scope_is_current');
    expect(scopeGuard).toContain('lock_active_request_scope');
    expect(claim).toContain("'claimed'");
    expect(claim).toContain("'in-progress'");
    expect(claim).toContain("'conflict'");
    expect(claim).toContain("'replay'");
    expect(claim).toContain("'completed-nonreplayable'");
    expect(claim).toContain("'indeterminate'");
    expect(claim).toContain('lease_expires_at <= pg_catalog.clock_timestamp()');
    expect(claim).toContain("reason_code = 'claim-lease-expired'");
    const expiredLease = claim?.match(
      /if v_receipt\.lease_expires_at <= pg_catalog\.clock_timestamp\(\) then[\s\S]+?record_audio_request_claim_outcome\([\s\S]+?\);/,
    )?.[0];
    expect(expiredLease).toContain("set state = 'indeterminate'");
    expect(expiredLease).not.toContain("set state = 'claimed'");
  });

  it('separates safe no-dispatch release from terminal indeterminate settlement', async () => {
    const sql = await readMigration();

    expect(sql).toContain(
      'create or replace function emdo.release_audio_request_claim',
    );
    expect(sql).toContain(
      'create or replace function emdo.mark_audio_request_indeterminate',
    );
    expect(sql).toContain("state = 'released'");
    expect(sql).toContain("state = 'indeterminate'");
    expect(sql).toContain("reconciliation_status = 'pending'");
    expect(sql).toContain('enforce_audio_request_receipt_transition');
    expect(sql).toContain('old.ownership_token_hash');
    expect(sql).toContain('old.claim_id');
  });

  it('allows exact settlement readback but prevents terminal regression and stale-token mutation', async () => {
    const sql = await readMigration();

    expect(sql).toContain('create table emdo.audio_request_receipt_operations');
    expect(sql).toContain('audio_request_receipt_operations_token_shape_check');
    expect(sql).toContain('ownership_token_hash');
    expect(sql).toContain('audio_request_receipt_operations_append_only');
    expect(sql).toContain('unique (receipt_id, receipt_revision)');
    expect(sql).toContain(
      'create or replace function emdo.complete_audio_transcription',
    );
    expect(sql).toContain(
      'create or replace function emdo.complete_audio_speech',
    );
    expect(sql).toContain("'exact-replay'");
    expect(sql).toContain("'denied'");
    expect(sql).toContain(
      'create or replace function emdo.read_audio_request_claim',
    );
    expect(sql).toContain(
      'create or replace function emdo.read_audio_request_operation',
    );
    expect(sql).toContain(
      'operation.ownership_token_hash = p_ownership_token_hash',
    );
    expect(sql).toContain('ownership_token_hash = p_ownership_token_hash');
    expect(sql).toContain('audio request terminal state cannot regress');
    expect(sql).toContain('p_transcript is null or p_model is null');
    expect(sql).toContain('p_model is null or p_content_type is null');
    expect(sql).toContain('result_model is not null');
    expect(sql).toContain('result_content_type is not null');
  });

  it('persists exact read-only claim outcomes without mutating the receipt revision', async () => {
    const sql = await readMigration();

    expect(sql).toContain('create table emdo.audio_request_claim_outcomes');
    expect(sql).toContain('audio_request_claim_outcomes_append_only');
    expect(sql).toContain('operation_id uuid primary key');
    expect(sql).toContain('operation_hash');
    expect(sql).toContain('origin_request_id');
    expect(sql).toContain('claim_id');
    expect(sql).toContain('ownership_token_hash');
    expect(sql).toContain('claim_generation');
    expect(sql).toContain('receipt_revision');
    expect(sql).toContain('stored_result jsonb');
    expect(sql).toContain('is_safe_audio_claim_outcome');
    expect(sql).toContain('from pg_catalog.jsonb_object_keys(p_result)');
    expect(sql).not.toContain('jsonb_object_length');
    expect(sql).toContain('insert into emdo.audio_request_claim_outcomes');
    expect(sql).toContain('read_audio_request_claim');
    expect(sql).toContain('outcome.operation_id = p_operation_id');
    expect(sql).toContain('outcome.operation_hash = p_operation_hash');
    expect(sql).toContain(
      'outcome.origin_request_id = emdo.current_request_id()',
    );
    expect(sql).toContain('outcome.stored_result');
    expect(sql).not.toContain(
      'read-only claim outcomes do not consume a receipt revision. re-evaluate',
    );
  });

  it('rejects NULL-pass terminal shapes and preserves execution evidence through operator resolution', async () => {
    const sql = await readMigration();
    const transition = sql.match(
      /create or replace function emdo\.enforce_audio_request_receipt_transition[\s\S]+?end\s*\$function\$/,
    )?.[0];

    expect(sql).toContain(
      'constraint audio_request_receipts_result_shape_check check (coalesce(',
    );
    expect(sql).toContain(
      'constraint audio_request_receipts_lifecycle_shape_check check (coalesce(',
    );
    expect(sql).toContain(
      'constraint audio_request_receipts_reconciliation_shape_check check (coalesce(',
    );
    expect(sql).toMatch(
      /constraint audio_request_receipt_operations_generation_shape_check\s+check \(coalesce\(/u,
    );
    expect(transition).toContain(
      'new.execution_id is distinct from old.execution_id',
    );
    expect(transition).toContain(
      'new.reservation_id is distinct from old.reservation_id',
    );
    expect(sql).toContain('p_operation_id is null or p_claim_id is null');
    expect(sql).toContain('p_operation_hash is null');
    expect(sql).toContain('p_ownership_token_hash is null');
  });

  it('supports unbounded positive revisions and bounded liveness-safe purging', async () => {
    const sql = await readMigration();

    expect(sql).not.toContain('p_expected_version not between 1 and 63');
    expect(sql).toContain('p_expected_version < 1');
    expect(sql).toContain('create role emdo_audio_retention nologin');
    expect(sql).toContain('create role emdo_audio_retention_executor nologin');
    expect(sql).toContain(
      'create or replace function emdo.purge_expired_audio_request_receipts',
    );
    expect(sql).toMatch(/receipt\.state in \(\s*'released'/u);
    expect(sql).toContain(
      'receipt.retain_until <= pg_catalog.clock_timestamp()',
    );
    expect(sql).toContain('delete from emdo.audio_request_claim_outcomes');
    expect(sql).toContain('delete from emdo.audio_request_receipt_operations');
    expect(sql).toContain('delete from emdo.audio_request_receipts');
    expect(sql).toMatch(
      /grant execute on function emdo\.purge_expired_audio_request_receipts\(integer\)[^;]+to emdo_audio_retention/u,
    );
  });

  it('keeps reconciliation bounded and isolated from the ordinary API role', async () => {
    const sql = await readMigration();

    expect(sql).toContain('create role emdo_audio_executor nologin');
    expect(sql).toContain(
      'create role emdo_audio_reconciliation_executor nologin',
    );
    expect(sql).toContain('create role emdo_audio_reconciliation nologin');
    expect(sql).toContain("session_user = 'emdo_audio_reconciliation_login'");
    expect(sql).toContain(
      'create or replace function emdo.audio_request_reconciliation_ready',
    );
    expect(sql).toContain(
      'create or replace function emdo.list_audio_request_reconciliation',
    );
    expect(sql).toContain(
      'create or replace function emdo.resolve_audio_request_reconciliation',
    );
    expect(sql).toContain('p_limit is null or p_limit not between 1 and 1000');
    expect(sql).toContain(
      'create or replace function emdo.read_audio_request_reconciliation_operation',
    );
    expect(sql).toContain(
      'resolve_audio_request_reconciliation(uuid, text, uuid, bigint, text, text)',
    );
    expect(sql).toMatch(
      /grant execute on function[\s\S]+list_audio_request_reconciliation[\s\S]+resolve_audio_request_reconciliation[\s\S]+read_audio_request_reconciliation_operation[\s\S]+to emdo_audio_reconciliation/,
    );
    expect(sql).toContain(
      "p_resolution not in (\n\t\t'confirmed-not-dispatched', 'confirmed-dispatched'",
    );
    expect(sql).not.toMatch(
      /grant execute on function emdo\.(?:list|resolve)_audio_request_reconciliation[^;]+to emdo_app/,
    );
    expect(sql).not.toMatch(
      /grant (?:select|insert|update|delete)[^;]+audio_request_receipts[^;]+to emdo_app/,
    );
  });

  it('exposes a narrow readiness function and never stores raw or generated audio bytes', async () => {
    const sql = await readMigration();
    const receiptTables = sql.match(
      /create table emdo\.audio_request_receipts[\s\S]+?create table emdo\.audio_request_receipt_operations[\s\S]+?\n\);/,
    )?.[0];

    expect(sql).toContain(
      'create or replace function emdo.audio_request_receipts_ready',
    );
    expect(sql).toMatch(
      /grant execute on function emdo\.audio_request_receipts_ready\(\)[^;]+to emdo_app/,
    );
    expect(receiptTables).not.toContain('bytea');
    expect(receiptTables).not.toContain('jsonb');
    expect(receiptTables).not.toContain('raw_audio');
    expect(receiptTables).not.toContain('generated_audio');
    expect(receiptTables).not.toContain('provider_error');
    expect(sql).toContain("session_user = 'emdo_api_login'");
    expect(sql).toContain('has_table_privilege');
    expect(sql).toContain('relforcerowsecurity');
    expect(sql).toContain(
      "privilege.grantee <>\n\t\t\t\t\t\t\tpg_catalog.to_regrole('emdo_app')",
    );
    expect(sql).toContain(
      "privilege.grantee <> pg_catalog.to_regrole(\n\t\t\t\t\t\t\t'emdo_audio_reconciliation'",
    );
    expect(sql).toContain('emdo.audio_request_receipts_ready()');
    expect(sql).toContain('select pg_catalog.count(*) = 8');
    expect(sql).toContain("'emdo_audio_reconciliation_executor'");
    expect(sql).toContain('not audio_role.rolcanlogin');
    expect(sql).toContain('not audio_role.rolinherit');
    expect(sql).toContain('not audio_role.rolbypassrls');
    expect(sql).toContain('not audio_role.rolsuper');
    expect(sql).toContain('not audio_role.rolcreatedb');
    expect(sql).toContain('not audio_role.rolcreaterole');
    expect(sql).toContain('not audio_role.rolreplication');
    expect(sql).toContain(
      "pg_has_role(\n\t\t\tsession_user, 'emdo_audio_reconciliation', 'member'",
    );
    expect(sql).toContain(
      "pg_has_role(\n\t\t\tsession_user, 'emdo_audio_reconciliation', 'set'",
    );
  });
});

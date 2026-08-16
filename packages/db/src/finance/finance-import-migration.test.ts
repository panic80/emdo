import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { loadOrderedMigrations } from '../migrations.js';

const migrationUrl = new URL(
  '../../drizzle/0008_finance_import_receipts.sql',
  import.meta.url,
);

const readNormalized = async (url: URL) =>
  (await readFile(url, 'utf8')).toLowerCase().replaceAll('"', '');

describe('finance import receipts migration', () => {
  it('is journaled as the narrow 0008 durable finance import upgrade', async () => {
    const migrations = await loadOrderedMigrations();
    const migration = migrations.find(
      ({ id }) => id === '0008_finance_import_receipts',
    );

    expect(migration?.id).toBe('0008_finance_import_receipts');
    expect(migration?.index).toBe(8);
  });

  it('keeps plans, duplicate fingerprints, and immutable receipts behind forced RLS', async () => {
    const sql = await readNormalized(migrationUrl);
    const tables = [
      'finance_import_plans',
      'finance_import_fingerprints',
      'finance_import_receipts',
    ];

    for (const table of tables) {
      expect(sql).toContain(`create table emdo.${table}`);
      expect(sql).toContain(
        `alter table emdo.${table} enable row level security`,
      );
      expect(sql).toContain(
        `alter table emdo.${table} force row level security`,
      );
      expect(sql).not.toMatch(
        new RegExp(
          `grant (?:select|insert|update|delete)[^;]+${table}[^;]+to emdo_app`,
          'u',
        ),
      );
    }
    expect(sql).toContain('finance_import_receipts_append_only');
    expect(sql).toContain('reject_append_only_mutation');
  });

  it('derives and locks the fresh grant plus current private finance account before persisting or committing', async () => {
    const sql = await readNormalized(migrationUrl);

    for (const routine of [
      'resolve_finance_import_scope',
      'read_finance_import_preview_scope',
      'persist_finance_import_plan',
      'commit_finance_import_plan',
    ]) {
      expect(sql).toContain(`create or replace function emdo.${routine}`);
    }
    expect(sql).toContain('emdo.resolve_space_access_grant');
    expect(sql).toContain('emdo.lock_active_request_scope');
    expect(sql).toContain("account.entity_type = 'finance.account'");
    expect(sql).toContain("space.visibility = 'private'");
    expect(sql).toContain('for share');
    expect(sql).toContain('for update');
  });

  it('exposes only active manual CAD destinations from the freshly locked private collection scope', async () => {
    const sql = await readNormalized(migrationUrl);

    expect(sql).toContain(
      'create or replace function emdo.read_finance_import_destinations',
    );
    expect(sql).toContain('emdo.lock_current_authorization_scope');
    expect(sql).toContain('v_authority.private_space_id');
    expect(sql).toContain("account.entity_type = 'finance.account'");
    expect(sql).toContain("category.entity_type = 'finance.category'");
    expect(sql).toContain("payload ->> 'currency' = 'cad'");
    expect(sql).toContain("payload ->> 'source' = 'manual'");
    expect(sql).toContain("payload ->> 'active' = 'true'");
    expect(sql).toContain(
      "order by (account.payload ->> 'name') collate c,\n\t\t\taccount.entity_id collate c",
    );
    expect(sql).toContain(
      "order by (category.payload ->> 'name') collate c,\n\t\t\tcategory.entity_id collate c",
    );
    expect(sql).toContain('limit 100');
    expect(sql).toContain('for share');
    expect(sql).toContain('is_valid_finance_import_destination');
    expect(sql).toContain(
      "'emdo.read_finance_import_destinations(uuid,uuid,text,text)'::regprocedure",
    );
    expect(sql).toContain(
      "'emdo_app', 'emdo.read_finance_import_destinations(uuid,uuid,text,text)', 'execute'",
    );
    expect(sql).toContain(
      'grant execute on function emdo.read_finance_import_destinations',
    );
    expect(sql).not.toMatch(
      /grant execute on function[^;]+read_finance_import_destinations[^;]+to public/u,
    );
  });

  it('persists no raw statement/header mapping data and exposes execute-only security-definer aggregates', async () => {
    const sql = await readNormalized(migrationUrl);

    expect(sql).toContain('create role emdo_finance_import_executor nologin');
    expect(sql).toContain('security definer');
    expect(sql).toContain('set row_security = on');
    expect(sql).toContain('finance_imports_ready');
    expect(sql).toMatch(
      /grant execute on function[\s\S]+commit_finance_import_plan[\s\S]+to emdo_app/u,
    );
    expect(sql).toContain(
      'grant execute on function emdo.read_finance_import_preview_scope',
    );
    expect(sql).not.toMatch(/source_text|raw_statement|statement_text/u);
    expect(sql).not.toMatch(/header_name|column_name|mapping_headers/u);
    expect(sql).toContain('mapping_metadata jsonb not null');
    expect(sql).toContain('diagnostics jsonb not null');
    expect(sql).toContain('plan_hash');
    expect(sql).toContain('source_hash');
  });

  it('binds exact replay to current scope, idempotency key, and the stored immutable plan hash', async () => {
    const sql = await readNormalized(migrationUrl);

    expect(sql).toContain('idempotency_key');
    expect(sql).toContain('plan_hash');
    expect(sql).toContain('scope_fingerprint');
    expect(sql).toContain('origin_space_access_grant_id');
    expect(sql).toContain(
      "message = 'emdo:finance-import-idempotency-conflict'",
    );
    expect(sql).toContain("message = 'emdo:finance-import-plan-expired'");
    expect(sql).toContain(
      "message = 'emdo:finance-import-duplicate-at-commit'",
    );
    expect(sql).toContain('insert into emdo.finance_import_fingerprints');
    expect(sql).toContain("entity_type = 'finance.transaction'");
    expect(sql).toContain('pg_advisory_xact_lock');
    expect(sql).not.toContain(
      'v_plan.origin_space_access_grant_id is distinct from p_space_access_grant_id',
    );
  });

  it('locks fingerprint rows before aggregating and validates/redacts a canonical plan', async () => {
    const sql = await readNormalized(migrationUrl);

    expect(sql).toContain('with locked_fingerprints as');
    expect(sql).toContain('for share');
    expect(sql).toContain('from locked_fingerprints');
    expect(sql).toContain("emdo.canonical_json_hash(p_plan - 'planhash')");
    expect(sql).toContain(
      'create or replace function emdo.is_valid_finance_import_plan',
    );
    expect(sql).toContain("set canonical_plan = '{}'::jsonb");
    expect(sql).toContain("mapping_metadata = '{}'::jsonb");
    expect(sql).toContain('finance_import_plans_redact_once');
    expect(sql).toContain('redacted_at');
    expect(sql).toContain("?& array['schemaversion', 'planid'");
    expect(sql).toContain(
      "'finance-import-' || pg_catalog.left(v_expected_fingerprint, 40)",
    );
    expect(sql).toContain('account.entity_id = p_account_id');
    expect(sql).not.toContain("p_canonical_plan ->> 'accountid')::uuid");
    expect(sql).toContain("category.entity_type = 'finance.category'");
    expect(sql).toContain(
      'category.original_owner_user_id = v_plan.owner_user_id',
    );
    expect(sql).toContain('category.tombstoned_at is null');
    expect(sql).toContain(
      "select distinct (transaction.value ->> 'categoryid') collate c as category_id",
    );
    expect(sql).toContain('order by category_id');
    expect(sql).not.toContain(
      "select distinct transaction.value ->> 'categoryid'\n\t\tfrom",
    );
    expect(sql).toContain('is_valid_finance_import_timestamp');
    expect(sql).toContain('is_valid_finance_import_date');
    expect(sql).toContain(
      "not emdo.is_valid_finance_import_date(v_transaction ->> 'postedon')",
    );
    expect(sql).toContain('datetime_field_overflow or invalid_datetime_format');
    expect(sql).toContain("'yyyy-mm-ddthh24:mi:ss.msz'");
    expect(sql).toContain(
      "'^[0-9]{4}-[0-9]{2}-[0-9]{2}t[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}z$'",
    );
  });

  it('keeps abandoned-plan retention behind a bounded isolated role', async () => {
    const sql = await readNormalized(migrationUrl);

    expect(sql).toContain('create role emdo_finance_import_retention nologin');
    expect(sql).toContain(
      'create or replace function emdo.purge_expired_finance_import_plans',
    );
    expect(sql).toContain('limit p_limit\n\t\tfor share skip locked');
    expect(sql).not.toContain('for update skip locked');
    expect(sql).toContain('limit p_limit');
    expect(sql).toContain('finance_import_plans_retention_select');
    expect(sql).toContain('finance_import_plans_retention_delete');
    expect(sql).toContain('finance_import_plans_retention_lock');
    expect(sql).toContain(
      'grant update (created_at) on emdo.finance_import_plans',
    );
    expect(sql).not.toMatch(
      /grant execute on function[^;]+purge_expired_finance_import_plans[^;]+to emdo_app/u,
    );
  });

  it('requires all forced-RLS relations and both isolated routine owners for readiness', async () => {
    const sql = await readNormalized(migrationUrl);

    expect(sql).toContain(') = 3 and (');
    expect(sql).toContain(
      "'emdo.resolve_finance_import_scope(text,uuid,uuid,text,text)'::regprocedure",
    );
    expect(sql).toContain(
      "'emdo.read_finance_import_preview_scope(text,uuid,uuid,text,text)'::regprocedure",
    );
    expect(sql).toContain(
      "proc.proowner = 'emdo_finance_import_executor'::regrole",
    );
    expect(sql).toContain(
      "proc.proowner = 'emdo_finance_import_retention'::regrole",
    );
    expect(sql).toContain(
      "array['row_security=on', 'search_path=pg_catalog, emdo']",
    );
    expect(sql).toContain('finance_import_receipts_retention_check');
    expect(sql).toContain('spaces_finance_import_executor_select');
    expect(sql).toContain('spaces_finance_import_executor_lock');
    expect(sql).toContain('sync_entities_finance_import_executor_lock');
    expect(sql).toContain(
      "entity_type in ('finance.account', 'finance.category', 'finance.transaction')",
    );
    expect(sql).toContain(
      "policy.polname = 'sync_entities_finance_import_executor_insert'",
    );
    expect(sql).toContain(
      'grant update (updated_at) on emdo.sync_entities, emdo.spaces',
    );
    expect(sql).toContain(
      'grant update (recorded_at) on emdo.finance_import_fingerprints',
    );
    expect(sql).toContain(
      'grant update (committed_at) on emdo.finance_import_receipts',
    );
    expect(sql).toContain(
      "'emdo_finance_import_executor', 'emdo.sync_entities', 'updated_at', 'update'",
    );
    expect(sql).toContain('emdo.is_active_request_scope(uuid, uuid, uuid)');
    expect(sql).toContain('emdo.canonical_json_text(jsonb)');
    expect(sql).toContain(
      "'emdo_app', 'emdo.resolve_finance_import_scope(text,uuid,uuid,text,text)', 'execute'",
    );
    expect(sql).toContain(
      "'emdo_app', 'emdo.purge_expired_finance_import_plans(integer)', 'execute'",
    );
  });

  it('accepts a duplicate persisted preview only for the exact current request aggregate', async () => {
    const sql = await readNormalized(migrationUrl);

    for (const predicate of [
      "v_existing_plan.account_id is not distinct from v_scope ->> 'accountid'",
      'v_existing_plan.diagnostics is not distinct from p_diagnostics',
      'v_existing_plan.mapping_metadata is not distinct from p_mapping_metadata',
      'v_existing_plan.origin_session_id is not distinct from emdo.current_session_id()',
      'v_existing_plan.origin_request_id is not distinct from emdo.current_request_id()',
      'v_existing_plan.origin_space_access_grant_id is not distinct from p_space_access_grant_id',
    ]) {
      expect(sql).toContain(predicate);
    }
    expect(sql).toContain("message = 'emdo:authorization-revoked'");
    expect(sql).toContain("message = 'emdo:finance-import-plan-invalid'");
    expect(sql).toContain("message = 'emdo:finance-import-plan-id-conflict'");
  });

  it('fails closed for null or malformed metadata and diagnostics helper inputs', async () => {
    const sql = await readNormalized(migrationUrl);

    expect(sql).toContain(
      'create or replace function emdo.is_bounded_finance_import_metadata',
    );
    expect(sql).toContain('select coalesce(');
    expect(sql).toContain(
      "pg_catalog.jsonb_typeof(p_metadata -> 'format') = 'string'",
    );
    expect(sql).toContain(
      "p_metadata ?& array['format', 'hasdefaultcategory']",
    );
    expect(sql).toContain(
      "pg_catalog.jsonb_typeof(p_metadata -> 'hasdefaultcategory') = 'boolean'",
    );
    expect(sql).toContain(
      'create or replace function emdo.is_bounded_finance_import_diagnostics',
    );
    expect(sql).toContain(
      'emdo.is_bounded_finance_import_metadata(p_mapping_metadata) is not true',
    );
    expect(sql).toContain(
      'emdo.is_bounded_finance_import_diagnostics(p_diagnostics) is not true',
    );
  });
});

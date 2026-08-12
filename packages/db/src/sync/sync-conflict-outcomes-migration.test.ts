import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  process.cwd(),
  'packages/db/drizzle/0006_sync_conflict_outcomes.sql',
);

describe('sync conflict outcome migration', () => {
  it('adds bounded immutable receipt details without weakening existing receipts', async () => {
    const sql = await readFile(migrationPath, 'utf8');

    expect(sql).toContain('ADD COLUMN "outcome_resolution" text');
    expect(sql).toContain('ADD COLUMN "outcome_disposition" text');
    expect(sql).toContain('ADD COLUMN "conflict_details" jsonb');
    expect(sql).toContain(
      'ADD COLUMN "compaction_after" timestamp with time zone',
    );
    expect(sql).toContain('jsonb_array_length("conflict_details") <= 32');
    expect(sql).toContain(
      'pg_catalog.octet_length("conflict_details"::text) <= 8192',
    );
    expect(sql).toContain(
      'pg_catalog.jsonb_typeof("conflict_details") = \'array\'',
    );
    expect(sql).toContain(
      "pg_catalog.jsonb_typeof(detail.value -> 'material') = 'boolean'",
    );
    expect(sql).toContain('pg_catalog.jsonb_object_keys(detail.value)');
    expect(sql).toContain(
      "'created', 'applied', 'merged', 'ignored', 'duplicate'",
    );
    expect(sql).toContain('"outcome_disposition" = \'terminal\'');
    expect(sql).toContain('sync_operation_receipts_outcome_shape_check');
    expect(sql).toContain('sync_operation_receipts_compaction_check');
    expect(sql).not.toMatch(
      /DISABLE ROW LEVEL SECURITY|DROP TRIGGER|DELETE FROM "emdo"\."sync_operation_receipts"/u,
    );
  });

  it('persists canonical revisions append-only with RLS, tombstones, hashes, and retention metadata', async () => {
    const sql = await readFile(migrationPath, 'utf8');

    expect(sql).toContain('CREATE TABLE "emdo"."sync_entity_revisions"');
    expect(sql).toContain('"payload_hash" text NOT NULL');
    expect(sql).toContain('"payload" jsonb NOT NULL');
    expect(sql).toContain('"tombstoned" boolean NOT NULL');
    expect(sql).toContain('"retain_until" timestamp with time zone NOT NULL');
    expect(sql).toContain(
      '"compaction_after" timestamp with time zone NOT NULL',
    );
    expect(sql).toContain('"compaction_policy" text NOT NULL');
    expect(sql).toContain(
      'UNIQUE("household_id","space_id","entity_type","entity_id","revision")',
    );
    expect(sql).toContain('sync_entity_revision_hash');
    expect(sql).toContain("'emdo.sync-entity-revision.v1'");
    expect(sql).not.toMatch(/chr\(0\)/u);
    expect(sql).toContain(
      '"payload_hash" = "emdo"."sync_entity_revision_hash"',
    );
    expect(sql).toContain('is_safe_sync_snapshot_payload');
    expect(sql).toContain(
      "pg_catalog.regexp_replace(\n\t\t\tpg_catalog.lower(object_key.key), '[^a-z0-9]', '', 'g'",
    );
    expect(sql).toContain('sync_entity_revisions_payload_safety_check');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('sync_entity_revisions_append_only');
    expect(sql).toContain('reject_append_only_mutation');
    expect(sql).toContain('sync_entities_capture_revision');
    expect(sql).toContain('capture_sync_entity_revision');
    expect(sql).toMatch(
      /AFTER INSERT OR UPDATE OF "payload", "actor_intent", "revision", "tombstoned_at" ON "emdo"\."sync_entities"/u,
    );
    expect(sql).toMatch(
      /INSERT INTO "emdo"\."sync_entity_revisions"[\s\S]*FROM "emdo"\."sync_entities"/u,
    );
    expect(sql).toContain('CREATE POLICY sync_entity_revisions_app_read');
    expect(sql).toContain(
      'CREATE POLICY sync_entity_revisions_executor_insert',
    );
    expect(sql).toMatch(
      /GRANT SELECT ON "emdo"\."sync_entity_revisions" TO emdo_app/u,
    );
    expect(sql).toMatch(
      /GRANT INSERT ON "emdo"\."sync_entity_revisions" TO emdo_sync_revision_executor/u,
    );
    expect(sql).toMatch(
      /REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON "emdo"\."sync_entity_revisions"/u,
    );
    expect(sql).not.toMatch(/DELETE FROM "emdo"\."sync_entity_revisions"/u);
  });

  it('stores strict payload-bound API request replays without provider authority', async () => {
    const sql = await readFile(migrationPath, 'utf8');

    expect(sql).toContain('CREATE TABLE "emdo"."sync_api_request_receipts"');
    expect(sql).toContain('"request_fingerprint" text NOT NULL');
    expect(sql).toContain('"response" jsonb');
    expect(sql).toContain('"completed_at" timestamp with time zone');
    expect(sql).toContain('DEFAULT pg_catalog.statement_timestamp() NOT NULL');
    expect(sql).toContain(
      "DEFAULT (pg_catalog.statement_timestamp() + interval '90 days') NOT NULL",
    );
    expect(sql).toContain(
      "DEFAULT (pg_catalog.statement_timestamp() + interval '91 days') NOT NULL",
    );
    expect(sql).toContain("'register-client', 'apply-operations'");
    expect(sql).toContain(
      'UNIQUE("household_id","user_id","client_id","request_kind","idempotency_key")',
    );
    expect(sql).toContain('"initial_request_id" uuid NOT NULL');
    expect(sql).toContain('"latest_request_id" uuid NOT NULL');
    expect(sql).toContain('is_safe_sync_api_response');
    expect(sql).not.toContain("'operation-in-progress'");
    expect(sql).not.toContain("'dependency-missing'");
    expect(sql).toContain('sync_api_request_receipts_response_check');
    expect(sql).toContain('sync_api_request_receipts_complete_once');
    expect(sql).toContain('complete_sync_api_request_receipt');
    expect(sql).toContain('OLD.response IS NOT NULL');
    expect(sql).toContain('NEW.response IS NULL');
    expect(sql).toContain('sync_api_request_receipts_delete_forbidden');
    expect(sql).toContain('CREATE POLICY sync_api_request_receipts_app_scope');
    expect(sql).toMatch(
      /GRANT INSERT \([\s\S]*?\) ON "emdo"\."sync_api_request_receipts" TO emdo_app/u,
    );
    expect(sql).toContain(
      'CREATE POLICY sync_api_request_receipts_app_insert_pending',
    );
    expect(sql).toContain(
      'CASE WHEN "request_kind" = \'apply-operations\' THEN "client_id" END',
    );
    expect(sql).not.toContain('sync_api_request_receipts_client_fk');
    expect(sql).toMatch(
      /GRANT UPDATE \("latest_request_id", "response", "completed_at"\)[\s\S]*TO emdo_app/u,
    );
    expect(sql).toMatch(
      /REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON "emdo"\."sync_api_request_receipts"/u,
    );
    expect(sql).not.toMatch(/DELETE FROM "emdo"\."sync_api_request_receipts"/u);
  });
});

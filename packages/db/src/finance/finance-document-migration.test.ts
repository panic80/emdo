import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { loadOrderedMigrations } from '../migrations.js';

const migrationUrl = new URL(
  '../../drizzle/0016_finance_document_knowledge.sql',
  import.meta.url,
);

const financeDocumentTables = Object.freeze([
  'finance_documents',
  'finance_document_extractions',
  'finance_document_chunks',
  'finance_document_review_batches',
  'finance_document_matches',
  'finance_document_evidence',
] as const);

const readNormalized = async () =>
  (await readFile(migrationUrl, 'utf8')).toLowerCase().replaceAll('"', '');

describe('finance document knowledge migration', () => {
  it('is journaled as the narrow 0016 finance document knowledge upgrade', async () => {
    const migrations = await loadOrderedMigrations();
    const migration = migrations.find(
      ({ id }) => id === '0016_finance_document_knowledge',
    );

    expect(migration?.id).toBe('0016_finance_document_knowledge');
    expect(migration?.index).toBe(16);
  });

  it('creates all six uploader-scoped relations behind forced RLS', async () => {
    const sql = await readNormalized();

    for (const table of financeDocumentTables) {
      expect(sql).toContain(`create table emdo.${table}`);
      expect(sql).toContain(
        `alter table emdo.${table} enable row level security`,
      );
      expect(sql).toContain(
        `alter table emdo.${table} force row level security`,
      );
      expect(sql).toContain(`on emdo.${table}`);
      expect(sql).toContain(`create policy ${table}_uploader_scope`);
    }

    expect(sql).toContain('for all to emdo_app');
    for (const table of financeDocumentTables) {
      expect(sql).toContain(`create policy ${table}_executor_scope`);
    }
    expect(sql).toContain('emdo.is_active_finance_document_scope(');
  });

  it('binds every policy to the current uploader and an active private scope, not a sync-client identifier', async () => {
    const sql = await readNormalized();

    expect(sql).toContain('p_owner_user_id = emdo.current_user_id()');
    expect(sql).toMatch(
      /emdo\.is_active_request_scope\(\s*p_household_id,\s*p_space_id,\s*null\s*\)/u,
    );
    expect(sql).toContain("space.visibility = 'private'");
    expect(sql).toContain('space.original_owner_user_id = p_owner_user_id');
    expect(sql).toContain('with check (');
  });

  it('keeps versioned content, evidence, review, and match data tied to a document without reusing generic memory chunks', async () => {
    const sql = await readNormalized();

    for (const foreignKey of [
      'finance_document_chunks_document_fk',
      'finance_document_evidence_document_fk',
      'finance_document_evidence_chunk_fk',
      'finance_document_extractions_document_fk',
      'finance_document_matches_document_fk',
      'finance_document_review_batches_document_fk',
      'finance_documents_household_space_fk',
      'finance_documents_owner_membership_fk',
    ]) {
      expect(sql).toContain(foreignKey);
    }
    expect(sql).toContain('finance_document_chunks_search_gin_idx');
    expect(sql).toContain('finance_document_chunks_embedding_hnsw_idx');
    expect(sql).toContain(
      'create trigger finance_document_chunks_search_vector',
    );
    expect(sql).toContain("to_tsvector('simple', new.content)");
    expect(sql).not.toContain('memory_chunks');
  });

  it('bounds direct lifecycle storage states and review decisions', async () => {
    const sql = await readNormalized();

    expect(sql).toContain('finance_documents_state_check');
    expect(sql).toContain(
      "'uploaded', 'extracting', 'awaiting-review', 'committed', 'failed', 'deleting', 'deleted'",
    );
    expect(sql).toContain('finance_document_extractions_completion_check');
    expect(sql).toContain(
      "'queued', 'extracting', 'awaiting-review', 'committed', 'failed', 'superseded'",
    );
    expect(sql).toContain('finance_document_review_batches_state_check');
    expect(sql).toContain(
      "'pending', 'committed', 'rejected', 'expired', 'invalidated'",
    );
    expect(sql).toContain('finance_document_review_batches_lifetime_check');
    expect(sql).toContain('finance_document_matches_state_check');
    expect(sql).toContain("'suggested', 'accepted', 'rejected'");
    expect(sql).toContain('finance_documents_deletion_check');
    expect(sql).toContain('finance_documents_guarded_deletion_receipt_check');
    expect(sql).toContain('deletion_proposal_id uuid');
    expect(sql).toContain('deletion_decision_id uuid');
    expect(sql).toContain('deletion_target_binding_hash');
    expect(sql).toContain('deletion_execution_binding_hash');
    expect(sql).toContain(
      'create trigger finance_documents_review_revision_invalidation',
    );
    expect(sql).toContain('finance_document_matches_review_batch_fk');
    expect(sql).toContain(
      'create or replace function emdo.claim_next_finance_document_extraction()',
    );
    expect(sql).toContain(
      'create or replace function emdo.complete_finance_document_extraction(',
    );
  });

  it('locks the document before atomically settling an extraction result', async () => {
    const sql = await readNormalized();

    for (const functionName of [
      'complete_finance_document_extraction',
      'fail_finance_document_extraction',
    ]) {
      const start = sql.indexOf(
        `create or replace function emdo.${functionName}(`,
      );
      const end = sql.indexOf('$function$;', start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const body = sql.slice(start, end);
      const documentLock = body.indexOf('for update;');
      const extractionUpdate = body.indexOf(
        'update emdo.finance_document_extractions as extraction',
      );
      expect(body).toContain('from emdo.finance_documents as document');
      expect(documentLock).toBeGreaterThan(-1);
      expect(extractionUpdate).toBeGreaterThan(documentLock);
      expect(body).toContain("using errcode = '40001'");
      expect(body).toContain('return true;');
    }
  });

  it('uses an isolated executor role, explicit table grants, and a fail-closed readiness check', async () => {
    const sql = await readNormalized();

    expect(sql).toContain('create role emdo_finance_document_executor nologin');
    expect(sql).toContain(
      'alter role emdo_finance_document_executor nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication',
    );
    expect(sql).toContain(
      'finance document executor must not have role memberships',
    );
    expect(sql).toContain('revoke all on table');
    expect(sql).toContain('from public');
    expect(sql).toContain('grant select, insert, update, delete on table');
    expect(sql).toContain('to emdo_app, emdo_finance_document_executor');
    expect(sql).toContain(
      'alter function emdo.claim_next_finance_document_extraction()',
    );
    expect(sql).toContain('to emdo_worker_executor');
    expect(sql).toContain(
      "'emdo_worker_executor', 'emdo.claim_next_finance_document_extraction()', 'execute'",
    );
    expect(sql).toContain(
      "'emdo_app', 'emdo.claim_next_finance_document_extraction()', 'execute'",
    );
    expect(sql).toContain('original_owner_user_id uuid');
    expect(sql).toContain('extraction_attempt smallint');
    expect(sql).toContain("queued.state = 'queued'");
    expect(sql).toContain('revoke all on function');
    expect(sql).toContain(
      'create or replace function emdo.finance_documents_ready()',
    );
    expect(sql).toContain('security definer');
    expect(sql).toContain('set row_security = on');
    expect(sql).toContain(
      'alter function emdo.finance_documents_ready() owner to emdo_policy_reader',
    );
    expect(sql).toContain(
      'grant execute on function emdo.finance_documents_ready() to emdo_app',
    );
    expect(sql).toContain(
      'emdo.invalidate_finance_document_reviews_on_revision()',
    );
  });

  it('adds an owner/private-space receipt for atomic Finance specialist record commands', async () => {
    const sql = await readNormalized();

    expect(sql).toContain(
      'create table emdo.finance_specialist_record_receipts',
    );
    expect(sql).toContain(
      'finance_specialist_record_receipts_scope_idempotency_unique',
    );
    expect(sql).toContain(
      'finance_specialist_record_receipts_audit_event_unique',
    );
    expect(sql).toContain('finance_specialist_record_receipts_audit_event_fk');
    expect(sql).toContain(
      "'manual-transaction-create', 'transaction-nondestructive-patch'",
    );
    expect(sql).toContain("'finance-transaction-adjustment'");
    expect(sql).toContain("'finance-transaction-reversal'");
    expect(sql).toContain('canonical_hash ~');
    expect(sql).toContain('scope_fingerprint ~');
    expect(sql).toContain(
      'alter table emdo.finance_specialist_record_receipts enable row level security',
    );
    expect(sql).toContain(
      'alter table emdo.finance_specialist_record_receipts force row level security',
    );
    expect(sql).toContain(
      'create policy finance_specialist_record_receipts_owner_read',
    );
    expect(sql).toContain(
      'create policy finance_specialist_record_receipts_owner_insert',
    );
    expect(sql).toContain(
      'create trigger finance_specialist_record_receipts_append_only',
    );
    expect(sql).toContain(
      'create or replace function emdo.finance_specialist_records_ready()',
    );
    expect(sql).toContain(
      "'emdo_app', 'emdo.sync_entities', 'select,insert,update'",
    );
    expect(sql).toContain("'emdo_app', 'emdo.sync_entity_revisions', 'select'");
    expect(sql).toContain("'emdo_app', 'emdo.audit_events', 'select,insert'");
    expect(sql).toContain(
      'grant select, insert on table emdo.finance_specialist_record_receipts to emdo_app',
    );
  });
});

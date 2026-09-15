import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migration = () =>
  readFile(
    new URL('../drizzle/0058_finance_legacy_migration.sql', import.meta.url),
    'utf8',
  );

describe('legacy Finance migration 0058', () => {
  it('creates only additive, scoped migration records', async () => {
    const sql = await migration();
    for (const table of [
      'finance_legacy_migration_runs',
      'finance_legacy_migration_records',
      'finance_legacy_migration_reviews',
      'finance_legacy_migration_comparisons',
      'finance_legacy_migration_cutovers',
    ]) {
      expect(sql).toContain(`CREATE TABLE "emdo"."${table}"`);
      expect(sql).toContain('ALTER TABLE emdo.%I ENABLE ROW LEVEL SECURITY');
      expect(sql).toContain('ALTER TABLE emdo.%I FORCE ROW LEVEL SECURITY');
    }
    expect(sql).toContain('finance_legacy_migration_access');
    expect(sql).toContain('source_owner_user_id');
    expect(sql).toContain('source_space_id');
    expect(sql).toContain('finance_legacy_migration_records_identity');
    expect(sql).toContain('finance_legacy_migration_runs_idempotency');
    expect(sql).toContain('finance_legacy_migration_runs_mapping_scope');
    expect(sql).toContain('finance_legacy_migration_records_financial_account');
    expect(sql).toContain('finance_legacy_migration_records_ledger_account');
    expect(sql).toContain('finance_legacy_migration_records_evidence');
  });

  it('keeps source history append-only and does not retire legacy writers', async () => {
    const sql = await migration();
    expect(sql).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN|FUNCTION)\b/iu);
    expect(sql).not.toMatch(
      /\b(?:UPDATE|DELETE)\s+(?:ONLY\s+)?(?:"?emdo"?\.)?"?sync_entities"?\b/iu,
    );
    expect(sql).not.toContain('legacy_writes_disabled');
    expect(sql).toContain('finance_legacy_migration_review_append_only');
    expect(sql).toContain('finance_legacy_migration_comparison_append_only');
    expect(sql).toContain('finance_legacy_migration_cutover_append_only');
    expect(sql).toContain('legacy migration source record is immutable');
    expect(sql).toContain('legacy migration mapping is closed');
  });

  it('requires owner-scoped policy access and normalized review state', async () => {
    const sql = await migration();
    expect(sql).toContain('owner_id = emdo.current_user_id()');
    expect(sql).toContain('emdo.is_active_request_scope(sh,ss,NULL)');
    expect(sql).toContain(
      'finance_legacy_migration_runs_insert ON emdo.finance_legacy_migration_runs',
    );
    expect(sql).toContain(
      'finance_legacy_migration_records_update ON emdo.finance_legacy_migration_records',
    );
    expect(sql).toContain('candidate_status');
    expect(sql).toContain('backfill_state');
    expect(sql).not.toMatch(/GRANT[^;]*DELETE[^;]*finance_legacy_migration/iu);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const migrate = vi.hoisted(() => vi.fn(async () => undefined));
const drizzle = vi.hoisted(() => vi.fn((client: unknown) => ({ client })));

vi.mock('drizzle-orm/node-postgres/migrator', () => ({ migrate }));
vi.mock('drizzle-orm/node-postgres', () => ({ drizzle }));

import {
  applyDatabaseMigrations,
  applyLockedDatabaseMigrations,
  loadOrderedMigrations,
} from './migrations.js';

describe('database migration runner', () => {
  beforeEach(() => {
    migrate.mockClear();
    drizzle.mockClear();
  });
  it('loads every journal entry in strict order, including deployment bootstrap', async () => {
    const migrations = await loadOrderedMigrations();
    const ids = migrations.map(({ id }) => id);

    expect(ids).toEqual([
      '0000_household_foundation',
      '0001_identity_onboarding',
      '0002_owner_bootstrap',
      '0003_durable_runtime_repositories',
      '0004_audio_request_receipts',
      '0005_household_administration',
      '0006_sync_conflict_outcomes',
      '0007_experience_notification_preferences',
      '0008_finance_import_receipts',
      '0009_google_oauth_authorization_starts',
      '0010_google_oauth_disconnect_operations',
      '0011_finance_import_retention_runner',
      '0012_google_oauth_disconnect_reconciliation_runner',
      '0013_google_oauth_disconnect_retention_runner',
      '0014_audio_spend_readiness',
      '0015_single_household_session_activation',
      '0016_finance_document_knowledge',
      '0017_approval_resume_public_events',
      '0018_finance_guarded_proposal_authority',
      '0019_manager_turn_spend_warning',
      '0020_manager_specialist_disclosure',
      '0021_blocked_visual_decision_claim',
      '0022_registered_agent_invocation_lineage',
      '0023_astra_model_migration',
      '0024_workspace_finance_foundation',
      '0025_finance_commercial_documents',
      '0026_normalized_finance_imports',
      '0027_investment_observations',
      '0028_report_mapping_registry',
      '0029_investment_valuation_runs',
      '0030_mapped_portfolio_observations',
      '0031_investment_lot_accounting',
      '0032_xlsx_book_evidence',
      '0033_finance_automation_authority',
      '0034_finance_generated_reports',
      '0035_finance_worker_report_permissions',
      '0036_pdf_book_evidence',
      '0037_finance_delivery_outbox',
      '0038_finance_automation_run_reads',
      '0039_finance_stalled_run_recovery',
      '0040_private_tax_cases',
      '0041_finance_corporate_actions',
      '0042_tax_book_source_rebind',
      '0043_finance_recurring_schedules',
      '0044_private_tax_calculation_runs',
      '0045_finance_structured_invoice_evidence',
      '0046_finance_accounting_statements',
      '0047_finance_invoice_review_drafts',
      '0048_finance_normalized_amount_components',
      '0049_finance_standardization',
      '0050_normalized_finance_disclosure_capabilities',
      '0051_finance_cash_dividends',
      '0052_finance_standardization_reconciliation',
      '0053_private_corporate_tax_runs',
      '0054_finance_image_evidence',
      '0055_finance_standardization_reconciliation_hardening',
      '0056_private_us_tax_wage_reviews',
      '0057_normalized_finance_planning',
      '0058_finance_legacy_migration',
      '0059_private_us_wage_corrections',
      '0060_finance_planning_automation',
      '0061_finance_fec_persistence',
      '0062_private_new_york_working_papers',
      '0063_finance_fec_evidence_binding',
      '0064_finance_legacy_activation',
      '0065_finance_account_source_assignments',
      '0066_finance_opening_proofs',
      '0067_finance_corporate_action_settlements',
      '0068_finance_pdf_ocr_evidence',
      '0069_finance_pdf_ocr_mapping_binding',
      '0070_finance_automation_extraction',
      '0071_finance_investment_reconciliation',
      '0072_finance_journal_draft_automation',
      '0073_finance_recurring_source_schedules',
      '0074_private_mexico_working_papers',
      '0075_finance_standardization_prompt_v3',
      '0076_finance_standardization_prompt_v4',
    ]);
    expect(migrations.map(({ index }) => index)).toEqual(
      migrations.map((_, index) => index),
    );
    expect(migrations[0]?.sql).toContain('CREATE SCHEMA "emdo"');
    expect(migrations[1]?.sql).toContain(
      'CREATE OR REPLACE FUNCTION "emdo"."provision_invited_account"',
    );
    expect(migrations[2]?.sql).toContain(
      'CREATE OR REPLACE FUNCTION "emdo"."bootstrap_initial_owner"',
    );
    expect(migrations[4]?.sql).toContain(
      'CREATE TABLE "emdo"."audio_request_receipts"',
    );
    expect(migrations[5]?.sql).toContain(
      'CREATE OR REPLACE FUNCTION emdo.issue_household_invitation',
    );
    expect(migrations[6]?.sql).toContain(
      'CREATE TABLE "emdo"."sync_entity_revisions"',
    );
    expect(migrations[7]?.sql).toContain(
      'CREATE TABLE "emdo"."notification_preferences"',
    );
    expect(migrations[8]?.sql).toContain(
      'CREATE TABLE emdo.finance_import_receipts',
    );
    expect(migrations[9]?.sql).toContain(
      'CREATE TABLE "emdo"."google_oauth_authorization_starts"',
    );
    expect(migrations[10]?.sql).toContain(
      'CREATE TABLE "emdo"."google_oauth_disconnect_operations"',
    );
    expect(migrations[11]?.sql).toContain(
      'CREATE OR REPLACE FUNCTION emdo.finance_import_retention_runner_ready',
    );
    expect(migrations[12]?.sql).toContain(
      'CREATE OR REPLACE FUNCTION emdo.google_oauth_disconnect_reconciliation_runner_ready',
    );
    expect(migrations[13]?.sql).toContain(
      'CREATE OR REPLACE FUNCTION emdo.google_oauth_disconnect_retention_runner_ready',
    );
    expect(migrations[14]?.sql).toContain(
      'CREATE OR REPLACE FUNCTION emdo.audio_spend_ready',
    );
    expect(migrations[15]?.sql).toContain(
      'CREATE OR REPLACE FUNCTION emdo.resolve_exactly_one_active_household_for_auth_session',
    );
    expect(migrations[16]?.sql).toContain(
      'CREATE TABLE "emdo"."finance_documents"',
    );
    expect(migrations[17]?.sql).toContain(
      'CREATE OR REPLACE FUNCTION "emdo"."settle_approval_resume_job"',
    );
    expect(migrations[18]?.sql).toContain('ADD COLUMN "guarded_action" jsonb');
    expect(migrations[19]?.sql).toContain(
      'CREATE OR REPLACE FUNCTION "emdo"."complete_manager_turn"',
    );
    expect(migrations[20]?.sql).toContain(
      'CREATE OR REPLACE FUNCTION "emdo"."resolve_model_disclosure_grant"',
    );
    expect(migrations[21]?.sql).toContain(
      'CREATE OR REPLACE FUNCTION "emdo"."issue_workflow_operation_claim_calendar"',
    );
  });

  it('holds one session-level advisory lock around the tracked migrator and always unlocks', async () => {
    const queries: {
      readonly text: string;
      readonly values?: readonly unknown[];
    }[] = [];
    let releases = 0;
    const client = {
      async query(text: string, values?: readonly unknown[]) {
        queries.push({ text, values });
        return { rows: [], rowCount: 0 };
      },
      release() {
        releases += 1;
      },
    };

    await applyLockedDatabaseMigrations({
      async connect() {
        return client;
      },
    });

    expect(queries.map(({ text }) => text)).toEqual([
      'begin',
      expect.stringContaining('statement_timeout'),
      expect.stringContaining('pg_advisory_lock'),
      'commit',
      expect.stringContaining('pg_advisory_unlock'),
    ]);
    expect(queries[2]?.values).toEqual(['emdo.database.migrations.v1']);
    expect(drizzle).toHaveBeenCalledWith(client);
    expect(migrate).toHaveBeenCalledWith(
      { client },
      expect.objectContaining({
        migrationsFolder: expect.stringMatching(/packages\/db\/drizzle\/?$/),
      }),
    );
    expect(releases).toBe(1);
  });

  it('unlocks and releases the dedicated migration session when migration fails', async () => {
    const queries: string[] = [];
    let releases = 0;
    const client = {
      async query(text: string) {
        queries.push(text);
        return { rows: [], rowCount: 0 };
      },
      release() {
        releases += 1;
      },
    };
    migrate.mockRejectedValueOnce(new Error('private database failure'));

    await expect(
      applyLockedDatabaseMigrations({
        async connect() {
          return client;
        },
      }),
    ).rejects.toThrow('Database migration failed');

    expect(queries.at(-1)).toContain('pg_advisory_unlock');
    expect(releases).toBe(1);
  });

  it('delegates deployment execution to the journal-aware Drizzle migrator', async () => {
    const database = { marker: 'database' };

    await applyDatabaseMigrations(database as never);

    expect(migrate).toHaveBeenCalledOnce();
    expect(migrate).toHaveBeenCalledWith(
      database,
      expect.objectContaining({
        migrationsFolder: expect.stringMatching(/packages\/db\/drizzle\/?$/),
      }),
    );
  });

  it('uses an explicit absolute migrations folder copied beside a runtime bundle', async () => {
    const database = { marker: 'bundled-database' };
    const migrationsFolder = '/opt/emdo/api/dist/migrations';

    await applyDatabaseMigrations(database as never, { migrationsFolder });

    expect(migrate).toHaveBeenCalledWith(database, { migrationsFolder });
  });

  it('rejects relative or nul-containing migration folder overrides', async () => {
    await expect(
      applyDatabaseMigrations({} as never, {
        migrationsFolder: '../migrations',
      }),
    ).rejects.toThrow('absolute path');
    await expect(
      applyDatabaseMigrations({} as never, {
        migrationsFolder: '/tmp/migrations\0hidden',
      }),
    ).rejects.toThrow('absolute path');
  });
});

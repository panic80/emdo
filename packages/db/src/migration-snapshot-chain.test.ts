import { isDeepStrictEqual } from 'node:util';
import { readdir, readFile } from 'node:fs/promises';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  encryptedGoogleCalendarGrants,
  financeImportFingerprints,
  financeImportPlans,
  financeImportReceipts,
  financeSpecialistRecordReceipts,
  googleOAuthAuthorizationStarts,
  googleOAuthDisconnectOperations,
} from './schema.js';

const metadataUrl = new URL('../drizzle/meta/', import.meta.url);

interface Snapshot {
  readonly id: string;
  readonly prevId: string;
  readonly tables: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

const readJson = async <Value>(url: URL): Promise<Value> =>
  JSON.parse(await readFile(url, 'utf8')) as Value;

const readSnapshot = (index: number): Promise<Snapshot> =>
  readJson(
    new URL(`${index.toString().padStart(4, '0')}_snapshot.json`, metadataUrl),
  );

const tableDelta = (previous: Snapshot, current: Snapshot) => {
  const previousNames = new Set(Object.keys(previous.tables));
  const currentNames = new Set(Object.keys(current.tables));
  return {
    added: [...currentNames].filter((name) => !previousNames.has(name)).sort(),
    changed: [...currentNames]
      .filter(
        (name) =>
          previousNames.has(name) &&
          !isDeepStrictEqual(previous.tables[name], current.tables[name]),
      )
      .sort(),
    removed: [...previousNames]
      .filter((name) => !currentNames.has(name))
      .sort(),
  };
};

const snapshotColumns = (
  snapshot: Snapshot,
  table: string,
): readonly string[] =>
  Object.keys(
    (snapshot.tables[table] as { readonly columns: Record<string, unknown> })
      .columns,
  );

describe('ordered migration snapshot chain', () => {
  it('keeps tables unchanged for PDF OCR mapping binding migration 0069', async () => {
    expect(tableDelta(await readSnapshot(68), await readSnapshot(69))).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
  });

  it('keeps tables unchanged for PDF OCR reader migration 0068', async () => {
    expect(tableDelta(await readSnapshot(67), await readSnapshot(68))).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
  });
  it('adds only normalized corporate-action settlement records in 0067', async () => {
    expect(tableDelta(await readSnapshot(66), await readSnapshot(67))).toEqual({
      added: [
        'emdo.finance_investment_corporate_action_settlement_allocations',
        'emdo.finance_investment_corporate_action_settlement_evidence',
        'emdo.finance_investment_corporate_action_settlements',
      ],
      changed: [],
      removed: [],
    });
  });
  it('keeps tables unchanged for FEC evidence policy 0063', async () => {
    expect(tableDelta(await readSnapshot(62), await readSnapshot(63))).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
  });
  it('keeps tables unchanged for NY private policy migration 0062', async () => {
    expect(tableDelta(await readSnapshot(61), await readSnapshot(62))).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
  });
  it('adds only the four reviewed FEC persistence tables in 0061', async () => {
    expect(tableDelta(await readSnapshot(60), await readSnapshot(61))).toEqual({
      added: [
        'emdo.finance_fec_account_mappings',
        'emdo.finance_fec_book_mapping_revisions',
        'emdo.finance_fec_export_receipts',
        'emdo.finance_fec_journal_mappings',
      ],
      changed: [],
      removed: [],
    });
  });

  it('adds planning results, construction markers and automation capability metadata in 0060', async () => {
    expect(tableDelta(await readSnapshot(59), await readSnapshot(60))).toEqual({
      added: ['emdo.finance_planning_results'],
      changed: [
        'emdo.finance_automation_capabilities',
        'emdo.finance_budget_revisions',
        'emdo.finance_forecast_snapshots',
      ],
      removed: [],
    });
  });
  it('has one continuous snapshot for every exact journal entry', async () => {
    const [journal, files] = await Promise.all([
      readJson<{
        readonly entries: readonly {
          readonly idx: number;
          readonly tag: string;
        }[];
      }>(new URL('_journal.json', metadataUrl)),
      readdir(metadataUrl),
    ]);
    expect(journal.entries.map(({ idx }) => idx)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38,
      39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56,
      57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74,
      75, 76, 77, 78, 79, 80, 81,
    ]);
    expect(journal.entries.map(({ tag }) => tag)).toEqual([
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
      '0077_finance_function_execute_privileges',
      '0078_finance_pdf_extraction_capacity',
      '0079_finance_pdf_prompt_projection',
      '0080_finance_bank_layout_prompt_v6',
      '0081_finance_standardization_retained_cost_retry',
    ]);
    expect(
      files.filter((file) => /^\d{4}_snapshot\.json$/u.test(file)).sort(),
    ).toEqual(
      Array.from(
        { length: 82 },
        (_, index) => `${index.toString().padStart(4, '0')}_snapshot.json`,
      ),
    );

    const snapshots = await Promise.all(
      Array.from({ length: 82 }, (_, index) => readSnapshot(index)),
    );
    expect(snapshots[0]?.prevId).toBe('00000000-0000-0000-0000-000000000000');
    for (let index = 1; index < snapshots.length; index += 1) {
      expect(snapshots[index]?.prevId).toBe(snapshots[index - 1]?.id);
    }
    expect(tableDelta(snapshots[58]!, snapshots[59]!)).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
    expect(tableDelta(snapshots[57]!, snapshots[58]!)).toEqual({
      added: [
        'emdo.finance_legacy_migration_comparisons',
        'emdo.finance_legacy_migration_cutovers',
        'emdo.finance_legacy_migration_records',
        'emdo.finance_legacy_migration_reviews',
        'emdo.finance_legacy_migration_runs',
      ],
      changed: [
        'emdo.action_proposals',
        'emdo.finance_investment_cash_dividends',
      ],
      removed: [],
    });
    expect(tableDelta(snapshots[54]!, snapshots[55]!)).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
    expect(tableDelta(snapshots[55]!, snapshots[56]!)).toEqual({
      added: ['emdo.finance_tax_wage_reviews'],
      changed: [],
      removed: [],
    });
    expect(tableDelta(snapshots[56]!, snapshots[57]!)).toEqual({
      added: [
        'emdo.finance_budget_lines',
        'emdo.finance_budget_revisions',
        'emdo.finance_forecast_assumptions',
        'emdo.finance_forecast_lines',
        'emdo.finance_forecast_snapshots',
      ],
      changed: [],
      removed: [],
    });
    expect(tableDelta(snapshots[53]!, snapshots[54]!)).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
    expect(tableDelta(snapshots[52]!, snapshots[53]!)).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
    expect(tableDelta(snapshots[42]!, snapshots[43]!)).toEqual({
      added: ['emdo.finance_schedule_plans', 'emdo.finance_schedules'],
      changed: [],
      removed: [],
    });
    expect(tableDelta(snapshots[43]!, snapshots[44]!)).toEqual({
      added: [
        'emdo.finance_tax_calculation_runs',
        'emdo.finance_tax_run_reviews',
        'emdo.finance_tax_run_schedules',
        'emdo.finance_tax_working_input_reviews',
      ],
      changed: [],
      removed: [],
    });
    expect(tableDelta(snapshots[44]!, snapshots[45]!)).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
    expect(tableDelta(snapshots[45]!, snapshots[46]!)).toEqual({
      added: ['emdo.finance_ledger_account_classifications'],
      changed: ['emdo.finance_generated_reports'],
      removed: [],
    });
    expect(tableDelta(snapshots[48]!, snapshots[49]!)).toEqual({
      added: [
        'emdo.finance_standardization_configuration',
        'emdo.finance_standardization_extractions',
        'emdo.finance_standardization_runs',
        'emdo.finance_standardization_spend',
      ],
      changed: [],
      removed: [],
    });
    expect(tableDelta(snapshots[51]!, snapshots[52]!)).toEqual({
      added: ['emdo.finance_standardization_reconciliations'],
      changed: ['emdo.finance_standardization_spend'],
      removed: [],
    });
    expect(tableDelta(snapshots[50]!, snapshots[51]!)).toEqual({
      added: [
        'emdo.finance_investment_cash_dividend_amounts',
        'emdo.finance_investment_cash_dividends',
      ],
      changed: [],
      removed: [],
    });
    expect(tableDelta(snapshots[47]!, snapshots[48]!)).toEqual({
      added: [
        'emdo.finance_economic_transaction_amount_components',
        'emdo.finance_normalized_import_amount_components',
      ],
      changed: [],
      removed: [],
    });
    expect(tableDelta(snapshots[40]!, snapshots[41]!)).toEqual({
      added: [
        'emdo.finance_investment_corporate_action_effects',
        'emdo.finance_investment_corporate_action_lots',
        'emdo.finance_investment_corporate_actions',
        'emdo.finance_investment_lot_revisions',
      ],
      changed: [],
      removed: [],
    });
    expect(tableDelta(snapshots[41]!, snapshots[42]!)).toEqual({
      added: [],
      changed: ['emdo.finance_tax_book_sources'],
      removed: [],
    });
    expect(tableDelta(snapshots[39]!, snapshots[40]!)).toEqual({
      added: [
        'emdo.finance_tax_book_sources',
        'emdo.finance_tax_case_grants',
        'emdo.finance_tax_case_snapshots',
        'emdo.finance_tax_cases',
        'emdo.finance_tax_fact_sources',
        'emdo.finance_tax_receipts',
        'emdo.finance_tax_subjects',
      ],
      changed: [],
      removed: [],
    });
    expect(tableDelta(snapshots[16]!, snapshots[17]!)).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
    expect(tableDelta(snapshots[17]!, snapshots[18]!)).toEqual({
      added: [],
      changed: ['emdo.action_proposals'],
      removed: [],
    });
    expect(tableDelta(snapshots[18]!, snapshots[19]!)).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
    expect(tableDelta(snapshots[19]!, snapshots[20]!)).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
    expect(tableDelta(snapshots[20]!, snapshots[21]!)).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
    expect(tableDelta(snapshots[21]!, snapshots[22]!)).toEqual({
      added: [],
      changed: ['emdo.disclosure_grants'],
      removed: [],
    });
    for (const snapshot of [snapshots[16]!, snapshots[17]!]) {
      expect(snapshotColumns(snapshot, 'emdo.finance_documents')).toEqual(
        expect.arrayContaining([
          'deletion_proposal_id',
          'deletion_decision_id',
          'deletion_target_binding_hash',
          'deletion_execution_binding_hash',
        ]),
      );
      expect(
        snapshotColumns(snapshot, 'emdo.finance_document_chunks'),
      ).not.toEqual(expect.arrayContaining(['deletion_proposal_id']));
      expect(
        snapshotColumns(snapshot, 'emdo.finance_document_evidence'),
      ).not.toEqual(expect.arrayContaining(['deletion_proposal_id']));
    }
  });

  it('adds Mexico working paper scopes without table changes', async () => {
    expect(tableDelta(await readSnapshot(73), await readSnapshot(74))).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
  });

  it('keeps recurring source schedules additive without table changes', async () => {
    expect(tableDelta(await readSnapshot(72), await readSnapshot(73))).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
  });

  it('adds only durable invoice review drafts in 0047', async () => {
    expect(tableDelta(await readSnapshot(46), await readSnapshot(47))).toEqual({
      added: ['emdo.finance_invoice_review_drafts'],
      changed: [],
      removed: [],
    });
  });

  it('keeps audio, household, sync, and preference structures in their owned boundary', async () => {
    const [
      snapshot2,
      snapshot3,
      snapshot4,
      snapshot5,
      snapshot6,
      snapshot7,
      snapshot8,
      snapshot9,
    ] = await Promise.all([2, 3, 4, 5, 6, 7, 8, 9].map(readSnapshot));

    expect(tableDelta(snapshot2, snapshot3).added).toEqual(
      expect.arrayContaining([
        'emdo.manager_turn_operations',
        'emdo.manager_turns',
      ]),
    );

    expect(tableDelta(snapshot3, snapshot4)).toEqual({
      added: [
        'emdo.audio_request_claim_outcomes',
        'emdo.audio_request_receipt_operations',
        'emdo.audio_request_receipts',
      ],
      changed: [],
      removed: [],
    });
    expect(tableDelta(snapshot4, snapshot5)).toEqual({
      added: [
        'emdo.household_administration_commands',
        'emdo.invitation_delivery_secrets',
        'emdo.invitation_redemption_commands',
      ],
      changed: ['emdo.invitations', 'emdo.worker_operation_outbox'],
      removed: [],
    });
    expect(tableDelta(snapshot5, snapshot6)).toEqual({
      added: ['emdo.sync_api_request_receipts', 'emdo.sync_entity_revisions'],
      changed: ['emdo.sync_operation_receipts'],
      removed: [],
    });
    expect(tableDelta(snapshot6, snapshot7)).toEqual({
      added: [
        'emdo.notification_preference_commands',
        'emdo.notification_preferences',
      ],
      changed: [],
      removed: [],
    });
    expect(tableDelta(snapshot7, snapshot8)).toEqual({
      added: [
        'emdo.finance_import_fingerprints',
        'emdo.finance_import_plans',
        'emdo.finance_import_receipts',
      ],
      changed: [],
      removed: [],
    });
    expect(tableDelta(snapshot8, snapshot9)).toEqual({
      added: ['emdo.google_oauth_authorization_starts'],
      changed: [],
      removed: [],
    });
    const snapshot10 = await readSnapshot(10);
    expect(tableDelta(snapshot9, snapshot10)).toEqual({
      added: ['emdo.google_oauth_disconnect_operations'],
      changed: [],
      removed: [],
    });
    const snapshot11 = await readSnapshot(11);
    expect(tableDelta(snapshot10, snapshot11)).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
    const snapshot12 = await readSnapshot(12);
    expect(tableDelta(snapshot11, snapshot12)).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
    const snapshot13 = await readSnapshot(13);
    expect(tableDelta(snapshot12, snapshot13)).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
    const snapshot14 = await readSnapshot(14);
    expect(tableDelta(snapshot13, snapshot14)).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
    const snapshot15 = await readSnapshot(15);
    expect(tableDelta(snapshot14, snapshot15)).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
    const snapshot16 = await readSnapshot(16);
    expect(tableDelta(snapshot15, snapshot16)).toEqual({
      added: [
        'emdo.finance_document_chunks',
        'emdo.finance_document_evidence',
        'emdo.finance_document_extractions',
        'emdo.finance_document_matches',
        'emdo.finance_document_review_batches',
        'emdo.finance_documents',
        'emdo.finance_specialist_record_receipts',
      ],
      changed: [],
      removed: [],
    });
  });

  it('keeps 0008 finance foreign keys and checks fully represented before the additive OAuth snapshot', async () => {
    const [snapshot8, files] = await Promise.all([
      readSnapshot(8),
      readdir(metadataUrl),
    ]);
    const plans = snapshot8.tables['emdo.finance_import_plans'] as {
      readonly indexes: Readonly<Record<string, unknown>>;
      readonly foreignKeys: Readonly<Record<string, unknown>>;
      readonly uniqueConstraints: Readonly<Record<string, unknown>>;
      readonly checkConstraints: Readonly<Record<string, unknown>>;
    };
    const fingerprints = snapshot8.tables[
      'emdo.finance_import_fingerprints'
    ] as {
      readonly indexes: Readonly<Record<string, unknown>>;
      readonly uniqueConstraints: Readonly<Record<string, unknown>>;
      readonly checkConstraints: Readonly<Record<string, unknown>>;
    };
    const receipts = snapshot8.tables['emdo.finance_import_receipts'] as {
      readonly indexes: Readonly<Record<string, unknown>>;
      readonly uniqueConstraints: Readonly<Record<string, unknown>>;
      readonly checkConstraints: Readonly<Record<string, unknown>>;
    };
    expect(Object.keys(plans.foreignKeys).sort()).toEqual([
      'finance_import_plans_household_space_fk',
      'finance_import_plans_owner_membership_fk',
    ]);
    for (const [snapshotTable, schemaTable] of [
      [plans, financeImportPlans],
      [fingerprints, financeImportFingerprints],
      [receipts, financeImportReceipts],
    ] as const) {
      const config = getTableConfig(schemaTable);
      expect(Object.keys(snapshotTable.indexes).sort()).toEqual(
        config.indexes.map((index) => index.config.name).sort(),
      );
      expect(Object.keys(snapshotTable.uniqueConstraints).sort()).toEqual(
        config.uniqueConstraints.map((constraint) => constraint.name).sort(),
      );
    }
    expect(Object.keys(plans.checkConstraints).sort()).toEqual(
      getTableConfig(financeImportPlans)
        .checks.map((check) => check.name)
        .sort(),
    );
    expect(Object.keys(fingerprints.checkConstraints).sort()).toEqual(
      getTableConfig(financeImportFingerprints)
        .checks.map((check) => check.name)
        .sort(),
    );
    expect(Object.keys(receipts.checkConstraints).sort()).toEqual(
      getTableConfig(financeImportReceipts)
        .checks.map((check) => check.name)
        .sort(),
    );
    expect(files).toContain('0009_snapshot.json');
    expect(files).toContain('0010_snapshot.json');
  });

  it('keeps the 0009 OAuth start table exactly aligned with the schema', async () => {
    const snapshot9 = await readSnapshot(9);
    const stored = snapshot9.tables[
      'emdo.google_oauth_authorization_starts'
    ] as {
      readonly indexes: Readonly<Record<string, unknown>>;
      readonly foreignKeys: Readonly<Record<string, unknown>>;
      readonly uniqueConstraints: Readonly<Record<string, unknown>>;
      readonly checkConstraints: Readonly<Record<string, unknown>>;
    };
    const config = getTableConfig(googleOAuthAuthorizationStarts);

    expect(Object.keys(stored.indexes).sort()).toEqual(
      config.indexes.map((index) => index.config.name).sort(),
    );
    expect(Object.keys(stored.foreignKeys).sort()).toEqual(
      config.foreignKeys.map((key) => key.reference().name).sort(),
    );
    expect(Object.keys(stored.uniqueConstraints).sort()).toEqual(
      config.uniqueConstraints.map((constraint) => constraint.name).sort(),
    );
    expect(Object.keys(stored.checkConstraints).sort()).toEqual(
      config.checks.map((check) => check.name).sort(),
    );
  });

  it('keeps the 0010 OAuth disconnect table exactly aligned with the schema', async () => {
    const snapshot10 = await readSnapshot(10);
    const stored = snapshot10.tables[
      'emdo.google_oauth_disconnect_operations'
    ] as {
      readonly indexes: Readonly<Record<string, unknown>>;
      readonly foreignKeys: Readonly<Record<string, unknown>>;
      readonly uniqueConstraints: Readonly<Record<string, unknown>>;
      readonly checkConstraints: Readonly<Record<string, unknown>>;
    };
    const config = getTableConfig(googleOAuthDisconnectOperations);

    expect(Object.keys(stored.indexes).sort()).toEqual(
      config.indexes.map((index) => index.config.name).sort(),
    );
    expect(Object.keys(stored.foreignKeys).sort()).toEqual(
      config.foreignKeys.map((key) => key.reference().name).sort(),
    );
    expect(Object.keys(stored.uniqueConstraints).sort()).toEqual(
      config.uniqueConstraints.map((constraint) => constraint.name).sort(),
    );
    expect(Object.keys(stored.checkConstraints).sort()).toEqual(
      config.checks.map((check) => check.name).sort(),
    );
  });

  it('keeps the 0016 Finance specialist receipt snapshot aligned with its narrow durable schema', async () => {
    const snapshot16 = await readSnapshot(16);
    const stored = snapshot16.tables[
      'emdo.finance_specialist_record_receipts'
    ] as {
      readonly indexes: Readonly<Record<string, unknown>>;
      readonly foreignKeys: Readonly<Record<string, unknown>>;
      readonly uniqueConstraints: Readonly<Record<string, unknown>>;
      readonly checkConstraints: Readonly<Record<string, unknown>>;
    };
    const config = getTableConfig(financeSpecialistRecordReceipts);

    expect(Object.keys(stored.indexes).sort()).toEqual(
      config.indexes.map((index) => index.config.name).sort(),
    );
    expect(Object.keys(stored.foreignKeys).sort()).toEqual(
      config.foreignKeys.map((key) => key.reference().name).sort(),
    );
    expect(Object.keys(stored.uniqueConstraints).sort()).toEqual(
      config.uniqueConstraints.map((constraint) => constraint.name).sort(),
    );
    expect(Object.keys(stored.checkConstraints).sort()).toEqual(
      config.checks.map((check) => check.name).sort(),
    );
  });

  it('keeps the encrypted Calendar grant checks aligned from their 0003 owner onward', async () => {
    const expectedChecks = getTableConfig(encryptedGoogleCalendarGrants)
      .checks.map((check) => check.name)
      .sort();
    for (let index = 3; index <= 9; index += 1) {
      const snapshot = await readSnapshot(index);
      const stored = snapshot.tables[
        'emdo.encrypted_google_calendar_grants'
      ] as {
        readonly checkConstraints: Readonly<Record<string, unknown>>;
      };
      expect(Object.keys(stored.checkConstraints).sort()).toEqual(
        expectedChecks,
      );
    }
  });
});

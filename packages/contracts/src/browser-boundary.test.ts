import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import * as browserContracts from './browser.js';

const source = (name: string): Promise<string> =>
  readFile(new URL(name, import.meta.url), 'utf8');

describe('browser-safe contracts boundary', () => {
  it('exports public experience and workspace Finance contracts', () => {
    expect(Object.keys(browserContracts)).toEqual(
      expect.arrayContaining([
        'ActivityPageSchema',
        'FinanceImportDestinationAccountSchema',
        'FinanceImportDestinationCategorySchema',
        'FinanceImportDestinationsSchema',
        'FinancePageSchema',
        'IdentifierSchema',
        'IsoDateTimeSchema',
        'JsonValueSchema',
        'NotificationPreferencesUpdateRequestSchema',
        'NotificationPreferencesViewSchema',
        'OpaqueReferenceSchema',
        'Sha256Schema',
        'SchedulePageSchema',
        'SettingsViewSchema',
        'ShoppingPageSchema',
        'SupportedLocaleSchema',
        'SyncOperationSchema',
        'TodayViewSchema',
        'UuidSchema',
        'deepFreeze',
        'CreatePrivateTaxCaseSchema',
        'ResetPrivateTaxInputsSchema',
        'SaveReviewedFinancePdfMappingSchema',
        'FinanceTaxCalculationRunSummarySchema',
        'FinanceLegacyMigrationPlanSchema',
        'StructuredInvoiceExtractionSchema',
        'ReviewStructuredInvoiceSchema',
        'FinanceBudgetRevisionSchema',
        'FinancePlanningAutomationResultSchema',
      ]),
    );
  });

  it('keeps the entire browser import graph within reviewed public contract modules', async () => {
    const visited = new Set<string>();
    const visit = async (name: string): Promise<void> => {
      if (visited.has(name)) return;
      visited.add(name);
      const imports = ts.preProcessFile(
        await source(name),
        true,
        true,
      ).importedFiles;
      for (const { fileName } of imports) {
        if (!fileName.startsWith('./')) {
          expect(fileName).toBe('zod');
          continue;
        }
        expect(fileName).toMatch(/^\.\/[a-z0-9-]+\.js$/u);
        await visit(fileName.slice(2).replace(/\.js$/u, '.ts'));
      }
    };
    await visit('browser.ts');
    expect([...visited].sort()).toEqual(
      [
        'browser.ts',
        'experience.ts',
        'finance-automation-schedules.ts',
        'finance-automations.ts',
        'finance-canada-cpp-2025.ts',
        'finance-corporate-actions.ts',
        'finance-corporate-action-settlement.ts',
        'finance-fec.ts',
        'finance-opening.ts',
        'finance-pdf-ocr.ts',
        'finance-dividends.ts',
        'finance-generated-reports.ts',
        'finance-imports.ts',
        'finance-import-components.ts',
        'finance-import-posting.ts',
        'finance-investments.ts',
        'finance-investment-reconciliation.ts',
        'finance-lots.ts',
        'finance-pdf-inspection.ts',
        'finance-pdf.ts',
        'finance-planning.ts',
        'finance-planning-results.ts',
        'finance-report-mappings.ts',
        'finance-image.ts',
        'finance-ofx.ts',
        'finance-legacy-migration.ts',
        'finance-standardization.ts',
        'finance-standardization-reconciliation.ts',
        'finance-structured-invoices.ts',
        'finance-tax-cases.ts',
        'finance-tax-questionnaire.ts',
        'finance-tax-read.ts',
        'finance-tax-runs.ts',
        'finance-tax.ts',
        'finance-v2.ts',
        'finance-xlsx.ts',
        'locale.ts',
        'primitives.ts',
        'sync.ts',
        'workspace.ts',
      ].sort(),
    );
    expect(
      Object.keys(browserContracts).filter((name) =>
        /^(AgentInvocation|CapabilityInvocation|GuardedAction|DisclosureGrant|ProviderAuthority)/u.test(
          name,
        ),
      ),
    ).toEqual([]);
  });

  it('publishes explicit browser and server package subpaths', async () => {
    const packageJson = JSON.parse(
      await source('../package.json'),
    ) as Readonly<{ exports?: Readonly<Record<string, unknown>> }>;

    expect(packageJson.exports).toMatchObject({
      './browser': './src/browser.ts',
      './server': './src/index.ts',
    });
  });
});

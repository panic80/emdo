import { describe, expect, it } from 'vitest';

describe('domain package subpath exports', () => {
  it('keeps the package root production-inert', async () => {
    const root = await import('@emdo/domains');

    expect(Object.keys(root)).toEqual([]);
    expect(root).not.toHaveProperty('InMemoryAuditLedger');
    expect(root).not.toHaveProperty('InMemoryProposalRepository');
    expect(root).not.toHaveProperty('ProposalService');
  });

  it('exposes stable least-privilege domain facades', async () => {
    const [
      scheduler,
      finance,
      shopping,
      conflicts,
      providerProposals,
      providerProposalTesting,
    ] = await Promise.all([
      import('@emdo/domains/scheduler'),
      import('@emdo/domains/finance'),
      import('@emdo/domains/shopping'),
      import('@emdo/domains/conflicts'),
      import('@emdo/domains/server/provider-proposals'),
      import('@emdo/domains/testing/provider-proposals'),
    ]);

    expect(scheduler).toHaveProperty('rankScheduleAlternatives');
    expect(scheduler).toHaveProperty('ScopedCalendarProposalMaterializer');
    expect(scheduler).not.toHaveProperty('CalendarProposalMaterializer');
    expect(finance).toHaveProperty('calculateMonthlyCategoryTotals');
    expect(finance).toHaveProperty('previewFinanceImport');
    expect(finance).not.toHaveProperty('InMemoryFinanceImportPlanningService');
    expect(finance).not.toHaveProperty('boundedFinanceParse');
    expect(shopping).toHaveProperty('normalizeShoppingItem');
    expect(shopping).toHaveProperty('groupShoppingItemsByRetailer');
    expect(conflicts).toHaveProperty('guardOfflineSyncOperation');
    expect(conflicts).toHaveProperty('mergeSchedulerConflict');
    expect(conflicts).toHaveProperty('resolveDeterministicSyncOperation');
    expect(providerProposals).toHaveProperty('ProposalDecisionService');
    expect(providerProposals).toHaveProperty('createProposalLifecycleService');
    expect(providerProposals).toHaveProperty('ProposalService');
    expect(providerProposals).toHaveProperty('hashActionProposalApproval');
    expect(providerProposals).not.toHaveProperty('InMemoryProposalRepository');
    expect(providerProposalTesting).toHaveProperty(
      'InMemoryProposalRepository',
    );
  });

  it('keeps browser-transitive conflict reducers on the browser contracts facade', async () => {
    const sourceRoot = new URL('./shared/', import.meta.url);
    const { readFile } = await import('node:fs/promises');
    const sources = await Promise.all([
      readFile(new URL('conflicts.ts', sourceRoot), 'utf8'),
      readFile(new URL('sync-conflict-runtime.ts', sourceRoot), 'utf8'),
    ]);

    for (const source of sources) {
      expect(source).toContain("from '@emdo/contracts/browser'");
      expect(source).not.toMatch(/from ['"]@emdo\/contracts['"]/u);
    }
  });
});

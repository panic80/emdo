import { describe, expect, it } from 'vitest';
import { FinanceGeneratedReportSchema } from './finance-generated-reports.js';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const report = {
  id: id(1),
  workspaceId: id(2),
  bookId: id(3),
  automationRunId: id(4),
  reportVersion: 1,
  kind: 'posted-ledger-trial-balance',
  coverage: 'all-posted-journals-at-snapshot',
  currency: 'CAD',
  snapshotAt: '2026-09-13T00:00:00Z',
  rows: [
    {
      accountId: id(5),
      code: '1000',
      name: 'Cash',
      kind: 'asset',
      debit: '10000000000000000000000000000.01',
      credit: '0',
      balance: '10000000000000000000000000000.01',
    },
    {
      accountId: id(6),
      code: '4000',
      name: 'Income',
      kind: 'income',
      debit: '0',
      credit: '10000000000000000000000000000.01',
      balance: '-10000000000000000000000000000.01',
    },
  ],
  sourceJournals: [
    {
      journalId: id(7),
      effectiveOn: '2026-09-13',
      sourceReference: 'posted-source',
      payloadHash: 'a'.repeat(64),
    },
  ],
  totalDebit: '10000000000000000000000000000.01',
  totalCredit: '10000000000000000000000000000.01',
};
describe('Generated accounting report integrity', () => {
  it('preserves aggregates beyond one source amount without floating point', () => {
    expect(FinanceGeneratedReportSchema.parse(report).totalDebit).toBe(
      report.totalDebit,
    );
  });
  it('rejects corrupt balances, totals, repeated sources and currency precision', () => {
    for (const changed of [
      { ...report, totalCredit: '0' },
      {
        ...report,
        rows: [{ ...report.rows[0], balance: '0' }, report.rows[1]],
      },
      {
        ...report,
        sourceJournals: [report.sourceJournals[0], report.sourceJournals[0]],
      },
      { ...report, currency: 'JPY' },
    ])
      expect(FinanceGeneratedReportSchema.safeParse(changed).success).toBe(
        false,
      );
  });
  it('returns validation failure for malformed decimals instead of invoking arithmetic on them', () => {
    expect(
      FinanceGeneratedReportSchema.safeParse({
        ...report,
        totalDebit: 'not a decimal',
      }).success,
    ).toBe(false);
  });
  it('validates statement scope, account classifications, and reconciliation math', () => {
    const income = {
      ...report,
      kind: 'income-statement' as const,
      coverage: 'period-posted-journals-at-snapshot' as const,
      periodId: id(8),
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      asOf: null,
      rows: [
        {
          accountId: id(6),
          code: '4000',
          name: 'Income',
          kind: 'income' as const,
          debit: '0',
          credit: '10',
          balance: '-10',
          balanceBasis: 'debit-minus-credit' as const,
          classification: {
            statement: 'income-statement' as const,
            section: 'revenue',
            revision: 1,
            displayOrder: 0,
          },
        },
      ],
      sourceJournals: [
        {
          journalId: id(7),
          effectiveOn: '2026-06-01',
          sourceReference: 'posted-source',
          payloadHash: 'a'.repeat(64),
        },
      ],
      totalDebit: '0',
      totalCredit: '10',
      reconciliation: {
        trialBalanceTotalDebit: '10',
        trialBalanceTotalCredit: '10',
        sourceTotalDebit: '10',
        sourceTotalCredit: '10',
        statementTotalDebit: '0',
        statementTotalCredit: '10',
        balanceSheetAssets: null,
        balanceSheetLiabilities: null,
        balanceSheetEquity: null,
        currentYearEarnings: null,
        difference: '0',
        balanced: true,
      },
    };
    expect(FinanceGeneratedReportSchema.safeParse(income).success).toBe(true);
    expect(
      FinanceGeneratedReportSchema.safeParse({
        ...income,
        sourceJournals: [
          { ...income.sourceJournals[0], effectiveOn: '2025-12-31' },
        ],
      }).success,
    ).toBe(false);
    expect(
      FinanceGeneratedReportSchema.safeParse({
        ...income,
        rows: [
          {
            ...income.rows[0],
            balanceBasis: 'credit-minus-debit',
          },
        ],
      }).success,
    ).toBe(false);
  });
});

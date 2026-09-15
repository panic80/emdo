import { z } from 'zod';
import { UuidSchema, IsoDateTimeSchema, Sha256Schema } from './primitives.js';
import {
  FinanceCurrencySchema,
  CreateLedgerAccountSchema,
} from './finance-v2.js';

// Up to 100,000 source lines, each at most 26 integer digits. Aggregates must not
// overflow the source-amount contract or pass through binary floating point.
export const FinanceReportDecimalSchema = z
  .string()
  .max(45)
  .regex(/^-?(?:0|[1-9]\d{0,30})(?:\.\d{1,12})?$/);
const unsigned = FinanceReportDecimalSchema.refine(
  (value) => !value.startsWith('-'),
  'Movement totals must be nonnegative',
);
const valueAtScale = (value: string) => {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const result = BigInt(whole!) * 10n ** 12n + BigInt(fraction.padEnd(12, '0'));
  return negative ? -result : result;
};

export const FinanceReportStatementSchema = z.enum([
  'balance-sheet',
  'income-statement',
]);
export const FinanceReportBalanceBasisSchema = z.enum([
  'debit-minus-credit',
  'credit-minus-debit',
]);
export const FinanceReportClassificationSchema = z.strictObject({
  statement: FinanceReportStatementSchema,
  section: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/),
  revision: z.number().int().safe().positive(),
  displayOrder: z.number().int().safe().nonnegative().max(10000),
});
export const FinanceLedgerAccountClassificationSchema = z.strictObject({
  workspaceId: UuidSchema,
  bookId: UuidSchema,
  accountId: UuidSchema,
  revision: z.number().int().safe().positive(),
  statement: FinanceReportStatementSchema,
  section: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/),
  displayOrder: z.number().int().safe().nonnegative().max(10000),
  createdBy: UuidSchema,
  createdAt: IsoDateTimeSchema,
});
export const SetFinanceLedgerAccountClassificationSchema = z.strictObject({
  statement: FinanceReportStatementSchema,
  section: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/),
  displayOrder: z.number().int().safe().nonnegative().max(10000).default(0),
});

/** Selection is canonicalized into every automation intent. Missing selection
 * on legacy runs means the original all-posted trial balance. */
export const FinanceReportSelectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('posted-ledger-trial-balance') }),
  z.strictObject({ kind: z.literal('income-statement'), periodId: UuidSchema }),
  z.strictObject({ kind: z.literal('balance-sheet'), asOf: z.iso.date() }),
]);
export type FinanceReportSelection = z.infer<
  typeof FinanceReportSelectionSchema
>;
export type FinanceLedgerAccountClassification = z.infer<
  typeof FinanceLedgerAccountClassificationSchema
>;

const ScopeFields = {
  periodId: UuidSchema.nullable().optional(),
  periodStart: z.iso.date().nullable().optional(),
  periodEnd: z.iso.date().nullable().optional(),
  asOf: z.iso.date().nullable().optional(),
} as const;
const BaseSummary = {
  id: UuidSchema,
  workspaceId: UuidSchema,
  bookId: UuidSchema,
  automationRunId: UuidSchema,
  reportVersion: z.literal(1),
  currency: FinanceCurrencySchema,
  snapshotAt: IsoDateTimeSchema,
  ...ScopeFields,
} as const;

const TrialBalanceSummarySchema = z.strictObject({
  ...BaseSummary,
  kind: z.literal('posted-ledger-trial-balance'),
  coverage: z.literal('all-posted-journals-at-snapshot'),
});
const IncomeStatementSummarySchema = z.strictObject({
  ...BaseSummary,
  kind: z.literal('income-statement'),
  coverage: z.literal('period-posted-journals-at-snapshot'),
  periodId: UuidSchema,
  periodStart: z.iso.date(),
  periodEnd: z.iso.date(),
  asOf: z.null(),
});
const BalanceSheetSummarySchema = z.strictObject({
  ...BaseSummary,
  kind: z.literal('balance-sheet'),
  coverage: z.literal('posted-journals-through-as-of'),
  periodId: z.null(),
  periodStart: z.null(),
  periodEnd: z.null(),
  asOf: z.iso.date(),
});

/** Summary metadata is a discriminated union while retaining defaults for
 * legacy saved trial-balance rows that predate explicit scope columns. */
const SummaryUnion = z.discriminatedUnion('kind', [
  TrialBalanceSummarySchema,
  IncomeStatementSummarySchema,
  BalanceSheetSummarySchema,
]);
/** Compatibility helper retained for existing browser fixtures/readers that
 * strip detail-only fields before validating summary metadata. */
export const FinanceGeneratedReportSummarySchema = Object.assign(
  SummaryUnion,
  {
    strip: () =>
      z.preprocess((value) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value))
          return value;
        const known = new Set([
          'id',
          'workspaceId',
          'bookId',
          'automationRunId',
          'reportVersion',
          'kind',
          'coverage',
          'currency',
          'snapshotAt',
          'periodId',
          'periodStart',
          'periodEnd',
          'asOf',
        ]);
        return Object.fromEntries(
          Object.entries(value).filter(([key]) => known.has(key)),
        );
      }, SummaryUnion),
  },
);

const ReportRowSchema = z.strictObject({
  accountId: UuidSchema,
  code: CreateLedgerAccountSchema.shape.code,
  name: CreateLedgerAccountSchema.shape.name,
  kind: CreateLedgerAccountSchema.shape.kind,
  debit: unsigned,
  credit: unsigned,
  balance: FinanceReportDecimalSchema,
  /** Explicitly records how the signed balance was derived for statement rows. */
  balanceBasis: FinanceReportBalanceBasisSchema.nullable().optional(),
  /** Null is retained for legacy trial balances; statement rows must carry the
   * exact classification revision used by the generator. */
  classification: FinanceReportClassificationSchema.nullable().optional(),
});

const SourceJournalSchema = z.strictObject({
  journalId: UuidSchema,
  effectiveOn: z.iso.date(),
  sourceReference: z.string().min(1).max(200),
  payloadHash: Sha256Schema,
});

export const FinanceGeneratedReportReconciliationSchema = z.strictObject({
  trialBalanceTotalDebit: unsigned,
  trialBalanceTotalCredit: unsigned,
  sourceTotalDebit: unsigned,
  sourceTotalCredit: unsigned,
  statementTotalDebit: unsigned,
  statementTotalCredit: unsigned,
  balanceSheetAssets: FinanceReportDecimalSchema.nullable(),
  balanceSheetLiabilities: FinanceReportDecimalSchema.nullable(),
  balanceSheetEquity: FinanceReportDecimalSchema.nullable(),
  currentYearEarnings: FinanceReportDecimalSchema.nullable(),
  difference: FinanceReportDecimalSchema,
  balanced: z.boolean(),
});

const ReportBody = {
  rows: z.array(ReportRowSchema).max(10000),
  sourceJournals: z.array(SourceJournalSchema).max(10000),
  totalDebit: unsigned,
  totalCredit: unsigned,
  reconciliation: FinanceGeneratedReportReconciliationSchema.nullable().optional(),
} as const;

const TrialBalanceReportSchema = TrialBalanceSummarySchema.extend(ReportBody);
const IncomeStatementReportSchema =
  IncomeStatementSummarySchema.extend(ReportBody);
const BalanceSheetReportSchema =
  BalanceSheetSummarySchema.extend(ReportBody);

export const FinanceGeneratedReportSchema = z
  .discriminatedUnion('kind', [
    TrialBalanceReportSchema,
    IncomeStatementReportSchema,
    BalanceSheetReportSchema,
  ])
  .superRefine((report, context) => {
    const issue = (message: string) =>
      context.addIssue({ code: 'custom', message });
    const decimalValues = [
      report.totalDebit,
      report.totalCredit,
      ...report.rows.flatMap((row) => [row.debit, row.credit, row.balance]),
      ...(report.reconciliation
        ? [
            report.reconciliation.trialBalanceTotalDebit,
            report.reconciliation.trialBalanceTotalCredit,
            report.reconciliation.sourceTotalDebit,
            report.reconciliation.sourceTotalCredit,
            report.reconciliation.statementTotalDebit,
            report.reconciliation.statementTotalCredit,
            report.reconciliation.balanceSheetAssets,
            report.reconciliation.balanceSheetLiabilities,
            report.reconciliation.balanceSheetEquity,
            report.reconciliation.currentYearEarnings,
            report.reconciliation.difference,
          ].filter((value): value is string => value !== null)
        : []),
    ];
    if (
      decimalValues.some(
        (value) => !FinanceReportDecimalSchema.safeParse(value).success,
      )
    )
      return;
    if (
      new Set(report.rows.map((row) => row.accountId)).size !==
        report.rows.length ||
      new Set(report.sourceJournals.map((row) => row.journalId)).size !==
        report.sourceJournals.length
    )
      issue('Snapshot source identities must be unique');

    for (const source of report.sourceJournals) {
      const inScope =
        report.kind === 'posted-ledger-trial-balance' ||
        (report.kind === 'income-statement'
          ? source.effectiveOn >= report.periodStart &&
            source.effectiveOn <= report.periodEnd
          : source.effectiveOn <= report.asOf);
      if (!inScope)
        issue('Source journal falls outside the declared report scope');
    }

    let debit = 0n;
    let credit = 0n;
    const precision = ['JPY', 'KRW'].includes(report.currency) ? 0 : 2;
    for (const row of report.rows) {
      const d = valueAtScale(row.debit);
      const c = valueAtScale(row.credit);
      debit += d;
      credit += c;
      const expectedBalance =
        report.kind === 'balance-sheet' &&
        (row.kind === 'liability' || row.kind === 'equity')
          ? c - d
          : d - c;
      const expectedBasis =
        report.kind === 'posted-ledger-trial-balance'
          ? null
          : report.kind === 'balance-sheet' &&
              (row.kind === 'liability' || row.kind === 'equity')
            ? 'credit-minus-debit'
            : 'debit-minus-credit';
      if (
        report.kind !== 'posted-ledger-trial-balance' &&
        row.balanceBasis !== expectedBasis
      )
        issue('Statement rows require the correct balance basis');
      if (expectedBalance !== valueAtScale(row.balance))
        issue('Snapshot balance differs from posted movements');
      for (const amount of [row.debit, row.credit, row.balance])
        if ((amount.split('.')[1] ?? '').replace(/0+$/, '').length > precision)
          issue('Snapshot amount exceeds functional-currency precision');
      if (
        report.kind !== 'posted-ledger-trial-balance' &&
        (row.classification ?? null) === null
      )
        issue('Statement rows require a versioned account classification');
      if (report.kind !== 'posted-ledger-trial-balance') {
        const classification = row.classification;
        const expectedStatement = report.kind;
        const expectedKind =
          report.kind === 'income-statement'
            ? row.kind === 'income' || row.kind === 'expense'
            : row.kind === 'asset' ||
              row.kind === 'liability' ||
              row.kind === 'equity';
        if (
          classification?.statement !== expectedStatement ||
          !expectedKind
        )
          issue('Statement row classification does not match its account');
      }
    }
    if (
      debit !== valueAtScale(report.totalDebit) ||
      credit !== valueAtScale(report.totalCredit)
    )
      issue('Snapshot totals do not match report rows');

    if (report.kind === 'posted-ledger-trial-balance') {
      if (debit !== credit) issue('Trial balance totals do not balance');
      if ((report.reconciliation ?? null) !== null)
        issue('Trial balances do not carry statement reconciliation metadata');
      return;
    }
    const reconciliation = report.reconciliation ?? null;
    if (reconciliation === null) {
      issue('Statement reports require reconciliation metadata');
      return;
    }
    if (
      valueAtScale(reconciliation.statementTotalDebit) !== debit ||
      valueAtScale(reconciliation.statementTotalCredit) !== credit ||
      valueAtScale(reconciliation.sourceTotalDebit) !==
        valueAtScale(reconciliation.trialBalanceTotalDebit) ||
      valueAtScale(reconciliation.sourceTotalCredit) !==
        valueAtScale(reconciliation.trialBalanceTotalCredit) ||
      valueAtScale(reconciliation.sourceTotalDebit) !==
        valueAtScale(reconciliation.sourceTotalCredit)
    )
      issue('Report reconciliation does not match source movements');
    if (report.kind === 'income-statement') {
      if (
        reconciliation.balanceSheetAssets !== null ||
        reconciliation.balanceSheetLiabilities !== null ||
        reconciliation.balanceSheetEquity !== null ||
        reconciliation.currentYearEarnings !== null
      )
        issue('Income statements cannot carry balance-sheet reconciliation fields');
      if (valueAtScale(reconciliation.difference) !== 0n)
        issue('Income statement reconciliation difference must be zero');
    } else if (
      reconciliation.balanceSheetAssets === null ||
      reconciliation.balanceSheetLiabilities === null ||
      reconciliation.balanceSheetEquity === null ||
      reconciliation.currentYearEarnings === null
    ) {
      issue('Balance sheets require current-year earnings reconciliation fields');
    } else if (
      valueAtScale(reconciliation.difference) !==
      valueAtScale(reconciliation.balanceSheetAssets) -
        valueAtScale(reconciliation.balanceSheetLiabilities) -
        valueAtScale(reconciliation.balanceSheetEquity) -
        valueAtScale(reconciliation.currentYearEarnings)
    )
      issue('Balance-sheet reconciliation difference is inconsistent');
    if (
      reconciliation.balanced !==
      (valueAtScale(reconciliation.difference) === 0n)
    )
      issue('Reconciliation balance flag does not match its difference');
  });

export type FinanceGeneratedReportSummary = z.infer<
  typeof FinanceGeneratedReportSummarySchema
>;
export type FinanceGeneratedReport = z.infer<typeof FinanceGeneratedReportSchema>;

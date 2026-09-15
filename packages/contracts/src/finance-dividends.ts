import { z } from 'zod';
import { UuidSchema } from './primitives.js';
import { FinanceCurrencySchema, FinanceDecimalSchema } from './finance-v2.js';

const NonNegativeDecimal = FinanceDecimalSchema.refine(
  (value) => !value.startsWith('-'),
  'Must be nonnegative',
);
const PositiveDecimal = NonNegativeDecimal.refine(
  (value) => !/^0(?:\.0+)?$/.test(value),
  'Must be positive',
);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

/** The three economic amounts that must be supplied by a reviewed dividend. */
export const FinanceCashDividendAmountKindSchema = z.enum([
  'gross',
  'withholding',
  'net',
]);
export type FinanceCashDividendAmountKind = z.infer<
  typeof FinanceCashDividendAmountKindSchema
>;

/** Source coordinates are retained for every dividend amount. */
export const FinanceCashDividendProvenanceSchema = z.strictObject({
  sourceRow: z.number().int().positive(),
  field: FinanceCashDividendAmountKindSchema,
  column: z.string().max(200).nullable(),
  raw: z.string().max(10_000),
  contextAnchor: z.string().max(300).nullable(),
  pdfSource: z.unknown().optional(),
});
export type FinanceCashDividendProvenance = z.infer<
  typeof FinanceCashDividendProvenanceSchema
>;

/** An amount carries both the observed native value and its explicit FX proof. */
export const FinanceCashDividendAmountSchema = z.strictObject({
  nativeAmount: NonNegativeDecimal,
  currency: FinanceCurrencySchema,
  functionalAmount: NonNegativeDecimal,
  fxRate: PositiveDecimal,
  fxSource: z.string().trim().min(1).max(200),
  provenance: FinanceCashDividendProvenanceSchema,
});
export type FinanceCashDividendAmount = z.infer<
  typeof FinanceCashDividendAmountSchema
>;

export const FinanceCashDividendLedgerMappingSchema = z.strictObject({
  cashLedgerAccountId: UuidSchema,
  dividendIncomeLedgerAccountId: UuidSchema,
  withholdingLedgerAccountId: UuidSchema,
});
export type FinanceCashDividendLedgerMapping = z.infer<
  typeof FinanceCashDividendLedgerMappingSchema
>;

/** Complete, reviewed action facts. Missing gross/tax/net values cannot parse. */
export const FinanceCashDividendActionSchema = z.strictObject({
  id: UuidSchema,
  actionType: z.literal('cash-dividend'),
  financialAccountId: UuidSchema,
  instrumentId: UuidSchema,
  evidenceId: UuidSchema,
  sourceRowId: UuidSchema,
  declaredOn: z.iso.date(),
  exDate: z.iso.date().nullable(),
  payableOn: z.iso.date(),
  sourceReference: z.string().trim().min(1).max(500),
  reviewReason: z.string().trim().min(1).max(2_000),
  gross: FinanceCashDividendAmountSchema,
  withholding: FinanceCashDividendAmountSchema,
  net: FinanceCashDividendAmountSchema,
  ledger: FinanceCashDividendLedgerMappingSchema,
});
export type FinanceCashDividendAction = z.infer<
  typeof FinanceCashDividendActionSchema
>;

/** Drafts are used by a review UI; null means the reviewer still owes a fact. */
export const FinanceCashDividendDraftSchema =
  FinanceCashDividendActionSchema.extend({
    gross: FinanceCashDividendAmountSchema.nullable(),
    withholding: FinanceCashDividendAmountSchema.nullable(),
    net: FinanceCashDividendAmountSchema.nullable(),
  });
export type FinanceCashDividendDraft = z.infer<
  typeof FinanceCashDividendDraftSchema
>;

/** Snapshot of the statement row that supplies the cash receipt. */
export const FinanceCashDividendSourceSnapshotSchema = z.strictObject({
  sourceRowId: UuidSchema,
  batchId: UuidSchema,
  sourceRow: z.number().int().positive(),
  evidenceId: UuidSchema,
  financialAccountId: UuidSchema,
  instrumentId: UuidSchema,
  sourceRevision: z.number().int().positive().safe(),
  sourceSnapshotHash: Sha256Schema,
  status: z.enum([
    'invalid',
    'review',
    'ready',
    'ignored',
    'committed',
    'matched',
  ]),
  effectiveOn: z.iso.date().nullable(),
  description: z.string().max(500),
  nativeAmount: FinanceDecimalSchema.nullable(),
  currency: FinanceCurrencySchema,
  fxRate: FinanceDecimalSchema.nullable(),
  fxSource: z.string().nullable(),
  issues: z.array(z.string().max(500)).max(100),
  financialAccountLedgerId: UuidSchema,
  functionalCurrency: FinanceCurrencySchema,
});
export type FinanceCashDividendSourceSnapshot = z.infer<
  typeof FinanceCashDividendSourceSnapshotSchema
>;

export const ReadInvestmentCashDividendSourceSchema = z.strictObject({
  sourceRowId: UuidSchema,
  financialAccountId: UuidSchema,
  instrumentId: UuidSchema,
  evidenceId: UuidSchema,
});
export type ReadInvestmentCashDividendSource = z.infer<
  typeof ReadInvestmentCashDividendSourceSchema
>;

/** A planner input is a reviewed action plus the exact source-row snapshot. */
export const PlanInvestmentCashDividendSchema = z.strictObject({
  action: FinanceCashDividendDraftSchema,
  source: FinanceCashDividendSourceSnapshotSchema,
});
export type PlanInvestmentCashDividend = z.infer<
  typeof PlanInvestmentCashDividendSchema
>;

export const FinanceCashDividendJournalLineSchema = z.strictObject({
  kind: FinanceCashDividendAmountKindSchema,
  accountId: UuidSchema,
  side: z.enum(['debit', 'credit']),
  amount: PositiveDecimal,
  nativeAmount: PositiveDecimal,
  currency: FinanceCurrencySchema,
  fxRate: PositiveDecimal,
  fxSource: z.string().trim().min(1).max(200),
});
export type FinanceCashDividendJournalLine = z.infer<
  typeof FinanceCashDividendJournalLineSchema
>;

const FinanceCashDividendBlockedReasonSchema = z.enum([
  'source-row-unavailable',
  'source-row-not-ready',
  'source-row-already-committed',
  'source-row-not-cash-inflow',
  'source-row-currency-mismatch',
  'source-row-amount-mismatch',
  'source-row-date-mismatch',
  'source-evidence-mismatch',
  'source-account-mismatch',
  'source-instrument-mismatch',
  'source-facts-missing',
  'amount-provenance-mismatch',
  'native-reconciliation-mismatch',
  'gross-not-positive',
  'gross-required',
  'withholding-required',
  'net-required',
  'gross-functional-mismatch',
  'withholding-functional-mismatch',
  'net-functional-mismatch',
  'functional-reconciliation-mismatch',
  'cash-ledger-mapping-mismatch',
  'ledger-account-mapping-mismatch',
  'fx-mapping-invalid',
  'dividend-date-invalid',
  'duplicate-source-row',
]);
export type FinanceCashDividendBlockedReason = z.infer<
  typeof FinanceCashDividendBlockedReasonSchema
>;

export const FinanceCashDividendPlanSchema = z.strictObject({
  calculationVersion: z.literal('investment-cash-dividends.v1'),
  action: FinanceCashDividendDraftSchema,
  source: FinanceCashDividendSourceSnapshotSchema,
  commitReadiness: z.enum(['ready', 'blocked']),
  blockedReasons: z.array(FinanceCashDividendBlockedReasonSchema),
  grossFunctionalAmount: NonNegativeDecimal.nullable(),
  withholdingFunctionalAmount: NonNegativeDecimal.nullable(),
  netFunctionalAmount: NonNegativeDecimal.nullable(),
  journalLines: z.array(FinanceCashDividendJournalLineSchema).max(3),
});
export type FinanceCashDividendPlan = z.infer<
  typeof FinanceCashDividendPlanSchema
>;

export const CommitInvestmentCashDividendSchema = z.strictObject({
  action: FinanceCashDividendActionSchema,
  expectedSourceRevision: z.number().int().positive().safe(),
  sourceSnapshotHash: Sha256Schema,
  idempotencyKey: z.string().trim().min(1).max(200),
});
export type CommitInvestmentCashDividend = z.infer<
  typeof CommitInvestmentCashDividendSchema
>;

export const FinanceCashDividendCommitResultSchema = z.strictObject({
  actionId: UuidSchema,
  workspaceId: UuidSchema,
  bookId: UuidSchema,
  sourceRowId: UuidSchema,
  sourceRevision: z.number().int().positive().safe(),
  nextSourceRevision: z.number().int().positive().safe(),
  sourceSnapshotHash: Sha256Schema,
  economicTransactionId: UuidSchema,
  journalId: UuidSchema,
  grossFunctionalAmount: NonNegativeDecimal,
  withholdingFunctionalAmount: NonNegativeDecimal,
  netFunctionalAmount: PositiveDecimal,
  status: z.literal('committed'),
  replayed: z.boolean(),
});
export type FinanceCashDividendCommitResult = z.infer<
  typeof FinanceCashDividendCommitResultSchema
>;

/** An amount as persisted beside the immutable action and journal proof. */
export const FinanceCashDividendSavedAmountSchema = z.strictObject({
  id: UuidSchema,
  kind: FinanceCashDividendAmountKindSchema,
  nativeAmount: NonNegativeDecimal,
  currency: FinanceCurrencySchema,
  functionalAmount: NonNegativeDecimal,
  fxRate: PositiveDecimal,
  fxSource: z.string().trim().min(1).max(200),
  ledgerAccountId: UuidSchema,
  postingSide: z.enum(['debit', 'credit']),
  journalId: UuidSchema,
  journalLineNumber: z.number().int().positive().nullable(),
  provenance: FinanceCashDividendProvenanceSchema,
});
export type FinanceCashDividendSavedAmount = z.infer<
  typeof FinanceCashDividendSavedAmountSchema
>;

/**
 * The source readback deliberately distinguishes the pre-commit revision/hash
 * from the source row's current claimed revision. This lets an agent explain
 * exactly which reviewed facts produced the action without recomputing them.
 */
export const FinanceCashDividendSavedSourceSchema = z.strictObject({
  sourceRowId: UuidSchema,
  batchId: UuidSchema,
  sourceRow: z.number().int().positive().safe(),
  evidenceId: UuidSchema,
  financialAccountId: UuidSchema,
  instrumentId: UuidSchema,
  sourceRevision: z.number().int().positive().safe(),
  currentRevision: z.number().int().positive().safe(),
  sourceSnapshotHash: Sha256Schema,
  status: z.literal('committed'),
  effectiveOn: z.iso.date().nullable(),
  description: z.string().max(500),
  nativeAmount: FinanceDecimalSchema.nullable(),
  currency: FinanceCurrencySchema,
  fxRate: FinanceDecimalSchema.nullable(),
  fxSource: z.string().nullable(),
  issues: z.array(z.string().max(500)).max(100),
  financialAccountLedgerId: UuidSchema,
  functionalCurrency: FinanceCurrencySchema,
});
export type FinanceCashDividendSavedSource = z.infer<
  typeof FinanceCashDividendSavedSourceSchema
>;

/** Immutable action readback for list pages and agent explanations. */
export const FinanceCashDividendSavedActionSchema = z.strictObject({
  id: UuidSchema,
  workspaceId: UuidSchema,
  bookId: UuidSchema,
  actionType: z.literal('cash-dividend'),
  financialAccountId: UuidSchema,
  instrumentId: UuidSchema,
  evidenceId: UuidSchema,
  sourceRowId: UuidSchema,
  declaredOn: z.iso.date(),
  exDate: z.iso.date().nullable(),
  payableOn: z.iso.date(),
  sourceReference: z.string().min(1).max(500),
  reviewReason: z.string().min(1).max(2_000),
  cashLedgerAccountId: UuidSchema,
  dividendIncomeLedgerAccountId: UuidSchema,
  withholdingLedgerAccountId: UuidSchema,
  sourceRevision: z.number().int().positive().safe(),
  nextSourceRevision: z.number().int().positive().safe(),
  sourceSnapshotHash: Sha256Schema,
  idempotencyKey: z.string().min(1).max(200),
  commandHash: Sha256Schema,
  economicTransactionId: UuidSchema,
  journalId: UuidSchema,
  status: z.literal('committed'),
  createdBy: UuidSchema,
  createdAt: z.iso.datetime(),
  source: FinanceCashDividendSavedSourceSchema,
  gross: FinanceCashDividendSavedAmountSchema,
  withholding: FinanceCashDividendSavedAmountSchema,
  net: FinanceCashDividendSavedAmountSchema,
});
export type FinanceCashDividendSavedAction = z.infer<
  typeof FinanceCashDividendSavedActionSchema
>;

export const ListInvestmentCashDividendsSchema = z.strictObject({
  offset: z.number().int().min(0).max(1_000_000).default(0),
  limit: z.number().int().min(1).max(100).default(50),
});
export type ListInvestmentCashDividends = z.infer<
  typeof ListInvestmentCashDividendsSchema
>;

export const FinanceCashDividendListSchema = z.strictObject({
  actions: z.array(FinanceCashDividendSavedActionSchema).max(100),
  nextOffset: z.number().int().min(0).nullable(),
});
export type FinanceCashDividendList = z.infer<
  typeof FinanceCashDividendListSchema
>;

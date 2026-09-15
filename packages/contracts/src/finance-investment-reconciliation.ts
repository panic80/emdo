import { z } from 'zod';
import { UuidSchema } from './primitives.js';
import { FinanceDecimalSchema } from './finance-v2.js';

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Revision = z.number().int().positive();
export const PreviewInvestmentReconciliationSchema = z.strictObject({
  valuationRunId: UuidSchema,
  observedPositionId: UuidSchema,
});
export const CreateInvestmentReconciliationSchema =
  PreviewInvestmentReconciliationSchema.extend({
    expectedComparisonHash: Hash,
  });
export const InvestmentReconciliationCorrectiveRecordSchema = z.strictObject({
  kind: z.enum([
    'movement',
    'opening',
    'stock-split',
    'split-settlement',
    'cash-dividend',
  ]),
  id: UuidSchema,
});
export const InvestmentReconciliationResolutionSchema = z
  .strictObject({
    kind: z.enum(['corrective-records', 'reviewed-explanation']),
    explanation: z.string().trim().min(10).max(4000),
    evidenceIds: z
      .array(UuidSchema)
      .min(1)
      .max(20)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        'Evidence must be unique',
      ),
    correctiveRecords: z
      .array(InvestmentReconciliationCorrectiveRecordSchema)
      .max(20),
  })
  .refine(
    (v) =>
      v.kind === 'corrective-records'
        ? v.correctiveRecords.length > 0
        : v.correctiveRecords.length === 0,
    'Corrective resolution requires records; explanation resolution must not imply a correction',
  );
export const ResolveInvestmentReconciliationSchema = z.strictObject({
  expectedRevision: Revision,
  expectedComparisonHash: Hash,
  resolution: InvestmentReconciliationResolutionSchema,
});
export const ReopenInvestmentReconciliationSchema =
  CreateInvestmentReconciliationSchema.extend({
    expectedRevision: Revision,
    reason: z.string().trim().min(10).max(4000),
  });
export const InvestmentReconciliationComparisonSchema = z.strictObject({
  valuationRunId: UuidSchema,
  observedPositionId: UuidSchema,
  comparisonHash: Hash,
  valuationInputHash: Hash,
  financialAccountId: UuidSchema,
  instrumentId: UuidSchema,
  asOf: z.iso.date(),
  evidenceId: UuidSchema,
  sourceRow: z.number().int().positive(),
  observedQuantity: FinanceDecimalSchema,
  calculatedQuantity: FinanceDecimalSchema.nullable(),
  difference: FinanceDecimalSchema.nullable(),
  status: z.enum(['matched', 'difference', 'unavailable']),
  sourceSnapshot: z.record(z.string(), z.unknown()),
});
export const InvestmentReconciliationPreviewSchema = z.strictObject({
  workspaceId: UuidSchema,
  bookId: UuidSchema,
  comparison: InvestmentReconciliationComparisonSchema,
  sourcesCurrent: z.boolean(),
});
export const InvestmentReconciliationEventSchema = z.strictObject({
  revision: Revision,
  kind: z.enum(['created', 'resolved', 'reopened']),
  comparison: InvestmentReconciliationComparisonSchema,
  resolution: InvestmentReconciliationResolutionSchema.nullable(),
  evidenceSnapshots: z.array(z.record(z.string(), z.unknown())),
  correctiveRecordSnapshots: z.array(z.record(z.string(), z.unknown())),
  reason: z.string().nullable(),
  createdBy: UuidSchema,
  createdAt: z.iso.datetime(),
});
export const InvestmentReconciliationCaseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: UuidSchema,
  workspaceId: UuidSchema,
  bookId: UuidSchema,
  revision: Revision,
  status: z.enum(['open', 'resolved']),
  effectiveStatus: z.enum(['open', 'resolved', 'reopen-required']),
  sourcesCurrent: z.boolean(),
  comparison: InvestmentReconciliationComparisonSchema,
  history: z.array(InvestmentReconciliationEventSchema).min(1),
  accountingEffect: z.literal('none'),
});
export const InvestmentReconciliationListSchema = z.strictObject({
  items: z.array(InvestmentReconciliationCaseSchema),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(100),
  total: z.number().int().nonnegative(),
});
export type InvestmentReconciliationCase = z.infer<
  typeof InvestmentReconciliationCaseSchema
>;
export type InvestmentReconciliationComparison = z.infer<
  typeof InvestmentReconciliationComparisonSchema
>;

export const InvestmentReconciliationCorrectiveRecordListSchema =
  z.strictObject({
    items: z.array(
      InvestmentReconciliationCorrectiveRecordSchema.extend({
        label: z.string().min(1).max(300),
        effectiveOn: z.iso.date(),
        evidenceIds: z.array(UuidSchema),
      }),
    ),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(100),
    total: z.number().int().nonnegative(),
  });

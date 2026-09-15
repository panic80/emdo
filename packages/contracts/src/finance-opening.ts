import { z } from 'zod';
import { UuidSchema, Sha256Schema } from './primitives.js';
export const FinanceLegacyOpeningPostRequestSchema = z.strictObject({
  expectedRunRevision: z.number().int().positive(),
  expectedRecordRevision: z.number().int().positive(),
  expectedSourceSnapshotHash: Sha256Schema,
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
});
export const FinanceOpeningProofSchema = z.strictObject({
  id: UuidSchema,
  workspaceId: UuidSchema,
  bookId: UuidSchema,
  financialAccountId: UuidSchema,
  sourceSpaceId: UuidSchema,
  sourceOwnerUserId: UuidSchema,
  sourceKind: z.literal('legacy-migration'),
  migrationId: UuidSchema,
  sourceRecordId: UuidSchema,
  sourceRevision: z.number().int().positive(),
  sourceSnapshotHash: Sha256Schema,
  reviewId: UuidSchema,
  evidenceId: UuidSchema,
  evidenceDigest: Sha256Schema,
  effectiveOn: z.iso.date(),
  amountCadMinor: z.string().regex(/^-?[1-9][0-9]*$/u),
  ledgerAccountId: UuidSchema,
  counterpartLedgerAccountId: UuidSchema,
  journalId: UuidSchema,
  postedBy: UuidSchema,
  postedAt: z.iso.datetime({ offset: true }),
  supersedesProofId: UuidSchema.nullable(),
});
export type FinanceLegacyOpeningPostRequest = z.infer<
  typeof FinanceLegacyOpeningPostRequestSchema
>;
export type FinanceOpeningProof = z.infer<typeof FinanceOpeningProofSchema>;

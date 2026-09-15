import { z } from 'zod';
import { UuidSchema } from './primitives.js';
import { FinanceTaxScopeSchema, FinanceTaxValueSchema } from './finance-tax.js';
import {
  FinanceTaxQuestionCategorySchema,
  FinanceTaxRelatedPartySchema,
} from './finance-tax-questionnaire.js';

/** Browser-safe request contracts for /api/v2/finance/tax/cases. Identity and grants come from trusted services. */
const Text = z.string().trim().min(1).max(200),
  Revision = z.number().int().positive().max(2147483647);
const Key = z.string().min(1).max(160);
const ExplicitPackageTaxCaseSchema = z.strictObject({
  title: Text,
  taxSubjectName: Text,
  legalEntityId: UuidSchema.nullable().optional(),
  scope: FinanceTaxScopeSchema,
  domesticResident: z.boolean().nullable(),
  hasCrossBorderActivity: z.boolean().nullable(),
  standaloneCorporation: z.boolean().nullable(),
  packageId: Text,
  packageVersion: Text,
  relatedParties: z.array(FinanceTaxRelatedPartySchema).max(1000),
});
/** Intake-only captures private inputs without claiming any available return package. */
export const CreatePrivateTaxCaseSchema = z.union([
  ExplicitPackageTaxCaseSchema,
  ExplicitPackageTaxCaseSchema.omit({
    packageId: true,
    packageVersion: true,
  }).extend({ mode: z.literal('intake-only') }),
]);
export const RecordPrivateTaxDeclarationSchema = z.strictObject({
  expectedCaseRevision: Revision,
  sourceId: UuidSchema.optional(),
  expectedSourceRevision: Revision.nullable(),
  factKey: Key,
  category: FinanceTaxQuestionCategorySchema,
  value: FinanceTaxValueSchema,
});
export const BindPrivateTaxLegalEntitySchema = z.strictObject({
  expectedCaseRevision: Revision,
  legalEntityId: UuidSchema,
});
export const SavePrivateTaxAnswerSchema = z.strictObject({
  expectedCaseRevision: Revision,
  expectedAnswerRevision: Revision.nullable(),
  sourceId: UuidSchema,
  expectedSourceRevision: Revision,
  relatedPartyId: UuidSchema.nullable(),
});
export const ReviewPrivateTaxAnswerSchema = z.strictObject({
  expectedCaseRevision: Revision,
  expectedAnswerRevision: Revision,
  factKey: Key,
  decision: z.enum(['reviewed', 'disputed']),
});
export const WithdrawPrivateTaxAnswerSchema = ReviewPrivateTaxAnswerSchema.omit(
  { decision: true },
);
export const GrantPrivateTaxCaseSchema = z.strictObject({
  userId: UuidSchema,
  role: z.enum(['preparer', 'reviewer', 'viewer']),
  expectedGrantRevision: Revision.nullable(),
});
export const RevokePrivateTaxCaseGrantSchema = z.strictObject({
  userId: UuidSchema,
  expectedGrantRevision: Revision,
});
export const AuthorizePrivateTaxBookSourceSchema = z.strictObject({
  bookId: UuidSchema,
  expectedCaseRevision: Revision,
});
export const ResetPrivateTaxInputsSchema = z.strictObject({
  expectedCaseRevision: Revision,
});

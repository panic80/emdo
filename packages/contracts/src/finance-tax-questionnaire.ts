import { z } from 'zod';
import { UuidSchema } from './primitives.js';
import {
  FinanceTaxFactSchema,
  FinanceTaxIntakeSchema,
  FinanceTaxPackageManifestSchema,
  FinanceTaxScopeSchema,
  FinanceTaxValueSchema,
} from './finance-tax.js';

const Text = z.string().trim().min(1).max(1000);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Revision = z.number().int().positive();
export const FinanceTaxQuestionCategorySchema = z.enum([
  'residency',
  'dependants',
  'elections',
  'prior-balances',
  'income',
  'deductions',
  'general',
]);
export const FinanceTaxDeclarationSourceBindingSchema = z.strictObject({
  sourceId: UuidSchema,
  sourceRevision: Revision,
  contentHash: Hash,
});
export const FinanceTaxDeclaredInputSchema =
  FinanceTaxDeclarationSourceBindingSchema.extend({
    factKey: Text,
    category: FinanceTaxQuestionCategorySchema,
    value: FinanceTaxValueSchema,
    reviewState: z.literal('unreviewed'),
  });
export const FinanceTaxDeclarationBindingStatusSchema = z.enum([
  'bound',
  'legacy-unbound',
]);
export const FinanceTaxQuestionMetadataSchema = z.strictObject({
  factKey: Text,
  category: FinanceTaxQuestionCategorySchema,
  label: Text,
});
export const FinanceTaxRelatedPartySchema = z.strictObject({
  id: UuidSchema,
  relationship: z.enum(['dependant', 'spouse', 'other']),
  displayName: Text,
});
const Identity = z.strictObject({
  caseId: UuidSchema,
  workspaceId: UuidSchema,
  taxSubjectId: UuidSchema,
});
const Source = FinanceTaxFactSchema.shape.source;
/** Supplied only by trusted persistence after authorization; a caller cannot grant itself access. */
export const FinanceTaxQuestionnaireAccessSchema = Identity.extend({
  actorId: UuidSchema,
  bookAuthorizations: z
    .array(
      z.strictObject({
        authorizationId: UuidSchema,
        authorizationRevision: Revision,
        bookId: UuidSchema,
        snapshotRevision: Revision,
        snapshotHash: Hash,
      }),
    )
    .max(100),
  availableSources: z.array(Source).max(10000),
});
export const FinanceTaxQuestionnaireAnswerSchema = Identity.extend({
  fact: FinanceTaxFactSchema,
  revision: Revision,
  relatedPartyId: UuidSchema.nullable(),
  updatedAt: z.iso.datetime(),
  previousRevisionHash: Hash.nullable(),
  review: z
    .strictObject({
      actorId: UuidSchema,
      reviewedAt: z.iso.datetime(),
      reviewedAnswerRevision: Revision,
    })
    .nullable(),
});
/** Reserved non-executable binding. Moving to a released package requires a new explicit binding/case. */
export const FINANCE_TAX_INTAKE_ONLY_BINDING = Object.freeze({
  packageId: 'emdo.intake-only',
  packageVersion: '1',
  mode: 'intake-only',
  enabled: false,
} as const);
export const FinanceTaxQuestionnaireBindingSchema = z.strictObject({
  mode: z.literal('intake-only').optional(),
  enabled: z.literal(false).optional(),
  packageId: Text,
  packageVersion: Text,
  scope: FinanceTaxScopeSchema,
  manifest: FinanceTaxPackageManifestSchema.nullable(),
  manifestHash: Hash.nullable(),
});
export const FinanceTaxQuestionnaireSchema = z.strictObject({
  schemaVersion: z.literal(1),
  visibility: z.literal('private'),
  /** Optional without a default: old snapshot hashes must not gain inferred source bindings. */
  declarationSourceBindings: z
    .array(FinanceTaxDeclarationSourceBindingSchema)
    .max(10000)
    .optional(),
  /** Existing intake envelope remains canonical; facts are materialized exclusively from bound answers. */
  intake: FinanceTaxIntakeSchema,
  binding: FinanceTaxQuestionnaireBindingSchema,
  questions: z.array(FinanceTaxQuestionMetadataSchema).max(10000),
  relatedParties: z.array(FinanceTaxRelatedPartySchema).max(1000),
  answers: z.array(FinanceTaxQuestionnaireAnswerSchema).max(10000),
  withdrawnAnswers: z
    .array(
      z.strictObject({
        answer: FinanceTaxQuestionnaireAnswerSchema,
        withdrawnAt: z.iso.datetime(),
        actorId: UuidSchema,
      }),
    )
    .max(10000),
  sourceAuthorizationBindings:
    FinanceTaxQuestionnaireAccessSchema.shape.bookAuthorizations,
});
export const FinanceTaxCreateQuestionnaireSchema = z.strictObject({
  intake: FinanceTaxIntakeSchema,
  packageId: Text,
  packageVersion: Text,
  questionMetadata: z.array(FinanceTaxQuestionMetadataSchema).max(10000),
  relatedParties: z.array(FinanceTaxRelatedPartySchema).max(1000),
});
export const FinanceTaxSaveQuestionnaireAnswerSchema = Identity.extend({
  expectedCaseRevision: Revision,
  expectedAnswerRevision: Revision.nullable(),
  fact: FinanceTaxFactSchema,
  relatedPartyId: UuidSchema.nullable(),
  updatedAt: z.iso.datetime(),
});
export const FinanceTaxReviewQuestionnaireAnswerSchema = Identity.extend({
  expectedCaseRevision: Revision,
  factKey: Text,
  expectedAnswerRevision: Revision,
  decision: z.enum(['reviewed', 'disputed']),
  reviewedAt: z.iso.datetime(),
});
export const FinanceTaxWithdrawQuestionnaireAnswerSchema = Identity.extend({
  expectedCaseRevision: Revision,
  factKey: Text,
  expectedAnswerRevision: Revision,
  withdrawnAt: z.iso.datetime(),
});
export type FinanceTaxQuestionnaire = z.infer<
  typeof FinanceTaxQuestionnaireSchema
>;
export type FinanceTaxQuestionnaireAccess = z.infer<
  typeof FinanceTaxQuestionnaireAccessSchema
>;
export type FinanceTaxQuestionnaireAnswer = z.infer<
  typeof FinanceTaxQuestionnaireAnswerSchema
>;

export type FinanceTaxDeclaredInput = z.infer<
  typeof FinanceTaxDeclaredInputSchema
>;
export type FinanceTaxDeclarationSourceBinding = z.infer<
  typeof FinanceTaxDeclarationSourceBindingSchema
>;

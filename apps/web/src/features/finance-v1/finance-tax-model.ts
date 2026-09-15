import { z } from 'zod';
import {
  UuidSchema,
  FinanceTaxQuestionnaireSchema,
  FinanceTaxQuestionCategorySchema,
  FinanceTaxQuestionMetadataSchema,
  FinanceTaxIntakeSchema,
  FinanceTaxValueSchema,
  FinanceTaxDeclaredInputSchema,
  FinanceTaxDeclarationBindingStatusSchema,
} from '@emdo/contracts/browser';

const Revision = z.number().int().positive();
const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const TaxCaseRoleSchema = z.enum([
  'owner',
  'preparer',
  'reviewer',
  'viewer',
]);
export const TaxCaseSummarySchema = z.object({
  caseId: UuidSchema,
  taxSubjectId: UuidSchema,
  title: z.string(),
  taxSubjectName: z.string(),
  revision: Revision,
  status: z.literal('incomplete'),
  caseRole: TaxCaseRoleSchema,
});
export const TaxCaseListSchema = z.object({
  cases: z.array(TaxCaseSummarySchema).max(100),
});
export const TaxCaseDetailSchema = z.object({
  caseId: UuidSchema,
  taxSubjectId: UuidSchema,
  currentRevision: Revision,
  snapshotHash: Hash,
  status: z.literal('incomplete'),
  caseRole: TaxCaseRoleSchema,
  questionnaire: FinanceTaxQuestionnaireSchema,
  declaredInputs: z.array(FinanceTaxDeclaredInputSchema).max(10000),
  declarationBindingStatus: FinanceTaxDeclarationBindingStatusSchema,
});
export const TaxDeclarationSchema = z.object({
  sourceId: UuidSchema,
  sourceRevision: Revision,
  factKey: z.string(),
  category: FinanceTaxQuestionCategorySchema,
  value: FinanceTaxValueSchema,
  contentHash: Hash,
});
export const TaxDeclarationsSchema = z.array(TaxDeclarationSchema).max(10000);
export const TaxAssessmentSchema = z.object({
  caseId: UuidSchema,
  taxSubjectId: UuidSchema,
  snapshotRevision: Revision,
  snapshotHash: Hash,
  status: z.enum(['incomplete', 'ready-for-calculation']),
  complete: z.literal(false),
  intake: FinanceTaxIntakeSchema.nullable(),
  issues: z
    .array(
      z.object({ code: z.string(), path: z.string(), message: z.string() }),
    )
    .max(10000),
  questions: z
    .array(
      FinanceTaxQuestionMetadataSchema.extend({
        applicability: z
          .enum(['required', 'undetermined', 'not-applicable'])
          .optional(),
        answerRevision: Revision.nullable().optional(),
      }),
    )
    .max(10000),
});
export const TaxGrantsSchema = z
  .array(
    z.object({
      userId: UuidSchema,
      role: TaxCaseRoleSchema,
      revision: Revision,
      revokedAt: z.iso.datetime().nullable(),
      status: z.enum(['active', 'revoked']),
    }),
  )
  .max(10000);
export const TaxMutationSchema = z.object({
  caseId: UuidSchema,
  taxSubjectId: UuidSchema,
  revision: Revision,
  snapshotHash: Hash,
  status: z.literal('incomplete'),
});
export const TaxBooksSchema = z.object({
  books: z
    .array(
      z.object({
        id: UuidSchema,
        name: z.string(),
        entityName: z.string(),
        legalEntityId: UuidSchema.optional(),
        functionalCurrency: z.string(),
      }),
    )
    .max(10000),
});
export const TaxMembersSchema = z.object({
  schemaVersion: z.literal(1),
  memberships: z
    .array(
      z.object({
        userId: UuidSchema,
        email: z.string().email(),
        status: z.enum(['active', 'inactive']),
      }),
    )
    .max(1000),
});
export type TaxCaseSummary = z.infer<typeof TaxCaseSummarySchema>;
export type TaxCaseDetail = z.infer<typeof TaxCaseDetailSchema>;
export type TaxDeclaration = z.infer<typeof TaxDeclarationSchema>;
export type TaxAssessment = z.infer<typeof TaxAssessmentSchema>;
export type TaxGrant = z.infer<typeof TaxGrantsSchema>[number];
export type TaxBook = z.infer<typeof TaxBooksSchema>['books'][number];

export const taxCountries = [
  ['CA', 'Canada'],
  ['US', 'United States'],
  ['MX', 'Mexico'],
  ['DE', 'Germany'],
  ['KR', 'South Korea'],
  ['JP', 'Japan'],
  ['FR', 'France'],
] as const;
export const taxCountryName = (code?: string) =>
  taxCountries.find(([id]) => id === code)?.[1] ?? code ?? 'Not specified';
export const taxValueText = (value: z.infer<typeof FinanceTaxValueSchema>) =>
  value.type === 'boolean' ? (value.value ? 'Yes' : 'No') : value.value;
export const taxTriState = (value: boolean | null) =>
  value === null ? 'Not established' : value ? 'Yes' : 'No';
export const taxCategoryLabels: Record<
  z.infer<typeof FinanceTaxQuestionCategorySchema>,
  string
> = {
  residency: 'Residency',
  dependants: 'Dependants & family',
  elections: 'Elections',
  'prior-balances': 'Prior balances',
  income: 'Income',
  deductions: 'Deductions',
  general: 'General',
};
export const taxRoleDescriptions = {
  owner: 'Manage case access, source books and inputs; review answers.',
  preparer: 'Save declarations and prepare answers for this case.',
  reviewer: 'Read the case and review or dispute saved answers.',
  viewer: 'Read this case and its saved inputs.',
} as const;

export function verifyTaxCase(
  rawDetail: unknown,
  rawDeclarations: unknown,
  rawAssessment: unknown,
  expectedCaseId: string,
) {
  const detail = TaxCaseDetailSchema.parse(rawDetail),
    declarations = TaxDeclarationsSchema.parse(rawDeclarations),
    assessment = TaxAssessmentSchema.parse(rawAssessment);
  if (
    detail.caseId !== expectedCaseId ||
    detail.questionnaire.intake.caseId !== expectedCaseId ||
    detail.questionnaire.intake.taxSubjectId !== detail.taxSubjectId ||
    detail.questionnaire.intake.revision !== detail.currentRevision ||
    assessment.caseId !== expectedCaseId ||
    assessment.taxSubjectId !== detail.taxSubjectId ||
    assessment.snapshotRevision !== detail.currentRevision ||
    assessment.snapshotHash !== detail.snapshotHash
  )
    throw new Error(
      'The case changed while it was loading. Refresh to review one current version.',
    );
  if (
    new Set(declarations.map((item) => item.sourceId)).size !==
    declarations.length
  )
    throw new Error('The declaration source versions could not be verified.');
  const bindings = detail.questionnaire.declarationSourceBindings;
  if (detail.declarationBindingStatus === 'legacy-unbound') {
    if (bindings !== undefined || detail.declaredInputs.length)
      throw new Error('Legacy declaration bindings could not be verified.');
  } else if (
    !bindings ||
    bindings.length !== detail.declaredInputs.length ||
    new Set(bindings.map((item) => item.sourceId)).size !== bindings.length ||
    new Set(detail.declaredInputs.map((item) => item.sourceId)).size !==
      detail.declaredInputs.length ||
    detail.declaredInputs.some(
      (input) =>
        !bindings.some(
          (binding) =>
            binding.sourceId === input.sourceId &&
            binding.sourceRevision === input.sourceRevision &&
            binding.contentHash === input.contentHash,
        ),
    )
  ) {
    throw new Error(
      'Saved declarations do not match this questionnaire revision. Refresh to verify the current inputs.',
    );
  }
  const sources = detail.questionnaire.sourceAuthorizationBindings;
  if (
    sources.length !== detail.questionnaire.intake.sourceBooks.length ||
    new Set(sources.map((source) => source.bookId)).size !== sources.length ||
    new Set(sources.map((source) => source.authorizationId)).size !==
      sources.length ||
    sources.some(
      (source) =>
        !detail.questionnaire.intake.sourceBooks.some(
          (book) =>
            book.bookId === source.bookId &&
            book.snapshotRevision === source.snapshotRevision &&
            book.snapshotHash === source.snapshotHash,
        ),
    )
  )
    throw new Error(
      'Source book permissions do not match this questionnaire revision.',
    );
  return { detail, declarations, assessment };
}

export class TaxRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function readTaxJson(
  path: string,
  signal: AbortSignal,
  init: RequestInit = {},
) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...init,
    signal,
  });
  if (!response.ok) {
    const raw: unknown = await response.json().catch(() => null);
    const problem = z.object({ code: z.string().optional() }).safeParse(raw);
    const code = problem.success ? (problem.data.code ?? '') : '';
    throw new TaxRequestError(
      response.status,
      code,
      response.status === 401
        ? 'Sign in again to access private tax cases.'
        : response.status === 403
          ? 'Current case or source access does not permit this action.'
          : response.status === 503
            ? 'Private tax preparation is not available right now.'
            : response.status === 409
              ? 'The case or source changed. Refresh and review the current version before continuing.'
              : response.status === 404
                ? 'This tax case is no longer available.'
                : 'Unable to save or load this tax information. Check the values and try again.',
    );
  }
  const result: unknown = await response.json();
  if (signal.aborted) throw new DOMException('Request aborted', 'AbortError');
  return result;
}

/** Receipts stay in component memory and survive only an uncertain retry. */
export function taxMutationRequest() {
  let pending: { path: string; body: string; key: string } | undefined;
  return async <T>(
    path: string,
    input: unknown,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    csrfToken?: string,
  ) => {
    if (!csrfToken)
      throw new Error('Sign in again before saving tax information.');
    if (signal.aborted) throw new DOMException('Request aborted', 'AbortError');
    const body = JSON.stringify(input);
    if (pending?.path !== path || pending.body !== body)
      pending = { path, body, key: crypto.randomUUID() };
    const result = schema.parse(
      await readTaxJson(path, signal, {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrfToken,
          'idempotency-key': pending.key,
        },
      }),
    );
    pending = undefined;
    return result;
  };
}

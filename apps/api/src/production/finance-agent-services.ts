import { FinanceFecMappingResponseSchema } from '../routes/finance-fec.js';
import { inspectFinanceOfxSource } from './finance-ofx-inspection.js';
import {
  planningReadViews,
  readFinancePlanning,
  type FinancePlanningReadPort,
} from './finance-planning-read.js';
import {
  FinanceAutomationJournalDraftResultSchema,
  InvestmentReconciliationCaseSchema,
  InvestmentReconciliationListSchema,
  FinanceTaxReadInputSchema,
  FinanceTaxReadOutputSchema,
  FinanceTaxQuestionnaireSchema,
  FinanceTaxDeclaredInputSchema,
  FinanceTaxDeclarationBindingStatusSchema,
  FinanceTaxCalculationRunSummarySchema,
  FinanceTaxCalculationRunDetailSchema,
  FinanceStandardizationRunSchema,
  FinanceStandardizationListSchema,
  FinanceStandardizationReconciliationSchema,
  FinanceCashDividendSavedActionSchema,
  FinanceCashDividendListSchema,
  SavedFinanceStockSplitSettlementSchema,
  FinanceImageInspectionSchema,
  FinancePdfOcrInspectionSchema,
} from '@emdo/contracts';
import { createHash } from 'node:crypto';
import {
  AgentInvocationContextSchema,
  FinanceGeneratedReportSchema,
  FinanceNormalizedImportPostingSchema,
  FinanceNormalizedAmountComponentViewSchema,
  FinanceAutomationRunRecordSchema,
  FinanceAutomationScheduleSchema,
  FinanceAutomationScheduleCursorSchema,
  FinanceGeneratedReportSummarySchema,
  GuardedActionPermitSchema,
  IsoDateTimeSchema,
  OpaqueReferenceSchema,
  Sha256Schema,
  UuidSchema,
  deepFreeze,
  type CapabilityInvocationContext,
  type GuardedActionPermit,
} from '@emdo/contracts';
import { financeCapabilityReferences } from '@emdo/agent-finance';
import {
  extractFinanceCsvTable,
  applyTransactionLedgerOperation,
  validateFinanceRecord,
  type FinanceBudgetRecord,
  type FinanceRecord,
  type FinanceTransactionRecord,
} from '@emdo/domains/finance';
import { hashCanonicalJson } from '@emdo/toolbox';
import {
  extractFinanceXlsxTables,
  extractFinancePdfReport,
} from '@emdo/integrations/finance-documents';
import { z } from 'zod';

import {
  materializeFinanceRecordCreate,
  type TrustedFinanceSpecialistServices,
} from '../agents/specialist-capability-adapters.js';
import {
  AuthenticatedPrincipalSchema,
  FinanceImportCommitResponseSchema,
} from '../schemas.js';
import type { AuthenticatedPrincipal } from '../services/contracts.js';

type FinanceReadRequest = Parameters<
  TrustedFinanceSpecialistServices['readFinanceRecords']
>[0];
type FinanceWriteMutation = Parameters<
  TrustedFinanceSpecialistServices['writeFinanceRecord']
>[0];
type FinanceStatementImportRequest = Parameters<
  TrustedFinanceSpecialistServices['executeStatementImport']
>[0];
type FinanceBudgetRequest = Parameters<
  TrustedFinanceSpecialistServices['loadFinanceBudgetInputs']
>[0];
type FinanceDocumentSearchRequest = Parameters<
  TrustedFinanceSpecialistServices['searchFinanceDocuments']
>[0];
type FinanceDocumentReadRequest = Parameters<
  TrustedFinanceSpecialistServices['readFinanceDocument']
>[0];
type FinanceMatchReadRequest = Parameters<
  TrustedFinanceSpecialistServices['readFinanceMatches']
>[0];

const FinancePrincipalSchema = AuthenticatedPrincipalSchema.extend({
  privateSpaceId: UuidSchema,
});

const AbortSignalSchema = z.custom<AbortSignal>(
  (value) =>
    value !== null &&
    typeof value === 'object' &&
    typeof (value as AbortSignal).aborted === 'boolean',
);

const FinanceInvocationContextSchema = z.strictObject({
  requestId: UuidSchema,
  runId: UuidSchema,
  userId: UuidSchema,
  householdId: UuidSchema,
  sessionId: UuidSchema,
  agentId: z.literal('finance'),
  invocationContext: AgentInvocationContextSchema,
  spaceAccessGrantId: OpaqueReferenceSchema,
  locale: z.enum(['en-CA', 'fr-CA', 'ja-JP', 'ko-KR']),
  disclosureGrantId: UuidSchema.optional(),
  approvalDecisionId: UuidSchema.optional(),
  guardedActionPermit: GuardedActionPermitSchema.optional(),
  abortSignal: AbortSignalSchema,
});

const FINANCE_REGISTERED_CAPABILITY_IDS = Object.freeze(
  financeCapabilityReferences.map(({ id }) => id).sort(),
);

const FinanceRecordTypeSchema = z.enum([
  'account',
  'transaction',
  'category',
  'budget',
  'bill',
  'subscription',
  'goal',
]);
type FinanceRecordType = z.output<typeof FinanceRecordTypeSchema>;

const FinanceDocumentTypeSchema = z.enum([
  'receipt',
  'invoice',
  'bank-statement',
  'credit-statement',
  'pay-stub',
  'tax-slip',
  'insurance',
  'loan',
  'investment-statement',
  'other',
]);
type FinanceDocumentType = z.output<typeof FinanceDocumentTypeSchema>;

const FinanceDocumentEvidenceSchema = z.strictObject({
  evidenceId: OpaqueReferenceSchema,
  documentId: OpaqueReferenceSchema,
  documentType: FinanceDocumentTypeSchema,
  displayName: z.string().trim().min(1).max(255),
  page: z.number().int().min(1).max(250),
  excerpt: z.string().trim().min(1).max(2_000),
  sourceLocale: z.enum(['en-CA', 'fr-CA', 'ja-JP', 'ko-KR']),
});
const FinanceDocumentSearchHitSchema = z.strictObject({
  documentId: OpaqueReferenceSchema,
  documentType: FinanceDocumentTypeSchema,
  displayName: z.string().trim().min(1).max(255),
  occurredOn: z.iso.date().nullable(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/u)
    .nullable(),
  amountMinor: z.number().int().safe().nullable(),
  score: z.number().min(0).max(1),
  evidence: z.array(FinanceDocumentEvidenceSchema).min(1).max(8),
});
type FinanceDocumentSearchHit = z.output<typeof FinanceDocumentSearchHitSchema>;

const FinanceDocumentReadResultSchema = z.strictObject({
  document: z.strictObject({
    id: OpaqueReferenceSchema,
    documentType: FinanceDocumentTypeSchema,
    displayName: z.string().trim().min(1).max(255),
    sourceLocale: z.enum(['en-CA', 'fr-CA', 'ja-JP', 'ko-KR']),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/u)
      .nullable(),
    summary: z.string().trim().min(1).max(4_000),
    committedAt: IsoDateTimeSchema,
  }),
  evidence: z.array(FinanceDocumentEvidenceSchema).max(32),
});
type FinanceDocumentReadResult = z.output<
  typeof FinanceDocumentReadResultSchema
>;

const FinanceDocumentMatchSchema = z.strictObject({
  matchId: OpaqueReferenceSchema,
  documentId: OpaqueReferenceSchema,
  recordId: OpaqueReferenceSchema,
  recordType: FinanceRecordTypeSchema,
  state: z.enum(['suggested', 'accepted', 'rejected']),
  score: z.number().min(0).max(1),
  reasons: z.array(z.string().trim().min(1).max(200)).min(1).max(8),
});
type FinanceDocumentMatch = z.output<typeof FinanceDocumentMatchSchema>;

const FinanceRecordSummarySchema = z.strictObject({
  id: OpaqueReferenceSchema,
  recordType: FinanceRecordTypeSchema,
  label: z.string().trim().min(1).max(2_000),
  currency: z.literal('CAD').nullable(),
  amountCadMinor: z.number().int().safe().nullable(),
  effectiveOn: z.iso.date().nullable(),
  status: z.string().trim().min(1).max(100).nullable(),
  revision: z.number().int().safe().nonnegative().nullable(),
  updatedAt: IsoDateTimeSchema,
});
type FinanceRecordSummary = z.output<typeof FinanceRecordSummarySchema>;

export interface FinanceCapabilityScope {
  readonly requestId: string;
  readonly runId: string;
  readonly userId: string;
  readonly householdId: string;
  readonly sessionId: string;
  readonly privateSpaceId: string;
  readonly spaceAccessGrantId: string;
  readonly agentInvocationId: string;
  readonly phaseInvocationId: string;
  readonly invocationIdempotencyScope: string;
  readonly collectionAuthorizationScopeFingerprint: string;
  readonly disclosureGrantId?: string;
  readonly abortSignal: AbortSignal;
}

/**
 * The model can name only the opaque target for these operations.  The
 * document port resolves every revision, review payload, original hash, and
 * match binding under the current owner scope; none of that material is ever
 * included in capability arguments.
 */
export type FinanceDocumentGuardedActionOperation =
  | 'finance-document-review-commit'
  | 'finance-document-match-accept'
  | 'finance-document-delete';

export type FinanceDocumentGuardedActionIntent =
  | Readonly<{
      readonly kind: 'commit-document-review';
      readonly documentId: string;
    }>
  | Readonly<{
      readonly kind: 'accept-document-match';
      readonly matchId: string;
    }>
  | Readonly<{ readonly kind: 'delete-document'; readonly documentId: string }>;

/** Content-free material persisted only through the shared proposal binding. */
export interface FinanceDocumentGuardedActionTarget {
  readonly targetBindingHash: string;
  readonly preview: Readonly<{
    readonly documentId: string;
    readonly beforeState: string;
    readonly afterState: string;
    readonly extractionRevision: number | null;
    readonly matchId?: string;
  }>;
}

export type FinanceDocumentGuardedActionExecutionResult =
  | Readonly<{
      readonly status: 'document-committed';
      readonly documentId: string;
      readonly extractionRevision: number;
    }>
  | Readonly<{
      readonly status: 'match-accepted';
      readonly documentId: string;
      readonly matchId: string;
    }>
  | Readonly<{
      readonly status: 'document-deleted' | 'document-purge-pending';
      readonly documentId: string;
    }>;

/**
 * A request-scoped, owner-bound bridge to the document gateway.  It is not a
 * registered capability and never crosses the model boundary.
 */
export interface FinanceDocumentGuardedActionPort {
  materializeTarget(input: {
    readonly scope: FinanceCapabilityScope;
    readonly operation: FinanceDocumentGuardedActionOperation;
    readonly intent: FinanceDocumentGuardedActionIntent;
  }): Promise<FinanceDocumentGuardedActionTarget>;
  executeApproved(input: {
    readonly scope: FinanceCapabilityScope;
    readonly operation: FinanceDocumentGuardedActionOperation;
    readonly intent: FinanceDocumentGuardedActionIntent;
    readonly permit: GuardedActionPermit;
    readonly capabilityFingerprint: string;
    readonly approvalDecisionId: string | undefined;
  }): Promise<FinanceDocumentGuardedActionExecutionResult>;
}

type FinanceSafeWriteOperation =
  | 'manual-transaction-create'
  | 'transaction-nondestructive-patch'
  | 'monthly-category-budget-create'
  | 'monthly-category-budget-update'
  | 'finance-transaction-adjustment'
  | 'finance-transaction-reversal';

export interface FinanceWriteAuditDescriptor {
  readonly eventType: 'finance.agent.safe-write';
  readonly operation: FinanceSafeWriteOperation;
  readonly canonicalHash: string;
  readonly requestId: string;
  readonly runId: string;
}

export interface FinanceDurableWriteCommand {
  readonly scope: FinanceCapabilityScope;
  readonly idempotencyKey: string;
  readonly canonicalHash: string;
  readonly audit: FinanceWriteAuditDescriptor;
}

/**
 * Each write method must atomically re-check this scope, persist its
 * idempotency receipt and canonical record, and append the supplied audit
 * descriptor. This leaf deliberately exposes neither a pool nor a provider.
 */
export interface FinanceSpecialistRecordPort {
  list(input: {
    readonly scope: FinanceCapabilityScope;
    readonly recordTypes?: readonly FinanceRecordType[];
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<
    Readonly<{
      readonly records: readonly FinanceRecord[];
      readonly nextCursor: string | null;
    }>
  >;
  getOwnedRecord(input: {
    readonly scope: FinanceCapabilityScope;
    readonly recordId: string;
  }): Promise<FinanceRecord | undefined>;
  getOwnedBudgetForMonth(input: {
    readonly scope: FinanceCapabilityScope;
    readonly month: string;
  }): Promise<FinanceBudgetRecord | undefined>;
  listBudgetTransactions(input: {
    readonly scope: FinanceCapabilityScope;
    readonly month: string;
    /** Document-derived values must be from committed review only. */
    readonly reviewedCommittedEvidenceOnly: true;
  }): Promise<readonly FinanceTransactionRecord[]>;
  createManualTransaction(
    input: FinanceDurableWriteCommand & {
      readonly record: FinanceTransactionRecord;
    },
  ): Promise<FinanceDurableWriteReceipt>;
  patchOwnedTransaction(
    input: FinanceDurableWriteCommand & {
      readonly current: FinanceTransactionRecord;
      readonly record: FinanceTransactionRecord;
      readonly expectedRevision: number;
    },
  ): Promise<FinanceDurableWriteReceipt>;
  applyTransactionAdjustment(
    input: FinanceDurableWriteCommand & {
      readonly current: FinanceTransactionRecord;
      readonly record: FinanceTransactionRecord;
      readonly expectedRevision: number;
      readonly operationId: string;
      readonly amountCadMinor: number;
      readonly reason: string;
    },
  ): Promise<FinanceDurableWriteReceipt>;
  applyTransactionReversal(
    input: FinanceDurableWriteCommand & {
      readonly current: FinanceTransactionRecord;
      readonly record: FinanceTransactionRecord;
      readonly expectedRevision: number;
      readonly operationId: string;
      readonly reason: string;
    },
  ): Promise<FinanceDurableWriteReceipt>;
  createMonthlyCategoryBudget(
    input: FinanceDurableWriteCommand & {
      readonly record: FinanceBudgetRecord;
    },
  ): Promise<FinanceDurableWriteReceipt>;
  updateMonthlyCategoryBudget(
    input: FinanceDurableWriteCommand & {
      readonly current: FinanceBudgetRecord;
      readonly record: FinanceBudgetRecord;
      readonly expectedRevision: number;
    },
  ): Promise<FinanceDurableWriteReceipt>;
}

export interface FinanceDurableWriteReceipt {
  readonly status: 'applied' | 'duplicate';
  readonly record: FinanceRecord;
  readonly auditEventId: string;
}

/** Every method is owner-scoped and excludes unreviewed document extraction. */
export interface FinanceSpecialistDocumentPort {
  searchCommitted(input: {
    readonly scope: FinanceCapabilityScope;
    readonly query: string;
    readonly documentTypes?: readonly FinanceDocumentType[];
    readonly from?: string;
    readonly to?: string;
    readonly limit: number;
  }): Promise<readonly FinanceDocumentSearchHit[]>;
  readCommitted(input: {
    readonly scope: FinanceCapabilityScope;
    readonly documentId: string;
    readonly evidenceIds: readonly string[];
  }): Promise<FinanceDocumentReadResult | undefined>;
  listCommittedMatches(input: {
    readonly scope: FinanceCapabilityScope;
    readonly documentId: string;
    readonly states?: readonly ('suggested' | 'accepted' | 'rejected')[];
    readonly limit: number;
  }): Promise<readonly FinanceDocumentMatch[]>;
}

export interface RequestScopedFinanceSpecialistServiceDependencies {
  readonly fec?: Pick<
    NonNullable<import('../services/contracts.js').ApiServices['financeFec']>,
    'getLatest' | 'checkReady'
  >;
  readonly planning?: FinancePlanningReadPort;
  readonly pdfOcrInspection?: Pick<
    import('@emdo/db/api').PostgresFinanceV2Repository,
    'readPdfOcrInspection'
  >;
  readonly imageInspection?: Pick<
    import('@emdo/db/api').PostgresFinanceV2Repository,
    'readImageInspection'
  >;
  readonly cashDividends?: Pick<
    import('@emdo/db/api').PostgresFinanceV2Repository,
    'listInvestmentCashDividends' | 'getInvestmentCashDividend'
  >;
  readonly standardizationRuns?: Pick<
    NonNullable<
      import('../services/contracts.js').ApiServices['financeStandardization']
    >,
    'list' | 'get'
  > &
    Partial<
      Pick<
        NonNullable<
          import('../services/contracts.js').ApiServices['financeStandardization']
        >,
        'reconciliation'
      >
    >;
  readonly taxCalculationRuns?: Pick<
    import('@emdo/db/api').PostgresFinanceTaxRepository,
    'listCalculationRuns' | 'getCalculationRun'
  >;
  readonly taxCases?: Pick<
    import('@emdo/db/api').PostgresFinanceTaxRepository,
    'listCases' | 'getCase' | 'assessCase'
  >;
  readonly automationSchedules?: Pick<
    NonNullable<
      import('../services/contracts.js').ApiServices['financeSchedules']
    >,
    'listSchedules'
  >;
  readonly journalDrafts?: Pick<
    NonNullable<
      import('../services/contracts.js').ApiServices['financeJournalDrafts']
    >,
    'listJournalDraftResults' | 'readJournalDraftResult'
  >;
  readonly investmentReconciliation?: Pick<
    NonNullable<
      import('../services/contracts.js').ApiServices['financeInvestmentReconciliation']
    >,
    'list' | 'get'
  >;
  readonly automationRuns?: Pick<
    NonNullable<
      import('../services/contracts.js').ApiServices['financeAutomations']
    >,
    'listRuns' | 'getRun'
  >;
  readonly generatedReports?: NonNullable<
    import('../services/contracts.js').ApiServices['financeGeneratedReports']
  >;
  readonly normalizedBooks?: Pick<
    import('@emdo/db/api').PostgresFinanceV2Repository,
    | 'downloadBookEvidence'
    | 'saveReportMapping'
    | 'saveSourceReportMapping'
    | 'listFinancialAccounts'
    | 'listBooks'
    | 'overview'
    | 'commercialOverview'
    | 'listNormalizedImports'
    | 'getNormalizedImport'
    | 'listInvestmentValuations'
    | 'listInvestmentLots'
    | 'getInvestmentValuation'
    | 'checkStockSplitSettlementReady'
    | 'getInvestmentStockSplitSettlement'
  >;
  readonly records: FinanceSpecialistRecordPort;
  readonly documents: FinanceSpecialistDocumentPort;
  /**
   * Optional only for read/safe-write-only startup. Document mutations fail
   * closed until the encrypted document gateway has composed this port.
   */
  readonly guardedDocumentActions?: FinanceDocumentGuardedActionPort;
  /**
   * Existing durable import receipt boundary. It is deliberately optional at
   * construction so the direct Finance read/safe-write subset remains usable;
   * a guarded statement commit fails closed when it is absent.
   */
  readonly imports?: Readonly<{
    commit(input: {
      readonly planId: string;
      readonly idempotencyKey: string;
      readonly principal: AuthenticatedPrincipal;
      readonly requestId: string;
    }): Promise<unknown>;
  }>;
  /** Server-computed bindings for the two dynamically guarded descriptors. */
  readonly guardedActionCapabilityFingerprints?: Readonly<{
    readonly recordsWrite: string;
    readonly statementImport: string;
  }>;
  /** Server time only; it is never included in an idempotency hash. */
  readonly now: () => Date;
}

export type FinanceConfirmationOperation =
  | 'ambiguous-or-bulk-finance-write'
  | 'finance-adjustment'
  | 'finance-reversal'
  | 'finance-statement-import-commit'
  | FinanceDocumentGuardedActionOperation
  | 'unsupported-finance-write';

export type FinanceGuardedActionClassification = Readonly<{
  readonly operation: FinanceConfirmationOperation;
}>;

const GuardedFinanceWriteInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  mutation: z.object({ kind: z.string() }).passthrough(),
});
const GuardedFinanceImportInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  request: z.object({ kind: z.string() }).passthrough(),
});

/**
 * Conservative pre-execution classification for the SDK approval callback.
 * Returning undefined permits only inputs that the existing service already
 * treats as direct, bounded safe writes; any ambiguity is held for the shared
 * EMDO visual proposal seam instead of being inferred from model authority.
 */
export const classifyFinanceGuardedAction = (input: {
  readonly capabilityId: string;
  readonly arguments: unknown;
}): FinanceGuardedActionClassification | undefined => {
  if (input.capabilityId === 'finance.statement.import') {
    const parsed = GuardedFinanceImportInputSchema.safeParse(input.arguments);
    if (!parsed.success || parsed.data.request.kind !== 'commit') {
      return Object.freeze({ operation: 'unsupported-finance-write' });
    }
    return Object.freeze({ operation: 'finance-statement-import-commit' });
  }
  if (input.capabilityId !== 'finance.records.write') {
    return Object.freeze({ operation: 'unsupported-finance-write' });
  }
  const parsed = GuardedFinanceWriteInputSchema.safeParse(input.arguments);
  if (!parsed.success) {
    return Object.freeze({ operation: 'unsupported-finance-write' });
  }
  const mutation = parsed.data.mutation;
  if (mutation.kind === 'adjust') {
    return Object.freeze({ operation: 'finance-adjustment' });
  }
  if (mutation.kind === 'reverse') {
    return Object.freeze({ operation: 'finance-reversal' });
  }
  if (mutation.kind === 'commit-document-review') {
    return Object.freeze({ operation: 'finance-document-review-commit' });
  }
  if (mutation.kind === 'accept-document-match') {
    return Object.freeze({ operation: 'finance-document-match-accept' });
  }
  if (mutation.kind === 'delete-document') {
    return Object.freeze({ operation: 'finance-document-delete' });
  }
  if (mutation.kind === 'patch-transaction') {
    const patch = mutation.patch;
    return patch === null ||
      typeof patch !== 'object' ||
      Array.isArray(patch) ||
      (patch as { readonly description?: unknown }).description === undefined
      ? undefined
      : Object.freeze({ operation: 'unsupported-finance-write' });
  }
  if (mutation.kind === 'create') {
    const record = mutation.record;
    if (
      record !== null &&
      typeof record === 'object' &&
      !Array.isArray(record) &&
      (record as { readonly recordType?: unknown }).recordType === 'transaction'
    ) {
      return undefined;
    }
    return Object.freeze({ operation: 'ambiguous-or-bulk-finance-write' });
  }
  if (mutation.kind === 'update') {
    return Object.freeze({ operation: 'ambiguous-or-bulk-finance-write' });
  }
  return Object.freeze({ operation: 'unsupported-finance-write' });
};

/**
 * This is intentionally not coerced into `rejected`: EMDO must turn it into
 * an authenticated visual confirmation, rather than treating it as a failed
 * request or a completed mutation.
 */
export interface FinanceConfirmationRequiredResult {
  readonly result: Readonly<{
    readonly status: 'confirmation-required';
    readonly proposal: Readonly<{
      readonly state: 'proposed';
      readonly operation: FinanceConfirmationOperation;
      readonly channel: 'emdo-authenticated-visual';
      readonly canonicalHash: string;
    }>;
  }>;
}

type FinanceWriteResult =
  | Readonly<{
      readonly result: Readonly<{
        readonly status: 'applied' | 'duplicate' | 'ignored';
        readonly record: FinanceRecordSummary;
      }>;
    }>
  | Readonly<{
      readonly result: Readonly<{
        readonly status: 'rejected';
        readonly record: FinanceRecordSummary | null;
        readonly safeError: Readonly<{
          readonly code: 'operation-rejected' | 'service-unavailable';
          readonly message: string;
          readonly retryable: false;
        }>;
      }>;
    }>
  | Readonly<{
      readonly result: FinanceDocumentGuardedActionExecutionResult;
    }>
  | FinanceConfirmationRequiredResult;

const FinanceDocumentGuardedActionExecutionResultSchema = z.discriminatedUnion(
  'status',
  [
    z.strictObject({
      status: z.literal('document-committed'),
      documentId: OpaqueReferenceSchema,
      extractionRevision: z.number().int().positive(),
    }),
    z.strictObject({
      status: z.literal('match-accepted'),
      documentId: OpaqueReferenceSchema,
      matchId: OpaqueReferenceSchema,
    }),
    z.strictObject({
      status: z.enum(['document-deleted', 'document-purge-pending']),
      documentId: OpaqueReferenceSchema,
    }),
  ],
);

type FinanceStatementImportResult =
  | FinanceConfirmationRequiredResult
  | Readonly<{
      readonly result: Readonly<{
        readonly status: 'committed' | 'replayed';
        readonly receipt: Readonly<{
          readonly id: string;
          readonly planId: string;
          readonly transactionCount: number;
          readonly verified: true;
        }>;
        readonly sourceDeletionAuthorized: true;
      }>;
    }>
  | Readonly<{
      readonly result: Readonly<{
        readonly status: 'rejected';
        readonly sourceDeletionAuthorized: false;
        readonly safeError: Readonly<{
          readonly code: 'service-unavailable';
          readonly message: string;
          readonly retryable: false;
        }>;
      }>;
    }>;

const scopeHashBinding = (scope: FinanceCapabilityScope) => ({
  requestId: scope.requestId,
  runId: scope.runId,
  userId: scope.userId,
  householdId: scope.householdId,
  sessionId: scope.sessionId,
  privateSpaceId: scope.privateSpaceId,
  spaceAccessGrantId: scope.spaceAccessGrantId,
  agentInvocationId: scope.agentInvocationId,
  phaseInvocationId: scope.phaseInvocationId,
  invocationIdempotencyScope: scope.invocationIdempotencyScope,
  collectionAuthorizationScopeFingerprint:
    scope.collectionAuthorizationScopeFingerprint,
  ...(scope.disclosureGrantId === undefined
    ? {}
    : { disclosureGrantId: scope.disclosureGrantId }),
});

const operationHash = (
  scope: FinanceCapabilityScope,
  operation: string,
  payload: Readonly<Record<string, unknown>>,
): string =>
  hashCanonicalJson({
    schemaVersion: 1,
    domain: 'emdo.finance-specialist.v1',
    scope: scopeHashBinding(scope),
    operation,
    payload,
  });

const durableCommand = (
  scope: FinanceCapabilityScope,
  operation: FinanceSafeWriteOperation,
  payload: Readonly<Record<string, unknown>>,
): FinanceDurableWriteCommand => {
  const canonicalHash = operationHash(scope, operation, payload);
  return deepFreeze({
    scope,
    canonicalHash,
    idempotencyKey: `finance-agent:${canonicalHash}`,
    audit: {
      eventType: 'finance.agent.safe-write' as const,
      operation,
      canonicalHash,
      requestId: scope.requestId,
      runId: scope.runId,
    },
  });
};

/**
 * The guarded proposal materializer and the Finance execution leaf both use
 * this exact, server-owned binding. A UUID alone is never authority: every
 * durable actor, run, private space, disclosure grant, descriptor, and
 * canonical action is covered by the digest. The current access-grant ID is
 * still checked at each live authorization boundary, but is intentionally not
 * a durable proposal binding so a renewed grant cannot invalidate an otherwise
 * unchanged approved action.
 */
export const hashFinanceGuardedActionExecutionBinding = <
  Scope extends Pick<
    FinanceCapabilityScope,
    | 'runId'
    | 'userId'
    | 'householdId'
    | 'sessionId'
    | 'privateSpaceId'
    | 'collectionAuthorizationScopeFingerprint'
    | 'disclosureGrantId'
  >,
>(input: {
  readonly proposalId: string;
  readonly scope: Scope;
  readonly capabilityId: 'finance.records.write' | 'finance.statement.import';
  readonly capabilityVersion: string;
  readonly capabilityFingerprint: string;
  readonly operation: FinanceConfirmationOperation;
  readonly actionHash: string;
  /** Present only for guarded Finance document mutations. */
  readonly targetBindingHash?: string;
}): string =>
  hashCanonicalJson({
    schemaVersion: 1,
    domain: 'emdo.finance-guarded-action-execution-binding.v2',
    proposalId: input.proposalId,
    runId: input.scope.runId,
    householdId: input.scope.householdId,
    userId: input.scope.userId,
    authenticatedSessionId: input.scope.sessionId,
    privateSpaceId: input.scope.privateSpaceId,
    authorizationScopeFingerprint:
      input.scope.collectionAuthorizationScopeFingerprint,
    disclosureGrantId: input.scope.disclosureGrantId,
    capabilityId: input.capabilityId,
    capabilityVersion: input.capabilityVersion,
    capabilityFingerprint: input.capabilityFingerprint,
    operation: input.operation,
    actionHash: input.actionHash,
    ...(input.targetBindingHash === undefined
      ? {}
      : { targetBindingHash: input.targetBindingHash }),
  });

const guardedDurableCommand = (input: {
  readonly scope: FinanceCapabilityScope;
  readonly operation:
    'finance-transaction-adjustment' | 'finance-transaction-reversal';
  readonly permit: GuardedActionPermit;
  readonly payload: Readonly<Record<string, unknown>>;
}): FinanceDurableWriteCommand => {
  const canonicalHash = operationHash(input.scope, input.operation, {
    proposalId: input.permit.proposalId,
    decisionId: input.permit.decisionId,
    actionHash: input.permit.actionHash,
    executionBindingHash: input.permit.executionBindingHash,
    ...input.payload,
  });
  return deepFreeze({
    scope: input.scope,
    canonicalHash,
    idempotencyKey: `finance-guarded:${input.permit.proposalId}`,
    audit: {
      eventType: 'finance.agent.safe-write' as const,
      operation: input.operation,
      canonicalHash,
      requestId: input.scope.requestId,
      runId: input.scope.runId,
    },
  });
};

const confirmationRequired = (
  scope: FinanceCapabilityScope,
  operation: FinanceConfirmationOperation,
  payload: Readonly<Record<string, unknown>>,
): FinanceConfirmationRequiredResult =>
  deepFreeze({
    result: {
      status: 'confirmation-required' as const,
      proposal: {
        state: 'proposed' as const,
        operation,
        channel: 'emdo-authenticated-visual' as const,
        canonicalHash: operationHash(scope, operation, payload),
      },
    },
  });

const rejectedWrite = (
  message: string,
  record: FinanceRecordSummary | null = null,
): FinanceWriteResult =>
  deepFreeze({
    result: {
      status: 'rejected' as const,
      record,
      safeError: {
        code: 'operation-rejected' as const,
        message,
        retryable: false as const,
      },
    },
  });

const unavailableWrite = (): FinanceWriteResult =>
  deepFreeze({
    result: {
      status: 'rejected' as const,
      record: null,
      safeError: {
        code: 'service-unavailable' as const,
        message: 'The finance service is unavailable.',
        retryable: false as const,
      },
    },
  });

const unavailableDocumentAction = (): FinanceWriteResult => unavailableWrite();

const unavailableImport = (): FinanceStatementImportResult =>
  deepFreeze({
    result: {
      status: 'rejected' as const,
      sourceDeletionAuthorized: false as const,
      safeError: {
        code: 'service-unavailable' as const,
        message: 'The finance import service is unavailable.',
        retryable: false as const,
      },
    },
  });

const nowIso = (now: () => Date): string => {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('api-finance-specialist-clock-invalid');
  }
  return IsoDateTimeSchema.parse(value.toISOString());
};

const ownedRecord = (
  candidate: unknown,
  scope: FinanceCapabilityScope,
): FinanceRecord => {
  const parsed = validateFinanceRecord(candidate);
  if (
    parsed.status !== 'accepted' ||
    parsed.record.spaceId !== scope.privateSpaceId ||
    parsed.record.ownerUserId !== scope.userId
  ) {
    throw new Error('api-finance-specialist-owned-record-invalid');
  }
  return parsed.record;
};

const sumBudgetAllocations = (budget: FinanceBudgetRecord): number => {
  const total = budget.allocations.reduce(
    (current, allocation) => current + BigInt(allocation.amountCadMinor),
    0n,
  );
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('api-finance-specialist-budget-total-out-of-range');
  }
  return Number(total);
};

const summarizeRecord = (record: FinanceRecord): FinanceRecordSummary => {
  let label: string;
  let amountCadMinor: number | null;
  let effectiveOn: string | null;
  let status: string | null;
  let revision: number | null = null;

  switch (record.recordType) {
    case 'account':
      label = record.name;
      amountCadMinor = record.openingBalanceCadMinor;
      effectiveOn = null;
      status = record.active ? 'active' : 'inactive';
      break;
    case 'transaction':
      label = record.description;
      amountCadMinor = record.effectiveAmountCadMinor;
      effectiveOn = record.postedOn;
      status = record.reversal === null ? 'active' : 'reversed';
      revision = record.revision ?? null;
      break;
    case 'category':
      label = record.name;
      amountCadMinor = null;
      effectiveOn = null;
      status = record.active ? 'active' : 'inactive';
      break;
    case 'budget':
      label = `Budget ${record.month}`;
      amountCadMinor = sumBudgetAllocations(record);
      effectiveOn = `${record.month}-01`;
      status = 'active';
      revision = record.revision;
      break;
    case 'bill':
      label = record.name;
      amountCadMinor = record.expectedAmountCadMinor;
      effectiveOn = record.dueOn;
      status = record.status;
      break;
    case 'subscription':
      label = record.name;
      amountCadMinor = record.expectedAmountCadMinor;
      effectiveOn = record.nextDueOn;
      status = record.active ? 'active' : 'inactive';
      break;
    case 'goal':
      label = record.name;
      amountCadMinor = record.currentAmountCadMinor;
      effectiveOn = record.targetOn;
      status = record.status;
      break;
  }

  return FinanceRecordSummarySchema.parse({
    id: record.id,
    recordType: record.recordType,
    label,
    currency: record.recordType === 'category' ? null : 'CAD',
    amountCadMinor,
    effectiveOn,
    status,
    revision,
    updatedAt: record.updatedAt,
  });
};

const sameAllocations = (
  left: FinanceBudgetRecord,
  right: FinanceBudgetRecord,
): boolean =>
  left.allocations.length === right.allocations.length &&
  left.allocations.every(
    (allocation, index) =>
      allocation.categoryId === right.allocations[index]?.categoryId &&
      allocation.amountCadMinor === right.allocations[index]?.amountCadMinor,
  );

const sameBudgetCreate = (
  left: FinanceBudgetRecord,
  right: FinanceBudgetRecord,
): boolean =>
  left.id === right.id &&
  left.month === right.month &&
  left.revision === 0 &&
  right.revision === 0 &&
  sameAllocations(left, right);

const budgetChangeKind = (
  current: FinanceBudgetRecord,
  next: FinanceBudgetRecord,
): 'none' | 'single-set' | 'confirmation-required' => {
  const currentAllocations = new Map(
    current.allocations.map((allocation) => [
      allocation.categoryId,
      allocation.amountCadMinor,
    ]),
  );
  const nextAllocations = new Map(
    next.allocations.map((allocation) => [
      allocation.categoryId,
      allocation.amountCadMinor,
    ]),
  );
  const changed = new Set<string>();
  for (const [categoryId, amount] of currentAllocations) {
    if (nextAllocations.get(categoryId) !== amount) changed.add(categoryId);
  }
  for (const categoryId of nextAllocations.keys()) {
    if (!currentAllocations.has(categoryId)) changed.add(categoryId);
  }
  if (changed.size === 0) return 'none';
  if (changed.size !== 1) return 'confirmation-required';
  const categoryId = [...changed][0]!;
  return nextAllocations.has(categoryId)
    ? 'single-set'
    : 'confirmation-required';
};

const transactionCreatePayload = (record: FinanceTransactionRecord) => ({
  recordId: record.id,
  accountId: record.accountId,
  categoryId: record.categoryId,
  postedOn: record.postedOn,
  description: record.description,
  amountCadMinor: record.originalAmountCadMinor,
});

const transactionPatchPayload = (
  current: FinanceTransactionRecord,
  next: FinanceTransactionRecord,
) => ({
  transactionId: current.id,
  expectedRevision: current.revision,
  patch: {
    ...(current.description === next.description
      ? {}
      : { description: next.description }),
    ...(current.categoryId === next.categoryId
      ? {}
      : { categoryId: next.categoryId }),
    ...((current.annotation ?? null) === (next.annotation ?? null)
      ? {}
      : { annotation: next.annotation ?? null }),
  },
});

const budgetPayload = (record: FinanceBudgetRecord) => ({
  recordId: record.id,
  month: record.month,
  allocations: record.allocations.map((allocation) => ({
    categoryId: allocation.categoryId,
    amountCadMinor: allocation.amountCadMinor,
  })),
});

const validReceipt = (
  receipt: FinanceDurableWriteReceipt,
  scope: FinanceCapabilityScope,
): Readonly<{
  readonly status: 'applied' | 'duplicate';
  readonly record: FinanceRecord;
}> => {
  if (
    (receipt.status !== 'applied' && receipt.status !== 'duplicate') ||
    !OpaqueReferenceSchema.safeParse(receipt.auditEventId).success
  ) {
    throw new Error('api-finance-specialist-write-receipt-invalid');
  }
  return deepFreeze({
    status: receipt.status,
    record: ownedRecord(receipt.record, scope),
  });
};

const sameManualTransaction = (
  expected: FinanceTransactionRecord,
  actual: FinanceRecord,
): actual is FinanceTransactionRecord =>
  actual.recordType === 'transaction' &&
  actual.id === expected.id &&
  actual.spaceId === expected.spaceId &&
  actual.ownerUserId === expected.ownerUserId &&
  actual.accountId === expected.accountId &&
  actual.categoryId === expected.categoryId &&
  actual.postedOn === expected.postedOn &&
  actual.description === expected.description &&
  actual.currency === 'CAD' &&
  actual.originalAmountCadMinor === expected.originalAmountCadMinor &&
  actual.effectiveAmountCadMinor === expected.effectiveAmountCadMinor &&
  actual.adjustments.length === 0 &&
  actual.reversal === null &&
  actual.appliedOperationIds.length === 0 &&
  actual.source.kind === 'manual' &&
  (actual.annotation ?? null) === (expected.annotation ?? null) &&
  actual.revision === expected.revision;

const sameTransactionMutation = (
  expected: FinanceTransactionRecord,
  actual: FinanceRecord,
): actual is FinanceTransactionRecord =>
  actual.recordType === 'transaction' &&
  actual.id === expected.id &&
  actual.spaceId === expected.spaceId &&
  actual.ownerUserId === expected.ownerUserId &&
  actual.accountId === expected.accountId &&
  actual.categoryId === expected.categoryId &&
  actual.postedOn === expected.postedOn &&
  actual.description === expected.description &&
  (actual.annotation ?? null) === (expected.annotation ?? null) &&
  actual.currency === expected.currency &&
  actual.originalAmountCadMinor === expected.originalAmountCadMinor &&
  actual.effectiveAmountCadMinor === expected.effectiveAmountCadMinor &&
  actual.adjustments.length === expected.adjustments.length &&
  actual.adjustments.every(
    (entry, index) =>
      entry.operationId === expected.adjustments[index]?.operationId &&
      entry.amountCadMinor === expected.adjustments[index]?.amountCadMinor &&
      entry.reason === expected.adjustments[index]?.reason,
  ) &&
  actual.reversal?.operationId === expected.reversal?.operationId &&
  actual.reversal?.reason === expected.reversal?.reason &&
  actual.appliedOperationIds.length === expected.appliedOperationIds.length &&
  actual.appliedOperationIds.every(
    (operationId, index) => operationId === expected.appliedOperationIds[index],
  ) &&
  actual.source.kind === expected.source.kind &&
  (actual.source.kind !== 'import' ||
    (expected.source.kind === 'import' &&
      actual.source.sourceHash === expected.source.sourceHash &&
      actual.source.sourceRow === expected.source.sourceRow &&
      actual.source.fingerprint === expected.source.fingerprint &&
      actual.source.externalId === expected.source.externalId)) &&
  actual.revision === expected.revision;

const sameBudgetMutation = (
  expected: FinanceBudgetRecord,
  actual: FinanceRecord,
): actual is FinanceBudgetRecord =>
  actual.recordType === 'budget' &&
  actual.id === expected.id &&
  actual.spaceId === expected.spaceId &&
  actual.ownerUserId === expected.ownerUserId &&
  actual.month === expected.month &&
  actual.currency === 'CAD' &&
  actual.revision === expected.revision &&
  sameAllocations(expected, actual);

const checkedScope = (
  principal: z.output<typeof FinancePrincipalSchema>,
  rawContext: CapabilityInvocationContext,
): FinanceCapabilityScope => {
  const context = FinanceInvocationContextSchema.safeParse(rawContext);
  if (
    !context.success ||
    context.data.abortSignal.aborted ||
    context.data.userId !== principal.userId ||
    context.data.householdId !== principal.householdId ||
    context.data.sessionId !== principal.sessionId ||
    context.data.spaceAccessGrantId !== principal.spaceAccessGrantId ||
    context.data.invocationContext.orchestrationRunId !== context.data.runId ||
    context.data.invocationContext.actorId !== context.data.userId ||
    context.data.invocationContext.locale !== context.data.locale ||
    context.data.invocationContext.grantedCapabilities.length !==
      FINANCE_REGISTERED_CAPABILITY_IDS.length ||
    context.data.invocationContext.grantedCapabilities.some(
      (capabilityId, index) =>
        capabilityId !== FINANCE_REGISTERED_CAPABILITY_IDS[index],
    )
  ) {
    throw new Error('api-finance-specialist-request-binding-invalid');
  }
  // The binding values themselves must not be replaceable, but abortSignal is
  // a live platform object. Deep-freezing it prevents AbortSignal.any() from
  // registering dependent signals after an approval pause.
  return Object.freeze({
    requestId: context.data.requestId,
    runId: context.data.runId,
    userId: principal.userId,
    householdId: principal.householdId,
    sessionId: principal.sessionId,
    privateSpaceId: principal.privateSpaceId,
    spaceAccessGrantId: principal.spaceAccessGrantId,
    agentInvocationId: context.data.invocationContext.agentInvocationId,
    phaseInvocationId: context.data.invocationContext.phaseInvocationId,
    invocationIdempotencyScope: context.data.invocationContext.idempotencyScope,
    collectionAuthorizationScopeFingerprint:
      principal.collectionAuthorizationScopeFingerprint,
    ...(context.data.disclosureGrantId === undefined
      ? {}
      : { disclosureGrantId: context.data.disclosureGrantId }),
    abortSignal: context.data.abortSignal,
  });
};

type ExecutableFinanceGuardedOperation =
  | 'finance-adjustment'
  | 'finance-reversal'
  | 'finance-statement-import-commit'
  | FinanceDocumentGuardedActionOperation;

const verifiedGuardedActionPermit = (input: {
  readonly context: CapabilityInvocationContext;
  readonly scope: FinanceCapabilityScope;
  readonly capabilityId: 'finance.records.write' | 'finance.statement.import';
  readonly operation: ExecutableFinanceGuardedOperation;
  readonly arguments: unknown;
  readonly capabilityFingerprint: string | undefined;
  readonly targetBindingHash?: string;
}): GuardedActionPermit | undefined => {
  const permit = GuardedActionPermitSchema.safeParse(
    input.context.guardedActionPermit,
  );
  const context = FinanceInvocationContextSchema.safeParse(input.context);
  if (
    !permit.success ||
    !context.success ||
    input.scope.disclosureGrantId === undefined ||
    input.capabilityFingerprint === undefined ||
    permit.data.capabilityId !== input.capabilityId ||
    permit.data.capabilityVersion !== '1.0.0' ||
    permit.data.capabilityFingerprint !== input.capabilityFingerprint ||
    permit.data.operation !== input.operation ||
    permit.data.actionHash !== hashCanonicalJson(input.arguments) ||
    (input.targetBindingHash !== undefined &&
      !Sha256Schema.safeParse(input.targetBindingHash).success) ||
    permit.data.targetBindingHash !== input.targetBindingHash ||
    context.data.approvalDecisionId !== permit.data.decisionId ||
    context.data.requestId !== input.scope.requestId ||
    context.data.runId !== input.scope.runId ||
    context.data.userId !== input.scope.userId ||
    context.data.householdId !== input.scope.householdId ||
    context.data.sessionId !== input.scope.sessionId ||
    context.data.spaceAccessGrantId !== input.scope.spaceAccessGrantId ||
    context.data.disclosureGrantId !== input.scope.disclosureGrantId ||
    permit.data.executionBindingHash !==
      hashFinanceGuardedActionExecutionBinding({
        proposalId: permit.data.proposalId,
        scope: input.scope,
        capabilityId: input.capabilityId,
        capabilityVersion: permit.data.capabilityVersion,
        capabilityFingerprint: permit.data.capabilityFingerprint,
        operation: input.operation,
        actionHash: permit.data.actionHash,
        ...(input.targetBindingHash === undefined
          ? {}
          : { targetBindingHash: input.targetBindingHash }),
      })
  ) {
    return undefined;
  }
  return permit.data;
};

const assertDependencies = (
  dependencies: RequestScopedFinanceSpecialistServiceDependencies,
): void => {
  if (
    typeof dependencies?.records?.list !== 'function' ||
    typeof dependencies.records.getOwnedRecord !== 'function' ||
    typeof dependencies.records.getOwnedBudgetForMonth !== 'function' ||
    typeof dependencies.records.listBudgetTransactions !== 'function' ||
    typeof dependencies.records.createManualTransaction !== 'function' ||
    typeof dependencies.records.patchOwnedTransaction !== 'function' ||
    typeof dependencies.records.applyTransactionAdjustment !== 'function' ||
    typeof dependencies.records.applyTransactionReversal !== 'function' ||
    typeof dependencies.records.createMonthlyCategoryBudget !== 'function' ||
    typeof dependencies.records.updateMonthlyCategoryBudget !== 'function' ||
    typeof dependencies?.documents?.searchCommitted !== 'function' ||
    typeof dependencies.documents.readCommitted !== 'function' ||
    typeof dependencies.documents.listCommittedMatches !== 'function' ||
    typeof dependencies.now !== 'function'
  ) {
    throw new Error('api-finance-specialist-services-unavailable');
  }
  if (
    (dependencies.imports !== undefined &&
      typeof dependencies.imports.commit !== 'function') ||
    (dependencies.guardedActionCapabilityFingerprints !== undefined &&
      (!Sha256Schema.safeParse(
        dependencies.guardedActionCapabilityFingerprints.recordsWrite,
      ).success ||
        !Sha256Schema.safeParse(
          dependencies.guardedActionCapabilityFingerprints.statementImport,
        ).success))
  ) {
    throw new Error('api-finance-specialist-services-unavailable');
  }
};

const asBudget = (
  candidate: FinanceRecord | undefined,
  scope: FinanceCapabilityScope,
): FinanceBudgetRecord | undefined => {
  if (candidate === undefined) return undefined;
  const record = ownedRecord(candidate, scope);
  return record.recordType === 'budget' ? record : undefined;
};

/**
 * Composes Finance's registered non-provider capabilities for one authenticated
 * private-space principal. All durable access is injected as a narrow port;
 * this service never receives document bytes, SQL, paths, provider handles,
 * or credentials.
 */
export const createRequestScopedFinanceSpecialistServices = (
  rawInput: Readonly<{
    readonly principal: unknown;
    readonly dependencies: RequestScopedFinanceSpecialistServiceDependencies;
  }>,
): TrustedFinanceSpecialistServices => {
  const principal = FinancePrincipalSchema.safeParse(rawInput.principal);
  if (!principal.success) {
    throw new Error('api-finance-specialist-services-unavailable');
  }
  assertDependencies(rawInput.dependencies);
  const fixedPrincipal = deepFreeze(principal.data);
  const dependencies = rawInput.dependencies;

  const readFinanceRecords: TrustedFinanceSpecialistServices['readFinanceRecords'] =
    async (input: FinanceReadRequest, context) => {
      const scope = checkedScope(fixedPrincipal, context);
      const limit = z.number().int().min(1).max(100).parse(input.limit);
      const recordTypes =
        input.recordTypes === undefined
          ? undefined
          : z.array(FinanceRecordTypeSchema).max(7).parse(input.recordTypes);
      const cursor =
        input.cursor === undefined
          ? undefined
          : OpaqueReferenceSchema.parse(input.cursor);
      const result = await dependencies.records.list({
        scope,
        ...(recordTypes === undefined ? {} : { recordTypes }),
        ...(cursor === undefined ? {} : { cursor }),
        limit,
      });
      if (result.records.length > limit) {
        throw new Error('api-finance-specialist-record-page-invalid');
      }
      const records = result.records.map((candidate) => {
        const record = ownedRecord(candidate, scope);
        if (
          recordTypes !== undefined &&
          !recordTypes.includes(record.recordType)
        ) {
          throw new Error('api-finance-specialist-record-page-invalid');
        }
        return summarizeRecord(record);
      });
      return deepFreeze({
        records,
        nextCursor:
          result.nextCursor === null
            ? null
            : OpaqueReferenceSchema.parse(result.nextCursor),
      });
    };

  const executeGuardedDocumentAction = async (input: {
    readonly scope: FinanceCapabilityScope;
    readonly context: CapabilityInvocationContext;
    readonly operation: FinanceDocumentGuardedActionOperation;
    readonly intent: FinanceDocumentGuardedActionIntent;
    readonly mutation: FinanceWriteMutation;
  }): Promise<FinanceWriteResult> => {
    const { scope, context, operation, intent, mutation } = input;
    const targetId =
      intent.kind === 'accept-document-match'
        ? intent.matchId
        : intent.documentId;
    if (context.guardedActionPermit === undefined) {
      return confirmationRequired(scope, operation, {
        ...(intent.kind === 'accept-document-match'
          ? { matchId: targetId }
          : { documentId: targetId }),
      });
    }
    const actions = dependencies.guardedDocumentActions;
    const capabilityFingerprint =
      dependencies.guardedActionCapabilityFingerprints?.recordsWrite;
    if (actions === undefined || capabilityFingerprint === undefined) {
      return unavailableDocumentAction();
    }
    try {
      // This reload is intentionally before permit comparison.  The target
      // digest includes the current review/match/original state, so a stale
      // approval cannot proceed to the document mutation leaf.
      const target = await actions.materializeTarget({
        scope,
        operation,
        intent,
      });
      const targetBindingHash = Sha256Schema.parse(target.targetBindingHash);
      const permit = verifiedGuardedActionPermit({
        context,
        scope,
        capabilityId: 'finance.records.write',
        operation,
        arguments: { schemaVersion: 1, mutation },
        capabilityFingerprint,
        targetBindingHash,
      });
      if (permit === undefined) return unavailableDocumentAction();
      const result = FinanceDocumentGuardedActionExecutionResultSchema.parse(
        await actions.executeApproved({
          scope,
          operation,
          intent,
          permit,
          capabilityFingerprint,
          approvalDecisionId: context.approvalDecisionId,
        }),
      );
      return deepFreeze({ result }) satisfies FinanceWriteResult;
    } catch {
      return unavailableDocumentAction();
    }
  };

  const writeFinanceRecord: TrustedFinanceSpecialistServices['writeFinanceRecord'] =
    async (mutation: FinanceWriteMutation, context): Promise<unknown> => {
      const scope = checkedScope(fixedPrincipal, context);

      if (mutation.kind === 'adjust') {
        if (context.guardedActionPermit === undefined) {
          return confirmationRequired(scope, 'finance-adjustment', {
            transactionId: mutation.transactionId,
            amountCadMinor: mutation.amountCadMinor,
          });
        }
        const permit = verifiedGuardedActionPermit({
          context,
          scope,
          capabilityId: 'finance.records.write',
          operation: 'finance-adjustment',
          arguments: { schemaVersion: 1, mutation },
          capabilityFingerprint:
            dependencies.guardedActionCapabilityFingerprints?.recordsWrite,
        });
        if (permit === undefined) return unavailableWrite();
        try {
          const candidate = ownedRecord(
            await dependencies.records.getOwnedRecord({
              scope,
              recordId: mutation.transactionId,
            }),
            scope,
          );
          if (
            candidate.recordType !== 'transaction' ||
            candidate.revision === undefined
          ) {
            return rejectedWrite('The finance transaction is unavailable.');
          }
          const timestamp = nowIso(dependencies.now);
          const ledger = applyTransactionLedgerOperation({
            transaction: candidate,
            operation: {
              operationId: permit.proposalId,
              kind: 'adjustment',
              amountCadMinor: mutation.amountCadMinor,
              reason: mutation.reason,
            },
            updatedAt: timestamp,
          });
          if (ledger.status !== 'applied' || ledger.transaction === null) {
            return rejectedWrite(
              'The finance adjustment could not be applied.',
            );
          }
          const nextResult = validateFinanceRecord({
            ...ledger.transaction,
            revision: candidate.revision + 1,
            updatedAt: timestamp,
          });
          if (
            nextResult.status !== 'accepted' ||
            nextResult.record.recordType !== 'transaction'
          ) {
            return rejectedWrite('The finance adjustment is invalid.');
          }
          const next = nextResult.record;
          const command = guardedDurableCommand({
            scope,
            operation: 'finance-transaction-adjustment',
            permit,
            payload: {
              transactionId: candidate.id,
              expectedRevision: candidate.revision,
              amountCadMinor: mutation.amountCadMinor,
              reason: mutation.reason,
            },
          });
          const receipt = validReceipt(
            await dependencies.records.applyTransactionAdjustment({
              ...command,
              current: candidate,
              record: next,
              expectedRevision: candidate.revision,
              operationId: permit.proposalId,
              amountCadMinor: mutation.amountCadMinor,
              reason: mutation.reason,
            }),
            scope,
          );
          if (!sameTransactionMutation(next, receipt.record)) {
            return unavailableWrite();
          }
          return deepFreeze({
            result: {
              status: receipt.status,
              record: summarizeRecord(receipt.record),
            },
          }) satisfies FinanceWriteResult;
        } catch {
          return unavailableWrite();
        }
      }
      if (mutation.kind === 'reverse') {
        if (context.guardedActionPermit === undefined) {
          return confirmationRequired(scope, 'finance-reversal', {
            transactionId: mutation.transactionId,
          });
        }
        const permit = verifiedGuardedActionPermit({
          context,
          scope,
          capabilityId: 'finance.records.write',
          operation: 'finance-reversal',
          arguments: { schemaVersion: 1, mutation },
          capabilityFingerprint:
            dependencies.guardedActionCapabilityFingerprints?.recordsWrite,
        });
        if (permit === undefined) return unavailableWrite();
        try {
          const candidate = ownedRecord(
            await dependencies.records.getOwnedRecord({
              scope,
              recordId: mutation.transactionId,
            }),
            scope,
          );
          if (
            candidate.recordType !== 'transaction' ||
            candidate.revision === undefined
          ) {
            return rejectedWrite('The finance transaction is unavailable.');
          }
          const timestamp = nowIso(dependencies.now);
          const ledger = applyTransactionLedgerOperation({
            transaction: candidate,
            operation: {
              operationId: permit.proposalId,
              kind: 'reversal',
              reason: mutation.reason,
            },
            updatedAt: timestamp,
          });
          if (ledger.status !== 'applied' || ledger.transaction === null) {
            return rejectedWrite('The finance reversal could not be applied.');
          }
          const nextResult = validateFinanceRecord({
            ...ledger.transaction,
            revision: candidate.revision + 1,
            updatedAt: timestamp,
          });
          if (
            nextResult.status !== 'accepted' ||
            nextResult.record.recordType !== 'transaction'
          ) {
            return rejectedWrite('The finance reversal is invalid.');
          }
          const next = nextResult.record;
          const command = guardedDurableCommand({
            scope,
            operation: 'finance-transaction-reversal',
            permit,
            payload: {
              transactionId: candidate.id,
              expectedRevision: candidate.revision,
              reason: mutation.reason,
            },
          });
          const receipt = validReceipt(
            await dependencies.records.applyTransactionReversal({
              ...command,
              current: candidate,
              record: next,
              expectedRevision: candidate.revision,
              operationId: permit.proposalId,
              reason: mutation.reason,
            }),
            scope,
          );
          if (!sameTransactionMutation(next, receipt.record)) {
            return unavailableWrite();
          }
          return deepFreeze({
            result: {
              status: receipt.status,
              record: summarizeRecord(receipt.record),
            },
          }) satisfies FinanceWriteResult;
        } catch {
          return unavailableWrite();
        }
      }

      if (mutation.kind === 'commit-document-review') {
        return executeGuardedDocumentAction({
          scope,
          context,
          operation: 'finance-document-review-commit',
          intent: deepFreeze({
            kind: 'commit-document-review' as const,
            documentId: mutation.documentId,
          }),
          mutation,
        });
      }

      if (mutation.kind === 'accept-document-match') {
        return executeGuardedDocumentAction({
          scope,
          context,
          operation: 'finance-document-match-accept',
          intent: deepFreeze({
            kind: 'accept-document-match' as const,
            matchId: mutation.matchId,
          }),
          mutation,
        });
      }

      if (mutation.kind === 'delete-document') {
        return executeGuardedDocumentAction({
          scope,
          context,
          operation: 'finance-document-delete',
          intent: deepFreeze({
            kind: 'delete-document' as const,
            documentId: mutation.documentId,
          }),
          mutation,
        });
      }

      if (mutation.kind === 'patch-transaction') {
        let current: FinanceTransactionRecord;
        try {
          const candidate = ownedRecord(
            await dependencies.records.getOwnedRecord({
              scope,
              recordId: mutation.transactionId,
            }),
            scope,
          );
          if (candidate.recordType !== 'transaction') {
            return rejectedWrite('The finance transaction is unavailable.');
          }
          current = candidate;
        } catch {
          return rejectedWrite('The finance transaction is unavailable.');
        }
        if (
          current.revision === undefined ||
          current.revision !== mutation.expectedRevision
        ) {
          return rejectedWrite(
            'The finance transaction changed. Refresh it before editing.',
            summarizeRecord(current),
          );
        }
        if (
          mutation.patch.description !== undefined &&
          current.source.kind !== 'manual'
        ) {
          return confirmationRequired(scope, 'unsupported-finance-write', {
            kind: mutation.kind,
            transactionId: current.id,
            field: 'description',
          });
        }
        const nextDescription =
          mutation.patch.description ?? current.description;
        const nextCategoryId =
          mutation.patch.categoryId === undefined
            ? current.categoryId
            : mutation.patch.categoryId;
        const nextAnnotation =
          mutation.patch.annotation === undefined
            ? (current.annotation ?? null)
            : mutation.patch.annotation;
        if (
          nextDescription === current.description &&
          nextCategoryId === current.categoryId &&
          nextAnnotation === (current.annotation ?? null)
        ) {
          return deepFreeze({
            result: {
              status: 'ignored' as const,
              record: summarizeRecord(current),
            },
          }) satisfies FinanceWriteResult;
        }
        const timestamp = nowIso(dependencies.now);
        const validated = validateFinanceRecord({
          ...current,
          description: nextDescription,
          categoryId: nextCategoryId,
          annotation: nextAnnotation,
          revision: current.revision + 1,
          updatedAt: timestamp,
        });
        if (
          validated.status !== 'accepted' ||
          validated.record.recordType !== 'transaction'
        ) {
          return rejectedWrite('The finance transaction edit is invalid.');
        }
        const next = validated.record;
        const command = durableCommand(
          scope,
          'transaction-nondestructive-patch',
          transactionPatchPayload(current, next),
        );
        try {
          const receipt = validReceipt(
            await dependencies.records.patchOwnedTransaction({
              ...command,
              current,
              record: next,
              expectedRevision: current.revision,
            }),
            scope,
          );
          if (!sameTransactionMutation(next, receipt.record)) {
            return unavailableWrite();
          }
          return deepFreeze({
            result: {
              status: receipt.status,
              record: summarizeRecord(receipt.record),
            },
          }) satisfies FinanceWriteResult;
        } catch {
          return unavailableWrite();
        }
      }

      if (mutation.kind === 'create') {
        if (
          mutation.record.recordType !== 'transaction' &&
          mutation.record.recordType !== 'budget'
        ) {
          return confirmationRequired(scope, 'unsupported-finance-write', {
            kind: mutation.kind,
            recordType: mutation.record.recordType,
            recordId: mutation.recordId,
          });
        }

        let record: FinanceRecord;
        try {
          const timestamp = nowIso(dependencies.now);
          record = materializeFinanceRecordCreate({
            modelArguments: { schemaVersion: 1, mutation },
            trustedState: {
              spaceId: scope.privateSpaceId,
              ownerUserId: scope.userId,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          });
        } catch {
          return rejectedWrite('The finance write is invalid.');
        }

        if (record.recordType === 'transaction') {
          if (
            record.source.kind !== 'manual' ||
            record.originalAmountCadMinor === 0 ||
            record.adjustments.length !== 0 ||
            record.reversal !== null ||
            record.appliedOperationIds.length !== 0
          ) {
            return rejectedWrite('The manual transaction is invalid.');
          }
          const command = durableCommand(
            scope,
            'manual-transaction-create',
            transactionCreatePayload(record),
          );
          try {
            const receipt = validReceipt(
              await dependencies.records.createManualTransaction({
                ...command,
                record,
              }),
              scope,
            );
            if (!sameManualTransaction(record, receipt.record)) {
              return unavailableWrite();
            }
            return deepFreeze({
              result: {
                status: receipt.status,
                record: summarizeRecord(receipt.record),
              },
            }) satisfies FinanceWriteResult;
          } catch {
            return unavailableWrite();
          }
        }

        if (record.recordType !== 'budget') {
          return rejectedWrite('The finance budget is invalid.');
        }
        const budget = record;

        if (budget.allocations.length !== 1) {
          return confirmationRequired(
            scope,
            'ambiguous-or-bulk-finance-write',
            {
              kind: mutation.kind,
              recordId: budget.id,
              month: budget.month,
              allocationCount: budget.allocations.length,
            },
          );
        }
        const command = durableCommand(
          scope,
          'monthly-category-budget-create',
          budgetPayload(budget),
        );
        try {
          const existing = asBudget(
            await dependencies.records.getOwnedBudgetForMonth({
              scope,
              month: budget.month,
            }),
            scope,
          );
          if (existing !== undefined && !sameBudgetCreate(existing, budget)) {
            return confirmationRequired(
              scope,
              'ambiguous-or-bulk-finance-write',
              {
                kind: mutation.kind,
                recordId: budget.id,
                month: budget.month,
                existingBudgetId: existing.id,
              },
            );
          }
          const receipt = validReceipt(
            await dependencies.records.createMonthlyCategoryBudget({
              ...command,
              record: budget,
            }),
            scope,
          );
          if (!sameBudgetMutation(budget, receipt.record)) {
            return unavailableWrite();
          }
          return deepFreeze({
            result: {
              status: receipt.status,
              record: summarizeRecord(receipt.record),
            },
          }) satisfies FinanceWriteResult;
        } catch {
          return unavailableWrite();
        }
      }

      if (mutation.replacement.recordType !== 'budget') {
        return confirmationRequired(scope, 'unsupported-finance-write', {
          kind: mutation.kind,
          recordType: mutation.replacement.recordType,
          recordId: mutation.recordId,
        });
      }
      try {
        const current = asBudget(
          await dependencies.records.getOwnedRecord({
            scope,
            recordId: mutation.recordId,
          }),
          scope,
        );
        if (current === undefined) {
          return rejectedWrite('The finance budget is unavailable.');
        }
        if (mutation.replacement.month !== current.month) {
          return confirmationRequired(
            scope,
            'ambiguous-or-bulk-finance-write',
            {
              kind: mutation.kind,
              recordId: current.id,
              expectedMonth: current.month,
              requestedMonth: mutation.replacement.month,
            },
          );
        }
        const timestamp = nowIso(dependencies.now);
        const nextResult = validateFinanceRecord({
          ...current,
          month: mutation.replacement.month,
          allocations: mutation.replacement.allocations,
          revision: current.revision + 1,
          updatedAt: timestamp,
        });
        if (
          nextResult.status !== 'accepted' ||
          nextResult.record.recordType !== 'budget'
        ) {
          return rejectedWrite('The finance budget is invalid.');
        }
        const next = nextResult.record;
        const change = budgetChangeKind(current, next);
        if (change === 'none') {
          return deepFreeze({
            result: {
              status: 'ignored' as const,
              record: summarizeRecord(current),
            },
          }) satisfies FinanceWriteResult;
        }
        if (change !== 'single-set') {
          return confirmationRequired(
            scope,
            'ambiguous-or-bulk-finance-write',
            {
              kind: mutation.kind,
              recordId: current.id,
              month: current.month,
            },
          );
        }
        const command = durableCommand(
          scope,
          'monthly-category-budget-update',
          {
            expectedRevision: current.revision,
            ...budgetPayload(next),
          },
        );
        const receipt = validReceipt(
          await dependencies.records.updateMonthlyCategoryBudget({
            ...command,
            current,
            record: next,
            expectedRevision: current.revision,
          }),
          scope,
        );
        if (!sameBudgetMutation(next, receipt.record))
          return unavailableWrite();
        return deepFreeze({
          result: {
            status: receipt.status,
            record: summarizeRecord(receipt.record),
          },
        }) satisfies FinanceWriteResult;
      } catch {
        return unavailableWrite();
      }
    };

  const executeStatementImport: TrustedFinanceSpecialistServices['executeStatementImport'] =
    async (
      request: FinanceStatementImportRequest,
      context,
    ): Promise<unknown> => {
      const scope = checkedScope(fixedPrincipal, context);
      if (context.guardedActionPermit === undefined) {
        return confirmationRequired(scope, 'finance-statement-import-commit', {
          planId: request.planId,
        }) satisfies FinanceStatementImportResult;
      }
      const permit = verifiedGuardedActionPermit({
        context,
        scope,
        capabilityId: 'finance.statement.import',
        operation: 'finance-statement-import-commit',
        arguments: { schemaVersion: 1, request },
        capabilityFingerprint:
          dependencies.guardedActionCapabilityFingerprints?.statementImport,
      });
      if (permit === undefined || dependencies.imports === undefined) {
        return unavailableImport();
      }
      try {
        const committed = FinanceImportCommitResponseSchema.safeParse(
          await dependencies.imports.commit({
            planId: request.planId,
            idempotencyKey: `finance-guarded:${permit.proposalId}`,
            principal: fixedPrincipal,
            requestId: scope.requestId,
          }),
        );
        if (
          !committed.success ||
          committed.data.receipt.planId !== request.planId
        ) {
          return unavailableImport();
        }
        return deepFreeze({
          result: {
            status: committed.data.status,
            receipt: committed.data.receipt,
            sourceDeletionAuthorized: committed.data.sourceDeletionAuthorized,
          },
        }) satisfies FinanceStatementImportResult;
      } catch {
        return unavailableImport();
      }
    };

  const loadFinanceBudgetInputs: TrustedFinanceSpecialistServices['loadFinanceBudgetInputs'] =
    async (input: FinanceBudgetRequest, context) => {
      const scope = checkedScope(fixedPrincipal, context);
      const month = z
        .string()
        .regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u)
        .parse(input.month);
      try {
        const transactions = await dependencies.records.listBudgetTransactions({
          scope,
          month,
          reviewedCommittedEvidenceOnly: true,
        });
        if (transactions.length > 100_000) {
          throw new Error('api-finance-specialist-budget-inputs-invalid');
        }
        return deepFreeze({
          spaceId: scope.privateSpaceId,
          transactions: transactions.map((transaction) => {
            const record = ownedRecord(transaction, scope);
            if (record.recordType !== 'transaction') {
              throw new Error('api-finance-specialist-budget-inputs-invalid');
            }
            return record;
          }),
        });
      } catch {
        throw new Error('api-finance-specialist-budget-inputs-unavailable');
      }
    };

  const searchFinanceDocuments: TrustedFinanceSpecialistServices['searchFinanceDocuments'] =
    async (input: FinanceDocumentSearchRequest, context) => {
      const scope = checkedScope(fixedPrincipal, context);
      try {
        const hits = await dependencies.documents.searchCommitted({
          scope,
          query: input.query,
          ...(input.documentTypes === undefined
            ? {}
            : { documentTypes: input.documentTypes }),
          ...(input.from === undefined ? {} : { from: input.from }),
          ...(input.to === undefined ? {} : { to: input.to }),
          limit: input.limit,
        });
        const parsed = z
          .array(FinanceDocumentSearchHitSchema)
          .max(25)
          .parse(hits);
        if (
          parsed.some((hit) =>
            hit.evidence.some(
              (evidence) =>
                evidence.documentId !== hit.documentId ||
                evidence.documentType !== hit.documentType,
            ),
          )
        ) {
          throw new Error('api-finance-specialist-document-search-invalid');
        }
        return deepFreeze({
          hits: parsed,
        });
      } catch {
        throw new Error('api-finance-specialist-document-search-unavailable');
      }
    };

  const readFinanceDocument: TrustedFinanceSpecialistServices['readFinanceDocument'] =
    async (input: FinanceDocumentReadRequest, context) => {
      const scope = checkedScope(fixedPrincipal, context);
      try {
        const result = await dependencies.documents.readCommitted({
          scope,
          documentId: input.documentId,
          evidenceIds: input.evidenceIds,
        });
        const parsed = FinanceDocumentReadResultSchema.parse(result);
        const requestedEvidence = new Set(input.evidenceIds);
        if (
          parsed.document.id !== input.documentId ||
          parsed.evidence.some(
            (evidence) =>
              evidence.documentId !== input.documentId ||
              !requestedEvidence.has(evidence.evidenceId),
          )
        ) {
          throw new Error('api-finance-specialist-document-read-invalid');
        }
        return deepFreeze(parsed);
      } catch {
        throw new Error('api-finance-specialist-document-read-unavailable');
      }
    };

  const readFinanceMatches: TrustedFinanceSpecialistServices['readFinanceMatches'] =
    async (input: FinanceMatchReadRequest, context) => {
      const scope = checkedScope(fixedPrincipal, context);
      try {
        const matches = z
          .array(FinanceDocumentMatchSchema)
          .max(50)
          .parse(
            await dependencies.documents.listCommittedMatches({
              scope,
              documentId: input.documentId,
              ...(input.states === undefined ? {} : { states: input.states }),
              limit: input.limit,
            }),
          );
        if (
          matches.length > input.limit ||
          matches.some(
            (match) =>
              match.documentId !== input.documentId ||
              (input.states !== undefined &&
                !input.states.includes(match.state)),
          )
        ) {
          throw new Error('api-finance-specialist-match-read-invalid');
        }
        return deepFreeze({ matches });
      } catch {
        throw new Error('api-finance-specialist-match-read-unavailable');
      }
    };

  const inspectFinanceReport: NonNullable<
    TrustedFinanceSpecialistServices['inspectFinanceReport']
  > = async (input, context) => {
    const scope = checkedScope(fixedPrincipal, context),
      repository = dependencies.normalizedBooks;
    if (!repository)
      throw new Error('api-finance-report-inspection-unavailable');
    const original = await repository.downloadBookEvidence(
      {
        workspaceId: scope.householdId,
        userId: scope.userId,
        sessionId: scope.sessionId,
        requestId: scope.requestId,
      },
      input.bookId,
      input.evidenceId,
    );
    if (
      original.format === 'pdf' &&
      (input.standardizationRunId != null || input.extractionRevision != null)
    ) {
      if (!input.standardizationRunId || input.extractionRevision == null)
        throw new Error('api-finance-pdf-ocr-extraction-required');
      if (input.tableId)
        throw new Error('api-finance-report-table-not-supported');
      const reader = dependencies.pdfOcrInspection;
      if (!reader)
        throw new Error('api-finance-pdf-ocr-inspection-unavailable');
      const originalPdf = z
        .object({ sourceBase64: z.string() })
        .parse(original);
      const bytes = Buffer.from(originalPdf.sourceBase64, 'base64');
      if (
        !bytes.length ||
        bytes.length > 2097152 ||
        bytes.toString('base64') !== originalPdf.sourceBase64
      )
        throw new Error('api-finance-report-source-integrity-invalid');
      const sourceDigest = createHash('sha256').update(bytes).digest('hex');
      const inspected = FinancePdfOcrInspectionSchema.parse(
        await reader.readPdfOcrInspection(
          {
            workspaceId: scope.householdId,
            userId: scope.userId,
            sessionId: scope.sessionId,
            requestId: scope.requestId,
          },
          input.bookId,
          input.evidenceId,
          {
            standardizationRunId: input.standardizationRunId,
            extractionRevision: input.extractionRevision,
          },
        ),
      );
      if (
        inspected.evidenceId !== input.evidenceId ||
        inspected.standardizationRunId !== input.standardizationRunId ||
        inspected.extractionRevision !== input.extractionRevision ||
        inspected.sourceDigest !== sourceDigest
      )
        throw new Error('api-finance-pdf-ocr-extraction-binding-invalid');
      if (scope.abortSignal.aborted)
        throw new Error('api-finance-specialist-request-binding-invalid');
      const selected = inspected.inventory.pages.find(
        (page) => page.pageNumber === input.pdfPage,
      );
      if (!selected) throw new Error('api-finance-pdf-ocr-page-unavailable');
      const pdfOcr = {
        standardizationRunId: inspected.standardizationRunId,
        extractionRevision: inspected.extractionRevision,
        extractionDigest: inspected.extractionDigest,
        sourceDigest,
        pageCount: inspected.inventory.pageCount,
        pages: inspected.inventory.pages.map((page) => ({
          pageNumber: page.pageNumber,
          kind: page.kind,
          reason: page.kind === 'unresolved' ? page.reason : null,
        })),
        selectedPage: selected.pageNumber,
        render: selected.kind === 'ocr' ? selected.result.render : null,
        complete: false as const,
        requiresVisualReview: true as const,
      };
      if (selected.kind !== 'ocr')
        return {
          evidenceId: input.evidenceId,
          filename: String(original.filename),
          format: 'pdf',
          pdf: null,
          image: null,
          pdfOcr,
          tableId: null,
          sheet: null,
          dateSystem: null,
          tableCandidates: [],
          nextCandidateOffset: null,
          totalCandidates: 0,
          extractionIssues: [
            selected.kind === 'unresolved'
              ? 'Selected original page remains unresolved.'
              : 'Selected page has embedded text; inspect the original PDF without saved OCR identity for positioned native text.',
          ],
          cellProvenance: [],
          nextProvenanceOffset: null,
          headers: [],
          rows: [],
          nextOffset: null,
          totalRows: 0,
          sourceReference: `/api/v2/finance/books/${input.bookId}/evidence/${input.evidenceId}`,
        };
      const saved = {
        ...inspected,
        extractionDigest: createHash('sha256')
          .update(JSON.stringify(selected.result.ocr))
          .digest('hex'),
        facts: selected.result.ocr,
        wordInventoryDigest: createHash('sha256')
          .update(JSON.stringify(selected.result.ocr.words))
          .digest('hex'),
      };
      const facts = saved.facts,
        textOffset = input.imageTextOffset ?? 0,
        wordOffset = input.provenanceOffset ?? 0;
      const text = facts.text.slice(textOffset, textOffset + 4000);
      const words = facts.words
        .slice(wordOffset, wordOffset + 20)
        .map((word) => ({
          ...word,
          text: word.text.slice(0, 200),
          textLength: word.text.length,
          truncated: word.text.length > 200,
        }));
      return {
        evidenceId: input.evidenceId,
        filename: String(original.filename),
        format: 'pdf',
        pdfOcr,
        pdf: null,
        image: {
          standardizationRunId: saved.standardizationRunId,
          extractionRevision: saved.extractionRevision,
          extractionDigest: saved.extractionDigest,
          sourceDigest: selected.result.render.renderedImageDigest,
          wordInventoryDigest: saved.wordInventoryDigest,
          status: facts.status,
          qualityStatus: facts.qualityStatus,
          width: facts.width,
          height: facts.height,
          coordinateSpace: facts.coordinateSpace,
          engine: facts.engine,
          textBasis: facts.textBasis,
          text,
          textLength: facts.text.length,
          textOffset,
          nextTextOffset:
            textOffset + text.length < facts.text.length
              ? textOffset + text.length
              : null,
          words,
          totalWords: facts.words.length,
          wordOffset,
          nextWordOffset:
            wordOffset + words.length < facts.words.length
              ? wordOffset + words.length
              : null,
          complete: false,
          requiresVisualReview: true,
        },
        tableId: null,
        sheet: null,
        dateSystem: null,
        tableCandidates: [],
        nextCandidateOffset: null,
        totalCandidates: 0,
        extractionIssues: [
          ...facts.issues,
          'OCR coordinates and word page 1 refer to the derived raster; pdfOcr.selectedPage identifies the original PDF page. Review original regions; no table, mapping or whole-document coverage is approved.',
        ],
        cellProvenance: [],
        nextProvenanceOffset: null,
        headers: [],
        rows: [],
        nextOffset: null,
        totalRows: 0,
        sourceReference: `/api/v2/finance/books/${input.bookId}/evidence/${input.evidenceId}`,
      };
    }
    if (['png', 'jpeg', 'webp'].includes(original.format)) {
      if (input.tableId)
        throw new Error('api-finance-report-table-not-supported');
      if (!input.standardizationRunId || input.extractionRevision == null)
        throw new Error('api-finance-image-extraction-required');
      const reader = dependencies.imageInspection;
      if (!reader) throw new Error('api-finance-image-inspection-unavailable');
      const imageOriginal = z
        .object({
          format: z.enum(['png', 'jpeg', 'webp']),
          sourceBase64: z.string(),
        })
        .parse(original);
      const bytes = Buffer.from(imageOriginal.sourceBase64, 'base64');
      if (
        bytes.length === 0 ||
        bytes.length > 2097152 ||
        bytes.toString('base64') !== imageOriginal.sourceBase64
      )
        throw new Error('api-finance-report-source-integrity-invalid');
      const sourceDigest = createHash('sha256').update(bytes).digest('hex');
      const saved = FinanceImageInspectionSchema.parse(
        await reader.readImageInspection(
          {
            workspaceId: scope.householdId,
            userId: scope.userId,
            sessionId: scope.sessionId,
            requestId: scope.requestId,
          },
          input.bookId,
          input.evidenceId,
          {
            standardizationRunId: input.standardizationRunId,
            extractionRevision: input.extractionRevision,
          },
        ),
      );
      if (
        saved.evidenceId !== input.evidenceId ||
        saved.standardizationRunId !== input.standardizationRunId ||
        saved.extractionRevision !== input.extractionRevision ||
        saved.sourceDigest !== sourceDigest ||
        saved.facts.format !== imageOriginal.format ||
        createHash('sha256')
          .update(JSON.stringify(saved.facts.words))
          .digest('hex') !== saved.wordInventoryDigest
      )
        throw new Error('api-finance-image-extraction-binding-invalid');
      if (scope.abortSignal.aborted)
        throw new Error('api-finance-specialist-request-binding-invalid');
      const facts = saved.facts,
        textOffset = input.imageTextOffset ?? 0,
        wordOffset = input.provenanceOffset ?? 0;
      const text = facts.text.slice(textOffset, textOffset + 4000);
      const words = facts.words
        .slice(wordOffset, wordOffset + 20)
        .map((word) => ({
          ...word,
          text: word.text.slice(0, 200),
          textLength: word.text.length,
          truncated: word.text.length > 200,
        }));
      return {
        evidenceId: input.evidenceId,
        filename: String(original.filename),
        format: imageOriginal.format,
        pdf: null,
        image: {
          standardizationRunId: saved.standardizationRunId,
          extractionRevision: saved.extractionRevision,
          extractionDigest: saved.extractionDigest,
          sourceDigest,
          wordInventoryDigest: saved.wordInventoryDigest,
          status: facts.status,
          qualityStatus: facts.qualityStatus,
          width: facts.width,
          height: facts.height,
          coordinateSpace: facts.coordinateSpace,
          engine: facts.engine,
          textBasis: facts.textBasis,
          text,
          textLength: facts.text.length,
          textOffset,
          nextTextOffset:
            textOffset + text.length < facts.text.length
              ? textOffset + text.length
              : null,
          words,
          totalWords: facts.words.length,
          wordOffset,
          nextWordOffset:
            wordOffset + words.length < facts.words.length
              ? wordOffset + words.length
              : null,
          complete: false,
          requiresVisualReview: true,
        },
        tableId: null,
        sheet: null,
        dateSystem: null,
        tableCandidates: [],
        nextCandidateOffset: null,
        totalCandidates: 0,
        extractionIssues: [
          ...facts.issues,
          'OCR text requires review against the original image; no table or mapping is approved.',
        ],
        cellProvenance: [],
        nextProvenanceOffset: null,
        headers: [],
        rows: [],
        nextOffset: null,
        totalRows: 0,
        sourceReference: `/api/v2/finance/books/${input.bookId}/evidence/${input.evidenceId}`,
      };
    }
    if (
      input.standardizationRunId != null ||
      input.extractionRevision != null ||
      (input.imageTextOffset ?? 0) !== 0
    )
      throw new Error('api-finance-image-extraction-input-invalid');
    if (original.format === 'ofx' || original.format === 'qfx') {
      if (input.tableId)
        throw new Error('api-finance-report-table-not-supported');
      const source = z
        .object({ sourceText: z.string().min(1).max(2097152) })
        .parse(original);
      const ofx = inspectFinanceOfxSource(
        source.sourceText,
        original.format,
        input.offset,
        input.provenanceOffset,
      );
      if (scope.abortSignal.aborted)
        throw new Error('api-finance-specialist-request-binding-invalid');
      return {
        evidenceId: input.evidenceId,
        filename: original.filename,
        format: original.format,
        ofx,
        image: null,
        pdf: null,
        tableId: null,
        sheet: null,
        dateSystem: null,
        tableCandidates: [],
        nextCandidateOffset: null,
        totalCandidates: 0,
        extractionIssues: ofx.issues,
        cellProvenance: [],
        nextProvenanceOffset: null,
        headers: [],
        rows: [],
        nextOffset: null,
        totalRows: 0,
        sourceReference: `/api/v2/finance/books/${input.bookId}/evidence/${input.evidenceId}`,
      };
    }
    if (original.format === 'pdf') {
      if (input.tableId)
        throw new Error('api-finance-report-table-not-supported');
      const sourceBytes = Buffer.from(original.sourceBase64, 'base64');
      if (
        sourceBytes.toString('base64') !== original.sourceBase64 ||
        sourceBytes.length > 2097152
      )
        throw new Error('api-finance-report-source-integrity-invalid');
      const sourceDigest = createHash('sha256')
        .update(sourceBytes)
        .digest('hex');
      const extraction = await extractFinancePdfReport(sourceBytes, {
        signal: scope.abortSignal,
        limits: { maxBytes: 2097152 },
      });
      if (scope.abortSignal.aborted)
        throw new Error('api-finance-specialist-request-binding-invalid');
      const parsed = extraction.status === 'unavailable' ? null : extraction;
      const page = parsed?.pages.find((page) => page.page === input.pdfPage);
      if (parsed && !page) throw new Error('api-finance-report-page-not-found');
      const text =
        page?.text.slice(input.pdfTextOffset, input.pdfTextOffset + 4000) ?? '';
      const spans =
        page?.spans
          .slice(input.provenanceOffset, input.provenanceOffset + 20)
          .map((span) => ({
            ...span,
            text: span.text.slice(0, 200),
            textLength: span.text.length,
            truncated: span.text.length > 200,
          })) ?? [];
      return {
        evidenceId: input.evidenceId,
        filename: String(original.filename),
        format: 'pdf',
        pdf: {
          sourceDigest,
          status: extraction.status,
          reason:
            extraction.status === 'unavailable' ? extraction.reason : null,
          totalPages: parsed?.totalPages ?? null,
          pages:
            parsed?.pages.map(
              ({ page, width, height, rotation, textStatus, text, spans }) => ({
                page,
                width,
                height,
                rotation,
                textStatus,
                textLength: text.length,
                spanCount: spans.length,
              }),
            ) ?? [],
          selectedPage: page?.page ?? null,
          text,
          textOffset: input.pdfTextOffset,
          nextTextOffset:
            page && input.pdfTextOffset + text.length < page.text.length
              ? input.pdfTextOffset + text.length
              : null,
          spans,
          nextSpanOffset:
            page && input.provenanceOffset + spans.length < page.spans.length
              ? input.provenanceOffset + spans.length
              : null,
          totalSpans: page?.spans.length ?? null,
        },
        tableId: null,
        sheet: null,
        dateSystem: null,
        tableCandidates: [],
        nextCandidateOffset: null,
        totalCandidates: 0,
        extractionIssues: parsed?.issues ?? [
          extraction.status === 'unavailable'
            ? `pdf-extraction-${extraction.reason}`
            : 'pdf-extraction-unavailable',
        ],
        cellProvenance: [],
        nextProvenanceOffset: null,
        headers: [],
        rows: [],
        nextOffset: null,
        totalRows: 0,
        sourceReference: `/api/v2/finance/books/${input.bookId}/evidence/${input.evidenceId}`,
      };
    }
    if (original.format !== 'csv' && original.format !== 'xlsx')
      throw new Error('api-finance-report-format-not-supported');
    const workbook =
      original.format === 'xlsx'
        ? extractFinanceXlsxTables(Buffer.from(original.sourceBase64, 'base64'))
        : null;
    const candidates = workbook?.tables ?? [];
    const selected = workbook
      ? input.tableId
        ? candidates.find((candidate) => candidate.tableId === input.tableId)
        : candidates.length === 1
          ? candidates[0]
          : undefined
      : undefined;
    if (
      input.tableId &&
      (workbook ? !selected : input.tableId !== 'csv-table-1')
    )
      throw new Error('api-finance-report-table-not-found');
    const table =
      original.format === 'csv'
        ? extractFinanceCsvTable(original.sourceText)
        : (selected ?? { headers: [], rows: [] });
    const candidateOffset = input.candidateOffset ?? 0;
    const provenanceOffset = input.provenanceOffset ?? 0;
    const cellProvenance = (selected?.cellProvenance ?? [])
      .slice(provenanceOffset, provenanceOffset + 20)
      .map((cell) => {
        const clip = (value: string | null) => value?.slice(0, 120) ?? null;
        const attributes = Object.entries(cell.formulaAttributes ?? {});
        return {
          ...cell,
          raw: clip(cell.raw),
          value: clip(cell.value),
          numberFormat: clip(cell.numberFormat),
          formula: clip(cell.formula),
          formulaAttributes: attributes.slice(0, 8).map(([name, value]) => ({
            name: name.slice(0, 80),
            value: value.slice(0, 120),
          })),
          truncated:
            [cell.raw, cell.value, cell.numberFormat, cell.formula].some(
              (value) => (value?.length ?? 0) > 120,
            ) ||
            attributes.length > 8 ||
            attributes.some(
              ([name, value]) => name.length > 80 || value.length > 120,
            ),
        };
      });
    const cellLimit = Math.max(
      16,
      Math.min(120, Math.floor(8000 / (table.headers.length * 5))),
    );
    const rows = table.rows
      .slice(input.offset, input.offset + 5)
      .map((row) => ({
        sourceRow: row.sourceRow,
        cells: row.cells.map((cell) => cell.slice(0, cellLimit)),
        truncated: row.cells.some((cell) => cell.length > cellLimit),
      }));
    if (scope.abortSignal.aborted)
      throw new Error('api-finance-specialist-request-binding-invalid');
    return {
      evidenceId: input.evidenceId,
      filename: String(original.filename),
      format: original.format,
      pdf: null,
      tableId:
        original.format === 'csv' ? 'csv-table-1' : (selected?.tableId ?? null),
      sheet: original.format === 'csv' ? 'CSV' : (selected?.sheet ?? null),
      dateSystem: workbook?.dateSystem ?? null,
      tableCandidates: candidates
        .slice(candidateOffset, candidateOffset + 20)
        .map((candidate) => ({
          tableId: candidate.tableId,
          sheet: candidate.sheet,
          range: candidate.range,
          headerRow: candidate.headerRow,
          totalRows: candidate.rows.length,
          issues: candidate.issues,
        })),
      nextCandidateOffset:
        candidateOffset + 20 < candidates.length ? candidateOffset + 20 : null,
      totalCandidates: workbook ? candidates.length : 1,
      extractionIssues: [
        ...(workbook?.issues ?? []),
        ...(selected?.issues ?? []),
        ...(table.headers.some((header) => header.length > 200)
          ? ['header-preview-truncated']
          : []),
        ...(workbook && !selected ? ['explicit-table-selection-required'] : []),
      ],
      cellProvenance,
      nextProvenanceOffset:
        provenanceOffset + cellProvenance.length <
        (selected?.cellProvenance.length ?? 0)
          ? provenanceOffset + cellProvenance.length
          : null,
      headers: table.headers.map((header) => header.slice(0, 200)),
      rows,
      nextOffset:
        input.offset + rows.length < table.rows.length
          ? input.offset + rows.length
          : null,
      totalRows: table.rows.length,
      sourceReference: `/api/v2/finance/books/${input.bookId}/evidence/${input.evidenceId}`,
    };
  };
  const proposeFinanceReportMapping: NonNullable<
    TrustedFinanceSpecialistServices['proposeFinanceReportMapping']
  > = async (input, context) => {
    const scope = checkedScope(fixedPrincipal, context),
      repository = dependencies.normalizedBooks;
    if (!repository) throw new Error('api-finance-report-proposal-unavailable');
    const workspace = {
      workspaceId: scope.householdId,
      userId: scope.userId,
      sessionId: scope.sessionId,
      requestId: scope.requestId,
    };
    const original = await repository.downloadBookEvidence(
      workspace,
      input.bookId,
      input.evidenceId,
    );
    if (original.format === 'pdf') {
      if (!input.proposal.definition.pdfSelection || input.tableId)
        throw new Error('api-finance-pdf-source-selection-required');
      const proposal = {
        ...input.proposal,
        unresolvedQuestions: [
          ...new Set([
            `PDF page ${input.proposal.definition.pdfSelection.page} whole-span selection, field meanings and omitted content require explicit source review. Selection confirmation fields do not grant approval.`,
            ...input.proposal.unresolvedQuestions,
          ]),
        ],
      };
      if (proposal.unresolvedQuestions.length > 30)
        throw new Error('api-finance-report-unresolved-question-limit');
      if (scope.abortSignal.aborted)
        throw new Error('api-finance-specialist-request-binding-invalid');
      // A model can propose selection facts, never supply authoritative extracted
      // table cells or approve their use. The repository reloads and re-extracts.
      const result = await repository.saveReportMapping(
        workspace,
        input.bookId,
        'mapping:' +
          hashCanonicalJson({
            idempotencyScope: scope.invocationIdempotencyScope,
            evidenceId: input.evidenceId,
            proposal,
          }),
        { evidenceId: input.evidenceId, proposal },
        'gpt-6-astra',
        {
          runId: scope.runId,
          agentInvocationId: scope.agentInvocationId,
          phaseInvocationId: scope.phaseInvocationId,
        },
      );
      return {
        id: result.id,
        version: result.version,
        revision: result.revision,
        status: result.status,
        validationStatus: result.validationStatus,
        unresolvedQuestions: proposal.unresolvedQuestions,
        sourceReference: `/api/v2/finance/books/${input.bookId}/report-mappings/${String(result.id)}`,
      };
    }
    if (original.format !== 'csv' && original.format !== 'xlsx')
      throw new Error('api-finance-report-format-not-supported');
    const workbook =
      original.format === 'xlsx'
        ? extractFinanceXlsxTables(Buffer.from(original.sourceBase64, 'base64'))
        : null;
    if (workbook && !input.tableId && workbook.tables.length !== 1)
      throw new Error('api-finance-report-table-selection-required');
    const selected = workbook?.tables.find((table) =>
      input.tableId ? table.tableId === input.tableId : true,
    );
    if (
      (workbook && !selected) ||
      (!workbook && input.tableId && input.tableId !== 'csv-table-1')
    )
      throw new Error('api-finance-report-table-not-found');
    const table =
      original.format === 'csv'
        ? extractFinanceCsvTable(original.sourceText)
        : selected!;
    if (selected?.issues.includes('ambiguous-headings') || !table.rows.length)
      throw new Error('api-finance-report-table-headings-or-rows-unavailable');
    const extractionQuestions = selected
      ? [
          `XLSX source region ${selected.sheet}!${selected.range} and header row ${selected.headerRow} are tentative and require source review.`,
          `XLSX dates remain original serial or text values (workbook date system ${workbook!.dateSystem}); currency, units and number formats require explicit source interpretation.`,
          ...(selected.cellProvenance.some((cell) => cell.formula !== null)
            ? [
                'XLSX formula caches are unverified source snapshots; missing caches are unavailable and no formulas were calculated.',
              ]
            : []),
        ]
      : [];
    const proposal = {
      ...input.proposal,
      unresolvedQuestions: [
        ...new Set([
          ...extractionQuestions,
          ...input.proposal.unresolvedQuestions,
        ]),
      ],
    };
    if (proposal.unresolvedQuestions.length > 30)
      throw new Error('api-finance-report-unresolved-question-limit');
    // No model-controlled example cells or default currency/date enter this payload.
    const example = {
      documentId: input.evidenceId,
      extractionRevision: 1,
      tableId: selected?.tableId ?? 'csv-table-1',
      page: null,
      sheet: selected?.sheet ?? 'CSV',
      providerKey: input.proposal.definition.providerKey,
      reportType: input.proposal.definition.reportType,
      headers: table.headers,
      context: { asOf: null, currency: null },
      rows: table.rows,
    };
    if (scope.abortSignal.aborted)
      throw new Error('api-finance-specialist-request-binding-invalid');
    const lineage = {
      runId: scope.runId,
      agentInvocationId: scope.agentInvocationId,
      phaseInvocationId: scope.phaseInvocationId,
    };
    const key =
      'mapping:' +
      hashCanonicalJson({
        idempotencyScope: scope.invocationIdempotencyScope,
        evidenceId: input.evidenceId,
        tableId: example.tableId,
        proposal,
      });
    const result =
      original.format === 'csv'
        ? await repository.saveSourceReportMapping(
            workspace,
            input.bookId,
            key,
            {
              evidenceId: input.evidenceId,
              expectedSourceDigest: createHash('sha256')
                .update(original.sourceText)
                .digest('hex'),
              proposal,
            },
            'gpt-6-astra',
            lineage,
          )
        : await repository.saveReportMapping(
            workspace,
            input.bookId,
            key,
            { proposal, example },
            'gpt-6-astra',
            lineage,
          );
    return {
      id: result.id,
      version: result.version,
      revision: result.revision,
      status: result.status,
      validationStatus: result.validationStatus,
      unresolvedQuestions: proposal.unresolvedQuestions,
      sourceReference: `/api/v2/finance/books/${input.bookId}/report-mappings/${String(result.id)}`,
    };
  };

  const readFinanceTax: NonNullable<
    TrustedFinanceSpecialistServices['readFinanceTax']
  > = async (raw, context) => {
    const scope = checkedScope(fixedPrincipal, context),
      input = FinanceTaxReadInputSchema.parse(raw),
      repository = dependencies.taxCases;
    if (!repository) throw new Error('api-finance-tax-unavailable');
    const workspace = {
      workspaceId: scope.householdId,
      userId: scope.userId,
      sessionId: scope.sessionId,
      requestId: scope.requestId,
    };
    type Row = {
      id: string;
      kind: z.infer<
        typeof FinanceTaxReadOutputSchema
      >['records'][number]['kind'];
      fields: { name: string; value: string | null }[];
    };
    // Private identities and wage-document payloads stay in human intake/export. Apply at
    // serialization so nested reviewed/withdrawn answers cannot bypass this.
    const modelSafeTaxValue = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(modelSafeTaxValue);
      if (value === null || typeof value !== 'object') return value;
      const record = value as Record<string, unknown>;
      const key = record.factKey ?? record.key;
      const privateFact =
        typeof key === 'string' &&
        (key.startsWith('identity.') ||
          key.startsWith('businessIdentity.') ||
          key.startsWith('wageEvidence.') ||
          [
            'business.separateName',
            'business.ein',
            'business.street',
            'business.cityStateZip',
            'refund.routing',
            'refund.account',
          ].includes(key));
      return Object.fromEntries(
        Object.entries(record).map(([name, item]) => [
          name,
          privateFact && name === 'value'
            ? { redacted: true }
            : modelSafeTaxValue(item),
        ]),
      );
    };
    const row = (id: string, kind: Row['kind'], data: object): Row => ({
      id,
      kind,
      fields: Object.entries(modelSafeTaxValue(data) as object).map(
        ([name, value]) => ({
          name,
          value:
            value == null
              ? null
              : typeof value === 'string'
                ? value
                : JSON.stringify(value),
        }),
      ),
    });
    let records: Row[],
      nextOffset: number | null = null,
      status: 'incomplete' | 'ready-for-calculation' = 'incomplete',
      truncated = false,
      snapshotRevision: number | null = null,
      snapshotHash: string | null = null;
    if (input.view === 'runs' || input.view === 'run') {
      const runs = dependencies.taxCalculationRuns;
      if (!runs) throw new Error('api-finance-tax-runs-unavailable');
      if (input.view === 'runs') {
        const values = z
          .array(FinanceTaxCalculationRunSummarySchema)
          .max(input.limit)
          .parse(
            await runs.listCalculationRuns(
              workspace,
              input.caseId!,
              input.offset,
              input.limit,
            ),
          );
        if (
          values.some((v) => v.caseId !== input.caseId) ||
          new Set(values.map((v) => v.runId)).size !== values.length ||
          new Set(values.map((v) => v.taxSubjectId)).size > 1
        )
          throw new Error('api-finance-tax-run-binding-invalid');
        records = values.map((v) => row(v.runId, 'run-summary', v));
        nextOffset =
          values.length === input.limit ? input.offset + input.limit : null;
      } else {
        const detail = FinanceTaxCalculationRunDetailSchema.parse(
          await runs.getCalculationRun(workspace, input.caseId!, input.runId!),
        );
        const {
          summary,
          inputBinding,
          output,
          schedules,
          reviews,
          authorities,
        } = detail;
        if (
          summary.caseId !== input.caseId ||
          summary.runId !== input.runId ||
          summary.snapshotRevision !== inputBinding.snapshotRevision ||
          summary.snapshotHash !== inputBinding.snapshotHash ||
          (summary.status === 'blocked-input') !==
            (output.status === 'blocked') ||
          new Set(schedules.map((s) => s.formId)).size !== schedules.length ||
          reviews.some((r) => r.outputHash !== summary.outputHash) ||
          schedules.some(
            (s) =>
              hashCanonicalJson(s.content) !== s.contentHash ||
              s.content.some((c) => c.field.form !== s.formId),
          )
        )
          throw new Error('api-finance-tax-run-binding-invalid');
        const fields = schedules.flatMap((s) =>
          s.content.map((c) => ({ ...c, contentHash: s.contentHash })),
        );
        if (
          new Set(fields.map((c) => c.ordinal)).size !== fields.length ||
          new Set(fields.map((c) => c.field.id)).size !== fields.length
        )
          throw new Error('api-finance-tax-run-fields-invalid');
        snapshotRevision = summary.snapshotRevision;
        snapshotHash = summary.snapshotHash;
        const { issues, releaseBlockers, ...header } = output;
        records = [
          row(summary.runId, 'run-summary', summary),
          row(`${summary.runId}:output`, 'run-output', header),
          ...issues.map((v, i) =>
            row(`${summary.runId}:issue:${i}`, 'run-issue', v),
          ),
          ...releaseBlockers.map((message, i) =>
            row(`${summary.runId}:blocker:${i}`, 'run-blocker', { message }),
          ),
          ...fields
            .sort((a, b) => a.ordinal - b.ordinal)
            .map((v) =>
              row(`${summary.runId}:field:${v.ordinal}`, 'run-field', {
                ...v.field,
                contentHash: v.contentHash,
              }),
            ),
          ...reviews.map((v) =>
            row(`${summary.runId}:review:${v.reviewId}`, 'run-review', v),
          ),
          ...authorities.map((v, i) =>
            row(`${summary.runId}:authority:${i}`, 'run-authority', v),
          ),
          ...inputBinding.declarations.map((v, i) =>
            row(`${summary.runId}:declaration:${i}`, 'run-input-binding', {
              kind: 'declaration',
              ...v,
            }),
          ),
          ...inputBinding.inputReviews.map((v, i) =>
            row(`${summary.runId}:input-review:${i}`, 'run-input-binding', {
              kind: 'input-review',
              ...v,
            }),
          ),
          ...inputBinding.sourceBooks.map((v, i) =>
            row(`${summary.runId}:book:${i}`, 'run-input-binding', {
              kind: 'book-snapshot',
              ...v,
            }),
          ),
        ];
        nextOffset =
          input.offset + input.limit < records.length
            ? input.offset + input.limit
            : null;
        records = records.slice(input.offset, input.offset + input.limit);
        if (
          records.some((r) =>
            r.fields.some((f) => f.value !== null && f.value.length > 24000),
          )
        )
          throw new Error('api-finance-tax-run-record-too-large');
      }
    } else if (input.view === 'list') {
      // The repository filters private tax-case grants under RLS. Book access is
      // never consulted or substituted for tax-case permission.
      const cases = z
        .array(
          z.strictObject({
            caseId: UuidSchema,
            taxSubjectId: UuidSchema,
            title: z.string(),
            revision: z.number().int().positive(),
            status: z.literal('incomplete'),
            taxSubjectName: z.string(),
            caseRole: z.enum(['owner', 'preparer', 'reviewer', 'viewer']),
          }),
        )
        .max(input.limit)
        .parse(
          await repository.listCases(workspace, input.offset, input.limit),
        );
      records = cases.map((value) => row(value.caseId, 'case-summary', value));
      // The current repository returns no total. A full page requires another
      // read; never infer completeness from an unreturned estimated count.
      nextOffset =
        cases.length === input.limit ? input.offset + input.limit : null;
    } else if (input.view === 'read') {
      const saved =
        input.revision === undefined
          ? await repository.getCase(workspace, input.caseId!)
          : await repository.getCase(workspace, input.caseId!, input.revision);
      if (saved.caseId !== input.caseId)
        throw new Error('api-finance-tax-case-binding-invalid');
      const questionnaire = FinanceTaxQuestionnaireSchema.parse(
        saved.questionnaire,
      );
      if (
        questionnaire.intake.caseId !== input.caseId ||
        questionnaire.intake.workspaceId !== scope.householdId ||
        questionnaire.intake.taxSubjectId !== saved.taxSubjectId
      )
        throw new Error('api-finance-tax-case-binding-invalid');
      snapshotHash = Sha256Schema.parse(saved.snapshotHash);
      snapshotRevision = questionnaire.intake.revision;
      if (input.revision !== undefined && snapshotRevision !== input.revision)
        throw new Error('api-finance-tax-snapshot-binding-invalid');
      const declaredInputs = z
        .array(FinanceTaxDeclaredInputSchema)
        .max(100000)
        .parse(saved.declaredInputs);
      const declarationBindingStatus =
        FinanceTaxDeclarationBindingStatusSchema.parse(
          saved.declarationBindingStatus,
        );
      const bindings = questionnaire.declarationSourceBindings;
      if (
        declarationBindingStatus !==
          (bindings === undefined ? 'legacy-unbound' : 'bound') ||
        declaredInputs.length !== (bindings?.length ?? 0) ||
        new Set(declaredInputs.map((value) => value.sourceId)).size !==
          declaredInputs.length ||
        declaredInputs.some(
          (value) =>
            !bindings?.some(
              (binding) =>
                binding.sourceId === value.sourceId &&
                binding.sourceRevision === value.sourceRevision &&
                binding.contentHash === value.contentHash,
            ),
        )
      ) {
        throw new Error('api-finance-tax-declaration-binding-invalid');
      }
      records = [
        row(saved.caseId, 'case', {
          caseId: saved.caseId,
          taxSubjectId: saved.taxSubjectId,
          currentRevision: saved.currentRevision,
          caseRole: saved.caseRole,
          declarationBindingStatus,
          snapshotHash: saved.snapshotHash,
          status: 'incomplete',
          binding: questionnaire.binding,
          intake: { ...questionnaire.intake, facts: undefined },
          sourceAuthorizationBindings:
            questionnaire.sourceAuthorizationBindings,
        }),
        ...declaredInputs.map((value) =>
          row(
            `declaration:${value.sourceId}:${value.sourceRevision}`,
            'declared-input',
            { ...value, sourceReference: `declaration:${value.sourceId}` },
          ),
        ),
        ...questionnaire.intake.facts.map((value, i) =>
          row(`${saved.caseId}:intake-fact:${i}`, 'intake-fact', value),
        ),
        ...questionnaire.questions.map((value, i) =>
          row(`${saved.caseId}:question:${i}`, 'question', value),
        ),
        ...questionnaire.answers.map((value, i) =>
          row(`${saved.caseId}:answer:${i}`, 'answer', value),
        ),
        ...questionnaire.withdrawnAnswers.map((value, i) =>
          row(`${saved.caseId}:withdrawn:${i}`, 'withdrawn-answer', value),
        ),
        ...questionnaire.relatedParties.map((value, i) =>
          row(`${saved.caseId}:party:${i}`, 'related-party', value),
        ),
      ];
      nextOffset =
        input.offset + input.limit < records.length
          ? input.offset + input.limit
          : null;
      records = records.slice(input.offset, input.offset + input.limit);
    } else {
      // assessCase reacquires explicit case/source permission and invokes the
      // deterministic questionnaire registry; no model-supplied rules or facts.
      const assessment = await repository.assessCase(workspace, input.caseId!);
      if (
        assessment.complete !== false ||
        !['incomplete', 'ready-for-calculation'].includes(assessment.status)
      )
        throw new Error('api-finance-tax-assessment-invalid');
      if (assessment.caseId !== input.caseId)
        throw new Error('api-finance-tax-case-binding-invalid');
      UuidSchema.parse(assessment.taxSubjectId);
      snapshotRevision = z
        .number()
        .int()
        .positive()
        .parse(assessment.snapshotRevision);
      snapshotHash = Sha256Schema.parse(assessment.snapshotHash);
      status = assessment.status;
      records = [
        ...assessment.issues.map((value, i) =>
          row(`${input.caseId}:issue:${i}`, 'assessment-issue', value),
        ),
        ...assessment.questions.map((value, i) =>
          row(`${input.caseId}:question:${i}`, 'question', value),
        ),
      ];
      nextOffset =
        input.offset + input.limit < records.length
          ? input.offset + input.limit
          : null;
      records = records.slice(input.offset, input.offset + input.limit);
    }
    if (nextOffset !== null && nextOffset > 100000) {
      nextOffset = null;
      truncated = true;
    }
    scope.abortSignal.throwIfAborted();
    return deepFreeze(
      FinanceTaxReadOutputSchema.omit({ schemaVersion: true }).parse({
        view: input.view,
        caseId: input.caseId,
        status,
        complete: false,
        records,
        nextOffset,
        sourceReferences:
          input.view === 'runs'
            ? records.map(
                (v) => `/api/v2/finance/tax/cases/${input.caseId}/runs/${v.id}`,
              )
            : input.view === 'run'
              ? [
                  `/api/v2/finance/tax/cases/${input.caseId}/runs/${input.runId}`,
                ]
              : input.caseId
                ? [`/api/v2/finance/tax/cases/${input.caseId}`]
                : records.map(
                    (value) => `/api/v2/finance/tax/cases/${value.id}`,
                  ),
        truncated,
        snapshotRevision,
        snapshotHash,
        coverage:
          input.view === 'runs' || input.view === 'run'
            ? 'private-tax-working-papers'
            : 'private-tax-case-snapshot',
      }),
    );
  };
  const readFinanceBooks: NonNullable<
    TrustedFinanceSpecialistServices['readFinanceBooks']
  > = async (input, context) => {
    const scope = checkedScope(fixedPrincipal, context),
      repository = dependencies.normalizedBooks;
    if (!repository) throw new Error('api-finance-books-unavailable');
    // Identity always comes from the request-bound principal, never model arguments.
    const workspace = {
      workspaceId: scope.householdId,
      userId: scope.userId,
      sessionId: scope.sessionId,
      requestId: scope.requestId,
    };
    if (input.view !== 'books' && !input.bookId)
      throw new Error('api-finance-book-required');
    if (
      [
        'investment-reconciliation',
        'investment-reconciliation-history',
      ].includes(input.view) !==
      (input.reconciliationCaseId != null)
    )
      throw new Error('api-finance-reconciliation-input-invalid');
    if (
      [
        'journal-draft',
        'journal-draft-lines',
        'journal-draft-history',
      ].includes(input.view) !==
      (input.journalDraftId != null)
    )
      throw new Error('api-finance-journal-draft-input-invalid');
    if ((input.view === 'automation-run') !== (input.automationRunId != null))
      throw new Error('api-finance-automation-run-input-invalid');
    if ((input.view === 'planning-result') !== (input.planningResultId != null))
      throw new Error('api-finance-planning-result-input-invalid');
    if (
      (input.view === 'standardization-run' ||
        input.view === 'standardization-reconciliation') !==
      (input.standardizationRunId != null)
    )
      throw new Error('api-finance-standardization-run-input-invalid');
    if (
      (input.view === 'budget' || input.view === 'budget-vs-actuals') !==
        (input.budgetId != null) ||
      (input.view === 'forecast') !== (input.forecastId != null) ||
      (input.planningRevision != null &&
        !['budget', 'budget-vs-actuals', 'forecast'].includes(input.view))
    )
      throw new Error('api-finance-planning-input-invalid');
    if ((input.view === 'cash-dividend') !== (input.dividendId != null))
      throw new Error('api-finance-dividend-input-invalid');
    if (
      (input.view === 'corporate-action-settlement') !==
      (input.settlementId != null)
    )
      throw new Error('api-finance-settlement-input-invalid');
    if ((input.view === 'generated-report') !== (input.reportId != null))
      throw new Error('api-finance-report-input-invalid');
    if (input.view === 'import-review' && !input.importId)
      throw new Error('api-finance-import-required');
    if ((input.view === 'valuation') !== (input.valuationId !== null))
      throw new Error('api-finance-valuation-input-invalid');
    if (input.view === 'books' && (input.bookId || input.importId))
      throw new Error('api-finance-books-input-invalid');
    if (input.view !== 'import-review' && input.importId)
      throw new Error('api-finance-books-input-invalid');
    let records: readonly Record<string, unknown>[],
      currency: string | null = null;
    let repositoryPage: { nextOffset: number | null } | undefined;
    if (input.view === 'corporate-action-settlement') {
      if (
        typeof repository.checkStockSplitSettlementReady !== 'function' ||
        typeof repository.getInvestmentStockSplitSettlement !== 'function' ||
        !(await repository.checkStockSplitSettlementReady().catch(() => false))
      )
        throw new Error('api-finance-settlement-unavailable');
      const raw = await repository.getInvestmentStockSplitSettlement(
        workspace,
        input.bookId!,
        input.settlementId!,
      );
      if (raw === null) throw new Error('api-finance-settlement-not-found');
      const saved = SavedFinanceStockSplitSettlementSchema.parse(raw);
      const { settlement, result } = saved;
      if (
        result.workspaceId !== workspace.workspaceId ||
        result.bookId !== input.bookId ||
        result.settlementId !== input.settlementId ||
        result.actionId !== settlement.actionId
      )
        throw new Error('api-finance-settlement-scope-invalid');
      currency = settlement.functionalCurrency;
      records = [
        {
          id: result.settlementId,
          recordType: 'committed-corporate-action-settlement',
          actionId: result.actionId,
          financialAccountId: settlement.financialAccountId,
          instrumentId: settlement.instrumentId,
          effectiveOn: settlement.effectiveOn,
          settledOn: settlement.settledOn,
          createdAt: saved.createdAt,
          status: result.status,
          accountEntitlement: settlement.accountEntitlement,
          deliveredQuantity: settlement.deliveredQuantity,
          cashDisposedQuantity: settlement.cashDisposedQuantity,
          nativeCurrency: settlement.nativeCurrency,
          functionalCurrency: settlement.functionalCurrency,
          retainedNativeCost: settlement.retainedNativeCost,
          retainedFunctionalCost: settlement.retainedFunctionalCost,
          disposedNativeCost: settlement.disposedNativeCost,
          disposedFunctionalCost: settlement.disposedFunctionalCost,
          nativeCashConsideration: settlement.cashConsideration.native.amount,
          functionalCashConsideration:
            settlement.cashConsideration.functional.amount,
          nativeBookGainLoss: settlement.nativeBookGainLoss,
          actionDateFunctionalConsideration:
            saved.accounting.actionDateFunctionalConsideration,
          settlementDateFunctionalConsideration:
            saved.accounting.settlementDateFunctionalConsideration,
          functionalBookGainLoss: saved.accounting.bookGainLoss,
          functionalFxGainLoss: saved.accounting.fxGainLoss,
          journalIds: result.journalIds,
          economicTransactionId: result.economicTransactionId,
          considerationEvidenceId: settlement.cashConsideration.evidenceId,
          allocationEvidenceId: settlement.allocationReview.evidenceId,
          allocationCount: settlement.allocations.length,
          taxTreatment: settlement.taxTreatment,
          coverage: 'saved-settlement-and-reviewed-book-allocations',
        },
        ...settlement.allocations.map((allocation) => ({
          id: `${result.settlementId}:lot:${allocation.sourceLotId}`,
          recordType: 'corporate-action-settlement-lot-allocation',
          ...allocation,
        })),
      ];
    } else if (input.view === 'fec-mapping') {
      const fec = dependencies.fec;
      if (!fec || !(await fec.checkReady().catch(() => false)))
        throw new Error('api-finance-fec-unavailable');
      // The scoped repository authorizes book access even when no revision exists.
      const raw = await fec.getLatest(workspace, input.bookId!);
      const mapping =
        raw === null ? null : FinanceFecMappingResponseSchema.parse(raw);
      if (
        mapping &&
        (mapping.workspaceId !== workspace.workspaceId ||
          mapping.bookId !== input.bookId ||
          mapping.revision !== mapping.mapping.expectedRevision)
      )
        throw new Error('api-finance-fec-scope-invalid');
      records = [
        {
          id: `fec-mapping:${mapping?.revision ?? 'missing'}`,
          recordType: 'reviewed-fec-mapping-summary',
          serviceReady: true,
          mappingStatus: mapping ? 'reviewed' : 'missing',
          mappingRevision: mapping?.revision ?? null,
          reviewedAt: mapping?.reviewedAt ?? null,
          journalMappingCount: mapping?.mapping.journals.length ?? 0,
          accountMappingCount: mapping?.mapping.accounts.length ?? 0,
          openingBalancesStatus:
            mapping?.mapping.openingBalances.status ?? null,
          sirenSourceDigest: mapping?.mapping.sirenSource.sourceDigest ?? null,
          openingBalancesSourceDigest:
            mapping?.mapping.openingBalances.source.sourceDigest ?? null,
          exportReadiness: 'not-checked',
          coverage: 'latest-reviewed-mapping-summary-only',
          workflow:
            'User must explicitly request an export through the FEC API; a reviewed mapping does not prove export readiness or legal completeness.',
          mappingApi: `/api/v2/finance/books/${input.bookId}/fec/mappings/latest`,
          exportApi: `/api/v2/finance/books/${input.bookId}/fec/exports`,
        },
      ];
    } else if (planningReadViews.has(input.view)) {
      if (!dependencies.planning)
        throw new Error('api-finance-planning-unavailable');
      const result = await readFinancePlanning(
        dependencies.planning,
        workspace,
        { ...input, bookId: input.bookId! },
      );
      records = result.records;
      currency = result.currency;
      repositoryPage = result.repositoryPage;
    } else if (
      input.view === 'cash-dividends' ||
      input.view === 'cash-dividend'
    ) {
      const reader = dependencies.cashDividends;
      if (!reader) throw new Error('api-finance-dividends-unavailable');
      const result =
        input.view === 'cash-dividends'
          ? FinanceCashDividendListSchema.parse(
              await reader.listInvestmentCashDividends(
                workspace,
                input.bookId!,
                { offset: input.offset, limit: input.limit },
              ),
            )
          : {
              actions: [
                FinanceCashDividendSavedActionSchema.parse(
                  await reader.getInvestmentCashDividend(
                    workspace,
                    input.bookId!,
                    input.dividendId!,
                  ),
                ),
              ],
              nextOffset: null,
            };
      for (const action of result.actions) {
        const source = action.source;
        if (
          action.workspaceId !== workspace.workspaceId ||
          action.bookId !== input.bookId ||
          (input.view === 'cash-dividend' && action.id !== input.dividendId) ||
          source.sourceRowId !== action.sourceRowId ||
          source.evidenceId !== action.evidenceId ||
          source.financialAccountId !== action.financialAccountId ||
          source.financialAccountLedgerId !== action.cashLedgerAccountId ||
          source.instrumentId !== action.instrumentId ||
          source.sourceRevision !== action.sourceRevision ||
          source.sourceSnapshotHash !== action.sourceSnapshotHash ||
          action.nextSourceRevision !== action.sourceRevision + 1 ||
          source.currentRevision < action.nextSourceRevision
        )
          throw new Error('api-finance-dividend-binding-invalid');
        const amounts = [action.gross, action.withholding, action.net];
        if (
          new Set(amounts.map((a) => a.id)).size !== 3 ||
          amounts.some(
            (a) =>
              a.journalId !== action.journalId ||
              a.currency !== source.currency ||
              a.provenance.sourceRow !== source.sourceRow ||
              a.provenance.field !== a.kind,
          ) ||
          action.gross.kind !== 'gross' ||
          action.withholding.kind !== 'withholding' ||
          action.net.kind !== 'net' ||
          action.gross.ledgerAccountId !==
            action.dividendIncomeLedgerAccountId ||
          action.gross.postingSide !== 'credit' ||
          action.withholding.ledgerAccountId !==
            action.withholdingLedgerAccountId ||
          action.withholding.postingSide !== 'debit' ||
          action.net.ledgerAccountId !== action.cashLedgerAccountId ||
          action.net.postingSide !== 'debit'
        )
          throw new Error('api-finance-dividend-amount-binding-invalid');
      }
      records = result.actions.map((action) => ({
        ...Object.fromEntries(
          Object.entries(action).filter(
            ([key]) =>
              !['createdBy', 'idempotencyKey', 'commandHash'].includes(key),
          ),
        ),
        recordType: 'saved-cash-dividend',
        functionalCurrency: action.source.functionalCurrency,
      }));
      if (input.view === 'cash-dividends') repositoryPage = result;
      const currencies = new Set(
        result.actions.map((a) => a.source.functionalCurrency),
      );
      currency = currencies.size === 1 ? [...currencies][0]! : null;
    } else if (input.view === 'standardization-reconciliation') {
      const reader = dependencies.standardizationRuns;
      if (!reader?.reconciliation)
        throw new Error(
          'api-finance-standardization-reconciliation-unavailable',
        );
      const saved = FinanceStandardizationReconciliationSchema.parse(
        await reader.reconciliation(
          workspace,
          input.bookId!,
          input.standardizationRunId!,
        ),
      );
      const reservations = new Map(
        saved.spend.map((spend) => [spend.id, spend]),
      );
      const receipts = new Map(
        saved.receipts.map((receipt) => [receipt.id, receipt]),
      );
      if (
        saved.workspaceId !== workspace.workspaceId ||
        saved.bookId !== input.bookId ||
        saved.runId !== input.standardizationRunId ||
        reservations.size !== saved.spend.length ||
        receipts.size !== saved.receipts.length ||
        new Set(saved.resolutions.map((r) => r.id)).size !==
          saved.resolutions.length ||
        saved.receipts.some(
          (receipt) =>
            !reservations.has(receipt.reservationId) ||
            receipt.providerResponseId !==
              reservations.get(receipt.reservationId)?.providerResponseId,
        ) ||
        saved.resolutions.some(
          (resolution) =>
            (resolution.reservationId !== null &&
              !reservations.has(resolution.reservationId)) ||
            (resolution.receiptId !== null &&
              receipts.get(resolution.receiptId)?.reservationId !==
                resolution.reservationId),
        )
      )
        throw new Error(
          'api-finance-standardization-reconciliation-binding-invalid',
        );
      const decimalCost = (minor: number | null) =>
        minor === null
          ? null
          : `${BigInt(minor) / 100n}.${(BigInt(minor) % 100n).toString().padStart(2, '0')}`;
      currency = 'CAD';
      records = [
        {
          id: saved.runId,
          recordType: 'standardization-reconciliation',
          runId: saved.runId,
          revision: saved.revision,
          sourceDigest: saved.sourceDigest,
          status: saved.status,
        },
        ...saved.spend.map((spend) => ({
          id: spend.id,
          recordType: 'standardization-spend',
          runId: saved.runId,
          revision: saved.revision,
          attempt: spend.attempt,
          status: spend.status,
          dispatchPhase: spend.dispatchPhase,
          pricingVersion: spend.pricingVersion,
          reservedCost: decimalCost(spend.reservedCadMinor),
          actualCost: decimalCost(spend.actualCadMinor),
          currency: 'CAD',
          providerResponseId: spend.providerResponseId,
        })),
        ...saved.receipts.map(({ actualCadMinor, ...receipt }) => ({
          ...receipt,
          recordType: 'standardization-receipt',
          actualCost: decimalCost(actualCadMinor),
          currency: 'CAD',
        })),
        ...saved.resolutions.map((resolution) => ({
          id: resolution.id,
          reservationId: resolution.reservationId,
          decision: resolution.decision,
          reviewedAt: resolution.reviewedAt,
          receiptId: resolution.receiptId,
          recordType: 'standardization-resolution',
        })),
      ];
    } else if (
      input.view === 'standardization-runs' ||
      input.view === 'standardization-run'
    ) {
      const reader = dependencies.standardizationRuns;
      if (!reader) throw new Error('api-finance-standardization-unavailable');
      const result =
        input.view === 'standardization-runs'
          ? FinanceStandardizationListSchema.parse(
              await reader.list(workspace, input.bookId!, input.offset),
            )
          : {
              runs: [
                FinanceStandardizationRunSchema.parse(
                  await reader.get(
                    workspace,
                    input.bookId!,
                    input.standardizationRunId!,
                  ),
                ),
              ],
              nextOffset: null,
            };
      if (
        result.runs.some(
          (run) =>
            run.workspaceId !== workspace.workspaceId ||
            run.bookId !== input.bookId ||
            (run.extraction !== null &&
              run.extraction.sourceDigest !== run.sourceDigest) ||
            (input.view === 'standardization-run' &&
              run.id !== input.standardizationRunId),
        ) ||
        new Set(result.runs.map((run) => run.id)).size !== result.runs.length ||
        (result.nextOffset !== null &&
          result.nextOffset !== input.offset + result.runs.length)
      )
        throw new Error('api-finance-standardization-scope-invalid');
      records = result.runs
        .slice(
          input.view === 'standardization-run' ? input.offset : 0,
          input.view === 'standardization-run'
            ? input.offset + input.limit
            : input.limit,
        )
        .map((run) => ({
          id: run.id,
          evidenceId: run.evidenceId,
          filename: run.filename,
          sourceDigest: run.sourceDigest,
          revision: run.revision,
          status: run.status,
          executionMode: run.executionMode,
          extraction: run.extraction,
          proposal: run.proposal,
          reviewedMapping: run.reviewedMapping,
          modelProvenance: run.modelProvenance,
          blockers: run.blockers,
          approval: run.approval,
          posting: run.posting,
        }));
      repositoryPage = {
        nextOffset:
          input.view === 'standardization-run'
            ? null
            : records.length < result.runs.length
              ? input.offset + records.length
              : result.nextOffset,
      };
    } else if (input.view === 'automation-schedules') {
      const reader = dependencies.automationSchedules;
      if (!reader) throw new Error('api-finance-schedules-unavailable');
      const rows = z
        .array(
          z.strictObject({
            schedule: FinanceAutomationScheduleSchema,
            cursor: FinanceAutomationScheduleCursorSchema,
            nextDueAt: IsoDateTimeSchema.nullable(),
            blockedReason: z.string().max(500).nullable(),
            createdAt: IsoDateTimeSchema,
            updatedAt: IsoDateTimeSchema,
          }),
        )
        .max(input.limit)
        .parse(
          await reader.listSchedules(
            workspace,
            input.bookId!,
            input.offset,
            input.limit,
          ),
        );
      if (
        new Set(rows.map((row) => row.schedule.id)).size !== rows.length ||
        rows.some(
          ({ schedule, cursor }) =>
            schedule.definition.workspaceId !== workspace.workspaceId ||
            schedule.definition.bookId !== input.bookId ||
            cursor.scheduleId !== schedule.id ||
            cursor.definitionRevision !== schedule.definitionRevision,
        )
      )
        throw new Error('api-finance-schedules-scope-invalid');
      // Expose reviewable configuration, never execution cursor/lease authority.
      records = rows.map(
        ({ schedule, nextDueAt, blockedReason, createdAt, updatedAt }) => ({
          id: schedule.id,
          status: schedule.status,
          definitionRevision: schedule.definitionRevision,
          stateRevision: schedule.stateRevision,
          capability: schedule.definition.capability,
          targetCount: schedule.definition.targets.length,
          extractionSource: schedule.definition.extraction ?? null,
          journalSource: schedule.definition.journal ?? null,
          planningSource: schedule.definition.planning
            ? {
                budgetId: schedule.definition.planning.budgetId,
                budgetRevision: schedule.definition.planning.budgetRevision,
                asOf: schedule.definition.planning.asOf,
                currency: schedule.definition.planning.currency,
                itemCount: schedule.definition.planning.itemCount,
              }
            : null,
          configuredMoney: schedule.definition.money,
          startAt: schedule.definition.startAt,
          endAt: schedule.definition.endAt,
          cadence: schedule.definition.cadence,
          misfire: schedule.definition.misfire,
          concurrency: schedule.definition.concurrency,
          nextDueAt,
          blockedReason,
          createdAt,
          updatedAt,
        }),
      );
      repositoryPage = {
        nextOffset:
          rows.length === input.limit ? input.offset + rows.length : null,
      };
    } else if (
      input.view === 'automation-runs' ||
      input.view === 'automation-run'
    ) {
      const reader = dependencies.automationRuns;
      if (!reader)
        throw new Error('api-finance-automation-history-unavailable');
      let rows: z.infer<typeof FinanceAutomationRunRecordSchema>[];
      if (input.view === 'automation-runs') {
        const result = z
          .strictObject({
            runs: z.array(FinanceAutomationRunRecordSchema).max(input.limit),
            nextOffset: z.number().int().nonnegative().nullable(),
          })
          .parse(
            await reader.listRuns(
              workspace,
              input.bookId!,
              input.offset,
              input.limit,
            ),
          );
        if (
          new Set(result.runs.map((row) => row.run.request.operationId))
            .size !== result.runs.length ||
          (result.nextOffset !== null &&
            (result.runs.length !== input.limit ||
              result.nextOffset !== input.offset + input.limit))
        )
          throw new Error('api-finance-automation-history-page-invalid');
        rows = result.runs;
        repositoryPage = result;
      } else {
        const raw = await reader.getRun(
          workspace,
          input.bookId!,
          input.automationRunId!,
        );
        if (!raw) throw new Error('api-finance-automation-run-unavailable');
        const row = FinanceAutomationRunRecordSchema.parse(raw);
        if (row.run.request.operationId !== input.automationRunId)
          throw new Error('api-finance-automation-history-scope-invalid');
        rows = [row];
      }
      if (
        rows.some(
          (row) =>
            row.run.request.workspaceId !== workspace.workspaceId ||
            row.run.request.bookId !== input.bookId,
        )
      )
        throw new Error('api-finance-automation-history-scope-invalid');
      records = rows.map((row) => ({
        id: row.run.request.operationId,
        ...row.run.request,
        revision: row.run.revision,
        attempts: row.run.attempts,
        status: row.run.status,
        outcomeReference: row.run.outcomeReference,
        createdAt: row.createdAt,
        blockedReason: row.blockedReason,
      }));
    } else if (
      [
        'journal-drafts',
        'journal-draft',
        'journal-draft-lines',
        'journal-draft-history',
      ].includes(input.view)
    ) {
      const reader = dependencies.journalDrafts;
      if (!reader) throw new Error('api-finance-journal-drafts-unavailable');
      let drafts;
      if (input.view === 'journal-drafts') {
        const result = z
          .strictObject({
            items: z.array(FinanceAutomationJournalDraftResultSchema).max(100),
            offset: z.number().int().nonnegative(),
            limit: z.number().int().min(1).max(100),
            total: z.number().int().nonnegative(),
          })
          .parse(
            await reader.listJournalDraftResults(
              workspace,
              input.bookId!,
              input.offset,
              Math.min(input.limit, 33),
            ),
          );
        if (
          result.offset !== input.offset ||
          result.limit !== Math.min(input.limit, 33) ||
          result.items.length > input.limit ||
          new Set(result.items.map((r) => r.id)).size !== result.items.length
        )
          throw new Error('api-finance-journal-draft-page-invalid');
        drafts = result.items;
        repositoryPage = {
          nextOffset:
            result.offset + result.items.length < result.total
              ? result.offset + result.items.length
              : null,
        };
      } else {
        const result = FinanceAutomationJournalDraftResultSchema.parse(
          await reader.readJournalDraftResult(
            workspace,
            input.bookId!,
            input.journalDraftId!,
          ),
        );
        if (result.id !== input.journalDraftId)
          throw new Error('api-finance-journal-draft-scope-invalid');
        drafts = [result];
      }
      if (
        drafts.some(
          (r) =>
            r.workspaceId !== workspace.workspaceId ||
            r.bookId !== input.bookId,
        )
      )
        throw new Error('api-finance-journal-draft-scope-invalid');
      for (const draft of drafts) {
        if (
          draft.events.length !== draft.revision ||
          draft.events.some((event, index) => event.revision !== index + 1)
        )
          throw new Error('api-finance-journal-draft-history-invalid');
        const posted = draft.events.filter((event) => event.kind === 'posted');
        if (
          draft.posting === 'performed' &&
          (posted.length !== 1 ||
            JSON.stringify(posted[0]!.journalIds) !==
              JSON.stringify(draft.postedJournalIds))
        )
          throw new Error('api-finance-journal-draft-history-invalid');
      }
      currency = drafts[0]?.currency ?? null;
      records = drafts.flatMap<Record<string, unknown>>((draft) => {
        const shared = {
          journalDraftId: draft.id,
          currentDraftRevision: draft.revision,
          status: draft.status,
          posting: draft.posting,
          evidenceId: draft.source.evidenceId,
          sourceDigest: draft.source.sourceDigest,
          sourceSnapshotHash: draft.source.snapshotHash,
        };
        if (input.view === 'journal-draft-lines')
          return draft.proposal.journals.flatMap((journal, j) =>
            journal.lines.map((line, l) => ({
              id: `${draft.id}:journal:${j}:line:${l}`,
              recordType: 'journal-draft-line',
              ...shared,
              journalIndex: j,
              lineIndex: l,
              effectiveOn: journal.effectiveOn,
              journalDescription: journal.description,
              sourceReference: journal.sourceReference,
              ...line,
            })),
          );
        if (input.view === 'journal-draft-history')
          return draft.events.flatMap((event) => {
            const record = {
              id: `${draft.id}:revision:${event.revision}`,
              recordType: 'journal-draft-event',
              ...shared,
              eventRevision: event.revision,
              kind: event.kind,
              actorId: event.actorId,
              at: event.at,
              decision: event.kind === 'reviewed' ? event.decision : null,
              reason: event.kind !== 'posted' ? event.reason : null,
            };
            return event.kind === 'posted'
              ? [
                  record,
                  ...event.journalIds.map((journalId, index) => ({
                    ...record,
                    id: `${draft.id}:revision:${event.revision}:journal:${index}`,
                    recordType: 'journal-draft-posted-journal',
                    journalId,
                  })),
                ]
              : [record];
          });
        return [
          {
            id: draft.id,
            recordType: 'journal-draft',
            ...shared,
            operationId: draft.operationId,
            currency: draft.currency,
            amount: draft.amount,
            itemCount: draft.itemCount,
            batchId: draft.source.batchId,
            batchRevision: draft.source.batchRevision,
            mappingHash: draft.source.mappingHash,
            sourceRowCount: draft.source.rows.length,
            journalCount: draft.proposal.journals.length,
            postedJournalCount: draft.postedJournalIds.length,
            reviewDecision: draft.review?.decision ?? null,
            reviewReason: draft.review?.reason ?? null,
            reviewActorId: draft.review?.actorId ?? null,
            reviewedAt: draft.review?.at ?? null,
          },
        ];
      });
    } else if (
      input.view === 'investment-reconciliations' ||
      input.view === 'investment-reconciliation' ||
      input.view === 'investment-reconciliation-history'
    ) {
      const reader = dependencies.investmentReconciliation;
      if (!reader) throw new Error('api-finance-reconciliation-unavailable');
      let cases;
      if (
        input.view === 'investment-reconciliation' ||
        input.view === 'investment-reconciliation-history'
      ) {
        const raw = await reader.get(
          workspace,
          input.bookId!,
          input.reconciliationCaseId!,
        );
        if (!raw) throw new Error('api-finance-reconciliation-not-found');
        const result = InvestmentReconciliationCaseSchema.parse(raw);
        if (result.id !== input.reconciliationCaseId)
          throw new Error('api-finance-reconciliation-scope-invalid');
        cases = [result];
      } else {
        const page = InvestmentReconciliationListSchema.parse(
          await reader.list(
            workspace,
            input.bookId!,
            input.offset,
            input.limit,
          ),
        );
        if (
          page.offset !== input.offset ||
          page.limit !== input.limit ||
          page.items.length > input.limit ||
          new Set(page.items.map((row) => row.id)).size !== page.items.length
        )
          throw new Error('api-finance-reconciliation-page-invalid');
        cases = page.items;
        repositoryPage = {
          nextOffset:
            page.offset + page.items.length < page.total
              ? page.offset + page.items.length
              : null,
        };
      }
      if (
        cases.some(
          (row) =>
            row.workspaceId !== workspace.workspaceId ||
            row.bookId !== input.bookId,
        )
      )
        throw new Error('api-finance-reconciliation-scope-invalid');
      if (input.view === 'investment-reconciliation-history') {
        const row = cases[0]!;
        if (
          row.history.length !== row.revision ||
          row.history.some((event, index) => event.revision !== index + 1)
        )
          throw new Error('api-finance-reconciliation-history-invalid');
        records = row.history.flatMap((event) => {
          const shared = {
            caseId: row.id,
            eventRevision: event.revision,
            currentCaseRevision: row.revision,
            currentEffectiveStatus: row.effectiveStatus,
            currentSourcesCurrent: row.sourcesCurrent,
            accountingEffect: row.accountingEffect,
          };
          const evidenceIds = event.resolution?.evidenceIds ?? [],
            corrections = event.resolution?.correctiveRecords ?? [];
          if (
            event.evidenceSnapshots.length !== evidenceIds.length ||
            event.correctiveRecordSnapshots.length !== corrections.length
          )
            throw new Error(
              'api-finance-reconciliation-history-provenance-invalid',
            );
          const eventRecord = {
            id: `${row.id}:${event.revision}:event`,
            recordType: 'reconciliation-event',
            ...shared,
            kind: event.kind,
            createdAt: event.createdAt,
            createdBy: event.createdBy,
            reason: event.reason,
            valuationRunId: event.comparison.valuationRunId,
            observedPositionId: event.comparison.observedPositionId,
            comparisonHash: event.comparison.comparisonHash,
            valuationInputHash: event.comparison.valuationInputHash,
            financialAccountId: event.comparison.financialAccountId,
            instrumentId: event.comparison.instrumentId,
            asOf: event.comparison.asOf,
            evidenceId: event.comparison.evidenceId,
            sourceRow: event.comparison.sourceRow,
            observedQuantity: event.comparison.observedQuantity,
            calculatedQuantity: event.comparison.calculatedQuantity,
            difference: event.comparison.difference,
            comparisonStatus: event.comparison.status,
            resolutionKind: event.resolution?.kind ?? null,
            explanation: event.resolution?.explanation ?? null,
            evidenceSnapshotCount: event.evidenceSnapshots.length,
            correctiveRecordSnapshotCount:
              event.correctiveRecordSnapshots.length,
          };
          const evidenceRecords = event.evidenceSnapshots.map(
            (snapshot, index) => {
              const proof = z
                .object({
                  id: UuidSchema,
                  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
                })
                .parse(snapshot);
              if (
                !evidenceIds.includes(proof.id) ||
                event.evidenceSnapshots.filter((item) => item.id === proof.id)
                  .length !== 1
              )
                throw new Error(
                  'api-finance-reconciliation-history-provenance-invalid',
                );
              return {
                id: `${row.id}:${event.revision}:evidence:${index}`,
                recordType: 'reconciliation-evidence',
                ...shared,
                evidenceId: proof.id,
                sourceDigest: proof.sourceDigest,
              };
            },
          );
          const correctionRecords = event.correctiveRecordSnapshots.map(
            (snapshot, index) => {
              const ref = corrections.find(
                (item) =>
                  item.id === snapshot.id && item.kind === snapshot.kind,
              );
              if (
                !ref ||
                event.correctiveRecordSnapshots.filter(
                  (item) => item.id === ref.id && item.kind === ref.kind,
                ).length !== 1 ||
                !snapshot.snapshot ||
                typeof snapshot.snapshot !== 'object' ||
                Array.isArray(snapshot.snapshot)
              )
                throw new Error(
                  'api-finance-reconciliation-history-provenance-invalid',
                );
              const source = snapshot.snapshot as Record<string, unknown>;
              const fields: Record<string, string | number | boolean | null> =
                {};
              let truncated = false;
              for (const key of [
                'as_of',
                'effective_on',
                'settlement_date',
                'quantity',
                'quantity_delta',
                'amount',
                'cash_amount',
                'gross_amount',
                'net_amount',
                'currency',
                'source_reference',
                'evidence_id',
                'financial_account_id',
                'instrument_id',
                'action_id',
                'journal_id',
                'status',
              ]) {
                const value = source[key];
                if (
                  [
                    'quantity',
                    'quantity_delta',
                    'amount',
                    'cash_amount',
                    'gross_amount',
                    'net_amount',
                  ].includes(key) &&
                  value !== undefined &&
                  value !== null &&
                  (typeof value !== 'string' ||
                    !/^-?\d+(?:\.\d+)?$/u.test(value))
                )
                  throw new Error(
                    'api-finance-reconciliation-exact-snapshot-required',
                  );
                if (
                  value === null ||
                  typeof value === 'number' ||
                  typeof value === 'boolean'
                )
                  fields[key] = value;
                else if (typeof value === 'string') {
                  fields[key] = value.slice(0, 4096);
                  if (value.length > 4096) truncated = true;
                }
              }
              return {
                id: `${row.id}:${event.revision}:correction:${index}`,
                recordType: 'reconciliation-corrective-record',
                ...shared,
                correctiveKind: ref.kind,
                correctiveRecordId: ref.id,
                ...fields,
                snapshotProjection: 'selected-scalar-fields',
                snapshotTextTruncated: truncated,
              };
            },
          );
          return [eventRecord, ...evidenceRecords, ...correctionRecords];
        });
      } else
        records = cases.map((row) => ({
          id: row.id,
          revision: row.revision,
          ...row.comparison,
          comparisonStatus: row.comparison.status,
          status: row.status,
          effectiveStatus: row.effectiveStatus,
          sourcesCurrent: row.sourcesCurrent,
          sourceSnapshot: undefined,
          historyCount: row.history.length,
          accountingEffect: row.accountingEffect,
        }));
    } else if (input.view === 'planning-result') {
      if (!dependencies.planning)
        throw new Error('api-finance-planning-unavailable');
      const result = await readFinancePlanning(
        dependencies.planning,
        workspace,
        {
          ...input,
          bookId: input.bookId!,
          planningResultId: input.planningResultId!,
        },
      );
      records = result.records;
      currency = result.currency;
      repositoryPage = result.repositoryPage;
    } else if (
      input.view === 'generated-reports' ||
      input.view === 'generated-report'
    ) {
      const reports = dependencies.generatedReports;
      if (!reports)
        throw new Error('api-finance-generated-reports-unavailable');
      if (input.view === 'generated-reports') {
        const rawResult = await reports.list(
          workspace,
          input.bookId!,
          input.offset,
          input.limit,
        );
        const result = z
          .strictObject({
            reports: z
              .array(FinanceGeneratedReportSummarySchema)
              .max(input.limit),
            nextOffset: z.number().int().nonnegative().nullable(),
          })
          .parse(rawResult);
        if (
          result.reports.some(
            (report) =>
              report.workspaceId !== workspace.workspaceId ||
              report.bookId !== input.bookId,
          ) ||
          (result.nextOffset !== null &&
            (result.nextOffset <= input.offset ||
              result.nextOffset !== input.offset + result.reports.length))
        )
          throw new Error('api-finance-generated-report-scope-invalid');
        records = result.reports;
        repositoryPage = result;
      } else {
        const raw = await reports.get(
          workspace,
          input.bookId!,
          input.reportId!,
        );
        if (!raw) throw new Error('api-finance-generated-report-unavailable');
        const { rows, sourceJournals, ...summary } =
          FinanceGeneratedReportSchema.parse(raw);
        if (
          summary.id !== input.reportId ||
          summary.workspaceId !== workspace.workspaceId ||
          summary.bookId !== input.bookId
        )
          throw new Error('api-finance-generated-report-scope-invalid');
        currency = summary.currency;
        records = [
          {
            ...summary,
            recordType:
              summary.kind === 'posted-ledger-trial-balance'
                ? 'saved-trial-balance-summary'
                : `saved-${summary.kind}-summary`,
            columnBasis:
              summary.kind === 'income-statement'
                ? 'period-posted-movements'
                : summary.kind === 'balance-sheet'
                  ? 'posted-movements-through-as-of'
                  : 'cumulative-posted-movements',
            accountCount: rows.length,
            journalCount: sourceJournals.length,
          },
          ...rows.map((row) => ({
            id: `${summary.id}:account:${row.accountId}`,
            recordType: 'account-movements',
            ...row,
            balanceBasis:
              summary.kind === 'balance-sheet' &&
              (row.kind === 'liability' || row.kind === 'equity')
                ? 'credit-minus-debit'
                : 'debit-minus-credit',
          })),
          ...sourceJournals.map((journal) => ({
            id: `${summary.id}:journal:${journal.journalId}`,
            recordType: 'source-journal',
            ...journal,
          })),
        ];
      }
    } else if (input.view === 'books')
      records = await repository.listBooks(workspace);
    else if (input.view === 'trial-balance') {
      const result = await repository.overview(workspace, input.bookId!);
      records = result.trialBalance;
      const books = await repository.listBooks(workspace);
      currency =
        String(
          books.find((b) => b.id === input.bookId)?.functionalCurrency ?? '',
        ) || null;
    } else if (input.view === 'commercial') {
      const result = await repository.commercialOverview(
        workspace,
        input.bookId!,
      );
      currency = String(result.currency);
      records = [
        ...result.documents.map((r) => ({
          ...r,
          recordType: 'commercial-document',
        })),
        ...result.payments.map((r) => ({ ...r, recordType: 'payment' })),
      ];
    } else if (input.view === 'investment-lots') {
      const result = await repository.listInvestmentLots(
        workspace,
        input.bookId!,
        input.offset,
        input.limit,
      );
      records = result.lots;
      repositoryPage = result;
    } else if (input.view === 'valuation-runs') {
      const result = await repository.listInvestmentValuations(
        workspace,
        input.bookId!,
        input.offset,
        input.limit,
      );
      records = result.runs;
      repositoryPage = result;
    } else if (input.view === 'valuation') {
      const run = await repository.getInvestmentValuation(
        workspace,
        input.bookId!,
        input.valuationId!,
      );
      if (run.id !== input.valuationId)
        throw new Error('api-finance-valuation-scope-invalid');
      const result = z.record(z.string(), z.unknown()).parse(run.result);
      currency = typeof result.currency === 'string' ? result.currency : null;
      const rows = (key: string) =>
        z.array(z.record(z.string(), z.unknown())).parse(result[key] ?? []);
      records = [
        {
          id: String(run.id),
          recordType: 'valuation-summary',
          asOf: run.asOf,
          calculationVersion: run.calculationVersion,
          mode: result.mode,
          valuationScope: result.valuationScope,
          status: result.status,
          currency: result.currency,
          total: result.total,
          availableSubtotal: result.availableSubtotal,
          unavailableCount: result.unavailableCount,
          createdAt: run.createdAt,
        },
        ...['positions', 'calculations', 'reconciliations'].flatMap((key) =>
          rows(key).map((row, index) => ({
            id: `${String(run.id)}:${key}:${index}`,
            recordType: key,
            ...row,
          })),
        ),
      ];
    } else if (input.view === 'imports')
      records = await repository.listNormalizedImports(
        workspace,
        input.bookId!,
      );
    else {
      const result = await repository.getNormalizedImport(
        workspace,
        input.bookId!,
        input.importId!,
      );
      if (result.batch.id !== input.importId)
        throw new Error('api-finance-import-scope-invalid');
      const accounts = await repository.listFinancialAccounts(
        workspace,
        input.bookId!,
      );
      const account = accounts.find(
        (a) => a.id === result.batch.financial_account_id,
      );
      if (!account) throw new Error('api-finance-book-account-unavailable');
      currency = String(account.currency);
      records = result.rows.flatMap((r) => {
        const posting = FinanceNormalizedImportPostingSchema.nullable().parse(
          r.posting ?? null,
        );
        if (
          posting &&
          (posting.economicTransactionId !== r.economic_transaction_id ||
            new Set(posting.lines.map((line) => line.lineNumber)).size !==
              posting.lines.length)
        )
          throw new Error('api-finance-import-posting-binding-invalid');
        const components = z
          .array(FinanceNormalizedAmountComponentViewSchema)
          .max(5)
          .parse(r.amountComponents ?? []);
        if (
          new Set(components.map((component) => component.kind)).size !==
            components.length ||
          new Set(components.map((component) => component.id)).size !==
            components.length ||
          components.some(
            (component) =>
              component.rowId !== r.id ||
              component.provenance.sourceRow !== r.source_row ||
              component.provenance.field !== component.kind,
          )
        )
          throw new Error('api-finance-import-component-source-invalid');
        const componentRecords = components.map((component) => {
          const decisions = [
            component.reviewedNativeAmount,
            component.reviewedCurrency,
            component.inclusion,
            component.postingSide,
            component.ledgerAccountId,
            component.fxRate,
            component.fxSource,
          ];
          if (
            decisions.some((value) => value === null) &&
            decisions.some((value) => value !== null)
          )
            throw new Error('api-finance-import-component-review-invalid');
          return {
            ...component,
            recordType: 'import-amount-component',
            reviewState: decisions.every((value) => value === null)
              ? 'unreviewed'
              : 'reviewed',
            batchId: result.batch.id,
            batchRevision: result.batch.revision,
            sourceRowRevision: r.revision,
            evidenceId: result.batch.evidence_id,
          };
        });
        return [
          {
            id: r.id,
            recordType: 'import-row',
            sourceRow: r.source_row,
            date: r.date,
            amount: r.amount,
            description: r.description,
            status: r.status,
            reviewDecision:
              z
                .object({ action: z.enum(['post', 'match', 'ignore']) })
                .nullable()
                .parse(r.decision ?? null)?.action ?? null,
            counterAccountId: UuidSchema.nullable().parse(
              r.counter_account_id ?? null,
            ),
            matchJournalId: UuidSchema.nullable().parse(
              r.match_journal_id ?? null,
            ),
            economicTransactionId: UuidSchema.nullable().parse(
              r.economic_transaction_id ?? null,
            ),
            revision: r.revision,
            issues: r.issues,
            fxRate: r.fxRate,
            fxSource: r.fx_source,
            batchId: result.batch.id,
            batchRevision: result.batch.revision,
            batchStatus: result.batch.status,
            evidenceId: result.batch.evidence_id,
          },
          ...componentRecords,
          ...(posting
            ? [
                {
                  id: `${r.id}:journal:${posting.journalId}`,
                  recordType: 'import-posted-journal',
                  sourceRowId: r.id,
                  batchId: result.batch.id,
                  evidenceId: result.batch.evidence_id,
                  ...posting,
                  lines: undefined,
                },
                ...posting.lines.map((line) => ({
                  id: `${r.id}:journal:${posting.journalId}:line:${line.lineNumber}`,
                  recordType: 'import-posted-line',
                  sourceRowId: r.id,
                  economicTransactionId: posting.economicTransactionId,
                  functionalCurrency: posting.functionalCurrency,
                  journalId: posting.journalId,
                  batchId: result.batch.id,
                  evidenceId: result.batch.evidence_id,
                  ...line,
                })),
              ]
            : []),
        ];
      });
    }
    if (scope.abortSignal.aborted)
      throw new Error('api-finance-specialist-request-binding-invalid');
    if (
      repositoryPage &&
      (records.length > input.limit ||
        records.some((record) => typeof record.id !== 'string' || !record.id) ||
        new Set(records.map((record) => record.id)).size !== records.length ||
        (repositoryPage.nextOffset !== null &&
          (!Number.isSafeInteger(repositoryPage.nextOffset) ||
            repositoryPage.nextOffset <= input.offset ||
            repositoryPage.nextOffset !== input.offset + records.length)))
    )
      throw new Error('api-finance-book-page-invalid');
    const page = repositoryPage
      ? records
      : records.slice(
          input.offset,
          input.offset +
            ([
              'journal-drafts',
              'journal-draft',
              'journal-draft-lines',
              'journal-draft-history',
            ].includes(input.view)
              ? Math.min(input.limit, 33)
              : input.limit),
        );
    return {
      view: input.view,
      bookId: input.bookId,
      currency,
      amountEncoding: 'decimal-string',
      records: page.map((r) => ({
        id: String(r.id),
        fields: Object.entries(r)
          .filter(([name]) => name !== 'id')
          .map(([name, value]) => ({
            name,
            value:
              value === null || value === undefined
                ? null
                : typeof value === 'object'
                  ? JSON.stringify(value)
                  : String(value),
          })),
      })),
      nextOffset: repositoryPage
        ? repositoryPage.nextOffset
        : input.offset + page.length < records.length
          ? input.offset + page.length
          : null,
      sourceReferences: [
        'journal-drafts',
        'journal-draft',
        'journal-draft-lines',
        'journal-draft-history',
      ].includes(input.view)
        ? [
            ...new Set(
              page.flatMap((r) => [
                `/api/v2/finance/books/${input.bookId}/automations/journal-drafts/${String(r.journalDraftId)}#${String(r.id)}`,
                `/api/v2/finance/books/${input.bookId}/evidence/${String(r.evidenceId)}`,
                ...(r.journalId
                  ? [
                      `/api/v2/finance/books/${input.bookId}/automations/journal-drafts/${String(r.journalDraftId)}#posted-journal-${String(r.journalId)}`,
                    ]
                  : []),
              ]),
            ),
          ]
        : page.map(
            (r) =>
              `/api/v2/finance/books${input.bookId ? '/' + input.bookId : ''}${['journal-drafts', 'journal-draft', 'journal-draft-lines', 'journal-draft-history'].includes(input.view) ? '/automations/journal-drafts/' + String(r.journalDraftId) : input.view === 'corporate-action-settlement' ? '/investments/corporate-actions/settlements/' + input.settlementId : input.view === 'investment-reconciliation-history' ? '/investments/reconciliations/' + input.reconciliationCaseId : input.view === 'investment-reconciliations' || input.view === 'investment-reconciliation' ? '/investments/reconciliations/' + String(r.id) : input.view === 'fec-mapping' ? '/fec/mappings/latest' : planningReadViews.has(input.view) ? (input.view === 'planning-result' ? '/planning/results/' + String(input.planningResultId) : '/planning/' + (input.view === 'forecast' || input.view === 'forecasts' ? 'forecasts/' + String(r.forecastId) : 'budgets/' + String(r.budgetId) + (input.view === 'budget-vs-actuals' ? '/vs-actuals' : '')) + '?revision=' + String(r.revision ?? r.budgetRevision)) : input.view === 'cash-dividends' || input.view === 'cash-dividend' ? '/investments/cash-dividends/' + String(r.id) : input.view === 'standardization-reconciliation' ? '/standardizations/' + input.standardizationRunId + '/reconciliation' : input.view === 'standardization-runs' || input.view === 'standardization-run' ? '/standardizations/' + String(r.id) : input.view === 'automation-schedules' ? '/automations/schedules/' + String(r.id) : input.view === 'automation-runs' || input.view === 'automation-run' ? '/automations/runs/' + String(r.id) : input.view === 'imports' ? '/imports' : input.view === 'import-review' ? '/imports/' + input.importId : input.view === 'valuation' ? '/investments/valuation-runs/' + input.valuationId : input.view === 'valuation-runs' ? '/investments/valuation-runs/' + String(r.id) : input.view === 'investment-lots' ? '/investments/lots/' + String(r.id) : input.view === 'generated-reports' ? '/reports/' + String(r.id) : input.view === 'generated-report' ? '/reports/' + input.reportId : ''}#${input.view === 'investment-reconciliation-history' ? 'revision-' + String(r.eventRevision) : String(r.id)}`,
          ),
    };
  };

  const services = {
    inspectFinanceReport,
    proposeFinanceReportMapping,
    readFinanceTax,
    readFinanceBooks,
    readFinanceRecords,
    writeFinanceRecord,
    executeStatementImport,
    loadFinanceBudgetInputs,
    searchFinanceDocuments,
    readFinanceDocument,
    readFinanceMatches,
  } satisfies Omit<TrustedFinanceSpecialistServices, 'guardedDocumentActions'>;
  if (dependencies.guardedDocumentActions !== undefined) {
    // This is composition metadata, never a model-facing capability.
    Object.defineProperty(services, 'guardedDocumentActions', {
      configurable: false,
      enumerable: false,
      value: dependencies.guardedDocumentActions,
      writable: false,
    });
  }
  return Object.freeze(services) as TrustedFinanceSpecialistServices;
};

/** All document mutations are now covered by the EMDO-owned guarded port. */
export const FINANCE_SPECIALIST_SHARED_CONTRACT_GAPS = deepFreeze([] as const);

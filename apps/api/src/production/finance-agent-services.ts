import {
  GuardedActionPermitSchema,
  IsoDateTimeSchema,
  OpaqueReferenceSchema,
  Sha256Schema,
  UuidSchema,
  deepFreeze,
  type CapabilityInvocationContext,
  type GuardedActionPermit,
} from '@emdo/contracts';
import {
  applyTransactionLedgerOperation,
  validateFinanceRecord,
  type FinanceBudgetRecord,
  type FinanceRecord,
  type FinanceTransactionRecord,
} from '@emdo/domains/finance';
import { hashCanonicalJson } from '@emdo/toolbox';
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
  spaceAccessGrantId: OpaqueReferenceSchema,
  locale: z.enum(['en-CA', 'fr-CA', 'ja-JP', 'ko-KR']),
  disclosureGrantId: UuidSchema.optional(),
  approvalDecisionId: UuidSchema.optional(),
  guardedActionPermit: GuardedActionPermitSchema.optional(),
  abortSignal: AbortSignalSchema,
});

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
    context.data.spaceAccessGrantId !== principal.spaceAccessGrantId
  ) {
    throw new Error('api-finance-specialist-request-binding-invalid');
  }
  return deepFreeze({
    requestId: context.data.requestId,
    runId: context.data.runId,
    userId: principal.userId,
    householdId: principal.householdId,
    sessionId: principal.sessionId,
    privateSpaceId: principal.privateSpaceId,
    spaceAccessGrantId: principal.spaceAccessGrantId,
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
 * Composes Finance's seven non-provider capabilities for one authenticated
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

  const services = {
    readFinanceRecords,
    writeFinanceRecord,
    executeStatementImport,
    loadFinanceBudgetInputs,
    searchFinanceDocuments,
    readFinanceDocument,
    readFinanceMatches,
  } satisfies Omit<TrustedFinanceSpecialistServices, 'guardedDocumentActions'>;
  if (dependencies.guardedDocumentActions !== undefined) {
    // This is composition metadata, not an eighth Finance capability.
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

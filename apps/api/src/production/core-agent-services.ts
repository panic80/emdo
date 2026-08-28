import { randomUUID } from 'node:crypto';

import {
  ApprovalCheckpointService,
  type ApprovalCheckpointCipher,
  type LocalTraceSink,
} from '@emdo/agent-core';
import {
  ActionDecisionSchema,
  ActionProposalSchema,
  CapabilityDescriptorSchema,
  EffectiveAuthorizationScopeFingerprintSchema,
  JsonValueSchema,
  ProviderWriteAuthorityBindingSchema,
  Sha256Schema,
  SemanticVersionSchema,
  UuidSchema,
  deepFreeze,
} from '@emdo/contracts';
import {
  CanonicalRecordEnvelopeDisclosureFilter,
  PostgresAgentMemoryRepository,
  PostgresApprovalCheckpointRepository,
  PostgresDataDisclosureGrantIssuer,
  PostgresGoogleCalendarProviderAuthorityResolver,
  PostgresGoogleCalendarProposalAuthorityResolver,
  PostgresModelDisclosureGateway,
  PostgresProposalRepository,
  PostgresSchedulerDisclosureGrantResolver,
  type DurableRepositoryPrincipal,
  type EmdoDatabaseClient,
  type ProposalRepository,
} from '@emdo/db/api';
import {
  ProposalService,
  createProposalLifecycleService,
  hashActionProposalApproval,
  type ProposalPreparationBinding,
  type TrustedDisclosureGrantResolver,
  type TrustedProposalMaterializer,
} from '@emdo/domains/server/provider-proposals';
import {
  CalendarCanonicalArgumentsSchema,
  ScopedCalendarProposalMaterializer,
} from '@emdo/domains/scheduler';
import {
  hashCanonicalJson,
  hashCapabilityDescriptorBinding,
} from '@emdo/toolbox';
import { z } from 'zod';

import type { TrustedProviderProposalAuthorityResolver } from '../agents/capability-runtime.js';
import type {
  TrustedGuardedActionProposalMaterializer,
  TrustedProviderWriteCapabilityBinding,
} from '../agents/production-bindings.js';
import {
  createCoreProductionAgentRuntime,
  createFinanceOnlyProductionAgentRuntime,
  createFinanceV1ProductionAgentRuntime,
  createManagerOnlyProductionAgentRuntime,
  type CoreProductionAgentRuntime,
  type FinanceOnlyProductionAgentRuntime,
  type FinanceV1ProductionAgentRuntime,
  type ManagerOnlyProductionAgentRuntime,
} from '../agents/production-runtime.js';
import type { TrustedFinanceSpecialistServices } from '../agents/specialist-capability-adapters.js';
import {
  createPostgresCoreModelDisclosureGateway,
  createPostgresManagerConversationMemory,
} from '../agents/production-runtime-foundations.js';
import {
  createNoProviderWriteProposalComposition,
  createProductionProviderProposalComposition,
  type TrustedProviderWriteDecisionPresenter,
} from '../agents/proposal-gateway.js';
import { AuthenticatedPrincipalSchema } from '../schemas.js';
import {
  createRequestScopedGoogleCalendarEventCreateBinding,
  createPostgresGoogleCalendarProposalAuthorityResolver,
  createRequestScopedGoogleCalendarCoreRuntime,
} from './core-agent-composition.js';
import {
  createRequestScopedModelSpendGuard,
  type ProductionOpenAiAgentServiceBundle,
} from './core-openai-services.js';
import {
  classifyFinanceGuardedAction,
  hashFinanceGuardedActionExecutionBinding,
} from './finance-agent-services.js';
import type {
  FinanceCapabilityScope,
  FinanceDocumentGuardedActionIntent,
  FinanceDocumentGuardedActionOperation,
  FinanceDocumentGuardedActionPort,
  FinanceDocumentGuardedActionTarget,
} from './finance-agent-services.js';
import type {
  RequestScopedGoogleCalendarConditionalGatewayFactory,
  RequestScopedGoogleCalendarProposalReaderFactory,
} from './google-services.js';

type DatabasePool = EmdoDatabaseClient['scopedPool'];

const PrincipalWithPrivateSpaceSchema = AuthenticatedPrincipalSchema.extend({
  privateSpaceId: UuidSchema,
});
const MaterializationContextSchema = z.strictObject({
  requestId: UuidSchema,
  runId: UuidSchema,
  householdId: UuidSchema,
  userId: UuidSchema,
  authenticatedSessionId: UuidSchema,
  spaceAccessGrantId: UuidSchema,
  authorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprintSchema,
  disclosureGrantId: UuidSchema,
  disclosureGrantVersion: SemanticVersionSchema,
  sdkCallId: z.string().trim().min(1).max(512),
  abortSignal: z.custom<AbortSignal>(
    (value) =>
      value !== null &&
      typeof value === 'object' &&
      typeof (value as AbortSignal).aborted === 'boolean',
  ),
});

type PrincipalWithPrivateSpace = z.output<
  typeof PrincipalWithPrivateSpaceSchema
>;
type MaterializeProposal =
  TrustedProviderWriteCapabilityBinding['materializeProposal'];

const PROPOSAL_LIFETIME_MS = 300_000;

type CoreProposalService = Pick<ProposalService, 'create'>;
type RequestScopedGoogleCalendarCoreFactory =
  RequestScopedGoogleCalendarProposalReaderFactory &
    RequestScopedGoogleCalendarConditionalGatewayFactory;

export interface RequestScopedCoreCalendarProposalAdapterDependencies {
  readonly createProposalAuthorityResolver: (input: {
    readonly pool: DatabasePool;
    readonly principal: DurableRepositoryPrincipal;
  }) => TrustedProviderProposalAuthorityResolver;
  readonly createDisclosureGrantResolver: (input: {
    readonly pool: DatabasePool;
    readonly principal: DurableRepositoryPrincipal;
    readonly runId: string;
    readonly householdId: string;
    readonly userId: string;
    readonly spaceAccessGrantId: string;
  }) => TrustedDisclosureGrantResolver;
  readonly createProposalRepository: (input: {
    readonly readPool: DatabasePool;
    readonly workflowPool: DatabasePool;
    readonly principal: DurableRepositoryPrincipal;
  }) => ProposalRepository;
  readonly createProposalService: (input: {
    readonly materializer: TrustedProposalMaterializer;
    readonly disclosureGrantResolver: TrustedDisclosureGrantResolver;
    readonly repository: ProposalRepository;
  }) => CoreProposalService;
  readonly createProposalId: () => string;
  readonly now: () => Date;
}

const defaultDependencies: RequestScopedCoreCalendarProposalAdapterDependencies =
  Object.freeze({
    createProposalAuthorityResolver: ({
      pool,
      principal,
    }: {
      readonly pool: DatabasePool;
      readonly principal: DurableRepositoryPrincipal;
    }) =>
      createPostgresGoogleCalendarProposalAuthorityResolver({
        resolver: new PostgresGoogleCalendarProposalAuthorityResolver(
          pool,
          principal,
        ),
      }),
    createDisclosureGrantResolver: ({
      pool,
      principal,
      runId,
      householdId,
      userId,
      spaceAccessGrantId,
    }: {
      readonly pool: DatabasePool;
      readonly principal: DurableRepositoryPrincipal;
      readonly runId: string;
      readonly householdId: string;
      readonly userId: string;
      readonly spaceAccessGrantId: string;
    }) =>
      new PostgresSchedulerDisclosureGrantResolver(pool, principal, {
        runId,
        householdId,
        userId,
        spaceAccessGrantId,
        agentId: 'scheduler',
        phasePurpose: 'specialist-execution',
        provider: 'openai',
      }),
    createProposalRepository: ({
      readPool,
      workflowPool,
      principal,
    }: {
      readonly readPool: DatabasePool;
      readonly workflowPool: DatabasePool;
      readonly principal: DurableRepositoryPrincipal;
    }) =>
      new PostgresProposalRepository({
        readPool,
        workflowPool,
        principal,
      }),
    createProposalService: ({
      materializer,
      disclosureGrantResolver,
      repository,
    }: {
      readonly materializer: TrustedProposalMaterializer;
      readonly disclosureGrantResolver: TrustedDisclosureGrantResolver;
      readonly repository: ProposalRepository;
    }) =>
      new ProposalService(materializer, disclosureGrantResolver, repository),
    createProposalId: randomUUID,
    now: () => new Date(),
  });

const durablePrincipalFor = (
  principal: PrincipalWithPrivateSpace,
  requestId: string,
): DurableRepositoryPrincipal =>
  Object.freeze({
    userId: principal.userId,
    householdId: principal.householdId,
    sessionId: principal.sessionId,
    requestId,
  });

const sameAuthorityBinding = (left: unknown, right: unknown): boolean => {
  const parsedLeft = ProviderWriteAuthorityBindingSchema.safeParse(left);
  const parsedRight = ProviderWriteAuthorityBindingSchema.safeParse(right);
  return (
    parsedLeft.success &&
    parsedRight.success &&
    hashCanonicalJson(parsedLeft.data) === hashCanonicalJson(parsedRight.data)
  );
};

const proposalExpiry = (now: Date, grantExpiresAt: string): string => {
  const nowMs = now.getTime();
  const grantExpiryMs = Date.parse(grantExpiresAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(grantExpiryMs)) {
    throw new Error('api-core-calendar-proposal-time-invalid');
  }
  const expiresAtMs = Math.min(nowMs + PROPOSAL_LIFETIME_MS, grantExpiryMs);
  if (expiresAtMs <= nowMs) {
    throw new Error('api-core-calendar-proposal-disclosure-expired');
  }
  return new Date(expiresAtMs).toISOString();
};

const createPresenter = (): TrustedProviderWriteDecisionPresenter =>
  Object.freeze({
    present: async (
      rawInput: Parameters<TrustedProviderWriteDecisionPresenter['present']>[0],
    ) => {
      const proposal = ActionProposalSchema.parse(rawInput.proposal);
      const decision = ActionDecisionSchema.parse(rawInput.visualDecision);
      const expectedDecision =
        rawInput.decision === 'approve' ? 'approved' : 'rejected';
      if (
        proposal.capabilityId !== 'google-calendar.event.create' ||
        decision.proposalId !== proposal.id ||
        decision.decision !== expectedDecision ||
        decision.payloadHash !== proposal.payloadHash ||
        decision.approvalHash !== proposal.approvalHash
      ) {
        throw new Error('api-core-calendar-proposal-presentation-invalid');
      }
      return JsonValueSchema.parse({
        summary:
          rawInput.decision === 'approve'
            ? `Calendar event proposal ${proposal.id} was approved and executed.`
            : `Calendar event proposal ${proposal.id} was rejected.`,
        clarificationQuestion: null,
        evidenceReferences: [],
        derivedValueReferences: [],
        actionProposalReferences: [proposal.id],
      });
    },
  });

const FinanceGuardedActionContextSchema = MaterializationContextSchema.extend({
  agentId: z.literal('finance'),
});

const FinanceGuardedActionCapabilityIdSchema = z.enum([
  'finance.records.write',
  'finance.statement.import',
]);
const FinanceGuardedActionOperationSchema = z.enum([
  'finance-adjustment',
  'finance-reversal',
  'finance-statement-import-commit',
  'finance-document-review-commit',
  'finance-document-match-accept',
  'finance-document-delete',
]);

const FinanceDocumentGuardedIntentSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('commit-document-review'),
    documentId: UuidSchema,
  }),
  z.strictObject({
    kind: z.literal('accept-document-match'),
    matchId: UuidSchema,
  }),
  z.strictObject({
    kind: z.literal('delete-document'),
    documentId: UuidSchema,
  }),
]);

const FinanceDocumentGuardedTargetSchema = z.strictObject({
  targetBindingHash: Sha256Schema,
  preview: z.strictObject({
    documentId: UuidSchema,
    beforeState: z.string().trim().min(1).max(64),
    afterState: z.string().trim().min(1).max(64),
    extractionRevision: z.number().int().positive().nullable(),
    matchId: UuidSchema.optional(),
  }),
});

const FinanceDocumentGuardedProposalPreviewSchema = z.strictObject({
  state: z.string().trim().min(1).max(64),
  operation: FinanceGuardedActionOperationSchema,
  documentId: UuidSchema,
  extractionRevision: z.number().int().positive().nullable(),
  matchId: UuidSchema.optional(),
});

/**
 * The capability runtime owns complete output validation. The presenter adds
 * the narrower, proposal-specific binding that prevents a valid-looking
 * Finance result for one mutation from being presented as another mutation's
 * approved execution. proposalGateway invokes the exact canonical capability
 * arguments, which binds amount and reason; this presenter validates the
 * resulting operation-specific durable state.
 */
const FinanceSuccessfulRecordWriteOutputSchema = z.object({
  schemaVersion: z.literal(1),
  result: z.object({
    status: z.enum(['applied', 'duplicate']),
    record: z.object({
      id: z.string().trim().min(1),
      recordType: z.literal('transaction'),
      revision: z.number().int().positive(),
      status: z.enum(['active', 'reversed']),
    }),
  }),
});

const FinanceSuccessfulStatementImportOutputSchema = z.object({
  schemaVersion: z.literal(1),
  result: z.object({
    status: z.enum(['committed', 'replayed']),
    receipt: z.object({
      planId: z.string().trim().min(1),
      transactionCount: z.number().int().positive(),
      verified: z.literal(true),
    }),
    sourceDeletionAuthorized: z.literal(true),
  }),
});

const FinanceDocumentCommittedOutputSchema = z.object({
  schemaVersion: z.literal(1),
  result: z.object({
    status: z.literal('document-committed'),
    documentId: z.string().trim().min(1),
    extractionRevision: z.number().int().positive(),
  }),
});

const FinanceDocumentMatchAcceptedOutputSchema = z.object({
  schemaVersion: z.literal(1),
  result: z.object({
    status: z.literal('match-accepted'),
    documentId: z.string().trim().min(1),
    matchId: z.string().trim().min(1),
  }),
});

const FinanceDocumentDeletedOutputSchema = z.object({
  schemaVersion: z.literal(1),
  result: z.object({
    status: z.enum(['document-deleted', 'document-purge-pending']),
    documentId: z.string().trim().min(1),
  }),
});

const FinanceAdjustmentCanonicalArgumentsSchema = z.object({
  schemaVersion: z.literal(1),
  mutation: z.object({
    kind: z.literal('adjust'),
    transactionId: z.string().trim().min(1),
  }),
});

const FinanceReversalCanonicalArgumentsSchema = z.object({
  schemaVersion: z.literal(1),
  mutation: z.object({
    kind: z.literal('reverse'),
    transactionId: z.string().trim().min(1),
  }),
});

const FinanceStatementImportCanonicalArgumentsSchema = z.object({
  schemaVersion: z.literal(1),
  request: z.object({
    kind: z.literal('commit'),
    planId: z.string().trim().min(1),
  }),
});

const documentGuardedIntentFor = (input: {
  readonly operation: string;
  readonly arguments: unknown;
}): FinanceDocumentGuardedActionIntent | undefined => {
  const parsed = z
    .strictObject({
      schemaVersion: z.literal(1),
      mutation: FinanceDocumentGuardedIntentSchema,
    })
    .safeParse(input.arguments);
  if (!parsed.success) return undefined;
  const intent = parsed.data.mutation;
  if (
    (input.operation === 'finance-document-review-commit' &&
      intent.kind === 'commit-document-review') ||
    (input.operation === 'finance-document-match-accept' &&
      intent.kind === 'accept-document-match') ||
    (input.operation === 'finance-document-delete' &&
      intent.kind === 'delete-document')
  ) {
    return deepFreeze(intent) as FinanceDocumentGuardedActionIntent;
  }
  return undefined;
};

const financeDocumentPreviewFor = (input: {
  readonly proposal: z.output<typeof ActionProposalSchema>;
  readonly operation: z.output<typeof FinanceGuardedActionOperationSchema>;
}) => {
  const before = FinanceDocumentGuardedProposalPreviewSchema.safeParse(
    input.proposal.beforePreview,
  );
  const after = FinanceDocumentGuardedProposalPreviewSchema.safeParse(
    input.proposal.afterPreview,
  );
  if (
    !before.success ||
    !after.success ||
    before.data.operation !== input.operation ||
    after.data.operation !== input.operation ||
    before.data.documentId !== after.data.documentId ||
    before.data.extractionRevision !== after.data.extractionRevision ||
    before.data.matchId !== after.data.matchId
  ) {
    return undefined;
  }
  return deepFreeze(before.data);
};

const financeGuardedActionExecutionMatchesProposal = (input: {
  readonly proposal: z.output<typeof ActionProposalSchema>;
  readonly capabilityId: z.output<
    typeof FinanceGuardedActionCapabilityIdSchema
  >;
  readonly capabilityOutput: unknown;
}): boolean => {
  const classification = classifyFinanceGuardedAction({
    capabilityId: input.capabilityId,
    arguments: input.proposal.canonicalArguments,
  });
  const operation = FinanceGuardedActionOperationSchema.safeParse(
    classification?.operation,
  );
  if (
    !operation.success ||
    input.proposal.guardedAction === undefined ||
    input.proposal.guardedAction.operation !== operation.data ||
    input.proposal.guardedAction.actionHash !==
      hashCanonicalJson(input.proposal.canonicalArguments) ||
    input.proposal.payloadHash !==
      hashCanonicalJson(input.proposal.canonicalArguments)
  ) {
    return false;
  }

  if (operation.data === 'finance-adjustment') {
    const canonical = FinanceAdjustmentCanonicalArgumentsSchema.safeParse(
      input.proposal.canonicalArguments,
    );
    const output = FinanceSuccessfulRecordWriteOutputSchema.safeParse(
      input.capabilityOutput,
    );
    return (
      canonical.success &&
      output.success &&
      output.data.result.record.id === canonical.data.mutation.transactionId &&
      output.data.result.record.status === 'active'
    );
  }

  if (operation.data === 'finance-reversal') {
    const canonical = FinanceReversalCanonicalArgumentsSchema.safeParse(
      input.proposal.canonicalArguments,
    );
    const output = FinanceSuccessfulRecordWriteOutputSchema.safeParse(
      input.capabilityOutput,
    );
    return (
      canonical.success &&
      output.success &&
      output.data.result.record.id === canonical.data.mutation.transactionId &&
      output.data.result.record.status === 'reversed'
    );
  }

  if (operation.data === 'finance-statement-import-commit') {
    const canonical = FinanceStatementImportCanonicalArgumentsSchema.safeParse(
      input.proposal.canonicalArguments,
    );
    const output = FinanceSuccessfulStatementImportOutputSchema.safeParse(
      input.capabilityOutput,
    );
    return (
      canonical.success &&
      output.success &&
      output.data.result.receipt.planId === canonical.data.request.planId
    );
  }

  const documentIntent = documentGuardedIntentFor({
    operation: operation.data,
    arguments: input.proposal.canonicalArguments,
  });
  if (documentIntent === undefined) return false;
  const documentPreview = financeDocumentPreviewFor({
    proposal: input.proposal,
    operation: operation.data,
  });
  if (documentPreview === undefined) return false;

  if (documentIntent.kind === 'commit-document-review') {
    const output = FinanceDocumentCommittedOutputSchema.safeParse(
      input.capabilityOutput,
    );
    return (
      output.success &&
      documentPreview.documentId === documentIntent.documentId &&
      documentPreview.extractionRevision !== null &&
      output.data.result.documentId === documentPreview.documentId &&
      output.data.result.extractionRevision ===
        documentPreview.extractionRevision
    );
  }

  if (documentIntent.kind === 'accept-document-match') {
    const output = FinanceDocumentMatchAcceptedOutputSchema.safeParse(
      input.capabilityOutput,
    );
    return (
      output.success &&
      documentPreview.matchId === documentIntent.matchId &&
      output.data.result.documentId === documentPreview.documentId &&
      output.data.result.matchId === documentPreview.matchId
    );
  }

  const output = FinanceDocumentDeletedOutputSchema.safeParse(
    input.capabilityOutput,
  );
  return (
    output.success &&
    documentPreview.documentId === documentIntent.documentId &&
    output.data.result.documentId === documentPreview.documentId
  );
};

type FinanceGuardedActionProposalService = Pick<ProposalService, 'create'>;

export interface RequestScopedFinanceGuardedActionProposalAdapterDependencies {
  readonly createDisclosureGrantResolver: (input: {
    readonly pool: DatabasePool;
    readonly principal: DurableRepositoryPrincipal;
    readonly runId: string;
    readonly householdId: string;
    readonly userId: string;
    readonly spaceAccessGrantId: string;
  }) => TrustedDisclosureGrantResolver;
  readonly createProposalRepository: (input: {
    readonly readPool: DatabasePool;
    readonly workflowPool: DatabasePool;
    readonly principal: DurableRepositoryPrincipal;
  }) => ProposalRepository;
  readonly createProposalService: (input: {
    readonly materializer: TrustedProposalMaterializer;
    readonly disclosureGrantResolver: TrustedDisclosureGrantResolver;
    readonly repository: ProposalRepository;
  }) => FinanceGuardedActionProposalService;
  readonly createProposalId: () => string;
  readonly now: () => Date;
}

const defaultFinanceGuardedActionProposalDependencies: RequestScopedFinanceGuardedActionProposalAdapterDependencies =
  Object.freeze({
    createDisclosureGrantResolver: ({
      pool,
      principal,
      runId,
      householdId,
      userId,
      spaceAccessGrantId,
    }: Parameters<
      RequestScopedFinanceGuardedActionProposalAdapterDependencies['createDisclosureGrantResolver']
    >[0]) =>
      new PostgresSchedulerDisclosureGrantResolver(pool, principal, {
        runId,
        householdId,
        userId,
        spaceAccessGrantId,
        agentId: 'finance',
        phasePurpose: 'specialist-execution',
        provider: 'openai',
      }),
    createProposalRepository: ({
      readPool,
      workflowPool,
      principal,
    }: Parameters<
      RequestScopedFinanceGuardedActionProposalAdapterDependencies['createProposalRepository']
    >[0]) =>
      new PostgresProposalRepository({ readPool, workflowPool, principal }),
    createProposalService: ({
      materializer,
      disclosureGrantResolver,
      repository,
    }: Parameters<
      RequestScopedFinanceGuardedActionProposalAdapterDependencies['createProposalService']
    >[0]) =>
      new ProposalService(materializer, disclosureGrantResolver, repository),
    createProposalId: randomUUID,
    now: () => new Date(),
  });

const financeGuardedActionMaterial = (input: {
  readonly proposalId: string;
  readonly principal: PrincipalWithPrivateSpace;
  readonly runId: string;
  readonly disclosureGrantId: string;
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  readonly capabilityFingerprint: string;
  readonly operation: string;
  readonly actionHash: string;
  /** Content-free, server-materialized document state for guarded mutations. */
  readonly target?: FinanceDocumentGuardedActionTarget;
}) => {
  const documentPreview =
    input.target === undefined
      ? undefined
      : deepFreeze({
          documentId: input.target.preview.documentId,
          beforeState: input.target.preview.beforeState,
          afterState: input.target.preview.afterState,
          extractionRevision: input.target.preview.extractionRevision,
          ...(input.target.preview.matchId === undefined
            ? {}
            : { matchId: input.target.preview.matchId }),
        });
  const executionBindingHash = hashFinanceGuardedActionExecutionBinding({
    proposalId: input.proposalId,
    scope: {
      runId: input.runId,
      userId: input.principal.userId,
      householdId: input.principal.householdId,
      sessionId: input.principal.sessionId,
      privateSpaceId: input.principal.privateSpaceId,
      spaceAccessGrantId: input.principal.spaceAccessGrantId,
      collectionAuthorizationScopeFingerprint:
        input.principal.collectionAuthorizationScopeFingerprint,
      disclosureGrantId: input.disclosureGrantId,
    },
    capabilityId: FinanceGuardedActionCapabilityIdSchema.parse(
      input.capabilityId,
    ),
    capabilityVersion: input.capabilityVersion,
    capabilityFingerprint: input.capabilityFingerprint,
    operation: FinanceGuardedActionOperationSchema.parse(input.operation),
    actionHash: input.actionHash,
    ...(input.target === undefined
      ? {}
      : { targetBindingHash: input.target.targetBindingHash }),
  });
  return deepFreeze({
    targets: [
      {
        kind: 'finance.guarded-action',
        id: input.actionHash,
        expectedVersion: input.capabilityVersion,
      },
    ],
    beforePreview:
      documentPreview === undefined
        ? {
            state: 'not-applied',
            operation: input.operation,
          }
        : {
            state: documentPreview.beforeState,
            operation: input.operation,
            documentId: documentPreview.documentId,
            extractionRevision: documentPreview.extractionRevision,
            ...(documentPreview.matchId === undefined
              ? {}
              : { matchId: documentPreview.matchId }),
          },
    afterPreview:
      documentPreview === undefined
        ? {
            state: 'approved-action',
            operation: input.operation,
          }
        : {
            state: documentPreview.afterState,
            operation: input.operation,
            documentId: documentPreview.documentId,
            extractionRevision: documentPreview.extractionRevision,
            ...(documentPreview.matchId === undefined
              ? {}
              : { matchId: documentPreview.matchId }),
          },
    approvalDisplay: {
      schemaVersion: 1 as const,
      title: 'Review Finance action',
      summary: 'EMDO needs your approval before applying this Finance action.',
      beforeSummary: 'No Finance change has been applied.',
      afterSummary: 'EMDO will apply the approved Finance action.',
      fields: [
        { label: 'Action', value: input.operation },
        { label: 'Capability', value: input.capabilityId },
        ...(documentPreview === undefined
          ? []
          : [
              { label: 'Document', value: documentPreview.documentId },
              {
                label: 'Review revision',
                value:
                  documentPreview.extractionRevision === null
                    ? 'none'
                    : String(documentPreview.extractionRevision),
              },
              ...(documentPreview.matchId === undefined
                ? []
                : [
                    {
                      label: 'Suggested match',
                      value: documentPreview.matchId,
                    },
                  ]),
            ]),
      ],
    },
    providerPreconditions: [
      {
        kind: 'finance.guarded-action-binding',
        targetId: input.actionHash,
        expectedValue: executionBindingHash,
      },
    ],
    providerAuthorityBindingHash: executionBindingHash,
  });
};

export const createFinanceGuardedActionPresenter =
  (): TrustedProviderWriteDecisionPresenter =>
    Object.freeze({
      present: async (
        rawInput: Parameters<
          TrustedProviderWriteDecisionPresenter['present']
        >[0],
      ) => {
        const proposal = ActionProposalSchema.parse(rawInput.proposal);
        const decision = ActionDecisionSchema.parse(rawInput.visualDecision);
        const expectedDecision =
          rawInput.decision === 'approve' ? 'approved' : 'rejected';
        const capabilityId = FinanceGuardedActionCapabilityIdSchema.safeParse(
          proposal.capabilityId,
        );
        if (
          !capabilityId.success ||
          proposal.guardedAction === undefined ||
          proposal.guardedAction.actionHash !== proposal.payloadHash ||
          proposal.guardedAction.executionBindingHash !==
            proposal.providerAuthorityBindingHash ||
          decision.proposalId !== proposal.id ||
          decision.decision !== expectedDecision ||
          decision.payloadHash !== proposal.payloadHash ||
          decision.approvalHash !== proposal.approvalHash ||
          (rawInput.decision === 'approve' &&
            !financeGuardedActionExecutionMatchesProposal({
              proposal,
              capabilityId: capabilityId.data,
              capabilityOutput: rawInput.capabilityOutput,
            }))
        ) {
          throw new Error('api-finance-guarded-action-presentation-invalid');
        }
        const approvedDeletion =
          rawInput.decision === 'approve'
            ? FinanceDocumentDeletedOutputSchema.safeParse(
                rawInput.capabilityOutput,
              )
            : undefined;
        const deletionFinalizationPending =
          approvedDeletion?.success === true &&
          approvedDeletion.data.result.status === 'document-purge-pending';
        return JsonValueSchema.parse({
          summary:
            rawInput.decision === 'approve'
              ? deletionFinalizationPending
                ? `Finance action proposal ${proposal.id} was approved. Access was revoked, but verified deletion finalization is pending and requires a retry.`
                : `Finance action proposal ${proposal.id} was approved and executed.`
              : `Finance action proposal ${proposal.id} was rejected.`,
          clarificationQuestion: null,
          evidenceReferences: [],
          derivedValueReferences: [],
          actionProposalReferences: [proposal.id],
        });
      },
    });

const createCompositeProposalPresenter = (input: {
  readonly calendar: TrustedProviderWriteDecisionPresenter;
  readonly finance?: TrustedProviderWriteDecisionPresenter;
}): TrustedProviderWriteDecisionPresenter =>
  Object.freeze({
    present: async (
      rawInput: Parameters<TrustedProviderWriteDecisionPresenter['present']>[0],
    ) => {
      const proposal = ActionProposalSchema.parse(rawInput.proposal);
      if (proposal.capabilityId === 'google-calendar.event.create') {
        return input.calendar.present(rawInput);
      }
      if (
        input.finance !== undefined &&
        (proposal.capabilityId === 'finance.records.write' ||
          proposal.capabilityId === 'finance.statement.import')
      ) {
        return input.finance.present(rawInput);
      }
      throw new Error('api-core-proposal-presentation-capability-invalid');
    },
  });

/**
 * Request-scoped materialization for Finance actions that the trusted
 * classification marks as requiring visual approval. It writes the same
 * ActionProposal/preparation record used by provider writes; it does not mint
 * a Finance-specific approval token or bypass the durable decision lifecycle.
 */
export const createRequestScopedFinanceGuardedActionProposalAdapter = (
  rawInput: Readonly<{
    readonly principal: unknown;
    readonly requestId: unknown;
    readonly runId: unknown;
    readonly readPool: DatabasePool;
    readonly workflowPool: DatabasePool;
    /** Internal only; absent means document mutations cannot materialize. */
    readonly guardedDocumentActions?: FinanceDocumentGuardedActionPort;
  }>,
  dependencies: RequestScopedFinanceGuardedActionProposalAdapterDependencies = defaultFinanceGuardedActionProposalDependencies,
): TrustedGuardedActionProposalMaterializer => {
  const principal = PrincipalWithPrivateSpaceSchema.safeParse(
    rawInput.principal,
  );
  const requestId = UuidSchema.safeParse(rawInput.requestId);
  const runId = UuidSchema.safeParse(rawInput.runId);
  if (
    !principal.success ||
    !requestId.success ||
    !runId.success ||
    rawInput.readPool === rawInput.workflowPool ||
    typeof rawInput.readPool?.connect !== 'function' ||
    typeof rawInput.workflowPool?.connect !== 'function' ||
    typeof dependencies.createDisclosureGrantResolver !== 'function' ||
    typeof dependencies.createProposalRepository !== 'function' ||
    typeof dependencies.createProposalService !== 'function' ||
    typeof dependencies.createProposalId !== 'function' ||
    typeof dependencies.now !== 'function' ||
    (rawInput.guardedDocumentActions !== undefined &&
      (typeof rawInput.guardedDocumentActions.materializeTarget !==
        'function' ||
        typeof rawInput.guardedDocumentActions.executeApproved !== 'function'))
  ) {
    throw new Error('api-finance-guarded-action-adapter-unavailable');
  }

  const fixedPrincipal = deepFreeze(principal.data);
  const fixedRequestId = requestId.data;
  const fixedRunId = runId.data;
  const durablePrincipal = durablePrincipalFor(fixedPrincipal, fixedRequestId);
  const disclosureGrantResolver = dependencies.createDisclosureGrantResolver({
    pool: rawInput.readPool,
    principal: durablePrincipal,
    runId: fixedRunId,
    householdId: fixedPrincipal.householdId,
    userId: fixedPrincipal.userId,
    spaceAccessGrantId: fixedPrincipal.spaceAccessGrantId,
  });
  const repository = dependencies.createProposalRepository({
    readPool: rawInput.readPool,
    workflowPool: rawInput.workflowPool,
    principal: durablePrincipal,
  });
  if (
    typeof disclosureGrantResolver?.resolve !== 'function' ||
    typeof repository?.transaction !== 'function'
  ) {
    throw new Error('api-finance-guarded-action-adapter-unavailable');
  }

  return Object.freeze({
    materializeProposal: async (
      rawMaterialization: Parameters<
        TrustedGuardedActionProposalMaterializer['materializeProposal']
      >[0],
    ) => {
      const context = FinanceGuardedActionContextSchema.parse(
        rawMaterialization.context,
      );
      const capabilityId = FinanceGuardedActionCapabilityIdSchema.parse(
        rawMaterialization.capabilityId,
      );
      const descriptor = CapabilityDescriptorSchema.parse(
        rawMaterialization.descriptor,
      );
      const argumentsValue = JsonValueSchema.parse(
        rawMaterialization.arguments,
      );
      const classification = classifyFinanceGuardedAction({
        capabilityId,
        arguments: argumentsValue,
      });
      if (
        context.abortSignal.aborted ||
        context.requestId !== fixedRequestId ||
        context.runId !== fixedRunId ||
        context.householdId !== fixedPrincipal.householdId ||
        context.userId !== fixedPrincipal.userId ||
        context.authenticatedSessionId !== fixedPrincipal.sessionId ||
        context.spaceAccessGrantId !== fixedPrincipal.spaceAccessGrantId ||
        context.authorizationScopeFingerprint !==
          fixedPrincipal.collectionAuthorizationScopeFingerprint ||
        descriptor.id !== capabilityId ||
        descriptor.capabilityKind === 'provider-write' ||
        (descriptor.capabilityKind !== 'local-write' &&
          descriptor.capabilityKind !== 'import') ||
        (capabilityId === 'finance.records.write' &&
          descriptor.capabilityKind !== 'local-write') ||
        (capabilityId === 'finance.statement.import' &&
          descriptor.capabilityKind !== 'import') ||
        descriptor.approval.rule !== 'authenticated-visual-proposal' ||
        classification === undefined ||
        !FinanceGuardedActionOperationSchema.safeParse(classification.operation)
          .success ||
        classification.operation !== rawMaterialization.operation
      ) {
        throw new Error('api-finance-guarded-action-request-binding-invalid');
      }
      const capabilityFingerprint = hashCapabilityDescriptorBinding(descriptor);
      const disclosureGrant = await disclosureGrantResolver.resolve(
        context.disclosureGrantId,
      );
      if (
        disclosureGrant === undefined ||
        disclosureGrant.id !== context.disclosureGrantId ||
        disclosureGrant.runId !== fixedRunId ||
        disclosureGrant.userId !== fixedPrincipal.userId ||
        disclosureGrant.householdId !== fixedPrincipal.householdId ||
        disclosureGrant.agentId !== 'finance'
      ) {
        throw new Error('api-finance-guarded-action-disclosure-invalid');
      }
      const now = new Date(dependencies.now());
      if (
        !Number.isFinite(now.getTime()) ||
        now.getTime() < Date.parse(disclosureGrant.createdAt)
      ) {
        throw new Error('api-finance-guarded-action-time-invalid');
      }
      const documentIntent = documentGuardedIntentFor({
        operation: classification.operation,
        arguments: argumentsValue,
      });
      const requiresDocumentTarget =
        classification.operation === 'finance-document-review-commit' ||
        classification.operation === 'finance-document-match-accept' ||
        classification.operation === 'finance-document-delete';
      let documentTarget: FinanceDocumentGuardedActionTarget | undefined;
      if (requiresDocumentTarget) {
        if (
          documentIntent === undefined ||
          rawInput.guardedDocumentActions === undefined
        ) {
          throw new Error('api-finance-guarded-action-document-unavailable');
        }
        documentTarget = FinanceDocumentGuardedTargetSchema.parse(
          await rawInput.guardedDocumentActions.materializeTarget({
            scope: deepFreeze({
              requestId: fixedRequestId,
              runId: fixedRunId,
              userId: fixedPrincipal.userId,
              householdId: fixedPrincipal.householdId,
              sessionId: fixedPrincipal.sessionId,
              privateSpaceId: fixedPrincipal.privateSpaceId,
              spaceAccessGrantId: fixedPrincipal.spaceAccessGrantId,
              collectionAuthorizationScopeFingerprint:
                fixedPrincipal.collectionAuthorizationScopeFingerprint,
              disclosureGrantId: disclosureGrant.id,
              abortSignal: context.abortSignal,
            } satisfies FinanceCapabilityScope),
            operation:
              classification.operation as FinanceDocumentGuardedActionOperation,
            intent: documentIntent,
          }),
        ) as FinanceDocumentGuardedActionTarget;
      } else if (documentIntent !== undefined) {
        throw new Error('api-finance-guarded-action-document-binding-invalid');
      }
      const id = UuidSchema.parse(dependencies.createProposalId());
      const actionHash = hashCanonicalJson(argumentsValue);
      const material = financeGuardedActionMaterial({
        proposalId: id,
        principal: fixedPrincipal,
        runId: fixedRunId,
        disclosureGrantId: disclosureGrant.id,
        capabilityId,
        capabilityVersion: descriptor.version,
        capabilityFingerprint,
        operation: classification.operation,
        actionHash,
        ...(documentTarget === undefined ? {} : { target: documentTarget }),
      });
      const materializer: TrustedProposalMaterializer = Object.freeze({
        materialize: async (
          input: Parameters<TrustedProposalMaterializer['materialize']>[0],
        ) => {
          if (
            input.capabilityId !== capabilityId ||
            input.capabilityFingerprint !== capabilityFingerprint ||
            hashCanonicalJson(input.canonicalArguments) !== actionHash ||
            hashCanonicalJson(input.disclosureGrant) !==
              hashCanonicalJson(disclosureGrant)
          ) {
            throw new Error(
              'api-finance-guarded-action-materialization-invalid',
            );
          }
          return material;
        },
      });
      const createdAt = now.toISOString();
      const executionBindingHash = material.providerAuthorityBindingHash;
      const proposalBase = {
        schemaVersion: 1 as const,
        id,
        version: 1,
        runId: fixedRunId,
        capabilityId,
        capabilityFingerprint,
        authorizationScopeFingerprint:
          fixedPrincipal.collectionAuthorizationScopeFingerprint,
        canonicalArguments: argumentsValue,
        ...material,
        providerSdkCallId: context.sdkCallId,
        guardedAction: {
          capabilityVersion: descriptor.version,
          operation: classification.operation,
          actionHash,
          executionBindingHash,
        },
        payloadHash: actionHash,
        disclosureGrant,
        createdAt,
        expiresAt: proposalExpiry(now, disclosureGrant.expiresAt),
        idempotencyKey: hashCanonicalJson({
          domain: 'emdo.finance-guarded-action-proposal.v1',
          requestId: fixedRequestId,
          runId: fixedRunId,
          sdkCallId: context.sdkCallId,
          householdId: fixedPrincipal.householdId,
          userId: fixedPrincipal.userId,
          authenticatedSessionId: fixedPrincipal.sessionId,
          spaceAccessGrantId: fixedPrincipal.spaceAccessGrantId,
          authorizationScopeFingerprint:
            fixedPrincipal.collectionAuthorizationScopeFingerprint,
          disclosureGrantId: disclosureGrant.id,
          capabilityId,
          capabilityVersion: descriptor.version,
          capabilityFingerprint,
          operation: classification.operation,
          actionHash,
          ...(documentTarget === undefined
            ? {}
            : { targetBindingHash: documentTarget.targetBindingHash }),
        }),
        state: 'pending' as const,
      };
      const proposal = ActionProposalSchema.parse({
        ...proposalBase,
        approvalHash: hashActionProposalApproval(proposalBase),
      });
      const preparation: ProposalPreparationBinding = {
        proposalId: proposal.id,
        originRequestId: fixedRequestId,
        runId: fixedRunId,
        householdId: fixedPrincipal.householdId,
        userId: fixedPrincipal.userId,
        originSessionId: fixedPrincipal.sessionId,
        agentId: 'finance',
        originSpaceAccessGrantId: fixedPrincipal.spaceAccessGrantId,
        disclosureGrantId: disclosureGrant.id,
        disclosurePolicyVersion: context.disclosureGrantVersion,
        capabilityId: proposal.capabilityId,
        sdkCallId: context.sdkCallId,
        providerAuthorityBindingHash: executionBindingHash,
      };
      const proposalService = dependencies.createProposalService({
        materializer,
        disclosureGrantResolver,
        repository,
      });
      if (typeof proposalService?.create !== 'function') {
        throw new Error('api-finance-guarded-action-adapter-unavailable');
      }
      const persisted = ActionProposalSchema.parse(
        await proposalService.create(proposal, preparation),
      );
      if (
        persisted.id !== proposal.id ||
        persisted.runId !== proposal.runId ||
        persisted.capabilityId !== proposal.capabilityId ||
        persisted.capabilityFingerprint !== proposal.capabilityFingerprint ||
        persisted.authorizationScopeFingerprint !==
          proposal.authorizationScopeFingerprint ||
        persisted.payloadHash !== proposal.payloadHash ||
        persisted.approvalHash !== proposal.approvalHash ||
        persisted.providerAuthorityBindingHash !==
          proposal.providerAuthorityBindingHash ||
        persisted.providerSdkCallId !== proposal.providerSdkCallId ||
        persisted.disclosureGrant.id !== proposal.disclosureGrant.id ||
        persisted.guardedAction === undefined ||
        persisted.guardedAction.executionBindingHash !== executionBindingHash
      ) {
        throw new Error('api-finance-guarded-action-persistence-invalid');
      }
      return deepFreeze({ sdkCallId: context.sdkCallId, proposal: persisted });
    },
  });
};

/**
 * Request-scoped preparation for the exact Calendar-create proposal path.
 * It owns only server-minted proposal material and the post-decision internal
 * presentation; authentication, provider reads, durable storage, and model
 * execution remain on their already-established boundaries.
 */
export const createRequestScopedCoreCalendarProposalAdapter = (
  rawInput: Readonly<{
    readonly principal: unknown;
    readonly requestId: unknown;
    readonly runId: unknown;
    readonly readPool: DatabasePool;
    readonly workflowPool: DatabasePool;
    readonly google: RequestScopedGoogleCalendarProposalReaderFactory;
  }>,
  dependencies: RequestScopedCoreCalendarProposalAdapterDependencies = defaultDependencies,
): Readonly<{
  readonly materializeProposal: MaterializeProposal;
  readonly presenter: TrustedProviderWriteDecisionPresenter;
}> => {
  const principal = PrincipalWithPrivateSpaceSchema.safeParse(
    rawInput.principal,
  );
  const requestId = UuidSchema.safeParse(rawInput.requestId);
  const runId = UuidSchema.safeParse(rawInput.runId);
  if (
    !principal.success ||
    !requestId.success ||
    !runId.success ||
    typeof rawInput.readPool?.connect !== 'function' ||
    typeof rawInput.workflowPool?.connect !== 'function' ||
    typeof rawInput.google?.createProposalTargetReader !== 'function' ||
    typeof dependencies.createProposalAuthorityResolver !== 'function' ||
    typeof dependencies.createDisclosureGrantResolver !== 'function' ||
    typeof dependencies.createProposalRepository !== 'function' ||
    typeof dependencies.createProposalService !== 'function' ||
    typeof dependencies.createProposalId !== 'function' ||
    typeof dependencies.now !== 'function'
  ) {
    throw new Error('api-core-calendar-proposal-adapter-unavailable');
  }

  const fixedPrincipal = principal.data;
  const fixedRequestId = requestId.data;
  const fixedRunId = runId.data;
  const durablePrincipal = durablePrincipalFor(fixedPrincipal, fixedRequestId);
  const authorityResolver = dependencies.createProposalAuthorityResolver({
    pool: rawInput.readPool,
    principal: durablePrincipal,
  });
  const disclosureGrantResolver = dependencies.createDisclosureGrantResolver({
    pool: rawInput.readPool,
    principal: durablePrincipal,
    runId: fixedRunId,
    householdId: fixedPrincipal.householdId,
    userId: fixedPrincipal.userId,
    spaceAccessGrantId: fixedPrincipal.spaceAccessGrantId,
  });
  const repository = dependencies.createProposalRepository({
    readPool: rawInput.readPool,
    workflowPool: rawInput.workflowPool,
    principal: durablePrincipal,
  });
  if (
    typeof authorityResolver?.resolve !== 'function' ||
    typeof disclosureGrantResolver?.resolve !== 'function' ||
    typeof repository?.transaction !== 'function'
  ) {
    throw new Error('api-core-calendar-proposal-adapter-unavailable');
  }

  const materializeProposal: MaterializeProposal = async (
    rawMaterialization,
  ) => {
    const context = MaterializationContextSchema.parse(
      rawMaterialization.context,
    );
    const argumentsValue = CalendarCanonicalArgumentsSchema.parse(
      rawMaterialization.arguments,
    );
    if (
      rawMaterialization.capabilityId !== 'google-calendar.event.create' ||
      argumentsValue.operation !== 'create' ||
      context.requestId !== fixedRequestId ||
      context.runId !== fixedRunId ||
      context.householdId !== fixedPrincipal.householdId ||
      context.userId !== fixedPrincipal.userId ||
      context.authenticatedSessionId !== fixedPrincipal.sessionId ||
      context.spaceAccessGrantId !== fixedPrincipal.spaceAccessGrantId ||
      context.authorizationScopeFingerprint !==
        fixedPrincipal.collectionAuthorizationScopeFingerprint
    ) {
      throw new Error('api-core-calendar-proposal-request-binding-invalid');
    }
    const capabilityFingerprint = hashCapabilityDescriptorBinding(
      rawMaterialization.descriptor,
    );
    const authority = await authorityResolver.resolve({
      requestId: fixedRequestId,
      runId: fixedRunId,
      householdId: fixedPrincipal.householdId,
      userId: fixedPrincipal.userId,
      authenticatedSessionId: fixedPrincipal.sessionId,
      agentId: 'scheduler',
      spaceAccessGrantId: fixedPrincipal.spaceAccessGrantId,
      authorizationScopeFingerprint:
        fixedPrincipal.collectionAuthorizationScopeFingerprint,
      disclosureGrantId: context.disclosureGrantId,
      sdkCallId: context.sdkCallId,
      capabilityId: rawMaterialization.capabilityId,
      capabilityFingerprint,
    });
    if (
      authority === undefined ||
      !sameAuthorityBinding(
        authority.authorityBinding,
        rawMaterialization.authorityBinding,
      )
    ) {
      throw new Error('api-core-calendar-proposal-authority-invalid');
    }
    const calendarRuntime = createRequestScopedGoogleCalendarCoreRuntime({
      principal: fixedPrincipal,
      requestId: fixedRequestId,
      authorityResolution: authority,
      google: rawInput.google,
    });
    const materializer = new ScopedCalendarProposalMaterializer(
      calendarRuntime.proposalStateReader,
      authority.authorityBinding,
    );
    const disclosureGrant = await disclosureGrantResolver.resolve(
      context.disclosureGrantId,
    );
    if (disclosureGrant === undefined) {
      throw new Error('api-core-calendar-proposal-disclosure-invalid');
    }
    const now = new Date(dependencies.now());
    if (
      !Number.isFinite(now.getTime()) ||
      now.getTime() < Date.parse(disclosureGrant.createdAt)
    ) {
      throw new Error('api-core-calendar-proposal-time-invalid');
    }
    const material = await materializer.materialize({
      capabilityId: rawMaterialization.capabilityId,
      capabilityFingerprint,
      canonicalArguments: argumentsValue,
      disclosureGrant,
      now,
    });
    const id = UuidSchema.parse(dependencies.createProposalId());
    const createdAt = now.toISOString();
    const idempotencyKey = hashCanonicalJson({
      domain: 'emdo.core-calendar-proposal.v1',
      runId: fixedRunId,
      sdkCallId: context.sdkCallId,
      capabilityId: rawMaterialization.capabilityId,
      capabilityFingerprint,
      authorizationScopeFingerprint:
        fixedPrincipal.collectionAuthorizationScopeFingerprint,
      disclosureGrantId: disclosureGrant.id,
      authorityBinding: authority.authorityBinding,
      canonicalArguments: argumentsValue,
    });
    const proposalBase = {
      schemaVersion: 1 as const,
      id,
      version: 1,
      runId: fixedRunId,
      capabilityId: rawMaterialization.capabilityId,
      capabilityFingerprint,
      authorizationScopeFingerprint:
        fixedPrincipal.collectionAuthorizationScopeFingerprint,
      canonicalArguments: argumentsValue,
      ...material,
      providerSdkCallId: context.sdkCallId,
      payloadHash: hashCanonicalJson(argumentsValue),
      disclosureGrant,
      createdAt,
      expiresAt: proposalExpiry(now, disclosureGrant.expiresAt),
      idempotencyKey,
      state: 'pending' as const,
    };
    const proposal = ActionProposalSchema.parse({
      ...proposalBase,
      approvalHash: hashActionProposalApproval(proposalBase),
    });
    const preparation: ProposalPreparationBinding = {
      proposalId: proposal.id,
      originRequestId: fixedRequestId,
      runId: fixedRunId,
      householdId: fixedPrincipal.householdId,
      userId: fixedPrincipal.userId,
      originSessionId: fixedPrincipal.sessionId,
      agentId: 'scheduler',
      originSpaceAccessGrantId: fixedPrincipal.spaceAccessGrantId,
      disclosureGrantId: disclosureGrant.id,
      disclosurePolicyVersion: context.disclosureGrantVersion,
      capabilityId: proposal.capabilityId,
      sdkCallId: context.sdkCallId,
      providerAuthorityBindingHash: material.providerAuthorityBindingHash,
    };
    const proposalService = dependencies.createProposalService({
      materializer,
      disclosureGrantResolver,
      repository,
    });
    if (typeof proposalService?.create !== 'function') {
      throw new Error('api-core-calendar-proposal-adapter-unavailable');
    }
    const persisted = ActionProposalSchema.parse(
      await proposalService.create(proposal, preparation),
    );
    if (
      persisted.id !== proposal.id ||
      persisted.runId !== proposal.runId ||
      persisted.capabilityId !== proposal.capabilityId ||
      persisted.capabilityFingerprint !== proposal.capabilityFingerprint ||
      persisted.authorizationScopeFingerprint !==
        proposal.authorizationScopeFingerprint ||
      persisted.payloadHash !== proposal.payloadHash ||
      persisted.approvalHash !== proposal.approvalHash ||
      persisted.providerAuthorityBindingHash !==
        proposal.providerAuthorityBindingHash ||
      persisted.providerSdkCallId !== proposal.providerSdkCallId ||
      persisted.disclosureGrant.id !== proposal.disclosureGrant.id
    ) {
      throw new Error('api-core-calendar-proposal-persistence-invalid');
    }
    return deepFreeze({ sdkCallId: context.sdkCallId, proposal: persisted });
  };

  return Object.freeze({
    materializeProposal,
    presenter: createPresenter(),
  });
};

export interface RequestScopedCoreAgentRuntimeFactory {
  readonly scope: Readonly<{
    readonly principal: PrincipalWithPrivateSpace;
    readonly requestId: string;
    readonly runId: string;
    readonly conversationId: string;
  }>;
  readonly runtime:
    CoreProductionAgentRuntime | FinanceV1ProductionAgentRuntime;
  /**
   * Checks only globally configured dependencies. Request authority, provider
   * authority, and provider state remain operation-time checks.
   */
  check(): Promise<boolean>;
}

const noOpTraceSink: LocalTraceSink = Object.freeze({
  append: async () => undefined,
});

/*
 * Manager delegation is declarative: AgentOrchestrator validates the manager
 * plan and dispatches the selected specialist itself. The SDK-facing executor
 * therefore rejects any direct invocation instead of presenting a second
 * delegation transport or an accidental capability backdoor.
 */
const denyDirectSchedulerDelegation = async (): Promise<never> => {
  throw new Error('api-core-scheduler-delegation-direct-invocation-denied');
};

const denyDirectFinanceDelegation = async (): Promise<never> => {
  throw new Error('api-finance-delegation-direct-invocation-denied');
};

const validCheckpointCipher = (
  value: unknown,
): value is ApprovalCheckpointCipher => {
  if (value === null || typeof value !== 'object') return false;
  const cipher = value as Partial<ApprovalCheckpointCipher>;
  return (
    cipher.security?.atRest === 'authenticated-encryption' &&
    cipher.security.algorithm === 'AES-256-GCM' &&
    cipher.security.keyRotation === 'versioned-keyring' &&
    typeof cipher.seal === 'function' &&
    typeof cipher.open === 'function'
  );
};

/**
 * Composes the narrow manager+scheduler runtime, optionally with the registered
 * Finance specialist, for one authenticated request.
 * It constructs no provider clients or calls; all Calendar and OpenAI checks
 * remain deferred to their existing operation/readiness boundaries.
 */
export const createRequestScopedCoreAgentRuntimeFactory = (
  rawInput: Readonly<{
    readonly principal: unknown;
    readonly requestId: unknown;
    readonly runId: unknown;
    readonly conversationId: unknown;
    readonly readPool: DatabasePool;
    readonly workflowPool: DatabasePool;
    readonly google: RequestScopedGoogleCalendarCoreFactory;
    readonly openAi: ProductionOpenAiAgentServiceBundle;
    readonly checkpointCipher: ApprovalCheckpointCipher;
    readonly checkGlobalDependencies: () => Promise<boolean>;
    readonly finance?: TrustedFinanceSpecialistServices;
  }>,
): RequestScopedCoreAgentRuntimeFactory | undefined => {
  const principal = PrincipalWithPrivateSpaceSchema.safeParse(
    rawInput.principal,
  );
  const requestId = UuidSchema.safeParse(rawInput.requestId);
  const runId = UuidSchema.safeParse(rawInput.runId);
  const conversationId = UuidSchema.safeParse(rawInput.conversationId);
  if (
    !principal.success ||
    !requestId.success ||
    !runId.success ||
    !conversationId.success ||
    rawInput.readPool === rawInput.workflowPool ||
    typeof rawInput.readPool?.connect !== 'function' ||
    typeof rawInput.workflowPool?.connect !== 'function' ||
    typeof rawInput.google?.createProposalTargetReader !== 'function' ||
    typeof rawInput.google?.createConditionalGateway !== 'function' ||
    typeof rawInput.openAi?.modelAvailability?.isAvailable !== 'function' ||
    typeof rawInput.openAi.costCalculator?.calculateCadMinor !== 'function' ||
    typeof rawInput.openAi.runner?.run !== 'function' ||
    typeof rawInput.openAi.close !== 'function' ||
    !validCheckpointCipher(rawInput.checkpointCipher) ||
    typeof rawInput.checkGlobalDependencies !== 'function'
  ) {
    return undefined;
  }

  try {
    const fixedPrincipal = deepFreeze(principal.data);
    const fixedRequestId = requestId.data;
    const fixedRunId = runId.data;
    const durablePrincipal = durablePrincipalFor(
      fixedPrincipal,
      fixedRequestId,
    );
    const proposalRepository = new PostgresProposalRepository({
      readPool: rawInput.readPool,
      workflowPool: rawInput.workflowPool,
      principal: durablePrincipal,
    });
    const schedulerDisclosureGrantResolver =
      new PostgresSchedulerDisclosureGrantResolver(
        rawInput.readPool,
        durablePrincipal,
        {
          runId: fixedRunId,
          householdId: fixedPrincipal.householdId,
          userId: fixedPrincipal.userId,
          spaceAccessGrantId: fixedPrincipal.spaceAccessGrantId,
          agentId: 'scheduler',
          phasePurpose: 'specialist-execution',
          provider: 'openai',
        },
      );
    const financeDisclosureGrantResolver =
      rawInput.finance === undefined
        ? undefined
        : new PostgresSchedulerDisclosureGrantResolver(
            rawInput.readPool,
            durablePrincipal,
            {
              runId: fixedRunId,
              householdId: fixedPrincipal.householdId,
              userId: fixedPrincipal.userId,
              spaceAccessGrantId: fixedPrincipal.spaceAccessGrantId,
              agentId: 'finance',
              phasePurpose: 'specialist-execution',
              provider: 'openai',
            },
          );
    const proposalAuthorityResolver =
      createPostgresGoogleCalendarProposalAuthorityResolver({
        resolver: new PostgresGoogleCalendarProposalAuthorityResolver(
          rawInput.readPool,
          durablePrincipal,
        ),
      });
    const calendarProposals = createRequestScopedCoreCalendarProposalAdapter(
      {
        principal: fixedPrincipal,
        requestId: fixedRequestId,
        runId: fixedRunId,
        readPool: rawInput.readPool,
        workflowPool: rawInput.workflowPool,
        google: rawInput.google,
      },
      {
        createProposalAuthorityResolver: () => proposalAuthorityResolver,
        createDisclosureGrantResolver: () => schedulerDisclosureGrantResolver,
        createProposalRepository: () => proposalRepository,
        createProposalService: ({
          materializer,
          disclosureGrantResolver: resolver,
          repository,
        }) => new ProposalService(materializer, resolver, repository),
        createProposalId: randomUUID,
        now: () => new Date(),
      },
    );
    const financeGuardedActionProposal =
      rawInput.finance === undefined
        ? undefined
        : createRequestScopedFinanceGuardedActionProposalAdapter(
            {
              principal: fixedPrincipal,
              requestId: fixedRequestId,
              runId: fixedRunId,
              readPool: rawInput.readPool,
              workflowPool: rawInput.workflowPool,
              ...(rawInput.finance.guardedDocumentActions === undefined
                ? {}
                : {
                    guardedDocumentActions:
                      rawInput.finance.guardedDocumentActions,
                  }),
            },
            {
              createDisclosureGrantResolver: () =>
                financeDisclosureGrantResolver!,
              createProposalRepository: () => proposalRepository,
              createProposalService: ({
                materializer,
                disclosureGrantResolver,
                repository,
              }) =>
                new ProposalService(
                  materializer,
                  disclosureGrantResolver,
                  repository,
                ),
              createProposalId: randomUUID,
              now: () => new Date(),
            },
          );
    const proposalDisclosureGrantResolver: TrustedDisclosureGrantResolver =
      Object.freeze({
        resolve: async (
          disclosureGrantId: Parameters<
            TrustedDisclosureGrantResolver['resolve']
          >[0],
        ) => {
          const scheduler =
            await schedulerDisclosureGrantResolver.resolve(disclosureGrantId);
          if (
            scheduler !== undefined ||
            financeDisclosureGrantResolver === undefined
          ) {
            return scheduler;
          }
          return financeDisclosureGrantResolver.resolve(disclosureGrantId);
        },
      });
    const proposalLifecycle = createProposalLifecycleService({
      repository: proposalRepository,
      disclosureGrantResolver: proposalDisclosureGrantResolver,
    });
    const proposals = createProductionProviderProposalComposition({
      proposalService: proposalLifecycle,
      lookup: proposalRepository,
      presenter: createCompositeProposalPresenter({
        calendar: calendarProposals.presenter,
        ...(financeGuardedActionProposal === undefined
          ? {}
          : { finance: createFinanceGuardedActionPresenter() }),
      }),
      authenticatedSessionId: fixedPrincipal.sessionId,
    });
    const calendarEventCreate =
      createRequestScopedGoogleCalendarEventCreateBinding({
        principal: fixedPrincipal,
        pool: rawInput.readPool,
        google: rawInput.google,
        materializeProposal: calendarProposals.materializeProposal,
      });
    const memoryRepository = new PostgresAgentMemoryRepository(
      rawInput.readPool,
      durablePrincipal,
    );
    const memory = createPostgresManagerConversationMemory({
      repository: {
        listConversation: async (conversationId) =>
          (await memoryRepository.listConversation(conversationId)).map(
            (event) => ({
              ...event,
              payload: JsonValueSchema.parse(event.payload),
            }),
          ),
        appendConversationEvent: async (input) => {
          const event = await memoryRepository.appendConversationEvent(input);
          return {
            ...event,
            payload: JsonValueSchema.parse(event.payload),
          };
        },
      },
      principal: {
        householdId: fixedPrincipal.householdId,
        userId: fixedPrincipal.userId,
      },
      privateSpaceId: fixedPrincipal.privateSpaceId,
    });
    const approvalCheckpoints = new ApprovalCheckpointService(
      new PostgresApprovalCheckpointRepository(
        rawInput.readPool,
        durablePrincipal,
      ),
      rawInput.checkpointCipher,
    );
    const modelDisclosureGateway = new PostgresModelDisclosureGateway(
      rawInput.readPool,
      durablePrincipal,
      new CanonicalRecordEnvelopeDisclosureFilter(),
    );
    const disclosureGateway = createPostgresCoreModelDisclosureGateway({
      issuer: new PostgresDataDisclosureGrantIssuer(
        rawInput.readPool,
        durablePrincipal,
      ),
      gateway: {
        authorize: async (input) =>
          modelDisclosureGateway.authorize({
            ...input,
            requestedDataClasses: [...input.requestedDataClasses],
          }),
      },
      privateSpaceId: fixedPrincipal.privateSpaceId,
    });
    const sharedRuntimeDependencies = {
      proposals,
      trustedProviderWriteAuthorityResolver:
        new PostgresGoogleCalendarProviderAuthorityResolver(
          rawInput.readPool,
          durablePrincipal,
        ),
      trustedProviderProposalAuthorityResolver: proposalAuthorityResolver,
      modelAvailability: rawInput.openAi.modelAvailability,
      memory,
      traceSink: noOpTraceSink,
      approvalCheckpoints,
      disclosureGateway,
      costCalculator: rawInput.openAi.costCalculator,
      spendGuard: createRequestScopedModelSpendGuard({
        pool: rawInput.readPool,
        principal: durablePrincipal,
        runId: fixedRunId,
      }),
      executionRunner: rawInput.openAi.runner,
    } as const;
    const runtime =
      rawInput.finance === undefined
        ? createCoreProductionAgentRuntime({
            ...sharedRuntimeDependencies,
            capabilityServices: {
              schedulerDelegation: denyDirectSchedulerDelegation,
              calendarEventCreate,
            },
          })
        : createFinanceV1ProductionAgentRuntime({
            ...sharedRuntimeDependencies,
            capabilityServices: {
              schedulerDelegation: denyDirectSchedulerDelegation,
              financeDelegation: denyDirectFinanceDelegation,
              calendarEventCreate,
              finance: rawInput.finance,
              guardedActionProposal: financeGuardedActionProposal,
            },
          });
    const check = async (): Promise<boolean> => {
      try {
        const global = await rawInput.checkGlobalDependencies();
        if (global !== true) return false;
        return (
          (await rawInput.openAi.modelAvailability.isAvailable(
            'gpt-5.6-terra',
          )) === true
        );
      } catch {
        return false;
      }
    };
    return Object.freeze({
      scope: Object.freeze({
        principal: fixedPrincipal,
        requestId: fixedRequestId,
        runId: fixedRunId,
        conversationId: conversationId.data,
      }),
      runtime,
      check,
    });
  } catch {
    return undefined;
  }
};

export interface RequestScopedManagerFinanceAgentRuntimeFactory {
  readonly scope: RequestScopedCoreAgentRuntimeFactory['scope'];
  readonly runtime:
    ManagerOnlyProductionAgentRuntime | FinanceOnlyProductionAgentRuntime;
  check(): Promise<boolean>;
}

/**
 * Composes EMDO without Scheduler. Finance is admitted only with the existing
 * workflow-backed proposal/decision lifecycle; a bare Manager fallback never
 * exposes a guarded Finance action without that durable authority.
 */
export const createRequestScopedManagerFinanceAgentRuntimeFactory = (
  rawInput: Readonly<{
    readonly principal: unknown;
    readonly requestId: unknown;
    readonly runId: unknown;
    readonly conversationId: unknown;
    readonly readPool: DatabasePool;
    readonly workflowPool?: DatabasePool;
    readonly openAi: ProductionOpenAiAgentServiceBundle;
    readonly checkpointCipher: ApprovalCheckpointCipher;
    readonly checkGlobalDependencies: () => Promise<boolean>;
    readonly finance?: TrustedFinanceSpecialistServices;
  }>,
): RequestScopedManagerFinanceAgentRuntimeFactory | undefined => {
  const principal = PrincipalWithPrivateSpaceSchema.safeParse(
    rawInput.principal,
  );
  const requestId = UuidSchema.safeParse(rawInput.requestId);
  const runId = UuidSchema.safeParse(rawInput.runId);
  const conversationId = UuidSchema.safeParse(rawInput.conversationId);
  if (
    !principal.success ||
    !requestId.success ||
    !runId.success ||
    !conversationId.success ||
    (rawInput.workflowPool !== undefined &&
      (rawInput.workflowPool === rawInput.readPool ||
        typeof rawInput.workflowPool.connect !== 'function')) ||
    (rawInput.finance !== undefined && rawInput.workflowPool === undefined) ||
    typeof rawInput.readPool?.connect !== 'function' ||
    typeof rawInput.openAi?.modelAvailability?.isAvailable !== 'function' ||
    typeof rawInput.openAi.costCalculator?.calculateCadMinor !== 'function' ||
    typeof rawInput.openAi.runner?.run !== 'function' ||
    typeof rawInput.openAi.close !== 'function' ||
    !validCheckpointCipher(rawInput.checkpointCipher) ||
    typeof rawInput.checkGlobalDependencies !== 'function'
  ) {
    return undefined;
  }

  try {
    const fixedPrincipal = deepFreeze(principal.data);
    const fixedRequestId = requestId.data;
    const fixedRunId = runId.data;
    const durablePrincipal = durablePrincipalFor(
      fixedPrincipal,
      fixedRequestId,
    );
    const financeDisclosureGrantResolver =
      rawInput.finance === undefined
        ? undefined
        : new PostgresSchedulerDisclosureGrantResolver(
            rawInput.readPool,
            durablePrincipal,
            {
              runId: fixedRunId,
              householdId: fixedPrincipal.householdId,
              userId: fixedPrincipal.userId,
              spaceAccessGrantId: fixedPrincipal.spaceAccessGrantId,
              agentId: 'finance',
              phasePurpose: 'specialist-execution',
              provider: 'openai',
            },
          );
    const financeProposalRepository =
      rawInput.finance === undefined
        ? undefined
        : new PostgresProposalRepository({
            readPool: rawInput.readPool,
            workflowPool: rawInput.workflowPool!,
            principal: durablePrincipal,
          });
    const financeGuardedActionProposal =
      rawInput.finance === undefined
        ? undefined
        : createRequestScopedFinanceGuardedActionProposalAdapter(
            {
              principal: fixedPrincipal,
              requestId: fixedRequestId,
              runId: fixedRunId,
              readPool: rawInput.readPool,
              workflowPool: rawInput.workflowPool!,
              ...(rawInput.finance.guardedDocumentActions === undefined
                ? {}
                : {
                    guardedDocumentActions:
                      rawInput.finance.guardedDocumentActions,
                  }),
            },
            {
              createDisclosureGrantResolver: () =>
                financeDisclosureGrantResolver!,
              createProposalRepository: () => financeProposalRepository!,
              createProposalService: ({
                materializer,
                disclosureGrantResolver,
                repository,
              }) =>
                new ProposalService(
                  materializer,
                  disclosureGrantResolver,
                  repository,
                ),
              createProposalId: randomUUID,
              now: () => new Date(),
            },
          );
    const financeProposalLifecycle =
      rawInput.finance === undefined
        ? undefined
        : createProposalLifecycleService({
            repository: financeProposalRepository!,
            disclosureGrantResolver: financeDisclosureGrantResolver!,
          });
    const memoryRepository = new PostgresAgentMemoryRepository(
      rawInput.readPool,
      durablePrincipal,
    );
    const memory = createPostgresManagerConversationMemory({
      repository: {
        listConversation: async (id) =>
          (await memoryRepository.listConversation(id)).map((event) => ({
            ...event,
            payload: JsonValueSchema.parse(event.payload),
          })),
        appendConversationEvent: async (input) => {
          const event = await memoryRepository.appendConversationEvent(input);
          return {
            ...event,
            payload: JsonValueSchema.parse(event.payload),
          };
        },
      },
      principal: {
        householdId: fixedPrincipal.householdId,
        userId: fixedPrincipal.userId,
      },
      privateSpaceId: fixedPrincipal.privateSpaceId,
    });
    const approvalCheckpoints = new ApprovalCheckpointService(
      new PostgresApprovalCheckpointRepository(
        rawInput.readPool,
        durablePrincipal,
      ),
      rawInput.checkpointCipher,
    );
    const modelDisclosureGateway = new PostgresModelDisclosureGateway(
      rawInput.readPool,
      durablePrincipal,
      new CanonicalRecordEnvelopeDisclosureFilter(),
    );
    const disclosureGateway = createPostgresCoreModelDisclosureGateway({
      issuer: new PostgresDataDisclosureGrantIssuer(
        rawInput.readPool,
        durablePrincipal,
      ),
      gateway: {
        authorize: async (input) =>
          modelDisclosureGateway.authorize({
            ...input,
            requestedDataClasses: [...input.requestedDataClasses],
          }),
      },
      privateSpaceId: fixedPrincipal.privateSpaceId,
    });
    const deniedProviderWriteAuthority = Object.freeze({
      resolve: async () => undefined,
    });
    const deniedProviderProposalAuthority = Object.freeze({
      resolve: async () => undefined,
    });
    const sharedRuntimeDependencies = {
      proposals:
        financeProposalLifecycle === undefined ||
        financeProposalRepository === undefined
          ? createNoProviderWriteProposalComposition()
          : createProductionProviderProposalComposition({
              proposalService: financeProposalLifecycle,
              lookup: financeProposalRepository,
              presenter: createFinanceGuardedActionPresenter(),
              authenticatedSessionId: fixedPrincipal.sessionId,
            }),
      trustedProviderWriteAuthorityResolver: deniedProviderWriteAuthority,
      trustedProviderProposalAuthorityResolver: deniedProviderProposalAuthority,
      modelAvailability: rawInput.openAi.modelAvailability,
      memory,
      traceSink: noOpTraceSink,
      approvalCheckpoints,
      disclosureGateway,
      costCalculator: rawInput.openAi.costCalculator,
      spendGuard: createRequestScopedModelSpendGuard({
        pool: rawInput.readPool,
        principal: durablePrincipal,
        runId: fixedRunId,
      }),
      executionRunner: rawInput.openAi.runner,
    } as const;
    const runtime =
      rawInput.finance === undefined
        ? createManagerOnlyProductionAgentRuntime(sharedRuntimeDependencies)
        : createFinanceOnlyProductionAgentRuntime({
            ...sharedRuntimeDependencies,
            capabilityServices: {
              financeDelegation: denyDirectFinanceDelegation,
              finance: rawInput.finance,
              guardedActionProposal: financeGuardedActionProposal,
            },
          });
    const check = async (): Promise<boolean> => {
      try {
        const [global, terra] = await Promise.all([
          rawInput.checkGlobalDependencies(),
          rawInput.openAi.modelAvailability.isAvailable('gpt-5.6-terra'),
        ]);
        return global === true && terra === true;
      } catch {
        return false;
      }
    };
    return Object.freeze({
      scope: Object.freeze({
        principal: fixedPrincipal,
        requestId: fixedRequestId,
        runId: fixedRunId,
        conversationId: conversationId.data,
      }),
      runtime,
      check,
    });
  } catch {
    return undefined;
  }
};

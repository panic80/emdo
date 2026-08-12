import { randomUUID } from 'node:crypto';

import {
  ActionDecisionRequestSchema,
  ActionDecisionSchema,
  ActionProposalSchema,
  DataDisclosureGrantSchema,
  IdentifierSchema,
  OpaqueReferenceSchema,
  ProviderWriteApprovalBindingSchema,
  ProviderWriteAuthorizationSchema,
  ProviderWriteOperationScopeSchema,
  SemanticVersionSchema,
  Sha256Schema,
  UuidSchema,
  deepFreeze,
  type ActionDecision,
  type ActionDecisionRequest,
  type ActionProposal,
  type ProviderWriteAuthorization,
  type ProviderWriteOperationScope,
} from '@emdo/contracts';
import {
  ProviderWriteCompletionSchema,
  hashCanonicalJson,
  hashProviderWriteApprovalBinding,
  type ProviderWriteApprovalBinding,
  type ProviderWriteApprovalResult,
  type ProviderWriteApprovalStore,
  type ProviderWriteCompletion,
  type ProviderWriteDispatchResult,
  type ProviderWriteFinalizationStatus,
} from '@emdo/toolbox';
import { z } from 'zod';

export type ProposalErrorCode =
  | 'proposal-already-exists'
  | 'proposal-approval-hash-mismatch'
  | 'proposal-authorization-scope-invalid'
  | 'proposal-decision-conflict'
  | 'proposal-disclosure-grant-invalid'
  | 'proposal-expired'
  | 'proposal-hash-mismatch'
  | 'proposal-idempotency-conflict'
  | 'proposal-materialization-mismatch'
  | 'proposal-not-found'
  | 'proposal-not-pending'
  | 'proposal-preparation-binding-invalid'
  | 'proposal-state-transition-invalid'
  | 'proposal-timestamp-invalid'
  | 'proposal-user-mismatch';

export class ProposalError extends Error {
  constructor(
    readonly code: ProposalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProposalError';
  }
}

export interface ProposalActivityEvent {
  readonly proposalId: string;
  readonly eventType:
    | 'proposal.created'
    | 'proposal.approved'
    | 'proposal.rejected'
    | 'proposal.expired'
    | 'proposal.prepared'
    | 'proposal.executing'
    | 'proposal.executed'
    | 'proposal.not-applied'
    | 'proposal.indeterminate'
    | 'proposal.failed';
  readonly occurredAt: string;
  readonly decisionId?: string;
  readonly actorUserId?: string;
  readonly authenticatedSessionId?: string;
  readonly approvalHash?: string;
  readonly decisionIdempotencyKey?: string;
  readonly application?: 'applied' | 'not-applied' | 'indeterminate';
  readonly outcomeReason?: string;
  readonly outputStatus?: 'valid' | 'invalid';
  readonly reconciliationRequired?: true;
  readonly evidenceHash?: string;
  readonly providerIdempotencyKey?: string;
  readonly attemptId?: string;
  readonly attemptVersion?: number;
  readonly resultHash?: string;
  readonly safeErrorCode?: string;
}

export interface AuthenticatedVisualDecisionContext {
  readonly decisionId: string;
  /** Fresh server-derived scope for this decision phase. */
  readonly operationScope: ProviderWriteOperationScope;
  readonly channel: 'authenticated-visual';
  readonly now: Date;
}

export interface TrustedProposalMaterializer {
  materialize(input: {
    readonly capabilityId: ActionProposal['capabilityId'];
    readonly capabilityFingerprint: ActionProposal['capabilityFingerprint'];
    readonly canonicalArguments: ActionProposal['canonicalArguments'];
    readonly disclosureGrant: ActionProposal['disclosureGrant'];
    readonly now: Date;
  }): Promise<
    Pick<
      ActionProposal,
      | 'targets'
      | 'beforePreview'
      | 'afterPreview'
      | 'approvalDisplay'
      | 'providerPreconditions'
      | 'providerAuthorityBindingHash'
    >
  >;
}

export interface TrustedDisclosureGrantResolver {
  resolve(
    disclosureGrantId: string,
  ): Promise<ActionProposal['disclosureGrant'] | undefined>;
}

export type ApprovalHashInput = Omit<
  ActionProposal,
  'approvalHash' | 'version' | 'state'
>;

export const hashActionProposalApproval = (
  proposal: ApprovalHashInput,
): string =>
  hashCanonicalJson({
    schemaVersion: proposal.schemaVersion,
    id: proposal.id,
    runId: proposal.runId,
    capabilityId: proposal.capabilityId,
    capabilityFingerprint: proposal.capabilityFingerprint,
    authorizationScopeFingerprint: proposal.authorizationScopeFingerprint,
    canonicalArguments: proposal.canonicalArguments,
    targets: proposal.targets,
    beforePreview: proposal.beforePreview,
    afterPreview: proposal.afterPreview,
    approvalDisplay: proposal.approvalDisplay,
    providerPreconditions: proposal.providerPreconditions,
    providerAuthorityBindingHash: proposal.providerAuthorityBindingHash,
    providerSdkCallId: proposal.providerSdkCallId,
    payloadHash: proposal.payloadHash,
    disclosureGrant: proposal.disclosureGrant,
    createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
    idempotencyKey: proposal.idempotencyKey,
  });

export type ProposalAbandonmentReason =
  | 'multiple-provider-writes-require-separate-turns'
  | 'execution-ended-before-checkpoint';

const ProposalAbandonmentReasonSchema = z.enum([
  'multiple-provider-writes-require-separate-turns',
  'execution-ended-before-checkpoint',
]);

const ProposalPreparationBindingBaseSchema = z.strictObject({
  proposalId: UuidSchema,
  originRequestId: UuidSchema,
  runId: UuidSchema,
  householdId: UuidSchema,
  userId: UuidSchema,
  originSessionId: UuidSchema,
  agentId: IdentifierSchema,
  originSpaceAccessGrantId: UuidSchema,
  disclosureGrantId: UuidSchema,
  disclosurePolicyVersion: SemanticVersionSchema,
  capabilityId: IdentifierSchema,
  sdkCallId: OpaqueReferenceSchema,
  providerAuthorityBindingHash: Sha256Schema,
});

export const ProposalPreparationBindingSchema =
  ProposalPreparationBindingBaseSchema.transform(deepFreeze);

const AbandonPreparedProposalInputSchema =
  ProposalPreparationBindingBaseSchema.extend({
    reason: ProposalAbandonmentReasonSchema,
    now: z.date(),
  });

export type ProposalPreparationBinding = Readonly<
  z.input<typeof ProposalPreparationBindingBaseSchema>
>;

export interface StoredProposalPreparation {
  readonly binding: ProposalPreparationBinding;
  readonly bindingHash: string;
  readonly abandonment?: {
    readonly reason: ProposalAbandonmentReason;
    readonly abandonedAt: string;
  };
}

export interface StoredDecision {
  readonly proposalId: string;
  readonly decision: ActionDecision;
}

export interface StoredProviderWriteCompletion {
  readonly completion: ProviderWriteCompletion;
  readonly bindingHash: string;
  readonly completionHash: string;
  readonly completedAt: string;
}

export interface StoredProviderWriteAttempt {
  readonly proposalId: string;
  readonly decisionId: string;
  readonly attemptState:
    'prepared' | 'executing' | 'executed' | 'not-applied' | 'indeterminate';
  readonly bindingHash: string;
  readonly authorization: ProviderWriteAuthorization;
  readonly dispatchedAt?: string;
  readonly completion?: StoredProviderWriteCompletion;
  readonly reconciliation?: StoredProviderWriteCompletion;
}

export type ProposalRepositoryWriteResult =
  'created' | 'duplicate' | 'conflict';

export interface ProposalExpectedRevision {
  readonly proposalId: string;
  readonly version: number;
  readonly state: ActionProposal['state'];
  readonly approvalHash: string;
}

export interface ProposalIdempotencyLookup {
  readonly householdId: string;
  readonly userId: string;
  readonly capabilityId: string;
  readonly idempotencyKey: string;
}

export interface DecisionIdempotencyLookup {
  readonly userId: string;
  readonly proposalId: string;
  readonly idempotencyKey: string;
}

interface ProposalOperationScopeAssertionBase {
  readonly currentRequestId: string;
  readonly runId: string;
  readonly householdId: string;
  readonly userId: string;
  readonly currentSpaceAccessGrantId: string;
  readonly currentSessionId: string;
  readonly authorizationScopeFingerprint: ActionProposal['authorizationScopeFingerprint'];
  readonly disclosureGrantId: string;
  readonly disclosureGrantVersion: number;
  readonly disclosureGrantHash: string;
  readonly proposalId: string;
  readonly providerSdkCallId: string;
  readonly activeAt: string;
  readonly requireActiveDisclosureGrant: boolean;
}

/**
 * Trusted aggregate precondition, not client or model input. A durable
 * repository must lock and revalidate the exact request/session/membership,
 * space-access grant, and disclosure-grant row represented here in the same
 * transaction as the mutation. A stale, revoked, expired, or hash-mismatched
 * assertion returns `conflict`; checking it before the transaction is not
 * sufficient.
 */
export type ProposalOperationScopeAssertion =
  | (ProposalOperationScopeAssertionBase & {
      readonly phase: 'proposal-create';
      readonly requireActiveDisclosureGrant: true;
    })
  | (ProposalOperationScopeAssertionBase & {
      readonly phase:
        | 'visual-decision'
        | 'provider-write-prepare'
        | 'provider-write-dispatch';
    });

interface ProposalRepositoryMutation {
  readonly expected: ProposalExpectedRevision;
  readonly next: ActionProposal;
  readonly event: ProposalActivityEvent;
}

export interface ProposalRepositoryTransaction {
  getProposal(id: string): Promise<ActionProposal | undefined>;
  findProposalByIdempotencyKey(
    lookup: ProposalIdempotencyLookup,
  ): Promise<ActionProposal | undefined>;
  getProposalPreparation(
    proposalId: string,
  ): Promise<StoredProposalPreparation | undefined>;
  getDecision(id: string): Promise<StoredDecision | undefined>;
  findDecisionByIdempotencyKey(
    lookup: DecisionIdempotencyLookup,
  ): Promise<StoredDecision | undefined>;
  getProviderWriteAttempt(
    decisionId: string,
  ): Promise<StoredProviderWriteAttempt | undefined>;
  insertProposal(input: {
    readonly proposal: ActionProposal;
    readonly preparation: StoredProposalPreparation;
    readonly scope: ProposalOperationScopeAssertion;
    readonly event: ProposalActivityEvent;
  }): Promise<ProposalRepositoryWriteResult>;
  abandonPrepared(
    input: ProposalRepositoryMutation & {
      readonly preparation: StoredProposalPreparation;
    },
  ): Promise<ProposalRepositoryWriteResult>;
  transitionProposal(
    input: ProposalRepositoryMutation,
  ): Promise<ProposalRepositoryWriteResult>;
  commitDecision(
    input: ProposalRepositoryMutation & {
      readonly decision: ActionDecision;
      readonly scope: ProposalOperationScopeAssertion;
    },
  ): Promise<ProposalRepositoryWriteResult>;
  prepareProviderWrite(
    input: ProposalRepositoryMutation & {
      readonly decisionId: string;
      readonly bindingHash: string;
      readonly authorization: ProviderWriteAuthorization;
      readonly scope: ProposalOperationScopeAssertion;
    },
  ): Promise<ProposalRepositoryWriteResult>;
  markDispatch(
    input: ProposalRepositoryMutation & {
      readonly decisionId: string;
      readonly bindingHash: string;
      readonly attemptId: string;
      readonly dispatchedAt: string;
      readonly scope: ProposalOperationScopeAssertion;
    },
  ): Promise<ProposalRepositoryWriteResult>;
  commitPreDispatchCompletion(
    input: ProposalRepositoryMutation & {
      readonly decisionId: string;
      readonly bindingHash: string;
      readonly attemptId: string;
      readonly completion: StoredProviderWriteCompletion;
    },
  ): Promise<ProposalRepositoryWriteResult>;
  commitCompletion(
    input: ProposalRepositoryMutation & {
      readonly decisionId: string;
      readonly bindingHash: string;
      readonly attemptId: string;
      readonly completion: StoredProviderWriteCompletion;
    },
  ): Promise<ProposalRepositoryWriteResult>;
  commitReconciliation(
    input: ProposalRepositoryMutation & {
      readonly decisionId: string;
      readonly bindingHash: string;
      readonly attemptId: string;
      readonly completion: StoredProviderWriteCompletion;
    },
  ): Promise<ProposalRepositoryWriteResult>;
}

export interface ProposalRepository {
  getProposal(id: string): Promise<ActionProposal | undefined>;
  listEvents(): Promise<readonly ProposalActivityEvent[]>;
  transaction<Result>(
    work: (transaction: ProposalRepositoryTransaction) => Promise<Result>,
  ): Promise<Result>;
}

interface RepositoryState {
  readonly proposals: Map<string, ActionProposal>;
  readonly proposalIdempotency: Map<string, string>;
  readonly preparations: Map<string, StoredProposalPreparation>;
  readonly decisions: Map<string, StoredDecision>;
  readonly decisionIdempotency: Map<string, string>;
  readonly attempts: Map<string, StoredProviderWriteAttempt>;
  readonly events: ProposalActivityEvent[];
}

const repositoryStates = new WeakMap<
  InMemoryProposalRepository,
  RepositoryState
>();
const repositoryTransactionTails = new WeakMap<
  InMemoryProposalRepository,
  Promise<void>
>();

const stateFor = (repository: InMemoryProposalRepository): RepositoryState => {
  const state = repositoryStates.get(repository);
  if (state === undefined) throw new Error('Proposal repository unavailable');
  return state;
};

const cloneState = (state: RepositoryState): RepositoryState => ({
  proposals: new Map(state.proposals),
  proposalIdempotency: new Map(state.proposalIdempotency),
  preparations: new Map(state.preparations),
  decisions: new Map(state.decisions),
  decisionIdempotency: new Map(state.decisionIdempotency),
  attempts: new Map(state.attempts),
  events: [...state.events],
});

const proposalScope = (lookup: ProposalIdempotencyLookup): string =>
  hashCanonicalJson(lookup);

const decisionScope = (lookup: DecisionIdempotencyLookup): string =>
  hashCanonicalJson(lookup);

const expectedRevisionFor = (
  proposal: ActionProposal,
): ProposalExpectedRevision => ({
  proposalId: proposal.id,
  version: proposal.version,
  state: proposal.state,
  approvalHash: proposal.approvalHash,
});

const revisionMatches = (
  proposal: ActionProposal | undefined,
  expected: ProposalExpectedRevision,
): proposal is ActionProposal =>
  proposal !== undefined &&
  proposal.id === expected.proposalId &&
  proposal.version === expected.version &&
  proposal.state === expected.state &&
  proposal.approvalHash === expected.approvalHash &&
  hashActionProposalApproval(proposal) === proposal.approvalHash;

const samePreparation = (
  left: StoredProposalPreparation,
  right: StoredProposalPreparation,
): boolean => hashCanonicalJson(left) === hashCanonicalJson(right);

const samePreparationBinding = (
  left: StoredProposalPreparation,
  right: StoredProposalPreparation,
): boolean =>
  left.bindingHash === right.bindingHash &&
  hashCanonicalJson(left.binding) === hashCanonicalJson(right.binding);

const freezeStoredPreparation = (
  value: StoredProposalPreparation,
): StoredProposalPreparation =>
  deepFreeze({
    binding: { ...value.binding },
    bindingHash: value.bindingHash,
    ...(value.abandonment === undefined
      ? {}
      : { abandonment: { ...value.abandonment } }),
  });

const sameCompletion = (
  left: StoredProviderWriteCompletion | undefined,
  right: StoredProviderWriteCompletion,
): boolean =>
  left !== undefined &&
  left.bindingHash === right.bindingHash &&
  left.completionHash === right.completionHash &&
  hashCanonicalJson(left.completion) === hashCanonicalJson(right.completion);

const sameCanonicalValue = (left: unknown, right: unknown): boolean =>
  hashCanonicalJson(left) === hashCanonicalJson(right);

function preparationMatchesProposal(
  preparation: ProposalPreparationBinding,
  proposal: ActionProposal,
): boolean {
  return (
    preparation.proposalId === proposal.id &&
    preparation.runId === proposal.runId &&
    preparation.householdId === proposal.disclosureGrant.householdId &&
    preparation.userId === proposal.disclosureGrant.userId &&
    preparation.agentId === proposal.disclosureGrant.agentId &&
    preparation.disclosureGrantId === proposal.disclosureGrant.id &&
    preparation.capabilityId === proposal.capabilityId &&
    preparation.sdkCallId === proposal.providerSdkCallId &&
    preparation.providerAuthorityBindingHash ===
      proposal.providerAuthorityBindingHash
  );
}

const createOperationScopeAssertion = (input: {
  readonly proposal: ActionProposal;
  readonly preparation: StoredProposalPreparation;
  readonly disclosureGrant: ActionProposal['disclosureGrant'];
  readonly activeAt: string;
}): Extract<
  ProposalOperationScopeAssertion,
  { readonly phase: 'proposal-create' }
> =>
  deepFreeze({
    phase: 'proposal-create',
    currentRequestId: input.preparation.binding.originRequestId,
    runId: input.proposal.runId,
    householdId: input.proposal.disclosureGrant.householdId,
    userId: input.proposal.disclosureGrant.userId,
    currentSpaceAccessGrantId:
      input.preparation.binding.originSpaceAccessGrantId,
    currentSessionId: input.preparation.binding.originSessionId,
    authorizationScopeFingerprint: input.proposal.authorizationScopeFingerprint,
    disclosureGrantId: input.disclosureGrant.id,
    disclosureGrantVersion: input.disclosureGrant.version,
    disclosureGrantHash: hashCanonicalJson(input.disclosureGrant),
    proposalId: input.proposal.id,
    providerSdkCallId: input.proposal.providerSdkCallId,
    activeAt: input.activeAt,
    requireActiveDisclosureGrant: true,
  });

const authenticatedOperationScopeAssertion = (input: {
  readonly phase:
    'visual-decision' | 'provider-write-prepare' | 'provider-write-dispatch';
  readonly proposal: ActionProposal;
  readonly preparation: StoredProposalPreparation;
  readonly decision: ActionDecision;
  readonly disclosureGrant: ActionProposal['disclosureGrant'];
  readonly activeAt: string;
  readonly requireActiveDisclosureGrant: boolean;
  readonly operationScope: ProviderWriteOperationScope;
}): Exclude<
  ProposalOperationScopeAssertion,
  { readonly phase: 'proposal-create' }
> =>
  deepFreeze({
    phase: input.phase,
    currentRequestId: input.operationScope.requestId,
    runId: input.proposal.runId,
    householdId: input.operationScope.householdId,
    userId: input.operationScope.userId,
    currentSpaceAccessGrantId: input.operationScope.spaceAccessGrantId,
    currentSessionId: input.operationScope.sessionId,
    authorizationScopeFingerprint:
      input.operationScope.authorizationScopeFingerprint,
    disclosureGrantId: input.disclosureGrant.id,
    disclosureGrantVersion: input.disclosureGrant.version,
    disclosureGrantHash: hashCanonicalJson(input.disclosureGrant),
    proposalId: input.proposal.id,
    providerSdkCallId: input.proposal.providerSdkCallId,
    activeAt: input.activeAt,
    requireActiveDisclosureGrant: input.requireActiveDisclosureGrant,
  });

const operationScopeMatches = (input: {
  readonly assertion: ProposalOperationScopeAssertion;
  readonly expectedPhase: ProposalOperationScopeAssertion['phase'];
  readonly proposal: ActionProposal;
  readonly preparation: StoredProposalPreparation | undefined;
  readonly decision?: ActionDecision;
}): boolean => {
  const { assertion, expectedPhase, proposal, preparation, decision } = input;
  const activeAt = Date.parse(assertion.activeAt);
  const grant = proposal.disclosureGrant;
  const sessionMatches =
    assertion.phase === 'proposal-create'
      ? assertion.currentSessionId === preparation?.binding.originSessionId
      : decision !== undefined &&
        assertion.currentSessionId === decision.authenticatedSessionId;
  const usesOriginRequestScope = assertion.phase === 'proposal-create';
  return (
    assertion.phase === expectedPhase &&
    preparation !== undefined &&
    preparation.bindingHash ===
      hashCanonicalJson({
        domain: 'emdo.provider-proposal-preparation.v1',
        binding: preparation.binding,
      }) &&
    preparationMatchesProposal(preparation.binding, proposal) &&
    (!usesOriginRequestScope ||
      assertion.currentRequestId === preparation.binding.originRequestId) &&
    assertion.runId === proposal.runId &&
    assertion.householdId === grant.householdId &&
    assertion.userId === grant.userId &&
    (!usesOriginRequestScope ||
      assertion.currentSpaceAccessGrantId ===
        preparation.binding.originSpaceAccessGrantId) &&
    assertion.authorizationScopeFingerprint ===
      proposal.authorizationScopeFingerprint &&
    assertion.disclosureGrantId === grant.id &&
    assertion.disclosureGrantVersion === grant.version &&
    assertion.disclosureGrantHash === hashCanonicalJson(grant) &&
    assertion.proposalId === proposal.id &&
    assertion.providerSdkCallId === proposal.providerSdkCallId &&
    Number.isFinite(activeAt) &&
    (!assertion.requireActiveDisclosureGrant ||
      (activeAt >= Date.parse(grant.createdAt) &&
        activeAt < Date.parse(grant.expiresAt))) &&
    sessionMatches
  );
};

const createInMemoryTransaction = (
  state: RepositoryState,
  isActive: () => boolean,
): ProposalRepositoryTransaction => {
  const assertActive = (): void => {
    if (!isActive()) throw new Error('Proposal transaction is closed');
  };
  const containsEvent = (candidate: ProposalActivityEvent): boolean =>
    state.events.some((event) => sameCanonicalValue(event, candidate));
  const isTransitionReplay = (input: ProposalRepositoryMutation): boolean => {
    const current = state.proposals.get(input.next.id);
    return (
      current !== undefined &&
      sameCanonicalValue(current, input.next) &&
      containsEvent(input.event)
    );
  };
  const applyTransition = (
    input: ProposalRepositoryMutation,
  ): ProposalRepositoryWriteResult => {
    if (isTransitionReplay(input)) return 'duplicate';
    if (
      !revisionMatches(
        state.proposals.get(input.expected.proposalId),
        input.expected,
      )
    ) {
      return 'conflict';
    }
    state.proposals.set(input.next.id, input.next);
    state.events.push(deepFreeze({ ...input.event }));
    return 'created';
  };

  const transaction: ProposalRepositoryTransaction = {
    getProposal: async (id) => {
      assertActive();
      return state.proposals.get(id);
    },
    findProposalByIdempotencyKey: async (lookup) => {
      assertActive();
      const id = state.proposalIdempotency.get(proposalScope(lookup));
      return id === undefined ? undefined : state.proposals.get(id);
    },
    getProposalPreparation: async (proposalId) => {
      assertActive();
      return state.preparations.get(proposalId);
    },
    getDecision: async (id) => {
      assertActive();
      return state.decisions.get(id);
    },
    findDecisionByIdempotencyKey: async (lookup) => {
      assertActive();
      const id = state.decisionIdempotency.get(decisionScope(lookup));
      return id === undefined ? undefined : state.decisions.get(id);
    },
    getProviderWriteAttempt: async (decisionId) => {
      assertActive();
      return state.attempts.get(decisionId);
    },
    insertProposal: async ({ proposal, preparation, scope, event }) => {
      assertActive();
      if (
        !operationScopeMatches({
          assertion: scope,
          expectedPhase: 'proposal-create',
          proposal,
          preparation,
        })
      ) {
        return 'conflict';
      }
      const idempotencyScope = proposalScope({
        householdId: proposal.disclosureGrant.householdId,
        userId: proposal.disclosureGrant.userId,
        capabilityId: proposal.capabilityId,
        idempotencyKey: proposal.idempotencyKey,
      });
      const scopedId = state.proposalIdempotency.get(idempotencyScope);
      const existing = state.proposals.get(proposal.id);
      const existingPreparation = state.preparations.get(proposal.id);
      if (existing !== undefined || scopedId !== undefined) {
        return existing !== undefined &&
          scopedId === proposal.id &&
          existing.approvalHash === proposal.approvalHash &&
          existingPreparation !== undefined &&
          samePreparationBinding(existingPreparation, preparation) &&
          containsEvent(event)
          ? 'duplicate'
          : 'conflict';
      }
      state.proposals.set(proposal.id, proposal);
      state.proposalIdempotency.set(idempotencyScope, proposal.id);
      state.preparations.set(proposal.id, freezeStoredPreparation(preparation));
      state.events.push(deepFreeze({ ...event }));
      return 'created';
    },
    abandonPrepared: async (input) => {
      assertActive();
      const current = state.proposals.get(input.expected.proposalId);
      const stored = state.preparations.get(input.expected.proposalId);
      if (
        current?.state === 'not-applied' &&
        stored?.abandonment !== undefined
      ) {
        return samePreparation(stored, input.preparation) &&
          sameCanonicalValue(current, input.next) &&
          containsEvent(input.event)
          ? 'duplicate'
          : 'conflict';
      }
      if (
        !revisionMatches(current, input.expected) ||
        current.state !== 'pending' ||
        input.expected.state !== 'pending' ||
        input.next.id !== current.id ||
        input.next.state !== 'not-applied' ||
        input.next.version !== current.version + 1 ||
        input.next.approvalHash !== current.approvalHash ||
        hashActionProposalApproval(input.next) !== current.approvalHash ||
        stored === undefined ||
        stored.abandonment !== undefined ||
        input.preparation.abandonment === undefined ||
        !samePreparationBinding(stored, input.preparation) ||
        input.event.proposalId !== current.id ||
        input.event.eventType !== 'proposal.not-applied' ||
        input.event.application !== 'not-applied' ||
        input.event.outcomeReason !== input.preparation.abandonment.reason ||
        input.event.occurredAt !== input.preparation.abandonment.abandonedAt ||
        Date.parse(input.event.occurredAt) < Date.parse(current.createdAt)
      ) {
        return 'conflict';
      }
      state.proposals.set(input.next.id, input.next);
      state.preparations.set(
        input.next.id,
        freezeStoredPreparation(input.preparation),
      );
      state.events.push(deepFreeze({ ...input.event }));
      return 'created';
    },
    transitionProposal: async (input) => {
      assertActive();
      return applyTransition(input);
    },
    commitDecision: async (input) => {
      assertActive();
      const preparation = state.preparations.get(input.decision.proposalId);
      if (
        !operationScopeMatches({
          assertion: input.scope,
          expectedPhase: 'visual-decision',
          proposal: input.next,
          preparation,
          decision: input.decision,
        }) ||
        input.scope.requireActiveDisclosureGrant !==
          (input.decision.decision === 'approved')
      ) {
        return 'conflict';
      }
      const scope = decisionScope({
        userId: input.decision.userId,
        proposalId: input.decision.proposalId,
        idempotencyKey: input.decision.idempotencyKey,
      });
      const existing = state.decisions.get(input.decision.id);
      const scopedId = state.decisionIdempotency.get(scope);
      if (existing !== undefined || scopedId !== undefined) {
        const current = state.proposals.get(input.next.id);
        return existing?.proposalId === input.decision.proposalId &&
          sameCanonicalValue(existing.decision, input.decision) &&
          scopedId === input.decision.id &&
          current !== undefined &&
          sameCanonicalValue(current, input.next) &&
          containsEvent(input.event)
          ? 'duplicate'
          : 'conflict';
      }
      if (
        !revisionMatches(
          state.proposals.get(input.expected.proposalId),
          input.expected,
        )
      ) {
        return 'conflict';
      }
      state.decisions.set(
        input.decision.id,
        deepFreeze({
          proposalId: input.decision.proposalId,
          decision: input.decision,
        }),
      );
      state.decisionIdempotency.set(scope, input.decision.id);
      state.proposals.set(input.next.id, input.next);
      state.events.push(deepFreeze({ ...input.event }));
      return 'created';
    },
    prepareProviderWrite: async (input) => {
      assertActive();
      const storedDecision = state.decisions.get(input.decisionId);
      const preparation = state.preparations.get(input.expected.proposalId);
      if (
        storedDecision === undefined ||
        !operationScopeMatches({
          assertion: input.scope,
          expectedPhase: 'provider-write-prepare',
          proposal: input.next,
          preparation,
          decision: storedDecision.decision,
        }) ||
        !input.scope.requireActiveDisclosureGrant
      ) {
        return 'conflict';
      }
      const existing = state.attempts.get(input.decisionId);
      if (existing !== undefined) {
        return existing.bindingHash === input.bindingHash &&
          existing.authorization.attemptId === input.authorization.attemptId &&
          sameCanonicalValue(existing.authorization, input.authorization) &&
          existing.attemptState === 'prepared' &&
          isTransitionReplay(input)
          ? 'duplicate'
          : 'conflict';
      }
      if (
        !revisionMatches(
          state.proposals.get(input.expected.proposalId),
          input.expected,
        )
      ) {
        return 'conflict';
      }
      state.proposals.set(input.next.id, input.next);
      state.attempts.set(
        input.decisionId,
        deepFreeze({
          proposalId: input.next.id,
          decisionId: input.decisionId,
          attemptState: 'prepared',
          bindingHash: input.bindingHash,
          authorization: input.authorization,
        }),
      );
      state.events.push(deepFreeze({ ...input.event }));
      return 'created';
    },
    markDispatch: async (input) => {
      assertActive();
      const attempt = state.attempts.get(input.decisionId);
      const storedDecision = state.decisions.get(input.decisionId);
      const preparation = state.preparations.get(input.expected.proposalId);
      if (
        attempt === undefined ||
        storedDecision === undefined ||
        attempt.bindingHash !== input.bindingHash ||
        attempt.authorization.attemptId !== input.attemptId ||
        !operationScopeMatches({
          assertion: input.scope,
          expectedPhase: 'provider-write-dispatch',
          proposal: input.next,
          preparation,
          decision: storedDecision.decision,
        }) ||
        !input.scope.requireActiveDisclosureGrant
      ) {
        return 'conflict';
      }
      if (attempt.attemptState === 'executing') {
        return attempt.dispatchedAt === input.dispatchedAt &&
          isTransitionReplay(input)
          ? 'duplicate'
          : 'conflict';
      }
      if (
        attempt.attemptState !== 'prepared' ||
        attempt.dispatchedAt !== undefined ||
        !revisionMatches(
          state.proposals.get(input.expected.proposalId),
          input.expected,
        )
      ) {
        return 'conflict';
      }
      state.proposals.set(input.next.id, input.next);
      state.attempts.set(
        input.decisionId,
        deepFreeze({
          ...attempt,
          attemptState: 'executing',
          dispatchedAt: input.dispatchedAt,
        }),
      );
      state.events.push(deepFreeze({ ...input.event }));
      return 'created';
    },
    commitPreDispatchCompletion: async (input) => {
      assertActive();
      const attempt = state.attempts.get(input.decisionId);
      if (sameCompletion(attempt?.completion, input.completion)) {
        return attempt !== undefined &&
          attempt.decisionId === input.decisionId &&
          attempt.bindingHash === input.bindingHash &&
          attempt.authorization.attemptId === input.attemptId &&
          attempt.attemptState === 'not-applied' &&
          isTransitionReplay(input)
          ? 'duplicate'
          : 'conflict';
      }
      if (
        attempt === undefined ||
        attempt.attemptState !== 'prepared' ||
        attempt.dispatchedAt !== undefined ||
        attempt.bindingHash !== input.bindingHash ||
        attempt.authorization.attemptId !== input.attemptId ||
        attempt.completion !== undefined ||
        !revisionMatches(
          state.proposals.get(input.expected.proposalId),
          input.expected,
        )
      ) {
        return 'conflict';
      }
      state.proposals.set(input.next.id, input.next);
      state.attempts.set(
        input.decisionId,
        deepFreeze({
          ...attempt,
          attemptState: 'not-applied',
          completion: input.completion,
        }),
      );
      state.events.push(deepFreeze({ ...input.event }));
      return 'created';
    },
    commitCompletion: async (input) => {
      assertActive();
      const attempt = state.attempts.get(input.decisionId);
      if (sameCompletion(attempt?.completion, input.completion)) {
        return attempt !== undefined &&
          attempt.decisionId === input.decisionId &&
          attempt.bindingHash === input.bindingHash &&
          attempt.authorization.attemptId === input.attemptId &&
          attempt.attemptState === input.completion.completion.state &&
          isTransitionReplay(input)
          ? 'duplicate'
          : 'conflict';
      }
      if (
        attempt === undefined ||
        attempt.attemptState !== 'executing' ||
        attempt.dispatchedAt === undefined ||
        attempt.bindingHash !== input.bindingHash ||
        attempt.authorization.attemptId !== input.attemptId ||
        attempt.completion !== undefined ||
        !revisionMatches(
          state.proposals.get(input.expected.proposalId),
          input.expected,
        )
      ) {
        return 'conflict';
      }
      state.proposals.set(input.next.id, input.next);
      state.attempts.set(
        input.decisionId,
        deepFreeze({
          ...attempt,
          attemptState: input.completion.completion.state,
          completion: input.completion,
        }),
      );
      state.events.push(deepFreeze({ ...input.event }));
      return 'created';
    },
    commitReconciliation: async (input) => {
      assertActive();
      const attempt = state.attempts.get(input.decisionId);
      if (sameCompletion(attempt?.reconciliation, input.completion)) {
        return attempt !== undefined &&
          attempt.decisionId === input.decisionId &&
          attempt.bindingHash === input.bindingHash &&
          attempt.authorization.attemptId === input.attemptId &&
          attempt.attemptState === input.completion.completion.state &&
          isTransitionReplay(input)
          ? 'duplicate'
          : 'conflict';
      }
      if (
        attempt === undefined ||
        attempt.attemptState !== 'indeterminate' ||
        attempt.dispatchedAt === undefined ||
        attempt.bindingHash !== input.bindingHash ||
        attempt.authorization.attemptId !== input.attemptId ||
        attempt.completion?.completion.state !== 'indeterminate' ||
        attempt.reconciliation !== undefined ||
        !revisionMatches(
          state.proposals.get(input.expected.proposalId),
          input.expected,
        )
      ) {
        return 'conflict';
      }
      state.proposals.set(input.next.id, input.next);
      state.attempts.set(
        input.decisionId,
        deepFreeze({
          ...attempt,
          attemptState: input.completion.completion.state,
          reconciliation: input.completion,
        }),
      );
      state.events.push(deepFreeze({ ...input.event }));
      return 'created';
    },
  };
  return Object.freeze(transaction);
};

export class InMemoryProposalRepository implements ProposalRepository {
  constructor() {
    repositoryStates.set(this, {
      proposals: new Map(),
      proposalIdempotency: new Map(),
      preparations: new Map(),
      decisions: new Map(),
      decisionIdempotency: new Map(),
      attempts: new Map(),
      events: [],
    });
    repositoryTransactionTails.set(this, Promise.resolve());
  }

  async getProposal(id: string): Promise<ActionProposal | undefined> {
    await repositoryTransactionTails.get(this);
    return stateFor(this).proposals.get(id);
  }

  async listEvents(): Promise<readonly ProposalActivityEvent[]> {
    await repositoryTransactionTails.get(this);
    return Object.freeze([...stateFor(this).events]);
  }

  async transaction<Result>(
    work: (transaction: ProposalRepositoryTransaction) => Promise<Result>,
  ): Promise<Result> {
    const previous = repositoryTransactionTails.get(this) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    repositoryTransactionTails.set(
      this,
      previous.then(() => gate),
    );
    await previous;
    const working = cloneState(stateFor(this));
    let active = true;
    const transaction = createInMemoryTransaction(working, () => active);
    try {
      const result = await work(transaction);
      repositoryStates.set(this, working);
      return result;
    } finally {
      active = false;
      release();
    }
  }
}

const prepareProposalTransition = (
  current: ActionProposal,
  nextState: ActionProposal['state'],
): ActionProposal => {
  if (hashActionProposalApproval(current) !== current.approvalHash) {
    throw new ProposalError(
      'proposal-decision-conflict',
      'Proposal immutable material failed validation',
    );
  }
  const allowed: Readonly<
    Record<ActionProposal['state'], readonly ActionProposal['state'][]>
  > = {
    pending: ['approved', 'rejected', 'not-applied', 'expired'],
    approved: ['prepared', 'expired'],
    rejected: [],
    prepared: ['executing', 'not-applied'],
    executing: ['executed', 'not-applied', 'indeterminate', 'failed'],
    executed: [],
    'not-applied': [],
    indeterminate: ['executed', 'not-applied'],
    expired: [],
    failed: [],
  };
  if (!allowed[current.state].includes(nextState)) {
    throw new ProposalError(
      'proposal-state-transition-invalid',
      `Proposal cannot transition from ${current.state} to ${nextState}`,
    );
  }
  return ActionProposalSchema.parse({
    ...current,
    version: current.version + 1,
    state: nextState,
  });
};

const bindingMatches = (
  decision: ActionDecision,
  proposal: ActionProposal,
  binding: ProviderWriteApprovalBinding,
): boolean =>
  decision.decision === 'approved' &&
  decision.userId === binding.userId &&
  proposal.disclosureGrant.agentId === binding.agentId &&
  decision.payloadHash === binding.payloadHash &&
  decision.approvalHash === proposal.approvalHash &&
  proposal.runId === binding.runId &&
  proposal.capabilityId === binding.capabilityId &&
  proposal.capabilityFingerprint === binding.capabilityFingerprint &&
  proposal.disclosureGrant.id === binding.disclosureGrantId &&
  proposal.disclosureGrant.householdId ===
    binding.authorityBinding.householdId &&
  proposal.authorizationScopeFingerprint ===
    binding.authorityBinding.authorizationScopeFingerprint &&
  proposal.providerAuthorityBindingHash ===
    hashCanonicalJson(binding.authorityBinding) &&
  proposal.payloadHash === binding.payloadHash &&
  hashActionProposalApproval(proposal) === proposal.approvalHash;

type ExistingAttemptLookup =
  | Extract<
      ProviderWriteApprovalResult,
      { readonly status: 'existing-attempt' }
    >
  | { readonly status: 'mismatch' };

const existingAttemptResult = (
  attempt: StoredProviderWriteAttempt | undefined,
  proposal: ActionProposal,
  bindingHash: string,
): ExistingAttemptLookup | undefined => {
  if (attempt === undefined) return undefined;
  if (
    attempt.bindingHash !== bindingHash ||
    attempt.authorization.approvalBindingHash !== bindingHash ||
    attempt.proposalId !== proposal.id ||
    attempt.attemptState !== proposal.state
  ) {
    return { status: 'mismatch' };
  }
  if (
    attempt.attemptState === 'prepared' ||
    attempt.attemptState === 'executing'
  ) {
    return {
      status: 'existing-attempt',
      attemptState: attempt.attemptState,
      authorization: attempt.authorization,
    };
  }
  const stored = attempt.reconciliation ?? attempt.completion;
  if (stored === undefined) return { status: 'mismatch' };
  const completion = ProviderWriteCompletionSchema.safeParse(stored.completion);
  if (!completion.success || completion.data.state !== attempt.attemptState) {
    return { status: 'mismatch' };
  }
  return {
    status: 'existing-attempt',
    attemptState: attempt.attemptState,
    authorization: attempt.authorization,
    completion: completion.data,
  };
};

const isSameProposalReplay = (
  persisted: ActionProposal,
  candidate: ActionProposal,
): boolean =>
  persisted.id === candidate.id &&
  persisted.approvalHash === candidate.approvalHash;

const isSameDecisionReplay = (
  persisted: ActionDecision,
  candidate: ActionDecision,
): boolean =>
  persisted.proposalId === candidate.proposalId &&
  persisted.userId === candidate.userId &&
  persisted.authenticatedSessionId === candidate.authenticatedSessionId &&
  persisted.payloadHash === candidate.payloadHash &&
  persisted.approvalHash === candidate.approvalHash &&
  persisted.decision === candidate.decision;

const proposalLookupFor = (
  proposal: ActionProposal,
): ProposalIdempotencyLookup => ({
  householdId: proposal.disclosureGrant.householdId,
  userId: proposal.disclosureGrant.userId,
  capabilityId: proposal.capabilityId,
  idempotencyKey: proposal.idempotencyKey,
});

const decisionLookupFor = (
  decision: ActionDecision,
): DecisionIdempotencyLookup => ({
  userId: decision.userId,
  proposalId: decision.proposalId,
  idempotencyKey: decision.idempotencyKey,
});

const storedPreparation = (
  raw: ProposalPreparationBinding,
): StoredProposalPreparation => {
  const binding = ProposalPreparationBindingSchema.parse(raw);
  return deepFreeze({
    binding,
    bindingHash: hashCanonicalJson({
      domain: 'emdo.provider-proposal-preparation.v1',
      binding,
    }),
  });
};

const completionRecord = (
  completion: ProviderWriteCompletion,
  bindingHash: string,
  completedAt: string,
): StoredProviderWriteCompletion =>
  deepFreeze({
    completion,
    bindingHash,
    completionHash: hashCanonicalJson(completion),
    completedAt,
  });

const parseProviderWriteApprovalBinding = (
  raw: ProviderWriteApprovalBinding,
): ProviderWriteApprovalBinding | undefined => {
  const parsed = ProviderWriteApprovalBindingSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
};

const parseProviderWriteOperationScope = (
  raw: ProviderWriteOperationScope,
): ProviderWriteOperationScope | undefined => {
  const parsed = ProviderWriteOperationScopeSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
};

const currentOperationScopeMatches = (input: {
  readonly operationScope: ProviderWriteOperationScope;
  readonly proposal: ActionProposal;
  readonly decision: ActionDecision;
  readonly binding: ProviderWriteApprovalBinding;
}): boolean =>
  input.operationScope.householdId ===
    input.proposal.disclosureGrant.householdId &&
  input.operationScope.householdId ===
    input.binding.authorityBinding.householdId &&
  input.operationScope.userId === input.proposal.disclosureGrant.userId &&
  input.operationScope.userId === input.binding.userId &&
  input.operationScope.sessionId === input.decision.authenticatedSessionId &&
  input.operationScope.authorizationScopeFingerprint ===
    input.proposal.authorizationScopeFingerprint &&
  input.operationScope.authorizationScopeFingerprint ===
    input.binding.authorityBinding.authorizationScopeFingerprint;

const providerEvent = (input: {
  readonly proposal: ActionProposal;
  readonly decision: ActionDecision;
  readonly permit: ProviderWriteAuthorization;
  readonly completion: ProviderWriteCompletion;
  readonly occurredAt: string;
}): ProposalActivityEvent => ({
  proposalId: input.proposal.id,
  eventType: `proposal.${input.completion.state}`,
  occurredAt: input.occurredAt,
  decisionId: input.decision.id,
  actorUserId: input.decision.userId,
  authenticatedSessionId: input.decision.authenticatedSessionId,
  approvalHash: input.decision.approvalHash,
  decisionIdempotencyKey: input.decision.idempotencyKey,
  application: input.completion.application,
  ...(!('reason' in input.completion)
    ? {}
    : { outcomeReason: input.completion.reason }),
  ...(!('outputStatus' in input.completion)
    ? {}
    : { outputStatus: input.completion.outputStatus }),
  ...(!('reconciliationRequired' in input.completion)
    ? {}
    : { reconciliationRequired: input.completion.reconciliationRequired }),
  ...(!('evidenceHash' in input.completion) ||
  input.completion.evidenceHash === undefined
    ? {}
    : { evidenceHash: input.completion.evidenceHash }),
  providerIdempotencyKey: input.permit.providerIdempotencyKey,
  attemptId: input.permit.attemptId,
  attemptVersion: input.permit.attemptVersion,
  ...(!('resultHash' in input.completion)
    ? {}
    : { resultHash: input.completion.resultHash }),
  ...(!('safeErrorCode' in input.completion)
    ? {}
    : { safeErrorCode: input.completion.safeErrorCode }),
});

const readApprovedContext = async (
  repository: ProposalRepository,
  binding: ProviderWriteApprovalBinding,
): Promise<
  | {
      readonly decision: ActionDecision;
      readonly proposal: ActionProposal;
      readonly attempt?: StoredProviderWriteAttempt;
    }
  | undefined
> =>
  repository.transaction(async (transaction) => {
    const storedDecision = await transaction.getDecision(binding.decisionId);
    if (storedDecision === undefined) return undefined;
    const proposal = await transaction.getProposal(storedDecision.proposalId);
    if (proposal === undefined) return undefined;
    return {
      decision: storedDecision.decision,
      proposal,
      attempt: await transaction.getProviderWriteAttempt(binding.decisionId),
    };
  });

const expireApproved = async (
  repository: ProposalRepository,
  binding: ProviderWriteApprovalBinding,
  occurredAt: string,
  bindingHash: string,
): Promise<ProviderWriteApprovalResult> =>
  repository.transaction(async (transaction) => {
    const storedDecision = await transaction.getDecision(binding.decisionId);
    if (storedDecision === undefined) return { status: 'not-found' };
    const proposal = await transaction.getProposal(storedDecision.proposalId);
    if (
      proposal === undefined ||
      !bindingMatches(storedDecision.decision, proposal, binding)
    ) {
      return { status: 'mismatch' };
    }
    const attempt = await transaction.getProviderWriteAttempt(
      binding.decisionId,
    );
    const existing = existingAttemptResult(attempt, proposal, bindingHash);
    if (existing !== undefined) return existing;
    if (proposal.state !== 'approved') return { status: 'mismatch' };
    const next = prepareProposalTransition(proposal, 'expired');
    const result = await transaction.transitionProposal({
      expected: expectedRevisionFor(proposal),
      next,
      event: {
        proposalId: proposal.id,
        eventType: 'proposal.expired',
        occurredAt,
      },
    });
    return result === 'created'
      ? { status: 'expired' }
      : result === 'duplicate'
        ? { status: 'expired' }
        : { status: 'mismatch' };
  });

const acquireApproval = async (
  repository: ProposalRepository,
  binding: ProviderWriteApprovalBinding,
  operationScope: ProviderWriteOperationScope,
  currentTime: () => Date,
  resolveDisclosureGrant: TrustedDisclosureGrantResolver['resolve'],
): Promise<ProviderWriteApprovalResult> => {
  const checkedNow = currentTime();
  const checkedAt = checkedNow.getTime();
  if (!Number.isFinite(checkedAt)) return { status: 'mismatch' };
  const initial = await readApprovedContext(repository, binding);
  if (initial === undefined) return { status: 'not-found' };
  if (!bindingMatches(initial.decision, initial.proposal, binding)) {
    return { status: 'mismatch' };
  }
  if (
    !currentOperationScopeMatches({
      operationScope,
      proposal: initial.proposal,
      decision: initial.decision,
      binding,
    })
  ) {
    return { status: 'mismatch' };
  }
  const bindingHash = hashProviderWriteApprovalBinding(binding);
  const initialExisting = existingAttemptResult(
    initial.attempt,
    initial.proposal,
    bindingHash,
  );
  if (initialExisting !== undefined) return initialExisting;

  if (
    checkedAt < Date.parse(initial.proposal.createdAt) ||
    checkedAt < Date.parse(initial.decision.decidedAt)
  ) {
    return { status: 'mismatch' };
  }
  if (checkedAt >= Date.parse(initial.proposal.expiresAt)) {
    return expireApproved(
      repository,
      binding,
      checkedNow.toISOString(),
      bindingHash,
    );
  }

  const trustedGrantResult = DataDisclosureGrantSchema.safeParse(
    await resolveDisclosureGrant(initial.proposal.disclosureGrant.id),
  );
  const observedAuthorizationNow = currentTime();
  const observedAuthorizationAt = observedAuthorizationNow.getTime();
  if (!Number.isFinite(observedAuthorizationAt)) {
    return { status: 'mismatch' };
  }
  const authorizationAt = Math.max(
    observedAuthorizationAt,
    checkedAt,
    Date.parse(initial.proposal.createdAt),
    Date.parse(initial.decision.decidedAt),
  );
  const authorizationNow = new Date(authorizationAt);
  if (authorizationAt >= Date.parse(initial.proposal.expiresAt)) {
    return expireApproved(
      repository,
      binding,
      authorizationNow.toISOString(),
      bindingHash,
    );
  }
  if (
    !trustedGrantResult.success ||
    hashCanonicalJson(trustedGrantResult.data) !==
      hashCanonicalJson(initial.proposal.disclosureGrant) ||
    authorizationAt < Date.parse(trustedGrantResult.data.createdAt) ||
    authorizationAt >= Date.parse(trustedGrantResult.data.expiresAt)
  ) {
    return { status: 'mismatch' };
  }

  return repository.transaction(async (transaction) => {
    const storedDecision = await transaction.getDecision(binding.decisionId);
    if (storedDecision === undefined) return { status: 'not-found' };
    const proposal = await transaction.getProposal(storedDecision.proposalId);
    if (
      proposal === undefined ||
      !bindingMatches(storedDecision.decision, proposal, binding)
    ) {
      return { status: 'mismatch' };
    }
    if (
      !currentOperationScopeMatches({
        operationScope,
        proposal,
        decision: storedDecision.decision,
        binding,
      })
    ) {
      return { status: 'mismatch' };
    }
    const attempt = await transaction.getProviderWriteAttempt(
      binding.decisionId,
    );
    const existing = existingAttemptResult(attempt, proposal, bindingHash);
    if (existing !== undefined) return existing;
    if (proposal.state !== 'approved') return { status: 'mismatch' };
    const preparation = await transaction.getProposalPreparation(proposal.id);
    if (preparation === undefined) return { status: 'mismatch' };

    const transactionNow = currentTime();
    const transactionObservedAt = transactionNow.getTime();
    if (!Number.isFinite(transactionObservedAt)) {
      return { status: 'mismatch' };
    }
    const transactionAuthorizationAt = Math.max(
      authorizationAt,
      transactionObservedAt,
      Date.parse(proposal.createdAt),
      Date.parse(storedDecision.decision.decidedAt),
    );
    const transactionAuthorizationNow = new Date(transactionAuthorizationAt);
    if (transactionAuthorizationAt >= Date.parse(proposal.expiresAt)) {
      const next = prepareProposalTransition(proposal, 'expired');
      const result = await transaction.transitionProposal({
        expected: expectedRevisionFor(proposal),
        next,
        event: {
          proposalId: proposal.id,
          eventType: 'proposal.expired',
          occurredAt: transactionAuthorizationNow.toISOString(),
        },
      });
      return result === 'created' || result === 'duplicate'
        ? { status: 'expired' }
        : { status: 'mismatch' };
    }
    if (
      transactionAuthorizationAt <
        Date.parse(trustedGrantResult.data.createdAt) ||
      transactionAuthorizationAt >=
        Date.parse(trustedGrantResult.data.expiresAt)
    ) {
      return { status: 'mismatch' };
    }

    const permit = ProviderWriteAuthorizationSchema.parse({
      proposalId: proposal.id,
      approvalHash: proposal.approvalHash,
      approvalBindingHash: bindingHash,
      capabilityFingerprint: proposal.capabilityFingerprint,
      proposalCreatedAt: proposal.createdAt,
      expiresAt: proposal.expiresAt,
      disclosureGrantId: trustedGrantResult.data.id,
      disclosureGrantHash: hashCanonicalJson(trustedGrantResult.data),
      approvalBinding: binding,
      providerIdempotencyKey: hashCanonicalJson({
        schemaVersion: 1,
        proposalId: proposal.id,
        capabilityId: proposal.capabilityId,
        capabilityFingerprint: proposal.capabilityFingerprint,
        disclosureGrantId: proposal.disclosureGrant.id,
        providerAuthorityBindingHash: proposal.providerAuthorityBindingHash,
        providerSdkCallId: proposal.providerSdkCallId,
        idempotencyKey: proposal.idempotencyKey,
      }),
      idempotencyExpiresAt: new Date(
        transactionAuthorizationAt + binding.idempotencyTtlMs,
      ).toISOString(),
      attemptId: randomUUID(),
      attemptVersion: 1,
      issuedAt: transactionAuthorizationNow.toISOString(),
      targets: proposal.targets,
      providerPreconditions: proposal.providerPreconditions,
    });
    const next = prepareProposalTransition(proposal, 'prepared');
    const result = await transaction.prepareProviderWrite({
      expected: expectedRevisionFor(proposal),
      next,
      decisionId: storedDecision.decision.id,
      bindingHash,
      authorization: permit,
      scope: authenticatedOperationScopeAssertion({
        phase: 'provider-write-prepare',
        proposal,
        preparation,
        decision: storedDecision.decision,
        disclosureGrant: trustedGrantResult.data,
        activeAt: transactionAuthorizationNow.toISOString(),
        requireActiveDisclosureGrant: true,
        operationScope,
      }),
      event: {
        proposalId: proposal.id,
        eventType: 'proposal.prepared',
        occurredAt: transactionAuthorizationNow.toISOString(),
        decisionId: storedDecision.decision.id,
        actorUserId: storedDecision.decision.userId,
        authenticatedSessionId: storedDecision.decision.authenticatedSessionId,
        approvalHash: storedDecision.decision.approvalHash,
        decisionIdempotencyKey: storedDecision.decision.idempotencyKey,
        providerIdempotencyKey: permit.providerIdempotencyKey,
        attemptId: permit.attemptId,
        attemptVersion: permit.attemptVersion,
      },
    });
    if (result === 'created') {
      return { status: 'authorized', authorization: permit };
    }
    const raced = await transaction.getProviderWriteAttempt(binding.decisionId);
    return (
      existingAttemptResult(raced, next, bindingHash) ?? { status: 'mismatch' }
    );
  });
};

const finalizeApproval = async (
  repository: ProposalRepository,
  binding: ProviderWriteApprovalBinding,
  rawCompletion: ProviderWriteCompletion,
  now: Date,
): Promise<ProviderWriteFinalizationStatus> => {
  const parsed = ProviderWriteCompletionSchema.safeParse(rawCompletion);
  if (!parsed.success) return 'mismatch';
  const completion = parsed.data;
  return repository.transaction(async (transaction) => {
    const storedDecision = await transaction.getDecision(binding.decisionId);
    if (storedDecision === undefined) return 'not-found';
    const proposal = await transaction.getProposal(storedDecision.proposalId);
    if (
      proposal === undefined ||
      !bindingMatches(storedDecision.decision, proposal, binding)
    ) {
      return 'mismatch';
    }
    const bindingHash = hashProviderWriteApprovalBinding(binding);
    const attempt = await transaction.getProviderWriteAttempt(
      binding.decisionId,
    );
    if (attempt === undefined) return 'mismatch';
    if (attempt.completion !== undefined) {
      return attempt.completion.bindingHash === bindingHash &&
        attempt.completion.completionHash === hashCanonicalJson(completion)
        ? 'already-finalized'
        : 'mismatch';
    }
    const observedAt = now.getTime();
    const preparedPreDispatch =
      proposal.state === 'prepared' &&
      attempt.attemptState === 'prepared' &&
      attempt.dispatchedAt === undefined &&
      completion.state === 'not-applied' &&
      (completion.reason === 'approval-expired-before-dispatch' ||
        completion.reason === 'approval-policy-mismatch' ||
        completion.reason === 'provider-rejected-before-apply');
    if (
      attempt.bindingHash !== bindingHash ||
      attempt.authorization.approvalBindingHash !== bindingHash ||
      (!preparedPreDispatch &&
        (proposal.state !== 'executing' ||
          attempt.attemptState !== 'executing' ||
          attempt.dispatchedAt === undefined)) ||
      !Number.isFinite(observedAt)
    ) {
      return 'mismatch';
    }
    const completedAt = new Date(
      Math.max(
        observedAt,
        Date.parse(attempt.authorization.issuedAt),
        attempt.dispatchedAt === undefined
          ? Number.NEGATIVE_INFINITY
          : Date.parse(attempt.dispatchedAt),
      ),
    ).toISOString();
    const next = prepareProposalTransition(proposal, completion.state);
    const storedCompletion = completionRecord(
      completion,
      bindingHash,
      completedAt,
    );
    const mutation = {
      expected: expectedRevisionFor(proposal),
      next,
      decisionId: binding.decisionId,
      bindingHash,
      attemptId: attempt.authorization.attemptId,
      completion: storedCompletion,
      event: providerEvent({
        proposal,
        decision: storedDecision.decision,
        permit: attempt.authorization,
        completion,
        occurredAt: completedAt,
      }),
    };
    const result = preparedPreDispatch
      ? await transaction.commitPreDispatchCompletion(mutation)
      : await transaction.commitCompletion(mutation);
    return result === 'created'
      ? 'finalized'
      : result === 'duplicate'
        ? 'already-finalized'
        : 'mismatch';
  });
};

const markDispatchingApproval = async (
  repository: ProposalRepository,
  binding: ProviderWriteApprovalBinding,
  attemptId: string,
  operationScope: ProviderWriteOperationScope,
  currentTime: () => Date,
  resolveDisclosureGrant: TrustedDisclosureGrantResolver['resolve'],
): Promise<ProviderWriteDispatchResult> => {
  const initial = await readApprovedContext(repository, binding);
  if (initial === undefined) return { status: 'not-found' };
  if (!bindingMatches(initial.decision, initial.proposal, binding)) {
    return { status: 'mismatch' };
  }
  if (
    !currentOperationScopeMatches({
      operationScope,
      proposal: initial.proposal,
      decision: initial.decision,
      binding,
    })
  ) {
    return { status: 'mismatch' };
  }
  const bindingHash = hashProviderWriteApprovalBinding(binding);
  const existing = existingAttemptResult(
    initial.attempt,
    initial.proposal,
    bindingHash,
  );
  if (existing === undefined || existing.status !== 'existing-attempt') {
    return existing ?? { status: 'mismatch' };
  }
  if (existing.authorization.attemptId !== attemptId) {
    return { status: 'mismatch' };
  }
  if (existing.attemptState !== 'prepared') return existing;

  const trustedGrantResult = DataDisclosureGrantSchema.safeParse(
    await resolveDisclosureGrant(initial.proposal.disclosureGrant.id),
  );
  const dispatchNow = currentTime();
  const observedDispatchAt = dispatchNow.getTime();
  if (!Number.isFinite(observedDispatchAt)) return { status: 'mismatch' };

  return repository.transaction(async (transaction) => {
    const storedDecision = await transaction.getDecision(binding.decisionId);
    if (storedDecision === undefined) return { status: 'not-found' };
    const proposal = await transaction.getProposal(storedDecision.proposalId);
    if (
      proposal === undefined ||
      !bindingMatches(storedDecision.decision, proposal, binding)
    ) {
      return { status: 'mismatch' };
    }
    if (
      !currentOperationScopeMatches({
        operationScope,
        proposal,
        decision: storedDecision.decision,
        binding,
      })
    ) {
      return { status: 'mismatch' };
    }
    const attempt = await transaction.getProviderWriteAttempt(
      binding.decisionId,
    );
    const raced = existingAttemptResult(attempt, proposal, bindingHash);
    if (raced === undefined || raced.status !== 'existing-attempt') {
      return raced ?? { status: 'mismatch' };
    }
    if (raced.authorization.attemptId !== attemptId) {
      return { status: 'mismatch' };
    }
    if (raced.attemptState !== 'prepared') return raced;
    const preparation = await transaction.getProposalPreparation(proposal.id);
    if (preparation === undefined) return { status: 'mismatch' };

    const transactionDispatchNow = currentTime();
    const transactionObservedDispatchAt = transactionDispatchNow.getTime();
    if (!Number.isFinite(transactionObservedDispatchAt)) {
      return { status: 'mismatch' };
    }
    const dispatchAt = Math.max(
      observedDispatchAt,
      transactionObservedDispatchAt,
      Date.parse(raced.authorization.issuedAt),
    );
    const occurredAt = new Date(dispatchAt).toISOString();
    const completePreDispatch = async (
      reason: 'approval-expired-before-dispatch' | 'approval-policy-mismatch',
    ): Promise<ProposalRepositoryWriteResult> => {
      const completion = ProviderWriteCompletionSchema.parse({
        state: 'not-applied',
        application: 'not-applied',
        reason,
      });
      const next = prepareProposalTransition(proposal, 'not-applied');
      return transaction.commitPreDispatchCompletion({
        expected: expectedRevisionFor(proposal),
        next,
        decisionId: binding.decisionId,
        bindingHash,
        attemptId,
        completion: completionRecord(completion, bindingHash, occurredAt),
        event: providerEvent({
          proposal,
          decision: storedDecision.decision,
          permit: raced.authorization,
          completion,
          occurredAt,
        }),
      });
    };

    if (
      dispatchAt >= Date.parse(raced.authorization.expiresAt) ||
      dispatchAt >= Date.parse(raced.authorization.idempotencyExpiresAt)
    ) {
      const result = await completePreDispatch(
        'approval-expired-before-dispatch',
      );
      return result === 'created' || result === 'duplicate'
        ? { status: 'expired' }
        : { status: 'mismatch' };
    }
    if (
      !trustedGrantResult.success ||
      hashCanonicalJson(trustedGrantResult.data) !==
        hashCanonicalJson(proposal.disclosureGrant) ||
      dispatchAt < Date.parse(trustedGrantResult.data.createdAt) ||
      dispatchAt >= Date.parse(trustedGrantResult.data.expiresAt)
    ) {
      await completePreDispatch('approval-policy-mismatch');
      return { status: 'mismatch' };
    }
    if (proposal.state !== 'prepared') return { status: 'mismatch' };
    const next = prepareProposalTransition(proposal, 'executing');
    const result = await transaction.markDispatch({
      expected: expectedRevisionFor(proposal),
      next,
      decisionId: binding.decisionId,
      bindingHash,
      attemptId,
      dispatchedAt: occurredAt,
      scope: authenticatedOperationScopeAssertion({
        phase: 'provider-write-dispatch',
        proposal,
        preparation,
        decision: storedDecision.decision,
        disclosureGrant: trustedGrantResult.data,
        activeAt: occurredAt,
        requireActiveDisclosureGrant: true,
        operationScope,
      }),
      event: {
        proposalId: proposal.id,
        eventType: 'proposal.executing',
        occurredAt,
        decisionId: storedDecision.decision.id,
        actorUserId: storedDecision.decision.userId,
        authenticatedSessionId: storedDecision.decision.authenticatedSessionId,
        approvalHash: storedDecision.decision.approvalHash,
        decisionIdempotencyKey: storedDecision.decision.idempotencyKey,
        providerIdempotencyKey: raced.authorization.providerIdempotencyKey,
        attemptId,
        attemptVersion: raced.authorization.attemptVersion,
      },
    });
    if (result === 'created') {
      return {
        status: 'dispatch-authorized',
        authorization: raced.authorization,
      };
    }
    if (result === 'duplicate') {
      const persistedProposal = await transaction.getProposal(proposal.id);
      const persistedAttempt = await transaction.getProviderWriteAttempt(
        binding.decisionId,
      );
      return persistedProposal === undefined
        ? { status: 'mismatch' }
        : (existingAttemptResult(
            persistedAttempt,
            persistedProposal,
            bindingHash,
          ) ?? { status: 'mismatch' });
    }
    return { status: 'mismatch' };
  });
};

const reconcileApproval = async (
  repository: ProposalRepository,
  binding: ProviderWriteApprovalBinding,
  rawCompletion: ProviderWriteCompletion,
  now: Date,
): Promise<ProviderWriteFinalizationStatus> => {
  const parsed = ProviderWriteCompletionSchema.safeParse(rawCompletion);
  if (
    !parsed.success ||
    parsed.data.state === 'indeterminate' ||
    (parsed.data.state === 'not-applied' &&
      (parsed.data.reason === 'approval-expired-before-dispatch' ||
        parsed.data.reason === 'approval-policy-mismatch'))
  ) {
    return 'mismatch';
  }
  const completion = parsed.data;
  return repository.transaction(async (transaction) => {
    const storedDecision = await transaction.getDecision(binding.decisionId);
    if (storedDecision === undefined) return 'not-found';
    const proposal = await transaction.getProposal(storedDecision.proposalId);
    if (
      proposal === undefined ||
      !bindingMatches(storedDecision.decision, proposal, binding)
    ) {
      return 'mismatch';
    }
    const bindingHash = hashProviderWriteApprovalBinding(binding);
    const attempt = await transaction.getProviderWriteAttempt(
      binding.decisionId,
    );
    if (attempt?.reconciliation !== undefined) {
      return attempt.reconciliation.bindingHash === bindingHash &&
        attempt.reconciliation.completionHash === hashCanonicalJson(completion)
        ? 'already-finalized'
        : 'mismatch';
    }
    const observedAt = now.getTime();
    if (
      attempt === undefined ||
      attempt.bindingHash !== bindingHash ||
      attempt.attemptState !== 'indeterminate' ||
      attempt.dispatchedAt === undefined ||
      attempt.completion?.completion.state !== 'indeterminate' ||
      proposal.state !== 'indeterminate' ||
      !Number.isFinite(observedAt)
    ) {
      return 'mismatch';
    }
    const reconciledAt = new Date(
      Math.max(
        observedAt,
        Date.parse(attempt.completion.completedAt),
        Date.parse(attempt.dispatchedAt),
      ),
    ).toISOString();
    const next = prepareProposalTransition(proposal, completion.state);
    const result = await transaction.commitReconciliation({
      expected: expectedRevisionFor(proposal),
      next,
      decisionId: binding.decisionId,
      bindingHash,
      attemptId: attempt.authorization.attemptId,
      completion: completionRecord(completion, bindingHash, reconciledAt),
      event: providerEvent({
        proposal,
        decision: storedDecision.decision,
        permit: attempt.authorization,
        completion,
        occurredAt: reconciledAt,
      }),
    });
    return result === 'created'
      ? 'finalized'
      : result === 'duplicate'
        ? 'already-finalized'
        : 'mismatch';
  });
};

export interface ProviderWriteReconciliationService {
  reconcile(
    binding: ProviderWriteApprovalBinding,
    completion: ProviderWriteCompletion,
  ): Promise<ProviderWriteFinalizationStatus>;
}

export const createProviderWriteReconciliationService = (
  repository: ProposalRepository,
  now: () => Date = () => new Date(),
): ProviderWriteReconciliationService => {
  const currentTime = now.bind(undefined);
  return Object.freeze({
    reconcile: async (
      rawBinding: ProviderWriteApprovalBinding,
      completion: ProviderWriteCompletion,
    ) => {
      const binding = parseProviderWriteApprovalBinding(rawBinding);
      return binding === undefined
        ? 'mismatch'
        : reconcileApproval(repository, binding, completion, currentTime());
    },
  });
};

export interface AbandonPreparedProposalInput extends ProposalPreparationBinding {
  readonly reason: ProposalAbandonmentReason;
  readonly now: Date;
}

export type AbandonPreparedProposalResult =
  | { readonly status: 'abandoned' }
  | { readonly status: 'already-abandoned' }
  | { readonly status: 'not-abandonable' };

export class ProposalService {
  readonly approvalStore: ProviderWriteApprovalStore;
  private readonly materializeProposal: TrustedProposalMaterializer['materialize'];
  private readonly resolveDisclosureGrant: TrustedDisclosureGrantResolver['resolve'];
  private readonly currentTime: () => Date;

  constructor(
    materializer: TrustedProposalMaterializer,
    disclosureGrantResolver: TrustedDisclosureGrantResolver,
    private readonly repository: ProposalRepository,
    now: () => Date = () => new Date(),
  ) {
    this.materializeProposal = materializer.materialize.bind(materializer);
    this.resolveDisclosureGrant = disclosureGrantResolver.resolve.bind(
      disclosureGrantResolver,
    );
    this.currentTime = now.bind(undefined);
    this.approvalStore = Object.freeze({
      acquire: async (
        rawBinding: ProviderWriteApprovalBinding,
        rawOperationScope: ProviderWriteOperationScope,
      ) => {
        const binding = parseProviderWriteApprovalBinding(rawBinding);
        const operationScope =
          parseProviderWriteOperationScope(rawOperationScope);
        return binding === undefined || operationScope === undefined
          ? ({ status: 'mismatch' } as const)
          : acquireApproval(
              this.repository,
              binding,
              operationScope,
              this.currentTime,
              this.resolveDisclosureGrant,
            );
      },
      markDispatching: async (
        rawBinding: ProviderWriteApprovalBinding,
        attemptId: string,
        rawOperationScope: ProviderWriteOperationScope,
      ) => {
        const binding = parseProviderWriteApprovalBinding(rawBinding);
        const operationScope =
          parseProviderWriteOperationScope(rawOperationScope);
        return binding === undefined || operationScope === undefined
          ? ({ status: 'mismatch' } as const)
          : markDispatchingApproval(
              this.repository,
              binding,
              attemptId,
              operationScope,
              this.currentTime,
              this.resolveDisclosureGrant,
            );
      },
      finalize: async (
        rawBinding: ProviderWriteApprovalBinding,
        completion: ProviderWriteCompletion,
      ) => {
        const binding = parseProviderWriteApprovalBinding(rawBinding);
        return binding === undefined
          ? 'mismatch'
          : finalizeApproval(
              this.repository,
              binding,
              completion,
              this.currentTime(),
            );
      },
      reconcile: async (
        rawBinding: ProviderWriteApprovalBinding,
        completion: ProviderWriteCompletion,
      ) => {
        const binding = parseProviderWriteApprovalBinding(rawBinding);
        return binding === undefined
          ? 'mismatch'
          : reconcileApproval(
              this.repository,
              binding,
              completion,
              this.currentTime(),
            );
      },
    });
  }

  async getProposal(id: string): Promise<ActionProposal | undefined> {
    return this.repository.getProposal(id);
  }

  async listEvents(): Promise<readonly ProposalActivityEvent[]> {
    return this.repository.listEvents();
  }

  async create(
    rawProposal: ActionProposal,
    rawPreparationBinding: ProposalPreparationBinding,
  ): Promise<ActionProposal> {
    const proposal = ActionProposalSchema.parse(rawProposal);
    const preparation = storedPreparation(rawPreparationBinding);
    if (!preparationMatchesProposal(preparation.binding, proposal)) {
      throw new ProposalError(
        'proposal-preparation-binding-invalid',
        'Proposal does not match its trusted SDK preparation binding',
      );
    }
    if (proposal.state !== 'pending') {
      throw new ProposalError(
        'proposal-not-pending',
        'A newly created proposal must be pending',
      );
    }
    if (proposal.version !== 1) {
      throw new ProposalError(
        'proposal-state-transition-invalid',
        'A newly created proposal must begin at version 1',
      );
    }
    if (
      hashCanonicalJson(proposal.canonicalArguments) !== proposal.payloadHash
    ) {
      throw new ProposalError(
        'proposal-hash-mismatch',
        'Proposal arguments do not match the immutable payload hash',
      );
    }
    if (hashActionProposalApproval(proposal) !== proposal.approvalHash) {
      throw new ProposalError(
        'proposal-approval-hash-mismatch',
        'Proposal preview and execution material do not match the approval hash',
      );
    }

    const replay = await this.repository.transaction(async (transaction) => {
      const existing = await transaction.findProposalByIdempotencyKey(
        proposalLookupFor(proposal),
      );
      if (existing === undefined) return undefined;
      const stored = await transaction.getProposalPreparation(existing.id);
      return { existing, stored };
    });
    if (replay !== undefined) {
      if (
        !isSameProposalReplay(replay.existing, proposal) ||
        replay.stored === undefined ||
        !samePreparationBinding(replay.stored, preparation)
      ) {
        throw new ProposalError(
          'proposal-idempotency-conflict',
          'Proposal idempotency key is bound to a different request',
        );
      }
      return replay.existing;
    }

    const now = this.currentTime();
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs) || Date.parse(proposal.createdAt) > nowMs) {
      throw new ProposalError(
        'proposal-timestamp-invalid',
        'Proposal creation time cannot be in the future',
      );
    }
    if (nowMs >= Date.parse(proposal.expiresAt)) {
      throw new ProposalError(
        'proposal-expired',
        'An expired proposal cannot be persisted',
      );
    }
    const trustedGrantResult = DataDisclosureGrantSchema.safeParse(
      await this.resolveDisclosureGrant(proposal.disclosureGrant.id),
    );
    const grantCheckedAt = this.currentTime();
    const grantCheckedAtMs = grantCheckedAt.getTime();
    if (
      Number.isFinite(grantCheckedAtMs) &&
      grantCheckedAtMs >= Date.parse(proposal.expiresAt)
    ) {
      throw new ProposalError(
        'proposal-expired',
        'Proposal expired while its disclosure grant was being resolved',
      );
    }
    if (
      !Number.isFinite(grantCheckedAtMs) ||
      !trustedGrantResult.success ||
      hashCanonicalJson(trustedGrantResult.data) !==
        hashCanonicalJson(proposal.disclosureGrant) ||
      grantCheckedAtMs < Date.parse(trustedGrantResult.data.createdAt) ||
      grantCheckedAtMs >= Date.parse(trustedGrantResult.data.expiresAt)
    ) {
      throw new ProposalError(
        'proposal-disclosure-grant-invalid',
        'Proposal disclosure grant is not an active server-issued grant',
      );
    }
    const trustedMaterial = await this.materializeProposal({
      capabilityId: proposal.capabilityId,
      capabilityFingerprint: proposal.capabilityFingerprint,
      canonicalArguments: proposal.canonicalArguments,
      disclosureGrant: trustedGrantResult.data,
      now: new Date(grantCheckedAt),
    });
    if (
      hashCanonicalJson({
        targets: proposal.targets,
        beforePreview: proposal.beforePreview,
        afterPreview: proposal.afterPreview,
        approvalDisplay: proposal.approvalDisplay,
        providerPreconditions: proposal.providerPreconditions,
        providerAuthorityBindingHash: proposal.providerAuthorityBindingHash,
      }) !== hashCanonicalJson(trustedMaterial)
    ) {
      throw new ProposalError(
        'proposal-materialization-mismatch',
        'Proposal preview and provider conditions were not derived by the trusted capability',
      );
    }

    const commitNow = this.currentTime();
    const commitAt = commitNow.getTime();
    if (
      !Number.isFinite(commitAt) ||
      commitAt < Date.parse(proposal.createdAt)
    ) {
      throw new ProposalError(
        'proposal-timestamp-invalid',
        'Proposal persistence time is invalid',
      );
    }
    if (commitAt >= Date.parse(proposal.expiresAt)) {
      throw new ProposalError(
        'proposal-expired',
        'Proposal expired before it could be persisted',
      );
    }
    const result = await this.repository.transaction(async (transaction) => {
      const existing = await transaction.findProposalByIdempotencyKey(
        proposalLookupFor(proposal),
      );
      if (existing !== undefined) {
        const stored = await transaction.getProposalPreparation(existing.id);
        return isSameProposalReplay(existing, proposal) &&
          stored !== undefined &&
          samePreparationBinding(stored, preparation)
          ? ({ kind: 'replay', proposal: existing } as const)
          : ({ kind: 'conflict' } as const);
      }
      const transactionNow = this.currentTime();
      const transactionObservedAt = transactionNow.getTime();
      if (!Number.isFinite(transactionObservedAt)) {
        throw new ProposalError(
          'proposal-timestamp-invalid',
          'Proposal persistence time is invalid',
        );
      }
      const transactionCommitAt = Math.max(commitAt, transactionObservedAt);
      if (transactionCommitAt >= Date.parse(proposal.expiresAt)) {
        throw new ProposalError(
          'proposal-expired',
          'Proposal expired before it could be persisted',
        );
      }
      const write = await transaction.insertProposal({
        proposal,
        preparation,
        scope: createOperationScopeAssertion({
          proposal,
          preparation,
          disclosureGrant: trustedGrantResult.data,
          activeAt: new Date(transactionCommitAt).toISOString(),
        }),
        event: {
          proposalId: proposal.id,
          eventType: 'proposal.created',
          occurredAt: proposal.createdAt,
        },
      });
      if (write === 'created') return { kind: 'created' } as const;
      if (write === 'duplicate') {
        const persisted = await transaction.findProposalByIdempotencyKey(
          proposalLookupFor(proposal),
        );
        const persistedPreparation =
          persisted === undefined
            ? undefined
            : await transaction.getProposalPreparation(persisted.id);
        return persisted !== undefined &&
          isSameProposalReplay(persisted, proposal) &&
          persistedPreparation !== undefined &&
          samePreparationBinding(persistedPreparation, preparation)
          ? ({ kind: 'replay', proposal: persisted } as const)
          : ({ kind: 'conflict' } as const);
      }
      return { kind: 'conflict' } as const;
    });
    if (result.kind === 'replay') return result.proposal;
    if (result.kind === 'conflict') {
      throw new ProposalError(
        'proposal-idempotency-conflict',
        'Proposal idempotency key is bound to a different request',
      );
    }
    return proposal;
  }

  async abandonPrepared(
    input: AbandonPreparedProposalInput,
  ): Promise<AbandonPreparedProposalResult> {
    const parsed = AbandonPreparedProposalInputSchema.safeParse(input);
    if (!parsed.success) {
      return { status: 'not-abandonable' };
    }
    const { reason, now, ...rawBinding } = parsed.data;
    const binding = ProposalPreparationBindingSchema.parse(rawBinding);
    const nowMs = now.getTime();
    const expectedPreparation = storedPreparation(binding);
    return this.repository.transaction(async (transaction) => {
      const proposal = await transaction.getProposal(binding.proposalId);
      const preparation = await transaction.getProposalPreparation(
        binding.proposalId,
      );
      if (proposal === undefined || preparation === undefined) {
        return { status: 'not-abandonable' };
      }
      if (
        proposal.state === 'not-applied' &&
        preparation.abandonment?.reason === reason &&
        preparation.bindingHash === expectedPreparation.bindingHash
      ) {
        return { status: 'already-abandoned' };
      }
      if (
        proposal.state !== 'pending' ||
        nowMs < Date.parse(proposal.createdAt) ||
        !preparationMatchesProposal(binding, proposal) ||
        preparation.bindingHash !== expectedPreparation.bindingHash ||
        preparation.abandonment !== undefined
      ) {
        return { status: 'not-abandonable' };
      }
      const abandonedAt = new Date(
        Math.max(nowMs, Date.parse(proposal.createdAt)),
      ).toISOString();
      const next = prepareProposalTransition(proposal, 'not-applied');
      const abandonedPreparation = deepFreeze({
        ...expectedPreparation,
        abandonment: {
          reason,
          abandonedAt,
        },
      });
      const result = await transaction.abandonPrepared({
        expected: expectedRevisionFor(proposal),
        next,
        preparation: abandonedPreparation,
        event: {
          proposalId: proposal.id,
          eventType: 'proposal.not-applied',
          occurredAt: abandonedAt,
          application: 'not-applied',
          outcomeReason: reason,
        },
      });
      return result === 'created'
        ? { status: 'abandoned' }
        : result === 'duplicate'
          ? { status: 'already-abandoned' }
          : { status: 'not-abandonable' };
    });
  }

  async decide(
    rawRequest: ActionDecisionRequest,
    context: AuthenticatedVisualDecisionContext,
  ): Promise<ActionDecision> {
    const request = ActionDecisionRequestSchema.parse(rawRequest);
    const operationScope = ProviderWriteOperationScopeSchema.safeParse(
      context.operationScope,
    );
    if (!operationScope.success) {
      throw new ProposalError(
        'proposal-authorization-scope-invalid',
        'Visual decision authorization scope is invalid',
      );
    }
    const nowMs = context.now.getTime();
    if (!Number.isFinite(nowMs) || context.channel !== 'authenticated-visual') {
      throw new ProposalError(
        'proposal-timestamp-invalid',
        'Visual decision context is invalid',
      );
    }
    const decision = ActionDecisionSchema.parse({
      ...request,
      id: context.decisionId,
      userId: operationScope.data.userId,
      authenticatedSessionId: operationScope.data.sessionId,
      channel: context.channel,
      decidedAt: context.now.toISOString(),
    });
    const outcome = await this.repository.transaction(async (transaction) => {
      const replay = await transaction.findDecisionByIdempotencyKey(
        decisionLookupFor(decision),
      );
      if (replay !== undefined) {
        return isSameDecisionReplay(replay.decision, decision)
          ? ({ kind: 'replay', decision: replay.decision } as const)
          : ({ kind: 'conflict' } as const);
      }
      const proposal = await transaction.getProposal(decision.proposalId);
      if (proposal === undefined) return { kind: 'not-found' } as const;
      const preparation = await transaction.getProposalPreparation(proposal.id);
      if (preparation === undefined) return { kind: 'conflict' } as const;
      if (proposal.state !== 'pending') return { kind: 'not-pending' } as const;
      if (proposal.disclosureGrant.userId !== decision.userId) {
        return { kind: 'user-mismatch' } as const;
      }
      if (
        decision.payloadHash !== proposal.payloadHash ||
        decision.approvalHash !== proposal.approvalHash ||
        hashActionProposalApproval(proposal) !== proposal.approvalHash
      ) {
        return { kind: 'hash-mismatch' } as const;
      }
      if (nowMs < Date.parse(proposal.createdAt)) {
        return { kind: 'invalid-time' } as const;
      }
      const transactionNow = this.currentTime();
      const transactionObservedAt = transactionNow.getTime();
      if (!Number.isFinite(transactionObservedAt)) {
        return { kind: 'invalid-time' } as const;
      }
      const transactionDecisionAt = Math.max(nowMs, transactionObservedAt);
      if (transactionDecisionAt >= Date.parse(proposal.expiresAt)) {
        const expiredAt = new Date(transactionDecisionAt).toISOString();
        const next = prepareProposalTransition(proposal, 'expired');
        const result = await transaction.transitionProposal({
          expected: expectedRevisionFor(proposal),
          next,
          event: {
            proposalId: proposal.id,
            eventType: 'proposal.expired',
            occurredAt: expiredAt,
          },
        });
        return result === 'created'
          ? ({ kind: 'expired' } as const)
          : result === 'duplicate'
            ? ({ kind: 'expired' } as const)
            : ({ kind: 'conflict' } as const);
      }
      const state = decision.decision === 'approved' ? 'approved' : 'rejected';
      const next = prepareProposalTransition(proposal, state);
      const result = await transaction.commitDecision({
        expected: expectedRevisionFor(proposal),
        next,
        decision,
        scope: authenticatedOperationScopeAssertion({
          phase: 'visual-decision',
          proposal,
          preparation,
          decision,
          disclosureGrant: proposal.disclosureGrant,
          activeAt: new Date(transactionDecisionAt).toISOString(),
          requireActiveDisclosureGrant: decision.decision === 'approved',
          operationScope: operationScope.data,
        }),
        event: {
          proposalId: proposal.id,
          eventType: `proposal.${state}`,
          occurredAt: decision.decidedAt,
          decisionId: decision.id,
          actorUserId: decision.userId,
          authenticatedSessionId: decision.authenticatedSessionId,
          approvalHash: decision.approvalHash,
          decisionIdempotencyKey: decision.idempotencyKey,
        },
      });
      if (result === 'created') return { kind: 'created' } as const;
      if (result === 'duplicate') {
        const persisted = await transaction.findDecisionByIdempotencyKey(
          decisionLookupFor(decision),
        );
        return persisted !== undefined &&
          isSameDecisionReplay(persisted.decision, decision)
          ? ({ kind: 'replay', decision: persisted.decision } as const)
          : ({ kind: 'conflict' } as const);
      }
      return { kind: 'conflict' } as const;
    });

    switch (outcome.kind) {
      case 'created':
        return decision;
      case 'replay':
        return outcome.decision;
      case 'not-found':
        throw new ProposalError(
          'proposal-not-found',
          `Proposal ${decision.proposalId} does not exist`,
        );
      case 'not-pending':
        throw new ProposalError(
          'proposal-not-pending',
          'Proposal is no longer pending',
        );
      case 'user-mismatch':
        throw new ProposalError(
          'proposal-user-mismatch',
          'Authenticated user does not own the proposal grant',
        );
      case 'hash-mismatch':
        throw new ProposalError(
          'proposal-hash-mismatch',
          'Decision does not match the immutable proposal',
        );
      case 'invalid-time':
        throw new ProposalError(
          'proposal-timestamp-invalid',
          'Decision time predates proposal creation',
        );
      case 'expired':
        throw new ProposalError(
          'proposal-expired',
          'Proposal expired before visual decision',
        );
      case 'conflict':
        throw new ProposalError(
          'proposal-decision-conflict',
          'Proposal decision conflicted with persisted state',
        );
    }
  }
}

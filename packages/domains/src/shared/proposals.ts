import { randomUUID } from 'node:crypto';

import {
  ActionDecisionRequestSchema,
  ActionDecisionSchema,
  ActionProposalSchema,
  DataDisclosureGrantSchema,
  ProviderWriteAuthorizationSchema,
  deepFreeze,
  type ActionDecision,
  type ActionDecisionRequest,
  type ActionProposal,
  type ProviderWriteAuthorization,
} from '@emdo/contracts';
import {
  hashCanonicalJson,
  hashProviderWriteApprovalBinding,
  ProviderWriteCompletionSchema,
  type ProviderWriteApprovalBinding,
  type ProviderWriteApprovalResult,
  type ProviderWriteApprovalStore,
  type ProviderWriteCompletion,
  type ProviderWriteDispatchResult,
  type ProviderWriteFinalizationStatus,
} from '@emdo/toolbox';

export type ProposalErrorCode =
  | 'proposal-already-exists'
  | 'proposal-approval-hash-mismatch'
  | 'proposal-decision-conflict'
  | 'proposal-disclosure-grant-invalid'
  | 'proposal-expired'
  | 'proposal-hash-mismatch'
  | 'proposal-idempotency-conflict'
  | 'proposal-materialization-mismatch'
  | 'proposal-not-found'
  | 'proposal-not-pending'
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
  readonly userId: string;
  readonly sessionId: string;
  readonly channel: 'authenticated-visual';
  readonly now: Date;
}

export interface TrustedProposalMaterializer {
  /** Capability-owned derivation. Agent/model output is never authoritative. */
  materialize(input: {
    readonly capabilityId: ActionProposal['capabilityId'];
    readonly capabilityFingerprint: ActionProposal['capabilityFingerprint'];
    readonly canonicalArguments: ActionProposal['canonicalArguments'];
    readonly disclosureGrant: ActionProposal['disclosureGrant'];
    readonly now: Date;
  }): Promise<
    Pick<
      ActionProposal,
      'targets' | 'beforePreview' | 'afterPreview' | 'providerPreconditions'
    >
  >;
}

export interface TrustedDisclosureGrantResolver {
  /** Resolves only server-issued grants from the authoritative grant store. */
  resolve(
    disclosureGrantId: string,
  ): Promise<ActionProposal['disclosureGrant'] | undefined>;
}

export type ApprovalHashInput = Omit<
  ActionProposal,
  'approvalHash' | 'version' | 'state'
>;

/** Binds the immutable visual preview and provider conditions to execution. */
export const hashActionProposalApproval = (
  proposal: ApprovalHashInput,
): string =>
  hashCanonicalJson({
    schemaVersion: proposal.schemaVersion,
    id: proposal.id,
    runId: proposal.runId,
    capabilityId: proposal.capabilityId,
    capabilityFingerprint: proposal.capabilityFingerprint,
    canonicalArguments: proposal.canonicalArguments,
    targets: proposal.targets,
    beforePreview: proposal.beforePreview,
    afterPreview: proposal.afterPreview,
    providerPreconditions: proposal.providerPreconditions,
    payloadHash: proposal.payloadHash,
    disclosureGrant: proposal.disclosureGrant,
    createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
    idempotencyKey: proposal.idempotencyKey,
  });

interface StoredDecision {
  readonly decision: ActionDecision;
  readonly proposalId: string;
}

interface StoredCompletion {
  readonly completion: ProviderWriteCompletion;
  readonly bindingHash: string;
  readonly completionHash: string;
  readonly completedAt: string;
}

interface RepositoryState {
  readonly proposals: Map<string, ActionProposal>;
  readonly proposalIdempotency: Map<string, string>;
  readonly decisions: Map<string, StoredDecision>;
  readonly decisionIdempotency: Map<string, string>;
  readonly consumedDecisionBindings: Map<string, string>;
  readonly permits: Map<string, ProviderWriteAuthorization>;
  readonly dispatchTimes: Map<string, string>;
  readonly completions: Map<string, StoredCompletion>;
  readonly reconciliations: Map<string, StoredCompletion>;
  readonly events: ProposalActivityEvent[];
}

const repositoryStates = new WeakMap<
  InMemoryProposalRepository,
  RepositoryState
>();

const stateFor = (repository: InMemoryProposalRepository): RepositoryState => {
  const state = repositoryStates.get(repository);
  if (state === undefined)
    throw new Error('Proposal repository is unavailable');
  return state;
};

/** Public surface is read-only; all mutations remain module-private. */
export class InMemoryProposalRepository {
  constructor() {
    repositoryStates.set(this, {
      proposals: new Map(),
      proposalIdempotency: new Map(),
      decisions: new Map(),
      decisionIdempotency: new Map(),
      consumedDecisionBindings: new Map(),
      permits: new Map(),
      dispatchTimes: new Map(),
      completions: new Map(),
      reconciliations: new Map(),
      events: [],
    });
  }

  getProposal(id: string): ActionProposal | undefined {
    return stateFor(this).proposals.get(id);
  }

  listEvents(): readonly ProposalActivityEvent[] {
    return Object.freeze([...stateFor(this).events]);
  }
}

const appendEvent = (
  repository: InMemoryProposalRepository,
  event: ProposalActivityEvent,
): void => {
  stateFor(repository).events.push(deepFreeze({ ...event }));
};

const proposalIdempotencyScope = (proposal: ActionProposal): string =>
  hashCanonicalJson({
    householdId: proposal.disclosureGrant.householdId,
    userId: proposal.disclosureGrant.userId,
    capabilityId: proposal.capabilityId,
    idempotencyKey: proposal.idempotencyKey,
  });

const findProposalByIdempotencyKey = (
  repository: InMemoryProposalRepository,
  proposal: ActionProposal,
): ActionProposal | undefined => {
  const state = stateFor(repository);
  const id = state.proposalIdempotency.get(proposalIdempotencyScope(proposal));
  return id === undefined ? undefined : state.proposals.get(id);
};

const insertProposal = (
  repository: InMemoryProposalRepository,
  proposal: ActionProposal,
): void => {
  const state = stateFor(repository);
  if (state.proposals.has(proposal.id)) {
    throw new ProposalError(
      'proposal-already-exists',
      `Proposal ${proposal.id} already exists`,
    );
  }
  const scopedIdempotencyKey = proposalIdempotencyScope(proposal);
  if (state.proposalIdempotency.has(scopedIdempotencyKey)) {
    throw new ProposalError(
      'proposal-idempotency-conflict',
      'Proposal idempotency key is already bound',
    );
  }
  state.proposals.set(proposal.id, proposal);
  state.proposalIdempotency.set(scopedIdempotencyKey, proposal.id);
  appendEvent(repository, {
    proposalId: proposal.id,
    eventType: 'proposal.created',
    occurredAt: proposal.createdAt,
  });
};

const prepareProposalTransition = (
  repository: InMemoryProposalRepository,
  expected: ActionProposal,
  nextState: ActionProposal['state'],
): ActionProposal => {
  const state = stateFor(repository);
  const current = state.proposals.get(expected.id);
  if (
    current === undefined ||
    current.version !== expected.version ||
    current.state !== expected.state ||
    current.approvalHash !== expected.approvalHash ||
    hashActionProposalApproval(current) !== current.approvalHash
  ) {
    throw new ProposalError(
      'proposal-decision-conflict',
      'Proposal state changed or immutable material failed validation',
    );
  }
  const allowedTransitions: Readonly<
    Record<ActionProposal['state'], readonly ActionProposal['state'][]>
  > = {
    pending: ['approved', 'rejected', 'expired'],
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
  if (!allowedTransitions[current.state].includes(nextState)) {
    throw new ProposalError(
      'proposal-state-transition-invalid',
      `Proposal cannot transition from ${current.state} to ${nextState}`,
    );
  }
  const next = ActionProposalSchema.parse({
    ...current,
    version: current.version + 1,
    state: nextState,
  });
  return next;
};

const transitionProposal = (
  repository: InMemoryProposalRepository,
  expected: ActionProposal,
  nextState: ActionProposal['state'],
): ActionProposal => {
  const next = prepareProposalTransition(repository, expected, nextState);
  const state = stateFor(repository);
  const current = state.proposals.get(expected.id);
  if (current === undefined) {
    throw new ProposalError(
      'proposal-decision-conflict',
      'Proposal disappeared before its state transition',
    );
  }
  state.proposals.set(current.id, next);
  return next;
};

const decisionIdempotencyScope = (decision: ActionDecision): string =>
  hashCanonicalJson({
    userId: decision.userId,
    proposalId: decision.proposalId,
    idempotencyKey: decision.idempotencyKey,
  });

const findDecisionByIdempotencyKey = (
  repository: InMemoryProposalRepository,
  decision: ActionDecision,
): ActionDecision | undefined => {
  const state = stateFor(repository);
  const id = state.decisionIdempotency.get(decisionIdempotencyScope(decision));
  return id === undefined ? undefined : state.decisions.get(id)?.decision;
};

const commitDecisionAndTransition = (
  repository: InMemoryProposalRepository,
  decision: ActionDecision,
  proposal: ActionProposal,
  nextState: 'approved' | 'rejected',
): void => {
  const state = stateFor(repository);
  const scopedIdempotencyKey = decisionIdempotencyScope(decision);
  if (
    state.decisions.has(decision.id) ||
    state.decisionIdempotency.has(scopedIdempotencyKey)
  ) {
    throw new ProposalError(
      'proposal-decision-conflict',
      'Approval decision is already persisted',
    );
  }
  const next = prepareProposalTransition(repository, proposal, nextState);

  // All validation precedes this synchronous in-memory commit.
  state.decisions.set(decision.id, {
    decision,
    proposalId: decision.proposalId,
  });
  state.decisionIdempotency.set(scopedIdempotencyKey, decision.id);
  state.proposals.set(proposal.id, next);
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
  proposal.payloadHash === binding.payloadHash &&
  hashActionProposalApproval(proposal) === proposal.approvalHash;

type ExistingAttemptLookup =
  | Extract<
      ProviderWriteApprovalResult,
      { readonly status: 'existing-attempt' }
    >
  | { readonly status: 'mismatch' };

const existingAttemptResult = (
  state: RepositoryState,
  decisionId: string,
  proposal: ActionProposal,
  bindingHash: string,
): ExistingAttemptLookup | undefined => {
  const consumedBindingHash = state.consumedDecisionBindings.get(decisionId);
  if (consumedBindingHash === undefined) return undefined;
  if (consumedBindingHash !== bindingHash) return { status: 'mismatch' };
  const authorization = state.permits.get(decisionId);
  if (authorization === undefined) return { status: 'mismatch' };
  if (proposal.state === 'prepared' || proposal.state === 'executing') {
    return {
      status: 'existing-attempt',
      attemptState: proposal.state,
      authorization,
    };
  }
  if (
    proposal.state !== 'executed' &&
    proposal.state !== 'not-applied' &&
    proposal.state !== 'indeterminate'
  ) {
    return { status: 'mismatch' };
  }
  const storedCompletion =
    state.reconciliations.get(decisionId) ?? state.completions.get(decisionId);
  if (storedCompletion === undefined) return { status: 'mismatch' };
  const parsedCompletion = ProviderWriteCompletionSchema.safeParse(
    storedCompletion.completion,
  );
  if (
    !parsedCompletion.success ||
    parsedCompletion.data.state !== proposal.state
  ) {
    return { status: 'mismatch' };
  }
  return {
    status: 'existing-attempt',
    attemptState: proposal.state,
    authorization,
    completion: parsedCompletion.data,
  };
};

const acquireApproval = async (
  repository: InMemoryProposalRepository,
  binding: ProviderWriteApprovalBinding,
  currentTime: () => Date,
  resolveDisclosureGrant: TrustedDisclosureGrantResolver['resolve'],
): Promise<ProviderWriteApprovalResult> => {
  const state = stateFor(repository);
  const storedDecision = state.decisions.get(binding.decisionId);
  if (storedDecision === undefined) return { status: 'not-found' };
  const { decision } = storedDecision;
  const proposal = state.proposals.get(storedDecision.proposalId);
  if (proposal === undefined) return { status: 'not-found' };
  if (!bindingMatches(decision, proposal, binding))
    return { status: 'mismatch' };

  const observedNow = currentTime();
  const checkedAt = observedNow.getTime();
  if (!Number.isFinite(checkedAt)) return { status: 'mismatch' };
  if (
    !Number.isSafeInteger(binding.idempotencyTtlMs) ||
    binding.idempotencyTtlMs <= 0 ||
    binding.idempotencyTtlMs > 31_536_000_000
  ) {
    return { status: 'mismatch' };
  }
  const bindingHash = hashProviderWriteApprovalBinding(binding);
  const existingAttempt = existingAttemptResult(
    state,
    decision.id,
    proposal,
    bindingHash,
  );
  if (existingAttempt !== undefined) return existingAttempt;
  if (
    checkedAt < Date.parse(proposal.createdAt) ||
    checkedAt < Date.parse(decision.decidedAt)
  )
    return { status: 'mismatch' };
  if (checkedAt >= Date.parse(proposal.expiresAt)) {
    if (proposal.state === 'approved') {
      transitionProposal(repository, proposal, 'expired');
      appendEvent(repository, {
        proposalId: proposal.id,
        eventType: 'proposal.expired',
        occurredAt: observedNow.toISOString(),
      });
    }
    return { status: 'expired' };
  }
  const trustedDisclosureGrantResult = DataDisclosureGrantSchema.safeParse(
    await resolveDisclosureGrant(proposal.disclosureGrant.id),
  );
  const currentProposal = state.proposals.get(proposal.id);
  if (currentProposal !== undefined) {
    const racedExistingAttempt = existingAttemptResult(
      state,
      decision.id,
      currentProposal,
      bindingHash,
    );
    if (racedExistingAttempt !== undefined) return racedExistingAttempt;
  }
  const observedAuthorizationNow = currentTime();
  const observedAuthorizationAt = observedAuthorizationNow.getTime();
  if (!Number.isFinite(observedAuthorizationAt)) return { status: 'mismatch' };
  const authorizationAt = Math.max(
    observedAuthorizationAt,
    checkedAt,
    Date.parse(proposal.createdAt),
    Date.parse(decision.decidedAt),
  );
  const authorizationNow = new Date(authorizationAt);
  if (authorizationAt >= Date.parse(proposal.expiresAt)) {
    if (currentProposal?.state === 'approved') {
      transitionProposal(repository, currentProposal, 'expired');
      appendEvent(repository, {
        proposalId: currentProposal.id,
        eventType: 'proposal.expired',
        occurredAt: authorizationNow.toISOString(),
      });
    }
    return { status: 'expired' };
  }
  if (
    !trustedDisclosureGrantResult.success ||
    hashCanonicalJson(trustedDisclosureGrantResult.data) !==
      hashCanonicalJson(proposal.disclosureGrant) ||
    authorizationAt < Date.parse(trustedDisclosureGrantResult.data.createdAt) ||
    authorizationAt >= Date.parse(trustedDisclosureGrantResult.data.expiresAt)
  ) {
    return { status: 'mismatch' };
  }
  const trustedDisclosureGrant = trustedDisclosureGrantResult.data;
  if (
    currentProposal === undefined ||
    currentProposal.version !== proposal.version ||
    currentProposal.state !== 'approved' ||
    !bindingMatches(decision, currentProposal, binding)
  ) {
    return { status: 'mismatch' };
  }

  const permit = ProviderWriteAuthorizationSchema.parse({
    proposalId: currentProposal.id,
    approvalHash: currentProposal.approvalHash,
    approvalBindingHash: bindingHash,
    capabilityFingerprint: currentProposal.capabilityFingerprint,
    proposalCreatedAt: currentProposal.createdAt,
    expiresAt: currentProposal.expiresAt,
    disclosureGrantId: trustedDisclosureGrant.id,
    disclosureGrantHash: hashCanonicalJson(trustedDisclosureGrant),
    providerIdempotencyKey: hashCanonicalJson({
      schemaVersion: 1,
      proposalId: currentProposal.id,
      capabilityId: currentProposal.capabilityId,
      capabilityFingerprint: currentProposal.capabilityFingerprint,
      disclosureGrantId: currentProposal.disclosureGrant.id,
      idempotencyKey: currentProposal.idempotencyKey,
    }),
    idempotencyExpiresAt: new Date(
      authorizationAt + binding.idempotencyTtlMs,
    ).toISOString(),
    attemptId: randomUUID(),
    attemptVersion: 1,
    issuedAt: authorizationNow.toISOString(),
    targets: currentProposal.targets,
    providerPreconditions: currentProposal.providerPreconditions,
  });
  transitionProposal(repository, currentProposal, 'prepared');
  state.consumedDecisionBindings.set(decision.id, bindingHash);
  state.permits.set(decision.id, permit);
  appendEvent(repository, {
    proposalId: currentProposal.id,
    eventType: 'proposal.prepared',
    occurredAt: authorizationNow.toISOString(),
    decisionId: decision.id,
    actorUserId: decision.userId,
    authenticatedSessionId: decision.authenticatedSessionId,
    approvalHash: decision.approvalHash,
    decisionIdempotencyKey: decision.idempotencyKey,
    providerIdempotencyKey: permit.providerIdempotencyKey,
    attemptId: permit.attemptId,
    attemptVersion: permit.attemptVersion,
  });
  return {
    status: 'authorized',
    authorization: permit,
  };
};

const finalizeApproval = (
  repository: InMemoryProposalRepository,
  binding: ProviderWriteApprovalBinding,
  completion: ProviderWriteCompletion,
  now: Date,
): ProviderWriteFinalizationStatus => {
  const parsedCompletion = ProviderWriteCompletionSchema.safeParse(completion);
  if (!parsedCompletion.success) return 'mismatch';
  const validatedCompletion = parsedCompletion.data;
  const state = stateFor(repository);
  const storedDecision = state.decisions.get(binding.decisionId);
  if (storedDecision === undefined) return 'not-found';
  const proposal = state.proposals.get(storedDecision.proposalId);
  if (
    proposal === undefined ||
    !bindingMatches(storedDecision.decision, proposal, binding)
  ) {
    return 'mismatch';
  }
  const bindingHash = hashProviderWriteApprovalBinding(binding);
  const completionHash = hashCanonicalJson(validatedCompletion);
  const existing = state.completions.get(binding.decisionId);
  if (existing !== undefined) {
    return existing.bindingHash === bindingHash &&
      existing.completionHash === completionHash
      ? 'already-finalized'
      : 'mismatch';
  }
  const permit = state.permits.get(binding.decisionId);
  const persistedDispatchAt = state.dispatchTimes.get(binding.decisionId);
  const observedCompletedAt = now.getTime();
  const preparedPreDispatchCompletion =
    proposal.state === 'prepared' &&
    validatedCompletion.state === 'not-applied' &&
    (validatedCompletion.reason === 'approval-expired-before-dispatch' ||
      validatedCompletion.reason === 'approval-policy-mismatch' ||
      validatedCompletion.reason === 'provider-rejected-before-apply');
  if (
    state.consumedDecisionBindings.get(binding.decisionId) !== bindingHash ||
    permit === undefined ||
    permit.approvalBindingHash !== bindingHash ||
    (proposal.state !== 'executing' && !preparedPreDispatchCompletion) ||
    (proposal.state === 'executing' && persistedDispatchAt === undefined) ||
    !Number.isFinite(observedCompletedAt)
  ) {
    return 'mismatch';
  }
  const completedAt = new Date(
    Math.max(
      observedCompletedAt,
      Date.parse(permit.issuedAt),
      persistedDispatchAt === undefined
        ? Number.NEGATIVE_INFINITY
        : Date.parse(persistedDispatchAt),
    ),
  ).toISOString();
  transitionProposal(repository, proposal, validatedCompletion.state);
  state.completions.set(
    binding.decisionId,
    Object.freeze({
      completion: validatedCompletion,
      bindingHash,
      completionHash,
      completedAt,
    }),
  );
  appendEvent(repository, {
    proposalId: proposal.id,
    eventType: `proposal.${validatedCompletion.state}`,
    occurredAt: completedAt,
    decisionId: storedDecision.decision.id,
    actorUserId: storedDecision.decision.userId,
    authenticatedSessionId: storedDecision.decision.authenticatedSessionId,
    approvalHash: storedDecision.decision.approvalHash,
    decisionIdempotencyKey: storedDecision.decision.idempotencyKey,
    application: validatedCompletion.application,
    ...(!('reason' in validatedCompletion)
      ? {}
      : { outcomeReason: validatedCompletion.reason }),
    ...(!('outputStatus' in validatedCompletion)
      ? {}
      : { outputStatus: validatedCompletion.outputStatus }),
    ...(!('reconciliationRequired' in validatedCompletion)
      ? {}
      : {
          reconciliationRequired: validatedCompletion.reconciliationRequired,
        }),
    ...(!('evidenceHash' in validatedCompletion) ||
    validatedCompletion.evidenceHash === undefined
      ? {}
      : { evidenceHash: validatedCompletion.evidenceHash }),
    providerIdempotencyKey: permit.providerIdempotencyKey,
    attemptId: permit.attemptId,
    attemptVersion: permit.attemptVersion,
    ...(!('resultHash' in validatedCompletion)
      ? {}
      : { resultHash: validatedCompletion.resultHash }),
    ...(!('safeErrorCode' in validatedCompletion)
      ? {}
      : { safeErrorCode: validatedCompletion.safeErrorCode }),
  });
  return 'finalized';
};

const markDispatchingApproval = async (
  repository: InMemoryProposalRepository,
  binding: ProviderWriteApprovalBinding,
  attemptId: string,
  currentTime: () => Date,
  resolveDisclosureGrant: TrustedDisclosureGrantResolver['resolve'],
): Promise<ProviderWriteDispatchResult> => {
  const state = stateFor(repository);
  const storedDecision = state.decisions.get(binding.decisionId);
  if (storedDecision === undefined) return { status: 'not-found' };
  const { decision } = storedDecision;
  const proposal = state.proposals.get(storedDecision.proposalId);
  if (proposal === undefined || !bindingMatches(decision, proposal, binding)) {
    return { status: 'mismatch' };
  }
  const bindingHash = hashProviderWriteApprovalBinding(binding);
  const existingAttempt = existingAttemptResult(
    state,
    decision.id,
    proposal,
    bindingHash,
  );
  if (
    existingAttempt === undefined ||
    existingAttempt.status !== 'existing-attempt'
  ) {
    return existingAttempt ?? { status: 'mismatch' };
  }
  if (existingAttempt.authorization.attemptId !== attemptId) {
    return { status: 'mismatch' };
  }
  if (existingAttempt.attemptState !== 'prepared') return existingAttempt;

  const trustedDisclosureGrantResult = DataDisclosureGrantSchema.safeParse(
    await resolveDisclosureGrant(proposal.disclosureGrant.id),
  );
  const currentProposal = state.proposals.get(proposal.id);
  if (currentProposal === undefined) return { status: 'not-found' };
  const racedAttempt = existingAttemptResult(
    state,
    decision.id,
    currentProposal,
    bindingHash,
  );
  if (
    racedAttempt === undefined ||
    racedAttempt.status !== 'existing-attempt'
  ) {
    return racedAttempt ?? { status: 'mismatch' };
  }
  if (racedAttempt.authorization.attemptId !== attemptId) {
    return { status: 'mismatch' };
  }
  if (racedAttempt.attemptState !== 'prepared') return racedAttempt;

  const dispatchNow = currentTime();
  const observedDispatchAt = dispatchNow.getTime();
  if (!Number.isFinite(observedDispatchAt)) return { status: 'mismatch' };
  const permit = racedAttempt.authorization;
  const dispatchAt = Math.max(observedDispatchAt, Date.parse(permit.issuedAt));
  const effectiveDispatchTime = new Date(dispatchAt);
  if (
    dispatchAt >= Date.parse(permit.expiresAt) ||
    dispatchAt >= Date.parse(permit.idempotencyExpiresAt)
  ) {
    const finalization = finalizeApproval(
      repository,
      binding,
      {
        state: 'not-applied',
        application: 'not-applied',
        reason: 'approval-expired-before-dispatch',
      },
      effectiveDispatchTime,
    );
    return finalization === 'finalized' || finalization === 'already-finalized'
      ? { status: 'expired' }
      : { status: 'mismatch' };
  }
  if (
    !trustedDisclosureGrantResult.success ||
    hashCanonicalJson(trustedDisclosureGrantResult.data) !==
      hashCanonicalJson(currentProposal.disclosureGrant) ||
    dispatchAt < Date.parse(trustedDisclosureGrantResult.data.createdAt) ||
    dispatchAt >= Date.parse(trustedDisclosureGrantResult.data.expiresAt)
  ) {
    finalizeApproval(
      repository,
      binding,
      {
        state: 'not-applied',
        application: 'not-applied',
        reason: 'approval-policy-mismatch',
      },
      effectiveDispatchTime,
    );
    return { status: 'mismatch' };
  }
  if (
    currentProposal.state !== 'prepared' ||
    !bindingMatches(decision, currentProposal, binding)
  ) {
    return { status: 'mismatch' };
  }

  transitionProposal(repository, currentProposal, 'executing');
  state.dispatchTimes.set(decision.id, effectiveDispatchTime.toISOString());
  appendEvent(repository, {
    proposalId: currentProposal.id,
    eventType: 'proposal.executing',
    occurredAt: effectiveDispatchTime.toISOString(),
    decisionId: decision.id,
    actorUserId: decision.userId,
    authenticatedSessionId: decision.authenticatedSessionId,
    approvalHash: decision.approvalHash,
    decisionIdempotencyKey: decision.idempotencyKey,
    providerIdempotencyKey: permit.providerIdempotencyKey,
    attemptId: permit.attemptId,
    attemptVersion: permit.attemptVersion,
  });
  return {
    status: 'dispatch-authorized',
    authorization: permit,
  };
};

const reconcileApproval = (
  repository: InMemoryProposalRepository,
  binding: ProviderWriteApprovalBinding,
  completion: ProviderWriteCompletion,
  now: Date,
): ProviderWriteFinalizationStatus => {
  const parsedCompletion = ProviderWriteCompletionSchema.safeParse(completion);
  if (
    !parsedCompletion.success ||
    parsedCompletion.data.state === 'indeterminate' ||
    (parsedCompletion.data.state === 'not-applied' &&
      (parsedCompletion.data.reason === 'approval-expired-before-dispatch' ||
        parsedCompletion.data.reason === 'approval-policy-mismatch'))
  ) {
    return 'mismatch';
  }
  const validatedCompletion = parsedCompletion.data;
  const state = stateFor(repository);
  const storedDecision = state.decisions.get(binding.decisionId);
  const proposal =
    storedDecision === undefined
      ? undefined
      : state.proposals.get(storedDecision.proposalId);
  if (
    storedDecision === undefined ||
    proposal === undefined ||
    !bindingMatches(storedDecision.decision, proposal, binding)
  ) {
    return storedDecision === undefined ? 'not-found' : 'mismatch';
  }
  const bindingHash = hashProviderWriteApprovalBinding(binding);
  const completionHash = hashCanonicalJson(validatedCompletion);
  const existingReconciliation = state.reconciliations.get(binding.decisionId);
  if (existingReconciliation !== undefined) {
    return existingReconciliation.bindingHash === bindingHash &&
      existingReconciliation.completionHash === completionHash
      ? 'already-finalized'
      : 'mismatch';
  }
  const initialCompletion = state.completions.get(binding.decisionId);
  const permit = state.permits.get(binding.decisionId);
  const persistedDispatchAt = state.dispatchTimes.get(binding.decisionId);
  const observedReconciledAt = now.getTime();
  if (
    state.consumedDecisionBindings.get(binding.decisionId) !== bindingHash ||
    initialCompletion?.completion.state !== 'indeterminate' ||
    permit === undefined ||
    persistedDispatchAt === undefined ||
    permit.approvalBindingHash !== bindingHash ||
    proposal.state !== 'indeterminate' ||
    !Number.isFinite(observedReconciledAt)
  ) {
    return 'mismatch';
  }
  const reconciledAt = new Date(
    Math.max(
      observedReconciledAt,
      Date.parse(initialCompletion.completedAt),
      Date.parse(persistedDispatchAt),
    ),
  ).toISOString();

  transitionProposal(repository, proposal, validatedCompletion.state);
  state.reconciliations.set(
    binding.decisionId,
    Object.freeze({
      completion: validatedCompletion,
      bindingHash,
      completionHash,
      completedAt: reconciledAt,
    }),
  );
  appendEvent(repository, {
    proposalId: proposal.id,
    eventType: `proposal.${validatedCompletion.state}`,
    occurredAt: reconciledAt,
    decisionId: storedDecision.decision.id,
    actorUserId: storedDecision.decision.userId,
    authenticatedSessionId: storedDecision.decision.authenticatedSessionId,
    approvalHash: storedDecision.decision.approvalHash,
    decisionIdempotencyKey: storedDecision.decision.idempotencyKey,
    application: validatedCompletion.application,
    ...(!('reason' in validatedCompletion)
      ? {}
      : { outcomeReason: validatedCompletion.reason }),
    ...(!('outputStatus' in validatedCompletion)
      ? {}
      : { outputStatus: validatedCompletion.outputStatus }),
    ...(!('evidenceHash' in validatedCompletion) ||
    validatedCompletion.evidenceHash === undefined
      ? {}
      : { evidenceHash: validatedCompletion.evidenceHash }),
    providerIdempotencyKey: permit.providerIdempotencyKey,
    attemptId: permit.attemptId,
    attemptVersion: permit.attemptVersion,
    ...(!('resultHash' in validatedCompletion)
      ? {}
      : { resultHash: validatedCompletion.resultHash }),
    ...(!('safeErrorCode' in validatedCompletion)
      ? {}
      : { safeErrorCode: validatedCompletion.safeErrorCode }),
  });
  return 'finalized';
};

const isSameProposalReplay = (
  persisted: ActionProposal,
  candidate: ActionProposal,
): boolean =>
  hashCanonicalJson({
    id: persisted.id,
    approvalHash: persisted.approvalHash,
  }) ===
  hashCanonicalJson({
    id: candidate.id,
    approvalHash: candidate.approvalHash,
  });

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

export class ProposalService {
  readonly approvalStore: ProviderWriteApprovalStore;
  private readonly materializeProposal: TrustedProposalMaterializer['materialize'];
  private readonly resolveDisclosureGrant: TrustedDisclosureGrantResolver['resolve'];
  private readonly currentTime: () => Date;

  constructor(
    materializer: TrustedProposalMaterializer,
    disclosureGrantResolver: TrustedDisclosureGrantResolver,
    private readonly repository: InMemoryProposalRepository = new InMemoryProposalRepository(),
    now: () => Date = () => new Date(),
  ) {
    this.materializeProposal = materializer.materialize.bind(materializer);
    this.resolveDisclosureGrant = disclosureGrantResolver.resolve.bind(
      disclosureGrantResolver,
    );
    this.currentTime = now.bind(undefined);
    this.approvalStore = Object.freeze({
      acquire: async (binding: ProviderWriteApprovalBinding) =>
        acquireApproval(
          this.repository,
          binding,
          this.currentTime,
          this.resolveDisclosureGrant,
        ),
      markDispatching: async (
        binding: ProviderWriteApprovalBinding,
        attemptId: string,
      ) =>
        markDispatchingApproval(
          this.repository,
          binding,
          attemptId,
          this.currentTime,
          this.resolveDisclosureGrant,
        ),
      finalize: async (
        binding: ProviderWriteApprovalBinding,
        completion: ProviderWriteCompletion,
      ) =>
        finalizeApproval(
          this.repository,
          binding,
          completion,
          this.currentTime(),
        ),
      reconcile: async (
        binding: ProviderWriteApprovalBinding,
        completion: ProviderWriteCompletion,
      ) =>
        reconcileApproval(
          this.repository,
          binding,
          completion,
          this.currentTime(),
        ),
    });
  }

  getProposal(id: string): ActionProposal | undefined {
    return this.repository.getProposal(id);
  }

  listEvents(): readonly ProposalActivityEvent[] {
    return this.repository.listEvents();
  }

  async create(rawProposal: ActionProposal): Promise<ActionProposal> {
    const proposal = ActionProposalSchema.parse(rawProposal);
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

    const replay = findProposalByIdempotencyKey(this.repository, proposal);
    if (replay !== undefined) {
      if (!isSameProposalReplay(replay, proposal)) {
        throw new ProposalError(
          'proposal-idempotency-conflict',
          'Proposal idempotency key is bound to a different request',
        );
      }
      return replay;
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
    const trustedDisclosureGrantResult = DataDisclosureGrantSchema.safeParse(
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
      !trustedDisclosureGrantResult.success ||
      hashCanonicalJson(trustedDisclosureGrantResult.data) !==
        hashCanonicalJson(proposal.disclosureGrant) ||
      grantCheckedAtMs <
        Date.parse(trustedDisclosureGrantResult.data.createdAt) ||
      grantCheckedAtMs >=
        Date.parse(trustedDisclosureGrantResult.data.expiresAt)
    ) {
      throw new ProposalError(
        'proposal-disclosure-grant-invalid',
        'Proposal disclosure grant is not an active server-issued grant',
      );
    }
    const trustedDisclosureGrant = trustedDisclosureGrantResult.data;
    const trustedMaterial = await this.materializeProposal({
      capabilityId: proposal.capabilityId,
      capabilityFingerprint: proposal.capabilityFingerprint,
      canonicalArguments: proposal.canonicalArguments,
      disclosureGrant: trustedDisclosureGrant,
      now: new Date(grantCheckedAt),
    });
    if (
      hashCanonicalJson({
        targets: proposal.targets,
        beforePreview: proposal.beforePreview,
        afterPreview: proposal.afterPreview,
        providerPreconditions: proposal.providerPreconditions,
      }) !== hashCanonicalJson(trustedMaterial)
    ) {
      throw new ProposalError(
        'proposal-materialization-mismatch',
        'Proposal preview and provider conditions were not derived by the trusted capability',
      );
    }
    const concurrentReplay = findProposalByIdempotencyKey(
      this.repository,
      proposal,
    );
    if (concurrentReplay !== undefined) {
      if (!isSameProposalReplay(concurrentReplay, proposal)) {
        throw new ProposalError(
          'proposal-idempotency-conflict',
          'Proposal idempotency key is bound to a different request',
        );
      }
      return concurrentReplay;
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
    insertProposal(this.repository, proposal);
    return proposal;
  }

  async decide(
    rawRequest: ActionDecisionRequest,
    context: AuthenticatedVisualDecisionContext,
  ): Promise<ActionDecision> {
    const request = ActionDecisionRequestSchema.parse(rawRequest);
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
      userId: context.userId,
      authenticatedSessionId: context.sessionId,
      channel: context.channel,
      decidedAt: context.now.toISOString(),
    });
    const replay = findDecisionByIdempotencyKey(this.repository, decision);
    if (replay !== undefined) {
      if (!isSameDecisionReplay(replay, decision)) {
        throw new ProposalError(
          'proposal-decision-conflict',
          'Decision idempotency key is bound to a different decision',
        );
      }
      return replay;
    }

    const proposal = this.repository.getProposal(decision.proposalId);
    if (proposal === undefined) {
      throw new ProposalError(
        'proposal-not-found',
        `Proposal ${decision.proposalId} does not exist`,
      );
    }
    if (proposal.state !== 'pending') {
      throw new ProposalError(
        'proposal-not-pending',
        'Only a pending proposal can be decided',
      );
    }
    if (proposal.disclosureGrant.userId !== decision.userId) {
      throw new ProposalError(
        'proposal-user-mismatch',
        'Only the authenticated user bound to the proposal may decide it',
      );
    }
    if (nowMs < Date.parse(proposal.createdAt)) {
      throw new ProposalError(
        'proposal-timestamp-invalid',
        'A visual decision cannot predate its proposal',
      );
    }
    if (proposal.payloadHash !== decision.payloadHash) {
      throw new ProposalError(
        'proposal-hash-mismatch',
        'The visual decision does not match the executable payload',
      );
    }
    if (proposal.approvalHash !== decision.approvalHash) {
      throw new ProposalError(
        'proposal-approval-hash-mismatch',
        'The visual decision does not match the displayed preview',
      );
    }
    if (nowMs >= Date.parse(proposal.expiresAt)) {
      transitionProposal(this.repository, proposal, 'expired');
      appendEvent(this.repository, {
        proposalId: proposal.id,
        eventType: 'proposal.expired',
        occurredAt: context.now.toISOString(),
      });
      throw new ProposalError(
        'proposal-expired',
        'The proposal is no longer eligible for approval',
      );
    }

    const state = decision.decision === 'approved' ? 'approved' : 'rejected';
    commitDecisionAndTransition(this.repository, decision, proposal, state);
    appendEvent(this.repository, {
      proposalId: proposal.id,
      eventType: `proposal.${state}`,
      occurredAt: context.now.toISOString(),
      decisionId: decision.id,
      actorUserId: decision.userId,
      authenticatedSessionId: decision.authenticatedSessionId,
      approvalHash: decision.approvalHash,
      decisionIdempotencyKey: decision.idempotencyKey,
    });
    return decision;
  }
}

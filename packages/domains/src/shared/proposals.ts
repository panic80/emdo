import {
  ActionDecisionSchema,
  ActionProposalSchema,
  type ActionDecision,
  type ActionProposal,
} from '@emdo/contracts';
import {
  hashCanonicalJson,
  type ProviderWriteApprovalBinding,
  type ProviderWriteApprovalStatus,
  type ProviderWriteApprovalStore,
} from '@emdo/toolbox';

export type ProposalErrorCode =
  | 'proposal-already-exists'
  | 'proposal-decision-conflict'
  | 'proposal-expired'
  | 'proposal-hash-mismatch'
  | 'proposal-idempotency-conflict'
  | 'proposal-not-found'
  | 'proposal-not-pending'
  | 'proposal-precondition-stale'
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
    | 'proposal.executing';
  readonly occurredAt: string;
}

interface StoredDecision {
  readonly decision: ActionDecision;
  readonly proposalId: string;
}

export class InMemoryProposalRepository {
  readonly #proposals = new Map<string, ActionProposal>();
  readonly #proposalIdempotency = new Map<string, string>();
  readonly #decisions = new Map<string, StoredDecision>();
  readonly #decisionIdempotency = new Map<string, string>();
  readonly #consumedDecisionIds = new Set<string>();
  readonly #events: ProposalActivityEvent[] = [];

  getProposal(id: string): ActionProposal | undefined {
    return this.#proposals.get(id);
  }

  findProposalByIdempotencyKey(key: string): ActionProposal | undefined {
    const id = this.#proposalIdempotency.get(key);
    return id === undefined ? undefined : this.#proposals.get(id);
  }

  insertProposal(proposal: ActionProposal): void {
    if (this.#proposals.has(proposal.id)) {
      throw new ProposalError(
        'proposal-already-exists',
        `Proposal ${proposal.id} already exists`,
      );
    }
    if (this.#proposalIdempotency.has(proposal.idempotencyKey)) {
      throw new ProposalError(
        'proposal-idempotency-conflict',
        'Proposal idempotency key is already bound',
      );
    }
    this.#proposals.set(proposal.id, proposal);
    this.#proposalIdempotency.set(proposal.idempotencyKey, proposal.id);
    this.appendEvent({
      proposalId: proposal.id,
      eventType: 'proposal.created',
      occurredAt: proposal.createdAt,
    });
  }

  replaceProposal(proposal: ActionProposal): void {
    if (!this.#proposals.has(proposal.id)) {
      throw new ProposalError(
        'proposal-not-found',
        `Proposal ${proposal.id} does not exist`,
      );
    }
    this.#proposals.set(proposal.id, proposal);
  }

  findDecisionByIdempotencyKey(key: string): ActionDecision | undefined {
    const id = this.#decisionIdempotency.get(key);
    return id === undefined ? undefined : this.#decisions.get(id)?.decision;
  }

  insertDecision(decision: ActionDecision): void {
    if (
      this.#decisions.has(decision.id) ||
      this.#decisionIdempotency.has(decision.idempotencyKey)
    ) {
      throw new ProposalError(
        'proposal-decision-conflict',
        'Approval decision is already persisted',
      );
    }
    this.#decisions.set(decision.id, {
      decision,
      proposalId: decision.proposalId,
    });
    this.#decisionIdempotency.set(decision.idempotencyKey, decision.id);
  }

  consumeApproval(
    binding: ProviderWriteApprovalBinding,
  ): ProviderWriteApprovalStatus {
    const storedDecision = this.#decisions.get(binding.decisionId);
    if (storedDecision === undefined) {
      return 'not-found';
    }
    const { decision } = storedDecision;
    const proposal = this.#proposals.get(storedDecision.proposalId);
    if (proposal === undefined) {
      return 'not-found';
    }
    if (
      decision.decision !== 'approved' ||
      decision.userId !== binding.userId ||
      decision.payloadHash !== binding.payloadHash ||
      proposal.runId !== binding.runId ||
      proposal.capabilityId !== binding.capabilityId ||
      proposal.payloadHash !== binding.payloadHash
    ) {
      return 'mismatch';
    }

    const checkedAt = Date.parse(binding.checkedAt);
    if (!Number.isFinite(checkedAt)) {
      return 'mismatch';
    }
    if (
      checkedAt < Date.parse(proposal.createdAt) ||
      checkedAt < Date.parse(decision.decidedAt)
    ) {
      return 'mismatch';
    }
    if (checkedAt >= Date.parse(proposal.expiresAt)) {
      return 'expired';
    }
    if (this.#consumedDecisionIds.has(decision.id)) {
      return 'consumed';
    }
    if (proposal.state !== 'approved') {
      return 'mismatch';
    }

    // No await occurs inside this critical section. A database implementation
    // performs the same transition with a conditional UPDATE in one transaction.
    this.#consumedDecisionIds.add(decision.id);
    const executing = ActionProposalSchema.parse({
      ...proposal,
      version: proposal.version + 1,
      state: 'executing',
    });
    this.#proposals.set(proposal.id, executing);
    this.appendEvent({
      proposalId: proposal.id,
      eventType: 'proposal.executing',
      occurredAt: binding.checkedAt,
    });
    return 'authorized';
  }

  appendEvent(event: ProposalActivityEvent): void {
    this.#events.push(Object.freeze({ ...event }));
  }

  listEvents(): readonly ProposalActivityEvent[] {
    return Object.freeze([...this.#events]);
  }
}

const isSameProposalReplay = (
  persisted: ActionProposal,
  candidate: ActionProposal,
): boolean =>
  hashCanonicalJson({
    runId: persisted.runId,
    capabilityId: persisted.capabilityId,
    canonicalArguments: persisted.canonicalArguments,
    targets: persisted.targets,
    beforePreview: persisted.beforePreview,
    afterPreview: persisted.afterPreview,
    providerPreconditions: persisted.providerPreconditions,
    payloadHash: persisted.payloadHash,
    disclosureGrant: persisted.disclosureGrant,
    createdAt: persisted.createdAt,
    expiresAt: persisted.expiresAt,
  }) ===
  hashCanonicalJson({
    runId: candidate.runId,
    capabilityId: candidate.capabilityId,
    canonicalArguments: candidate.canonicalArguments,
    targets: candidate.targets,
    beforePreview: candidate.beforePreview,
    afterPreview: candidate.afterPreview,
    providerPreconditions: candidate.providerPreconditions,
    payloadHash: candidate.payloadHash,
    disclosureGrant: candidate.disclosureGrant,
    createdAt: candidate.createdAt,
    expiresAt: candidate.expiresAt,
  });

const isSameDecisionReplay = (
  persisted: ActionDecision,
  candidate: ActionDecision,
): boolean =>
  persisted.proposalId === candidate.proposalId &&
  persisted.userId === candidate.userId &&
  persisted.authenticatedSessionId === candidate.authenticatedSessionId &&
  persisted.payloadHash === candidate.payloadHash &&
  persisted.decision === candidate.decision;

export class ProposalService {
  readonly approvalStore: ProviderWriteApprovalStore;

  constructor(readonly repository: InMemoryProposalRepository) {
    this.approvalStore = Object.freeze({
      consume: async (binding: ProviderWriteApprovalBinding) =>
        this.repository.consumeApproval(binding),
    });
  }

  async create(rawProposal: ActionProposal): Promise<ActionProposal> {
    const proposal = ActionProposalSchema.parse(rawProposal);
    if (proposal.state !== 'pending') {
      throw new ProposalError(
        'proposal-not-pending',
        'A newly created proposal must be pending',
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

    const replay = this.repository.findProposalByIdempotencyKey(
      proposal.idempotencyKey,
    );
    if (replay !== undefined) {
      if (!isSameProposalReplay(replay, proposal)) {
        throw new ProposalError(
          'proposal-idempotency-conflict',
          'Proposal idempotency key is bound to a different request',
        );
      }
      return replay;
    }

    this.repository.insertProposal(proposal);
    return proposal;
  }

  async decide(
    rawDecision: ActionDecision,
    now: Date,
  ): Promise<ActionDecision> {
    const decision = ActionDecisionSchema.parse(rawDecision);
    const replay = this.repository.findDecisionByIdempotencyKey(
      decision.idempotencyKey,
    );
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
        'Only the user bound to the proposal may decide it',
      );
    }
    if (proposal.payloadHash !== decision.payloadHash) {
      throw new ProposalError(
        'proposal-hash-mismatch',
        'The visual decision does not match the displayed proposal',
      );
    }
    if (now.getTime() >= Date.parse(proposal.expiresAt)) {
      const expired = ActionProposalSchema.parse({
        ...proposal,
        version: proposal.version + 1,
        state: 'expired',
      });
      this.repository.replaceProposal(expired);
      this.repository.appendEvent({
        proposalId: proposal.id,
        eventType: 'proposal.expired',
        occurredAt: now.toISOString(),
      });
      throw new ProposalError(
        'proposal-expired',
        'The proposal is no longer eligible for approval',
      );
    }

    this.repository.insertDecision(decision);
    const state = decision.decision === 'approved' ? 'approved' : 'rejected';
    this.repository.replaceProposal(
      ActionProposalSchema.parse({
        ...proposal,
        version: proposal.version + 1,
        state,
      }),
    );
    this.repository.appendEvent({
      proposalId: proposal.id,
      eventType: `proposal.${state}`,
      occurredAt: now.toISOString(),
    });
    return decision;
  }

  async assertProviderPreconditions(
    proposalId: string,
    currentValues: Readonly<Record<string, string>>,
  ): Promise<void> {
    const proposal = this.repository.getProposal(proposalId);
    if (proposal === undefined) {
      throw new ProposalError(
        'proposal-not-found',
        `Proposal ${proposalId} does not exist`,
      );
    }

    for (const precondition of proposal.providerPreconditions) {
      const key = `${precondition.kind}:${precondition.targetId}`;
      if (currentValues[key] !== precondition.expectedValue) {
        throw new ProposalError(
          'proposal-precondition-stale',
          `Provider precondition ${key} changed after the preview`,
        );
      }
    }
  }
}

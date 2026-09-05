import { describe, expect, it } from 'vitest';

import {
  ActionDecisionSchema,
  ActionProposalSchema,
  EffectiveAuthorizationScopeFingerprintSchema,
} from '@emdo/contracts';
import { hashCanonicalJson } from '@emdo/toolbox';

import {
  createProposalLifecycleService,
  createProviderWriteReconciliationService,
  hashActionProposalApproval,
  InMemoryProposalRepository,
  ProposalService,
  type ProposalOperationScopeAssertion,
  type ProposalRepositoryTransaction,
  type StoredDecision,
  type StoredProviderWriteAttempt,
} from './proposals.js';

const ids = {
  proposal: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f001',
  grant: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f002',
  user: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f003',
  household: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f004',
  run: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f005',
  decision: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f006',
  session: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f007',
  otherProposal: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f008',
  otherGrant: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f009',
  otherUser: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f010',
  otherHousehold: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f011',
  otherRun: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f012',
  privateSpace: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f013',
  request: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f014',
  currentRequest: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f015',
  currentSpaceGrant: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f016',
  originSpaceGrant: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f017',
  parentInvocation: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f018',
  agentInvocation: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f019',
  phaseInvocation: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f020',
} as const;

const argumentsValue = { calendarId: 'primary', title: 'Dentist' };
const payloadHash = hashCanonicalJson(argumentsValue);
const capabilityFingerprint = hashCanonicalJson({
  schemaVersion: 1,
  id: 'google-calendar.event.create',
  version: '1.0.0',
  inputSchema: { id: 'calendar.event-create.input', version: '1.0.0' },
  outputSchema: { id: 'calendar.event-create.output', version: '1.0.0' },
  executorId: 'google-calendar.event-create.v1',
});
const authorizationScopeFingerprint =
  EffectiveAuthorizationScopeFingerprintSchema.parse('e'.repeat(64));
const authorityBinding = {
  kind: 'google-calendar-grant-v2',
  householdId: ids.household,
  privateSpaceId: ids.privateSpace,
  authorizationScopeFingerprint,
  providerGrantReference: 'google-grant-reference-1',
  authorizationEpoch: 1,
} as const;
const originSpaceAccessGrantId = ids.originSpaceGrant;
const providerAuthorityBindingHash = hashCanonicalJson(authorityBinding);
const approvalDisplay = {
  schemaVersion: 1,
  title: 'Create Google Calendar event',
  summary: 'Review the event details before creating it in Google Calendar.',
  beforeSummary: 'No event exists at the selected calendar target.',
  afterSummary: 'One event will be created with the approved details.',
  fields: [{ label: 'Title', value: 'Dentist' }],
} as const;
const invocationContext = {
  orchestrationRunId: ids.run,
  parentInvocationId: ids.parentInvocation,
  agentInvocationId: ids.agentInvocation,
  phaseInvocationId: ids.phaseInvocation,
  actorId: ids.user,
  locale: 'en-CA',
  grantedCapabilities: ['google-calendar.event.create'],
  disclosedContextRefs: [
    `context-ref-${hashCanonicalJson({
      dataClass: 'calendar.events',
      recordId: 'primary',
    })}`,
  ],
  deadline: '2026-08-09T16:10:00.000Z',
  idempotencyScope: '1'.repeat(64),
} as const;
const proposalInput = {
  schemaVersion: 1,
  id: ids.proposal,
  version: 1,
  runId: ids.run,
  capabilityId: 'google-calendar.event.create',
  capabilityFingerprint,
  authorizationScopeFingerprint,
  canonicalArguments: argumentsValue,
  targets: [
    { kind: 'google-calendar.event', id: 'primary', expectedVersion: 'v1' },
  ],
  beforePreview: null,
  afterPreview: argumentsValue,
  approvalDisplay,
  providerPreconditions: [
    { kind: 'calendar-version', targetId: 'primary', expectedValue: 'v1' },
  ],
  providerAuthorityBindingHash,
  providerSdkCallId: 'call-google-calendar-create-1',
  payloadHash,
  disclosureGrant: {
    schemaVersion: 1,
    id: ids.grant,
    version: 1,
    userId: ids.user,
    householdId: ids.household,
    agentId: 'scheduler',
    purpose: 'Create the approved appointment.',
    runId: ids.run,
    invocationContext,
    invocationContextHash: hashCanonicalJson(invocationContext),
    recordAllowlist: [
      { dataClass: 'calendar.events', recordId: 'primary', fields: ['title'] },
    ],
    provider: 'google-calendar',
    createdAt: '2026-08-09T16:00:00.000Z',
    expiresAt: '2026-08-09T16:10:00.000Z',
    oneRunOnly: true,
  },
  createdAt: '2026-08-09T16:00:00.000Z',
  expiresAt: '2026-08-09T16:10:00.000Z',
  idempotencyKey: 'proposal:calendar:018f1f5e',
  state: 'pending',
} as const;
const approvalHash = hashActionProposalApproval(proposalInput);
const proposal = ActionProposalSchema.parse({
  ...proposalInput,
  approvalHash,
});
const preparationBindingFor = (candidate: typeof proposal) =>
  ({
    proposalId: candidate.id,
    originRequestId: ids.request,
    runId: candidate.runId,
    householdId: candidate.disclosureGrant.householdId,
    userId: candidate.disclosureGrant.userId,
    originSessionId: ids.session,
    agentId: candidate.disclosureGrant.agentId,
    originSpaceAccessGrantId,
    disclosureGrantId: candidate.disclosureGrant.id,
    disclosurePolicyVersion: '1.0.0',
    capabilityId: candidate.capabilityId,
    sdkCallId: candidate.providerSdkCallId,
    providerAuthorityBindingHash: candidate.providerAuthorityBindingHash,
  }) as const;
const preparationBinding = preparationBindingFor(proposal);
const operationScopeFor = (
  phase: ProposalOperationScopeAssertion['phase'],
  activeAt: string,
  requireActiveDisclosureGrant = true,
): ProposalOperationScopeAssertion => {
  const base = {
    runId: proposal.runId,
    householdId: proposal.disclosureGrant.householdId,
    userId: proposal.disclosureGrant.userId,
    authorizationScopeFingerprint: proposal.authorizationScopeFingerprint,
    disclosureGrantId: proposal.disclosureGrant.id,
    disclosureGrantVersion: proposal.disclosureGrant.version,
    disclosureGrantHash: hashCanonicalJson(proposal.disclosureGrant),
    proposalId: proposal.id,
    providerSdkCallId: proposal.providerSdkCallId,
    activeAt,
  } as const;
  if (phase === 'proposal-create') {
    return {
      ...base,
      phase,
      currentRequestId: preparationBinding.originRequestId,
      currentSpaceAccessGrantId: preparationBinding.originSpaceAccessGrantId,
      currentSessionId: preparationBinding.originSessionId,
      requireActiveDisclosureGrant: true,
    };
  }
  return {
    ...base,
    phase,
    currentRequestId: ids.currentRequest,
    currentSpaceAccessGrantId: ids.currentSpaceGrant,
    currentSessionId: ids.session,
    requireActiveDisclosureGrant,
  };
};
const providerOperationScope = {
  requestId: ids.currentRequest,
  sessionId: ids.session,
  householdId: ids.household,
  userId: ids.user,
  spaceAccessGrantId: ids.currentSpaceGrant,
  authorizationScopeFingerprint: proposal.authorizationScopeFingerprint,
} as const;
const createdAt = new Date('2026-08-09T16:00:00.000Z');
const decisionRequest = {
  schemaVersion: 1,
  proposalId: ids.proposal,
  payloadHash,
  approvalHash,
  decision: 'approved',
  idempotencyKey: 'decision:calendar:018f1f5e',
} as const;
const decisionContext = {
  decisionId: ids.decision,
  operationScope: providerOperationScope,
  channel: 'authenticated-visual',
  now: new Date('2026-08-09T16:01:00.000Z'),
} as const;
const materializer = {
  materialize: async (input: { canonicalArguments: unknown }) => ({
    targets: proposalInput.targets,
    beforePreview: null,
    afterPreview: input.canonicalArguments as typeof argumentsValue,
    approvalDisplay,
    providerPreconditions: proposalInput.providerPreconditions,
    providerAuthorityBindingHash,
  }),
};
const disclosureGrantResolver = {
  resolve: async (grantId: string) => {
    if (grantId === ids.grant) return proposalInput.disclosureGrant;
    if (grantId === ids.otherGrant) {
      return {
        ...proposalInput.disclosureGrant,
        id: ids.otherGrant,
        userId: ids.otherUser,
        householdId: ids.otherHousehold,
        runId: ids.otherRun,
      } as const;
    }
    return undefined;
  },
};

class ClockAdvancingProposalRepository extends InMemoryProposalRepository {
  private transactionsBeforeAdvance: number | undefined;

  constructor(private readonly advanceClock: () => void) {
    super();
  }

  advanceBeforeTransactionAfter(completedTransactions: number): void {
    this.transactionsBeforeAdvance = completedTransactions;
  }

  override async transaction<Result>(
    work: (transaction: ProposalRepositoryTransaction) => Promise<Result>,
  ): Promise<Result> {
    if (this.transactionsBeforeAdvance !== undefined) {
      if (this.transactionsBeforeAdvance === 0) {
        this.transactionsBeforeAdvance = undefined;
        this.advanceClock();
      } else {
        this.transactionsBeforeAdvance -= 1;
      }
    }
    return super.transaction(work);
  }
}

class CountingDecisionCommitRepository extends InMemoryProposalRepository {
  decisionCommitCount = 0;

  override async transaction<Result>(
    work: (transaction: ProposalRepositoryTransaction) => Promise<Result>,
  ): Promise<Result> {
    return super.transaction((transaction) =>
      work(
        Object.freeze({
          ...transaction,
          commitDecision: async (
            input: Parameters<
              ProposalRepositoryTransaction['commitDecision']
            >[0],
          ) => {
            this.decisionCommitCount += 1;
            return transaction.commitDecision(input);
          },
        }),
      ),
    );
  }
}

class DuplicateDecisionCommitRepository extends CountingDecisionCommitRepository {
  private reportDuplicateOnce = true;

  override async transaction<Result>(
    work: (transaction: ProposalRepositoryTransaction) => Promise<Result>,
  ): Promise<Result> {
    return super.transaction((transaction) =>
      work(
        Object.freeze({
          ...transaction,
          commitDecision: async (
            input: Parameters<
              ProposalRepositoryTransaction['commitDecision']
            >[0],
          ) => {
            const result = await transaction.commitDecision(input);
            if (this.reportDuplicateOnce && result === 'created') {
              this.reportDuplicateOnce = false;
              return 'duplicate';
            }
            return result;
          },
        }),
      ),
    );
  }
}

class ConflictAfterPersistedDecisionRepository extends CountingDecisionCommitRepository {
  private reportConflictOnce = true;

  override async transaction<Result>(
    work: (transaction: ProposalRepositoryTransaction) => Promise<Result>,
  ): Promise<Result> {
    return super.transaction((transaction) =>
      work(
        Object.freeze({
          ...transaction,
          commitDecision: async (
            input: Parameters<
              ProposalRepositoryTransaction['commitDecision']
            >[0],
          ) => {
            const result = await transaction.commitDecision(input);
            if (this.reportConflictOnce && result === 'created') {
              this.reportConflictOnce = false;
              return 'conflict';
            }
            return result;
          },
        }),
      ),
    );
  }
}

class ConcurrentDecisionReadBarrierRepository extends CountingDecisionCommitRepository {
  private absentDecisionReads = 0;
  private readonly bothAbsentReadsObserved: Promise<void>;
  private releaseAbsentReads!: () => void;

  constructor() {
    super();
    this.bothAbsentReadsObserved = new Promise<void>((resolve) => {
      this.releaseAbsentReads = resolve;
    });
  }

  override async transaction<Result>(
    work: (transaction: ProposalRepositoryTransaction) => Promise<Result>,
  ): Promise<Result> {
    let observedAbsentDecision = false;
    const result = await super.transaction((transaction) =>
      work(
        Object.freeze({
          ...transaction,
          findDecisionByIdempotencyKey: async (
            lookup: Parameters<
              ProposalRepositoryTransaction['findDecisionByIdempotencyKey']
            >[0],
          ) => {
            const stored =
              await transaction.findDecisionByIdempotencyKey(lookup);
            if (stored === undefined) observedAbsentDecision = true;
            return stored;
          },
        }),
      ),
    );
    if (observedAbsentDecision && this.absentDecisionReads < 2) {
      this.absentDecisionReads += 1;
      if (this.absentDecisionReads === 2) this.releaseAbsentReads();
      await this.bothAbsentReadsObserved;
    }
    return result;
  }
}

describe('ProposalService', () => {
  it('provides the exact approval lifecycle and abandonment operations without a materializer', async () => {
    const now = () => new Date('2026-08-09T16:02:00.000Z');
    const repository = new InMemoryProposalRepository();
    const creator = new ProposalService(
      materializer,
      disclosureGrantResolver,
      repository,
      now,
    );
    await creator.create(proposal, preparationBinding);
    const decision = await creator.decide(decisionRequest, decisionContext);
    const lifecycle = createProposalLifecycleService({
      repository,
      disclosureGrantResolver,
      now,
    });
    const binding = {
      decisionId: decision.id,
      userId: ids.user,
      agentId: 'scheduler' as const,
      runId: ids.run,
      capabilityId: proposal.capabilityId,
      capabilityFingerprint,
      disclosureGrantId: ids.grant,
      payloadHash,
      idempotencyTtlMs: 86_400_000,
      authorityBinding,
    };

    const acquisition = await lifecycle.approvalStore.acquire(
      binding,
      providerOperationScope,
    );
    expect(acquisition).toMatchObject({ status: 'authorized' });
    if (acquisition.status !== 'authorized') throw new Error('expected permit');
    await expect(
      lifecycle.approvalStore.markDispatching(
        binding,
        acquisition.authorization.attemptId,
        providerOperationScope,
      ),
    ).resolves.toMatchObject({ status: 'dispatch-authorized' });
    await expect(
      lifecycle.approvalStore.finalize(binding, {
        state: 'executed',
        application: 'applied',
        outputStatus: 'valid',
        resultHash: 'c'.repeat(64),
      }),
    ).resolves.toBe('finalized');

    const abandonmentRepository = new InMemoryProposalRepository();
    const abandonmentCreator = new ProposalService(
      materializer,
      disclosureGrantResolver,
      abandonmentRepository,
      now,
    );
    await abandonmentCreator.create(proposal, preparationBinding);
    const abandonmentLifecycle = createProposalLifecycleService({
      repository: abandonmentRepository,
      disclosureGrantResolver,
      now,
    });
    const abandonment = {
      ...preparationBinding,
      reason: 'multiple-provider-writes-require-separate-turns' as const,
      now: now(),
    };
    await expect(
      abandonmentLifecycle.abandonPrepared(abandonment),
    ).resolves.toEqual({ status: 'abandoned' });
    await expect(
      abandonmentLifecycle.abandonPrepared(abandonment),
    ).resolves.toEqual({ status: 'already-abandoned' });
  });

  it('exposes asynchronous repository-backed reads', async () => {
    const service = new ProposalService(
      materializer,
      disclosureGrantResolver,
      new InMemoryProposalRepository(),
      () => new Date('2026-08-09T16:02:00.000Z'),
    );
    await service.create(proposal, preparationBinding);

    expect(service.getProposal(ids.proposal)).toBeInstanceOf(Promise);
    await expect(service.getProposal(ids.proposal)).resolves.toEqual(proposal);
    expect(service.listEvents()).toBeInstanceOf(Promise);
    await expect(service.listEvents()).resolves.toHaveLength(1);
  });

  it('rolls back failed repository transactions and closes escaped handles', async () => {
    const repository = new InMemoryProposalRepository();
    let escapedTransaction: ProposalRepositoryTransaction | undefined;

    await expect(
      repository.transaction(async (transaction) => {
        escapedTransaction = transaction;
        await expect(
          transaction.insertProposal({
            proposal,
            preparation: {
              binding: preparationBinding,
              bindingHash: hashCanonicalJson({
                domain: 'emdo.provider-proposal-preparation.v1',
                binding: preparationBinding,
              }),
            },
            scope: operationScopeFor('proposal-create', proposal.createdAt),
            event: {
              proposalId: proposal.id,
              eventType: 'proposal.created',
              occurredAt: proposal.createdAt,
            },
          }),
        ).resolves.toBe('created');
        throw new Error('injected aggregate failure');
      }),
    ).rejects.toThrow('injected aggregate failure');

    await expect(repository.getProposal(proposal.id)).resolves.toBeUndefined();
    await expect(repository.listEvents()).resolves.toEqual([]);
    await expect(escapedTransaction?.getProposal(proposal.id)).rejects.toThrow(
      'Proposal transaction is closed',
    );
  });

  it('distinguishes exact repository decision replays from changed material', async () => {
    const repository = new InMemoryProposalRepository();
    const service = new ProposalService(
      materializer,
      disclosureGrantResolver,
      repository,
      () => new Date('2026-08-09T16:02:00.000Z'),
    );
    await service.create(proposal, preparationBinding);
    const decision = await service.decide(decisionRequest, decisionContext);
    const approvedProposal = await repository.getProposal(proposal.id);
    if (approvedProposal === undefined) throw new Error('expected proposal');
    const exactInput = {
      expected: {
        proposalId: proposal.id,
        version: proposal.version,
        state: proposal.state,
        approvalHash: proposal.approvalHash,
      },
      next: approvedProposal,
      decision,
      scope: operationScopeFor('visual-decision', decision.decidedAt),
      event: {
        proposalId: proposal.id,
        eventType: 'proposal.approved' as const,
        occurredAt: decision.decidedAt,
        decisionId: decision.id,
        actorUserId: decision.userId,
        authenticatedSessionId: decision.authenticatedSessionId,
        approvalHash: decision.approvalHash,
        decisionIdempotencyKey: decision.idempotencyKey,
      },
    };
    await expect(
      repository.transaction((transaction) =>
        transaction.commitDecision(exactInput),
      ),
    ).resolves.toBe('duplicate');

    const changedDecision = ActionDecisionSchema.parse({
      ...decision,
      authenticatedSessionId: ids.otherRun,
    });
    await expect(
      repository.transaction((transaction) =>
        transaction.commitDecision({
          ...exactInput,
          decision: changedDecision,
        }),
      ),
    ).resolves.toBe('conflict');
  });

  it('returns the persisted decision on an exact second visual-decision request without another commit', async () => {
    const repository = new CountingDecisionCommitRepository();
    const service = new ProposalService(
      materializer,
      disclosureGrantResolver,
      repository,
      () => new Date('2026-08-09T16:02:00.000Z'),
    );
    await service.create(proposal, preparationBinding);

    const first = await service.decide(decisionRequest, decisionContext);
    const replay = await service.decide(decisionRequest, {
      ...decisionContext,
      decisionId: ids.otherProposal,
      now: new Date('2026-08-09T16:02:30.000Z'),
    });

    expect(replay).toEqual(first);
    expect(repository.decisionCommitCount).toBe(1);
    expect((await repository.getProposal(proposal.id))?.state).toBe('approved');
  });

  it('converges overlapping exact visual-decision requests on one persisted decision', async () => {
    const repository = new ConcurrentDecisionReadBarrierRepository();
    const service = new ProposalService(
      materializer,
      disclosureGrantResolver,
      repository,
      () => new Date('2026-08-09T16:02:00.000Z'),
    );
    await service.create(proposal, preparationBinding);

    const [first, second] = await Promise.all([
      service.decide(decisionRequest, decisionContext),
      service.decide(decisionRequest, {
        ...decisionContext,
        decisionId: ids.otherProposal,
        now: new Date('2026-08-09T16:01:30.000Z'),
      }),
    ]);

    expect(second).toEqual(first);
    expect(repository.decisionCommitCount).toBe(1);
    expect((await repository.getProposal(proposal.id))?.state).toBe('approved');
    expect(
      (await repository.listEvents()).filter(
        ({ eventType }) => eventType === 'proposal.approved',
      ),
    ).toHaveLength(1);
  });

  it('keeps a conflicting overlapping visual decision fail-closed', async () => {
    const repository = new ConcurrentDecisionReadBarrierRepository();
    const service = new ProposalService(
      materializer,
      disclosureGrantResolver,
      repository,
      () => new Date('2026-08-09T16:02:00.000Z'),
    );
    await service.create(proposal, preparationBinding);

    const [approved, rejected] = await Promise.allSettled([
      service.decide(decisionRequest, decisionContext),
      service.decide(
        { ...decisionRequest, decision: 'rejected' },
        {
          ...decisionContext,
          decisionId: ids.otherProposal,
          now: new Date('2026-08-09T16:01:30.000Z'),
        },
      ),
    ]);

    expect(approved.status).toBe('fulfilled');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { code: 'proposal-decision-conflict' },
    });
    expect(repository.decisionCommitCount).toBe(1);
    expect((await repository.getProposal(proposal.id))?.state).toBe('approved');
  });

  it('recovers the persisted decision when the commit transaction reports an exact duplicate', async () => {
    const repository = new DuplicateDecisionCommitRepository();
    const service = new ProposalService(
      materializer,
      disclosureGrantResolver,
      repository,
      () => new Date('2026-08-09T16:02:00.000Z'),
    );
    await service.create(proposal, preparationBinding);

    const decision = await service.decide(decisionRequest, decisionContext);

    expect(decision).toMatchObject({
      id: ids.decision,
      proposalId: proposal.id,
      decision: 'approved',
    });
    expect(repository.decisionCommitCount).toBe(1);
    expect((await repository.getProposal(proposal.id))?.state).toBe('approved');
  });

  it('recovers an exact persisted decision after the commit path reports a concurrency conflict', async () => {
    const repository = new ConflictAfterPersistedDecisionRepository();
    const service = new ProposalService(
      materializer,
      disclosureGrantResolver,
      repository,
      () => new Date('2026-08-09T16:02:00.000Z'),
    );
    await service.create(proposal, preparationBinding);

    const decision = await service.decide(decisionRequest, decisionContext);

    expect(decision).toMatchObject({
      id: ids.decision,
      proposalId: proposal.id,
      decision: 'approved',
    });
    expect(repository.decisionCommitCount).toBe(1);
    expect((await repository.getProposal(proposal.id))?.state).toBe('approved');
  });

  it('rejects direct repository abandonment after visual approval', async () => {
    const repository = new InMemoryProposalRepository();
    const service = new ProposalService(
      materializer,
      disclosureGrantResolver,
      repository,
      () => new Date('2026-08-09T16:02:00.000Z'),
    );
    await service.create(proposal, preparationBinding);
    await service.decide(decisionRequest, decisionContext);

    await expect(
      repository.transaction(async (transaction) => {
        const approved = await transaction.getProposal(proposal.id);
        const preparation = await transaction.getProposalPreparation(
          proposal.id,
        );
        if (approved === undefined || preparation === undefined) {
          throw new Error('expected approved prepared proposal');
        }
        const abandonedAt = '2026-08-09T16:02:00.000Z';
        const next = ActionProposalSchema.parse({
          ...approved,
          state: 'not-applied',
          version: approved.version + 1,
        });
        return transaction.abandonPrepared({
          expected: {
            proposalId: approved.id,
            version: approved.version,
            state: approved.state,
            approvalHash: approved.approvalHash,
          },
          next,
          preparation: {
            ...preparation,
            abandonment: {
              reason: 'execution-ended-before-checkpoint',
              abandonedAt,
            },
          },
          event: {
            proposalId: approved.id,
            eventType: 'proposal.not-applied',
            occurredAt: abandonedAt,
            application: 'not-applied',
            outcomeReason: 'execution-ended-before-checkpoint',
          },
        });
      }),
    ).resolves.toBe('conflict');
    await expect(service.getProposal(proposal.id)).resolves.toMatchObject({
      state: 'approved',
    });
  });

  it('does not let rows escape transaction isolation by reference', async () => {
    const repository = new InMemoryProposalRepository();
    const service = new ProposalService(
      materializer,
      disclosureGrantResolver,
      repository,
      () => new Date('2026-08-09T16:02:00.000Z'),
    );
    await service.create(proposal, preparationBinding);
    const decision = await service.decide(decisionRequest, decisionContext);
    const binding = {
      decisionId: decision.id,
      userId: ids.user,
      agentId: 'scheduler',
      runId: ids.run,
      capabilityId: proposal.capabilityId,
      capabilityFingerprint,
      disclosureGrantId: ids.grant,
      payloadHash,
      idempotencyTtlMs: 86_400_000,
      authorityBinding,
    } as const;
    const acquisition = await service.approvalStore.acquire(
      binding,
      providerOperationScope,
    );
    expect(acquisition).toMatchObject({ status: 'authorized' });

    let escapedDecision: StoredDecision | undefined;
    let escapedAttempt: StoredProviderWriteAttempt | undefined;
    await repository.transaction(async (transaction) => {
      escapedDecision = await transaction.getDecision(decision.id);
      escapedAttempt = await transaction.getProviderWriteAttempt(decision.id);
    });
    expect(Object.isFrozen(escapedDecision)).toBe(true);
    expect(Object.isFrozen(escapedAttempt)).toBe(true);
    expect(
      Reflect.set(escapedDecision ?? {}, 'proposalId', ids.otherProposal),
    ).toBe(false);
    expect(Reflect.set(escapedAttempt ?? {}, 'attemptState', 'executed')).toBe(
      false,
    );
    await expect(service.getProposal(proposal.id)).resolves.toMatchObject({
      state: 'prepared',
    });
  });

  it('fails closed instead of throwing for malformed provider approval bindings', async () => {
    const service = new ProposalService(
      materializer,
      disclosureGrantResolver,
      new InMemoryProposalRepository(),
      () => new Date('2026-08-09T16:02:00.000Z'),
    );
    await service.create(proposal, preparationBinding);
    const decision = await service.decide(decisionRequest, decisionContext);
    const malformedBinding = {
      decisionId: decision.id,
      userId: ids.user,
      agentId: 'scheduler',
      runId: ids.run,
      capabilityId: proposal.capabilityId,
      capabilityFingerprint,
      disclosureGrantId: ids.grant,
      payloadHash,
      idempotencyTtlMs: 86_400_000,
      authorityBinding: undefined,
    } as unknown as Parameters<typeof service.approvalStore.acquire>[0];

    await expect(
      service.approvalStore.acquire(malformedBinding, providerOperationScope),
    ).resolves.toEqual({ status: 'mismatch' });
    await expect(
      service.approvalStore.markDispatching(
        malformedBinding,
        ids.request,
        providerOperationScope,
      ),
    ).resolves.toEqual({ status: 'mismatch' });
    await expect(
      service.approvalStore.finalize(malformedBinding, {
        state: 'not-applied',
        application: 'not-applied',
        reason: 'provider-rejected-before-apply',
      }),
    ).resolves.toBe('mismatch');
    await expect(
      service.approvalStore.reconcile(malformedBinding, {
        state: 'executed',
        application: 'applied',
        outputStatus: 'valid',
        resultHash: 'f'.repeat(64),
      }),
    ).resolves.toBe('mismatch');
  });

  it('idempotently abandons only the exact undispatched SDK-call proposal', async () => {
    const service = new ProposalService(
      materializer,
      disclosureGrantResolver,
      new InMemoryProposalRepository(),
      () => new Date('2026-08-09T16:02:00.000Z'),
    );
    await service.create(proposal, preparationBinding);
    const abandonment = {
      proposalId: ids.proposal,
      originRequestId: ids.request,
      capabilityId: proposal.capabilityId,
      sdkCallId: 'call-google-calendar-create-1',
      runId: ids.run,
      userId: ids.user,
      householdId: ids.household,
      originSessionId: ids.session,
      agentId: 'scheduler',
      originSpaceAccessGrantId,
      disclosureGrantId: ids.grant,
      disclosurePolicyVersion: '1.0.0',
      providerAuthorityBindingHash,
      reason: 'multiple-provider-writes-require-separate-turns',
      now: new Date('2026-08-09T16:02:00.000Z'),
    } as const;

    await expect(
      service.abandonPrepared({
        ...abandonment,
        sdkCallId: 'different-provider-sdk-call',
      }),
    ).resolves.toEqual({ status: 'not-abandonable' });
    await expect(
      service.abandonPrepared({
        ...abandonment,
        reason: 'caller-controlled-terminal-reason',
      } as never),
    ).resolves.toEqual({ status: 'not-abandonable' });
    await expect(
      service.abandonPrepared({
        ...abandonment,
        now: '2026-08-09T16:02:00.000Z',
      } as never),
    ).resolves.toEqual({ status: 'not-abandonable' });
    await expect(service.getProposal(ids.proposal)).resolves.toMatchObject({
      state: 'pending',
    });
    await expect(service.listEvents()).resolves.toHaveLength(1);

    await expect(service.abandonPrepared(abandonment)).resolves.toEqual({
      status: 'abandoned',
    });
    await expect(service.abandonPrepared(abandonment)).resolves.toEqual({
      status: 'already-abandoned',
    });
    await expect(service.getProposal(ids.proposal)).resolves.toMatchObject({
      state: 'not-applied',
    });
    await expect(service.listEvents()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'proposal.not-applied',
          outcomeReason: 'multiple-provider-writes-require-separate-turns',
        }),
      ]),
    );
    await expect(
      service.create(proposal, preparationBinding),
    ).resolves.toMatchObject({ state: 'not-applied' });
  });

  it('includes the trusted provider-authority hash in immutable approval material', () => {
    const originalAuthorityHash = hashCanonicalJson({
      kind: 'google-calendar-grant-v2',
      householdId: ids.household,
      privateSpaceId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f013',
      authorizationScopeFingerprint: 'e'.repeat(64),
      providerGrantReference: 'google-grant-reference-1',
      authorizationEpoch: 1,
    });
    const reconnectedAuthorityHash = hashCanonicalJson({
      kind: 'google-calendar-grant-v2',
      householdId: ids.household,
      privateSpaceId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f013',
      authorizationScopeFingerprint: 'e'.repeat(64),
      providerGrantReference: 'google-grant-reference-2',
      authorizationEpoch: 2,
    });
    const original = {
      ...proposalInput,
      providerAuthorityBindingHash: originalAuthorityHash,
    } as const;
    const reconnected = {
      ...proposalInput,
      providerAuthorityBindingHash: reconnectedAuthorityHash,
    } as const;

    expect(
      ActionProposalSchema.parse({
        ...original,
        approvalHash: hashActionProposalApproval(original),
      }).providerAuthorityBindingHash,
    ).toBe(originalAuthorityHash);
    expect(hashActionProposalApproval(reconnected)).not.toBe(
      hashActionProposalApproval(original),
    );
  });

  it('includes the capability-owned approval display in immutable approval material', () => {
    const changedDisplay = {
      ...proposalInput,
      approvalDisplay: {
        ...proposalInput.approvalDisplay,
        summary: 'A different visible approval summary.',
      },
    } as const;

    expect(hashActionProposalApproval(changedDisplay)).not.toBe(
      hashActionProposalApproval(proposalInput),
    );
  });

  it('includes the effective authorization scope in immutable approval material', () => {
    const changedScope = {
      ...proposalInput,
      authorizationScopeFingerprint:
        EffectiveAuthorizationScopeFingerprintSchema.parse('f'.repeat(64)),
    } as const;

    expect(hashActionProposalApproval(changedScope)).not.toBe(
      hashActionProposalApproval(proposalInput),
    );
  });

  it('includes guarded local-action and target bindings in immutable approval material', () => {
    const guarded = {
      ...proposalInput,
      guardedAction: {
        capabilityVersion: '1.0.0',
        operation: 'finance-document-review-commit',
        actionHash: proposalInput.payloadHash,
        executionBindingHash: proposalInput.providerAuthorityBindingHash,
        targetBindingHash: '8'.repeat(64),
      },
    } as const;
    const changedTarget = {
      ...guarded,
      guardedAction: {
        ...guarded.guardedAction,
        targetBindingHash: '7'.repeat(64),
      },
    } as const;

    expect(hashActionProposalApproval(guarded)).not.toBe(
      hashActionProposalApproval(proposalInput),
    );
    expect(hashActionProposalApproval(changedTarget)).not.toBe(
      hashActionProposalApproval(guarded),
    );
  });

  it('creates, visually approves, binds preconditions, and reaches one terminal state', async () => {
    const service = new ProposalService(
      materializer,
      disclosureGrantResolver,
      new InMemoryProposalRepository(),
      () => new Date('2026-08-09T16:02:00.000Z'),
    );
    await service.create(proposal, preparationBinding);
    const decision = await service.decide(decisionRequest, decisionContext);
    const binding = {
      decisionId: decision.id,
      userId: ids.user,
      agentId: 'scheduler',
      runId: ids.run,
      capabilityId: 'google-calendar.event.create',
      capabilityFingerprint,
      disclosureGrantId: ids.grant,
      payloadHash,
      idempotencyTtlMs: 86_400_000,
      authorityBinding,
    };

    await expect(
      service.approvalStore.acquire(
        {
          ...binding,
          authorityBinding: {
            ...authorityBinding,
            providerGrantReference: 'google-grant-reference-2',
            authorizationEpoch: 2,
          },
        },
        providerOperationScope,
      ),
    ).resolves.toEqual({ status: 'mismatch' });

    const acquisition = await service.approvalStore.acquire(
      binding,
      providerOperationScope,
    );
    expect(acquisition).toMatchObject({
      status: 'authorized',
      authorization: {
        approvalHash,
        approvalBinding: binding,
        targets: [{ expectedVersion: 'v1' }],
        providerPreconditions: [{ expectedValue: 'v1' }],
      },
    });
    if (acquisition.status !== 'authorized') throw new Error('expected permit');
    await expect(
      service.approvalStore.markDispatching(
        binding,
        acquisition.authorization.attemptId,
        providerOperationScope,
      ),
    ).resolves.toMatchObject({ status: 'dispatch-authorized' });
    await expect(
      service.approvalStore.finalize(binding, {
        state: 'pending',
      } as never),
    ).resolves.toBe('mismatch');
    expect((await service.getProposal(ids.proposal))?.state).toBe('executing');
    await expect(
      service.approvalStore.finalize(
        { ...binding, capabilityId: 'google-calendar.event.update' },
        {
          state: 'not-applied',
          application: 'not-applied',
          reason: 'provider-rejected-before-apply',
        },
      ),
    ).resolves.toBe('mismatch');
    await expect(
      service.approvalStore.finalize(binding, {
        state: 'executed',
        application: 'applied',
        outputStatus: 'valid',
      } as never),
    ).resolves.toBe('mismatch');
    await expect(
      service.approvalStore.finalize(binding, {
        state: 'executed',
        application: 'applied',
        outputStatus: 'valid',
        resultHash: 'c'.repeat(64),
      }),
    ).resolves.toBe('finalized');
    expect((await service.getProposal(ids.proposal))?.state).toBe('executed');
    expect(await service.listEvents()).toContainEqual(
      expect.objectContaining({
        eventType: 'proposal.approved',
        decisionId: ids.decision,
        actorUserId: ids.user,
        authenticatedSessionId: ids.session,
        approvalHash,
        decisionIdempotencyKey: decisionRequest.idempotencyKey,
      }),
    );
    await expect(
      service.approvalStore.acquire(binding, providerOperationScope),
    ).resolves.toMatchObject({
      status: 'existing-attempt',
      attemptState: 'executed',
      completion: { state: 'executed', application: 'applied' },
    });
  });

  it('rejects payload, preview, idempotency, and future-time tampering', async () => {
    const service = new ProposalService(
      materializer,
      disclosureGrantResolver,
      new InMemoryProposalRepository(),
      () => new Date(createdAt),
    );
    await expect(
      service.create(
        { ...proposal, payloadHash: 'a'.repeat(64) },
        preparationBinding,
      ),
    ).rejects.toMatchObject({ code: 'proposal-hash-mismatch' });
    await expect(
      service.create({ ...proposal, version: 2 }, preparationBinding),
    ).rejects.toMatchObject({ code: 'proposal-state-transition-invalid' });
    const previewTamper = {
      ...proposal,
      id: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f098',
      idempotencyKey: 'proposal:calendar:preview-tamper',
      afterPreview: { title: 'Harmless reminder' },
    } as const;
    await expect(
      service.create(
        previewTamper,
        preparationBindingFor(previewTamper as typeof proposal),
      ),
    ).rejects.toMatchObject({ code: 'proposal-approval-hash-mismatch' });

    const deceptiveInput = {
      ...proposalInput,
      id: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f097',
      canonicalArguments: {
        calendarId: 'primary',
        operation: 'delete-all-events',
      },
      afterPreview: { title: 'Harmless reminder' },
      payloadHash: hashCanonicalJson({
        calendarId: 'primary',
        operation: 'delete-all-events',
      }),
      idempotencyKey: 'proposal:calendar:deceptive-preview',
    } as const;
    const deceptiveProposal = ActionProposalSchema.parse({
      ...deceptiveInput,
      approvalHash: hashActionProposalApproval(deceptiveInput),
    });
    await expect(
      service.create(
        deceptiveProposal,
        preparationBindingFor(deceptiveProposal as typeof proposal),
      ),
    ).rejects.toMatchObject({ code: 'proposal-materialization-mismatch' });

    await service.create(proposal, preparationBinding);
    const changedProposal = {
      ...proposal,
      id: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f099',
    } as const;
    const changedPersistedProposal = ActionProposalSchema.parse({
      ...changedProposal,
      approvalHash: hashActionProposalApproval(changedProposal),
    });
    await expect(
      service.create(
        changedPersistedProposal,
        preparationBindingFor(changedPersistedProposal as typeof proposal),
      ),
    ).rejects.toMatchObject({ code: 'proposal-idempotency-conflict' });

    const futureService = new ProposalService(
      materializer,
      disclosureGrantResolver,
      new InMemoryProposalRepository(),
      () => new Date('2026-08-09T15:59:59.999Z'),
    );
    await expect(
      futureService.create(proposal, preparationBinding),
    ).rejects.toMatchObject({
      code: 'proposal-timestamp-invalid',
    });
  });

  it('derives visual identity server-side and expires decisions and consumes', async () => {
    const service = new ProposalService(
      materializer,
      disclosureGrantResolver,
      new InMemoryProposalRepository(),
      () => new Date('2026-08-09T16:00:30.000Z'),
    );
    await service.create(proposal, preparationBinding);
    await expect(
      service.decide(decisionRequest, {
        ...decisionContext,
        now: new Date('2026-08-09T15:59:59.999Z'),
      }),
    ).rejects.toMatchObject({ code: 'proposal-timestamp-invalid' });
    await expect(
      service.decide(decisionRequest, {
        ...decisionContext,
        operationScope: {
          ...providerOperationScope,
          userId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f099',
        },
      }),
    ).rejects.toMatchObject({ code: 'proposal-user-mismatch' });
    const decision = await service.decide(decisionRequest, decisionContext);
    await expect(
      service.approvalStore.acquire(
        {
          decisionId: decision.id,
          userId: ids.user,
          agentId: 'scheduler',
          runId: ids.run,
          capabilityId: 'google-calendar.event.create',
          capabilityFingerprint,
          disclosureGrantId: ids.grant,
          payloadHash,
          idempotencyTtlMs: 86_400_000,
          authorityBinding,
        },
        providerOperationScope,
      ),
    ).resolves.toEqual({ status: 'mismatch' });

    const expiringService = new ProposalService(
      materializer,
      disclosureGrantResolver,
      new InMemoryProposalRepository(),
      () => new Date(createdAt),
    );
    await expiringService.create(proposal, preparationBinding);
    await expect(
      expiringService.decide(decisionRequest, {
        ...decisionContext,
        now: new Date('2026-08-09T16:10:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'proposal-expired' });
    expect((await expiringService.getProposal(ids.proposal))?.state).toBe(
      'expired',
    );

    let consumeNow = new Date(createdAt);
    const consumeExpiryService = new ProposalService(
      materializer,
      disclosureGrantResolver,
      new InMemoryProposalRepository(),
      () => new Date(consumeNow),
    );
    await consumeExpiryService.create(proposal, preparationBinding);
    const expiringDecision = await consumeExpiryService.decide(
      decisionRequest,
      decisionContext,
    );
    consumeNow = new Date('2026-08-09T16:10:00.000Z');
    await expect(
      consumeExpiryService.approvalStore.acquire(
        {
          decisionId: expiringDecision.id,
          userId: ids.user,
          agentId: 'scheduler',
          runId: ids.run,
          capabilityId: 'google-calendar.event.create',
          capabilityFingerprint,
          disclosureGrantId: ids.grant,
          payloadHash,
          idempotencyTtlMs: 86_400_000,
          authorityBinding,
        },
        providerOperationScope,
      ),
    ).resolves.toEqual({ status: 'expired' });
    expect((await consumeExpiryService.getProposal(ids.proposal))?.state).toBe(
      'expired',
    );
  });

  it('scopes proposal idempotency keys by tenant and principal', async () => {
    const service = new ProposalService(
      materializer,
      disclosureGrantResolver,
      new InMemoryProposalRepository(),
      () => new Date(createdAt),
    );
    await service.create(proposal, preparationBinding);
    const otherInput = {
      ...proposalInput,
      id: ids.otherProposal,
      runId: ids.otherRun,
      disclosureGrant: {
        ...proposalInput.disclosureGrant,
        id: ids.otherGrant,
        userId: ids.otherUser,
        householdId: ids.otherHousehold,
        runId: ids.otherRun,
      },
    } as const;
    const otherProposal = ActionProposalSchema.parse({
      ...otherInput,
      approvalHash: hashActionProposalApproval(otherInput),
    });

    await expect(
      service.create(
        otherProposal,
        preparationBindingFor(otherProposal as typeof proposal),
      ),
    ).resolves.toMatchObject({ id: ids.otherProposal });
  });

  it('audits and reconciles an indeterminate provider attempt without redispatch', async () => {
    let serviceNow = new Date('2026-08-09T16:02:00.000Z');
    const repository = new InMemoryProposalRepository();
    const service = new ProposalService(
      materializer,
      disclosureGrantResolver,
      repository,
      () => new Date(serviceNow),
    );
    const reconciliationService = createProviderWriteReconciliationService(
      repository,
      () => new Date(serviceNow),
    );
    await service.create(proposal, preparationBinding);
    const decision = await service.decide(decisionRequest, decisionContext);
    const binding = {
      decisionId: decision.id,
      userId: ids.user,
      agentId: 'scheduler',
      runId: ids.run,
      capabilityId: proposal.capabilityId,
      capabilityFingerprint,
      disclosureGrantId: ids.grant,
      payloadHash,
      idempotencyTtlMs: 86_400_000,
      authorityBinding,
    };
    const acquisition = await service.approvalStore.acquire(
      binding,
      providerOperationScope,
    );
    expect(acquisition).toMatchObject({ status: 'authorized' });
    if (acquisition.status !== 'authorized') throw new Error('expected permit');
    await service.approvalStore.markDispatching(
      binding,
      acquisition.authorization.attemptId,
      providerOperationScope,
    );
    await expect(
      service.approvalStore.finalize(binding, {
        state: 'indeterminate',
        application: 'indeterminate',
        reason: 'timeout-after-dispatch',
        reconciliationRequired: true,
      }),
    ).resolves.toBe('finalized');
    expect((await service.getProposal(ids.proposal))?.state).toBe(
      'indeterminate',
    );

    serviceNow = new Date('2026-08-09T16:03:00.000Z');
    const reconciled = {
      state: 'executed' as const,
      application: 'applied' as const,
      outputStatus: 'valid' as const,
      resultHash: 'e'.repeat(64),
    };
    await expect(
      reconciliationService.reconcile(binding, reconciled),
    ).resolves.toBe('finalized');
    await expect(
      reconciliationService.reconcile(binding, reconciled),
    ).resolves.toBe('already-finalized');
    expect((await service.getProposal(ids.proposal))?.state).toBe('executed');
    expect(await service.listEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'proposal.indeterminate',
          outcomeReason: 'timeout-after-dispatch',
          reconciliationRequired: true,
        }),
        expect.objectContaining({
          eventType: 'proposal.executed',
          application: 'applied',
          providerIdempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ]),
    );
  });

  it('returns the exact existing attempt after consumption even past approval expiry', async () => {
    let serviceNow = new Date('2026-08-09T16:02:00.000Z');
    const service = new ProposalService(
      materializer,
      disclosureGrantResolver,
      new InMemoryProposalRepository(),
      () => new Date(serviceNow),
    );
    await service.create(proposal, preparationBinding);
    const decision = await service.decide(decisionRequest, decisionContext);
    const binding = {
      decisionId: decision.id,
      userId: ids.user,
      agentId: 'scheduler',
      runId: ids.run,
      capabilityId: proposal.capabilityId,
      capabilityFingerprint,
      disclosureGrantId: ids.grant,
      payloadHash,
      idempotencyTtlMs: 86_400_000,
      authorityBinding,
    };
    const acquired = await service.approvalStore.acquire(
      binding,
      providerOperationScope,
    );
    expect(acquired).toMatchObject({ status: 'authorized' });
    if (acquired.status !== 'authorized') throw new Error('expected permit');

    serviceNow = new Date('2026-08-09T16:11:00.000Z');
    await expect(
      service.approvalStore.acquire(binding, providerOperationScope),
    ).resolves.toEqual({
      status: 'existing-attempt',
      attemptState: 'prepared',
      authorization: acquired.authorization,
    });
    expect(
      (await service.listEvents()).filter(
        (event) => event.eventType === 'proposal.prepared',
      ),
    ).toHaveLength(1);
    expect(
      (await service.listEvents()).filter(
        (event) => event.eventType === 'proposal.executing',
      ),
    ).toHaveLength(0);

    await expect(
      service.approvalStore.markDispatching(
        binding,
        acquired.authorization.attemptId,
        providerOperationScope,
      ),
    ).resolves.toEqual({ status: 'expired' });
    const completion = {
      state: 'not-applied' as const,
      application: 'not-applied' as const,
      reason: 'approval-expired-before-dispatch' as const,
    };
    await expect(
      service.approvalStore.acquire(binding, providerOperationScope),
    ).resolves.toEqual({
      status: 'existing-attempt',
      attemptState: 'not-applied',
      authorization: acquired.authorization,
      completion,
    });
  });

  it('separates a recoverable prepared claim from irreversible dispatch', async () => {
    const service = new ProposalService(
      materializer,
      disclosureGrantResolver,
      new InMemoryProposalRepository(),
      () => new Date('2026-08-09T16:02:00.000Z'),
    );
    await service.create(proposal, preparationBinding);
    const decision = await service.decide(decisionRequest, decisionContext);
    const binding = {
      decisionId: decision.id,
      userId: ids.user,
      agentId: 'scheduler',
      runId: ids.run,
      capabilityId: proposal.capabilityId,
      capabilityFingerprint,
      disclosureGrantId: ids.grant,
      payloadHash,
      idempotencyTtlMs: 86_400_000,
      authorityBinding,
    };
    const first = await service.approvalStore.acquire(
      binding,
      providerOperationScope,
    );
    expect(first).toMatchObject({ status: 'authorized' });
    expect((await service.getProposal(ids.proposal))?.state).toBe('prepared');
    if (first.status !== 'authorized') throw new Error('expected permit');
    await expect(
      service.approvalStore.acquire(binding, providerOperationScope),
    ).resolves.toEqual({
      status: 'existing-attempt',
      attemptState: 'prepared',
      authorization: first.authorization,
    });

    await expect(
      service.approvalStore.markDispatching(
        binding,
        first.authorization.attemptId,
        providerOperationScope,
      ),
    ).resolves.toMatchObject({
      status: 'dispatch-authorized',
      authorization: first.authorization,
    });
    expect((await service.getProposal(ids.proposal))?.state).toBe('executing');
    await expect(
      service.approvalStore.acquire(binding, providerOperationScope),
    ).resolves.toMatchObject({
      status: 'existing-attempt',
      attemptState: 'executing',
      authorization: first.authorization,
    });
    await expect(
      service.approvalStore.markDispatching(
        binding,
        first.authorization.attemptId,
        providerOperationScope,
      ),
    ).resolves.toMatchObject({
      status: 'existing-attempt',
      attemptState: 'executing',
      authorization: first.authorization,
    });
  });

  it('rejects creation that is already expired or crosses expiry while materializing', async () => {
    const expiredService = new ProposalService(
      materializer,
      disclosureGrantResolver,
      new InMemoryProposalRepository(),
      () => new Date('2026-08-09T16:10:00.000Z'),
    );
    await expect(
      expiredService.create(proposal, preparationBinding),
    ).rejects.toMatchObject({
      code: 'proposal-expired',
    });
    expect(await expiredService.getProposal(ids.proposal)).toBeUndefined();

    let serviceNow = new Date('2026-08-09T16:09:59.999Z');
    let releaseMaterialization: (() => void) | undefined;
    const materializationGate = new Promise<void>((resolve) => {
      releaseMaterialization = resolve;
    });
    const slowMaterializer = {
      materialize: async (input: { canonicalArguments: unknown }) => {
        await materializationGate;
        return {
          targets: proposalInput.targets,
          beforePreview: null,
          afterPreview: input.canonicalArguments as typeof argumentsValue,
          approvalDisplay,
          providerPreconditions: proposalInput.providerPreconditions,
          providerAuthorityBindingHash,
        };
      },
    };
    const crossingService = new ProposalService(
      slowMaterializer,
      disclosureGrantResolver,
      new InMemoryProposalRepository(),
      () => new Date(serviceNow),
    );
    const creation = crossingService.create(proposal, preparationBinding);
    serviceNow = new Date('2026-08-09T16:10:00.000Z');
    releaseMaterialization?.();

    await expect(creation).rejects.toMatchObject({ code: 'proposal-expired' });
    expect(await crossingService.getProposal(ids.proposal)).toBeUndefined();
  });

  it('rechecks expiry inside every state-changing transaction', async () => {
    let createNow = new Date('2026-08-09T16:09:59.999Z');
    const createRepository = new ClockAdvancingProposalRepository(() => {
      createNow = new Date('2026-08-09T16:10:00.000Z');
    });
    createRepository.advanceBeforeTransactionAfter(1);
    const createService = new ProposalService(
      materializer,
      disclosureGrantResolver,
      createRepository,
      () => new Date(createNow),
    );
    await expect(
      createService.create(proposal, preparationBinding),
    ).rejects.toMatchObject({ code: 'proposal-expired' });
    await expect(
      createService.getProposal(proposal.id),
    ).resolves.toBeUndefined();

    let decisionNow = new Date('2026-08-09T16:02:00.000Z');
    const decisionRepository = new ClockAdvancingProposalRepository(() => {
      decisionNow = new Date('2026-08-09T16:10:00.000Z');
    });
    const decisionService = new ProposalService(
      materializer,
      disclosureGrantResolver,
      decisionRepository,
      () => new Date(decisionNow),
    );
    await decisionService.create(proposal, preparationBinding);
    decisionNow = new Date('2026-08-09T16:09:59.999Z');
    decisionRepository.advanceBeforeTransactionAfter(0);
    await expect(
      decisionService.decide(decisionRequest, {
        ...decisionContext,
        now: new Date('2026-08-09T16:09:59.999Z'),
      }),
    ).rejects.toMatchObject({ code: 'proposal-expired' });
    await expect(
      decisionService.getProposal(proposal.id),
    ).resolves.toMatchObject({ state: 'expired' });

    let acquireNow = new Date('2026-08-09T16:02:00.000Z');
    const acquireRepository = new ClockAdvancingProposalRepository(() => {
      acquireNow = new Date('2026-08-09T16:10:00.000Z');
    });
    const acquireService = new ProposalService(
      materializer,
      disclosureGrantResolver,
      acquireRepository,
      () => new Date(acquireNow),
    );
    await acquireService.create(proposal, preparationBinding);
    const acquiredDecision = await acquireService.decide(
      decisionRequest,
      decisionContext,
    );
    acquireNow = new Date('2026-08-09T16:09:59.999Z');
    acquireRepository.advanceBeforeTransactionAfter(1);
    const binding = {
      decisionId: acquiredDecision.id,
      userId: ids.user,
      agentId: 'scheduler',
      runId: ids.run,
      capabilityId: proposal.capabilityId,
      capabilityFingerprint,
      disclosureGrantId: ids.grant,
      payloadHash,
      idempotencyTtlMs: 86_400_000,
      authorityBinding,
    } as const;
    await expect(
      acquireService.approvalStore.acquire(binding, providerOperationScope),
    ).resolves.toEqual({ status: 'expired' });

    let dispatchNow = new Date('2026-08-09T16:02:00.000Z');
    const dispatchRepository = new ClockAdvancingProposalRepository(() => {
      dispatchNow = new Date('2026-08-09T16:10:00.000Z');
    });
    const dispatchService = new ProposalService(
      materializer,
      disclosureGrantResolver,
      dispatchRepository,
      () => new Date(dispatchNow),
    );
    await dispatchService.create(proposal, preparationBinding);
    const dispatchDecision = await dispatchService.decide(
      decisionRequest,
      decisionContext,
    );
    const dispatchBinding = {
      ...binding,
      decisionId: dispatchDecision.id,
    };
    const permit = await dispatchService.approvalStore.acquire(
      dispatchBinding,
      providerOperationScope,
    );
    expect(permit).toMatchObject({ status: 'authorized' });
    if (permit.status !== 'authorized') throw new Error('expected permit');
    dispatchNow = new Date('2026-08-09T16:09:59.999Z');
    dispatchRepository.advanceBeforeTransactionAfter(1);
    await expect(
      dispatchService.approvalStore.markDispatching(
        dispatchBinding,
        permit.authorization.attemptId,
        providerOperationScope,
      ),
    ).resolves.toEqual({ status: 'expired' });
    await expect(
      dispatchService.getProposal(proposal.id),
    ).resolves.toMatchObject({ state: 'not-applied' });
  });

  it('returns an exact persisted creation replay after the proposal expires', async () => {
    let serviceNow = new Date('2026-08-09T16:02:00.000Z');
    const service = new ProposalService(
      materializer,
      disclosureGrantResolver,
      new InMemoryProposalRepository(),
      () => new Date(serviceNow),
    );
    await service.create(proposal, preparationBinding);

    serviceNow = new Date('2026-08-09T16:10:00.000Z');
    await expect(service.create(proposal, preparationBinding)).resolves.toEqual(
      proposal,
    );
    expect(
      (await service.listEvents()).filter(
        (event) => event.eventType === 'proposal.created',
      ),
    ).toHaveLength(1);
  });

  it('uses a fresh store time after disclosure resolution before authorizing', async () => {
    let serviceNow = new Date('2026-08-09T16:09:59.999Z');
    let releaseGrantLookup: (() => void) | undefined;
    const grantLookupGate = new Promise<void>((resolve) => {
      releaseGrantLookup = resolve;
    });
    let grantLookups = 0;
    const slowResolver = {
      resolve: async (grantId: string) => {
        grantLookups += 1;
        if (grantLookups > 1) await grantLookupGate;
        return grantId === ids.grant
          ? proposalInput.disclosureGrant
          : undefined;
      },
    };
    const service = new ProposalService(
      materializer,
      slowResolver,
      new InMemoryProposalRepository(),
      () => new Date(serviceNow),
    );
    await service.create(proposal, preparationBinding);
    const decision = await service.decide(decisionRequest, decisionContext);
    const binding = {
      decisionId: decision.id,
      userId: ids.user,
      agentId: 'scheduler',
      runId: ids.run,
      capabilityId: proposal.capabilityId,
      capabilityFingerprint,
      disclosureGrantId: ids.grant,
      payloadHash,
      idempotencyTtlMs: 86_400_000,
      authorityBinding,
    };
    const acquisition = service.approvalStore.acquire(
      binding,
      providerOperationScope,
    );
    serviceNow = new Date('2026-08-09T16:10:00.000Z');
    releaseGrantLookup?.();

    await expect(acquisition).resolves.toEqual({ status: 'expired' });
    expect((await service.getProposal(ids.proposal))?.state).toBe('expired');
  });

  it('keeps permit issuance after the visual decision when the clock rolls back during grant lookup', async () => {
    let serviceNow = new Date('2026-08-09T16:02:00.000Z');
    let releaseGrantLookup: (() => void) | undefined;
    const grantLookupGate = new Promise<void>((resolve) => {
      releaseGrantLookup = resolve;
    });
    let grantLookups = 0;
    const rollingResolver = {
      resolve: async (grantId: string) => {
        grantLookups += 1;
        if (grantLookups > 1) await grantLookupGate;
        return grantId === ids.grant
          ? proposalInput.disclosureGrant
          : undefined;
      },
    };
    const service = new ProposalService(
      materializer,
      rollingResolver,
      new InMemoryProposalRepository(),
      () => new Date(serviceNow),
    );
    await service.create(proposal, preparationBinding);
    const decision = await service.decide(decisionRequest, decisionContext);
    const binding = {
      decisionId: decision.id,
      userId: ids.user,
      agentId: 'scheduler',
      runId: ids.run,
      capabilityId: proposal.capabilityId,
      capabilityFingerprint,
      disclosureGrantId: ids.grant,
      payloadHash,
      idempotencyTtlMs: 86_400_000,
      authorityBinding,
    };

    const acquisition = service.approvalStore.acquire(
      binding,
      providerOperationScope,
    );
    serviceNow = new Date('2026-08-09T16:00:30.000Z');
    releaseGrantLookup?.();
    const result = await acquisition;

    expect(result).toMatchObject({
      status: 'authorized',
      authorization: {
        issuedAt: '2026-08-09T16:02:00.000Z',
        idempotencyExpiresAt: '2026-08-10T16:02:00.000Z',
      },
    });
    expect(await service.listEvents()).toContainEqual(
      expect.objectContaining({
        eventType: 'proposal.prepared',
        occurredAt: '2026-08-09T16:02:00.000Z',
      }),
    );
  });

  it('converges concurrent exact acquires on one provider attempt', async () => {
    let releaseGrantLookup: (() => void) | undefined;
    const grantLookupGate = new Promise<void>((resolve) => {
      releaseGrantLookup = resolve;
    });
    let grantLookups = 0;
    const gatedResolver = {
      resolve: async (grantId: string) => {
        grantLookups += 1;
        if (grantLookups > 1) await grantLookupGate;
        return grantId === ids.grant
          ? proposalInput.disclosureGrant
          : undefined;
      },
    };
    const service = new ProposalService(
      materializer,
      gatedResolver,
      new InMemoryProposalRepository(),
      () => new Date('2026-08-09T16:02:00.000Z'),
    );
    await service.create(proposal, preparationBinding);
    const decision = await service.decide(decisionRequest, decisionContext);
    const binding = {
      decisionId: decision.id,
      userId: ids.user,
      agentId: 'scheduler',
      runId: ids.run,
      capabilityId: proposal.capabilityId,
      capabilityFingerprint,
      disclosureGrantId: ids.grant,
      payloadHash,
      idempotencyTtlMs: 86_400_000,
      authorityBinding,
    };

    const first = service.approvalStore.acquire(
      binding,
      providerOperationScope,
    );
    const second = service.approvalStore.acquire(
      binding,
      providerOperationScope,
    );
    releaseGrantLookup?.();
    const results = await Promise.all([first, second]);

    expect(results.map((result) => result.status).sort()).toEqual([
      'authorized',
      'existing-attempt',
    ]);
    const permits = results.flatMap((result) =>
      result.status === 'authorized' || result.status === 'existing-attempt'
        ? [result.authorization]
        : [],
    );
    expect(permits).toHaveLength(2);
    expect(permits[0]).toEqual(permits[1]);
    expect(
      (await service.listEvents()).filter(
        (event) => event.eventType === 'proposal.prepared',
      ),
    ).toHaveLength(1);
    expect(
      (await service.listEvents()).filter(
        (event) => event.eventType === 'proposal.executing',
      ),
    ).toHaveLength(0);
  });

  it('clamps dispatch chronology when the store clock rolls backward', async () => {
    let serviceNow = new Date('2026-08-09T16:02:00.000Z');
    const service = new ProposalService(
      materializer,
      disclosureGrantResolver,
      new InMemoryProposalRepository(),
      () => new Date(serviceNow),
    );
    await service.create(proposal, preparationBinding);
    const decision = await service.decide(decisionRequest, decisionContext);
    const binding = {
      decisionId: decision.id,
      userId: ids.user,
      agentId: 'scheduler',
      runId: ids.run,
      capabilityId: proposal.capabilityId,
      capabilityFingerprint,
      disclosureGrantId: ids.grant,
      payloadHash,
      idempotencyTtlMs: 86_400_000,
      authorityBinding,
    };
    const acquisition = await service.approvalStore.acquire(
      binding,
      providerOperationScope,
    );
    if (acquisition.status !== 'authorized') throw new Error('expected permit');

    serviceNow = new Date('2026-08-09T16:01:30.000Z');
    await expect(
      service.approvalStore.markDispatching(
        binding,
        acquisition.authorization.attemptId,
        providerOperationScope,
      ),
    ).resolves.toMatchObject({ status: 'dispatch-authorized' });
    expect(await service.listEvents()).toContainEqual(
      expect.objectContaining({
        eventType: 'proposal.executing',
        occurredAt: '2026-08-09T16:02:00.000Z',
      }),
    );
  });

  it('clamps finalization to a later dispatch when the clock rolls backward', async () => {
    let serviceNow = new Date('2026-08-09T16:02:00.000Z');
    const service = new ProposalService(
      materializer,
      disclosureGrantResolver,
      new InMemoryProposalRepository(),
      () => new Date(serviceNow),
    );
    await service.create(proposal, preparationBinding);
    const decision = await service.decide(decisionRequest, decisionContext);
    const binding = {
      decisionId: decision.id,
      userId: ids.user,
      agentId: 'scheduler',
      runId: ids.run,
      capabilityId: proposal.capabilityId,
      capabilityFingerprint,
      disclosureGrantId: ids.grant,
      payloadHash,
      idempotencyTtlMs: 86_400_000,
      authorityBinding,
    };
    const acquisition = await service.approvalStore.acquire(
      binding,
      providerOperationScope,
    );
    expect(acquisition).toMatchObject({ status: 'authorized' });
    if (acquisition.status !== 'authorized') throw new Error('expected permit');
    serviceNow = new Date('2026-08-09T16:03:00.000Z');
    await service.approvalStore.markDispatching(
      binding,
      acquisition.authorization.attemptId,
      providerOperationScope,
    );

    serviceNow = new Date('2026-08-09T16:01:30.000Z');
    await expect(
      service.approvalStore.finalize(binding, {
        state: 'executed',
        application: 'applied',
        outputStatus: 'valid',
        resultHash: '1'.repeat(64),
      }),
    ).resolves.toBe('finalized');
    expect((await service.getProposal(ids.proposal))?.state).toBe('executed');
    expect(await service.listEvents()).toContainEqual(
      expect.objectContaining({
        eventType: 'proposal.executed',
        occurredAt: '2026-08-09T16:03:00.000Z',
      }),
    );
  });

  it('rejects pre-dispatch reasons during post-dispatch reconciliation', async () => {
    const service = new ProposalService(
      materializer,
      disclosureGrantResolver,
      new InMemoryProposalRepository(),
      () => new Date('2026-08-09T16:02:00.000Z'),
    );
    await service.create(proposal, preparationBinding);
    const decision = await service.decide(decisionRequest, decisionContext);
    const binding = {
      decisionId: decision.id,
      userId: ids.user,
      agentId: 'scheduler',
      runId: ids.run,
      capabilityId: proposal.capabilityId,
      capabilityFingerprint,
      disclosureGrantId: ids.grant,
      payloadHash,
      idempotencyTtlMs: 86_400_000,
      authorityBinding,
    };
    const acquisition = await service.approvalStore.acquire(
      binding,
      providerOperationScope,
    );
    if (acquisition.status !== 'authorized') throw new Error('expected permit');
    await service.approvalStore.markDispatching(
      binding,
      acquisition.authorization.attemptId,
      providerOperationScope,
    );
    await expect(
      service.approvalStore.finalize(binding, {
        state: 'indeterminate',
        application: 'indeterminate',
        reason: 'transport-lost-after-dispatch',
        reconciliationRequired: true,
      }),
    ).resolves.toBe('finalized');

    for (const reason of [
      'approval-expired-before-dispatch',
      'approval-policy-mismatch',
    ] as const) {
      await expect(
        service.approvalStore.reconcile(binding, {
          state: 'not-applied',
          application: 'not-applied',
          reason,
        }),
      ).resolves.toBe('mismatch');
    }
    expect((await service.getProposal(ids.proposal))?.state).toBe(
      'indeterminate',
    );
  });

  it('rechecks disclosure revocation before consuming visual approval', async () => {
    let grantActive = true;
    const revocableResolver = {
      resolve: async (grantId: string) =>
        grantActive && grantId === ids.grant
          ? proposalInput.disclosureGrant
          : undefined,
    };
    const service = new ProposalService(
      materializer,
      revocableResolver,
      new InMemoryProposalRepository(),
      () => new Date('2026-08-09T16:02:00.000Z'),
    );
    await service.create(proposal, preparationBinding);
    const decision = await service.decide(decisionRequest, decisionContext);
    grantActive = false;

    await expect(
      service.approvalStore.acquire(
        {
          decisionId: decision.id,
          userId: ids.user,
          agentId: 'scheduler',
          runId: ids.run,
          capabilityId: proposal.capabilityId,
          capabilityFingerprint,
          disclosureGrantId: ids.grant,
          payloadHash,
          idempotencyTtlMs: 86_400_000,
          authorityBinding,
        },
        providerOperationScope,
      ),
    ).resolves.toEqual({ status: 'mismatch' });
    expect((await service.getProposal(ids.proposal))?.state).toBe('approved');
  });

  it('snapshots its trusted materializer and converges concurrent replays', async () => {
    let releaseMaterialization: (() => void) | undefined;
    const materializationGate = new Promise<void>((resolve) => {
      releaseMaterialization = resolve;
    });
    let trustedCalls = 0;
    let swappedCalls = 0;
    const mutableMaterializer = {
      materialize: async (input: { canonicalArguments: unknown }) => {
        trustedCalls += 1;
        await materializationGate;
        return {
          targets: proposalInput.targets,
          beforePreview: null,
          afterPreview: input.canonicalArguments as typeof argumentsValue,
          approvalDisplay,
          providerPreconditions: proposalInput.providerPreconditions,
          providerAuthorityBindingHash,
        };
      },
    };
    const service = new ProposalService(
      mutableMaterializer,
      disclosureGrantResolver,
      new InMemoryProposalRepository(),
      () => new Date(createdAt),
    );
    mutableMaterializer.materialize = async () => {
      swappedCalls += 1;
      return {
        targets: proposalInput.targets,
        beforePreview: null,
        afterPreview: { calendarId: 'primary', title: 'deceptive' },
        approvalDisplay,
        providerPreconditions: proposalInput.providerPreconditions,
        providerAuthorityBindingHash,
      };
    };

    const first = service.create(proposal, preparationBinding);
    const second = service.create(proposal, preparationBinding);
    releaseMaterialization?.();
    await expect(Promise.all([first, second])).resolves.toEqual([
      proposal,
      proposal,
    ]);
    expect(trustedCalls).toBe(2);
    expect(swappedCalls).toBe(0);
    expect(
      (await service.listEvents()).filter(
        (event) => event.eventType === 'proposal.created',
      ),
    ).toHaveLength(1);
  });
});

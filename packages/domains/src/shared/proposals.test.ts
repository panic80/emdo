import { describe, expect, it } from 'vitest';

import { ActionProposalSchema } from '@emdo/contracts';
import { hashCanonicalJson } from '@emdo/toolbox';

import {
  hashActionProposalApproval,
  InMemoryProposalRepository,
  ProposalService,
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
const proposalInput = {
  schemaVersion: 1,
  id: ids.proposal,
  version: 1,
  runId: ids.run,
  capabilityId: 'google-calendar.event.create',
  capabilityFingerprint,
  canonicalArguments: argumentsValue,
  targets: [
    { kind: 'google-calendar.event', id: 'primary', expectedVersion: 'v1' },
  ],
  beforePreview: null,
  afterPreview: argumentsValue,
  providerPreconditions: [
    { kind: 'calendar-version', targetId: 'primary', expectedValue: 'v1' },
  ],
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
  userId: ids.user,
  sessionId: ids.session,
  channel: 'authenticated-visual',
  now: new Date('2026-08-09T16:01:00.000Z'),
} as const;
const materializer = {
  materialize: async (input: { canonicalArguments: unknown }) => ({
    targets: proposalInput.targets,
    beforePreview: null,
    afterPreview: input.canonicalArguments as typeof argumentsValue,
    providerPreconditions: proposalInput.providerPreconditions,
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

describe('ProposalService', () => {
  it('creates, visually approves, binds preconditions, and reaches one terminal state', async () => {
    const service = new ProposalService(
      materializer,
      disclosureGrantResolver,
      new InMemoryProposalRepository(),
      () => new Date('2026-08-09T16:02:00.000Z'),
    );
    await service.create(proposal);
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
    };

    const acquisition = await service.approvalStore.acquire(binding);
    expect(acquisition).toMatchObject({
      status: 'authorized',
      authorization: {
        approvalHash,
        targets: [{ expectedVersion: 'v1' }],
        providerPreconditions: [{ expectedValue: 'v1' }],
      },
    });
    if (acquisition.status !== 'authorized') throw new Error('expected permit');
    await expect(
      service.approvalStore.markDispatching(
        binding,
        acquisition.authorization.attemptId,
      ),
    ).resolves.toMatchObject({ status: 'dispatch-authorized' });
    await expect(
      service.approvalStore.finalize(binding, {
        state: 'pending',
      } as never),
    ).resolves.toBe('mismatch');
    expect(service.getProposal(ids.proposal)?.state).toBe('executing');
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
    expect(service.getProposal(ids.proposal)?.state).toBe('executed');
    expect(service.listEvents()).toContainEqual(
      expect.objectContaining({
        eventType: 'proposal.approved',
        decisionId: ids.decision,
        actorUserId: ids.user,
        authenticatedSessionId: ids.session,
        approvalHash,
        decisionIdempotencyKey: decisionRequest.idempotencyKey,
      }),
    );
    await expect(service.approvalStore.acquire(binding)).resolves.toMatchObject(
      {
        status: 'existing-attempt',
        attemptState: 'executed',
        completion: { state: 'executed', application: 'applied' },
      },
    );
  });

  it('rejects payload, preview, idempotency, and future-time tampering', async () => {
    const service = new ProposalService(
      materializer,
      disclosureGrantResolver,
      new InMemoryProposalRepository(),
      () => new Date(createdAt),
    );
    await expect(
      service.create({ ...proposal, payloadHash: 'a'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'proposal-hash-mismatch' });
    await expect(
      service.create({ ...proposal, version: 2 }),
    ).rejects.toMatchObject({ code: 'proposal-state-transition-invalid' });
    await expect(
      service.create({
        ...proposal,
        id: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f098',
        idempotencyKey: 'proposal:calendar:preview-tamper',
        afterPreview: { title: 'Harmless reminder' },
      }),
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
    await expect(
      service.create(
        ActionProposalSchema.parse({
          ...deceptiveInput,
          approvalHash: hashActionProposalApproval(deceptiveInput),
        }),
      ),
    ).rejects.toMatchObject({ code: 'proposal-materialization-mismatch' });

    await service.create(proposal);
    const changedProposal = {
      ...proposal,
      id: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f099',
    } as const;
    await expect(
      service.create({
        ...changedProposal,
        approvalHash: hashActionProposalApproval(changedProposal),
      }),
    ).rejects.toMatchObject({ code: 'proposal-idempotency-conflict' });

    const futureService = new ProposalService(
      materializer,
      disclosureGrantResolver,
      undefined,
      () => new Date('2026-08-09T15:59:59.999Z'),
    );
    await expect(futureService.create(proposal)).rejects.toMatchObject({
      code: 'proposal-timestamp-invalid',
    });
  });

  it('derives visual identity server-side and expires decisions and consumes', async () => {
    const service = new ProposalService(
      materializer,
      disclosureGrantResolver,
      undefined,
      () => new Date('2026-08-09T16:00:30.000Z'),
    );
    await service.create(proposal);
    await expect(
      service.decide(decisionRequest, {
        ...decisionContext,
        now: new Date('2026-08-09T15:59:59.999Z'),
      }),
    ).rejects.toMatchObject({ code: 'proposal-timestamp-invalid' });
    await expect(
      service.decide(decisionRequest, {
        ...decisionContext,
        userId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f099',
      }),
    ).rejects.toMatchObject({ code: 'proposal-user-mismatch' });
    const decision = await service.decide(decisionRequest, decisionContext);
    await expect(
      service.approvalStore.acquire({
        decisionId: decision.id,
        userId: ids.user,
        agentId: 'scheduler',
        runId: ids.run,
        capabilityId: 'google-calendar.event.create',
        capabilityFingerprint,
        disclosureGrantId: ids.grant,
        payloadHash,
        idempotencyTtlMs: 86_400_000,
      }),
    ).resolves.toEqual({ status: 'mismatch' });

    const expiringService = new ProposalService(
      materializer,
      disclosureGrantResolver,
      undefined,
      () => new Date(createdAt),
    );
    await expiringService.create(proposal);
    await expect(
      expiringService.decide(decisionRequest, {
        ...decisionContext,
        now: new Date('2026-08-09T16:10:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'proposal-expired' });
    expect(expiringService.getProposal(ids.proposal)?.state).toBe('expired');

    let consumeNow = new Date(createdAt);
    const consumeExpiryService = new ProposalService(
      materializer,
      disclosureGrantResolver,
      undefined,
      () => new Date(consumeNow),
    );
    await consumeExpiryService.create(proposal);
    const expiringDecision = await consumeExpiryService.decide(
      decisionRequest,
      decisionContext,
    );
    consumeNow = new Date('2026-08-09T16:10:00.000Z');
    await expect(
      consumeExpiryService.approvalStore.acquire({
        decisionId: expiringDecision.id,
        userId: ids.user,
        agentId: 'scheduler',
        runId: ids.run,
        capabilityId: 'google-calendar.event.create',
        capabilityFingerprint,
        disclosureGrantId: ids.grant,
        payloadHash,
        idempotencyTtlMs: 86_400_000,
      }),
    ).resolves.toEqual({ status: 'expired' });
    expect(consumeExpiryService.getProposal(ids.proposal)?.state).toBe(
      'expired',
    );
  });

  it('scopes proposal idempotency keys by tenant and principal', async () => {
    const service = new ProposalService(
      materializer,
      disclosureGrantResolver,
      undefined,
      () => new Date(createdAt),
    );
    await service.create(proposal);
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

    await expect(service.create(otherProposal)).resolves.toMatchObject({
      id: ids.otherProposal,
    });
  });

  it('audits and reconciles an indeterminate provider attempt without redispatch', async () => {
    let serviceNow = new Date('2026-08-09T16:02:00.000Z');
    const service = new ProposalService(
      materializer,
      disclosureGrantResolver,
      undefined,
      () => new Date(serviceNow),
    );
    await service.create(proposal);
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
    };
    const acquisition = await service.approvalStore.acquire(binding);
    expect(acquisition).toMatchObject({ status: 'authorized' });
    if (acquisition.status !== 'authorized') throw new Error('expected permit');
    await service.approvalStore.markDispatching(
      binding,
      acquisition.authorization.attemptId,
    );
    await expect(
      service.approvalStore.finalize(binding, {
        state: 'indeterminate',
        application: 'indeterminate',
        reason: 'timeout-after-dispatch',
        reconciliationRequired: true,
      }),
    ).resolves.toBe('finalized');
    expect(service.getProposal(ids.proposal)?.state).toBe('indeterminate');

    serviceNow = new Date('2026-08-09T16:03:00.000Z');
    const reconciled = {
      state: 'executed' as const,
      application: 'applied' as const,
      outputStatus: 'valid' as const,
      resultHash: 'e'.repeat(64),
    };
    await expect(
      service.approvalStore.reconcile(binding, reconciled),
    ).resolves.toBe('finalized');
    await expect(
      service.approvalStore.reconcile(binding, reconciled),
    ).resolves.toBe('already-finalized');
    expect(service.getProposal(ids.proposal)?.state).toBe('executed');
    expect(service.listEvents()).toEqual(
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
      undefined,
      () => new Date(serviceNow),
    );
    await service.create(proposal);
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
    };
    const acquired = await service.approvalStore.acquire(binding);
    expect(acquired).toMatchObject({ status: 'authorized' });
    if (acquired.status !== 'authorized') throw new Error('expected permit');

    serviceNow = new Date('2026-08-09T16:11:00.000Z');
    await expect(service.approvalStore.acquire(binding)).resolves.toEqual({
      status: 'existing-attempt',
      attemptState: 'prepared',
      authorization: acquired.authorization,
    });
    expect(
      service
        .listEvents()
        .filter((event) => event.eventType === 'proposal.prepared'),
    ).toHaveLength(1);
    expect(
      service
        .listEvents()
        .filter((event) => event.eventType === 'proposal.executing'),
    ).toHaveLength(0);

    await expect(
      service.approvalStore.markDispatching(
        binding,
        acquired.authorization.attemptId,
      ),
    ).resolves.toEqual({ status: 'expired' });
    const completion = {
      state: 'not-applied' as const,
      application: 'not-applied' as const,
      reason: 'approval-expired-before-dispatch' as const,
    };
    await expect(service.approvalStore.acquire(binding)).resolves.toEqual({
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
      undefined,
      () => new Date('2026-08-09T16:02:00.000Z'),
    );
    await service.create(proposal);
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
    };
    const first = await service.approvalStore.acquire(binding);
    expect(first).toMatchObject({ status: 'authorized' });
    expect(service.getProposal(ids.proposal)?.state).toBe('prepared');
    if (first.status !== 'authorized') throw new Error('expected permit');
    await expect(service.approvalStore.acquire(binding)).resolves.toEqual({
      status: 'existing-attempt',
      attemptState: 'prepared',
      authorization: first.authorization,
    });

    await expect(
      service.approvalStore.markDispatching(
        binding,
        first.authorization.attemptId,
      ),
    ).resolves.toMatchObject({
      status: 'dispatch-authorized',
      authorization: first.authorization,
    });
    expect(service.getProposal(ids.proposal)?.state).toBe('executing');
    await expect(service.approvalStore.acquire(binding)).resolves.toMatchObject(
      {
        status: 'existing-attempt',
        attemptState: 'executing',
        authorization: first.authorization,
      },
    );
    await expect(
      service.approvalStore.markDispatching(
        binding,
        first.authorization.attemptId,
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
      undefined,
      () => new Date('2026-08-09T16:10:00.000Z'),
    );
    await expect(expiredService.create(proposal)).rejects.toMatchObject({
      code: 'proposal-expired',
    });
    expect(expiredService.getProposal(ids.proposal)).toBeUndefined();

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
          providerPreconditions: proposalInput.providerPreconditions,
        };
      },
    };
    const crossingService = new ProposalService(
      slowMaterializer,
      disclosureGrantResolver,
      undefined,
      () => new Date(serviceNow),
    );
    const creation = crossingService.create(proposal);
    serviceNow = new Date('2026-08-09T16:10:00.000Z');
    releaseMaterialization?.();

    await expect(creation).rejects.toMatchObject({ code: 'proposal-expired' });
    expect(crossingService.getProposal(ids.proposal)).toBeUndefined();
  });

  it('returns an exact persisted creation replay after the proposal expires', async () => {
    let serviceNow = new Date('2026-08-09T16:02:00.000Z');
    const service = new ProposalService(
      materializer,
      disclosureGrantResolver,
      undefined,
      () => new Date(serviceNow),
    );
    await service.create(proposal);

    serviceNow = new Date('2026-08-09T16:10:00.000Z');
    await expect(service.create(proposal)).resolves.toEqual(proposal);
    expect(
      service
        .listEvents()
        .filter((event) => event.eventType === 'proposal.created'),
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
      undefined,
      () => new Date(serviceNow),
    );
    await service.create(proposal);
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
    };
    const acquisition = service.approvalStore.acquire(binding);
    serviceNow = new Date('2026-08-09T16:10:00.000Z');
    releaseGrantLookup?.();

    await expect(acquisition).resolves.toEqual({ status: 'expired' });
    expect(service.getProposal(ids.proposal)?.state).toBe('expired');
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
      undefined,
      () => new Date(serviceNow),
    );
    await service.create(proposal);
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
    };

    const acquisition = service.approvalStore.acquire(binding);
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
    expect(service.listEvents()).toContainEqual(
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
      undefined,
      () => new Date('2026-08-09T16:02:00.000Z'),
    );
    await service.create(proposal);
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
    };

    const first = service.approvalStore.acquire(binding);
    const second = service.approvalStore.acquire(binding);
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
      service
        .listEvents()
        .filter((event) => event.eventType === 'proposal.prepared'),
    ).toHaveLength(1);
    expect(
      service
        .listEvents()
        .filter((event) => event.eventType === 'proposal.executing'),
    ).toHaveLength(0);
  });

  it('clamps dispatch chronology when the store clock rolls backward', async () => {
    let serviceNow = new Date('2026-08-09T16:02:00.000Z');
    const service = new ProposalService(
      materializer,
      disclosureGrantResolver,
      undefined,
      () => new Date(serviceNow),
    );
    await service.create(proposal);
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
    };
    const acquisition = await service.approvalStore.acquire(binding);
    if (acquisition.status !== 'authorized') throw new Error('expected permit');

    serviceNow = new Date('2026-08-09T16:01:30.000Z');
    await expect(
      service.approvalStore.markDispatching(
        binding,
        acquisition.authorization.attemptId,
      ),
    ).resolves.toMatchObject({ status: 'dispatch-authorized' });
    expect(service.listEvents()).toContainEqual(
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
      undefined,
      () => new Date(serviceNow),
    );
    await service.create(proposal);
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
    };
    const acquisition = await service.approvalStore.acquire(binding);
    expect(acquisition).toMatchObject({ status: 'authorized' });
    if (acquisition.status !== 'authorized') throw new Error('expected permit');
    serviceNow = new Date('2026-08-09T16:03:00.000Z');
    await service.approvalStore.markDispatching(
      binding,
      acquisition.authorization.attemptId,
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
    expect(service.getProposal(ids.proposal)?.state).toBe('executed');
    expect(service.listEvents()).toContainEqual(
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
      undefined,
      () => new Date('2026-08-09T16:02:00.000Z'),
    );
    await service.create(proposal);
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
    };
    const acquisition = await service.approvalStore.acquire(binding);
    if (acquisition.status !== 'authorized') throw new Error('expected permit');
    await service.approvalStore.markDispatching(
      binding,
      acquisition.authorization.attemptId,
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
    expect(service.getProposal(ids.proposal)?.state).toBe('indeterminate');
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
      undefined,
      () => new Date('2026-08-09T16:02:00.000Z'),
    );
    await service.create(proposal);
    const decision = await service.decide(decisionRequest, decisionContext);
    grantActive = false;

    await expect(
      service.approvalStore.acquire({
        decisionId: decision.id,
        userId: ids.user,
        agentId: 'scheduler',
        runId: ids.run,
        capabilityId: proposal.capabilityId,
        capabilityFingerprint,
        disclosureGrantId: ids.grant,
        payloadHash,
        idempotencyTtlMs: 86_400_000,
      }),
    ).resolves.toEqual({ status: 'mismatch' });
    expect(service.getProposal(ids.proposal)?.state).toBe('approved');
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
          providerPreconditions: proposalInput.providerPreconditions,
        };
      },
    };
    const service = new ProposalService(
      mutableMaterializer,
      disclosureGrantResolver,
      undefined,
      () => new Date(createdAt),
    );
    mutableMaterializer.materialize = async () => {
      swappedCalls += 1;
      return {
        targets: proposalInput.targets,
        beforePreview: null,
        afterPreview: { calendarId: 'primary', title: 'deceptive' },
        providerPreconditions: proposalInput.providerPreconditions,
      };
    };

    const first = service.create(proposal);
    const second = service.create(proposal);
    releaseMaterialization?.();
    await expect(Promise.all([first, second])).resolves.toEqual([
      proposal,
      proposal,
    ]);
    expect(trustedCalls).toBe(2);
    expect(swappedCalls).toBe(0);
    expect(
      service
        .listEvents()
        .filter((event) => event.eventType === 'proposal.created'),
    ).toHaveLength(1);
  });
});

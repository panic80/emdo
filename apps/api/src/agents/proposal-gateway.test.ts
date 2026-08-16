import { describe, expect, it, vi } from 'vitest';

import type { AgentExecutionContext } from '@emdo/agent-core';
import {
  ActionDecisionSchema,
  ActionProposalSchema,
  EffectiveAuthorizationScopeFingerprintSchema,
  type ActionProposal,
} from '@emdo/contracts';
import {
  hashActionProposalApproval,
  type StoredDecision,
  type StoredProposalPreparation,
  type StoredProviderWriteAttempt,
} from '@emdo/domains/server/provider-proposals';
import {
  hashCanonicalJson,
  hashProviderWriteApprovalBinding,
  type ProviderWriteApprovalStore,
} from '@emdo/toolbox';

import {
  parseProductionProviderWriteCapabilityId,
  type ProductionCapabilityRuntime,
} from './capability-runtime.js';
import {
  createProductionProviderProposalComposition,
  type DurableProviderProposalLookup,
  type TrustedProviderWriteDecisionPresenter,
} from './proposal-gateway.js';

const ids = Object.freeze({
  proposal: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f001',
  grant: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f002',
  user: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f003',
  household: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f004',
  run: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f005',
  request: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f006',
  decision: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f007',
  session: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f008',
  privateSpace: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f009',
  spaceAccessGrant: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f00a',
});

const capabilityId = parseProductionProviderWriteCapabilityId(
  'google-calendar.event.create',
);
const sdkCallId = 'call-calendar-create-1';
const authorizationScopeFingerprint =
  EffectiveAuthorizationScopeFingerprintSchema.parse('e'.repeat(64));
const authorityBinding = Object.freeze({
  kind: 'google-calendar-grant-v2' as const,
  householdId: ids.household,
  privateSpaceId: ids.privateSpace,
  authorizationScopeFingerprint,
  providerGrantReference: 'google-calendar-grant-reference-1',
  authorizationEpoch: 1,
});
const canonicalArguments = Object.freeze({
  schemaVersion: 1 as const,
  calendarRef: 'primary',
  event: {
    title: 'Dentist appointment',
    start: '2026-08-11T14:00:00.000Z',
    end: '2026-08-11T15:00:00.000Z',
  },
});
const capabilityFingerprint = hashCanonicalJson({ capabilityId, version: 1 });
const providerAuthorityBindingHash = hashCanonicalJson(authorityBinding);
const proposalInput = Object.freeze({
  schemaVersion: 1 as const,
  id: ids.proposal,
  version: 1,
  runId: ids.run,
  capabilityId,
  capabilityFingerprint,
  authorizationScopeFingerprint,
  canonicalArguments,
  targets: [
    {
      kind: 'google-calendar.event',
      id: 'calendar-primary-event-1',
      expectedVersion: 'absent',
    },
  ],
  beforePreview: null,
  afterPreview: { title: 'Dentist appointment' },
  approvalDisplay: {
    schemaVersion: 1 as const,
    title: 'Create calendar event',
    summary: 'Create a dentist appointment on the primary calendar.',
    beforeSummary: '',
    afterSummary: 'Dentist appointment, August 11 from 10:00 to 11:00.',
    fields: [
      { label: 'Calendar', value: 'Primary' },
      { label: 'Title', value: 'Dentist appointment' },
    ],
  },
  providerPreconditions: [
    {
      kind: 'calendar-version',
      targetId: 'primary',
      expectedValue: 'calendar-v1',
    },
  ],
  providerAuthorityBindingHash,
  providerSdkCallId: sdkCallId,
  payloadHash: hashCanonicalJson(canonicalArguments),
  disclosureGrant: {
    schemaVersion: 1 as const,
    id: ids.grant,
    version: 1,
    userId: ids.user,
    householdId: ids.household,
    agentId: 'scheduler',
    purpose: 'Prepare the requested calendar event proposal.',
    runId: ids.run,
    recordAllowlist: [
      {
        dataClass: 'calendar.events',
        recordId: 'calendar-primary-event-1',
        fields: ['title', 'start', 'end'],
      },
    ],
    provider: 'google-calendar' as const,
    createdAt: '2026-08-10T14:00:00.000Z',
    expiresAt: '2026-08-10T14:10:00.000Z',
    oneRunOnly: true as const,
  },
  createdAt: '2026-08-10T14:00:00.000Z',
  expiresAt: '2026-08-10T14:10:00.000Z',
  idempotencyKey: 'proposal:calendar:018f1f5e',
  state: 'pending' as const,
});
const proposal: ActionProposal = ActionProposalSchema.parse({
  ...proposalInput,
  approvalHash: hashActionProposalApproval(proposalInput),
});
const preparationBinding = Object.freeze({
  proposalId: proposal.id,
  originRequestId: ids.request,
  runId: proposal.runId,
  householdId: ids.household,
  userId: ids.user,
  originSessionId: ids.session,
  agentId: 'scheduler',
  originSpaceAccessGrantId: ids.spaceAccessGrant,
  disclosureGrantId: ids.grant,
  disclosurePolicyVersion: '1.0.0',
  capabilityId,
  sdkCallId,
  providerAuthorityBindingHash,
});
const preparation: StoredProposalPreparation = Object.freeze({
  binding: preparationBinding,
  bindingHash: hashCanonicalJson({
    domain: 'emdo.provider-proposal-preparation.v1',
    binding: preparationBinding,
  }),
});
const approvedProposal: ActionProposal = ActionProposalSchema.parse({
  ...proposal,
  version: 2,
  state: 'approved',
});
const approvedDecision: StoredDecision = Object.freeze({
  proposalId: proposal.id,
  decision: ActionDecisionSchema.parse({
    schemaVersion: 1,
    id: ids.decision,
    proposalId: proposal.id,
    userId: ids.user,
    authenticatedSessionId: ids.session,
    payloadHash: proposal.payloadHash,
    approvalHash: proposal.approvalHash,
    decision: 'approved',
    channel: 'authenticated-visual',
    decidedAt: '2026-08-10T14:01:00.000Z',
    idempotencyKey: 'decision:calendar:018f1f5e',
  }),
});
const approvalBinding = Object.freeze({
  decisionId: ids.decision,
  userId: ids.user,
  agentId: 'scheduler',
  runId: ids.run,
  capabilityId,
  capabilityFingerprint,
  disclosureGrantId: ids.grant,
  payloadHash: proposal.payloadHash,
  idempotencyTtlMs: 86_400_000,
  authorityBinding,
});
const approvalBindingHash = hashProviderWriteApprovalBinding(approvalBinding);
const capabilityOutput = Object.freeze({
  schemaVersion: 1 as const,
  result: {
    status: 'applied' as const,
    providerRequestId: 'provider-request-1',
    reconciled: false,
    readbackCalendarVersion: 'calendar-v2',
    readback: {
      eventId: 'calendar-primary-event-1',
      eventVersion: 'event-v1',
      title: 'Dentist appointment',
      start: '2026-08-11T14:00:00.000Z',
      end: '2026-08-11T15:00:00.000Z',
    },
  },
});
const providerCompletion = Object.freeze({
  state: 'executed' as const,
  application: 'applied' as const,
  outputStatus: 'valid' as const,
  resultHash: hashCanonicalJson(capabilityOutput),
});
const providerAttempt: StoredProviderWriteAttempt = Object.freeze({
  proposalId: proposal.id,
  decisionId: ids.decision,
  attemptState: 'executed',
  bindingHash: approvalBindingHash,
  authorization: {
    proposalId: proposal.id,
    approvalHash: proposal.approvalHash,
    approvalBindingHash,
    capabilityFingerprint,
    proposalCreatedAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
    disclosureGrantId: ids.grant,
    disclosureGrantHash: hashCanonicalJson(proposal.disclosureGrant),
    approvalBinding,
    providerIdempotencyKey: 'c'.repeat(64),
    idempotencyExpiresAt: '2026-08-11T14:01:00.000Z',
    attemptId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f010',
    attemptVersion: 1,
    issuedAt: '2026-08-10T14:01:00.000Z',
    targets: proposal.targets,
    providerPreconditions: proposal.providerPreconditions,
  },
  dispatchedAt: '2026-08-10T14:01:01.000Z',
  completion: {
    completion: providerCompletion,
    bindingHash: approvalBindingHash,
    completionHash: hashCanonicalJson(providerCompletion),
    completedAt: '2026-08-10T14:01:02.000Z',
  },
});

const context: AgentExecutionContext = Object.freeze({
  requestId: ids.request,
  runId: ids.run,
  householdId: ids.household,
  userId: ids.user,
  authenticatedSessionId: ids.session,
  spaceAccessGrantId: ids.spaceAccessGrant,
  authorizationScopeFingerprint,
  disclosureGrantId: ids.grant,
  disclosureGrantVersion: '1.0.0',
  agentId: 'scheduler',
  abortSignal: new AbortController().signal,
});

const approvalStore: ProviderWriteApprovalStore = Object.freeze({
  acquire: async () => ({ status: 'not-found' as const }),
  markDispatching: async () => ({ status: 'not-found' as const }),
  finalize: async () => 'not-found' as const,
  reconcile: async () => 'not-found' as const,
});

const setup = (authenticatedSessionId: string = ids.session) => {
  const materializeProviderWriteProposal = vi.fn(async () => ({
    sdkCallId,
    proposal,
  }));
  const invoke = vi.fn(async () => capabilityOutput);
  const runtime = {
    materializeProviderWriteProposal,
    registry: {
      size: 19,
      resolveForAgent: vi.fn(() => [
        {
          descriptor: { id: capabilityId, capabilityKind: 'provider-write' },
          invoke,
        },
      ]),
    },
    manifests: { scheduler: { id: 'scheduler' } },
  } as unknown as ProductionCapabilityRuntime;
  const lookup: DurableProviderProposalLookup = {
    resolvePreparedBySdkBinding: vi.fn(async () => ({
      proposal,
      preparation,
    })),
    resolveDecisionById: vi.fn(async () => ({
      proposal: approvedProposal,
      preparation,
      decision: approvedDecision,
    })),
    resolveProviderWriteCompletionByDecisionId: vi.fn(
      async () => providerAttempt,
    ),
  };
  const presenter: TrustedProviderWriteDecisionPresenter = {
    present: vi.fn(async () => ({
      summary: 'The calendar change was completed and verified.',
      clarificationQuestion: null,
      evidenceReferences: [],
      derivedValueReferences: [],
      actionProposalReferences: [ids.proposal],
    })),
  };
  const abandonPrepared = vi.fn(async () => ({
    status: 'abandoned' as const,
  }));
  const composition = createProductionProviderProposalComposition({
    proposalService: { approvalStore, abandonPrepared },
    lookup,
    presenter,
    authenticatedSessionId,
    now: () => new Date('2026-08-10T14:02:00.000Z'),
  });
  return {
    abandonPrepared,
    composition,
    gateway: composition.createGateway(runtime),
    invoke,
    lookup,
    materializeProviderWriteProposal,
    presenter,
    runtime,
  };
};

describe('production provider proposal gateway', () => {
  it('prepares and resolves the same durable SDK-bound proposal without a process-local store', async () => {
    const { composition, gateway, lookup, materializeProviderWriteProposal } =
      setup();

    expect(composition.approvalStore).toBe(approvalStore);
    await expect(
      gateway.prepare({
        capabilityId,
        sdkCallId,
        canonicalArguments,
        context,
      }),
    ).resolves.toEqual({
      proposalId: ids.proposal,
      providerAuthorityBindingHash,
      authorizationScopeFingerprint,
      preview: {
        before: proposal.beforePreview,
        after: proposal.afterPreview,
      },
    });
    expect(materializeProviderWriteProposal).toHaveBeenCalledWith({
      capabilityId,
      arguments: canonicalArguments,
      context: expect.objectContaining({
        requestId: ids.request,
        runId: ids.run,
        sdkCallId,
        disclosureGrantVersion: '1.0.0',
      }),
    });
    await expect(
      gateway.resolvePrepared({ capabilityId, sdkCallId, context }),
    ).resolves.toEqual({
      proposalId: ids.proposal,
      providerAuthorityBindingHash,
      authorizationScopeFingerprint,
      preview: {
        before: proposal.beforePreview,
        after: proposal.afterPreview,
      },
    });
    expect(lookup.resolvePreparedBySdkBinding).toHaveBeenCalledWith({
      runId: ids.run,
      capabilityId,
      providerSdkCallId: sdkCallId,
    });
  });

  it('validates every persisted visual-decision and execution binding before dispatch', async () => {
    const { gateway, invoke, presenter } = setup();
    const decisionContext = Object.freeze({
      ...context,
      approvalDecisionId: ids.decision,
    });
    const currentExecutionContext = Object.freeze({
      ...decisionContext,
      requestId: '018f1f5e-2000-7000-8000-00000000000c',
      spaceAccessGrantId: '018f1f5e-2000-7000-8000-00000000000d',
    });

    await expect(
      gateway.validateDecision({
        proposalId: ids.proposal,
        approvalDecisionId: ids.decision,
        capabilityId,
        context: currentExecutionContext,
        preparationContext: decisionContext,
        decision: 'approve',
      }),
    ).resolves.toBe(true);
    await expect(
      gateway.validateDecision({
        proposalId: ids.proposal,
        approvalDecisionId: ids.decision,
        capabilityId,
        context: { ...decisionContext, userId: ids.household },
        preparationContext: decisionContext,
        decision: 'approve',
      }),
    ).resolves.toBe(false);
    await expect(
      gateway.validateDecision({
        proposalId: ids.proposal,
        approvalDecisionId: ids.decision,
        capabilityId,
        context: {
          ...decisionContext,
          disclosureGrantVersion: '2.0.0',
        },
        preparationContext: decisionContext,
        decision: 'approve',
      }),
    ).resolves.toBe(false);
    const wrongSession = setup(ids.user);
    await expect(
      wrongSession.gateway.validateDecision({
        proposalId: ids.proposal,
        approvalDecisionId: ids.decision,
        capabilityId,
        context: currentExecutionContext,
        preparationContext: decisionContext,
        decision: 'approve',
      }),
    ).resolves.toBe(false);

    await expect(
      gateway.executeDecision({
        proposalId: ids.proposal,
        approvalDecisionId: ids.decision,
        capabilityId,
        context: currentExecutionContext,
        preparationContext: decisionContext,
        decision: 'approve',
      }),
    ).resolves.toEqual({
      outcome: 'executed-readback-verified',
      output: expect.objectContaining({
        actionProposalReferences: [ids.proposal],
      }),
      idempotencyKey: 'c'.repeat(64),
    });
    expect(invoke).toHaveBeenCalledWith(
      canonicalArguments,
      expect.objectContaining({
        approvalDecisionId: ids.decision,
        disclosureGrantId: ids.grant,
        requestId: currentExecutionContext.requestId,
        spaceAccessGrantId: currentExecutionContext.spaceAccessGrantId,
      }),
    );
    expect(presenter.present).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'approve',
        capabilityOutput: expect.objectContaining({ schemaVersion: 1 }),
      }),
    );
  });

  it('refuses to attest provider readback when the durable completion does not bind the output', async () => {
    const configured = setup();
    vi.mocked(
      configured.lookup.resolveProviderWriteCompletionByDecisionId,
    ).mockResolvedValue({
      ...providerAttempt,
      completion: {
        ...providerAttempt.completion!,
        completion: {
          ...providerCompletion,
          resultHash: 'd'.repeat(64),
        },
        completionHash: hashCanonicalJson({
          ...providerCompletion,
          resultHash: 'd'.repeat(64),
        }),
      },
    });

    await expect(
      configured.gateway.executeDecision({
        proposalId: ids.proposal,
        approvalDecisionId: ids.decision,
        capabilityId,
        context: { ...context, approvalDecisionId: ids.decision },
        preparationContext: {
          ...context,
          approvalDecisionId: ids.decision,
        },
        decision: 'approve',
      }),
    ).rejects.toThrow('api-provider-write-completion-invalid');
    expect(configured.invoke).toHaveBeenCalledOnce();
    expect(configured.presenter.present).not.toHaveBeenCalled();
  });

  it('delegates exact abandonment scope and never invokes a provider for rejection', async () => {
    const { abandonPrepared, gateway } = setup();

    await expect(
      gateway.abandonPrepared({
        proposalId: ids.proposal,
        capabilityId,
        sdkCallId,
        providerAuthorityBindingHash,
        reason: 'execution-ended-before-checkpoint',
        scope: {
          requestId: ids.request,
          runId: ids.run,
          householdId: ids.household,
          userId: ids.user,
          authenticatedSessionId: ids.session,
          spaceAccessGrantId: ids.spaceAccessGrant,
          disclosureGrantId: ids.grant,
          disclosurePolicyVersion: '1.0.0',
          agentId: 'scheduler',
        },
      }),
    ).resolves.toEqual({ status: 'abandoned' });
    expect(abandonPrepared).toHaveBeenCalledWith({
      ...preparationBinding,
      reason: 'execution-ended-before-checkpoint',
      now: new Date('2026-08-10T14:02:00.000Z'),
    });

    const rejectedDecision: StoredDecision = Object.freeze({
      proposalId: proposal.id,
      decision: ActionDecisionSchema.parse({
        ...approvedDecision.decision,
        decision: 'rejected',
      }),
    });
    const rejectedProposal = ActionProposalSchema.parse({
      ...proposal,
      version: 2,
      state: 'rejected',
    });
    const { gateway: rejectedGateway, invoke: rejectedInvoke } = (() => {
      const configured = setup();
      vi.mocked(configured.lookup.resolveDecisionById).mockResolvedValue({
        proposal: rejectedProposal,
        preparation,
        decision: rejectedDecision,
      });
      return configured;
    })();
    await expect(
      rejectedGateway.executeDecision({
        proposalId: ids.proposal,
        approvalDecisionId: ids.decision,
        capabilityId,
        context: { ...context, approvalDecisionId: ids.decision },
        preparationContext: {
          ...context,
          approvalDecisionId: ids.decision,
        },
        decision: 'reject',
      }),
    ).resolves.toMatchObject({ outcome: 'rejected' });
    expect(rejectedInvoke).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';

import type { ResumeTurnInput, TurnResult } from '@emdo/agent-core';
import {
  EffectiveAuthorizationScopeFingerprintSchema,
  type ActionDecision,
} from '@emdo/contracts';

import type { AuthenticatedPrincipal } from '../services/contracts.js';
import {
  createProductionApprovalResumeBinding,
  type DurableApprovalDecisionResumeBoundary,
  type ProductionApprovalResumeRuntimeFactory,
} from './approval-resume.js';

const ids = Object.freeze({
  decisionRequest: '018f1f5e-3000-7000-8000-000000000001',
  turnRequest: '018f1f5e-3000-7000-8000-000000000002',
  run: '018f1f5e-3000-7000-8000-000000000003',
  conversation: '018f1f5e-3000-7000-8000-000000000004',
  checkpoint: '018f1f5e-3000-7000-8000-000000000005',
  proposal: '018f1f5e-3000-7000-8000-000000000006',
  decision: '018f1f5e-3000-7000-8000-000000000007',
  user: '018f1f5e-3000-7000-8000-000000000008',
  session: '018f1f5e-3000-7000-8000-000000000009',
  household: '018f1f5e-3000-7000-8000-00000000000a',
  decisionSpaceGrant: '018f1f5e-3000-7000-8000-00000000000b',
  disclosureGrant: '018f1f5e-3000-7000-8000-00000000000c',
  resumeSpaceGrant: '018f1f5e-3000-7000-8000-00000000000d',
  privateSpace: '018f1f5e-3000-7000-8000-00000000000e',
});

const payloadHash = 'a'.repeat(64);
const approvalHash = 'b'.repeat(64);
const runScopeFingerprint = EffectiveAuthorizationScopeFingerprintSchema.parse(
  'e'.repeat(64),
);
const collectionScopeFingerprint =
  EffectiveAuthorizationScopeFingerprintSchema.parse('d'.repeat(64));

const principal: AuthenticatedPrincipal = Object.freeze({
  userId: ids.user,
  sessionId: ids.session,
  householdId: ids.household,
  role: 'owner',
  emailVerified: true,
  spaceAccessGrantId: ids.decisionSpaceGrant,
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema.parse('f'.repeat(64)),
});

const decision: ActionDecision = Object.freeze({
  schemaVersion: 1,
  id: ids.decision,
  proposalId: ids.proposal,
  userId: ids.user,
  authenticatedSessionId: ids.session,
  payloadHash,
  approvalHash,
  decision: 'approved',
  channel: 'authenticated-visual',
  decidedAt: '2026-08-10T14:00:00.000Z',
  idempotencyKey: 'decision-key-0001',
});

const request = Object.freeze({
  request: {
    schemaVersion: 1 as const,
    proposalId: ids.proposal,
    payloadHash,
    approvalHash,
    decision: 'approved' as const,
    idempotencyKey: 'decision-key-0001',
  },
  visualProofToken: 'trusted-visual-proof-token',
  principal,
  requestId: ids.decisionRequest,
});

const claimed = Object.freeze({
  turnRequestId: ids.turnRequest,
  runId: ids.run,
  conversationId: ids.conversation,
  checkpointId: ids.checkpoint,
  interruptionId: 'delegation-1:approval:call-1',
  proposalId: ids.proposal,
  approvalDecisionId: ids.decision,
  decision: 'approve' as const,
  householdId: ids.household,
  userId: ids.user,
  authenticatedSessionId: ids.session,
  spaceAccessGrantId: ids.resumeSpaceGrant,
  disclosureGrantId: ids.disclosureGrant,
  disclosureGrantVersion: '1.0.0',
  collectionAuthorizationScopeFingerprint: collectionScopeFingerprint,
  authorizationScopeFingerprint: runScopeFingerprint,
  payloadHash,
  approvalHash,
});

const completedTurn = Object.freeze({
  status: 'failed' as const,
  runId: ids.run,
  localTraceReference: 'local-trace-ref',
  safeError: {
    code: 'approval-rejection-failed',
    message: 'The proposal rejection could not be recorded safely.',
    retryable: false,
  },
  specialistOutcomes: [],
  usage: { inputTokens: 0, outputTokens: 0, modelCostCadMinor: 0 },
});

const setup = (
  overrides: {
    readonly decideAndLink?: DurableApprovalDecisionResumeBoundary['decideAndLink'];
    readonly claim?: DurableApprovalDecisionResumeBoundary['claim'];
    readonly resumeTurn?: (input: ResumeTurnInput) => Promise<TurnResult>;
    readonly runtimeCheck?: () => Promise<boolean>;
    readonly boundaryCheck?: () => Promise<boolean>;
  } = {},
) => {
  const decideAndLink = vi.fn<
    DurableApprovalDecisionResumeBoundary['decideAndLink']
  >(overrides.decideAndLink ?? (async () => ({ status: 'decided', decision })));
  const claim = vi.fn<DurableApprovalDecisionResumeBoundary['claim']>(
    overrides.claim ??
      (async () => ({
        status: 'claimed',
        claimId: 'approval-resume-claim-0001',
        ownershipToken: 'approval-resume-owner-0001',
        binding: claimed,
      })),
  );
  const complete = vi.fn<DurableApprovalDecisionResumeBoundary['complete']>(
    async () => ({ status: 'completed', terminalEventSequence: 17 }),
  );
  const markIndeterminate = vi.fn<
    DurableApprovalDecisionResumeBoundary['markIndeterminate']
  >(async () => ({ status: 'indeterminate', terminalEventSequence: 17 }));
  const terminalizeNotDispatched = vi.fn<
    DurableApprovalDecisionResumeBoundary['terminalizeNotDispatched']
  >(async () => ({ status: 'terminalized', terminalEventSequence: 17 }));
  const boundary: DurableApprovalDecisionResumeBoundary = {
    decideAndLink,
    claim,
    complete,
    markIndeterminate,
    terminalizeNotDispatched,
    check: overrides.boundaryCheck ?? (async () => true),
  };
  const resumeTurn = vi.fn(overrides.resumeTurn ?? (async () => completedTurn));
  const create = vi.fn<ProductionApprovalResumeRuntimeFactory['create']>(
    async () => ({ orchestrator: { resumeTurn } }),
  );
  const runtimeFactory: ProductionApprovalResumeRuntimeFactory = {
    create,
    check: overrides.runtimeCheck ?? (async () => true),
  };
  const binding = createProductionApprovalResumeBinding({
    boundary,
    runtimeFactory,
  });
  return {
    binding,
    decideAndLink,
    claim,
    complete,
    markIndeterminate,
    terminalizeNotDispatched,
    create,
    resumeTurn,
  };
};

describe('production approval resume binding', () => {
  it('atomically decides and claims before resuming with a fresh phase grant, then commits a terminal event', async () => {
    const configured = setup();

    await expect(
      configured.binding.service.decideWithVisualProof(request),
    ).resolves.toEqual({ status: 'decided', decision });

    expect(configured.decideAndLink).toHaveBeenCalledWith(request);
    expect(configured.claim).toHaveBeenCalledWith({
      decision,
      principal,
      decisionRequestId: ids.decisionRequest,
    });
    expect(configured.create).toHaveBeenCalledWith({
      principal: {
        ...principal,
        spaceAccessGrantId: ids.resumeSpaceGrant,
        collectionAuthorizationScopeFingerprint: collectionScopeFingerprint,
      },
      requestId: ids.turnRequest,
      runId: ids.run,
      conversationId: ids.conversation,
      authorizationScopeFingerprint: runScopeFingerprint,
      approvalResume: {
        checkpointId: ids.checkpoint,
        proposalId: ids.proposal,
        approvalDecisionId: ids.decision,
        authenticatedSessionId: ids.session,
        disclosureGrantId: ids.disclosureGrant,
        disclosureGrantVersion: '1.0.0',
        collectionAuthorizationScopeFingerprint: collectionScopeFingerprint,
        authorizationScopeFingerprint: runScopeFingerprint,
      },
    });
    expect(configured.resumeTurn).toHaveBeenCalledWith({
      requestId: ids.turnRequest,
      runId: ids.run,
      householdId: ids.household,
      userId: ids.user,
      authenticatedSessionId: ids.session,
      conversationId: ids.conversation,
      spaceAccessGrantId: ids.resumeSpaceGrant,
      collectionAuthorizationScopeFingerprint: collectionScopeFingerprint,
      disclosureGrantId: ids.disclosureGrant,
      disclosureGrantVersion: '1.0.0',
      authorizationScopeFingerprint: runScopeFingerprint,
      checkpointId: ids.checkpoint,
      interruptionId: 'delegation-1:approval:call-1',
      proposalId: ids.proposal,
      approvalDecisionId: ids.decision,
      decision: 'approve',
      approvalChannel: 'authenticated-visual',
      abortSignal: expect.any(AbortSignal),
    });
    expect(configured.complete).toHaveBeenCalledWith({
      claimId: 'approval-resume-claim-0001',
      ownershipToken: 'approval-resume-owner-0001',
      binding: claimed,
      result: completedTurn,
    });
    expect(configured.markIndeterminate).not.toHaveBeenCalled();
    expect(ids.resumeSpaceGrant).not.toBe(ids.decisionSpaceGrant);
    expect(collectionScopeFingerprint).not.toBe(
      principal.collectionAuthorizationScopeFingerprint,
    );
  });

  it('projects private-space metadata out of strict durable boundaries while preserving it for the resumed runtime', async () => {
    const configured = setup();
    const privatePrincipal: AuthenticatedPrincipal = Object.freeze({
      ...principal,
      privateSpaceId: ids.privateSpace,
    });

    await expect(
      configured.binding.service.decideWithVisualProof({
        ...request,
        principal: privatePrincipal,
      }),
    ).resolves.toEqual({ status: 'decided', decision });

    expect(configured.decideAndLink).toHaveBeenCalledWith({
      ...request,
      principal,
    });
    expect(configured.claim).toHaveBeenCalledWith({
      decision,
      principal,
      decisionRequestId: ids.decisionRequest,
    });
    expect(configured.create).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: {
          ...privatePrincipal,
          spaceAccessGrantId: ids.resumeSpaceGrant,
          collectionAuthorizationScopeFingerprint: collectionScopeFingerprint,
        },
      }),
    );
  });

  it('never constructs a runtime for an exact durable terminal replay', async () => {
    const configured = setup({
      claim: async () => ({
        status: 'terminal-replay',
        runId: ids.run,
        terminalEventSequence: 18,
      }),
    });

    await expect(
      configured.binding.service.decideWithVisualProof(request),
    ).resolves.toEqual({ status: 'decided', decision });
    expect(configured.create).not.toHaveBeenCalled();
    expect(configured.resumeTurn).not.toHaveBeenCalled();
    expect(configured.complete).not.toHaveBeenCalled();
  });

  it('terminalizes without checkpoint consumption when a claimed binding is not exact for the authenticated session', async () => {
    const configured = setup({
      claim: async () => ({
        status: 'claimed',
        claimId: 'approval-resume-claim-0001',
        ownershipToken: 'approval-resume-owner-0001',
        binding: {
          ...claimed,
          authenticatedSessionId: '018f1f5e-3000-7000-8000-00000000000e',
        },
      }),
    });

    await expect(
      configured.binding.service.decideWithVisualProof(request),
    ).resolves.toEqual({ status: 'decided', decision });
    expect(configured.terminalizeNotDispatched).toHaveBeenCalledWith({
      claimId: 'approval-resume-claim-0001',
      ownershipToken: 'approval-resume-owner-0001',
      binding: expect.objectContaining({
        authenticatedSessionId: '018f1f5e-3000-7000-8000-00000000000e',
      }),
      reasonCode: 'approval-resume-binding-invalid',
    });
    expect(configured.create).not.toHaveBeenCalled();
    expect(configured.resumeTurn).not.toHaveBeenCalled();
  });

  it('atomically records an indeterminate terminal event when runtime construction or resume throws', async () => {
    const configured = setup({
      resumeTurn: async () => {
        throw new Error('provider-boundary-failed');
      },
    });

    await expect(
      configured.binding.service.decideWithVisualProof(request),
    ).resolves.toEqual({ status: 'decided', decision });
    expect(configured.complete).not.toHaveBeenCalled();
    expect(configured.markIndeterminate).toHaveBeenCalledWith({
      claimId: 'approval-resume-claim-0001',
      ownershipToken: 'approval-resume-owner-0001',
      binding: claimed,
      reasonCode: 'approval-resume-failed',
    });
  });

  it('reports ready only when decision, durable resume, and runtime probes are all exactly true', async () => {
    const ready = setup();
    await expect(ready.binding.check()).resolves.toBe(true);

    const unavailable = setup({
      boundaryCheck: async () => false,
      runtimeCheck: async () => {
        throw new Error('secret-must-not-leak');
      },
    });
    await expect(unavailable.binding.check()).resolves.toBe(false);
  });
});

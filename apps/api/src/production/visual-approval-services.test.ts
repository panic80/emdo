import { randomUUID } from 'node:crypto';

import {
  ActionDecisionSchema,
  EffectiveAuthorizationScopeFingerprintSchema,
} from '@emdo/contracts';
import { ProposalError } from '@emdo/domains/server/provider-proposals';
import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedPrincipal } from '../services/contracts.js';
import {
  PostgresVisualProposalDecisionGateway,
  type VisualProposalDecisionGatewayDependencies,
} from './visual-approval-services.js';

const ids = {
  user: '95000000-0000-4000-8000-000000000001',
  session: '95000000-0000-4000-8000-000000000002',
  household: '95000000-0000-4000-8000-000000000003',
  grant: '95000000-0000-4000-8000-000000000004',
  request: '95000000-0000-4000-8000-000000000005',
  proposal: '95000000-0000-4000-8000-000000000006',
  decision: '95000000-0000-4000-8000-000000000007',
} as const;

const operationFingerprint = EffectiveAuthorizationScopeFingerprintSchema.parse(
  'a'.repeat(64),
);
const collectionFingerprint =
  EffectiveAuthorizationScopeFingerprintSchema.parse('b'.repeat(64));

const principal: AuthenticatedPrincipal = {
  userId: ids.user,
  sessionId: ids.session,
  householdId: ids.household,
  role: 'owner',
  emailVerified: true,
  spaceAccessGrantId: ids.grant,
  collectionAuthorizationScopeFingerprint: collectionFingerprint,
};
const request = {
  schemaVersion: 1 as const,
  proposalId: ids.proposal,
  payloadHash: 'c'.repeat(64),
  approvalHash: 'd'.repeat(64),
  decision: 'approved' as const,
  idempotencyKey: 'visual-decision:calendar-write:1',
};
const decision = ActionDecisionSchema.parse({
  ...request,
  id: ids.decision,
  userId: ids.user,
  authenticatedSessionId: ids.session,
  channel: 'authenticated-visual',
  decidedAt: '2026-08-13T12:00:00.000Z',
});
const proposal = {
  id: ids.proposal,
  authorizationScopeFingerprint: operationFingerprint,
} as never;

const build = (options: { readonly proposalExists?: boolean } = {}) => {
  const repository = {
    getProposal: vi.fn(async () =>
      options.proposalExists === false ? undefined : proposal,
    ),
  };
  const decide = vi.fn(async () => decision);
  const dependencies: VisualProposalDecisionGatewayDependencies = {
    checkReady: vi.fn(async () => true),
    createDecisionId: vi.fn(() => ids.decision),
    createDecisionService: vi.fn(() => ({ decide })),
    createRepository: vi.fn(() => repository as never),
    now: vi.fn(() => new Date('2026-08-13T12:00:00.000Z')),
  };
  const readPool = Object.freeze({ connect: vi.fn() }) as never;
  const decisionPool = Object.freeze({ connect: vi.fn() }) as never;
  return {
    decide,
    dependencies,
    gateway: new PostgresVisualProposalDecisionGateway(
      { readPool, decisionPool },
      dependencies,
    ),
    readPool,
    repository,
    decisionPool,
  };
};

describe('production visual proposal decision gateway', () => {
  it('derives the operation fingerprint from the durable proposal and commits through the proof-bound workflow repository', async () => {
    const fixture = build();
    const proofToken = Buffer.from('visual-proof-token-1234567890').toString(
      'base64url',
    );

    await expect(
      fixture.gateway.decideWithVisualProof({
        request,
        visualProofToken: proofToken,
        principal,
        requestId: ids.request,
      }),
    ).resolves.toEqual({ status: 'decided', decision });

    expect(fixture.dependencies.createRepository).toHaveBeenCalledWith({
      readPool: fixture.readPool,
      decisionPool: fixture.decisionPool,
      principal: {
        userId: ids.user,
        sessionId: ids.session,
        requestId: ids.request,
        householdId: ids.household,
      },
      currentSpaceAccessGrantId: ids.grant,
      visualProofToken: proofToken,
    });
    expect(fixture.repository.getProposal).toHaveBeenCalledWith(ids.proposal);
    expect(fixture.decide).toHaveBeenCalledWith(request, {
      decisionId: ids.decision,
      operationScope: {
        requestId: ids.request,
        sessionId: ids.session,
        householdId: ids.household,
        userId: ids.user,
        spaceAccessGrantId: ids.grant,
        authorizationScopeFingerprint: operationFingerprint,
      },
      channel: 'authenticated-visual',
      now: new Date('2026-08-13T12:00:00.000Z'),
    });
    expect(collectionFingerprint).not.toBe(operationFingerprint);
  });

  it('does not invent an operation scope when the durable proposal is absent', async () => {
    const fixture = build({ proposalExists: false });

    await expect(
      fixture.gateway.decideWithVisualProof({
        request,
        visualProofToken: Buffer.from(randomUUID()).toString('base64url'),
        principal,
        requestId: ids.request,
      }),
    ).resolves.toEqual({ status: 'proposal-not-found' });
    expect(fixture.decide).not.toHaveBeenCalled();
  });

  it.each([
    ['proposal-not-pending', 'proposal-not-pending'],
    ['proposal-expired', 'proposal-expired'],
    ['proposal-hash-mismatch', 'proposal-binding-mismatch'],
    ['proposal-user-mismatch', 'proposal-binding-mismatch'],
    ['proposal-decision-conflict', 'proposal-binding-mismatch'],
  ] as const)(
    'maps %s without exposing storage details',
    async (code, status) => {
      const fixture = build();
      fixture.decide.mockRejectedValueOnce(new ProposalError(code, code));

      await expect(
        fixture.gateway.decideWithVisualProof({
          request,
          visualProofToken: Buffer.from(randomUUID()).toString('base64url'),
          principal,
          requestId: ids.request,
        }),
      ).resolves.toEqual({ status });
    },
  );

  it('requires the API read/replay and decision-only commit probes together', async () => {
    const fixture = build();

    await expect(fixture.gateway.checkReady()).resolves.toBe(true);
    expect(fixture.dependencies.checkReady).toHaveBeenCalledWith(
      fixture.readPool,
      fixture.decisionPool,
    );

    vi.mocked(fixture.dependencies.checkReady).mockResolvedValueOnce(false);
    await expect(fixture.gateway.checkReady()).resolves.toBe(false);
  });
});

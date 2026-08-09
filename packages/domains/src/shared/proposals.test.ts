import { describe, expect, it } from 'vitest';

import { ActionDecisionSchema, ActionProposalSchema } from '@emdo/contracts';
import { hashCanonicalJson } from '@emdo/toolbox';

import { InMemoryProposalRepository, ProposalService } from './proposals.js';

const ids = {
  proposal: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f001',
  grant: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f002',
  user: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f003',
  household: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f004',
  run: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f005',
  decision: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f006',
  session: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f007',
} as const;

const argumentsValue = { calendarId: 'primary', title: 'Dentist' };
const payloadHash = hashCanonicalJson(argumentsValue);
const proposal = ActionProposalSchema.parse({
  schemaVersion: 1,
  id: ids.proposal,
  version: 1,
  runId: ids.run,
  capabilityId: 'google-calendar.event.create',
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
});

describe('ProposalService', () => {
  it('creates, visually approves, binds, and atomically consumes once', async () => {
    const repository = new InMemoryProposalRepository();
    const service = new ProposalService(repository);
    await service.create(proposal);
    const decision = ActionDecisionSchema.parse({
      schemaVersion: 1,
      id: ids.decision,
      proposalId: ids.proposal,
      userId: ids.user,
      authenticatedSessionId: ids.session,
      payloadHash,
      decision: 'approved',
      channel: 'authenticated-visual',
      decidedAt: '2026-08-09T16:01:00.000Z',
      idempotencyKey: 'decision:calendar:018f1f5e',
    });
    await service.decide(decision, new Date('2026-08-09T16:01:00.000Z'));

    const binding = {
      decisionId: ids.decision,
      userId: ids.user,
      runId: ids.run,
      capabilityId: 'google-calendar.event.create',
      payloadHash,
      checkedAt: '2026-08-09T16:02:00.000Z',
    };
    await expect(service.approvalStore.consume(binding)).resolves.toBe(
      'authorized',
    );
    await expect(service.approvalStore.consume(binding)).resolves.toBe(
      'consumed',
    );
  });

  it('rejects canonical-hash tampering, stale decisions, and precondition drift', async () => {
    const service = new ProposalService(new InMemoryProposalRepository());
    await expect(
      service.create({ ...proposal, payloadHash: 'a'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'proposal-hash-mismatch' });
    await service.create(proposal);
    await expect(
      service.assertProviderPreconditions(ids.proposal, {
        'calendar-version:primary': 'v2',
      }),
    ).rejects.toMatchObject({ code: 'proposal-precondition-stale' });
    await expect(
      service.create({
        ...proposal,
        id: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f099',
        providerPreconditions: [
          {
            kind: 'calendar-version',
            targetId: 'primary',
            expectedValue: 'v2',
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'proposal-idempotency-conflict' });
  });

  it('rejects approval at expiry and a consume timestamp before the decision', async () => {
    const service = new ProposalService(new InMemoryProposalRepository());
    await service.create(proposal);
    const decision = ActionDecisionSchema.parse({
      schemaVersion: 1,
      id: ids.decision,
      proposalId: ids.proposal,
      userId: ids.user,
      authenticatedSessionId: ids.session,
      payloadHash,
      decision: 'approved',
      channel: 'authenticated-visual',
      decidedAt: '2026-08-09T16:01:00.000Z',
      idempotencyKey: 'decision:calendar:018f1f5e',
    });
    await service.decide(decision, new Date('2026-08-09T16:01:00.000Z'));
    await expect(
      service.approvalStore.consume({
        decisionId: ids.decision,
        userId: ids.user,
        runId: ids.run,
        capabilityId: 'google-calendar.event.create',
        payloadHash,
        checkedAt: '2026-08-09T16:00:30.000Z',
      }),
    ).resolves.toBe('mismatch');

    const expiringService = new ProposalService(
      new InMemoryProposalRepository(),
    );
    await expiringService.create(proposal);
    await expect(
      expiringService.decide(decision, new Date('2026-08-09T16:10:00.000Z')),
    ).rejects.toMatchObject({ code: 'proposal-expired' });
  });
});

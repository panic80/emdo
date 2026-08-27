import { createHash } from 'node:crypto';

import {
  ActionProposalSchema,
  ProviderWriteAuthorizationSchema,
  type ActionDecision,
} from '@emdo/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import {
  checkPostgresVisualDecisionReadiness,
  PostgresProposalRepository,
} from './postgres-proposal-repository.js';

const ids = {
  user: '91000000-0000-4000-8000-000000000001',
  session: '91000000-0000-4000-8000-000000000002',
  request: '91000000-0000-4000-8000-000000000003',
  household: '91000000-0000-4000-8000-000000000004',
  run: '91000000-0000-4000-8000-000000000005',
  grant: '91000000-0000-4000-8000-000000000006',
  proposal: '91000000-0000-4000-8000-000000000007',
  decision: '91000000-0000-4000-8000-000000000008',
  attempt: '91000000-0000-4000-8000-000000000009',
  privateSpace: '91000000-0000-4000-8000-000000000010',
  spaceGrant: '91000000-0000-4000-8000-000000000011',
} as const;

const hash = (character: string) => character.repeat(64);
const operationId = (character: string) => character.repeat(43);

const proposal = ActionProposalSchema.parse({
  schemaVersion: 1,
  id: ids.proposal,
  version: 1,
  runId: ids.run,
  capabilityId: 'scheduler.calendar.create',
  capabilityFingerprint: hash('a'),
  authorizationScopeFingerprint: hash('9'),
  canonicalArguments: { title: 'Dinner' },
  targets: [
    { kind: 'calendar-event', id: 'event:dinner', expectedVersion: 'none' },
  ],
  beforePreview: null,
  afterPreview: { title: 'Dinner' },
  approvalDisplay: {
    schemaVersion: 1,
    title: 'Create Dinner',
    summary: 'Create one calendar event named Dinner.',
    beforeSummary: '',
    afterSummary: 'Dinner is added to the calendar.',
    fields: [{ label: 'Title', value: 'Dinner' }],
  },
  providerPreconditions: [],
  providerAuthorityBindingHash: hash('b'),
  providerSdkCallId: 'sdk-call-calendar-create-1',
  payloadHash: hash('c'),
  approvalHash: hash('d'),
  disclosureGrant: {
    schemaVersion: 1,
    id: ids.grant,
    version: 3,
    userId: ids.user,
    householdId: ids.household,
    agentId: 'scheduler',
    purpose: 'Create one approved Calendar event',
    runId: ids.run,
    recordAllowlist: [
      {
        dataClass: 'calendar.event',
        recordId: 'event:dinner',
        fields: ['title'],
      },
    ],
    provider: 'openai',
    createdAt: '2026-08-10T13:55:00.000Z',
    expiresAt: '2026-08-10T14:10:00.000Z',
    oneRunOnly: true,
  },
  createdAt: '2026-08-10T14:00:00.000Z',
  expiresAt: '2026-08-10T14:10:00.000Z',
  idempotencyKey: 'calendar-create-dinner-1',
  state: 'pending',
});

const preparation = {
  binding: {
    proposalId: ids.proposal,
    originRequestId: ids.request,
    originSpaceAccessGrantId: ids.spaceGrant,
    originSessionId: ids.session,
    runId: ids.run,
    householdId: ids.household,
    userId: ids.user,
    agentId: 'scheduler',
    disclosureGrantId: ids.grant,
    disclosurePolicyVersion: '1.0.0',
    capabilityId: 'scheduler.calendar.create',
    sdkCallId: 'sdk-call-calendar-create-1',
    providerAuthorityBindingHash: hash('b'),
  },
  bindingHash: hash('e'),
} as const;

const createScope = {
  phase: 'proposal-create',
  currentRequestId: ids.request,
  currentSpaceAccessGrantId: ids.spaceGrant,
  currentSessionId: ids.session,
  runId: ids.run,
  householdId: ids.household,
  userId: ids.user,
  authorizationScopeFingerprint: proposal.authorizationScopeFingerprint,
  disclosureGrantId: ids.grant,
  disclosureGrantVersion: 3,
  disclosureGrantHash: hash('f'),
  proposalId: ids.proposal,
  providerSdkCallId: 'sdk-call-calendar-create-1',
  activeAt: '2026-08-10T14:00:01.000Z',
  requireActiveDisclosureGrant: true,
} as const;

const createdEvent = {
  proposalId: ids.proposal,
  eventType: 'proposal.created',
  occurredAt: proposal.createdAt,
} as const;

const approvedDecision: ActionDecision = {
  schemaVersion: 1,
  id: ids.decision,
  proposalId: ids.proposal,
  userId: ids.user,
  authenticatedSessionId: ids.session,
  payloadHash: proposal.payloadHash,
  approvalHash: proposal.approvalHash,
  decision: 'approved',
  channel: 'authenticated-visual',
  decidedAt: '2026-08-10T14:01:00.000Z',
  idempotencyKey: 'decision-calendar-dinner-1',
};

const writeAuthorization = ProviderWriteAuthorizationSchema.parse({
  proposalId: ids.proposal,
  approvalHash: proposal.approvalHash,
  approvalBindingHash: hash('1'),
  capabilityFingerprint: proposal.capabilityFingerprint,
  proposalCreatedAt: proposal.createdAt,
  expiresAt: proposal.expiresAt,
  disclosureGrantId: ids.grant,
  disclosureGrantHash: hash('f'),
  approvalBinding: {
    decisionId: ids.decision,
    userId: ids.user,
    agentId: 'scheduler',
    runId: ids.run,
    capabilityId: proposal.capabilityId,
    capabilityFingerprint: proposal.capabilityFingerprint,
    disclosureGrantId: ids.grant,
    payloadHash: proposal.payloadHash,
    idempotencyTtlMs: 86_400_000,
    authorityBinding: {
      kind: 'google-calendar-grant-v2',
      householdId: ids.household,
      privateSpaceId: ids.privateSpace,
      authorizationScopeFingerprint: proposal.authorizationScopeFingerprint,
      providerGrantReference: 'calendar-grant-reference-1',
      authorizationEpoch: 7,
    },
  },
  providerIdempotencyKey: hash('2'),
  idempotencyExpiresAt: '2026-08-11T14:02:00.000Z',
  attemptId: ids.attempt,
  attemptVersion: 1,
  issuedAt: '2026-08-10T14:02:00.000Z',
  targets: proposal.targets,
  providerPreconditions: proposal.providerPreconditions,
});

const principal = {
  userId: ids.user,
  sessionId: ids.session,
  requestId: ids.request,
  householdId: ids.household,
};

const clientFor = (
  respond: (
    sql: string,
    values: readonly unknown[],
  ) => readonly Record<string, unknown>[],
) => {
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => ({
    rowCount: 1,
    rows: respond(sql, values),
  }));
  const release = vi.fn();
  const client: DatabaseClient = { query, release };
  return { client, query, release };
};

const poolFor = (
  respond: (
    sql: string,
    values: readonly unknown[],
  ) => readonly Record<string, unknown>[],
) => {
  const { client, query, release } = clientFor(respond);
  const pool: DatabasePool = { connect: vi.fn(async () => client) };
  return { pool, query, release };
};

const repositoryFor = (
  readPool: DatabasePool,
  workflowPool: DatabasePool,
  fixedOperationId = operationId('A'),
) =>
  new PostgresProposalRepository({
    readPool,
    workflowPool,
    principal,
    workflowOperationIdFactory: () => fixedOperationId,
  });

describe('PostgresProposalRepository', () => {
  it('persists proposal and internally claims authority in the same aggregate transaction', async () => {
    const fixedOperationId = operationId('B');
    const read = poolFor(() => []);
    const workflow = poolFor((sql) =>
      sql.includes('commit_provider_proposal_create')
        ? [{ write_result: 'created' }]
        : [],
    );
    const repository = repositoryFor(
      read.pool,
      workflow.pool,
      fixedOperationId,
    );

    await expect(
      repository.transaction((transaction) =>
        transaction.insertProposal({
          proposal,
          preparation,
          scope: createScope,
          event: createdEvent,
        }),
      ),
    ).resolves.toBe('created');

    const commit = workflow.query.mock.calls.find(([sql]) =>
      sql.includes('commit_provider_proposal_create'),
    );
    expect(commit?.[1]).toEqual([
      fixedOperationId,
      {
        proposal,
        preparation,
        scope: createScope,
        event: createdEvent,
      },
    ]);
    expect(
      read.query.mock.calls.some(([sql]) =>
        sql.includes('issue_workflow_operation_claim'),
      ),
    ).toBe(false);
    expect(workflow.query.mock.calls.map(([sql]) => sql)).toContainEqual(
      expect.stringContaining("set_config('emdo.user_id'"),
    );
    expect(workflow.query.mock.calls.map(([sql]) => sql)).toEqual([
      'begin',
      'set local row_security = on',
      "set local statement_timeout = '30s'",
      "set local lock_timeout = '5s'",
      expect.stringContaining("set_config('emdo.user_id'"),
      expect.stringContaining('commit_provider_proposal_create'),
      'commit',
    ]);
  });

  it('proves an ambiguous authority commit by replaying the exact operation once', async () => {
    const fixedOperationId = operationId('M');
    const factory = vi.fn(() => fixedOperationId);
    const read = poolFor(() => []);
    const initial = clientFor((sql) => {
      if (sql.includes('commit_provider_proposal_create')) {
        return [{ write_result: 'created' }];
      }
      if (sql === 'commit') {
        throw new Error('commit response lost');
      }
      return [];
    });
    const replay = clientFor((sql) =>
      sql.includes('commit_provider_proposal_create')
        ? [{ write_result: 'duplicate' }]
        : [],
    );
    const workflowClients = [initial.client, replay.client];
    const workflowPool: DatabasePool = {
      connect: vi.fn(async () => {
        const client = workflowClients.shift();
        if (client === undefined) throw new Error('unexpected workflow client');
        return client;
      }),
    };
    const repository = new PostgresProposalRepository({
      readPool: read.pool,
      workflowPool,
      principal,
      workflowOperationIdFactory: factory,
    });

    await expect(
      repository.transaction(async (transaction) => ({
        persisted: await transaction.insertProposal({
          proposal,
          preparation,
          scope: createScope,
          event: createdEvent,
        }),
      })),
    ).resolves.toEqual({ persisted: 'created' });

    const firstInvocation = initial.query.mock.calls.find(([sql]) =>
      sql.includes('commit_provider_proposal_create'),
    );
    const replayInvocation = replay.query.mock.calls.find(([sql]) =>
      sql.includes('commit_provider_proposal_create'),
    );
    expect(replayInvocation).toEqual(firstInvocation);
    expect(factory).toHaveBeenCalledOnce();
    expect(initial.release).toHaveBeenCalledOnce();
    expect(initial.release).toHaveBeenCalledWith(true);
    expect(replay.release).toHaveBeenCalledOnce();
    expect(replay.release).toHaveBeenCalledWith(false);
  });

  it('proves an ambiguous terminal commit with the exact jsonb aggregate signature', async () => {
    const read = poolFor(() => []);
    const initial = clientFor((sql) => {
      if (sql.includes('commit_provider_proposal_transition')) {
        return [{ write_result: 'created' }];
      }
      if (sql === 'commit') {
        throw new Error('commit response lost');
      }
      return [];
    });
    const replay = clientFor((sql) =>
      sql.includes('commit_provider_proposal_transition')
        ? [{ write_result: 'duplicate' }]
        : [],
    );
    const workflowClients = [initial.client, replay.client];
    const workflowPool: DatabasePool = {
      connect: vi.fn(async () => {
        const client = workflowClients.shift();
        if (client === undefined) throw new Error('unexpected workflow client');
        return client;
      }),
    };
    const repository = repositoryFor(read.pool, workflowPool);
    const next = { ...proposal, version: 2, state: 'expired' as const };

    await expect(
      repository.transaction(async (transaction) => ({
        persisted: await transaction.transitionProposal({
          expected: {
            proposalId: proposal.id,
            version: 1,
            state: 'pending',
            approvalHash: proposal.approvalHash,
          },
          next,
          event: {
            proposalId: proposal.id,
            eventType: 'proposal.expired',
            occurredAt: '2026-08-10T14:10:00.000Z',
          },
        }),
      })),
    ).resolves.toEqual({ persisted: 'created' });

    const firstInvocation = initial.query.mock.calls.find(([sql]) =>
      sql.includes('commit_provider_proposal_transition'),
    );
    const replayInvocation = replay.query.mock.calls.find(([sql]) =>
      sql.includes('commit_provider_proposal_transition'),
    );
    expect(firstInvocation?.[1]).toHaveLength(1);
    expect(replayInvocation).toEqual(firstInvocation);
    expect(initial.release).toHaveBeenCalledWith(true);
    expect(replay.release).toHaveBeenCalledWith(false);
  });

  it('fails closed and destroys both sessions when ambiguous replay is not duplicate', async () => {
    const read = poolFor(() => []);
    const initial = clientFor((sql) => {
      if (sql.includes('commit_provider_proposal_create')) {
        return [{ write_result: 'created' }];
      }
      if (sql === 'commit') throw new Error('commit response lost');
      return [];
    });
    const replay = clientFor((sql) =>
      sql.includes('commit_provider_proposal_create')
        ? [{ write_result: 'conflict' }]
        : [],
    );
    const workflowClients = [initial.client, replay.client];
    const workflowPool: DatabasePool = {
      connect: vi.fn(async () => {
        const client = workflowClients.shift();
        if (client === undefined) throw new Error('unexpected workflow client');
        return client;
      }),
    };
    const repository = repositoryFor(read.pool, workflowPool, operationId('N'));

    await expect(
      repository.transaction((transaction) =>
        transaction.insertProposal({
          proposal,
          preparation,
          scope: createScope,
          event: createdEvent,
        }),
      ),
    ).rejects.toMatchObject({ code: 'authority-unavailable' });
    expect(replay.query).toHaveBeenCalledWith('rollback');
    expect(initial.release).toHaveBeenCalledWith(true);
    expect(replay.release).toHaveBeenCalledWith(true);
  });

  it('fails closed and destroys the replay session after a second ambiguous commit', async () => {
    const read = poolFor(() => []);
    const initial = clientFor((sql) => {
      if (sql.includes('commit_provider_proposal_create')) {
        return [{ write_result: 'created' }];
      }
      if (sql === 'commit') throw new Error('first commit response lost');
      return [];
    });
    const replay = clientFor((sql) => {
      if (sql.includes('commit_provider_proposal_create')) {
        return [{ write_result: 'duplicate' }];
      }
      if (sql === 'commit') throw new Error('replay commit response lost');
      return [];
    });
    const workflowClients = [initial.client, replay.client];
    const workflowPool: DatabasePool = {
      connect: vi.fn(async () => {
        const client = workflowClients.shift();
        if (client === undefined) throw new Error('unexpected workflow client');
        return client;
      }),
    };
    const repository = repositoryFor(read.pool, workflowPool, operationId('O'));

    await expect(
      repository.transaction((transaction) =>
        transaction.insertProposal({
          proposal,
          preparation,
          scope: createScope,
          event: createdEvent,
        }),
      ),
    ).rejects.toMatchObject({ code: 'authority-unavailable' });
    expect(initial.release).toHaveBeenCalledWith(true);
    expect(replay.release).toHaveBeenCalledWith(true);
  });

  it('does not consume workflow authority for a read-only preflight', async () => {
    const read = poolFor((sql) =>
      sql.includes('from emdo.action_proposals')
        ? [
            {
              proposal: {
                ...proposal,
                createdAt: '2026-08-10T10:00:00.000-04:00',
                expiresAt: '2026-08-10T10:10:00.000-04:00',
              },
            },
          ]
        : [],
    );
    const workflow = poolFor(() => []);
    const repository = repositoryFor(
      read.pool,
      workflow.pool,
      operationId('C'),
    );

    await expect(
      repository.transaction((transaction) =>
        transaction.getProposal(ids.proposal),
      ),
    ).resolves.toEqual(proposal);
    expect(
      read.query.mock.calls.some(([sql]) =>
        sql.includes('claim_workflow_operation_scope'),
      ),
    ).toBe(false);
    expect(
      read.query.mock.calls.some(([sql]) =>
        sql.includes('commit_provider_proposal'),
      ),
    ).toBe(false);
    expect(workflow.query).not.toHaveBeenCalled();
  });

  it('destroys a read session whose commit response is ambiguous', async () => {
    const read = clientFor((sql) => {
      if (sql === 'commit') throw new Error('read commit response lost');
      return [];
    });
    const readPool: DatabasePool = {
      connect: vi.fn(async () => read.client),
    };
    const workflow = poolFor(() => []);
    const repository = repositoryFor(readPool, workflow.pool);

    await expect(
      repository.transaction(async () => 'read-only-result'),
    ).rejects.toThrow('read commit response lost');
    expect(read.release).toHaveBeenCalledOnce();
    expect(read.release).toHaveBeenCalledWith(true);
    expect(read.query).not.toHaveBeenCalledWith('rollback');
    expect(workflow.query).not.toHaveBeenCalled();
  });

  it('persists the complete approval binding when preparing the provider write', async () => {
    const decision: ActionDecision = {
      schemaVersion: 1,
      id: ids.decision,
      proposalId: ids.proposal,
      userId: ids.user,
      authenticatedSessionId: ids.session,
      payloadHash: proposal.payloadHash,
      approvalHash: proposal.approvalHash,
      decision: 'approved',
      channel: 'authenticated-visual',
      decidedAt: '2026-08-10T14:01:00.000Z',
      idempotencyKey: 'decision-calendar-dinner-1',
    };
    const authorization = ProviderWriteAuthorizationSchema.parse({
      proposalId: ids.proposal,
      approvalHash: proposal.approvalHash,
      approvalBindingHash: hash('1'),
      capabilityFingerprint: proposal.capabilityFingerprint,
      proposalCreatedAt: proposal.createdAt,
      expiresAt: proposal.expiresAt,
      disclosureGrantId: ids.grant,
      disclosureGrantHash: hash('f'),
      approvalBinding: {
        decisionId: ids.decision,
        userId: ids.user,
        agentId: 'scheduler',
        runId: ids.run,
        capabilityId: proposal.capabilityId,
        capabilityFingerprint: proposal.capabilityFingerprint,
        disclosureGrantId: ids.grant,
        payloadHash: proposal.payloadHash,
        idempotencyTtlMs: 86_400_000,
        authorityBinding: {
          kind: 'google-calendar-grant-v2',
          householdId: ids.household,
          privateSpaceId: ids.privateSpace,
          authorizationScopeFingerprint: proposal.authorizationScopeFingerprint,
          providerGrantReference: 'calendar-grant-reference-1',
          authorizationEpoch: 7,
        },
      },
      providerIdempotencyKey: hash('2'),
      idempotencyExpiresAt: '2026-08-11T14:02:00.000Z',
      attemptId: ids.attempt,
      attemptVersion: 1,
      issuedAt: '2026-08-10T14:02:00.000Z',
      targets: proposal.targets,
      providerPreconditions: proposal.providerPreconditions,
    });
    const next = { ...proposal, version: 3, state: 'prepared' as const };
    const scope = {
      ...createScope,
      phase: 'provider-write-prepare' as const,
    };
    const read = poolFor(() => []);
    const workflow = poolFor((sql) =>
      sql.includes('commit_provider_proposal_prepare')
        ? [{ write_result: 'created' }]
        : [],
    );
    const repository = repositoryFor(
      read.pool,
      workflow.pool,
      operationId('D'),
    );

    await repository.transaction((transaction) =>
      transaction.prepareProviderWrite({
        expected: {
          proposalId: ids.proposal,
          version: 2,
          state: 'approved',
          approvalHash: proposal.approvalHash,
        },
        next,
        decisionId: decision.id,
        bindingHash: authorization.approvalBindingHash,
        authorization,
        scope,
        event: {
          proposalId: ids.proposal,
          eventType: 'proposal.prepared',
          occurredAt: authorization.issuedAt,
          decisionId: decision.id,
          actorUserId: ids.user,
          authenticatedSessionId: ids.session,
          approvalHash: proposal.approvalHash,
          decisionIdempotencyKey: decision.idempotencyKey,
          providerIdempotencyKey: authorization.providerIdempotencyKey,
          attemptId: authorization.attemptId,
          attemptVersion: authorization.attemptVersion,
        },
      }),
    );

    const commit = workflow.query.mock.calls.find(([sql]) =>
      sql.includes('commit_provider_proposal_prepare'),
    );
    expect(commit?.[1]?.[1]).toMatchObject({
      authorization,
      approvalBinding: authorization.approvalBinding,
      scope,
    });
    expect(
      read.query.mock.calls.some(([sql]) =>
        sql.includes('issue_workflow_operation_claim'),
      ),
    ).toBe(false);
  });

  it('fails closed without a proof and atomically binds the proof digest to a visual decision', async () => {
    const scope = {
      ...createScope,
      phase: 'visual-decision' as const,
    };
    const next = { ...proposal, version: 2, state: 'approved' as const };
    const event = {
      proposalId: ids.proposal,
      eventType: 'proposal.approved' as const,
      occurredAt: approvedDecision.decidedAt,
      decisionId: ids.decision,
      actorUserId: ids.user,
      authenticatedSessionId: ids.session,
      approvalHash: proposal.approvalHash,
      decisionIdempotencyKey: approvedDecision.idempotencyKey,
    };
    const input = {
      expected: {
        proposalId: ids.proposal,
        version: 1,
        state: 'pending' as const,
        approvalHash: proposal.approvalHash,
      },
      next,
      decision: approvedDecision,
      scope,
      event,
    };
    const read = poolFor(() => []);
    const workflow = poolFor((sql) =>
      sql.includes('commit_provider_proposal_decision')
        ? [{ write_result: 'created' }]
        : [],
    );
    const repository = repositoryFor(
      read.pool,
      workflow.pool,
      operationId('F'),
    );

    await expect(
      repository.transaction((transaction) =>
        transaction.commitDecision(input),
      ),
    ).resolves.toBe('conflict');
    expect(workflow.query).not.toHaveBeenCalled();

    const proofToken = 'p'.repeat(43);
    const wrongGrantRepository = repository.withVisualDecisionProof(
      proofToken,
      ids.grant,
    );
    await expect(
      wrongGrantRepository.transaction((transaction) =>
        transaction.commitDecision(input),
      ),
    ).resolves.toBe('conflict');
    expect(
      read.query.mock.calls.some(([sql]) =>
        sql.includes('issue_workflow_operation_claim'),
      ),
    ).toBe(false);

    const proofRepository = repository.withVisualDecisionProof(
      proofToken,
      ids.spaceGrant,
    );
    await expect(
      proofRepository.transaction((transaction) =>
        transaction.commitDecision(input),
      ),
    ).resolves.toBe('created');

    const commit = workflow.query.mock.calls.find(([sql]) =>
      sql.includes('commit_provider_proposal_decision'),
    );
    const envelope = commit?.[1]?.[1] as Record<string, unknown> | undefined;
    expect(envelope).toEqual({
      expected: input.expected,
      next,
      decision: approvedDecision,
      scope,
      event,
      visualDecisionProofHash: createHash('sha256')
        .update(proofToken, 'utf8')
        .digest('hex'),
    });
    expect(
      read.query.mock.calls.some(([sql]) =>
        sql.includes('issue_workflow_operation_claim'),
      ),
    ).toBe(false);
  });

  it('returns a decision replay only through the exact consumed visual-proof linkage', async () => {
    const proofToken = 'q'.repeat(43);
    const tokenHash = createHash('sha256')
      .update(proofToken, 'utf8')
      .digest('hex');
    const read = poolFor((sql) =>
      sql.includes('resolve_provider_proposal_decision_replay')
        ? [
            {
              replay: {
                proposalId: ids.proposal,
                decision: approvedDecision,
              },
            },
          ]
        : [],
    );
    const repository = repositoryFor(read.pool, poolFor(() => []).pool);
    const lookup = {
      userId: ids.user,
      proposalId: ids.proposal,
      idempotencyKey: approvedDecision.idempotencyKey,
    };

    await expect(
      repository.transaction((transaction) =>
        transaction.findDecisionByIdempotencyKey(lookup),
      ),
    ).resolves.toBeUndefined();
    expect(
      read.query.mock.calls.some(([sql]) =>
        sql.includes('resolve_provider_proposal_decision_replay'),
      ),
    ).toBe(false);

    const proofRepository = repository.withVisualDecisionProof(
      proofToken,
      ids.spaceGrant,
    );
    await expect(
      proofRepository.transaction((transaction) =>
        transaction.findDecisionByIdempotencyKey(lookup),
      ),
    ).resolves.toEqual({
      proposalId: ids.proposal,
      decision: approvedDecision,
    });
    const replay = read.query.mock.calls.find(([sql]) =>
      sql.includes('resolve_provider_proposal_decision_replay'),
    );
    expect(replay?.[1]).toEqual([
      ids.user,
      ids.proposal,
      approvedDecision.idempotencyKey,
      tokenHash,
      ids.spaceGrant,
    ]);
  });

  it('binds dispatch ids, timestamp, scope, and exact mutation envelope before commit', async () => {
    const scope = {
      ...createScope,
      phase: 'provider-write-dispatch' as const,
    };
    const next = { ...proposal, version: 4, state: 'executing' as const };
    const event = {
      proposalId: ids.proposal,
      eventType: 'proposal.executing' as const,
      occurredAt: '2026-08-10T14:02:30.000Z',
      decisionId: ids.decision,
      providerIdempotencyKey: writeAuthorization.providerIdempotencyKey,
      attemptId: ids.attempt,
      attemptVersion: 1,
    };
    const read = poolFor(() => []);
    const workflow = poolFor((sql) =>
      sql.includes('commit_provider_proposal_dispatch')
        ? [{ write_result: 'created' }]
        : [],
    );
    const repository = repositoryFor(
      read.pool,
      workflow.pool,
      operationId('G'),
    );

    await expect(
      repository.transaction((transaction) =>
        transaction.markDispatch({
          expected: {
            proposalId: ids.proposal,
            version: 3,
            state: 'prepared',
            approvalHash: proposal.approvalHash,
          },
          next,
          decisionId: ids.decision,
          bindingHash: writeAuthorization.approvalBindingHash,
          attemptId: ids.attempt,
          dispatchedAt: event.occurredAt,
          scope,
          event,
        }),
      ),
    ).resolves.toBe('created');

    const commit = workflow.query.mock.calls.find(([sql]) =>
      sql.includes('commit_provider_proposal_dispatch'),
    );
    expect(commit?.[1]?.[0]).toBe(operationId('G'));
    expect(
      read.query.mock.calls.some(([sql]) =>
        sql.includes('issue_workflow_operation_claim'),
      ),
    ).toBe(false);
  });

  it('fails closed when the aggregate cannot issue and consume canonical authority', async () => {
    const read = poolFor(() => []);
    const workflow = poolFor((sql) =>
      sql.includes('commit_provider_proposal_create')
        ? [{ write_result: 'conflict' }]
        : [],
    );
    const repository = repositoryFor(
      read.pool,
      workflow.pool,
      operationId('H'),
    );

    await expect(
      repository.transaction((transaction) =>
        transaction.insertProposal({
          proposal,
          preparation,
          scope: createScope,
          event: createdEvent,
        }),
      ),
    ).resolves.toBe('conflict');
    expect(
      workflow.query.mock.calls.some(([sql]) =>
        sql.includes('commit_provider_proposal_create'),
      ),
    ).toBe(true);
    expect(
      read.query.mock.calls.some(([sql]) =>
        sql.includes('issue_workflow_operation_claim'),
      ),
    ).toBe(false);
  });

  it('maps exact completion and reconciliation records from durable rows', async () => {
    const authorization = ProviderWriteAuthorizationSchema.parse({
      proposalId: ids.proposal,
      approvalHash: proposal.approvalHash,
      approvalBindingHash: hash('1'),
      capabilityFingerprint: proposal.capabilityFingerprint,
      proposalCreatedAt: proposal.createdAt,
      expiresAt: proposal.expiresAt,
      disclosureGrantId: ids.grant,
      disclosureGrantHash: hash('f'),
      approvalBinding: {
        decisionId: ids.decision,
        userId: ids.user,
        agentId: 'scheduler',
        runId: ids.run,
        capabilityId: proposal.capabilityId,
        capabilityFingerprint: proposal.capabilityFingerprint,
        disclosureGrantId: ids.grant,
        payloadHash: proposal.payloadHash,
        idempotencyTtlMs: 86_400_000,
        authorityBinding: {
          kind: 'google-calendar-grant-v2',
          householdId: ids.household,
          privateSpaceId: ids.privateSpace,
          authorizationScopeFingerprint: proposal.authorizationScopeFingerprint,
          providerGrantReference: 'calendar-grant-reference-1',
          authorizationEpoch: 7,
        },
      },
      providerIdempotencyKey: hash('2'),
      idempotencyExpiresAt: '2026-08-11T14:02:00.000Z',
      attemptId: ids.attempt,
      attemptVersion: 1,
      issuedAt: '2026-08-10T14:02:00.000Z',
      targets: proposal.targets,
      providerPreconditions: proposal.providerPreconditions,
    });
    const completion = {
      completion: {
        state: 'indeterminate',
        application: 'indeterminate',
        reason: 'timeout-after-dispatch',
        reconciliationRequired: true,
      },
      bindingHash: hash('1'),
      completionHash: hash('3'),
      completedAt: '2026-08-10T14:03:00.000Z',
    } as const;
    const reconciliation = {
      completion: {
        state: 'executed',
        application: 'applied',
        outputStatus: 'valid',
        resultHash: hash('4'),
      },
      bindingHash: hash('1'),
      completionHash: hash('5'),
      completedAt: '2026-08-10T14:04:00.000Z',
    } as const;
    const storedCompletion = {
      ...completion,
      completedAt: '2026-08-10T10:03:00.000-04:00',
    } as const;
    const storedReconciliation = {
      ...reconciliation,
      completedAt: '2026-08-10T10:04:00.000-04:00',
    } as const;
    const read = poolFor((sql) =>
      sql.includes('from emdo.provider_attempts')
        ? [
            {
              proposal_id: ids.proposal,
              decision_id: ids.decision,
              attempt_state: 'executed',
              binding_hash: hash('1'),
              authorization,
              dispatched_at: new Date('2026-08-10T14:02:30.000Z'),
              completion: storedCompletion,
              reconciliation: storedReconciliation,
            },
          ]
        : [],
    );
    const workflow = poolFor(() => []);

    await expect(
      repositoryFor(read.pool, workflow.pool).transaction((transaction) =>
        transaction.getProviderWriteAttempt(ids.decision),
      ),
    ).resolves.toEqual({
      proposalId: ids.proposal,
      decisionId: ids.decision,
      attemptState: 'executed',
      bindingHash: hash('1'),
      authorization,
      dispatchedAt: '2026-08-10T14:02:30.000Z',
      completion,
      reconciliation,
    });
  });

  it('routes abandonment and fixed-time transitions only through workflow terminal functions', async () => {
    const read = poolFor(() => []);
    const workflow = poolFor((sql) =>
      sql.includes('commit_provider_proposal_')
        ? [{ write_result: 'created' }]
        : [],
    );
    const repository = repositoryFor(read.pool, workflow.pool);
    const abandonedAt = '2026-08-10T14:00:30.000Z';
    const abandonedPreparation = {
      ...preparation,
      abandonment: {
        reason: 'execution-ended-before-checkpoint' as const,
        abandonedAt,
      },
    };

    await expect(
      repository.transaction((transaction) =>
        transaction.abandonPrepared({
          expected: {
            proposalId: ids.proposal,
            version: 1,
            state: 'pending',
            approvalHash: proposal.approvalHash,
          },
          next: { ...proposal, version: 2, state: 'not-applied' },
          preparation: abandonedPreparation,
          event: {
            proposalId: ids.proposal,
            eventType: 'proposal.not-applied',
            occurredAt: abandonedAt,
            application: 'not-applied',
            outcomeReason: abandonedPreparation.abandonment.reason,
          },
        }),
      ),
    ).resolves.toBe('created');

    const transitionRepository = repositoryFor(read.pool, workflow.pool);
    await expect(
      transitionRepository.transaction((transaction) =>
        transaction.transitionProposal({
          expected: {
            proposalId: ids.proposal,
            version: 1,
            state: 'pending',
            approvalHash: proposal.approvalHash,
          },
          next: { ...proposal, version: 2, state: 'expired' },
          event: {
            proposalId: ids.proposal,
            eventType: 'proposal.expired',
            occurredAt: proposal.expiresAt,
          },
        }),
      ),
    ).resolves.toBe('created');

    expect(
      read.query.mock.calls.some(([sql]) =>
        sql.includes('commit_provider_proposal_'),
      ),
    ).toBe(false);
    expect(
      workflow.query.mock.calls.some(([sql]) =>
        sql.includes('commit_provider_proposal_abandonment'),
      ),
    ).toBe(true);
    expect(
      workflow.query.mock.calls.some(([sql]) =>
        sql.includes('commit_provider_proposal_transition'),
      ),
    ).toBe(true);
  });

  it('routes both completion modes through the isolated workflow terminal boundary', async () => {
    const read = poolFor(() => []);
    const workflow = poolFor((sql) =>
      sql.includes('commit_provider_proposal_completion')
        ? [{ write_result: 'created' }]
        : [],
    );
    const preDispatch = {
      completion: {
        state: 'not-applied' as const,
        application: 'not-applied' as const,
        reason: 'approval-expired-before-dispatch' as const,
      },
      bindingHash: writeAuthorization.approvalBindingHash,
      completionHash: hash('6'),
      completedAt: '2026-08-10T14:03:00.000Z',
    };
    const postDispatch = {
      completion: {
        state: 'executed' as const,
        application: 'applied' as const,
        outputStatus: 'valid' as const,
        resultHash: hash('7'),
      },
      bindingHash: writeAuthorization.approvalBindingHash,
      completionHash: hash('8'),
      completedAt: '2026-08-10T14:04:00.000Z',
    };
    const mutationFor = (
      completion: typeof preDispatch | typeof postDispatch,
      state: 'not-applied' | 'executed',
    ) => ({
      expected: {
        proposalId: ids.proposal,
        version: state === 'not-applied' ? 3 : 4,
        state:
          state === 'not-applied'
            ? ('prepared' as const)
            : ('executing' as const),
        approvalHash: proposal.approvalHash,
      },
      next: {
        ...proposal,
        version: state === 'not-applied' ? 4 : 5,
        state,
      },
      decisionId: ids.decision,
      bindingHash: writeAuthorization.approvalBindingHash,
      attemptId: ids.attempt,
      completion,
      event: {
        proposalId: ids.proposal,
        eventType:
          state === 'not-applied'
            ? ('proposal.not-applied' as const)
            : ('proposal.executed' as const),
        occurredAt: completion.completedAt,
        decisionId: ids.decision,
        attemptId: ids.attempt,
        attemptVersion: 1,
        application: completion.completion.application,
        ...(state === 'not-applied'
          ? { outcomeReason: preDispatch.completion.reason }
          : {
              outputStatus: 'valid' as const,
              resultHash: postDispatch.completion.resultHash,
            }),
      },
    });

    await expect(
      repositoryFor(read.pool, workflow.pool).transaction((transaction) =>
        transaction.commitPreDispatchCompletion(
          mutationFor(preDispatch, 'not-applied'),
        ),
      ),
    ).resolves.toBe('created');
    await expect(
      repositoryFor(read.pool, workflow.pool).transaction((transaction) =>
        transaction.commitCompletion(mutationFor(postDispatch, 'executed')),
      ),
    ).resolves.toBe('created');

    const envelopes = workflow.query.mock.calls
      .filter(([sql]) => sql.includes('commit_provider_proposal_completion'))
      .map(([, values]) => values?.[0]);
    expect(envelopes).toEqual([
      expect.objectContaining({
        mode: 'pre-dispatch',
        completion: preDispatch,
      }),
      expect.objectContaining({
        mode: 'post-dispatch',
        completion: postDispatch,
      }),
    ]);
    expect(
      read.query.mock.calls.some(([sql]) =>
        sql.includes('commit_provider_proposal_completion'),
      ),
    ).toBe(false);
  });

  it('fails reconciliation closed on the API/workflow adapter', async () => {
    const read = poolFor(() => []);
    const workflow = poolFor(() => []);
    const completion = {
      completion: {
        state: 'executed' as const,
        application: 'applied' as const,
        outputStatus: 'valid' as const,
        resultHash: hash('9'),
      },
      bindingHash: writeAuthorization.approvalBindingHash,
      completionHash: hash('0'),
      completedAt: '2026-08-10T14:05:00.000Z',
    };
    await expect(
      repositoryFor(read.pool, workflow.pool).transaction((transaction) =>
        transaction.commitReconciliation({
          expected: {
            proposalId: ids.proposal,
            version: 5,
            state: 'indeterminate',
            approvalHash: proposal.approvalHash,
          },
          next: { ...proposal, version: 6, state: 'executed' },
          decisionId: ids.decision,
          bindingHash: writeAuthorization.approvalBindingHash,
          attemptId: ids.attempt,
          completion,
          event: {
            proposalId: ids.proposal,
            eventType: 'proposal.executed',
            occurredAt: completion.completedAt,
            decisionId: ids.decision,
            attemptId: ids.attempt,
            attemptVersion: 1,
            application: 'applied',
            outputStatus: 'valid',
            resultHash: completion.completion.resultHash,
          },
        }),
      ),
    ).resolves.toBe('conflict');
    expect(workflow.query).not.toHaveBeenCalled();
  });

  it('resolves trusted prepared, decision, and completion records only after locking the principal scope', async () => {
    const completedAttempt = {
      proposalId: ids.proposal,
      decisionId: ids.decision,
      attemptState: 'executed',
      bindingHash: writeAuthorization.approvalBindingHash,
      authorization: writeAuthorization,
      dispatchedAt: '2026-08-10T14:02:30.000Z',
      completion: {
        completion: {
          state: 'executed',
          application: 'applied',
          outputStatus: 'valid',
          resultHash: hash('7'),
        },
        bindingHash: writeAuthorization.approvalBindingHash,
        completionHash: hash('8'),
        completedAt: '2026-08-10T14:04:00.000Z',
      },
    } as const;
    const read = poolFor((sql) => {
      if (sql.includes('select proposal.id as proposal_id')) {
        return [{ proposal_id: ids.proposal, space_id: ids.privateSpace }];
      }
      if (sql.includes('select proposal.space_id')) {
        return [{ space_id: ids.privateSpace }];
      }
      if (sql.includes('lock_active_request_scope')) {
        return [{ authorized: true }];
      }
      if (sql.includes("'schemaVersion', proposal.schema_version")) {
        return [{ proposal }];
      }
      if (sql.includes('from emdo.proposal_preparations')) {
        return [{ preparation }];
      }
      if (sql.includes('from emdo.action_decisions')) {
        return [{ proposal_id: ids.proposal, decision: approvedDecision }];
      }
      if (sql.includes('from emdo.provider_attempts')) {
        return [
          {
            proposal_id: completedAttempt.proposalId,
            decision_id: completedAttempt.decisionId,
            attempt_state: completedAttempt.attemptState,
            binding_hash: completedAttempt.bindingHash,
            authorization: completedAttempt.authorization,
            dispatched_at: new Date(completedAttempt.dispatchedAt),
            completion: completedAttempt.completion,
            reconciliation: null,
          },
        ];
      }
      return [];
    });
    const repository = repositoryFor(read.pool, poolFor(() => []).pool);

    await expect(
      repository.resolvePreparedBySdkBinding({
        runId: ids.run,
        capabilityId: proposal.capabilityId,
        providerSdkCallId: proposal.providerSdkCallId,
      }),
    ).resolves.toEqual({ proposal, preparation });
    await expect(
      repository.resolveDecisionById({
        proposalId: ids.proposal,
        decisionId: ids.decision,
      }),
    ).resolves.toEqual({
      proposal,
      preparation,
      decision: { proposalId: ids.proposal, decision: approvedDecision },
    });
    await expect(
      repository.resolveProviderWriteCompletionByDecisionId({
        proposalId: ids.proposal,
        decisionId: ids.decision,
      }),
    ).resolves.toEqual(completedAttempt);

    const lockCalls = read.query.mock.calls.filter(([sql]) =>
      sql.includes('lock_active_request_scope'),
    );
    expect(lockCalls).toHaveLength(3);
    expect(
      lockCalls.every(([, values]) => values?.[1] === ids.privateSpace),
    ).toBe(true);
  });

  it('does not resolve a trusted SDK binding outside the durable principal scope', async () => {
    const read = poolFor((sql) =>
      sql.includes('select proposal.id as proposal_id') ? [] : [],
    );
    const repository = repositoryFor(read.pool, poolFor(() => []).pool);

    await expect(
      repository.resolvePreparedBySdkBinding({
        runId: ids.run,
        capabilityId: proposal.capabilityId,
        providerSdkCallId: proposal.providerSdkCallId,
      }),
    ).resolves.toBeUndefined();
    expect(
      read.query.mock.calls.some(([sql]) =>
        sql.includes('lock_active_request_scope'),
      ),
    ).toBe(false);
  });

  it('generates a fresh operation id for each authority mutation transaction', async () => {
    const generated = [operationId('J'), operationId('K')];
    const factory = vi.fn(() => generated.shift() ?? operationId('L'));
    const read = poolFor(() => []);
    const workflow = poolFor((sql) =>
      sql.includes('commit_provider_proposal_create')
        ? [{ write_result: 'created' }]
        : [],
    );
    const repository = new PostgresProposalRepository({
      readPool: read.pool,
      workflowPool: workflow.pool,
      principal,
      workflowOperationIdFactory: factory,
    });
    const create = () =>
      repository.transaction((transaction) =>
        transaction.insertProposal({
          proposal,
          preparation,
          scope: createScope,
          event: createdEvent,
        }),
      );

    await create();
    await create();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(
      workflow.query.mock.calls
        .filter(([sql]) => sql.includes('commit_provider_proposal_create'))
        .map(([, values]) => values?.[0]),
    ).toEqual([operationId('J'), operationId('K')]);
  });

  it('rolls back callback failures and rejects an escaped transaction handle', async () => {
    const read = poolFor(() => []);
    const workflow = poolFor((sql) =>
      sql.includes('commit_provider_proposal_create')
        ? [{ write_result: 'created' }]
        : [],
    );
    const repository = repositoryFor(
      read.pool,
      workflow.pool,
      operationId('E'),
    );
    let escaped:
      Parameters<Parameters<typeof repository.transaction>[0]>[0] | undefined;

    await expect(
      repository.transaction(async (transaction) => {
        escaped = transaction;
        await transaction.insertProposal({
          proposal,
          preparation,
          scope: createScope,
          event: createdEvent,
        });
        throw new Error('rollback sentinel');
      }),
    ).rejects.toThrow('rollback sentinel');
    await expect(escaped?.getProposal(ids.proposal)).rejects.toThrow(
      'Proposal transaction is closed',
    );
    expect(read.query).toHaveBeenLastCalledWith('rollback');
    expect(workflow.query).toHaveBeenLastCalledWith('rollback');
    expect(read.release).toHaveBeenCalledOnce();
    expect(workflow.release).toHaveBeenCalledOnce();
  });

  it('reports ready only when every public workflow aggregate entrypoint is executable', async () => {
    const read = poolFor(() => []);
    const workflow = poolFor((sql) =>
      sql.includes('has_function_privilege') ? [{ ready: true }] : [],
    );
    const repository = repositoryFor(read.pool, workflow.pool);

    await expect(repository.check()).resolves.toBe(true);

    expect(read.query).not.toHaveBeenCalled();
    const workflowProbe = workflow.query.mock.calls.find(([sql]) =>
      sql.includes('has_function_privilege'),
    );
    expect(workflowProbe?.[0]).toMatch(/\bcoalesce\(/u);
    expect(workflowProbe?.[0]).not.toContain('pg_catalog.coalesce');
    expect(workflowProbe?.[1]?.[0]).toEqual([
      'emdo.commit_provider_proposal_create(text,jsonb)',
      'emdo.commit_provider_proposal_abandonment(jsonb)',
      'emdo.commit_provider_proposal_transition(jsonb)',
      'emdo.commit_provider_proposal_decision(text,jsonb)',
      'emdo.commit_provider_proposal_prepare(text,jsonb)',
      'emdo.commit_provider_proposal_dispatch(text,jsonb)',
      'emdo.commit_provider_proposal_completion(jsonb)',
    ]);
  });

  it('reports unavailable on missing privileges, malformed probes, or backend failure', async () => {
    const readyRead = poolFor(() => []);
    const deniedWorkflow = poolFor((sql) =>
      sql.includes('has_function_privilege') ? [{ ready: false }] : [],
    );
    await expect(
      repositoryFor(readyRead.pool, deniedWorkflow.pool).check(),
    ).resolves.toBe(false);

    const malformedWorkflow = poolFor(() => [{ ready: 'true' }]);
    await expect(
      repositoryFor(readyRead.pool, malformedWorkflow.pool).check(),
    ).resolves.toBe(false);

    const failedPool: DatabasePool = {
      connect: vi.fn(async () => {
        throw new Error('database unavailable');
      }),
    };
    await expect(
      repositoryFor(readyRead.pool, failedPool).check(),
    ).resolves.toBe(false);
  });

  it('requires both the API replay path and the isolated decision-only login', async () => {
    const api = poolFor((sql) =>
      sql.includes('visual_decision_api_readiness') ? [{ ready: true }] : [],
    );
    const decision = poolFor((sql) =>
      sql.includes('visual_decision_commit_readiness') ? [{ ready: true }] : [],
    );

    await expect(
      checkPostgresVisualDecisionReadiness(api.pool, decision.pool),
    ).resolves.toBe(true);

    const apiProbe = api.query.mock.calls.find(([sql]) =>
      sql.includes('visual_decision_api_readiness'),
    )?.[0];
    expect(apiProbe).toContain("session_user = 'emdo_api_login'");
    expect(apiProbe).toContain(
      'emdo.resolve_provider_proposal_decision_replay(uuid,uuid,text,text,uuid)',
    );
    expect(apiProbe).toContain('relforcerowsecurity');
    expect(apiProbe).toMatch(/\bcoalesce\(/u);
    expect(apiProbe).not.toContain('pg_catalog.coalesce');

    const decisionProbe = decision.query.mock.calls.find(([sql]) =>
      sql.includes('visual_decision_commit_readiness'),
    )?.[0];
    expect(decisionProbe).toContain(
      "session_user = 'emdo_visual_decision_login'",
    );
    expect(decisionProbe).toContain(
      'emdo.commit_provider_proposal_decision(text,jsonb)',
    );
    expect(decisionProbe).toContain('has_table_privilege');
    expect(decisionProbe).toContain('pg_auth_members');
    expect(decisionProbe).toMatch(/\bcoalesce\(/u);
    expect(decisionProbe).not.toContain('pg_catalog.coalesce');
  });

  it('stays unavailable when either half of the visual-decision path fails', async () => {
    const readyApi = poolFor(() => [{ ready: true }]);
    const readyDecision = poolFor(() => [{ ready: true }]);
    const deniedApi = poolFor(() => [{ ready: false }]);
    const deniedDecision = poolFor(() => [{ ready: false }]);

    await expect(
      checkPostgresVisualDecisionReadiness(deniedApi.pool, readyDecision.pool),
    ).resolves.toBe(false);
    await expect(
      checkPostgresVisualDecisionReadiness(readyApi.pool, deniedDecision.pool),
    ).resolves.toBe(false);
  });
});

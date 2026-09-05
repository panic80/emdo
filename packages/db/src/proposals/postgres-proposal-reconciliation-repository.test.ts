import {
  ActionProposalSchema,
  ProviderWriteAuthorizationSchema,
} from '@emdo/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import {
  PostgresProposalReconciliationRepository,
  type PostgresProposalReconciliationRepositoryOptions,
} from './postgres-proposal-reconciliation-repository.js';
import type { ProposalRepositoryTransaction } from '@emdo/domains/server/provider-proposals';

type ReconciliationCommitInput = Parameters<
  ProposalRepositoryTransaction['commitReconciliation']
>[0];

const ids = {
  user: '92000000-0000-4000-8000-000000000001',
  session: '92000000-0000-4000-8000-000000000002',
  request: '92000000-0000-4000-8000-000000000003',
  household: '92000000-0000-4000-8000-000000000004',
  run: '92000000-0000-4000-8000-000000000005',
  grant: '92000000-0000-4000-8000-000000000006',
  proposal: '92000000-0000-4000-8000-000000000007',
  decision: '92000000-0000-4000-8000-000000000008',
  attempt: '92000000-0000-4000-8000-000000000009',
  otherAttempt: '92000000-0000-4000-8000-000000000010',
  privateSpace: '92000000-0000-4000-8000-000000000011',
  queue: '92000000-0000-4000-8000-000000000012',
  lease: '92000000-0000-4000-8000-000000000013',
  parentInvocation: '92000000-0000-4000-8000-000000000014',
  agentInvocation: '92000000-0000-4000-8000-000000000015',
  phaseInvocation: '92000000-0000-4000-8000-000000000016',
} as const;

const hash = (character: string) => character.repeat(64);

const proposal = ActionProposalSchema.parse({
  schemaVersion: 1,
  id: ids.proposal,
  version: 4,
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
    invocationContext: {
      orchestrationRunId: ids.run,
      parentInvocationId: ids.parentInvocation,
      agentInvocationId: ids.agentInvocation,
      phaseInvocationId: ids.phaseInvocation,
      actorId: ids.user,
      locale: 'en-CA',
      grantedCapabilities: ['scheduler.calendar.create'],
      disclosedContextRefs: [`context-ref-${hash('1')}`],
      deadline: '2026-08-10T14:10:00.000Z',
      idempotencyScope: hash('2'),
    },
    invocationContextHash: hash('3'),
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
  state: 'indeterminate',
});

const decision = {
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
} as const;

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

const indeterminateCompletion = {
  completion: {
    state: 'indeterminate',
    application: 'indeterminate',
    reason: 'timeout-after-dispatch',
    reconciliationRequired: true,
  },
  bindingHash: authorization.approvalBindingHash,
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
  bindingHash: authorization.approvalBindingHash,
  completionHash: hash('5'),
  completedAt: '2026-08-10T14:04:00.000Z',
} as const;

const reconciliationInput = {
  expected: {
    proposalId: ids.proposal,
    version: 4,
    state: 'indeterminate',
    approvalHash: proposal.approvalHash,
  },
  next: { ...proposal, version: 5, state: 'executed' as const },
  decisionId: ids.decision,
  bindingHash: authorization.approvalBindingHash,
  attemptId: ids.attempt,
  completion: reconciliation,
  event: {
    proposalId: ids.proposal,
    eventType: 'proposal.executed',
    occurredAt: reconciliation.completedAt,
    decisionId: ids.decision,
    approvalHash: proposal.approvalHash,
    application: 'applied',
    outputStatus: 'valid',
    attemptId: ids.attempt,
    attemptVersion: authorization.attemptVersion,
    resultHash: reconciliation.completion.resultHash,
  },
} as const;

const execution = {
  jobName: 'emdo.calendar.reconciliation.v1' as const,
  operationId: 'reconcile:provider-attempt:0001',
  queueJobId: ids.queue,
  payloadHash: hash('9'),
  leaseToken: ids.lease,
  leaseExpiresAt: '2026-08-10T14:15:00.000Z',
};

const poolFor = (
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
  const pool: DatabasePool = { connect: vi.fn(async () => client) };
  return { pool, query, release };
};

const repositoryFor = (
  workerPool: DatabasePool,
  overrides: Partial<PostgresProposalReconciliationRepositoryOptions> = {},
) =>
  new PostgresProposalReconciliationRepository({
    workerPool,
    execution,
    providerAttemptId: ids.attempt,
    ...overrides,
  });

describe('PostgresProposalReconciliationRepository', () => {
  it('keeps bounded reads and the reconciliation commit in one exact worker scope transaction', async () => {
    const worker = poolFor((sql) => {
      if (sql.includes('claim_worker_operation_scope')) {
        return [{ authorized: true }];
      }
      if (sql.includes('from emdo.action_proposals')) {
        return [{ proposal }];
      }
      if (sql.includes('from emdo.action_decisions')) {
        return [{ proposal_id: ids.proposal, decision }];
      }
      if (sql.includes('from emdo.provider_attempts')) {
        return [
          {
            proposal_id: ids.proposal,
            decision_id: ids.decision,
            attempt_state: 'indeterminate',
            binding_hash: authorization.approvalBindingHash,
            authorization,
            dispatched_at: '2026-08-10T14:02:30.000Z',
            completion: indeterminateCompletion,
            reconciliation: null,
          },
        ];
      }
      if (sql.includes('commit_provider_proposal_reconciliation')) {
        return [{ write_result: 'created' }];
      }
      return [];
    });
    const repository = repositoryFor(worker.pool);

    await expect(
      repository.transaction(async (transaction) => {
        const storedProposal = await transaction.getProposal(ids.proposal);
        const storedDecision = await transaction.getDecision(ids.decision);
        const storedAttempt = await transaction.getProviderWriteAttempt(
          ids.decision,
        );
        const result =
          await transaction.commitReconciliation(reconciliationInput);
        return { storedProposal, storedDecision, storedAttempt, result };
      }),
    ).resolves.toMatchObject({
      storedProposal: proposal,
      storedDecision: { proposalId: ids.proposal, decision },
      storedAttempt: {
        proposalId: ids.proposal,
        decisionId: ids.decision,
        attemptState: 'indeterminate',
      },
      result: 'created',
    });

    expect(worker.pool.connect).toHaveBeenCalledOnce();
    const claim = worker.query.mock.calls.find(([sql]) =>
      sql.includes('claim_worker_operation_scope'),
    );
    expect(claim?.[1]).toEqual([
      execution.jobName,
      execution.operationId,
      execution.queueJobId,
      execution.payloadHash,
      execution.leaseToken,
      'provider-attempt',
      ids.attempt,
      null,
      null,
      null,
    ]);
    const commit = worker.query.mock.calls.find(([sql]) =>
      sql.includes('commit_provider_proposal_reconciliation'),
    );
    expect(commit?.[0]).toBe(
      'select emdo.commit_provider_proposal_reconciliation($1::jsonb) as write_result',
    );
    expect(commit?.[1]).toEqual([reconciliationInput]);
    expect(worker.query.mock.calls.at(-1)?.[0]).toBe('commit');
    expect(worker.release).toHaveBeenCalledOnce();
  });

  it('exposes every non-reconciliation mutation as a fail-closed conflict', async () => {
    const worker = poolFor((sql) =>
      sql.includes('claim_worker_operation_scope')
        ? [{ authorized: true }]
        : [],
    );
    const repository = repositoryFor(worker.pool);

    await expect(
      repository.transaction(async (transaction) =>
        Promise.all([
          transaction.insertProposal({} as never),
          transaction.abandonPrepared({} as never),
          transaction.transitionProposal({} as never),
          transaction.commitDecision({} as never),
          transaction.prepareProviderWrite({} as never),
          transaction.markDispatch({} as never),
          transaction.commitPreDispatchCompletion({} as never),
          transaction.commitCompletion({} as never),
        ]),
      ),
    ).resolves.toEqual(Array.from({ length: 8 }, () => 'conflict'));
    expect(
      worker.query.mock.calls.some(([sql]) =>
        sql.includes('commit_provider_proposal_'),
      ),
    ).toBe(false);
  });

  it('fails closed before SQL when reconciliation targets another provider attempt', async () => {
    const worker = poolFor((sql) =>
      sql.includes('claim_worker_operation_scope')
        ? [{ authorized: true }]
        : [],
    );
    const repository = repositoryFor(worker.pool);

    await expect(
      repository.transaction((transaction) =>
        transaction.commitReconciliation({
          ...reconciliationInput,
          attemptId: ids.otherAttempt,
        }),
      ),
    ).resolves.toBe('conflict');
    expect(
      worker.query.mock.calls.some(([sql]) =>
        sql.includes('commit_provider_proposal_reconciliation'),
      ),
    ).toBe(false);
  });

  it('rejects domain-impossible reconciliation envelopes before privileged SQL', async () => {
    const worker = poolFor((sql) =>
      sql.includes('claim_worker_operation_scope')
        ? [{ authorized: true }]
        : sql.includes('commit_provider_proposal_reconciliation')
          ? [{ write_result: 'created' }]
          : [],
    );
    const indeterminate = {
      ...reconciliationInput,
      next: {
        ...reconciliationInput.next,
        state: 'indeterminate' as const,
      },
      completion: indeterminateCompletion,
      event: {
        ...reconciliationInput.event,
        eventType: 'proposal.indeterminate' as const,
        application: 'indeterminate' as const,
        outcomeReason: 'timeout-after-dispatch' as const,
        reconciliationRequired: true as const,
      },
    };
    const preDispatchNotApplied = {
      ...reconciliationInput,
      next: {
        ...reconciliationInput.next,
        state: 'not-applied' as const,
      },
      completion: {
        completion: {
          state: 'not-applied' as const,
          application: 'not-applied' as const,
          reason: 'approval-expired-before-dispatch' as const,
        },
        bindingHash: reconciliationInput.bindingHash,
        completionHash: hash('6'),
        completedAt: reconciliation.completedAt,
      },
      event: {
        ...reconciliationInput.event,
        eventType: 'proposal.not-applied' as const,
        application: 'not-applied' as const,
        outcomeReason: 'approval-expired-before-dispatch' as const,
      },
    };
    const cases: readonly {
      readonly name: string;
      readonly input: ReconciliationCommitInput;
    }[] = [
      { name: 'indeterminate completion', input: indeterminate },
      {
        name: 'pre-dispatch not-applied completion',
        input: preDispatchNotApplied,
      },
      {
        name: 'changed approval hash',
        input: {
          ...reconciliationInput,
          next: { ...reconciliationInput.next, approvalHash: hash('6') },
        },
      },
      {
        name: 'event decision',
        input: {
          ...reconciliationInput,
          event: { ...reconciliationInput.event, decisionId: ids.otherAttempt },
        },
      },
      {
        name: 'event attempt',
        input: {
          ...reconciliationInput,
          event: { ...reconciliationInput.event, attemptId: ids.otherAttempt },
        },
      },
      {
        name: 'event approval hash',
        input: {
          ...reconciliationInput,
          event: { ...reconciliationInput.event, approvalHash: hash('6') },
        },
      },
      {
        name: 'event type',
        input: {
          ...reconciliationInput,
          event: {
            ...reconciliationInput.event,
            eventType: 'proposal.failed',
          },
        },
      },
      {
        name: 'event application',
        input: {
          ...reconciliationInput,
          event: {
            ...reconciliationInput.event,
            application: 'not-applied',
          },
        },
      },
      {
        name: 'event output status',
        input: {
          ...reconciliationInput,
          event: { ...reconciliationInput.event, outputStatus: 'invalid' },
        },
      },
      {
        name: 'event result hash',
        input: {
          ...reconciliationInput,
          event: { ...reconciliationInput.event, resultHash: hash('6') },
        },
      },
      {
        name: 'event evidence hash',
        input: {
          ...reconciliationInput,
          event: { ...reconciliationInput.event, evidenceHash: hash('6') },
        },
      },
      {
        name: 'event occurrence time',
        input: {
          ...reconciliationInput,
          event: {
            ...reconciliationInput.event,
            occurredAt: '2026-08-10T14:05:00.000Z',
          },
        },
      },
      {
        name: 'irrelevant event outcome reason',
        input: {
          ...reconciliationInput,
          event: {
            ...reconciliationInput.event,
            outcomeReason: 'provider-precondition-failed',
          },
        },
      },
    ];

    for (const testCase of cases) {
      const repository = repositoryFor(worker.pool);
      await expect(
        repository.transaction((transaction) =>
          transaction.commitReconciliation(testCase.input),
        ),
        testCase.name,
      ).resolves.toBe('conflict');
    }
    expect(
      worker.query.mock.calls.some(([sql]) =>
        sql.includes('commit_provider_proposal_reconciliation'),
      ),
    ).toBe(false);
  });

  it('rejects persisted preparation references containing control characters', async () => {
    const worker = poolFor((sql) =>
      sql.includes('claim_worker_operation_scope')
        ? [{ authorized: true }]
        : sql.includes('from emdo.proposal_preparations')
          ? [
              {
                preparation: {
                  binding: {
                    proposalId: ids.proposal,
                    originRequestId: ids.request,
                    runId: ids.run,
                    householdId: ids.household,
                    userId: ids.user,
                    agentId: 'scheduler',
                    originSessionId: ids.session,
                    originSpaceAccessGrantId: 'space\u0000grant',
                    disclosureGrantId: ids.grant,
                    disclosurePolicyVersion: '1.0.0',
                    capabilityId: proposal.capabilityId,
                    sdkCallId: proposal.providerSdkCallId,
                    providerAuthorityBindingHash:
                      proposal.providerAuthorityBindingHash,
                  },
                  bindingHash: hash('6'),
                },
              },
            ]
          : [],
    );

    await expect(
      repositoryFor(worker.pool).transaction((transaction) =>
        transaction.getProposalPreparation(ids.proposal),
      ),
    ).rejects.toMatchObject({ code: 'invalid-result' });
  });

  it('rejects a non-reconciliation worker permit before opening a connection', () => {
    const worker = poolFor(() => []);

    expect(() =>
      repositoryFor(worker.pool, {
        execution: {
          ...execution,
          jobName: 'emdo.calendar.sync.v1',
        },
      }),
    ).toThrow(/reconciliation worker permit/u);
    expect(worker.pool.connect).not.toHaveBeenCalled();
  });

  it('freezes the worker facade so trusted repository methods cannot be shadowed', () => {
    const worker = poolFor(() => []);
    const repository = repositoryFor(worker.pool);

    expect(Object.isFrozen(repository)).toBe(true);
    expect(() =>
      Object.defineProperty(repository, 'transaction', {
        value: async () => 'shadowed',
      }),
    ).toThrow(TypeError);
  });

  it('rolls back malformed commit results and closes escaped transaction handles', async () => {
    const worker = poolFor((sql) =>
      sql.includes('claim_worker_operation_scope')
        ? [{ authorized: true }]
        : sql.includes('commit_provider_proposal_reconciliation')
          ? [{ write_result: 'unexpected' }]
          : [],
    );
    const repository = repositoryFor(worker.pool);
    let escaped: ProposalRepositoryTransaction | undefined;

    await expect(
      repository.transaction(async (transaction) => {
        escaped = transaction;
        await transaction.commitReconciliation(reconciliationInput);
      }),
    ).rejects.toMatchObject({ code: 'invalid-result' });
    expect(worker.query).toHaveBeenLastCalledWith('rollback');
    await expect(escaped?.getProposal(ids.proposal)).rejects.toThrow(
      'Proposal reconciliation transaction is closed',
    );
  });
});

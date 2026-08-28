import { describe, expect, it, vi } from 'vitest';

import type { CapabilityInvocationContext } from '@emdo/contracts';
import {
  validateFinanceRecord,
  type FinanceBudgetRecord,
  type FinanceTransactionRecord,
} from '@emdo/domains/finance';
import { hashCanonicalJson } from '@emdo/toolbox';

import { financeGuardedActionCapabilityFingerprint } from '../agents/capability-runtime.js';
import {
  createRequestScopedFinanceSpecialistServices,
  hashFinanceGuardedActionExecutionBinding,
  type FinanceSpecialistDocumentPort,
  type FinanceSpecialistRecordPort,
  type RequestScopedFinanceSpecialistServiceDependencies,
} from './finance-agent-services.js';

const ids = Object.freeze({
  request: '72000000-0000-4000-8000-000000000001',
  run: '72000000-0000-4000-8000-000000000002',
  user: '72000000-0000-4000-8000-000000000003',
  household: '72000000-0000-4000-8000-000000000004',
  session: '72000000-0000-4000-8000-000000000005',
  privateSpace: '72000000-0000-4000-8000-000000000006',
  spaceGrant: '72000000-0000-4000-8000-000000000007',
  disclosureGrant: '72000000-0000-4000-8000-000000000008',
  proposal: '72000000-0000-4000-8000-000000000009',
  decision: '72000000-0000-4000-8000-000000000010',
});

const principal = Object.freeze({
  userId: ids.user,
  sessionId: ids.session,
  householdId: ids.household,
  privateSpaceId: ids.privateSpace,
  role: 'owner' as const,
  emailVerified: true as const,
  spaceAccessGrantId: ids.spaceGrant,
  collectionAuthorizationScopeFingerprint: 'a'.repeat(64),
});

const context = Object.freeze({
  requestId: ids.request,
  runId: ids.run,
  userId: ids.user,
  householdId: ids.household,
  sessionId: ids.session,
  agentId: 'finance',
  locale: 'en-CA',
  spaceAccessGrantId: ids.spaceGrant,
  disclosureGrantId: ids.disclosureGrant,
  abortSignal: new AbortController().signal,
} satisfies CapabilityInvocationContext);

const guardedContext = (input: {
  readonly capabilityId: 'finance.records.write' | 'finance.statement.import';
  readonly operation:
    | 'finance-adjustment'
    | 'finance-reversal'
    | 'finance-statement-import-commit';
  readonly arguments: unknown;
  readonly proposalId?: string;
  readonly decisionId?: string;
  readonly actionHash?: string;
  readonly executionBindingHash?: string;
  readonly capabilityFingerprint?: string;
}) => {
  const proposalId = input.proposalId ?? ids.proposal;
  const decisionId = input.decisionId ?? ids.decision;
  const capabilityFingerprint =
    input.capabilityFingerprint ??
    financeGuardedActionCapabilityFingerprint(input.capabilityId);
  const actionHash = input.actionHash ?? hashCanonicalJson(input.arguments);
  const executionBindingHash =
    input.executionBindingHash ??
    hashFinanceGuardedActionExecutionBinding({
      proposalId,
      scope: {
        runId: ids.run,
        userId: ids.user,
        householdId: ids.household,
        sessionId: ids.session,
        privateSpaceId: ids.privateSpace,
        spaceAccessGrantId: ids.spaceGrant,
        collectionAuthorizationScopeFingerprint:
          principal.collectionAuthorizationScopeFingerprint,
        disclosureGrantId: ids.disclosureGrant,
      },
      capabilityId: input.capabilityId,
      capabilityVersion: '1.0.0',
      capabilityFingerprint,
      operation: input.operation,
      actionHash,
    });
  return Object.freeze({
    ...context,
    approvalDecisionId: decisionId,
    guardedActionPermit: {
      proposalId,
      decisionId,
      capabilityId: input.capabilityId,
      capabilityVersion: '1.0.0' as const,
      capabilityFingerprint,
      operation: input.operation,
      actionHash,
      executionBindingHash,
    },
  } satisfies CapabilityInvocationContext);
};

const ownedTransaction = (
  overrides: Partial<FinanceTransactionRecord> = {},
): FinanceTransactionRecord => {
  const result = validateFinanceRecord({
    schemaVersion: 1,
    id: 'transaction-1',
    spaceId: ids.privateSpace,
    ownerUserId: ids.user,
    createdAt: '2026-08-26T12:00:00.000Z',
    updatedAt: '2026-08-26T12:00:00.000Z',
    recordType: 'transaction',
    accountId: 'account-1',
    categoryId: 'groceries',
    postedOn: '2026-08-26',
    description: 'Groceries',
    annotation: null,
    currency: 'CAD',
    originalAmountCadMinor: -1_299,
    effectiveAmountCadMinor: -1_299,
    adjustments: [],
    reversal: null,
    appliedOperationIds: [],
    source: { kind: 'manual' },
    revision: 0,
    ...overrides,
  });
  if (
    result.status !== 'accepted' ||
    result.record.recordType !== 'transaction'
  ) {
    throw new Error('invalid transaction fixture');
  }
  return result.record;
};

const ownedBudget = (
  overrides: Partial<FinanceBudgetRecord> = {},
): FinanceBudgetRecord => {
  const result = validateFinanceRecord({
    schemaVersion: 1,
    id: 'budget-1',
    spaceId: ids.privateSpace,
    ownerUserId: ids.user,
    createdAt: '2026-08-26T12:00:00.000Z',
    updatedAt: '2026-08-26T12:00:00.000Z',
    recordType: 'budget',
    month: '2026-08',
    currency: 'CAD',
    allocations: [
      { categoryId: 'groceries', amountCadMinor: 30_000 },
      { categoryId: 'rent', amountCadMinor: 150_000 },
    ],
    revision: 4,
    ...overrides,
  });
  if (result.status !== 'accepted' || result.record.recordType !== 'budget') {
    throw new Error('invalid budget fixture');
  }
  return result.record;
};

const documentEvidence = Object.freeze({
  evidenceId: 'evidence-1',
  documentId: 'document-1',
  documentType: 'receipt' as const,
  displayName: 'Example Market receipt',
  page: 1,
  excerpt: 'Groceries 12.99 CAD',
  sourceLocale: 'en-CA' as const,
});

const createDependencies = () => {
  const records = {
    list: vi.fn<FinanceSpecialistRecordPort['list']>(async () => ({
      records: [],
      nextCursor: null,
    })),
    getOwnedRecord: vi.fn<FinanceSpecialistRecordPort['getOwnedRecord']>(
      async () => undefined,
    ),
    getOwnedBudgetForMonth: vi.fn<
      FinanceSpecialistRecordPort['getOwnedBudgetForMonth']
    >(async () => undefined),
    listBudgetTransactions: vi.fn<
      FinanceSpecialistRecordPort['listBudgetTransactions']
    >(async () => [ownedTransaction()]),
    createManualTransaction: vi.fn<
      FinanceSpecialistRecordPort['createManualTransaction']
    >(async (input) => ({
      status: 'applied',
      record: input.record,
      auditEventId: 'audit-event-1',
    })),
    patchOwnedTransaction: vi.fn<
      FinanceSpecialistRecordPort['patchOwnedTransaction']
    >(async (input) => ({
      status: 'applied',
      record: input.record,
      auditEventId: 'audit-event-4',
    })),
    applyTransactionAdjustment: vi.fn<
      FinanceSpecialistRecordPort['applyTransactionAdjustment']
    >(async (input) => ({
      status: 'applied',
      record: input.record,
      auditEventId: 'audit-event-5',
    })),
    applyTransactionReversal: vi.fn<
      FinanceSpecialistRecordPort['applyTransactionReversal']
    >(async (input) => ({
      status: 'applied',
      record: input.record,
      auditEventId: 'audit-event-6',
    })),
    createMonthlyCategoryBudget: vi.fn<
      FinanceSpecialistRecordPort['createMonthlyCategoryBudget']
    >(async (input) => ({
      status: 'applied',
      record: input.record,
      auditEventId: 'audit-event-2',
    })),
    updateMonthlyCategoryBudget: vi.fn<
      FinanceSpecialistRecordPort['updateMonthlyCategoryBudget']
    >(async (input) => ({
      status: 'applied',
      record: input.record,
      auditEventId: 'audit-event-3',
    })),
  } satisfies FinanceSpecialistRecordPort;
  const documents = {
    searchCommitted: vi.fn<FinanceSpecialistDocumentPort['searchCommitted']>(
      async () => [
        {
          documentId: 'document-1',
          documentType: 'receipt',
          displayName: 'Example Market receipt',
          occurredOn: '2026-08-26',
          currency: 'CAD',
          amountMinor: 1_299,
          score: 0.98,
          evidence: [documentEvidence],
        },
      ],
    ),
    readCommitted: vi.fn<FinanceSpecialistDocumentPort['readCommitted']>(
      async () => ({
        document: {
          id: 'document-1',
          documentType: 'receipt',
          displayName: 'Example Market receipt',
          sourceLocale: 'en-CA',
          currency: 'CAD',
          summary: 'A reviewed receipt for groceries.',
          committedAt: '2026-08-26T12:00:00.000Z',
        },
        evidence: [documentEvidence],
      }),
    ),
    listCommittedMatches: vi.fn<
      FinanceSpecialistDocumentPort['listCommittedMatches']
    >(async () => [
      {
        matchId: 'match-1',
        documentId: 'document-1',
        recordId: 'transaction-1',
        recordType: 'transaction',
        state: 'suggested',
        score: 0.98,
        reasons: ['Exact amount and merchant.'],
      },
    ]),
  } satisfies FinanceSpecialistDocumentPort;
  return {
    dependencies: {
      records,
      documents,
      now: () => new Date('2026-08-26T13:00:00.000Z'),
    } satisfies RequestScopedFinanceSpecialistServiceDependencies,
    records,
    documents,
  };
};

describe('request-scoped Finance specialist services', () => {
  it('mints owner-bound deterministic commands for an exact manual transaction only', async () => {
    const { dependencies, records } = createDependencies();
    records.createManualTransaction
      .mockResolvedValueOnce({
        status: 'applied',
        record: ownedTransaction({
          id: 'transaction-2',
          createdAt: '2026-08-26T13:00:00.000Z',
          updatedAt: '2026-08-26T13:00:00.000Z',
        }),
        auditEventId: 'audit-event-1',
      })
      .mockResolvedValueOnce({
        status: 'duplicate',
        record: ownedTransaction({
          id: 'transaction-2',
          createdAt: '2026-08-26T13:00:00.000Z',
          updatedAt: '2026-08-26T13:00:00.000Z',
        }),
        auditEventId: 'audit-event-1',
      });
    const services = createRequestScopedFinanceSpecialistServices({
      principal,
      dependencies,
    });
    const mutation = {
      kind: 'create' as const,
      recordId: 'transaction-2',
      record: {
        recordType: 'transaction' as const,
        accountId: 'account-1',
        categoryId: 'groceries',
        postedOn: '2026-08-26',
        description: 'Groceries',
        amountCadMinor: -1_299,
      },
    };

    const first = (await services.writeFinanceRecord(mutation, context)) as {
      result: {
        status: string;
        record: { id: string; amountCadMinor: number };
      };
    };
    const second = (await services.writeFinanceRecord(mutation, context)) as {
      result: { status: string };
    };

    expect(first.result).toMatchObject({
      status: 'applied',
      record: { id: 'transaction-2', amountCadMinor: -1_299 },
    });
    expect(second.result.status).toBe('duplicate');
    expect(records.createManualTransaction).toHaveBeenCalledTimes(2);
    const firstCommand = records.createManualTransaction.mock.calls[0]?.[0];
    const secondCommand = records.createManualTransaction.mock.calls[1]?.[0];
    expect(firstCommand).toMatchObject({
      scope: {
        requestId: ids.request,
        runId: ids.run,
        userId: ids.user,
        householdId: ids.household,
        sessionId: ids.session,
        privateSpaceId: ids.privateSpace,
        spaceAccessGrantId: ids.spaceGrant,
      },
      audit: {
        eventType: 'finance.agent.safe-write',
        operation: 'manual-transaction-create',
      },
      record: {
        source: { kind: 'manual' },
        adjustments: [],
        reversal: null,
        appliedOperationIds: [],
      },
    });
    expect(firstCommand?.idempotencyKey).toBe(secondCommand?.idempotencyKey);
    expect(firstCommand?.canonicalHash).toBe(secondCommand?.canonicalHash);
    expect(firstCommand).not.toHaveProperty('sql');
    expect(firstCommand).not.toHaveProperty('sourceText');
    expect(firstCommand).not.toHaveProperty('credentials');
  });

  it('applies exact revision-bound transaction metadata edits and categorizes owned imports', async () => {
    const { dependencies, records } = createDependencies();
    const manual = ownedTransaction({ revision: 7 });
    const imported = ownedTransaction({
      id: 'transaction-import-1',
      categoryId: null,
      revision: 3,
      source: {
        kind: 'import',
        sourceHash: 'b'.repeat(64),
        sourceRow: 1,
        fingerprint: 'c'.repeat(64),
        externalId: null,
      },
    });
    records.getOwnedRecord
      .mockResolvedValueOnce(manual)
      .mockResolvedValueOnce(imported);
    const services = createRequestScopedFinanceSpecialistServices({
      principal,
      dependencies,
    });

    const manualResult = (await services.writeFinanceRecord(
      {
        kind: 'patch-transaction',
        transactionId: manual.id,
        expectedRevision: 7,
        patch: {
          description: 'Weekly groceries',
          categoryId: 'household-groceries',
          annotation: 'Bought pantry staples.',
        },
      },
      context,
    )) as { result: { status: string; record: { revision: number } } };
    const importResult = (await services.writeFinanceRecord(
      {
        kind: 'patch-transaction',
        transactionId: imported.id,
        expectedRevision: 3,
        patch: { categoryId: 'household-groceries' },
      },
      context,
    )) as { result: { status: string; record: { revision: number } } };

    expect(manualResult.result).toMatchObject({
      status: 'applied',
      record: { revision: 8 },
    });
    expect(importResult.result).toMatchObject({
      status: 'applied',
      record: { revision: 4 },
    });
    expect(records.patchOwnedTransaction).toHaveBeenCalledTimes(2);
    expect(records.patchOwnedTransaction.mock.calls[0]?.[0]).toMatchObject({
      expectedRevision: 7,
      audit: { operation: 'transaction-nondestructive-patch' },
      record: {
        description: 'Weekly groceries',
        categoryId: 'household-groceries',
        annotation: 'Bought pantry staples.',
        revision: 8,
      },
    });
    expect(records.patchOwnedTransaction.mock.calls[1]?.[0]).toMatchObject({
      expectedRevision: 3,
      record: {
        description: imported.description,
        categoryId: 'household-groceries',
        revision: 4,
        source: { kind: 'import' },
      },
    });
  });

  it('rejects stale transaction edits and proposes imported-description changes', async () => {
    const { dependencies, records } = createDependencies();
    const imported = ownedTransaction({
      revision: 4,
      source: {
        kind: 'import',
        sourceHash: 'b'.repeat(64),
        sourceRow: 1,
        fingerprint: 'c'.repeat(64),
        externalId: null,
      },
    });
    records.getOwnedRecord.mockResolvedValue(imported);
    const services = createRequestScopedFinanceSpecialistServices({
      principal,
      dependencies,
    });

    const stale = (await services.writeFinanceRecord(
      {
        kind: 'patch-transaction',
        transactionId: imported.id,
        expectedRevision: 3,
        patch: { annotation: 'Old edit.' },
      },
      context,
    )) as { result: { status: string; safeError: { code: string } } };
    const description = (await services.writeFinanceRecord(
      {
        kind: 'patch-transaction',
        transactionId: imported.id,
        expectedRevision: 4,
        patch: { description: 'Changed import description' },
      },
      context,
    )) as { result: { status: string; proposal: { operation: string } } };

    expect(stale.result).toMatchObject({
      status: 'rejected',
      safeError: { code: 'operation-rejected' },
    });
    expect(description.result).toMatchObject({
      status: 'confirmation-required',
      proposal: { operation: 'unsupported-finance-write' },
    });
    expect(records.patchOwnedTransaction).not.toHaveBeenCalled();
  });

  it('rejects a forged invocation before it reaches any durable port', async () => {
    const { dependencies, records } = createDependencies();
    const services = createRequestScopedFinanceSpecialistServices({
      principal,
      dependencies,
    });

    await expect(
      services.readFinanceRecords(
        { recordTypes: ['transaction'], limit: 25 },
        { ...context, userId: '72000000-0000-4000-8000-000000000099' },
      ),
    ).rejects.toThrow('api-finance-specialist-request-binding-invalid');
    expect(records.list).not.toHaveBeenCalled();
  });

  it('returns non-mutating typed proposals for reversals, adjustments, and import commits', async () => {
    const { dependencies, records } = createDependencies();
    const services = createRequestScopedFinanceSpecialistServices({
      principal,
      dependencies,
    });

    const reversal = (await services.writeFinanceRecord(
      {
        kind: 'reverse',
        transactionId: 'transaction-1',
        reason: 'Requested reversal',
      },
      context,
    )) as { result: { status: string; proposal: { operation: string } } };
    const adjustment = (await services.writeFinanceRecord(
      {
        kind: 'adjust',
        transactionId: 'transaction-1',
        amountCadMinor: 50,
        reason: 'Correction',
      },
      context,
    )) as { result: { status: string; proposal: { operation: string } } };
    const commit = (await services.executeStatementImport(
      { kind: 'commit', planId: 'plan-1' },
      context,
    )) as { result: { status: string; proposal: { operation: string } } };

    expect(reversal.result).toMatchObject({
      status: 'confirmation-required',
      proposal: { state: 'proposed', operation: 'finance-reversal' },
    });
    expect(adjustment.result.proposal.operation).toBe('finance-adjustment');
    expect(commit.result.proposal.operation).toBe(
      'finance-statement-import-commit',
    );
    expect(records.createManualTransaction).not.toHaveBeenCalled();
    expect(records.updateMonthlyCategoryBudget).not.toHaveBeenCalled();
  });

  it('executes one approved adjustment and reversal through distinct receipt operations', async () => {
    const { dependencies, records } = createDependencies();
    const adjustmentCurrent = ownedTransaction({ revision: 2 });
    const reversalCurrent = ownedTransaction({
      id: 'transaction-2',
      revision: 5,
    });
    records.getOwnedRecord
      .mockResolvedValueOnce(adjustmentCurrent)
      .mockResolvedValueOnce(adjustmentCurrent)
      .mockResolvedValueOnce(reversalCurrent);
    records.applyTransactionAdjustment
      .mockImplementationOnce(async (input) => ({
        status: 'applied',
        record: input.record,
        auditEventId: 'audit-event-5',
      }))
      .mockImplementationOnce(async (input) => ({
        status: 'duplicate',
        record: input.record,
        auditEventId: 'audit-event-5',
      }));
    const guardedDependencies = {
      ...dependencies,
      guardedActionCapabilityFingerprints: {
        recordsWrite: financeGuardedActionCapabilityFingerprint(
          'finance.records.write',
        ),
        statementImport: financeGuardedActionCapabilityFingerprint(
          'finance.statement.import',
        ),
      },
    } satisfies RequestScopedFinanceSpecialistServiceDependencies;
    const services = createRequestScopedFinanceSpecialistServices({
      principal,
      dependencies: guardedDependencies,
    });
    const adjustment = {
      kind: 'adjust' as const,
      transactionId: adjustmentCurrent.id,
      amountCadMinor: 50,
      reason: 'Correct the receipt total.',
    };
    const adjustmentArguments = { schemaVersion: 1, mutation: adjustment };
    const adjustmentContext = guardedContext({
      capabilityId: 'finance.records.write',
      operation: 'finance-adjustment',
      arguments: adjustmentArguments,
    });

    const first = (await services.writeFinanceRecord(
      adjustment,
      adjustmentContext,
    )) as { result: { status: string; record: { amountCadMinor: number } } };
    const replay = (await services.writeFinanceRecord(
      adjustment,
      adjustmentContext,
    )) as { result: { status: string } };
    const reversal = {
      kind: 'reverse' as const,
      transactionId: reversalCurrent.id,
      reason: 'Reverse a duplicate statement line.',
    };
    const reversalResult = (await services.writeFinanceRecord(
      reversal,
      guardedContext({
        capabilityId: 'finance.records.write',
        operation: 'finance-reversal',
        arguments: { schemaVersion: 1, mutation: reversal },
        proposalId: '72000000-0000-4000-8000-000000000011',
        decisionId: '72000000-0000-4000-8000-000000000012',
      }),
    )) as { result: { status: string; record: { amountCadMinor: number } } };

    expect(first.result).toMatchObject({
      status: 'applied',
      record: { amountCadMinor: -1_249 },
    });
    expect(replay.result.status).toBe('duplicate');
    expect(reversalResult.result).toMatchObject({
      status: 'applied',
      record: { amountCadMinor: 0 },
    });
    expect(records.applyTransactionAdjustment).toHaveBeenCalledTimes(2);
    expect(records.applyTransactionAdjustment.mock.calls[0]?.[0]).toMatchObject(
      {
        operationId: ids.proposal,
        expectedRevision: 2,
        audit: { operation: 'finance-transaction-adjustment' },
        idempotencyKey: `finance-guarded:${ids.proposal}`,
        record: {
          effectiveAmountCadMinor: -1_249,
          adjustments: [
            {
              operationId: ids.proposal,
              amountCadMinor: 50,
            },
          ],
          revision: 3,
        },
      },
    );
    expect(records.applyTransactionReversal).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: '72000000-0000-4000-8000-000000000011',
        expectedRevision: 5,
        audit: expect.objectContaining({
          operation: 'finance-transaction-reversal',
        }),
        record: expect.objectContaining({
          effectiveAmountCadMinor: 0,
          reversal: expect.objectContaining({
            operationId: '72000000-0000-4000-8000-000000000011',
          }),
          revision: 6,
        }),
      }),
    );
  });

  it('fails closed on a tampered permit and commits an approved stored import plan once', async () => {
    const { dependencies, records } = createDependencies();
    const commit = vi.fn(async () => ({
      schemaVersion: 1 as const,
      status: 'committed' as const,
      receipt: {
        id: 'import-receipt-1',
        planId: 'plan-1',
        transactionCount: 2,
        verified: true as const,
      },
      sourceDeletionAuthorized: true as const,
    }));
    const guardedDependencies = {
      ...dependencies,
      imports: { commit },
      guardedActionCapabilityFingerprints: {
        recordsWrite: financeGuardedActionCapabilityFingerprint(
          'finance.records.write',
        ),
        statementImport: financeGuardedActionCapabilityFingerprint(
          'finance.statement.import',
        ),
      },
    } satisfies RequestScopedFinanceSpecialistServiceDependencies;
    const services = createRequestScopedFinanceSpecialistServices({
      principal,
      dependencies: guardedDependencies,
    });
    const mutation = {
      kind: 'adjust' as const,
      transactionId: 'transaction-1',
      amountCadMinor: 50,
      reason: 'Correct the receipt total.',
    };
    const tampered = (await services.writeFinanceRecord(
      mutation,
      guardedContext({
        capabilityId: 'finance.records.write',
        operation: 'finance-adjustment',
        arguments: { schemaVersion: 1, mutation },
        actionHash: 'f'.repeat(64),
      }),
    )) as { result: { status: string; safeError: { code: string } } };
    const request = { kind: 'commit' as const, planId: 'plan-1' };
    const committed = (await services.executeStatementImport(
      request,
      guardedContext({
        capabilityId: 'finance.statement.import',
        operation: 'finance-statement-import-commit',
        arguments: { schemaVersion: 1, request },
        proposalId: '72000000-0000-4000-8000-000000000013',
        decisionId: '72000000-0000-4000-8000-000000000014',
      }),
    )) as {
      result: { status: string; receipt: { planId: string } };
    };

    expect(tampered.result).toMatchObject({
      status: 'rejected',
      safeError: { code: 'service-unavailable' },
    });
    expect(records.applyTransactionAdjustment).not.toHaveBeenCalled();
    expect(committed.result).toMatchObject({
      status: 'committed',
      receipt: { planId: 'plan-1' },
    });
    expect(commit).toHaveBeenCalledWith({
      planId: 'plan-1',
      idempotencyKey: 'finance-guarded:72000000-0000-4000-8000-000000000013',
      principal,
      requestId: ids.request,
    });
  });

  it('accepts a v2 permit after grant renewal but rejects changed durable bindings', async () => {
    const { dependencies } = createDependencies();
    const commit = vi.fn(async () => ({
      schemaVersion: 1 as const,
      status: 'committed' as const,
      receipt: {
        id: 'import-receipt-1',
        planId: 'plan-1',
        transactionCount: 2,
        verified: true as const,
      },
      sourceDeletionAuthorized: true as const,
    }));
    const Gturn = ids.spaceGrant;
    const Gresume = '72000000-0000-4000-8000-000000000015';
    const capabilityFingerprint = financeGuardedActionCapabilityFingerprint(
      'finance.statement.import',
    );
    const request = { kind: 'commit' as const, planId: 'plan-1' };
    const preparedScope = {
      runId: ids.run,
      userId: ids.user,
      householdId: ids.household,
      sessionId: ids.session,
      privateSpaceId: ids.privateSpace,
      spaceAccessGrantId: Gturn,
      collectionAuthorizationScopeFingerprint:
        principal.collectionAuthorizationScopeFingerprint,
      disclosureGrantId: ids.disclosureGrant,
    };
    const permit = {
      proposalId: ids.proposal,
      decisionId: ids.decision,
      capabilityId: 'finance.statement.import' as const,
      capabilityVersion: '1.0.0' as const,
      capabilityFingerprint,
      operation: 'finance-statement-import-commit' as const,
      actionHash: hashCanonicalJson({ schemaVersion: 1, request }),
      executionBindingHash: hashFinanceGuardedActionExecutionBinding({
        proposalId: ids.proposal,
        scope: preparedScope,
        capabilityId: 'finance.statement.import',
        capabilityVersion: '1.0.0',
        capabilityFingerprint,
        operation: 'finance-statement-import-commit',
        actionHash: hashCanonicalJson({ schemaVersion: 1, request }),
      }),
    };
    const guardedDependencies = {
      ...dependencies,
      imports: { commit },
      guardedActionCapabilityFingerprints: {
        recordsWrite: financeGuardedActionCapabilityFingerprint(
          'finance.records.write',
        ),
        statementImport: capabilityFingerprint,
      },
    } satisfies RequestScopedFinanceSpecialistServiceDependencies;
    const resumedPrincipal = {
      ...principal,
      spaceAccessGrantId: Gresume,
    };
    const resumedContext = {
      ...context,
      spaceAccessGrantId: Gresume,
      approvalDecisionId: ids.decision,
      guardedActionPermit: permit,
    } satisfies CapabilityInvocationContext;
    const resumedServices = createRequestScopedFinanceSpecialistServices({
      principal: resumedPrincipal,
      dependencies: guardedDependencies,
    });

    const resumed = (await resumedServices.executeStatementImport(
      request,
      resumedContext,
    )) as { result: { status: string } };
    expect(resumed.result.status).toBe('committed');
    expect(commit).toHaveBeenCalledOnce();

    const legacyExecutionBindingHash = hashCanonicalJson({
      schemaVersion: 1,
      domain: 'emdo.finance-guarded-action-execution-binding.v1',
      proposalId: ids.proposal,
      runId: preparedScope.runId,
      householdId: preparedScope.householdId,
      userId: preparedScope.userId,
      authenticatedSessionId: preparedScope.sessionId,
      privateSpaceId: preparedScope.privateSpaceId,
      spaceAccessGrantId: preparedScope.spaceAccessGrantId,
      authorizationScopeFingerprint:
        preparedScope.collectionAuthorizationScopeFingerprint,
      disclosureGrantId: preparedScope.disclosureGrantId,
      capabilityId: permit.capabilityId,
      capabilityVersion: permit.capabilityVersion,
      capabilityFingerprint: permit.capabilityFingerprint,
      operation: permit.operation,
      actionHash: permit.actionHash,
    });
    const legacy = (await createRequestScopedFinanceSpecialistServices({
      principal,
      dependencies: guardedDependencies,
    }).executeStatementImport(request, {
      ...context,
      approvalDecisionId: ids.decision,
      guardedActionPermit: {
        ...permit,
        executionBindingHash: legacyExecutionBindingHash,
      },
    })) as { result: { status: string; safeError: { code: string } } };

    const scopeChangedServices = createRequestScopedFinanceSpecialistServices({
      principal: {
        ...resumedPrincipal,
        collectionAuthorizationScopeFingerprint: 'b'.repeat(64),
      },
      dependencies: guardedDependencies,
    });
    const changedScope = (await scopeChangedServices.executeStatementImport(
      request,
      resumedContext,
    )) as { result: { status: string; safeError: { code: string } } };
    const changedDisclosure = (await resumedServices.executeStatementImport(
      request,
      {
        ...resumedContext,
        disclosureGrantId: '72000000-0000-4000-8000-000000000016',
      },
    )) as { result: { status: string; safeError: { code: string } } };
    const changedAction = (await resumedServices.executeStatementImport(
      { kind: 'commit', planId: 'plan-2' },
      resumedContext,
    )) as { result: { status: string; safeError: { code: string } } };

    expect(changedScope.result).toMatchObject({
      status: 'rejected',
      safeError: { code: 'service-unavailable' },
    });
    expect(legacy.result).toMatchObject({
      status: 'rejected',
      safeError: { code: 'service-unavailable' },
    });
    expect(changedDisclosure.result).toMatchObject({
      status: 'rejected',
      safeError: { code: 'service-unavailable' },
    });
    expect(changedAction.result).toMatchObject({
      status: 'rejected',
      safeError: { code: 'service-unavailable' },
    });
    expect(commit).toHaveBeenCalledOnce();
  });

  it('allows one exact monthly category budget change and proposes bulk replacements', async () => {
    const { dependencies, records } = createDependencies();
    const current = ownedBudget();
    records.getOwnedRecord.mockResolvedValue(current);
    records.updateMonthlyCategoryBudget.mockImplementation(async (input) => ({
      status: 'applied',
      record: input.record,
      auditEventId: 'audit-event-3',
    }));
    const services = createRequestScopedFinanceSpecialistServices({
      principal,
      dependencies,
    });

    const exact = (await services.writeFinanceRecord(
      {
        kind: 'update',
        recordId: current.id,
        replacement: {
          recordType: 'budget',
          month: current.month,
          allocations: [
            { categoryId: 'groceries', amountCadMinor: 35_000 },
            { categoryId: 'rent', amountCadMinor: 150_000 },
          ],
        },
      },
      context,
    )) as { result: { status: string; record: { revision: number } } };
    const bulk = (await services.writeFinanceRecord(
      {
        kind: 'update',
        recordId: current.id,
        replacement: {
          recordType: 'budget',
          month: current.month,
          allocations: [
            { categoryId: 'groceries', amountCadMinor: 35_000 },
            { categoryId: 'rent', amountCadMinor: 160_000 },
          ],
        },
      },
      context,
    )) as { result: { status: string; proposal?: { operation: string } } };

    expect(exact.result).toMatchObject({
      status: 'applied',
      record: { revision: 5 },
    });
    expect(records.updateMonthlyCategoryBudget).toHaveBeenCalledOnce();
    expect(records.updateMonthlyCategoryBudget).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 4,
        audit: expect.objectContaining({
          operation: 'monthly-category-budget-update',
        }),
      }),
    );
    expect(bulk.result).toMatchObject({
      status: 'confirmation-required',
      proposal: { operation: 'ambiguous-or-bulk-finance-write' },
    });
  });

  it('uses only reviewed statement plan IDs and committed document ports', async () => {
    const { dependencies, documents } = createDependencies();
    const services = createRequestScopedFinanceSpecialistServices({
      principal,
      dependencies,
    });

    const commit = await services.executeStatementImport(
      { kind: 'commit', planId: 'reviewed-plan-1' },
      context,
    );
    const document = await services.readFinanceDocument(
      { documentId: 'document-1', evidenceIds: ['evidence-1'] },
      context,
    );
    const matches = await services.readFinanceMatches(
      { documentId: 'document-1', states: ['suggested'], limit: 25 },
      context,
    );

    expect(commit).toMatchObject({
      result: {
        status: 'confirmation-required',
        proposal: { operation: 'finance-statement-import-commit' },
      },
    });
    expect(commit).not.toHaveProperty('sourceText');
    expect(commit).not.toHaveProperty('path');
    expect(document).toMatchObject({ document: { id: 'document-1' } });
    expect(matches).toMatchObject({
      matches: [expect.objectContaining({ state: 'suggested' })],
    });
    expect(documents.readCommitted).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: expect.objectContaining({ privateSpaceId: ids.privateSpace }),
        documentId: 'document-1',
      }),
    );
    expect(documents.listCommittedMatches).toHaveBeenCalledOnce();
  });

  it('excludes an unowned budget input before deterministic integer totals can run', async () => {
    const { dependencies, records } = createDependencies();
    records.listBudgetTransactions.mockResolvedValue([
      ownedTransaction({ ownerUserId: 'other-user' }),
    ]);
    const services = createRequestScopedFinanceSpecialistServices({
      principal,
      dependencies,
    });

    await expect(
      services.loadFinanceBudgetInputs({ month: '2026-08' }, context),
    ).rejects.toThrow('api-finance-specialist-budget-inputs-unavailable');
    expect(records.listBudgetTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ reviewedCommittedEvidenceOnly: true }),
    );
  });
});

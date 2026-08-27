import { describe, expect, it, vi } from 'vitest';

import {
  ALL_MANAGER_DELEGATION_CAPABILITY_IDS,
  ALL_SPECIALIST_CAPABILITY_IDS,
  FINANCE_V1_CAPABILITY_IDS,
  PROVIDER_WRITE_CAPABILITY_IDS,
  createProductionCapabilityRuntime,
} from './capability-runtime.js';
import {
  createFinanceV1ProductionCapabilityBindings,
  createProductionCapabilityBindings,
  type TrustedProductionCapabilityServices,
  type TrustedProviderWriteCapabilityBindings,
} from './production-bindings.js';

const instant = '2026-08-11T14:00:00.000Z';
const safeError = {
  code: 'operation-rejected',
  message: 'The operation was rejected.',
  retryable: false,
} as const;
const providerWriteSafety = Object.freeze({
  atomicConditions: 'provider-native-single-request' as const,
  idempotency: 'deterministic-resource-id' as const,
  retryOwnership: 'adapter-bounded-within-invocation' as const,
  reconciliation: 'required' as const,
});

const createProviderBinding = () => ({
  executeProviderWrite: vi.fn(async () => ({
    application: 'applied' as const,
    output: {
      schemaVersion: 1,
      result: {
        status: 'applied',
        providerRequestId: null,
        reconciled: false,
        readbackCalendarVersion: 'calendar-etag-1',
        readback: null,
      },
    },
    readback: { status: 'verified' },
  })),
  materializeProposal: vi.fn(async () => {
    throw new Error('not-exercised');
  }),
  providerWriteSafety,
});

const createServices = (): TrustedProductionCapabilityServices => {
  const providerWrites = {
    'google-calendar.event.create': createProviderBinding(),
    'google-calendar.event.update': createProviderBinding(),
    'google-calendar.event.delete': createProviderBinding(),
  } satisfies TrustedProviderWriteCapabilityBindings;
  return {
    specialists: {
      readCalendarFreeBusy: vi.fn(async () => ({
        calendarRefs: [],
        blocks: [],
        snapshots: [],
      })),
      readTasks: vi.fn(async () => ({ tasks: [], nextCursor: null })),
      writeTask: vi.fn(async () => ({
        result: { status: 'rejected', task: null, safeError },
      })),
      resolveTravelTime: vi.fn(async () => ({
        travelMinutes: 0,
        totalBufferMinutes: 0,
        source: 'same-location',
        fetchedAt: null,
      })),
      readFinanceRecords: vi.fn(async () => ({
        records: [],
        nextCursor: null,
      })),
      writeFinanceRecord: vi.fn(async () => ({
        result: { status: 'rejected', record: null, safeError },
      })),
      executeStatementImport: vi.fn(async () => ({
        result: {
          status: 'confirmation-required',
          proposal: {
            state: 'proposed',
            operation: 'finance-statement-import-commit',
            channel: 'emdo-authenticated-visual',
            canonicalHash: 'a'.repeat(64),
          },
        },
      })),
      loadFinanceBudgetInputs: vi.fn(async () => ({
        spaceId: 'space-1',
        transactions: [],
      })),
      searchFinanceDocuments: vi.fn(async () => ({
        hits: [
          {
            documentId: 'document-1',
            documentType: 'receipt' as const,
            displayName: 'Example Market receipt',
            occurredOn: '2026-08-11',
            currency: 'CAD',
            amountMinor: 1_299,
            score: 0.98,
            evidence: [
              {
                evidenceId: 'evidence-1',
                documentId: 'document-1',
                documentType: 'receipt' as const,
                displayName: 'Example Market receipt',
                page: 1,
                excerpt: 'Groceries 12.99 CAD',
                sourceLocale: 'en-CA' as const,
              },
            ],
          },
        ],
      })),
      readFinanceDocument: vi.fn(async () => ({
        document: {
          id: 'document-1',
          documentType: 'receipt' as const,
          displayName: 'Example Market receipt',
          sourceLocale: 'en-CA' as const,
          currency: 'CAD',
          summary: 'A receipt for groceries totaling 12.99 CAD.',
          committedAt: instant,
        },
        evidence: [
          {
            evidenceId: 'evidence-1',
            documentId: 'document-1',
            documentType: 'receipt' as const,
            displayName: 'Example Market receipt',
            page: 1,
            excerpt: 'Groceries 12.99 CAD',
            sourceLocale: 'en-CA' as const,
          },
        ],
      })),
      readFinanceMatches: vi.fn(async () => ({
        matches: [
          {
            matchId: 'match-1',
            documentId: 'document-1',
            recordId: 'transaction-1',
            recordType: 'transaction' as const,
            state: 'suggested' as const,
            score: 0.98,
            reasons: ['Amount and merchant match the transaction.'],
          },
        ],
      })),
      readShoppingItems: vi.fn(async () => ({
        items: [],
        nextCursor: null,
      })),
      writeShoppingItem: vi.fn(async () => ({
        result: { status: 'rejected', item: null, safeError },
      })),
      readOffers: vi.fn(async () => ({
        offers: [],
        observedAt: instant,
        unknownCosts: [],
      })),
      refreshOffers: vi.fn(async () => ({
        status: 'blocked',
        safeError,
      })),
      prepareLinkOut: vi.fn(async () => ({
        status: 'rejected',
        safeError: {
          code: 'retailer-link-unsafe',
          message: 'The retailer link is unavailable.',
          retryable: false,
        },
      })),
    },
    providerWrites,
    delegations: {
      'agent.scheduler.delegate': vi.fn(async () => ({
        summary: 'Scheduler delegated.',
      })),
      'agent.finance.delegate': vi.fn(async () => ({
        summary: 'Finance delegated.',
      })),
      'agent.shopping.delegate': vi.fn(async () => ({
        summary: 'Shopping delegated.',
      })),
    },
  };
};

const approvalStore = {
  acquire: vi.fn(async () => ({ status: 'not-found' as const })),
  markDispatching: vi.fn(async () => ({ status: 'not-found' as const })),
  finalize: vi.fn(async () => 'not-found' as const),
  reconcile: vi.fn(async () => 'not-found' as const),
};

const authorityResolver = {
  resolve: vi.fn(async () => ({
    authorityBinding: {
      kind: 'google-calendar-grant-v2' as const,
      householdId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f001',
      privateSpaceId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f002',
      authorizationScopeFingerprint: 'e'.repeat(64),
      providerGrantReference: 'provider-grant-1',
      authorizationEpoch: 1,
    },
    operationScope: {
      requestId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f003',
      sessionId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f004',
      householdId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f001',
      userId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f005',
      spaceAccessGrantId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f006',
      authorizationScopeFingerprint: 'e'.repeat(64),
    },
  })),
};

describe('production capability bindings', () => {
  it('binds all 19 exact capabilities without a generic invoke dispatcher', async () => {
    const services = createServices();
    const bindings = createProductionCapabilityBindings(services);

    expect(Object.keys(bindings).sort()).toEqual(
      [
        ...ALL_SPECIALIST_CAPABILITY_IDS,
        ...ALL_MANAGER_DELEGATION_CAPABILITY_IDS,
      ].sort(),
    );
    for (const capabilityId of PROVIDER_WRITE_CAPABILITY_IDS) {
      const capabilityKey = capabilityId as keyof typeof bindings;
      expect(bindings[capabilityKey].kind).toBe('provider-write');
    }
    for (const capabilityId of ALL_MANAGER_DELEGATION_CAPABILITY_IDS) {
      expect(bindings[capabilityId].kind).toBe('delegation');
    }

    const taskRead = bindings['scheduler.tasks.read'];
    if (taskRead.kind !== 'read') throw new Error('invalid-test-binding');
    await expect(
      taskRead.execute(
        { schemaVersion: 1, status: 'open', limit: 25 },
        {
          requestId: 'request-1',
          runId: 'run-1',
          userId: 'user-1',
          sessionId: 'session-1',
          householdId: 'household-1',
          agentId: 'scheduler',
          locale: 'en-CA',
          spaceAccessGrantId: 'space-grant-1',
          abortSignal: new AbortController().signal,
        },
      ),
    ).resolves.toEqual({
      schemaVersion: 1,
      tasks: [],
      nextCursor: null,
    });
    expect(services.specialists.readTasks).toHaveBeenCalledWith(
      {
        status: 'open',
        dueBefore: undefined,
        cursor: undefined,
        limit: 25,
      },
      expect.objectContaining({ agentId: 'scheduler' }),
    );
  });

  it('binds the exact seven Finance v1 specialist capabilities', () => {
    const services = createServices();
    const bindings = createFinanceV1ProductionCapabilityBindings({
      schedulerDelegation: services.delegations['agent.scheduler.delegate'],
      financeDelegation: services.delegations['agent.finance.delegate'],
      calendarEventCreate: createProviderBinding(),
      finance: services.specialists,
    });

    const financeCapabilityIds = FINANCE_V1_CAPABILITY_IDS.filter((id) =>
      id.startsWith('finance.'),
    );
    expect(financeCapabilityIds).toHaveLength(7);
    expect(Object.keys(bindings).sort()).toEqual(
      [...FINANCE_V1_CAPABILITY_IDS].sort(),
    );
    expect(bindings['finance.analytics.calculate'].kind).toBe('read');
    expect(bindings['finance.documents.search'].kind).toBe('read');
    expect(bindings['finance.documents.read'].kind).toBe('read');
    expect(bindings['finance.matches.read'].kind).toBe('read');
  });

  it('leaves safe Finance writes direct and fails guarded writes closed without a durable proposal materializer', async () => {
    const services = createServices();
    const bindings = createFinanceV1ProductionCapabilityBindings({
      schedulerDelegation: services.delegations['agent.scheduler.delegate'],
      financeDelegation: services.delegations['agent.finance.delegate'],
      calendarEventCreate: createProviderBinding(),
      finance: services.specialists,
    });
    const materialize = bindings['finance.records.write'].materializeProposal!;
    const base = {
      capabilityId: 'finance.records.write',
      descriptor: {} as never,
      authorityBinding: {} as never,
      context: {} as never,
    };

    await expect(
      materialize({
        ...base,
        arguments: {
          schemaVersion: 1,
          mutation: {
            kind: 'create',
            recordId: 'transaction-1',
            record: {
              recordType: 'transaction',
              accountId: 'account-1',
              categoryId: null,
              postedOn: '2026-08-11',
              description: 'Groceries',
              amountCadMinor: -1_299,
            },
          },
        },
      } as never),
    ).resolves.toBeUndefined();
    await expect(
      materialize({
        ...base,
        arguments: {
          schemaVersion: 1,
          mutation: {
            kind: 'adjust',
            transactionId: 'transaction-1',
            amountCadMinor: 50,
            reason: 'Correct the receipt total.',
          },
        },
      } as never),
    ).rejects.toThrow('api-finance-guarded-action-unavailable');
  });

  it('requires exact per-capability provider and delegation maps', () => {
    const missingProvider = createServices() as unknown as {
      providerWrites: Record<string, unknown>;
    };
    delete missingProvider.providerWrites['google-calendar.event.delete'];
    expect(() =>
      createProductionCapabilityBindings(missingProvider as never),
    ).toThrow('api-provider-capability-bindings-invalid');

    const permissiveSafety = createServices() as unknown as {
      providerWrites: Record<
        string,
        { providerWriteSafety: Record<string, unknown> }
      >;
    };
    permissiveSafety.providerWrites[
      'google-calendar.event.create'
    ]!.providerWriteSafety = {
      ...providerWriteSafety,
      idempotency: 'none',
    };
    expect(() =>
      createProductionCapabilityBindings(permissiveSafety as never),
    ).toThrow(
      'api-provider-capability-binding-invalid:google-calendar.event.create',
    );

    const extraDelegation = createServices() as unknown as {
      delegations: Record<string, unknown>;
    };
    extraDelegation.delegations['raw-calendar-client'] = vi.fn();
    expect(() =>
      createProductionCapabilityBindings(extraDelegation as never),
    ).toThrow('api-delegation-capability-bindings-invalid');
  });

  it('is accepted by the deny-by-default production runtime', () => {
    const bindings = createProductionCapabilityBindings(createServices());
    expect(() =>
      createProductionCapabilityRuntime({
        bindings,
        providerWriteApprovalStore: approvalStore,
        trustedProviderWriteAuthorityResolver: authorityResolver,
        trustedProviderProposalAuthorityResolver: authorityResolver,
      }),
    ).not.toThrow();
  });
});

import { describe, expect, it, vi } from 'vitest';

import {
  ALL_MANAGER_DELEGATION_CAPABILITY_IDS,
  ALL_SPECIALIST_CAPABILITY_IDS,
  PROVIDER_WRITE_CAPABILITY_IDS,
  createProductionCapabilityRuntime,
} from './capability-runtime.js';
import {
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
          status: 'preview-ready',
          previewId: 'preview-1',
          acceptedRows: 0,
          rejectedRows: 0,
          duplicateRows: 0,
        },
      })),
      loadFinanceBudgetInputs: vi.fn(async () => ({
        spaceId: 'space-1',
        transactions: [],
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

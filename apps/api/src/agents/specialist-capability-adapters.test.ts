import { describe, expect, it, vi } from 'vitest';

import type { CapabilityInvocationContext } from '@emdo/contracts';

import {
  parseSpecialistCapabilityOutput,
  specialistCapabilitySchemas,
} from './capability-runtime.js';
import {
  createStandardSpecialistCapabilityExecutors,
  materializeFinanceLedgerOperation,
  materializeFinanceRecordCreate,
  type StandardSpecialistCapabilityId,
  type TrustedStandardSpecialistServices,
} from './specialist-capability-adapters.js';

const instant = '2026-08-11T14:00:00.000Z';
const laterInstant = '2026-08-11T15:00:00.000Z';
const safeError = {
  code: 'operation-rejected',
  message: 'The operation was rejected.',
  retryable: false,
} as const;

const context: CapabilityInvocationContext = Object.freeze({
  requestId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f101',
  runId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f102',
  userId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f103',
  sessionId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f105',
  householdId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f106',
  agentId: 'scheduler',
  locale: 'en-CA',
  spaceAccessGrantId: 'opaque-space-access-grant',
  disclosureGrantId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f104',
  abortSignal: new AbortController().signal,
});

const transaction = Object.freeze({
  schemaVersion: 1 as const,
  id: 'transaction-1',
  spaceId: 'private-space-1',
  ownerUserId: 'owner-user-1',
  createdAt: '2026-08-10T12:00:00.000Z',
  updatedAt: '2026-08-10T12:00:00.000Z',
  recordType: 'transaction' as const,
  accountId: 'account-1',
  categoryId: 'groceries',
  postedOn: '2026-08-11',
  description: 'Groceries',
  currency: 'CAD' as const,
  originalAmountCadMinor: -1_299,
  effectiveAmountCadMinor: -1_299,
  adjustments: [],
  reversal: null,
  appliedOperationIds: [],
  source: { kind: 'manual' as const },
});

const offer = Object.freeze({
  schemaVersion: 1 as const,
  id: 'offer-1',
  version: 1,
  provider: 'official-feed',
  merchant: { id: 'merchant-1', name: 'Example Market' },
  product: { id: 'product-1', title: 'Whole milk' },
  variant: { id: 'variant-1', title: '2 litres' },
  price: { minorUnits: 499, currency: 'CAD' as const },
  shipping: { status: 'unknown' as const, reason: 'Calculated at handoff.' },
  availabilityScope: { kind: 'online' as const },
  sourceUrl: 'https://retailer.example/products/milk',
  upstreamAt: '2026-08-11T14:00:00.000Z',
  fetchedAt: '2026-08-11T14:00:00.000Z',
  expiresAt: '2026-08-11T15:00:00.000Z',
  comparisonPermission: 'allowed' as const,
});

const handoffOffer = Object.freeze({
  offer,
  costs: {
    item: {
      status: 'known' as const,
      minorUnits: 499,
      currency: 'CAD' as const,
    },
    shipping: {
      status: 'unknown' as const,
      reason: 'Calculated at handoff.',
    },
    tax: { status: 'unknown' as const, reason: 'Calculated at handoff.' },
    fees: { status: 'not-applicable' as const },
    membership: { status: 'not-applicable' as const },
    unknown: [
      { component: 'shipping' as const, reason: 'Calculated at handoff.' },
      { component: 'tax' as const, reason: 'Calculated at handoff.' },
    ],
  },
  stock: {
    status: 'unknown' as const,
    reason: 'The connector did not provide verified inventory.' as const,
  },
  handoff: {
    url: 'https://retailer.example/products/milk',
    rel: 'noopener noreferrer external' as const,
  },
});

const calendarBlocks = Array.from({ length: 201 }, (_, index) => ({
  calendarRef: 'calendar-1',
  eventRef: `event-${index + 1}`,
  fetchedAt: instant,
  start: instant,
  end: laterInstant,
  details: null,
  maskReason: 'free-busy-only' as const,
}));

const documentEvidence = Object.freeze({
  evidenceId: 'evidence-1',
  documentId: 'document-1',
  documentType: 'receipt' as const,
  displayName: 'Example Market receipt',
  page: 1,
  excerpt: 'Groceries 12.99 CAD',
  sourceLocale: 'en-CA' as const,
});

const createServices = () =>
  ({
    readCalendarFreeBusy: vi.fn(async () => ({
      calendarRefs: ['calendar-1'],
      blocks: calendarBlocks,
      snapshots: [],
    })),
    readTasks: vi.fn<TrustedStandardSpecialistServices['readTasks']>(
      async () => ({ tasks: [], nextCursor: null }),
    ),
    writeTask: vi.fn(async () => ({
      result: { status: 'rejected', task: null, safeError },
    })),
    resolveTravelTime: vi.fn(async () => ({
      travelMinutes: 20,
      totalBufferMinutes: 30,
      source: 'google-maps',
      fetchedAt: instant,
    })),
    readFinanceRecords: vi.fn(async () => ({ records: [], nextCursor: null })),
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
      spaceId: 'private-space-1',
      transactions: [transaction],
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
          evidence: [documentEvidence],
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
      evidence: [documentEvidence],
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
    readShoppingItems: vi.fn(async () => ({ items: [], nextCursor: null })),
    writeShoppingItem: vi.fn(async () => ({
      result: { status: 'rejected', item: null, safeError },
    })),
    readOffers: vi.fn<TrustedStandardSpecialistServices['readOffers']>(
      async () => ({
        offers: [offer],
        observedAt: '2026-08-11T14:00:30.000Z',
        unknownCosts: [{ component: 'tax', reason: 'Calculated at handoff.' }],
      }),
    ),
    refreshOffers: vi.fn<TrustedStandardSpecialistServices['refreshOffers']>(
      async () => ({
        status: 'ready',
        refreshedAt: '2026-08-11T14:00:30.000Z',
        offers: [handoffOffer],
      }),
    ),
    prepareLinkOut: vi.fn<TrustedStandardSpecialistServices['prepareLinkOut']>(
      async () => ({
        status: 'accepted',
        link: {
          url: 'https://retailer.example/products/milk',
          rel: 'noopener noreferrer external',
        },
      }),
    ),
  }) satisfies TrustedStandardSpecialistServices;

const invocations = [
  [
    'scheduler.calendar.freebusy.read',
    { schemaVersion: 1, windowStart: instant, windowEnd: laterInstant },
  ],
  ['scheduler.tasks.read', { schemaVersion: 1, status: 'open', limit: 25 }],
  [
    'scheduler.tasks.write',
    {
      schemaVersion: 1,
      mutation: {
        kind: 'create',
        taskId: 'task-1',
        task: {
          title: 'Book dentist',
          notes: null,
          dueAt: laterInstant,
          recurrence: null,
        },
      },
    },
  ],
  [
    'maps.travel-time.read',
    {
      schemaVersion: 1,
      origin: 'Home',
      destination: 'Dentist',
      mode: 'driving',
      departureAt: instant,
    },
  ],
  [
    'finance.records.read',
    { schemaVersion: 1, recordTypes: ['transaction'], limit: 25 },
  ],
  [
    'finance.records.write',
    {
      schemaVersion: 1,
      mutation: {
        kind: 'create',
        recordId: 'transaction-2',
        record: {
          recordType: 'transaction',
          accountId: 'account-1',
          categoryId: null,
          postedOn: '2026-08-11',
          description: 'Coffee',
          amountCadMinor: -299,
        },
      },
    },
  ],
  [
    'finance.statement.import',
    {
      schemaVersion: 1,
      request: { kind: 'commit', planId: 'reviewed-plan-1' },
    },
  ],
  ['finance.analytics.calculate', { schemaVersion: 1, month: '2026-08' }],
  [
    'finance.documents.search',
    {
      schemaVersion: 1,
      query: 'Example Market',
      documentTypes: ['receipt'],
      from: '2026-08-01',
      to: '2026-08-31',
      limit: 10,
    },
  ],
  [
    'finance.documents.read',
    {
      schemaVersion: 1,
      documentId: 'document-1',
      evidenceIds: ['evidence-1'],
    },
  ],
  [
    'finance.matches.read',
    {
      schemaVersion: 1,
      documentId: 'document-1',
      states: ['suggested'],
      limit: 25,
    },
  ],
  ['shopping.items.read', { schemaVersion: 1, kinds: ['grocery'], limit: 25 }],
  [
    'shopping.items.write',
    {
      schemaVersion: 1,
      mutation: {
        kind: 'delta',
        itemId: 'milk-1',
        quantityMilliUnits: 1_000,
      },
    },
  ],
  [
    'commerce.offers.read',
    { schemaVersion: 1, itemIds: ['milk-1'], maximumAgeMs: 60_000 },
  ],
  [
    'commerce.offers.refresh',
    {
      schemaVersion: 1,
      query: 'milk',
      postalCode: 'M5V 2T6',
      limit: 10,
      maximumAgeMs: 60_000,
    },
  ],
  ['commerce.link-out.prepare', { schemaVersion: 1, offerId: 'offer-1' }],
] as const satisfies readonly (readonly [
  StandardSpecialistCapabilityId,
  unknown,
])[];

describe('standard specialist Task6 adapters', () => {
  it('executes all 16 non-provider capabilities through finite validated outputs', async () => {
    const services = createServices();
    const executors = createStandardSpecialistCapabilityExecutors(services);

    expect(Object.keys(executors)).toHaveLength(16);
    for (const [capabilityId, input] of invocations) {
      const output = await executors[capabilityId](input, context);
      expect(
        () => parseSpecialistCapabilityOutput(capabilityId, output),
        capabilityId,
      ).not.toThrow();
    }

    const freeBusy = specialistCapabilitySchemas[
      'scheduler.calendar.freebusy.read'
    ].output.parse(
      await executors['scheduler.calendar.freebusy.read'](
        invocations[0][1],
        context,
      ),
    );
    expect(freeBusy.blocks).toHaveLength(200);
    expect(freeBusy.omittedBlockCount).toBe(1);

    const budget = specialistCapabilitySchemas[
      'finance.analytics.calculate'
    ].output.parse(
      await executors['finance.analytics.calculate'](
        { schemaVersion: 1, month: '2026-08' },
        context,
      ),
    );
    expect(budget.result).toMatchObject({
      status: 'calculated',
      totals: {
        inflowCadMinor: 0,
        outflowCadMinor: 1_299,
        netCadMinor: -1_299,
      },
    });
  });

  it('strips schema and provider authority before trusted service invocation', async () => {
    const services = createServices();
    const executors = createStandardSpecialistCapabilityExecutors(services);

    await executors['scheduler.tasks.read'](
      { schemaVersion: 1, status: 'open', limit: 25 },
      context,
    );
    await executors['commerce.offers.refresh'](
      {
        schemaVersion: 1,
        query: 'milk',
        limit: 10,
        maximumAgeMs: 60_000,
      },
      context,
    );

    const taskRequest = services.readTasks.mock.calls[0]?.[0];
    const refreshRequest = services.refreshOffers.mock.calls[0]?.[0];
    expect(taskRequest).toEqual({
      status: 'open',
      dueBefore: undefined,
      cursor: undefined,
      limit: 25,
    });
    expect(refreshRequest).toEqual({
      query: 'milk',
      postalCode: undefined,
      limit: 10,
      maximumAgeMs: 60_000,
    });
    expect(taskRequest).not.toHaveProperty('schemaVersion');
    expect(refreshRequest).not.toHaveProperty('providerId');
    expect(Object.isFrozen(taskRequest)).toBe(true);
    expect(Object.isFrozen(refreshRequest)).toBe(true);

    services.refreshOffers.mockClear();
    await expect(
      executors['commerce.offers.refresh'](
        {
          schemaVersion: 1,
          providerId: 'model-chosen-provider',
          query: 'milk',
          limit: 10,
          maximumAgeMs: 60_000,
        },
        context,
      ),
    ).rejects.toThrow();
    expect(services.refreshOffers).not.toHaveBeenCalled();
  });

  it('canonicalizes shopping quantities and rejects nonzero-delta violations before storage', async () => {
    const services = createServices();
    const executors = createStandardSpecialistCapabilityExecutors(services);
    const item = {
      id: 'milk-1',
      kind: 'grocery',
      name: 'Whole milk',
      quantity: { amount: '1.25', unit: 'L' },
      preferences: {
        requiredTags: ['lactose-free'],
        excludedTags: [],
        preferredBrands: ['Natrel'],
      },
      substitutions: { policy: 'similar', alternatives: [] },
      preferredRetailers: ['no-frills-ca'],
    } as const;

    await executors['shopping.items.write'](
      { schemaVersion: 1, mutation: { kind: 'create', item } },
      context,
    );
    expect(services.writeShoppingItem).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'create',
        item: expect.objectContaining({
          id: 'milk-1',
          quantity: {
            amountMilliUnits: 1_250_000,
            unit: 'millilitre',
            scale: 1_000,
          },
        }),
      }),
      context,
    );

    services.writeShoppingItem.mockClear();
    await expect(
      executors['shopping.items.write'](
        {
          schemaVersion: 1,
          mutation: {
            kind: 'delta',
            itemId: 'milk-1',
            quantityMilliUnits: 0,
          },
        },
        context,
      ),
    ).rejects.toThrow();
    await expect(
      executors['shopping.items.write'](
        {
          schemaVersion: 1,
          mutation: {
            kind: 'update',
            itemId: 'milk-1',
            replacement: { ...item, id: 'another-item' },
          },
        },
        context,
      ),
    ).rejects.toThrow();
    expect(services.writeShoppingItem).not.toHaveBeenCalled();
  });

  it('derives finance authority, CAD fields, and ledger identity exclusively from trusted state', () => {
    const record = materializeFinanceRecordCreate({
      modelArguments: {
        schemaVersion: 1,
        mutation: {
          kind: 'create',
          recordId: 'account-2',
          record: {
            recordType: 'account',
            name: 'Chequing',
            accountKind: 'chequing',
            openingBalanceCadMinor: 12_345,
            active: true,
          },
        },
      },
      trustedState: {
        spaceId: 'private-space-1',
        ownerUserId: 'owner-user-1',
        createdAt: '2026-08-11T12:00:00.000Z',
        updatedAt: '2026-08-11T12:00:00.000Z',
      },
    });
    expect(record).toMatchObject({
      id: 'account-2',
      spaceId: 'private-space-1',
      ownerUserId: 'owner-user-1',
      currency: 'CAD',
      source: 'manual',
      openingBalanceCadMinor: 12_345,
    });
    expect(Object.isFrozen(record)).toBe(true);

    expect(() =>
      materializeFinanceRecordCreate({
        modelArguments: {
          schemaVersion: 1,
          mutation: {
            kind: 'create',
            recordId: 'account-2',
            record: {
              recordType: 'account',
              name: 'Chequing',
              accountKind: 'chequing',
              openingBalanceCadMinor: 12.34,
              active: true,
              ownerUserId: 'forged-owner',
            },
          },
        },
        trustedState: {
          spaceId: 'private-space-1',
          ownerUserId: 'owner-user-1',
          createdAt: '2026-08-11T12:00:00.000Z',
          updatedAt: '2026-08-11T12:00:00.000Z',
        },
      }),
    ).toThrow();

    const result = materializeFinanceLedgerOperation({
      modelArguments: {
        schemaVersion: 1,
        mutation: {
          kind: 'adjust',
          transactionId: transaction.id,
          amountCadMinor: 250,
          reason: 'Price correction',
        },
      },
      trustedState: {
        transaction,
        operationId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f105',
        updatedAt: '2026-08-11T16:00:00.000Z',
      },
    });
    expect(result).toMatchObject({
      status: 'applied',
      transaction: {
        id: transaction.id,
        effectiveAmountCadMinor: -1_049,
        appliedOperationIds: ['018f1f5e-6f47-7d61-a6dd-1e86f8b8f105'],
      },
      providerWrites: [],
    });
  });

  it('rejects stale/comparison-forbidden offers and malformed link-out results', async () => {
    const services = createServices();
    const executors = createStandardSpecialistCapabilityExecutors(services);

    services.readOffers.mockResolvedValueOnce({
      offers: [{ ...offer, comparisonPermission: 'not-authorized' }],
      observedAt: '2026-08-11T14:00:30.000Z',
      unknownCosts: [],
    });
    await expect(
      executors['commerce.offers.read'](
        { schemaVersion: 1, itemIds: ['milk-1'], maximumAgeMs: 60_000 },
        context,
      ),
    ).rejects.toThrow('api-commerce-offer-freshness-invalid');

    services.prepareLinkOut.mockResolvedValueOnce({
      status: 'accepted',
      link: {
        url: 'http://retailer.example/products/milk',
        rel: 'noopener noreferrer external',
      },
    });
    await expect(
      executors['commerce.link-out.prepare'](
        { schemaVersion: 1, offerId: 'offer-1' },
        context,
      ),
    ).rejects.toThrow();
  });
});

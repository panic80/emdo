import { describe, expect, it } from 'vitest';

import {
  compareLegacyFinanceMigration,
  evaluateLegacyFinanceCutover,
  legacyCadMinorToDecimal,
  normalizedAmountToLegacyCadMinor,
  planLegacyFinanceMigration,
} from './legacy-migration.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = (digit: string) => digit.repeat(64);

const source = {
  householdId: id(1),
  privateSpaceId: id(2),
  originalOwnerUserId: id(3),
};
const target = {
  workspaceId: source.householdId,
  bookId: id(4),
  ownerUserId: source.originalOwnerUserId,
};
const accountId = id(10);
const categoryId = id(11);
const evidenceId = id(12);
const batchId = id(13);
const rowId = id(14);

const mapping = {
  source,
  target,
  financialAccounts: [
    { legacyAccountId: 'account-1', targetFinancialAccountId: accountId },
  ],
  categories: [
    { legacyCategoryId: 'category-1', targetLedgerAccountId: categoryId },
  ],
  evidence: [{ legacyEntityId: 'transaction-1', targetEvidenceId: evidenceId }],
  openings: [],
};

const transactionPayload = {
  schemaVersion: 1 as const,
  id: 'transaction-1',
  spaceId: source.privateSpaceId,
  ownerUserId: source.originalOwnerUserId,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  recordType: 'transaction' as const,
  accountId: 'account-1',
  categoryId: 'category-1',
  postedOn: '2026-08-31',
  description: 'Market',
  annotation: null,
  currency: 'CAD' as const,
  originalAmountCadMinor: -4_205,
  effectiveAmountCadMinor: -4_205,
  adjustments: [],
  reversal: null,
  appliedOperationIds: [],
  source: {
    kind: 'import' as const,
    sourceHash: hash('a'),
    sourceRow: 7,
    fingerprint: hash('b'),
    externalId: 'statement-row-7',
  },
};

const sourceRecord = (
  entityType: 'finance.transaction' | 'finance.account' | 'finance.budget',
  entityId: string,
  payload: unknown,
  n: number,
  options: { tombstoned?: boolean; provenance?: unknown } = {},
) => ({
  source,
  entityType,
  entityId,
  legacyRowId: id(n),
  revision: 1,
  tombstoned: options.tombstoned ?? false,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  payload,
  payloadHash: hash('c'),
  provenance: options.provenance ?? {
    kind: 'import' as const,
    sourceHash: hash('a'),
    sourceRow: n,
    fingerprint: hash('b'),
    externalId: `row-${n}`,
  },
});

const transactionSource = sourceRecord(
  'finance.transaction',
  'transaction-1',
  transactionPayload,
  20,
  { provenance: transactionPayload.source },
);

const planningInput = {
  schemaVersion: 1 as const,
  mapping,
  sourceRecords: [transactionSource],
  stableTargetIds: [
    {
      entityType: 'finance.transaction' as const,
      entityId: 'transaction-1',
      targetRecordId: id(15),
      targetBatchId: batchId,
      targetRowId: rowId,
    },
  ],
};

describe('legacy Finance migration planning', () => {
  it('converts CAD minor units exactly, including safe large integers', () => {
    expect(legacyCadMinorToDecimal(-4_205)).toBe('-42.05');
    expect(legacyCadMinorToDecimal(1)).toBe('0.01');
    expect(legacyCadMinorToDecimal(Number.MAX_SAFE_INTEGER)).toBe(
      '90071992547409.91',
    );
    expect(() => legacyCadMinorToDecimal(1.5)).toThrow(
      'legacy-cad-minor-out-of-range',
    );
  });

  it('produces a ready, stable, provenance-preserving transaction candidate', () => {
    const plan = planLegacyFinanceMigration(planningInput);
    expect(plan.status).toBe('ready');
    expect(plan.counts).toEqual({
      source: 1,
      ready: 1,
      blocked: 0,
      preserved: 0,
      unresolved: 0,
    });
    expect(plan.candidates[0]).toMatchObject({
      targetRecordId: id(15),
      targetBatchId: batchId,
      targetRowId: rowId,
      normalized: {
        recordType: 'transaction',
        nativeAmount: '-42.05',
        currency: 'CAD',
        sourceRow: 7,
        externalId: 'statement-row-7',
        sourceHash: hash('a'),
        fingerprint: hash('b'),
      },
      classification: {
        targetFinancialAccountId: accountId,
        targetLedgerAccountId: categoryId,
        targetEvidenceId: evidenceId,
      },
    });
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it('blocks unmapped classifications, evidence, and missing stable targets', () => {
    const plan = planLegacyFinanceMigration({
      ...planningInput,
      mapping: {
        ...mapping,
        financialAccounts: [],
        categories: [],
        evidence: [],
      },
      stableTargetIds: [],
    });
    expect(plan.status).toBe('blocked');
    expect(plan.candidates[0]?.blockers).toEqual(
      expect.arrayContaining([
        'financial-account-mapping-required',
        'category-mapping-required',
        'evidence-mapping-required',
        'stable-target-id-missing',
      ]),
    );
  });

  it('keeps tombstones preserved and queues nonzero openings without posting', () => {
    const accountPayload = {
      schemaVersion: 1 as const,
      id: 'account-1',
      spaceId: source.privateSpaceId,
      ownerUserId: source.originalOwnerUserId,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      recordType: 'account' as const,
      name: 'Cash',
      accountKind: 'cash' as const,
      currency: 'CAD' as const,
      openingBalanceCadMinor: 1_000,
      active: true,
      source: 'manual' as const,
    };
    const tombstone = sourceRecord(
      'finance.transaction',
      'deleted-transaction',
      {},
      21,
      { tombstoned: true, provenance: { kind: 'manual' as const } },
    );
    const account = sourceRecord(
      'finance.account',
      'account-1',
      accountPayload,
      22,
      { provenance: { kind: 'manual' as const } },
    );
    const plan = planLegacyFinanceMigration({
      ...planningInput,
      sourceRecords: [tombstone, account],
      stableTargetIds: [],
      mapping: {
        ...mapping,
        openings: [
          {
            legacyAccountId: 'account-1',
            disposition: 'queue' as const,
            targetLedgerAccountId: null,
            targetEvidenceId: null,
          },
        ],
      },
    });
    expect(plan.candidates[0]).toMatchObject({
      status: 'preserved',
      disposition: 'preserve-only',
    });
    expect(plan.candidates[1]?.blockers).toContain(
      'opening-balance-review-required',
    );
    expect(plan.candidates[1]?.disposition).toBe('unresolved');
  });

  it('preserves unsupported legacy records in the review queue', () => {
    const budget = sourceRecord(
      'finance.budget',
      'budget-1',
      {
        schemaVersion: 1,
        id: 'budget-1',
        spaceId: source.privateSpaceId,
        ownerUserId: source.originalOwnerUserId,
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
        recordType: 'budget',
        month: '2026-09',
        currency: 'CAD',
        allocations: [],
        revision: 0,
      },
      23,
    );
    const plan = planLegacyFinanceMigration({
      ...planningInput,
      sourceRecords: [budget],
      stableTargetIds: [],
    });
    expect(plan.candidates[0]).toMatchObject({
      status: 'blocked',
      disposition: 'unresolved',
      blockers: ['unsupported-legacy-record-type'],
    });
  });
});

describe('legacy Finance migration comparison and cutover gate', () => {
  it('passes only when target transactions match source identities and exact amounts', () => {
    const plan = planLegacyFinanceMigration(planningInput);
    const comparison = compareLegacyFinanceMigration({
      sourceRecords: planningInput.sourceRecords,
      candidates: plan.candidates,
      targetTransactions: [
        {
          entityType: 'finance.transaction' as const,
          entityId: 'transaction-1',
          targetRowId: rowId,
          status: 'backfilled' as const,
          nativeAmount: '-42.05',
          currency: 'CAD' as const,
        },
      ],
    });
    expect(comparison).toMatchObject({
      status: 'passed',
      sourceTransactionCount: 1,
      targetTransactionCount: 1,
      sourceCadMinorTotal: '-4205',
      targetCadDecimalTotal: '-42.05',
      mismatches: [],
    });
    expect(evaluateLegacyFinanceCutover({ plan, comparison })).toEqual({
      ready: true,
      blockers: [],
    });
  });

  it('fails on amount drift, missing targets, unresolved candidates, and extras', () => {
    const plan = planLegacyFinanceMigration(planningInput);
    const comparison = compareLegacyFinanceMigration({
      sourceRecords: planningInput.sourceRecords,
      candidates: [
        ...plan.candidates,
        {
          ...plan.candidates[0],
          entityId: 'unresolved-extra',
          disposition: 'unresolved' as const,
          status: 'blocked' as const,
          blockers: ['manual-review'],
        },
      ],
      targetTransactions: [
        {
          entityType: 'finance.transaction' as const,
          entityId: 'transaction-1',
          targetRowId: rowId,
          status: 'backfilled' as const,
          nativeAmount: '-42.06',
          currency: 'CAD' as const,
        },
        {
          entityType: 'finance.transaction' as const,
          entityId: 'extra-transaction',
          targetRowId: id(30),
          status: 'backfilled' as const,
          nativeAmount: '1',
          currency: 'CAD' as const,
        },
      ],
    });
    expect(comparison.status).toBe('failed');
    expect(comparison.mismatches).toEqual(
      expect.arrayContaining([
        'target-transaction-amount-mismatch',
        'target-transaction-extra',
        'unresolved-records',
        'transaction-count-mismatch',
      ]),
    );
    expect(evaluateLegacyFinanceCutover({ plan, comparison })).toMatchObject({
      ready: false,
      blockers: expect.arrayContaining(['comparison-not-passed']),
    });
  });
});

it('projects normalized CAD values exactly to legacy integer boundaries', () => {
  for (const value of [
    0,
    1,
    -4205,
    Number.MAX_SAFE_INTEGER,
    Number.MIN_SAFE_INTEGER,
  ])
    expect(
      normalizedAmountToLegacyCadMinor(legacyCadMinorToDecimal(value), 'CAD'),
    ).toBe(value);
  expect(normalizedAmountToLegacyCadMinor('1.230000000000', 'CAD')).toBe(123);
  expect(() => normalizedAmountToLegacyCadMinor('0.001', 'CAD')).toThrow(
    'precision-unrepresentable',
  );
  expect(() => normalizedAmountToLegacyCadMinor('1', 'USD')).toThrow(
    'currency-unrepresentable',
  );
  expect(() =>
    normalizedAmountToLegacyCadMinor('90071992547409.92', 'CAD'),
  ).toThrow('out-of-range');
});

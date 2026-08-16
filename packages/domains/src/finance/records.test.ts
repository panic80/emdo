import { describe, expect, it } from 'vitest';

import {
  evaluateFinanceOperation,
  validateFinanceRecord,
  validateFinanceRecordCreate,
} from './records.js';

const base = {
  schemaVersion: 1 as const,
  id: 'record-1',
  spaceId: 'space-private-1',
  ownerUserId: 'user-1',
  createdAt: '2026-08-09T14:00:00.000Z',
  updatedAt: '2026-08-09T14:00:00.000Z',
};

const examples = [
  {
    ...base,
    recordType: 'account',
    name: 'Household cash',
    accountKind: 'cash',
    currency: 'CAD',
    openingBalanceCadMinor: 12_345,
    active: true,
    source: 'manual',
  },
  {
    ...base,
    recordType: 'transaction',
    accountId: 'account-1',
    categoryId: 'category-groceries',
    postedOn: '2026-08-08',
    description: 'Neighbourhood market',
    currency: 'CAD',
    originalAmountCadMinor: -4_205,
    effectiveAmountCadMinor: -4_205,
    adjustments: [],
    reversal: null,
    appliedOperationIds: [],
    source: { kind: 'manual' },
  },
  {
    ...base,
    recordType: 'category',
    name: 'Groceries',
    categoryKind: 'expense',
    parentCategoryId: null,
    active: true,
  },
  {
    ...base,
    recordType: 'budget',
    month: '2026-08',
    currency: 'CAD',
    allocations: [{ categoryId: 'category-groceries', amountCadMinor: 50_000 }],
    revision: 0,
  },
  {
    ...base,
    recordType: 'bill',
    name: 'Hydro',
    dueOn: '2026-08-25',
    expectedAmountCadMinor: 9_001,
    currency: 'CAD',
    status: 'planned',
  },
  {
    ...base,
    recordType: 'subscription',
    name: 'Music',
    nextDueOn: '2026-09-01',
    expectedAmountCadMinor: 1_299,
    currency: 'CAD',
    cadence: 'monthly',
    active: true,
  },
  {
    ...base,
    recordType: 'goal',
    name: 'Emergency fund',
    targetAmountCadMinor: 500_000,
    currentAmountCadMinor: 125_000,
    currency: 'CAD',
    targetOn: '2027-08-01',
    status: 'active',
  },
] as const;

describe('manual finance records', () => {
  it.each(examples)('validates and freezes $recordType records', (record) => {
    const result = validateFinanceRecord(record);

    expect(result).toMatchObject({ status: 'accepted', record });
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.status === 'accepted' && Object.isFrozen(result.record)).toBe(
      true,
    );
  });

  it('rejects foreign currency, fractional minor units, and secret fields', () => {
    for (const record of [
      { ...examples[0], currency: 'USD' },
      { ...examples[0], openingBalanceCadMinor: 12.5 },
      { ...examples[0], onlineBankingPassword: 'do-not-store' },
      { ...examples[0], accessToken: 'do-not-store' },
    ]) {
      expect(validateFinanceRecord(record)).toEqual({
        status: 'rejected',
        safeError: {
          code: 'invalid-finance-record',
          message: 'The finance record is invalid.',
        },
      });
    }
  });

  it('rejects impossible dates and inconsistent ledger values', () => {
    expect(
      validateFinanceRecord({ ...examples[1], postedOn: '2026-02-30' }),
    ).toMatchObject({ status: 'rejected' });
    expect(
      validateFinanceRecord({
        ...examples[1],
        effectiveAmountCadMinor: -1,
      }),
    ).toMatchObject({ status: 'rejected' });
  });

  it('rejects cycles and accessors before inspecting them', () => {
    const cyclic: Record<string, unknown> = { ...examples[0] };
    cyclic.self = cyclic;
    expect(validateFinanceRecord(cyclic)).toMatchObject({
      status: 'rejected',
    });

    let accessed = false;
    const accessor = { ...examples[0] } as Record<string, unknown>;
    Object.defineProperty(accessor, 'name', {
      enumerable: true,
      get() {
        accessed = true;
        return 'Unsafe';
      },
    });
    expect(validateFinanceRecord(accessor)).toMatchObject({
      status: 'rejected',
    });
    expect(accessed).toBe(false);
  });
});

describe('finance operation boundary', () => {
  it('allows only a clean manual transaction through the record-create boundary', () => {
    expect(validateFinanceRecordCreate(examples[1])).toMatchObject({
      status: 'accepted',
    });

    expect(
      validateFinanceRecordCreate({
        ...examples[1],
        source: {
          kind: 'import',
          sourceHash:
            '01cfd7be901f15e35d854f6f54ff09d48753506c17444d86968344073632f81c',
          sourceRow: 1,
          fingerprint:
            'd59dbd289bccf5fb4c6cc1a14117dc5ae107243747c7727d6ac0f936a6018c5a',
          externalId: 'forged-import',
        },
      }),
    ).toMatchObject({ status: 'rejected' });

    const operationId = '018f61b4-8304-70ea-9497-2a3e99e3fceb';
    expect(
      validateFinanceRecordCreate({
        ...examples[1],
        effectiveAmountCadMinor: -4_105,
        adjustments: [
          { operationId, amountCadMinor: 100, reason: 'Forged adjustment' },
        ],
        appliedOperationIds: [operationId],
      }),
    ).toMatchObject({ status: 'rejected' });
  });

  it.each([
    'banking.credentials.store',
    'banking.aggregate',
    'payment.create',
    'transfer.create',
    'investment.recommend',
    'tax.file',
    'credit.decide',
  ])('forbids %s', (operationId) => {
    expect(evaluateFinanceOperation(operationId)).toMatchObject({
      decision: 'forbidden',
      safeError: { code: 'finance-operation-forbidden' },
    });
  });

  it('allows only declared local finance operations and denies unknown ones', () => {
    expect(evaluateFinanceOperation('finance.statement.import')).toEqual({
      decision: 'allowed',
    });
    expect(
      evaluateFinanceOperation('finance.transaction.create-manual'),
    ).toEqual({
      decision: 'allowed',
    });
    expect(evaluateFinanceOperation('finance.account.create')).toEqual({
      decision: 'allowed',
    });
    expect(evaluateFinanceOperation('finance.transaction.adjust')).toEqual({
      decision: 'allowed',
    });
    expect(evaluateFinanceOperation('finance.record.write')).toMatchObject({
      decision: 'forbidden',
    });
    expect(evaluateFinanceOperation('finance.record.create')).toMatchObject({
      decision: 'forbidden',
    });
    expect(evaluateFinanceOperation('finance.unknown')).toMatchObject({
      decision: 'forbidden',
    });
  });
});

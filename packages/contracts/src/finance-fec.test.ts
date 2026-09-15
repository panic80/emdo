import { describe, expect, it } from 'vitest';
import {
  FinanceFecExportRequestSchema,
  FinanceFecMappingCreateSchema,
} from './finance-fec.js';

const request = {
  startsOn: '2025-01-01',
  endsOn: '2025-12-31',
  mappingRevision: 1,
  idempotencyKey: 'fec-2025-reviewed-1',
};
describe('reviewed FEC export request', () => {
  it('accepts a revision-bound period without caller-owned ledger amounts', () => {
    expect(FinanceFecExportRequestSchema.parse(request)).toEqual(request);
  });
  it.each([
    { endsOn: '2024-12-31' },
    { startsOn: '2025-02-30' },
    { mappingRevision: 0 },
    { mappingRevision: 1.5 },
    { debit: '100' },
    { reviewedBy: 'caller' },
    { idempotencyKey: '../file' },
  ])('rejects invalid scope or caller-supplied authority: %j', (patch) => {
    expect(
      FinanceFecExportRequestSchema.safeParse({ ...request, ...patch }).success,
    ).toBe(false);
  });
});

const source = {
  sourceReference: 'reviewed-source',
  sourceDigest: 'a'.repeat(64),
};
const mapping = {
  expectedRevision: 0,
  siren: '123456789',
  sirenSource: source,
  openingBalances: { status: 'not-applicable', source },
  journals: [],
  accounts: [
    {
      accountId: '11111111-1111-4111-8111-111111111111',
      accountNumber: '512000',
      accountLabel: 'Banque',
      auxiliary: null,
    },
  ],
};
describe('FEC reviewed mapping boundary', () => {
  it('accepts legal metadata without invented ledger values', () => {
    expect(FinanceFecMappingCreateSchema.safeParse(mapping).success).toBe(true);
  });
  it('rejects reviewer injection, duplicate accounts, partial auxiliary metadata and control characters', () => {
    for (const candidate of [
      { ...mapping, reviewedBy: 'caller' },
      { ...mapping, accounts: [...mapping.accounts, ...mapping.accounts] },
      {
        ...mapping,
        accounts: [{ ...mapping.accounts[0], auxiliary: { number: 'A' } }],
      },
      {
        ...mapping,
        accounts: [{ ...mapping.accounts[0], accountLabel: 'Bank\tInjected' }],
      },
    ])
      expect(FinanceFecMappingCreateSchema.safeParse(candidate).success).toBe(
        false,
      );
  });
});

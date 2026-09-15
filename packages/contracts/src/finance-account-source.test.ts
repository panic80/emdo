import { describe, expect, it } from 'vitest';
import { CreateFinancialAccountSchema } from './finance-v2.js';

const id = '11111111-1111-4111-8111-111111111111';
const account = {
  name: 'Operating account',
  kind: 'bank',
  currency: 'CAD',
  ledgerAccountId: id,
};
const assignment = {
  sourceSpaceId: id,
  compatibilityAccountKind: 'chequing',
  reason: 'Include in my private finance view',
};

describe('Explicit financial account source assignment', () => {
  it('keeps unassigned accounts book-scoped without inventing a private source', () => {
    expect(
      CreateFinancialAccountSchema.parse(account).privateSourceAssignment,
    ).toBeUndefined();
  });
  it('accepts an explicit bank subtype and source without accepting client ownership claims', () => {
    expect(
      CreateFinancialAccountSchema.parse({
        ...account,
        privateSourceAssignment: assignment,
      }).privateSourceAssignment,
    ).toEqual(assignment);
    expect(
      CreateFinancialAccountSchema.safeParse({
        ...account,
        privateSourceAssignment: { ...assignment, sourceOwnerUserId: id },
      }).success,
    ).toBe(false);
  });
  it('rejects a cash classification for a bank account', () => {
    expect(
      CreateFinancialAccountSchema.safeParse({
        ...account,
        privateSourceAssignment: {
          ...assignment,
          compatibilityAccountKind: 'cash',
        },
      }).success,
    ).toBe(false);
  });
  it('does not allow account creation to assert a reviewed opening balance', () => {
    expect(
      CreateFinancialAccountSchema.safeParse({
        ...account,
        privateSourceAssignment: { ...assignment, openingBalance: '0.00' },
      }).success,
    ).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { decimal as q } from './personal-exact.js';
import {
  calculateCanada2025EducatorSchoolSupplyCredit,
  CANADA_PERSONAL_EDUCATOR_CREDIT_SOURCE,
  CANADA_PERSONAL_EDUCATOR_CREDIT_VERSION,
} from './personal-educator-credit.js';

const eligible = {
  eligibleEducator: true,
  expensesPaidIn2025: true,
  expensesUnreimbursed: true,
  expensesNotClaimedElsewhere: true,
} as const;

describe('2025 CRA educator school-supply credit', () => {
  it.each([
    ['0', '0', '0'],
    ['0.50', '0.5', '0.125'],
    ['1000', '1000', '250'],
    ['1000.01', '1000', '250'],
    ['2500.50', '1000', '250'],
  ])(
    'uses exact min-and-25-percent arithmetic at eligible expenses %s',
    (expenses, capped, credit) => {
      const result = calculateCanada2025EducatorSchoolSupplyCredit(
        q(expenses),
        eligible,
      );
      expect(result.status).toBe('calculated');
      expect(result.version).toBe(CANADA_PERSONAL_EDUCATOR_CREDIT_VERSION);
      expect(result.sourceId).toBe(CANADA_PERSONAL_EDUCATOR_CREDIT_SOURCE.id);
      expect(result.cappedExpenses.exactDecimal).toBe(capped);
      expect(result.credit.exactDecimal).toBe(credit);
      expect(result.issues).toEqual([]);
    },
  );

  it('requires every reviewed gate for a nonzero claim', () => {
    const result = calculateCanada2025EducatorSchoolSupplyCredit(q('1'), {
      ...eligible,
      expensesUnreimbursed: false,
    });
    expect(result.status).toBe('blocked');
    expect(result.credit.exactDecimal).toBe('0');
    expect(result.issues).toContainEqual({
      code: 'eligibility-gate-failed',
      path: 'educator.expensesUnreimbursed',
      message:
        'The reviewed educator.expensesUnreimbursed gate does not support a nonzero educator claim.',
    });
  });

  it('distinguishes missing review from a reviewed false gate', () => {
    const result = calculateCanada2025EducatorSchoolSupplyCredit(q('1'), {
      ...eligible,
      eligibleEducator: null,
    });
    expect(result.status).toBe('blocked');
    expect(result.issues).toContainEqual({
      code: 'missing-eligibility-fact',
      path: 'educator.eligibleEducator',
      message:
        'Reviewed educator.eligibleEducator is required for a nonzero educator claim.',
    });
  });

  it('keeps a negative source amount blocked instead of changing its sign', () => {
    const result = calculateCanada2025EducatorSchoolSupplyCredit(q('-0.01'), {
      ...eligible,
    });
    expect(result.status).toBe('blocked');
    expect(result.eligibleExpenses.exactDecimal).toBe('-0.01');
    expect(result.credit.exactDecimal).toBe('0');
    expect(result.issues).toContainEqual({
      code: 'negative-expense-amount',
      path: 'educator.eligibleSuppliesExpenses',
      message: 'Eligible educator supplies expenses cannot be negative.',
    });
  });
});

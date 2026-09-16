import { describe, expect, it } from 'vitest';
import { ResolveFinanceStandardizationSchema } from './finance-standardization-reconciliation.js';

const command = {
  expectedRevision: 7,
  reservationId: '74000000-0000-4000-8000-000000000001',
  decision: 'retain-reserved-cost',
  receiptId: null,
  acknowledgeNoApproval: true,
};
describe('retained standardization cost review', () => {
  it('requires an acknowledged exact reservation without claiming a cost receipt', () => {
    expect(ResolveFinanceStandardizationSchema.parse(command)).toEqual(command);
    for (const invalid of [
      { reservationId: null },
      { receiptId: '74000000-0000-4000-8000-000000000002' },
      { acknowledgeNoApproval: false },
      { actualCadMinor: 0 },
    ]) {
      expect(
        ResolveFinanceStandardizationSchema.safeParse({
          ...command,
          ...invalid,
        }).success,
      ).toBe(false);
    }
  });
});

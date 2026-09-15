import { describe, expect, it } from 'vitest';
import { FinanceAutomationCapabilitySchema } from '@emdo/contracts';
import { CreateDurableFinanceAutomationGrantSchema } from './finance-automation-repository.js';

const grant = {
  capabilities: FinanceAutomationCapabilitySchema.options,
  limits: {
    maxRuns: 5,
    maxAttemptsPerRun: 2,
    maxItemsPerRun: 10,
    maxTotalItems: 50,
    currency: 'CAD',
    maxAmountPerRun: '100',
    maxTotalAmount: '500',
  },
  validFrom: '2026-09-15T00:00:00Z',
  expiresAt: '2026-10-15T00:00:00Z',
};

describe('Durable automation grant capability boundary', () => {
  it('accepts all registered capabilities supported by the public grant and database', () => {
    expect(
      CreateDurableFinanceAutomationGrantSchema.parse(grant).capabilities,
    ).toEqual(grant.capabilities);
  });
  it('rejects duplicate capabilities before persistence', () => {
    expect(
      CreateDurableFinanceAutomationGrantSchema.safeParse({
        ...grant,
        capabilities: ['finance.reports.generate', 'finance.reports.generate'],
      }).success,
    ).toBe(false);
  });
});

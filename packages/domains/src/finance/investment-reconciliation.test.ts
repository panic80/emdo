import { describe, expect, it } from 'vitest';
import {
  canonicalInvestmentSnapshot,
  investmentReconciliationEffectiveStatus,
} from './investment-reconciliation.js';
import { ResolveInvestmentReconciliationSchema } from '@emdo/contracts';
import { randomUUID } from 'node:crypto';
describe('investment reconciliation review semantics', () => {
  it('compares jsonb without depending on object-key order while preserving array order and exact decimal text', () => {
    expect(
      canonicalInvestmentSnapshot({ b: [{ y: '10.00', x: 1 }], a: null }),
    ).toBe(canonicalInvestmentSnapshot({ a: null, b: [{ x: 1, y: '10.00' }] }));
    expect(canonicalInvestmentSnapshot(['10', '12'])).not.toBe(
      canonicalInvestmentSnapshot(['12', '10']),
    );
    expect(canonicalInvestmentSnapshot('10')).not.toBe(
      canonicalInvestmentSnapshot('10.00'),
    );
  });
  it('exposes changed-source resolution as requiring reopen without changing the stored resolution', () => {
    expect(investmentReconciliationEffectiveStatus('resolved', false)).toBe(
      'reopen-required',
    );
    expect(investmentReconciliationEffectiveStatus('open', false)).toBe(
      'reopen-required',
    );
    expect(investmentReconciliationEffectiveStatus('resolved', true)).toBe(
      'resolved',
    );
  });
  it('requires explicit evidence and actual records for a corrective resolution', () => {
    const input = {
      expectedRevision: 1,
      expectedComparisonHash: 'a'.repeat(64),
      resolution: {
        kind: 'corrective-records',
        explanation: 'Reviewed correction to opening statement.',
        evidenceIds: [randomUUID()],
        correctiveRecords: [],
      },
    };
    expect(ResolveInvestmentReconciliationSchema.safeParse(input).success).toBe(
      false,
    );
    expect(
      ResolveInvestmentReconciliationSchema.safeParse({
        ...input,
        resolution: {
          ...input.resolution,
          correctiveRecords: [{ kind: 'opening', id: randomUUID() }],
        },
      }).success,
    ).toBe(true);
    expect(
      ResolveInvestmentReconciliationSchema.safeParse({
        ...input,
        resolution: {
          ...input.resolution,
          kind: 'reviewed-explanation',
          evidenceIds: [],
        },
      }).success,
    ).toBe(false);
  });
});

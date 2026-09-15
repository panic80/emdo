import { describe, expect, it } from 'vitest';
import type { FinanceTaxIntake } from '@emdo/contracts';
import {
  CANADA_PERSONAL_NONCAPITAL_LOSS_YEARS,
  CANADA_PERSONAL_NONCAPITAL_LOSS_ORDER_SOURCE,
  CANADA_PERSONAL_NONCAPITAL_LOSS_SOURCE,
  calculateCanadaPersonalNonCapitalLossCarryforward2025,
  personalNonCapitalLossFactKey,
} from './personal-carryforward.js';
import { decimal } from './personal-exact.js';

function facts(
  balances: Record<number, string> = {},
): FinanceTaxIntake['facts'] {
  return CANADA_PERSONAL_NONCAPITAL_LOSS_YEARS.map((year) => ({
    key: personalNonCapitalLossFactKey(year),
    value: {
      type: 'decimal' as const,
      value: balances[year] ?? '0',
    },
    reviewState: 'reviewed' as const,
    source: {
      kind: 'evidence' as const,
      reference: `${CANADA_PERSONAL_NONCAPITAL_LOSS_SOURCE.id}:${year}`,
      revision: 1,
      contentHash: 'a'.repeat(64),
    },
  }));
}

describe('Canada 2025 general non-capital loss carryforward', () => {
  it('uses the 2006 through 2024 eligibility boundary for a 2025 return', () => {
    expect(CANADA_PERSONAL_NONCAPITAL_LOSS_YEARS[0]).toBe(2006);
    expect(
      CANADA_PERSONAL_NONCAPITAL_LOSS_YEARS[
        CANADA_PERSONAL_NONCAPITAL_LOSS_YEARS.length - 1
      ],
    ).toBe(2024);
    const result = calculateCanadaPersonalNonCapitalLossCarryforward2025(
      facts({ 2006: '10', 2024: '20' }),
      decimal('15'),
    );
    expect(result.ledger[0]?.claimedIn2025.exactDecimal).toBe('10');
    expect(result.ledger.at(-1)?.claimedIn2025.exactDecimal).toBe('5');
  });

  it('applies oldest available balances first and retains each source binding', () => {
    const result = calculateCanadaPersonalNonCapitalLossCarryforward2025(
      facts({ 2022: '3000', 2024: '5000' }),
      decimal('6000'),
    );
    expect(result.status).toBe('calculated');
    expect(result.orderingSourceId).toBe(
      CANADA_PERSONAL_NONCAPITAL_LOSS_ORDER_SOURCE.id,
    );
    expect(result.orderingSourceHash).toBe(
      CANADA_PERSONAL_NONCAPITAL_LOSS_ORDER_SOURCE.documentHash,
    );
    expect(result.taxableIncomeAfterCarryforward.exactDecimal).toBe('0');
    expect(result.claimedTotal.exactDecimal).toBe('6000');
    expect(result.closingTotal.exactDecimal).toBe('2000');
    expect(
      result.ledger.find((entry) => entry.lossYear === 2022),
    ).toMatchObject({
      claimedIn2025: expect.objectContaining({
        exactDecimal: '3000',
      }),
      closingBalance: expect.objectContaining({ exactDecimal: '0' }),
      sourceBinding: expect.objectContaining({
        reference: 'cra-line-25200-2025-html:2022',
      }),
    });
    expect(
      result.ledger.find((entry) => entry.lossYear === 2024),
    ).toMatchObject({
      claimedIn2025: expect.objectContaining({
        exactDecimal: '3000',
      }),
      closingBalance: expect.objectContaining({ exactDecimal: '2000' }),
    });
  });

  it('does not consume a balance when taxable income before line 25200 is zero', () => {
    const result = calculateCanadaPersonalNonCapitalLossCarryforward2025(
      facts({ 2006: '1250.50' }),
      decimal('0'),
    );
    expect(result.claimedTotal.exactDecimal).toBe('0');
    expect(result.closingTotal.exactDecimal).toBe('1250.5');
  });

  it('retains half-dollar precision when a balance is fully consumed', () => {
    const result = calculateCanadaPersonalNonCapitalLossCarryforward2025(
      facts({ 2022: '1000.50' }),
      decimal('1000.50'),
    );
    expect(result.status).toBe('calculated');
    expect(result.claimedTotal.exactDecimal).toBe('1000.5');
    expect(result.closingTotal.exactDecimal).toBe('0');
    expect(
      result.ledger.find((entry) => entry.lossYear === 2022)?.claimedIn2025
        .exactRational,
    ).toEqual({ numerator: '2001', denominator: '2' });
  });

  it('blocks a negative continuity balance instead of turning it into a claim', () => {
    const result = calculateCanadaPersonalNonCapitalLossCarryforward2025(
      facts({ 2024: '-0.50' }),
      decimal('1'),
    );
    expect(result.status).toBe('blocked');
    expect(result.claimedTotal.exactDecimal).toBe('0');
    expect(result.closingTotal.exactDecimal).toBe('-0.5');
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'negative-carryforward-balance',
        path: personalNonCapitalLossFactKey(2024),
      }),
    );
    expect(
      result.ledger.find((entry) => entry.lossYear === 2024),
    ).toMatchObject({
      openingBalance: expect.objectContaining({ exactDecimal: '-0.5' }),
      claimedIn2025: expect.objectContaining({ exactDecimal: '0' }),
      closingBalance: expect.objectContaining({ exactDecimal: '-0.5' }),
      calculationEligible: false,
    });
  });

  it('blocks duplicate year balances instead of choosing an arbitrary source', () => {
    const duplicate = facts({ 2024: '100' });
    duplicate.push({ ...duplicate[duplicate.length - 1]! });
    const result = calculateCanadaPersonalNonCapitalLossCarryforward2025(
      duplicate,
      decimal('100'),
    );
    expect(result.status).toBe('blocked');
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'duplicate-carryforward-fact',
        path: personalNonCapitalLossFactKey(2024),
      }),
    );
  });

  it('requires the complete reviewed year ledger and keeps missing history blocked', () => {
    const partial = facts({ 2024: '100' }).slice(0, -1);
    const result = calculateCanadaPersonalNonCapitalLossCarryforward2025(
      partial,
      decimal('500'),
    );
    expect(result.status).toBe('blocked');
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'missing-carryforward-fact',
        path: personalNonCapitalLossFactKey(2024),
      }),
    );
  });
});

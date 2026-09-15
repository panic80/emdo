import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FINANCE_TAX_PACKAGE_REGISTRY } from '../../index.js';
import {
  calculateCanadaOntario2025Components,
  CANADA_2025_FEDERAL_FORM_COLUMNS,
  ONTARIO_2025_FORM_COLUMNS,
} from './components.js';
import {
  CANADA_ON_2025_READINESS,
  CANADA_ON_2025_SOURCES,
} from './readiness.js';

const input = (taxableIncomeLine26000: string) => ({
  scope: CANADA_ON_2025_READINESS.scope,
  fullYearCanadianResident: true,
  ontarioResidentOnDecember31: true,
  hasPermanentEstablishmentOutsideOntario: false,
  taxableIncomeLine26000,
});

describe('2025 CRA annual form arithmetic components (not a complete return)', () => {
  it('pins the downloaded CRA source bytes and official annual form constants', () => {
    for (const reference of CANADA_ON_2025_SOURCES) {
      const bytes = readFileSync(
        new URL(`./sources/${reference.localFile}`, import.meta.url),
      );
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(
        reference.documentHash,
      );
    }
    // Independent source comparison catches accidental use of the 2025 14% payroll withholding table.
    const federal = readFileSync(
      new URL('./sources/5006-r-25e.txt', import.meta.url),
      'utf8',
    );
    expect(federal).toContain('Line 73: Rate 14.5%');
    expect(federal).toContain('Line 75: 8,319.38');
    expect(federal).toContain('Line 75: 20,081.25');
    expect(federal).toContain('Line 75: 36,495.57');
    expect(federal).toContain('Line 75: 58,399.85');
    expect(
      CANADA_2025_FEDERAL_FORM_COLUMNS.map((column) => column.base),
    ).toEqual(['0', '8319.38', '20081.25', '36495.57', '58399.85']);
    const ontario = readFileSync(
      new URL('./sources/5006-c-25e.txt', import.meta.url),
      'utf8',
    );
    expect(ontario).toContain('Line 7: 2,670.74');
    expect(ontario).toContain('Line 7: 7,510.09');
    expect(ontario).toContain('Line 7: 12,445.60');
    expect(ontario).toContain('Line 7: 20,957.60');
    expect(ONTARIO_2025_FORM_COLUMNS.map((column) => column.base)).toEqual([
      '0',
      '2670.74',
      '7510.09',
      '12445.60',
      '20957.60',
    ]);
  });

  // Independently calculated with Python Decimal from the CRA annual column instructions.
  // These are arithmetic fixtures, not CRA-certified whole-return examples or rounded tax amounts.
  it.each([
    ['0', '0', 1],
    ['57375', '8319.375', 1],
    ['57375.01', '8319.38205', 2],
    ['60000', '8857.505', 2],
    ['114750', '20081.255', 2],
    ['114750.01', '20081.2526', 3],
    ['150000', '29246.25', 3],
    ['177882', '36495.57', 3],
    ['177882.01', '36495.5729', 4],
    ['200000', '42909.79', 4],
    ['253414', '58399.85', 4],
    ['253414.01', '58399.8533', 5],
    ['300000', '73773.23', 5],
  ])(
    'replays federal annual-form income %s exactly',
    (income, expected, column) => {
      const result = calculateCanadaOntario2025Components(input(income));
      expect(result.components.federalTaxOnTaxableIncome.exactAmount).toBe(
        expected,
      );
      expect(
        result.components.federalTaxOnTaxableIncome.calculation.column,
      ).toBe(column);
    },
  );
  it.each([
    ['0', '0', 1],
    ['52886', '2670.743', 1],
    ['52886.01', '2670.740915', 2],
    ['60000', '3321.671', 2],
    ['105775', '7510.0835', 2],
    ['105775.01', '7510.091116', 3],
    ['150000', '12445.6', 3],
    ['150000.01', '12445.601216', 4],
    ['220000', '20957.6', 4],
    ['220000.01', '20957.601316', 5],
    ['300000', '31485.6', 5],
  ])(
    'replays Ontario annual-form income %s exactly',
    (income, expected, column) => {
      const result = calculateCanadaOntario2025Components(input(income));
      expect(result.components.ontarioTaxOnTaxableIncome.exactAmount).toBe(
        expected,
      );
      expect(
        result.components.ontarioTaxOnTaxableIncome.calculation.column,
      ).toBe(column);
    },
  );
  it.each([
    ['0', '0'],
    ['20000', '0'],
    ['20000.01', '0.0006'],
    ['22500', '150'],
    ['25000', '300'],
    ['25000.01', '300'],
    ['36000', '300'],
    ['36000.01', '300.0006'],
    ['37000', '360'],
    ['38500', '450'],
    ['38500.01', '450'],
    ['48000', '450'],
    ['48000.01', '450.0025'],
    ['48300', '525'],
    ['48600', '600'],
    ['48600.01', '600'],
    ['72000', '600'],
    ['72000.01', '600.0025'],
    ['72300', '675'],
    ['72600', '750'],
    ['72600.01', '750'],
    ['200000', '750'],
    ['200000.01', '750.0025'],
    ['200300', '825'],
    ['200600', '900'],
    ['200600.01', '900'],
    ['1000000', '900'],
  ])(
    'checks Ontario health-premium chart boundary or interpolation %s',
    (income, expected) => {
      expect(
        calculateCanadaOntario2025Components(input(income)).components
          .ontarioHealthPremium.exactAmount,
      ).toBe(expected);
    },
  );
  it.each([
    ['0', '0', '0', '0', '0'],
    ['5710', '0', '5710', '0', '0'],
    ['5710.01', '0', '5710.01', '0.002', '0'],
    ['7307', '0', '7307', '319.4', '0'],
    ['7307.01', '0', '7307.01', '319.402', '0.0036'],
    ['10000', '1000', '9000', '658', '609.48'],
    ['10', '20', '0', '0', '0'],
  ])(
    'uses ON428 line 62 %s minus split-income tax %s as surtax base',
    (line62, taxOnSplitIncomeLine54, line65, line66, line67) => {
      const result = calculateCanadaOntario2025Components({
        ...input('100000'),
        ontarioSurtaxInputs: { line62, taxOnSplitIncomeLine54 },
      });
      expect(result.components.ontarioSurtax?.calculation).toEqual({
        line65,
        line66,
        line67,
      });
      if (line62 === '10000')
        expect(result.components.ontarioSurtax?.exactAmount).toBe('1267.48');
    },
  );
  it('does not infer surtax from taxable income, aggregate liability, or permit full-return completion', () => {
    const result = calculateCanadaOntario2025Components(input('60000'));
    expect(result.components.ontarioSurtax).toBeNull();
    expect(result.missingComponentInputs).toHaveLength(2);
    expect(result.status).toBe('components-only');
    expect(result.complete).toBe(false);
    expect(result).not.toHaveProperty('totalTax');
    expect(result).not.toHaveProperty('refund');
    expect(
      result.components.federalTaxOnTaxableIncome.reportableAmount,
    ).toBeNull();
    expect(result.releaseBlockerIds).toContain('rounding-policy');
    expect(CANADA_ON_2025_READINESS.registryEligible).toBe(false);
    expect(FINANCE_TAX_PACKAGE_REGISTRY.list()).toEqual([]);
  });
  it('preserves printed bases and fractional cents instead of silently choosing a final rounding policy', () => {
    const atThreshold = calculateCanadaOntario2025Components(input('114750'));
    const aboveThreshold = calculateCanadaOntario2025Components(
      input('114750.01'),
    );
    expect(atThreshold.components.federalTaxOnTaxableIncome.exactAmount).toBe(
      '20081.255',
    );
    expect(
      aboveThreshold.components.federalTaxOnTaxableIncome.exactAmount,
    ).toBe('20081.2526');
    expect(atThreshold.components.federalTaxOnTaxableIncome.status).toBe(
      'rounding-review-required',
    );
  });
  it('requires exact year, subdivision, taxpayer, form and domestic applicability', () => {
    for (const patch of [
      { country: 'US' },
      { subdivision: 'CA-QC' },
      { taxpayerType: 'sole-proprietor' },
      { taxpayerType: 'corporation' },
      { year: 2026 },
      { regime: 'payroll' },
      { formVersion: 'latest' },
    ])
      expect(() =>
        calculateCanadaOntario2025Components({
          ...input('0'),
          scope: { ...input('0').scope, ...patch },
        }),
      ).toThrow();
    for (const patch of [
      { fullYearCanadianResident: false },
      { ontarioResidentOnDecember31: false },
      { hasPermanentEstablishmentOutsideOntario: true },
    ])
      expect(() =>
        calculateCanadaOntario2025Components({ ...input('0'), ...patch }),
      ).toThrow();
  });
  it.each([
    '-1',
    '0.001',
    '1e6',
    '10,000',
    'NaN',
    '',
    ' 0',
    '1000000000000000',
  ])('rejects invalid CAD input %s', (value) => {
    expect(() => calculateCanadaOntario2025Components(input(value))).toThrow();
  });
  it('is deterministic and freezes source/version/input/output evidence', () => {
    const facts = input('300000.25');
    const first = calculateCanadaOntario2025Components(facts);
    expect(first).toEqual(calculateCanadaOntario2025Components(facts));
    facts.taxableIncomeLine26000 = '0';
    expect(first.inputs.taxableIncomeLine26000).toBe('300000.25');
    expect(Object.isFrozen(first.components)).toBe(true);
    expect(Object.isFrozen(first.sources[0])).toBe(true);
  });
});

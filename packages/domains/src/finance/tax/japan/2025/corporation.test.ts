import { describe, expect, it } from 'vitest';
import { type FinanceTaxIntake } from '@emdo/contracts';
import {
  JAPAN_2025_CORPORATION_CANDIDATE,
  JAPAN_2025_CORPORATION_REQUIRED_FACTS,
  evaluateJapan2025StandaloneCorporation,
  runJapan2025StandaloneCorporation,
} from './corporation.js';

const sourceHash = 'd'.repeat(64);

function fixture(
  returnType: 'blue' | 'white' = 'blue',
  overrides: Record<string, string | boolean> = {},
): FinanceTaxIntake {
  const defaults: Record<string, string | boolean> = {
    'corporation.returnType': returnType,
    'corporation.legalName': 'Example K.K.',
    'corporation.corporateNumber': '1234567890123',
    'corporation.address': 'Tokyo-to Minato-ku',
    'corporation.fiscalStart': '2025-01-01',
    'corporation.fiscalEnd': '2025-12-31',
    'corporation.fiscalMonths': '12',
    'corporation.isDomesticOrdinary': true,
    'corporation.isStandalone': true,
    'corporation.isSmallCompany': true,
    'corporation.notExcludedCompany': true,
    'corporation.capital': '1000000',
    'corporation.noTaxAdjustments': true,
    'corporation.noTaxCredits': true,
    'corporation.noForeignTax': true,
    'corporation.noDeficits': true,
    'corporation.noConsolidatedGroup': true,
    'corporation.noSpecialTaxMeasures': true,
    'corporation.noInterimPayments': true,
    'corporation.accountingProfit': '688750',
    'corporation.taxableIncome': '688750',
    'corporation.incomeTaxWithheld': '0',
    'corporation.interimCorporateTax': '0',
    'corporation.interimLocalCorporateTax': '0',
  };
  const values = { ...defaults, ...overrides };
  return {
    schemaVersion: 1,
    caseId: '00000000-0000-4000-8000-000000000021',
    workspaceId: '00000000-0000-4000-8000-000000000022',
    taxSubjectId: '00000000-0000-4000-8000-000000000023',
    legalEntityId: '00000000-0000-4000-8000-000000000024',
    sourceBooks: [],
    revision: 1,
    scope: { ...JAPAN_2025_CORPORATION_CANDIDATE.scope },
    domesticResident: true,
    hasCrossBorderActivity: false,
    standaloneCorporation: true,
    requestedFeatures: ['income-tax-return'],
    facts: JAPAN_2025_CORPORATION_REQUIRED_FACTS.map((definition) => ({
      key: definition.key,
      reviewState: 'reviewed' as const,
      value: {
        type: definition.type,
        value:
          values[definition.key] ??
          ('equals' in definition ? definition.equals : '0'),
      } as FinanceTaxIntake['facts'][number]['value'],
      source: {
        kind: 'declaration' as const,
        reference: `Independent Japan 2025 corporation ${returnType} fixture`,
        revision: 1,
        contentHash: sourceHash,
      },
    })),
  };
}

describe('Japan 2025 standalone corporation Form 1 chain', () => {
  it('calculates the NTA small-company 15% and national local corporate tax chain exactly', () => {
    const result = runJapan2025StandaloneCorporation(fixture());
    expect(result.status).toBe('incomplete-corporate-working-papers');
    expect(result.selectedComplete).toBe(true);
    expect(result.formDataReady).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.reportable).toBe(false);
    expect(result.fileable).toBe(false);
    expect(result.calculations).toMatchObject({
      accountingProfit: '688750',
      taxableIncome: '688750',
      taxableIncomeThousandFloor: '688000',
      smallRateBase: '688000',
      excessRateBase: '0',
      corporateTax: '103200',
      corporateTaxDeclared: '103200',
      localCorporateTaxExact: '10629.3/5',
      localCorporateTaxDeclared: '10600',
      combinedDeclared: '113800',
    });
    expect(
      result.fields.find((field) => field.id === 'corporation.corporateTax'),
    ).toMatchObject({
      exactYen: '103200',
      sourceId: 'nta-jp-r07-corporation-guide',
    });
  });

  it('supports the selected white Form 1 rate branch with the same explicit gates', () => {
    const result = evaluateJapan2025StandaloneCorporation(fixture('white'));
    expect(result.returnType).toBe('white');
    expect(result.selectedComplete).toBe(true);
    expect(result.formCoverage[0]).toMatchObject({
      id: 'JP-Corporation-Form-1-White',
      complete: true,
      sourceId: 'nta-jp-r07-corporation-form-1-white',
    });
  });

  it('fails closed for adjustments, large capital, tax mismatches and invalid identity', () => {
    const adjustment = runJapan2025StandaloneCorporation(
      fixture('blue', { 'corporation.noTaxAdjustments': false }),
    );
    expect(adjustment.status).toBe('blocked-input');
    expect(adjustment.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'unsupported-fact' }),
      ]),
    );

    const capital = runJapan2025StandaloneCorporation(
      fixture('blue', { 'corporation.capital': '100000001' }),
    );
    expect(capital.issues).toContainEqual(
      expect.objectContaining({ code: 'small-company-capital-limit' }),
    );

    const mismatch = runJapan2025StandaloneCorporation(
      fixture('blue', { 'corporation.taxableIncome': '688751' }),
    );
    expect(mismatch.issues).toContainEqual(
      expect.objectContaining({
        code: 'taxable-income-reconciliation-mismatch',
      }),
    );

    const number = runJapan2025StandaloneCorporation(
      fixture('blue', { 'corporation.corporateNumber': '123' }),
    );
    expect(number.issues).toContainEqual(
      expect.objectContaining({ code: 'invalid-corporate-number' }),
    );
  });

  it('fails closed instead of throwing for malformed cross-field monetary facts', () => {
    const malformedCapital = runJapan2025StandaloneCorporation(
      fixture('blue', { 'corporation.capital': '1000000.01' }),
    );
    expect(malformedCapital.status).toBe('blocked-input');
    expect(malformedCapital.issues).toContainEqual(
      expect.objectContaining({ code: 'invalid-money' }),
    );

    const malformedProfit = runJapan2025StandaloneCorporation(
      fixture('blue', { 'corporation.accountingProfit': '688750.01' }),
    );
    expect(malformedProfit.status).toBe('blocked-input');
    expect(malformedProfit.issues).toContainEqual(
      expect.objectContaining({ code: 'invalid-money' }),
    );
  });
});

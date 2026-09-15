import { describe, expect, it } from 'vitest';
import { type FinanceTaxIntake } from '@emdo/contracts';
import {
  JAPAN_2025_SOLE_PROPRIETOR_CANDIDATE,
  JAPAN_2025_SOLE_PROPRIETOR_REQUIRED_FACTS,
  evaluateJapan2025SoleProprietorSchedules,
  runJapan2025SoleProprietorSchedules,
} from './sole-proprietor.js';

const sourceHash = 'c'.repeat(64);

function fixture(
  returnType: 'white' | 'blue',
  overrides: Record<string, string | boolean> = {},
): FinanceTaxIntake {
  const defaults: Record<string, string | boolean> = {
    'return.type': returnType,
    'business.taxpayerName': 'Aiko Example',
    'business.tradeName': 'Example Studio',
    'business.address': 'Tokyo-to Chiyoda-ku',
    'business.industry': 'Design services',
    'business.fiscalStart': '2025-01-01',
    'business.fiscalEnd': '2025-12-31',
    'business.singleActivity': true,
    'business.noEmployees': true,
    'business.noInventory': true,
    'business.noConsumptionTax': true,
    'business.noOtherIncome': true,
    'business.noLossCarryforward': true,
    'business.noSpecialExpenses': true,
    'business.noVehicleHomeOffice': true,
    'business.grossReceipts': '1000000',
    'business.salesReturns': '0',
    'business.costOfSales': '0',
    'business.personnel': '0',
    'business.outsourcing': '0',
    'business.rent': '100000',
    'business.utilities': '20000',
    'business.communication': '10000',
    'business.supplies': '50000',
    'business.travel': '0',
    'business.advertising': '0',
    'business.insurance': '0',
    'business.taxesAndDues': '0',
    'business.interest': '0',
    'business.depreciation': '0',
    'business.otherExpenses': '120000',
    'return.blueBooksComplete': true,
    'return.blueSpecialDeduction': '0',
    'balance.cash': '700000',
    'balance.accountsReceivable': '0',
    'balance.inventory': '0',
    'balance.fixedAssets': '0',
    'balance.otherAssets': '0',
    'balance.accountsPayable': '0',
    'balance.loans': '0',
    'balance.otherLiabilities': '0',
    'balance.capital': '700000',
  };
  const values = { ...defaults, ...overrides };
  return {
    schemaVersion: 1,
    caseId: '00000000-0000-4000-8000-000000000011',
    workspaceId: '00000000-0000-4000-8000-000000000012',
    taxSubjectId: '00000000-0000-4000-8000-000000000013',
    legalEntityId: null,
    sourceBooks: [],
    revision: 1,
    scope: { ...JAPAN_2025_SOLE_PROPRIETOR_CANDIDATE.scope },
    domesticResident: true,
    hasCrossBorderActivity: false,
    standaloneCorporation: null,
    requestedFeatures: ['income-tax-return'],
    facts: JAPAN_2025_SOLE_PROPRIETOR_REQUIRED_FACTS.filter(
      (definition) => !definition.when || definition.when === returnType,
    ).map((definition) => ({
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
        reference: `Independent Japan 2025 ${returnType} schedule fixture`,
        revision: 1,
        contentHash: sourceHash,
      },
    })),
  };
}

describe('Japan 2025 sole-proprietor general schedules', () => {
  it('calculates the selected ordinary white-return business schedule exactly', () => {
    const result = runJapan2025SoleProprietorSchedules(fixture('white'));
    expect(result.status).toBe('incomplete-schedule-working-papers');
    expect(result.selectedComplete).toBe(true);
    expect(result.formDataReady).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.reportable).toBe(false);
    expect(result.fileable).toBe(false);
    expect(result.returnType).toBe('white');
    expect(result.calculations).toMatchObject({
      grossReceipts: '1000000',
      adjustedGrossReceipts: '1000000',
      totalExpenses: '300000',
      netBusinessIncomeBeforeBlueDeduction: '700000',
      blueSpecialDeduction: '0',
      netBusinessIncome: '700000',
    });
    expect(
      result.fields.find((field) => field.id === 'schedule.netBusinessIncome'),
    ).toMatchObject({
      exactYen: '700000',
      sourceId: 'nta-jp-r07-white-business-general-guide',
    });
  });

  it('requires and reconciles the selected blue-return balance-sheet subset', () => {
    const result = evaluateJapan2025SoleProprietorSchedules(fixture('blue'));
    expect(result.selectedComplete).toBe(true);
    expect(result.returnType).toBe('blue');
    expect(result.scheduleCoverage[0]).toMatchObject({
      id: 'JP-Blue-Business-General',
      complete: true,
    });
    expect(
      result.fields.find((field) => field.id === 'schedule.balanceDifference'),
    ).toMatchObject({ exactYen: '0' });
    expect(result.calculations?.netBusinessIncome).toBe('700000');
  });

  it('fails closed for unsupported return branches, money shape and blue balance evidence', () => {
    const unsupported = fixture('white', { 'return.type': 'agriculture' });
    expect(runJapan2025SoleProprietorSchedules(unsupported).status).toBe(
      'blocked-input',
    );

    const fractional = fixture('white', { 'business.rent': '100000.01' });
    expect(runJapan2025SoleProprietorSchedules(fractional).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'invalid-money' }),
      ]),
    );

    const blueDeduction = fixture('blue', {
      'return.blueSpecialDeduction': '100000',
    });
    const deductionResult = runJapan2025SoleProprietorSchedules(blueDeduction);
    expect(deductionResult.status).toBe('blocked-input');

    const unbalanced = fixture('blue', { 'balance.capital': '699999' });
    expect(
      runJapan2025SoleProprietorSchedules(unbalanced).issues,
    ).toContainEqual(
      expect.objectContaining({ code: 'blue-balance-sheet-unbalanced' }),
    );
  });
});

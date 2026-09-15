import { describe, expect, it } from 'vitest';
import { type FinanceTaxIntake } from '@emdo/contracts';
import {
  JAPAN_2025_LOCAL_TAX_REQUIRED_FACTS,
  prepareJapan2025LocalTaxHandoff,
} from './local-tax.js';

const sourceHash = 'e'.repeat(64);

function fixture(
  overrides: Record<string, string | boolean> = {},
): FinanceTaxIntake {
  const defaults: Record<string, string | boolean> = {
    'localTax.prefecture': 'Tokyo',
    'localTax.municipality': 'Chiyoda-ku',
    'localTax.addressAt2026-01-01': 'Tokyo-to Chiyoda-ku',
    'localTax.noNonSalaryIncome': true,
    'localTax.collectionMethodAcknowledged': 'special-withholding-if-assessed',
    'localTax.noMinorDependants': true,
    'localTax.noRetirementRelatives': true,
    'localTax.noDesignatedDonations': true,
    'localTax.noResidentTaxCreditAdjustments': true,
  };
  const values = { ...defaults, ...overrides };
  return {
    schemaVersion: 1,
    caseId: '00000000-0000-4000-8000-000000000031',
    workspaceId: '00000000-0000-4000-8000-000000000032',
    taxSubjectId: '00000000-0000-4000-8000-000000000033',
    legalEntityId: null,
    sourceBooks: [],
    revision: 1,
    scope: {
      country: 'JP',
      subdivision: 'JP-NATIONAL',
      taxpayerType: 'individual',
      year: 2025,
      regime: 'income-tax-return',
      formVersion: 'r07-form-1-2',
    },
    domesticResident: true,
    hasCrossBorderActivity: false,
    standaloneCorporation: null,
    requestedFeatures: ['income-tax-return'],
    facts: JAPAN_2025_LOCAL_TAX_REQUIRED_FACTS.map((definition) => ({
      key: definition.key,
      reviewState: 'reviewed' as const,
      value: {
        type: definition.type,
        value:
          values[definition.key] ??
          ('equals' in definition ? definition.equals : ''),
      } as FinanceTaxIntake['facts'][number]['value'],
      source: {
        kind: 'declaration' as const,
        reference: `Independent Japan local-tax handoff fact ${definition.key}`,
        revision: 1,
        contentHash: sourceHash,
      },
    })),
  };
}

describe('Japan 2025 local-tax handoff', () => {
  it('prepares the proven NTA Form 2 handoff without inventing a municipal liability', () => {
    const result = prepareJapan2025LocalTaxHandoff(fixture());
    expect(result.status).toBe('handoff-working-papers');
    expect(result.selectedComplete).toBe(true);
    expect(result.formDataReady).toBe(true);
    expect(result.calculationComplete).toBe(false);
    expect(result.taxLiability).toBeNull();
    expect(result.authorityCalculationRequired).toBe(true);
    expect(result.municipalityRateSchedule).toBeNull();
    expect(result.complete).toBe(false);
    expect(result.reportable).toBe(false);
  });

  it('fails closed when a local field is missing or not reviewed', () => {
    const missing = fixture();
    missing.facts = missing.facts.filter(
      (fact) => fact.key !== 'localTax.municipality',
    );
    const missingResult = prepareJapan2025LocalTaxHandoff(missing);
    expect(missingResult.status).toBe('blocked-input');
    expect(missingResult.selectedComplete).toBe(false);
    expect(missingResult.issues).toContainEqual(
      expect.objectContaining({
        code: 'missing-or-unreviewed-local-tax-fact',
        message: 'localTax.municipality',
      }),
    );

    const unreviewed = fixture();
    unreviewed.facts.find(
      (fact) => fact.key === 'localTax.prefecture',
    )!.reviewState = 'unreviewed';
    const unreviewedResult = prepareJapan2025LocalTaxHandoff(unreviewed);
    expect(unreviewedResult.selectedComplete).toBe(false);
  });
});

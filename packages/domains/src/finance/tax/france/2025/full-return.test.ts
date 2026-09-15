import { describe, expect, it } from 'vitest';
import {
  FRANCE_2025_SELECTED_FIELD_CATALOG,
  FRANCE_2025_SELECTED_REQUIRED_FACTS,
  FRANCE_2025_SELECTED_SCOPES,
  assessFrance2025SelectedReturnFacts,
  exportFrance2025Return,
  runFrance2025SelectedReturn,
  serializeFrance2025ReturnExport,
  type France2025ReturnKind,
  type France2025SelectedFactRequirement,
  type France2025SelectedReturnRun,
} from './package.js';
import type { FinanceTaxIntake, FinanceTaxValue } from '@emdo/contracts';
import { report } from './exact.js';

const source = {
  kind: 'declaration' as const,
  reference: 'Independently authored France selected-return fixture',
  revision: 1,
  contentHash: 'b'.repeat(64),
};

const ids = {
  caseId: '00000000-0000-4000-8000-000000000201',
  workspaceId: '00000000-0000-4000-8000-000000000202',
  taxSubjectId: '00000000-0000-4000-8000-000000000203',
};

type Override = string | boolean;

function defaultValue(
  requirement: France2025SelectedFactRequirement,
  overrides: Readonly<Record<string, Override>>,
): Override {
  const override = overrides[requirement.key];
  if (override !== undefined) return override;
  if (requirement.expected !== undefined) return requirement.expected;
  if (requirement.type === 'boolean') return false;
  if (requirement.type === 'decimal') return '0';
  if (requirement.type === 'date') return '2025-01-01';
  return 'fixture';
}

function typedValue(
  type: 'decimal' | 'text' | 'boolean' | 'date',
  value: Override,
): FinanceTaxValue {
  if (type === 'boolean') return { type: 'boolean', value: value as boolean };
  if (type === 'decimal') return { type: 'decimal', value: value as string };
  if (type === 'date') return { type: 'date', value: value as string };
  return { type: 'text', value: value as string };
}

function makeIntake(
  returnKind: France2025ReturnKind,
  overrides: Readonly<Record<string, Override>> = {},
): FinanceTaxIntake {
  const requirements = FRANCE_2025_SELECTED_REQUIRED_FACTS[returnKind];
  const scope = FRANCE_2025_SELECTED_SCOPES[returnKind];
  return {
    schemaVersion: 1,
    ...ids,
    legalEntityId:
      returnKind === 'corporation'
        ? '00000000-0000-4000-8000-000000000204'
        : null,
    sourceBooks: [],
    revision: 1,
    scope: { ...scope },
    domesticResident: true,
    hasCrossBorderActivity: false,
    standaloneCorporation: returnKind === 'corporation' ? true : null,
    requestedFeatures: ['income-tax-return'],
    facts: requirements.map((requirement) => ({
      key: requirement.key,
      value: typedValue(requirement.type, defaultValue(requirement, overrides)),
      reviewState: 'reviewed' as const,
      source,
    })),
  };
}

function field(run: France2025SelectedReturnRun, key: string) {
  const result = run.fields.find((entry) => entry.key === key);
  if (!result) throw new Error(`selected-field-missing:${key}`);
  return result;
}

describe('France 2025 selected return forms and deterministic branches', () => {
  it('publishes an explicit field catalog for the selected 2042 and annex scope', () => {
    expect(FRANCE_2025_SELECTED_FIELD_CATALOG).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: '2042.1AJ',
          formId: '2042',
          line: '1AJ',
          sourceId: 'dgfip-fr-form-2042-2026',
        }),
        expect.objectContaining({
          id: '2042.8HV',
          formId: '2042',
          line: '8HV',
        }),
        expect.objectContaining({
          id: '2042-C-PRO.5KP',
          formId: '2042-C-PRO',
          line: '5KP',
        }),
        expect.objectContaining({
          id: '2065.C1',
          formId: '2065-SD',
          line: 'C1-normal',
        }),
        expect.objectContaining({
          id: '2050-2059-G.liasse',
          formId: '2050-2059-G',
        }),
      ]),
    );
  });

  it('runs the full supported salary case and reports 2042 values with source hashes', () => {
    const intake = makeIntake('salary', {
      'identity.nameAtBirth': 'Martin',
      'identity.givenNames': 'Alex',
      'identity.birthDate': '1990-04-05',
      'identity.birthPlace': 'Paris',
      'identity.addressAtJan2026': '1 Rue Example',
      'identity.postalCode': '75001',
      'identity.city': 'Paris',
      'identity.taxNumber': '1234567890123',
      'identity.phone': '0102030405',
      'identity.email': 'alex@example.test',
      'identity.bankDetailsProvided': true,
      'employment.grossSalary': '30000',
      'pas.withheld': '1500',
    });
    const run = runFrance2025SelectedReturn(intake);
    expect(run.status).toBe('review-calculation-produced');
    expect(run.issues).toEqual([]);
    expect(run.provenance.returnForm).toBe('2042-2026');
    expect(run.calculation?.returnKind).toBe('salary');
    if (!run.calculation || run.calculation.returnKind !== 'salary')
      throw new Error('salary-calculation-missing');
    expect(report(run.calculation.netTaxableExact)).toBe('27000');
    expect(run.calculation.taxBeforeFamilyCap).toBe(1694n);
    expect(run.calculation.decote).toBe(130n);
    expect(run.calculation.taxAfterCollectionThreshold).toBe(1564n);
    expect(report(run.calculation.balanceExact)).toBe('64');
    expect(field(run, '1AJ.grossSalary')).toMatchObject({
      decision: 'populated',
      reportableValue: '30000',
      sourceId: 'dgfip-fr-form-2042-2026',
      documentHash:
        'ddf48d388d9b4c69650d3985499aaabb1af757a9b43211979ea663701c46ef2d',
    });
    expect(field(run, 'family.C')).toMatchObject({
      decision: 'populated',
      reportableValue: 'true',
    });
    expect(field(run, '1AK.actualExpenses').decision).toBe('inapplicable');
    expect(field(run, 'identity.nameAtBirth')).toMatchObject({
      decision: 'populated',
      sensitive: true,
    });
    expect(field(run, 'identity.signatureStatus').decision).toBe(
      'user-required',
    );
    expect(run.formApplicability.formDataReady).toBe(false);
    expect(run.formApplicability.forms).toHaveLength(1);
    expect(run.complete).toBe(false);
    expect(run.enabled).toBe(false);
    expect(run.reportable).toBe(false);
  });

  it('runs the ordinary micro-BIC services sole-proprietor branch and maps 2042-C-PRO', () => {
    const run = runFrance2025SelectedReturn(
      makeIntake('sole-proprietor', {
        'identity.nameAtBirth': 'Bernard',
        'identity.givenNames': 'Noa',
        'identity.birthDate': '1985-02-03',
        'identity.birthPlace': 'Lyon',
        'identity.addressAtJan2026': '2 Rue Example',
        'identity.postalCode': '69001',
        'identity.city': 'Lyon',
        'identity.taxNumber': '2345678901234',
        'identity.phone': '0102030406',
        'identity.email': 'noa@example.test',
        'identity.bankDetailsProvided': true,
        'business.incomeCategory': 'BIC-services',
        'business.grossReceipts': '40000',
        'business.operatorName': 'Bernard',
        'business.operatorGivenNames': 'Noa',
        'business.operatorAddress': '2 Rue Example',
        'business.siret': '12345678901234',
        'pas.independentAdvance': '400',
      }),
    );
    expect(run.status).toBe('review-calculation-produced');
    expect(run.issues).toEqual([]);
    if (!run.calculation || run.calculation.returnKind !== 'sole-proprietor')
      throw new Error('sole-proprietor-calculation-missing');
    expect(run.calculation.incomeCategory).toBe('BIC-services');
    expect(report(run.calculation.abatement)).toBe('20000');
    expect(report(run.calculation.taxableBusinessIncome)).toBe('20000');
    expect(run.calculation.taxAfterCollectionThreshold).toBe(445n);
    expect(report(run.calculation.balanceExact)).toBe('45');
    expect(field(run, '5KP.microBicServicesReceipts')).toMatchObject({
      decision: 'populated',
      reportableValue: '40000',
    });
    expect(field(run, '5HV.microBncGrossReceipts').decision).toBe(
      'inapplicable',
    );
    expect(field(run, '5HQ.microBncTaxableIncome').decision).toBe(
      'inapplicable',
    );
    expect(field(run, 'business.operatorIdentity')).toMatchObject({
      decision: 'populated',
      sensitive: true,
    });
    expect(field(run, '8HW.independentAdvance2025')).toMatchObject({
      decision: 'populated',
      reportableValue: '400',
    });
    expect(run.formCoverage.map((form) => form.formId)).toEqual([
      '2042',
      '2042-C-PRO',
    ]);
  });

  it('keeps the micro-BNC branch separate from the 5KP BIC line', () => {
    const run = runFrance2025SelectedReturn(
      makeIntake('sole-proprietor', {
        'identity.nameAtBirth': 'Bernard',
        'identity.givenNames': 'Noa',
        'identity.birthDate': '1985-02-03',
        'identity.birthPlace': 'Lyon',
        'identity.addressAtJan2026': '2 Rue Example',
        'identity.postalCode': '69001',
        'identity.city': 'Lyon',
        'identity.taxNumber': '2345678901234',
        'identity.phone': '0102030406',
        'identity.email': 'noa@example.test',
        'business.incomeCategory': 'BNC',
        'business.grossReceipts': '40000',
        'business.operatorName': 'Bernard',
        'business.operatorGivenNames': 'Noa',
        'business.operatorAddress': '2 Rue Example',
        'business.siret': '12345678901234',
      }),
    );
    expect(run.issues).toEqual([]);
    if (!run.calculation || run.calculation.returnKind !== 'sole-proprietor')
      throw new Error('sole-proprietor-calculation-missing');
    expect(report(run.calculation.taxableBusinessIncome)).toBe('26400');
    expect(run.calculation.taxAfterCollectionThreshold).toBe(1468n);
    expect(field(run, '5KP.microBicServicesReceipts').decision).toBe(
      'inapplicable',
    );
    expect(field(run, '5HV.microBncGrossReceipts')).toMatchObject({
      decision: 'populated',
      reportableValue: '40000',
    });
    expect(field(run, '5HQ.microBncTaxableIncome')).toMatchObject({
      decision: 'populated',
      reportableValue: '26400',
    });
  });

  it('runs the standalone real-normal corporation branch with an explicit liasse gap', () => {
    const run = runFrance2025SelectedReturn(
      makeIntake('corporation', {
        'corporate.name': 'Example SAS',
        'corporate.siret': '98765432101234',
        'corporate.registeredOffice': '3 Rue Example, Paris',
        'corporate.activity': 'Consulting',
        'corporate.accountingResult': '100000',
        'corporate.taxableProfit': '100000',
        'corporate.annualTurnover': '100000',
        'corporate.taxInstallments': '5000',
      }),
    );
    expect(run.status).toBe('review-calculation-produced');
    expect(run.issues).toEqual([]);
    expect(run.provenance.returnForm).toBe('2065-SD-2026_2050-2059-G-2026');
    if (!run.calculation || run.calculation.returnKind !== 'corporation')
      throw new Error('corporation-calculation-missing');
    expect(report(run.calculation.taxableProfit)).toBe('100000');
    expect(run.calculation.reducedRateEligible).toBe(false);
    expect(run.calculation.reducedRateProfit.n).toBe(0n);
    expect(run.calculation.normalRateProfit.n).toBe(100000n);
    expect(run.calculation.incomeTax).toBe(25000n);
    expect(run.calculation.balance).toBe(20000n);
    expect(field(run, '2058-A.taxableProfit')).toMatchObject({
      decision: 'populated',
      reportableValue: '100000',
    });
    expect(field(run, '2058-A.deficit').decision).toBe('inapplicable');
    expect(field(run, '2065.normalRateProfit')).toMatchObject({
      decision: 'populated',
      reportableValue: '100000',
    });
    expect(field(run, '2065.reducedRateProfit').decision).toBe('inapplicable');
    expect(field(run, '2050-2059-G.completeLiasse').decision).toBe(
      'user-required',
    );
    expect(run.formCoverage.map((form) => form.formId)).toEqual([
      '2050-2059-G',
      '2058-A-SD',
      '2065 bis-SD',
      '2065-SD',
    ]);
  });

  it('applies the qualifying-company 15% rate to the first €42,500', () => {
    const run = runFrance2025SelectedReturn(
      makeIntake('corporation', {
        'corporate.name': 'Example SAS',
        'corporate.siret': '98765432101234',
        'corporate.registeredOffice': '3 Rue Example, Paris',
        'corporate.activity': 'Consulting',
        'corporate.accountingResult': '100000',
        'corporate.taxableProfit': '100000',
        'corporate.annualTurnover': '100000',
        'corporate.reducedRateEligible': true,
        'corporate.capitalFullyPaid': true,
        'corporate.capitalNaturalPersonOwnership': true,
      }),
    );
    expect(run.issues).toEqual([]);
    if (!run.calculation || run.calculation.returnKind !== 'corporation')
      throw new Error('corporation-calculation-missing');
    expect(run.calculation.reducedRateProfit.n).toBe(42500n);
    expect(run.calculation.normalRateProfit.n).toBe(57500n);
    expect(run.calculation.incomeTax).toBe(20750n);
    expect(field(run, '2065.reducedRateProfit')).toMatchObject({
      decision: 'populated',
      reportableValue: '42500',
    });
  });

  it('exports a deterministic redacted report and preserves the private identity seam', () => {
    const run = runFrance2025SelectedReturn(
      makeIntake('salary', {
        'identity.nameAtBirth': 'Martin',
        'identity.givenNames': 'Alex',
        'identity.birthDate': '1990-04-05',
        'identity.birthPlace': 'Paris',
        'identity.addressAtJan2026': '1 Rue Example',
        'identity.postalCode': '75001',
        'identity.city': 'Paris',
        'identity.taxNumber': '1234567890123',
        'identity.phone': '0102030405',
        'identity.email': 'alex@example.test',
        'identity.bankDetailsProvided': true,
        'employment.grossSalary': '30000',
      }),
    );
    const first = exportFrance2025Return(run);
    const second = exportFrance2025Return(run);
    expect(first).toEqual(second);
    expect(first.redactedSensitiveFields).toBe(true);
    expect(
      first.forms
        .flatMap((form) => form.fields)
        .find((entry) => entry.key === 'identity.nameAtBirth')?.value,
    ).toBeNull();
    expect(
      first.forms
        .flatMap((form) => form.fields)
        .find((entry) => entry.key === '1AJ.grossSalary')?.value,
    ).toBe('30000');
    expect(serializeFrance2025ReturnExport(first)).toBe(
      serializeFrance2025ReturnExport(second),
    );
    const privateExport = exportFrance2025Return(run, {
      includeSensitiveIdentity: true,
    });
    expect(privateExport.redactedSensitiveFields).toBe(false);
    expect(
      privateExport.forms
        .flatMap((form) => form.fields)
        .find((entry) => entry.key === 'identity.nameAtBirth')?.value,
    ).toBe('Martin');
  });

  it('fails closed for missing identity, unsupported feature, thresholds, and corporate result mismatches', () => {
    const salary = makeIntake('salary', {
      'identity.nameAtBirth': 'Martin',
      'identity.givenNames': 'Alex',
      'identity.birthDate': '1990-04-05',
      'identity.birthPlace': 'Paris',
      'identity.addressAtJan2026': '1 Rue Example',
      'identity.postalCode': '75001',
      'identity.city': 'Paris',
      'identity.taxNumber': '1234567890123',
      'identity.phone': '0102030405',
      'identity.email': 'alex@example.test',
      'employment.grossSalary': '30000',
    });
    salary.facts = salary.facts.filter(
      (fact) => fact.key !== 'identity.taxNumber',
    );
    const missing = runFrance2025SelectedReturn(salary);
    expect(missing.status).toBe('blocked-input');
    expect(missing.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'missing-fact',
          path: 'facts.identity.taxNumber',
        }),
      ]),
    );
    expect(missing.calculation).toBeNull();

    const payroll = makeIntake('salary');
    payroll.requestedFeatures = ['payroll'];
    expect(runFrance2025SelectedReturn(payroll).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'unsupported-feature' }),
      ]),
    );

    const sole = makeIntake('sole-proprietor', {
      'business.incomeCategory': 'BIC-services',
      'business.grossReceipts': '77700.01',
    });
    expect(assessFrance2025SelectedReturnFacts(sole).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'unsupported-business-threshold' }),
      ]),
    );

    const corporation = makeIntake('corporation', {
      'corporate.accountingResult': '100000',
      'corporate.taxableProfit': '99999',
    });
    expect(assessFrance2025SelectedReturnFacts(corporation).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'corporate-tax-result-mismatch' }),
      ]),
    );
  });
});

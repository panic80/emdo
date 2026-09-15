import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CanadaCorporate2025IntakeSchema,
  T2_2025_ADDITIONAL_SCHEDULE_TRIGGERS,
  T2_2025_EXPENSE_CODES,
  type CanadaCorporate2025Intake,
} from './intake.js';
import { CANADA_CORPORATE_2025_SOURCES } from './sources.js';
import { CORPORATE_XFA_FIELDS } from './xfa-inventory.js';
import { encodeCorporateFieldLosslessly } from './reporting.js';
import { validateCorporateFieldValue } from './field-validation.js';
import {
  CANADA_CORPORATE_2025_DEFINITION,
  CANADA_CORPORATE_2025_DEFINITION_HASH,
  canonicalCorporateJson,
  prepareCanadaCorporate2025Review,
} from './workflow.js';

function fixture(): CanadaCorporate2025Intake {
  return CanadaCorporate2025IntakeSchema.parse({
    schemaVersion: 1,
    currency: 'CAD',
    binding: {
      caseId: '55d9f01c-993c-4e3b-89d5-509c9cc1d430',
      snapshotRevision: 7,
      snapshotHash: 'a'.repeat(64),
    },
    sourceReferences: [
      { id: 'synthetic-financial-statements', sha256: 'b'.repeat(64) },
    ],
    identity: {
      legalName: 'Synthetic Review Services Inc.',
      legalNameContinuation: null,
      operatingName: 'Synthetic Review Services',
      businessNumber: '123456789RC0001',
      taxYearStart: '2025-01-01',
      taxYearEnd: '2025-12-31',
      province: 'ON',
      headOffice: {
        street: '1 Synthetic Street',
        city: 'Toronto',
        postalCode: 'M1A1A1',
      },
      addressesUnchangedAndSame: true,
      naics: '541611',
      activity: 'Management consulting services',
      principalActivityRevenuePercentage: '100',
      otherPrincipalActivities: [],
      shareholder: {
        name: 'Synthetic Owner',
        socialInsuranceNumber: '000000000',
        commonSharePercentage: '100',
        preferredSharePercentage: '0',
      },
      signingOfficer: {
        firstName: 'Synthetic',
        lastName: 'Owner',
        position: 'President',
        telephone: '4165550100',
        contactIsSigningOfficer: true,
      },
      correspondenceLanguage: 'en',
    },
    declarations: Object.fromEntries(
      Object.keys(CanadaCorporate2025IntakeSchema.shape.declarations.shape).map(
        (key) => [key, true],
      ),
    ),
    additionalInformation: {
      usesIfrs: false,
      taxExemptUnderSection149: false,
      quarterlyEligibilityCeasedOn: null,
      refundPreference: null,
      constructionIsMajorBusinessActivity: false,
      constructionSubcontractors: false,
      quarterlyInstalmentRemitterRequested: false,
    },
    attachmentAnswers: Object.fromEntries(
      Object.keys(T2_2025_ADDITIONAL_SCHEDULE_TRIGGERS).map((key) => [
        key,
        false,
      ]),
    ),
    priorYear: {
      refundableTaxHistory: {
        eligibleRdToh: '0',
        nonEligibleRdToh: '0',
        eligibleDividendRefund: '0',
        nonEligibleDividendRefund: '0',
        sourceReferenceId: 'synthetic-financial-statements',
      },
      taxableCapitalEmployedCanada: '100000',
      adjustedAggregateInvestmentIncome: '0',
      taxableIncome: '100000',
      businessLimit: '500000',
      federalSmallBusinessDeductionClaimed: true,
    },
    financialStatements: {
      incomeStatementActivity: 'non-farming',
      otherComprehensiveIncome: '0',
      costOfSales: { '8320': '0', '8340': '0', '8360': '0' },
      opening: {
        '1001': '10100',
        '1060': '0',
        '1483': '0',
        '2621': '0',
        '2680': '0',
        '3500': '100',
        '3600': '10000',
      },
      closing: {
        '1001': '110100',
        '1060': '0',
        '1483': '0',
        '2621': '0',
        '2680': '12200',
        '3500': '100',
        '3600': '97800',
      },
      tradeSales: '150000',
      operatingExpenses: {
        ...Object.fromEntries(T2_2025_EXPENSE_CODES.map((k) => [k, '0'])),
        '9060': '50000',
      },
      currentIncomeTaxProvision: '12200',
      notes: [
        'Synthetic fixture: ordinary accrual accounting; all amounts exclude recoverable HST.',
      ],
    },
    gifi141: {
      primaryPreparerIdentified: true,
      primaryPreparerAccountingDesignation: false,
      primaryPreparerConnected: true,
      involvement: ['304'],
      involvementOther: null,
      reservation: null,
      subsequentEvents: false,
      assetsRevalued: false,
      contingentLiabilities: false,
      commitments: false,
      jointVenturesOrPartnerships: false,
      impairmentOrFairValueChanges: false,
      financialInstrumentsDerecognized: false,
      hedgeAccountingApplied: false,
      hedgeAccountingDiscontinued: false,
      openingEquityAdjustment: false,
      returnPreparerIsPrimaryPreparer: true,
      returnPreparerAccountingDesignation: false,
      returnPreparerInputs: [],
      returnPreparerOther: null,
    },
    taxWithholding: { amount: '0', payments: '0', sourceReferenceId: null },
    taxInstalmentsPaid: '10000',
  });
}
function field(
  result: ReturnType<typeof prepareCanadaCorporate2025Review>,
  form: string,
  line: string,
) {
  const value = result.forms.find((f) => f.id === form)?.fields[line];
  if (value === null || typeof value !== 'object' || !('exactDecimal' in value))
    throw new Error(`missing-money:${form}:${line}`);
  return value;
}

describe('Canada 2025 corporate review pipeline', () => {
  it('classifies every official field once and binds identity without duplicating split values', () => {
    const result = prepareCanadaCorporate2025Review(fixture());
    if (result.status !== 'incomplete-review')
      throw new Error(JSON.stringify(result.issues));
    const fields = result.fieldCoverage.fields;
    expect(fields).toHaveLength(1618);
    expect(new Set(fields.map((f) => `${f.form}:${f.ordinal}`)).size).toBe(
      1618,
    );
    const t2 = (ordinal: number) =>
      fields.find((f) => f.form === 'T2' && f.ordinal === ordinal)!;
    expect([t2(2).value, t2(3).value, t2(4).value]).toEqual([
      '123456789',
      'RC',
      '0001',
    ]);
    expect([t2(7).value, t2(8).value]).toEqual([false, true]);
    expect([t2(32).value, t2(33).value, t2(36).value]).toEqual([
      true,
      false,
      false,
    ]);
    expect(t2(9).classification).toBe('inapplicable');
    expect(t2(6).classification).toBe('inapplicable');
    expect(
      fields.find((f) => f.form === 'S50' && f.ordinal === 6)?.classification,
    ).toBe('inapplicable');
    expect(
      result.fieldCoverage.attachments.find((a) => a.line === '173'),
    ).toMatchObject({
      answer: true,
      instruction: expect.stringContaining('Schedule 50'),
    });
    expect(
      result.fieldCoverage.attachments.find((a) => a.line === '208'),
    ).toMatchObject({
      answer: false,
      instruction: expect.stringContaining('Schedule 8'),
    });
    expect(result.fieldCoverage.unresolvedFields).toEqual([]);
    expect(result.issues.some((i) => i.code.includes('certified'))).toBe(false);
  });
  it('maps explicit additional activities, names and eligibility dates without assuming a single trade', () => {
    const input = fixture();
    input.identity.legalNameContinuation = 'Consulting Division';
    input.identity.principalActivityRevenuePercentage = '65.25';
    input.identity.otherPrincipalActivities = [
      { description: 'Training', revenuePercentage: '34.75' },
    ];
    input.additionalInformation.quarterlyEligibilityCeasedOn = '2025-07-01';
    const result = prepareCanadaCorporate2025Review(input);
    if (result.status !== 'incomplete-review') throw new Error('fixture');
    const f = result.fieldCoverage.fields;
    expect(f.find((v) => v.form === 'T2' && v.ordinal === 6)?.value).toBe(
      'Consulting Division',
    );
    expect(f.find((v) => v.form === 'T2' && v.ordinal === 138)?.value).toBe(
      'Training',
    );
    expect(f.find((v) => v.form === 'T2' && v.ordinal === 139)?.value).toBe(
      '34.75',
    );
    expect(
      f.find((v) => v.form === 'T2' && v.ordinal === 140)?.classification,
    ).toBe('inapplicable');
    expect(f.find((v) => v.form === 'T2' && v.ordinal === 148)?.value).toBe(
      '2025-07-01',
    );
    expect(result.forms.find((v) => v.id === 'GIFI125')?.fields['0001']).toBe(
      'Synthetic Review Services',
    );
  });
  it('maps refund preferences only for refunds and retains other-liability instructions as required', () => {
    for (const [preference, expected] of [
      ['refund', '1'],
      ['next-year-instalments', '2'],
      ['other-liability', null],
    ] as const) {
      const input = fixture();
      input.taxInstalmentsPaid = '12210';
      input.additionalInformation.refundPreference = preference;
      const result = prepareCanadaCorporate2025Review(input);
      if (result.status !== 'incomplete-review') throw new Error('fixture');
      const field = result.fieldCoverage.fields.find(
        (f) => f.form === 'T2' && f.ordinal === 345,
      )!;
      expect(field.value).toBe(expected);
      expect(field.classification).toBe(
        expected ? 'populated' : 'user-required',
      );
    }
  });
  it('requires the new questionnaire facts and rejects incompatible percentages, dates and exemptions', () => {
    for (const key of [
      'taxExemptUnderSection149',
      'quarterlyEligibilityCeasedOn',
    ]) {
      const input = structuredClone(fixture()) as unknown as {
        additionalInformation: Record<string, unknown>;
      };
      delete input.additionalInformation[key];
      expect(prepareCanadaCorporate2025Review(input).status).toBe(
        'blocked-input',
      );
    }
    for (const mutate of [
      (i: CanadaCorporate2025Intake) => {
        i.identity.principalActivityRevenuePercentage = '99.99';
      },
      (i: CanadaCorporate2025Intake) => {
        i.additionalInformation.quarterlyEligibilityCeasedOn = '2024-12-31';
      },
      (i: CanadaCorporate2025Intake) => {
        i.additionalInformation.taxExemptUnderSection149 = true;
      },
    ]) {
      const input = fixture();
      mutate(input);
      expect(prepareCanadaCorporate2025Review(input).status).toBe(
        'blocked-input',
      );
    }
  });
  it('classifies Schedule141 conditional questions using actual preparer facts', () => {
    const input = fixture();
    input.gifi141.primaryPreparerIdentified = false;
    input.gifi141.primaryPreparerAccountingDesignation = null;
    input.gifi141.primaryPreparerConnected = null;
    const result = prepareCanadaCorporate2025Review(input);
    if (result.status !== 'incomplete-review') throw new Error('fixture');
    const fields = result.fieldCoverage.fields.filter(
      (f) => f.form === 'GIFI141',
    );
    expect(fields.find((f) => f.ordinal === 8)?.classification).toBe(
      'inapplicable',
    );
    expect(fields.find((f) => f.ordinal === 37)?.classification).toBe(
      'inapplicable',
    );
    expect(fields.find((f) => f.ordinal === 55)?.classification).toBe(
      'inapplicable',
    );
  });
  it('calculates pages 5–7 intermediates and carries actual prior refundable pools', () => {
    const input = fixture();
    input.priorYear.refundableTaxHistory = {
      eligibleRdToh: '1500',
      nonEligibleRdToh: '2300',
      eligibleDividendRefund: '400',
      nonEligibleDividendRefund: '700',
      sourceReferenceId: 'synthetic-financial-statements',
    };
    const result = prepareCanadaCorporate2025Review(input);
    if (result.status !== 'incomplete-review') throw new Error('fixture');
    const t2 = result.forms.find((f) => f.id === 'T2')!.fields;
    const expected: Record<string, string> = {
      'p5.A': '100000',
      'p5.E': '100000',
      'p5.G': '100000',
      'p5.H': '0',
      'p5.I': '0',
      '638': '0',
      'p6.F': '100000',
      'p6.G': '100000',
      'p6.J': '100000',
      'p6.K': '0',
      'p6.L': '0',
      'p6.M': '9000',
      '450': '0',
      '520': '1500',
      '535': '2300',
      '530': '1100',
      '545': '1600',
      'p7.BB': '1100',
      'p7.EE': '1600',
      'p7.HH': '1100',
      'p7.CC': '0',
      'p7.FF': '0',
      'p7.II': '0',
      '784': '0',
    };
    for (const [key, value] of Object.entries(expected))
      expect(t2[key], key).toMatchObject({
        exactDecimal: value,
        reportableAmount: value,
      });
    expect(
      result.reporting.fields.find((f) => f.id === 'T2.p6.K')?.dependencies,
    ).toEqual(['T2.p6.F', 'T2.p6.J']);
    expect(
      result.fieldCoverage.fields
        .filter((f) => f.path.includes('.Page5.Tax_Reduction_sub.'))
        .every((f) => f.classification === 'inapplicable'),
    ).toBe(true);
  });
  it('preserves fractional historical pools and applies only explicitly directed zero floors', () => {
    const input = fixture();
    input.priorYear.refundableTaxHistory = {
      eligibleRdToh: '100.51',
      nonEligibleRdToh: '-20.50',
      eligibleDividendRefund: '0.02',
      nonEligibleDividendRefund: '5',
      sourceReferenceId: 'synthetic-financial-statements',
    };
    const result = prepareCanadaCorporate2025Review(input);
    if (result.status !== 'incomplete-review') throw new Error('fixture');
    const fields = result.forms.find((f) => f.id === 'T2')!.fields;
    expect(fields['530']).toMatchObject({
      exactDecimal: '100.49',
      reportableAmount: null,
    });
    expect(fields['535']).toMatchObject({ exactDecimal: '0' });
    expect(fields['545']).toMatchObject({ exactDecimal: '0' });
    expect(fields['784']).toMatchObject({ exactDecimal: '0' });
    const depleted = fixture();
    depleted.priorYear.refundableTaxHistory.eligibleRdToh = '10';
    depleted.priorYear.refundableTaxHistory.eligibleDividendRefund = '11';
    const other = prepareCanadaCorporate2025Review(depleted);
    if (other.status !== 'incomplete-review') throw new Error('fixture');
    expect(other.forms.find((f) => f.id === 'T2')!.fields['530']).toMatchObject(
      { exactDecimal: '0' },
    );
  });
  it('requires historical balances and evidence instead of inferring zero from no current dividends', () => {
    const raw = fixture() as unknown as { priorYear: Record<string, unknown> };
    delete raw.priorYear.refundableTaxHistory;
    expect(prepareCanadaCorporate2025Review(raw).status).toBe('blocked-input');
    const input = fixture();
    input.priorYear.refundableTaxHistory.sourceReferenceId = 'not-provided';
    const result = prepareCanadaCorporate2025Review(input);
    expect(result.status).toBe('blocked-input');
    expect(
      result.issues.some((i) => i.code === 'missing-pool-source-reference'),
    ).toBe(true);
  });
  it('reconciles income, SBD intermediates, federal totals and credits against hand calculations', () => {
    const result = prepareCanadaCorporate2025Review(fixture());
    if (result.status !== 'incomplete-review') throw new Error('fixture');
    const fields = result.forms.find((f) => f.id === 'T2')!.fields;
    expect(
      result.fieldCoverage.fields
        .filter(
          (f) =>
            f.form === 'T2' &&
            f.path.includes('.Page5.') &&
            f.assist?.startsWith('Line 490.'),
        )
        .every((f) => f.classification === 'inapplicable'),
    ).toBe(true);
    const expected = {
      'p3.B': '0',
      'p3.C': '100000',
      '360': '100000',
      'p4.C': '500000',
      'p4.E': '0',
      'p4.F': '-50000',
      'p4.G': '-250000',
      '422': '0',
      '426': '500000',
      '428': '500000',
      'p4.minimum': '100000',
      '430': '19000',
      'p8.F': '0',
      'p8.G': '100000',
      'p8.H': '100000',
      'p8.I': '0',
      '604': '0',
      'p8.K': '38000',
      'p8.L': '19000',
      'p8.M': '29000',
      'p8.N': '9000',
      '700': '9000',
      'p9.totalFederal': '9000',
      '770': '12200',
      '890': '10000',
      'p9.balance': '2200',
    };
    for (const [line, value] of Object.entries(expected))
      expect(fields[line], line).toMatchObject({
        exactDecimal: value,
        reportableAmount: value,
      });
    expect(
      result.reporting.fields.find((f) => f.id === 'T2.p9.totalFederal')
        ?.bindings[0]?.field.assist,
    ).toContain('Add lines 700');
  });
  it('adds evidence-backed withholding to credits without deducting it from gross trade income', () => {
    const input = fixture();
    input.taxInstalmentsPaid = '10000';
    input.taxWithholding = {
      amount: '2201.99',
      payments: '20000',
      sourceReferenceId: 'synthetic-financial-statements',
    };
    const result = prepareCanadaCorporate2025Review(input);
    if (result.status !== 'incomplete-review') throw new Error('fixture');
    const fields = result.forms.find((f) => f.id === 'T2')!.fields;
    expect(fields['300']).toMatchObject({ exactDecimal: '100000' });
    expect(fields['800']).toMatchObject({
      exactDecimal: '2201.99',
      reportableAmount: null,
    });
    expect(fields['801']).toMatchObject({ exactDecimal: '20000' });
    expect(fields['890']).toMatchObject({
      exactDecimal: '12201.99',
      reportableAmount: null,
    });
    expect(fields['p9.balance']).toMatchObject({
      exactDecimal: '-1.99',
      reportableAmount: null,
    });
    expect(fields.refund).toMatchObject({
      exactDecimal: '1.99',
      reportableAmount: null,
    });
    expect(fields.balanceOwing).toMatchObject({ exactDecimal: '0' });
    input.taxWithholding.sourceReferenceId = null;
    expect(prepareCanadaCorporate2025Review(input).status).toBe(
      'blocked-input',
    );
    input.taxWithholding = {
      amount: '1001',
      payments: '1000',
      sourceReferenceId: 'synthetic-financial-statements',
    };
    expect(prepareCanadaCorporate2025Review(input).status).toBe(
      'blocked-input',
    );
  });
  it('maps the Ontario 5A–5J chain and no-other-adjustment S1 totals', () => {
    const result = prepareCanadaCorporate2025Review(fixture());
    if (result.status !== 'incomplete-review')
      throw new Error(JSON.stringify(result.issues));
    for (const line of ['5A', '5C', '5E', '5F', '5G', '5I', '290'])
      expect(field(result, 'S5', line)).toMatchObject({
        exactDecimal: '3200',
        reportableAmount: '3200',
      });
    for (const line of ['5B', '5D', '5H', '5J'])
      expect(field(result, 'S5', line)).toMatchObject({
        exactDecimal: '0',
        reportableAmount: '0',
      });
    for (const line of ['102', '199', '499', 'D', 'E'])
      expect(field(result, 'S1', line)).toMatchObject({
        exactDecimal: '0',
        reportableAmount: '0',
      });
    expect(
      result.reporting.fields.find((f) => f.id === 'S5.5J')?.bindings,
    ).toHaveLength(2);
    expect(
      result.reporting.fields
        .find((f) => f.id === 'T2.632')
        ?.bindings.some((b) => b.field.path.includes('.Page6.')),
    ).toBe(true);
    expect(
      result.fieldCoverage.fields
        .filter((f) => f.form === 'S5' && f.path.includes('.Part1_SF.'))
        .every((f) => f.classification === 'inapplicable'),
    ).toBe(true);
    expect(
      result.fieldCoverage.fields
        .filter((f) => f.form === 'S5' && f.path.includes('.NS_SF.'))
        .every((f) => f.classification === 'inapplicable'),
    ).toBe(true);
  });
  it('enforces captured identifier, sequence and calendar constraints without inventing text rules', () => {
    const find = (form: string, ordinal: number) =>
      CORPORATE_XFA_FIELDS.find(
        (f) => f.form === form && f.ordinal === ordinal,
      )!;
    expect(find('S1', 3).maxChars).toBe(15);
    expect(
      validateCorporateFieldValue(find('S1', 3), '123456789RC0001').status,
    ).toBe('proven-rules-pass');
    expect(
      validateCorporateFieldValue(find('S1', 3), '123456789RC00012').status,
    ).toBe('invalid');
    expect(
      validateCorporateFieldValue(find('S50', 7), '12345678X').status,
    ).toBe('invalid');
    expect(validateCorporateFieldValue(find('GIFI125', 8), '01').status).toBe(
      'proven-rules-pass',
    );
    expect(validateCorporateFieldValue(find('GIFI125', 8), '1').status).toBe(
      'invalid',
    );
    expect(
      validateCorporateFieldValue(find('S1', 4), '2025-12-31').status,
    ).toBe('proven-rules-pass');
    expect(
      validateCorporateFieldValue(find('S1', 4), '2025-02-29').status,
    ).toBe('invalid');
    expect(
      validateCorporateFieldValue(find('T2', 5), 'Société Élan Inc.').status,
    ).toBe('rules-unresolved');
  });
  it('matches the official fixed GIFI controls and complete candidate return totals independently', () => {
    const result = prepareCanadaCorporate2025Review(fixture());
    if (result.status !== 'incomplete-review')
      throw new Error(JSON.stringify(result.issues));
    const expected = [
      ['GIFI100', 84, '2599', '110100'],
      ['GIFI100', 164, '3499', '12200'],
      ['GIFI100', 196, '3620', '97900'],
      ['GIFI100', 226, '3849', '97800'],
      ['GIFI125', 74, '8299', '150000'],
      ['GIFI125', 206, '9368', '50000'],
      ['GIFI125', 208, '9369', '100000'],
      ['GIFI125', 302, '9999', '87800'],
    ] as const;
    for (const [form, ordinal, code, value] of expected)
      expect(
        result.requiredControlManifest.requiredControls.find(
          (f) => f.form === form && f.ordinal === ordinal,
        ),
      ).toMatchObject({
        code,
        value,
        populated: true,
        applicableMappingPresent: true,
      });
    expect(
      result.requiredControlManifest.applicabilityResolved,
      JSON.stringify(
        result.requiredControlManifest.unresolvedApplicability.map((f) => [
          f.form,
          f.ordinal,
          f.assist,
        ]),
      ),
    ).toBe(true);
    expect(result.requiredControlManifest.requiredGifiMappingsComplete).toBe(
      true,
    );
    expect(result.requiredControlManifest.missingUserInputs).toEqual([]);
    expect(result.requiredControlManifest.completeReturn).toBe(false);
    expect(result.forms.map((f) => f.id)).toEqual([
      'GIFI100',
      'GIFI125',
      'GIFI141',
      'S1',
      'S50',
      'S500',
      'S5',
      'T2',
    ]);
    expect(field(result, 'T2', '700').exactDecimal).toBe('9000');
    expect(field(result, 'T2', '760').exactDecimal).toBe('3200');
    expect(field(result, 'T2', 'balanceOwing').exactDecimal).toBe('2200');
  });
  it('supports ordinary direct costs separately from operating expenses without changing net income', () => {
    const input = fixture();
    input.financialStatements.operatingExpenses['9060'] = '30000';
    input.financialStatements.costOfSales['8360'] = '20000';
    const result = prepareCanadaCorporate2025Review(input);
    if (result.status !== 'incomplete-review')
      throw new Error(JSON.stringify(result.issues));
    expect(field(result, 'GIFI125', '8518').exactDecimal).toBe('20000');
    expect(field(result, 'GIFI125', '9367').exactDecimal).toBe('30000');
    expect(field(result, 'GIFI125', '9368').exactDecimal).toBe('50000');
    expect(field(result, 'T2', '700').exactDecimal).toBe('9000');
    expect(
      result.reporting.fields.find((f) => f.id === 'GIFI125.8360')?.bindings[0]
        ?.field.assist,
    ).toContain('Cost of sales');
    input.financialStatements.operatingExpenses['9060'] = '29999.99';
    input.financialStatements.costOfSales['8360'] = '20000.01';
    const fractional = prepareCanadaCorporate2025Review(input);
    if (fractional.status !== 'incomplete-review')
      throw new Error(JSON.stringify(fractional.issues));
    expect(field(fractional, 'T2', '700')).toMatchObject({
      exactDecimal: '9000',
      reportableAmount: null,
    });
    expect(
      fractional.requiredControlManifest.requiredGifiMappingsComplete,
    ).toBe(true);
    expect(fractional.requiredControlManifest.requiredGifiValuesAvailable).toBe(
      false,
    );
    input.financialStatements.incomeStatementActivity = 'farming';
    expect(prepareCanadaCorporate2025Review(input).status).toBe(
      'blocked-input',
    );
    input.financialStatements.incomeStatementActivity = 'non-farming';
    input.financialStatements.otherComprehensiveIncome = '0.01';
    expect(prepareCanadaCorporate2025Review(input).status).toBe(
      'blocked-input',
    );
  });
  it('pins successful and rejected reviews to the versioned source manifest', () => {
    const expected = createHash('sha256')
      .update(canonicalCorporateJson(CANADA_CORPORATE_2025_DEFINITION))
      .digest('hex');
    expect(CANADA_CORPORATE_2025_DEFINITION_HASH).toBe(expected);
    for (const raw of [fixture(), {}]) {
      const result = prepareCanadaCorporate2025Review(raw);
      expect(result.packageVersion).toBe('2025.7');
      expect(result.definitionHash).toBe(expected);
      expect(result.workflowId).toBe(
        CANADA_CORPORATE_2025_DEFINITION.workflowId,
      );
      expect(result.complete).toBe(false);
    }
  });
  it('maps implemented money fields to public XFA paths and permits lossless resolved field values without claiming a complete return', () => {
    const result = prepareCanadaCorporate2025Review(fixture());
    if (!('reporting' in result)) throw new Error('missing-reporting-proof');
    expect(
      result.reporting.fields.filter(
        (f) => f.encodingStatus === 'field-mapping-unproven',
      ),
    ).toEqual([]);
    expect(
      result.reporting.fields.filter(
        (f) => f.status === 'reporting-dependencies-unproven',
      ),
    ).toEqual([]);
    expect(field(result, 'T2', '700').reportableAmount).toBe('9000');
    expect(field(result, 'S5', '255').reportableAmount).toBe('3200');
    expect(
      result.reporting.fields.find((f) => f.id === 'T2.700')?.bindings[0]
        ?.field,
    ).toMatchObject({
      sourceFile: 't2-fill-25e.pdf',
      path: 'form1.Page9.Summary_sub.Amount_700',
      decimalPlaces: 0,
      maxIntegerDigits: 12,
    });
    const cash = result.reporting.fields.find((f) => f.id === 'GIFI100.1001');
    expect(cash?.bindings[0]?.companionCodeValue).toBe('1001');
    expect(cash?.bindings[0]?.companionCodeField?.assist).toBe(
      'Assets. Field code. Row 1.',
    );
    expect(result.reporting.coverage.every((c) => c.complete === false)).toBe(
      true,
    );
    expect(
      result.reporting.coverage.some(
        (c) => c.unclassifiedInventoryFields.length > 0,
      ),
    ).toBe(true);
    expect(
      result.reporting.numericNonMoneyFields.map((f) => [
        f.id,
        f.reportableValue,
      ]),
    ).toEqual([
      ['S50.400', '100.00'],
      ['S50.500', '0.00'],
      ['S500.1B', '11.5'],
      ['S500.2K', '1.0000'],
    ]);
    expect(result.complete).toBe(false);
    expect(result.filingAvailable).toBe(false);
  });

  it('blocks reporting of integer subtotals when fractional source-line rounding is unresolved', () => {
    const input = fixture();
    input.financialStatements.tradeSales = '150000.50';
    input.financialStatements.operatingExpenses['9060'] = '50000.50';
    const result = prepareCanadaCorporate2025Review(input);
    expect(result.status).toBe('incomplete-review');
    expect(field(result, 'T2', '700').exactDecimal).toBe('9000');
    expect(field(result, 'T2', '700').reportableAmount).toBeNull();
    expect(field(result, 'GIFI125', '9369').exactDecimal).toBe('100000');
    if (!('reporting' in result)) throw new Error('missing-reporting-proof');
    expect(
      result.reporting.fields.find((f) => f.id === 'GIFI125.9369'),
    ).toMatchObject({
      encodingStatus: 'lossless-at-proven-precision',
      encodedAmount: '100000',
      status: 'upstream-reporting-unresolved',
      reportableAmount: null,
    });
    expect(field(result, 'T2', '410').reportableAmount).toBe('500000');
  });

  it('proves integer field range and leaves .49/.50/.51 and negative ties unresolved without rounding', () => {
    const evidence = CORPORATE_XFA_FIELDS.find(
      (f) => f.form === 'T2' && f.path.endsWith('.Amount_840'),
    )!;
    for (const value of ['10.49', '10.50', '10.51', '-10.50'])
      expect(encodeCorporateFieldLosslessly(value, evidence)).toEqual({
        status: 'rounding-rule-required',
        encodedAmount: null,
      });
    expect(encodeCorporateFieldLosslessly('999999999999', evidence)).toEqual({
      status: 'lossless-at-proven-precision',
      encodedAmount: '999999999999',
    });
    expect(encodeCorporateFieldLosslessly('1000000000000', evidence)).toEqual({
      status: 'outside-proven-field-range',
      encodedAmount: null,
    });
    expect(encodeCorporateFieldLosslessly('-20.0000', evidence)).toEqual({
      status: 'lossless-at-proven-precision',
      encodedAmount: '-20',
    });
    expect(
      encodeCorporateFieldLosslessly('-0.0000', evidence).encodedAmount,
    ).toBe('0');
  });

  it('preserves independently proven percentage/ratio precision instead of applying monetary integer precision to every numeric field', () => {
    const rate = CORPORATE_XFA_FIELDS.find(
      (f) => f.form === 'S500' && f.path.endsWith('.Amt_1B_11-5Prct'),
    )!;
    const factor = CORPORATE_XFA_FIELDS.find(
      (f) => f.form === 'S500' && f.path.endsWith('.Amt_2K'),
    )!;
    const shares = CORPORATE_XFA_FIELDS.find(
      (f) =>
        f.form === 'S50' &&
        f.assist === 'Line 400. Percentage common shares. Row 1.',
    )!;
    expect(encodeCorporateFieldLosslessly('11.5', rate).encodedAmount).toBe(
      '11.5',
    );
    expect(encodeCorporateFieldLosslessly('11.55', rate).status).toBe(
      'rounding-rule-required',
    );
    expect(encodeCorporateFieldLosslessly('1', factor).encodedAmount).toBe(
      '1.0000',
    );
    expect(encodeCorporateFieldLosslessly('0.99995', factor).status).toBe(
      'rounding-rule-required',
    );
    expect(encodeCorporateFieldLosslessly('100', shares).encodedAmount).toBe(
      '100.00',
    );
  });

  it('pins the full1618-field public catalog and its extraction references to the captured PDFs', () => {
    const raw = JSON.parse(
      readFileSync(
        new URL('./sources/xfa-field-inventory.json', import.meta.url),
        'utf8',
      ),
    ) as Array<{
      form: string;
      ordinal: number;
      path: string;
      sourceFile: string;
      sourceSha256: string;
      uiPicture: string | null;
      formatPicture: string | null;
    }>;
    expect(raw).toHaveLength(1618);
    expect(CORPORATE_XFA_FIELDS).toHaveLength(1618);
    expect(new Set(raw.map((f) => `${f.form}:${f.ordinal}`)).size).toBe(1618);
    for (const f of CORPORATE_XFA_FIELDS) {
      const extracted = raw.find(
        (r) => r.form === f.form && r.ordinal === f.ordinal,
      )!;
      expect(extracted.path).toBe(f.path);
      expect(extracted.uiPicture).toBe(f.uiPicture);
      expect(extracted.formatPicture).toBe(f.formatPicture);
      expect(extracted.sourceSha256).toBe(
        CANADA_CORPORATE_2025_SOURCES.find((s) => s.file === f.sourceFile)
          ?.sha256,
      );
    }
  });

  it('freezes returned graphs, normalized intake and shared provenance without freezing the caller input', () => {
    const input = fixture();
    const result = prepareCanadaCorporate2025Review(input);
    const before = result.reviewExport;
    expect(() => Reflect.set(result.coverage, 'id', 'tampered')).not.toThrow();
    expect(Reflect.set(result.coverage, 'id', 'tampered')).toBe(false);
    expect(Reflect.set(result.sources[0]!, 'sha256', '0'.repeat(64))).toBe(
      false,
    );
    expect(Reflect.set(result.forms[0]!.fields, '2599', 'tampered')).toBe(
      false,
    );
    expect(Reflect.set(result.forms[0]!.dependsOn, '0', 'tampered')).toBe(
      false,
    );
    expect(Reflect.set(result.issues, '0', { code: 'tampered' })).toBe(false);
    if (!('intake' in result)) throw new Error('missing-normalized-intake');
    expect(
      Reflect.set(result.intake.financialStatements, 'tradeSales', '1'),
    ).toBe(false);
    expect(Reflect.set(result.reviewExport!, 'content', 'tampered')).toBe(
      false,
    );
    expect(prepareCanadaCorporate2025Review(input).reviewExport).toEqual(
      before,
    );
    input.financialStatements.notes.push(
      'Caller remains independently mutable.',
    );
    expect(result.intake.financialStatements.notes).not.toContain(
      'Caller remains independently mutable.',
    );
    expect(
      prepareCanadaCorporate2025Review(input).reviewExport?.sha256,
    ).not.toBe(before?.sha256);
    for (const blocked of [
      prepareCanadaCorporate2025Review({}),
      prepareCanadaCorporate2025Review({
        ...fixture(),
        identity: { ...fixture().identity, province: 'QC' },
      }),
    ]) {
      expect(Object.isFrozen(blocked)).toBe(true);
      expect(Reflect.set(blocked.forms, '0', 'tampered')).toBe(false);
      expect(Reflect.set(blocked.issues[0]!, 'code', 'tampered')).toBe(false);
    }
  });

  it('retains zero-provision Schedule1 only as a worksheet consistently with T2 answer201', () => {
    const input = fixture();
    input.financialStatements.currentIncomeTaxProvision = '0';
    input.financialStatements.closing['2680'] = '0';
    input.financialStatements.closing['3600'] = '110000';
    const result = prepareCanadaCorporate2025Review(input);
    expect(result.status).toBe('incomplete-review');
    expect(result.forms.find((f) => f.id === 'S1')?.purpose).toBe('worksheet');
    expect(result.forms.find((f) => f.id === 'T2')?.fields['201']).toBe(false);
    expect(field(result, 'S1', 'C').exactDecimal).toBe('100000');
    expect(result.issues.map((i) => i.code)).toContain(
      'book-tax-provision-differs-from-calculation',
    );
    expect(result.complete).toBe(false);
    expect(result.reviewExport).toEqual(
      prepareCanadaCorporate2025Review(input).reviewExport,
    );
  });

  it('matches independently worked $100k ABI return and cross-form reconciliation', () => {
    // CRA T2: 38,000 - 10,000 abatement - 19,000 SBD = 9,000.
    // Ontario S500: 11,500 - 8,300 SBD = 3,200. Total 12,200; instalments 10,000.
    const result = prepareCanadaCorporate2025Review(fixture());
    expect(result.status).toBe('incomplete-review');
    for (const [form, line, expected] of [
      ['GIFI100', '2599', '110100'],
      ['GIFI100', '3640', '110100'],
      ['GIFI100', '3849', '97800'],
      ['GIFI125', '9999', '87800'],
      ['S1', '101', '12200'],
      ['S1', 'C', '100000'],
      ['T2', '550', '38000'],
      ['T2', '608', '10000'],
      ['T2', '430', '19000'],
      ['T2', '700', '9000'],
      ['S500', '1C', '11500'],
      ['S500', '2O', '8300'],
      ['S5', '290', '3200'],
      ['S5', '255', '3200'],
      ['T2', '760', '3200'],
      ['T2', '770', '12200'],
      ['T2', 'balanceOwing', '2200'],
    ])
      expect(field(result, form, line).exactDecimal).toBe(expected);
    expect(result.forms.map((f) => f.id)).toEqual([
      'GIFI100',
      'GIFI125',
      'GIFI141',
      'S1',
      'S50',
      'S500',
      'S5',
      'T2',
    ]);
    expect(result.forms.find((f) => f.id === 'S500')?.purpose).toBe(
      'worksheet',
    );
    expect(result.forms.find((f) => f.id === 'T2')?.fields['205']).toBe(true);
  });

  it('keeps every fractional input and sub-cent tax result exact without redefining coverage', () => {
    const input = fixture();
    input.financialStatements.tradeSales = '150000.01';
    input.financialStatements.closing['1001'] = '110100.01';
    input.financialStatements.closing['3600'] = '97800.01';
    // Independently: extra one cent * 9% = .0009; *.032 = .00032; *.122=.00122.
    const result = prepareCanadaCorporate2025Review(input);
    expect(result.status).toBe('incomplete-review');
    expect(field(result, 'T2', '700')).toMatchObject({
      exactDecimal: '9000.0009',
      numerator: '90000009',
      denominator: '10000',
      reportableAmount: null,
    });
    expect(field(result, 'T2', '760').exactDecimal).toBe('3200.00032');
    expect(field(result, 'T2', '770').exactDecimal).toBe('12200.00122');
    expect(result.issues.map((i) => i.code)).toContain(
      'book-tax-provision-differs-from-calculation',
    );
    expect(field(result, 'T2', '700').reportableAmount).toBeNull();
    expect(field(result, 'T2', '410').reportableAmount).toBe('500000');
    expect(field(result, 'GIFI100', '3500').reportableAmount).toBe('100');
  });

  it('evaluates the $500,000 SBD ceiling and blocks unsupported general-rate cases', () => {
    const input = fixture();
    input.financialStatements.tradeSales = '550000';
    input.financialStatements.currentIncomeTaxProvision = '61000';
    input.financialStatements.closing['1001'] = '510100';
    input.financialStatements.closing['2680'] = '61000';
    input.financialStatements.closing['3600'] = '449000';
    const result = prepareCanadaCorporate2025Review(input);
    expect(field(result, 'T2', '700').exactDecimal).toBe('45000');
    expect(field(result, 'T2', '760').exactDecimal).toBe('16000');
    input.financialStatements.tradeSales = '550000.01';
    expect(
      prepareCanadaCorporate2025Review(input).issues.map((i) => i.code),
    ).toContain('unsupported-taxable-income');
  });

  it('exports a refund exactly and never suppresses the CRA two-dollar administrative threshold', () => {
    const input = fixture();
    input.taxInstalmentsPaid = '12201.99';
    const result = prepareCanadaCorporate2025Review(input);
    expect(field(result, 'T2', 'refund').exactDecimal).toBe('1.99');
    expect(field(result, 'T2', 'balanceOwing').exactDecimal).toBe('0');
  });

  it('blocks every triggered or unknown required additional schedule rather than discarding it', () => {
    for (const code of Object.keys(
      T2_2025_ADDITIONAL_SCHEDULE_TRIGGERS,
    ) as (keyof CanadaCorporate2025Intake['attachmentAnswers'])[]) {
      for (const value of [true, null]) {
        const input = fixture();
        input.attachmentAnswers[code] = value;
        const result = prepareCanadaCorporate2025Review(input);
        expect(result.status, code).toBe('blocked-input');
        expect(
          result.issues.some((i) => i.path === `attachmentAnswers.${code}`),
          code,
        ).toBe(true);
        expect(result.reviewExport).toBeNull();
      }
    }
  });

  it('requires complete explicit scope facts, rejects unsupported jurisdiction/year and unknown input keys', () => {
    const input = fixture();
    input.declarations.noInventoryOrCapitalAssets = null;
    expect(prepareCanadaCorporate2025Review(input).issues).toContainEqual(
      expect.objectContaining({
        code: 'missing-fact',
        path: 'declarations.noInventoryOrCapitalAssets',
      }),
    );
    const foreign = fixture();
    foreign.identity.province = 'QC';
    expect(prepareCanadaCorporate2025Review(foreign).status).toBe(
      'blocked-input',
    );
    const shortYear = fixture();
    shortYear.identity.taxYearStart = '2025-02-01';
    expect(prepareCanadaCorporate2025Review(shortYear).status).toBe(
      'blocked-input',
    );
    expect(
      prepareCanadaCorporate2025Review({
        ...fixture(),
        useUnapprovedElection: true,
      }).status,
    ).toBe('blocked-input');
    const partial = { ...fixture(), attachmentAnswers: {} };
    expect(prepareCanadaCorporate2025Review(partial).status).toBe(
      'blocked-input',
    );
  });

  it('rejects contradictory balance sheets, retained earnings and pre-existing business-limit reductions', () => {
    const unbalanced = fixture();
    unbalanced.financialStatements.closing['1001'] = '1';
    expect(
      prepareCanadaCorporate2025Review(unbalanced).issues.map((i) => i.code),
    ).toContain('unbalanced-financial-statements');
    const retained = fixture();
    retained.financialStatements.closing['1001'] = '110101';
    retained.financialStatements.closing['3600'] = '97801';
    expect(
      prepareCanadaCorporate2025Review(retained).issues.map((i) => i.code),
    ).toContain('retained-earnings-reconciliation-failed');
    const passive = fixture();
    passive.priorYear.adjustedAggregateInvestmentIncome = '0.01';
    expect(
      prepareCanadaCorporate2025Review(passive).issues.map((i) => i.code),
    ).toContain('unsupported-business-limit-reduction');
  });

  it('uses the actual prior business limit for line896 instead of assuming a full prior-year limit', () => {
    const input = fixture();
    input.priorYear.businessLimit = '90000';
    expect(
      prepareCanadaCorporate2025Review(input).forms.find((f) => f.id === 'T2')
        ?.fields['896'],
    ).toBe(false);
  });

  it('does not fabricate preparer responses, notes, audit reservations or signature', () => {
    const input = fixture();
    input.gifi141.involvement = ['300'];
    expect(
      prepareCanadaCorporate2025Review(input).issues.map((i) => i.path),
    ).toContain('gifi141.reservation');
    input.gifi141.reservation = true;
    expect(prepareCanadaCorporate2025Review(input).status).toBe(
      'blocked-input',
    );
    const result = prepareCanadaCorporate2025Review(fixture());
    expect(result.forms.find((f) => f.id === 'GIFI141')?.fields['095']).toBe(
      false,
    );
    expect(result.forms.find((f) => f.id === 'GIFI141')?.fields.notes).toEqual(
      fixture().financialStatements.notes,
    );
    expect(
      result.forms.find((f) => f.id === 'T2')?.fields.signature,
    ).toBeNull();
  });

  it('produces a replayable private review export with canonical hashes independent of object key order', () => {
    const input = fixture();
    const result = prepareCanadaCorporate2025Review(input);
    const reversed = Object.fromEntries(Object.entries(input).reverse());
    expect(prepareCanadaCorporate2025Review(reversed).reviewExport).toEqual(
      result.reviewExport,
    );
    expect(result.reviewExport).not.toBeNull();
    if (!result.reviewExport) throw new Error('missing-review-export');
    const payload = JSON.parse(result.reviewExport.content);
    expect(payload.binding).toEqual(input.binding);
    expect(
      prepareCanadaCorporate2025Review(payload.intake).reviewExport,
    ).toEqual(result.reviewExport);
    expect(payload.inputHash).toBe(
      createHash('sha256').update(canonicalCorporateJson(input)).digest('hex'),
    );
    expect(
      createHash('sha256').update(result.reviewExport.content).digest('hex'),
    ).toBe(result.reviewExport.sha256);
    expect(payload.complete).toBe(false);
    expect(payload.filingAvailable).toBe(false);
    expect(payload.issues.map((i: { code: string }) => i.code)).toEqual(
      expect.arrayContaining(['t2-and-gifi-rounding-authority-unresolved']),
    );
    input.binding.snapshotRevision++;
    expect(
      prepareCanadaCorporate2025Review(input).reviewExport?.sha256,
    ).not.toBe(result.reviewExport.sha256);
  });

  it('pins every official source byte and locator used by the form graph', () => {
    const research = JSON.parse(
      readFileSync(
        new URL('./sources/rounding-research.json', import.meta.url),
        'utf8',
      ),
    ) as { file: string; sha256: string; decision: string };
    expect(
      createHash('sha256')
        .update(
          readFileSync(new URL(`./sources/${research.file}`, import.meta.url)),
        )
        .digest('hex'),
    ).toBe(research.sha256);
    expect(research.decision).toContain('Not applicable authority');
    for (const source of CANADA_CORPORATE_2025_SOURCES) {
      const bytes = readFileSync(
        new URL(`./sources/${source.file}`, import.meta.url),
      );
      expect(bytes.length).toBe(source.bytes);
      expect(
        createHash('sha256').update(bytes).digest('hex'),
        source.file,
      ).toBe(source.sha256);
      expect(new URL(source.url).hostname).toBe('www.canada.ca');
      expect(source.locator.length).toBeGreaterThan(10);
    }
    const result = prepareCanadaCorporate2025Review(fixture());
    for (const f of result.forms)
      expect(
        CANADA_CORPORATE_2025_SOURCES.some((s) => s.file === f.sourceFile),
      ).toBe(true);
    const seen = new Set<string>();
    for (const form of result.forms) {
      for (const dependency of form.dependsOn)
        expect(seen.has(dependency), `${form.id} → ${dependency}`).toBe(true);
      seen.add(form.id);
    }
  });
});

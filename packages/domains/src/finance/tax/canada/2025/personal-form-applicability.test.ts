import { describe, it, expect } from 'vitest';
import type { FinanceTaxIntake } from '@emdo/contracts';
import {
  CANADA_ON_2025_PERSONAL_QUESTIONS,
  runCanadaOntario2025PersonalWorkflow,
} from './personal-package.js';
import { auditCanadaOntario2025PersonalFormApplicability as audit } from './personal-form-applicability.js';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function input(
  type: 'individual' | 'sole-proprietor' = 'individual',
): FinanceTaxIntake {
  return {
    schemaVersion: 1,
    caseId: id(1),
    workspaceId: id(2),
    taxSubjectId: id(3),
    legalEntityId: null,
    sourceBooks: [],
    revision: 1,
    scope: {
      country: 'CA',
      subdivision: 'CA-ON',
      taxpayerType: type,
      year: 2025,
      regime: 'income-tax-return',
      formVersion: '5006-R-E-25_5006-C-E-25',
    },
    domesticResident: true,
    hasCrossBorderActivity: false,
    standaloneCorporation: null,
    requestedFeatures: ['income-tax-return'],
    facts: CANADA_ON_2025_PERSONAL_QUESTIONS.map((x) => ({
      key: x.key,
      value:
        x.type === 'boolean'
          ? {
              type: 'boolean',
              value:
                !x.key.startsWith('educator.') &&
                x.key !== 'business.methodChanged',
            }
          : x.type === 'text'
            ? {
                type: 'text',
                value: x.key === 'business.incomeKind' ? 'business' : 'accrual',
              }
            : x.type === 'date'
              ? { type: 'date', value: '1990-01-01' }
              : { type: 'decimal', value: '0' },
      reviewState: 'reviewed',
      source: {
        kind: 'declaration',
        reference: `fixture:${x.key}`,
        revision: 1,
        contentHash: 'a'.repeat(64),
      },
    })),
  };
}

const source = {
  kind: 'declaration' as const,
  reference: 'synthetic-form-test',
  revision: 1,
  contentHash: 'b'.repeat(64),
};
function check(values: Record<string, string | boolean>, unreviewed?: string) {
  const run = runCanadaOntario2025PersonalWorkflow(input('sole-proprietor'));
  const facts: FinanceTaxIntake['facts'] = Object.entries(values).map(
    ([key, value]) => ({
      key,
      value:
        typeof value === 'boolean'
          ? { type: 'boolean', value }
          : {
              type:
                key.includes('Count') || key.includes('Percentage')
                  ? 'decimal'
                  : 'text',
              value,
            },
      reviewState: key === unreviewed ? 'unreviewed' : 'reviewed',
      source,
    }),
  );
  return audit(run, {
    caseId: run.inputSnapshot!.caseId,
    taxSubjectId: run.inputSnapshot!.taxSubjectId,
    revision: run.inputSnapshot!.revision,
    runHash: run.runHash,
    facts,
  });
}
const t2125 = (a: ReturnType<typeof check>) =>
  a.fields.filter((f) => f.sourceId === 'cra-t2125-2025-fillable');
describe('T2125 reviewed identification and internet fields', () => {
  it('requires reviewed preparer identity instead of treating its text field as manual signing', () => {
    const key = 'businessIdentity.preparerNameAndAddress';
    const preparer = (
      values: Record<string, string | boolean>,
      unreviewed?: string,
    ) =>
      t2125(check(values, unreviewed)).find((f) =>
        f.fieldPath.endsWith('.Prt1_Frm_inpt16'),
      )!;
    expect(preparer({}).decision).toBe('missing-input');
    expect(preparer({ [key]: '   ' }).decision).toBe('missing-input');
    expect(
      preparer({ [key]: 'Synthetic Preparer, 10 Example St, Ottawa ON' }, key)
        .decision,
    ).toBe('missing-input');
    const mapped = preparer({
      [key]: 'Synthetic Preparer, 10 Example St, Ottawa ON',
    });
    expect(mapped.decision).toBe('reviewed-input');
    expect(mapped.inputValue).toBe(
      'Synthetic Preparer, 10 Example St, Ottawa ON',
    );
    expect(mapped.selected).toBeNull();
    const result = check({
      [key]: 'Synthetic Preparer, 10 Example St, Ottawa ON',
    });
    expect(result.signature.status).toBe('manual-unperformed');
    expect(result.complete).toBe(false);
    expect(result.formDataReady).toBe(false);
  });
  it('transfers proprietor identity and selects exactly one last-year occurrence without touching accounting choices', () => {
    const fields = t2125(
      check({
        'identity.firstName': 'Alex',
        'identity.lastName': 'Sample',
        'identity.taxNumber': '123456789',
        'businessIdentity.lastBusinessYear': false,
      }),
    );
    expect(fields.find((f) => f.label === 'Your name.')?.inputValue).toBe(
      'Alex Sample',
    );
    expect(
      fields.find((f) => f.label.startsWith('Your social insurance'))
        ?.inputValue,
    ).toBe('123456789');
    const choices = fields.filter((f) => f.fieldPath.endsWith('cbGrp.cb'));
    expect(choices.map((f) => f.selected)).toEqual([false, true, null, null]);
    expect(choices.slice(2).every((f) => f.decision === 'not-applicable')).toBe(
      true,
    );
    expect(
      t2125(check({ 'businessIdentity.lastBusinessYear': true }))
        .filter((f) => f.fieldPath.endsWith('cbGrp.cb'))
        .map((f) => f.selected),
    ).toEqual([true, false, null, null]);
  });
  it('requires explicit applicability and validates the complete assigned program account', () => {
    const businessNumber = (values: Record<string, string | boolean>) =>
      t2125(check(values)).find((f) => f.label.startsWith('Business number.'))!;
    expect(businessNumber({}).decision).toBe('missing-input');
    expect(
      businessNumber({ 'businessIdentity.hasProgramAccount': false }).decision,
    ).toBe('not-applicable');
    expect(
      businessNumber({
        'businessIdentity.hasProgramAccount': true,
        'businessIdentity.programAccountNumber': '123456789',
      }).decision,
    ).toBe('missing-input');
    expect(
      businessNumber({
        'businessIdentity.hasProgramAccount': true,
        'businessIdentity.programAccountNumber': '123456789RT0001',
      }).inputValue,
    ).toBe('123456789RT0001');
  });
  it('maps exactly the applicable website slots and requires five main addresses when count exceeds five', () => {
    const values = {
      'businessIdentity.internetSiteCount': '2',
      'businessIdentity.internetSite1': 'example.com',
      'businessIdentity.internetSite2': 'example.org',
    };
    const sites = t2125(check(values)).filter((f) =>
      f.label.startsWith('Provide up to five'),
    );
    expect(sites.map((f) => f.decision)).toEqual([
      'reviewed-input',
      'reviewed-input',
      'not-applicable',
      'not-applicable',
      'not-applicable',
    ]);
    expect(sites[0].inputValue).toBe('example.com');
    expect(
      t2125(check({ 'businessIdentity.internetSiteCount': '6' }))
        .filter((f) => f.label.startsWith('Provide up to five'))
        .every((f) => f.decision === 'missing-input'),
    ).toBe(true);
    expect(
      t2125(check(values, 'businessIdentity.internetSiteCount'))
        .filter((f) => f.label.startsWith('Provide up to five'))
        .slice(2)
        .every((f) => f.decision === 'missing-input'),
    ).toBe(true);
    expect(
      check({
        'businessIdentity.internetSiteCount': '0',
        'businessIdentity.internetIncomePercentage': '1',
      }).issues,
    ).toContain(
      'contradictory-form-fact:businessIdentity.internetIncomePercentage',
    );
  });
});

describe('commission accounting controls bind the calculation snapshot', () => {
  it.each(['cash', 'accrual'] as const)(
    'selects only the reviewed %s occurrence',
    (method) => {
      const intake = input('sole-proprietor');
      intake.facts.find((f) => f.key === 'business.incomeKind')!.value = {
        type: 'text',
        value: 'commission',
      };
      intake.facts.find((f) => f.key === 'business.reportingMethod')!.value = {
        type: 'text',
        value: method,
      };
      const run = runCanadaOntario2025PersonalWorkflow(intake);
      expect(run.status).not.toBe('blocked');
      const controls = audit(run).fields.filter(
        (f) =>
          f.fieldPath.endsWith('cbGrp.cb') &&
          (f.occurrence === 2 || f.occurrence === 3),
      );
      expect(controls).toHaveLength(2);
      expect(controls.every((f) => f.decision === 'reviewed-input')).toBe(true);
      expect(
        controls.filter((f) => f.selected).map((f) => f.occurrence),
      ).toEqual([method === 'cash' ? 2 : 3]);
      intake.facts.find(
        (f) => f.key === 'business.reportingMethod',
      )!.reviewState = 'unreviewed';
      const blocked = audit(
        runCanadaOntario2025PersonalWorkflow(intake),
      ).fields.filter(
        (f) =>
          f.fieldPath.endsWith('cbGrp.cb') &&
          (f.occurrence === 2 || f.occurrence === 3),
      );
      expect(
        blocked.every(
          (f) => f.decision === 'missing-input' && f.selected === null,
        ),
      ).toBe(true);
    },
  );
});

describe('Ontario health premium selected-row applicability', () => {
  it('resolves only inactive row fields using the calculated taxable-income branch', () => {
    const intake = input();
    intake.facts.find((f) => f.key === 'interest')!.value = {
      type: 'decimal',
      value: '37000',
    };
    const run = runCanadaOntario2025PersonalWorkflow(intake);
    const fields = audit(run).fields.filter((f) =>
      f.fieldPath.includes('Chart_ON_Health_Prenium.Taxable_Line'),
    );
    expect(fields).toHaveLength(19);
    expect(
      fields
        .filter((f) => f.fieldPath.includes('Taxable_Line4.'))
        .every((f) => f.decision === 'mapped-amount'),
    ).toBe(true);
    expect(
      fields
        .filter((f) => !f.fieldPath.includes('Taxable_Line4.'))
        .every((f) => f.decision === 'not-applicable'),
    ).toBe(true);
    intake.facts.find((f) => f.key === 'interest')!.reviewState = 'unreviewed';
    const blocked = audit(
      runCanadaOntario2025PersonalWorkflow(intake),
    ).fields.filter((f) =>
      f.fieldPath.includes('Chart_ON_Health_Prenium.Taxable_Line'),
    );
    expect(blocked.every((f) => f.decision !== 'not-applicable')).toBe(true);
  });
});

describe('ON428 surtax threshold applicability', () => {
  it('skips only the four surtax operands for a calculated below-threshold branch', () => {
    const intake = input();
    const fields = (
      run: ReturnType<typeof runCanadaOntario2025PersonalWorkflow>,
    ) =>
      audit(run).fields.filter(
        (f) =>
          f.sourceId === 'cra-5006-c-2025-fillable' &&
          /^form1\.Page3\.Line(66|67)\.Amount[12]$/.test(f.fieldPath),
      );
    const excluded = fields(runCanadaOntario2025PersonalWorkflow(intake));
    expect(excluded).toHaveLength(4);
    expect(excluded.every((f) => f.decision === 'not-applicable')).toBe(true);
    intake.facts.find((f) => f.key === 'scope.noSpecialTaxes')!.reviewState =
      'unreviewed';
    expect(
      fields(runCanadaOntario2025PersonalWorkflow(intake)).every(
        (f) => f.decision !== 'not-applicable',
      ),
    ).toBe(true);
  });
});

describe('Ontario published bracket constants', () => {
  it('preserves readonly source constants independently of taxpayer completeness', () => {
    const intake = input();
    intake.facts = [];
    const fields = audit(
      runCanadaOntario2025PersonalWorkflow(intake),
    ).fields.filter(
      (f) =>
        f.sourceId === 'cra-5006-c-2025-fillable' &&
        /^form1\.Page1\.Chart\.Column[1-5]\.Line(3\.Amount|5\.Percent|7\.Amount)$/.test(
          f.fieldPath,
        ),
    );
    expect(fields).toHaveLength(15);
    expect(fields.every((f) => f.decision === 'source-layout')).toBe(true);
    expect(
      fields.find((f) => f.fieldPath.endsWith('Column1.Line5.Percent'))
        ?.inputValue,
    ).toBe('.0505');
    expect(
      fields.find((f) => f.fieldPath.endsWith('Column2.Line3.Amount'))
        ?.inputValue,
    ).toBe('52886');
  });
});

it('selects only one Ontario editable bracket column from reviewed taxable income', () => {
  const intake = input();
  intake.facts.find((f) => f.key === 'interest')!.value = {
    type: 'decimal',
    value: '150000.01',
  };
  const run = runCanadaOntario2025PersonalWorkflow(intake);
  const columns = audit(run).fields.filter(
    (f) =>
      f.sourceId === 'cra-5006-c-2025-fillable' &&
      /^form1\.Page1\.Chart\.Column[1-5]\.Line(2|4|6|8)\.Amount$/.test(
        f.fieldPath,
      ),
  );
  expect(columns).toHaveLength(20);
  expect(columns.filter((f) => f.decision === 'not-applicable')).toHaveLength(
    16,
  );
  expect(
    columns
      .filter((f) => f.decision !== 'not-applicable')
      .every((f) => f.fieldPath.includes('Column4.')),
  ).toBe(true);
  expect(run.fields.find((f) => f.id === 'ON428.8')?.dependencies).toEqual([
    'ONBracket.column4.8',
  ]);
});

describe('Federal Part A tax worksheet selected-column applicability', () => {
  it('maps the selected column, preserves the printed rate constant, and excludes inactive columns', () => {
    const intake = input();
    intake.facts.find((f) => f.key === 'interest')!.value = {
      type: 'decimal',
      value: '200000',
    };
    const run = runCanadaOntario2025PersonalWorkflow(intake);
    const columns = audit(run).fields.filter(
      (f) =>
        f.sourceId === 'cra-5006-r-2025-fillable' &&
        /^form1\.Page5\.PartA\.Column[1-5]\.(?:Line(?:36|37|38|40|41|42)Amount\d+|Line39Rate\d+)$/.test(
          f.fieldPath,
        ),
    );
    expect(columns).toHaveLength(35);
    expect(
      columns
        .filter((f) => f.fieldPath.includes('Column4.'))
        .filter((f) => f.decision === 'mapped-amount'),
    ).toHaveLength(6);
    expect(
      columns.find((f) => f.fieldPath.endsWith('Column4.Line39Rate4')),
    ).toMatchObject({
      decision: 'source-layout',
      reason:
        'Published federal Part A rate constant captured from the source form',
    });
    expect(
      columns
        .filter((f) => !f.fieldPath.includes('Column4.'))
        .every((f) => f.decision === 'not-applicable'),
    ).toBe(true);
    expect(run.fields.find((f) => f.id === 'T1.119')?.dependencies).toEqual([
      'FederalTax.Column4.76',
    ]);
  });
});

describe('T1 Step 6 guarded payable and refund transfers', () => {
  it('maps all reviewed no-other-refund lines with captured field proofs', () => {
    const run = runCanadaOntario2025PersonalWorkflow(input('sole-proprietor'));
    const expectedPaths = new Map([
      ['form1.Page7.Step6.Line42120.Line_42120_Amount', 'T1.42120'],
      ['form1.Page7.Step6.Line42200.Line_42200_Amount', 'T1.42200'],
      ['form1.Page8.Step6-Continued.Line44000.Line_44000_Amount', 'T1.44000'],
      ['form1.Page8.Step6-Continued.Line45350.Line_45350_Amount', 'T1.45350'],
      ['form1.Page8.Step6-Continued.Line45355.Line_45355_Amount', 'T1.45355'],
      ['form1.Page8.Step6-Continued.Line45400.Line_45400_Amount', 'T1.45400'],
      ['form1.Page8.Step6-Continued.Line45600.Line_45600_Amount', 'T1.45600'],
      ['form1.Page8.Step6-Continued.Line45700.Line_45700_Amount', 'T1.45700'],
      [
        'form1.Page8.Step6-Continued.Line46900.Line46800.Line_46800_Amount',
        'T1.46800',
      ],
      ['form1.Page8.Step6-Continued.Line46900.Line_46900_Amount', 'T1.46900'],
      ['form1.Page8.Step6-Continued.Line47555.Line_47600_Amount', 'T1.47555'],
      ['form1.Page8.Step6-Continued.Line47556.Line_47556_Amount', 'T1.47556'],
      ['form1.Page8.Step6-Continued.Line47900.Line_47900_Amount', 'T1.47900'],
    ]);
    const fields = audit(run).fields.filter((f) =>
      expectedPaths.has(f.fieldPath),
    );
    expect(fields).toHaveLength(expectedPaths.size);
    expect(fields.every((f) => f.decision === 'mapped-amount')).toBe(true);
    expect(fields.map((f) => f.fieldId).sort()).toEqual(
      [...expectedPaths.values()].sort(),
    );
    expect(run.fields.find((f) => f.id === 'T1.42120')?.dependencies).toEqual([
      'fact:scope.noEiSpecialBenefitsAgreement',
      'fact:scope.noOtherIncome',
    ]);
    expect(run.fields.find((f) => f.id === 'T1.42200')?.dependencies).toEqual([
      'fact:scope.noOtherIncome',
    ]);
    for (const line of [
      '44000',
      '45350',
      '45355',
      '45400',
      '45600',
      '45700',
      '47555',
      '47556',
      '47900',
    ]) {
      const field = run.fields.find((f) => f.id === `T1.${line}`)!;
      expect(field.reportableAmount, line).toBe('0.00');
      expect(field.dependencies, line).toEqual(['fact:scope.noOtherRefunds']);
    }
    const educatorDependencies = [
      'fact:educator.eligibleSuppliesExpenses',
      'fact:educator.eligibleEducator',
      'fact:educator.expensesPaidIn2025',
      'fact:educator.expensesUnreimbursed',
      'fact:educator.expensesNotClaimedElsewhere',
      'fact:scope.noOtherCredits',
    ];
    expect(run.fields.find((f) => f.id === 'T1.46800')?.dependencies).toEqual(
      educatorDependencies,
    );
    expect(run.fields.find((f) => f.id === 'T1.46800')?.reportableAmount).toBe(
      '0.00',
    );
    expect(run.fields.find((f) => f.id === 'T1.46900')?.exactDecimal).toBe('0');
    expect(run.fields.find((f) => f.id === 'T1.46900')?.dependencies).toEqual([
      'T1.46800',
      ...educatorDependencies,
    ]);
  });

  it('maps a supported nonzero educator claim through the captured T1 fields', () => {
    const candidate = input('individual');
    for (const key of [
      'educator.eligibleEducator',
      'educator.expensesPaidIn2025',
      'educator.expensesUnreimbursed',
      'educator.expensesNotClaimedElsewhere',
    ])
      candidate.facts.find((fact) => fact.key === key)!.value = {
        type: 'boolean',
        value: true,
      };
    candidate.facts.find(
      (fact) => fact.key === 'educator.eligibleSuppliesExpenses',
    )!.value = { type: 'decimal', value: '750' };
    const run = runCanadaOntario2025PersonalWorkflow(candidate);
    expect(run.issues).toEqual([]);
    expect(run.fields.find((f) => f.id === 'T1.46800')?.exactDecimal).toBe(
      '750',
    );
    expect(run.fields.find((f) => f.id === 'T1.46900')?.exactDecimal).toBe(
      '187.5',
    );
    expect(run.fields.find((f) => f.id === 'T1.46800')?.reportableAmount).toBe(
      '750.00',
    );
    expect(run.fields.find((f) => f.id === 'T1.46900')?.reportableAmount).toBe(
      '187.50',
    );
    expect(
      audit(run).fields.find(
        (field) =>
          field.fieldId === 'T1.46900' &&
          field.fieldPath ===
            'form1.Page8.Step6-Continued.Line46900.Line_46900_Amount',
      )?.decision,
    ).toBe('mapped-amount');
  });
});

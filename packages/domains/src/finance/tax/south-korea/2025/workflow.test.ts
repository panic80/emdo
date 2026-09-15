import { describe, expect, it } from 'vitest';
import {
  FinanceTaxEvaluationSchema,
  FinanceTaxIntakeSchema,
  type FinanceTaxIntake,
} from '@emdo/contracts';
import { SOUTH_KOREA_2025_FIXTURES } from './fixtures.js';
import { decimal, exactDecimal, q, truncateTowardZero } from './exact.js';
import {
  SOUTH_KOREA_2025_EARNED_INCOME_DEDUCTION_BANDS,
  SOUTH_KOREA_2025_INCOME_TAX_BANDS,
  southKorea2025EarnedIncomeDeduction,
  southKorea2025EarnedIncomeTaxCredit,
  southKorea2025IncomeTax,
} from './tables.js';
import {
  SOUTH_KOREA_2025_PUBLICATION_EVIDENCE,
  SOUTH_KOREA_2025_SOURCES,
  SOUTH_KOREA_2025_SOURCE_VERSION,
} from './sources.js';
import {
  assessSouthKorea2025EmploymentFacts,
  calculateSouthKorea2025Employment,
  SOUTH_KOREA_2025_CANDIDATE,
  SOUTH_KOREA_2025_FORM_VERSION,
  SOUTH_KOREA_2025_REQUIRED_FACTS,
  SOUTH_KOREA_2025_SCOPE,
  SOUTH_KOREA_2025_VERSION,
  evaluateSouthKorea2025WorkingPapers,
} from './workflow.js';

function values(result: ReturnType<typeof calculateSouthKorea2025Employment>) {
  return Object.fromEntries(
    result.lines.map((line) => [line.key, line.reportedWon]),
  );
}

function replaceFact(
  input: FinanceTaxIntake,
  key: string,
  value: FinanceTaxIntake['facts'][number]['value'],
) {
  const fact = input.facts.find((entry) => entry.key === key);
  if (!fact) throw new Error(`fixture-missing-${key}`);
  fact.value = value;
}

function genericFixture(
  overrides: Record<string, string | boolean> = {},
): FinanceTaxIntake {
  return {
    schemaVersion: 1,
    caseId: '00000000-0000-4000-8000-000000000021',
    workspaceId: '00000000-0000-4000-8000-000000000022',
    taxSubjectId: '00000000-0000-4000-8000-000000000023',
    legalEntityId: null,
    sourceBooks: [],
    revision: 1,
    scope: { ...SOUTH_KOREA_2025_SCOPE },
    domesticResident: true,
    hasCrossBorderActivity: false,
    standaloneCorporation: null,
    requestedFeatures: ['income-tax-return'],
    facts: SOUTH_KOREA_2025_REQUIRED_FACTS.map((definition) => {
      const defaultValue =
        definition.type === 'boolean'
          ? definition.key === 'case.onlyOrdinaryEmploymentIncome'
          : definition.key === 'deduction.basicDeductionCount'
            ? '1'
            : '0';
      return {
        key: definition.key,
        reviewState: 'reviewed' as const,
        value: {
          type: definition.type,
          value: overrides[definition.key] ?? defaultValue,
        } as FinanceTaxIntake['facts'][number]['value'],
        source: {
          kind: 'declaration' as const,
          reference: 'Independent South Korea 2025 fixture evidence',
          revision: 1,
          contentHash: 'a'.repeat(64),
        },
      };
    }),
  };
}

describe('South Korea 2025 NTS tables and exact arithmetic', () => {
  it('keeps the published earned-income deduction endpoints inclusive', () => {
    const expected: readonly [string, string][] = [
      ['5000000', '3500000'],
      ['5000000.01', '3500000.004'],
      ['15000000', '7500000'],
      ['15000000.01', '7500000.0015'],
      ['45000000', '12000000'],
      ['45000000.01', '12000000.0005'],
      ['100000000', '14750000'],
      ['100000000.01', '14750000.0002'],
      ['1000000000', '20000000'],
    ];
    for (const [salary, amount] of expected)
      expect(
        exactDecimal(
          southKorea2025EarnedIncomeDeduction(decimal(salary)).amount,
        ),
      ).toBe(amount);
    expect(
      southKorea2025EarnedIncomeDeduction(decimal('1000000000')).amount,
    ).toEqual(decimal('20000000'));
    expect(
      southKorea2025EarnedIncomeDeduction(decimal('1000000000')).uncapped,
    ).toEqual(decimal('32750000'));
    expect(SOUTH_KOREA_2025_EARNED_INCOME_DEDUCTION_BANDS).toHaveLength(5);
  });

  it('keeps every 2025 progressive income-tax bracket endpoint inclusive', () => {
    const expected: readonly [string, string][] = [
      ['14000000', '840000'],
      ['14000000.01', '840000.0015'],
      ['50000000', '6240000'],
      ['50000000.01', '6240000.0024'],
      ['88000000', '15360000'],
      ['88000000.01', '15360000.0035'],
      ['150000000', '37060000'],
      ['150000000.01', '37060000.0038'],
      ['300000000', '94060000'],
      ['300000000.01', '94060000.004'],
      ['500000000', '174060000'],
      ['500000000.01', '174060000.0042'],
      ['1000000000', '384060000'],
      ['1000000000.01', '384060000.0045'],
    ];
    for (const [taxBase, amount] of expected)
      expect(
        exactDecimal(southKorea2025IncomeTax(decimal(taxBase)).amount),
      ).toBe(amount);
    expect(SOUTH_KOREA_2025_INCOME_TAX_BANDS).toHaveLength(8);
  });

  it('applies the Article 59 preliminary earned-income credit and salary caps', () => {
    const atThreshold = southKorea2025EarnedIncomeTaxCredit(
      decimal('33000000'),
      decimal('1300000'),
    );
    expect(atThreshold.preliminary).toEqual(decimal('715000'));
    expect(atThreshold.cap).toEqual(decimal('740000'));
    expect(atThreshold.amount).toEqual(decimal('715000'));

    const aboveThreshold = southKorea2025EarnedIncomeTaxCredit(
      decimal('33000000'),
      decimal('1300000.01'),
    );
    expect(exactDecimal(aboveThreshold.preliminary)).toBe('715000.003');

    expect(southKorea2025EarnedIncomeTaxCredit(q(0n), q(0n)).cap).toEqual(
      q(0n),
    );
    expect(
      southKorea2025EarnedIncomeTaxCredit(decimal('33000000'), q(0n)).cap,
    ).toEqual(decimal('740000'));
    expect(
      southKorea2025EarnedIncomeTaxCredit(decimal('70000000'), q(0n)).cap,
    ).toEqual(decimal('660000'));
    expect(
      southKorea2025EarnedIncomeTaxCredit(decimal('70000000.01'), q(0n)).cap,
    ).toEqual(decimal('659999.995'));
    expect(
      southKorea2025EarnedIncomeTaxCredit(decimal('120000000'), q(0n)).cap,
    ).toEqual(decimal('500000'));
    expect(
      southKorea2025EarnedIncomeTaxCredit(decimal('120000000.01'), q(0n)).cap,
    ).toEqual(decimal('499999.995'));
    expect(
      southKorea2025EarnedIncomeTaxCredit(decimal('200000000'), q(0n)).cap,
    ).toEqual(decimal('200000'));
  });

  it('retains reduced rational values and truncates only the report boundary', () => {
    expect(exactDecimal(decimal('1.25'))).toBe('1.25');
    expect(exactDecimal(q(1n, 3n))).toBe('1/3');
    expect(truncateTowardZero(q(-1n, 2n))).toBe(0n);
    const result = calculateSouthKorea2025Employment(
      SOUTH_KOREA_2025_FIXTURES.find(
        (fixture) =>
          fixture.id === 'fractional-intermediates-truncate-at-lines',
      )!.input,
    );
    expect(result.status).toBe('calculated');
    expect(
      result.lines.find((line) => line.key === 'employment.totalSalary'),
    ).toMatchObject({
      exactNumerator: '500000001',
      exactDenominator: '100',
      exactAmount: '5000000.01',
      reportedWon: '5000000',
    });
    expect(
      result.lines.find((line) => line.key === 'tax.taxBase'),
    ).toMatchObject({
      exactNumerator: '3',
      exactDenominator: '500',
      exactAmount: '0.006',
      reportedWon: '0',
    });
  });

  it('applies the NTS non-collection rule only to a positive sub-KRW-1,000 balance', () => {
    const input = structuredClone(SOUTH_KOREA_2025_FIXTURES[0]!.input);
    input.withheldIncomeTax = '3387000';
    const result = calculateSouthKorea2025Employment(input);
    const balance = result.lines.find(
      (line) => line.key === 'settlement.balanceDueOrRefund',
    )!;
    expect(balance.exactAmount).toBe('500');
    expect(balance.reportedWon).toBe('0');

    input.withheldIncomeTax = '3386500';
    const larger = calculateSouthKorea2025Employment(input);
    expect(
      larger.lines.find((line) => line.key === 'settlement.balanceDueOrRefund')
        ?.reportedWon,
    ).toBe('1000');
  });

  it('keeps the standard credit available with only the separate public-pension deduction', () => {
    const input = structuredClone(SOUTH_KOREA_2025_FIXTURES[0]!.input);
    input.nationalPensionContribution = '1000000';
    const result = calculateSouthKorea2025Employment(input);
    expect(
      result.lines.find((line) => line.key === 'credit.standardTaxCredit')
        ?.reportedWon,
    ).toBe('130000');
  });
});

describe('South Korea 2025 national employment working papers', () => {
  it.each(SOUTH_KOREA_2025_FIXTURES.map((fixture) => fixture.id))(
    'matches the independent expected fixture for %s',
    (fixtureId) => {
      const fixture = SOUTH_KOREA_2025_FIXTURES.find(
        (entry) => entry.id === fixtureId,
      )!;
      const result = calculateSouthKorea2025Employment(fixture.input);
      expect(result.status).toBe('calculated');
      expect(result.complete).toBe(false);
      expect(result.candidate.enabled).toBe(false);
      expect(result.candidate.registryEligible).toBe(false);
      expect(values(result)).toEqual(fixture.expectedValues);
      expect(result.lines).toHaveLength(24);
      expect(result.trace).toEqual(result.lines);
    },
  );

  it('carries source facts through the complete supported dependency graph', () => {
    const result = calculateSouthKorea2025Employment(
      SOUTH_KOREA_2025_FIXTURES[0]!.input,
    );
    const settlement = result.trace.find(
      (line) => line.key === 'settlement.balanceDueOrRefund',
    )!;
    expect(settlement.sourceFactKeys).toEqual(
      expect.arrayContaining([
        'income.annualGrossEmploymentIncome',
        'income.annualNonTaxableEmploymentIncome',
        'deduction.basicDeductionCount',
        'deduction.nationalPensionContribution',
        'deduction.healthInsuranceContribution',
        'deduction.employmentInsuranceContribution',
        'deduction.longTermCareInsuranceContribution',
        'deduction.otherIncomeDeductions',
        'credit.otherTaxCredits',
        'credit.monthlyRentTaxCredit',
        'credit.incomeTaxReduction',
        'withholding.incomeTax',
      ]),
    );
    expect(settlement.referenceIds).toEqual([
      'nts-kr-2025-year-end-settlement-guide',
    ]);
    expect(SOUTH_KOREA_2025_CANDIDATE.rules.map((rule) => rule.id)).toEqual(
      expect.arrayContaining(result.lines.map((line) => line.ruleId)),
    );
  });

  it('maps a reviewed generic intake into deterministic incomplete working papers', () => {
    const input = genericFixture({
      'income.annualGrossEmploymentIncome': '50000000',
      'withholding.incomeTax': '3387500',
    });
    expect(FinanceTaxIntakeSchema.parse(input)).toEqual(input);
    const first = evaluateSouthKorea2025WorkingPapers(input);
    const second = evaluateSouthKorea2025WorkingPapers(structuredClone(input));
    expect(first.status).toBe('incomplete-working-papers');
    expect(first.complete).toBe(false);
    expect(first.evaluation.forms).toHaveLength(1);
    expect(first.evaluation.forms[0]!.fields).toHaveLength(24);
    expect(first.evaluation).toEqual(second.evaluation);
    expect(first.outputHash).toBe(second.outputHash);
    expect(FinanceTaxEvaluationSchema.parse(first.evaluation)).toEqual(
      first.evaluation,
    );
    const output = Object.fromEntries(
      first.evaluation.forms[0]!.fields.map((field) => [
        field.key,
        field.value.value,
      ]),
    );
    expect(output['tax.determinedTax']).toBe('3387500');
    expect(first.fieldCoverage.unresolved).toEqual(
      SOUTH_KOREA_2025_CANDIDATE.releaseBlockers,
    );
  });

  it('fails closed for missing, unreviewed, unknown and unsupported facts', () => {
    const missing = genericFixture();
    missing.facts.pop();
    expect(evaluateSouthKorea2025WorkingPapers(missing).status).toBe(
      'blocked-input',
    );

    const unreviewed = genericFixture();
    unreviewed.facts[0]!.reviewState = 'unreviewed';
    expect(
      assessSouthKorea2025EmploymentFacts(unreviewed).issues.some(
        (issue) => issue.code === 'unreviewed-fact',
      ),
    ).toBe(true);

    const extra = genericFixture();
    extra.facts.push({ ...extra.facts[0]!, key: 'unsupported.income' });
    expect(
      assessSouthKorea2025EmploymentFacts(extra).issues.some(
        (issue) => issue.code === 'unsupported-fact',
      ),
    ).toBe(true);

    const unsupported = genericFixture({
      'credit.otherTaxCredits': '1',
    });
    expect(evaluateSouthKorea2025WorkingPapers(unsupported).status).toBe(
      'blocked-input',
    );

    const foreign = genericFixture();
    foreign.domesticResident = false;
    expect(evaluateSouthKorea2025WorkingPapers(foreign).status).toBe(
      'blocked-input',
    );
  });

  it('blocks direct arithmetic inputs outside the bounded scope', () => {
    const unsupported = structuredClone(SOUTH_KOREA_2025_FIXTURES[0]!.input);
    unsupported.otherIncomeDeductions = '1';
    expect(calculateSouthKorea2025Employment(unsupported)).toMatchObject({
      status: 'blocked-input',
      lines: [],
    });

    const invalidIncome = structuredClone(SOUTH_KOREA_2025_FIXTURES[0]!.input);
    invalidIncome.annualNonTaxableEmploymentIncome = '50000001';
    expect(calculateSouthKorea2025Employment(invalidIncome).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'invalid-income' }),
      ]),
    );

    const invalidSchema = structuredClone(SOUTH_KOREA_2025_FIXTURES[0]!.input);
    invalidSchema.annualGrossEmploymentIncome = '-1';
    expect(calculateSouthKorea2025Employment(invalidSchema).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'invalid-input' }),
      ]),
    );
  });
});

describe('South Korea 2025 publication and version provenance', () => {
  it('pins the latest fully published NTS return year and source hashes', () => {
    expect(SOUTH_KOREA_2025_SCOPE).toMatchObject({
      country: 'KR',
      subdivision: 'KR-NATIONAL',
      year: 2025,
      formVersion: SOUTH_KOREA_2025_FORM_VERSION,
    });
    expect(SOUTH_KOREA_2025_PUBLICATION_EVIDENCE).toMatchObject({
      selectedYear: 2025,
      latestFullyPublishedReturnYear: 2025,
      publicationDate: '2026-04-30',
    });
    expect(SOUTH_KOREA_2025_SOURCE_VERSION.packageVersion).toBe(
      SOUTH_KOREA_2025_VERSION,
    );
    expect(SOUTH_KOREA_2025_SOURCES).toHaveLength(10);
    for (const source of SOUTH_KOREA_2025_SOURCES) {
      expect(source.url.startsWith('https://')).toBe(true);
      expect(source.documentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(source.retrievedAt).toMatch(
        /^2026-09-14T(?:05:16:28|15:07:12)\.000Z$/,
      );
    }
  });

  it('keeps the candidate explicitly incomplete and outside the shared registry', () => {
    expect(SOUTH_KOREA_2025_CANDIDATE).toMatchObject({
      id: 'kr-national-2025-employment-working-papers',
      version: SOUTH_KOREA_2025_VERSION,
      enabled: false,
      registryEligible: false,
      complete: false,
    });
    expect(SOUTH_KOREA_2025_CANDIDATE.releaseBlockers).toEqual(
      expect.arrayContaining([
        'complete-national-year-end-form-field-and-attachment-inventory-not-validated',
        'local-authority-subdivision-return-and-payment-proof-not-implemented',
        'combined-income-loss-and-special-schedules-not-implemented',
        'special-deductions-credits-reliefs-and-carryovers-not-implemented',
        'independent-complete-return-validation-and-filing-certification-not-complete',
      ]),
    );
  });

  it('returns a blocked result when the strict standalone input schema does not match', () => {
    const result = calculateSouthKorea2025Employment({});
    expect(result.status).toBe('blocked-input');
    expect(result.complete).toBe(false);
    expect(result.lines).toEqual([]);
    expect(result.issues[0]?.code).toBe('invalid-input');
  });
});

describe('South Korea test fixture helpers', () => {
  it('can alter a generic fixture only through explicit reviewed facts', () => {
    const input = genericFixture();
    replaceFact(input, 'income.annualGrossEmploymentIncome', {
      type: 'decimal',
      value: '50000000',
    });
    const result = evaluateSouthKorea2025WorkingPapers(input);
    expect(result.status).toBe('incomplete-working-papers');
  });
});

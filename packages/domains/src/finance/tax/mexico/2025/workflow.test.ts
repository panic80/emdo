import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type FinanceTaxIntake } from '@emdo/contracts';
import {
  evaluateMexico2025StandaloneCorporation,
  evaluateMexico2025ProfessionalSoleProprietor,
  evaluateMexico2025SalariedIndividual,
  MEXICO_2025_CORPORATE_CANDIDATE,
  MEXICO_2025_CORPORATE_REQUIRED_FACTS,
  MEXICO_2025_FORM_INVENTORY,
  MEXICO_2025_PROFESSIONAL_CANDIDATE,
  MEXICO_2025_PROFESSIONAL_REQUIRED_FACTS,
  MEXICO_2025_RULES,
  MEXICO_2025_SALARIED_CANDIDATE,
  MEXICO_2025_SALARIED_REQUIRED_FACTS,
} from './workflow.js';
import {
  mexico2025AnnualIsr,
  mexico2025EmploymentSubsidy,
  mexico2025MonthlySalaryIsr,
  MEXICO_2025_MONTHLY_EMPLOYMENT_SUBSIDY,
} from './tables.js';
import { decimal, q, roundHalfUp } from './exact.js';
import { MEXICO_2025_SOURCES } from './sources.js';
import {
  buildMexico2025Report,
  exportMexico2025Report,
  serializeMexico2025Report,
} from './reporting.js';
import { MEXICO_2025_FIELD_APPLICABILITY } from './field-catalog.js';

const uuid = (suffix: string) => `00000000-0000-4000-8000-00000000000${suffix}`;

function fixture(
  mode: 'salary' | 'professional' | 'corporation',
  overrides: Record<string, string | boolean> = {},
): FinanceTaxIntake {
  const required =
    mode === 'salary'
      ? MEXICO_2025_SALARIED_REQUIRED_FACTS
      : mode === 'professional'
        ? MEXICO_2025_PROFESSIONAL_REQUIRED_FACTS
        : MEXICO_2025_CORPORATE_REQUIRED_FACTS;
  const candidate =
    mode === 'salary'
      ? MEXICO_2025_SALARIED_CANDIDATE
      : mode === 'professional'
        ? MEXICO_2025_PROFESSIONAL_CANDIDATE
        : MEXICO_2025_CORPORATE_CANDIDATE;
  return {
    schemaVersion: 1,
    caseId: uuid('1'),
    workspaceId: uuid('2'),
    taxSubjectId: uuid('3'),
    legalEntityId: mode === 'corporation' ? uuid('4') : null,
    sourceBooks: [],
    revision: 1,
    scope: { ...candidate.scope },
    domesticResident: true,
    hasCrossBorderActivity: false,
    standaloneCorporation: mode === 'corporation' ? true : null,
    requestedFeatures: ['income-tax-return'],
    facts: required.map((fact) => ({
      key: fact.key,
      reviewState: 'reviewed',
      value: {
        type: fact.type,
        value:
          overrides[fact.key] ??
          (fact.key === 'corporation.investments.rows' ? '[]' : undefined) ??
          ('equals' in fact && fact.equals !== undefined
            ? fact.equals
            : fact.type === 'boolean'
              ? false
              : fact.type === 'text'
                ? 'fixture'
                : '0'),
      } as FinanceTaxIntake['facts'][number]['value'],
      source: {
        kind: 'declaration',
        reference: 'Independent fixture evidence',
        revision: 1,
        contentHash: 'a'.repeat(64),
      },
    })),
  };
}

function values(result: {
  evaluation: {
    forms: readonly {
      id: string;
      fields: readonly {
        key: string;
        value: { value: string | boolean };
      }[];
    }[];
  };
}) {
  return Object.fromEntries(
    result.evaluation.forms.flatMap((form) =>
      form.fields.map((field) => [
        `${form.id}.${field.key}`,
        field.value.value,
      ]),
    ),
  );
}

describe('Mexico 2025 exact tariff and subsidy tables', () => {
  it('applies the Anexo 8 annual tariff to the exact base before display rounding', () => {
    const result = mexico2025AnnualIsr(q(13200n));
    expect(result.tax).toEqual(q(11093n, 25n));
    expect(roundHalfUp(result.tax)).toBe(444n);
    expect(result.row?.ratePercent).toBe('6.40');
  });

  it('keeps published upper limits inclusive and the next cent in the next bracket', () => {
    const upper = mexico2025AnnualIsr(decimal('75984.55'));
    const next = mexico2025AnnualIsr(decimal('75984.56'));
    expect(upper.row?.lower).toBe('8952.50');
    expect(next.row?.lower).toBe('75984.56');
  });

  it('exposes the current Anexo 8 monthly employee withholding tariff', () => {
    const result = mexico2025MonthlySalaryIsr(decimal('10000'));
    expect(result.row?.[0]).toBe('6332.06');
    expect(roundHalfUp(result.tax)).toBe(771n);
  });

  it('retains the January and February-to-December employment subsidy source rates', () => {
    expect(mexico2025EmploymentSubsidy('january')).toEqual(
      MEXICO_2025_MONTHLY_EMPLOYMENT_SUBSIDY.january,
    );
    expect(mexico2025EmploymentSubsidy('february-to-december')).toEqual(
      MEXICO_2025_MONTHLY_EMPLOYMENT_SUBSIDY.februaryToDecember,
    );
    expect(roundHalfUp(MEXICO_2025_MONTHLY_EMPLOYMENT_SUBSIDY.january)).toBe(
      475n,
    );
    expect(
      roundHalfUp(
        MEXICO_2025_MONTHLY_EMPLOYMENT_SUBSIDY.annualJanuaryPlusEleven,
      ),
    ).toBe(5696n);
  });
});

describe('Mexico 2025 salaried individual working papers', () => {
  it('runs the salary income, capped personal deductions, tariff and withholding chain', () => {
    const result = evaluateMexico2025SalariedIndividual(
      fixture('salary', {
        'salary.annualIncome': '100000',
        'salary.isrWithheld': '10000',
      }),
    );
    expect(values(result)).toMatchObject({
      'SUELDOS.accumulatedIncome': '100000',
      'DECLARACION_ANUAL.taxableBase': '100000',
      'DECLARACION_ANUAL.isrAnnual': '7075',
      'DECLARACION_ANUAL.credits': '10000',
      'DECLARACION_ANUAL.taxDue': '0',
      'DECLARACION_ANUAL.balanceFavor': '2925',
      'PAGO.balanceFavor': '2925',
    });
    expect(result.status).toBe('incomplete-working-papers');
    expect(result.complete).toBe(false);
    expect(
      result.evaluation.issues.some((issue) => issue.code.includes('complete')),
    ).toBe(true);
  });

  it('uses the exact five-UMA cap before whole-peso display', () => {
    const result = evaluateMexico2025SalariedIndividual(
      fixture('salary', {
        'salary.annualIncome': '2000000',
        'personalDeductions.amount': '300000',
      }),
    );
    const cap = result.trace.find(
      (row) =>
        row.formId === 'DECLARACION_ANUAL' &&
        row.line === 'personalDeductionCap',
    );
    expect(cap).toMatchObject({
      exactNumerator: '1031838',
      exactDenominator: '5',
      reportedDollars: '206368',
    });
  });
});

describe('Mexico 2025 professional sole-proprietor working papers', () => {
  it('runs Article 103/109 utility, Article 152 tariff and Article 106 withholding credits', () => {
    const result = evaluateMexico2025ProfessionalSoleProprietor(
      fixture('professional', {
        'business.grossReceipts': '100000',
        'business.refundsDiscounts': '5000',
        'business.authorizedDeductions': '20000',
        'business.provisionalPayments': '5000',
        'business.professionalPaymentsFromLegalEntities': '50000',
        'business.legalEntityWithholding': '5000',
      }),
    );
    expect(values(result)).toMatchObject({
      'ACTIVIDAD_PROFESIONAL.netReceipts': '95000',
      'ACTIVIDAD_PROFESIONAL.fiscalUtilityBeforePtu': '75000',
      'ACTIVIDAD_PROFESIONAL.taxableUtility': '75000',
      'DECLARACION_ANUAL_PROFESIONAL.taxableBase': '75000',
      'DECLARACION_ANUAL_PROFESIONAL.isrAnnual': '4399',
      'DECLARACION_ANUAL_PROFESIONAL.professionalWithholding': '5000',
      'DECLARACION_ANUAL_PROFESIONAL.credits': '10000',
      'DECLARACION_ANUAL_PROFESIONAL.balanceFavor': '5601',
    });
    const withholding = result.trace.find(
      (row) =>
        row.formId === 'DECLARACION_ANUAL_PROFESIONAL' &&
        row.line === 'professionalWithholding',
    );
    expect(withholding?.sourceFactKeys).toContain(
      'business.legalEntityWithholding',
    );
    expect(result.complete).toBe(false);
  });
});

describe('Mexico 2025 ordinary standalone corporation working papers', () => {
  it('runs the Article 9 result, 30% ISR, provisional-credit and payment chain', () => {
    const result = evaluateMexico2025StandaloneCorporation(
      fixture('corporation', {
        'corporation.accruedIncome': '200000',
        'corporation.refundsDiscounts': '10000',
        'corporation.authorizedDeductions': '50000',
        'corporation.ptuPaid': '10000',
        'corporation.provisionalPayments': '20000',
      }),
    );
    expect(values(result)).toMatchObject({
      'INGRESOS_PERSONA_MORAL.totalAccumulatedIncome': '190000',
      'DECLARACION_ANUAL_MORAL.totalAuthorizedDeductions': '50000',
      'DECLARACION_ANUAL_MORAL.utilityBeforePtu': '140000',
      'DECLARACION_ANUAL_MORAL.fiscalUtility': '130000',
      'DECLARACION_ANUAL_MORAL.fiscalResult': '130000',
      'DECLARACION_ANUAL_MORAL.isrCaused': '39000',
      'DECLARACION_ANUAL_MORAL.isrExercise': '39000',
      'DECLARACION_ANUAL_MORAL.credits': '20000',
      'DECLARACION_ANUAL_MORAL.taxDue': '19000',
      'DECLARACION_ANUAL_MORAL.balanceFavor': '0',
      'PAGO.taxDue': '19000',
    });
    expect(result.status).toBe('incomplete-working-papers');
    expect(result.complete).toBe(false);
    expect(
      result.evaluation.issues.some((issue) =>
        issue.code.includes('corporate'),
      ),
    ).toBe(true);
  });

  it('requires a legal-entity binding and rejects the non-standalone variant', () => {
    const input = fixture('corporation');
    input.legalEntityId = null;
    const result = evaluateMexico2025StandaloneCorporation(input);
    expect(result.status).toBe('blocked-input');
    expect(result.evaluation.forms).toEqual([]);
    expect(
      result.evaluation.issues.some(
        (issue) => issue.code === 'unsupported-scope',
      ),
    ).toBe(true);
  });
});

describe('Mexico 2025 independent supported-slice fixtures', () => {
  it('replays the independent salary, professional and corporation fixtures', () => {
    const fixtures = JSON.parse(
      readFileSync(
        new URL('./independent-fixtures.json', import.meta.url),
        'utf8',
      ),
    ) as Array<{
      id: string;
      kind: string;
      inputs?: Record<string, string>;
      expected?: Record<string, string>;
      allBoundedFactsReviewed?: boolean;
      fullReturn?: boolean;
    }>;
    const supported = fixtures.filter(
      (entry) => entry.kind === 'independent-complete-supported-slice',
    );
    expect(supported.map((entry) => entry.id)).toEqual([
      'mx2025-salaried-independent-supported-slice',
      'mx2025-professional-independent-supported-slice',
      'mx2025-corporation-independent-supported-slice',
    ]);
    for (const entry of supported) {
      expect(entry.allBoundedFactsReviewed).toBe(true);
      expect(entry.fullReturn).toBe(false);
      const mode = entry.id.includes('salaried')
        ? 'salary'
        : entry.id.includes('professional')
          ? 'professional'
          : 'corporation';
      const result =
        mode === 'salary'
          ? evaluateMexico2025SalariedIndividual(
              fixture(mode, entry.inputs ?? {}),
            )
          : mode === 'professional'
            ? evaluateMexico2025ProfessionalSoleProprietor(
                fixture(mode, entry.inputs ?? {}),
              )
            : evaluateMexico2025StandaloneCorporation(
                fixture(mode, entry.inputs ?? {}),
              );
      const resultValues = values(result);
      const form =
        mode === 'salary'
          ? 'DECLARACION_ANUAL'
          : mode === 'professional'
            ? 'DECLARACION_ANUAL_PROFESIONAL'
            : 'DECLARACION_ANUAL_MORAL';
      for (const [key, expected] of Object.entries(entry.expected ?? {})) {
        const actualKey =
          mode === 'professional' && key === 'netReceipts'
            ? `ACTIVIDAD_PROFESIONAL.${key}`
            : mode === 'professional' && key === 'fiscalUtility'
              ? 'ACTIVIDAD_PROFESIONAL.fiscalUtilityBeforePtu'
              : key === 'accumulatedIncome' ||
                  key === 'personalDeductionsAllowed' ||
                  key === 'taxableBase' ||
                  key === 'isrAnnualDisplayed' ||
                  key === 'creditsDisplayed' ||
                  key === 'taxDueDisplayed' ||
                  key === 'balanceFavorDisplayed'
                ? `${form}.${
                    key === 'isrAnnualDisplayed'
                      ? 'isrAnnual'
                      : key === 'creditsDisplayed'
                        ? 'credits'
                        : key === 'taxDueDisplayed'
                          ? 'taxDue'
                          : key === 'balanceFavorDisplayed'
                            ? 'balanceFavor'
                            : key
                  }`
                : mode === 'corporation' && key === 'totalAccumulatedIncome'
                  ? `INGRESOS_PERSONA_MORAL.${key}`
                  : mode === 'corporation' && key === 'creditsDisplayed'
                    ? `${form}.credits`
                    : `${form}.${key}`;
        expect(resultValues[actualKey]).toBe(expected);
      }
    }
  });
});

describe('Mexico 2025 fail-closed boundaries', () => {
  it.each([
    'missing',
    'unreviewed',
    'extra',
    'precision',
    'scope',
    'loss',
    'withholding',
  ] as const)('blocks %s input without emitting a calculation', (problem) => {
    const input = fixture('professional', {
      'business.grossReceipts': '100000',
      'business.refundsDiscounts': '5000',
      'business.authorizedDeductions': '20000',
      'business.professionalPaymentsFromLegalEntities': '50000',
      'business.legalEntityWithholding': '5000',
    });
    if (problem === 'missing') input.facts.pop();
    if (problem === 'unreviewed') input.facts[0]!.reviewState = 'unreviewed';
    if (problem === 'extra')
      input.facts.push({ ...input.facts[0]!, key: 'unmapped-income' });
    if (problem === 'precision')
      input.facts.find((fact) => fact.key === 'business.grossReceipts')!.value =
        {
          type: 'decimal',
          value: '100000.001',
        };
    if (problem === 'scope') input.scope.subdivision = 'MX-JAL';
    if (problem === 'loss')
      input.facts.find(
        (fact) => fact.key === 'business.authorizedDeductions',
      )!.value = {
        type: 'decimal',
        value: '120000',
      };
    if (problem === 'withholding')
      input.facts.find(
        (fact) => fact.key === 'business.legalEntityWithholding',
      )!.value = { type: 'decimal', value: '4999' };
    const result = evaluateMexico2025ProfessionalSoleProprietor(input);
    expect(result.status).toBe('blocked-input');
    expect(result.evaluation.forms).toEqual([]);
    expect(result.complete).toBe(false);
  });

  it('rejects corporation scope when sent to the salary evaluator', () => {
    const input = fixture('salary');
    input.scope.taxpayerType = 'corporation';
    const result = evaluateMexico2025SalariedIndividual(input);
    expect(result.status).toBe('blocked-input');
    expect(result.evaluation.forms).toEqual([]);
    expect(
      result.evaluation.issues.some(
        (issue) => issue.code === 'unsupported-scope',
      ),
    ).toBe(true);
  });

  it('binds checked-in primary sources and freezes candidate metadata', () => {
    expect(MEXICO_2025_SOURCES.length).toBeGreaterThan(10);
    expect(
      MEXICO_2025_SOURCES.every((source) => source.url.startsWith('https://')),
    ).toBe(true);
    expect(MEXICO_2025_SALARIED_CANDIDATE.enabled).toBe(false);
    expect(MEXICO_2025_PROFESSIONAL_CANDIDATE.registryEligible).toBe(false);
    const result = evaluateMexico2025SalariedIndividual(fixture('salary'));
    expect(() => (result.trace as unknown as unknown[]).pop()).toThrow();
    expect(
      evaluateMexico2025SalariedIndividual(fixture('salary')).outputHash,
    ).toBe(result.outputHash);
  });

  it('keeps every emitted field rule-bound and fact-traceable', () => {
    const result = evaluateMexico2025ProfessionalSoleProprietor(
      fixture('professional', {
        'business.grossReceipts': '100000',
        'business.refundsDiscounts': '5000',
        'business.authorizedDeductions': '20000',
        'business.professionalPaymentsFromLegalEntities': '50000',
        'business.legalEntityWithholding': '5000',
      }),
    );
    const rules = new Set(
      MEXICO_2025_PROFESSIONAL_CANDIDATE.rules.map((rule) => rule.id),
    );
    for (const form of result.evaluation.forms)
      for (const field of form.fields) {
        expect(field.ruleIds.every((ruleId) => rules.has(ruleId))).toBe(true);
        expect(field.sourceFactKeys.length).toBeGreaterThan(0);
      }
  });

  it('matches every source-capture manifest hash and byte count', () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL('./sources/capture-manifest.json', import.meta.url),
        'utf8',
      ),
    ) as Array<{
      id: string;
      localFile: string;
      bytes: number;
      documentHash: string;
    }>;
    expect(manifest.length).toBe(MEXICO_2025_SOURCES.length);
    for (const capture of manifest) {
      const bytes = readFileSync(
        new URL(`./sources/${capture.localFile}`, import.meta.url),
      );
      expect(bytes.byteLength).toBe(capture.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(
        capture.documentHash,
      );
      expect(
        MEXICO_2025_SOURCES.find((source) => source.id === capture.id)
          ?.documentHash,
      ).toBe(capture.documentHash);
    }
  });

  it('exports deterministic source-bound applicability with unresolved fields visible', () => {
    const result = evaluateMexico2025SalariedIndividual(
      fixture('salary', {
        'salary.annualIncome': '100000',
        'salary.isrWithheld': '10000',
      }),
    );
    const report = buildMexico2025Report(result);
    expect(report.complete).toBe(false);
    expect(report.fieldApplicability.length).toBeGreaterThan(0);
    expect(
      report.fieldApplicability.some(
        (entry) => entry.resolution === 'unresolved',
      ),
    ).toBe(true);
    expect(
      report.fieldApplicability.some((entry) => entry.status === 'unsupported'),
    ).toBe(true);
    expect(
      report.sourceReferences.some(
        (source) => source.id === 'sat-mx-2025-guia-sueldos-salarios',
      ),
    ).toBe(true);
    expect(report.coverage.catalogFields).toBe(
      MEXICO_2025_FIELD_APPLICABILITY.filter(
        (entry) => entry.taxpayerType === 'individual',
      ).length,
    );
    const exported = exportMexico2025Report(result);
    expect(exported.json).toBe(serializeMexico2025Report(report));
    expect(exported.reportHash).toBe(report.reportHash);
    expect(exported.json).toBe(
      exportMexico2025Report(
        evaluateMexico2025SalariedIndividual(
          fixture('salary', {
            'salary.annualIncome': '100000',
            'salary.isrWithheld': '10000',
          }),
        ),
      ).json,
    );
  });

  it('keeps every emitted or inventoried field source-bound to a known rule or explicit unresolved status', () => {
    const sources = new Set(MEXICO_2025_SOURCES.map((source) => source.id));
    const rules = new Set(MEXICO_2025_RULES.map((entry) => entry.id));
    const taxpayerTypeForForm = (formId: string) =>
      formId === 'SUELDOS' || formId === 'DECLARACION_ANUAL'
        ? 'individual'
        : formId === 'ACTIVIDAD_PROFESIONAL' ||
            formId === 'DECLARACION_ANUAL_PROFESIONAL'
          ? 'sole-proprietor'
          : 'corporation';
    for (const entry of MEXICO_2025_FIELD_APPLICABILITY) {
      expect(
        entry.sourceReferenceIds.every((referenceId) =>
          sources.has(referenceId),
        ),
      ).toBe(true);
      if (entry.ruleId) expect(rules.has(entry.ruleId)).toBe(true);
      if (entry.status === 'unsupported' || entry.status === 'review-required')
        expect(entry.ruleId).toBeNull();
    }
    for (const form of MEXICO_2025_FORM_INVENTORY)
      for (const field of form.fields) {
        expect(
          MEXICO_2025_FIELD_APPLICABILITY.some(
            (entry) =>
              entry.formId === form.id &&
              entry.fieldKey === field &&
              entry.taxpayerType === taxpayerTypeForForm(form.id),
          ),
        ).toBe(true);
      }
  });

  it('exports the corporate annual determination with unresolved additional-data fields visible', () => {
    const result = evaluateMexico2025StandaloneCorporation(
      fixture('corporation', {
        'corporation.accruedIncome': '200000',
        'corporation.refundsDiscounts': '10000',
        'corporation.authorizedDeductions': '50000',
        'corporation.ptuPaid': '10000',
        'corporation.provisionalPayments': '20000',
      }),
    );
    const report = buildMexico2025Report(result);
    expect(report.scope.taxpayerType).toBe('corporation');
    expect(
      report.fieldApplicability.some(
        (entry) =>
          entry.formId === 'DATOS_ADICIONALES_MORAL' &&
          entry.fieldKey === 'cufin' &&
          entry.resolution === 'unsupported',
      ),
    ).toBe(true);
    expect(
      report.sourceReferences.some(
        (source) =>
          source.id === 'sat-mx-2025-guia-personas-morales-regimen-general',
      ),
    ).toBe(true);
    expect(report.coverage.unsupportedFields).toBeGreaterThan(0);
    expect(report.reportHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('Mexico Article 44 corporate inflation return graph', () => {
  const balances = (credits: string, debts: string) =>
    Object.fromEntries(
      Array.from({ length: 12 }, (_, i) =>
        String(i + 1).padStart(2, '0'),
      ).flatMap((month) => [
        [`corporation.inflation.${month}.credits`, credits],
        [`corporation.inflation.${month}.debts`, debts],
      ]),
    );
  it('adds debt-excess inflation to annual income and tax due', () => {
    // Independent: (300000 - 100000) * .0369 = 7380;
    // (1000000 + 7380 - 400000) * .30 - 100000 = 82214.
    const result = evaluateMexico2025StandaloneCorporation(
      fixture('corporation', {
        ...balances('100000', '300000'),
        'corporation.accruedIncome': '1000000',
        'corporation.authorizedDeductions': '400000',
        'corporation.provisionalPayments': '100000',
      }),
    );
    expect(
      values(result)['INGRESOS_PERSONA_MORAL.annualInflationAdjustmentIncome'],
    ).toBe('7380');
    expect(
      values(result)[
        'DEDUCCIONES_PERSONA_MORAL.annualInflationAdjustmentDeductible'
      ],
    ).toBe('0');
    expect(values(result)['PAGO.taxDue']).toBe('82214');
    const payment = result.trace.find(
      (row) => row.formId === 'PAGO' && row.line === 'taxDue',
    );
    expect(payment?.sourceFactKeys).toEqual(
      expect.arrayContaining(Object.keys(balances('0', '0'))),
    );
    expect(payment?.referenceIds).toContain('inegi-mx-inpc-december-2025');
    expect(result.complete).toBe(false);
  });
  it('deducts credit-excess inflation and produces a nonzero balance in favor', () => {
    // (1000000 - 400000 - 7380) * .30 = 177786; 180000 - 177786 = 2214.
    const result = evaluateMexico2025StandaloneCorporation(
      fixture('corporation', {
        ...balances('300000', '100000'),
        'corporation.accruedIncome': '1000000',
        'corporation.authorizedDeductions': '400000',
        'corporation.provisionalPayments': '180000',
      }),
    );
    expect(
      values(result)[
        'DEDUCCIONES_PERSONA_MORAL.annualInflationAdjustmentDeductible'
      ],
    ).toBe('7380');
    expect(
      values(result)['DECLARACION_ANUAL_MORAL.totalAuthorizedDeductions'],
    ).toBe('407380');
    expect(values(result)['PAGO.balanceFavor']).toBe('2214');
  });
  it('averages twelve month ends rather than using the final balance', () => {
    const result = evaluateMexico2025StandaloneCorporation(
      fixture('corporation', {
        ...balances('0', '0'),
        'corporation.inflation.12.debts': '120000.12',
      }),
    );
    const average = result.trace.find(
      (row) => row.line === 'averageAnnualDebts',
    );
    expect(average?.exactNumerator).toBe('1000001');
    expect(average?.exactDenominator).toBe('100');
    const adjustment = result.trace.find(
      (row) => row.line === 'annualInflationAdjustmentIncome',
    );
    expect(adjustment?.exactNumerator).toBe('369000369');
    expect(adjustment?.exactDenominator).toBe('1000000');
  });
  it('blocks missing months and unreviewed classification without emitting partial calculations', () => {
    const intake = fixture('corporation', balances('100000', '300000'));
    intake.facts = intake.facts.filter(
      (fact) => fact.key !== 'corporation.inflation.06.debts',
    );
    expect(
      evaluateMexico2025StandaloneCorporation(intake).evaluation.forms,
    ).toEqual([]);
    const unreviewed = fixture('corporation', balances('100000', '300000'));
    unreviewed.facts.find(
      (fact) =>
        fact.key ===
        'corporation.inflation.article45And46ClassificationReviewed',
    )!.reviewState = 'unreviewed';
    expect(
      evaluateMexico2025StandaloneCorporation(unreviewed).evaluation.forms,
    ).toEqual([]);
  });
});

describe('Mexico private shared-intake adapter', () => {
  it('exposes the exact reviewed scalar catalogs including every inflation month', async () => {
    const { MEXICO_2025_PRIVATE_QUESTIONS_BY_TAXPAYER_TYPE: catalogs } =
      await import('./private-intake-adapter.js');
    for (const [type, facts] of [
      ['individual', MEXICO_2025_SALARIED_REQUIRED_FACTS],
      ['sole-proprietor', MEXICO_2025_PROFESSIONAL_REQUIRED_FACTS],
      ['corporation', MEXICO_2025_CORPORATE_REQUIRED_FACTS],
    ] as const) {
      expect(catalogs[type].map((question) => question.key)).toEqual(
        facts.map((fact) => fact.key),
      );
      expect(
        catalogs[type].every(
          (question) => question.required && question.reviewRequired,
        ),
      ).toBe(true);
    }
    expect(
      catalogs.corporation.filter((question) =>
        /^corporation\.inflation\.\d{2}\./.test(question.key),
      ),
    ).toHaveLength(24);
  });
  it('preserves exact scalar values and source/case revisions with deterministic immutable binding', async () => {
    const { adaptPrivateMexico2025 } =
      await import('./private-intake-adapter.js');
    const input = fixture('corporation', {
      'corporation.accruedIncome': '1000000.01',
      'corporation.inflation.12.debts': '120000.12',
    });
    input.revision = 7;
    input.facts.find(
      (fact) => fact.key === 'corporation.inflation.12.debts',
    )!.source.revision = 9;
    const before = structuredClone(input);
    const adapted = adaptPrivateMexico2025(input, 'b'.repeat(64));
    expect(adapted).toEqual(adaptPrivateMexico2025(input, 'b'.repeat(64)));
    expect(input).toEqual(before);
    expect(adapted.binding?.snapshotRevision).toBe(7);
    expect(adapted.binding?.snapshotHash).toBe('b'.repeat(64));
    expect(adapted.binding?.inputHash).toBe(adapted.result?.binding?.inputHash);
    expect(
      adapted.binding?.sourceFacts.find(
        (fact) => fact.key === 'corporation.inflation.12.debts',
      ),
    ).toMatchObject({
      value: { type: 'decimal', value: '120000.12' },
      source: { revision: 9, contentHash: 'a'.repeat(64) },
    });
    expect(adapted.result).toEqual(
      evaluateMexico2025StandaloneCorporation(input),
    );
    expect(adapted.status).toBe('incomplete-working-papers');
    expect(adapted.complete).toBe(false);
    expect(adapted.fileable).toBe(false);
    expect(adapted.registryEligible).toBe(false);
    expect(adapted.report?.complete).toBe(false);
    expect(Object.isFrozen(adapted.binding?.sourceFacts)).toBe(true);
    input.facts[0]!.source.revision += 1;
    const revised = adaptPrivateMexico2025(input, 'c'.repeat(64));
    expect(revised.adapterHash).not.toBe(adapted.adapterHash);
    expect(revised.binding?.inputHash).not.toBe(adapted.binding?.inputHash);
  });
  it('provides actionable missing fact paths and no partial forms', async () => {
    const { adaptPrivateMexico2025 } =
      await import('./private-intake-adapter.js');
    const input = fixture('corporation');
    input.facts = input.facts.filter(
      (fact) => fact.key !== 'corporation.inflation.06.credits',
    );
    const result = adaptPrivateMexico2025(input, 'b'.repeat(64));
    expect(result.status).toBe('blocked-input');
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'missing-or-unreviewed-fact',
        path: 'corporation.inflation.06.credits',
      }),
    );
    expect(result.result?.evaluation.forms).toEqual([]);
  });
  it('rejects malformed snapshot identity, duplicate facts and unsupported scope', async () => {
    const { adaptPrivateMexico2025 } =
      await import('./private-intake-adapter.js');
    expect(
      adaptPrivateMexico2025(fixture('salary'), 'invalid').result,
    ).toBeNull();
    const duplicate = fixture('salary');
    duplicate.facts.push(structuredClone(duplicate.facts[0]!));
    expect(adaptPrivateMexico2025(duplicate, 'b'.repeat(64)).result).toBeNull();
    const wrong = fixture('corporation');
    wrong.scope.country = 'US';
    expect(adaptPrivateMexico2025(wrong, 'b'.repeat(64)).result).toBeNull();
  });
  it('routes salary and professional scopes without renaming or dropping facts', async () => {
    const { adaptPrivateMexico2025 } =
      await import('./private-intake-adapter.js');
    const salary = fixture('salary', { 'salary.annualIncome': '100000' });
    const professional = fixture('professional', {
      'business.grossReceipts': '100000',
    });
    expect(adaptPrivateMexico2025(salary, 'b'.repeat(64)).result).toEqual(
      evaluateMexico2025SalariedIndividual(salary),
    );
    expect(adaptPrivateMexico2025(professional, 'b'.repeat(64)).result).toEqual(
      evaluateMexico2025ProfessionalSoleProprietor(professional),
    );
  });
});

describe('Mexico corporate investment deduction return integration', () => {
  const rows = JSON.stringify([
    {
      assetId: 'computer1',
      assetClass: 'computer-equipment',
      acquisitionDate: '2025-01-01',
      firstUseDate: '2025-01-01',
      originalInvestment: '100000',
    },
    {
      assetId: 'office1',
      assetClass: 'office-furniture-equipment',
      acquisitionDate: '2025-06-15',
      firstUseDate: '2025-07-01',
      originalInvestment: '120000',
    },
  ]);
  it('carries a nonzero two-asset deduction into exact annual ISR, payment and report', () => {
    // Total deduction36480.60; (1000000-400000-36480.60)*30%-100000=69055.82.
    const result = evaluateMexico2025StandaloneCorporation(
      fixture('corporation', {
        'corporation.investments.rows': rows,
        'corporation.accruedIncome': '1000000',
        'corporation.authorizedDeductions': '400000',
        'corporation.provisionalPayments': '100000',
      }),
    );
    expect(
      values(result)['DEDUCCIONES_PERSONA_MORAL.investmentDeductions'],
    ).toBe('36481');
    const payment = result.trace.find(
      (row) => row.formId === 'PAGO' && row.line === 'taxDue',
    );
    expect(payment).toMatchObject({
      exactNumerator: '3452791',
      exactDenominator: '50',
      reportedDollars: '69056',
    });
    expect(payment?.sourceFactKeys).toContain('corporation.investments.rows');
    expect(payment?.referenceIds).toContain('sat-mx-lisr-articulo-31');
    expect(payment?.referenceIds).toContain('inegi-mx-inpc-2025-06');
    expect(result.investmentSchedule).toHaveLength(2);
    expect(buildMexico2025Report(result).investmentSchedule).toEqual(
      result.investmentSchedule,
    );
    expect(result.complete).toBe(false);
  });
  it('blocks the entire calculation for missing assets or incomplete investment review', () => {
    const cases: Record<string, string | boolean>[] = [
      { 'corporation.investments.rows': '0' },
      {
        'corporation.investments.rows': rows,
        'corporation.investments.whollyBusinessUseAndRetainedThroughYearEnd': false,
      },
      {
        'corporation.investments.rows': rows,
        'corporation.investments.excludedFromOtherDeductions': false,
      },
    ];
    for (const overrides of cases) {
      const result = evaluateMexico2025StandaloneCorporation(
        fixture('corporation', overrides),
      );
      expect(result.status).toBe('blocked-input');
      expect(result.evaluation.forms).toEqual([]);
      expect(result.investmentSchedule).toEqual([]);
    }
  });
});

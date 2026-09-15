import { describe, expect, it } from 'vitest';
import {
  FinanceTaxIntakeSchema,
  FinanceTaxRunFieldSchema,
} from '@emdo/contracts';
import { MEXICO_2025_PRIVATE_QUESTIONNAIRES } from '@emdo/domains/finance';
import {
  runPrivateMexicoWorkingPapers,
  exportPrivateMexicoWorkingPapers,
} from './finance-tax-mexico-adapter.js';

function intake(credit = '100000', debt = '300000') {
  const questionnaire = MEXICO_2025_PRIVATE_QUESTIONNAIRES.find(
    (row) => row.scope.taxpayerType === 'corporation',
  )!;
  return FinanceTaxIntakeSchema.parse({
    schemaVersion: 1,
    caseId: '00000000-0000-4000-8000-000000000001',
    workspaceId: '00000000-0000-4000-8000-000000000002',
    taxSubjectId: '00000000-0000-4000-8000-000000000003',
    legalEntityId: '00000000-0000-4000-8000-000000000004',
    sourceBooks: [],
    revision: 7,
    scope: questionnaire.scope,
    domesticResident: true,
    hasCrossBorderActivity: false,
    standaloneCorporation: true,
    requestedFeatures: ['income-tax-return'],
    facts: questionnaire.questions.map((question) => ({
      key: question.key,
      reviewState: 'reviewed',
      value: {
        type: question.type,
        value:
          question.key === 'corporation.investments.rows'
            ? '[]'
            : question.key === 'corporation.accruedIncome'
              ? '1000000'
              : question.key === 'corporation.authorizedDeductions'
                ? '400000'
                : question.key === 'corporation.provisionalPayments'
                  ? '100000'
                  : /^corporation\.inflation\.\d{2}\.credits$/.test(
                        question.key,
                      )
                    ? credit
                    : /^corporation\.inflation\.\d{2}\.debts$/.test(
                          question.key,
                        )
                      ? debt
                      : (question.requiredValue ??
                        (question.type === 'boolean' ? false : '0')),
      },
      source: {
        kind: 'declaration',
        reference: `declaration:${question.key}`,
        revision: 9,
        contentHash: 'a'.repeat(64),
      },
    })),
  });
}

describe('Mexico saved private working-paper adapter', () => {
  it('preserves exact investment deductions and the per-asset report through export', () => {
    const input = intake('0', '0');
    const assets = [
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
    ];
    input.facts.find(
      (fact) => fact.key === 'corporation.investments.rows',
    )!.value = { type: 'text', value: JSON.stringify(assets) };
    const run = runPrivateMexicoWorkingPapers(input, 'b'.repeat(64));
    expect(
      run.fields.find((field) => field.id === 'PAGO.taxDue'),
    ).toMatchObject({
      exactDecimal: '69055.82',
      exactRational: { numerator: '3452791', denominator: '50' },
      reportableAmount: null,
    });
    expect(
      run.fields.find(
        (field) =>
          field.id === 'DEDUCCIONES_PERSONA_MORAL.investmentDeductions',
      ),
    ).toMatchObject({ exactDecimal: '36480.6', reportableAmount: null });
    const exported = exportPrivateMexicoWorkingPapers(run);
    expect(exported.content).toContain('computer1');
    expect(exported.content).toContain('office1');
    expect(exported.content).toContain('inegi-mx-inpc-2025-06');
    expect(exported.content).toContain('corporation.investments.rows');
  });
  it('maps every emitted field losslessly and retains the full report and input provenance', () => {
    const input = intake();
    const run = runPrivateMexicoWorkingPapers(input, 'b'.repeat(64));
    expect(run.status).toBe('review-calculation-produced');
    expect(run.fields).toHaveLength(run.mexicoResult.result!.trace.length);
    expect(
      run.fields.find((field) => field.id === 'PAGO.taxDue'),
    ).toMatchObject({
      exactDecimal: '82214',
      exactRational: { numerator: '82214', denominator: '1' },
      reportableAmount: null,
    });
    expect(
      run.fields.every(
        (field) => FinanceTaxRunFieldSchema.safeParse(field).success,
      ),
    ).toBe(true);
    expect(
      run.fields.every(
        (field) => field.reporting.target === 'sat-2025-working-paper-field',
      ),
    ).toBe(true);
    expect(run.mexicoResult.binding).toMatchObject({
      snapshotRevision: 7,
      snapshotHash: 'b'.repeat(64),
    });
    expect(run.mexicoResult.binding!.sourceFacts).toHaveLength(
      input.facts.length,
    );
    expect(run.mexicoResult.binding!.sourceFacts[0]!.source).toEqual(
      input.facts[0]!.source,
    );
    expect(run.inputSnapshot).toEqual(input);
    expect(
      run.sources.some((source) => source.id === 'inegi-mx-inpc-december-2025'),
    ).toBe(true);
    expect(run.complete).toBe(false);
    expect(run.fileable).toBe(false);
    expect(run.enabled).toBe(false);
    expect(run.finalAmounts).toEqual({ refund: null, balanceOwing: null });
    expect(run).toEqual(runPrivateMexicoWorkingPapers(input, 'b'.repeat(64)));
    expect(Object.isFrozen(run.mexicoResult.report)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
  });
  it('keeps fractional decimals exact and repeating averages rational', () => {
    const input = intake('0', '0');
    input.facts.find(
      (fact) => fact.key === 'corporation.inflation.12.debts',
    )!.value = { type: 'decimal', value: '0.01' };
    const run = runPrivateMexicoWorkingPapers(input, 'b'.repeat(64));
    expect(
      run.fields.find(
        (field) => field.id === 'INGRESOS_PERSONA_MORAL.averageAnnualDebts',
      ),
    ).toMatchObject({
      exactRational: { numerator: '1', denominator: '1200' },
      exactDecimal: null,
    });
    expect(
      run.fields.find(
        (field) =>
          field.id === 'INGRESOS_PERSONA_MORAL.annualInflationAdjustmentIncome',
      ),
    ).toMatchObject({
      exactRational: { numerator: '123', denominator: '4000000' },
      exactDecimal: '0.00003075',
      reportableAmount: null,
    });
  });
  it('exports unresolved catalog fields and source facts without claiming filing readiness', () => {
    const run = runPrivateMexicoWorkingPapers(intake(), 'b'.repeat(64));
    const exported = exportPrivateMexicoWorkingPapers(run);
    expect(exported.content).toContain('incomplete and not fileable');
    expect(exported.content).toContain('corporation.inflation.12.debts');
    expect(exported.content).toContain('sourceFacts');
    expect(exported.content).toContain('fieldApplicability');
    expect(exported.content).toContain('unsupported');
    expect(exported.content).toContain(run.mexicoResult.report!.reportHash);
    const tampered = structuredClone(run);
    Object.assign(tampered.mexicoResult.binding!.sourceFacts[0]!.source, {
      revision: 10,
    });
    expect(() => exportPrivateMexicoWorkingPapers(tampered)).toThrow(
      'mexico-export-integrity-or-inputs',
    );
  });
  it('blocks missing/unreviewed inputs and malformed snapshot hashes without partial fields', () => {
    for (const mutate of [
      (input: ReturnType<typeof intake>) => {
        input.facts.pop();
      },
      (input: ReturnType<typeof intake>) => {
        input.facts[0]!.reviewState = 'unreviewed';
      },
      (input: ReturnType<typeof intake>) => {
        input.scope.year = 2024;
      },
    ]) {
      const input = intake();
      mutate(input);
      const run = runPrivateMexicoWorkingPapers(input, 'b'.repeat(64));
      expect(run.status).toBe('blocked');
      expect(run.fields).toEqual([]);
      expect(run.issues.length).toBeGreaterThan(0);
      expect(() => exportPrivateMexicoWorkingPapers(run)).toThrow();
    }
    expect(runPrivateMexicoWorkingPapers(intake(), 'invalid').fields).toEqual(
      [],
    );
  });
});

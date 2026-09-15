import { describe, expect, it } from 'vitest';
import {
  FinanceTaxEvaluationSchema,
  type FinanceTaxIntake,
} from '@emdo/contracts';
import {
  FRANCE_2025_CANDIDATE,
  FRANCE_2025_FIELD_DEFINITIONS,
  FRANCE_2025_REQUIRED_FACTS,
  FRANCE_2025_VERSION,
  assessFrance2025Facts,
  runFrance2025PersonalWorkflow,
} from './workflow.js';
import {
  FRANCE_2025_FIXTURES,
  FRANCE_2025_IMPLEMENTATION_HASH,
  FRANCE_2025_PACKAGE,
} from './package.js';
import {
  france2025DecoteSingle,
  france2025ProgressiveTax,
  france2025StandardSalaryDeduction,
  FRANCE_2025_LIMITS,
} from './tables.js';
import { decimal, q, report } from './exact.js';
import { FRANCE_2025_SOURCES } from './sources.js';

function replaceFact(
  input: FinanceTaxIntake,
  key: string,
  value: FinanceTaxIntake['facts'][number]['value'],
) {
  const fact = input.facts.find((entry) => entry.key === key);
  if (!fact) throw new Error(`fixture-missing-${key}`);
  fact.value = value;
}

function mutableIntake(intake: FinanceTaxIntake): FinanceTaxIntake {
  return structuredClone(intake) as FinanceTaxIntake;
}

describe('France 2025-income / 2026-return bounded working papers', () => {
  it('keeps the official income-year and filing-year distinction in the candidate', () => {
    expect(FRANCE_2025_CANDIDATE.scope.year).toBe(2025);
    expect(FRANCE_2025_CANDIDATE.scope.formVersion).toBe('2042-2026');
    expect(
      FRANCE_2025_REQUIRED_FACTS.find(
        (fact) => fact.key === 'filing.incomeYear',
      )?.expected,
    ).toBe('2025');
    expect(
      FRANCE_2025_REQUIRED_FACTS.find(
        (fact) => fact.key === 'filing.declarationYear',
      )?.expected,
    ).toBe('2026');
  });

  it.each(FRANCE_2025_FIXTURES.map((fixture) => fixture.id))(
    'matches the independently authored expected output for %s',
    (fixtureId) => {
      const fixture = FRANCE_2025_FIXTURES.find(
        (entry) => entry.id === fixtureId,
      )!;
      const result = runFrance2025PersonalWorkflow(fixture.intake);
      expect(result.status).toBe('review-calculation-produced');
      expect(result.complete).toBe(false);
      expect(result.enabled).toBe(false);
      expect(result.reportable).toBe(false);
      expect(result.evaluation).toEqual(fixture.expected);
      expect(FinanceTaxEvaluationSchema.parse(result.evaluation)).toEqual(
        fixture.expected,
      );
    },
  );

  it('applies the 10% salary deduction minimum and maximum without floating point', () => {
    expect(report(france2025StandardSalaryDeduction(decimal('508')))).toBe(
      '508',
    );
    expect(report(france2025StandardSalaryDeduction(decimal('509')))).toBe(
      '509',
    );
    expect(report(france2025StandardSalaryDeduction(decimal('510')))).toBe(
      '509',
    );
    expect(report(france2025StandardSalaryDeduction(decimal('220000')))).toBe(
      '14555',
    );
    expect(FRANCE_2025_LIMITS.salaryDeductionMinimum.n).toBe(509n);
    expect(FRANCE_2025_LIMITS.salaryDeductionMaximum.n).toBe(14555n);
  });

  it('uses inclusive published scale endpoints and exact quotient division', () => {
    expect(report(france2025ProgressiveTax(decimal('11600'), q(1n)))).toBe('0');
    expect(report(france2025ProgressiveTax(decimal('29579'), q(1n)))).toBe(
      '1978',
    );
    expect(report(france2025ProgressiveTax(decimal('84577'), q(1n)))).toBe(
      '18477',
    );
    expect(report(france2025ProgressiveTax(decimal('181917'), q(1n)))).toBe(
      '58386',
    );
    expect(report(france2025ProgressiveTax(decimal('108000'), q(2n)))).toBe(
      '18608',
    );
  });

  it('applies the single-filer decote only below the €1,982 gross-tax threshold', () => {
    expect(france2025DecoteSingle(1981n)).toBe(1n);
    expect(france2025DecoteSingle(1982n)).toBe(0n);
    expect(france2025DecoteSingle(1694n)).toBe(130n);
  });

  it('fails closed for missing, unreviewed, unsupported and high-precision inputs', () => {
    const fixture = FRANCE_2025_FIXTURES[1]!;
    const missing = mutableIntake(fixture.intake as FinanceTaxIntake);
    missing.facts = missing.facts.slice(1);
    expect(runFrance2025PersonalWorkflow(missing).status).toBe('blocked-input');
    expect(runFrance2025PersonalWorkflow(missing).evaluation.forms).toEqual([]);

    const unreviewed = mutableIntake(fixture.intake as FinanceTaxIntake);
    unreviewed.facts[0]!.reviewState = 'unreviewed';
    expect(
      assessFrance2025Facts(unreviewed).issues.some(
        (entry) => entry.code === 'unreviewed-fact',
      ),
    ).toBe(true);

    const unsupported = mutableIntake(fixture.intake as FinanceTaxIntake);
    replaceFact(unsupported, 'income.otherTaxableIncome', {
      type: 'decimal',
      value: '1',
    });
    expect(runFrance2025PersonalWorkflow(unsupported).status).toBe(
      'blocked-input',
    );

    const precise = mutableIntake(fixture.intake as FinanceTaxIntake);
    replaceFact(precise, 'employment.grossSalary', {
      type: 'decimal',
      value: '30000.001',
    });
    expect(
      assessFrance2025Facts(precise).issues.some(
        (entry) => entry.code === 'invalid-money',
      ),
    ).toBe(true);
  });

  it('blocks married, cross-border, DOM and multi-child cases with precise issue codes', () => {
    const fixture = FRANCE_2025_FIXTURES[0]!;
    const married = mutableIntake(fixture.intake as FinanceTaxIntake);
    replaceFact(married, 'family.status', { type: 'text', value: 'married' });
    expect(
      assessFrance2025Facts(married).issues.some(
        (entry) => entry.path === 'facts.family.status',
      ),
    ).toBe(true);

    const crossBorder = mutableIntake(fixture.intake as FinanceTaxIntake);
    crossBorder.hasCrossBorderActivity = true;
    expect(
      assessFrance2025Facts(crossBorder).issues.some(
        (entry) => entry.code === 'unsupported-scope',
      ),
    ).toBe(true);

    const dom = mutableIntake(fixture.intake as FinanceTaxIntake);
    replaceFact(dom, 'residency.region', {
      type: 'text',
      value: 'guadeloupe',
    });
    expect(runFrance2025PersonalWorkflow(dom).status).toBe('blocked-input');

    const children = mutableIntake(fixture.intake as FinanceTaxIntake);
    replaceFact(children, 'family.dependentChildren', {
      type: 'decimal',
      value: '2',
    });
    expect(
      assessFrance2025Facts(children).issues.some(
        (entry) => entry.code === 'unsupported-family-size',
      ),
    ).toBe(true);
  });

  it('is deterministic and carries source facts through the dependency trace', () => {
    const fixture = FRANCE_2025_FIXTURES[2]!;
    const first = runFrance2025PersonalWorkflow(fixture.intake);
    const second = runFrance2025PersonalWorkflow(
      mutableIntake(fixture.intake as FinanceTaxIntake),
    );
    expect(first.runHash).toBe(second.runHash);
    const balance = first.trace.find(
      (trace) => trace.fieldId === '2042.calc.balanceAfterWithholding',
    )!;
    expect(balance.sourceFactKeys).toEqual(
      expect.arrayContaining([
        'employment.grossSalary',
        'deduction.method',
        'family.dependentChildren',
        'pas.withheld',
      ]),
    );
    expect(first.sources.map((source) => source.documentHash)).toHaveLength(
      FRANCE_2025_SOURCES.length,
    );
  });

  it('exposes bounded development metadata without a full-return registry claim', () => {
    expect(FRANCE_2025_PACKAGE.scope).toMatchObject({
      country: 'FR',
      subdivision: 'FR-METRO',
      year: 2025,
      formVersion: '2042-2026',
    });
    expect(FRANCE_2025_PACKAGE.fieldIds).toHaveLength(
      FRANCE_2025_FIELD_DEFINITIONS.length,
    );
    expect(FRANCE_2025_PACKAGE.requiredFactKeys).toHaveLength(
      FRANCE_2025_REQUIRED_FACTS.length,
    );
    expect(FRANCE_2025_IMPLEMENTATION_HASH).toMatch(/^[a-f0-9]{64}$/);
    expect(FRANCE_2025_VERSION).toContain('2025');
  });
});

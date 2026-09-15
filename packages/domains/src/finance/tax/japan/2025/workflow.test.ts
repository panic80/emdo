import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type FinanceTaxIntake } from '@emdo/contracts';
import {
  assessJapan2025Facts,
  evaluateJapan2025WorkingPapers,
  JAPAN_2025_CANDIDATE,
  JAPAN_2025_REQUIRED_FACTS,
} from './workflow.js';
import {
  basicDeduction2025,
  nationalIncomeTax2025,
  reconstructionSurtax2025,
  salaryIncome2025,
} from './tables.js';
import { decimal, q } from './exact.js';
import { JAPAN_2025_SOURCES } from './sources.js';

function fixture(
  overrides: Record<string, string | boolean> = {},
): FinanceTaxIntake {
  return {
    schemaVersion: 1,
    caseId: '00000000-0000-4000-8000-000000000001',
    workspaceId: '00000000-0000-4000-8000-000000000002',
    taxSubjectId: '00000000-0000-4000-8000-000000000003',
    legalEntityId: null,
    sourceBooks: [],
    revision: 1,
    scope: { ...JAPAN_2025_CANDIDATE.scope },
    domesticResident: true,
    hasCrossBorderActivity: false,
    standaloneCorporation: null,
    requestedFeatures: ['income-tax-return'],
    facts: JAPAN_2025_REQUIRED_FACTS.map((definition) => ({
      key: definition.key,
      reviewState: 'reviewed',
      value: {
        type: definition.type,
        value:
          overrides[definition.key] ??
          ('equals' in definition ? definition.equals : '0'),
      } as FinanceTaxIntake['facts'][number]['value'],
      source: {
        kind: 'declaration',
        reference: 'Independent Japan 2025 fixture evidence',
        revision: 1,
        contentHash: 'a'.repeat(64),
      },
    })),
  };
}

function values(input: FinanceTaxIntake) {
  const result = evaluateJapan2025WorkingPapers(input);
  return {
    result,
    values: Object.fromEntries(
      result.evaluation.forms.flatMap((form) =>
        form.fields.map((field) => [
          `${form.id}.${field.key}`,
          field.value.value,
        ]),
      ),
    ),
  };
}

describe('Japan 2025 NTA tables', () => {
  it('uses the published salary-income bands and boundary truncations', () => {
    expect(salaryIncome2025(q(650_999n)).income).toEqual(q(0n));
    expect(salaryIncome2025(q(651_000n)).income).toEqual(q(1_000n));
    expect(salaryIncome2025(q(1_899_999n)).income).toEqual(q(1_249_999n));
    expect(salaryIncome2025(q(1_900_000n)).income).toEqual(q(1_250_000n));
    expect(salaryIncome2025(q(3_599_999n)).income).toEqual(q(2_437_200n));
    expect(salaryIncome2025(q(3_600_000n)).income).toEqual(q(2_440_000n));
    expect(salaryIncome2025(q(6_599_999n)).income).toEqual(q(4_836_800n));
    expect(salaryIncome2025(q(6_600_000n)).income).toEqual(q(4_840_000n));
    expect(salaryIncome2025(q(8_499_999n)).income).toEqual(q(6_549_999n));
    expect(salaryIncome2025(q(8_500_000n)).income).toEqual(q(6_550_000n));
  });

  it('uses the resident 2025 basic-deduction bands', () => {
    expect(basicDeduction2025(q(1_320_000n)).amount).toEqual(q(950_000n));
    expect(basicDeduction2025(q(1_320_001n)).amount).toEqual(q(880_000n));
    expect(basicDeduction2025(q(3_360_000n)).amount).toEqual(q(880_000n));
    expect(basicDeduction2025(q(3_360_001n)).amount).toEqual(q(680_000n));
    expect(basicDeduction2025(q(23_500_000n)).amount).toEqual(q(580_000n));
    expect(basicDeduction2025(q(23_500_001n)).amount).toEqual(q(480_000n));
    expect(basicDeduction2025(q(25_000_000n)).amount).toEqual(q(160_000n));
    expect(basicDeduction2025(q(25_000_001n)).amount).toEqual(q(0n));
  });

  it('uses each inclusive national-tax bracket and floors taxable income first', () => {
    const expected = [
      [1_949_000n, 97_450n],
      [1_950_000n, 97_500n],
      [3_299_000n, 232_400n],
      [3_300_000n, 232_500n],
      [6_949_000n, 962_300n],
      [6_950_000n, 962_500n],
      [8_999_000n, 1_433_770n],
      [9_000_000n, 1_434_000n],
      [17_999_000n, 4_403_670n],
      [18_000_000n, 4_404_000n],
      [39_999_000n, 13_203_600n],
      [40_000_000n, 13_204_000n],
    ] as const;
    for (const [taxable, amount] of expected)
      expect(nationalIncomeTax2025(q(taxable)).amount).toEqual(q(amount));
    expect(nationalIncomeTax2025(decimal('1949999.99'))).toMatchObject({
      taxableIncome: q(1_949_000n),
      amount: q(97_450n),
    });
  });

  it('truncates reconstruction surtax fractions below one yen', () => {
    expect(reconstructionSurtax2025(q(176_500n))).toEqual(q(3_706n));
    expect(reconstructionSurtax2025(q(47n))).toEqual(q(0n));
  });
});

describe('Japan 2025 national salary working papers', () => {
  it('matches the NTA salary example through the national tax and settlement chain', () => {
    const { result, values: output } = values(
      fixture({ 'salary.gross': '1920500' }),
    );
    expect(output).toMatchObject({
      'JP-Form-1.salaryGross': '1920500',
      'JP-Form-1.salaryIncome': '1264000',
      'JP-Form-1.totalIncome': '1264000',
      'JP-Form-1.socialInsurance': '0',
      'JP-Form-1.basicDeduction': '950000',
      'JP-Form-1.totalDeductions': '950000',
      'JP-Form-1.taxableIncome': '314000',
      'JP-Form-1.taxBeforeCredits': '15700',
      'JP-Form-1.deductedIncomeTax': '15700',
      'JP-Form-1.baseIncomeTax': '15700',
      'JP-Form-1.reconstructionSurtax': '329',
      'JP-Form-1.combinedTax': '16029',
      'JP-Form-1.withholding': '0',
      'JP-Form-1.estimatedTax': '0',
      'JP-Form-1.assessmentBeforeRounding': '16029',
      'JP-Form-1.declaredAssessment': '16000',
      'JP-Form-1.thirdPeriodDue': '16000',
      'JP-Form-1.refund': '0',
    });
    expect(output['JP-Form-2.salaryIncomeDetail']).toBe('1264000');
    expect(output['JP-Form-2.socialInsuranceDetail']).toBe('0');
    expect(output['JP-Form-2.withholdingDetail']).toBe('0');
    expect(result.status).toBe('incomplete-working-papers');
    expect(result.complete).toBe(false);
    expect(result.enabled).toBe(false);
    expect(result.reportable).toBe(false);
    expect(result.registryEligible).toBe(false);
    expect(result.evaluation.forms).toHaveLength(2);
  });

  it('keeps whole-yen and thousand-yen rules distinct and binds source facts through the graph', () => {
    const { result, values: output } = values(
      fixture({
        'salary.gross': '1900000',
        'deductions.socialInsurancePremiums': '1',
        'withholding.incomeTax': '20000',
      }),
    );
    expect(output).toMatchObject({
      'JP-Form-1.salaryIncome': '1250000',
      'JP-Form-1.totalDeductions': '950001',
      'JP-Form-1.taxableIncome': '299000',
      'JP-Form-1.baseIncomeTax': '14950',
      'JP-Form-1.reconstructionSurtax': '313',
      'JP-Form-1.combinedTax': '15263',
      'JP-Form-1.assessmentBeforeRounding': '-4737',
      'JP-Form-1.declaredAssessment': '-4737',
      'JP-Form-1.thirdPeriodDue': '0',
      'JP-Form-1.refund': '-4737',
    });
    const settlement = result.trace.find(
      (row) =>
        row.formId === 'JP-Form-1' && row.line === 'assessmentBeforeRounding',
    )!;
    expect(settlement.sourceFactKeys).toEqual([
      'deductions.other',
      'deductions.socialInsurancePremiums',
      'payments.estimatedTax',
      'salary.gross',
      'withholding.incomeTax',
    ]);
    expect(settlement.referenceIds).toContain('nta-jp-r07-assessment');
    const salaryIncome = result.trace.find(
      (row) => row.formId === 'JP-Form-1' && row.line === 'salaryIncome',
    )!;
    expect(salaryIncome.sourceFactKeys).toEqual(['salary.gross']);
    expect(salaryIncome.referenceIds).toEqual(['nta-jp-r07-salary-income']);
  });

  it('fails closed when required facts are missing, unreviewed, unsupported, fractional or out of scope', () => {
    const cases: Array<[string, (input: FinanceTaxIntake) => void, string]> = [
      ['missing', (input) => void input.facts.pop(), 'missing-reviewed-fact'],
      [
        'unreviewed',
        (input) => {
          input.facts[0]!.reviewState = 'unreviewed';
        },
        'unreviewed-fact',
      ],
      [
        'unsupported-fact',
        (input) => {
          input.facts.push({ ...input.facts[0]!, key: 'other.income' });
        },
        'unsupported-fact',
      ],
      [
        'fractional-money',
        (input) => {
          input.facts.find((fact) => fact.key === 'salary.gross')!.value = {
            type: 'decimal',
            value: '1920500.01',
          };
        },
        'invalid-money',
      ],
      [
        'foreign',
        (input) => {
          input.domesticResident = false;
        },
        'unsupported-scope',
      ],
      [
        'payroll-request',
        (input) => {
          input.requestedFeatures = ['income-tax-return', 'payroll'];
        },
        'unsupported-scope',
      ],
      [
        'high-income-special-measure',
        (input) => {
          input.facts.find((fact) => fact.key === 'salary.gross')!.value = {
            type: 'decimal',
            value: '332000000',
          };
        },
        'high-income-special-tax-not-covered',
      ],
    ];
    for (const [, mutate, code] of cases) {
      const input = fixture();
      mutate(input);
      const result = evaluateJapan2025WorkingPapers(input);
      expect(result.status).toBe('blocked-input');
      expect(result.evaluation.forms).toEqual([]);
      expect(result.complete).toBe(false);
      expect(result.reportable).toBe(false);
      expect(
        result.evaluation.issues.some((issue) => issue.code === code),
      ).toBe(true);
    }
  });

  it('rejects a caller supplied tax result and retains immutable deterministic output', () => {
    const input = fixture({
      'salary.gross': '1920500',
      'withholding.incomeTax': '999999',
    });
    const first = evaluateJapan2025WorkingPapers(input);
    const second = evaluateJapan2025WorkingPapers(input);
    expect(first.outputHash).toBe(second.outputHash);
    expect(first.inputHash).toBe(second.inputHash);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.fields[0])).toBe(true);
    expect(first.calculations?.combinedTax).toBe('16029');
    expect(first.calculations?.amountDue).toBe('0');
    expect(first.calculations?.refund).toBe('-983970');
    expect(
      first.releaseBlockers.some((blocker) =>
        blocker.includes('full-return-attestation'),
      ),
    ).toBe(true);
  });

  it('binds every declared NTA source to its captured bytes and manifest', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('./sources/manifest.json', import.meta.url), 'utf8'),
    ) as {
      sources: Array<{ id: string; file: string; sha256: string }>;
    };
    expect(manifest.sources).toHaveLength(JAPAN_2025_SOURCES.length);
    const sourceIds = new Set(JAPAN_2025_SOURCES.map((source) => source.id));
    for (const rule of JAPAN_2025_CANDIDATE.rules)
      for (const referenceId of rule.referenceIds)
        expect(sourceIds.has(referenceId)).toBe(true);
    const valid = evaluateJapan2025WorkingPapers(fixture());
    for (const field of valid.fields)
      expect(sourceIds.has(field.sourceId)).toBe(true);
    const sourceDirectory = new URL('./sources/', import.meta.url);
    for (const source of JAPAN_2025_SOURCES) {
      const entry = manifest.sources.find(
        (candidate) => candidate.id === source.id,
      );
      expect(entry).toBeDefined();
      const bytes = readFileSync(new URL(entry!.file, sourceDirectory));
      const digest = createHash('sha256').update(bytes).digest('hex');
      expect(digest).toBe(source.documentHash);
      expect(digest).toBe(entry!.sha256);
    }
  });

  it('exposes the latest-year and complete-return boundary as disabled metadata', () => {
    expect(JAPAN_2025_CANDIDATE.version).toBe(
      '2025.1-national-salary-working-papers',
    );
    expect(JAPAN_2025_CANDIDATE.enabled).toBe(false);
    expect(JAPAN_2025_CANDIDATE.complete).toBe(false);
    expect(JAPAN_2025_CANDIDATE.registryEligible).toBe(false);
    expect(JAPAN_2025_CANDIDATE.forms).toEqual(['JP-Form-1', 'JP-Form-2']);
    expect(JAPAN_2025_CANDIDATE.releaseBlockers).toContain(
      'local-inhabitant-tax-and-prefectural-municipal-tax-not-implemented',
    );
    expect(JAPAN_2025_CANDIDATE.releaseBlockers).toContain(
      'sole-proprietor-business-income-and-expense-schedules-not-implemented',
    );
    expect(JAPAN_2025_CANDIDATE.releaseBlockers).toContain(
      'corporation-return-and-corporate-local-tax-not-implemented',
    );
  });

  it('reports invalid generic intake before attempting the bounded graph', () => {
    const assessment = assessJapan2025Facts({});
    expect(assessment.intake).toBeNull();
    expect(assessment.issues).toEqual([
      {
        code: 'invalid-intake',
        message: 'Generic tax intake or source lineage is invalid.',
      },
    ]);
  });
});

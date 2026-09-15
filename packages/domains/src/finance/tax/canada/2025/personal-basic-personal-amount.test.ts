import { describe, expect, it } from 'vitest';
import {
  calculateCanada2025FederalBasicPersonalAmount,
  CANADA_2025_FEDERAL_BPA_WORKSHEET_PROVENANCE,
  divideAmountsToDimensionless,
  serializeCanada2025FederalBasicPersonalAmount,
  serializeDimensionlessRatio,
} from './personal-basic-personal-amount.js';
import { decimal as q } from './personal-exact.js';
import type { FinanceTaxIntake } from '@emdo/contracts';
import {
  CANADA_ON_2025_PERSONAL_QUESTIONS,
  runCanadaOntario2025PersonalWorkflow,
} from './personal-package.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function workflowInput(netInterest: string): FinanceTaxIntake {
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
      taxpayerType: 'individual',
      year: 2025,
      regime: 'income-tax-return',
      formVersion: '5006-R-E-25_5006-C-E-25',
    },
    domesticResident: true,
    hasCrossBorderActivity: false,
    standaloneCorporation: null,
    requestedFeatures: ['income-tax-return'],
    facts: CANADA_ON_2025_PERSONAL_QUESTIONS.map((question) => ({
      key: question.key,
      value:
        question.type === 'boolean'
          ? { type: 'boolean' as const, value: true }
          : question.type === 'text'
            ? {
                type: 'text' as const,
                value:
                  question.key === 'business.reportingMethod'
                    ? 'accrual'
                    : 'business',
              }
            : question.type === 'date'
              ? { type: 'date' as const, value: '1990-01-01' }
              : {
                  type: 'decimal' as const,
                  value: question.key === 'interest' ? netInterest : '0',
                },
      reviewState: 'reviewed' as const,
      source: {
        kind: 'declaration' as const,
        reference: `fixture:${question.key}`,
        revision: 1,
        contentHash: 'a'.repeat(64),
      },
    })),
  };
}

describe('2025 Federal Worksheet line 30000 basic personal amount', () => {
  it.each([
    ['-0.01', 'maximum', '16129'],
    ['0', 'maximum', '16129'],
    ['177882', 'maximum', '16129'],
    ['253414', 'minimum', '14538'],
    ['253414.01', 'minimum', '14538'],
  ] as const)('uses the published branch at %s', (income, branch, amount) => {
    const result = calculateCanada2025FederalBasicPersonalAmount(q(income));
    expect(result.branch).toBe(branch);
    expect(result.amount).toEqual(q(amount));
    expect(result.worksheet).toBeNull();
  });

  it('calculates the phaseout with a typed ratio and no monetary-cent division', () => {
    const result = calculateCanada2025FederalBasicPersonalAmount(q('200000'));
    expect(result.branch).toBe('phaseout');
    expect(result.worksheet?.line7).toMatchObject({
      kind: 'dimensionless-ratio',
      n: 11059n,
      d: 37766n,
      provenance: CANADA_2025_FEDERAL_BPA_WORKSHEET_PROVENANCE,
    });
    expect(serializeDimensionlessRatio(result.worksheet!.line7)).toEqual({
      kind: 'dimensionless-ratio',
      unit: 'dimensionless',
      exactRational: { numerator: '11059', denominator: '37766' },
      exactDecimal: null,
      provenance: CANADA_2025_FEDERAL_BPA_WORKSHEET_PROVENANCE,
    });
    expect(result.worksheet?.line9).toEqual({
      n: 17594869n,
      d: 37766n,
    });
    expect(result.amount).toEqual({ n: 591532945n, d: 37766n });
    expect(serializeCanada2025FederalBasicPersonalAmount(result)).toEqual(
      expect.objectContaining({
        branch: 'phaseout',
        reporting: {
          ratio: 'dimensionless-not-reportable',
          annualRounding: 'unestablished',
        },
      }),
    );
  });

  it('retains half-dollar worksheet values independently at the phaseout midpoint', () => {
    const result = calculateCanada2025FederalBasicPersonalAmount(q('215648'));
    expect(result.worksheet?.line7).toMatchObject({ n: 1n, d: 2n });
    expect(result.worksheet?.line9).toEqual({ n: 1591n, d: 2n });
    expect(result.worksheet?.line10).toEqual({ n: 1591n, d: 2n });
    expect(result.amount).toEqual({ n: 30667n, d: 2n });
    expect(
      serializeCanada2025FederalBasicPersonalAmount(result).worksheet?.line7,
    ).toMatchObject({ exactDecimal: '0.5', unit: 'dimensionless' });
  });

  it('keeps the first and last fractional dollars inside the phaseout', () => {
    const first = calculateCanada2025FederalBasicPersonalAmount(q('177882.01'));
    expect(first.worksheet?.line7).toMatchObject({ n: 1n, d: 7553200n });
    expect(first.worksheet?.line11).toEqual({
      n: 121825561209n,
      d: 7553200n,
    });
    const last = calculateCanada2025FederalBasicPersonalAmount(q('253413.99'));
    expect(last.worksheet?.line7).toMatchObject({
      n: 7553199n,
      d: 7553200n,
    });
    expect(last.worksheet?.line11).toEqual({
      n: 109808423191n,
      d: 7553200n,
    });
  });

  it('rejects a zero denominator instead of manufacturing a ratio', () => {
    expect(() =>
      divideAmountsToDimensionless(
        q('1'),
        q('0'),
        CANADA_2025_FEDERAL_BPA_WORKSHEET_PROVENANCE,
      ),
    ).toThrow('dimensionless-zero-denominator');
  });

  it('connects the phaseout worksheet to the Ontario workflow without CAD-cent reporting for line 7', () => {
    const run = runCanadaOntario2025PersonalWorkflow(workflowInput('200000'));
    expect(run.issues).toEqual([]);
    expect(run.packageVersion).toBe('2025.1-personal-workflow.30');
    expect(run.federalBasicPersonalAmountWorksheet?.worksheet?.line7).toEqual(
      expect.objectContaining({
        unit: 'dimensionless',
        exactRational: { numerator: '11059', denominator: '37766' },
      }),
    );
    const ratioField = run.fields.find((field) => field.id === 'FederalBpa.7');
    expect(ratioField?.unit).toBe('dimensionless');
    expect(ratioField?.provenance).toEqual(
      CANADA_2025_FEDERAL_BPA_WORKSHEET_PROVENANCE,
    );
    expect(ratioField?.reportableAmount).toBeNull();
    expect(ratioField?.reporting.status).toBe('dimensionless-not-reportable');
    expect(
      run.fields.find((field) => field.id === 'T1.30000')?.reporting.status,
    ).toBe('dependency-unresolved');
    expect(
      run.fields.find((field) => field.id === 'T1.30000')?.reportableAmount,
    ).toBeNull();
  });

  it('reports the direct threshold branch only when no phaseout worksheet is required', () => {
    const run = runCanadaOntario2025PersonalWorkflow(workflowInput('0'));
    expect(run.issues).toEqual([]);
    expect(run.federalBasicPersonalAmountWorksheet?.worksheet).toBeNull();
    expect(run.fields.some((field) => field.id === 'FederalBpa.7')).toBe(false);
    expect(run.fields.find((field) => field.id === 'T1.30000')).toMatchObject({
      exactDecimal: '16129',
      reportableAmount: '16129.00',
      reporting: { status: 'lossless-cents' },
    });
  });
});

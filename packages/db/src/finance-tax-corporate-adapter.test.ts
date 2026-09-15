import { describe, it, expect } from 'vitest';
import {
  FinanceTaxIntakeSchema,
  FinanceTaxRunFieldSchema,
} from '@emdo/contracts';
import {
  CORPORATE_PRIVATE_SCOPE,
  CORPORATE_PRIVATE_QUESTIONS,
} from '@emdo/domains/finance';
import { corporateFixtureValues } from './finance-tax-corporate.fixture.js';
import {
  runPrivateCorporateWorkingPapers,
  exportPrivateCorporateWorkingPapers,
} from './finance-tax-corporate-adapter.js';
function intake() {
  return FinanceTaxIntakeSchema.parse({
    schemaVersion: 1,
    caseId: '00000000-0000-4000-8000-000000000001',
    workspaceId: '00000000-0000-4000-8000-000000000002',
    taxSubjectId: '00000000-0000-4000-8000-000000000003',
    legalEntityId: null,
    sourceBooks: [],
    revision: 1,
    scope: CORPORATE_PRIVATE_SCOPE,
    domesticResident: true,
    hasCrossBorderActivity: false,
    standaloneCorporation: true,
    requestedFeatures: ['income-tax-return'],
    facts: corporateFixtureValues().map((f) => ({
      ...f,
      reviewState: 'reviewed',
      source: {
        kind: 'declaration',
        reference: `declaration:${f.key}`,
        revision: 1,
        contentHash: 'a'.repeat(64),
      },
    })),
  });
}
describe('trusted corporate private-case adapter', () => {
  it('reconstructs full reviewed fixture from scalar source facts with source-bound numeric schedules and authorized CSV', () => {
    expect(CORPORATE_PRIVATE_QUESTIONS.length).toBeGreaterThan(128);
    const run = runPrivateCorporateWorkingPapers(intake(), 'b'.repeat(64));
    expect(
      run.issues.filter(
        (i) => i.code !== 't2-and-gifi-rounding-authority-unresolved',
      ),
    ).toEqual([]);
    expect(run.status).toBe('review-calculation-produced');
    expect(run.fields.length).toBeGreaterThan(100);
    expect(run.fields.find((f) => f.id === 'T2.700')!.reportableAmount).toBe(
      '9000',
    );
    expect(
      run.fields.find((f) => f.id === 'T2.balanceOwing')!.exactDecimal,
    ).toBe('2200');
    for (const f of run.fields)
      expect(FinanceTaxRunFieldSchema.safeParse(f).success).toBe(true);
    const exported = exportPrivateCorporateWorkingPapers(run);
    expect(exported.content).toContain('Synthetic Review Services');
    expect(exported.content).toContain('123456789RC0001');
    expect(exported.content).toContain('T2');
    expect(run.complete).toBe(false);
    expect(JSON.stringify(run.fields)).not.toContain('000000000');
  });
  it('preserves unresolved fractional reporting through the corporate dependency graph', () => {
    const i = intake();
    i.facts.find(
      (f) => f.key === 'corporate.financialStatements.operatingExpenses.9060',
    )!.value = { type: 'decimal', value: '29999.99' };
    i.facts.find(
      (f) => f.key === 'corporate.financialStatements.costOfSales.8360',
    )!.value = { type: 'decimal', value: '20000.01' };
    const run = runPrivateCorporateWorkingPapers(i, 'b'.repeat(64));
    expect(run.status).toBe('review-calculation-produced');
    expect(run.fields.find((f) => f.id === 'T2.700')).toMatchObject({
      exactDecimal: '9000',
      reportableAmount: null,
      reporting: { status: 'dependency-unresolved' },
    });
    expect(run.fields.find((f) => f.id === 'GIFI125.8360')).toMatchObject({
      exactDecimal: '20000.01',
      reportableAmount: null,
      reporting: { status: 'rounding-unproven' },
    });
    expect(run.releaseBlockers).toContain(
      't2-and-gifi-rounding-authority-unresolved',
    );
  });
  it('blocks missing, unreviewed, wrong-scope and unknown inputs without constructing guessed corporate facts', () => {
    for (const change of [
      (i: ReturnType<typeof intake>) => {
        i.facts.pop();
      },
      (i: ReturnType<typeof intake>) => {
        i.facts[0]!.reviewState = 'unreviewed';
      },
      (i: ReturnType<typeof intake>) => {
        i.scope.year = 2024;
      },
      (i: ReturnType<typeof intake>) => {
        i.facts[0]!.key = 'caller.output';
      },
    ]) {
      const i = intake();
      change(i);
      const run = runPrivateCorporateWorkingPapers(i, 'b'.repeat(64));
      expect(run.status).toBe('blocked');
      expect(run.fields).toEqual([]);
      expect(() => exportPrivateCorporateWorkingPapers(run)).toThrow();
    }
  });
});

import { us2025TestFixture as fixture } from './test-fixtures.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type FinanceTaxIntake } from '@emdo/contracts';
import { evaluateUs2025WorkingPapers, US_2025_CANDIDATE } from './workflow.js';
import { roundUsdLine, roundNonnegativeRatio } from './rounding.js';
import { US_2025_SOURCES } from './sources.js';
import {
  singleIncomeTax2025,
  singleNoChildEic2025,
  IRS_SINGLE_TABLE_DATA,
} from './tables.js';
import { q } from './exact.js';
import { US_2025_FIELD_CATALOG } from './form-fields.js';

function lines(input: FinanceTaxIntake) {
  const result = evaluateUs2025WorkingPapers(input);
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
describe('IRS 2025 federal working papers', () => {
  it('matches IRS Publication 334 actual regular-method earnings example (not its optional election)', () => {
    // Publication 334 (2025), chapter 10, Nonfarm Optional Method, Example 1:
    // $5,400 gross, $1,200 profit, actual regular-method earnings $1,108.
    const { result, values } = lines(
      fixture({ 'business.receipts': '5400', 'business.expense.22': '4200' }),
    );
    expect(values['C.31']).toBe('1200');
    expect(values['SE.4a']).toBe('1108');
    // Whole-dollar field dependencies: entered earnings1108; taxes137+32=169; half84.5→85.
    expect(values).toMatchObject({
      'SE.10': '137',
      'SE.11': '32',
      'SE.12': '169',
      'SE.13': '85',
      'F1040.11a': '1115',
      'S2.4': '169',
    });
    expect(
      result.trace.find((row) => row.formId === 'SE' && row.line === '4a'),
    ).toMatchObject({ exactNumerator: '5541', exactDenominator: '5' });
    expect(result.complete).toBe(false);
    expect(result.status).toBe('incomplete-working-papers');
    expect(values['F1040.16']).toBe('0');
    expect(values['S2.21']).toBe('169');
  });
  it('carries entered SE totals into the half-tax deduction and retains exact pre-entry lineage', () => {
    for (const [profit, social, medicare, tax, deduction, agi] of [
      ['10000', '1145', '268', '1413', '707', '9293'],
      ['50000', '5726', '1339', '7065', '3533', '46467'],
    ]) {
      const { result, values } = lines(
        fixture({ 'business.receipts': profit! }),
      );
      expect(values).toMatchObject({
        'SE.10': social,
        'SE.11': medicare,
        'SE.12': tax,
        'SE.13': deduction,
        'S1.15': deduction,
        'F1040.10': deduction,
        'F1040.11a': agi,
      });
      expect(BigInt(values['SE.12'] as string)).toBe(
        BigInt(social!) + BigInt(medicare!),
      );
      const half = result.trace.find(
        (row) => row.formId === 'SE' && row.line === '13',
      )!;
      expect(half.dependsOn).toEqual(['SE.12']);
      expect(half.exactNumerator).toBe(tax);
      expect(half.exactDenominator).toBe('2');
    }
  });
  it('matches the IRS $525 gross / $175 net example: no regular-method SE tax', () => {
    const { values } = lines(
      fixture({ 'business.receipts': '525', 'business.expense.22': '350' }),
    );
    expect(values).toMatchObject({
      'C.31': '175',
      'SE.4c': '162',
      'S2.4': '0',
      'S1.15': '0',
    });
    expect(values['SE.12']).toBeUndefined();
  });
  it('calculates the mixed W-2 wage ceiling independently of Medicare', () => {
    const { values } = lines(
      fixture({
        'business.receipts': '10000',
        'w2.box1': '175000',
        'w2.box3': '175000',
        'w2.box5': '175000',
      }),
    );
    // 9,235 earnings; 1,100 remaining SS base x .124=136.40 ->136;
    // 9,235 x .029=267.815 ->268; total404 and half202.
    expect(values).toMatchObject({
      'SE.9': '1100',
      'SE.10': '136',
      'SE.11': '268',
      'SE.12': '404',
      'SE.13': '202',
      'F1040.11a': '184798',
    });
  });
  it('skips Social Security lines at the wage ceiling and exposes additional Medicare dependency', () => {
    const { values, result } = lines(
      fixture({
        'business.receipts': '30000',
        'w2.box1': '176100',
        'w2.box3': '176100',
        'w2.box5': '176100',
      }),
    );
    expect(values['SE.10']).toBeUndefined();
    expect(values['SE.11']).toBe('803');
    expect(values['F8959.18']).toBe('34');
    expect(
      result.evaluation.issues.some(
        (issue) => issue.code === 'additional-medicare-required',
      ),
    ).toBe(false);
  });
  it('applies the IRS 433-dollar Schedule SE threshold exception after entered-line rounding', () => {
    const cases = [
      { receipts: '432', entered: '432', net: '399', tax: '0' },
      { receipts: '433', entered: '433', net: '400', tax: '62' },
      { receipts: '433.49', entered: '433', net: '400', tax: '62' },
      { receipts: '433.50', entered: '434', net: '401', tax: '62' },
      { receipts: '433.99', entered: '434', net: '401', tax: '62' },
      { receipts: '434', entered: '434', net: '401', tax: '62' },
    ] as const;

    for (const testCase of cases) {
      const { result, values } = lines(
        fixture({ 'business.receipts': testCase.receipts }),
      );
      expect(values).toMatchObject({
        'C.31': testCase.entered,
        'SE.3': testCase.entered,
        'SE.4a': testCase.net,
        'SE.4c': testCase.net,
        'S2.4': testCase.tax,
      });
      expect(
        result.evaluation.issues.some(
          (issue) => issue.code === 'se-400-threshold-reporting-unresolved',
        ),
      ).toBe(false);
      expect(
        result.trace
          .filter((row) => row.formId === 'SE')
          .every((row) =>
            row.referenceIds.includes('irs-2025-irm-se-threshold'),
          ),
      ).toBe(true);
    }

    const boundary = lines(fixture({ 'business.receipts': '433' }));
    expect(
      boundary.result.trace.find(
        (row) => row.formId === 'SE' && row.line === '4a',
      ),
    ).toMatchObject({
      exactNumerator: '799751',
      exactDenominator: '2000',
      reportedDollars: '400',
      referenceIds: expect.arrayContaining(['irs-2025-irm-se-threshold']),
    });
  });
  it('keeps fractional receipts and expenses and traceable source facts', () => {
    const { result, values } = lines(
      fixture({
        'business.receipts': '1200.50',
        'business.expense.22': '0.49',
      }),
    );
    expect(values['C.1']).toBe('1201');
    expect(values['C.22']).toBe('0');
    const agi = result.trace.find(
      (row) => row.formId === 'F1040' && row.line === '11a',
    )!;
    expect(agi.sourceFactKeys).toContain('business.receipts');
    expect(agi.sourceFactKeys).toContain('w2.box1');
    expect(agi.referenceIds).toContain('irs-2025-f1040');
  });
  it.each([
    'missing',
    'unreviewed',
    'unsupported',
    'extra',
    'loss',
    'precision',
    'scope',
    'lineage',
  ] as const)('fails closed for %s input', (problem) => {
    const input = fixture({ 'business.receipts': '1200' });
    if (problem === 'missing') input.facts.pop();
    if (problem === 'unreviewed') input.facts[0].reviewState = 'unreviewed';
    if (problem === 'unsupported')
      input.facts.find((f) => f.key === 'optionalSeMethod')!.value = {
        type: 'boolean',
        value: true,
      };
    if (problem === 'extra')
      input.facts.push({ ...input.facts[0], key: 'unmapped-income' });
    if (problem === 'loss')
      input.facts.find((f) => f.key === 'business.expense.22')!.value = {
        type: 'decimal',
        value: '1201',
      };
    if (problem === 'precision')
      input.facts.find((f) => f.key === 'business.receipts')!.value = {
        type: 'decimal',
        value: '1200.001',
      };
    if (problem === 'scope') input.scope.subdivision = 'US-NY';
    if (problem === 'lineage')
      input.facts[0].source = {
        ...input.facts[0].source,
        kind: 'ledger-snapshot',
        sourceBookId: input.caseId,
      };
    const result = evaluateUs2025WorkingPapers(input);
    expect(result.status).toBe('blocked-input');
    expect(result.evaluation.forms).toEqual([]);
    expect(result.complete).toBe(false);
  });
  it('distinguishes source cents aggregated within one line from sums of entered expense lines', () => {
    const { result, values } = lines(
      fixture({
        'business.receipts': '1000',
        'business.expense.8': '0.49',
        'business.expense.22': '0.49',
        'w2.box3': '0.49',
        'w2.box7': '0.49',
      }),
    );
    expect(values).toMatchObject({
      'C.8': '0',
      'C.22': '0',
      'C.28': '0',
      'C.31': '1000',
      'SE.8a': '1',
    });
    for (const form of result.evaluation.forms)
      for (const field of form.fields)
        for (const ruleId of field.ruleIds)
          expect(
            US_2025_CANDIDATE.rules.some((rule) => rule.id === ruleId),
          ).toBe(true);
  });
  it('freezes outputs and deterministically binds reviewed source revisions', () => {
    const input = fixture({ 'business.receipts': '1200' });
    const a = evaluateUs2025WorkingPapers(input);
    expect(() => {
      (a.trace as unknown as unknown[]).pop();
    }).toThrow();
    expect(evaluateUs2025WorkingPapers(input).outputHash).toBe(a.outputHash);
    input.facts[0].source.revision++;
    expect(evaluateUs2025WorkingPapers(input).binding?.inputHash).not.toBe(
      a.binding?.inputHash,
    );
    expect(US_2025_CANDIDATE.enabled).toBe(false);
    expect(US_2025_CANDIDATE.registryEligible).toBe(false);
  });
  it('reconciles a positive-profit federal calculation through QBI, tax table and refund allocation', () => {
    // Independent arithmetic: profit40000; SE5651.82; half2825.91; AGI37174.09;
    // income-limited QBI4284.818; taxable17139.272; printed tax-table row17100–17150=1817.
    const { values, result } = lines(
      fixture({
        'business.receipts': '50000',
        'business.expense.22': '10000',
        'payments.estimatedAndPriorYearApplied': '10000',
        'payments.applyTo2026': '1000',
      }),
    );
    expect(values).toMatchObject({
      'C.31': '40000',
      'S1.15': '2826',
      'F1040.11b': '37174',
      'F8995.5': '7435',
      'F8995.14': '4285',
      'F8995.15': '4285',
      'F1040.15': '17139',
      'F1040.16': '1817',
      'F6251.11': '0',
      'F1040.24': '7469',
      'F1040.33': '10000',
      'F1040.34': '2531',
      'F1040.36': '1000',
      'F1040.35a': '1531',
      'F1040.37': '0',
    });
    expect(result.complete).toBe(false);
  });
  it('uses the published single-column tax for the IRS sample taxable income25300', () => {
    const { values } = lines(
      fixture({ 'w2.box1': '41050', 'w2.box2': '3000' }),
    );
    expect(values).toMatchObject({
      'F1040.15': '25300',
      'F1040.16': '2801',
      'F1040.35a': '199',
    });
  });
  it('calculates the childless EIC worksheet and its transfer without inventing other credits', () => {
    const { values } = lines(fixture({ 'business.receipts': '1200' }));
    // EIC WorksheetB entered earned income1115; published single/0 row1100–1150=86.
    expect(values).toMatchObject({
      'EICB.4b': '1115',
      'EICB.7': '86',
      'F1040.27a': '86',
      'F1040.33': '86',
      'F1040.37': '83',
    });
    expect(
      lines(
        fixture({
          'business.receipts': '1200',
          'eic.ageBand': 'under25',
          'identity.birthDate': '2005-06-15',
        }),
      ).values['F1040.27a'],
    ).toBe('0');
    expect(
      lines(
        fixture({
          'business.receipts': '1200',
          'eic.validEmploymentSsn': false,
        }),
      ).values['F1040.27a'],
    ).toBe('0');
  });
  it('blocks unsupported QBI phase-in and invalid payment allocation without a false refund', () => {
    const high = lines(
      fixture({ 'w2.box1': '211935.50', 'business.receipts': '1200' }),
    );
    expect(high.values['F1040.16']).toBeUndefined();
    expect(high.values['F1040.35a']).toBeUndefined();
    expect(
      high.result.evaluation.issues.some(
        (issue) => issue.code === 'form-8995-a-required',
      ),
    ).toBe(true);
    expect(lines(fixture({ 'w2.box1': '213050' })).values['F1040.16']).toBe(
      '40199',
    );
    const invalid = lines(fixture({ 'payments.applyTo2026': '1' }));
    expect(invalid.values['F1040.35a']).toBeUndefined();
    const noQbi = lines(fixture({ 'w2.box1': '213051' }));
    expect(noQbi.values['F1040.16']).toBeDefined();
    expect(
      noQbi.result.evaluation.issues.some(
        (issue) => issue.code === 'form-8995-a-required',
      ),
    ).toBe(false);
    const phaseout = lines(fixture({ 'w2.box1': '626351' }));
    expect(phaseout.values['F1040.35a']).toBeUndefined();
    expect(
      phaseout.result.evaluation.issues.some(
        (issue) => issue.code === 'amt-exemption-phaseout-not-implemented',
      ),
    ).toBe(true);
    expect(
      invalid.result.evaluation.issues.some(
        (issue) => issue.code === 'invalid-refund-allocation',
      ),
    ).toBe(true);
  });
  it('reconciles additional Medicare withholding rather than treating all box6 as income-tax withholding', () => {
    const { values } = lines(
      fixture({
        'w2.box1': '205000',
        'w2.box3': '176100',
        'w2.box5': '205000',
        'w2.box6': '3017.50',
      }),
    );
    // Regular Medicare2972.50; additional wage tax45; additional withholding45.
    expect(values).toMatchObject({
      'F8959.7': '45',
      'F8959.22': '45',
      'F1040.25c': '45',
      'S2.11': '45',
    });
  });
  it.each([
    'eic.ageBand',
    'qbi.priorLossOrSuspendedLoss',
    'schedule1AEligibleDeductions',
    'amtAdjustmentsOrPreferences',
    'payments.estimatedAndPriorYearApplied',
  ])('requires reviewed return-chain fact %s', (key) => {
    const input = fixture();
    input.facts = input.facts.filter((fact) => fact.key !== key);
    expect(evaluateUs2025WorkingPapers(input).status).toBe('blocked-input');
  });
  it('requires the W-2 attachment when withholding exists even with zero box1 wages', () => {
    const { result } = lines(fixture({ 'w2.box2': '12' }));
    expect(
      result.fieldCoverage?.attachments.find((item) => item.form === 'W-2')
        ?.required,
    ).toBe(true);
  });
  it('matches the runtime field catalog to the reproducible source capture', () => {
    expect(US_2025_FIELD_CATALOG).toEqual(
      JSON.parse(
        readFileSync(
          new URL('./sources/field-catalog.json', import.meta.url),
          'utf8',
        ),
      ),
    );
  });
  it('classifies all787 IRS source fields for the covered review fixture and preserves identity copies', () => {
    const { result } = lines(
      fixture({ 'business.receipts': '50000', 'business.expense.22': '10000' }),
    );
    expect(result.fieldCoverage?.sourceFieldCount).toBe(787);
    expect(result.fieldCoverage?.unresolved).toEqual([]);
    expect(
      result.fieldCoverage?.fields.find(
        (field) => field.formId === 'C' && field.fieldId === 'f1_1[0]',
      ),
    ).toMatchObject({ status: 'populated', value: 'Alex Q Example' });
    expect(
      result.fieldCoverage?.fields.find(
        (field) => field.formId === 'F1040' && field.fieldId === 'c1_8[0]',
      ),
    ).toMatchObject({ status: 'populated', value: true });
    expect(
      result.fieldCoverage?.fields.find(
        (field) => field.formId === 'F1040' && field.fieldId === 'f1_31[0]',
      ),
    ).toMatchObject({ status: 'inapplicable' });
    expect(
      result.fieldCoverage?.attachments.find(
        (attachment) => attachment.form === 'F2210',
      )?.required,
    ).toBe(false);
  });
  it('validates form lengths, published business codes, DOB and payment timing facts', () => {
    for (const overrides of [
      { 'identity.ssn': '123' },
      { 'business.code': '541611' },
      { 'identity.birthDate': '1961-01-01' },
      {
        'refund.method': 'checking',
        'refund.routing': '123',
        'refund.account': 'test',
      },
      { 'identity.street': 'bad\naddress' },
      {
        'payments.estimatedAndPriorYearApplied': '1000',
        'penalty.paymentLedger': '[]',
      },
    ] as Record<string, string | boolean>[])
      expect(evaluateUs2025WorkingPapers(fixture(overrides)).status).toBe(
        'blocked-input',
      );
    const eligible = lines(
      fixture({
        'identity.birthDate': '2001-01-01',
        'business.receipts': '1200',
      }),
    );
    expect(eligible.values['F1040.27a']).toBe('86');
  });
  it('keeps blocked computations unresolved in the field inventory', () => {
    const { result } = lines(
      fixture({ 'business.receipts': '1200', 'w2.box1': '211935.50' }),
    );
    expect(result.fieldCoverage?.unresolved).toContain('F1040.f2_08[0]');
  });
  it('reconciles a late-payment penalty with the full refund allocation', () => {
    const { values, result } = lines(
      fixture({
        'business.receipts': '50000',
        'business.expense.22': '10000',
        'penalty.priorYearTaxFor2210': '20000',
        'penalty.priorYearAgi': '100000',
        'payments.estimatedAndPriorYearApplied': '10000',
        'payments.applyTo2026': '1000',
        'penalty.paymentLedger': JSON.stringify([
          { date: '2026-01-15', amount: '10000', kind: 'estimated' },
        ]),
      }),
    );
    // Independently: net quarterly requirement1680.4845 ×(275+213+122)days ×.07/365 =196.593666…
    expect(values).toMatchObject({
      'F1040.38': '197',
      'F1040.34': '2531',
      'F1040.35a': '1334',
      'F1040.36': '1000',
      'F1040.37': '0',
    });
    expect(
      BigInt(String(values['F1040.35a'])) +
        BigInt(String(values['F1040.36'])) +
        BigInt(String(values['F1040.38'])),
    ).toBe(BigInt(String(values['F1040.34'])));
    expect(result.penaltyProof?.exception).toBeNull();
    expect(result.fieldCoverage?.unresolved).toEqual([]);
  });
  it('validates direct-deposit field bounds and conditional1099 controls', () => {
    const { result } = lines(
      fixture({
        'w2.box1': '41050',
        'w2.box2': '3000',
        'refund.method': 'checking',
        'refund.routing': '021000021',
        'refund.account': 'EXAMPLE-123',
        'business.requires1099': false,
      }),
    );
    expect(
      result.fieldCoverage?.fields.find(
        (field) => field.formId === 'F1040' && field.fieldId === 'f2_32[0]',
      ),
    ).toMatchObject({ status: 'populated', value: '021000021' });
    expect(
      result.fieldCoverage?.fields.find(
        (field) => field.formId === 'C' && field.fieldId === 'c1_5[0]',
      ),
    ).toMatchObject({ status: 'inapplicable' });
    expect(
      evaluateUs2025WorkingPapers(
        fixture({
          'refund.method': 'checking',
          'refund.routing': '021000021',
          'refund.account': '123456789012345678',
        }),
      ).status,
    ).toBe('blocked-input');
  });
  it('checks all immutable primary-source hashes against captured bytes', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('./sources/manifest.json', import.meta.url), 'utf8'),
    ) as { id: string; file: string; documentHash: string }[];
    expect(manifest.length).toBe(19);
    for (const source of manifest) {
      expect(
        createHash('sha256')
          .update(
            readFileSync(new URL(`./sources/${source.file}`, import.meta.url)),
          )
          .digest('hex'),
      ).toBe(source.documentHash);
      expect(
        US_2025_SOURCES.find((item) => item.id === source.id)?.documentHash,
      ).toBe(source.documentHash);
    }
  });
});
describe('explicit IRS whole-dollar election', () => {
  it('matches IRS examples and sums cents before rounding an input line', () => {
    expect(roundUsdLine(['1.39'])).toBe('1');
    expect(roundUsdLine(['2.50'])).toBe('3');
    expect(roundUsdLine(['0.49', '0.49'])).toBe('1');
    expect(roundUsdLine(['0.49'])).toBe('0');
    expect(roundNonnegativeRatio(1004999n, 1000000n)).toBe(1n);
    expect(roundNonnegativeRatio(1500000n, 1000000n)).toBe(2n);
    expect(() => roundUsdLine(['-1.00'])).toThrow();
  });
});

describe('published2025 single tax and childless EIC tables', () => {
  it('uses table values below100000 and the computation worksheet at100000', () => {
    expect(singleIncomeTax2025(q(99999n))).toMatchObject({
      method: 'tax-table',
      amount: q(16909n),
    });
    expect(singleIncomeTax2025(q(100000n))).toMatchObject({
      method: 'computation-worksheet',
      amount: q(16914n),
    });
    expect(singleIncomeTax2025(q(103350n)).amount).toEqual(q(17651n));
    expect(singleIncomeTax2025(q(103351n)).amount).toEqual(q(1765124n, 100n));
    expect(singleIncomeTax2025(q(9999950n, 100n)).method).toBe(
      'computation-worksheet',
    );
  });
  it('honors published childless EIC peak and the19100 footnote zero', () => {
    expect(singleNoChildEic2025(q(2455n))).toBe(189n); // printed IRS sample row single/0 column
    expect(singleNoChildEic2025(q(8490n))).toBe(649n);
    expect(singleNoChildEic2025(q(19099n))).toBe(2n);
    expect(singleNoChildEic2025(q(19100n))).toBe(0n);
    expect(singleNoChildEic2025(q(19104n))).toBe(0n);
  });
  it('preserves contiguous table intervals and matches the reproducible source artifact', () => {
    const artifact = JSON.parse(
      readFileSync(
        new URL('./sources/single-tables.json', import.meta.url),
        'utf8',
      ),
    );
    expect(IRS_SINGLE_TABLE_DATA).toEqual(artifact);
    expect(IRS_SINGLE_TABLE_DATA.singleTax).toHaveLength(2062);
    expect(() => {
      (IRS_SINGLE_TABLE_DATA.singleTax as unknown as unknown[]).pop();
    }).toThrow();
    for (const rows of [
      IRS_SINGLE_TABLE_DATA.singleTax,
      IRS_SINGLE_TABLE_DATA.singleNoChildEic,
    ])
      for (let index = 1; index < rows.length; index++)
        expect(rows[index][0]).toBe(rows[index - 1][1]);
  });
});

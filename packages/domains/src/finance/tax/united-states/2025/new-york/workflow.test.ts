import { describe, it, expect } from 'vitest';
import type { FinanceTaxIntake } from '@emdo/contracts';
import { us2025TestFixture } from '../test-fixtures.js';
import { usReviewContentHash } from '../review-bundle.js';
import {
  NY_2025_REQUIRED_FACTS,
  evaluateNewYork2025WorkingPapers,
  newYorkSingleTax2025,
  newYorkSingleRecapture2025,
  calculateNyMctmt2025,
} from './workflow.js';
function fixture(
  overrides: Record<string, string | boolean> = {},
  federalOverrides: Record<string, string | boolean> = {},
) {
  const federal = us2025TestFixture({
    'business.receipts': '40000',
    'identity.city':
      overrides.localResidence === 'NYC'
        ? 'New York'
        : overrides.localResidence === 'Yonkers'
          ? 'Yonkers'
          : 'Albany',
    'identity.zip':
      overrides.localResidence === 'NYC'
        ? '10001'
        : overrides.localResidence === 'Yonkers'
          ? '10701'
          : '12207',
    ...federalOverrides,
  });
  const formDefaults: Record<string, string | boolean> = {
    'penalty.method': 'short-method',
    'penalty.returnFiledOn': 'not-filed',
    'penalty.returnBalancePaidOn': 'unpaid',
    'identity.firstName': 'Alex',
    'identity.middleInitial': 'Q',
    'identity.county':
      overrides.localResidence === 'NYC'
        ? 'New York'
        : overrides.localResidence === 'Yonkers'
          ? 'Westchester'
          : 'Albany',
    'identity.schoolDistrict':
      overrides.localResidence === 'NYC'
        ? 'Manhattan'
        : overrides.localResidence === 'Yonkers'
          ? 'Yonkers'
          : 'Albany',
    'identity.schoolDistrictCode':
      overrides.localResidence === 'NYC'
        ? '369'
        : overrides.localResidence === 'Yonkers'
          ? '715'
          : '005',
    'identity.homeSameAsMailing': true,
    'identity.homeStreet': 'none',
    'identity.homeApartment': 'none',
    'identity.homeCity': 'none',
    'identity.homeZip': 'none',
    'identity.nycQuarters': overrides.localResidence === 'NYC',
    'identity.yonkersQuarters': overrides.localResidence === 'Yonkers',
    'refund.method': 'check',
    'refund.routing': 'none',
    'refund.account': 'none',
  };
  const ny: FinanceTaxIntake = {
    ...federal,
    scope: {
      ...federal.scope,
      subdivision: 'US-NY',
      formVersion: 'IT201-2025',
    },
    facts: NY_2025_REQUIRED_FACTS.map((required) => ({
      key: required.key,
      reviewState: 'reviewed',
      value: {
        type: required.type,
        value:
          overrides[required.key] ??
          formDefaults[required.key] ??
          ('equals' in required
            ? required.equals
            : required.key === 'federalInputHash'
              ? usReviewContentHash(federal)
              : required.key === 'localResidence'
                ? 'outside-NYC-Yonkers'
                : required.key === 'penalty.paymentLedger'
                  ? '[]'
                  : required.key === 'penalty.balancePaidOn'
                    ? 'unpaid'
                    : required.type === 'boolean'
                      ? false
                      : required.key === 'businessLocation'
                        ? 'outside-MCTD'
                        : '0'),
      } as FinanceTaxIntake['facts'][number]['value'],
      source: {
        kind: 'declaration',
        reference: 'independently-reviewed-NY-fixture',
        revision: 1,
        contentHash: 'd'.repeat(64),
      },
    })),
  };
  return { federal, ny };
}
describe('explicit New York2025 initial subdivision', () => {
  it('transfers reviewed federal income to the published state table and correct IT201 totals', () => {
    const f = fixture();
    const result = evaluateNewYork2025WorkingPapers(f.federal, f.ny);
    const values = Object.fromEntries(
      result.trace.map((row) => [row.key, row.value]),
    );
    // 37174 AGI -8000 standard=29174. Published29150–29200 NYS single table=1440.
    expect(values).toMatchObject({
      '19': '37174',
      '34': '8000',
      '38': '29174',
      '39': '1440',
      '40': '0',
      '41': '0',
      '43': '0',
      '44': '1440',
      '46': '1440',
      '58': '0',
      '61': '1440',
      '62': '1440',
      '80': '1522',
      '81': '82',
    });
    expect(result.complete).toBe(false);
    expect(result.physicalCoverage?.issues).toEqual([]);
    expect(
      result.physicalCoverage?.fields
        .filter((field) => field.status === 'unresolved')
        .map((field) => field.fieldId),
    ).toEqual([]);
    expect(result.penaltyProof?.penalty).toBe('82');
  });
  it('binds the full ordinary Albany review packet, exact copied fields and publication widget controls', () => {
    const f = fixture();
    const result = evaluateNewYork2025WorkingPapers(f.federal, f.ny);
    const fields = result.physicalCoverage!.fields;
    expect(fields).toHaveLength(214);
    expect(fields.find((field) => field.fieldId === 'TP_SSN')).toMatchObject({
      value: '123456789',
      widgetCount: 4,
      maxLength: 9,
    });
    expect(fields.find((field) => field.fieldId === 'SD_code')?.value).toBe(
      '005',
    );
    expect(fields.find((field) => field.fieldId === '18_identify')?.value).toBe(
      'Self-employment tax deduction',
    );
    expect(
      fields
        .filter((field) => field.status === 'user-required')
        .map((field) => field.fieldId),
    ).toEqual(['signed_date']);
    expect(result.attachmentCoverage?.issues).toEqual([]);
    const attachments = result.attachmentCoverage!.forms;
    expect(
      attachments.map((form) => [
        form.formId,
        form.required,
        form.fields.length,
      ]),
    ).toEqual([
      ['IT-215', false, 67],
      ['IT-2105.9', true, 76],
      ['IT-270', false, 18],
    ]);
    expect(
      attachments
        .flatMap((form) => form.fields)
        .filter((field) => field.status === 'unresolved'),
    ).toEqual([]);
    const penalty = attachments[1]!.fields;
    // Published NYS tax1440; 90%=1296; no payments;1296*.06313=81.815 rounded82.
    expect(penalty.find((field) => field.fieldId === '13d')?.value).toBe(
      '1296',
    );
    expect(penalty.find((field) => field.fieldId === '24d')?.value).toBe('82');
    expect(() => {
      Object.assign(fields[0]!, { value: 'corrupt' });
    }).toThrow();
    expect(evaluateNewYork2025WorkingPapers(f.federal, f.ny).outputHash).toBe(
      result.outputHash,
    );
  });
  it('blocks missing school provenance, invalid local controls and form overflow without truncating facts', () => {
    for (const overrides of [
      { 'identity.schoolDistrictCode': '010' },
      { 'identity.firstName': 'A'.repeat(21) },
      { 'identity.middleInitial': 'QQ' },
      { 'identity.nycDays': '366' },
      { 'identity.foreignAccount': true },
      { 'refund.method': 'personal checking', 'refund.routing': 'none' },
    ] as Record<string, string | boolean>[]) {
      const f = fixture(overrides);
      expect(evaluateNewYork2025WorkingPapers(f.federal, f.ny).status).toBe(
        'blocked-input',
      );
    }
    const missing = fixture();
    missing.ny.facts = missing.ny.facts.filter(
      (fact) => fact.key !== 'identity.county',
    );
    expect(
      evaluateNewYork2025WorkingPapers(missing.federal, missing.ny).status,
    ).toBe('blocked-input');
  });

  it('assembles the independent NYC childless-EIC return with all applicable credit fields bound', () => {
    const f = fixture(
      { localResidence: 'NYC' },
      { 'business.receipts': '10000' },
    );
    const result = evaluateNewYork2025WorkingPapers(f.federal, f.ny);
    // SE1413, deduction707, AGI9293; federal childless EIC649 (published plateau).
    // NY table1250–1300 TI1293 =>51, household45; state EIC round(649*.30)-45=150.
    // NYC table1250–1300:39-household15=24; school63+round(1293*.00171)=65;
    // NYC EIC round(649*.25)=162; payments377 less tax30 => refund347.
    expect(
      Object.fromEntries(result.trace.map((row) => [row.key, row.value])),
    ).toMatchObject({
      '19': '9293',
      '38': '1293',
      '39': '51',
      '40': '45',
      '46': '6',
      '47a': '39',
      '48': '15',
      '54': '24',
      '61': '30',
      '65': '150',
      '69': '63',
      '69a': '2',
      '70': '162',
      '76': '377',
      '78': '347',
      '80': '0',
      '81': '0',
    });
    expect(result.physicalCoverage!.issues).toEqual([]);
    expect(
      result.physicalCoverage!.fields.find((field) => field.fieldId === 'E1')
        ?.status,
    ).toBe('inapplicable');
    expect(
      result.physicalCoverage!.fields.find(
        (field) => field.fieldId === 'F1_NYC',
      )?.value,
    ).toBe('12');
    expect(
      result.physicalCoverage!.fields.find(
        (field) => field.fieldId === 'Line78_refund',
      )?.value,
    ).toBe('check');
    const eic = result.attachmentCoverage!.forms.find(
      (form) => form.formId === 'IT-215',
    )!;
    expect(eic.required).toBe(true);
    expect(eic.fields.filter((field) => field.status === 'unresolved')).toEqual(
      [],
    );
    expect(eic.fields.find((field) => field.fieldId === '8 ein15')?.value).toBe(
      '123456789',
    );
    expect(
      eic.fields.find((field) => field.fieldId === '16 dollars15')?.value,
    ).toBe('150');
    expect(
      eic.fields.find((field) => field.fieldId === '27 dollars15')?.value,
    ).toBe('162');
    expect(result.complete).toBe(false);
  });
  it('runs the ordinary regular-method penalty and blocks the specific unresolved June16 edge', () => {
    const f = fixture({ 'penalty.method': 'regular-method' });
    const result = evaluateNewYork2025WorkingPapers(f.federal, f.ny);
    //Annual1296; quarter324; period penalties5+16+31+30=82.
    expect(result.penaltyProof?.method).toBe('regular-method');
    expect(result.attachmentCoverage?.issues).toEqual([]);
    const physical = result.attachmentCoverage!.forms.find(
      (form) => form.formId === 'IT-2105.9',
    )!.fields;
    expect(physical.filter((field) => field.status === 'unresolved')).toEqual(
      [],
    );
    expect(physical.find((field) => field.fieldId === '31')?.value).toBe(
      '.01587',
    );
    expect(physical.find((field) => field.fieldId === '39dd')?.value).toBe(
      '82',
    );
    expect(result.penaltyProof?.penalty).toBe('82');
    expect(
      result.evaluation.forms
        .find((form) => form.id === 'IT-201')!
        .fields.find((field) => field.key === '81')!.sourceFactKeys,
    ).toEqual(
      expect.arrayContaining([
        'federalInputHash',
        'penalty.method',
        'penalty.returnFiledOn',
      ]),
    );
    expect(result.trace.find((row) => row.key === '81')?.locator).toBe(
      'IT-2105.9 line39',
    );
    expect(result.federalScheduleCAttachment?.contentHash).toBe(
      usReviewContentHash(result.federalScheduleCAttachment!.content),
    );
    const edge = fixture({
      'penalty.method': 'regular-method',
      estimatedPayments: '100',
      'penalty.paymentLedger': JSON.stringify([
        { date: '2025-06-16', amount: '100' },
      ]),
    });
    const blocked = evaluateNewYork2025WorkingPapers(edge.federal, edge.ny);
    expect(blocked.unresolved).toContain(
      'ny-june16-prior-underpayment-boundary-unresolved',
    );
    expect(blocked.trace.some((row) => row.key === '80')).toBe(false);
  });
  it('binds required separate payment computations when one factor cannot represent the penalty line', () => {
    const f = fixture({
      'penalty.method': 'regular-method',
      estimatedPayments: '50',
      'penalty.paymentLedger': JSON.stringify([
        { date: '2025-04-26', amount: '50' },
      ]),
    });
    const result = evaluateNewYork2025WorkingPapers(f.federal, f.ny);
    //First period50*.00285+274*.01587=4.49088→4; later entered lines14+29+29; total76.
    expect(result.penaltyProof?.penalty).toBe('76');
    expect(result.trace.find((row) => row.key === '80')?.value).toBe('1466');
    const statements = result.attachmentCoverage!.regularPeriodStatements;
    expect(statements).toHaveLength(1);
    expect(statements[0]!.required).toBe(true);
    expect(statements[0]!.contentHash).toBe(
      usReviewContentHash(statements[0]!.content),
    );
    const factor = result
      .attachmentCoverage!.forms.find((form) => form.formId === 'IT-2105.9')!
      .fields.find((field) => field.fieldId === '31')!;
    expect(factor.status).toBe('inapplicable');
    expect(factor.reason).toContain('separate computation');
  });
  it('matches independently calculated single recapture worksheet7 and full recapture stop', () => {
    // AGI120000 TI112000: regular6152; flat6720; benefit568;
    // ratio12350/50000=.2470; incremental140; tax6292.
    expect(newYorkSingleRecapture2025(112000n, 120000n)).toMatchObject({
      worksheet: 7,
      tax: 6292n,
      fields: {
        '3': '6720',
        '4': '6152',
        '5': '568',
        '7': '0.2470',
        '8': '140',
        '9': '6292',
      },
    });
    expect(newYorkSingleTax2025(149650n, 157650n)).toBe(8979n);
    expect(newYorkSingleRecapture2025(250000n, 258000n)).toMatchObject({
      worksheet: 8,
    });
  });
  it('preserves mandatory table/rate and high-AGI boundaries', () => {
    expect(newYorkSingleTax2025(12n, 10000n)).toBe(0n);
    expect(newYorkSingleTax2025(13n, 10000n)).toBe(1n);
    expect(newYorkSingleTax2025(65000n, 73000n)).toBe(3411n);
    expect(newYorkSingleTax2025(65000n, 107651n)).toBe(3411n);
    expect(newYorkSingleTax2025(65000n, 73000n, true)).toBe(2394n);
  });
  it('matches both published MCTMT examples and strict per-zone threshold', () => {
    expect(calculateNyMctmt2025('40000', '70000')).toEqual({
      zone1Tax: '0',
      zone2Tax: '238',
      total: '238',
    });
    expect(calculateNyMctmt2025('53000', '57000')).toEqual({
      zone1Tax: '318',
      zone2Tax: '194',
      total: '512',
    });
    expect(calculateNyMctmt2025('50000', '50000')).toEqual({
      zone1Tax: '0',
      zone2Tax: '0',
      total: '0',
    });
    expect(calculateNyMctmt2025('50000.01', '0').zone1Tax).toBe('300');
  });
  it('requires explicit local facts, matching federal hash and supported allocation', () => {
    const f = fixture();
    f.ny.facts = f.ny.facts.filter((fact) => fact.key !== 'localResidence');
    expect(evaluateNewYork2025WorkingPapers(f.federal, f.ny).status).toBe(
      'blocked-input',
    );
    for (const overrides of [
      { federalInputHash: 'a'.repeat(64) },
      { businessLocation: 'mixed' },
      { localResidence: 'part-year' },
      { nycBusinessActivity: true },
    ] as Record<string, string | boolean>[]) {
      const x = fixture(overrides);
      expect(evaluateNewYork2025WorkingPapers(x.federal, x.ny).status).toBe(
        'blocked-input',
      );
    }
  });
  it('calculates Yonkers surcharge and NYC taxes while stopping before missing NYC credit settlement', () => {
    const y = fixture({ localResidence: 'Yonkers' });
    const yr = evaluateNewYork2025WorkingPapers(y.federal, y.ny);
    expect(yr.trace.find((row) => row.key === '55')?.value).toBe('241');
    const c = fixture({ localResidence: 'NYC' });
    const cr = evaluateNewYork2025WorkingPapers(c.federal, c.ny);
    expect(cr.trace.find((row) => row.key === '69')?.value).toBe('63');
    expect(cr.trace.find((row) => row.key === '69a')?.value).toBe('60');
    expect(cr.applicability[0]).toMatchObject({ required: false, credit: '0' });
    expect(cr.trace.some((row) => row.key === '76')).toBe(true);
  });
});

import {
  PERSONAL_T1_EXCLUDED_BRANCHES,
  personalT1ExcludedBranch,
} from './personal-t1-applicability.js';
import { PERSONAL_COMPLETE_FIELD_CATALOG } from './personal-field-catalog.js';
import {
  auditCanadaOntario2025PersonalFormApplicability,
  PERSONAL_REQUIRED_FORM_FACTS,
  PERSONAL_REQUIRED_BUSINESS_FORM_FACTS,
} from './personal-form-applicability.js';
import {
  PERSONAL_PAPER_FIELD_PROOFS,
  PERSONAL_PAPER_PRECISION_SOURCES,
} from './personal-precision-evidence.js';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { FinanceTaxIntake } from '@emdo/contracts';
import { FINANCE_TAX_PACKAGE_REGISTRY } from '../../index.js';
import {
  CANADA_ON_2025_PERSONAL_QUESTIONS,
  CANADA_ON_2025_PERSONAL_PACKAGE_VERSION,
  assessCanadaOntario2025PersonalFacts,
  runCanadaOntario2025PersonalWorkflow,
  exportCanadaOntario2025PersonalSchedules,
  exportReviewedCanadaOntario2025PersonalSchedules,
  reviewCanadaOntario2025PersonalExport,
} from './personal-package.js';
import { calculateCanadaOntario2025Components } from './components.js';
import { calculateCanadaOntario2025Credits } from './credits.js';
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
function amount(i: FinanceTaxIntake, key: string, value: string) {
  i.facts.find((f) => f.key === key)!.value = { type: 'decimal', value };
}
const value = (
  run: ReturnType<typeof runCanadaOntario2025PersonalWorkflow>,
  id: string,
) => run.fields.find((f) => f.id === id)?.exactDecimal;
const canonicalForHash = (v: unknown): string =>
  v === null || typeof v !== 'object'
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? `[${v.map(canonicalForHash).join(',')}]`
      : `{${Object.entries(v)
          .filter(([, value]) => value !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => `${JSON.stringify(k)}:${canonicalForHash(v)}`)
          .join(',')}}`;
describe('whole-form required-field inventory and private identity binding', () => {
  function envelope(
    run: ReturnType<typeof runCanadaOntario2025PersonalWorkflow>,
  ) {
    return {
      caseId: run.inputSnapshot!.caseId,
      taxSubjectId: run.inputSnapshot!.taxSubjectId,
      revision: run.inputSnapshot!.revision,
      runHash: run.runHash,
      facts: PERSONAL_REQUIRED_FORM_FACTS.map((r) => ({
        key: r.key,
        value:
          r.type === 'boolean'
            ? { type: 'boolean' as const, value: false }
            : {
                type: 'text' as const,
                value:
                  r.key === 'identity.taxNumber'
                    ? '000000000'
                    : r.key === 'identity.language'
                      ? 'en'
                      : 'Synthetic fixture',
              },
        reviewState: 'reviewed' as const,
        source: {
          kind: 'declaration' as const,
          reference: `fixture:${r.key}`,
          revision: 1,
          contentHash: 'b'.repeat(64),
        },
      })),
    };
  }
  it('binds every explicit excluded printed line to captured CRA fields and reviewed scope', () => {
    for (const branch of PERSONAL_T1_EXCLUDED_BRANCHES) {
      for (const line of branch.lines) {
        const fields = PERSONAL_COMPLETE_FIELD_CATALOG.filter(
          (f) =>
            f.sourceId === 'cra-5006-r-2025-fillable' &&
            f.label.startsWith(`Line ${line}.`),
        );
        expect(fields.length, line).toBeGreaterThan(0);
        for (const field of fields) {
          expect(
            personalT1ExcludedBranch(
              field.sourceId,
              field.label,
              (key) => key === branch.guard,
            ),
          ).toEqual(branch);
          expect(
            personalT1ExcludedBranch(field.sourceId, field.label, () => false),
          ).toBeNull();
          expect(
            personalT1ExcludedBranch('another-form', field.label, () => true),
          ).toBeNull();
        }
      }
    }
    expect(
      personalT1ExcludedBranch(
        'cra-5006-r-2025-fillable',
        'Line 23500. Social benefits repayment.',
        () => true,
      ),
    ).toBeNull();
  });
  it.each(['individual', 'sole-proprietor'] as const)(
    'measures explicit exclusions separately from computed fields for %s',
    (type) => {
      const run = runCanadaOntario2025PersonalWorkflow(input(type));
      const bound = envelope(run);
      const businessFacts =
        type === 'sole-proprietor'
          ? PERSONAL_REQUIRED_BUSINESS_FORM_FACTS.filter(
              (f) =>
                f.key !== 'businessIdentity.programAccountNumber' &&
                !/^businessIdentity\.internetSite[1-5]$/.test(f.key),
            ).map((f) => ({
              key: f.key,
              value: {
                type: f.type,
                value:
                  f.type === 'boolean'
                    ? false
                    : f.type === 'date'
                      ? f.key.endsWith('Start')
                        ? '2025-01-01'
                        : '2025-12-31'
                      : f.type === 'decimal'
                        ? '0'
                        : f.key.endsWith('industryCode')
                          ? '541990'
                          : 'Synthetic business fixture',
              },
              reviewState: 'reviewed' as const,
              source: {
                kind: 'declaration' as const,
                reference: `fixture:${f.key}`,
                revision: 1,
                contentHash: 'b'.repeat(64),
              },
            }))
          : [];
      const audit = auditCanadaOntario2025PersonalFormApplicability(run, {
        ...bound,
        facts: [...bound.facts, ...businessFacts],
      });
      expect(audit.requirements.every((r) => r.satisfied)).toBe(true);
      const excluded = audit.fields.filter(
        (f) => f.decision === 'not-applicable' && f.reason.startsWith('scope.'),
      );
      expect(audit.unresolvedCount).toBe(type === 'individual' ? 208 : 559);
      // Supported line21200 dues, line25200 carryforward and Step 6
      // payable/refund transfers are calculated fields; remaining scope
      // exclusions are independently bound.
      expect(audit.unresolvedCount + excluded.length).toBe(
        type === 'individual' ? 301 : 652,
      );
      expect(excluded.length).toBe(93);
      expect(excluded.every((f) => f.fieldId === null)).toBe(true);
      expect(audit.formDataReady).toBe(false);
      const blocked = input(type);
      blocked.facts.find((f) => f.key === 'scope.noOtherIncome')!.reviewState =
        'unreviewed';
      const blockedRun = runCanadaOntario2025PersonalWorkflow(blocked);
      const blockedAudit =
        auditCanadaOntario2025PersonalFormApplicability(blockedRun);
      expect(
        blockedAudit.fields.filter((f) => f.reason.startsWith('scope.')),
      ).toEqual([]);
    },
  );
  it('accounts for every field instance and exposes missing identity and unresolved whole-return proof', () => {
    const run = runCanadaOntario2025PersonalWorkflow(input());
    const audit = auditCanadaOntario2025PersonalFormApplicability(run);
    expect(audit.fieldCount).toBe(1271);
    expect(
      new Set(
        audit.fields.map((f) => `${f.sourceId}:${f.fieldPath}:${f.occurrence}`),
      ).size,
    ).toBe(1271);
    expect(audit.issues).toContain(
      'missing-or-unreviewed-form-fact:identity.taxNumber',
    );
    expect(audit.fields.some((f) => f.decision === 'unresolved-field')).toBe(
      true,
    );
    expect(audit.signature).toEqual({
      status: 'manual-unperformed',
      blocksCalculation: false,
    });
    expect(audit.complete).toBe(false);
  });
  it('binds reviewed private identity to the exact taxpayer, revision and run without granting access', () => {
    const run = runCanadaOntario2025PersonalWorkflow(input());
    const e = envelope(run);
    const good = auditCanadaOntario2025PersonalFormApplicability(run, e);
    expect(good.requirements.every((r) => r.satisfied)).toBe(true);
    expect(good.formDataReady).toBe(false); // all remaining field/precision proof is still required
    for (const patch of [
      { taxSubjectId: id(99) },
      { revision: 2 },
      { runHash: 'f'.repeat(64) },
    ]) {
      const audit = auditCanadaOntario2025PersonalFormApplicability(run, {
        ...e,
        ...patch,
      });
      expect(audit.issues).toContain(
        'form-input-case-revision-run-binding-mismatch',
      );
      expect(audit.requirements.some((r) => !r.satisfied)).toBe(true);
    }
    e.facts[0]!.reviewState = 'unreviewed' as 'reviewed';
    expect(
      auditCanadaOntario2025PersonalFormApplicability(run, e).issues,
    ).toContain('missing-or-unreviewed-form-fact:identity.firstName');
  });
  it('uses explicit citizenship and contact choices instead of inventing authorizations', () => {
    const run = runCanadaOntario2025PersonalWorkflow(input());
    const e = envelope(run);
    const citizen = e.facts.find((f) => f.key === 'identity.canadianCitizen')!;
    citizen.value = { type: 'boolean', value: true };
    e.facts = e.facts.filter(
      (f) => f.key !== 'identity.electionsCanadaAuthorization',
    );
    expect(
      auditCanadaOntario2025PersonalFormApplicability(run, e).issues,
    ).toContain(
      'missing-or-unreviewed-form-fact:identity.electionsCanadaAuthorization',
    );
  });
  it('carries independent service-business amounts through T2125 and every T1 business transfer, keeping equity out of profit', () => {
    const i = input('sole-proprietor');
    for (const [key, val] of Object.entries({
      grossSales: '11300',
      salesAdjustments: '1300',
      '8810': '1000',
      '9931': '500.12',
      '9932': '1234.56',
      '9933': '78.90',
    }))
      amount(i, `business.${key}`, val);
    const run = runCanadaOntario2025PersonalWorkflow(i);
    for (const [line, expected] of Object.entries({
      '3A': '11300.00',
      '3B': '1300.00',
      '3C': '10000.00',
      '3G': '10000.00',
      '8000': '10000.00',
      '8299': '10000.00',
      '8519': '10000.00',
      '4A': '10000.00',
      '8810': '1000.00',
      '9368': '1000.00',
      '9368.copy2': '1000.00',
      '9369': '9000.00',
      '5A': '9000.00',
      '5C': '9000.00',
      '5C.copy2': '9000.00',
      '5D': '9000.00',
      '9946': '9000.00',
      '9931': '500.12',
      '9932': '1234.56',
      '9933': '78.90',
    })) {
      const field = run.fields.find((f) => f.id === `T2125.${line}`)!;
      expect(field.reportableAmount, line).toBe(expected);
      expect(field.reporting.sourceId).toBe('cra-t2125-2025-fillable');
    }
    for (const [line, expected] of Object.entries({
      '13499': '10000',
      '13500': '9000',
      '15000': '9000',
      '22200': '382.25',
      '23600': '8617.75',
      '26000': '8617.75',
      '42100': '654.5',
      '42120': '0',
      '42200': '0',
      '42800': '0',
      '45300': '1620',
      '167': '-965.5',
    }))
      expect(value(run, `T1.${line}`), line).toBe(expected);
    const csv = exportCanadaOntario2025PersonalSchedules(run);
    expect(csv.content).toContain('"T2125","9932"');
    expect(csv.content).toContain('1234.56');
    for (const key of ['business.9931', 'business.9932', 'business.9933']) {
      const missing = structuredClone(i);
      missing.facts = missing.facts.filter((f) => f.key !== key);
      expect(runCanadaOntario2025PersonalWorkflow(missing).status).toBe(
        'blocked',
      );
      const unreviewed = structuredClone(i);
      unreviewed.facts.find((f) => f.key === key)!.reviewState = 'unreviewed';
      expect(runCanadaOntario2025PersonalWorkflow(unreviewed).status).toBe(
        'blocked',
      );
    }
    const otherIncome = structuredClone(i);
    otherIncome.facts.find((f) => f.key === 'business.noOtherIncome')!.value = {
      type: 'boolean',
      value: false,
    };
    expect(runCanadaOntario2025PersonalWorkflow(otherIncome).status).toBe(
      'blocked',
    );
    expect(run.complete).toBe(false);
  });
  it('audits the full known service-business return projection against independent expected amounts without relabelling it complete', () => {
    const i = input('sole-proprietor');
    amount(i, 'business.grossSales', '10000');
    amount(i, 'business.8810', '1000');
    const run = runCanadaOntario2025PersonalWorkflow(i);
    // Independent printed-form substitution: profit9000, CPP654.50, deduction382.25;
    // net8617.75; income tax zero; CWB1620; exact reconciliation -965.50.
    for (const [line, expected] of Object.entries({
      '13499': '10000',
      '13500': '9000',
      '15000': '9000',
      '22200': '382.25',
      '22215': '0',
      '23300': '382.25',
      '23600': '8617.75',
      '26000': '8617.75',
      '30800': '0',
      '31000': '272.25',
      '42000': '0',
      '42100': '654.5',
      '42800': '0',
      '43500': '654.5',
      '44800': '0',
      '45000': '0',
      '45300': '1620',
      '48200': '1620',
      '167': '-965.5',
    }))
      expect(value(run, `T1.${line}`), line).toBe(expected);
    const audit = auditCanadaOntario2025PersonalFormApplicability(
      run,
      envelope(run),
    );
    expect(
      audit.fields.some(
        (f) =>
          f.sourceId === 'cra-t2125-2025-fillable' &&
          f.decision === 'unresolved-field',
      ),
    ).toBe(true);
    expect(audit.remainingProof).toContain(
      'independent-complete-return-expected-fixtures',
    );
    expect(
      audit.fields.some(
        (f) => f.fieldId === 'T1.42100' && f.decision === 'mapped-amount',
      ),
    ).toBe(true);
  });
});
describe('Schedule 8 mixed employment and business paper graph', () => {
  function mixed(wages: string, business: string, contributions = '0') {
    const i = input('sole-proprietor');
    for (const [key, val] of Object.entries({
      't4.box14': wages,
      't4.box26': wages,
      't4.box24': wages,
      't4.box16': contributions,
      'business.grossSales': business,
    }))
      amount(i, key, val);
    return runCanadaOntario2025PersonalWorkflow(i);
  }
  it.each([
    ['3000', '10000', '9500', '0', '1130.50', '470.25', '660.25'],
    ['3500', '10000', '10000', '0', '1190.00', '495.00', '695.00'],
    ['3500', '67800', '67800', '0', '8068.20', '3356.10', '4712.10'],
    ['3500', '77700', '67800', '9900', '8860.20', '3356.10', '5504.10'],
  ])(
    'official rates and unused exemption for wages %s, business %s',
    (wages, business, base, second, payable, credit, deduction) => {
      const run = mixed(wages, business);
      expect(run.status).toBe('review-calculation-produced');
      expect(run.cpp && 'branch' in run.cpp && run.cpp.branch).toBe('mixed');
      const f = (id: string) => run.fields.find((f) => f.id === id)!;
      expect(f('Schedule8.part5.line30').exactDecimal).toBe(base);
      expect(f('Schedule8.part5.line42').exactDecimal).toBe(second);
      expect(f('T1.42100').reportableAmount).toBe(payable);
      expect(f('T1.31000').reportableAmount).toBe(credit);
      expect(f('T1.22200').reportableAmount).toBe(deduction);
      expect(f('T1.44800').reportableAmount).toBe('0.00');
      expect(
        run.fields
          .filter((f) => f.id.startsWith('Schedule8.part5.'))
          .every((f) => f.reporting.fieldPath !== null),
      ).toBe(true);
      expect(run.complete).toBe(false);
    },
  );
  it('keeps second-additional cents threshold and both source branches explicit', () => {
    const run = mixed('3500', '67800.01');
    const f = (id: string) => run.fields.find((f) => f.id === id)!;
    expect(f('Schedule8.part5.line42').reportableAmount).toBe('0.01');
    expect(f('Schedule8.part5.line45').exactDecimal).toBe('0.0008');
    expect(f('Schedule8.part5.line45').reporting.status).toBe(
      'rounding-unproven',
    );
    expect(f('T1.42100').reportableAmount).toBeNull();
    expect(f('T1.22200').reportableAmount).toBeNull();
    expect(f('T1.31000').reportableAmount).toBe('3356.10');
  });
  it('propagates employment allocation and reverse-factor uncertainty through mixed deductions', () => {
    const run = mixed('30000', '9000', '1576.75');
    const f = (id: string) => run.fields.find((f) => f.id === id)!;
    expect(f('Schedule8.part5.line20').exactDecimal).toBe('26499.99576');
    expect(f('Schedule8.part5.line30').exactDecimal).toBe('9000');
    expect(f('T1.42100').exactDecimal).toBe('1071');
    expect(f('T1.22200').exactDecimal).toBe('625.5');
    expect(f('T1.42100').reportableAmount).toBeNull();
    expect(f('Schedule8.part5.line20').reporting.blockedDependencies).toContain(
      'Schedule8.part5.line10',
    );
  });
  it('follows the printed return-to-Part3 branch when no mixed contribution base remains', () => {
    const run = mixed('1000', '2000');
    const f = (id: string) => run.fields.find((f) => f.id === id)!;
    expect(f('Schedule8.part5.line30').exactDecimal).toBe('0');
    expect(f('Schedule8.part5.line42').exactDecimal).toBe('0');
    expect(run.fields.some((f) => f.id === 'Schedule8.part5.line43')).toBe(
      false,
    );
    for (const line of ['22200', '22215', '30800', '31000', '42100', '44800'])
      expect(f(`T1.${line}`).reportableAmount).toBe('0.00');
  });
  it('offsets mixed contributions against employment overpayment without hiding subcent allocation', () => {
    const run = mixed('30000', '9000', '10000');
    const f = (id: string) => run.fields.find((f) => f.id === id)!;
    // Employment overpayment8423.25 less half of1071 self CPP =7887.75 refund.
    expect(f('Schedule8.part5.line49').exactDecimal).toBe('-15775.5');
    expect(f('T1.42100').exactDecimal).toBe('0');
    expect(f('T1.44800').exactDecimal).toBe('7887.75');
    expect(f('Schedule8.part5.line75').exactDecimal).toBe('445.5001215');
    expect(f('T1.22200').exactDecimal).toBe('90');
    expect(f('T1.44800').reportableAmount).toBeNull();
    expect(f('T1.22200').reportableAmount).toBeNull();
  });
  it('maps page11 by printed labels, not the XFA subform off-by-one names', () => {
    const run = mixed('3500', '77700');
    const f = run.fields.find((f) => f.id === 'Schedule8.part5.line88')!;
    expect(f.reporting.fieldPath).toBe('form1.Page11.Part5-Cont.Line89.Amount');
    expect(f.dependencies).toEqual(
      [80, 81, 83, 84, 87].map((n) => `Schedule8.part5.line${n}`),
    );
  });
});
describe('Schedule 8 source-bound paper transfers', () => {
  it('reports six legitimate zero transfers without a nonapplicable employment worksheet', () => {
    const run = runCanadaOntario2025PersonalWorkflow(input());
    for (const line of ['22200', '22215', '30800', '31000', '42100', '44800']) {
      const f = run.fields.find((f) => f.id === `T1.${line}`)!;
      expect(f.reportableAmount, line).toBe('0.00');
      expect(f.reporting.sourceId).toBe('cra-5006-r-2025-fillable');
    }
    expect(run.fields.some((f) => f.id.startsWith('Schedule8.part3.'))).toBe(
      false,
    );
    expect(run.complete).toBe(false);
  });
  it.each([
    ['9000', '654.50', '272.25', '382.25'],
    ['81200', '8860.20', '3356.10', '5504.10'],
    ['81200.01', '8860.20', '3356.10', '5504.10'],
  ])(
    'substitutes official Part4 rates and caps for business income %s',
    (income, payable, credit, deduction) => {
      const i = input('sole-proprietor');
      amount(i, 'business.grossSales', income);
      const run = runCanadaOntario2025PersonalWorkflow(i);
      const paper = (id: string) =>
        run.fields.find((f) => f.id === id)!.reportableAmount;
      expect(paper('T1.42100')).toBe(payable);
      expect(paper('T1.31000')).toBe(credit);
      expect(paper('T1.22200')).toBe(deduction);
      expect(paper('ON428.58280')).toBe(credit);
      expect(paper('T1.23300')).toBe(deduction);
      if (income === '9000') {
        expect(paper('ON428.58800')).toBe('13019.25');
        expect(paper('T1.23600')).toBe('8617.75');
        expect(paper('T1.26000')).toBe('8617.75');
        expect(paper('T1.45300')).toBe('1620.00');
      }
    },
  );
  it('preserves fractional Part4 arithmetic and blocks its descendants, not unrelated zero transfers', () => {
    const i = input('sole-proprietor');
    amount(i, 'business.grossSales', '9000.05');
    const run = runCanadaOntario2025PersonalWorkflow(i);
    const f = (id: string) => run.fields.find((f) => f.id === id)!;
    expect(f('Schedule8.part4.line9').reportableAmount).toBe('5500.05');
    expect(f('Schedule8.part4.line10').exactDecimal).toBe('544.50495');
    expect(f('Schedule8.part4.line10').reporting.status).toBe(
      'rounding-unproven',
    );
    expect(f('T1.42100').reporting.status).toBe('dependency-unresolved');
    expect(f('T1.22200').reportableAmount).toBeNull();
    expect(f('T1.22215').reportableAmount).toBe('0.00');
    expect(f('T1.30800').reportableAmount).toBe('0.00');
  });
  it('keeps the printed employment allocation factor unrounded while resolving no-business zeros', () => {
    const i = input();
    for (const [key, amountValue] of Object.entries({
      't4.box14': '30000',
      't4.box26': '30000',
      't4.box16': '1576.75',
      't4.box24': '30000',
      't4.box18': '492',
    }))
      amount(i, key, amountValue);
    const run = runCanadaOntario2025PersonalWorkflow(i);
    const f = (id: string) => run.fields.find((f) => f.id === id)!;
    expect(f('Schedule8.part3.line9').exactDecimal).toBe('1311.75035775');
    expect(f('Schedule8.part3.line9').reporting.status).toBe(
      'rounding-unproven',
    );
    expect(f('T1.30800').reportableAmount).toBeNull();
    for (const line of ['22200', '31000', '42100'])
      expect(f(`T1.${line}`).reportableAmount).toBe('0.00');
  });
  it('supports cent-exact employment overpayment without borrowing an annual rounding rule', () => {
    const i = input();
    for (const [key, amountValue] of Object.entries({
      't4.box14': '30000',
      't4.box26': '30000',
      't4.box16': '10000',
      't4.box24': '30000',
      't4.box18': '492',
    }))
      amount(i, key, amountValue);
    const run = runCanadaOntario2025PersonalWorkflow(i);
    const paper = (id: string) =>
      run.fields.find((f) => f.id === id)!.reportableAmount;
    // 10000 * 83.1933% = 8319.33; required CPP = (30000-3500)*5.95%=1576.75.
    expect(paper('T1.30800')).toBe('1311.75');
    expect(paper('T1.22215')).toBe('265.00');
    expect(paper('T1.44800')).toBe('8423.25');
    expect(paper('ON428.58240')).toBe('1311.75');
  });
});
describe('Canada Ontario2025 connected personal return review workflow', () => {
  it('binds paper-field precision rules to captured CRA PDF bytes and extracted field locators', () => {
    const catalog = JSON.parse(
      readFileSync(
        new URL(
          './sources/personal-precision-field-catalog.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as Array<{
      sourceId: string;
      path: string;
      inputPattern: string;
      changeScripts: string[];
    }>;
    for (const source of PERSONAL_PAPER_PRECISION_SOURCES) {
      expect(
        createHash('sha256')
          .update(
            readFileSync(
              new URL(`./sources/${source.localFile}`, import.meta.url),
            ),
          )
          .digest('hex'),
      ).toBe(source.documentHash);
    }
    for (const proof of Object.values(PERSONAL_PAPER_FIELD_PROOFS)) {
      const captured = catalog.find(
        (f) => f.sourceId === proof.sourceId && f.path === proof.path,
      )!;
      expect(captured).toBeDefined();
      expect(captured.inputPattern).toBe(proof.inputPattern);
      expect(captured.changeScripts).toEqual(proof.changeScripts);
      expect(proof.displayPattern).toMatch(/9\.99/);
    }
  });
  it('retains exact captured CRA source bytes under their immutable hashes', () => {
    const captures = JSON.parse(
      readFileSync(
        new URL(
          './sources/personal-workflow-capture-manifest.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as Array<{ localFile: string; documentHash: string }>;
    for (const capture of captures) {
      const bytes = readFileSync(
        new URL(`./sources/${capture.localFile}`, import.meta.url),
      );
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(
        capture.documentHash,
      );
    }
  });
  it('runs from reviewed ordinary T4 through CPP, federal/ON credits, LIFT/CWB and refund reconciliation', () => {
    const i = input();
    amount(i, 't4.box14', '30000');
    amount(i, 't4.box26', '30000');
    amount(i, 't4.box16', '1576.75');
    amount(i, 't4.box18', '492');
    amount(i, 't4.box24', '30000');
    amount(i, 't4.box22', '2000');
    const run = runCanadaOntario2025PersonalWorkflow(i);
    expect(run.issues).toEqual([]);
    expect(run.status).toBe('review-calculation-produced');
    // Independent substitution into CRA annual line formulas (not calculator-generated expected values).
    expect(value(run, 'T1.22215')).toBe('265');
    expect(value(run, 'T1.23600')).toBe('29735');
    expect(value(run, 'T1.35000')).toBe('2813.54375');
    expect(value(run, 'T1.42000')).toBe('1498.03125');
    expect(value(run, 'T1.42800')).toBe('300');
    expect(value(run, 'T1.45300')).toBe('1201');
    expect(value(run, 'T1.167')).toBe('-1402.96875');
    expect(run.finalAmounts).toEqual({ refund: null, balanceOwing: null });
    expect(run.fields.find((f) => f.id === 'T1.10100')!.reportableAmount).toBe(
      '30000.00',
    );
    expect(
      run.fields.find((f) => f.id === 'T1.167')!.reportableAmount,
    ).toBeNull();
    expect(run.fields.some((f) => f.form === 'T2125')).toBe(false);
    for (const f of run.fields)
      for (const d of f.dependencies)
        expect(
          d.startsWith('fact:') || run.fields.some((x) => x.id === d),
        ).toBe(true);
  });
  it('carries an elected ordinary donation through Schedule 9, federal tax and refund reconciliation', () => {
    const i = input();
    for (const [key, amountValue] of Object.entries({
      't4.box14': '30000',
      't4.box26': '30000',
      't4.box16': '1576.75',
      't4.box18': '492',
      't4.box24': '30000',
      't4.box22': '2000',
      'donations.currentEligibleGifts': '1000',
      'donations.claimAmount': '1000',
    }))
      amount(i, key, amountValue);
    const run = runCanadaOntario2025PersonalWorkflow(i);
    expect(run.issues).toEqual([]);
    expect(run.charitableDonations?.status).toBe('calculated');
    expect(run.charitableDonations?.claimedFromCurrentYear.exactDecimal).toBe(
      '1000',
    );
    expect(
      run.charitableDonations?.currentYearClosingBalance.exactDecimal,
    ).toBe('0');
    expect(value(run, 'Schedule9.13')).toBe('200');
    expect(value(run, 'Schedule9.14')).toBe('800');
    expect(value(run, 'Schedule9.21')).toBe('232');
    expect(value(run, 'Schedule9.22')).toBe('29');
    expect(value(run, 'Schedule9.23')).toBe('261');
    expect(value(run, 'T1.34900')).toBe('261');
    expect(
      run.fields.find((field) => field.id === 'T1.34900')?.reportableAmount,
    ).toBeNull();
    expect(
      run.fields.find((field) => field.id === 'T1.34900')?.reporting,
    ).toEqual(
      expect.objectContaining({
        status: 'dependency-unresolved',
        blockedDependencies: ['Schedule9.23'],
      }),
    );
    expect(
      run.fields.find((field) => field.id === 'Schedule9.1')?.reportableAmount,
    ).toBe('1000.00');
    expect(value(run, 'FederalTopUp.2')).toBe('29');
    expect(value(run, 'T1.35000')).toBe('3074.54375');
    expect(value(run, 'T1.42000')).toBe('1237.03125');
    expect(value(run, 'T1.167')).toBe('-1663.96875');
    expect(
      run.fields.find((field) => field.id === 'T1.34900')?.dependencies,
    ).toEqual(
      expect.arrayContaining([
        'Schedule9.23',
        'fact:donations.claimAmount',
        'fact:donations.carryforward.2024',
      ]),
    );
    expect(run.complete).toBe(false);
    expect(run.finalAmounts).toEqual({ refund: null, balanceOwing: null });
  });
  it('binds a donation amendment to a new immutable run hash and recalculates the elected credit', () => {
    const original = input();
    for (const [key, amountValue] of Object.entries({
      't4.box14': '30000',
      't4.box26': '30000',
      't4.box16': '1576.75',
      't4.box18': '492',
      't4.box24': '30000',
    }))
      amount(original, key, amountValue);
    amount(original, 'donations.currentEligibleGifts', '1000');
    amount(original, 'donations.claimAmount', '1000');
    const originalRun = runCanadaOntario2025PersonalWorkflow(original);
    const amended = structuredClone(original);
    amended.revision = 2;
    amount(amended, 'donations.claimAmount', '200');
    const amendedRun = runCanadaOntario2025PersonalWorkflow(amended);
    expect(originalRun.issues).toEqual([]);
    expect(amendedRun.issues).toEqual([]);
    expect(value(originalRun, 'Schedule9.23')).toBe('261');
    expect(value(amendedRun, 'Schedule9.23')).toBe('29');
    expect(amendedRun.runHash).not.toBe(originalRun.runHash);
    expect(() =>
      reviewCanadaOntario2025PersonalExport(amendedRun, {
        reviewerId: id(4),
        reviewedAt: '2026-09-15T01:00:00Z',
        runHash: originalRun.runHash,
      }),
    ).toThrow('hash-mismatch');
  });
  it('applies source-bound non-capital losses oldest-first before taxable-income tax lines', () => {
    const i = input();
    amount(i, 't4.box14', '30000');
    amount(i, 't4.box26', '30000');
    amount(i, 't4.box16', '1576.75');
    amount(i, 't4.box18', '492');
    amount(i, 't4.box24', '30000');
    amount(i, 't4.box22', '2000');
    amount(i, 'carryforward.nonCapitalLoss.2022', '10000');
    amount(i, 'carryforward.nonCapitalLoss.2024', '5000');
    const run = runCanadaOntario2025PersonalWorkflow(i);
    const carryforward = run.carryforward!;
    expect(run.issues).toEqual([]);
    expect(carryforward.version).toBe(
      '2025-general-noncapital-loss-carryforward.1',
    );
    expect(carryforward.claimedTotal.exactDecimal).toBe('15000');
    expect(carryforward.closingTotal.exactDecimal).toBe('0');
    expect(carryforward.taxableIncomeAfterCarryforward.exactDecimal).toBe(
      '14735',
    );
    expect(value(run, 'T1.25200')).toBe('15000');
    expect(value(run, 'T1.26000')).toBe('14735');
    expect(value(run, 'T1.40400')).toBe('2136.575');
    expect(
      carryforward.ledger.find((entry) => entry.lossYear === 2022)!
        .sourceBinding!.reference,
    ).toBe('fixture:carryforward.nonCapitalLoss.2022');
    expect(
      run.fields.find((field) => field.id === 'T1.25200')?.reportableAmount,
    ).toBeNull();
    expect(
      run.fields.find((field) => field.id === 'T1.25200')?.reporting.status,
    ).toBe('dependency-unresolved');
  });
  it('rejects carryforward history outside the supported year ledger or loss classes', () => {
    const outside = input();
    outside.facts.push({
      key: 'carryforward.nonCapitalLoss.2005',
      value: { type: 'decimal', value: '1' },
      reviewState: 'reviewed',
      source: {
        kind: 'evidence',
        reference: 'fixture:carryforward.nonCapitalLoss.2005',
        revision: 1,
        contentHash: 'c'.repeat(64),
      },
    });
    expect(assessCanadaOntario2025PersonalFacts(outside).issues).toContainEqual(
      expect.objectContaining({
        code: 'unsupported-fact',
        path: 'carryforward.nonCapitalLoss.2005',
      }),
    );
    const unsupportedPool = input();
    unsupportedPool.facts.find(
      (fact) => fact.key === 'scope.noUnsupportedCarryforwards',
    )!.value = { type: 'boolean', value: false };
    expect(
      assessCanadaOntario2025PersonalFacts(unsupportedPool).issues,
    ).toContainEqual(
      expect.objectContaining({
        code: 'unsupported-feature',
        path: 'scope.noUnsupportedCarryforwards',
      }),
    );
  });
  it('connects T2125 gross/expenses to self-employment CPP, deductions and CWB', () => {
    const i = input('sole-proprietor');
    amount(i, 'business.grossSales', '10000');
    amount(i, 'business.8810', '1000');
    const run = runCanadaOntario2025PersonalWorkflow(i);
    expect(run.issues).toEqual([]);
    expect(value(run, 'T2125.9946')).toBe('9000');
    expect(value(run, 'T1.42100')).toBe('654.5');
    expect(value(run, 'T1.31000')).toBe('272.25');
    expect(value(run, 'T1.22200')).toBe('382.25');
    expect(value(run, 'T1.23600')).toBe('8617.75');
    expect(value(run, 'T1.45300')).toBe('1620');
    expect(value(run, 'T1.167')).toBe('-965.5');
    expect(run.fields.find((f) => f.id === 'T1.42120')?.reportableAmount).toBe(
      '0.00',
    );
    expect(run.fields.find((f) => f.id === 'T1.42200')?.reportableAmount).toBe(
      '0.00',
    );
    expect(run.fields.find((f) => f.id === 'T1.43500')?.dependencies).toEqual([
      'T1.143',
      'T1.42100',
      'T1.42120',
      'T1.42200',
      'T1.42800',
      'fact:scope.noEiSpecialBenefitsAgreement',
      'fact:scope.noOtherIncome',
      'fact:scope.noOtherRefunds',
    ]);
  });
  it('matches established bracket and credit components where cent-precision inputs are exact', () => {
    const i = input();
    amount(i, 'interest', '200000');
    const run = runCanadaOntario2025PersonalWorkflow(i);
    const context = {
      scope: { ...i.scope, taxpayerType: 'individual' },
      fullYearCanadianResident: true,
      ontarioResidentOnDecember31: true,
      hasPermanentEstablishmentOutsideOntario: false,
    };
    const existing = calculateCanadaOntario2025Components({
      ...context,
      taxableIncomeLine26000: '200000',
    });
    expect(value(run, 'T1.40400')).toBe(
      existing.components.federalTaxOnTaxableIncome.exactAmount.replace(
        /\.?0+$/,
        '',
      ),
    );
    const credits = calculateCanadaOntario2025Credits({
      ...context,
      netIncomeLine23600: '200000',
      eligibleFederalAmountsExcludingBasicPersonalAmount: '0',
      federalDonationsAndGiftsLine34900: '0',
      federalSchedule9Line22: '0',
      eligibleOntarioAmountsExcludingBasicPersonalAmount: '0',
      ontarioDonationsAndGiftsLine58969: '0',
      eligibleInputsReviewed: true,
    });
    expect(run.fields.find((f) => f.id === 'T1.30000')!.exactRational).toEqual(
      credits.components.federalBasicPersonalAmount.exactRational,
    );
    expect(value(run, 'T1.30000')).toBeNull();
  });
  it('connects the selected federal Part A worksheet column to line119 with captured field paths', () => {
    const i = input();
    amount(i, 'interest', '200000');
    const run = runCanadaOntario2025PersonalWorkflow(i);
    const field = (id: string) => run.fields.find((f) => f.id === id)!;
    expect(field('FederalTax.Column4.70').exactDecimal).toBe('200000');
    expect(field('FederalTax.Column4.71').exactDecimal).toBe('177882');
    expect(field('FederalTax.Column4.72').exactDecimal).toBe('22118');
    expect(field('FederalTax.Column4.74').exactDecimal).toBe('6414.22');
    expect(field('FederalTax.Column4.75').exactDecimal).toBe('36495.57');
    expect(field('FederalTax.Column4.76').exactDecimal).toBe('42909.79');
    expect(field('FederalTax.Column4.76').reportableAmount).toBe('42909.79');
    expect(value(run, 'T1.119')).toBe('42909.79');
    expect(field('T1.119').dependencies).toEqual(['FederalTax.Column4.76']);
    expect(field('FederalTax.Column4.76').reporting.fieldPath).toBe(
      'form1.Page5.PartA.Column4.Line42Amount4',
    );
    expect(
      run.fields.some((candidate) => candidate.id === 'FederalTax.Column3.76'),
    ).toBe(false);
  });
  it('keeps the connected Part A descendant unresolved when the printed rate product is sub-cent', () => {
    const i = input();
    amount(i, 'interest', '177882.01');
    const run = runCanadaOntario2025PersonalWorkflow(i);
    const product = run.fields.find((f) => f.id === 'FederalTax.Column4.74')!;
    expect(product.exactDecimal).toBe('0.0029');
    expect(product.reporting.status).toBe('rounding-unproven');
    expect(
      run.fields.find((f) => f.id === 'FederalTax.Column4.76')!.reporting
        .status,
    ).toBe('dependency-unresolved');
    expect(run.fields.find((f) => f.id === 'T1.119')!.reporting.status).toBe(
      'dependency-unresolved',
    );
  });
  it.each([
    ['1900', '35', '0', '35'],
    ['2000', '32.80', '0', '32.8'],
    ['2000.01', '32.80', '0.01', '32.79'],
    ['3000', '46', '46', '0'],
    ['3000', '50.20', '49.2', '0'],
    ['3000', '50.21', '49.2', '1.01'],
    ['65700', '1100', '1077.48', '22.52'],
  ])(
    'calculates T2204 earnings %s premiums %s',
    (earnings, premiums, credit, refund) => {
      const i = input();
      amount(i, 't4.box14', earnings);
      amount(i, 't4.box24', earnings);
      amount(i, 't4.box18', premiums);
      const run = runCanadaOntario2025PersonalWorkflow(i);
      expect(run.issues).toEqual([]);
      expect(value(run, 'T1.31200')).toBe(credit);
      expect(value(run, 'T1.45000')).toBe(refund);
      expect(
        run.fields.find((f) => f.id === 'T1.48200')!.dependencies,
      ).toContain('T1.45000');
    },
  );
  it.each([
    ['0.50', '0.5', '0.125', null, 'rounding-unproven'],
    ['1000', '1000', '250', '250.00', 'lossless-cents'],
    ['1000.01', '1000', '250', '250.00', 'lossless-cents'],
  ])(
    'applies the educator cap and exact 25%% credit at %s of reviewed expenses',
    (expenses, capped, credit, reportable, reportingStatus) => {
      const i = input();
      for (const key of [
        'educator.eligibleEducator',
        'educator.expensesPaidIn2025',
        'educator.expensesUnreimbursed',
        'educator.expensesNotClaimedElsewhere',
      ])
        i.facts.find((fact) => fact.key === key)!.value = {
          type: 'boolean',
          value: true,
        };
      amount(i, 'educator.eligibleSuppliesExpenses', expenses);
      const run = runCanadaOntario2025PersonalWorkflow(i);
      const base = run.fields.find((field) => field.id === 'T1.46800')!;
      const creditField = run.fields.find((field) => field.id === 'T1.46900')!;
      expect(run.issues).toEqual([]);
      expect(base.exactDecimal, expenses).toBe(capped);
      expect(creditField.exactDecimal, expenses).toBe(credit);
      expect(run.educatorSchoolSupplyCredit?.version).toBe(
        '2025-educator-school-supply-credit.1',
      );
      expect(run.educatorSchoolSupplyCredit?.sourceHash).toBe(
        'd307c87b2e53d98653d45065ca1b5d7b0ded5b6220e59fe6fef67c6c06717539',
      );
      expect(base.reportableAmount, expenses).toBe(
        capped === '0.5' ? '0.50' : `${capped}.00`,
      );
      expect(creditField.reportableAmount, expenses).toBe(reportable);
      expect(creditField.reporting.status, expenses).toBe(reportingStatus);
      expect(value(run, 'T1.48200'), expenses).toBe(credit);
      expect(value(run, 'T1.48400'), expenses).toBe(credit);
    },
  );

  it('blocks a nonzero educator amount when a required eligibility gate is false', () => {
    const i = input();
    amount(i, 'educator.eligibleSuppliesExpenses', '100');
    i.facts.find((fact) => fact.key === 'educator.eligibleEducator')!.value = {
      type: 'boolean',
      value: false,
    };
    const run = runCanadaOntario2025PersonalWorkflow(i);
    expect(run.status).toBe('blocked');
    expect(run.issues).toContainEqual(
      expect.objectContaining({
        code: 'educator-eligibility-gate-failed',
        path: 'educator.eligibleEducator',
      }),
    );
    expect(run.educatorSchoolSupplyCredit?.status).toBe('blocked');
    expect(run.educatorSchoolSupplyCredit?.credit.exactDecimal).toBe('0');
    expect(run.fields.some((field) => field.id === 'T1.46900')).toBe(false);
  });

  it('carries the educator credit through a supported T2125 sole-proprietor return', () => {
    const i = input('sole-proprietor');
    amount(i, 'business.grossSales', '10000');
    for (const key of [
      'educator.eligibleEducator',
      'educator.expensesPaidIn2025',
      'educator.expensesUnreimbursed',
      'educator.expensesNotClaimedElsewhere',
    ])
      i.facts.find((fact) => fact.key === key)!.value = {
        type: 'boolean',
        value: true,
      };
    amount(i, 'educator.eligibleSuppliesExpenses', '1000');
    const run = runCanadaOntario2025PersonalWorkflow(i);
    expect(run.issues).toEqual([]);
    expect(value(run, 'T2125.9946')).toBe('10000');
    expect(value(run, 'T1.46900')).toBe('250');
    expect(
      run.fields.find((field) => field.id === 'T1.48200')!.dependencies,
    ).toContain('T1.46900');
  });

  it('changes the review hash when an amended educator claim changes', () => {
    const original = input();
    for (const key of [
      'educator.eligibleEducator',
      'educator.expensesPaidIn2025',
      'educator.expensesUnreimbursed',
      'educator.expensesNotClaimedElsewhere',
    ])
      original.facts.find((fact) => fact.key === key)!.value = {
        type: 'boolean',
        value: true,
      };
    amount(original, 'educator.eligibleSuppliesExpenses', '750');
    const originalRun = runCanadaOntario2025PersonalWorkflow(original);
    const amended = structuredClone(original);
    amended.revision = 2;
    amount(amended, 'educator.eligibleSuppliesExpenses', '1000');
    const amendedRun = runCanadaOntario2025PersonalWorkflow(amended);
    expect(amendedRun.runHash).not.toBe(originalRun.runHash);
    expect(() =>
      reviewCanadaOntario2025PersonalExport(amendedRun, {
        reviewerId: id(4),
        reviewedAt: '2026-09-15T01:00:00Z',
        runHash: originalRun.runHash,
      }),
    ).toThrow('hash-mismatch');
  });

  it('requires explicit insurable earnings and rejects blocked CSV exports', () => {
    const i = input();
    i.facts = i.facts.filter((f) => f.key !== 't4.box24');
    const run = runCanadaOntario2025PersonalWorkflow(i);
    expect(
      run.issues.some(
        (f) => f.code === 'missing-fact' && f.path === 't4.box24',
      ),
    ).toBe(true);
    expect(() => exportCanadaOntario2025PersonalSchedules(run)).toThrow(
      'blocking-inputs',
    );
  });
  it('escapes formula-leading dynamic CSV cells after verifying the run hash', () => {
    const original = runCanadaOntario2025PersonalWorkflow(input());
    const { runHash, ...body } = original;
    expect(runHash).toHaveLength(64);
    const modified = {
      ...body,
      fields: body.fields.map((f, n) =>
        n === 0 ? { ...f, label: '=HYPERLINK("https://example.invalid")' } : f,
      ),
    };
    const canonical = (v: unknown): string =>
      v === null || typeof v !== 'object'
        ? JSON.stringify(v)
        : Array.isArray(v)
          ? `[${v.map(canonical).join(',')}]`
          : `{${Object.entries(v)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
              .join(',')}}`;
    const altered = {
      ...modified,
      runHash: createHash('sha256').update(canonical(modified)).digest('hex'),
    };
    expect(exportCanadaOntario2025PersonalSchedules(altered).content).toContain(
      '"\'=HYPERLINK',
    );
  });
  it('reports lossless cents across a mixed fractional business case and keeps CPP dependencies unresolved', () => {
    const i = input('sole-proprietor');
    amount(i, 'business.grossSales', '10000.17');
    amount(i, 'business.8810', '1000.12');
    amount(i, 'instalments', '12.34');
    const run = runCanadaOntario2025PersonalWorkflow(i);
    const at = (id: string) => run.fields.find((f) => f.id === id)!;
    expect(at('T2125.8000').reportableAmount).toBe('10000.17');
    expect(at('T2125.9368').reportableAmount).toBe('1000.12');
    expect(at('T2125.9946').reportableAmount).toBe('9000.05');
    expect(at('T1.13500').reportableAmount).toBe('9000.05');
    expect(at('T1.15000').reportableAmount).toBe('9000.05');
    expect(at('T1.47600').reportableAmount).toBe('12.34');
    expect(at('T1.23600').reportableAmount).toBeNull();
    expect(at('T1.13500').reporting.rounding).toBe('none-lossless');
    expect(at('T1.13500').reporting.fieldPath).toContain('13500');
    expect(run.complete).toBe(false);
    expect(exportCanadaOntario2025PersonalSchedules(run).content).toContain(
      '"9000.05"',
    );
  });
  it('reports the CRA low-earnings EI example but blocks unproven subcent rounding and its descendants', () => {
    const i = input();
    amount(i, 't4.box14', '1900');
    amount(i, 't4.box24', '1900');
    amount(i, 't4.box18', '35');
    const run = runCanadaOntario2025PersonalWorkflow(i);
    expect(run.fields.find((f) => f.id === 'T1.45000')!.reportableAmount).toBe(
      '35.00',
    );
    expect(run.fields.find((f) => f.id === 'T1.31200')!.reportableAmount).toBe(
      '0.00',
    );
    amount(i, 't4.box14', '2000.01');
    amount(i, 't4.box24', '2000.01');
    const fraction = runCanadaOntario2025PersonalWorkflow(i);
    expect(
      fraction.fields.find((f) => f.id === 'T2204.10')!.reporting.status,
    ).toBe('rounding-unproven');
    const transfer = fraction.fields.find((f) => f.id === 'T1.45000')!;
    expect(transfer.reportableAmount).toBeNull();
    expect(transfer.reporting.status).toBe('dependency-unresolved');
    expect(transfer.reporting.blockedDependencies).toEqual(['T2204.15']);
  });
  it('retains a large source amount exactly but blocks its paper field width', () => {
    const i = input();
    amount(i, 'instalments', '1000000000.01');
    const f = runCanadaOntario2025PersonalWorkflow(i).fields.find(
      (f) => f.id === 'T1.47600',
    )!;
    expect(f.exactDecimal).toBe('1000000000.01');
    expect(f.reportableAmount).toBeNull();
    expect(f.reporting.status).toBe('field-width-exceeded');
  });
  it('blocks incomplete, unreviewed, disputed and unknown facts before producing schedules', () => {
    const i = input();
    i.facts.shift();
    expect(runCanadaOntario2025PersonalWorkflow(i).issues[0]?.code).toBe(
      'missing-fact',
    );
    const u = input();
    u.facts[0]!.reviewState = 'unreviewed';
    expect(runCanadaOntario2025PersonalWorkflow(u).fields).toEqual([]);
    const d = input();
    d.facts[0]!.reviewState = 'disputed';
    expect(runCanadaOntario2025PersonalWorkflow(d).fields).toEqual([]);
    const unknown = input();
    unknown.facts.push({ ...unknown.facts[0]!, key: 'unmapped.income' });
    expect(
      runCanadaOntario2025PersonalWorkflow(unknown).issues.some(
        (i) => i.code === 'unsupported-fact',
      ),
    ).toBe(true);
  });
  it.each([
    { subdivision: 'CA-BC' },
    { year: 2024 },
    { taxpayerType: 'corporation' },
    { formVersion: 'latest' },
  ])('rejects unsupported exact coverage %j', (scope) => {
    const i = input();
    i.scope = { ...i.scope, ...scope } as FinanceTaxIntake['scope'];
    expect(
      runCanadaOntario2025PersonalWorkflow(i).issues.some(
        (i) => i.code === 'unsupported-scope',
      ),
    ).toBe(true);
  });
  it('blocks business loss, business income in individual scope and mismatched source-book snapshots', () => {
    const loss = input('sole-proprietor');
    amount(loss, 'business.8910', '1');
    expect(
      runCanadaOntario2025PersonalWorkflow(loss).issues.some(
        (i) => i.code === 'business-loss-not-covered',
      ),
    ).toBe(true);
    const personal = input();
    amount(personal, 'business.grossSales', '1');
    expect(
      runCanadaOntario2025PersonalWorkflow(personal).issues.some(
        (i) => i.code === 'business-requires-sole-proprietor-scope',
      ),
    ).toBe(true);
    const ledger = input();
    ledger.facts[0]!.source = {
      kind: 'ledger-snapshot',
      reference: 'private',
      revision: 1,
      contentHash: 'a'.repeat(64),
      sourceBookId: id(8),
    };
    expect(
      runCanadaOntario2025PersonalWorkflow(ledger).issues.some(
        (i) => i.code === 'invalid-intake',
      ),
    ).toBe(true);
  });
  it('keeps prior runs immutable, pins rule/source revisions and exports only exact review values', () => {
    const i = input('sole-proprietor');
    amount(i, 'business.grossSales', '9000');
    const old = runCanadaOntario2025PersonalWorkflow(i);
    const oldHash = old.runHash;
    i.revision++;
    amount(i, 'business.grossSales', '10000');
    i.facts.find((f) => f.key === 'business.grossSales')!.source.revision++;
    const changed = runCanadaOntario2025PersonalWorkflow(i);
    expect(changed.runHash).not.toBe(oldHash);
    expect(value(old, 'T1.13500')).toBe('9000');
    expect(
      runCanadaOntario2025PersonalWorkflow(i, '2025.2').issues.some(
        (i) => i.code === 'package-version-mismatch',
      ),
    ).toBe(true);
    const exported = exportCanadaOntario2025PersonalSchedules(old);
    expect(exported.content).toContain('NOT A FILEABLE RETURN');
    expect(exported.content).toContain('UNAVAILABLE');
    const review = reviewCanadaOntario2025PersonalExport(old, {
      reviewerId: id(4),
      reviewedAt: '2026-09-14T03:00:00Z',
      runHash: oldHash,
    });
    expect(review.complete).toBe(false);
    expect(review.reportable).toBe(false);
    const reviewedExport =
      exportReviewedCanadaOntario2025PersonalSchedules(review);
    expect(reviewedExport.content).toContain(review.exportHash);
    expect(reviewedExport.content).toContain(old.inputHash);
    expect(reviewedExport.content).toContain(old.sources[0]!.documentHash);
    expect(reviewedExport.content).toContain('Dependencies,Source,Locator');
    const tampered = {
      ...review,
      review: { ...review.review, reviewerId: id(9) },
    };
    expect(() =>
      exportReviewedCanadaOntario2025PersonalSchedules(tampered),
    ).toThrow('hash-mismatch');
    const tamperedRun = {
      ...old,
      fields: old.fields.map((f, index) =>
        index === 0 ? { ...f, exactDecimal: '999' } : f,
      ),
    };
    expect(() => exportCanadaOntario2025PersonalSchedules(tamperedRun)).toThrow(
      'hash-mismatch',
    );
    expect(() =>
      reviewCanadaOntario2025PersonalExport(changed, {
        reviewerId: id(4),
        reviewedAt: '2026-09-14T03:00:00Z',
        runHash: oldHash,
      }),
    ).toThrow('hash-mismatch');
    expect(old.packageVersion).toBe(CANADA_ON_2025_PERSONAL_PACKAGE_VERSION);
    expect(FINANCE_TAX_PACKAGE_REGISTRY.list()).toHaveLength(0);
  });
  it('exports calculated carryforward ledgers with exact amounts, source bindings and run provenance', () => {
    const i = input();
    amount(i, 'interest', '30000');
    amount(i, 'donations.currentEligibleGifts', '1000');
    amount(i, 'donations.claimAmount', '1000');
    for (const year of [2020, 2021, 2022, 2023, 2024])
      amount(i, `donations.carryforward.${year}`, '100');
    amount(i, 'carryforward.nonCapitalLoss.2024', '50');
    const run = runCanadaOntario2025PersonalWorkflow(i);
    expect(run.issues).toEqual([]);
    expect(value(run, 'Schedule9.23')).toBe('261');

    const exported = exportCanadaOntario2025PersonalSchedules(run);
    expect(
      exported.carryforwardSections.map((section) => section.sectionId),
    ).toEqual(['charitable-donations', 'general-noncapital-loss']);
    expect(Object.isFrozen(exported.carryforwardSections)).toBe(true);
    const donations = exported.carryforwardSections.find(
      (section) => section.sectionId === 'charitable-donations',
    )!;
    expect(donations).toEqual(
      expect.objectContaining({
        version: '2025-federal-charitable-donations.1',
        targetLine: 'T1.34900',
        sourceId: 'cra-5000-s9-2025-etext',
        orderingSourceId: 'cra-p113-2025-html',
        provenance: expect.objectContaining({
          packageVersion: run.packageVersion,
          runHash: run.runHash,
          inputHash: run.inputHash,
          caseId: i.caseId,
          taxSubjectId: i.taxSubjectId,
          revision: 1,
          targetYear: 2025,
        }),
      }),
    );
    expect(
      donations.rows.map((row) => [
        row.year,
        row.opening.exactDecimal,
        row.used.exactDecimal,
        row.expired.exactDecimal,
        row.closing.exactDecimal,
      ]),
    ).toEqual([
      [2020, '100', '100', '0', '0'],
      [2021, '100', '100', '0', '0'],
      [2022, '100', '100', '0', '0'],
      [2023, '100', '100', '0', '0'],
      [2024, '100', '100', '0', '0'],
      [2025, '1000', '500', '0', '500'],
    ]);
    expect(donations.rows[0]!.sourceBinding).toEqual(
      expect.objectContaining({
        reference: 'fixture:donations.carryforward.2020',
        revision: 1,
        contentHash: 'a'.repeat(64),
      }),
    );
    expect(donations.rows[5]!.sourceBinding).toEqual(
      expect.objectContaining({
        reference: 'fixture:donations.currentEligibleGifts',
        revision: 1,
        contentHash: 'a'.repeat(64),
      }),
    );

    const losses = exported.carryforwardSections.find(
      (section) => section.sectionId === 'general-noncapital-loss',
    )!;
    const loss2024 = losses.rows.find((row) => row.year === 2024)!;
    expect(losses).toEqual(
      expect.objectContaining({
        version: '2025-general-noncapital-loss-carryforward.1',
        targetLine: 'T1.25200',
        sourceId: 'cra-line-25200-2025-html',
        orderingSourceId: 'cra-itam-chapter-29-loss-order-2025-html',
      }),
    );
    expect([
      loss2024.opening.exactDecimal,
      loss2024.used.exactDecimal,
      loss2024.expired.exactDecimal,
      loss2024.closing.exactDecimal,
    ]).toEqual(['50', '50', '0', '0']);
    expect(loss2024.sourceBinding).toEqual(
      expect.objectContaining({
        reference: 'fixture:carryforward.nonCapitalLoss.2024',
        revision: 1,
        contentHash: 'a'.repeat(64),
      }),
    );
    expect(exported.content).toContain(
      'Carryforward section type,Section ID,Section label,Rule version',
    );
    expect(exported.content).toContain(
      '"Carryforward section","charitable-donations"',
    );
    expect(exported.content).toContain('fixture:donations.carryforward.2020');
    expect(exported.content).toContain(run.runHash);
    expect(exported.content).toContain('"500"');
  });
  it('keeps carryforward export provenance immutable across an amended donation claim and source revision', () => {
    const original = input();
    amount(original, 'interest', '30000');
    amount(original, 'donations.currentEligibleGifts', '1000');
    amount(original, 'donations.claimAmount', '1000');
    for (const year of [2020, 2021, 2022, 2023, 2024])
      amount(original, `donations.carryforward.${year}`, '100');
    const originalRun = runCanadaOntario2025PersonalWorkflow(original);
    const originalExport =
      exportCanadaOntario2025PersonalSchedules(originalRun);

    const amended = structuredClone(original);
    amended.revision = 2;
    amount(amended, 'donations.claimAmount', '200');
    const amendedCurrent = amended.facts.find(
      (fact) => fact.key === 'donations.currentEligibleGifts',
    )!;
    amendedCurrent.source = {
      ...amendedCurrent.source,
      revision: 2,
      contentHash: 'b'.repeat(64),
    };
    const amendedRun = runCanadaOntario2025PersonalWorkflow(amended);
    const amendedExport = exportCanadaOntario2025PersonalSchedules(amendedRun);
    const originalDonations = originalExport.carryforwardSections.find(
      (section) => section.sectionId === 'charitable-donations',
    )!;
    const amendedDonations = amendedExport.carryforwardSections.find(
      (section) => section.sectionId === 'charitable-donations',
    )!;

    expect(value(originalRun, 'Schedule9.23')).toBe('261');
    expect(value(amendedRun, 'Schedule9.23')).toBe('29');
    expect(originalRun.runHash).not.toBe(amendedRun.runHash);
    expect(originalDonations.provenance).toEqual(
      expect.objectContaining({
        runHash: originalRun.runHash,
        inputHash: originalRun.inputHash,
        revision: 1,
      }),
    );
    expect(amendedDonations.provenance).toEqual(
      expect.objectContaining({
        runHash: amendedRun.runHash,
        inputHash: amendedRun.inputHash,
        revision: 2,
      }),
    );
    expect(amendedDonations.rows.map((row) => row.used.exactDecimal)).toEqual([
      '100',
      '100',
      '0',
      '0',
      '0',
      '0',
    ]);
    expect(amendedDonations.rows[5]!.closing.exactDecimal).toBe('1000');
    expect(amendedDonations.rows[5]!.sourceBinding).toEqual(
      expect.objectContaining({
        reference: 'fixture:donations.currentEligibleGifts',
        revision: 2,
        contentHash: 'b'.repeat(64),
      }),
    );
    expect(originalDonations.rows.map((row) => row.used.exactDecimal)).toEqual([
      '100',
      '100',
      '100',
      '100',
      '100',
      '500',
    ]);
    expect(originalExport.content).toContain(originalRun.runHash);
    expect(amendedExport.content).toContain(amendedRun.runHash);
    expect(amendedExport.content).not.toContain(originalRun.runHash);
  });
  it('exports historical runs without a charitable-donations property without fabricating a zero donation section', () => {
    const current = runCanadaOntario2025PersonalWorkflow(input());
    const legacyBody = Object.fromEntries(
      Object.entries(current).filter(
        ([key]) => key !== 'charitableDonations' && key !== 'runHash',
      ),
    );
    const legacyRun = {
      ...legacyBody,
      runHash: createHash('sha256')
        .update(canonicalForHash(legacyBody))
        .digest('hex'),
    } as typeof current;
    const exported = exportCanadaOntario2025PersonalSchedules(legacyRun);
    expect(
      exported.carryforwardSections.map((section) => section.sectionId),
    ).toEqual(['general-noncapital-loss']);
    expect(exported.content).not.toContain('charitable-donations');
  });
});

describe('reviewed annual dues deduction', () => {
  it('propagates deductions through the income-tested CWB calculation', () => {
    const i = input();
    for (const [key, amountValue] of Object.entries({
      't4.box14': '30000',
      't4.box26': '30000',
      't4.box16': '1576.75',
      't4.box18': '492',
      't4.box24': '30000',
      'deductions.annualDues': '1000',
    }))
      amount(i, key, amountValue);
    const run = runCanadaOntario2025PersonalWorkflow(i);
    expect(run.issues).toEqual([]);
    expect(value(run, 'T1.23600')).toBe('28735');
    // CWB reduction falls by 15% of the $1,000 net-income deduction.
    expect(value(run, 'T1.45300')).toBe('1351');
  });

  it('transfers exact cents into deductions and reduces the carryforward base', () => {
    const i = input();
    amount(i, 'interest', '10000');
    amount(i, 'deductions.annualDues', '250.17');
    amount(i, 'carryforward.nonCapitalLoss.2024', '10000');
    const run = runCanadaOntario2025PersonalWorkflow(i);
    expect(run.status).not.toBe('blocked');
    expect(value(run, 'T1.21200')).toBe('250.17');
    expect(value(run, 'T1.23300')).toBe('250.17');
    expect(value(run, 'T1.23600')).toBe('9749.83');
    expect(value(run, 'T1.25200')).toBe('9749.83');
    expect(value(run, 'T1.26000')).toBe('0');
    expect(run.fields.find((f) => f.id === 'T1.21200')?.reportableAmount).toBe(
      '250.17',
    );
    expect(
      run.inputSnapshot?.facts.find((f) => f.key === 'deductions.annualDues')
        ?.source.reference,
    ).toBe('fixture:deductions.annualDues');
    expect(run.complete).toBe(false);
    expect(run.enabled).toBe(false);
  });
  it('requires an explicit reviewed zero when no dues are claimed', () => {
    const i = input();
    expect(value(runCanadaOntario2025PersonalWorkflow(i), 'T1.21200')).toBe(
      '0',
    );
    i.facts = i.facts.filter((f) => f.key !== 'deductions.annualDues');
    expect(runCanadaOntario2025PersonalWorkflow(i).status).toBe('blocked');
  });
  it.each([
    'unreviewed',
    'negative',
    'duplicate',
    'reimbursed',
    'business-duplicate',
  ] as const)('blocks %s dues inputs', (reason) => {
    const i = input('sole-proprietor');
    const fact = i.facts.find((f) => f.key === 'deductions.annualDues')!;
    if (reason === 'unreviewed') fact.reviewState = 'unreviewed';
    if (reason === 'negative') amount(i, fact.key, '-1');
    if (reason === 'duplicate') i.facts.push({ ...fact });
    if (reason === 'reimbursed' || reason === 'business-duplicate') {
      i.facts.find(
        (f) =>
          f.key ===
          (reason === 'reimbursed'
            ? 'scope.duesEligibleUnreimbursed'
            : 'scope.duesNotClaimedInBusiness'),
      )!.value = { type: 'boolean', value: false };
    }
    expect(runCanadaOntario2025PersonalWorkflow(i).status).toBe('blocked');
  });
});

describe('reviewed self medical expenses in the annual return', () => {
  it('reports a lossless-cent supplement using the captured federal worksheet fields', () => {
    const i = input('sole-proprietor');
    amount(i, 'business.grossSales', '7500');
    amount(i, 'medical.eligibleSelfExpenses', '1216.66');
    const run = runCanadaOntario2025PersonalWorkflow(i);
    expect(run.issues).toEqual([]);
    expect(value(run, 'T1.23600')).toBe('7222');
    expect(value(run, 'T1.33200')).toBe('1000');
    expect(value(run, 'T1.45200')).toBe('250');
    expect(run.fields.find((f) => f.id === 'T1.45200')?.reportableAmount).toBe(
      '250.00',
    );
    expect(
      run.fields.find((f) => f.id === 'MedicalSupplement.13')?.reporting
        .sourceId,
    ).toBe('cra-5000-d1-2025-fillable');
    expect(run.complete).toBe(false);
  });

  it('connects credits and refundable supplement while withholding unproven paper precision', () => {
    const i = input();
    for (const [key, amountValue] of Object.entries({
      't4.box14': '30000',
      't4.box26': '30000',
      't4.box16': '1576.75',
      't4.box18': '492',
      't4.box24': '30000',
      'medical.eligibleSelfExpenses': '5000',
    }))
      amount(i, key, amountValue);
    const run = runCanadaOntario2025PersonalWorkflow(i);
    expect(run.issues).toEqual([]);
    expect(value(run, 'T1.33200')).toBe('4107.95');
    expect(value(run, 'ON428.58769')).toBe('4107.95');
    expect(value(run, 'T1.45200')).toBe('1026.9875');
    expect(value(run, 'T1.48200')).toBe('2227.9875');
    expect(
      run.fields.find((f) => f.id === 'T1.45200')?.reportableAmount,
    ).toBeNull();
    expect(run.fields.find((f) => f.id === 'T1.33099')?.reportableAmount).toBe(
      '5000.00',
    );
    expect(
      run.inputSnapshot?.facts.find(
        (f) => f.key === 'medical.eligibleSelfExpenses',
      )?.source.reference,
    ).toBe('fixture:medical.eligibleSelfExpenses');
    expect(run.complete).toBe(false);
    expect(run.reportable).toBe(false);
    expect(run.finalAmounts).toEqual({ refund: null, balanceOwing: null });
  });
  it.each([
    'missing',
    'unreviewed',
    'negative',
    'duplicate',
    'reimbursed',
    'prior-claim',
    'Ontario-special',
  ] as const)('blocks %s medical facts', (reason) => {
    const i = input();
    const fact = i.facts.find((f) => f.key === 'medical.eligibleSelfExpenses')!;
    if (reason === 'missing') i.facts = i.facts.filter((f) => f !== fact);
    if (reason === 'unreviewed') fact.reviewState = 'unreviewed';
    if (reason === 'negative') amount(i, fact.key, '-1');
    if (reason === 'duplicate') i.facts.push({ ...fact });
    const guard =
      reason === 'reimbursed'
        ? 'scope.medicalEligibleUnreimbursed'
        : reason === 'prior-claim'
          ? 'scope.medicalSamePeriodNotPreviouslyClaimed'
          : reason === 'Ontario-special'
            ? 'scope.medicalNoOntarioSpecialCategories'
            : null;
    if (guard)
      i.facts.find((f) => f.key === guard)!.value = {
        type: 'boolean',
        value: false,
      };
    expect(runCanadaOntario2025PersonalWorkflow(i).status).toBe('blocked');
  });
});

describe('connected commission reporting', () => {
  function commission(method: 'cash' | 'accrual' = 'accrual') {
    const i = input('sole-proprietor');
    i.facts.find((f) => f.key === 'business.incomeKind')!.value = {
      type: 'text',
      value: 'commission',
    };
    i.facts.find((f) => f.key === 'business.reportingMethod')!.value = {
      type: 'text',
      value: method,
    };
    amount(i, 'business.grossSales', '11300');
    amount(i, 'business.salesAdjustments', '1300');
    amount(i, 'business.8810', '1000');
    amount(i, 'medical.eligibleSelfExpenses', '2000');
    return i;
  }
  it.each(['cash', 'accrual'] as const)(
    'routes reviewed %s commission totals once through income, CPP, CWB and medical',
    (method) => {
      const i = commission(method);
      const c = runCanadaOntario2025PersonalWorkflow(i);
      const ordinary = structuredClone(i);
      ordinary.facts.find((f) => f.key === 'business.incomeKind')!.value = {
        type: 'text',
        value: 'business',
      };
      ordinary.facts.find((f) => f.key === 'business.reportingMethod')!.value =
        { type: 'text', value: 'accrual' };
      const b = runCanadaOntario2025PersonalWorkflow(ordinary);
      expect(c.status).toBe('review-calculation-produced');
      expect(value(c, 'T1.13899')).toBe('10000');
      expect(value(c, 'T1.13900')).toBe('9000');
      expect(value(c, 'T1.13499')).toBe('0');
      expect(value(c, 'T1.13500')).toBe('0');
      for (const id of [
        'T1.15000',
        'T1.23600',
        'T1.22200',
        'T1.42100',
        'Schedule6.3',
        'T1.45300',
        'MedicalSupplement.workingIncome',
        'T1.45200',
        'T1.167',
      ])
        expect(value(c, id), id).toBe(value(b, id));
      expect(value(c, 'T1.15000')).toBe('9000');
      expect(value(c, 'T1.42100')).toBe('654.5');
      expect(value(c, 'Schedule6.3')).toBe('9000');
      expect(value(c, 'T1.45300')).toBe('1620');
      expect(
        c.fields.find((f) => f.id === 'Schedule6.3')!.dependencies,
      ).toContain('T1.13900');
      expect(
        c.fields.find((f) => f.id === 'MedicalSupplement.workingIncome')!
          .dependencies,
      ).toContain('T1.13900');
      expect(c.fields.find((f) => f.id === 'T2125.3A')!.dependencies).toContain(
        'fact:business.reportingMethod',
      );
      expect(c.complete).toBe(false);
      expect(c.enabled).toBe(false);
    },
  );
  it('includes commission in mixed employment CPP and the EI low-earnings condition', () => {
    const i = commission('cash');
    for (const key of ['t4.box14', 't4.box24', 't4.box26'])
      amount(i, key, '1500');
    const c = runCanadaOntario2025PersonalWorkflow(i);
    const bInput = structuredClone(i);
    bInput.facts.find((f) => f.key === 'business.incomeKind')!.value = {
      type: 'text',
      value: 'business',
    };
    bInput.facts.find((f) => f.key === 'business.reportingMethod')!.value = {
      type: 'text',
      value: 'accrual',
    };
    const b = runCanadaOntario2025PersonalWorkflow(bInput);
    expect(c.status).toBe('review-calculation-produced');
    expect(value(c, 'T2204.1')).toBe('1500');
    expect(value(c, 'T1.42100')).toBe(value(b, 'T1.42100'));
    expect(value(c, 'Schedule6.3')).toBe('9000');
    expect(
      c.fields.find((f) => f.id === 'Schedule8.part5.line1')!.dependencies,
    ).toContain('T1.13900');
  });
  it('rejects missing, unreviewed or invalid method inputs and unsupported transitions', () => {
    for (const key of [
      'business.incomeKind',
      'business.reportingMethod',
      'business.methodChanged',
      'business.amountsOnSelectedBasis',
    ]) {
      const missing = commission();
      missing.facts = missing.facts.filter((f) => f.key !== key);
      expect(
        runCanadaOntario2025PersonalWorkflow(missing).issues,
      ).toContainEqual(
        expect.objectContaining({ code: 'missing-fact', path: key }),
      );
      const unreviewed = commission();
      unreviewed.facts.find((f) => f.key === key)!.reviewState = 'unreviewed';
      expect(runCanadaOntario2025PersonalWorkflow(unreviewed).status).toBe(
        'blocked',
      );
    }
    for (const [key, v, code] of [
      ['business.incomeKind', 'mixed', 'invalid-business-income-kind'],
      ['business.reportingMethod', 'automatic', 'invalid-reporting-method'],
      [
        'business.methodChanged',
        true,
        'unsupported-accounting-method-transition',
      ],
      ['business.amountsOnSelectedBasis', false, 'unsupported-feature'],
    ] as const) {
      const i = commission();
      i.facts.find((f) => f.key === key)!.value =
        typeof v === 'boolean'
          ? { type: 'boolean', value: v }
          : { type: 'text', value: v };
      const run = runCanadaOntario2025PersonalWorkflow(i);
      expect(run.status).toBe('blocked');
      expect(run.issues).toContainEqual(
        expect.objectContaining({ code, path: key }),
      );
    }
    const cashBusiness = commission('cash');
    cashBusiness.facts.find((f) => f.key === 'business.incomeKind')!.value = {
      type: 'text',
      value: 'business',
    };
    expect(
      runCanadaOntario2025PersonalWorkflow(cashBusiness).issues,
    ).toContainEqual(
      expect.objectContaining({ code: 'unsupported-reporting-method' }),
    );
    const individual = input();
    individual.facts = individual.facts.filter(
      (f) =>
        ![
          'business.incomeKind',
          'business.reportingMethod',
          'business.methodChanged',
          'business.amountsOnSelectedBasis',
        ].includes(f.key),
    );
    expect(runCanadaOntario2025PersonalWorkflow(individual).status).toBe(
      'review-calculation-produced',
    );
  });
});

describe('Ontario health premium taxable-income basis', () => {
  it.each([
    ['30000', '15000', '15000', '0'],
    ['50000', '10000', '40000', '450'],
    ['80000', '7500', '72500', '725'],
  ])(
    'uses taxable income after carryforward for interest %s and loss %s',
    (interest, loss, taxable, premium) => {
      const intake = input();
      amount(intake, 'interest', interest);
      amount(intake, 'carryforward.nonCapitalLoss.2024', loss);
      const run = runCanadaOntario2025PersonalWorkflow(intake);
      expect(run.status).not.toBe('blocked');
      const field = (id: string) => run.fields.find((f) => f.id === id)!;
      expect(field('T1.23600').exactDecimal).toBe(interest);
      expect(field('T1.26000').exactDecimal).toBe(taxable);
      expect(field('ON428.89').exactDecimal).toBe(premium);
      expect(field('ONHealthPremium.1').dependencies).toEqual(['T1.26000']);
      expect(field('ONHealthPremium.1').exactDecimal).toBe(taxable);
    },
  );
});

describe('Ontario health-premium worksheet reporting chain', () => {
  it('preserves an unresolved fractional cent through the premium transfer', () => {
    const intake = input();
    amount(intake, 'interest', '20000.01');
    const run = runCanadaOntario2025PersonalWorkflow(intake);
    const field = (id: string) => run.fields.find((f) => f.id === id)!;
    expect(field('ONHealthPremium.row2.excess').exactDecimal).toBe('0.01');
    expect(field('ONHealthPremium.row2.rateProduct').exactDecimal).toBe(
      '0.0006',
    );
    expect(field('ONHealthPremium.row2.rateProduct').reporting.status).toBe(
      'rounding-unproven',
    );
    expect(field('ON428.89').reportableAmount).toBeNull();
    expect(field('ON428.89').dependencies).toEqual([
      'ONHealthPremium.row2.rateProduct',
    ]);
    expect(field('T1.42800').reportableAmount).toBeNull();
  });
});

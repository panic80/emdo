import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type FinanceTaxIntake } from '@emdo/contracts';
import {
  auditJapan2025FormApplicability,
  JAPAN_2025_REQUIRED_FORM_FACTS,
} from './form-applicability.js';
import {
  exportJapan2025SelectedReturn,
  exportReviewedJapan2025SelectedReturn,
  reviewJapan2025SelectedReturnExport,
} from './export.js';
import { applyJapan2025SelectedReporting } from './reporting.js';
import {
  JAPAN_2025_CANDIDATE,
  JAPAN_2025_REQUIRED_FACTS,
  runJapan2025WorkingPapers,
} from './workflow.js';

const CASE_ID = '00000000-0000-4000-8000-000000000001';
const SUBJECT_ID = '00000000-0000-4000-8000-000000000003';
const SOURCE_HASH = 'b'.repeat(64);

function intake(
  overrides: Record<string, string | boolean> = {},
): FinanceTaxIntake {
  return {
    schemaVersion: 1,
    caseId: CASE_ID,
    workspaceId: '00000000-0000-4000-8000-000000000002',
    taxSubjectId: SUBJECT_ID,
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
      reviewState: 'reviewed' as const,
      value: {
        type: definition.type,
        value:
          overrides[definition.key] ??
          ('equals' in definition ? definition.equals : '0'),
      } as FinanceTaxIntake['facts'][number]['value'],
      source: {
        kind: 'declaration' as const,
        reference: 'Independent Japan 2025 salary fixture',
        revision: 1,
        contentHash: SOURCE_HASH,
      },
    })),
  };
}

function formFacts(
  overrides: Record<string, string | boolean> = {},
): FinanceTaxIntake['facts'] {
  const defaults: Record<string, string | boolean> = {
    'identity.taxOffice': 'Tokyo',
    'identity.submissionDate': '2026-02-16',
    'identity.fullName': 'Aiko Example',
    'identity.furigana': 'エグザンプル アイコ',
    'identity.taxNumber': '123456789012',
    'identity.postalCode': '100-0001',
    'identity.address': 'Tokyo-to Chiyoda-ku',
    'identity.dateOfBirth': '1990-01-02',
    'identity.gender': 'female',
    'identity.occupation': 'employee',
    'identity.tradeName': 'none',
    'identity.householdHead': 'Aiko Example',
    'identity.householdRelationship': 'self',
    'identity.phone': '03-1234-5678',
    'identity.sameAddressAt2026-01-01': true,
    'form.noBlueReturn': true,
    'form.noSeparateTaxation': true,
    'form.noEmigrationTax': true,
    'form.noLossReturn': true,
    'form.noAmendedReturn': true,
    'form.noSpecialAgriculture': true,
    'case.singleSalaryPayer': true,
    'salary.payerName': 'Example Co., Ltd.',
    'salary.payerAddressOrNumber': 'Tokyo-to Minato-ku / 12345',
    'salary.incomeDetailGross': '1920500',
    'salary.incomeDetailWithholding': '0',
    'socialInsurance.detailType': 'salary-withheld-social-insurance',
    'socialInsurance.detailAmount': '0',
    'case.noSpouseOrDependants': true,
    'case.noSpecialProvisionArticles': true,
    'scope.localTaxOutOfScopeAcknowledged': true,
  };
  const values = { ...defaults, ...overrides };
  return JAPAN_2025_REQUIRED_FORM_FACTS.map((definition) => ({
    key: definition.key,
    reviewState: 'reviewed' as const,
    value: {
      type: definition.type,
      value: values[definition.key] ?? '0',
    } as FinanceTaxIntake['facts'][number]['value'],
    source: {
      kind: 'declaration' as const,
      reference: `Reviewed form fact ${definition.key}`,
      revision: 1,
      contentHash: SOURCE_HASH,
    },
  }));
}

function run(overrides: Record<string, string | boolean> = {}) {
  return runJapan2025WorkingPapers(
    intake({ 'salary.gross': '1920500', ...overrides }),
  );
}

function envelope(
  result: ReturnType<typeof run>,
  overrides: Record<string, string | boolean> = {},
) {
  return {
    caseId: CASE_ID,
    taxSubjectId: SUBJECT_ID,
    revision: 1,
    runHash: result.outputHash,
    facts: formFacts(overrides),
  };
}

describe('Japan 2025 selected Form 1/Form 2 applicability', () => {
  it('independently completes the supported reviewed salary branch while keeping full return incomplete', () => {
    const result = run();
    const audit = auditJapan2025FormApplicability(result, envelope(result));
    expect(audit.selectedComplete).toBe(true);
    expect(audit.complete).toBe(true);
    expect(audit.formDataReady).toBe(true);
    expect(audit.fullReturnComplete).toBe(false);
    expect(audit.reportable).toBe(false);
    expect(audit.unresolvedCount).toBe(0);
    expect(audit.issues).toEqual([]);
    expect(
      audit.fields.find(
        (field) => field.id === 'calculated:JP-Form-1.combinedTax',
      ),
    ).toMatchObject({
      decision: 'calculated',
      value: '16029',
      sourceId: 'nta-jp-r07-total-tax',
    });
    expect(
      audit.fields.find((field) => field.id === 'out-of-scope:local-tax'),
    ).toMatchObject({ decision: 'out-of-scope', fullReturnGap: true });
  });

  it('fails closed on missing, mismatched, unknown and unreviewed form facts', () => {
    const result = run();
    const missing = envelope(result);
    missing.facts = missing.facts.filter(
      (fact) => fact.key !== 'identity.fullName',
    );
    const missingAudit = auditJapan2025FormApplicability(result, missing);
    expect(missingAudit.selectedComplete).toBe(false);
    expect(missingAudit.issues).toContain(
      'missing-or-unreviewed-form-fact:identity.fullName',
    );

    const mismatched = envelope(result, {
      'salary.incomeDetailGross': '1920501',
    });
    const mismatchAudit = auditJapan2025FormApplicability(result, mismatched);
    expect(mismatchAudit.selectedComplete).toBe(false);
    expect(mismatchAudit.issues).toContain(
      'form-detail-does-not-match:salary.incomeDetailGross',
    );

    const unreviewed = envelope(result);
    unreviewed.facts.find(
      (fact) => fact.key === 'identity.fullName',
    )!.reviewState = 'unreviewed';
    const unreviewedAudit = auditJapan2025FormApplicability(result, unreviewed);
    expect(unreviewedAudit.selectedComplete).toBe(false);

    const unknown = envelope(result);
    unknown.facts.push({
      ...unknown.facts[0]!,
      key: 'unsupported.formField',
    });
    const unknownAudit = auditJapan2025FormApplicability(result, unknown);
    expect(unknownAudit.selectedComplete).toBe(false);
    expect(unknownAudit.issues).toContain(
      'unknown-form-fact:unsupported.formField',
    );
  });

  it('binds form facts to the exact run output and preserves explicit full-return gaps', () => {
    const result = run();
    const changed = envelope(result);
    changed.runHash = createHash('sha256').update('different').digest('hex');
    const audit = auditJapan2025FormApplicability(result, changed);
    expect(audit.selectedComplete).toBe(false);
    expect(audit.issues).toContain(
      'form-input-case-revision-run-binding-mismatch',
    );
    expect(audit.fullReturnGaps).toEqual(
      expect.arrayContaining([
        'out-of-scope:local-tax',
        'out-of-scope:form-3',
        'out-of-scope:form-4',
        'out-of-scope:business-schedules',
      ]),
    );
  });
});

describe('Japan 2025 selected reporting and export', () => {
  it('reports exact whole-JPY selected fields and keeps out-of-scope/manual fields gated', () => {
    const result = run();
    const audit = auditJapan2025FormApplicability(result, envelope(result));
    const reporting = applyJapan2025SelectedReporting(result, audit);
    expect(reporting.complete).toBe(true);
    expect(reporting.reportable).toBe(false);
    expect(
      reporting.fields.find(
        (field) => field.id === 'calculated:JP-Form-1.combinedTax',
      ),
    ).toMatchObject({
      exactYen: '16029',
      reportableAmount: '16029',
      reporting: {
        target: 'japan-2025-selected-form-field',
        status: 'lossless-whole-yen',
        rounding: 'none-lossless',
      },
    });
    expect(
      reporting.fields.find((field) => field.id === 'out-of-scope:local-tax')!
        .reporting.status,
    ).toBe('out-of-scope');
    expect(
      reporting.fields.find(
        (field) => field.id === 'manual:taxpayer-signature',
      )!.reporting.status,
    ).toBe('manual-unperformed');
  });

  it('exports deterministic, source-provenanced selected working data and a separately bound review', () => {
    const result = run();
    const audit = auditJapan2025FormApplicability(result, envelope(result));
    const first = exportJapan2025SelectedReturn(result, audit);
    const second = exportJapan2025SelectedReturn(result, audit);
    expect(first).toEqual(second);
    expect(first.complete).toBe(false);
    expect(first.selectedComplete).toBe(true);
    expect(first.fileable).toBe(false);
    expect(first.content).toContain('NOT A COMPLETE RETURN');
    expect(first.content).toContain('nta-jp-r07-form-1-2');
    expect(first.content).toContain('16029');
    expect(createHash('sha256').update(first.content).digest('hex')).toBe(
      first.sha256,
    );

    const review = reviewJapan2025SelectedReturnExport(result, audit, {
      reviewerId: '00000000-0000-4000-8000-000000000004',
      reviewedAt: '2026-02-17T12:00:00Z',
      runHash: result.outputHash,
      auditHash: audit.auditHash,
    });
    const reviewedExport = exportReviewedJapan2025SelectedReturn(review);
    expect(reviewedExport.fileable).toBe(false);
    expect(reviewedExport.content).toContain(review.reviewHash);
  });

  it('does not export blocked or incomplete selected branches', () => {
    const result = run();
    const incomplete = auditJapan2025FormApplicability(
      result,
      envelope(result, { 'identity.fullName': '' }),
    );
    expect(incomplete.selectedComplete).toBe(false);
    expect(() => exportJapan2025SelectedReturn(result, incomplete)).toThrow(
      'japan-export-selected-form-not-ready',
    );
    const blocked = run({ 'salary.gross': '332000000' });
    const blockedAudit = auditJapan2025FormApplicability(
      blocked,
      envelope(blocked),
    );
    expect(blockedAudit.selectedComplete).toBe(false);
    expect(() =>
      applyJapan2025SelectedReporting(blocked, blockedAudit),
    ).not.toThrow();
    expect(() => exportJapan2025SelectedReturn(blocked, blockedAudit)).toThrow(
      'japan-export-has-blocking-inputs',
    );
  });
});

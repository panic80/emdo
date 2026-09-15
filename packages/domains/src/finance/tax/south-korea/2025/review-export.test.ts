import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SOUTH_KOREA_2025_FORM_INVENTORY_VERSION,
  SOUTH_KOREA_2025_REQUIRED_FORM_FACTS,
  auditSouthKorea2025FormApplicability,
} from './form-inventory.js';
import { buildSouthKorea2025ReviewExport } from './review-export.js';
import {
  SOUTH_KOREA_2025_FIXTURES,
  type SouthKorea2025Fixture,
} from './fixtures.js';
import {
  SOUTH_KOREA_2025_MONEY_FACTS,
  SOUTH_KOREA_2025_SCOPE,
} from './workflow.js';
import { SOUTH_KOREA_2025_SOURCES } from './sources.js';

const sourceHash = (id: string) =>
  SOUTH_KOREA_2025_SOURCES.find((source) => source.id === id)!.documentHash;

const contentHash = (value: Uint8Array) =>
  createHash('sha256').update(value).digest('hex');

const declarationSource = {
  kind: 'declaration' as const,
  reference: 'independent reviewed South Korea fixture',
  revision: 1,
  contentHash: 'a'.repeat(64),
};

function genericSalaryIntake(fixture: SouthKorea2025Fixture) {
  const input = fixture.input;
  const guardFacts = [
    ...[
      'onlyOrdinaryEmploymentIncome',
      'hasBusinessIncome',
      'hasInvestmentIncome',
      'hasPensionIncome',
      'hasOtherGlobalIncome',
      'hasDailyEmploymentIncome',
      'hasForeignSourceIncome',
      'hasRetirementIncome',
      'usesForeignWorkerFlatTax',
      'hasTaxReductionOrExemption',
    ].map((directKey) => ({
      key: `case.${directKey}`,
      value: {
        type: 'boolean' as const,
        value: input[directKey as keyof typeof input] as boolean,
      },
      reviewState: 'reviewed' as const,
      source: declarationSource,
    })),
  ];
  const moneyFacts = SOUTH_KOREA_2025_MONEY_FACTS.map((definition) => ({
    key: definition.key,
    value: {
      type: 'decimal' as const,
      value: String(input[definition.directKey as keyof typeof input]),
    },
    reviewState: 'reviewed' as const,
    source: declarationSource,
  }));
  return {
    schemaVersion: 1 as const,
    caseId: '00000000-0000-4000-8000-000000000011',
    workspaceId: '00000000-0000-4000-8000-000000000012',
    taxSubjectId: '00000000-0000-4000-8000-000000000013',
    legalEntityId: null,
    sourceBooks: [],
    revision: 1,
    scope: { ...SOUTH_KOREA_2025_SCOPE },
    domesticResident: true,
    hasCrossBorderActivity: false,
    standaloneCorporation: null,
    requestedFeatures: ['income-tax-return' as const],
    facts: [...guardFacts, ...moneyFacts],
  };
}

function formFacts() {
  const values: Record<
    string,
    { type: 'boolean' | 'text' | 'date'; value: string | boolean }
  > = {
    'form.resident': { type: 'boolean', value: true },
    'form.taxpayerName': { type: 'text', value: 'Kim Review Fixture' },
    'form.taxpayerRegistrationNumber': {
      type: 'text',
      value: '900101-1234567',
    },
    'form.taxpayerAddress': { type: 'text', value: 'Seoul, Republic of Korea' },
    'form.withholdingAgentName': {
      type: 'text',
      value: 'Fixture Employer Co.',
    },
    'form.withholdingAgentRegistrationNumber': {
      type: 'text',
      value: '123-45-67890',
    },
    'form.singleSalaryPayer': { type: 'boolean', value: true },
    'form.employmentPeriodStart': { type: 'date', value: '2025-01-01' },
    'form.employmentPeriodEnd': { type: 'date', value: '2025-12-31' },
  };
  return SOUTH_KOREA_2025_REQUIRED_FORM_FACTS.map((requirement) => ({
    key: requirement.key,
    value: values[requirement.key]!,
    reviewState: 'reviewed' as const,
    source: {
      kind: 'evidence' as const,
      reference: 'NTS salary receipt review fixture',
      revision: 1,
      contentHash: 'b'.repeat(64),
    },
  }));
}

function attachment(
  attachmentId: string,
  bytes: Uint8Array,
  artifactId: string,
) {
  return {
    artifactId,
    attachmentId,
    formId: 'NTS-YEAREND-2025',
    authoritySourceId: 'nts-kr-2025-year-end-settlement-guide',
    authorityDocumentHash: sourceHash('nts-kr-2025-year-end-settlement-guide'),
    contentHash: contentHash(bytes),
    bytes,
    reviewedBy: 'review-fixture',
    reviewedAt: '2026-09-14T15:30:00.000Z',
  };
}

function completeSalaryReviewInput() {
  const receipt = new TextEncoder().encode('reviewed NTS salary receipt bytes');
  const declaration = new TextEncoder().encode(
    'reviewed NTS income and deduction declaration bytes',
  );
  return {
    intake: genericSalaryIntake(SOUTH_KOREA_2025_FIXTURES[0]!),
    formFacts: formFacts(),
    attachments: [
      attachment(
        'attachment.salary-withholding-receipt',
        receipt,
        '00000000-0000-4000-8000-000000000021',
      ),
      attachment(
        'attachment.salary-income-deduction-declaration',
        declaration,
        '00000000-0000-4000-8000-000000000022',
      ),
    ],
  };
}

describe('South Korea 2025 source-bound form review export', () => {
  it('marks the selected one-payer salary case complete and full return incomplete', () => {
    const input = completeSalaryReviewInput();
    const audit = auditSouthKorea2025FormApplicability(input);
    expect(audit.version).toBe(SOUTH_KOREA_2025_FORM_INVENTORY_VERSION);
    expect(audit.selectedComplete).toBe(true);
    expect(audit.formDataReady).toBe(true);
    expect(audit.fullReturnComplete).toBe(false);
    expect(audit.issues).toEqual([]);
    expect(
      audit.attachments.filter((entry) => entry.applicable && entry.satisfied),
    ).toHaveLength(2);

    const exported = buildSouthKorea2025ReviewExport(input);
    expect(exported.status).toBe('reviewed-supported-salary-case');
    expect(exported.supportedCaseComplete).toBe(true);
    expect(exported.packageCandidateComplete).toBe(false);
    expect(exported.fullReturnComplete).toBe(false);
    expect(exported.filingAuthorized).toBe(false);
    expect(exported.reportable).toBe(false);
    expect(exported.exportHash).toMatch(/^[a-f0-9]{64}$/);
    expect(exported.blockers).toEqual(
      expect.arrayContaining([
        'full-return-not-attested',
        'filing-submission-not-authorized',
      ]),
    );
    expect(exported.forms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'NTS-YEAREND-2025' }),
        expect.objectContaining({ id: 'NTS-GLOBAL-40-1-2025' }),
        expect.objectContaining({ id: 'NTS-CORPORATE-1-2025' }),
      ]),
    );
    expect(buildSouthKorea2025ReviewExport(input).exportHash).toBe(
      exported.exportHash,
    );
  });

  it('blocks the export when a required actual NTS attachment is absent', () => {
    const input = completeSalaryReviewInput();
    input.attachments.pop();
    const exported = buildSouthKorea2025ReviewExport(input);
    expect(exported.status).toBe('blocked-review');
    expect(exported.supportedCaseComplete).toBe(false);
    expect(exported.blockers).toContain('missing-or-unbound-attachment');
    expect(exported.fullReturnComplete).toBe(false);
  });

  it('rejects an attachment whose authority hash is not the pinned NTS hash', () => {
    const input = completeSalaryReviewInput();
    input.attachments[0] = {
      ...input.attachments[0]!,
      authorityDocumentHash: 'c'.repeat(64),
    };
    const audit = auditSouthKorea2025FormApplicability(input);
    expect(audit.selectedComplete).toBe(false);
    expect(audit.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'missing-or-unbound-attachment' }),
      ]),
    );
  });
});

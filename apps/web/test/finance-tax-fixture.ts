import type {
  FinanceTaxQuestionnaire,
  FinanceTaxDeclaredInput,
} from '@emdo/contracts/browser';

export const taxCaseId = '70000000-0000-4000-8000-000000000001';
export const taxSubjectId = '70000000-0000-4000-8000-000000000002';
export const taxBookId = '70000000-0000-4000-8000-000000000003';
export const taxSourceId = '70000000-0000-4000-8000-000000000004';
export const taxOwnerId = '70000000-0000-4000-8000-000000000005';
export const taxMemberId = '70000000-0000-4000-8000-000000000006';
export const taxAuthorizationId = '70000000-0000-4000-8000-000000000007';
export const taxSecondAuthorizationId = '70000000-0000-4000-8000-000000000008';
export const taxWorkspaceId = '70000000-0000-4000-8000-000000000009';
export const taxScope = {
  country: 'CA',
  subdivision: 'CA-ON',
  taxpayerType: 'individual' as const,
  year: 2025,
  regime: 'income-tax-return',
  formVersion: 'T1-2025',
};

export function taxFixture() {
  const declaration: FinanceTaxDeclaredInput = {
    sourceId: taxSourceId,
    sourceRevision: 1,
    contentHash: 'd'.repeat(64),
    factKey: 'Employment income (CAD)',
    category: 'income',
    value: { type: 'decimal', value: '123456.7800' },
    reviewState: 'unreviewed',
  };
  const questionnaire: FinanceTaxQuestionnaire = {
    schemaVersion: 1,
    visibility: 'private',
    declarationSourceBindings: [
      {
        sourceId: declaration.sourceId,
        sourceRevision: 1,
        contentHash: declaration.contentHash,
      },
    ],
    intake: {
      schemaVersion: 1,
      caseId: taxCaseId,
      workspaceId: taxWorkspaceId,
      taxSubjectId,
      legalEntityId: null,
      sourceBooks: [],
      revision: 2,
      scope: taxScope,
      domesticResident: null,
      hasCrossBorderActivity: null,
      standaloneCorporation: null,
      requestedFeatures: ['income-tax-return'],
      facts: [],
    },
    binding: {
      mode: 'intake-only',
      enabled: false,
      packageId: 'emdo.intake-only',
      packageVersion: '1',
      scope: taxScope,
      manifest: null,
      manifestHash: null,
    },
    questions: [],
    relatedParties: [],
    answers: [],
    withdrawnAnswers: [],
    sourceAuthorizationBindings: [],
  };
  const detail = {
    caseId: taxCaseId,
    taxSubjectId,
    currentRevision: 2,
    snapshotHash: 'b'.repeat(64),
    status: 'incomplete' as const,
    caseRole: 'owner' as 'owner' | 'preparer' | 'reviewer' | 'viewer',
    questionnaire,
    declaredInputs: [declaration],
    declarationBindingStatus: 'bound' as 'bound' | 'legacy-unbound',
  };
  const declarations = [{ ...declaration }];
  const summary = () => ({
    caseId: taxCaseId,
    taxSubjectId,
    title: '2025 · Personal income tax',
    taxSubjectName: 'Jordan Chen',
    revision: detail.currentRevision,
    status: 'incomplete',
    caseRole: detail.caseRole,
  });
  const assessment = () => ({
    caseId: taxCaseId,
    taxSubjectId,
    snapshotRevision: detail.currentRevision,
    snapshotHash: detail.snapshotHash,
    status: 'incomplete',
    complete: false,
    intake: null,
    questions: [],
    issues: [
      {
        code: 'package-unavailable',
        path: 'binding',
        message: 'No validated full-return package is available.',
      },
    ],
  });
  const receipt = () => ({
    caseId: taxCaseId,
    taxSubjectId,
    revision: detail.currentRevision,
    snapshotHash: detail.snapshotHash,
    status: 'incomplete',
  });
  function advance() {
    detail.currentRevision += 1;
    questionnaire.intake.revision = detail.currentRevision;
  }
  const books = [
    {
      id: taxBookId,
      name: 'Personal finances',
      entityName: 'Jordan Chen',
      functionalCurrency: 'CAD',
      country: 'CA',
      role: 'admin',
    },
  ];
  const grants = [
    {
      userId: taxOwnerId,
      role: 'owner',
      revision: 1,
      revokedAt: null as string | null,
      status: 'active',
    },
    {
      userId: taxMemberId,
      role: 'preparer',
      revision: 2,
      revokedAt: null as string | null,
      status: 'active',
    },
  ];
  return {
    detail,
    declarations,
    summary,
    assessment,
    receipt,
    advance,
    books,
    grants,
  };
}

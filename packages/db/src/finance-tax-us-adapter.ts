import { createHash } from 'node:crypto';
import {
  FinanceTaxRunFieldSchema,
  type FinanceTaxIntake,
} from '@emdo/contracts';
import {
  US_2025_CANDIDATE,
  US_2025_REQUIRED_FACTS,
  US_2025_SOURCES,
  US_2025_VERSION,
  US_REVIEW_BUNDLE_VERSION,
  prepareUs2025ReviewBundle,
  evaluateUs2025WorkingPapers,
  usReviewContentHash,
  type UsReviewedWageArtifact,
} from '@emdo/domains/finance';
export const US_PRIVATE_PACKAGE_VERSION = `${US_2025_VERSION}+private.2`;
export const US_PRIVATE_ADAPTER_VERSION = '2025-private-federal-output.2';
export const US_PRIVATE_QUESTIONS = [
  ...US_2025_REQUIRED_FACTS.map((f) => ({
    key: f.key,
    type: f.type,
    label: f.key.replaceAll('.', ' / '),
    required: true,
    locator: `IRS2025 reviewed input: ${f.key}`,
  })),
  {
    key: 'wageEvidence.documents',
    type: 'text' as const,
    label: 'W-2 original documents and reviewed boxes',
    required: false,
    locator: 'IRS2025 Form1040 instructions: Assemble Your Return',
  },
];
export const US_PRIVATE_PACKAGE_HASH = usReviewContentHash({
  candidate: US_2025_CANDIDATE,
  adapterVersion: US_PRIVATE_ADAPTER_VERSION,
  reviewBundleVersion: US_REVIEW_BUNDLE_VERSION,
  questions: US_PRIVATE_QUESTIONS,
});
export type PrivateUsWageEvidence = {
  reference: string;
  revision: number;
  artifacts: readonly UsReviewedWageArtifact[];
};
export function runPrivateUsWorkingPapers(
  input: FinanceTaxIntake,
  snapshotHash: string,
  wages?: PrivateUsWageEvidence,
) {
  const facts = input.facts.filter((f) => f.key !== 'wageEvidence.documents');
  const manifest = wages
    ? {
        reference: wages.reference,
        revision: wages.revision,
        artifacts: wages.artifacts
          .map(({ bytes, ...metadata }) => {
            void bytes;
            return metadata;
          })
          .sort((a, b) =>
            a.artifactId < b.artifactId
              ? -1
              : a.artifactId > b.artifactId
                ? 1
                : 0,
          ),
      }
    : null;
  const intake = {
    ...input,
    facts: facts.map((f) =>
      wages && f.key.startsWith('w2.') && f.reviewState === 'reviewed'
        ? {
            ...f,
            source: {
              kind: 'evidence' as const,
              reference: wages.reference,
              revision: wages.revision,
              contentHash: usReviewContentHash(manifest),
            },
          }
        : f,
    ),
  };
  const result = evaluateUs2025WorkingPapers(intake);
  const bundle = prepareUs2025ReviewBundle(
    intake,
    {
      workspaceId: intake.workspaceId,
      caseId: intake.caseId,
      taxSubjectId: intake.taxSubjectId,
      snapshotRevision: intake.revision,
      snapshotHash,
      intakeHash: usReviewContentHash(intake),
      wageManifestReference: wages?.reference ?? `tax-wages:${intake.caseId}`,
      wageManifestRevision: wages?.revision ?? intake.revision,
    },
    wages?.artifacts ?? [],
  );
  const fields = result.trace.map((t) =>
    FinanceTaxRunFieldSchema.parse({
      id: `${t.formId}.${t.line}`,
      form: t.formId,
      line: t.line,
      label: `${t.formId} line ${t.line}`,
      dependencies: t.dependsOn,
      sourceId: t.referenceIds[0] ?? 'irs-2025-f1040',
      locator: `${t.formId} line ${t.line}`,
      exactRational: {
        numerator: t.exactNumerator,
        denominator: t.exactDenominator,
      },
      exactDecimal: null,
      reportableAmount: t.reportedDollars,
      reporting: {
        target: 'irs-2025-paper-field',
        policyVersion: US_2025_CANDIDATE.roundingPolicy,
        status: 'official-whole-dollar-rounding',
        rounding: 'irs-whole-dollar-half-up',
        blockedDependencies: [],
        sourceId: t.referenceIds[0] ?? null,
        fieldPath: `${t.formId}.${t.line}`,
      },
    }),
  );
  const evidencePending =
    input.facts.some((f) => f.key === 'wageEvidence.documents') && !wages;
  const body = {
    adapterVersion: US_PRIVATE_ADAPTER_VERSION,
    packageHash: US_PRIVATE_PACKAGE_HASH,
    packageVersion: US_PRIVATE_PACKAGE_VERSION,
    complete: false as const,
    enabled: false as const,
    reportable: false as const,
    status:
      result.status === 'blocked-input' ||
      bundle.blockers.length ||
      evidencePending
        ? ('blocked' as const)
        : ('review-calculation-produced' as const),
    inputSnapshot: input,
    inputHash: usReviewContentHash(input),
    fields,
    sources: US_2025_SOURCES.map((s) => ({ ...s, formVersion: '2025' })),
    reportingPolicyVersion: US_2025_CANDIDATE.roundingPolicy,
    issues: [
      ...result.evaluation.issues.map((i) => ({
        code: i.code,
        message: i.message,
        path: 'federal-return',
      })),
      ...(evidencePending
        ? [
            {
              code: 'saved-wage-extraction-review-required',
              path: 'wageEvidence.documents',
              message:
                'Saved wage extraction requires exact original evidence review.',
            },
          ]
        : []),
      ...bundle.blockers.map((code) => ({
        code,
        path: 'wageEvidence.documents',
        message: code.replaceAll('-', ' '),
      })),
    ],
    releaseBlockers: [
      ...US_2025_CANDIDATE.releaseBlockers,
      'state-and-local-returns-not-included',
    ],
    finalAmounts: { refund: null, balanceOwing: null },
    usResult: result,
    usReviewBundle: bundle,
  };
  return { ...body, runHash: usReviewContentHash(body) };
}
export function exportPrivateUsWorkingPapers(
  run: ReturnType<typeof runPrivateUsWorkingPapers>,
) {
  const { runHash, ...body } = run;
  if (usReviewContentHash(body) !== runHash || run.status === 'blocked')
    throw Error('us-export-integrity-or-inputs');
  const quote = (value: unknown) => {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    return `"${(/^[\s]*[=+@-]/.test(s) ? "'" : '') + s.replaceAll('"', '""')}"`;
  };
  const content = [
    'Private US federal working papers; incomplete return; state and local returns not included; signature unperformed',
    `Run hash,${runHash}`,
    `Package version,${run.packageVersion}`,
    `Package hash,${run.packageHash}`,
    `Input hash,${run.inputHash}`,
    `Review bundle hash,${run.usReviewBundle.bundleHash}`,
    'Form,Field,Reported USD,Exact numerator,Exact denominator',
    ...run.fields.map((f) =>
      [
        f.form,
        f.line,
        f.reportableAmount,
        f.exactRational.numerator,
        f.exactRational.denominator,
      ]
        .map(quote)
        .join(','),
    ),
    'Private reviewed form inputs',
    ...run.inputSnapshot.facts
      .filter(
        (f) =>
          f.reviewState === 'reviewed' && f.key !== 'wageEvidence.documents',
      )
      .map((f) => [f.key, f.value.value].map(quote).join(',')),
    ...run.usReviewBundle.assembly.map((a) =>
      ['Attachment', a.formId, a.sequence, a.generatedContentHash]
        .map(quote)
        .join(','),
    ),
    ...(run.adapterVersion === '2025-private-federal-output.2'
      ? [
          'Private reviewed wage correction chain',
          ...run.usReviewBundle.wageManifest.artifacts.flatMap((a) => [
            [
              'Wage document',
              a.artifactId,
              a.form,
              a.contentHash,
              a.originalArtifactId ?? '',
              a.supersedesArtifactId ?? '',
              run.usReviewBundle.effectiveWageArtifactIds.includes(a.artifactId)
                ? 'effective terminal'
                : 'retained history',
              a.reviewedBy,
              a.reviewedAt,
            ]
              .map(quote)
              .join(','),
            ...Object.entries(a.boxes).map(([box, value]) =>
              ['Effective box', a.artifactId, box, value].map(quote).join(','),
            ),
            ...(a.corrections ?? []).map((c) =>
              ['Correction', a.artifactId, c.box, c.previous, c.correct]
                .map(quote)
                .join(','),
            ),
          ]),
        ]
      : []),
    ...run.sources.map((s) =>
      ['Source', s.id, s.documentHash, s.url].map(quote).join(','),
    ),
  ].join('\n');
  return {
    filename: `us-federal-2025-${run.inputSnapshot.caseId}-review.csv`,
    mimeType: 'text/csv' as const,
    content,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

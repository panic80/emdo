import { createHash } from 'node:crypto';
import {
  FinanceTaxIntakeSchema,
  FinanceTaxRunFieldSchema,
  type FinanceTaxIntake,
} from '@emdo/contracts';
import {
  US_2025_CANDIDATE,
  US_2025_SOURCES,
  usReviewContentHash,
} from '@emdo/domains/finance';
import {
  US_PRIVATE_PACKAGE_HASH,
  US_PRIVATE_PACKAGE_VERSION,
  runPrivateUsWorkingPapers,
  type PrivateUsWageEvidence,
} from './finance-tax-us-adapter.js';
import {
  NY_2025_CANDIDATE,
  NY_2025_REQUIRED_FACTS,
  evaluateNewYork2025WorkingPapers,
} from '../../domains/src/finance/tax/united-states/2025/new-york/workflow.js';
import { NY_2025_SOURCES } from '../../domains/src/finance/tax/united-states/2025/new-york/sources.js';

export { NY_2025_REQUIRED_FACTS };

/**
 * New York is a state component of the federal package.  It is deliberately
 * kept as its own adapter so that a state result cannot be mistaken for a
 * complete federal or fileable return.
 */
export const NY_PRIVATE_SCOPE = {
  country: 'US',
  subdivision: 'US-NY',
  taxpayerType: 'sole-proprietor',
  year: 2025,
  regime: 'income-tax-return',
  formVersion: 'IT201-2025',
} as const;

export const NY_PRIVATE_PACKAGE_VERSION = `${NY_2025_CANDIDATE.version}+private.1`;
export const NY_PRIVATE_ADAPTER_VERSION = '2025-private-new-york-output.1';
export const NY_PRIVATE_WORKFLOW_ID = 'us-ny-2025-working-papers';

/**
 * These questions are declarations for the NY component.  Federal wage
 * evidence is repeated as a dependency marker so callers cannot infer that a
 * NY run has reviewed W-2 originals merely because the federal input has W-2
 * values.
 */
export const NY_PRIVATE_QUESTIONS = [
  ...NY_2025_REQUIRED_FACTS.map((fact) => ({
    key: fact.key,
    type: fact.type,
    label: fact.key.replaceAll('.', ' / '),
    required: true,
    locator: `New York 2025 reviewed input: ${fact.key}`,
  })),
  {
    key: 'wageEvidence.documents',
    type: 'text' as const,
    label: 'Federal W-2 original documents and reviewed boxes',
    required: false,
    locator: 'New York 2025 IT-2 and federal Form 1040 assembly instructions',
  },
];

/** A package hash includes the federal dependency and every NY source/input. */
export const NY_PRIVATE_PACKAGE_HASH = usReviewContentHash({
  candidate: NY_2025_CANDIDATE,
  scope: NY_PRIVATE_SCOPE,
  adapterVersion: NY_PRIVATE_ADAPTER_VERSION,
  federalPackageVersion: US_PRIVATE_PACKAGE_VERSION,
  federalPackageHash: US_PRIVATE_PACKAGE_HASH,
  questions: NY_PRIVATE_QUESTIONS,
  sources: NY_2025_SOURCES,
});

type SourceBook = FinanceTaxIntake['sourceBooks'][number];
export type PrivateNewYorkWorkingPaperOptions = {
  /** Case snapshot hash resolved by trusted persistence. */
  snapshotHash: string;
  /** Optional component hashes are preserved when a caller has separate snapshots. */
  federalSnapshotHash?: string;
  newYorkSnapshotHash?: string;
  /** Resolved, reviewed W-2 originals. Never inferred from wage amounts. */
  wageEvidence?: PrivateUsWageEvidence;
};

const Hash = /^[a-f0-9]{64}$/;

function decimalRational(value: string) {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return { numerator: '0', denominator: '1' };
  const fraction = match[3] ?? '';
  const sign = match[1] === '-' ? -1n : 1n;
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = sign * BigInt(`${match[2]}${fraction}` || '0');
  return {
    numerator: numerator.toString(),
    denominator: denominator.toString(),
  };
}

function canonicalBookSnapshots(books: readonly SourceBook[]) {
  return books
    .map(({ bookId, snapshotRevision, snapshotHash }) => ({
      bookId,
      snapshotRevision,
      snapshotHash,
    }))
    .sort((a, b) => (a.bookId < b.bookId ? -1 : a.bookId > b.bookId ? 1 : 0));
}

function sameBookSnapshots(
  left: readonly SourceBook[],
  right: readonly SourceBook[],
) {
  return (
    usReviewContentHash(canonicalBookSnapshots(left)) ===
    usReviewContentHash(canonicalBookSnapshots(right))
  );
}

function normalizeOptions(
  snapshotHashOrOptions: string | PrivateNewYorkWorkingPaperOptions,
  wageEvidence?: PrivateUsWageEvidence,
): PrivateNewYorkWorkingPaperOptions {
  if (typeof snapshotHashOrOptions === 'string')
    return { snapshotHash: snapshotHashOrOptions, wageEvidence };
  return {
    ...snapshotHashOrOptions,
    wageEvidence: snapshotHashOrOptions.wageEvidence ?? wageEvidence,
  };
}

function issue(code: string, path: string, message: string) {
  return { code, path, message };
}

function fieldSource(formId: string, sourceId: string | undefined): string {
  if (sourceId) return sourceId;
  if (formId === 'IT-2105.9') return 'ny-2025-it2105-9';
  if (formId === 'IT-215') return 'ny-2025-it215';
  if (formId === 'IT-270') return 'ny-2025-it270';
  return 'ny-2025-it201';
}

/**
 * Convert deterministic domain output into the common review-field envelope.
 * The domain's rows are already entered/reportable whole-dollar values; the
 * adapter does not claim that those values make a fileable return.
 */
function prepareFields(
  result: ReturnType<typeof evaluateNewYork2025WorkingPapers>,
) {
  type TraceRow = ReturnType<
    typeof evaluateNewYork2025WorkingPapers
  >['trace'][number];
  const trace: Map<string, TraceRow> = new Map(
    result.trace.map((row) => [`IT-201.${row.key}`, row] as const),
  );
  const fields = [];
  for (const form of result.evaluation.forms) {
    for (const calculated of form.fields) {
      const id = `${form.id}.${calculated.key}`;
      const sourceRow = trace.get(id);
      const value =
        calculated.value.type === 'decimal' ? calculated.value.value : null;
      const exact = value === null ? null : decimalRational(value);
      const blocked = result.status === 'blocked-input' || value === null;
      fields.push(
        FinanceTaxRunFieldSchema.parse({
          id,
          form: form.id,
          line: calculated.key,
          label: `${form.id} line ${calculated.key}`,
          dependencies: sourceRow?.dependencies ?? calculated.sourceFactKeys,
          sourceId: fieldSource(form.id, sourceRow?.sourceId),
          locator: sourceRow?.locator ?? `${form.id} line ${calculated.key}`,
          exactRational: exact ?? { numerator: '0', denominator: '1' },
          exactDecimal: value,
          reportableAmount: blocked ? null : value,
          reporting: {
            target: 'irs-2025-paper-field',
            policyVersion: 'new-york-2025-entered-whole-dollar-lines.1',
            status: blocked
              ? value === null
                ? 'field-proof-missing'
                : 'dependency-unresolved'
              : 'lossless-at-proven-precision',
            rounding: 'none-lossless',
            blockedDependencies: blocked
              ? (sourceRow?.dependencies ?? calculated.sourceFactKeys)
              : [],
            sourceId: fieldSource(form.id, sourceRow?.sourceId),
            fieldPath: `${form.id}.${calculated.key}`,
          },
        }),
      );
    }
  }
  return fields;
}

function parseRequest(
  federalInput: unknown,
  newYorkInput: unknown,
): {
  federal: FinanceTaxIntake | null;
  newYork: FinanceTaxIntake | null;
  issues: ReturnType<typeof issue>[];
} {
  const federal = FinanceTaxIntakeSchema.safeParse(federalInput);
  const newYork = FinanceTaxIntakeSchema.safeParse(newYorkInput);
  const issues: ReturnType<typeof issue>[] = [];
  if (!federal.success)
    issues.push(
      issue(
        'invalid-federal-intake',
        'federalInput',
        'Federal tax intake and source lineage are invalid.',
      ),
    );
  if (!newYork.success)
    issues.push(
      issue(
        'invalid-new-york-intake',
        'newYorkInput',
        'New York tax intake and source lineage are invalid.',
      ),
    );
  return {
    federal: federal.success ? federal.data : null,
    newYork: newYork.success ? newYork.data : null,
    issues,
  };
}

function scopeIssues(
  federal: FinanceTaxIntake,
  newYork: FinanceTaxIntake,
  options: PrivateNewYorkWorkingPaperOptions,
) {
  const issues: ReturnType<typeof issue>[] = [];
  const same = (
    key: 'workspaceId' | 'caseId' | 'taxSubjectId' | 'revision',
  ) => {
    if (federal[key] !== newYork[key])
      issues.push(
        issue(
          'federal-new-york-binding-mismatch',
          key,
          `Federal and New York ${key} must bind the exact same reviewed input revision.`,
        ),
      );
  };
  same('workspaceId');
  same('caseId');
  same('taxSubjectId');
  same('revision');
  if (
    usReviewContentHash(federal.scope) !==
    usReviewContentHash(US_2025_CANDIDATE.scope)
  )
    issues.push(
      issue(
        'unsupported-federal-scope',
        'federalInput.scope',
        'The federal dependency must use the exact 2025 federal sole-proprietor scope.',
      ),
    );
  if (
    usReviewContentHash(newYork.scope) !== usReviewContentHash(NY_PRIVATE_SCOPE)
  )
    issues.push(
      issue(
        'unsupported-new-york-scope',
        'newYorkInput.scope',
        'The New York adapter requires the exact 2025 IT-201 scope.',
      ),
    );
  if (!sameBookSnapshots(federal.sourceBooks, newYork.sourceBooks))
    issues.push(
      issue(
        'federal-new-york-book-snapshot-mismatch',
        'sourceBooks',
        'Federal and New York inputs must bind the same explicit book snapshots.',
      ),
    );
  for (const [label, hash] of [
    ['snapshotHash', options.snapshotHash],
    ['federalSnapshotHash', options.federalSnapshotHash],
    ['newYorkSnapshotHash', options.newYorkSnapshotHash],
  ] as const)
    if (hash !== undefined && !Hash.test(hash))
      issues.push(
        issue(
          'invalid-snapshot-hash',
          label,
          'Snapshot hashes must be lowercase SHA-256 values.',
        ),
      );
  return issues;
}

/**
 * Prepare private New York working papers from two trusted, reviewed inputs.
 * Persistence must resolve the case permission, source-book authorizations,
 * and wage evidence before invoking this pure adapter.
 */
export function runPrivateNewYorkWorkingPapers(
  federalRaw: FinanceTaxIntake,
  newYorkRaw: FinanceTaxIntake,
  snapshotHashOrOptions: string | PrivateNewYorkWorkingPaperOptions,
  wageEvidence?: PrivateUsWageEvidence,
) {
  const options = normalizeOptions(snapshotHashOrOptions, wageEvidence);
  const parsed = parseRequest(federalRaw, newYorkRaw);
  const inputHash = usReviewContentHash({
    federalInput: federalRaw,
    newYorkInput: newYorkRaw,
  });
  const federalInputHash = usReviewContentHash(federalRaw);
  const newYorkInputHash = usReviewContentHash(newYorkRaw);
  const bindingIssues =
    parsed.federal && parsed.newYork
      ? scopeIssues(parsed.federal, parsed.newYork, options)
      : [];

  let federalResult: ReturnType<typeof runPrivateUsWorkingPapers> | null = null;
  let newYorkResult: ReturnType<
    typeof evaluateNewYork2025WorkingPapers
  > | null = null;
  if (parsed.federal) {
    try {
      federalResult = runPrivateUsWorkingPapers(
        parsed.federal,
        options.federalSnapshotHash ?? options.snapshotHash,
        options.wageEvidence,
      );
    } catch (error) {
      parsed.issues.push(
        issue(
          'federal-working-papers-unavailable',
          'federalInput',
          error instanceof Error
            ? error.message
            : 'Federal working papers could not be prepared.',
        ),
      );
    }
  }
  if (parsed.federal && parsed.newYork) {
    try {
      newYorkResult = evaluateNewYork2025WorkingPapers(
        parsed.federal,
        parsed.newYork,
      );
    } catch (error) {
      parsed.issues.push(
        issue(
          'new-york-working-papers-unavailable',
          'newYorkInput',
          error instanceof Error
            ? error.message
            : 'New York working papers could not be prepared.',
        ),
      );
    }
  }

  const issues = [
    ...parsed.issues,
    ...bindingIssues,
    ...(federalResult?.status === 'blocked'
      ? [
          issue(
            'federal-working-papers-blocked',
            'federalInput',
            'The New York component requires a resolved federal working-paper dependency.',
          ),
        ]
      : []),
    ...(newYorkResult?.evaluation.issues.map((entry) =>
      issue(entry.code, 'newYorkInput', entry.message),
    ) ?? []),
  ];
  const fields = newYorkResult ? prepareFields(newYorkResult) : [];
  const status =
    !federalResult ||
    !newYorkResult ||
    federalResult.status === 'blocked' ||
    newYorkResult.status === 'blocked-input' ||
    bindingIssues.length ||
    parsed.issues.length
      ? ('blocked' as const)
      : ('review-calculation-produced' as const);
  const sources = [
    ...US_2025_SOURCES.map((source: (typeof US_2025_SOURCES)[number]) => ({
      ...source,
      formVersion: '2025',
    })),
    ...NY_2025_SOURCES.map((source: (typeof NY_2025_SOURCES)[number]) => ({
      ...source,
      formVersion: '2025',
    })),
  ];
  const sourceBooks = {
    federal: parsed.federal
      ? canonicalBookSnapshots(parsed.federal.sourceBooks)
      : [],
    newYork: parsed.newYork
      ? canonicalBookSnapshots(parsed.newYork.sourceBooks)
      : [],
  };
  const body = {
    adapterVersion: NY_PRIVATE_ADAPTER_VERSION,
    workflowId: NY_PRIVATE_WORKFLOW_ID,
    packageVersion: NY_PRIVATE_PACKAGE_VERSION,
    packageHash: NY_PRIVATE_PACKAGE_HASH,
    jurisdiction: NY_PRIVATE_SCOPE,
    complete: false as const,
    enabled: false as const,
    reportable: false as const,
    status,
    inputSnapshot: newYorkRaw,
    federalInputSnapshot: federalRaw,
    inputHash,
    federalInputHash,
    newYorkInputHash,
    inputBinding: {
      workspaceId: parsed.newYork?.workspaceId ?? newYorkRaw.workspaceId,
      caseId: parsed.newYork?.caseId ?? newYorkRaw.caseId,
      taxSubjectId: parsed.newYork?.taxSubjectId ?? newYorkRaw.taxSubjectId,
      federalRevision: parsed.federal?.revision ?? newYorkRaw.revision,
      newYorkRevision: parsed.newYork?.revision ?? newYorkRaw.revision,
      snapshotRevision: parsed.newYork?.revision ?? newYorkRaw.revision,
      snapshotHash: options.snapshotHash,
      federalSnapshotHash: options.federalSnapshotHash ?? options.snapshotHash,
      newYorkSnapshotHash: options.newYorkSnapshotHash ?? options.snapshotHash,
      sourceBooks,
      sourceBooksHash: usReviewContentHash(sourceBooks),
      federalInputHash,
      newYorkInputHash,
    },
    fields,
    physicalFields: newYorkResult?.physicalCoverage?.fields ?? [],
    attachmentForms: newYorkResult?.attachmentCoverage?.forms ?? [],
    sources,
    reportingPolicyVersion: 'new-york-2025-entered-whole-dollar-lines.1',
    ruleSet: {
      candidateVersion: NY_2025_CANDIDATE.version,
      candidateHash: usReviewContentHash(NY_2025_CANDIDATE),
      federalCandidateVersion: US_2025_CANDIDATE.version,
      federalCandidateHash: usReviewContentHash(US_2025_CANDIDATE),
      sourceHashes: sources.map((source) => ({
        id: source.id,
        documentHash: source.documentHash,
      })),
    },
    questions: NY_PRIVATE_QUESTIONS,
    issues,
    releaseBlockers: [
      'new-york-full-return-validation-not-complete',
      'new-york-state-and-local-return-not-enabled',
      ...NY_2025_CANDIDATE.remaining,
      ...(federalResult?.releaseBlockers ?? []),
    ],
    finalAmounts: { refund: null, balanceOwing: null },
    federalResult,
    newYorkResult,
    sourceLineage: {
      federalOutputHash: federalResult?.runHash ?? null,
      federalDomainOutputHash: federalResult?.usResult.outputHash ?? null,
      newYorkDomainOutputHash: newYorkResult?.outputHash ?? null,
      federalWageEvidence: options.wageEvidence
        ? {
            reference: options.wageEvidence.reference,
            revision: options.wageEvidence.revision,
          }
        : null,
    },
  };
  return { ...body, runHash: usReviewContentHash(body) };
}

/** Compatibility spelling for callers that name the jurisdiction first. */
export const runPrivateNyWorkingPapers = runPrivateNewYorkWorkingPapers;

export function exportPrivateNewYorkWorkingPapers(
  run: ReturnType<typeof runPrivateNewYorkWorkingPapers>,
) {
  const { runHash, ...body } = run;
  if (!Hash.test(runHash) || usReviewContentHash(body) !== runHash)
    throw Error('new-york-export-integrity');
  if (run.status === 'blocked')
    throw Error('new-york-export-integrity-or-inputs');
  const quote = (value: unknown) => {
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    const safe = /^[\s]*[=+@-]/.test(raw) ? `'${raw}` : raw;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  const lines = [
    'Private US-NY working papers; incomplete return; state and local filing disabled; signature unperformed',
    `Run hash,${runHash}`,
    `Package version,${run.packageVersion}`,
    `Package hash,${run.packageHash}`,
    `Federal input hash,${run.federalInputHash}`,
    `New York input hash,${run.newYorkInputHash}`,
    `Federal output hash,${run.sourceLineage.federalOutputHash ?? ''}`,
    `New York output hash,${run.sourceLineage.newYorkDomainOutputHash ?? ''}`,
    'Form,Field,Reportable USD,Exact numerator,Exact denominator,Source,Locator',
    ...run.fields.map((field) =>
      [
        field.form,
        field.line,
        field.reportableAmount ?? '',
        field.exactRational.numerator,
        field.exactRational.denominator,
        field.sourceId,
        field.locator,
      ]
        .map(quote)
        .join(','),
    ),
    'Physical NY form fields',
    ...run.physicalFields.map((field) =>
      [
        'IT-201',
        field.fieldId,
        field.status,
        field.value ?? '',
        field.sourceId,
        field.sourceHash,
        field.reason,
      ]
        .map(quote)
        .join(','),
    ),
    'Attachment form fields',
    ...run.attachmentForms.flatMap((form) =>
      form.fields.map((field) =>
        [
          form.formId,
          field.fieldId,
          field.status,
          field.value ?? '',
          field.sourceId,
          field.sourceHash,
          field.reason,
        ]
          .map(quote)
          .join(','),
      ),
    ),
    'Rule source hashes',
    ...run.ruleSet.sourceHashes.map((source) =>
      [source.id, source.documentHash].map(quote).join(','),
    ),
  ];
  const content = lines.join('\n');
  return {
    filename: `us-ny-2025-${run.inputBinding.caseId}-review.csv`,
    mimeType: 'text/csv' as const,
    content,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

export const exportPrivateNyWorkingPapers = exportPrivateNewYorkWorkingPapers;

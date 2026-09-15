import { createHash } from 'node:crypto';
import { deepFreeze } from '@emdo/contracts';
import { z } from 'zod';
import { auditJapan2025FormApplicability } from './form-applicability.js';
import { applyJapan2025SelectedReporting } from './reporting.js';
import type { Japan2025Run } from './workflow.js';

const Hash = z.string().regex(/^[a-f0-9]{64}$/);

export const Japan2025SelectedReturnReviewSchema = z.strictObject({
  reviewerId: z.uuid(),
  reviewedAt: z.iso.datetime(),
  runHash: Hash,
  auditHash: Hash,
});

type Japan2025FormAudit = ReturnType<typeof auditJapan2025FormApplicability>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

const digest = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');

function quote(value: string): string {
  // A CSV export is also opened by spreadsheet software.  Prefix formula-like
  // strings so a payer name or source reference cannot become a formula.
  const safe =
    /^[\s]*[=+@-]/.test(value) || /^[\t\r\n]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

const row = (...values: (string | number | boolean | null | undefined)[]) =>
  values.map((value) => quote(value == null ? '' : String(value))).join(',');

function verifyAudit(audit: Japan2025FormAudit): void {
  const { auditHash, ...body } = audit;
  if (digest(body) !== auditHash)
    throw new Error('japan-form-audit-hash-mismatch');
}

function verifyBinding(run: Japan2025Run, audit: Japan2025FormAudit): void {
  if (audit.runHash !== run.outputHash)
    throw new Error('japan-export-run-hash-mismatch');
  verifyAudit(audit);
  if (run.status === 'blocked-input')
    throw new Error('japan-export-has-blocking-inputs');
  if (!audit.selectedComplete)
    throw new Error('japan-export-selected-form-not-ready');
}

type ExportableJapan2025Field = {
  readonly form: string;
  readonly line: string;
  readonly label: string;
  readonly kind: string;
  readonly decision: string;
  readonly value: string | boolean | null;
  readonly exactRational: {
    readonly numerator: string;
    readonly denominator: string;
  } | null;
  readonly exactYen: string | null;
  readonly reportableAmount: string | null;
  readonly dependencies: readonly string[];
  readonly sourceFactKeys: readonly string[];
  readonly sourceId: string | null;
  readonly fieldPath: string | null;
  readonly reporting: {
    readonly status: string;
    readonly policyVersion: string;
  };
};

function exportRows(fields: ReadonlyArray<ExportableJapan2025Field>) {
  return fields.map((field) =>
    row(
      field.form,
      field.line,
      field.label,
      field.kind,
      field.decision,
      field.value,
      field.exactRational?.numerator,
      field.exactRational?.denominator,
      field.exactYen,
      field.reportableAmount,
      field.dependencies.join(';'),
      field.sourceFactKeys.join(';'),
      field.sourceId,
      field.fieldPath,
      field.reporting.status,
      field.reporting.policyVersion,
    ),
  );
}

/**
 * Export a deterministic selected national Form 1/Form 2 working report.
 * The export is deliberately fileable=false even when selectedComplete=true:
 * the national/local full return, taxpayer signature and filing submission
 * remain outside this package.
 */
export function exportJapan2025SelectedReturn(
  run: Japan2025Run,
  audit: Japan2025FormAudit,
) {
  verifyBinding(run, audit);
  const reporting = applyJapan2025SelectedReporting(run, audit);
  const sources = run.sources.map((source) =>
    row(
      source.id,
      source.title,
      source.documentHash,
      source.url,
      source.retrievedAt,
      source.locator,
    ),
  );
  const content = [
    row(
      'Report kind',
      'Japan 2025 selected national salary Form 1/Form 2 working report; NOT A COMPLETE RETURN; NOT FILEABLE',
    ),
    row('Status', 'selected-national-working-report-not-fileable'),
    row('Package version', run.candidate.version),
    row('Run output hash', run.outputHash),
    row('Form audit hash', audit.auditHash),
    row('Input hash', run.inputHash),
    row('Selected branch complete', audit.selectedComplete),
    row('Full return complete', false),
    row('Reportable', false),
    row('Fileable', false),
    row('Source id', 'Title', 'SHA-256', 'URL', 'Retrieved at', 'Locator'),
    ...sources,
    row(
      'Form',
      'Field path',
      'Label',
      'Kind',
      'Applicability decision',
      'Value',
      'Exact numerator',
      'Exact denominator',
      'Exact JPY',
      'Reportable amount',
      'Dependencies',
      'Source fact keys',
      'Source id',
      'Field path',
      'Reporting status',
      'Reporting policy',
    ),
    ...exportRows(reporting.fields),
    row(
      'Full-return gap',
      'Local tax, schedules, Form 3/Form 4, signature and filing remain outside selected working report',
    ),
    ...audit.fullReturnGaps.map((gap) => row('Full-return gap field', gap)),
  ].join('\n');
  return deepFreeze({
    filename: `jp-2025-${run.inputSnapshot?.caseId ?? 'invalid'}-selected-national-review.csv`,
    mimeType: 'text/csv' as const,
    status: 'selected-national-working-report-not-fileable' as const,
    complete: false as const,
    selectedComplete: true as const,
    fullReturnComplete: false as const,
    reportable: false as const,
    fileable: false as const,
    runHash: run.outputHash,
    auditHash: audit.auditHash,
    inputHash: run.inputHash,
    content,
    sha256: createHash('sha256').update(content).digest('hex'),
  });
}

export type Japan2025SelectedReturnExport = ReturnType<
  typeof exportJapan2025SelectedReturn
>;

/** Reviewer identity is supplied by trusted persistence; it does not make a return fileable. */
export function reviewJapan2025SelectedReturnExport(
  run: Japan2025Run,
  audit: Japan2025FormAudit,
  raw: unknown,
) {
  verifyBinding(run, audit);
  const review = Japan2025SelectedReturnReviewSchema.parse(raw);
  if (review.runHash !== run.outputHash || review.auditHash !== audit.auditHash)
    throw new Error('japan-selected-review-binding-mismatch');
  const exported = exportJapan2025SelectedReturn(run, audit);
  const body = {
    schemaVersion: 1 as const,
    status: 'reviewed-selected-national-working-report-not-fileable' as const,
    complete: false as const,
    selectedComplete: true as const,
    fullReturnComplete: false as const,
    reportable: false as const,
    fileable: false as const,
    review,
    export: exported,
  };
  return deepFreeze({ ...body, reviewHash: digest(body) });
}

export function exportReviewedJapan2025SelectedReturn(
  review: ReturnType<typeof reviewJapan2025SelectedReturnExport>,
) {
  const { reviewHash, ...body } = review;
  if (digest(body) !== reviewHash)
    throw new Error('japan-reviewed-export-hash-mismatch');
  return deepFreeze({
    ...review.export,
    content:
      row('Reviewer', review.review.reviewerId) +
      '\n' +
      row('Reviewed at', review.review.reviewedAt) +
      '\n' +
      row('Review hash', reviewHash) +
      '\n' +
      review.export.content,
    reviewHash,
  });
}

export const exportJapan2025SelectedWorkingReport =
  exportJapan2025SelectedReturn;

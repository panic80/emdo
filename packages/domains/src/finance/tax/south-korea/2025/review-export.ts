import { createHash } from 'node:crypto';
import { deepFreeze } from '@emdo/contracts';
import {
  auditSouthKorea2025FormApplicability,
  SOUTH_KOREA_2025_ACTUAL_FORMS,
  SOUTH_KOREA_2025_FORM_FIELD_CATALOG,
  SOUTH_KOREA_2025_FORM_INVENTORY_VERSION,
  type SouthKorea2025FormReviewInput,
} from './form-inventory.js';
import { SOUTH_KOREA_2025_SOURCES } from './sources.js';

/** Review-export version; changes when the exported evidence contract changes. */
export const SOUTH_KOREA_2025_REVIEW_EXPORT_VERSION =
  '2025-nts-form-review-export.1';

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

const hash = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');

/**
 * Produce a deterministic review artifact from source-bound NTS fields and
 * byte-hashed attachments.  The export can say that the selected salary
 * subset is ready for review while always keeping full-return and filing
 * authorization false.
 */
export function buildSouthKorea2025ReviewExport(raw: unknown) {
  const audit = auditSouthKorea2025FormApplicability(raw);
  const input =
    raw !== null && typeof raw === 'object'
      ? (raw as Partial<SouthKorea2025FormReviewInput>)
      : {};
  const sourceBindings = SOUTH_KOREA_2025_SOURCES.map((source) => ({
    id: source.id,
    authority: source.authority,
    title: source.title,
    url: source.url,
    retrievedAt: source.retrievedAt,
    documentHash: source.documentHash,
    locator: source.locator,
  }));
  const forms = SOUTH_KOREA_2025_ACTUAL_FORMS.map((form) => ({
    ...form,
    authorityDocumentHash:
      sourceBindings.find((source) => source.id === form.sourceId)
        ?.documentHash ?? null,
    fields: SOUTH_KOREA_2025_FORM_FIELD_CATALOG.filter(
      (field) => field.formId === form.id,
    ).map((field) => field.id),
  }));
  const blockers = [
    ...audit.issues.map((entry) => entry.code),
    ...audit.fullReturnGaps,
    'full-return-not-attested',
    'filing-submission-not-authorized',
    'local-authority-subdivision-and-payment-proof-missing',
  ].filter((value, index, values) => values.indexOf(value) === index);
  const body = {
    version: SOUTH_KOREA_2025_REVIEW_EXPORT_VERSION,
    country: 'KR' as const,
    subdivision: 'KR-NATIONAL' as const,
    taxYear: 2025 as const,
    inventoryVersion: SOUTH_KOREA_2025_FORM_INVENTORY_VERSION,
    packageVersion: audit.packageVersion,
    packageCandidateComplete: false as const,
    supportedCaseComplete: audit.selectedComplete,
    fullReturnComplete: false as const,
    filingAuthorized: false as const,
    reportable: false as const,
    status: audit.selectedComplete
      ? ('reviewed-supported-salary-case' as const)
      : ('blocked-review' as const),
    forms,
    fields: audit.fields,
    attachments: audit.attachments,
    requirements: audit.requirements,
    sourceBindings,
    nationalEvaluationHash: audit.runHash,
    intakeHash: audit.intakeHash,
    auditHash: audit.auditHash,
    blockers,
    fullReturnGaps: audit.fullReturnGaps,
    remainingProof: audit.remainingProof,
    inputHash: input.intake === undefined ? null : hash(input.intake),
  };
  return deepFreeze({ ...body, exportHash: hash(body) });
}

export const exportSouthKorea2025Review = buildSouthKorea2025ReviewExport;
export const prepareSouthKorea2025ReviewExport =
  buildSouthKorea2025ReviewExport;

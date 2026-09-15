import { z } from 'zod';
import {
  FinanceStandardizationAvailabilitySchema,
  FinanceStandardizationListSchema,
  FinanceStandardizationRunSchema,
  StartFinanceStandardizationSchema,
  ChangeFinanceStandardizationSchema,
  UuidSchema,
  UploadFinanceBookEvidenceSchema,
  type FinanceStandardizationRun,
} from '@emdo/contracts/browser';
import { binaryBookOriginal } from './finance-book-evidence-files.js';
import {
  financeImageMime,
  imageStandardizationUpload,
  isFinanceImage,
} from './finance-image-review-api.js';
import { saveMemoryFile } from '../../downloads/save-memory-file.js';

export type StandardizationAvailability = z.infer<
  typeof FinanceStandardizationAvailabilitySchema
>;
export type StandardizationSource = {
  id: string;
  filename: string;
  format: string;
  sourceDigest?: string;
};
export const StandardizationUploadReceiptSchema = z.object({
  id: UuidSchema,
  sourceDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
});
export class StandardizationRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export const standardizationBase = (bookId: string) =>
  `/api/v2/finance/books/${bookId}`;
export async function standardizationJson(
  path: string,
  signal: AbortSignal,
  init: RequestInit = {},
) {
  if (signal.aborted) throw new DOMException('Request aborted', 'AbortError');
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...init,
    signal,
  });
  if (!response.ok) {
    const problem = z
      .object({ code: z.string().optional() })
      .safeParse(await response.json().catch(() => null));
    throw new StandardizationRequestError(
      response.status,
      problem.success ? (problem.data.code ?? '') : '',
      response.status === 401
        ? 'Sign in again to access saved report analyses.'
        : response.status === 403
          ? 'Current book access does not permit this analysis. Previously loaded details have been cleared.'
          : response.status === 409
            ? 'This saved analysis or its authorization changed. Refresh and review its current state before continuing.'
            : response.status === 503
              ? 'Saved report analysis is not available right now. Your original and manual review paths remain available.'
              : response.status === 404
                ? 'This saved analysis is no longer available.'
                : 'The analysis request could not be completed. Refresh saved analyses before trying again.',
    );
  }
  const value: unknown = await response.json();
  if (signal.aborted) throw new DOMException('Request aborted', 'AbortError');
  return value;
}
export function verifyStandardizationRun(
  raw: unknown,
  bookId: string,
  expected?: { id?: string; evidenceId?: string; sourceDigest?: string },
) {
  const run = FinanceStandardizationRunSchema.parse(raw);
  if (
    run.bookId !== bookId ||
    (expected?.id && run.id !== expected.id) ||
    (expected?.evidenceId && run.evidenceId !== expected.evidenceId) ||
    (expected?.sourceDigest && run.sourceDigest !== expected.sourceDigest) ||
    (run.extraction && run.extraction.sourceDigest !== run.sourceDigest)
  )
    throw new Error(
      'The saved analysis and its original source could not be verified. Refresh this book.',
    );
  return run;
}
export async function readStandardizationOptions(
  bookId: string,
  signal: AbortSignal,
) {
  return FinanceStandardizationAvailabilitySchema.parse(
    await standardizationJson(
      `${standardizationBase(bookId)}/standardizations/options`,
      signal,
    ),
  );
}
export async function readStandardizationList(
  bookId: string,
  offset: number,
  signal: AbortSignal,
) {
  const value = FinanceStandardizationListSchema.parse(
    await standardizationJson(
      `${standardizationBase(bookId)}/standardizations?offset=${offset}`,
      signal,
    ),
  );
  if (new Set(value.runs.map((run) => run.id)).size !== value.runs.length)
    throw new Error('Saved analysis records could not be verified.');
  value.runs.forEach((run) => verifyStandardizationRun(run, bookId));
  return value;
}
export async function readStandardizationRun(
  bookId: string,
  id: string,
  signal: AbortSignal,
) {
  return verifyStandardizationRun(
    await standardizationJson(
      `${standardizationBase(bookId)}/standardizations/${id}`,
      signal,
    ),
    bookId,
    { id },
  );
}
/** Keep uncertain request keys only in component memory; the server deduplicates durable starts across reloads. */
export function standardizationMutation() {
  let pending: { signature: string; key: string } | undefined;
  return async <T>(
    path: string,
    payload: unknown,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    csrfToken?: string,
  ) => {
    if (!csrfToken)
      throw new Error('Sign in again before saving or changing an analysis.');
    const body = JSON.stringify(payload),
      signature = `${path}:${body}`;
    if (pending?.signature !== signature)
      pending = { signature, key: crypto.randomUUID() };
    const result = schema.parse(
      await standardizationJson(path, signal, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrfToken,
          'idempotency-key': pending.key,
        },
        body,
      }),
    );
    pending = undefined;
    return result;
  };
}
export const standardizationStart = (source: StandardizationSource) =>
  StartFinanceStandardizationSchema.parse({
    evidenceId: source.id,
    expectedSourceDigest: source.sourceDigest,
  });
export const standardizationChange = (run: FinanceStandardizationRun) =>
  ChangeFinanceStandardizationSchema.parse({ expectedRevision: run.revision });
export async function standardizationUpload(file: File) {
  if (!file.size || file.size > 2097152)
    throw new Error(
      'Choose a nonempty report or image original no larger than 2 MiB.',
    );
  const format = file.name.toLowerCase().split('.').pop();
  if (format === 'xlsx' || format === 'pdf')
    return binaryBookOriginal(file, format);
  if (
    format === 'png' ||
    format === 'jpeg' ||
    format === 'jpg' ||
    format === 'webp'
  )
    return imageStandardizationUpload(file, format === 'jpg' ? 'jpeg' : format);
  if (format !== 'csv')
    throw new Error(
      'Choose CSV, XLSX, PDF, PNG, JPEG or WebP. Use Documents for supported OFX/QFX or structured invoices.',
    );
  return UploadFinanceBookEvidenceSchema.parse({
    filename: file.name,
    format,
    sourceText: new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(await file.arrayBuffer()),
  });
}
export async function readStandardizationOriginal(
  run: Pick<
    FinanceStandardizationRun,
    'bookId' | 'evidenceId' | 'format' | 'sourceDigest'
  >,
  signal: AbortSignal,
) {
  const raw = z
    .object({
      filename: z.string().min(1).max(200),
      format: z.string(),
      sourceText: z.string().max(2097152).optional(),
      sourceBase64: z.string().max(2796204).optional(),
    })
    .parse(
      await standardizationJson(
        `${standardizationBase(run.bookId)}/evidence/${run.evidenceId}`,
        signal,
      ),
    );
  if (raw.format !== run.format)
    throw new Error('The original format does not match this analysis.');
  const bytes =
    raw.sourceBase64 !== undefined
      ? Uint8Array.from(atob(raw.sourceBase64), (character) =>
          character.charCodeAt(0),
        )
      : raw.sourceText !== undefined
        ? new TextEncoder().encode(raw.sourceText)
        : new Uint8Array();
  if (!bytes.length || bytes.length > 2097152)
    throw new Error('The original download could not be verified.');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const actual = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  if (actual !== run.sourceDigest)
    throw new Error(
      'The original does not match the saved analysis fingerprint. No file was downloaded.',
    );
  if (signal.aborted) throw new DOMException('Request aborted', 'AbortError');
  return { ...raw, bytes };
}
export async function downloadStandardizationOriginal(
  run: Pick<
    FinanceStandardizationRun,
    'bookId' | 'evidenceId' | 'format' | 'sourceDigest'
  >,
  signal: AbortSignal,
) {
  const raw = await readStandardizationOriginal(run, signal);
  if (signal.aborted) return;
  saveMemoryFile(
    raw.filename,
    raw.bytes,
    isFinanceImage(raw.format)
      ? financeImageMime(raw.format)
      : raw.format === 'pdf'
        ? 'application/pdf'
        : raw.format === 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'text/csv',
  );
}

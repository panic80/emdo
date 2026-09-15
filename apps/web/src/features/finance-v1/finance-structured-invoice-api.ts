import { z } from 'zod';
import {
  StructuredInvoiceExtractionSchema,
  PostReviewedStructuredInvoiceSchema,
  StructuredInvoiceReviewDraftSchema,
  StructuredInvoiceReviewDraftRecordSchema,
  FinanceCurrencySchema,
  FinanceDecimalSchema,
  UuidSchema,
} from '@emdo/contracts/browser';
export type InvoiceSource = z.infer<typeof StructuredInvoiceExtractionSchema>;
export type InvoiceReview = z.infer<typeof PostReviewedStructuredInvoiceSchema>;
export type InvoiceDraft = z.infer<typeof StructuredInvoiceReviewDraftSchema>;
const EvidencePage = z.object({
  documents: z
    .array(
      z.object({
        id: UuidSchema,
        filename: z.string().max(200),
        format: z.string(),
      }),
    )
    .max(50),
  nextOffset: z.number().int().min(0).nullable(),
});
const Parties = z.object({
  parties: z.array(
    z.object({
      id: UuidSchema,
      name: z.string(),
      kind: z.string(),
      reference: z.string(),
    }),
  ),
});
export class InvoiceRequestError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401 || status === 403
        ? 'Current book access does not permit this invoice operation.'
        : status === 409
          ? 'The source, accounting state or posting changed. Refresh the source and accounting records before proceeding.'
          : status === 503
            ? 'Structured invoice processing is unavailable in this environment.'
            : status === 400 || status === 422
              ? 'The XML or reviewed invoice does not meet the supported input requirements.'
              : 'The request could not be confirmed. Retry the same request to confirm its result.',
    );
  }
}
async function request(
  book: string,
  path: string,
  signal: AbortSignal,
  write?: { body: unknown; csrf: string; key: string },
) {
  const response = await fetch(`/api/v2/finance/books/${book}${path}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    ...(write
      ? {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': write.csrf,
            'idempotency-key': write.key,
          },
          body: JSON.stringify(write.body),
        }
      : {}),
  });
  if (!response.ok) throw new InvoiceRequestError(response.status);
  return response.json() as Promise<unknown>;
}
export async function readInvoiceLibrary(
  book: string,
  offset: number,
  signal: AbortSignal,
) {
  const [evidence, parties] = await Promise.all([
    request(book, `/evidence?offset=${offset}`, signal),
    request(book, '/commercial', signal),
  ]);
  const page = EvidencePage.parse(evidence);
  return {
    ...page,
    documents: page.documents.filter(
      (d) => d.format === 'ubl' || d.format === 'cii',
    ),
    parties: Parties.parse(parties).parties,
  };
}
export async function uploadInvoice(
  book: string,
  body: { filename: string; format: 'ubl' | 'cii'; sourceText: string },
  csrf: string,
  key: string,
  signal: AbortSignal,
) {
  if (new TextEncoder().encode(body.sourceText).length > 2097152)
    throw new Error('The XML exceeds the 2 MiB upload limit.');
  return z
    .object({ id: UuidSchema })
    .parse(await request(book, '/evidence', signal, { body, csrf, key }));
}
export async function inspectInvoice(
  book: string,
  id: string,
  signal: AbortSignal,
) {
  return StructuredInvoiceExtractionSchema.parse(
    await request(book, `/evidence/${id}/structured-invoice`, signal),
  );
}
export async function postInvoice(
  book: string,
  id: string,
  review: InvoiceReview,
  csrf: string,
  key: string,
  signal: AbortSignal,
) {
  const result = z
    .strictObject({
      id: UuidSchema,
      journalId: UuidSchema,
      total: FinanceDecimalSchema,
      currency: FinanceCurrencySchema,
      evidenceId: UuidSchema,
      sourceDigest: z.string(),
      adapterVersion: z.literal('structured-invoice.v1'),
    })
    .parse(
      await request(
        book,
        `/evidence/${id}/structured-invoice/review-and-post`,
        signal,
        { body: PostReviewedStructuredInvoiceSchema.parse(review), csrf, key },
      ),
    );
  if (
    result.evidenceId !== id ||
    result.sourceDigest !== review.expectedSourceDigest
  )
    throw new Error(
      'The posting response does not match the reviewed source. Retry to confirm the same request.',
    );
  return result;
}

export async function readInvoiceDraft(
  book: string,
  id: string,
  signal: AbortSignal,
) {
  return z
    .strictObject({
      review: StructuredInvoiceReviewDraftRecordSchema.nullable(),
      posting: z
        .object({
          id: UuidSchema,
          journalId: UuidSchema,
          status: z.enum(['issued', 'void']),
          total: FinanceDecimalSchema,
          currency: FinanceCurrencySchema,
        })
        .nullable(),
    })
    .parse(
      await request(
        book,
        `/evidence/${id}/structured-invoice/review-draft`,
        signal,
      ),
    );
}
export async function saveInvoiceDraft(
  book: string,
  id: string,
  draft: InvoiceDraft,
  expectedRevision: number,
  csrf: string,
  key: string,
  signal: AbortSignal,
) {
  const result = StructuredInvoiceReviewDraftRecordSchema.parse(
    await request(
      book,
      `/evidence/${id}/structured-invoice/review-draft`,
      signal,
      {
        body: {
          expectedRevision,
          draft: StructuredInvoiceReviewDraftSchema.parse(draft),
        },
        csrf,
        key,
      },
    ),
  );
  if (
    result.evidenceId !== id ||
    result.revision !== expectedRevision + 1 ||
    JSON.stringify(result.draft) !==
      JSON.stringify(StructuredInvoiceReviewDraftSchema.parse(draft))
  )
    throw new Error(
      'Saved review response differs from the submitted revision. Retry the same request.',
    );
  return result;
}

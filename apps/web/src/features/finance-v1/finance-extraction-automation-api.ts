import { z } from 'zod';
import {
  FinanceAutomationExtractionIntentSchema,
  FinanceAutomationExtractionResultSchema,
  type FinanceAutomationRunRecord,
  FinanceAutomationRunRecordSchema,
  UuidSchema,
  Sha256Schema,
  type FinanceAutomationGrant,
  type FinanceAutomationExtractionIntent,
} from '@emdo/contracts/browser';
export const ExtractionDocumentSchema = z.object({
  id: UuidSchema,
  filename: z.string().min(1),
  format: z.string(),
  sourceDigest: Sha256Schema.optional(),
});
export type ExtractionDocument = z.infer<typeof ExtractionDocumentSchema>;
export class ExtractionAutomationError extends Error {
  constructor(readonly status: number) {
    super(
      [401, 403].includes(status)
        ? 'Current access does not permit document extraction.'
        : status === 409
          ? 'The document or grant changed. Refresh and review the scope again.'
          : 'The extraction request could not be confirmed. Retry the same request.',
    );
  }
}
async function request(
  bookId: string,
  path: string,
  signal: AbortSignal,
  mutation?: { body: unknown; csrf: string; key: string },
) {
  UuidSchema.parse(bookId);
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const response = await fetch(`/api/v2/finance/books/${bookId}${path}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    ...(mutation
      ? {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': mutation.csrf,
            'idempotency-key': mutation.key,
          },
          body: JSON.stringify(mutation.body),
        }
      : {}),
  });
  if (!response.ok) throw new ExtractionAutomationError(response.status);
  const value: unknown = await response.json();
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  return value;
}
export async function readExtractionDocuments(
  bookId: string,
  offset: number,
  signal: AbortSignal,
) {
  return z
    .object({
      documents: z.array(ExtractionDocumentSchema),
      nextOffset: z.number().int().nonnegative().nullable(),
    })
    .parse(
      await request(bookId, `/evidence?offset=${offset}&limit=50`, signal),
    );
}
export async function prepareExtractionIntent(
  bookId: string,
  document: ExtractionDocument,
  csrf: string,
  key: string,
  signal: AbortSignal,
) {
  const sourceDigest = Sha256Schema.parse(document.sourceDigest);
  const value = FinanceAutomationExtractionIntentSchema.parse(
    await request(bookId, '/automations/extractions/prepare', signal, {
      csrf,
      key,
      body: { evidenceId: document.id, expectedSourceDigest: sourceDigest },
    }),
  );
  if (
    value.evidenceId !== document.id ||
    value.expectedSourceDigest !== sourceDigest
  )
    throw new Error('Prepared extraction refers to a different original.');
  return value;
}
function scopedRun(raw: unknown, bookId: string) {
  const value = FinanceAutomationRunRecordSchema.parse(raw);
  if (
    value.run.request.bookId !== bookId ||
    value.run.request.capability !== 'finance.documents.extract' ||
    !value.run.request.extraction
  )
    throw new Error('Unexpected saved extraction run scope.');
  return value;
}
export async function enqueueExtractionRun(
  bookId: string,
  grant: FinanceAutomationGrant,
  intent: FinanceAutomationExtractionIntent,
  csrf: string,
  key: string,
  signal: AbortSignal,
) {
  if (
    grant.bookId !== bookId ||
    grant.status !== 'active' ||
    !grant.allowedCapabilities.includes('finance.documents.extract') ||
    Date.parse(grant.validFrom) > Date.now() ||
    Date.parse(grant.expiresAt) <= Date.now()
  )
    throw new Error('Select an active extraction grant for this book.');
  const extraction = FinanceAutomationExtractionIntentSchema.parse(intent);
  const value = scopedRun(
    await request(bookId, '/automations/runs', signal, {
      csrf,
      key,
      body: {
        grantId: grant.id,
        capability: 'finance.documents.extract',
        targets: [extraction.evidenceId],
        currency: grant.limits.currency,
        amount: '0',
        extraction,
      },
    }),
    bookId,
  );
  if (
    value.run.request.grantId !== grant.id ||
    value.run.request.grantRevision !== grant.revision ||
    value.run.request.currency !== grant.limits.currency ||
    value.run.request.amount !== '0' ||
    JSON.stringify(value.run.request.extraction) !==
      JSON.stringify(extraction) ||
    value.run.request.itemCount !== 1
  )
    throw new Error('Saved run does not match the reviewed extraction scope.');
  return value;
}
export async function readExtractionRun(
  bookId: string,
  operationId: string,
  signal: AbortSignal,
) {
  UuidSchema.parse(operationId);
  const value = scopedRun(
    await request(bookId, `/automations/runs/${operationId}`, signal),
    bookId,
  );
  if (value.run.request.operationId !== operationId)
    throw new Error('Unexpected saved extraction run.');
  return value;
}
export async function readExtractionRuns(bookId: string, signal: AbortSignal) {
  const value = z
    .object({
      runs: z.array(FinanceAutomationRunRecordSchema),
      nextOffset: z.number().int().nonnegative().nullable(),
    })
    .parse(
      await request(bookId, '/automations/runs?offset=0&limit=50', signal),
    );
  if (value.runs.some((item) => item.run.request.bookId !== bookId))
    throw new Error('Unexpected automation book scope.');
  return value.runs.filter(
    (item) => item.run.request.capability === 'finance.documents.extract',
  );
}

export async function readExtractionResult(
  bookId: string,
  saved: FinanceAutomationRunRecord,
  signal: AbortSignal,
) {
  const intent = saved.run.request.extraction;
  if (
    !intent ||
    saved.run.status !== 'completed' ||
    saved.run.outcomeReference !== saved.run.request.operationId
  )
    throw new Error('A completed extraction outcome is required.');
  const result = FinanceAutomationExtractionResultSchema.parse(
    await request(
      bookId,
      `/automations/extractions/results/${saved.run.outcomeReference}`,
      signal,
    ),
  );
  if (
    result.operationId !== saved.run.request.operationId ||
    result.bookId !== bookId ||
    result.workspaceId !== saved.run.request.workspaceId ||
    result.evidenceId !== intent.evidenceId ||
    result.sourceDigest !== intent.expectedSourceDigest ||
    result.standardizationRunId !== intent.standardizationRunId ||
    result.extractionRevision !==
      (intent.expectedExtractionRevision === 0
        ? 1
        : intent.expectedExtractionRevision)
  )
    throw new Error(
      'Saved extraction outcome does not match the reviewed original and revision.',
    );
  return result;
}

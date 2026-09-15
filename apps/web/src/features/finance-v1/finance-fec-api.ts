import { z } from 'zod';
import {
  FinanceFecMappingCreateSchema,
  FinanceFecExportRequestSchema,
} from '@emdo/contracts/browser';
import { saveMemoryFile } from '../../downloads/save-memory-file.js';
export const FecMapping = z.object({
  bookId: z.uuid(),
  revision: z.number().int().positive(),
  reviewedBy: z.uuid(),
  reviewedAt: z.iso.datetime(),
  mapping: FinanceFecMappingCreateSchema,
});
export const FecExport = z
  .object({
    status: z.enum(['ready', 'blocked']),
    review: z.object({
      errors: z.array(
        z.object({ code: z.string(), path: z.string(), message: z.string() }),
      ),
      entryCount: z.number(),
      lineCount: z.number(),
    }),
    file: z
      .object({
        fileName: z.string().regex(/^\d{9}FEC\d{8}\.txt$/),
        content: z.string(),
        byteLength: z.number().int(),
        encoding: z.literal('UTF-8'),
      })
      .nullable(),
  })
  .superRefine((v, c) => {
    if (
      (v.status === 'ready' &&
        (!v.file ||
          v.review.errors.length ||
          new TextEncoder().encode(v.file.content).length !==
            v.file.byteLength)) ||
      (v.status === 'blocked' && v.file)
    )
      c.addIssue({ code: 'custom', message: 'Invalid FEC file response' });
  });
export class FecRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function fecJson(
  bookId: string,
  path: string,
  signal: AbortSignal,
  init: RequestInit = {},
) {
  const response = await fetch(
    `/api/v2/finance/books/${encodeURIComponent(bookId)}/fec/${path}`,
    { credentials: 'same-origin', cache: 'no-store', ...init, signal },
  );
  if (!response.ok)
    throw new FecRequestError(
      response.status,
      response.status === 503
        ? 'France FEC is not enabled or ready in this environment.'
        : response.status === 409
          ? 'The mapping revision changed. Refresh and review it before saving again.'
          : response.status === 401 || response.status === 403
            ? 'Your current book access does not permit this action.'
            : response.status === 404
              ? 'This saved FEC export is unavailable.'
              : 'The FEC request failed. Review your inputs and retry.',
    );
  return response.json() as Promise<unknown>;
}
export async function readFecMapping(bookId: string, signal: AbortSignal) {
  const result = FecMapping.nullable().parse(
    await fecJson(bookId, 'mappings/latest', signal),
  );
  if (
    result &&
    (result.bookId !== bookId ||
      result.revision !== result.mapping.expectedRevision)
  )
    throw new Error('Mapping book or revision could not be verified.');
  return result;
}
export async function readFecExport(
  bookId: string,
  key: string,
  signal: AbortSignal,
) {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key))
    throw new Error('Enter a valid saved export key.');
  return FecExport.parse(
    await fecJson(bookId, `exports/${encodeURIComponent(key)}`, signal),
  );
}
export function fecMutation() {
  let pending: { signature: string; key: string } | undefined;
  return async (
    bookId: string,
    kind: 'mappings' | 'exports',
    input: unknown,
    csrf: string | undefined,
    signal: AbortSignal,
    onKey?: (key: string) => void,
  ) => {
    if (!csrf) throw new Error('Sign in again before saving.');
    const signature = JSON.stringify({ bookId, kind, input });
    if (pending?.signature !== signature)
      pending = { signature, key: crypto.randomUUID() };
    const payload =
      kind === 'mappings'
        ? FinanceFecMappingCreateSchema.parse(input)
        : FinanceFecExportRequestSchema.parse({
            ...(input as object),
            idempotencyKey: pending.key,
          });
    onKey?.(pending.key);
    const raw = await fecJson(bookId, kind, signal, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrf,
        'idempotency-key': pending.key,
      },
      body: JSON.stringify(payload),
    });
    const result =
      kind === 'mappings'
        ? z.object({ revision: z.number().int().positive() }).parse(raw)
        : FecExport.parse(raw);
    pending = undefined;
    return result;
  };
}
export function downloadFec(result: z.infer<typeof FecExport>) {
  const checked = FecExport.parse(result);
  if (checked.status !== 'ready' || !checked.file)
    throw new Error('Resolve the blocking review errors before downloading.');
  saveMemoryFile(
    checked.file.fileName,
    new TextEncoder().encode(checked.file.content),
    'text/plain;charset=utf-8',
  );
}

export const FecEvidencePage = z.object({
  documents: z
    .array(
      z.object({
        id: z.uuid(),
        filename: z.string(),
        format: z.string(),
        sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
        byteSize: z.number().int().nonnegative(),
        createdAt: z.string(),
      }),
    )
    .max(100),
  nextOffset: z.number().int().nonnegative().max(1000000).nullable(),
});
export async function readFecEvidence(
  bookId: string,
  offset: number,
  signal: AbortSignal,
) {
  const response = await fetch(
    `/api/v2/finance/books/${encodeURIComponent(bookId)}/evidence?offset=${offset}`,
    { credentials: 'same-origin', cache: 'no-store', signal },
  );
  if (!response.ok)
    throw new FecRequestError(
      response.status,
      'Uploaded book documents could not be loaded. Refresh or use an externally reviewed source.',
    );
  const value = FecEvidencePage.parse(await response.json());
  if (value.nextOffset !== null && value.nextOffset <= offset)
    throw new Error('Document pagination could not be verified.');
  return value;
}

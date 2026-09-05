import { z } from 'zod';

export type FinanceLocale = 'en-CA' | 'fr-CA' | 'ja-JP' | 'ko-KR';
export type FinanceDocumentSummary = Readonly<{
  schemaVersion: 1;
  id: string;
  documentType: string | null;
  displayName: string | null;
  mimeType: 'application/pdf' | 'image/jpeg' | 'image/png' | null;
  byteSize: number | null;
  plaintextSha256: string | null;
  sourceLocale: FinanceLocale | null;
  currency: string | null;
  extractionRevision: number | null;
  state:
    | 'uploaded'
    | 'extracting'
    | 'awaiting-review'
    | 'committed'
    | 'failed'
    | 'deleting'
    | 'deleted';
  createdAt: string;
  updatedAt: string;
}>;
export type FinanceDocumentDetail = Readonly<{
  schemaVersion: 1;
  document: FinanceDocumentSummary;
  reviewAvailable: boolean;
  matchCount: number;
}>;
export type FinanceDocumentList = Readonly<{
  schemaVersion: 1;
  items: readonly FinanceDocumentSummary[];
  nextCursor?: string;
}>;
/** A redacted, discriminated review envelope. Unknown fields are retained so
 * a browser review never drops a type-specific server field. */
export type FinanceDocumentEnvelopeV1 = Readonly<Record<string, unknown>> &
  Readonly<{
    schemaVersion: 1;
    documentType: string;
    sourceLocale: FinanceLocale;
    currency: string | null;
    total: Readonly<{ currency: string; minorUnits: number }> | null;
  }>;
export type FinanceDocumentReviewDraft = Readonly<{
  schemaVersion: 1;
  documentId: string;
  extractionRevision: number;
  envelope: FinanceDocumentEnvelopeV1;
  payloadHash: string;
  reviewToken: string;
  expiresAt: string;
}>;
export type FinanceDocumentMatchList = Readonly<{
  schemaVersion: 1;
  items: readonly Readonly<{
    id: string;
    documentId: string;
    recordType: string;
    scoreBasisPoints: number;
  }>[];
}>;
export type FinanceDocumentEvidenceList = Readonly<{
  schemaVersion: 1;
  items: readonly Readonly<{
    id: string;
    documentId: string;
    extractionRevision: number;
    page: number;
    excerpt: string;
    sourceLocale: FinanceLocale;
    locator: Readonly<Record<string, unknown>>;
  }>[];
}>;

type MutationAuthority = {
  readonly csrfToken: string;
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
};

// The currently exported finance schema barrel also exports server-only
// capability contracts. Keep the browser parser structurally identical while
// importing its public types only, until a browser-safe schema subpath exists.
const FinanceLocaleSchema = z.enum(['en-CA', 'fr-CA', 'ja-JP', 'ko-KR']);
const documentId = z.string().trim().min(1).max(512);
const money = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/u),
  minorUnits: z.number().int().safe(),
});
const summary = z.object({
  schemaVersion: z.literal(1),
  id: documentId,
  documentType: z.string().nullable(),
  displayName: z.string().trim().min(1).max(255).nullable(),
  mimeType: z.enum(['application/pdf', 'image/jpeg', 'image/png']).nullable(),
  byteSize: z
    .number()
    .int()
    .positive()
    .max(25 * 1024 * 1024)
    .nullable(),
  plaintextSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  sourceLocale: FinanceLocaleSchema.nullable(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/u)
    .nullable(),
  extractionRevision: z.number().int().positive().nullable(),
  state: z.enum([
    'uploaded',
    'extracting',
    'awaiting-review',
    'committed',
    'failed',
    'deleting',
    'deleted',
  ]),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
const FinanceDocumentSummarySchema = summary;
const FinanceDocumentListSchema = z.object({
  schemaVersion: z.literal(1),
  items: z.array(summary).max(100),
  nextCursor: z.string().trim().min(1).max(512).optional(),
});
const FinanceDocumentDetailSchema = z.object({
  schemaVersion: z.literal(1),
  document: summary,
  reviewAvailable: z.boolean(),
  matchCount: z.number().int().nonnegative().max(100_000),
});
const FinanceDocumentReviewDraftSchema = z.object({
  schemaVersion: z.literal(1),
  documentId,
  extractionRevision: z.number().int().positive(),
  envelope: z
    .object({
      schemaVersion: z.literal(1),
      documentType: z.string(),
      sourceLocale: FinanceLocaleSchema,
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/u)
        .nullable(),
      total: money.nullable(),
    })
    .passthrough(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/u),
  reviewToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  expiresAt: z.iso.datetime({ offset: true }),
});
const FinanceDocumentReviewPatchSchema = z.object({
  schemaVersion: z.literal(1),
  expectedExtractionRevision: z.number().int().positive(),
  envelope: z.unknown(),
});
const FinanceDocumentMatchListSchema = z.object({
  schemaVersion: z.literal(1),
  items: z
    .array(
      z
        .object({
          id: documentId,
          documentId,
          recordType: z.string(),
          scoreBasisPoints: z.number().int().min(0).max(10_000),
        })
        .passthrough(),
    )
    .max(100),
});
const FinanceDocumentEvidenceListSchema = z.object({
  schemaVersion: z.literal(1),
  items: z
    .array(
      z.object({
        id: documentId,
        documentId,
        extractionRevision: z.number().int().positive(),
        page: z.number().int().min(1).max(250),
        excerpt: z.string().trim().min(1).max(2_000),
        sourceLocale: FinanceLocaleSchema,
        locator: z.record(z.string().trim().min(1).max(120), z.unknown()),
      }),
    )
    .max(100),
});

export interface FinanceDocumentApi {
  list(options?: {
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }): Promise<FinanceDocumentList>;
  upload(
    file: File,
    authority: MutationAuthority,
  ): Promise<FinanceDocumentSummary>;
  readDetail(
    id: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<FinanceDocumentDetail>;
  originalUrl(id: string): string;
  readReview(
    id: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<FinanceDocumentReviewDraft>;
  updateReview(
    input: MutationAuthority & {
      readonly id: string;
      readonly expectedExtractionRevision: number;
      readonly envelope: FinanceDocumentEnvelopeV1;
    },
  ): Promise<FinanceDocumentReviewDraft>;
  readMatches(
    id: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<FinanceDocumentMatchList>;
  readEvidence(
    id: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<FinanceDocumentEvidenceList>;
  retry(
    id: string,
    authority: MutationAuthority,
  ): Promise<FinanceDocumentDetail>;
}

export class FinanceDocumentApiError extends Error {
  constructor(
    readonly code: 'unavailable' | 'invalid-response',
    message: string,
  ) {
    super(message);
    this.name = 'FinanceDocumentApiError';
  }
}

function documentPath(id: string): string {
  return `/api/v1/finance/documents/${encodeURIComponent(id)}`;
}

function documentListPath(options?: {
  readonly cursor?: string;
  readonly limit?: number;
}): string {
  const query = new URLSearchParams();
  const cursor = options?.cursor?.trim();
  if (cursor) query.set('cursor', cursor);
  if (options?.limit !== undefined && Number.isFinite(options.limit)) {
    query.set(
      'limit',
      String(Math.max(1, Math.min(100, Math.floor(options.limit)))),
    );
  }
  const suffix = query.toString();
  return suffix
    ? `/api/v1/finance/documents?${suffix}`
    : '/api/v1/finance/documents';
}

const jsonRead = (signal?: AbortSignal): RequestInit => ({
  method: 'GET',
  credentials: 'include',
  cache: 'no-store',
  headers: { accept: 'application/json' },
  ...(signal ? { signal } : {}),
});

const authorityHeaders = (authority: MutationAuthority): HeadersInit => ({
  accept: 'application/json',
  'x-csrf-token': authority.csrfToken,
  'idempotency-key': authority.idempotencyKey,
});

async function parseJson(response: Response): Promise<unknown> {
  if (!response.ok)
    throw new FinanceDocumentApiError(
      'unavailable',
      'Documents are unavailable.',
    );
  if (
    !response.headers
      .get('content-type')
      ?.toLowerCase()
      .includes('application/json')
  ) {
    throw new FinanceDocumentApiError(
      'invalid-response',
      'EMDO returned an invalid document response.',
    );
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new FinanceDocumentApiError(
      'invalid-response',
      'EMDO returned an invalid document response.',
    );
  }
}

function parsed<Output>(
  schema: { safeParse(input: unknown): { success: boolean; data?: Output } },
  value: unknown,
): Output {
  const result = schema.safeParse(value);
  if (!result.success || result.data === undefined) {
    throw new FinanceDocumentApiError(
      'invalid-response',
      'EMDO returned an invalid document response.',
    );
  }
  return result.data;
}

/** Document, review and evidence content is held only in React memory. */
export function createFinanceDocumentApi(
  dependencies: { readonly fetcher?: typeof fetch } = {},
): FinanceDocumentApi {
  const fetcher = dependencies.fetcher ?? fetch;
  const get = async (path: string, signal?: AbortSignal) =>
    parseJson(await fetcher(path, jsonRead(signal)));
  const mutation = async (
    path: string,
    method: 'POST' | 'PATCH' | 'DELETE',
    authority: MutationAuthority,
    body?: BodyInit,
    extraHeaders?: HeadersInit,
  ) =>
    parseJson(
      await fetcher(path, {
        method,
        credentials: 'include',
        cache: 'no-store',
        signal: authority.signal,
        headers: { ...authorityHeaders(authority), ...(extraHeaders ?? {}) },
        ...(body ? { body } : {}),
      }),
    );

  const client: FinanceDocumentApi = {
    async list(options) {
      return parsed(
        FinanceDocumentListSchema,
        await get(documentListPath(options), options?.signal),
      );
    },
    async upload(file, authority) {
      const form = new FormData();
      form.append('file', file);
      return parsed(
        FinanceDocumentSummarySchema,
        await mutation('/api/v1/finance/documents', 'POST', authority, form),
      );
    },
    async readDetail(id, options) {
      return parsed(
        FinanceDocumentDetailSchema,
        await get(documentPath(id), options?.signal),
      );
    },
    originalUrl: (id) => `${documentPath(id)}/original`,
    async readReview(id, options) {
      return parsed(
        FinanceDocumentReviewDraftSchema,
        await get(`${documentPath(id)}/review`, options?.signal),
      );
    },
    async updateReview(input) {
      return parsed(
        FinanceDocumentReviewDraftSchema,
        await mutation(
          `${documentPath(input.id)}/review`,
          'PATCH',
          input,
          JSON.stringify(
            FinanceDocumentReviewPatchSchema.parse({
              schemaVersion: 1,
              expectedExtractionRevision: input.expectedExtractionRevision,
              envelope: input.envelope,
            }),
          ),
          { 'content-type': 'application/json' },
        ),
      );
    },
    async readMatches(id, options) {
      return parsed(
        FinanceDocumentMatchListSchema,
        await get(`${documentPath(id)}/matches`, options?.signal),
      );
    },
    async readEvidence(id, options) {
      return parsed(
        FinanceDocumentEvidenceListSchema,
        await get(
          `/api/v1/finance/evidence/${encodeURIComponent(id)}`,
          options?.signal,
        ),
      );
    },
    async retry(id, authority) {
      return parsed(
        FinanceDocumentDetailSchema,
        await mutation(`${documentPath(id)}/retry`, 'POST', authority),
      );
    },
  };
  return Object.freeze(client);
}

export function financeLocale(value: unknown): FinanceLocale | undefined {
  return FinanceLocaleSchema.safeParse(value).data;
}

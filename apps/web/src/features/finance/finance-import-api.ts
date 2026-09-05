import { FinanceImportDestinationsSchema } from '@emdo/contracts/browser';
import { z } from 'zod';

const MAXIMUM_JSON_BODY_BYTES = 1_048_576;
const ReferenceSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => new TextEncoder().encode(value).byteLength <= 512)
  .refine((value) => !/\p{Cc}/u.test(value));
const OpaqueReferenceSchema = ReferenceSchema;
const CsrfTokenSchema = z.string().trim().min(1).max(512);

const CsvMappingSchema = z.strictObject({
  defaultCategoryId: ReferenceSchema.nullable(),
  dateFormat: z.enum(['yyyy-mm-dd', 'mm/dd/yyyy', 'dd/mm/yyyy']),
  columns: z
    .strictObject({
      postedOn: z.string().trim().min(1).max(200),
      description: z.string().trim().min(1).max(200),
      amount: z.string().trim().min(1).max(200).optional(),
      debit: z.string().trim().min(1).max(200).optional(),
      credit: z.string().trim().min(1).max(200).optional(),
      externalId: z.string().trim().min(1).max(200).optional(),
      categoryId: z.string().trim().min(1).max(200).optional(),
    })
    .superRefine((columns, context) => {
      const signed = columns.amount !== undefined;
      const split = columns.debit !== undefined && columns.credit !== undefined;
      if (
        signed === split ||
        (signed &&
          (columns.debit !== undefined || columns.credit !== undefined))
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Choose one signed amount or both debit and credit columns.',
        });
      }
    }),
});

const PreviewRequestSchema = z.discriminatedUnion('format', [
  z.strictObject({
    schemaVersion: z.literal(1),
    format: z.literal('csv'),
    sourceText: z.string().min(1),
    accountId: ReferenceSchema,
    mapping: CsvMappingSchema,
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    format: z.literal('ofx'),
    sourceText: z.string().min(1),
    accountId: ReferenceSchema,
    mapping: z.strictObject({ defaultCategoryId: ReferenceSchema.nullable() }),
  }),
]);

const PreviewResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  plan: z.strictObject({
    id: OpaqueReferenceSchema,
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
    expiresAt: z.iso.datetime({ offset: true }),
    summary: z.strictObject({
      accepted: z.number().int().nonnegative().max(100_000),
      rejected: z.number().int().nonnegative().max(100_000),
      duplicates: z.number().int().nonnegative().max(100_000),
    }),
    rejectedRows: z
      .array(
        z.strictObject({
          sourceRow: z.number().int().positive().max(100_001),
          code: z.string().trim().min(1).max(160),
        }),
      )
      .max(100_000),
    duplicateRows: z
      .array(
        z.strictObject({
          sourceRow: z.number().int().positive().max(100_001),
          reason: z.enum(['existing', 'within-source']),
        }),
      )
      .max(100_000),
  }),
});

export type FinanceImportPreview = z.output<typeof PreviewResponseSchema>;
export type FinanceImportPreviewRequest =
  | {
      readonly format: 'csv';
      readonly sourceText: string;
      readonly accountId: string;
      readonly mapping: z.input<typeof CsvMappingSchema>;
    }
  | {
      readonly format: 'ofx';
      readonly sourceText: string;
      readonly accountId: string;
      readonly mapping: { readonly defaultCategoryId: string | null };
    };
export interface FinanceImportApi {
  listDestinations(options?: {
    readonly signal?: AbortSignal;
  }): Promise<z.output<typeof FinanceImportDestinationsSchema>>;
  preview(
    input: FinanceImportPreviewRequest & {
      readonly csrfToken: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<FinanceImportPreview>;
}

export class FinanceImportApiError extends Error {
  public constructor(
    public readonly code:
      'invalid-request' | 'request-failed' | 'unsafe-response',
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'FinanceImportApiError';
  }
}

type Fetcher = typeof fetch;

function invalidRequest(message: string): FinanceImportApiError {
  return new FinanceImportApiError('invalid-request', message);
}

function stringifyBounded(payload: unknown): string {
  const body = JSON.stringify(payload);
  if (new TextEncoder().encode(body).byteLength > MAXIMUM_JSON_BODY_BYTES) {
    throw invalidRequest('This statement is too large to import.');
  }
  return body;
}

async function parseJson(
  response: Response,
  schema: z.ZodType,
): Promise<unknown> {
  if (!response.ok) {
    throw new FinanceImportApiError(
      'request-failed',
      'Statement import is unavailable. Try again while online.',
      response.status,
    );
  }
  if (
    !response.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  ) {
    throw new FinanceImportApiError(
      'unsafe-response',
      'EMDO rejected an invalid import response.',
    );
  }
  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch {
    throw new FinanceImportApiError(
      'unsafe-response',
      'EMDO rejected an invalid import response.',
    );
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new FinanceImportApiError(
      'unsafe-response',
      'EMDO rejected an invalid import response.',
    );
  }
  return parsed.data;
}

function authorityHeaders(
  csrfToken: string,
  idempotencyKey?: string,
): HeadersInit {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    'x-csrf-token': csrfToken,
  };
}

export function createFinanceImportApi({
  fetcher = fetch,
}: {
  readonly fetcher?: Fetcher;
} = {}): FinanceImportApi {
  return {
    async listDestinations(options = {}) {
      const response = await fetcher('/api/v1/finance/imports/options', {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: options.signal,
        headers: { accept: 'application/json' },
      });
      return (await parseJson(
        response,
        FinanceImportDestinationsSchema,
      )) as z.output<typeof FinanceImportDestinationsSchema>;
    },
    async preview(
      input: FinanceImportPreviewRequest & {
        readonly csrfToken: string;
        readonly signal?: AbortSignal;
      },
    ) {
      const { csrfToken, signal, ...previewInput } = input;
      const parsed = PreviewRequestSchema.safeParse({
        ...previewInput,
        schemaVersion: 1,
      });
      if (!parsed.success || !CsrfTokenSchema.safeParse(csrfToken).success) {
        throw invalidRequest(
          'The authenticated import request is unavailable.',
        );
      }
      const body = stringifyBounded(parsed.data);
      const response = await fetcher('/api/v1/finance/imports/preview', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        signal,
        headers: authorityHeaders(csrfToken),
        body,
      });
      return (await parseJson(
        response,
        PreviewResponseSchema,
      )) as FinanceImportPreview;
    },
  };
}

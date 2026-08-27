import {
  EncryptedFinanceDocumentPayloadSchema,
  FinanceDocumentPayloadScopeSchema,
  parseFinanceDocumentMetadata,
} from '@emdo/integrations/finance-documents';
import {
  FinanceDocumentMimeTypeSchema,
  FinanceDocumentTypeSchema,
  FinanceLocaleSchema,
} from '@emdo/domains/finance';
import { UuidSchema } from '@emdo/contracts';
import { z } from 'zod';

import type {
  FinanceDocumentExtractionExecutor,
  FinanceDocumentExtractionSafeErrorCode,
  FinanceDocumentExtractionWorker,
} from './finance-document-extraction.js';

interface DatabaseClient {
  query(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<{
    readonly rows: unknown[];
    readonly rowCount?: number | null;
  }>;
  release(): void;
}

interface DatabasePool {
  connect(): Promise<DatabaseClient>;
}

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const WrappedDataKeySchema = z.strictObject({
  algorithm: z.literal('aes-256-gcm'),
  aadVersion: z.literal(1),
  wrappedKey: z.string().min(1).max(1_024),
  nonce: z.string().min(1).max(128),
  authenticationTag: z.string().min(1).max(128),
});
const ClaimRowSchema = z.strictObject({
  household_id: UuidSchema,
  space_id: UuidSchema,
  original_owner_user_id: UuidSchema,
  document_id: UuidSchema,
  extraction_revision: z.coerce.number().int().positive(),
  extraction_attempt: z.coerce.number().int().min(1).max(2),
  storage_object_id: z.string().min(16).max(200),
  mime_type: FinanceDocumentMimeTypeSchema,
  byte_size: z.coerce
    .number()
    .int()
    .positive()
    .max(25 * 1024 * 1024),
  page_count: z.coerce.number().int().min(1).max(250).nullable(),
  image_width: z.coerce.number().int().positive().nullable(),
  image_height: z.coerce.number().int().positive().nullable(),
  plaintext_sha256: HashSchema,
  ciphertext_sha256: HashSchema,
  wrapped_data_key: WrappedDataKeySchema,
  key_version: z.string().min(1).max(100),
});

const BooleanResultSchema = z.strictObject({ result: z.literal(true) });

const unavailable = (): Error =>
  new Error('Finance document extraction database unavailable.');

const queryOne = async (
  pool: DatabasePool,
  sql: string,
  parameters: readonly unknown[] = [],
): Promise<unknown | undefined> => {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, parameters);
    if (result.rows.length > 1) throw unavailable();
    return result.rows[0];
  } finally {
    client.release();
  }
};

/** Fixed-role adapter for the three 0016 security-definer worker functions. */
export class PostgresFinanceDocumentExtractionExecutor implements FinanceDocumentExtractionExecutor {
  constructor(private readonly pool: DatabasePool) {
    if (typeof pool?.connect !== 'function') throw unavailable();
  }

  async claimNextFinanceDocumentExtraction(input: {
    readonly signal: AbortSignal;
  }): Promise<unknown> {
    if (input.signal.aborted) throw unavailable();
    const raw = await queryOne(
      this.pool,
      'select * from emdo.claim_next_finance_document_extraction()',
    );
    if (raw === undefined) return undefined;
    const row = ClaimRowSchema.parse(raw);
    if (input.signal.aborted) throw unavailable();
    const payloadScope = FinanceDocumentPayloadScopeSchema.parse({
      householdId: row.household_id,
      privateSpaceId: row.space_id,
      ownerUserId: row.original_owner_user_id,
      documentId: row.document_id,
      extractionRevision: row.extraction_revision,
      purpose: 'unreviewed-extraction',
    });
    return Object.freeze({
      schemaVersion: 1 as const,
      documentId: row.document_id,
      extractionRevision: row.extraction_revision,
      attempt: row.extraction_attempt as 1 | 2,
      original: Object.freeze({
        mimeType: row.mime_type,
        byteSize: row.byte_size,
        pageCount: row.page_count,
        imageWidth: row.image_width,
        imageHeight: row.image_height,
        metadata: parseFinanceDocumentMetadata({
          schemaVersion: 1,
          algorithm: row.wrapped_data_key.algorithm,
          aadVersion: row.wrapped_data_key.aadVersion,
          objectName: row.storage_object_id,
          plaintextBytes: row.byte_size,
          ciphertextBytes: row.byte_size,
          plaintextSha256: row.plaintext_sha256,
          ciphertextSha256: row.ciphertext_sha256,
          nonce: row.wrapped_data_key.nonce,
          authenticationTag: row.wrapped_data_key.authenticationTag,
          wrappedKey: row.wrapped_data_key.wrappedKey,
          keyVersion: row.key_version,
        }),
      }),
      payloadScope,
    });
  }

  async completeFinanceDocumentExtraction(
    input: Parameters<
      FinanceDocumentExtractionExecutor['completeFinanceDocumentExtraction']
    >[0],
  ): Promise<unknown> {
    if (input.signal.aborted) throw unavailable();
    const payload = EncryptedFinanceDocumentPayloadSchema.parse(
      input.encryptedPayload,
    );
    const documentType = FinanceDocumentTypeSchema.parse(input.documentType);
    const sourceLocale = FinanceLocaleSchema.parse(input.sourceLocale);
    const result = BooleanResultSchema.parse(
      await queryOne(
        this.pool,
        `select emdo.complete_finance_document_extraction(
           $1::uuid, $2::integer, $3::smallint, $4::jsonb, $5::jsonb,
           $6::text, $7::integer, $8::integer, $9::text, $10::text, $11::text
         ) as result`,
        [
          UuidSchema.parse(input.documentId),
          input.extractionRevision,
          input.attempt,
          payload,
          input.redactedSummary,
          HashSchema.parse(input.responseHash),
          input.inputTokens,
          input.outputTokens,
          documentType,
          sourceLocale,
          input.currency,
        ],
      ),
    );
    return result.result;
  }

  async failFinanceDocumentExtraction(
    input: Parameters<
      FinanceDocumentExtractionExecutor['failFinanceDocumentExtraction']
    >[0],
  ): Promise<unknown> {
    if (input.signal.aborted) throw unavailable();
    const safeErrorCode = z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9.-]+$/u)
      .parse(input.safeErrorCode) as FinanceDocumentExtractionSafeErrorCode;
    const result = BooleanResultSchema.parse(
      await queryOne(
        this.pool,
        `select emdo.fail_finance_document_extraction(
           $1::uuid, $2::integer, $3::smallint, $4::text
         ) as result`,
        [
          UuidSchema.parse(input.documentId),
          input.extractionRevision,
          input.attempt,
          safeErrorCode,
        ],
      ),
    );
    return result.result;
  }
}

export interface FinanceDocumentExtractionPollerHandle {
  stop(): Promise<void>;
}

/** One process-local serial loop; the database adds a VPS-wide advisory lock. */
export const startFinanceDocumentExtractionPoller = (input: {
  readonly worker: FinanceDocumentExtractionWorker;
  readonly signal: AbortSignal;
  readonly pollIntervalMs: number;
  readonly onFatalError: () => void;
}): FinanceDocumentExtractionPollerHandle => {
  if (
    typeof input.worker?.runOnce !== 'function' ||
    !Number.isSafeInteger(input.pollIntervalMs) ||
    input.pollIntervalMs < 250 ||
    input.pollIntervalMs > 60_000 ||
    typeof input.onFatalError !== 'function'
  ) {
    throw unavailable();
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  input.signal.addEventListener('abort', abort, { once: true });
  if (input.signal.aborted) controller.abort();

  const wait = (): Promise<void> => {
    if (controller.signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, input.pollIntervalMs);
      controller.signal.addEventListener('abort', finish, { once: true });
      if (controller.signal.aborted) {
        finish();
        return;
      }
    });
  };
  const loop = (async () => {
    try {
      while (!controller.signal.aborted) {
        const result = await input.worker.runOnce({
          signal: controller.signal,
        });
        if (result.status === 'idle') await wait();
      }
    } catch {
      if (!controller.signal.aborted) input.onFatalError();
    }
  })();
  let stopPromise: Promise<void> | undefined;
  return Object.freeze({
    stop(): Promise<void> {
      stopPromise ??= (async () => {
        controller.abort();
        input.signal.removeEventListener('abort', abort);
        await loop;
      })();
      return stopPromise;
    },
  });
};

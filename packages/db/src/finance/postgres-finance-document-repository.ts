import { createHash, randomUUID } from 'node:crypto';

import {
  IdempotencyKeySchema,
  Sha256Schema,
  UuidSchema,
  deepFreeze,
  type JsonValue,
} from '@emdo/contracts';
import {
  FinanceDocumentEnvelopeV1Schema,
  type FinanceDocumentEnvelopeV1,
} from '@emdo/domains/finance';
import { z } from 'zod';

import {
  DurableRepositoryError,
  beginDurableTransaction,
  firstResultRow,
  lockDurableScope,
  type DurableRepositoryPrincipal,
} from '../durable/scoped-transaction.js';
import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';

const MAXIMUM_SEARCH_RESULTS = 25;
const RANK_FUSION_OFFSET = 60;
const FULL_TEXT_RANK_WEIGHT_MILLIONTHS = 3_000_000;
const VECTOR_RANK_WEIGHT_MILLIONTHS = 2_000_000;

/**
 * This repository deliberately receives the scope resolved by the server's
 * authentication boundary.  It never accepts a caller-selected owner or
 * space, and every command re-installs the request claims before touching a
 * Finance document relation.
 */
export interface FinanceDocumentRepositoryPrincipal {
  readonly userId: string;
  readonly sessionId: string;
  readonly householdId: string;
  readonly privateSpaceId: string;
  readonly emailVerified: true;
  readonly spaceAccessGrantId: string;
  readonly scopeFingerprint: string;
}

export class FinanceDocumentRepositoryError extends Error {
  constructor(
    readonly code:
      | 'authorization-revoked'
      | 'conflict'
      | 'database-unavailable'
      | 'document-not-found'
      | 'document-unavailable'
      | 'duplicate'
      | 'extraction-not-found'
      | 'invalid-input'
      | 'invalid-result'
      | 'quota-exceeded'
      | 'retry-exhausted'
      | 'review-expired'
      | 'review-not-found'
      | 'review-unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'FinanceDocumentRepositoryError';
  }
}

export type FinanceDocumentCurrencyLabel = 'cad' | 'non-cad' | 'unknown';

export interface FinanceDocumentMetadataView {
  readonly id: string;
  readonly state:
    | 'uploaded'
    | 'extracting'
    | 'awaiting-review'
    | 'committed'
    | 'failed'
    | 'deleting'
    | 'deleted';
  readonly displayName: string | null;
  readonly mimeType: 'application/pdf' | 'image/jpeg' | 'image/png' | null;
  readonly byteSize: number | null;
  readonly pageCount: number | null;
  readonly imageWidth: number | null;
  readonly imageHeight: number | null;
  readonly plaintextSha256: string | null;
  readonly documentType:
    | 'receipt'
    | 'invoice'
    | 'bank-statement'
    | 'credit-statement'
    | 'pay-stub'
    | 'tax-slip'
    | 'insurance'
    | 'loan'
    | 'investment-statement'
    | 'other'
    | null;
  readonly sourceLocale: 'en-CA' | 'fr-CA' | 'ja-JP' | 'ko-KR' | null;
  readonly currency: string | null;
  readonly currencyLabel: FinanceDocumentCurrencyLabel;
  readonly extractionRevision: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

/**
 * The specialist-only fact projection is derived from the current committed
 * review envelope. It intentionally contains no raw review payload, chunks,
 * vectors, or unreviewed extraction state.
 */
interface FinanceDocumentCommittedProjection {
  readonly id: string;
  readonly documentType: NonNullable<
    FinanceDocumentMetadataView['documentType']
  >;
  readonly sourceLocale: NonNullable<
    FinanceDocumentMetadataView['sourceLocale']
  >;
  readonly currency: string | null;
  readonly currencyLabel: FinanceDocumentCurrencyLabel;
  readonly extractionRevision: number;
  readonly occurredOn: string | null;
  readonly amountMinor: number | null;
  readonly committedAt: string;
}

export interface FinanceDocumentOriginalAuthorization {
  readonly id: string;
  readonly storageObjectId: string;
  readonly mimeType: 'application/pdf' | 'image/jpeg' | 'image/png';
  readonly byteSize: number;
  readonly pageCount: number | null;
  readonly imageWidth: number | null;
  readonly imageHeight: number | null;
  readonly plaintextSha256: string;
  readonly ciphertextSha256: string;
  readonly wrappedDataKey: Readonly<{
    readonly algorithm: 'aes-256-gcm';
    readonly wrappedKey: string;
    readonly nonce: string;
    readonly authenticationTag: string;
    readonly aadVersion: 1;
  }>;
  readonly keyVersion: string;
}

export interface FinanceDocumentReviewDraft {
  readonly id: string;
  readonly documentId: string;
  readonly extractionRevision: number;
  readonly authenticatedSessionId: string;
  readonly spaceAccessGrantId: string;
  readonly scopeFingerprint: string;
  readonly payloadHash: string;
  readonly reviewTokenHash: string;
  readonly idempotencyKey: string;
  readonly selectedFacts: FinanceDocumentReviewedPayload;
  readonly expiresAt: string;
}

export interface FinanceDocumentEncryptedExtractionPayload {
  readonly schemaVersion: 1;
  readonly algorithm: 'aes-256-gcm';
  readonly aadVersion: 1;
  readonly ciphertext: string;
  readonly nonce: string;
  readonly authenticationTag: string;
  readonly wrappedKey: string;
  readonly keyVersion: string;
}

export interface FinanceDocumentCurrentExtraction {
  readonly documentId: string;
  readonly extractionRevision: number;
  readonly documentType: FinanceDocumentReviewedPayload['documentType'] | null;
  readonly sourceLocale: FinanceDocumentReviewedPayload['sourceLocale'] | null;
  readonly currency: string | null;
  readonly encryptedPayload: FinanceDocumentEncryptedExtractionPayload;
}

export interface FinanceDocumentReviewedPayload {
  readonly documentType:
    | 'receipt'
    | 'invoice'
    | 'bank-statement'
    | 'credit-statement'
    | 'pay-stub'
    | 'tax-slip'
    | 'insurance'
    | 'loan'
    | 'investment-statement'
    | 'other';
  readonly sourceLocale: 'en-CA' | 'fr-CA' | 'ja-JP' | 'ko-KR';
  readonly currency: string | null;
  readonly chunks: readonly FinanceDocumentReviewedChunk[];
  readonly evidence: readonly FinanceDocumentReviewedEvidence[];
  readonly matchSuggestions: readonly FinanceDocumentMatchSuggestion[];
}

export interface FinanceDocumentReviewedChunk {
  readonly ordinal: number;
  readonly pageStart: number;
  readonly pageEnd: number;
  readonly content: string;
  /** Vectors are deliberately excluded from the review payload/token hash. */
  readonly embedding: null;
}

export interface FinanceDocumentReviewedEvidence {
  readonly chunkOrdinal: number | null;
  readonly page: number;
  readonly excerpt: string;
  readonly locator: Readonly<{
    readonly characterStart: number | null;
    readonly characterEnd: number | null;
  }>;
  readonly sourceLocale: 'en-CA' | 'fr-CA' | 'ja-JP' | 'ko-KR';
}

export interface FinanceDocumentMatchSuggestion {
  readonly recordType:
    | 'account'
    | 'transaction'
    | 'category'
    | 'budget'
    | 'bill'
    | 'subscription'
    | 'goal';
  readonly recordId: string;
  readonly scoreBasisPoints: number;
  readonly reasons: readonly string[];
}

const FinanceDocumentStateSchema = z.enum([
  'uploaded',
  'extracting',
  'awaiting-review',
  'committed',
  'failed',
  'deleting',
  'deleted',
]);
const FinanceDocumentTypeSchema = z.enum([
  'receipt',
  'invoice',
  'bank-statement',
  'credit-statement',
  'pay-stub',
  'tax-slip',
  'insurance',
  'loan',
  'investment-statement',
  'other',
]);
const FinanceLocaleSchema = z.enum(['en-CA', 'fr-CA', 'ja-JP', 'ko-KR']);
const FinanceDocumentMimeTypeSchema = z.enum([
  'application/pdf',
  'image/jpeg',
  'image/png',
]);
const CurrencySchema = z.string().regex(/^[A-Z]{3}$/u);
const ReviewTokenSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/u);
const StorageObjectIdSchema = z
  .string()
  .min(16)
  .max(200)
  .regex(/^[A-Za-z0-9._-]+$/u);
const DisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (value) => !/\p{Cc}/u.test(value),
    'Control characters are not allowed',
  );
const WrappedDataKeySchema = z.strictObject({
  algorithm: z.literal('aes-256-gcm'),
  wrappedKey: z.string().min(1).max(16_384),
  nonce: z.string().min(1).max(512),
  authenticationTag: z.string().min(1).max(512),
  aadVersion: z.literal(1),
});
const PrincipalSchema = z.strictObject({
  userId: UuidSchema,
  sessionId: UuidSchema,
  householdId: UuidSchema,
  privateSpaceId: UuidSchema,
  emailVerified: z.literal(true),
  spaceAccessGrantId: UuidSchema,
  scopeFingerprint: Sha256Schema,
});
const ScopedInputSchema = z.strictObject({
  principal: PrincipalSchema,
  requestId: UuidSchema,
});
const DocumentInputSchema = ScopedInputSchema.extend({
  documentId: UuidSchema,
});
const EvidenceInputSchema = ScopedInputSchema.extend({
  evidenceId: UuidSchema,
});
const MatchInputSchema = ScopedInputSchema.extend({
  matchId: UuidSchema,
});
const CommittedReviewInputSchema = DocumentInputSchema.extend({
  reviewToken: ReviewTokenSchema,
});
const StorageMetadataInputSchema = ScopedInputSchema.extend({
  storage: z
    .strictObject({
      storageObjectId: StorageObjectIdSchema,
      displayName: DisplayNameSchema,
      mimeType: FinanceDocumentMimeTypeSchema,
      byteSize: z
        .number()
        .int()
        .positive()
        .max(25 * 1024 * 1024),
      pageCount: z.number().int().min(1).max(250).nullable(),
      imageWidth: z.number().int().positive().max(40_000).nullable(),
      imageHeight: z.number().int().positive().max(40_000).nullable(),
      plaintextSha256: Sha256Schema,
      ciphertextSha256: Sha256Schema,
      wrappedDataKey: WrappedDataKeySchema,
      keyVersion: z.string().trim().min(1).max(100),
    })
    .superRefine((value, context) => {
      if (
        value.mimeType === 'application/pdf' &&
        (value.pageCount === null ||
          value.imageWidth !== null ||
          value.imageHeight !== null)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['pageCount'],
          message: 'PDF metadata must include pages and no image dimensions',
        });
      }
      if (
        value.mimeType !== 'application/pdf' &&
        (value.pageCount !== null ||
          value.imageWidth === null ||
          value.imageHeight === null ||
          value.imageWidth * value.imageHeight > 40_000_000)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['imageWidth'],
          message:
            'Image metadata must include bounded dimensions and no page count',
        });
      }
    }),
});
const CursorSchema = z.strictObject({
  updatedAt: z.iso.datetime({ offset: true }),
  id: UuidSchema,
});
const ListInputSchema = ScopedInputSchema.extend({
  states: z.array(FinanceDocumentStateSchema).max(7).default([]),
  documentTypes: z.array(FinanceDocumentTypeSchema).max(10).default([]),
  includeDeleted: z.boolean().default(false),
  cursor: CursorSchema.nullable().default(null),
  limit: z.number().int().min(1).max(100).default(50),
});
const ExtractionCreateInputSchema = DocumentInputSchema.extend({
  retry: z.boolean().default(false),
  model: z.literal('gpt-5.6-terra').nullable().default(null),
});
const EncryptedExtractionPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  algorithm: z.literal('aes-256-gcm'),
  aadVersion: z.literal(1),
  ciphertext: z.string().min(1).max(16_000_000),
  nonce: z.string().min(1).max(512),
  authenticationTag: z.string().min(1).max(512),
  wrappedKey: z.string().min(1).max(16_384),
  keyVersion: z.string().trim().min(1).max(100),
});
// Keep provider-specific response fields outside this repository. This summary
// is deliberately non-content-bearing and cannot become a raw model body.
const RedactedExtractionSummarySchema = z.strictObject({
  documentType: FinanceDocumentTypeSchema.nullable(),
  sourceLocale: FinanceLocaleSchema.nullable(),
  currency: CurrencySchema.nullable(),
  factCount: z.number().int().nonnegative().max(512),
  chunkCount: z.number().int().nonnegative().max(128),
  evidenceCount: z.number().int().nonnegative().max(512),
  safeStatus: z.enum(['ready-for-review', 'no-readable-facts']),
});
const ExtractionCompletionInputSchema = DocumentInputSchema.extend({
  extractionRevision: z.number().int().positive(),
  outcome: z.discriminatedUnion('state', [
    z.strictObject({
      state: z.literal('awaiting-review'),
      encryptedPayload: EncryptedExtractionPayloadSchema,
      redactedSummary: RedactedExtractionSummarySchema,
      responseHash: Sha256Schema,
      inputTokens: z.number().int().nonnegative().max(10_000_000).nullable(),
      outputTokens: z.number().int().nonnegative().max(10_000_000).nullable(),
    }),
    z.strictObject({
      state: z.literal('failed'),
      safeErrorCode: z
        .string()
        .min(3)
        .max(120)
        .regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/u),
      responseHash: Sha256Schema.nullable(),
      inputTokens: z.number().int().nonnegative().max(10_000_000).nullable(),
      outputTokens: z.number().int().nonnegative().max(10_000_000).nullable(),
    }),
  ]),
});
const ReviewedChunkSchema = z.strictObject({
  ordinal: z.number().int().min(0).max(4_095),
  pageStart: z.number().int().min(1).max(250),
  pageEnd: z.number().int().min(1).max(250),
  content: z.string().trim().min(1).max(16_384),
  // The reviewed payload is the token-bound source of truth. Vectors are
  // generated only after review and supplied separately to commitReview.
  embedding: z.null(),
});
const ReviewedEvidenceSchema = z
  .strictObject({
    chunkOrdinal: z.number().int().min(0).max(4_095).nullable(),
    page: z.number().int().min(1).max(250),
    excerpt: z.string().trim().min(1).max(8_192),
    locator: z
      .strictObject({
        characterStart: z.number().int().nonnegative().nullable(),
        characterEnd: z.number().int().positive().nullable(),
      })
      .superRefine((value, context) => {
        if (
          (value.characterStart === null) !== (value.characterEnd === null) ||
          (value.characterStart !== null &&
            value.characterEnd !== null &&
            value.characterEnd <= value.characterStart)
        ) {
          context.addIssue({
            code: 'custom',
            path: ['characterEnd'],
            message: 'Locator offsets must be an increasing pair',
          });
        }
      }),
    sourceLocale: FinanceLocaleSchema,
  })
  .superRefine((value, context) => {
    if (/\p{Cc}/u.test(value.excerpt)) {
      context.addIssue({
        code: 'custom',
        path: ['excerpt'],
        message: 'Evidence excerpt contains control characters',
      });
    }
  });
const MatchSuggestionSchema = z.strictObject({
  recordType: z.enum([
    'account',
    'transaction',
    'category',
    'budget',
    'bill',
    'subscription',
    'goal',
  ]),
  recordId: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .refine(
      (value) => !/\p{Cc}/u.test(value),
      'Control characters are not allowed',
    ),
  scoreBasisPoints: z.number().int().min(0).max(10_000),
  reasons: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(240)
        .regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/u),
    )
    .min(1)
    .max(8),
});
const ReviewedPayloadSchema = z
  .strictObject({
    documentType: FinanceDocumentTypeSchema,
    sourceLocale: FinanceLocaleSchema,
    currency: CurrencySchema.nullable(),
    chunks: z.array(ReviewedChunkSchema).min(1).max(128),
    evidence: z.array(ReviewedEvidenceSchema).max(512),
    matchSuggestions: z.array(MatchSuggestionSchema).max(100),
  })
  .superRefine((value, context) => {
    const ordinals = new Set<number>();
    for (const [index, chunk] of value.chunks.entries()) {
      if (chunk.pageEnd < chunk.pageStart) {
        context.addIssue({
          code: 'custom',
          path: ['chunks', index, 'pageEnd'],
          message: 'Chunk page end must not precede the page start',
        });
      }
      if (ordinals.has(chunk.ordinal)) {
        context.addIssue({
          code: 'custom',
          path: ['chunks', index, 'ordinal'],
          message: 'Chunk ordinals must be unique',
        });
      }
      ordinals.add(chunk.ordinal);
    }
    for (const [index, evidence] of value.evidence.entries()) {
      if (
        evidence.chunkOrdinal !== null &&
        !ordinals.has(evidence.chunkOrdinal)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['evidence', index, 'chunkOrdinal'],
          message: 'Evidence must reference a reviewed chunk ordinal',
        });
      }
      if (evidence.sourceLocale !== value.sourceLocale) {
        context.addIssue({
          code: 'custom',
          path: ['evidence', index, 'sourceLocale'],
          message: 'Evidence locale must match the reviewed document locale',
        });
      }
    }
    if (value.currency !== 'CAD' && value.matchSuggestions.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['matchSuggestions'],
        message: 'Only reviewed CAD documents can retain match suggestions',
      });
    }
    if (Buffer.byteLength(stableJson(value), 'utf8') > 4_000_000) {
      context.addIssue({
        code: 'custom',
        message: 'Reviewed payload exceeds the durable review limit',
      });
    }
  });
const ReplaceReviewDraftInputSchema = DocumentInputSchema.extend({
  extractionRevision: z.number().int().positive(),
  reviewToken: ReviewTokenSchema,
  idempotencyKey: IdempotencyKeySchema,
  selectedFacts: ReviewedPayloadSchema,
});
const ReviewedEmbeddingSchema = z.strictObject({
  ordinal: z.number().int().min(0).max(4_095),
  embedding: z.array(z.number().finite()).length(1_536),
});
const ReviewedEmbeddingsSchema = z
  .array(ReviewedEmbeddingSchema)
  .max(128)
  .superRefine((value, context) => {
    const ordinals = new Set<number>();
    for (const [index, embedding] of value.entries()) {
      if (ordinals.has(embedding.ordinal)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'ordinal'],
          message: 'Reviewed embedding ordinals must be unique',
        });
      }
      ordinals.add(embedding.ordinal);
    }
  });
const CommitReviewInputSchema = DocumentInputSchema.extend({
  extractionRevision: z.number().int().positive(),
  reviewBatchId: UuidSchema,
  reviewToken: ReviewTokenSchema,
  payloadHash: Sha256Schema,
  idempotencyKey: IdempotencyKeySchema,
  embeddings: ReviewedEmbeddingsSchema,
});
const SearchInputSchema = ScopedInputSchema.extend({
  query: z.string().trim().min(1).max(500),
  documentTypes: z.array(FinanceDocumentTypeSchema).max(10).default([]),
  currency: CurrencySchema.nullable().default(null),
  displayName: z.string().trim().min(1).max(255).nullable().default(null),
  vectorQuery: z
    .array(z.number().finite())
    .length(1_536)
    .nullable()
    .default(null),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAXIMUM_SEARCH_RESULTS)
    .default(MAXIMUM_SEARCH_RESULTS),
});
const EvidenceListInputSchema = DocumentInputSchema.extend({
  limit: z.number().int().min(1).max(100).default(50),
});
const MatchesListInputSchema = EvidenceListInputSchema.extend({
  states: z
    .array(z.enum(['suggested', 'accepted', 'rejected']))
    .max(3)
    .default([]),
});
const MatchDecisionInputSchema = DocumentInputSchema.extend({
  matchId: UuidSchema,
  reviewBatchId: UuidSchema,
  decision: z.enum(['accepted', 'rejected']),
});
/**
 * Retained on a deleting/deleted row only. It is content-free and lets the
 * exact already-approved action retry a non-transactional object-store purge.
 */
const GuardedDeleteReceiptSchema = z.strictObject({
  proposalId: UuidSchema,
  decisionId: UuidSchema,
  targetBindingHash: Sha256Schema,
  executionBindingHash: Sha256Schema,
});
const GuardedDeleteInputSchema = DocumentInputSchema.extend({
  receipt: GuardedDeleteReceiptSchema,
});

const DocumentRowSchema = z.strictObject({
  id: UuidSchema,
  state: FinanceDocumentStateSchema,
  displayName: z.string().nullable(),
  mimeType: FinanceDocumentMimeTypeSchema.nullable(),
  byteSize: z.coerce
    .number()
    .int()
    .positive()
    .max(25 * 1024 * 1024)
    .nullable(),
  pageCount: z.coerce.number().int().min(1).max(250).nullable(),
  imageWidth: z.coerce.number().int().positive().max(40_000).nullable(),
  imageHeight: z.coerce.number().int().positive().max(40_000).nullable(),
  plaintextSha256: Sha256Schema.nullable(),
  ciphertextSha256: Sha256Schema.nullable(),
  wrappedDataKey: WrappedDataKeySchema.nullable(),
  keyVersion: z.string().nullable(),
  storageObjectId: StorageObjectIdSchema.nullable(),
  documentType: FinanceDocumentTypeSchema.nullable(),
  sourceLocale: FinanceLocaleSchema.nullable(),
  currency: CurrencySchema.nullable(),
  extractionRevision: z.coerce.number().int().positive().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  deletedAt: z.coerce.date().nullable(),
  deletionProposalId: UuidSchema.nullable(),
  deletionDecisionId: UuidSchema.nullable(),
  deletionTargetBindingHash: Sha256Schema.nullable(),
  deletionExecutionBindingHash: Sha256Schema.nullable(),
});
type FinanceDocumentRow = z.output<typeof DocumentRowSchema>;

const matchesGuardedDeleteReceipt = (
  document: FinanceDocumentRow,
  receipt: z.output<typeof GuardedDeleteReceiptSchema>,
): boolean =>
  document.deletionProposalId === receipt.proposalId &&
  document.deletionDecisionId === receipt.decisionId &&
  document.deletionTargetBindingHash === receipt.targetBindingHash &&
  document.deletionExecutionBindingHash === receipt.executionBindingHash;
const CommittedProjectionRowSchema = z.strictObject({
  id: UuidSchema,
  documentType: FinanceDocumentTypeSchema,
  sourceLocale: FinanceLocaleSchema,
  currency: CurrencySchema.nullable(),
  extractionRevision: z.coerce.number().int().positive(),
  selectedFacts: ReviewedPayloadSchema,
  committedAt: z.coerce.date(),
});
const ExtractionRowSchema = z.strictObject({
  id: UuidSchema,
  revision: z.coerce.number().int().positive(),
  attempt: z.coerce.number().int().min(1).max(2),
  state: z.enum([
    'queued',
    'extracting',
    'awaiting-review',
    'committed',
    'failed',
    'superseded',
  ]),
});
const ReviewBatchRowSchema = z.strictObject({
  id: UuidSchema,
  documentId: UuidSchema,
  extractionRevision: z.coerce.number().int().positive(),
  authenticatedSessionId: UuidSchema,
  spaceAccessGrantId: UuidSchema,
  scopeFingerprint: Sha256Schema,
  payloadHash: Sha256Schema,
  reviewTokenHash: Sha256Schema,
  selectedFacts: ReviewedPayloadSchema,
  state: z.enum(['pending', 'committed', 'rejected', 'expired', 'invalidated']),
  idempotencyKey: IdempotencyKeySchema,
  expiresAt: z.coerce.date(),
});
const CurrentExtractionRowSchema = z.strictObject({
  documentId: UuidSchema,
  extractionRevision: z.coerce.number().int().positive(),
  documentType: FinanceDocumentTypeSchema.nullable(),
  sourceLocale: FinanceLocaleSchema.nullable(),
  currency: CurrencySchema.nullable(),
  encryptedPayload: EncryptedExtractionPayloadSchema,
});
const EvidenceRowSchema = z.strictObject({
  id: UuidSchema,
  documentId: UuidSchema,
  extractionRevision: z.coerce.number().int().positive(),
  chunkId: UuidSchema.nullable(),
  page: z.coerce.number().int().min(1).max(250),
  excerpt: z.string().min(1).max(8_192),
  excerptHash: Sha256Schema,
  locator: z.strictObject({
    characterStart: z.coerce.number().int().nonnegative().nullable(),
    characterEnd: z.coerce.number().int().positive().nullable(),
  }),
  sourceLocale: FinanceLocaleSchema,
});
const MatchRowSchema = z.strictObject({
  id: UuidSchema,
  documentId: UuidSchema,
  extractionRevision: z.coerce.number().int().positive(),
  recordType: MatchSuggestionSchema.shape.recordType,
  recordId: z.string().min(1).max(512),
  scoreBasisPoints: z.coerce.number().int().min(0).max(10_000),
  reasons: z.array(z.string().min(1).max(240)).min(1).max(8),
  state: z.enum(['suggested', 'accepted', 'rejected']),
  decisionReviewBatchId: UuidSchema.nullable(),
  decidedAt: z.coerce.date().nullable(),
});

const MAX_DOCUMENTS_PER_OWNER = 10_000;
const MAX_BYTES_PER_OWNER = 50 * 1024 * 1024 * 1024;
const REVIEW_ENVELOPE_PREFIX = 'emdo.finance-document.review-envelope.v1:';
const MAXIMUM_REVIEW_ENVELOPE_CHUNKS = 96;
const REVIEW_ENVELOPE_CHUNK_DATA_BYTES = 15_000;
const MAXIMUM_REVIEW_ENVELOPE_ENCODED_BYTES =
  MAXIMUM_REVIEW_ENVELOPE_CHUNKS * REVIEW_ENVELOPE_CHUNK_DATA_BYTES;

const stableJson = (value: JsonValue): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`)
    .join(',')}}`;
};

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const vectorLiteral = (vector: readonly number[] | null): string | null =>
  vector === null ? null : `[${vector.join(',')}]`;

const labelCurrency = (
  currency: string | null,
): FinanceDocumentCurrencyLabel =>
  currency === null ? 'unknown' : currency === 'CAD' ? 'cad' : 'non-cad';

const parseInput = <Output>(
  schema: z.ZodType<Output>,
  input: unknown,
): Output => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new FinanceDocumentRepositoryError(
      'invalid-input',
      'Finance document input is malformed',
    );
  }
  return parsed.data;
};

const parseResult = <Output>(
  schema: z.ZodType<Output>,
  input: unknown,
  label: string,
): Output => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new FinanceDocumentRepositoryError(
      'invalid-result',
      `Finance document ${label} returned an invalid database result`,
    );
  }
  return parsed.data;
};

const durablePrincipalFor = (input: {
  readonly principal: FinanceDocumentRepositoryPrincipal;
  readonly requestId: string;
}): Readonly<DurableRepositoryPrincipal> =>
  deepFreeze({
    userId: input.principal.userId,
    sessionId: input.principal.sessionId,
    householdId: input.principal.householdId,
    requestId: input.requestId,
  });

const asPrincipal = (
  principal: z.output<typeof PrincipalSchema>,
): FinanceDocumentRepositoryPrincipal =>
  deepFreeze({
    userId: principal.userId,
    sessionId: principal.sessionId,
    householdId: principal.householdId,
    privateSpaceId: principal.privateSpaceId,
    emailVerified: principal.emailVerified,
    spaceAccessGrantId: principal.spaceAccessGrantId,
    scopeFingerprint: principal.scopeFingerprint,
  }) as FinanceDocumentRepositoryPrincipal;

const rollbackQuietly = async (client: DatabaseClient) => {
  try {
    await client.query('rollback');
  } catch {
    // Preserve the original failure as the only safe result.
  }
};

const databaseCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

const mapError = (error: unknown): never => {
  if (error instanceof FinanceDocumentRepositoryError) throw error;
  if (error instanceof DurableRepositoryError) {
    throw new FinanceDocumentRepositoryError(
      error.code === 'authorization-revoked'
        ? 'authorization-revoked'
        : error.code === 'invalid-input'
          ? 'invalid-input'
          : 'database-unavailable',
      'The Finance document request is no longer authorized',
    );
  }
  if (databaseCode(error) === '23505') {
    throw new FinanceDocumentRepositoryError(
      'conflict',
      'The Finance document operation conflicts with an existing record',
    );
  }
  if (databaseCode(error) === '23514' || databaseCode(error) === '22001') {
    throw new FinanceDocumentRepositoryError(
      'invalid-input',
      'The Finance document operation violates a bounded storage rule',
    );
  }
  throw new FinanceDocumentRepositoryError(
    'database-unavailable',
    'The Finance document operation could not be verified',
  );
};

const withScopedTransaction = async <Result>(
  pool: DatabasePool,
  input: {
    readonly principal: FinanceDocumentRepositoryPrincipal;
    readonly requestId: string;
  },
  work: (client: DatabaseClient) => Promise<Result>,
): Promise<Result> => {
  let client: DatabaseClient | undefined;
  let released = false;
  try {
    client = await beginDurableTransaction(
      pool,
      durablePrincipalFor({
        principal: input.principal,
        requestId: input.requestId,
      }),
    );
    await lockDurableScope(client, {
      householdId: input.principal.householdId,
      spaceId: input.principal.privateSpaceId,
    });
    const result = await work(client);
    await client.query('commit');
    released = true;
    client.release();
    return result;
  } catch (error) {
    if (client !== undefined && !released) {
      await rollbackQuietly(client);
      released = true;
      client.release();
    }
    return mapError(error);
  }
};

const scopeValues = (principal: FinanceDocumentRepositoryPrincipal) =>
  [principal.householdId, principal.privateSpaceId, principal.userId] as const;

const documentSelect = `select document.id::text as "id",
       document.state as "state",
       document.display_name as "displayName",
       document.mime_type as "mimeType",
       document.byte_size as "byteSize",
       document.page_count as "pageCount",
       document.image_width as "imageWidth",
       document.image_height as "imageHeight",
       document.plaintext_sha256 as "plaintextSha256",
       document.ciphertext_sha256 as "ciphertextSha256",
       document.wrapped_data_key as "wrappedDataKey",
       document.key_version as "keyVersion",
       document.storage_object_id as "storageObjectId",
       document.document_type as "documentType",
       document.source_locale as "sourceLocale",
       document.currency as "currency",
       document.extraction_revision as "extractionRevision",
       document.created_at as "createdAt",
       document.updated_at as "updatedAt",
       document.deleted_at as "deletedAt",
       document.deletion_proposal_id::text as "deletionProposalId",
       document.deletion_decision_id::text as "deletionDecisionId",
       document.deletion_target_binding_hash as "deletionTargetBindingHash",
       document.deletion_execution_binding_hash as "deletionExecutionBindingHash"
  from emdo.finance_documents as document`;

const documentFromRow = (row: unknown): FinanceDocumentMetadataView => {
  const parsed = parseResult(DocumentRowSchema, row, 'metadata');
  const hasGuardedDeletionReceipt =
    parsed.deletionProposalId !== null &&
    parsed.deletionDecisionId !== null &&
    parsed.deletionTargetBindingHash !== null &&
    parsed.deletionExecutionBindingHash !== null;
  const hasNoGuardedDeletionReceipt =
    parsed.deletionProposalId === null &&
    parsed.deletionDecisionId === null &&
    parsed.deletionTargetBindingHash === null &&
    parsed.deletionExecutionBindingHash === null;
  if (
    parsed.state === 'deleting' || parsed.state === 'deleted'
      ? !hasGuardedDeletionReceipt
      : !hasNoGuardedDeletionReceipt
  ) {
    throw new FinanceDocumentRepositoryError(
      'invalid-result',
      'Finance document deletion receipt state is invalid',
    );
  }
  if (parsed.state === 'deleted') {
    if (
      parsed.storageObjectId !== null ||
      parsed.displayName !== null ||
      parsed.mimeType !== null ||
      parsed.byteSize !== null ||
      parsed.pageCount !== null ||
      parsed.imageWidth !== null ||
      parsed.imageHeight !== null ||
      parsed.plaintextSha256 !== null ||
      parsed.ciphertextSha256 !== null ||
      parsed.wrappedDataKey !== null ||
      parsed.keyVersion !== null ||
      parsed.documentType !== null ||
      parsed.sourceLocale !== null ||
      parsed.currency !== null ||
      parsed.extractionRevision !== null ||
      parsed.deletedAt === null
    ) {
      throw new FinanceDocumentRepositoryError(
        'invalid-result',
        'Finance document tombstone retained content-bearing metadata',
      );
    }
  } else if (
    parsed.storageObjectId === null ||
    parsed.displayName === null ||
    parsed.mimeType === null ||
    parsed.byteSize === null ||
    parsed.plaintextSha256 === null ||
    parsed.ciphertextSha256 === null ||
    parsed.wrappedDataKey === null ||
    parsed.keyVersion === null
  ) {
    throw new FinanceDocumentRepositoryError(
      'invalid-result',
      'Finance document metadata is incomplete outside a tombstone',
    );
  }
  return deepFreeze({
    id: parsed.id,
    state: parsed.state,
    displayName: parsed.displayName,
    mimeType: parsed.mimeType,
    byteSize: parsed.byteSize,
    pageCount: parsed.pageCount,
    imageWidth: parsed.imageWidth,
    imageHeight: parsed.imageHeight,
    plaintextSha256: parsed.plaintextSha256,
    documentType: parsed.documentType,
    sourceLocale: parsed.sourceLocale,
    currency: parsed.currency,
    currencyLabel: labelCurrency(parsed.currency),
    extractionRevision: parsed.extractionRevision,
    createdAt: parsed.createdAt.toISOString(),
    updatedAt: parsed.updatedAt.toISOString(),
    deletedAt: parsed.deletedAt?.toISOString() ?? null,
  }) as FinanceDocumentMetadataView;
};

const envelopeFromCommittedReviewedPayload = (
  payload: FinanceDocumentReviewedPayload,
): FinanceDocumentEnvelopeV1 => {
  const parts = payload.chunks
    .flatMap((chunk) => {
      if (!chunk.content.startsWith(REVIEW_ENVELOPE_PREFIX)) return [];
      const encoded = chunk.content.slice(REVIEW_ENVELOPE_PREFIX.length);
      const match = /^(\d{1,3})\/(\d{1,3}):([A-Za-z0-9_-]+)$/u.exec(encoded);
      if (match === null) return [];
      return [
        {
          index: Number(match[1]),
          count: Number(match[2]),
          data: match[3],
        },
      ];
    })
    .sort((left, right) => left.index - right.index);
  const count = parts[0]?.count;
  if (
    count === undefined ||
    count < 1 ||
    count > MAXIMUM_REVIEW_ENVELOPE_CHUNKS ||
    parts.length !== count ||
    parts.some(
      (part, index) =>
        part.index !== index + 1 ||
        part.count !== count ||
        part.data.length > REVIEW_ENVELOPE_CHUNK_DATA_BYTES,
    )
  ) {
    throw new FinanceDocumentRepositoryError(
      'invalid-result',
      'The committed Finance review envelope is unavailable',
    );
  }
  const encoded = parts.map((part) => part.data).join('');
  if (
    encoded.length === 0 ||
    encoded.length > MAXIMUM_REVIEW_ENVELOPE_ENCODED_BYTES
  ) {
    throw new FinanceDocumentRepositoryError(
      'invalid-result',
      'The committed Finance review envelope is unavailable',
    );
  }
  const bytes = Buffer.from(encoded, 'base64url');
  try {
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength > MAXIMUM_REVIEW_ENVELOPE_ENCODED_BYTES ||
      bytes.toString('base64url') !== encoded
    ) {
      throw new FinanceDocumentRepositoryError(
        'invalid-result',
        'The committed Finance review envelope is unavailable',
      );
    }
    const envelope = FinanceDocumentEnvelopeV1Schema.safeParse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
    if (!envelope.success) {
      throw new FinanceDocumentRepositoryError(
        'invalid-result',
        'The committed Finance review envelope is unavailable',
      );
    }
    return envelope.data;
  } catch (error) {
    if (error instanceof FinanceDocumentRepositoryError) throw error;
    throw new FinanceDocumentRepositoryError(
      'invalid-result',
      'The committed Finance review envelope is unavailable',
    );
  } finally {
    bytes.fill(0);
  }
};

const occurredOnFromReviewedEnvelope = (
  envelope: FinanceDocumentEnvelopeV1,
): string | null => {
  const record = envelope as unknown as Readonly<Record<string, unknown>>;
  const values = [
    record.purchasedOn,
    envelope.issuedOn,
    envelope.dueOn,
    envelope.periodEnd,
    envelope.periodStart,
  ];
  return (
    values.find(
      (value): value is string =>
        typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value),
    ) ?? null
  );
};

const committedProjectionFromRow = (
  row: unknown,
): FinanceDocumentCommittedProjection => {
  const parsed = parseResult(
    CommittedProjectionRowSchema,
    row,
    'committed review projection',
  );
  const envelope = envelopeFromCommittedReviewedPayload(parsed.selectedFacts);
  if (
    envelope.documentType !== parsed.documentType ||
    envelope.sourceLocale !== parsed.sourceLocale ||
    envelope.currency !== parsed.currency ||
    parsed.selectedFacts.documentType !== parsed.documentType ||
    parsed.selectedFacts.sourceLocale !== parsed.sourceLocale ||
    parsed.selectedFacts.currency !== parsed.currency
  ) {
    throw new FinanceDocumentRepositoryError(
      'invalid-result',
      'The committed Finance review projection does not match the document',
    );
  }
  const amountMinor =
    envelope.currency !== null &&
    envelope.total !== null &&
    envelope.total.currency === envelope.currency
      ? envelope.total.minorUnits
      : null;
  return deepFreeze({
    id: parsed.id,
    documentType: parsed.documentType,
    sourceLocale: parsed.sourceLocale,
    currency: parsed.currency,
    currencyLabel: labelCurrency(parsed.currency),
    extractionRevision: parsed.extractionRevision,
    occurredOn: occurredOnFromReviewedEnvelope(envelope),
    amountMinor,
    committedAt: parsed.committedAt.toISOString(),
  }) as FinanceDocumentCommittedProjection;
};

const originalFromRow = (
  row: unknown,
): FinanceDocumentOriginalAuthorization => {
  const parsed = parseResult(DocumentRowSchema, row, 'original authorization');
  if (
    ![
      'uploaded',
      'extracting',
      'awaiting-review',
      'committed',
      'failed',
      // beginDelete is the one compensating-delete path that may retrieve the
      // already-authorized object metadata while the row is deleting.
      'deleting',
    ].includes(parsed.state) ||
    parsed.storageObjectId === null ||
    parsed.mimeType === null ||
    parsed.byteSize === null ||
    parsed.plaintextSha256 === null ||
    parsed.ciphertextSha256 === null ||
    parsed.wrappedDataKey === null ||
    parsed.keyVersion === null
  ) {
    throw new FinanceDocumentRepositoryError(
      'invalid-result',
      'Finance document original authorization is incomplete',
    );
  }
  return deepFreeze({
    id: parsed.id,
    storageObjectId: parsed.storageObjectId,
    mimeType: parsed.mimeType,
    byteSize: parsed.byteSize,
    pageCount: parsed.pageCount,
    imageWidth: parsed.imageWidth,
    imageHeight: parsed.imageHeight,
    plaintextSha256: parsed.plaintextSha256,
    ciphertextSha256: parsed.ciphertextSha256,
    wrappedDataKey: parsed.wrappedDataKey,
    keyVersion: parsed.keyVersion,
  }) as FinanceDocumentOriginalAuthorization;
};

const extractionFromRow = (row: unknown) =>
  deepFreeze(parseResult(ExtractionRowSchema, row, 'extraction'));

const reviewFromRow = (row: unknown): FinanceDocumentReviewDraft => {
  const parsed = parseResult(ReviewBatchRowSchema, row, 'review batch');
  return deepFreeze({
    id: parsed.id,
    documentId: parsed.documentId,
    extractionRevision: parsed.extractionRevision,
    authenticatedSessionId: parsed.authenticatedSessionId,
    spaceAccessGrantId: parsed.spaceAccessGrantId,
    scopeFingerprint: parsed.scopeFingerprint,
    payloadHash: parsed.payloadHash,
    reviewTokenHash: parsed.reviewTokenHash,
    idempotencyKey: parsed.idempotencyKey,
    selectedFacts: deepFreeze(
      parsed.selectedFacts,
    ) as FinanceDocumentReviewedPayload,
    expiresAt: parsed.expiresAt.toISOString(),
  }) as FinanceDocumentReviewDraft;
};

const requireDocumentForUpdate = async (
  client: DatabaseClient,
  principal: FinanceDocumentRepositoryPrincipal,
  documentId: string,
) => {
  const row = firstResultRow(
    await client.query(
      `${documentSelect}
        where document.household_id = $1
          and document.space_id = $2
          and document.original_owner_user_id = $3
          and document.id = $4
        for update`,
      [...scopeValues(principal), documentId],
    ),
  );
  if (row === undefined) {
    throw new FinanceDocumentRepositoryError(
      'document-not-found',
      'The Finance document is unavailable in the current private scope',
    );
  }
  return parseResult(DocumentRowSchema, row, 'document');
};

const lockOwnerPrivateSpace = async (
  client: DatabaseClient,
  principal: FinanceDocumentRepositoryPrincipal,
): Promise<void> => {
  const row = firstResultRow(
    await client.query(
      `select space.id::text as "id"
         from emdo.spaces as space
        where space.household_id = $1
          and space.id = $2
          and space.original_owner_user_id = $3
          and space.visibility = 'private'
        for update`,
      scopeValues(principal),
    ),
  );
  if (row === undefined) {
    throw new FinanceDocumentRepositoryError(
      'authorization-revoked',
      'The Finance document private scope is no longer active',
    );
  }
};

const invalidatePendingReviews = async (
  client: DatabaseClient,
  principal: FinanceDocumentRepositoryPrincipal,
  documentId: string,
) => {
  await client.query(
    `update emdo.finance_document_review_batches as review
        set state = 'invalidated', decided_at = pg_catalog.clock_timestamp()
      where review.household_id = $1
        and review.space_id = $2
        and review.original_owner_user_id = $3
        and review.document_id = $4
        and review.state = 'pending'`,
    [...scopeValues(principal), documentId],
  );
};

const expireReviewIfNeeded = async (
  client: DatabaseClient,
  principal: FinanceDocumentRepositoryPrincipal,
  reviewBatchId: string,
): Promise<boolean> => {
  const row = firstResultRow(
    await client.query(
      `update emdo.finance_document_review_batches as review
          set state = 'expired', decided_at = pg_catalog.clock_timestamp()
        where review.household_id = $1
          and review.space_id = $2
          and review.original_owner_user_id = $3
          and review.id = $4
          and review.state = 'pending'
          and review.expires_at <= pg_catalog.clock_timestamp()
      returning review.id::text as "id"`,
      [...scopeValues(principal), reviewBatchId],
    ),
  );
  return row !== undefined;
};

/**
 * Authenticated, private-space Finance document persistence.  Storage and
 * extraction providers are intentionally outside this class: callers supply
 * only already-encrypted object metadata and a server-validated review draft.
 */
export class PostgresFinanceDocumentRepository {
  readonly #createUuid: () => string;

  constructor(
    private readonly pool: DatabasePool,
    options: Readonly<{ generateUuid?: () => string }> = {},
  ) {
    this.#createUuid = options.generateUuid ?? randomUUID;
  }

  /** Deployment readiness has no user scope and never reads document rows. */
  async checkInfrastructureReady(): Promise<boolean> {
    let client: DatabaseClient | undefined;
    try {
      client = await this.pool.connect();
      const row = firstResultRow(
        await client.query('select emdo.finance_documents_ready() as "ready"'),
      );
      return parseResult(
        z.strictObject({ ready: z.boolean() }),
        row,
        'readiness',
      ).ready;
    } catch {
      return false;
    } finally {
      client?.release();
    }
  }

  async checkReady(input: unknown): Promise<boolean> {
    const parsed = parseInput(ScopedInputSchema, input);
    const principal = asPrincipal(parsed.principal);
    try {
      return await withScopedTransaction(
        this.pool,
        { principal, requestId: parsed.requestId },
        async (client) => {
          const row = firstResultRow(
            await client.query(
              'select emdo.finance_documents_ready() as "ready"',
            ),
          );
          return parseResult(
            z.strictObject({ ready: z.boolean() }),
            row,
            'readiness',
          ).ready;
        },
      );
    } catch (error) {
      if (
        error instanceof FinanceDocumentRepositoryError &&
        error.code === 'invalid-input'
      ) {
        throw error;
      }
      return false;
    }
  }

  async getOwnerQuota(input: unknown): Promise<
    Readonly<{
      documentCount: number;
      byteCount: number;
      maxDocuments: number;
      maxBytes: number;
    }>
  > {
    const parsed = parseInput(ScopedInputSchema, input);
    const principal = asPrincipal(parsed.principal);
    return withScopedTransaction(
      this.pool,
      { principal, requestId: parsed.requestId },
      async (client) => {
        const quota = parseResult(
          z.strictObject({
            documentCount: z.coerce.number().int().nonnegative(),
            byteCount: z.coerce.number().int().nonnegative(),
          }),
          firstResultRow(
            await client.query(
              `select count(*)::integer as "documentCount",
                      coalesce(sum(document.byte_size), 0)::text as "byteCount"
                 from emdo.finance_documents as document
                where document.household_id = $1
                  and document.original_owner_user_id = $2
                  and document.deleted_at is null`,
              [principal.householdId, principal.userId],
            ),
          ),
          'owner quota',
        );
        return deepFreeze({
          ...quota,
          maxDocuments: MAX_DOCUMENTS_PER_OWNER,
          maxBytes: MAX_BYTES_PER_OWNER,
        });
      },
    );
  }

  async createUploadedMetadata(input: unknown): Promise<
    | Readonly<{ status: 'created'; document: FinanceDocumentMetadataView }>
    | Readonly<{ status: 'duplicate'; document: FinanceDocumentMetadataView }>
    | Readonly<{
        status: 'quota-exceeded';
        documentCount: number;
        byteCount: number;
        maxDocuments: number;
        maxBytes: number;
      }>
  > {
    const parsed = parseInput(StorageMetadataInputSchema, input);
    const principal = asPrincipal(parsed.principal);
    return withScopedTransaction(
      this.pool,
      { principal, requestId: parsed.requestId },
      async (client) => {
        await lockOwnerPrivateSpace(client, principal);
        const existing = firstResultRow(
          await client.query(
            `${documentSelect}
            where document.household_id = $1
              and document.space_id = $2
              and document.original_owner_user_id = $3
              and document.plaintext_sha256 = $4
              and document.deleted_at is null
            order by document.created_at, document.id
            limit 1
            for update`,
            [...scopeValues(principal), parsed.storage.plaintextSha256],
          ),
        );
        if (existing !== undefined) {
          return deepFreeze({
            status: 'duplicate' as const,
            document: documentFromRow(existing),
          });
        }

        const quota = parseResult(
          z.strictObject({
            documentCount: z.coerce.number().int().nonnegative(),
            byteCount: z.coerce.number().int().nonnegative(),
          }),
          firstResultRow(
            await client.query(
              `select count(*)::integer as "documentCount",
                    coalesce(sum(document.byte_size), 0)::text as "byteCount"
               from emdo.finance_documents as document
              where document.household_id = $1
                and document.space_id = $2
                and document.original_owner_user_id = $3
                and document.deleted_at is null`,
              scopeValues(principal),
            ),
          ),
          'quota',
        );
        if (
          quota.documentCount >= MAX_DOCUMENTS_PER_OWNER ||
          quota.byteCount + parsed.storage.byteSize > MAX_BYTES_PER_OWNER
        ) {
          return deepFreeze({
            status: 'quota-exceeded' as const,
            documentCount: quota.documentCount,
            byteCount: quota.byteCount,
            maxDocuments: MAX_DOCUMENTS_PER_OWNER,
            maxBytes: MAX_BYTES_PER_OWNER,
          });
        }

        const documentId = parseInput(UuidSchema, this.#createUuid());
        const inserted = firstResultRow(
          await client.query(
            `insert into emdo.finance_documents (
             id, household_id, space_id, original_owner_user_id,
             storage_object_id, display_name, mime_type, byte_size, page_count,
             image_width, image_height, plaintext_sha256, ciphertext_sha256,
             wrapped_data_key, key_version, state, created_at, updated_at
           )
           select $4::uuid, scope.household_id, scope.id,
                  scope.original_owner_user_id,
                  $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15,
                  'uploaded', pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()
             from emdo.spaces as scope
            where scope.household_id = $1
              and scope.id = $2
              and scope.original_owner_user_id = $3
              and scope.visibility = 'private'
           returning id::text as "id", state as "state",
                     display_name as "displayName", mime_type as "mimeType",
                     byte_size as "byteSize", page_count as "pageCount",
                     image_width as "imageWidth", image_height as "imageHeight",
                     plaintext_sha256 as "plaintextSha256",
                     ciphertext_sha256 as "ciphertextSha256",
                     wrapped_data_key as "wrappedDataKey", key_version as "keyVersion",
                     storage_object_id as "storageObjectId", document_type as "documentType",
                     source_locale as "sourceLocale", currency as "currency",
                     extraction_revision as "extractionRevision", created_at as "createdAt",
                     updated_at as "updatedAt", deleted_at as "deletedAt",
                     deletion_proposal_id::text as "deletionProposalId",
                     deletion_decision_id::text as "deletionDecisionId",
                     deletion_target_binding_hash as "deletionTargetBindingHash",
                     deletion_execution_binding_hash as "deletionExecutionBindingHash"`,
            [
              ...scopeValues(principal),
              documentId,
              parsed.storage.storageObjectId,
              parsed.storage.displayName,
              parsed.storage.mimeType,
              parsed.storage.byteSize,
              parsed.storage.pageCount,
              parsed.storage.imageWidth,
              parsed.storage.imageHeight,
              parsed.storage.plaintextSha256,
              parsed.storage.ciphertextSha256,
              parsed.storage.wrappedDataKey,
              parsed.storage.keyVersion,
            ],
          ),
        );
        if (inserted === undefined) {
          throw new FinanceDocumentRepositoryError(
            'authorization-revoked',
            'The Finance document private scope is no longer active',
          );
        }
        return deepFreeze({
          status: 'created' as const,
          document: documentFromRow(inserted),
        });
      },
    );
  }

  async list(input: unknown): Promise<
    Readonly<{
      documents: readonly FinanceDocumentMetadataView[];
      nextCursor: Readonly<{ updatedAt: string; id: string }> | null;
    }>
  > {
    const parsed = parseInput(ListInputSchema, input);
    const principal = asPrincipal(parsed.principal);
    return withScopedTransaction(
      this.pool,
      { principal, requestId: parsed.requestId },
      async (client) => {
        const rows = await client.query(
          `${documentSelect}
          where document.household_id = $1
            and document.space_id = $2
            and document.original_owner_user_id = $3
            and ($4::text[] = '{}'::text[] or document.state = any($4::text[]))
            and ($5::text[] = '{}'::text[] or document.document_type = any($5::text[]))
            and ($6::boolean or document.deleted_at is null)
            and document.state <> 'deleting'
            and (
              $7::timestamptz is null
              or (document.updated_at, document.id) < ($7::timestamptz, $8::uuid)
            )
          order by document.updated_at desc, document.id desc
          limit $9`,
          [
            ...scopeValues(principal),
            parsed.states,
            parsed.documentTypes,
            parsed.includeDeleted,
            parsed.cursor?.updatedAt ?? null,
            parsed.cursor?.id ?? null,
            parsed.limit + 1,
          ],
        );
        const documents = rows.rows.slice(0, parsed.limit).map(documentFromRow);
        const tail = documents.at(-1);
        return deepFreeze({
          documents,
          nextCursor:
            rows.rows.length > parsed.limit && tail !== undefined
              ? { updatedAt: tail.updatedAt, id: tail.id }
              : null,
        });
      },
    );
  }

  async getMetadata(
    input: unknown,
  ): Promise<FinanceDocumentMetadataView | undefined> {
    const parsed = parseInput(DocumentInputSchema, input);
    const principal = asPrincipal(parsed.principal);
    return withScopedTransaction(
      this.pool,
      { principal, requestId: parsed.requestId },
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `${documentSelect}
            where document.household_id = $1
              and document.space_id = $2
              and document.original_owner_user_id = $3
              and document.id = $4
              and document.state <> 'deleting'`,
            [...scopeValues(principal), parsed.documentId],
          ),
        );
        return row === undefined ? undefined : documentFromRow(row);
      },
    );
  }

  /**
   * Returns only facts from the committed review bound to the document's
   * current extraction revision. This deliberately never consults draft or
   * encrypted extraction payloads, and its timestamp is the review decision.
   */
  async getCommittedProjection(
    input: unknown,
  ): Promise<FinanceDocumentCommittedProjection | undefined> {
    const parsed = parseInput(DocumentInputSchema, input);
    const principal = asPrincipal(parsed.principal);
    return withScopedTransaction(
      this.pool,
      { principal, requestId: parsed.requestId },
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `select document.id::text as "id",
                    document.document_type as "documentType",
                    document.source_locale as "sourceLocale",
                    document.currency as "currency",
                    document.extraction_revision as "extractionRevision",
                    review.selected_facts as "selectedFacts",
                    review.decided_at as "committedAt"
               from emdo.finance_documents as document
               join emdo.finance_document_review_batches as review
                 on review.document_id = document.id
                and review.household_id = document.household_id
                and review.space_id = document.space_id
                and review.original_owner_user_id = document.original_owner_user_id
              where document.household_id = $1
                and document.space_id = $2
                and document.original_owner_user_id = $3
                and document.id = $4
                and document.state = 'committed'
                and document.deleted_at is null
                and document.extraction_revision is not null
                and review.extraction_revision = document.extraction_revision
                and review.state = 'committed'
                and review.decided_at is not null
              order by review.decided_at desc, review.id
              limit 1`,
            [...scopeValues(principal), parsed.documentId],
          ),
        );
        return row === undefined ? undefined : committedProjectionFromRow(row);
      },
    );
  }

  async getOriginalAuthorization(
    input: unknown,
  ): Promise<FinanceDocumentOriginalAuthorization | undefined> {
    const parsed = parseInput(DocumentInputSchema, input);
    const principal = asPrincipal(parsed.principal);
    return withScopedTransaction(
      this.pool,
      { principal, requestId: parsed.requestId },
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `${documentSelect}
            where document.household_id = $1
              and document.space_id = $2
              and document.original_owner_user_id = $3
              and document.id = $4
              and document.deleted_at is null
              and document.state = any($5::text[])`,
            [
              ...scopeValues(principal),
              parsed.documentId,
              [
                'uploaded',
                'extracting',
                'awaiting-review',
                'committed',
                'failed',
              ],
            ],
          ),
        );
        return row === undefined ? undefined : originalFromRow(row);
      },
    );
  }

  /**
   * Internal-only content-free receipt used to resume an exact approved
   * deletion after object storage has failed. No caller can select this by a
   * decision UUID alone: begin/finalize below compare every field again while
   * holding the owner-scoped document row lock.
   */
  async getGuardedDeleteReceipt(input: unknown): Promise<
    | Readonly<{
        state: 'deleting' | 'deleted';
        receipt: z.output<typeof GuardedDeleteReceiptSchema>;
      }>
    | undefined
  > {
    const parsed = parseInput(DocumentInputSchema, input);
    const principal = asPrincipal(parsed.principal);
    return withScopedTransaction(
      this.pool,
      { principal, requestId: parsed.requestId },
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `select document.state as "state",
                    document.deletion_proposal_id::text as "proposalId",
                    document.deletion_decision_id::text as "decisionId",
                    document.deletion_target_binding_hash as "targetBindingHash",
                    document.deletion_execution_binding_hash as "executionBindingHash"
               from emdo.finance_documents as document
              where document.household_id = $1
                and document.space_id = $2
                and document.original_owner_user_id = $3
                and document.id = $4
                and document.state = any($5::text[])
              limit 1`,
            [
              ...scopeValues(principal),
              parsed.documentId,
              ['deleting', 'deleted'],
            ],
          ),
        );
        if (row === undefined) return undefined;
        const parsedReceipt = parseResult(
          z.strictObject({
            state: z.enum(['deleting', 'deleted']),
            proposalId: UuidSchema,
            decisionId: UuidSchema,
            targetBindingHash: Sha256Schema,
            executionBindingHash: Sha256Schema,
          }),
          row,
          'guarded deletion receipt',
        );
        return deepFreeze({
          state: parsedReceipt.state,
          receipt: deepFreeze({
            proposalId: parsedReceipt.proposalId,
            decisionId: parsedReceipt.decisionId,
            targetBindingHash: parsedReceipt.targetBindingHash,
            executionBindingHash: parsedReceipt.executionBindingHash,
          }),
        });
      },
    );
  }

  async createOrRetryExtractionRevision(input: unknown): Promise<
    Readonly<{
      id: string;
      documentId: string;
      revision: number;
      attempt: number;
      state: 'queued';
    }>
  > {
    const parsed = parseInput(ExtractionCreateInputSchema, input);
    const principal = asPrincipal(parsed.principal);
    return withScopedTransaction(
      this.pool,
      { principal, requestId: parsed.requestId },
      async (client) => {
        const document = await requireDocumentForUpdate(
          client,
          principal,
          parsed.documentId,
        );
        if (document.state === 'deleting' || document.state === 'deleted') {
          throw new FinanceDocumentRepositoryError(
            'document-unavailable',
            'Deletion-state Finance documents cannot be extracted',
          );
        }
        if (document.state === 'extracting') {
          throw new FinanceDocumentRepositoryError(
            'conflict',
            'A Finance document extraction is already active',
          );
        }
        const eligibleInitial = document.state === 'uploaded';
        const eligibleRetry =
          parsed.retry &&
          (document.state === 'failed' || document.state === 'awaiting-review');
        if (!eligibleInitial && !eligibleRetry) {
          throw new FinanceDocumentRepositoryError(
            'document-unavailable',
            'The Finance document is not eligible for this extraction revision',
          );
        }
        if (eligibleInitial && parsed.retry) {
          throw new FinanceDocumentRepositoryError(
            'invalid-input',
            'The first Finance document extraction cannot be marked as a retry',
          );
        }

        const latestRow = firstResultRow(
          await client.query(
            `select extraction.id::text as "id", extraction.revision as "revision",
                  extraction.attempt as "attempt", extraction.state as "state"
             from emdo.finance_document_extractions as extraction
            where extraction.household_id = $1
              and extraction.space_id = $2
              and extraction.original_owner_user_id = $3
              and extraction.document_id = $4
            order by extraction.revision desc
            limit 1
            for update`,
            [...scopeValues(principal), parsed.documentId],
          ),
        );
        const latest =
          latestRow === undefined ? undefined : extractionFromRow(latestRow);
        const revision = (latest?.revision ?? 0) + 1;
        const attempt = latest === undefined ? 1 : latest.attempt + 1;
        if (attempt > 2) {
          throw new FinanceDocumentRepositoryError(
            'retry-exhausted',
            'The Finance document has exhausted its bounded extraction retries',
          );
        }

        await client.query(
          `update emdo.finance_document_extractions as extraction
            set state = 'superseded',
                completed_at = coalesce(extraction.completed_at, pg_catalog.clock_timestamp())
          where extraction.household_id = $1
            and extraction.space_id = $2
            and extraction.original_owner_user_id = $3
            and extraction.document_id = $4
            and extraction.state = any($5::text[])`,
          [
            ...scopeValues(principal),
            parsed.documentId,
            ['queued', 'extracting', 'awaiting-review'],
          ],
        );
        await invalidatePendingReviews(client, principal, parsed.documentId);

        const extractionId = parseInput(UuidSchema, this.#createUuid());
        const created = firstResultRow(
          await client.query(
            `insert into emdo.finance_document_extractions (
             id, document_id, household_id, space_id, original_owner_user_id,
             revision, attempt, state, model, schema_version
           )
           select $5::uuid, document.id, document.household_id, document.space_id,
                  document.original_owner_user_id, $6, $7, 'queued', $8, 1
             from emdo.finance_documents as document
            where document.household_id = $1
              and document.space_id = $2
              and document.original_owner_user_id = $3
              and document.id = $4
              and document.state = any($9::text[])
           returning id::text as "id", revision as "revision", attempt as "attempt",
                     state as "state"`,
            [
              ...scopeValues(principal),
              parsed.documentId,
              extractionId,
              revision,
              attempt,
              parsed.model,
              ['uploaded', 'failed', 'awaiting-review'],
            ],
          ),
        );
        if (created === undefined) {
          throw new FinanceDocumentRepositoryError(
            'conflict',
            'The Finance document lifecycle changed before extraction could begin',
          );
        }
        const documentUpdated = await client.query(
          `update emdo.finance_documents as document
            set state = 'extracting', extraction_revision = $5,
                updated_at = pg_catalog.clock_timestamp()
          where document.household_id = $1
            and document.space_id = $2
            and document.original_owner_user_id = $3
            and document.id = $4
            and document.state = any($6::text[])`,
          [
            ...scopeValues(principal),
            parsed.documentId,
            revision,
            ['uploaded', 'failed', 'awaiting-review'],
          ],
        );
        if (documentUpdated.rowCount !== 1) {
          throw new FinanceDocumentRepositoryError(
            'conflict',
            'The Finance document lifecycle changed before extraction could begin',
          );
        }
        const extraction = extractionFromRow(created);
        if (extraction.state !== 'queued') {
          throw new FinanceDocumentRepositoryError(
            'invalid-result',
            'The Finance document extraction was not queued',
          );
        }
        return deepFreeze({
          id: extraction.id,
          documentId: parsed.documentId,
          revision: extraction.revision,
          attempt: extraction.attempt,
          state: 'queued' as const,
        });
      },
    );
  }

  /** Stores only encrypted, validated extraction material or a safe error code. */
  async completeExtraction(input: unknown): Promise<
    Readonly<{
      documentId: string;
      extractionRevision: number;
      state: 'awaiting-review' | 'failed';
    }>
  > {
    const parsed = parseInput(ExtractionCompletionInputSchema, input);
    const principal = asPrincipal(parsed.principal);
    return withScopedTransaction(
      this.pool,
      { principal, requestId: parsed.requestId },
      async (client) => {
        const document = await requireDocumentForUpdate(
          client,
          principal,
          parsed.documentId,
        );
        if (
          document.state !== 'extracting' ||
          document.extractionRevision !== parsed.extractionRevision
        ) {
          throw new FinanceDocumentRepositoryError(
            'document-unavailable',
            'The Finance document extraction is no longer current',
          );
        }
        const extractionRow = firstResultRow(
          await client.query(
            `select extraction.id::text as "id", extraction.revision as "revision",
                  extraction.attempt as "attempt", extraction.state as "state"
             from emdo.finance_document_extractions as extraction
            where extraction.household_id = $1
              and extraction.space_id = $2
              and extraction.original_owner_user_id = $3
              and extraction.document_id = $4
              and extraction.revision = $5
            for update`,
            [
              ...scopeValues(principal),
              parsed.documentId,
              parsed.extractionRevision,
            ],
          ),
        );
        if (extractionRow === undefined) {
          throw new FinanceDocumentRepositoryError(
            'extraction-not-found',
            'The Finance document extraction is unavailable',
          );
        }
        const extraction = extractionFromRow(extractionRow);
        if (!['queued', 'extracting'].includes(extraction.state)) {
          throw new FinanceDocumentRepositoryError(
            'conflict',
            'The Finance document extraction has already reached a terminal state',
          );
        }
        const extractionUpdate =
          parsed.outcome.state === 'awaiting-review'
            ? await client.query(
                `update emdo.finance_document_extractions as extraction
              set state = 'awaiting-review', encrypted_payload = $6::jsonb,
                  redacted_summary = $7::jsonb, response_hash = $8,
                  input_tokens = $9, output_tokens = $10,
                  completed_at = pg_catalog.clock_timestamp()
            where extraction.household_id = $1
              and extraction.space_id = $2
              and extraction.original_owner_user_id = $3
              and extraction.document_id = $4
              and extraction.revision = $5
              and extraction.state = any($11::text[])`,
                [
                  ...scopeValues(principal),
                  parsed.documentId,
                  parsed.extractionRevision,
                  parsed.outcome.encryptedPayload,
                  parsed.outcome.redactedSummary,
                  parsed.outcome.responseHash,
                  parsed.outcome.inputTokens,
                  parsed.outcome.outputTokens,
                  ['queued', 'extracting'],
                ],
              )
            : await client.query(
                `update emdo.finance_document_extractions as extraction
              set state = 'failed', safe_error_code = $6, response_hash = $7,
                  input_tokens = $8, output_tokens = $9,
                  completed_at = pg_catalog.clock_timestamp()
            where extraction.household_id = $1
              and extraction.space_id = $2
              and extraction.original_owner_user_id = $3
              and extraction.document_id = $4
              and extraction.revision = $5
              and extraction.state = any($10::text[])`,
                [
                  ...scopeValues(principal),
                  parsed.documentId,
                  parsed.extractionRevision,
                  parsed.outcome.safeErrorCode,
                  parsed.outcome.responseHash,
                  parsed.outcome.inputTokens,
                  parsed.outcome.outputTokens,
                  ['queued', 'extracting'],
                ],
              );
        if (extractionUpdate.rowCount !== 1) {
          throw new FinanceDocumentRepositoryError(
            'conflict',
            'The Finance extraction changed while recording its terminal result',
          );
        }
        const documentUpdate = await client.query(
          `update emdo.finance_documents as document
            set state = $5, updated_at = pg_catalog.clock_timestamp()
          where document.household_id = $1
            and document.space_id = $2
            and document.original_owner_user_id = $3
            and document.id = $4
            and document.state = 'extracting'
            and document.extraction_revision = $6`,
          [
            ...scopeValues(principal),
            parsed.documentId,
            parsed.outcome.state,
            parsed.extractionRevision,
          ],
        );
        if (documentUpdate.rowCount !== 1) {
          throw new FinanceDocumentRepositoryError(
            'conflict',
            'The Finance document lifecycle changed while recording extraction output',
          );
        }
        return deepFreeze({
          documentId: parsed.documentId,
          extractionRevision: parsed.extractionRevision,
          state: parsed.outcome.state,
        });
      },
    );
  }

  async getCurrentExtraction(
    input: unknown,
  ): Promise<FinanceDocumentCurrentExtraction> {
    const parsed = parseInput(DocumentInputSchema, input);
    const principal = asPrincipal(parsed.principal);
    return withScopedTransaction(
      this.pool,
      { principal, requestId: parsed.requestId },
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `select document.id::text as "documentId",
                    document.extraction_revision as "extractionRevision",
                    document.document_type as "documentType",
                    document.source_locale as "sourceLocale",
                    document.currency as "currency",
                    extraction.encrypted_payload as "encryptedPayload"
               from emdo.finance_documents as document
               join emdo.finance_document_extractions as extraction
                 on extraction.document_id = document.id
                and extraction.household_id = document.household_id
                and extraction.space_id = document.space_id
                and extraction.original_owner_user_id = document.original_owner_user_id
                and extraction.revision = document.extraction_revision
              where document.household_id = $1
                and document.space_id = $2
                and document.original_owner_user_id = $3
                and document.id = $4
                and document.state = 'awaiting-review'
                and document.deleted_at is null
                and extraction.state = 'awaiting-review'
                and extraction.encrypted_payload is not null
              limit 1`,
            [...scopeValues(principal), parsed.documentId],
          ),
        );
        if (row === undefined) {
          throw new FinanceDocumentRepositoryError(
            'review-unavailable',
            'The current Finance extraction is unavailable for review',
          );
        }
        return deepFreeze(
          parseResult(CurrentExtractionRowSchema, row, 'current extraction'),
        ) as FinanceDocumentCurrentExtraction;
      },
    );
  }

  async getCurrentReviewDraft(
    input: unknown,
  ): Promise<FinanceDocumentReviewDraft | undefined> {
    const parsed = parseInput(DocumentInputSchema, input);
    const principal = asPrincipal(parsed.principal);
    return withScopedTransaction(
      this.pool,
      { principal, requestId: parsed.requestId },
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `select review.id::text as "id", review.document_id::text as "documentId",
                  review.extraction_revision as "extractionRevision",
                  review.authenticated_session_id::text as "authenticatedSessionId",
                  review.space_access_grant_id::text as "spaceAccessGrantId",
                  review.scope_fingerprint as "scopeFingerprint",
                  review.payload_hash as "payloadHash",
                  review.review_token_hash as "reviewTokenHash",
                  review.selected_facts as "selectedFacts", review.state as "state",
                  review.idempotency_key as "idempotencyKey", review.expires_at as "expiresAt"
             from emdo.finance_document_review_batches as review
             join emdo.finance_documents as document
               on document.id = review.document_id
              and document.household_id = review.household_id
              and document.space_id = review.space_id
              and document.original_owner_user_id = review.original_owner_user_id
            where review.household_id = $1
              and review.space_id = $2
              and review.original_owner_user_id = $3
              and review.document_id = $4
              and review.extraction_revision = document.extraction_revision
              and review.authenticated_session_id = $5
              and review.scope_fingerprint = $6
              and review.state = 'pending'
              and review.expires_at > pg_catalog.clock_timestamp()
              and document.state = 'awaiting-review'
              and document.deleted_at is null
            order by review.created_at desc, review.id desc
            limit 1`,
            [
              ...scopeValues(principal),
              parsed.documentId,
              principal.sessionId,
              principal.scopeFingerprint,
            ],
          ),
        );
        return row === undefined ? undefined : reviewFromRow(row);
      },
    );
  }

  async getCommittedReviewAuthorization(
    input: unknown,
  ): Promise<FinanceDocumentReviewDraft | undefined> {
    const parsed = parseInput(CommittedReviewInputSchema, input);
    const principal = asPrincipal(parsed.principal);
    const reviewTokenHash = sha256(parsed.reviewToken);
    return withScopedTransaction(
      this.pool,
      { principal, requestId: parsed.requestId },
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `select review.id::text as "id", review.document_id::text as "documentId",
                    review.extraction_revision as "extractionRevision",
                    review.authenticated_session_id::text as "authenticatedSessionId",
                    review.space_access_grant_id::text as "spaceAccessGrantId",
                    review.scope_fingerprint as "scopeFingerprint",
                    review.payload_hash as "payloadHash",
                    review.review_token_hash as "reviewTokenHash",
                    review.selected_facts as "selectedFacts", review.state as "state",
                    review.idempotency_key as "idempotencyKey",
                    review.expires_at as "expiresAt"
               from emdo.finance_document_review_batches as review
               join emdo.finance_documents as document
                 on document.id = review.document_id
                and document.household_id = review.household_id
                and document.space_id = review.space_id
                and document.original_owner_user_id = review.original_owner_user_id
              where review.household_id = $1
                and review.space_id = $2
                and review.original_owner_user_id = $3
                and review.document_id = $4
                and review.extraction_revision = document.extraction_revision
                and review.authenticated_session_id = $5
                and review.scope_fingerprint = $6
                and review.review_token_hash = $7
                and review.state = 'committed'
                and document.state = 'committed'
                and document.deleted_at is null
              order by review.decided_at desc, review.id desc
              limit 1`,
            [
              ...scopeValues(principal),
              parsed.documentId,
              principal.sessionId,
              principal.scopeFingerprint,
              reviewTokenHash,
            ],
          ),
        );
        return row === undefined ? undefined : reviewFromRow(row);
      },
    );
  }

  /**
   * Server-only current committed-review lookup for an already owner-scoped
   * guarded document action.  Unlike the public-token lookup above, this
   * never accepts a review token and must not be exposed through HTTP.
   */
  async getCurrentCommittedReview(
    input: unknown,
  ): Promise<FinanceDocumentReviewDraft | undefined> {
    const parsed = parseInput(DocumentInputSchema, input);
    const principal = asPrincipal(parsed.principal);
    return withScopedTransaction(
      this.pool,
      { principal, requestId: parsed.requestId },
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `select review.id::text as "id", review.document_id::text as "documentId",
                    review.extraction_revision as "extractionRevision",
                    review.authenticated_session_id::text as "authenticatedSessionId",
                    review.space_access_grant_id::text as "spaceAccessGrantId",
                    review.scope_fingerprint as "scopeFingerprint",
                    review.payload_hash as "payloadHash",
                    review.review_token_hash as "reviewTokenHash",
                    review.selected_facts as "selectedFacts", review.state as "state",
                    review.idempotency_key as "idempotencyKey",
                    review.expires_at as "expiresAt"
               from emdo.finance_document_review_batches as review
               join emdo.finance_documents as document
                 on document.id = review.document_id
                and document.household_id = review.household_id
                and document.space_id = review.space_id
                and document.original_owner_user_id = review.original_owner_user_id
              where review.household_id = $1
                and review.space_id = $2
                and review.original_owner_user_id = $3
                and review.document_id = $4
                and review.extraction_revision = document.extraction_revision
                and review.authenticated_session_id = $5
                and review.scope_fingerprint = $6
                and review.state = 'committed'
                and document.state = 'committed'
                and document.deleted_at is null
              order by review.decided_at desc, review.id desc
              limit 1`,
            [
              ...scopeValues(principal),
              parsed.documentId,
              principal.sessionId,
              principal.scopeFingerprint,
            ],
          ),
        );
        return row === undefined ? undefined : reviewFromRow(row);
      },
    );
  }

  async replaceCurrentReviewDraft(input: unknown): Promise<
    Readonly<{
      status: 'created' | 'replayed';
      review: FinanceDocumentReviewDraft;
    }>
  > {
    const parsed = parseInput(ReplaceReviewDraftInputSchema, input);
    const principal = asPrincipal(parsed.principal);
    const payloadHash = sha256(stableJson(parsed.selectedFacts));
    const reviewTokenHash = sha256(parsed.reviewToken);
    return withScopedTransaction(
      this.pool,
      { principal, requestId: parsed.requestId },
      async (client) => {
        const document = await requireDocumentForUpdate(
          client,
          principal,
          parsed.documentId,
        );
        if (
          document.state !== 'awaiting-review' ||
          document.deletedAt !== null ||
          document.extractionRevision !== parsed.extractionRevision
        ) {
          throw new FinanceDocumentRepositoryError(
            'review-unavailable',
            'The Finance document is not awaiting this review revision',
          );
        }
        const extraction = firstResultRow(
          await client.query(
            `select extraction.id::text as "id", extraction.revision as "revision",
                  extraction.attempt as "attempt", extraction.state as "state"
             from emdo.finance_document_extractions as extraction
            where extraction.household_id = $1
              and extraction.space_id = $2
              and extraction.original_owner_user_id = $3
              and extraction.document_id = $4
              and extraction.revision = $5
            for update`,
            [
              ...scopeValues(principal),
              parsed.documentId,
              parsed.extractionRevision,
            ],
          ),
        );
        if (
          extraction === undefined ||
          extractionFromRow(extraction).state !== 'awaiting-review'
        ) {
          throw new FinanceDocumentRepositoryError(
            'review-unavailable',
            'The Finance extraction cannot issue a review draft',
          );
        }
        const idempotent = firstResultRow(
          await client.query(
            `select review.id::text as "id", review.document_id::text as "documentId",
                  review.extraction_revision as "extractionRevision",
                  review.authenticated_session_id::text as "authenticatedSessionId",
                  review.space_access_grant_id::text as "spaceAccessGrantId",
                  review.scope_fingerprint as "scopeFingerprint",
                  review.payload_hash as "payloadHash",
                  review.review_token_hash as "reviewTokenHash",
                  review.selected_facts as "selectedFacts", review.state as "state",
                  review.idempotency_key as "idempotencyKey", review.expires_at as "expiresAt"
             from emdo.finance_document_review_batches as review
            where review.household_id = $1
              and review.space_id = $2
              and review.original_owner_user_id = $3
              and review.idempotency_key = $4
            for update`,
            [...scopeValues(principal), parsed.idempotencyKey],
          ),
        );
        if (idempotent !== undefined) {
          const existing = parseResult(
            ReviewBatchRowSchema,
            idempotent,
            'review batch',
          );
          const exact =
            existing.documentId === parsed.documentId &&
            existing.extractionRevision === parsed.extractionRevision &&
            existing.authenticatedSessionId === principal.sessionId &&
            existing.scopeFingerprint === principal.scopeFingerprint &&
            existing.payloadHash === payloadHash &&
            existing.reviewTokenHash === reviewTokenHash;
          if (exact && existing.state === 'pending') {
            if (await expireReviewIfNeeded(client, principal, existing.id)) {
              throw new FinanceDocumentRepositoryError(
                'review-expired',
                'The Finance document review draft expired',
              );
            }
            return deepFreeze({
              status: 'replayed' as const,
              review: reviewFromRow(idempotent),
            });
          }
          throw new FinanceDocumentRepositoryError(
            'conflict',
            'The Finance document idempotency key is already bound to another review',
          );
        }

        await invalidatePendingReviews(client, principal, parsed.documentId);
        const reviewId = parseInput(UuidSchema, this.#createUuid());
        const row = firstResultRow(
          await client.query(
            `insert into emdo.finance_document_review_batches (
             id, document_id, extraction_revision, household_id, space_id,
             original_owner_user_id, authenticated_session_id, space_access_grant_id,
             scope_fingerprint, payload_hash, review_token_hash, selected_facts,
             state, idempotency_key, created_at, expires_at
           )
           select $5::uuid, document.id, $6, document.household_id, document.space_id,
                  document.original_owner_user_id, $7::uuid, $8::uuid, $9, $10, $11,
                  $12::jsonb, 'pending', $13, pg_catalog.statement_timestamp(),
                  pg_catalog.statement_timestamp() + interval '30 minutes'
             from emdo.finance_documents as document
            where document.household_id = $1
              and document.space_id = $2
              and document.original_owner_user_id = $3
              and document.id = $4
              and document.state = 'awaiting-review'
              and document.extraction_revision = $6
              and document.deleted_at is null
           returning id::text as "id", document_id::text as "documentId",
                     extraction_revision as "extractionRevision",
                     authenticated_session_id::text as "authenticatedSessionId",
                     space_access_grant_id::text as "spaceAccessGrantId",
                     scope_fingerprint as "scopeFingerprint", payload_hash as "payloadHash",
                     review_token_hash as "reviewTokenHash", selected_facts as "selectedFacts",
                     state as "state", idempotency_key as "idempotencyKey",
                     expires_at as "expiresAt"`,
            [
              ...scopeValues(principal),
              parsed.documentId,
              reviewId,
              parsed.extractionRevision,
              principal.sessionId,
              principal.spaceAccessGrantId,
              principal.scopeFingerprint,
              payloadHash,
              reviewTokenHash,
              parsed.selectedFacts,
              parsed.idempotencyKey,
            ],
          ),
        );
        if (row === undefined) {
          throw new FinanceDocumentRepositoryError(
            'review-unavailable',
            'The Finance document review draft could not be issued',
          );
        }
        return deepFreeze({
          status: 'created' as const,
          review: reviewFromRow(row),
        });
      },
    );
  }

  async commitReview(input: unknown): Promise<
    Readonly<{
      status: 'committed' | 'replayed';
      documentId: string;
      extractionRevision: number;
      documentType: FinanceDocumentReviewedPayload['documentType'];
      currency: string | null;
      currencyLabel: FinanceDocumentCurrencyLabel;
      chunksCommitted: number;
      evidenceCommitted: number;
      matchSuggestionsCommitted: number;
    }>
  > {
    const parsed = parseInput(CommitReviewInputSchema, input);
    const principal = asPrincipal(parsed.principal);
    const tokenHash = sha256(parsed.reviewToken);
    return withScopedTransaction(
      this.pool,
      { principal, requestId: parsed.requestId },
      async (client) => {
        const document = await requireDocumentForUpdate(
          client,
          principal,
          parsed.documentId,
        );
        if (document.state === 'deleting' || document.state === 'deleted') {
          throw new FinanceDocumentRepositoryError(
            'document-unavailable',
            'Deletion-state Finance documents cannot be reviewed',
          );
        }
        const reviewRow = firstResultRow(
          await client.query(
            `select review.id::text as "id", review.document_id::text as "documentId",
                  review.extraction_revision as "extractionRevision",
                  review.authenticated_session_id::text as "authenticatedSessionId",
                  review.space_access_grant_id::text as "spaceAccessGrantId",
                  review.scope_fingerprint as "scopeFingerprint",
                  review.payload_hash as "payloadHash",
                  review.review_token_hash as "reviewTokenHash",
                  review.selected_facts as "selectedFacts", review.state as "state",
                  review.idempotency_key as "idempotencyKey", review.expires_at as "expiresAt"
             from emdo.finance_document_review_batches as review
            where review.household_id = $1
              and review.space_id = $2
              and review.original_owner_user_id = $3
              and review.id = $4
              and review.document_id = $5
              and review.extraction_revision = $6
              and review.authenticated_session_id = $7
              and review.scope_fingerprint = $8
              and review.payload_hash = $9
              and review.review_token_hash = $10
              and review.idempotency_key = $11
            for update`,
            [
              ...scopeValues(principal),
              parsed.reviewBatchId,
              parsed.documentId,
              parsed.extractionRevision,
              principal.sessionId,
              principal.scopeFingerprint,
              parsed.payloadHash,
              tokenHash,
              parsed.idempotencyKey,
            ],
          ),
        );
        if (reviewRow === undefined) {
          throw new FinanceDocumentRepositoryError(
            'review-not-found',
            'The Finance document review authorization is unavailable',
          );
        }
        const review = parseResult(
          ReviewBatchRowSchema,
          reviewRow,
          'review batch',
        );
        if (sha256(stableJson(review.selectedFacts)) !== review.payloadHash) {
          throw new FinanceDocumentRepositoryError(
            'invalid-result',
            'The Finance document review payload no longer matches its hash',
          );
        }
        const expectedEmbeddingOrdinals = review.selectedFacts.chunks
          .filter((chunk) => !chunk.content.startsWith(REVIEW_ENVELOPE_PREFIX))
          .map((chunk) => chunk.ordinal)
          .sort((left, right) => left - right);
        const suppliedEmbeddingOrdinals = parsed.embeddings
          .map((embedding) => embedding.ordinal)
          .sort((left, right) => left - right);
        if (
          expectedEmbeddingOrdinals.length !==
            suppliedEmbeddingOrdinals.length ||
          expectedEmbeddingOrdinals.some(
            (ordinal, index) => ordinal !== suppliedEmbeddingOrdinals[index],
          )
        ) {
          throw new FinanceDocumentRepositoryError(
            'invalid-input',
            'Finance document embeddings do not match the reviewed chunks',
          );
        }
        const embeddingsByOrdinal = new Map(
          parsed.embeddings.map((embedding) => [
            embedding.ordinal,
            embedding.embedding,
          ]),
        );
        const resultFor = (status: 'committed' | 'replayed') =>
          deepFreeze({
            status,
            documentId: parsed.documentId,
            extractionRevision: parsed.extractionRevision,
            documentType: review.selectedFacts.documentType,
            currency: review.selectedFacts.currency,
            currencyLabel: labelCurrency(review.selectedFacts.currency),
            chunksCommitted: review.selectedFacts.chunks.length,
            evidenceCommitted: review.selectedFacts.evidence.length,
            matchSuggestionsCommitted:
              review.selectedFacts.matchSuggestions.length,
          });
        if (review.state === 'committed') return resultFor('replayed');
        if (review.state !== 'pending') {
          throw new FinanceDocumentRepositoryError(
            'review-unavailable',
            'The Finance document review is no longer pending',
          );
        }
        if (await expireReviewIfNeeded(client, principal, review.id)) {
          throw new FinanceDocumentRepositoryError(
            'review-expired',
            'The Finance document review authorization expired',
          );
        }
        if (
          document.state !== 'awaiting-review' ||
          document.deletedAt !== null ||
          document.extractionRevision !== parsed.extractionRevision
        ) {
          throw new FinanceDocumentRepositoryError(
            'review-unavailable',
            'The Finance document lifecycle no longer accepts this review',
          );
        }
        const extractionRow = firstResultRow(
          await client.query(
            `select extraction.id::text as "id", extraction.revision as "revision",
                  extraction.attempt as "attempt", extraction.state as "state"
             from emdo.finance_document_extractions as extraction
            where extraction.household_id = $1
              and extraction.space_id = $2
              and extraction.original_owner_user_id = $3
              and extraction.document_id = $4
              and extraction.revision = $5
              and extraction.state = 'awaiting-review'
            for update`,
            [
              ...scopeValues(principal),
              parsed.documentId,
              parsed.extractionRevision,
            ],
          ),
        );
        if (extractionRow === undefined) {
          throw new FinanceDocumentRepositoryError(
            'review-unavailable',
            'The Finance extraction is no longer awaiting review',
          );
        }

        const chunkIds = new Map<number, string>();
        for (const chunk of review.selectedFacts.chunks) {
          const row = firstResultRow(
            await client.query(
              `insert into emdo.finance_document_chunks (
               id, document_id, extraction_revision, household_id, space_id,
               original_owner_user_id, ordinal, page_start, page_end, content,
               content_hash, embedding, committed_at
             )
             select $5::uuid, document.id, $6, document.household_id, document.space_id,
                    document.original_owner_user_id, $7, $8, $9, $10, $11, $12::vector,
                    pg_catalog.clock_timestamp()
               from emdo.finance_documents as document
              where document.household_id = $1
                and document.space_id = $2
                and document.original_owner_user_id = $3
                and document.id = $4
                and document.state = 'awaiting-review'
                and document.extraction_revision = $6
                and document.deleted_at is null
             returning id::text as "id", ordinal as "ordinal"`,
              [
                ...scopeValues(principal),
                parsed.documentId,
                parseInput(UuidSchema, this.#createUuid()),
                parsed.extractionRevision,
                chunk.ordinal,
                chunk.pageStart,
                chunk.pageEnd,
                chunk.content,
                sha256(chunk.content),
                vectorLiteral(embeddingsByOrdinal.get(chunk.ordinal) ?? null),
              ],
            ),
          );
          const created = parseResult(
            z.strictObject({
              id: UuidSchema,
              ordinal: z.coerce.number().int().nonnegative(),
            }),
            row,
            'reviewed chunk',
          );
          chunkIds.set(created.ordinal, created.id);
        }
        for (const evidence of review.selectedFacts.evidence) {
          const row = await client.query(
            `insert into emdo.finance_document_evidence (
             id, document_id, extraction_revision, chunk_id, household_id, space_id,
             original_owner_user_id, page, excerpt, excerpt_hash, locator, source_locale
           )
           select $5::uuid, document.id, $6, $7::uuid, document.household_id,
                  document.space_id, document.original_owner_user_id, $8, $9, $10,
                  $11::jsonb, $12
             from emdo.finance_documents as document
            where document.household_id = $1
              and document.space_id = $2
              and document.original_owner_user_id = $3
              and document.id = $4
              and document.state = 'awaiting-review'
              and document.extraction_revision = $6
              and document.deleted_at is null`,
            [
              ...scopeValues(principal),
              parsed.documentId,
              parseInput(UuidSchema, this.#createUuid()),
              parsed.extractionRevision,
              evidence.chunkOrdinal === null
                ? null
                : (chunkIds.get(evidence.chunkOrdinal) ?? null),
              evidence.page,
              evidence.excerpt,
              sha256(evidence.excerpt),
              evidence.locator,
              evidence.sourceLocale,
            ],
          );
          if (row.rowCount !== 1) {
            throw new FinanceDocumentRepositoryError(
              'conflict',
              'The Finance document lifecycle changed while committing evidence',
            );
          }
        }
        for (const suggestion of review.selectedFacts.matchSuggestions) {
          const row = await client.query(
            `insert into emdo.finance_document_matches (
             id, document_id, extraction_revision, household_id, space_id,
             original_owner_user_id, record_type, record_id, score_basis_points,
             reasons, state
           )
           select $5::uuid, document.id, $6, document.household_id, document.space_id,
                  document.original_owner_user_id, $7, $8, $9, $10::jsonb, 'suggested'
             from emdo.finance_documents as document
            where document.household_id = $1
              and document.space_id = $2
              and document.original_owner_user_id = $3
              and document.id = $4
              and document.state = 'awaiting-review'
              and document.extraction_revision = $6
              and document.deleted_at is null
           on conflict (document_id, extraction_revision, record_type, record_id)
           do nothing`,
            [
              ...scopeValues(principal),
              parsed.documentId,
              parseInput(UuidSchema, this.#createUuid()),
              parsed.extractionRevision,
              suggestion.recordType,
              suggestion.recordId,
              suggestion.scoreBasisPoints,
              suggestion.reasons,
            ],
          );
          if (row.rowCount !== 1) {
            throw new FinanceDocumentRepositoryError(
              'conflict',
              'The Finance match suggestion could not be materialized safely',
            );
          }
        }
        const reviewUpdate = await client.query(
          `update emdo.finance_document_review_batches as review
            set state = 'committed', decided_at = pg_catalog.clock_timestamp()
          where review.household_id = $1
            and review.space_id = $2
            and review.original_owner_user_id = $3
            and review.id = $4
            and review.document_id = $5
            and review.extraction_revision = $6
            and review.authenticated_session_id = $7
            and review.scope_fingerprint = $8
            and review.payload_hash = $9
            and review.review_token_hash = $10
            and review.idempotency_key = $11
            and review.state = 'pending'
            and review.expires_at > pg_catalog.clock_timestamp()`,
          [
            ...scopeValues(principal),
            parsed.reviewBatchId,
            parsed.documentId,
            parsed.extractionRevision,
            principal.sessionId,
            principal.scopeFingerprint,
            parsed.payloadHash,
            tokenHash,
            parsed.idempotencyKey,
          ],
        );
        if (reviewUpdate.rowCount !== 1) {
          throw new FinanceDocumentRepositoryError(
            'review-unavailable',
            'The Finance document review was invalidated before commit',
          );
        }
        const extractionUpdate = await client.query(
          `update emdo.finance_document_extractions as extraction
            set state = 'committed'
          where extraction.household_id = $1
            and extraction.space_id = $2
            and extraction.original_owner_user_id = $3
            and extraction.document_id = $4
            and extraction.revision = $5
            and extraction.state = 'awaiting-review'`,
          [
            ...scopeValues(principal),
            parsed.documentId,
            parsed.extractionRevision,
          ],
        );
        const documentUpdate = await client.query(
          `update emdo.finance_documents as document
            set state = 'committed', document_type = $5, source_locale = $6,
                currency = $7, updated_at = pg_catalog.clock_timestamp()
          where document.household_id = $1
            and document.space_id = $2
            and document.original_owner_user_id = $3
            and document.id = $4
            and document.state = 'awaiting-review'
            and document.extraction_revision = $8
            and document.deleted_at is null`,
          [
            ...scopeValues(principal),
            parsed.documentId,
            review.selectedFacts.documentType,
            review.selectedFacts.sourceLocale,
            review.selectedFacts.currency,
            parsed.extractionRevision,
          ],
        );
        if (extractionUpdate.rowCount !== 1 || documentUpdate.rowCount !== 1) {
          throw new FinanceDocumentRepositoryError(
            'conflict',
            'The Finance document lifecycle changed while committing review output',
          );
        }
        return resultFor('committed');
      },
    );
  }

  async search(input: unknown): Promise<
    Readonly<{
      structured: readonly (FinanceDocumentMetadataView & {
        readonly structuredRank: number;
      })[];
      fullText: readonly Readonly<{
        id: string;
        documentId: string;
        extractionRevision: number;
        documentType: FinanceDocumentReviewedPayload['documentType'];
        currency: string | null;
        currencyLabel: FinanceDocumentCurrencyLabel;
        content: string;
        pageStart: number;
        pageEnd: number;
        fullTextRank: number | null;
        vectorRank: number | null;
      }>[];
    }>
  > {
    const parsed = parseInput(SearchInputSchema, input);
    const principal = asPrincipal(parsed.principal);
    return withScopedTransaction(
      this.pool,
      { principal, requestId: parsed.requestId },
      async (client) => {
        const structuredRows = await client.query(
          `${documentSelect}
          where document.household_id = $1
            and document.space_id = $2
            and document.original_owner_user_id = $3
            and document.state = 'committed'
            and document.deleted_at is null
            and ($4::text[] = '{}'::text[] or document.document_type = any($4::text[]))
            and ($5::text is null or document.currency = $5)
            and ($6::text is null or document.display_name ilike '%' || $6 || '%')
          order by document.updated_at desc, document.id desc
          limit $7`,
          [
            ...scopeValues(principal),
            parsed.documentTypes,
            parsed.currency,
            parsed.displayName,
            parsed.limit,
          ],
        );
        const structured = structuredRows.rows.map((row, index) =>
          deepFreeze({ ...documentFromRow(row), structuredRank: index + 1 }),
        );
        const fullTextRows = await client.query(
          `with eligible_chunks as not materialized (
             select chunk.id::text as "id", chunk.document_id::text as "documentId",
                    chunk.extraction_revision as "extractionRevision",
                    document.document_type as "documentType", document.currency as "currency",
                    chunk.content as "content", chunk.page_start as "pageStart",
                    chunk.page_end as "pageEnd", chunk.search_vector,
                    chunk.embedding
               from emdo.finance_document_chunks as chunk
               join emdo.finance_documents as document
                 on document.id = chunk.document_id
                and document.household_id = chunk.household_id
                and document.space_id = chunk.space_id
                and document.original_owner_user_id = chunk.original_owner_user_id
              where chunk.household_id = $1
                and chunk.space_id = $2
                and chunk.original_owner_user_id = $3
                and document.state = 'committed'
                and document.deleted_at is null
                and document.extraction_revision = chunk.extraction_revision
                and chunk.deleted_at is null
                and ($6::text[] = '{}'::text[] or document.document_type = any($6::text[]))
                and ($7::text is null or document.currency = $7)
           ),
           full_text_candidates as (
             select eligible.*,
                    row_number() over (
                      order by pg_catalog.ts_rank_cd(
                        eligible.search_vector,
                        pg_catalog.websearch_to_tsquery('simple', $4)
                      ) desc, eligible."id"
                    )::integer as "fullTextRank"
               from eligible_chunks as eligible
              where eligible.search_vector @@ pg_catalog.websearch_to_tsquery('simple', $4)
              order by pg_catalog.ts_rank_cd(
                eligible.search_vector,
                pg_catalog.websearch_to_tsquery('simple', $4)
              ) desc, eligible."id"
              limit ${MAXIMUM_SEARCH_RESULTS}
           ),
           vector_candidates as (
             select eligible.*,
                    row_number() over (
                      order by eligible.embedding <=> $5::vector, eligible."id"
                    )::integer as "vectorRank"
               from eligible_chunks as eligible
              where $5::text is not null
                and eligible.embedding is not null
              order by eligible.embedding <=> $5::vector, eligible."id"
              limit ${MAXIMUM_SEARCH_RESULTS}
           ),
           candidates as (
             select coalesce(full_text."id", vector."id") as "id",
                    coalesce(full_text."documentId", vector."documentId") as "documentId",
                    coalesce(full_text."extractionRevision", vector."extractionRevision") as "extractionRevision",
                    coalesce(full_text."documentType", vector."documentType") as "documentType",
                    coalesce(full_text."currency", vector."currency") as "currency",
                    coalesce(full_text."content", vector."content") as "content",
                    coalesce(full_text."pageStart", vector."pageStart") as "pageStart",
                    coalesce(full_text."pageEnd", vector."pageEnd") as "pageEnd",
                    full_text."fullTextRank" as "fullTextRank",
                    vector."vectorRank" as "vectorRank"
               from full_text_candidates as full_text
               full outer join vector_candidates as vector
                 on vector."id" = full_text."id"
           ),
           ranked_candidates as (
             select candidates.*,
                    (
                      case when candidates."fullTextRank" is null then 0
                           else pg_catalog.round(
                             ${FULL_TEXT_RANK_WEIGHT_MILLIONTHS}::numeric /
                             (${RANK_FUSION_OFFSET} + candidates."fullTextRank")
                           )::integer
                       end +
                      case when candidates."vectorRank" is null then 0
                           else pg_catalog.round(
                             ${VECTOR_RANK_WEIGHT_MILLIONTHS}::numeric /
                             (${RANK_FUSION_OFFSET} + candidates."vectorRank")
                           )::integer
                       end
                    ) as "rankScoreMillionths"
               from candidates
           )
           select "id", "documentId", "extractionRevision", "documentType", "currency",
                  "content", "pageStart", "pageEnd", "fullTextRank", "vectorRank"
             from ranked_candidates
            order by "rankScoreMillionths" desc,
                     coalesce("fullTextRank", 2147483647),
                     coalesce("vectorRank", 2147483647),
                     "id"
            limit $8`,
          [
            ...scopeValues(principal),
            parsed.query,
            vectorLiteral(parsed.vectorQuery),
            parsed.documentTypes,
            parsed.currency,
            parsed.limit,
          ],
        );
        const FullTextRowSchema = z
          .strictObject({
            id: UuidSchema,
            documentId: UuidSchema,
            extractionRevision: z.coerce.number().int().positive(),
            documentType: FinanceDocumentTypeSchema,
            currency: CurrencySchema.nullable(),
            content: z.string().min(1).max(16_384),
            pageStart: z.coerce.number().int().min(1).max(250),
            pageEnd: z.coerce.number().int().min(1).max(250),
            fullTextRank: z.coerce.number().int().positive().nullable(),
            vectorRank: z.coerce.number().int().positive().nullable(),
          })
          .refine(
            (row) => row.fullTextRank !== null || row.vectorRank !== null,
            'A search candidate must have a lexical or vector rank',
          );
        const fullText = fullTextRows.rows.map((row) => {
          const hit = parseResult(FullTextRowSchema, row, 'full-text search');
          return deepFreeze({
            ...hit,
            currencyLabel: labelCurrency(hit.currency),
          });
        });
        return deepFreeze({ structured, fullText });
      },
    );
  }

  async listEvidence(input: unknown): Promise<
    readonly Readonly<{
      id: string;
      documentId: string;
      extractionRevision: number;
      chunkId: string | null;
      page: number;
      excerpt: string;
      excerptHash: string;
      locator: Readonly<{
        characterStart: number | null;
        characterEnd: number | null;
      }>;
      sourceLocale: 'en-CA' | 'fr-CA' | 'ja-JP' | 'ko-KR';
    }>[]
  > {
    const parsed = parseInput(EvidenceListInputSchema, input);
    const principal = asPrincipal(parsed.principal);
    return withScopedTransaction(
      this.pool,
      { principal, requestId: parsed.requestId },
      async (client) => {
        const rows = await client.query(
          `select evidence.id::text as "id", evidence.document_id::text as "documentId",
                evidence.extraction_revision as "extractionRevision",
                evidence.chunk_id::text as "chunkId", evidence.page as "page",
                evidence.excerpt as "excerpt", evidence.excerpt_hash as "excerptHash",
                evidence.locator as "locator", evidence.source_locale as "sourceLocale"
           from emdo.finance_document_evidence as evidence
           join emdo.finance_documents as document
             on document.id = evidence.document_id
            and document.household_id = evidence.household_id
            and document.space_id = evidence.space_id
            and document.original_owner_user_id = evidence.original_owner_user_id
          where evidence.household_id = $1
            and evidence.space_id = $2
            and evidence.original_owner_user_id = $3
            and evidence.document_id = $4
            and evidence.extraction_revision = document.extraction_revision
            and evidence.deleted_at is null
            and document.state = 'committed'
            and document.deleted_at is null
          order by evidence.page, evidence.id
          limit $5`,
          [...scopeValues(principal), parsed.documentId, parsed.limit],
        );
        return deepFreeze(
          rows.rows.map((row) =>
            parseResult(EvidenceRowSchema, row, 'evidence'),
          ),
        );
      },
    );
  }

  async getEvidenceById(input: unknown): Promise<
    | Readonly<{
        id: string;
        documentId: string;
        extractionRevision: number;
        chunkId: string | null;
        page: number;
        excerpt: string;
        excerptHash: string;
        locator: Readonly<{
          characterStart: number | null;
          characterEnd: number | null;
        }>;
        sourceLocale: 'en-CA' | 'fr-CA' | 'ja-JP' | 'ko-KR';
      }>
    | undefined
  > {
    const parsed = parseInput(EvidenceInputSchema, input);
    const principal = asPrincipal(parsed.principal);
    return withScopedTransaction(
      this.pool,
      { principal, requestId: parsed.requestId },
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `select evidence.id::text as "id", evidence.document_id::text as "documentId",
                    evidence.extraction_revision as "extractionRevision",
                    evidence.chunk_id::text as "chunkId", evidence.page as "page",
                    evidence.excerpt as "excerpt", evidence.excerpt_hash as "excerptHash",
                    evidence.locator as "locator", evidence.source_locale as "sourceLocale"
               from emdo.finance_document_evidence as evidence
               join emdo.finance_documents as document
                 on document.id = evidence.document_id
                and document.household_id = evidence.household_id
                and document.space_id = evidence.space_id
                and document.original_owner_user_id = evidence.original_owner_user_id
              where evidence.household_id = $1
                and evidence.space_id = $2
                and evidence.original_owner_user_id = $3
                and evidence.id = $4
                and evidence.extraction_revision = document.extraction_revision
                and evidence.deleted_at is null
                and document.state = 'committed'
                and document.deleted_at is null
              limit 1`,
            [...scopeValues(principal), parsed.evidenceId],
          ),
        );
        return row === undefined
          ? undefined
          : deepFreeze(parseResult(EvidenceRowSchema, row, 'evidence'));
      },
    );
  }

  async listMatches(input: unknown): Promise<
    readonly Readonly<{
      id: string;
      documentId: string;
      extractionRevision: number;
      recordType: FinanceDocumentMatchSuggestion['recordType'];
      recordId: string;
      scoreBasisPoints: number;
      reasons: readonly string[];
      state: 'suggested' | 'accepted' | 'rejected';
      decisionReviewBatchId: string | null;
      decidedAt: string | null;
    }>[]
  > {
    const parsed = parseInput(MatchesListInputSchema, input);
    const principal = asPrincipal(parsed.principal);
    return withScopedTransaction(
      this.pool,
      { principal, requestId: parsed.requestId },
      async (client) => {
        const rows = await client.query(
          `select match.id::text as "id", match.document_id::text as "documentId",
                match.extraction_revision as "extractionRevision",
                match.record_type as "recordType", match.record_id as "recordId",
                match.score_basis_points as "scoreBasisPoints", match.reasons as "reasons",
                match.state as "state", match.decision_review_batch_id::text as "decisionReviewBatchId",
                match.decided_at as "decidedAt"
           from emdo.finance_document_matches as match
           join emdo.finance_documents as document
             on document.id = match.document_id
            and document.household_id = match.household_id
            and document.space_id = match.space_id
            and document.original_owner_user_id = match.original_owner_user_id
          where match.household_id = $1
            and match.space_id = $2
            and match.original_owner_user_id = $3
            and match.document_id = $4
            and match.extraction_revision = document.extraction_revision
            and document.state = 'committed'
            and document.deleted_at is null
            and ($5::text[] = '{}'::text[] or match.state = any($5::text[]))
          order by match.created_at, match.id
          limit $6`,
          [
            ...scopeValues(principal),
            parsed.documentId,
            parsed.states,
            parsed.limit,
          ],
        );
        return deepFreeze(
          rows.rows.map((row) => {
            const match = parseResult(MatchRowSchema, row, 'match');
            return deepFreeze({
              ...match,
              decidedAt: match.decidedAt?.toISOString() ?? null,
            });
          }),
        );
      },
    );
  }

  async getMatchById(input: unknown): Promise<
    | Readonly<{
        id: string;
        documentId: string;
        extractionRevision: number;
        recordType: FinanceDocumentMatchSuggestion['recordType'];
        recordId: string;
        scoreBasisPoints: number;
        reasons: readonly string[];
        state: 'suggested' | 'accepted' | 'rejected';
        decisionReviewBatchId: string | null;
        decidedAt: string | null;
      }>
    | undefined
  > {
    const parsed = parseInput(MatchInputSchema, input);
    const principal = asPrincipal(parsed.principal);
    return withScopedTransaction(
      this.pool,
      { principal, requestId: parsed.requestId },
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `select match.id::text as "id", match.document_id::text as "documentId",
                    match.extraction_revision as "extractionRevision",
                    match.record_type as "recordType", match.record_id as "recordId",
                    match.score_basis_points as "scoreBasisPoints", match.reasons as "reasons",
                    match.state as "state",
                    match.decision_review_batch_id::text as "decisionReviewBatchId",
                    match.decided_at as "decidedAt"
               from emdo.finance_document_matches as match
               join emdo.finance_documents as document
                 on document.id = match.document_id
                and document.household_id = match.household_id
                and document.space_id = match.space_id
                and document.original_owner_user_id = match.original_owner_user_id
              where match.household_id = $1
                and match.space_id = $2
                and match.original_owner_user_id = $3
                and match.id = $4
                and match.extraction_revision = document.extraction_revision
                and document.state = 'committed'
                and document.deleted_at is null
              limit 1`,
            [...scopeValues(principal), parsed.matchId],
          ),
        );
        if (row === undefined) return undefined;
        const match = parseResult(MatchRowSchema, row, 'match');
        return deepFreeze({
          ...match,
          decidedAt: match.decidedAt?.toISOString() ?? null,
        });
      },
    );
  }

  /** A reviewed match decision is recorded only; provider posting is impossible here. */
  async decideMatch(
    input: unknown,
  ): Promise<
    Readonly<{ status: 'decided' | 'replayed'; state: 'accepted' | 'rejected' }>
  > {
    const parsed = parseInput(MatchDecisionInputSchema, input);
    const principal = asPrincipal(parsed.principal);
    return withScopedTransaction(
      this.pool,
      { principal, requestId: parsed.requestId },
      async (client) => {
        const document = await requireDocumentForUpdate(
          client,
          principal,
          parsed.documentId,
        );
        if (
          document.state !== 'committed' ||
          document.deletedAt !== null ||
          document.extractionRevision === null
        ) {
          throw new FinanceDocumentRepositoryError(
            'document-unavailable',
            'Only committed Finance documents can decide a match suggestion',
          );
        }
        const review = firstResultRow(
          await client.query(
            `select review.id::text as "id"
             from emdo.finance_document_review_batches as review
            where review.household_id = $1
              and review.space_id = $2
              and review.original_owner_user_id = $3
              and review.id = $4
              and review.document_id = $5
              and review.extraction_revision = $6
              and review.authenticated_session_id = $7
              and review.scope_fingerprint = $8
              and review.state = 'committed'
            for update`,
            [
              ...scopeValues(principal),
              parsed.reviewBatchId,
              parsed.documentId,
              document.extractionRevision,
              principal.sessionId,
              principal.scopeFingerprint,
            ],
          ),
        );
        if (review === undefined) {
          throw new FinanceDocumentRepositoryError(
            'review-unavailable',
            'A committed Finance document review is required for match decisions',
          );
        }
        const current = firstResultRow(
          await client.query(
            `select match.state as "state", match.decision_review_batch_id::text as "decisionReviewBatchId"
             from emdo.finance_document_matches as match
            where match.household_id = $1
              and match.space_id = $2
              and match.original_owner_user_id = $3
              and match.id = $4
              and match.document_id = $5
              and match.extraction_revision = $6
            for update`,
            [
              ...scopeValues(principal),
              parsed.matchId,
              parsed.documentId,
              document.extractionRevision,
            ],
          ),
        );
        const currentMatch = parseResult(
          z.strictObject({
            state: z.enum(['suggested', 'accepted', 'rejected']),
            decisionReviewBatchId: UuidSchema.nullable(),
          }),
          current,
          'match decision',
        );
        if (currentMatch.state !== 'suggested') {
          if (
            currentMatch.state === parsed.decision &&
            currentMatch.decisionReviewBatchId === parsed.reviewBatchId
          ) {
            return deepFreeze({
              status: 'replayed' as const,
              state: parsed.decision,
            });
          }
          throw new FinanceDocumentRepositoryError(
            'conflict',
            'The Finance match suggestion already has a different decision',
          );
        }
        const updated = await client.query(
          `update emdo.finance_document_matches as match
            set state = $7, decision_review_batch_id = $8,
                decided_at = pg_catalog.clock_timestamp()
          where match.household_id = $1
            and match.space_id = $2
            and match.original_owner_user_id = $3
            and match.id = $4
            and match.document_id = $5
            and match.extraction_revision = $6
            and match.state = 'suggested'`,
          [
            ...scopeValues(principal),
            parsed.matchId,
            parsed.documentId,
            document.extractionRevision,
            parsed.decision,
            parsed.reviewBatchId,
          ],
        );
        if (updated.rowCount !== 1) {
          throw new FinanceDocumentRepositoryError(
            'conflict',
            'The Finance match suggestion changed before it could be decided',
          );
        }
        return deepFreeze({
          status: 'decided' as const,
          state: parsed.decision,
        });
      },
    );
  }

  /**
   * Atomically revokes content access and records the one exact guarded
   * action allowed to retry storage purge. The receipt is intentionally
   * content-free and stays on the eventual tombstone for idempotent replay.
   */
  async beginGuardedDelete(input: unknown): Promise<
    | Readonly<{
        status: 'deleting' | 'replayed';
        original: FinanceDocumentOriginalAuthorization;
      }>
    | Readonly<{ status: 'already-deleted' }>
  > {
    const parsed = parseInput(GuardedDeleteInputSchema, input);
    const principal = asPrincipal(parsed.principal);
    return withScopedTransaction(
      this.pool,
      { principal, requestId: parsed.requestId },
      async (client) => {
        const document = await requireDocumentForUpdate(
          client,
          principal,
          parsed.documentId,
        );
        if (document.state === 'deleted') {
          if (!matchesGuardedDeleteReceipt(document, parsed.receipt)) {
            throw new FinanceDocumentRepositoryError(
              'conflict',
              'The Finance document tombstone belongs to a different guarded action',
            );
          }
          return deepFreeze({ status: 'already-deleted' as const });
        }
        if (document.state === 'deleting') {
          if (!matchesGuardedDeleteReceipt(document, parsed.receipt)) {
            throw new FinanceDocumentRepositoryError(
              'conflict',
              'The Finance document purge retry does not match its guarded action',
            );
          }
          return deepFreeze({
            status: 'replayed' as const,
            original: originalFromRow(document),
          });
        }
        if (
          document.deletionProposalId !== null ||
          document.deletionDecisionId !== null ||
          document.deletionTargetBindingHash !== null ||
          document.deletionExecutionBindingHash !== null
        ) {
          throw new FinanceDocumentRepositoryError(
            'invalid-result',
            'An active Finance document retained a deletion receipt',
          );
        }
        const original = originalFromRow(document);
        const update = await client.query(
          `update emdo.finance_documents as document
            set state = 'deleting',
                deletion_proposal_id = $5::uuid,
                deletion_decision_id = $6::uuid,
                deletion_target_binding_hash = $7,
                deletion_execution_binding_hash = $8,
                updated_at = pg_catalog.clock_timestamp()
          where document.household_id = $1
            and document.space_id = $2
            and document.original_owner_user_id = $3
            and document.id = $4
            and document.state = any($9::text[])
            and document.deleted_at is null
            and document.deletion_proposal_id is null
            and document.deletion_decision_id is null
            and document.deletion_target_binding_hash is null
            and document.deletion_execution_binding_hash is null`,
          [
            ...scopeValues(principal),
            parsed.documentId,
            parsed.receipt.proposalId,
            parsed.receipt.decisionId,
            parsed.receipt.targetBindingHash,
            parsed.receipt.executionBindingHash,
            [
              'uploaded',
              'extracting',
              'awaiting-review',
              'committed',
              'failed',
            ],
          ],
        );
        if (update.rowCount !== 1) {
          throw new FinanceDocumentRepositoryError(
            'conflict',
            'The Finance document lifecycle changed before deletion could begin',
          );
        }
        await invalidatePendingReviews(client, principal, parsed.documentId);
        return deepFreeze({ status: 'deleting' as const, original });
      },
    );
  }

  /**
   * Finalizes only the exact deletion that beginGuardedDelete recorded. This
   * keeps a storage retry from becoming a generic document-delete primitive.
   */
  async finalizeGuardedDelete(
    input: unknown,
  ): Promise<Readonly<{ status: 'deleted' | 'already-deleted' }>> {
    const parsed = parseInput(GuardedDeleteInputSchema, input);
    const principal = asPrincipal(parsed.principal);
    return withScopedTransaction(
      this.pool,
      { principal, requestId: parsed.requestId },
      async (client) => {
        const document = await requireDocumentForUpdate(
          client,
          principal,
          parsed.documentId,
        );
        if (document.state === 'deleted') {
          if (!matchesGuardedDeleteReceipt(document, parsed.receipt)) {
            throw new FinanceDocumentRepositoryError(
              'conflict',
              'The Finance document tombstone belongs to a different guarded action',
            );
          }
          return deepFreeze({ status: 'already-deleted' as const });
        }
        if (
          document.state !== 'deleting' ||
          !matchesGuardedDeleteReceipt(document, parsed.receipt)
        ) {
          throw new FinanceDocumentRepositoryError(
            'document-unavailable',
            'The Finance document deletion receipt is unavailable',
          );
        }
        // Child order is deliberate: evidence references chunks, and a future
        // review-batch FK from matches must not make tombstoning impossible.
        await client.query(
          `delete from emdo.finance_document_evidence as evidence
          where evidence.household_id = $1
            and evidence.space_id = $2
            and evidence.original_owner_user_id = $3
            and evidence.document_id = $4`,
          [...scopeValues(principal), parsed.documentId],
        );
        await client.query(
          `delete from emdo.finance_document_matches as match
          where match.household_id = $1
            and match.space_id = $2
            and match.original_owner_user_id = $3
            and match.document_id = $4`,
          [...scopeValues(principal), parsed.documentId],
        );
        await client.query(
          `delete from emdo.finance_document_review_batches as review
          where review.household_id = $1
            and review.space_id = $2
            and review.original_owner_user_id = $3
            and review.document_id = $4`,
          [...scopeValues(principal), parsed.documentId],
        );
        await client.query(
          `delete from emdo.finance_document_chunks as chunk
          where chunk.household_id = $1
            and chunk.space_id = $2
            and chunk.original_owner_user_id = $3
            and chunk.document_id = $4`,
          [...scopeValues(principal), parsed.documentId],
        );
        await client.query(
          `delete from emdo.finance_document_extractions as extraction
          where extraction.household_id = $1
            and extraction.space_id = $2
            and extraction.original_owner_user_id = $3
            and extraction.document_id = $4`,
          [...scopeValues(principal), parsed.documentId],
        );
        const update = await client.query(
          `update emdo.finance_documents as document
            set state = 'deleted', storage_object_id = null, display_name = null,
                mime_type = null, byte_size = null, page_count = null,
                image_width = null, image_height = null, plaintext_sha256 = null,
                ciphertext_sha256 = null, wrapped_data_key = null, key_version = null,
                document_type = null, source_locale = null, currency = null,
                extraction_revision = null, deleted_at = pg_catalog.clock_timestamp(),
                updated_at = pg_catalog.clock_timestamp()
          where document.household_id = $1
            and document.space_id = $2
            and document.original_owner_user_id = $3
            and document.id = $4
            and document.state = 'deleting'
            and document.deleted_at is null
            and document.deletion_proposal_id = $5::uuid
            and document.deletion_decision_id = $6::uuid
            and document.deletion_target_binding_hash = $7
            and document.deletion_execution_binding_hash = $8`,
          [
            ...scopeValues(principal),
            parsed.documentId,
            parsed.receipt.proposalId,
            parsed.receipt.decisionId,
            parsed.receipt.targetBindingHash,
            parsed.receipt.executionBindingHash,
          ],
        );
        if (update.rowCount !== 1) {
          throw new FinanceDocumentRepositoryError(
            'conflict',
            'The Finance document lifecycle changed before final tombstoning',
          );
        }
        return deepFreeze({ status: 'deleted' as const });
      },
    );
  }
}

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import {
  FinanceDocumentRepositoryError,
  type FinanceDocumentMetadataView,
  type FinanceDocumentOriginalAuthorization,
  type FinanceDocumentRepositoryPrincipal,
  type FinanceDocumentReviewDraft as StoredFinanceDocumentReviewDraft,
  type FinanceDocumentReviewedPayload,
  type PostgresFinanceDocumentRepository,
} from '@emdo/db/api';
import {
  EffectiveAuthorizationScopeFingerprintSchema,
  FinancePageSchema,
  GuardedActionPermitSchema,
  IdempotencyKeySchema,
  IsoDateTimeSchema,
  Sha256Schema,
  UuidSchema,
} from '@emdo/contracts';
import {
  financeDocumentOriginalAssociatedData,
  FinanceDocumentPayloadCrypto,
  FinanceDocumentStorage,
  type FinanceDocumentMetadata,
} from '@emdo/integrations/finance-documents';
import {
  OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_DIMENSIONS,
  OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_LIMITS,
} from '@emdo/integrations/openai';
import { hashCanonicalJson } from '@emdo/toolbox';
import {
  FINANCE_DOCUMENT_LIMITS,
  FinanceDocumentDetailSchema,
  FinanceDocumentEvidenceListSchema,
  FinanceDocumentMatchListSchema,
  FinanceDocumentMimeTypeSchema,
  FinanceDocumentReviewDraftSchema,
  FinanceDocumentStateSchema,
  FinanceDocumentSummarySchema,
  FinanceDocumentTypeSchema,
  FinanceExperienceV1Schema,
  FinanceExperienceSnapshotSchema,
  FinanceLocaleSchema,
  redactFinanceDocumentEnvelopeForReview,
  redactFinanceDocumentText,
  suggestFinanceDocumentMatches,
  type FinanceDocumentEnvelopeV1,
  type FinanceDocumentReviewDraft,
  type FinanceDocumentSummary,
  type FinanceLocale,
} from '@emdo/domains/finance';
import { z } from 'zod';

import { AuthenticatedPrincipalSchema } from '../schemas.js';
import type {
  AuthenticatedPrincipal,
  FinanceDocumentGateway,
  FinanceReadGateway,
} from '../services/contracts.js';
import {
  hashFinanceGuardedActionExecutionBinding,
  type FinanceCapabilityScope,
  type FinanceDocumentGuardedActionIntent,
  type FinanceDocumentGuardedActionOperation,
  type FinanceDocumentGuardedActionPort,
  type FinanceDocumentGuardedActionTarget,
} from './finance-agent-services.js';
import type { FinancePdfInspector } from './finance-pdf-inspection.js';

const REVIEW_TOKEN_V2_DOMAIN = 'emdo.finance-document.review-token.v2\0';
const REVIEW_IDEMPOTENCY_V2_DOMAIN =
  'emdo.finance-document.review-idempotency.v2\0';
const LEGACY_REVIEW_TOKEN_V1_DOMAIN = 'emdo.finance-document.review-token.v1\0';
const CURSOR_DOMAIN = 'emdo.finance-document.cursor.v1\0';
const REVIEW_ENVELOPE_PREFIX = 'emdo.finance-document.review-envelope.v1:';
const REVIEW_ENVELOPE_CHUNK_DATA_BYTES = 15_000;
const MAXIMUM_REVIEW_ENVELOPE_CHUNKS = 96;
const MAXIMUM_REVIEW_ENVELOPE_BYTES =
  MAXIMUM_REVIEW_ENVELOPE_CHUNKS * REVIEW_ENVELOPE_CHUNK_DATA_BYTES;
const MAXIMUM_EMPTY_UPLOAD_CHUNKS = 16;

const safeDocumentDisplayName = (input: unknown): string => {
  if (typeof input !== 'string') return error('invalid-input');
  const scrubbed = input.replace(/[\p{Cc}\p{Cf}"\\/]/gu, '_').trim();
  const extensionMatch = /\.[A-Za-z0-9]{1,10}$/u.exec(scrubbed);
  const extension = extensionMatch?.[0] ?? '';
  const stem = scrubbed.slice(0, scrubbed.length - extension.length);
  const redactedStem = redactFinanceDocumentText(stem).trim();
  const fallbackStem =
    redactedStem.length === 0 ? 'finance-document' : redactedStem;
  return `${fallbackStem.slice(0, 255 - extension.length)}${extension}`;
};

type Repository = Pick<
  PostgresFinanceDocumentRepository,
  | 'beginGuardedDelete'
  | 'checkInfrastructureReady'
  | 'checkReady'
  | 'commitReview'
  | 'createOrRetryExtractionRevision'
  | 'createUploadedMetadata'
  | 'decideMatch'
  | 'finalizeGuardedDelete'
  | 'getCommittedReviewAuthorization'
  | 'getCurrentCommittedReview'
  | 'getCurrentExtraction'
  | 'getCurrentReviewDraft'
  | 'getGuardedDeleteReceipt'
  | 'getEvidenceById'
  | 'getMatchById'
  | 'getMetadata'
  | 'getOriginalAuthorization'
  | 'getOwnerQuota'
  | 'list'
  | 'listMatches'
  | 'replaceCurrentReviewDraft'
>;

type Storage = Pick<
  FinanceDocumentStorage,
  'checkReady' | 'purge' | 'read' | 'store'
>;
type PayloadCrypto = Pick<FinanceDocumentPayloadCrypto, 'decrypt'>;
type FinanceMimeType = z.output<typeof FinanceDocumentMimeTypeSchema>;

export type FinanceDocumentGatewayErrorCode =
  | 'approval-required'
  | 'authorization-revoked'
  | 'document-not-found'
  | 'document-state-conflict'
  | 'duplicate-document'
  | 'evidence-not-found'
  | 'finance-documents-unavailable'
  | 'idempotency-conflict'
  | 'invalid-input'
  | 'match-not-found'
  | 'quota-exceeded'
  | 'review-token-expired'
  | 'review-token-invalid';

/** Deliberately contains no provider, database, storage, or document details. */
export class FinanceDocumentGatewayError extends Error {
  constructor(readonly code: FinanceDocumentGatewayErrorCode) {
    super('Finance document operation unavailable.');
    this.name = 'FinanceDocumentGatewayError';
  }
}

export interface ProductionFinanceDocumentGateway extends FinanceDocumentGateway {
  checkReady(): Promise<boolean>;
  /** Internal only: captures the authenticated uploader in a guarded port. */
  createGuardedActionPort(
    principal: AuthenticatedPrincipal,
  ): FinanceDocumentGuardedActionPort;
  dispose(): void;
}

/**
 * Infrastructure-only boundary for vectors derived from content that has
 * already passed the redacted review boundary. It intentionally receives no
 * document, owner, storage, or review identifiers.
 */
export interface FinanceDocumentEmbeddingsPort {
  embed(input: {
    readonly chunks: readonly Readonly<{ readonly content: string }>[];
    readonly signal: AbortSignal;
    readonly timeoutMs?: number;
  }): Promise<
    Readonly<{
      readonly vectors: readonly (readonly number[])[];
    }>
  >;
}

export interface ProductionFinanceDocumentGatewayDependencies {
  /**
   * Existing bounded activity projection plus its one-query owner-private
   * Overview snapshot. The snapshot never follows a client cursor.
   */
  readonly financeRead: Pick<FinanceReadGateway, 'list' | 'readSnapshot'>;
  /**
   * A provider adapter injected by production composition. It is invoked only
   * while atomically committing a reviewed document.
   */
  readonly embeddings: FinanceDocumentEmbeddingsPort;
  /** Exactly 32 bytes owned by the caller's keyring composition. */
  readonly reviewTokenHmacKey: Uint8Array;
  readonly payloadCrypto: PayloadCrypto;
  readonly pdfInspector: FinancePdfInspector;
  readonly repository: Repository;
  readonly storage: Storage;
}

const CursorPayloadSchema = z.strictObject({
  version: z.literal(1),
  householdId: UuidSchema,
  privateSpaceId: UuidSchema,
  ownerUserId: UuidSchema,
  scopeFingerprint: EffectiveAuthorizationScopeFingerprintSchema,
  updatedAt: IsoDateTimeSchema,
  id: UuidSchema,
});

type CursorPayload = z.output<typeof CursorPayloadSchema>;

const AbortSignalSchema = z.custom<AbortSignal>(
  (value) =>
    value !== null &&
    typeof value === 'object' &&
    typeof (value as AbortSignal).aborted === 'boolean',
);

const error = (code: FinanceDocumentGatewayErrorCode): never => {
  throw new FinanceDocumentGatewayError(code);
};

const mapRepositoryError = (input: FinanceDocumentRepositoryError) => {
  switch (input.code) {
    case 'authorization-revoked':
      return new FinanceDocumentGatewayError('authorization-revoked');
    case 'document-not-found':
      return new FinanceDocumentGatewayError('document-not-found');
    case 'duplicate':
      return new FinanceDocumentGatewayError('duplicate-document');
    case 'quota-exceeded':
      return new FinanceDocumentGatewayError('quota-exceeded');
    case 'review-expired':
      return new FinanceDocumentGatewayError('review-token-expired');
    case 'review-not-found':
      return new FinanceDocumentGatewayError('review-token-invalid');
    case 'conflict':
      return new FinanceDocumentGatewayError('idempotency-conflict');
    case 'document-unavailable':
    case 'extraction-not-found':
    case 'retry-exhausted':
      return new FinanceDocumentGatewayError('document-state-conflict');
    case 'invalid-input':
      return new FinanceDocumentGatewayError('invalid-input');
    case 'review-unavailable':
      return new FinanceDocumentGatewayError('review-token-invalid');
    case 'database-unavailable':
    case 'invalid-result':
      return new FinanceDocumentGatewayError('finance-documents-unavailable');
  }
};

const safeError = (input: unknown): FinanceDocumentGatewayError => {
  if (input instanceof FinanceDocumentGatewayError) return input;
  if (input instanceof FinanceDocumentRepositoryError) {
    return mapRepositoryError(input);
  }
  return new FinanceDocumentGatewayError('finance-documents-unavailable');
};

const asPrivatePrincipal = (
  input: AuthenticatedPrincipal,
): FinanceDocumentRepositoryPrincipal => {
  const parsed = AuthenticatedPrincipalSchema.safeParse(input);
  if (!parsed.success || parsed.data.privateSpaceId === undefined) {
    return error('authorization-revoked');
  }
  return Object.freeze({
    userId: parsed.data.userId,
    sessionId: parsed.data.sessionId,
    householdId: parsed.data.householdId,
    privateSpaceId: parsed.data.privateSpaceId,
    emailVerified: parsed.data.emailVerified,
    spaceAccessGrantId: parsed.data.spaceAccessGrantId,
    scopeFingerprint: parsed.data.collectionAuthorizationScopeFingerprint,
  });
};

const asExperiencePrincipal = (
  principal: AuthenticatedPrincipal,
): Omit<AuthenticatedPrincipal, 'privateSpaceId'> =>
  Object.freeze({
    userId: principal.userId,
    sessionId: principal.sessionId,
    householdId: principal.householdId,
    role: principal.role,
    emailVerified: principal.emailVerified,
    spaceAccessGrantId: principal.spaceAccessGrantId,
    collectionAuthorizationScopeFingerprint:
      principal.collectionAuthorizationScopeFingerprint,
  });

const stableJson = (input: unknown): string => {
  if (input === null) return 'null';
  if (typeof input === 'string' || typeof input === 'boolean') {
    return JSON.stringify(input);
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return error('invalid-input');
    return JSON.stringify(input);
  }
  if (Array.isArray(input)) return `[${input.map(stableJson).join(',')}]`;
  if (
    typeof input !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  ) {
    return error('invalid-input');
  }
  const record = input as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
};

const sha256 = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex');

const copyHmacKey = (input: Uint8Array): Buffer => {
  if (!(input instanceof Uint8Array) || input.byteLength !== 32) {
    return error('finance-documents-unavailable');
  }
  return Buffer.from(input);
};

const equalText = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  try {
    return (
      leftBytes.byteLength === rightBytes.byteLength &&
      timingSafeEqual(leftBytes, rightBytes)
    );
  } finally {
    leftBytes.fill(0);
    rightBytes.fill(0);
  }
};

const hmac = (key: Uint8Array, domain: string, value: unknown): string =>
  createHmac('sha256', key)
    .update(domain, 'utf8')
    .update(stableJson(value), 'utf8')
    .digest('base64url');

/** Durable v2 binding for every newly issued review token. */
const reviewBindingV2 = (input: {
  readonly principal: FinanceDocumentRepositoryPrincipal;
  readonly documentId: string;
  readonly extractionRevision: number;
  readonly payloadHash: string;
}) => ({
  householdId: input.principal.householdId,
  privateSpaceId: input.principal.privateSpaceId,
  ownerUserId: input.principal.userId,
  sessionId: input.principal.sessionId,
  scopeFingerprint: input.principal.scopeFingerprint,
  documentId: input.documentId,
  extractionRevision: input.extractionRevision,
  payloadHash: input.payloadHash,
});

const reviewTokenV2For = (
  key: Uint8Array,
  input: Parameters<typeof reviewBindingV2>[0],
): string => hmac(key, REVIEW_TOKEN_V2_DOMAIN, reviewBindingV2(input));

const reviewIdempotencyKeyV2For = (
  key: Uint8Array,
  input: Parameters<typeof reviewBindingV2>[0],
): string =>
  `finance-review:${hmac(
    key,
    REVIEW_IDEMPOTENCY_V2_DOMAIN,
    reviewBindingV2(input),
  )}`;

/**
 * Pre-v2 rows did not carry an explicit token version. These immutable fields
 * are provenance for reconstructing the former HMAC only; current owner,
 * session, scope, and RLS checks remain at their normal repository boundaries.
 */
const StoredReviewTokenBindingSchema = z.object({
  documentId: UuidSchema,
  extractionRevision: z.number().int().positive(),
  authenticatedSessionId: UuidSchema,
  spaceAccessGrantId: UuidSchema,
  scopeFingerprint: EffectiveAuthorizationScopeFingerprintSchema,
  payloadHash: Sha256Schema,
  reviewTokenHash: Sha256Schema,
});

const storedReviewTokenFor = (input: {
  readonly key: Uint8Array;
  readonly principal: FinanceDocumentRepositoryPrincipal;
  readonly stored: StoredFinanceDocumentReviewDraft;
}): string | undefined => {
  const stored = StoredReviewTokenBindingSchema.safeParse(input.stored);
  if (!stored.success) return undefined;
  if (
    stored.data.authenticatedSessionId !== input.principal.sessionId ||
    stored.data.scopeFingerprint !== input.principal.scopeFingerprint
  ) {
    return undefined;
  }
  const v2 = reviewTokenV2For(input.key, {
    principal: input.principal,
    documentId: stored.data.documentId,
    extractionRevision: stored.data.extractionRevision,
    payloadHash: stored.data.payloadHash,
  });
  if (equalText(sha256(v2), stored.data.reviewTokenHash)) return v2;

  // A legacy token must still be owned by the live authenticated session and
  // stable authorization scope. Its historical access grant is never compared
  // to current authority: it is HMAC provenance only, allowing safe renewal.
  const v1 = hmac(input.key, LEGACY_REVIEW_TOKEN_V1_DOMAIN, {
    householdId: input.principal.householdId,
    privateSpaceId: input.principal.privateSpaceId,
    ownerUserId: input.principal.userId,
    sessionId: stored.data.authenticatedSessionId,
    spaceAccessGrantId: stored.data.spaceAccessGrantId,
    scopeFingerprint: stored.data.scopeFingerprint,
    documentId: stored.data.documentId,
    extractionRevision: stored.data.extractionRevision,
    payloadHash: stored.data.payloadHash,
  });
  return equalText(sha256(v1), stored.data.reviewTokenHash) ? v1 : undefined;
};

const originalAad = (
  principal: FinanceDocumentRepositoryPrincipal,
): Uint8Array =>
  financeDocumentOriginalAssociatedData({
    householdId: principal.householdId,
    privateSpaceId: principal.privateSpaceId,
    ownerUserId: principal.userId,
  });

const payloadScope = (input: {
  readonly principal: FinanceDocumentRepositoryPrincipal;
  readonly documentId: string;
  readonly extractionRevision: number;
}) => ({
  householdId: input.principal.householdId,
  privateSpaceId: input.principal.privateSpaceId,
  ownerUserId: input.principal.userId,
  documentId: input.documentId,
  extractionRevision: input.extractionRevision,
  purpose: 'unreviewed-extraction' as const,
});

const detectMime = (input: Uint8Array): FinanceMimeType | undefined => {
  if (
    input.byteLength >= 5 &&
    input[0] === 0x25 &&
    input[1] === 0x50 &&
    input[2] === 0x44 &&
    input[3] === 0x46 &&
    input[4] === 0x2d
  ) {
    return 'application/pdf';
  }
  if (
    input.byteLength >= 8 &&
    input[0] === 0x89 &&
    input[1] === 0x50 &&
    input[2] === 0x4e &&
    input[3] === 0x47 &&
    input[4] === 0x0d &&
    input[5] === 0x0a &&
    input[6] === 0x1a &&
    input[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    input.byteLength >= 3 &&
    input[0] === 0xff &&
    input[1] === 0xd8 &&
    input[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  return undefined;
};

const isChunk = (value: unknown): value is Uint8Array =>
  value instanceof Uint8Array &&
  value.buffer instanceof ArrayBuffer &&
  value.byteOffset >= 0 &&
  value.byteLength >= 0;

const sniffedUploadSource = (
  source: AsyncIterable<Uint8Array>,
  declaredMimeType: FinanceMimeType,
): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    if (
      source === null ||
      typeof source !== 'object' ||
      typeof source[Symbol.asyncIterator] !== 'function'
    ) {
      return error('invalid-input');
    }
    const iterator = source[Symbol.asyncIterator]();
    const initial: Uint8Array[] = [];
    let emptyChunks = 0;
    let prefixLength = 0;
    let completed = false;
    try {
      while (prefixLength < 8) {
        const next = await iterator.next();
        if (next.done) {
          completed = true;
          break;
        }
        if (!isChunk(next.value)) return error('invalid-input');
        initial.push(next.value);
        if (next.value.byteLength === 0) {
          emptyChunks += 1;
          if (emptyChunks > MAXIMUM_EMPTY_UPLOAD_CHUNKS) {
            return error('invalid-input');
          }
          continue;
        }
        prefixLength += next.value.byteLength;
      }
      const prefix = Buffer.alloc(Math.min(prefixLength, 8));
      try {
        let offset = 0;
        for (const chunk of initial) {
          if (offset >= prefix.byteLength) break;
          const nextOffset = Math.min(
            prefix.byteLength,
            offset + chunk.byteLength,
          );
          prefix.set(chunk.subarray(0, nextOffset - offset), offset);
          offset = nextOffset;
        }
        if (detectMime(prefix) !== declaredMimeType)
          return error('invalid-input');
      } finally {
        prefix.fill(0);
      }
      for (const chunk of initial) yield chunk;
      if (!completed) {
        while (true) {
          const next = await iterator.next();
          if (next.done) break;
          if (!isChunk(next.value)) return error('invalid-input');
          yield next.value;
        }
      }
    } finally {
      if (!completed && typeof iterator.return === 'function') {
        await iterator.return().catch(() => undefined);
      }
    }
  },
});

const imageDimensions = (input: Uint8Array, mimeType: FinanceMimeType) => {
  const reject = () => error('invalid-input');
  const validate = (width: number, height: number) => {
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 40_000 ||
      height > 40_000 ||
      width * height >
        FINANCE_DOCUMENT_LIMITS.maximumImageMegapixels * 1_000_000
    ) {
      return reject();
    }
    return Object.freeze({ width, height });
  };
  if (mimeType === 'image/png') {
    if (
      input.byteLength < 24 ||
      Buffer.from(input.subarray(12, 16)).toString('ascii') !== 'IHDR'
    ) {
      return reject();
    }
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    return validate(view.getUint32(16, false), view.getUint32(20, false));
  }
  if (mimeType !== 'image/jpeg') return reject();
  let offset = 2;
  while (offset + 1 < input.byteLength) {
    if (input[offset] !== 0xff) return reject();
    while (input[offset] === 0xff) offset += 1;
    const marker = input[offset];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    offset += 1;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > input.byteLength) return reject();
    const segmentLength = (input[offset]! << 8) | input[offset + 1]!;
    if (segmentLength < 2 || offset + segmentLength > input.byteLength) {
      return reject();
    }
    const sof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (sof) {
      if (segmentLength < 7) return reject();
      const height = (input[offset + 3]! << 8) | input[offset + 4]!;
      const width = (input[offset + 5]! << 8) | input[offset + 6]!;
      return validate(width, height);
    }
    offset += segmentLength;
  }
  return reject();
};

const inspectOriginal = async (input: {
  readonly bytes: Uint8Array;
  readonly declaredMimeType: FinanceMimeType;
  readonly pdfInspector: FinancePdfInspector;
}) => {
  if (detectMime(input.bytes) !== input.declaredMimeType) {
    return error('invalid-input');
  }
  if (input.declaredMimeType === 'application/pdf') {
    const pageCount = await input.pdfInspector.pageCount(input.bytes);
    if (pageCount === undefined) return error('invalid-input');
    return Object.freeze({
      pageCount,
      imageWidth: null,
      imageHeight: null,
    });
  }
  const dimensions = imageDimensions(input.bytes, input.declaredMimeType);
  return Object.freeze({
    pageCount: null,
    imageWidth: dimensions.width,
    imageHeight: dimensions.height,
  });
};

const storageMetadataFromAuthorization = (
  authorization: FinanceDocumentOriginalAuthorization,
): FinanceDocumentMetadata => ({
  schemaVersion: 1,
  algorithm: 'aes-256-gcm',
  aadVersion: 1,
  objectName: authorization.storageObjectId,
  plaintextBytes: authorization.byteSize,
  ciphertextBytes: authorization.byteSize,
  plaintextSha256: authorization.plaintextSha256,
  ciphertextSha256: authorization.ciphertextSha256,
  nonce: authorization.wrappedDataKey.nonce,
  authenticationTag: authorization.wrappedDataKey.authenticationTag,
  wrappedKey: authorization.wrappedDataKey.wrappedKey,
  keyVersion: authorization.keyVersion,
});

const readStoredBytes = async (input: {
  readonly storage: Storage;
  readonly metadata: FinanceDocumentMetadata;
  readonly aad: Uint8Array;
}): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of input.storage.read({
      metadata: input.metadata,
      aad: input.aad,
    })) {
      if (!isChunk(chunk)) return error('finance-documents-unavailable');
      total += chunk.byteLength;
      if (total > FINANCE_DOCUMENT_LIMITS.maximumBytesPerFile) {
        return error('finance-documents-unavailable');
      }
      chunks.push(Buffer.from(chunk));
    }
    if (total !== input.metadata.plaintextBytes || total === 0) {
      return error('finance-documents-unavailable');
    }
    return Buffer.concat(chunks, total);
  } catch (cause) {
    throw safeError(cause);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
};

const summaryFor = (
  document: FinanceDocumentMetadataView,
): FinanceDocumentSummary =>
  FinanceDocumentSummarySchema.parse({
    schemaVersion: 1,
    id: document.id,
    documentType: document.documentType,
    sourceLocale: document.sourceLocale,
    currency: document.currency,
    state: document.state,
    displayName: document.displayName,
    mimeType: document.mimeType,
    byteSize: document.byteSize,
    plaintextSha256: document.plaintextSha256,
    extractionRevision: document.extractionRevision,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  });

const finiteText = (input: unknown, maximum = 2_000): string | undefined => {
  if (typeof input !== 'string') return undefined;
  const value = input.replace(/\p{Cc}/gu, ' ').trim();
  return value.length > 0 ? value.slice(0, maximum).trim() : undefined;
};

const envelopePages = (
  envelope: FinanceDocumentEnvelopeV1,
): readonly number[] =>
  envelope.facts.flatMap((fact) =>
    fact.evidence.map((evidence) => evidence.page),
  );

const pageRangeFor = (envelope: FinanceDocumentEnvelopeV1) => {
  const pages = envelopePages(envelope);
  return Object.freeze({
    pageStart: pages.length === 0 ? 1 : Math.min(...pages),
    pageEnd: pages.length === 0 ? 1 : Math.max(...pages),
  });
};

const encodeEnvelopeChunks = (envelope: FinanceDocumentEnvelopeV1) => {
  const bytes = Buffer.from(stableJson(envelope), 'utf8');
  try {
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength > MAXIMUM_REVIEW_ENVELOPE_BYTES
    ) {
      return error('invalid-input');
    }
    const encoded = bytes.toString('base64url');
    const count = Math.ceil(encoded.length / REVIEW_ENVELOPE_CHUNK_DATA_BYTES);
    if (count < 1 || count > MAXIMUM_REVIEW_ENVELOPE_CHUNKS) {
      return error('invalid-input');
    }
    const pageRange = pageRangeFor(envelope);
    return Array.from({ length: count }, (_entry, index) => ({
      ordinal: index,
      pageStart: pageRange.pageStart,
      pageEnd: pageRange.pageEnd,
      content: `${REVIEW_ENVELOPE_PREFIX}${index + 1}/${count}:${encoded.slice(
        index * REVIEW_ENVELOPE_CHUNK_DATA_BYTES,
        (index + 1) * REVIEW_ENVELOPE_CHUNK_DATA_BYTES,
      )}`,
      embedding: null,
    }));
  } finally {
    bytes.fill(0);
  }
};

const summaryTextFor = (envelope: FinanceDocumentEnvelopeV1): string => {
  const record = envelope as unknown as Readonly<Record<string, unknown>>;
  const pieces = [
    envelope.documentType,
    finiteText(record.merchant),
    finiteText(record.vendor),
    finiteText(record.issuer),
    finiteText(record.recipient),
    finiteText(record.institution),
    finiteText(record.employer),
    finiteText(record.summary),
    typeof record.purchasedOn === 'string' ? record.purchasedOn : undefined,
    envelope.issuedOn ?? undefined,
    envelope.dueOn ?? undefined,
    envelope.total === null
      ? undefined
      : `${envelope.total.currency} ${envelope.total.minorUnits}`,
  ].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return finiteText(pieces.join(' · '), 16_000) ?? envelope.documentType;
};

const reviewedPayloadFor = (input: {
  readonly documentId: string;
  readonly extractionRevision: number;
  readonly envelope: FinanceDocumentEnvelopeV1;
  readonly matches: readonly {
    readonly recordType: 'transaction' | 'bill';
    readonly recordId: string;
    readonly scoreBasisPoints: number;
    readonly reasons: readonly string[];
  }[];
}): FinanceDocumentReviewedPayload => {
  const envelope = redactFinanceDocumentEnvelopeForReview(input.envelope);
  const chunks = [...encodeEnvelopeChunks(envelope)];
  const pageRange = pageRangeFor(envelope);
  chunks.push({
    ordinal: chunks.length,
    pageStart: pageRange.pageStart,
    pageEnd: pageRange.pageEnd,
    content: summaryTextFor(envelope),
    embedding: null,
  });
  const evidence = [] as Array<{
    chunkOrdinal: number | null;
    page: number;
    excerpt: string;
    locator: { characterStart: number | null; characterEnd: number | null };
    sourceLocale: FinanceDocumentEnvelopeV1['sourceLocale'];
  }>;
  const evidenceChunks = FINANCE_DOCUMENT_LIMITS.maximumPdfPages;
  for (const fact of envelope.facts) {
    for (const sourceEvidence of fact.evidence) {
      if (evidence.length >= 512) break;
      const excerpt = finiteText(sourceEvidence.excerpt);
      if (excerpt === undefined) continue;
      const canMaterializeChunk =
        chunks.length < 128 && evidence.length < evidenceChunks;
      const ordinal = canMaterializeChunk ? chunks.length : null;
      if (ordinal !== null) {
        chunks.push({
          ordinal,
          pageStart: sourceEvidence.page,
          pageEnd: sourceEvidence.page,
          content: excerpt,
          embedding: null,
        });
      }
      evidence.push({
        chunkOrdinal: ordinal,
        page: sourceEvidence.page,
        excerpt,
        locator: {
          characterStart: sourceEvidence.characterStart,
          characterEnd: sourceEvidence.characterEnd,
        },
        sourceLocale: envelope.sourceLocale,
      });
    }
    if (evidence.length >= 512) break;
  }
  return {
    documentType: envelope.documentType,
    sourceLocale: envelope.sourceLocale,
    currency: envelope.currency,
    chunks,
    evidence,
    matchSuggestions: input.matches.map((match) => ({
      recordType: match.recordType,
      recordId: match.recordId,
      scoreBasisPoints: match.scoreBasisPoints,
      reasons: [...match.reasons],
    })),
  };
};

type ReviewedEmbedding = Readonly<{
  ordinal: number;
  embedding: readonly number[];
}>;

type SemanticReviewedChunk = Readonly<{
  ordinal: number;
  content: string;
}>;

const isReviewEnvelopeReconstructionChunk = (content: string): boolean =>
  content.startsWith(REVIEW_ENVELOPE_PREFIX);

const semanticReviewedChunksForEmbedding = (
  payload: FinanceDocumentReviewedPayload,
): readonly SemanticReviewedChunk[] =>
  Object.freeze(
    payload.chunks
      .filter((chunk) => !isReviewEnvelopeReconstructionChunk(chunk.content))
      .map((chunk) =>
        Object.freeze({ ordinal: chunk.ordinal, content: chunk.content }),
      )
      .sort((left, right) => left.ordinal - right.ordinal),
  );

const embeddingBatchesFor = (
  chunks: readonly SemanticReviewedChunk[],
): readonly (readonly SemanticReviewedChunk[])[] => {
  const batches: Array<readonly SemanticReviewedChunk[]> = [];
  let batch: SemanticReviewedChunk[] = [];
  let characterCount = 0;
  let byteCount = 0;
  for (const chunk of chunks) {
    const chunkCharacters = chunk.content.length;
    const chunkBytes = Buffer.byteLength(chunk.content, 'utf8');
    if (
      chunkCharacters >
        OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_LIMITS.maxInputCharactersPerChunk ||
      chunkBytes >
        OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_LIMITS.maxInputBytesPerChunk
    ) {
      return error('finance-documents-unavailable');
    }
    const batchWouldOverflow =
      batch.length ===
        OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_LIMITS.maxChunksPerRequest ||
      characterCount + chunkCharacters >
        OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_LIMITS.maxInputCharactersPerRequest ||
      byteCount + chunkBytes >
        OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_LIMITS.maxInputBytesPerRequest;
    if (batchWouldOverflow) {
      if (batch.length === 0) return error('finance-documents-unavailable');
      batches.push(Object.freeze(batch));
      batch = [];
      characterCount = 0;
      byteCount = 0;
    }
    batch.push(chunk);
    characterCount += chunkCharacters;
    byteCount += chunkBytes;
  }
  if (batch.length > 0) batches.push(Object.freeze(batch));
  return Object.freeze(batches);
};

const validEmbeddingVector = (value: unknown): value is readonly number[] =>
  Array.isArray(value) &&
  Object.getPrototypeOf(value) === Array.prototype &&
  value.length === OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_DIMENSIONS &&
  value.every((entry) => typeof entry === 'number' && Number.isFinite(entry));

const reviewedEmbeddingsFor = async (input: {
  readonly embeddings: FinanceDocumentEmbeddingsPort;
  readonly selectedFacts: FinanceDocumentReviewedPayload;
}): Promise<readonly ReviewedEmbedding[]> => {
  const embeddings: ReviewedEmbedding[] = [];
  for (const batch of embeddingBatchesFor(
    semanticReviewedChunksForEmbedding(input.selectedFacts),
  )) {
    const controller = new AbortController();
    try {
      const result = await input.embeddings.embed({
        chunks: Object.freeze(
          batch.map((chunk) => Object.freeze({ content: chunk.content })),
        ),
        signal: controller.signal,
      });
      if (
        !Array.isArray(result?.vectors) ||
        result.vectors.length !== batch.length
      ) {
        return error('finance-documents-unavailable');
      }
      for (const [index, vector] of result.vectors.entries()) {
        const chunk = batch[index];
        if (chunk === undefined || !validEmbeddingVector(vector)) {
          return error('finance-documents-unavailable');
        }
        embeddings.push(
          Object.freeze({
            ordinal: chunk.ordinal,
            embedding: Object.freeze([...vector]),
          }),
        );
      }
    } finally {
      controller.abort();
    }
  }
  return Object.freeze(embeddings);
};

const envelopeFromReviewedPayload = (
  payload: FinanceDocumentReviewedPayload,
): FinanceDocumentEnvelopeV1 => {
  const envelopeChunks = payload.chunks
    .flatMap((chunk) => {
      if (!chunk.content.startsWith(REVIEW_ENVELOPE_PREFIX)) return [];
      const encoded = chunk.content.slice(REVIEW_ENVELOPE_PREFIX.length);
      const match = /^(\d{1,3})\/(\d{1,3}):([A-Za-z0-9_-]+)$/u.exec(encoded);
      if (match === null) return error('finance-documents-unavailable');
      return [
        { index: Number(match[1]), count: Number(match[2]), data: match[3] },
      ];
    })
    .sort((left, right) => left.index - right.index);
  const count = envelopeChunks[0]?.count;
  if (
    count === undefined ||
    count !== envelopeChunks.length ||
    count > MAXIMUM_REVIEW_ENVELOPE_CHUNKS ||
    envelopeChunks.some(
      (part, index) => part.index !== index + 1 || part.count !== count,
    )
  ) {
    return error('finance-documents-unavailable');
  }
  const encoded = envelopeChunks.map((part) => part.data).join('');
  const bytes = Buffer.from(encoded, 'base64url');
  try {
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength > MAXIMUM_REVIEW_ENVELOPE_BYTES ||
      bytes.toString('base64url') !== encoded
    ) {
      return error('finance-documents-unavailable');
    }
    return redactFinanceDocumentEnvelopeForReview(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
  } catch {
    return error('finance-documents-unavailable');
  } finally {
    bytes.fill(0);
  }
};

const sourceDateFor = (envelope: FinanceDocumentEnvelopeV1): string | null => {
  const record = envelope as unknown as Readonly<Record<string, unknown>>;
  const values = [
    record.purchasedOn,
    envelope.issuedOn,
    envelope.dueOn,
    envelope.periodEnd,
    envelope.periodStart,
  ];
  const value = values.find(
    (candidate): candidate is string =>
      typeof candidate === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(candidate),
  );
  return value ?? null;
};

const sourceMerchantFor = (
  envelope: FinanceDocumentEnvelopeV1,
): string | null => {
  const record = envelope as unknown as Readonly<Record<string, unknown>>;
  const fields = [
    record.merchant,
    record.vendor,
    record.payee,
    envelope.issuer,
    record.institution,
    record.employer,
  ];
  return (
    fields
      .map((value) => finiteText(value))
      .find((value): value is string => value !== undefined) ?? null
  );
};

const sourceAmountFor = (envelope: FinanceDocumentEnvelopeV1): number | null =>
  envelope.currency === 'CAD' && envelope.total?.currency === 'CAD'
    ? envelope.total.minorUnits
    : null;

const mimeFromAuthorization = (
  authorization: FinanceDocumentOriginalAuthorization,
): FinanceMimeType =>
  FinanceDocumentMimeTypeSchema.parse(authorization.mimeType);

const encodedCursor = (key: Uint8Array, payload: CursorPayload): string => {
  const body = Buffer.from(stableJson(payload), 'utf8');
  try {
    const encoded = body.toString('base64url');
    return `${encoded}.${hmac(key, CURSOR_DOMAIN, encoded)}`;
  } finally {
    body.fill(0);
  }
};

const decodeCursor = (
  key: Uint8Array,
  value: string,
  principal: FinanceDocumentRepositoryPrincipal,
): Readonly<{ updatedAt: string; id: string }> => {
  if (typeof value !== 'string' || value.length < 20 || value.length > 512) {
    return error('invalid-input');
  }
  const parts = value.split('.');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    return error('invalid-input');
  }
  if (!equalText(parts[1]!, hmac(key, CURSOR_DOMAIN, parts[0]!))) {
    return error('invalid-input');
  }
  const bytes = Buffer.from(parts[0]!, 'base64url');
  try {
    if (bytes.toString('base64url') !== parts[0]) return error('invalid-input');
    const parsed = CursorPayloadSchema.safeParse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
    if (
      !parsed.success ||
      parsed.data.householdId !== principal.householdId ||
      parsed.data.privateSpaceId !== principal.privateSpaceId ||
      parsed.data.ownerUserId !== principal.userId ||
      parsed.data.scopeFingerprint !== principal.scopeFingerprint
    ) {
      return error('invalid-input');
    }
    return Object.freeze({
      updatedAt: parsed.data.updatedAt,
      id: parsed.data.id,
    });
  } catch {
    return error('invalid-input');
  } finally {
    bytes.fill(0);
  }
};

export const createProductionFinanceDocumentGateway = (
  dependencies: ProductionFinanceDocumentGatewayDependencies,
): ProductionFinanceDocumentGateway => {
  const reviewTokenHmacKey = copyHmacKey(dependencies.reviewTokenHmacKey);

  const getAuthorization = async (input: {
    readonly principal: FinanceDocumentRepositoryPrincipal;
    readonly requestId: string;
    readonly documentId: string;
  }): Promise<FinanceDocumentOriginalAuthorization> => {
    const authorization =
      await dependencies.repository.getOriginalAuthorization(input);
    if (authorization !== undefined) return authorization;
    const metadata = await dependencies.repository.getMetadata(input);
    if (metadata === undefined) return error('document-not-found');
    return error('document-state-conflict');
  };

  const getSuggestedMatches = async (input: {
    readonly principal: AuthenticatedPrincipal;
    readonly repositoryPrincipal: FinanceDocumentRepositoryPrincipal;
    readonly requestId: string;
    readonly documentId: string;
    readonly extractionRevision: number;
    readonly envelope: FinanceDocumentEnvelopeV1;
  }) => {
    const amountMinorUnits = sourceAmountFor(input.envelope);
    const occurredOn = sourceDateFor(input.envelope);
    const merchantOrPayee = sourceMerchantFor(input.envelope);
    if (
      input.envelope.currency !== 'CAD' ||
      amountMinorUnits === null ||
      occurredOn === null ||
      merchantOrPayee === null
    ) {
      return [] as const;
    }
    try {
      const page = FinancePageSchema.parse(
        await dependencies.financeRead.list({
          limit: 50,
          principal: asExperiencePrincipal(input.principal),
          requestId: input.requestId,
        }),
      );
      const records = page.items.flatMap((item) =>
        item.recordType === 'transaction' && item.state === 'active'
          ? [
              {
                recordType: 'transaction' as const,
                recordId: item.id,
                currency: item.currency,
                amountMinorUnits: item.amountCadMinor,
                occurredOn: item.postedOn,
                merchantOrPayee: item.description,
              },
            ]
          : [],
      );
      return suggestFinanceDocumentMatches({
        source: {
          documentId: input.documentId,
          extractionRevision: input.extractionRevision,
          documentType: input.envelope.documentType,
          currency: input.envelope.currency,
          amountMinorUnits,
          occurredOn,
          merchantOrPayee,
        },
        records,
        limit: 100,
      }).map((match) => ({
        recordType: match.recordType,
        recordId: match.recordId,
        scoreBasisPoints: match.scoreBasisPoints,
        reasons: [...match.reasons],
      }));
    } catch {
      // Suggestions are optional. A projection outage must not block review.
      return [] as const;
    }
  };

  const reviewFor = (input: {
    readonly principal: FinanceDocumentRepositoryPrincipal;
    readonly stored: StoredFinanceDocumentReviewDraft;
    readonly envelope: FinanceDocumentEnvelopeV1;
  }): FinanceDocumentReviewDraft => {
    const reviewToken = storedReviewTokenFor({
      key: reviewTokenHmacKey,
      principal: input.principal,
      stored: input.stored,
    });
    if (reviewToken === undefined) {
      return error('finance-documents-unavailable');
    }
    return FinanceDocumentReviewDraftSchema.parse({
      schemaVersion: 1,
      documentId: input.stored.documentId,
      extractionRevision: input.stored.extractionRevision,
      envelope: input.envelope,
      payloadHash: input.stored.payloadHash,
      reviewToken,
      expiresAt: input.stored.expiresAt,
    });
  };

  const detailFor = async (input: {
    readonly principal: FinanceDocumentRepositoryPrincipal;
    readonly requestId: string;
    readonly documentId: string;
  }) => {
    const document = await dependencies.repository.getMetadata(input);
    if (document === undefined) return error('document-not-found');
    const matchCount =
      document.state === 'committed'
        ? (
            await dependencies.repository.listMatches({
              ...input,
              states: [],
              limit: 100,
            })
          ).length
        : 0;
    return FinanceDocumentDetailSchema.parse({
      schemaVersion: 1,
      document: summaryFor(document),
      reviewAvailable: document.state === 'awaiting-review',
      matchCount,
    });
  };

  const GuardedDocumentActionOperationSchema = z.enum([
    'finance-document-review-commit',
    'finance-document-match-accept',
    'finance-document-delete',
  ]);
  const GuardedDocumentActionIntentSchema = z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('commit-document-review'),
      documentId: UuidSchema,
    }),
    z.strictObject({
      kind: z.literal('accept-document-match'),
      matchId: UuidSchema,
    }),
    z.strictObject({
      kind: z.literal('delete-document'),
      documentId: UuidSchema,
    }),
  ]);
  const GuardedDocumentActionScopeSchema = z.strictObject({
    requestId: UuidSchema,
    runId: UuidSchema,
    userId: UuidSchema,
    householdId: UuidSchema,
    sessionId: UuidSchema,
    privateSpaceId: UuidSchema,
    spaceAccessGrantId: UuidSchema,
    collectionAuthorizationScopeFingerprint:
      EffectiveAuthorizationScopeFingerprintSchema,
    disclosureGrantId: UuidSchema,
    abortSignal: AbortSignalSchema,
  });

  const guardedTargetHash = (
    input: Readonly<Record<string, unknown>>,
  ): string =>
    hashCanonicalJson({
      schemaVersion: 1,
      domain: 'emdo.finance-document-guarded-target.v1',
      ...input,
    });

  const reviewTarget = (review: StoredFinanceDocumentReviewDraft) =>
    Object.freeze({
      reviewBatchId: review.id,
      extractionRevision: review.extractionRevision,
      payloadHash: review.payloadHash,
    });

  const resolveGuardedDocumentTarget = async (input: {
    readonly principal: FinanceDocumentRepositoryPrincipal;
    readonly requestId: string;
    readonly operation: FinanceDocumentGuardedActionOperation;
    readonly intent: FinanceDocumentGuardedActionIntent;
  }): Promise<FinanceDocumentGuardedActionTarget> => {
    const documentId =
      input.intent.kind === 'accept-document-match'
        ? undefined
        : input.intent.documentId;
    if (
      input.operation === 'finance-document-review-commit' &&
      input.intent.kind !== 'commit-document-review'
    ) {
      return error('invalid-input');
    }
    if (
      input.operation === 'finance-document-match-accept' &&
      input.intent.kind !== 'accept-document-match'
    ) {
      return error('invalid-input');
    }
    if (
      input.operation === 'finance-document-delete' &&
      input.intent.kind !== 'delete-document'
    ) {
      return error('invalid-input');
    }

    if (input.operation === 'finance-document-delete') {
      if (input.intent.kind !== 'delete-document') {
        return error('invalid-input');
      }
      const guardedDeletion =
        await dependencies.repository.getGuardedDeleteReceipt({
          principal: input.principal,
          requestId: input.requestId,
          documentId: input.intent.documentId,
        });
      if (guardedDeletion !== undefined) {
        return Object.freeze({
          targetBindingHash: guardedDeletion.receipt.targetBindingHash,
          preview: Object.freeze({
            documentId: input.intent.documentId,
            beforeState: guardedDeletion.state,
            afterState: 'deleted',
            extractionRevision: null,
          }),
        });
      }
    }

    if (input.operation === 'finance-document-match-accept') {
      if (input.intent.kind !== 'accept-document-match') {
        return error('invalid-input');
      }
      const match = await dependencies.repository.getMatchById({
        principal: input.principal,
        requestId: input.requestId,
        matchId: input.intent.matchId,
      });
      if (match === undefined) return error('match-not-found');
      const review = await dependencies.repository.getCurrentCommittedReview({
        principal: input.principal,
        requestId: input.requestId,
        documentId: match.documentId,
      });
      if (
        review === undefined ||
        match.state !== 'suggested' ||
        review.documentId !== match.documentId ||
        review.extractionRevision !== match.extractionRevision
      ) {
        return error('document-state-conflict');
      }
      const matchBindingHash = hashCanonicalJson({
        schemaVersion: 1,
        domain: 'emdo.finance-document-guarded-match.v1',
        id: match.id,
        documentId: match.documentId,
        extractionRevision: match.extractionRevision,
        recordType: match.recordType,
        recordId: match.recordId,
        scoreBasisPoints: match.scoreBasisPoints,
        reasons: match.reasons,
        state: match.state,
        decisionReviewBatchId: match.decisionReviewBatchId,
      });
      return Object.freeze({
        targetBindingHash: guardedTargetHash({
          operation: input.operation,
          documentId: match.documentId,
          review: reviewTarget(review),
          matchBindingHash,
        }),
        preview: Object.freeze({
          documentId: match.documentId,
          beforeState: 'suggested',
          afterState: 'accepted',
          extractionRevision: match.extractionRevision,
          matchId: match.id,
        }),
      });
    }

    const metadata = await dependencies.repository.getMetadata({
      principal: input.principal,
      requestId: input.requestId,
      documentId: documentId!,
    });
    if (metadata === undefined) return error('document-not-found');
    const original = await dependencies.repository.getOriginalAuthorization({
      principal: input.principal,
      requestId: input.requestId,
      documentId: metadata.id,
    });
    if (original === undefined) return error('document-state-conflict');

    if (input.operation === 'finance-document-review-commit') {
      if (metadata.state === 'deleting' || metadata.state === 'deleted') {
        return error('document-state-conflict');
      }
      const review =
        metadata.state === 'awaiting-review'
          ? await dependencies.repository.getCurrentReviewDraft({
              principal: input.principal,
              requestId: input.requestId,
              documentId: metadata.id,
            })
          : metadata.state === 'committed'
            ? await dependencies.repository.getCurrentCommittedReview({
                principal: input.principal,
                requestId: input.requestId,
                documentId: metadata.id,
              })
            : undefined;
      if (
        review === undefined ||
        metadata.extractionRevision !== review.extractionRevision
      ) {
        return error('document-state-conflict');
      }
      return Object.freeze({
        targetBindingHash: guardedTargetHash({
          operation: input.operation,
          documentId: metadata.id,
          originalPlaintextSha256: original.plaintextSha256,
          review: reviewTarget(review),
        }),
        preview: Object.freeze({
          documentId: metadata.id,
          beforeState: metadata.state,
          afterState: 'committed',
          extractionRevision: review.extractionRevision,
        }),
      });
    }

    if (metadata.deletedAt !== null) {
      return error('document-state-conflict');
    }
    const review =
      metadata.state === 'awaiting-review'
        ? await dependencies.repository.getCurrentReviewDraft({
            principal: input.principal,
            requestId: input.requestId,
            documentId: metadata.id,
          })
        : metadata.state === 'committed'
          ? await dependencies.repository.getCurrentCommittedReview({
              principal: input.principal,
              requestId: input.requestId,
              documentId: metadata.id,
            })
          : undefined;
    if (
      (metadata.state === 'committed' && review === undefined) ||
      (review !== undefined &&
        review.extractionRevision !== metadata.extractionRevision)
    ) {
      return error('document-state-conflict');
    }
    return Object.freeze({
      targetBindingHash: guardedTargetHash({
        operation: input.operation,
        documentId: metadata.id,
        documentState: metadata.state,
        extractionRevision: metadata.extractionRevision,
        originalPlaintextSha256: original.plaintextSha256,
        ...(review === undefined ? {} : { review: reviewTarget(review) }),
      }),
      preview: Object.freeze({
        documentId: metadata.id,
        beforeState: metadata.state,
        afterState: 'deleted',
        extractionRevision: metadata.extractionRevision,
      }),
    });
  };

  /**
   * These mutation helpers are reachable only through the request-scoped
   * guarded port below.  In particular, they do not accept a client review
   * token or a caller-provided approval identifier: both values are resolved
   * from the current owner-scoped state after the shared proposal gateway has
   * minted an exact permit.
   */
  const commitReviewedDraftUnderPermit = async (input: {
    readonly principal: FinanceDocumentRepositoryPrincipal;
    readonly requestId: string;
    readonly documentId: string;
  }) => {
    const pending = await dependencies.repository.getCurrentReviewDraft({
      principal: input.principal,
      requestId: input.requestId,
      documentId: input.documentId,
    });
    if (pending === undefined) {
      const committed = await dependencies.repository.getCurrentCommittedReview(
        {
          principal: input.principal,
          requestId: input.requestId,
          documentId: input.documentId,
        },
      );
      if (committed === undefined) return error('document-state-conflict');
      return detailFor(input);
    }
    const reviewToken = storedReviewTokenFor({
      key: reviewTokenHmacKey,
      principal: input.principal,
      stored: pending,
    });
    if (reviewToken === undefined) {
      return error('finance-documents-unavailable');
    }
    const embeddings = await reviewedEmbeddingsFor({
      embeddings: dependencies.embeddings,
      selectedFacts: pending.selectedFacts,
    });
    await dependencies.repository.commitReview({
      principal: input.principal,
      requestId: input.requestId,
      documentId: pending.documentId,
      extractionRevision: pending.extractionRevision,
      reviewBatchId: pending.id,
      reviewToken,
      payloadHash: pending.payloadHash,
      idempotencyKey: pending.idempotencyKey,
      embeddings,
    });
    return detailFor(input);
  };

  const acceptSuggestedMatchUnderPermit = async (input: {
    readonly principal: FinanceDocumentRepositoryPrincipal;
    readonly requestId: string;
    readonly matchId: string;
  }) => {
    const match = await dependencies.repository.getMatchById({
      principal: input.principal,
      requestId: input.requestId,
      matchId: input.matchId,
    });
    if (match === undefined || match.state !== 'suggested') {
      return error('document-state-conflict');
    }
    const review = await dependencies.repository.getCurrentCommittedReview({
      principal: input.principal,
      requestId: input.requestId,
      documentId: match.documentId,
    });
    const reviewToken =
      review === undefined
        ? undefined
        : storedReviewTokenFor({
            key: reviewTokenHmacKey,
            principal: input.principal,
            stored: review,
          });
    if (
      review === undefined ||
      review.extractionRevision !== match.extractionRevision ||
      reviewToken === undefined
    ) {
      return error('document-state-conflict');
    }
    await dependencies.repository.decideMatch({
      principal: input.principal,
      requestId: input.requestId,
      documentId: match.documentId,
      matchId: match.id,
      reviewBatchId: review.id,
      decision: 'accepted',
    });
    return Object.freeze({
      documentId: match.documentId,
      matchId: match.id,
    });
  };

  const deleteDocumentUnderPermit = async (input: {
    readonly principal: FinanceDocumentRepositoryPrincipal;
    readonly requestId: string;
    readonly documentId: string;
    readonly receipt: Readonly<{
      readonly proposalId: string;
      readonly decisionId: string;
      readonly targetBindingHash: string;
      readonly executionBindingHash: string;
    }>;
  }) => {
    const started = await dependencies.repository.beginGuardedDelete({
      principal: input.principal,
      requestId: input.requestId,
      documentId: input.documentId,
      receipt: input.receipt,
    });
    if (started.status === 'already-deleted') {
      return Object.freeze({ status: 'deleted' as const });
    }
    try {
      await dependencies.storage.purge(started.original.storageObjectId);
      await dependencies.repository.finalizeGuardedDelete({
        principal: input.principal,
        requestId: input.requestId,
        documentId: input.documentId,
        receipt: input.receipt,
      });
      return Object.freeze({ status: 'deleted' as const });
    } catch {
      // beginDelete revokes access before a provider call. The durable receipt
      // binding added at the repository boundary makes a later permitted
      // replay the only way to retry this purge.
      return Object.freeze({ status: 'pending-purge' as const });
    }
  };

  const guardedActionPortFor = (
    capturedPrincipal: AuthenticatedPrincipal,
  ): FinanceDocumentGuardedActionPort => {
    const parsedPrincipal =
      AuthenticatedPrincipalSchema.safeParse(capturedPrincipal);
    if (
      !parsedPrincipal.success ||
      parsedPrincipal.data.privateSpaceId === undefined
    ) {
      throw new Error('api-finance-document-guarded-action-unavailable');
    }
    const fixedPrincipal = Object.freeze(parsedPrincipal.data);
    const scoped = (rawScope: FinanceCapabilityScope) => {
      const scope = GuardedDocumentActionScopeSchema.parse(rawScope);
      if (
        scope.abortSignal.aborted ||
        scope.userId !== fixedPrincipal.userId ||
        scope.householdId !== fixedPrincipal.householdId ||
        scope.sessionId !== fixedPrincipal.sessionId ||
        scope.privateSpaceId !== fixedPrincipal.privateSpaceId ||
        scope.spaceAccessGrantId !== fixedPrincipal.spaceAccessGrantId ||
        scope.collectionAuthorizationScopeFingerprint !==
          fixedPrincipal.collectionAuthorizationScopeFingerprint
      ) {
        return error('authorization-revoked');
      }
      return Object.freeze({
        scope,
        principal: asPrivatePrincipal(fixedPrincipal),
      });
    };

    return Object.freeze({
      async materializeTarget(
        rawInput: Parameters<
          FinanceDocumentGuardedActionPort['materializeTarget']
        >[0],
      ) {
        try {
          const operation = GuardedDocumentActionOperationSchema.parse(
            rawInput.operation,
          ) as FinanceDocumentGuardedActionOperation;
          const intent = GuardedDocumentActionIntentSchema.parse(
            rawInput.intent,
          ) as FinanceDocumentGuardedActionIntent;
          const current = scoped(rawInput.scope);
          return await resolveGuardedDocumentTarget({
            principal: current.principal,
            requestId: current.scope.requestId,
            operation,
            intent,
          });
        } catch (cause) {
          throw safeError(cause);
        }
      },
      async executeApproved(
        rawInput: Parameters<
          FinanceDocumentGuardedActionPort['executeApproved']
        >[0],
      ) {
        try {
          const operation = GuardedDocumentActionOperationSchema.parse(
            rawInput.operation,
          ) as FinanceDocumentGuardedActionOperation;
          const intent = GuardedDocumentActionIntentSchema.parse(
            rawInput.intent,
          ) as FinanceDocumentGuardedActionIntent;
          const current = scoped(rawInput.scope);
          const permit = GuardedActionPermitSchema.parse(rawInput.permit);
          const capabilityFingerprint = Sha256Schema.parse(
            rawInput.capabilityFingerprint,
          );
          const decisionId = UuidSchema.parse(rawInput.approvalDecisionId);
          const target = await resolveGuardedDocumentTarget({
            principal: current.principal,
            requestId: current.scope.requestId,
            operation,
            intent,
          });
          const actionHash = hashCanonicalJson({
            schemaVersion: 1,
            mutation: intent,
          });
          const expectedExecutionBindingHash =
            hashFinanceGuardedActionExecutionBinding({
              proposalId: permit.proposalId,
              scope: current.scope,
              capabilityId: 'finance.records.write',
              capabilityVersion: '1.0.0',
              capabilityFingerprint,
              operation,
              actionHash,
              targetBindingHash: target.targetBindingHash,
            });
          // The shared proposal gateway has already read and verified the
          // durable approval decision before minting this permit.  This leaf
          // nevertheless verifies the complete permit/decision tuple again
          // before it touches document storage or persistence.
          if (
            permit.decisionId !== decisionId ||
            permit.capabilityId !== 'finance.records.write' ||
            permit.capabilityVersion !== '1.0.0' ||
            permit.capabilityFingerprint !== capabilityFingerprint ||
            permit.operation !== operation ||
            permit.actionHash !== actionHash ||
            permit.executionBindingHash !== expectedExecutionBindingHash
          ) {
            return error('authorization-revoked');
          }

          if (operation === 'finance-document-review-commit') {
            if (intent.kind !== 'commit-document-review') {
              return error('invalid-input');
            }
            const committed = await commitReviewedDraftUnderPermit({
              principal: current.principal,
              requestId: current.scope.requestId,
              documentId: intent.documentId,
            });
            if (
              committed.document.id !== intent.documentId ||
              committed.document.state !== 'committed' ||
              committed.document.extractionRevision === null
            ) {
              return error('document-state-conflict');
            }
            return Object.freeze({
              status: 'document-committed' as const,
              documentId: committed.document.id,
              extractionRevision: committed.document.extractionRevision,
            });
          }

          if (operation === 'finance-document-match-accept') {
            if (intent.kind !== 'accept-document-match') {
              return error('invalid-input');
            }
            const accepted = await acceptSuggestedMatchUnderPermit({
              principal: current.principal,
              requestId: current.scope.requestId,
              matchId: intent.matchId,
            });
            return Object.freeze({
              status: 'match-accepted' as const,
              documentId: accepted.documentId,
              matchId: accepted.matchId,
            });
          }

          if (intent.kind !== 'delete-document') {
            return error('invalid-input');
          }
          const deleted = await deleteDocumentUnderPermit({
            principal: current.principal,
            requestId: current.scope.requestId,
            documentId: intent.documentId,
            receipt: Object.freeze({
              proposalId: permit.proposalId,
              decisionId: permit.decisionId,
              targetBindingHash: target.targetBindingHash,
              executionBindingHash: permit.executionBindingHash,
            }),
          });
          return Object.freeze({
            status:
              deleted.status === 'deleted'
                ? ('document-deleted' as const)
                : ('document-purge-pending' as const),
            documentId: intent.documentId,
          });
        } catch (cause) {
          throw safeError(cause);
        }
      },
    });
  };

  const gateway: ProductionFinanceDocumentGateway = {
    createGuardedActionPort(principal) {
      return guardedActionPortFor(principal);
    },
    dispose() {
      reviewTokenHmacKey.fill(0);
    },
    async checkReady() {
      try {
        const [databaseReady, storageReady] = await Promise.all([
          dependencies.repository.checkInfrastructureReady(),
          dependencies.storage.checkReady(),
        ]);
        return databaseReady === true && storageReady === true;
      } catch {
        return false;
      }
    },

    async list(input) {
      try {
        const principal = asPrivatePrincipal(input.principal);
        const state =
          input.state === undefined
            ? []
            : [FinanceDocumentStateSchema.parse(input.state)];
        const documentType =
          input.documentType === undefined
            ? []
            : [FinanceDocumentTypeSchema.parse(input.documentType)];
        const cursor =
          input.cursor === undefined
            ? null
            : decodeCursor(reviewTokenHmacKey, input.cursor, principal);
        const result = await dependencies.repository.list({
          principal,
          requestId: input.requestId,
          states: state,
          documentTypes: documentType,
          includeDeleted: false,
          cursor,
          limit: input.limit,
        });
        return z
          .object({
            schemaVersion: z.literal(1),
            items: z.array(FinanceDocumentSummarySchema).max(100),
            nextCursor: z.string().trim().min(1).max(512).optional(),
          })
          .parse({
            schemaVersion: 1,
            items: result.documents.map(summaryFor),
            ...(result.nextCursor === null
              ? {}
              : {
                  nextCursor: encodedCursor(reviewTokenHmacKey, {
                    version: 1,
                    householdId: principal.householdId,
                    privateSpaceId: principal.privateSpaceId,
                    ownerUserId: principal.userId,
                    scopeFingerprint:
                      EffectiveAuthorizationScopeFingerprintSchema.parse(
                        principal.scopeFingerprint,
                      ),
                    updatedAt: result.nextCursor.updatedAt,
                    id: result.nextCursor.id,
                  }),
                }),
          });
      } catch (cause) {
        throw safeError(cause);
      }
    },

    async get(input) {
      try {
        return await detailFor({
          principal: asPrivatePrincipal(input.principal),
          requestId: input.requestId,
          documentId: input.documentId,
        });
      } catch (cause) {
        throw safeError(cause);
      }
    },

    async upload(input) {
      const principal = asPrivatePrincipal(input.principal);
      const declaredMimeType = FinanceDocumentMimeTypeSchema.safeParse(
        input.declaredMimeType,
      );
      if (!declaredMimeType.success) return error('invalid-input');
      let storageMetadata: FinanceDocumentMetadata | undefined;
      let stored = false;
      let bytes: Buffer | undefined;
      try {
        storageMetadata = await dependencies.storage.store({
          source: sniffedUploadSource(input.source, declaredMimeType.data),
          aad: originalAad(principal),
        });
        bytes = await readStoredBytes({
          storage: dependencies.storage,
          metadata: storageMetadata,
          aad: originalAad(principal),
        });
        const inspection = await inspectOriginal({
          bytes,
          declaredMimeType: declaredMimeType.data,
          pdfInspector: dependencies.pdfInspector,
        });
        const created = await dependencies.repository.createUploadedMetadata({
          principal,
          requestId: input.requestId,
          storage: {
            storageObjectId: storageMetadata.objectName,
            displayName: safeDocumentDisplayName(input.displayName),
            mimeType: declaredMimeType.data,
            byteSize: storageMetadata.plaintextBytes,
            ...inspection,
            plaintextSha256: storageMetadata.plaintextSha256,
            ciphertextSha256: storageMetadata.ciphertextSha256,
            wrappedDataKey: {
              algorithm: storageMetadata.algorithm,
              wrappedKey: storageMetadata.wrappedKey,
              nonce: storageMetadata.nonce,
              authenticationTag: storageMetadata.authenticationTag,
              aadVersion: storageMetadata.aadVersion,
            },
            keyVersion: storageMetadata.keyVersion,
          },
        });
        if (created.status === 'duplicate') {
          await dependencies.storage.purge(storageMetadata.objectName);
          storageMetadata = undefined;
          return summaryFor(created.document);
        }
        if (created.status === 'quota-exceeded') {
          await dependencies.storage.purge(storageMetadata.objectName);
          storageMetadata = undefined;
          return error('quota-exceeded');
        }
        stored = true;
        await dependencies.repository.createOrRetryExtractionRevision({
          principal,
          requestId: input.requestId,
          documentId: created.document.id,
          retry: false,
          model: null,
        });
        const document = await dependencies.repository.getMetadata({
          principal,
          requestId: input.requestId,
          documentId: created.document.id,
        });
        if (document === undefined) return error('document-not-found');
        return summaryFor(document);
      } catch (cause) {
        if (!stored && storageMetadata !== undefined) {
          try {
            await dependencies.storage.purge(storageMetadata.objectName);
          } catch {
            throw new FinanceDocumentGatewayError(
              'finance-documents-unavailable',
            );
          }
        }
        throw safeError(cause);
      } finally {
        bytes?.fill(0);
      }
    },

    async downloadOriginal(input) {
      try {
        const principal = asPrivatePrincipal(input.principal);
        const authorization = await getAuthorization({
          principal,
          requestId: input.requestId,
          documentId: input.documentId,
        });
        const metadata = storageMetadataFromAuthorization(authorization);
        return {
          displayName:
            (
              await dependencies.repository.getMetadata({
                principal,
                requestId: input.requestId,
                documentId: input.documentId,
              })
            )?.displayName ?? 'finance-document',
          mimeType: mimeFromAuthorization(authorization),
          byteSize: authorization.byteSize,
          body: {
            async *[Symbol.asyncIterator]() {
              try {
                for await (const chunk of dependencies.storage.read({
                  metadata,
                  aad: originalAad(principal),
                })) {
                  if (!isChunk(chunk))
                    return error('finance-documents-unavailable');
                  yield chunk;
                }
              } catch (cause) {
                throw safeError(cause);
              }
            },
          },
        };
      } catch (cause) {
        throw safeError(cause);
      }
    },

    async retry(input) {
      try {
        const principal = asPrivatePrincipal(input.principal);
        await dependencies.repository.createOrRetryExtractionRevision({
          principal,
          requestId: input.requestId,
          documentId: input.documentId,
          retry: true,
          model: null,
        });
        return await detailFor({
          principal,
          requestId: input.requestId,
          documentId: input.documentId,
        });
      } catch (cause) {
        throw safeError(cause);
      }
    },

    async getReview(input) {
      try {
        const principal = asPrivatePrincipal(input.principal);
        const existing = await dependencies.repository.getCurrentReviewDraft({
          principal,
          requestId: input.requestId,
          documentId: input.documentId,
        });
        if (existing !== undefined) {
          return reviewFor({
            principal,
            stored: existing,
            envelope: envelopeFromReviewedPayload(existing.selectedFacts),
          });
        }
        const extraction = await dependencies.repository.getCurrentExtraction({
          principal,
          requestId: input.requestId,
          documentId: input.documentId,
        });
        const envelope = redactFinanceDocumentEnvelopeForReview(
          await dependencies.payloadCrypto.decrypt(
            extraction.encryptedPayload,
            payloadScope({
              principal,
              documentId: extraction.documentId,
              extractionRevision: extraction.extractionRevision,
            }),
          ),
        );
        const matches = await getSuggestedMatches({
          principal: input.principal,
          repositoryPrincipal: principal,
          requestId: input.requestId,
          documentId: extraction.documentId,
          extractionRevision: extraction.extractionRevision,
          envelope,
        });
        const selectedFacts = reviewedPayloadFor({
          documentId: extraction.documentId,
          extractionRevision: extraction.extractionRevision,
          envelope,
          matches,
        });
        const payloadHash = sha256(stableJson(selectedFacts));
        const binding = {
          principal,
          documentId: extraction.documentId,
          extractionRevision: extraction.extractionRevision,
          payloadHash,
        };
        const reviewToken = reviewTokenV2For(reviewTokenHmacKey, binding);
        const review = await dependencies.repository.replaceCurrentReviewDraft({
          principal,
          requestId: input.requestId,
          documentId: extraction.documentId,
          extractionRevision: extraction.extractionRevision,
          reviewToken,
          idempotencyKey: reviewIdempotencyKeyV2For(
            reviewTokenHmacKey,
            binding,
          ),
          selectedFacts,
        });
        if (!equalText(review.review.payloadHash, payloadHash)) {
          return error('finance-documents-unavailable');
        }
        return reviewFor({ principal, stored: review.review, envelope });
      } catch (cause) {
        throw safeError(cause);
      }
    },

    async updateReview(input) {
      try {
        const principal = asPrivatePrincipal(input.principal);
        const envelope = redactFinanceDocumentEnvelopeForReview(input.envelope);
        const matches = await getSuggestedMatches({
          principal: input.principal,
          repositoryPrincipal: principal,
          requestId: input.requestId,
          documentId: input.documentId,
          extractionRevision: input.expectedExtractionRevision,
          envelope,
        });
        const selectedFacts = reviewedPayloadFor({
          documentId: input.documentId,
          extractionRevision: input.expectedExtractionRevision,
          envelope,
          matches,
        });
        const payloadHash = sha256(stableJson(selectedFacts));
        const binding = {
          principal,
          documentId: input.documentId,
          extractionRevision: input.expectedExtractionRevision,
          payloadHash,
        };
        const reviewToken = reviewTokenV2For(reviewTokenHmacKey, binding);
        const replacement =
          await dependencies.repository.replaceCurrentReviewDraft({
            principal,
            requestId: input.requestId,
            documentId: input.documentId,
            extractionRevision: input.expectedExtractionRevision,
            reviewToken,
            idempotencyKey: IdempotencyKeySchema.parse(input.idempotencyKey),
            selectedFacts,
          });
        return reviewFor({
          principal,
          stored: replacement.review,
          envelope,
        });
      } catch (cause) {
        throw safeError(cause);
      }
    },

    async commitReview() {
      // A review token is proof of a reviewed draft, not mutation authority.
      // The only execution route is the guarded action port above.
      return error('approval-required');
    },

    async listMatches(input) {
      try {
        const principal = asPrivatePrincipal(input.principal);
        const matches = await dependencies.repository.listMatches({
          principal,
          requestId: input.requestId,
          documentId: input.documentId,
          states: [],
          limit: 100,
        });
        return FinanceDocumentMatchListSchema.parse({
          schemaVersion: 1,
          items: matches.map((match) => ({
            schemaVersion: 1,
            id: match.id,
            documentId: match.documentId,
            extractionRevision: match.extractionRevision,
            recordType: match.recordType,
            recordId: match.recordId,
            scoreBasisPoints: match.scoreBasisPoints,
            reasons: match.reasons,
            state: match.state,
          })),
        });
      } catch (cause) {
        throw safeError(cause);
      }
    },

    async decideMatch(input) {
      if (input.decision === 'accept') {
        // Match acceptance changes the trusted document decision state and is
        // therefore intentionally unavailable on the direct HTTP boundary.
        return error('approval-required');
      }
      try {
        const principal = asPrivatePrincipal(input.principal);
        const match = await dependencies.repository.getMatchById({
          principal,
          requestId: input.requestId,
          matchId: input.matchId,
        });
        if (match === undefined) return error('match-not-found');
        const review =
          await dependencies.repository.getCommittedReviewAuthorization({
            principal,
            requestId: input.requestId,
            documentId: match.documentId,
            reviewToken: input.reviewToken,
          });
        if (review === undefined) return error('review-token-invalid');
        const expected = storedReviewTokenFor({
          key: reviewTokenHmacKey,
          principal,
          stored: review,
        });
        if (expected === undefined || !equalText(expected, input.reviewToken)) {
          return error('review-token-invalid');
        }
        await dependencies.repository.decideMatch({
          principal,
          requestId: input.requestId,
          documentId: match.documentId,
          matchId: match.id,
          reviewBatchId: review.id,
          decision: 'rejected',
        });
        const matches = await dependencies.repository.listMatches({
          principal,
          requestId: input.requestId,
          documentId: match.documentId,
          states: [],
          limit: 100,
        });
        return FinanceDocumentMatchListSchema.parse({
          schemaVersion: 1,
          items: matches.map((current) => ({
            schemaVersion: 1,
            id: current.id,
            documentId: current.documentId,
            extractionRevision: current.extractionRevision,
            recordType: current.recordType,
            recordId: current.recordId,
            scoreBasisPoints: current.scoreBasisPoints,
            reasons: current.reasons,
            state: current.state,
          })),
        });
      } catch (cause) {
        throw safeError(cause);
      }
    },

    async getEvidence(input) {
      try {
        const evidence = await dependencies.repository.getEvidenceById({
          principal: asPrivatePrincipal(input.principal),
          requestId: input.requestId,
          evidenceId: input.evidenceId,
        });
        if (evidence === undefined) return error('evidence-not-found');
        return FinanceDocumentEvidenceListSchema.parse({
          schemaVersion: 1,
          items: [
            {
              schemaVersion: 1,
              id: evidence.id,
              documentId: evidence.documentId,
              extractionRevision: evidence.extractionRevision,
              page: evidence.page,
              excerpt: evidence.excerpt,
              sourceLocale: evidence.sourceLocale,
              locator: evidence.locator,
            },
          ],
        });
      } catch (cause) {
        throw safeError(cause);
      }
    },

    async delete() {
      // A decision UUID alone is not authority. Deletion can begin only after
      // the shared proposal lifecycle mints and the guarded port verifies an
      // exact permit.
      return error('approval-required');
    },

    async readExperience(input) {
      const principal = asPrivatePrincipal(input.principal);
      const locale = FinanceLocaleSchema.safeParse(input.locale).success
        ? FinanceLocaleSchema.parse(input.locale)
        : 'en-CA';
      try {
        const [quota, snapshotResult] = await Promise.all([
          dependencies.repository.getOwnerQuota({
            principal,
            requestId: input.requestId,
          }),
          dependencies.financeRead.readSnapshot({
            principal: input.principal,
            requestId: input.requestId,
          }),
        ]);
        const snapshot = FinanceExperienceSnapshotSchema.parse(snapshotResult);
        return FinanceExperienceV1Schema.parse({
          schemaVersion: 1,
          locale: locale as FinanceLocale,
          connectivity: 'online',
          quota: {
            documentsUsed: quota.documentCount,
            documentsLimit: quota.maxDocuments,
            bytesUsed: quota.byteCount,
            bytesLimit: quota.maxBytes,
          },
          reviewedCadTotals: snapshot.reviewedCadTotals,
          recentActivity: snapshot.recentActivity ?? [],
          budgets: snapshot.budgets,
        });
      } catch (cause) {
        const mapped = safeError(cause);
        if (mapped.code === 'authorization-revoked') throw mapped;
        return FinanceExperienceV1Schema.parse({
          schemaVersion: 1,
          locale: locale as FinanceLocale,
          connectivity: 'unavailable',
          quota: {
            documentsUsed: 0,
            documentsLimit: FINANCE_DOCUMENT_LIMITS.maximumDocumentsPerOwner,
            bytesUsed: 0,
            bytesLimit: FINANCE_DOCUMENT_LIMITS.maximumBytesPerOwner,
          },
          reviewedCadTotals: [],
          recentActivity: [],
          budgets: [],
        });
      }
    },
  };

  return Object.freeze(gateway);
};

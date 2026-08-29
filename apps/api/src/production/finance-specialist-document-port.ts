import {
  EffectiveAuthorizationScopeFingerprintSchema,
  IsoDateTimeSchema,
  OpaqueReferenceSchema,
  UuidSchema,
  deepFreeze,
} from '@emdo/contracts';
import {
  fuseFinanceEvidenceRanks,
  type FinanceDocumentType,
} from '@emdo/domains/finance';
import { z } from 'zod';

import type {
  FinanceCapabilityScope,
  FinanceSpecialistDocumentPort,
} from './finance-agent-services.js';

const MAXIMUM_SEARCH_QUERY_CHARACTERS = 500;
const MAXIMUM_SEARCH_RESULTS = 25;
const MAXIMUM_EVIDENCE_PER_SEARCH_DOCUMENT = 32;
const MAXIMUM_EVIDENCE_PER_SEARCH_HIT = 8;
const MAXIMUM_READ_EVIDENCE = 32;
const MAXIMUM_MATCHES = 50;
const EMBEDDING_DIMENSIONS = 1_536;

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
const CurrencySchema = z.string().regex(/^[A-Z]{3}$/u);
const MatchStateSchema = z.enum(['suggested', 'accepted', 'rejected']);
const FinanceRecordTypeSchema = z.enum([
  'account',
  'transaction',
  'category',
  'budget',
  'bill',
  'subscription',
  'goal',
]);

const FixedOwnerSchema = z.strictObject({
  userId: UuidSchema,
  sessionId: UuidSchema,
  householdId: UuidSchema,
  privateSpaceId: UuidSchema,
  role: z.enum(['owner', 'member']),
  emailVerified: z.literal(true),
  spaceAccessGrantId: UuidSchema,
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema,
});

const ScopeSchema = z.strictObject({
  requestId: UuidSchema,
  runId: UuidSchema,
  userId: UuidSchema,
  householdId: UuidSchema,
  sessionId: UuidSchema,
  privateSpaceId: UuidSchema,
  spaceAccessGrantId: UuidSchema,
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema,
  disclosureGrantId: UuidSchema.optional(),
  abortSignal: z.custom<AbortSignal>(
    (value) =>
      value !== null &&
      typeof value === 'object' &&
      typeof (value as AbortSignal).aborted === 'boolean',
  ),
});

const MetadataSchema = z.object({
  id: UuidSchema,
  state: z.enum([
    'uploaded',
    'extracting',
    'awaiting-review',
    'committed',
    'failed',
    'deleting',
    'deleted',
  ]),
  displayName: z.string().nullable(),
  documentType: FinanceDocumentTypeSchema.nullable(),
  sourceLocale: FinanceLocaleSchema.nullable(),
  currency: CurrencySchema.nullable(),
  extractionRevision: z.number().int().positive().nullable(),
  updatedAt: IsoDateTimeSchema,
  deletedAt: IsoDateTimeSchema.nullable(),
});

const CommittedProjectionSchema = z.strictObject({
  id: UuidSchema,
  documentType: FinanceDocumentTypeSchema,
  sourceLocale: FinanceLocaleSchema,
  currency: CurrencySchema.nullable(),
  extractionRevision: z.number().int().positive(),
  occurredOn: z.iso.date().nullable(),
  amountMinor: z.number().int().safe().nullable(),
  committedAt: IsoDateTimeSchema,
});

const StructuredSearchResultSchema = MetadataSchema.extend({
  structuredRank: z.number().int().positive(),
});

const FullTextSearchResultSchema = z
  .object({
    id: UuidSchema,
    documentId: UuidSchema,
    extractionRevision: z.number().int().positive(),
    documentType: FinanceDocumentTypeSchema,
    currency: CurrencySchema.nullable(),
    pageStart: z.number().int().positive().max(250),
    pageEnd: z.number().int().positive().max(250),
    fullTextRank: z
      .number()
      .int()
      .positive()
      .max(MAXIMUM_SEARCH_RESULTS)
      .nullable(),
    vectorRank: z
      .number()
      .int()
      .positive()
      .max(MAXIMUM_SEARCH_RESULTS)
      .nullable(),
  })
  .refine(
    (row) => row.fullTextRank !== null || row.vectorRank !== null,
    'A search candidate must have a lexical or vector rank',
  );

const SearchResultSchema = z.object({
  structured: z.array(StructuredSearchResultSchema).max(MAXIMUM_SEARCH_RESULTS),
  fullText: z.array(FullTextSearchResultSchema).max(MAXIMUM_SEARCH_RESULTS),
});

const EvidenceSchema = z.object({
  id: UuidSchema,
  documentId: UuidSchema,
  extractionRevision: z.number().int().positive(),
  chunkId: UuidSchema.nullable(),
  page: z.number().int().positive().max(250),
  excerpt: z.string().min(1).max(8_192),
  sourceLocale: FinanceLocaleSchema,
});

const MatchSchema = z.object({
  id: UuidSchema,
  documentId: UuidSchema,
  extractionRevision: z.number().int().positive(),
  recordType: FinanceRecordTypeSchema,
  recordId: OpaqueReferenceSchema,
  scoreBasisPoints: z.number().int().min(0).max(10_000),
  reasons: z.array(z.string().min(1).max(240)).min(1).max(8),
  state: MatchStateSchema,
});

const SearchRequestSchema = z
  .object({
    scope: ScopeSchema,
    query: z.string().trim().min(1).max(MAXIMUM_SEARCH_QUERY_CHARACTERS),
    documentTypes: z.array(FinanceDocumentTypeSchema).max(10).optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    limit: z.number().int().min(1).max(MAXIMUM_SEARCH_RESULTS),
  })
  .superRefine((value, context) => {
    if (
      value.from !== undefined &&
      value.to !== undefined &&
      value.to < value.from
    ) {
      context.addIssue({
        code: 'custom',
        path: ['to'],
        message: 'End date must not precede start date',
      });
    }
  });

const ReadRequestSchema = z.object({
  scope: ScopeSchema,
  documentId: UuidSchema,
  evidenceIds: z.array(UuidSchema).max(MAXIMUM_READ_EVIDENCE),
});

const MatchesRequestSchema = z.object({
  scope: ScopeSchema,
  documentId: UuidSchema,
  states: z.array(MatchStateSchema).max(3).optional(),
  limit: z.number().int().min(1).max(MAXIMUM_MATCHES),
});

const EmbeddingSchema = z
  .array(z.number().finite())
  .length(EMBEDDING_DIMENSIONS);

type FixedOwner = z.output<typeof FixedOwnerSchema>;
type Metadata = z.output<typeof MetadataSchema>;
type CommittedProjection = z.output<typeof CommittedProjectionSchema>;
type CommittedDocument = Metadata & CommittedProjection;
type Evidence = z.output<typeof EvidenceSchema>;
type PublicSearchHit = Awaited<
  ReturnType<FinanceSpecialistDocumentPort['searchCommitted']>
>[number];
type PublicEvidence = PublicSearchHit['evidence'][number];
type PublicReadResult = NonNullable<
  Awaited<ReturnType<FinanceSpecialistDocumentPort['readCommitted']>>
>;
type PublicMatch = Awaited<
  ReturnType<FinanceSpecialistDocumentPort['listCommittedMatches']>
>[number];

/**
 * This is the minimum read surface needed from the document repository. It
 * deliberately excludes storage authorization, extraction drafts, encrypted
 * payloads, write commands, pools, and SQL handles.
 */
export interface FinanceSpecialistCommittedDocumentRepository {
  search(input: {
    readonly principal: Readonly<{
      readonly userId: string;
      readonly sessionId: string;
      readonly householdId: string;
      readonly privateSpaceId: string;
      readonly emailVerified: true;
      readonly spaceAccessGrantId: string;
      readonly scopeFingerprint: string;
    }>;
    readonly requestId: string;
    readonly query: string;
    readonly documentTypes: readonly FinanceDocumentType[];
    readonly currency: string | null;
    readonly displayName: string | null;
    readonly vectorQuery: readonly number[] | null;
    readonly limit: number;
  }): Promise<unknown>;
  getMetadata(input: {
    readonly principal: Readonly<{
      readonly userId: string;
      readonly sessionId: string;
      readonly householdId: string;
      readonly privateSpaceId: string;
      readonly emailVerified: true;
      readonly spaceAccessGrantId: string;
      readonly scopeFingerprint: string;
    }>;
    readonly requestId: string;
    readonly documentId: string;
  }): Promise<unknown>;
  getCommittedProjection(input: {
    readonly principal: Readonly<{
      readonly userId: string;
      readonly sessionId: string;
      readonly householdId: string;
      readonly privateSpaceId: string;
      readonly emailVerified: true;
      readonly spaceAccessGrantId: string;
      readonly scopeFingerprint: string;
    }>;
    readonly requestId: string;
    readonly documentId: string;
  }): Promise<unknown>;
  listEvidence(input: {
    readonly principal: Readonly<{
      readonly userId: string;
      readonly sessionId: string;
      readonly householdId: string;
      readonly privateSpaceId: string;
      readonly emailVerified: true;
      readonly spaceAccessGrantId: string;
      readonly scopeFingerprint: string;
    }>;
    readonly requestId: string;
    readonly documentId: string;
    readonly limit: number;
  }): Promise<unknown>;
  getEvidenceById(input: {
    readonly principal: Readonly<{
      readonly userId: string;
      readonly sessionId: string;
      readonly householdId: string;
      readonly privateSpaceId: string;
      readonly emailVerified: true;
      readonly spaceAccessGrantId: string;
      readonly scopeFingerprint: string;
    }>;
    readonly requestId: string;
    readonly evidenceId: string;
  }): Promise<unknown>;
  listMatches(input: {
    readonly principal: Readonly<{
      readonly userId: string;
      readonly sessionId: string;
      readonly householdId: string;
      readonly privateSpaceId: string;
      readonly emailVerified: true;
      readonly spaceAccessGrantId: string;
      readonly scopeFingerprint: string;
    }>;
    readonly requestId: string;
    readonly documentId: string;
    readonly states: readonly ('suggested' | 'accepted' | 'rejected')[];
    readonly limit: number;
  }): Promise<unknown>;
}

/**
 * Optional server-owned semantic-query boundary. It accepts only the already
 * authorized search phrase and can never receive document content or IDs.
 */
export interface FinanceSpecialistEmbeddingQueryPort {
  query(input: {
    readonly query: string;
    readonly abortSignal: AbortSignal;
  }): Promise<readonly number[]>;
}

export interface ProductionFinanceSpecialistDocumentPortDependencies {
  readonly owner: unknown;
  readonly repository: FinanceSpecialistCommittedDocumentRepository;
  readonly embeddingQuery?: FinanceSpecialistEmbeddingQueryPort;
}

const unavailable = (): Error =>
  new Error('api-finance-specialist-document-port-unavailable');

const minimumRank = (
  left: number | null,
  right: number | null,
): number | null =>
  left === null ? right : right === null ? left : Math.min(left, right);

const fallbackRank = (
  rank: number | null,
  reviewedEvidenceOffset: number,
): number | null =>
  rank === null ? null : MAXIMUM_SEARCH_RESULTS + rank + reviewedEvidenceOffset;

const bindScope = (
  owner: FixedOwner,
  rawScope: FinanceCapabilityScope,
): z.output<typeof ScopeSchema> => {
  const scope = ScopeSchema.safeParse(rawScope);
  if (
    !scope.success ||
    scope.data.abortSignal.aborted ||
    scope.data.userId !== owner.userId ||
    scope.data.householdId !== owner.householdId ||
    scope.data.sessionId !== owner.sessionId ||
    scope.data.privateSpaceId !== owner.privateSpaceId ||
    scope.data.spaceAccessGrantId !== owner.spaceAccessGrantId ||
    scope.data.collectionAuthorizationScopeFingerprint !==
      owner.collectionAuthorizationScopeFingerprint
  ) {
    throw unavailable();
  }
  return scope.data;
};

const repositoryPrincipalFor = (owner: FixedOwner) =>
  deepFreeze({
    userId: owner.userId,
    sessionId: owner.sessionId,
    householdId: owner.householdId,
    privateSpaceId: owner.privateSpaceId,
    emailVerified: true as const,
    spaceAccessGrantId: owner.spaceAccessGrantId,
    scopeFingerprint: owner.collectionAuthorizationScopeFingerprint,
  });

const committedMetadata = (value: unknown): Metadata | undefined => {
  const metadata = MetadataSchema.safeParse(value);
  if (
    !metadata.success ||
    metadata.data.state !== 'committed' ||
    metadata.data.deletedAt !== null ||
    metadata.data.documentType === null ||
    metadata.data.sourceLocale === null ||
    metadata.data.extractionRevision === null
  ) {
    return undefined;
  }
  return metadata.data;
};

const boundedText = (
  value: string,
  maximumLength: number,
): string | undefined => {
  const bounded = value.trim().slice(0, maximumLength);
  if (
    bounded.length === 0 ||
    Array.from(bounded).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    return undefined;
  }
  return bounded;
};

const displayNameFor = (metadata: Metadata): string => {
  const name =
    metadata.displayName === null
      ? undefined
      : boundedText(metadata.displayName, 255);
  return name ?? `${metadata.documentType ?? 'finance'} document`;
};

const evidenceFor = (
  evidence: Evidence,
  metadata: Metadata,
  displayName: string,
): PublicEvidence | undefined => {
  if (
    metadata.documentType === null ||
    metadata.sourceLocale === null ||
    evidence.documentId !== metadata.id ||
    evidence.extractionRevision !== metadata.extractionRevision ||
    evidence.sourceLocale !== metadata.sourceLocale
  ) {
    return undefined;
  }
  const excerpt = boundedText(evidence.excerpt, 2_000);
  if (excerpt === undefined) return undefined;
  return deepFreeze({
    evidenceId: evidence.id,
    documentId: metadata.id,
    documentType: metadata.documentType,
    displayName,
    page: evidence.page,
    excerpt,
    sourceLocale: metadata.sourceLocale,
  }) as PublicEvidence;
};

const queryEmbeddingFor = async (
  port: FinanceSpecialistEmbeddingQueryPort | undefined,
  query: string,
  abortSignal: AbortSignal,
): Promise<readonly number[] | null> => {
  if (port === undefined) return null;
  if (abortSignal.aborted) throw unavailable();
  try {
    const result = EmbeddingSchema.safeParse(
      await port.query({ query, abortSignal }),
    );
    return result.success ? result.data : null;
  } catch {
    // Semantic ranking is optional; its failure must not widen the read scope.
    return null;
  }
};

/**
 * Creates the Finance specialist's document-only read port for one already
 * authenticated owner and private space. The caller's scope can select no
 * owner, space, revision, or provider; it is checked against this fixed
 * composition binding before every repository read.
 */
export const createProductionFinanceSpecialistDocumentPort = (
  dependencies: ProductionFinanceSpecialistDocumentPortDependencies,
): FinanceSpecialistDocumentPort => {
  const owner = FixedOwnerSchema.safeParse(dependencies?.owner);
  if (
    !owner.success ||
    typeof dependencies?.repository?.search !== 'function' ||
    typeof dependencies.repository.getMetadata !== 'function' ||
    typeof dependencies.repository.getCommittedProjection !== 'function' ||
    typeof dependencies.repository.listEvidence !== 'function' ||
    typeof dependencies.repository.getEvidenceById !== 'function' ||
    typeof dependencies.repository.listMatches !== 'function' ||
    (dependencies.embeddingQuery !== undefined &&
      typeof dependencies.embeddingQuery.query !== 'function')
  ) {
    throw unavailable();
  }
  const repositoryPrincipal = repositoryPrincipalFor(owner.data);
  const repository = dependencies.repository;
  const embeddingQuery = dependencies.embeddingQuery;

  const getCommittedDocument = async (
    scope: z.output<typeof ScopeSchema>,
    documentId: string,
  ): Promise<CommittedDocument | undefined> => {
    const metadata = committedMetadata(
      await repository.getMetadata({
        principal: repositoryPrincipal,
        requestId: scope.requestId,
        documentId,
      }),
    );
    if (metadata?.id !== documentId) return undefined;
    const projection = CommittedProjectionSchema.safeParse(
      await repository.getCommittedProjection({
        principal: repositoryPrincipal,
        requestId: scope.requestId,
        documentId,
      }),
    );
    if (
      !projection.success ||
      projection.data.id !== metadata.id ||
      projection.data.documentType !== metadata.documentType ||
      projection.data.sourceLocale !== metadata.sourceLocale ||
      projection.data.currency !== metadata.currency ||
      projection.data.extractionRevision !== metadata.extractionRevision
    ) {
      return undefined;
    }
    return deepFreeze({ ...metadata, ...projection.data }) as CommittedDocument;
  };

  const port: FinanceSpecialistDocumentPort = {
    async searchCommitted(rawInput) {
      const request = SearchRequestSchema.safeParse(rawInput);
      if (!request.success) throw unavailable();
      const scope = bindScope(owner.data, request.data.scope);
      const vectorQuery = await queryEmbeddingFor(
        embeddingQuery,
        request.data.query,
        scope.abortSignal,
      );
      if (scope.abortSignal.aborted) throw unavailable();
      const search = SearchResultSchema.safeParse(
        await repository.search({
          principal: repositoryPrincipal,
          requestId: scope.requestId,
          query: request.data.query,
          documentTypes: request.data.documentTypes ?? [],
          currency: null,
          // The repository's structured projection can safely rank an exact
          // display-name match; it never receives inferred finance facts.
          displayName: request.data.query,
          vectorQuery,
          // Date filtering is applied only to committed reviewed projections.
          // Fetching the bounded search maximum first prevents an earlier
          // nonmatching candidate from consuming the caller's result budget.
          limit:
            request.data.from === undefined && request.data.to === undefined
              ? request.data.limit
              : MAXIMUM_SEARCH_RESULTS,
        }),
      );
      if (!search.success) throw unavailable();

      const structuredRanks = new Map<string, number>();
      const documentIds = new Set<string>();
      for (const structured of search.data.structured) {
        documentIds.add(structured.id);
        const prior = structuredRanks.get(structured.id);
        structuredRanks.set(
          structured.id,
          prior === undefined
            ? structured.structuredRank
            : Math.min(prior, structured.structuredRank),
        );
      }
      for (const fullText of search.data.fullText) {
        documentIds.add(fullText.documentId);
      }

      const documents = new Map<string, CommittedDocument>();
      await Promise.all(
        [...documentIds].map(async (documentId) => {
          const metadata = await getCommittedDocument(scope, documentId);
          if (metadata !== undefined) documents.set(documentId, metadata);
        }),
      );
      if (scope.abortSignal.aborted) throw unavailable();

      for (const [documentId, document] of documents) {
        if (
          (request.data.from !== undefined &&
            (document.occurredOn === null ||
              document.occurredOn < request.data.from)) ||
          (request.data.to !== undefined &&
            (document.occurredOn === null ||
              document.occurredOn > request.data.to))
        ) {
          documents.delete(documentId);
        }
      }

      const ranksByChunkId = new Map<
        string,
        Readonly<{ fullTextRank: number | null; vectorRank: number | null }>
      >();
      const ranksByDocumentId = new Map<
        string,
        Readonly<{ fullTextRank: number | null; vectorRank: number | null }>
      >();
      for (const fullText of search.data.fullText) {
        const document = documents.get(fullText.documentId);
        if (
          document === undefined ||
          document.extractionRevision !== fullText.extractionRevision ||
          document.documentType !== fullText.documentType ||
          document.currency !== fullText.currency
        ) {
          continue;
        }
        const previous = ranksByChunkId.get(fullText.id);
        ranksByChunkId.set(
          fullText.id,
          deepFreeze({
            fullTextRank: minimumRank(
              previous?.fullTextRank ?? null,
              fullText.fullTextRank,
            ),
            vectorRank: minimumRank(
              previous?.vectorRank ?? null,
              fullText.vectorRank,
            ),
          }),
        );
        const documentRanks = ranksByDocumentId.get(fullText.documentId);
        ranksByDocumentId.set(
          fullText.documentId,
          deepFreeze({
            fullTextRank: minimumRank(
              documentRanks?.fullTextRank ?? null,
              fullText.fullTextRank,
            ),
            vectorRank: minimumRank(
              documentRanks?.vectorRank ?? null,
              fullText.vectorRank,
            ),
          }),
        );
      }

      const evidenceById = new Map<string, Evidence>();
      const reviewedEvidenceOffsetById = new Map<string, number>();
      await Promise.all(
        [...documents.values()].map(async (document) => {
          const result = z.array(EvidenceSchema).safeParse(
            await repository.listEvidence({
              principal: repositoryPrincipal,
              requestId: scope.requestId,
              documentId: document.id,
              limit: MAXIMUM_EVIDENCE_PER_SEARCH_DOCUMENT,
            }),
          );
          if (
            !result.success ||
            result.data.length > MAXIMUM_EVIDENCE_PER_SEARCH_DOCUMENT
          ) {
            throw unavailable();
          }
          for (const [
            reviewedEvidenceOffset,
            evidence,
          ] of result.data.entries()) {
            if (
              evidence.documentId !== document.id ||
              evidence.extractionRevision !== document.extractionRevision ||
              evidence.sourceLocale !== document.sourceLocale ||
              evidenceById.has(evidence.id) ||
              reviewedEvidenceOffsetById.has(evidence.id)
            ) {
              throw unavailable();
            }
            evidenceById.set(evidence.id, evidence);
            reviewedEvidenceOffsetById.set(evidence.id, reviewedEvidenceOffset);
          }
        }),
      );
      if (scope.abortSignal.aborted) throw unavailable();

      const evidenceDocumentIds = new Set(
        [...evidenceById.values()].map((evidence) => evidence.documentId),
      );
      const rankedDocuments = fuseFinanceEvidenceRanks({
        candidates: [...documents.values()]
          .filter((document) => evidenceDocumentIds.has(document.id))
          .map((document) => {
            const documentRanks = ranksByDocumentId.get(document.id);
            return {
              evidenceId: document.id,
              structuredRank: structuredRanks.get(document.id) ?? null,
              fullTextRank: documentRanks?.fullTextRank ?? null,
              vectorRank: documentRanks?.vectorRank ?? null,
            };
          }),
        limit: request.data.limit,
      });
      const selectedDocuments = new Map(
        rankedDocuments.flatMap((rank) => {
          const document = documents.get(rank.evidenceId);
          return document === undefined
            ? []
            : [[document.id, document] as const];
        }),
      );

      return deepFreeze(
        rankedDocuments
          .flatMap((documentRank) => {
            const document = selectedDocuments.get(documentRank.evidenceId);
            if (document === undefined || document.documentType === null) {
              throw unavailable();
            }
            const rankedEvidence = fuseFinanceEvidenceRanks({
              candidates: [...evidenceById.values()]
                .filter((evidence) => evidence.documentId === document.id)
                .map((evidence) => {
                  const reviewedEvidenceOffset = reviewedEvidenceOffsetById.get(
                    evidence.id,
                  );
                  if (reviewedEvidenceOffset === undefined) {
                    throw unavailable();
                  }
                  const chunkRanks =
                    evidence.chunkId === null
                      ? undefined
                      : ranksByChunkId.get(evidence.chunkId);
                  const documentRanks = ranksByDocumentId.get(
                    evidence.documentId,
                  );
                  return {
                    evidenceId: evidence.id,
                    structuredRank:
                      structuredRanks.get(evidence.documentId) ?? null,
                    fullTextRank:
                      chunkRanks?.fullTextRank ??
                      fallbackRank(
                        documentRanks?.fullTextRank ?? null,
                        reviewedEvidenceOffset,
                      ),
                    vectorRank:
                      chunkRanks?.vectorRank ??
                      fallbackRank(
                        documentRanks?.vectorRank ?? null,
                        reviewedEvidenceOffset,
                      ),
                  };
                }),
              limit: MAXIMUM_EVIDENCE_PER_SEARCH_HIT,
            });
            const publicEvidence = rankedEvidence.map((rank) => {
              const evidence = evidenceById.get(rank.evidenceId);
              if (evidence === undefined) throw unavailable();
              const result = evidenceFor(
                evidence,
                document,
                displayNameFor(document),
              );
              if (result === undefined) throw unavailable();
              return result;
            });
            if (publicEvidence.length === 0) return [];
            return {
              documentId: document.id,
              documentType: document.documentType,
              displayName: displayNameFor(document),
              occurredOn: document.occurredOn,
              currency: document.currency,
              amountMinor: document.amountMinor,
              score: documentRank.scoreMillionths / 1_000_000,
              evidence: publicEvidence,
            };
          })
          .sort(
            (left, right) =>
              right.score - left.score ||
              left.documentId.localeCompare(right.documentId),
          )
          .slice(0, request.data.limit),
      ) as Awaited<
        ReturnType<FinanceSpecialistDocumentPort['searchCommitted']>
      >;
    },

    async readCommitted(rawInput) {
      const request = ReadRequestSchema.safeParse(rawInput);
      if (!request.success) throw unavailable();
      const scope = bindScope(owner.data, request.data.scope);
      if (
        new Set(request.data.evidenceIds).size !==
        request.data.evidenceIds.length
      ) {
        throw unavailable();
      }
      const document = await getCommittedDocument(
        scope,
        request.data.documentId,
      );
      if (document === undefined) return undefined;
      const displayName = displayNameFor(document);
      const requested = await Promise.all(
        request.data.evidenceIds.map(async (evidenceId) => {
          const result = EvidenceSchema.safeParse(
            await repository.getEvidenceById({
              principal: repositoryPrincipal,
              requestId: scope.requestId,
              evidenceId,
            }),
          );
          if (!result.success) return undefined;
          return evidenceFor(result.data, document, displayName);
        }),
      );
      if (
        scope.abortSignal.aborted ||
        requested.some((evidence) => evidence === undefined)
      ) {
        return undefined;
      }
      if (document.documentType === null || document.sourceLocale === null) {
        return undefined;
      }
      const exactEvidence = requested as PublicEvidence[];
      return deepFreeze({
        document: {
          id: document.id,
          documentType: document.documentType,
          displayName,
          sourceLocale: document.sourceLocale,
          currency: document.currency,
          summary:
            request.data.evidenceIds.length === 0
              ? `Committed ${document.documentType} document.`
              : `Committed ${document.documentType} document with ${request.data.evidenceIds.length} requested reviewed evidence excerpt${request.data.evidenceIds.length === 1 ? '' : 's'}.`,
          committedAt: document.committedAt,
        },
        evidence: exactEvidence,
      }) as PublicReadResult;
    },

    async listCommittedMatches(rawInput) {
      const request = MatchesRequestSchema.safeParse(rawInput);
      if (!request.success) throw unavailable();
      const scope = bindScope(owner.data, request.data.scope);
      const document = await getCommittedDocument(
        scope,
        request.data.documentId,
      );
      if (document === undefined) return deepFreeze([]);
      const results = z.array(MatchSchema).safeParse(
        await repository.listMatches({
          principal: repositoryPrincipal,
          requestId: scope.requestId,
          documentId: document.id,
          states: request.data.states ?? [],
          limit: request.data.limit,
        }),
      );
      if (
        !results.success ||
        results.data.length > request.data.limit ||
        scope.abortSignal.aborted
      ) {
        throw unavailable();
      }
      const matches: PublicMatch[] = results.data.map((match) => {
        if (
          match.documentId !== document.id ||
          match.extractionRevision !== document.extractionRevision ||
          (request.data.states !== undefined &&
            !request.data.states.includes(match.state))
        ) {
          throw unavailable();
        }
        const reasons = match.reasons.map((reason) => boundedText(reason, 200));
        if (reasons.some((reason) => reason === undefined)) throw unavailable();
        return {
          matchId: match.id,
          documentId: match.documentId,
          recordId: match.recordId,
          recordType: match.recordType,
          state: match.state,
          score: match.scoreBasisPoints / 10_000,
          reasons: reasons as string[],
        } as PublicMatch;
      });
      return deepFreeze(matches) as Awaited<
        ReturnType<FinanceSpecialistDocumentPort['listCommittedMatches']>
      >;
    },
  };

  return Object.freeze(port);
};

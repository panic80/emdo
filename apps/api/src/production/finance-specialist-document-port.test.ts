import { describe, expect, it, vi } from 'vitest';

import type { FinanceCapabilityScope } from './finance-agent-services.js';
import {
  createProductionFinanceSpecialistDocumentPort,
  type FinanceSpecialistCommittedDocumentRepository,
} from './finance-specialist-document-port.js';

const ids = Object.freeze({
  request: '72000000-0000-4000-8000-000000000001',
  run: '72000000-0000-4000-8000-000000000002',
  user: '72000000-0000-4000-8000-000000000003',
  household: '72000000-0000-4000-8000-000000000004',
  session: '72000000-0000-4000-8000-000000000005',
  privateSpace: '72000000-0000-4000-8000-000000000006',
  spaceGrant: '72000000-0000-4000-8000-000000000007',
  document: '72000000-0000-4000-8000-000000000008',
  chunk: '72000000-0000-4000-8000-000000000009',
  evidenceOne: '72000000-0000-4000-8000-000000000010',
  evidenceTwo: '72000000-0000-4000-8000-000000000011',
  match: '72000000-0000-4000-8000-000000000012',
  summaryChunk: '72000000-0000-4000-8000-000000000013',
  documentTwo: '72000000-0000-4000-8000-000000000014',
  summaryChunkTwo: '72000000-0000-4000-8000-000000000015',
  exactEvidence: '72000000-0000-4000-8000-000000000099',
});

const owner = Object.freeze({
  userId: ids.user,
  sessionId: ids.session,
  householdId: ids.household,
  privateSpaceId: ids.privateSpace,
  role: 'owner' as const,
  emailVerified: true as const,
  spaceAccessGrantId: ids.spaceGrant,
  collectionAuthorizationScopeFingerprint: 'a'.repeat(64),
});

const scope = Object.freeze({
  requestId: ids.request,
  runId: ids.run,
  userId: ids.user,
  householdId: ids.household,
  sessionId: ids.session,
  privateSpaceId: ids.privateSpace,
  spaceAccessGrantId: ids.spaceGrant,
  collectionAuthorizationScopeFingerprint: 'a'.repeat(64),
  abortSignal: new AbortController().signal,
} satisfies FinanceCapabilityScope);

const document = Object.freeze({
  id: ids.document,
  state: 'committed' as 'committed' | 'awaiting-review',
  displayName: 'Example Market receipt',
  documentType: 'receipt' as const,
  sourceLocale: 'en-CA' as const,
  currency: 'CAD' as string,
  extractionRevision: 2,
  updatedAt: '2026-08-26T12:00:00.000Z',
  deletedAt: null,
});

const committedProjection = Object.freeze({
  id: ids.document,
  documentType: 'receipt' as const,
  sourceLocale: 'en-CA' as const,
  currency: 'CAD' as string,
  extractionRevision: 2,
  occurredOn: '2026-08-24',
  amountMinor: 1299 as number,
  committedAt: '2026-08-26T11:59:00.000Z',
});

const evidence = Object.freeze([
  {
    id: ids.evidenceOne,
    documentId: ids.document,
    extractionRevision: 2,
    chunkId: ids.chunk,
    page: 1,
    excerpt: `Example Market ${'x'.repeat(2_100)}`,
    sourceLocale: 'en-CA' as const,
  },
  {
    id: ids.evidenceTwo,
    documentId: ids.document,
    extractionRevision: 2,
    chunkId: null,
    page: 2,
    excerpt: 'Receipt total: 12.99 CAD',
    sourceLocale: 'en-CA' as const,
  },
]);

const createRepository = () => {
  const repository = {
    search: vi.fn<FinanceSpecialistCommittedDocumentRepository['search']>(
      async () => ({
        structured: [{ ...document, structuredRank: 1 }],
        fullText: [
          {
            id: ids.chunk,
            documentId: ids.document,
            extractionRevision: 2,
            documentType: 'receipt',
            currency: 'CAD' as string,
            pageStart: 1,
            pageEnd: 1,
            fullTextRank: 1 as number | null,
            vectorRank: 1 as number | null,
          },
        ],
      }),
    ),
    getMetadata: vi.fn<
      FinanceSpecialistCommittedDocumentRepository['getMetadata']
    >(async () => document),
    getCommittedProjection: vi.fn<
      FinanceSpecialistCommittedDocumentRepository['getCommittedProjection']
    >(async () => committedProjection),
    listEvidence: vi.fn<
      FinanceSpecialistCommittedDocumentRepository['listEvidence']
    >(async () => evidence),
    getEvidenceById: vi.fn(async (input: { evidenceId: string }) =>
      evidence.find((item) => item.id === input.evidenceId),
    ),
    listMatches: vi.fn(async () => [
      {
        id: ids.match,
        documentId: ids.document,
        extractionRevision: 2,
        recordType: 'transaction',
        recordId: 'transaction-1',
        scoreBasisPoints: 9_800,
        reasons: ['currency-exact', 'amount-exact'],
        state: 'suggested',
      },
    ]),
  } satisfies FinanceSpecialistCommittedDocumentRepository;
  return repository;
};

describe('createProductionFinanceSpecialistDocumentPort', () => {
  it('fuses server-ranked committed evidence and never returns unbounded chunk content', async () => {
    const repository = createRepository();
    const embeddingQuery = {
      query: vi.fn(async () => Array.from({ length: 1_536 }, () => 0)),
    };
    const port = createProductionFinanceSpecialistDocumentPort({
      owner,
      repository,
      embeddingQuery,
    });

    const hits = await port.searchCommitted({
      scope,
      query: 'Example Market',
      limit: 10,
    });

    expect(embeddingQuery.query).toHaveBeenCalledWith({
      query: 'Example Market',
      abortSignal: scope.abortSignal,
    });
    expect(repository.search).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: {
          userId: ids.user,
          sessionId: ids.session,
          householdId: ids.household,
          privateSpaceId: ids.privateSpace,
          emailVerified: true,
          spaceAccessGrantId: ids.spaceGrant,
          scopeFingerprint: 'a'.repeat(64),
        },
        requestId: ids.request,
        query: 'Example Market',
        documentTypes: [],
        currency: null,
        displayName: 'Example Market',
        limit: 10,
      }),
    );
    expect(repository.listEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: ids.document,
        limit: 32,
      }),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      documentId: ids.document,
      documentType: 'receipt',
      occurredOn: '2026-08-24',
      currency: 'CAD',
      amountMinor: 1299,
    });
    expect(hits[0]!.evidence).toHaveLength(2);
    expect(hits[0]!.evidence[0]!.excerpt).toHaveLength(2_000);
    expect(hits[0]!.score).toBeGreaterThan(0);
  });

  it('preserves a semantic-only candidate when lexical rank is absent', async () => {
    const repository = createRepository();
    repository.search.mockResolvedValueOnce({
      structured: [],
      fullText: [
        {
          id: ids.chunk,
          documentId: ids.document,
          extractionRevision: 2,
          documentType: 'receipt',
          currency: 'CAD',
          pageStart: 1,
          pageEnd: 1,
          fullTextRank: null,
          vectorRank: 1,
        },
      ],
    });
    const port = createProductionFinanceSpecialistDocumentPort({
      owner,
      repository,
      embeddingQuery: {
        query: vi.fn(async () => Array.from({ length: 1_536 }, () => 0)),
      },
    });

    await expect(
      port.searchCommitted({
        scope,
        query: 'vegetables',
        limit: 1,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        documentId: ids.document,
        evidence: expect.arrayContaining([
          expect.objectContaining({ evidenceId: ids.evidenceOne }),
        ]),
      }),
    ]);
  });

  it('uses same-document search ranks when a matched summary chunk has no evidence', async () => {
    const repository = createRepository();
    repository.search.mockResolvedValueOnce({
      structured: [],
      fullText: [
        {
          id: ids.summaryChunk,
          documentId: ids.document,
          extractionRevision: 2,
          documentType: 'receipt',
          currency: 'CAD',
          pageStart: 1,
          pageEnd: 1,
          fullTextRank: 1,
          vectorRank: null,
        },
      ],
    });
    const port = createProductionFinanceSpecialistDocumentPort({
      owner,
      repository,
    });

    await expect(
      port.searchCommitted({
        scope,
        query: 'Example Market issuer',
        limit: 1,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        documentId: ids.document,
        evidence: [
          expect.objectContaining({ evidenceId: ids.evidenceOne }),
          expect.objectContaining({ evidenceId: ids.evidenceTwo }),
        ],
      }),
    ]);
  });

  it('keeps reviewed evidence order when document-level fallback ranks tie', async () => {
    const repository = createRepository();
    const marker = {
      ...evidence[0],
      id: ids.exactEvidence,
      chunkId: null,
      excerpt: 'Cobalt Lantern Receipt',
    };
    const fallbackEvidence = Array.from({ length: 12 }, (_entry, index) => ({
      ...evidence[0],
      id: `72000000-0000-4000-8000-${String(index + 20).padStart(12, '0')}`,
      chunkId: null,
      excerpt: `Fallback evidence ${index}`,
    }));
    repository.search.mockResolvedValueOnce({
      structured: [],
      fullText: [
        {
          id: ids.summaryChunk,
          documentId: ids.document,
          extractionRevision: 2,
          documentType: 'receipt',
          currency: 'CAD',
          pageStart: 1,
          pageEnd: 1,
          fullTextRank: 1,
          vectorRank: null,
        },
      ],
    });
    repository.listEvidence.mockResolvedValueOnce([
      marker,
      ...fallbackEvidence,
    ]);
    const port = createProductionFinanceSpecialistDocumentPort({
      owner,
      repository,
    });

    const hits = await port.searchCommitted({
      scope,
      query: 'Boreal Quasar Ledger',
      limit: 1,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.evidence).toHaveLength(8);
    expect(hits[0]?.evidence[0]).toMatchObject({
      evidenceId: ids.exactEvidence,
      excerpt: 'Cobalt Lantern Receipt',
    });
  });

  it('selects matching documents before bounded evidence and prioritizes exact chunk ranks', async () => {
    const repository = createRepository();
    const secondDocument = {
      ...document,
      id: ids.documentTwo,
      displayName: 'Second Market receipt',
    };
    const secondProjection = {
      ...committedProjection,
      id: ids.documentTwo,
    };
    const fallbackEvidence = Array.from({ length: 17 }, (_, index) => ({
      ...evidence[0],
      id: `72000000-0000-4000-8000-${String(index + 20).padStart(12, '0')}`,
      chunkId: null,
    }));
    const exactEvidence = {
      ...evidence[0],
      id: ids.exactEvidence,
      chunkId: ids.chunk,
    };
    const secondEvidence = [
      {
        ...evidence[1],
        documentId: ids.documentTwo,
      },
    ];
    repository.search.mockResolvedValueOnce({
      structured: [],
      fullText: [
        {
          id: ids.summaryChunk,
          documentId: ids.document,
          extractionRevision: 2,
          documentType: 'receipt',
          currency: 'CAD',
          pageStart: 1,
          pageEnd: 1,
          fullTextRank: 1,
          vectorRank: null,
        },
        {
          id: ids.chunk,
          documentId: ids.document,
          extractionRevision: 2,
          documentType: 'receipt',
          currency: 'CAD',
          pageStart: 1,
          pageEnd: 1,
          fullTextRank: 25,
          vectorRank: null,
        },
        {
          id: ids.summaryChunkTwo,
          documentId: ids.documentTwo,
          extractionRevision: 2,
          documentType: 'receipt',
          currency: 'CAD',
          pageStart: 1,
          pageEnd: 1,
          fullTextRank: 2,
          vectorRank: null,
        },
      ],
    });
    repository.getMetadata.mockImplementation(async ({ documentId }) =>
      documentId === ids.document
        ? document
        : documentId === ids.documentTwo
          ? secondDocument
          : undefined,
    );
    repository.getCommittedProjection.mockImplementation(
      async ({ documentId }) =>
        documentId === ids.document
          ? committedProjection
          : documentId === ids.documentTwo
            ? secondProjection
            : undefined,
    );
    repository.listEvidence.mockImplementation(async ({ documentId }) =>
      documentId === ids.document
        ? [...fallbackEvidence, exactEvidence]
        : documentId === ids.documentTwo
          ? secondEvidence
          : [],
    );
    const port = createProductionFinanceSpecialistDocumentPort({
      owner,
      repository,
    });

    const hits = await port.searchCommitted({
      scope,
      query: 'Market',
      limit: 2,
    });

    expect(hits.map((hit) => hit.documentId)).toEqual([
      ids.document,
      ids.documentTwo,
    ]);
    expect(hits[0]?.evidence).toHaveLength(8);
    expect(hits[1]?.evidence).toHaveLength(1);
    expect(hits[0]?.evidence[0]).toMatchObject({
      evidenceId: ids.exactEvidence,
    });
  });

  it('does not let an uncitable document consume the document result limit', async () => {
    const repository = createRepository();
    const secondDocument = {
      ...document,
      id: ids.documentTwo,
      displayName: 'Second Market receipt',
    };
    const secondProjection = {
      ...committedProjection,
      id: ids.documentTwo,
    };
    repository.search.mockResolvedValueOnce({
      structured: [],
      fullText: [
        {
          id: ids.summaryChunk,
          documentId: ids.document,
          extractionRevision: 2,
          documentType: 'receipt',
          currency: 'CAD',
          pageStart: 1,
          pageEnd: 1,
          fullTextRank: 1,
          vectorRank: null,
        },
        {
          id: ids.summaryChunkTwo,
          documentId: ids.documentTwo,
          extractionRevision: 2,
          documentType: 'receipt',
          currency: 'CAD',
          pageStart: 1,
          pageEnd: 1,
          fullTextRank: 2,
          vectorRank: null,
        },
      ],
    });
    repository.getMetadata.mockImplementation(async ({ documentId }) =>
      documentId === ids.document
        ? document
        : documentId === ids.documentTwo
          ? secondDocument
          : undefined,
    );
    repository.getCommittedProjection.mockImplementation(
      async ({ documentId }) =>
        documentId === ids.document
          ? committedProjection
          : documentId === ids.documentTwo
            ? secondProjection
            : undefined,
    );
    repository.listEvidence.mockImplementation(async ({ documentId }) =>
      documentId === ids.document
        ? []
        : documentId === ids.documentTwo
          ? [{ ...evidence[0], documentId: ids.documentTwo }]
          : [],
    );
    const port = createProductionFinanceSpecialistDocumentPort({
      owner,
      repository,
    });

    await expect(
      port.searchCommitted({
        scope,
        query: 'Market',
        limit: 1,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ documentId: ids.documentTwo }),
    ]);
  });

  it('reads only the exact committed evidence IDs requested for the document', async () => {
    const repository = createRepository();
    const port = createProductionFinanceSpecialistDocumentPort({
      owner,
      repository,
    });

    const result = await port.readCommitted({
      scope,
      documentId: ids.document,
      evidenceIds: [ids.evidenceTwo, ids.evidenceOne],
    });

    expect(result).toMatchObject({
      document: {
        id: ids.document,
        documentType: 'receipt',
        sourceLocale: 'en-CA',
        committedAt: '2026-08-26T11:59:00.000Z',
      },
    });
    expect(result?.evidence.map((item) => item.evidenceId)).toEqual([
      ids.evidenceTwo,
      ids.evidenceOne,
    ]);
    expect(repository.getEvidenceById).toHaveBeenCalledTimes(2);
    expect(
      repository.getEvidenceById.mock.calls.map(([input]) => input.evidenceId),
    ).toEqual([ids.evidenceTwo, ids.evidenceOne]);
  });

  it('fails closed when scope binding, requested evidence, or committed state is invalid', async () => {
    const repository = createRepository();
    const port = createProductionFinanceSpecialistDocumentPort({
      owner,
      repository,
    });

    await expect(
      port.searchCommitted({
        scope: { ...scope, privateSpaceId: ids.document },
        query: 'Example Market',
        limit: 10,
      }),
    ).rejects.toThrow('api-finance-specialist-document-port-unavailable');
    await expect(
      port.readCommitted({
        scope,
        documentId: ids.document,
        evidenceIds: ['72000000-0000-4000-8000-000000000099'],
      }),
    ).resolves.toBeUndefined();

    repository.getMetadata.mockResolvedValueOnce({
      ...document,
      state: 'awaiting-review',
    });
    await expect(
      port.listCommittedMatches({
        scope,
        documentId: ids.document,
        limit: 10,
      }),
    ).resolves.toEqual([]);
    expect(repository.listMatches).not.toHaveBeenCalled();
  });

  it('returns only committed, current-revision matches with bounded scores', async () => {
    const repository = createRepository();
    const port = createProductionFinanceSpecialistDocumentPort({
      owner,
      repository,
    });

    await expect(
      port.listCommittedMatches({
        scope,
        documentId: ids.document,
        states: ['suggested'],
        limit: 10,
      }),
    ).resolves.toEqual([
      {
        matchId: ids.match,
        documentId: ids.document,
        recordId: 'transaction-1',
        recordType: 'transaction',
        state: 'suggested',
        score: 0.98,
        reasons: ['currency-exact', 'amount-exact'],
      },
    ]);
  });

  it('filters by reviewed occurrence date with a bounded candidate query', async () => {
    const repository = createRepository();
    const port = createProductionFinanceSpecialistDocumentPort({
      owner,
      repository,
    });

    await expect(
      port.searchCommitted({
        scope,
        query: 'Example Market',
        from: '2026-08-24',
        to: '2026-08-24',
        limit: 1,
      }),
    ).resolves.toHaveLength(1);
    expect(repository.search).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 25 }),
    );

    const outsideRepository = createRepository();
    const outsidePort = createProductionFinanceSpecialistDocumentPort({
      owner,
      repository: outsideRepository,
    });
    await expect(
      outsidePort.searchCommitted({
        scope,
        query: 'Example Market',
        from: '2026-08-25',
        limit: 1,
      }),
    ).resolves.toEqual([]);
    expect(outsideRepository.listEvidence).not.toHaveBeenCalled();
  });

  it('keeps committed non-CAD facts searchable and explicitly labelled by currency', async () => {
    const repository = createRepository();
    repository.search.mockResolvedValueOnce({
      structured: [{ ...document, currency: 'USD', structuredRank: 1 }],
      fullText: [
        {
          id: ids.chunk,
          documentId: ids.document,
          extractionRevision: 2,
          documentType: 'receipt',
          currency: 'USD',
          pageStart: 1,
          pageEnd: 1,
          fullTextRank: 1,
          vectorRank: null,
        },
      ],
    });
    repository.getMetadata.mockResolvedValueOnce({
      ...document,
      currency: 'USD',
    });
    repository.getCommittedProjection.mockResolvedValueOnce({
      ...committedProjection,
      currency: 'USD',
      amountMinor: 1599,
    });
    const port = createProductionFinanceSpecialistDocumentPort({
      owner,
      repository,
    });

    await expect(
      port.searchCommitted({
        scope,
        query: 'Example Market',
        limit: 1,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ currency: 'USD', amountMinor: 1599 }),
    ]);
  });
});

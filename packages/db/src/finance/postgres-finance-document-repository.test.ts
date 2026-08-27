import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import {
  FinanceDocumentRepositoryError,
  PostgresFinanceDocumentRepository,
} from './postgres-finance-document-repository.js';

const ids = {
  user: 'c3000000-0000-4000-8000-000000000001',
  otherUser: 'c3000000-0000-4000-8000-000000000002',
  session: 'c3000000-0000-4000-8000-000000000003',
  household: 'c3000000-0000-4000-8000-000000000004',
  space: 'c3000000-0000-4000-8000-000000000005',
  grant: 'c3000000-0000-4000-8000-000000000006',
  request: 'c3000000-0000-4000-8000-000000000007',
  document: 'c3000000-0000-4000-8000-000000000008',
  nextDocument: 'c3000000-0000-4000-8000-000000000009',
  extraction: 'c3000000-0000-4000-8000-000000000010',
  nextExtraction: 'c3000000-0000-4000-8000-000000000011',
  review: 'c3000000-0000-4000-8000-000000000012',
  chunk: 'c3000000-0000-4000-8000-000000000013',
  evidence: 'c3000000-0000-4000-8000-000000000014',
  match: 'c3000000-0000-4000-8000-000000000015',
} as const;

const principal = {
  userId: ids.user,
  sessionId: ids.session,
  householdId: ids.household,
  privateSpaceId: ids.space,
  emailVerified: true as const,
  spaceAccessGrantId: ids.grant,
  scopeFingerprint: 'f'.repeat(64),
};

const sha256 = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex');
const vector = (seed: number): readonly number[] =>
  Object.freeze(Array.from({ length: 1_536 }, () => seed));

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
};

const storage = {
  storageObjectId: 'finance-document-object-0001',
  displayName: 'August receipt.pdf',
  mimeType: 'application/pdf' as const,
  byteSize: 1024,
  pageCount: 1,
  imageWidth: null,
  imageHeight: null,
  plaintextSha256: 'a'.repeat(64),
  ciphertextSha256: 'b'.repeat(64),
  wrappedDataKey: {
    algorithm: 'aes-256-gcm' as const,
    wrappedKey: 'wrapped-key',
    nonce: 'nonce',
    authenticationTag: 'tag',
    aadVersion: 1 as const,
  },
  keyVersion: 'finance-document-test-v1',
};

const documentRow = (overrides: Record<string, unknown> = {}) => ({
  id: ids.document,
  state: 'uploaded',
  displayName: storage.displayName,
  mimeType: storage.mimeType,
  byteSize: storage.byteSize,
  pageCount: storage.pageCount,
  imageWidth: storage.imageWidth,
  imageHeight: storage.imageHeight,
  plaintextSha256: storage.plaintextSha256,
  ciphertextSha256: storage.ciphertextSha256,
  wrappedDataKey: storage.wrappedDataKey,
  keyVersion: storage.keyVersion,
  storageObjectId: storage.storageObjectId,
  documentType: null,
  sourceLocale: null,
  currency: null,
  extractionRevision: null,
  createdAt: new Date('2026-08-26T12:00:00.000Z'),
  updatedAt: new Date('2026-08-26T12:00:00.000Z'),
  deletedAt: null,
  deletionProposalId: null,
  deletionDecisionId: null,
  deletionTargetBindingHash: null,
  deletionExecutionBindingHash: null,
  ...overrides,
});

const payload = (currency: string | null = 'CAD') => ({
  documentType: 'receipt' as const,
  sourceLocale: 'en-CA' as const,
  currency,
  chunks: [
    {
      ordinal: 0,
      pageStart: 1,
      pageEnd: 1,
      content: 'Reviewed groceries receipt total',
      embedding: null,
    },
  ],
  evidence: [
    {
      chunkOrdinal: 0,
      page: 1,
      excerpt: 'groceries receipt total',
      locator: { characterStart: 0, characterEnd: 23 },
      sourceLocale: 'en-CA' as const,
    },
  ],
  matchSuggestions: [],
});

const committedReviewedPayload = (
  input: {
    readonly currency?: 'CAD' | 'USD';
    readonly purchasedOn?: string | null;
    readonly totalMinor?: number;
  } = {},
) => {
  const currency = input.currency ?? 'CAD';
  const envelope = {
    schemaVersion: 1 as const,
    documentType: 'receipt' as const,
    sourceLocale: 'en-CA' as const,
    currency,
    issuer: null,
    recipient: null,
    issuedOn: null,
    dueOn: null,
    periodStart: null,
    periodEnd: null,
    subtotal: null,
    tax: null,
    total: { currency, minorUnits: input.totalMinor ?? 1299 },
    accountLast4: null,
    facts: [],
    merchant: 'Example Market',
    purchasedOn: input.purchasedOn ?? '2026-08-24',
    tip: null,
    paymentMethodLast4: null,
    lineItems: [],
    proposedRecord: {
      kind: 'expense' as const,
      amount: { currency, minorUnits: input.totalMinor ?? 1299 },
      occurredOn: input.purchasedOn ?? '2026-08-24',
      description: 'Example Market',
    },
  };
  const encoded = Buffer.from(stableJson(envelope), 'utf8').toString(
    'base64url',
  );
  return {
    documentType: envelope.documentType,
    sourceLocale: envelope.sourceLocale,
    currency: envelope.currency,
    chunks: [
      {
        ordinal: 0,
        pageStart: 1,
        pageEnd: 1,
        content: `emdo.finance-document.review-envelope.v1:1/1:${encoded}`,
        embedding: null,
      },
    ],
    evidence: [],
    matchSuggestions: [],
  };
};

const committedProjectionRow = (overrides: Record<string, unknown> = {}) => ({
  id: ids.document,
  documentType: 'receipt',
  sourceLocale: 'en-CA',
  currency: 'CAD',
  extractionRevision: 1,
  selectedFacts: committedReviewedPayload(),
  committedAt: new Date('2026-08-26T12:01:00.000Z'),
  ...overrides,
});

const reviewRow = (
  currency: string | null = 'CAD',
  input: Readonly<{
    selectedFacts?: ReturnType<typeof payload>;
    state?: 'pending' | 'committed' | 'rejected' | 'expired' | 'invalidated';
  }> = {},
) => {
  const selectedFacts = input.selectedFacts ?? payload(currency);
  return {
    id: ids.review,
    documentId: ids.document,
    extractionRevision: 1,
    authenticatedSessionId: ids.session,
    spaceAccessGrantId: ids.grant,
    scopeFingerprint: principal.scopeFingerprint,
    payloadHash: sha256(stableJson(selectedFacts)),
    reviewTokenHash: sha256('A'.repeat(43)),
    selectedFacts,
    state: input.state ?? 'committed',
    idempotencyKey: 'finance-document-review-key-0001',
    expiresAt: new Date('2026-08-26T12:30:00.000Z'),
  };
};

type Respond = (
  sql: string,
  values: readonly unknown[],
) =>
  | readonly Record<string, unknown>[]
  | Readonly<{
      rows: readonly Record<string, unknown>[];
      rowCount?: number | null;
    }>
  | Promise<
      | readonly Record<string, unknown>[]
      | Readonly<{
          rows: readonly Record<string, unknown>[];
          rowCount?: number | null;
        }>
    >;

const poolFor = (respond: Respond) => {
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    const response = await respond(sql, values);
    if (
      typeof response === 'object' &&
      response !== null &&
      !Array.isArray(response) &&
      'rows' in response
    ) {
      return {
        rows: response.rows,
        rowCount: response.rowCount ?? response.rows.length,
      };
    }
    return { rows: response, rowCount: response.length };
  });
  const release = vi.fn();
  const client: DatabaseClient = { query, release };
  const pool: DatabasePool = { connect: vi.fn(async () => client) };
  return { pool, query, release };
};

const lockRows = (
  sql: string,
): readonly Record<string, unknown>[] | undefined =>
  sql.includes('lock_active_request_scope')
    ? [{ authorized: true }]
    : undefined;

describe('PostgresFinanceDocumentRepository', () => {
  it('validates server-owned scope input and installs exact durable claims before readiness', async () => {
    const { pool, query } = poolFor((sql) => {
      const lock = lockRows(sql);
      if (lock !== undefined) return lock;
      if (sql.includes('finance_documents_ready')) return [{ ready: true }];
      return [];
    });
    const repository = new PostgresFinanceDocumentRepository(pool);

    await expect(repository.checkInfrastructureReady()).resolves.toBe(true);
    await expect(
      repository.checkReady({ requestId: ids.request }),
    ).rejects.toMatchObject({
      code: 'invalid-input',
    });
    await expect(
      repository.checkReady({ principal, requestId: ids.request }),
    ).resolves.toBe(true);

    const claims = query.mock.calls.find(([sql]) =>
      String(sql).includes("set_config('emdo.user_id'"),
    );
    expect(claims?.[1]).toEqual([ids.user, ids.session, ids.request]);
    const scope = query.mock.calls.find(([sql]) =>
      String(sql).includes('lock_active_request_scope'),
    );
    expect(scope?.[1]).toEqual([ids.household, ids.space, null]);
  });

  it('uses explicit household, private-space, and original-owner predicates for metadata reads', async () => {
    const { pool, query } = poolFor((sql) => {
      const lock = lockRows(sql);
      if (lock !== undefined) return lock;
      if (sql.includes('from emdo.finance_documents')) return [documentRow()];
      return [];
    });
    const repository = new PostgresFinanceDocumentRepository(pool);

    await expect(
      repository.getMetadata({
        principal,
        requestId: ids.request,
        documentId: ids.document,
      }),
    ).resolves.toMatchObject({
      id: ids.document,
      displayName: storage.displayName,
    });

    const financeQueries = query.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => sql.includes('emdo.finance_'));
    expect(financeQueries).toHaveLength(1);
    expect(financeQueries[0]).toContain('document.household_id = $1');
    expect(financeQueries[0]).toContain('document.space_id = $2');
    expect(financeQueries[0]).toContain('document.original_owner_user_id = $3');
    expect(financeQueries[0]).not.toContain(ids.user);
  });

  it('projects only the current committed reviewed envelope with its decision timestamp', async () => {
    const { pool, query } = poolFor((sql) => {
      const lock = lockRows(sql);
      if (lock !== undefined) return lock;
      if (
        sql.includes('join emdo.finance_document_review_batches as review') &&
        sql.includes('review.selected_facts as "selectedFacts"')
      ) {
        return [committedProjectionRow()];
      }
      return [];
    });
    const repository = new PostgresFinanceDocumentRepository(pool);

    await expect(
      repository.getCommittedProjection({
        principal,
        requestId: ids.request,
        documentId: ids.document,
      }),
    ).resolves.toEqual({
      id: ids.document,
      documentType: 'receipt',
      sourceLocale: 'en-CA',
      currency: 'CAD',
      currencyLabel: 'cad',
      extractionRevision: 1,
      occurredOn: '2026-08-24',
      amountMinor: 1299,
      committedAt: '2026-08-26T12:01:00.000Z',
    });

    const projectionCall = query.mock.calls.find(([sql]) =>
      String(sql).includes('review.selected_facts as "selectedFacts"'),
    );
    expect(projectionCall?.[1]).toEqual([
      ids.household,
      ids.space,
      ids.user,
      ids.document,
    ]);
    const projectionSql = String(projectionCall?.[0]);
    expect(projectionSql).toContain("document.state = 'committed'");
    expect(projectionSql).toContain("review.state = 'committed'");
    expect(projectionSql).toContain(
      'review.extraction_revision = document.extraction_revision',
    );
    expect(projectionSql).toContain('review.decided_at is not null');
    expect(projectionSql).not.toContain('document.updated_at');
  });

  it('returns duplicate before quota and then enforces the exact owner document quota under the scope lock', async () => {
    let mode: 'duplicate' | 'quota' = 'duplicate';
    const { pool, query } = poolFor((sql) => {
      const lock = lockRows(sql);
      if (lock !== undefined) return lock;
      if (sql.includes('from emdo.spaces')) return [{ id: ids.space }];
      if (sql.includes('plaintext_sha256')) {
        return mode === 'duplicate' ? [documentRow()] : [];
      }
      if (sql.includes('count(*)::integer')) {
        return [{ documentCount: 10_000, byteCount: 12_345 }];
      }
      return [];
    });
    const repository = new PostgresFinanceDocumentRepository(pool);

    await expect(
      repository.createUploadedMetadata({
        principal,
        requestId: ids.request,
        storage,
      }),
    ).resolves.toMatchObject({
      status: 'duplicate',
      document: { id: ids.document },
    });
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).startsWith('insert into emdo.finance_documents'),
      ),
    ).toBe(false);

    mode = 'quota';
    await expect(
      repository.createUploadedMetadata({
        principal,
        requestId: ids.request,
        storage,
      }),
    ).resolves.toEqual({
      status: 'quota-exceeded',
      documentCount: 10_000,
      byteCount: 12_345,
      maxDocuments: 10_000,
      maxBytes: 50 * 1024 * 1024 * 1024,
    });
  });

  it('supersedes a retry revision and atomically invalidates every pending review token', async () => {
    const { pool, query } = poolFor((sql) => {
      const lock = lockRows(sql);
      if (lock !== undefined) return lock;
      if (
        sql.includes('from emdo.finance_documents') &&
        sql.includes('for update')
      ) {
        return [
          documentRow({
            state: 'awaiting-review',
            extractionRevision: 1,
          }),
        ];
      }
      if (
        sql.includes('from emdo.finance_document_extractions') &&
        sql.includes('for update')
      ) {
        return [
          {
            id: ids.extraction,
            revision: 1,
            attempt: 1,
            state: 'awaiting-review',
          },
        ];
      }
      if (sql.includes('insert into emdo.finance_document_extractions')) {
        return [
          { id: ids.nextExtraction, revision: 2, attempt: 2, state: 'queued' },
        ];
      }
      if (sql.includes('update emdo.finance_documents'))
        return { rows: [], rowCount: 1 };
      return [];
    });
    const repository = new PostgresFinanceDocumentRepository(pool, {
      generateUuid: () => ids.nextExtraction,
    });

    await expect(
      repository.createOrRetryExtractionRevision({
        principal,
        requestId: ids.request,
        documentId: ids.document,
        retry: true,
      }),
    ).resolves.toEqual({
      id: ids.nextExtraction,
      documentId: ids.document,
      revision: 2,
      attempt: 2,
      state: 'queued',
    });

    const sql = query.mock.calls.map(([text]) => String(text));
    expect(sql.some((text) => text.includes("set state = 'superseded'"))).toBe(
      true,
    );
    const invalidation = sql.find((text) =>
      text.includes('update emdo.finance_document_review_batches'),
    );
    expect(invalidation).toContain("state = 'invalidated'");
    expect(invalidation).toContain('review.household_id = $1');
    expect(invalidation).toContain('review.space_id = $2');
    expect(invalidation).toContain('review.original_owner_user_id = $3');
  });

  it('replays only a hash-, token-, session-, grant-, and scope-bound committed review', async () => {
    const committedReview = reviewRow('CAD');
    const expectedPayloadHash = committedReview.payloadHash;
    const { pool, query } = poolFor((sql, values) => {
      const lock = lockRows(sql);
      if (lock !== undefined) return lock;
      if (
        sql.includes('from emdo.finance_documents') &&
        sql.includes('for update')
      ) {
        return [documentRow({ state: 'committed', extractionRevision: 1 })];
      }
      if (sql.includes('from emdo.finance_document_review_batches')) {
        return values.includes(expectedPayloadHash) &&
          values.includes(sha256('A'.repeat(43)))
          ? [committedReview]
          : [];
      }
      return [];
    });
    const repository = new PostgresFinanceDocumentRepository(pool);
    const exact = {
      principal,
      requestId: ids.request,
      documentId: ids.document,
      extractionRevision: 1,
      reviewBatchId: ids.review,
      reviewToken: 'A'.repeat(43),
      payloadHash: expectedPayloadHash,
      idempotencyKey: committedReview.idempotencyKey,
      embeddings: [{ ordinal: 0, embedding: vector(1) }],
    };

    await expect(repository.commitReview(exact)).resolves.toMatchObject({
      status: 'replayed',
      chunksCommitted: 1,
      evidenceCommitted: 1,
    });
    await expect(
      repository.commitReview({ ...exact, payloadHash: 'e'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'review-not-found' });
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes('insert into emdo.finance_document_chunks'),
      ),
    ).toBe(false);
  });

  it('writes only separately supplied semantic vectors in the same review commit transaction', async () => {
    const selectedFacts = {
      ...payload(),
      chunks: [
        {
          ordinal: 0,
          pageStart: 1,
          pageEnd: 1,
          content:
            'emdo.finance-document.review-envelope.v1:1/1:eyJzY2hlbWFWZXJzaW9uIjoxfQ',
          embedding: null,
        },
        {
          ordinal: 1,
          pageStart: 1,
          pageEnd: 1,
          content: 'Reviewed groceries receipt total',
          embedding: null,
        },
      ],
      evidence: [
        {
          chunkOrdinal: 1,
          page: 1,
          excerpt: 'groceries receipt total',
          locator: { characterStart: 0, characterEnd: 23 },
          sourceLocale: 'en-CA' as const,
        },
      ],
    };
    const pendingReview = reviewRow('CAD', {
      selectedFacts,
      state: 'pending',
    });
    const { pool, query } = poolFor((sql, values) => {
      const lock = lockRows(sql);
      if (lock !== undefined) return lock;
      if (
        sql.includes('from emdo.finance_documents') &&
        sql.includes('for update')
      ) {
        return [
          documentRow({ state: 'awaiting-review', extractionRevision: 1 }),
        ];
      }
      if (
        sql.includes('from emdo.finance_document_review_batches') &&
        sql.includes('for update')
      ) {
        return [pendingReview];
      }
      if (
        sql.includes('from emdo.finance_document_extractions') &&
        sql.includes('for update')
      ) {
        return [
          {
            id: ids.extraction,
            revision: 1,
            attempt: 1,
            state: 'awaiting-review',
          },
        ];
      }
      if (sql.includes('insert into emdo.finance_document_chunks')) {
        return [{ id: ids.chunk, ordinal: values[6] }];
      }
      if (
        sql.includes('insert into emdo.finance_document_evidence') ||
        sql.includes('update emdo.finance_document_review_batches') ||
        sql.includes('update emdo.finance_document_extractions') ||
        sql.includes('update emdo.finance_documents')
      ) {
        return { rows: [], rowCount: 1 };
      }
      return [];
    });
    const repository = new PostgresFinanceDocumentRepository(pool);

    await expect(
      repository.commitReview({
        principal,
        requestId: ids.request,
        documentId: ids.document,
        extractionRevision: 1,
        reviewBatchId: ids.review,
        reviewToken: 'A'.repeat(43),
        payloadHash: pendingReview.payloadHash,
        idempotencyKey: pendingReview.idempotencyKey,
        embeddings: [{ ordinal: 1, embedding: vector(0.25) }],
      }),
    ).resolves.toMatchObject({ status: 'committed', chunksCommitted: 2 });

    const chunkInserts = query.mock.calls.filter(([sql]) =>
      String(sql).includes('insert into emdo.finance_document_chunks'),
    );
    expect(chunkInserts).toHaveLength(2);
    const envelopeValues = chunkInserts.find(
      ([, values]) => values?.[6] === 0,
    )?.[1];
    const semanticValues = chunkInserts.find(
      ([, values]) => values?.[6] === 1,
    )?.[1];
    expect(envelopeValues?.[11]).toBeNull();
    expect(typeof semanticValues?.[11]).toBe('string');
    expect(String(semanticValues?.[11]).split(',')).toHaveLength(1_536);
    expect(String(semanticValues?.[11])).toMatch(/^\[0.25,/u);
    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(
      statements.findIndex((sql) =>
        sql.includes('insert into emdo.finance_document_chunks'),
      ),
    ).toBeLessThan(
      statements.findIndex((sql) => sql.includes("set state = 'committed'")),
    );
    expect(
      statements.some((sql) => sql.trim().toLowerCase() === 'commit'),
    ).toBe(true);
  });

  it('rejects review payload vectors and non-semantic embedding ordinals before materialization', async () => {
    const pendingReview = reviewRow('CAD', { state: 'pending' });
    const { pool, query } = poolFor((sql) => {
      const lock = lockRows(sql);
      if (lock !== undefined) return lock;
      if (
        sql.includes('from emdo.finance_documents') &&
        sql.includes('for update')
      ) {
        return [
          documentRow({ state: 'awaiting-review', extractionRevision: 1 }),
        ];
      }
      if (
        sql.includes('from emdo.finance_document_review_batches') &&
        sql.includes('for update')
      ) {
        return [pendingReview];
      }
      return [];
    });
    const repository = new PostgresFinanceDocumentRepository(pool);
    const base = {
      principal,
      requestId: ids.request,
      documentId: ids.document,
      extractionRevision: 1,
      reviewBatchId: ids.review,
      reviewToken: 'A'.repeat(43),
      payloadHash: pendingReview.payloadHash,
      idempotencyKey: pendingReview.idempotencyKey,
    };

    await expect(
      repository.commitReview({
        ...base,
        embeddings: [{ ordinal: 99, embedding: vector(1) }],
      }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes('insert into emdo.finance_document_chunks'),
      ),
    ).toBe(false);

    await expect(
      repository.replaceCurrentReviewDraft({
        principal,
        requestId: ids.request,
        documentId: ids.document,
        extractionRevision: 1,
        reviewToken: 'A'.repeat(43),
        idempotencyKey: 'finance-document-review-key-0002',
        selectedFacts: {
          ...payload(),
          chunks: [
            {
              ...payload().chunks[0],
              embedding: vector(1),
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
  });

  it('retains non-CAD review data while labelling it non-CAD instead of dropping it', async () => {
    const committedReview = reviewRow('USD');
    const { pool } = poolFor((sql) => {
      const lock = lockRows(sql);
      if (lock !== undefined) return lock;
      if (
        sql.includes('from emdo.finance_documents') &&
        sql.includes('for update')
      ) {
        return [
          documentRow({
            state: 'committed',
            extractionRevision: 1,
            currency: 'USD',
          }),
        ];
      }
      if (sql.includes('from emdo.finance_document_review_batches'))
        return [committedReview];
      return [];
    });
    const repository = new PostgresFinanceDocumentRepository(pool);

    await expect(
      repository.commitReview({
        principal,
        requestId: ids.request,
        documentId: ids.document,
        extractionRevision: 1,
        reviewBatchId: ids.review,
        reviewToken: 'A'.repeat(43),
        payloadHash: committedReview.payloadHash,
        idempotencyKey: committedReview.idempotencyKey,
        embeddings: [{ ordinal: 0, embedding: vector(1) }],
      }),
    ).resolves.toMatchObject({
      status: 'replayed',
      currency: 'USD',
      currencyLabel: 'non-cad',
      matchSuggestionsCommitted: 0,
    });
  });

  it('returns evidence only through the current owner predicates and denies another owner a fake-pool row', async () => {
    const { pool, query } = poolFor((sql, values) => {
      const lock = lockRows(sql);
      if (lock !== undefined) return lock;
      if (sql.includes('from emdo.finance_document_evidence')) {
        return values[2] === ids.user
          ? [
              {
                id: ids.evidence,
                documentId: ids.document,
                extractionRevision: 1,
                chunkId: ids.chunk,
                page: 1,
                excerpt: 'reviewed evidence',
                excerptHash: 'c'.repeat(64),
                locator: { characterStart: 0, characterEnd: 16 },
                sourceLocale: 'en-CA',
              },
            ]
          : [];
      }
      return [];
    });
    const repository = new PostgresFinanceDocumentRepository(pool);
    const input = { requestId: ids.request, documentId: ids.document };

    await expect(
      repository.listEvidence({ ...input, principal }),
    ).resolves.toHaveLength(1);
    await expect(
      repository.listEvidence({
        ...input,
        principal: { ...principal, userId: ids.otherUser },
      }),
    ).resolves.toEqual([]);
    const evidenceSql = query.mock.calls.find(([sql]) =>
      String(sql).includes('from emdo.finance_document_evidence'),
    )?.[0];
    expect(evidenceSql).toContain('evidence.household_id = $1');
    expect(evidenceSql).toContain('evidence.space_id = $2');
    expect(evidenceSql).toContain('evidence.original_owner_user_id = $3');
  });

  it('deletes in FK-safe order, clears every content field into a tombstone, and is idempotent', async () => {
    let deleted = false;
    const receipt = {
      proposalId: ids.review,
      decisionId: ids.match,
      targetBindingHash: 'c'.repeat(64),
      executionBindingHash: 'd'.repeat(64),
    };
    const { pool, query } = poolFor((sql) => {
      const lock = lockRows(sql);
      if (lock !== undefined) return lock;
      if (
        sql.includes('from emdo.finance_documents') &&
        sql.includes('for update')
      ) {
        return [
          documentRow({
            state: deleted ? 'deleted' : 'deleting',
            storageObjectId: deleted ? null : storage.storageObjectId,
            displayName: deleted ? null : storage.displayName,
            mimeType: deleted ? null : storage.mimeType,
            byteSize: deleted ? null : storage.byteSize,
            pageCount: deleted ? null : storage.pageCount,
            plaintextSha256: deleted ? null : storage.plaintextSha256,
            ciphertextSha256: deleted ? null : storage.ciphertextSha256,
            wrappedDataKey: deleted ? null : storage.wrappedDataKey,
            keyVersion: deleted ? null : storage.keyVersion,
            deletedAt: deleted ? new Date('2026-08-26T12:20:00.000Z') : null,
            deletionProposalId: receipt.proposalId,
            deletionDecisionId: receipt.decisionId,
            deletionTargetBindingHash: receipt.targetBindingHash,
            deletionExecutionBindingHash: receipt.executionBindingHash,
          }),
        ];
      }
      if (sql.includes('update emdo.finance_documents'))
        return { rows: [], rowCount: 1 };
      return [];
    });
    const repository = new PostgresFinanceDocumentRepository(pool);
    const input = {
      principal,
      requestId: ids.request,
      documentId: ids.document,
      receipt,
    };

    await expect(repository.finalizeGuardedDelete(input)).resolves.toEqual({
      status: 'deleted',
    });
    const mutations = query.mock.calls
      .map(([sql]) => String(sql))
      .filter(
        (sql) =>
          sql.startsWith('delete from emdo.finance') ||
          sql.startsWith('update emdo.finance_documents'),
      );
    expect(mutations).toEqual([
      expect.stringContaining('delete from emdo.finance_document_evidence'),
      expect.stringContaining('delete from emdo.finance_document_matches'),
      expect.stringContaining(
        'delete from emdo.finance_document_review_batches',
      ),
      expect.stringContaining('delete from emdo.finance_document_chunks'),
      expect.stringContaining('delete from emdo.finance_document_extractions'),
      expect.stringContaining('update emdo.finance_documents'),
    ]);
    expect(mutations.at(-1)).toContain('storage_object_id = null');
    expect(mutations.at(-1)).toContain('wrapped_data_key = null');
    expect(mutations.at(-1)).toContain('extraction_revision = null');

    deleted = true;
    await expect(repository.finalizeGuardedDelete(input)).resolves.toEqual({
      status: 'already-deleted',
    });
  });

  it('rolls back and maps unexpected pool failures without exposing a database error', async () => {
    const { pool, query, release } = poolFor((sql) => {
      const lock = lockRows(sql);
      if (lock !== undefined) return lock;
      if (sql.includes('from emdo.finance_documents')) {
        throw new Error('sensitive postgres failure');
      }
      return [];
    });
    const repository = new PostgresFinanceDocumentRepository(pool);

    await expect(
      repository.getMetadata({
        principal,
        requestId: ids.request,
        documentId: ids.document,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'database-unavailable',
        message: 'The Finance document operation could not be verified',
      }),
    );
    expect(query.mock.calls.map(([sql]) => sql)).toContain('rollback');
    expect(release).toHaveBeenCalledTimes(1);
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes('sensitive postgres failure'),
      ),
    ).toBe(false);
  });

  it('rejects malformed vector input before opening an unscoped database session', async () => {
    const { pool } = poolFor(() => []);
    const repository = new PostgresFinanceDocumentRepository(pool);

    await expect(
      repository.search({
        principal,
        requestId: ids.request,
        query: 'groceries',
        vectorQuery: [1, 2, 3],
      }),
    ).rejects.toBeInstanceOf(FinanceDocumentRepositoryError);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

import { createHash } from 'node:crypto';

import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { financeDocumentOriginalAssociatedData } from '@emdo/integrations/finance-documents';
import { hashCanonicalJson } from '@emdo/toolbox';
import { describe, expect, it, vi } from 'vitest';

import {
  createProductionFinanceDocumentGateway,
  FinanceDocumentGatewayError,
  type ProductionFinanceDocumentGatewayDependencies,
} from './finance-document-services.js';
import { hashFinanceGuardedActionExecutionBinding } from './finance-agent-services.js';
import { financeGuardedActionCapabilityFingerprint } from '../agents/capability-runtime.js';
import type { AuthenticatedPrincipal } from '../services/contracts.js';

const IDS = Object.freeze({
  user: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f70',
  session: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f71',
  household: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f72',
  privateSpace: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f73',
  grant: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f74',
  document: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f75',
  review: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f76',
  match: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f77',
  evidence: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f78',
  transaction: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f79',
  budget: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f7a',
  request: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f7b',
  approval: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f7c',
  run: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f7d',
  disclosure: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f7e',
  proposal: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f7f',
});

const NOW = '2026-08-26T12:00:00.000Z';
const LATER = '2026-08-26T13:00:00.000Z';
const IDEMPOTENCY_KEY = 'request:018f1f5e:finance-document';
const OBJECT_NAME = `fd1_${'a'.repeat(43)}`;
const PDF_BYTES = Buffer.from(
  '%PDF-1.7\n1 0 obj\n<< /Type /Page >>\nendobj\n',
  'utf8',
);
const hex = (value: Uint8Array | string): string =>
  createHash('sha256').update(value).digest('hex');
const vector = (seed: number): readonly number[] =>
  Object.freeze(Array.from({ length: 1_536 }, () => seed));

const stableJson = (value: unknown): string => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
};

const principal: AuthenticatedPrincipal = Object.freeze({
  userId: IDS.user,
  sessionId: IDS.session,
  householdId: IDS.household,
  privateSpaceId: IDS.privateSpace,
  role: 'owner',
  emailVerified: true,
  spaceAccessGrantId: IDS.grant,
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema.parse('a'.repeat(64)),
});

const envelope = Object.freeze({
  schemaVersion: 1 as const,
  sourceLocale: 'en-CA' as const,
  currency: 'CAD',
  issuer: 'Policy ＡＢ１２ＣＤ３４ＥＦ',
  recipient: null,
  issuedOn: null,
  dueOn: null,
  periodStart: null,
  periodEnd: null,
  subtotal: null,
  tax: null,
  total: { currency: 'CAD', minorUnits: 123 },
  accountLast4: null,
  facts: [
    {
      field: 'total',
      confidence: 0.99,
      evidence: [
        {
          page: 1,
          excerpt: 'Grocer CAD 1.23',
          characterStart: 0,
          characterEnd: 15,
        },
      ],
    },
  ],
  documentType: 'receipt' as const,
  merchant: 'Grocer',
  purchasedOn: '2026-08-25',
  tip: null,
  paymentMethodLast4: '1234',
  lineItems: [],
  proposedRecord: {
    kind: 'expense' as const,
    amount: { currency: 'CAD', minorUnits: 123 },
    occurredOn: '2026-08-25',
    description: 'Grocer',
  },
});

const uploadedMetadata = (state = 'awaiting-review') => ({
  id: IDS.document,
  state,
  displayName: 'receipt.pdf',
  mimeType: 'application/pdf' as const,
  byteSize: PDF_BYTES.byteLength,
  pageCount: 1,
  imageWidth: null,
  imageHeight: null,
  plaintextSha256: hex(PDF_BYTES),
  documentType: state === 'committed' ? ('receipt' as const) : null,
  sourceLocale: state === 'committed' ? ('en-CA' as const) : null,
  currency: null,
  currencyLabel: 'unknown' as const,
  extractionRevision: state === 'uploaded' || state === 'deleted' ? null : 1,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: state === 'deleted' ? NOW : null,
});

const originalAuthorization = Object.freeze({
  id: IDS.document,
  storageObjectId: OBJECT_NAME,
  mimeType: 'application/pdf' as const,
  byteSize: PDF_BYTES.byteLength,
  pageCount: 1,
  imageWidth: null,
  imageHeight: null,
  plaintextSha256: hex(PDF_BYTES),
  ciphertextSha256: hex(PDF_BYTES),
  wrappedDataKey: {
    algorithm: 'aes-256-gcm' as const,
    wrappedKey: 'wrapped-key',
    nonce: 'nonce',
    authenticationTag: 'tag',
    aadVersion: 1 as const,
  },
  keyVersion: 'finance-documents.v1',
});

const encryptedPayload = Object.freeze({
  schemaVersion: 1 as const,
  algorithm: 'aes-256-gcm' as const,
  aadVersion: 1 as const,
  ciphertext: 'ciphertext',
  nonce: 'nonce',
  authenticationTag: 'tag',
  wrappedKey: 'wrapped-key',
  keyVersion: 'finance-documents.v1',
});

const sourceOf = (bytes: Uint8Array): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    yield bytes;
  },
});

const request = <Value>(value: Value): Value & { readonly requestId: string } =>
  Object.freeze({ ...value, requestId: IDS.request });

const guardedScope = Object.freeze({
  requestId: IDS.request,
  runId: IDS.run,
  userId: IDS.user,
  householdId: IDS.household,
  sessionId: IDS.session,
  privateSpaceId: IDS.privateSpace,
  spaceAccessGrantId: IDS.grant,
  collectionAuthorizationScopeFingerprint:
    principal.collectionAuthorizationScopeFingerprint,
  disclosureGrantId: IDS.disclosure,
  abortSignal: new AbortController().signal,
});

const executeGuardedDocumentAction = async (
  gateway: ReturnType<typeof createProductionFinanceDocumentGateway>,
  input:
    | Readonly<{
        readonly operation: 'finance-document-review-commit';
        readonly intent: Readonly<{
          readonly kind: 'commit-document-review';
          readonly documentId: string;
        }>;
      }>
    | Readonly<{
        readonly operation: 'finance-document-match-accept';
        readonly intent: Readonly<{
          readonly kind: 'accept-document-match';
          readonly matchId: string;
        }>;
      }>
    | Readonly<{
        readonly operation: 'finance-document-delete';
        readonly intent: Readonly<{
          readonly kind: 'delete-document';
          readonly documentId: string;
        }>;
      }>,
) => {
  const port = gateway.createGuardedActionPort(principal);
  const target = await port.materializeTarget({
    scope: guardedScope,
    operation: input.operation,
    intent: input.intent,
  });
  const capabilityFingerprint = financeGuardedActionCapabilityFingerprint(
    'finance.records.write',
  );
  const actionHash = hashCanonicalJson({
    schemaVersion: 1,
    mutation: input.intent,
  });
  const executionBindingHash = hashFinanceGuardedActionExecutionBinding({
    proposalId: IDS.proposal,
    scope: guardedScope,
    capabilityId: 'finance.records.write',
    capabilityVersion: '1.0.0',
    capabilityFingerprint,
    operation: input.operation,
    actionHash,
    targetBindingHash: target.targetBindingHash,
  });
  return port.executeApproved({
    scope: guardedScope,
    operation: input.operation,
    intent: input.intent,
    permit: {
      proposalId: IDS.proposal,
      decisionId: IDS.approval,
      capabilityId: 'finance.records.write',
      capabilityVersion: '1.0.0',
      capabilityFingerprint,
      operation: input.operation,
      actionHash,
      executionBindingHash,
    },
    capabilityFingerprint,
    approvalDecisionId: IDS.approval,
  });
};

const createHarness = () => {
  let currentDocument: Record<string, unknown> = uploadedMetadata();
  let storedReview: Record<string, unknown> | undefined;
  let reviewCommitted = false;
  let guardedDeletionReceipt:
    | Readonly<{
        readonly proposalId: string;
        readonly decisionId: string;
        readonly targetBindingHash: string;
        readonly executionBindingHash: string;
      }>
    | undefined;
  let embeddingSeed = 0;
  const storedObjects = new Map<string, Buffer>();
  const capturedAads: Uint8Array[] = [];

  const repository = {
    checkInfrastructureReady: vi.fn(async () => true),
    checkReady: vi.fn(async () => true),
    getOwnerQuota: vi.fn(async () => ({
      documentCount: 2,
      byteCount: 456,
      maxDocuments: 10_000,
      maxBytes: 50 * 1024 * 1024 * 1024,
    })),
    createUploadedMetadata: vi.fn(async (): Promise<unknown> => ({
      status: 'created' as const,
      document: uploadedMetadata('uploaded'),
    })),
    list: vi.fn(async () => ({ documents: [], nextCursor: null })),
    getMetadata: vi.fn(async () => currentDocument),
    getOriginalAuthorization: vi.fn(async () => originalAuthorization),
    createOrRetryExtractionRevision: vi.fn(async () => {
      currentDocument = uploadedMetadata('extracting');
      return {
        id: IDS.review,
        documentId: IDS.document,
        revision: 1,
        attempt: 1,
        state: 'queued' as const,
      };
    }),
    getCurrentExtraction: vi.fn(async () => ({
      documentId: IDS.document,
      extractionRevision: 1,
      documentType: null,
      sourceLocale: null,
      currency: null,
      encryptedPayload,
    })),
    getCurrentReviewDraft: vi.fn(async () =>
      reviewCommitted ? undefined : storedReview,
    ),
    getCommittedReviewAuthorization: vi.fn(async () =>
      reviewCommitted ? storedReview : undefined,
    ),
    getCurrentCommittedReview: vi.fn(async () =>
      reviewCommitted ? storedReview : undefined,
    ),
    replaceCurrentReviewDraft: vi.fn(async (input: Record<string, unknown>) => {
      storedReview = {
        id: IDS.review,
        documentId: input.documentId,
        extractionRevision: input.extractionRevision,
        payloadHash: hex(stableJson(input.selectedFacts)),
        reviewTokenHash: hex(input.reviewToken as string),
        idempotencyKey: input.idempotencyKey,
        selectedFacts: input.selectedFacts,
        expiresAt: LATER,
      };
      return { status: 'created' as const, review: storedReview };
    }),
    commitReview: vi.fn(async () => {
      reviewCommitted = true;
      currentDocument = uploadedMetadata('committed');
      return { status: 'committed' as const };
    }),
    listMatches: vi.fn(async (): Promise<unknown> => []),
    getMatchById: vi.fn(async () => ({
      id: IDS.match,
      documentId: IDS.document,
      extractionRevision: 1,
      recordType: 'transaction' as const,
      recordId: IDS.transaction,
      scoreBasisPoints: 9_500,
      reasons: ['exact CAD total'],
      state: 'suggested' as const,
      decisionReviewBatchId: null,
      decidedAt: null,
    })),
    decideMatch: vi.fn(async () => ({
      status: 'decided' as const,
      state: 'accepted' as const,
    })),
    getEvidenceById: vi.fn(async () => ({
      id: IDS.evidence,
      documentId: IDS.document,
      extractionRevision: 1,
      chunkId: null,
      page: 1,
      excerpt: 'Grocer CAD 1.23',
      excerptHash: hex('Grocer CAD 1.23'),
      locator: { characterStart: 0, characterEnd: 15 },
      sourceLocale: 'en-CA' as const,
    })),
    getGuardedDeleteReceipt: vi.fn(async () =>
      guardedDeletionReceipt === undefined ||
      (currentDocument.state !== 'deleting' &&
        currentDocument.state !== 'deleted')
        ? undefined
        : {
            state: currentDocument.state,
            receipt: guardedDeletionReceipt,
          },
    ),
    beginGuardedDelete: vi.fn(
      async (input: { readonly receipt: typeof guardedDeletionReceipt }) => {
        if (guardedDeletionReceipt === undefined) {
          guardedDeletionReceipt = input.receipt!;
          currentDocument = uploadedMetadata('deleting');
          return {
            status: 'deleting' as const,
            original: originalAuthorization,
          };
        }
        if (
          input.receipt?.proposalId !== guardedDeletionReceipt.proposalId ||
          input.receipt?.decisionId !== guardedDeletionReceipt.decisionId ||
          input.receipt?.targetBindingHash !==
            guardedDeletionReceipt.targetBindingHash ||
          input.receipt?.executionBindingHash !==
            guardedDeletionReceipt.executionBindingHash
        ) {
          throw new Error('receipt mismatch');
        }
        return {
          status: 'replayed' as const,
          original: originalAuthorization,
        };
      },
    ),
    finalizeGuardedDelete: vi.fn(async () => {
      currentDocument = uploadedMetadata('deleted');
      return { status: 'deleted' as const };
    }),
  };

  const storage = {
    checkReady: vi.fn(async () => true),
    store: vi.fn(
      async (input: {
        readonly source: AsyncIterable<Uint8Array>;
        readonly aad: Uint8Array;
      }) => {
        capturedAads.push(new Uint8Array(input.aad));
        const chunks: Buffer[] = [];
        for await (const chunk of input.source) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        storedObjects.set(OBJECT_NAME, bytes);
        return {
          schemaVersion: 1 as const,
          algorithm: 'aes-256-gcm' as const,
          aadVersion: 1 as const,
          objectName: OBJECT_NAME,
          plaintextBytes: bytes.byteLength,
          ciphertextBytes: bytes.byteLength,
          plaintextSha256: hex(bytes),
          ciphertextSha256: hex(bytes),
          nonce: 'nonce',
          authenticationTag: 'tag',
          wrappedKey: 'wrapped-key',
          keyVersion: 'finance-documents.v1',
        };
      },
    ),
    read: vi.fn(
      (input: {
        readonly metadata: { readonly objectName: string };
        readonly aad: Uint8Array;
      }) => {
        capturedAads.push(new Uint8Array(input.aad));
        const bytes = storedObjects.get(input.metadata.objectName) ?? PDF_BYTES;
        return sourceOf(bytes);
      },
    ),
    purge: vi.fn(async (objectName: string) => {
      storedObjects.delete(objectName);
      return { status: 'deleted' as const };
    }),
  };

  const payloadCrypto = {
    decrypt: vi.fn(async () => envelope),
  };
  const financeRead = {
    list: vi.fn(async (input?: { cursor?: string }): Promise<unknown> => {
      void input;
      return {
        schemaVersion: 1 as const,
        items: [],
      };
    }),
    readSnapshot: vi.fn(
      async (): Promise<{
        readonly reviewedCadTotals: readonly unknown[];
        readonly budgets: readonly unknown[];
        readonly recentActivity?: readonly unknown[];
      }> => ({ reviewedCadTotals: [], budgets: [], recentActivity: [] }),
    ),
  };
  const embeddings = {
    embed: vi.fn(
      async (input: {
        readonly chunks: readonly Readonly<{ readonly content: string }>[];
      }) => ({
        vectors: input.chunks.map(() => vector((embeddingSeed += 1))),
      }),
    ),
  };
  const pdfInspector = {
    pageCount: vi.fn(async () => 1),
  };

  const gateway = createProductionFinanceDocumentGateway({
    repository,
    storage,
    payloadCrypto,
    financeRead,
    embeddings,
    pdfInspector,
    reviewTokenHmacKey: Buffer.alloc(32, 7),
  } as unknown as ProductionFinanceDocumentGatewayDependencies);

  return {
    gateway,
    repository,
    storage,
    payloadCrypto,
    financeRead,
    embeddings,
    pdfInspector,
    capturedAads,
    setFinancePage: (items: readonly unknown[]) =>
      financeRead.list.mockResolvedValue({ schemaVersion: 1, items }),
    setFinanceSnapshot: (snapshot: {
      readonly reviewedCadTotals: readonly unknown[];
      readonly budgets: readonly unknown[];
      readonly recentActivity?: readonly unknown[];
    }) => financeRead.readSnapshot.mockResolvedValue(snapshot),
    setFinancePages: (pages: readonly Readonly<Record<string, unknown>>[]) => {
      financeRead.list.mockImplementation(
        async (input?: { cursor?: string }) => {
          const pageIndex =
            input?.cursor === undefined
              ? 0
              : Number(/^page-(\d+)$/u.exec(input.cursor)?.[1]);
          const page = pages[pageIndex];
          if (page === undefined) throw new Error('unexpected finance cursor');
          return page;
        },
      );
    },
  };
};

describe('production Finance document gateway', () => {
  it('derives a repeatable hash-bound review token and commits only semantic reviewed chunks', async () => {
    const harness = createHarness();

    const first = await harness.gateway.getReview(
      request({ documentId: IDS.document, principal }),
    );
    const replay = await harness.gateway.getReview(
      request({ documentId: IDS.document, principal }),
    );

    expect(first.reviewToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(replay.reviewToken).toBe(first.reviewToken);
    expect(harness.payloadCrypto.decrypt).toHaveBeenCalledOnce();
    expect(harness.repository.replaceCurrentReviewDraft).toHaveBeenCalledOnce();
    expect(harness.embeddings.embed).not.toHaveBeenCalled();
    const replacement = harness.repository.replaceCurrentReviewDraft.mock
      .calls[0]?.[0] as {
      readonly idempotencyKey: string;
      readonly selectedFacts: Readonly<{
        readonly chunks: readonly Readonly<{
          readonly ordinal: number;
          readonly content: string;
          readonly embedding: null;
        }>[];
      }>;
    };
    expect(replacement.idempotencyKey).toMatch(
      /^finance-review:[A-Za-z0-9_-]{43}$/u,
    );

    await executeGuardedDocumentAction(harness.gateway, {
      operation: 'finance-document-review-commit',
      intent: { kind: 'commit-document-review', documentId: IDS.document },
    });
    const embeddingRequest = harness.embeddings.embed.mock.calls[0]?.[0] as {
      readonly chunks: readonly Readonly<{ readonly content: string }>[];
    };
    const semanticChunks = replacement.selectedFacts.chunks.filter(
      (chunk) =>
        !chunk.content.startsWith('emdo.finance-document.review-envelope.v1:'),
    );
    expect(harness.embeddings.embed).toHaveBeenCalledOnce();
    expect(JSON.stringify(replacement.selectedFacts)).not.toContain(
      'ＡＢ１２ＣＤ３４ＥＦ',
    );
    expect(JSON.stringify(embeddingRequest)).not.toContain(
      'ＡＢ１２ＣＤ３４ＥＦ',
    );
    expect(JSON.stringify(embeddingRequest)).toContain('••••••34EF');
    expect(embeddingRequest.chunks.map((chunk) => chunk.content)).toEqual(
      semanticChunks.map((chunk) => chunk.content),
    );
    expect(
      replacement.selectedFacts.chunks.every(
        (chunk) => chunk.embedding === null,
      ),
    ).toBe(true);
    expect(harness.repository.commitReview).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: replacement.idempotencyKey,
        reviewToken: first.reviewToken,
      }),
    );
    const commitCalls = harness.repository.commitReview.mock
      .calls as unknown as readonly [
      {
        readonly embeddings: readonly Readonly<{
          readonly ordinal: number;
          readonly embedding: readonly number[];
        }>[];
      },
    ][];
    const commitInput = commitCalls[0]![0] as {
      readonly embeddings: readonly Readonly<{
        readonly ordinal: number;
        readonly embedding: readonly number[];
      }>[];
    };
    expect(
      commitInput.embeddings.map((embedding) => embedding.ordinal),
    ).toEqual(semanticChunks.map((chunk) => chunk.ordinal));
    expect(
      commitInput.embeddings.every(
        (embedding) =>
          embedding.embedding.length === 1_536 &&
          embedding.embedding.every(Number.isFinite),
      ),
    ).toBe(true);

    await executeGuardedDocumentAction(harness.gateway, {
      operation: 'finance-document-review-commit',
      intent: { kind: 'commit-document-review', documentId: IDS.document },
    });
    expect(harness.repository.commitReview).toHaveBeenCalledOnce();
    expect(harness.embeddings.embed).toHaveBeenCalledOnce();
    expect(harness.repository.getCurrentCommittedReview).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: IDS.document }),
    );
  });

  it('keeps direct commit, match acceptance, and deletion fail-closed even with a token or decision UUID', async () => {
    const harness = createHarness();
    const draft = await harness.gateway.getReview(
      request({ documentId: IDS.document, principal }),
    );

    await expect(
      harness.gateway.commitReview(
        request({
          documentId: IDS.document,
          reviewToken: draft.reviewToken,
          idempotencyKey: 'route:commit:blocked',
          principal,
        }),
      ),
    ).rejects.toMatchObject({ code: 'approval-required' });
    await expect(
      harness.gateway.decideMatch(
        request({
          matchId: IDS.match,
          decision: 'accept' as const,
          reviewToken: draft.reviewToken,
          idempotencyKey: 'route:match:blocked',
          principal,
        }),
      ),
    ).rejects.toMatchObject({ code: 'approval-required' });
    await expect(
      harness.gateway.delete(
        request({
          documentId: IDS.document,
          approvalDecisionId: IDS.approval,
          idempotencyKey: IDEMPOTENCY_KEY,
          principal,
        }),
      ),
    ).rejects.toMatchObject({ code: 'approval-required' });

    expect(harness.repository.commitReview).not.toHaveBeenCalled();
    expect(harness.repository.decideMatch).not.toHaveBeenCalled();
    expect(harness.repository.beginGuardedDelete).not.toHaveBeenCalled();
  });

  it('keeps a reviewed draft retryable when embeddings fail without exposing reviewed content', async () => {
    const harness = createHarness();
    await harness.gateway.getReview(
      request({ documentId: IDS.document, principal }),
    );
    const providerContent = 'Grocer CAD 1.23';
    harness.embeddings.embed.mockRejectedValueOnce(
      new Error(`provider failure: ${providerContent}`),
    );

    const failure = await executeGuardedDocumentAction(harness.gateway, {
      operation: 'finance-document-review-commit',
      intent: { kind: 'commit-document-review', documentId: IDS.document },
    }).catch((cause: unknown) => cause);

    expect(failure).toMatchObject({
      code: 'finance-documents-unavailable',
      message: 'Finance document operation unavailable.',
    });
    expect(String(failure)).not.toContain(providerContent);
    expect(harness.repository.commitReview).not.toHaveBeenCalled();

    await executeGuardedDocumentAction(harness.gateway, {
      operation: 'finance-document-review-commit',
      intent: { kind: 'commit-document-review', documentId: IDS.document },
    });
    expect(harness.embeddings.embed).toHaveBeenCalledTimes(2);
    expect(harness.repository.commitReview).toHaveBeenCalledOnce();
  });

  it('batches only semantic reviewed chunks within the provider limits and preserves ordinals', async () => {
    const harness = createHarness();
    const longReviewedEnvelope = {
      ...envelope,
      issuer: 'i'.repeat(2_000),
      recipient: 'r'.repeat(2_000),
      merchant: 'm'.repeat(2_000),
      facts: Array.from({ length: 33 }, (_entry, index) => ({
        field: `evidence-${index}`,
        confidence: 0.99,
        evidence: [
          {
            page: 1,
            excerpt: 'e'.repeat(2_000),
            characterStart: 0,
            characterEnd: 2_000,
          },
        ],
      })),
    };
    await harness.gateway.updateReview(
      request({
        documentId: IDS.document,
        expectedExtractionRevision: 1,
        envelope: longReviewedEnvelope,
        idempotencyKey: 'route:review:batch',
        principal,
      }),
    );

    await executeGuardedDocumentAction(harness.gateway, {
      operation: 'finance-document-review-commit',
      intent: { kind: 'commit-document-review', documentId: IDS.document },
    });

    expect(harness.embeddings.embed.mock.calls.length).toBeGreaterThan(1);
    for (const [input] of harness.embeddings.embed.mock.calls) {
      const chunks = (
        input as {
          readonly chunks: readonly Readonly<{ readonly content: string }>[];
        }
      ).chunks;
      expect(chunks.length).toBeLessThanOrEqual(32);
      expect(
        chunks.reduce((total, chunk) => total + chunk.content.length, 0),
      ).toBeLessThanOrEqual(64_000);
      expect(
        chunks.reduce(
          (total, chunk) => total + Buffer.byteLength(chunk.content, 'utf8'),
          0,
        ),
      ).toBeLessThanOrEqual(128 * 1_024);
      expect(
        chunks.every(
          (chunk) =>
            !chunk.content.startsWith(
              'emdo.finance-document.review-envelope.v1:',
            ),
        ),
      ).toBe(true);
    }
    const replacement = harness.repository.replaceCurrentReviewDraft.mock
      .calls[0]?.[0] as {
      readonly selectedFacts: Readonly<{
        readonly chunks: readonly Readonly<{
          readonly ordinal: number;
          readonly content: string;
        }>[];
      }>;
    };
    const semanticOrdinals = replacement.selectedFacts.chunks
      .filter(
        (chunk) =>
          !chunk.content.startsWith(
            'emdo.finance-document.review-envelope.v1:',
          ),
      )
      .map((chunk) => chunk.ordinal);
    const commitCalls = harness.repository.commitReview.mock
      .calls as unknown as readonly [
      {
        readonly embeddings: readonly Readonly<{
          readonly ordinal: number;
          readonly embedding: readonly number[];
        }>[];
      },
    ][];
    const commitInput = commitCalls[0]![0] as {
      readonly embeddings: readonly Readonly<{
        readonly ordinal: number;
        readonly embedding: readonly number[];
      }>[];
    };
    expect(
      commitInput.embeddings.map((embedding) => embedding.ordinal),
    ).toEqual(semanticOrdinals);
    expect(
      commitInput.embeddings.map((embedding) => embedding.embedding[0]),
    ).toEqual(semanticOrdinals.map((_ordinal, index) => index + 1));
  });

  it('magic-sniffs before persistence, applies canonical original AAD, and purges a duplicate encrypted object', async () => {
    const harness = createHarness();
    harness.repository.createUploadedMetadata.mockResolvedValueOnce({
      status: 'duplicate',
      document: uploadedMetadata(),
    });

    await harness.gateway.upload(
      request({
        displayName: 'policy-AB-12CD-34EF.pdf',
        declaredMimeType: 'application/pdf',
        source: sourceOf(PDF_BYTES),
        idempotencyKey: 'route:upload:1',
        principal,
      }),
    );
    expect(harness.repository.createUploadedMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        storage: expect.objectContaining({
          displayName: 'policy-••-••••-34EF.pdf',
        }),
      }),
    );

    const canonicalAad = financeDocumentOriginalAssociatedData({
      householdId: IDS.household,
      privateSpaceId: IDS.privateSpace,
      ownerUserId: IDS.user,
    });
    expect(harness.capturedAads).not.toHaveLength(0);
    expect(Buffer.from(harness.capturedAads[0] ?? [])).toEqual(
      Buffer.from(canonicalAad),
    );
    expect(harness.storage.purge).toHaveBeenCalledWith(OBJECT_NAME);

    harness.repository.createUploadedMetadata.mockResolvedValueOnce({
      status: 'quota-exceeded',
      documentCount: 10_000,
      byteCount: 0,
      maxDocuments: 10_000,
      maxBytes: 50 * 1024 * 1024 * 1024,
    });
    await expect(
      harness.gateway.upload(
        request({
          displayName: 'over-quota.pdf',
          declaredMimeType: 'application/pdf',
          source: sourceOf(PDF_BYTES),
          idempotencyKey: 'route:upload:quota',
          principal,
        }),
      ),
    ).rejects.toMatchObject({ code: 'quota-exceeded' });
    expect(harness.storage.purge).toHaveBeenCalledTimes(2);

    await expect(
      harness.gateway.upload(
        request({
          displayName: 'not-a-png.png',
          declaredMimeType: 'image/png',
          source: sourceOf(PDF_BYTES),
          idempotencyKey: 'route:upload:2',
          principal,
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    expect(harness.repository.createUploadedMetadata).toHaveBeenCalledTimes(2);
  });

  it('queues upload and retry revisions without doing extraction work in the API process', async () => {
    const uploadHarness = createHarness();
    const uploaded = await uploadHarness.gateway.upload(
      request({
        displayName: 'queued.pdf',
        declaredMimeType: 'application/pdf',
        source: sourceOf(PDF_BYTES),
        idempotencyKey: 'route:upload:queued',
        principal,
      }),
    );
    expect(uploaded.state).toBe('extracting');
    expect(
      uploadHarness.repository.createOrRetryExtractionRevision,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: IDS.document,
        retry: false,
        model: null,
      }),
    );

    const retryHarness = createHarness();
    const retried = await retryHarness.gateway.retry(
      request({
        documentId: IDS.document,
        idempotencyKey: 'route:retry:queued',
        principal,
      }),
    );
    expect(retried.document.state).toBe('extracting');
    expect(
      retryHarness.repository.createOrRetryExtractionRevision,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: IDS.document,
        retry: true,
        model: null,
      }),
    );
    expect(retryHarness.payloadCrypto.decrypt).not.toHaveBeenCalled();
  });

  it('leaves a deletion in pending-purge when object removal is indeterminate, then compensates safely', async () => {
    const harness = createHarness();
    harness.storage.purge.mockRejectedValueOnce(
      new Error('object store unavailable'),
    );

    await expect(
      executeGuardedDocumentAction(harness.gateway, {
        operation: 'finance-document-delete',
        intent: { kind: 'delete-document', documentId: IDS.document },
      }),
    ).resolves.toEqual({
      status: 'document-purge-pending',
      documentId: IDS.document,
    });
    expect(harness.repository.finalizeGuardedDelete).not.toHaveBeenCalled();

    await expect(
      executeGuardedDocumentAction(harness.gateway, {
        operation: 'finance-document-delete',
        intent: { kind: 'delete-document', documentId: IDS.document },
      }),
    ).resolves.toEqual({
      status: 'document-deleted',
      documentId: IDS.document,
    });
    expect(harness.repository.finalizeGuardedDelete).toHaveBeenCalledOnce();
  });

  it('authorizes exact match and evidence lookups and calculates reviewed CAD projections deterministically', async () => {
    const harness = createHarness();
    await harness.gateway.getReview(
      request({ documentId: IDS.document, principal }),
    );
    await executeGuardedDocumentAction(harness.gateway, {
      operation: 'finance-document-review-commit',
      intent: { kind: 'commit-document-review', documentId: IDS.document },
    });
    harness.repository.listMatches.mockResolvedValueOnce([
      {
        id: IDS.match,
        documentId: IDS.document,
        extractionRevision: 1,
        recordType: 'transaction',
        recordId: IDS.transaction,
        scoreBasisPoints: 9_500,
        reasons: ['exact CAD total'],
        state: 'accepted',
      },
    ]);

    const accepted = await executeGuardedDocumentAction(harness.gateway, {
      operation: 'finance-document-match-accept',
      intent: { kind: 'accept-document-match', matchId: IDS.match },
    });
    expect(accepted).toEqual({
      status: 'match-accepted',
      documentId: IDS.document,
      matchId: IDS.match,
    });
    expect(harness.repository.getMatchById).toHaveBeenCalledWith(
      expect.objectContaining({ matchId: IDS.match }),
    );
    expect(harness.repository.getCurrentCommittedReview).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: IDS.document,
      }),
    );

    const evidence = await harness.gateway.getEvidence(
      request({ evidenceId: IDS.evidence, principal }),
    );
    expect(evidence.items).toHaveLength(1);
    expect(harness.repository.getEvidenceById).toHaveBeenCalledWith(
      expect.objectContaining({ evidenceId: IDS.evidence }),
    );

    harness.setFinancePage([
      {
        recordType: 'transaction',
        id: IDS.transaction,
        description: 'Groceries',
        category: 'groceries',
        postedOn: '2026-08-25',
        currency: 'CAD',
        amountCadMinor: 125,
        state: 'active',
      },
      {
        recordType: 'transaction',
        id: IDS.match,
        description: 'Reversal',
        category: 'groceries',
        postedOn: '2026-08-24',
        currency: 'CAD',
        amountCadMinor: -125,
        state: 'reversed',
      },
      {
        recordType: 'budget',
        id: IDS.budget,
        currency: 'CAD',
        allocationsCadMinor: { groceries: 5_000 },
      },
    ]);
    harness.setFinanceSnapshot({
      reviewedCadTotals: [{ label: 'groceries', amountCadMinor: 125 }],
      budgets: [
        {
          id: `${IDS.budget}:groceries`,
          label: 'groceries',
          allocatedCadMinor: 5_000,
        },
      ],
    });
    const experience = await harness.gateway.readExperience(
      request({ locale: 'fr-CA' as const, principal }),
    );
    expect(experience.locale).toBe('fr-CA');
    expect(experience.reviewedCadTotals).toEqual([
      { label: 'groceries', amountCadMinor: 125 },
    ]);
    expect(experience.budgets).toEqual([
      {
        id: `${IDS.budget}:groceries`,
        label: 'groceries',
        allocatedCadMinor: 5_000,
      },
    ]);
  });

  it('uses one exact owner-private snapshot for unpaged totals and budgets while keeping recent activity at 50', async () => {
    const harness = createHarness();
    const recentActivity = Array.from({ length: 50 }, (_value, index) => ({
      id: `transaction-${index}`,
      label: `groceries: Recent ${index}`,
      occurredAt: '2026-08-25T12:00:00.000Z',
    }));
    harness.setFinanceSnapshot({
      reviewedCadTotals: Array.from({ length: 25 }, (_value, index) => ({
        label: `category-${String(index).padStart(2, '0')}`,
        amountCadMinor: index + 1,
      })),
      budgets: Array.from({ length: 101 }, (_value, index) => ({
        id: `budget-2026-08:category-${String(index).padStart(3, '0')}`,
        label: `category-${String(index).padStart(3, '0')}`,
        allocatedCadMinor: index,
      })),
      recentActivity,
    });

    const experience = await harness.gateway.readExperience(
      request({ locale: 'en-CA' as const, principal }),
    );

    expect(experience.reviewedCadTotals).toHaveLength(25);
    expect(experience.reviewedCadTotals.at(-1)).toEqual({
      label: 'category-24',
      amountCadMinor: 25,
    });
    expect(experience.recentActivity).toHaveLength(50);
    expect(experience.recentActivity[0]).toEqual(recentActivity[0]);
    expect(experience.budgets).toHaveLength(101);
    expect(harness.financeRead.list).not.toHaveBeenCalled();
    expect(harness.financeRead.readSnapshot).toHaveBeenCalledOnce();
    expect(harness.financeRead.readSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        principal,
        requestId: expect.any(String),
      }),
    );
  });

  it('does not convert malformed principal material into a storage or repository scope', async () => {
    const harness = createHarness();
    const malformed = { ...principal, privateSpaceId: undefined };

    await expect(
      harness.gateway.get(
        request({ documentId: IDS.document, principal: malformed }),
      ),
    ).rejects.toBeInstanceOf(FinanceDocumentGatewayError);
    expect(harness.repository.getMetadata).not.toHaveBeenCalled();
  });
});

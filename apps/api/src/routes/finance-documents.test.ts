import { Readable } from 'node:stream';

import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { FINANCE_DOCUMENT_LIMITS } from '@emdo/domains/finance';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../app.js';
import { createFailClosedApiServices } from '../production/unavailable-services.js';
import type {
  ApiServices,
  AuthenticatedPrincipal,
} from '../services/contracts.js';

const IDS = Object.freeze({
  user: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f70',
  session: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f71',
  household: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f72',
  privateSpace: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f73',
  grant: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f74',
  document: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f75',
  match: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f76',
  evidence: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f77',
  approval: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f78',
});
const IDEMPOTENCY_KEY = 'request:018f1f5e:finance-document';
const REVIEW_TOKEN = 'a'.repeat(43);
const NOW = '2026-08-26T12:00:00.000Z';
const principal: AuthenticatedPrincipal = Object.freeze({
  userId: IDS.user,
  sessionId: IDS.session,
  householdId: IDS.household,
  privateSpaceId: IDS.privateSpace,
  role: 'owner',
  emailVerified: true,
  spaceAccessGrantId: IDS.grant,
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema.parse('7'.repeat(64)),
});
const mutationHeaders = Object.freeze({
  cookie: '__Secure-emdo.session_token=current',
  origin: 'https://emdo.example',
  'x-csrf-token': 'csrf-token',
  'idempotency-key': IDEMPOTENCY_KEY,
});

const summary = (state: 'extracting' | 'deleting' = 'extracting') => ({
  schemaVersion: 1 as const,
  id: IDS.document,
  documentType: 'receipt' as const,
  sourceLocale: 'en-CA' as const,
  currency: 'CAD',
  state,
  displayName: 'receipt.pdf',
  mimeType: 'application/pdf' as const,
  byteSize: 4,
  plaintextSha256: '0'.repeat(64),
  extractionRevision: 1,
  createdAt: NOW,
  updatedAt: NOW,
});
const detail = () => ({
  schemaVersion: 1 as const,
  document: summary(),
  reviewAvailable: true,
  matchCount: 1,
});
const envelope = Object.freeze({
  schemaVersion: 1 as const,
  sourceLocale: 'en-CA' as const,
  currency: 'CAD',
  issuer: null,
  recipient: null,
  issuedOn: null,
  dueOn: null,
  periodStart: null,
  periodEnd: null,
  subtotal: null,
  tax: null,
  total: { currency: 'CAD', minorUnits: 123 },
  accountLast4: null,
  facts: [],
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
const review = () => ({
  schemaVersion: 1 as const,
  documentId: IDS.document,
  extractionRevision: 1,
  envelope,
  payloadHash: '1'.repeat(64),
  reviewToken: REVIEW_TOKEN,
  expiresAt: '2026-08-26T13:00:00.000Z',
});
const matches = () => ({
  schemaVersion: 1 as const,
  items: [
    {
      schemaVersion: 1 as const,
      id: IDS.match,
      documentId: IDS.document,
      extractionRevision: 1,
      recordType: 'transaction' as const,
      recordId: 'transaction:receipt-1',
      scoreBasisPoints: 9_000,
      reasons: ['exact CAD total'],
      state: 'suggested' as const,
    },
  ],
});
const evidence = () => ({
  schemaVersion: 1 as const,
  items: [
    {
      schemaVersion: 1 as const,
      id: IDS.evidence,
      documentId: IDS.document,
      extractionRevision: 1,
      page: 1,
      excerpt: 'CAD 1.23',
      sourceLocale: 'en-CA' as const,
      locator: { kind: 'text' },
    },
  ],
});

const multipart = (
  parts: readonly {
    readonly field: string;
    readonly name: string;
    readonly mime: string;
    readonly value: string | Buffer;
  }[],
) => {
  const boundary = '----emdo-finance-document-boundary';
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.field}"; filename="${part.name}"\r\nContent-Type: ${part.mime}\r\n\r\n`,
      ),
    );
    chunks.push(
      Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value),
    );
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
};

const buildServices = (
  options: { readonly principal?: AuthenticatedPrincipal | undefined } = {},
) => {
  const receivedUploads: Uint8Array[] = [];
  const financeDocuments = {
    list: vi.fn(async () => ({ schemaVersion: 1 as const, items: [] })),
    get: vi.fn(async () => detail()),
    upload: vi.fn(
      async (input: { readonly source: AsyncIterable<Uint8Array> }) => {
        for await (const chunk of input.source) receivedUploads.push(chunk);
        return summary();
      },
    ),
    downloadOriginal: vi.fn(async () => ({
      displayName: 'receipt".pdf',
      mimeType: 'application/pdf' as const,
      byteSize: 4,
      body: Readable.from([Buffer.from('%PDF')]),
    })),
    retry: vi.fn(async () => detail()),
    getReview: vi.fn(async () => review()),
    updateReview: vi.fn(async () => review()),
    commitReview: vi.fn(async () => detail()),
    listMatches: vi.fn(async () => matches()),
    decideMatch: vi.fn(async () => matches()),
    getEvidence: vi.fn(async () => evidence()),
    delete: vi.fn(async () => ({
      schemaVersion: 1 as const,
      status: 'pending-purge' as const,
    })),
    readExperience: vi.fn(async () => ({
      schemaVersion: 1 as const,
      locale: 'en-CA' as const,
      connectivity: 'online' as const,
      quota: {
        documentsUsed: 1,
        documentsLimit: 10_000,
        bytesUsed: 4,
        bytesLimit: 50 * 1024 * 1024 * 1024,
      },
      reviewedCadTotals: [],
      recentActivity: [],
      budgets: [],
    })),
  };
  const auth = {
    authenticate: vi.fn(async () =>
      Object.hasOwn(options, 'principal') ? options.principal : principal,
    ),
    verifyMutation: vi.fn(
      async (input: {
        readonly origin?: string;
        readonly csrfToken?: string;
      }) =>
        input.origin === mutationHeaders.origin &&
        input.csrfToken === mutationHeaders['x-csrf-token'],
    ),
  };
  return {
    services: createFailClosedApiServices({
      auth: auth as unknown as ApiServices['auth'],
      bindings: {
        financeDocuments: {
          service:
            financeDocuments as unknown as ApiServices['financeDocuments'],
          check: async () => true,
        },
      },
    }),
    auth,
    financeDocuments,
    receivedUploads,
  };
};

const injectUpload = (
  app: Awaited<ReturnType<typeof createApp>>,
  input: {
    readonly field?: string;
    readonly name?: string;
    readonly mime?: string;
    readonly body?: string | Buffer;
    readonly headers?: Record<string, string>;
  } = {},
) => {
  const data = multipart([
    {
      field: input.field ?? 'file',
      name: input.name ?? 'receipt.pdf',
      mime: input.mime ?? 'application/pdf',
      value: input.body ?? '%PDF',
    },
  ]);
  return app.inject({
    method: 'POST',
    url: '/api/v1/finance/documents',
    headers: {
      ...mutationHeaders,
      ...(input.headers ?? {}),
      'content-type': data.contentType,
    },
    payload: data.body,
  });
};

describe('finance document HTTP boundary', () => {
  it.each([
    ['receipt.pdf', 'application/pdf'],
    ['receipt.jpg', 'image/jpeg'],
    ['receipt.png', 'image/png'],
  ])(
    'uploads one authenticated %s without trusting client identity',
    async (name, mime) => {
      const { services, financeDocuments, receivedUploads } = buildServices();
      const app = await createApp({ services });
      const response = await injectUpload(app, {
        name,
        mime,
        body: 'safe-bytes',
      });
      expect(response.statusCode, response.body).toBe(201);
      expect(response.headers['cache-control']).toContain('no-store');
      expect(Buffer.concat(receivedUploads).toString()).toBe('safe-bytes');
      expect(financeDocuments.upload).toHaveBeenCalledWith(
        expect.objectContaining({
          displayName: name,
          declaredMimeType: mime,
          idempotencyKey: IDEMPOTENCY_KEY,
          principal,
          requestId: expect.any(String),
        }),
      );
      expect(financeDocuments.upload.mock.calls[0]?.[0]).not.toHaveProperty(
        'userId',
      );
      await app.close();
    },
  );

  it('maps duplicate, quota, and unexpected upload failures to bounded responses without raw document bytes', async () => {
    const { services, financeDocuments } = buildServices();
    financeDocuments.upload
      .mockRejectedValueOnce(
        Object.assign(new Error('duplicate raw %PDF bytes'), {
          code: 'duplicate-document',
        }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('quota raw %PDF bytes'), {
          code: 'quota-exceeded',
        }),
      )
      .mockRejectedValueOnce(new Error('provider raw %PDF bytes'));
    const app = await createApp({ services });
    for (const expected of [409, 413, 500]) {
      const response = await injectUpload(app, {
        body: '%PDF secret-statement',
      });
      expect(response.statusCode).toBe(expected);
      expect(response.body).not.toContain('secret-statement');
      expect(response.body).not.toContain('raw %PDF bytes');
    }
    await app.close();
  });

  it('rejects missing mutation proof and a wrong upload field before dispatch', async () => {
    const { services, financeDocuments } = buildServices();
    const app = await createApp({ services });
    const unproven = multipart([
      {
        field: 'file',
        name: 'receipt.pdf',
        mime: 'application/pdf',
        value: '%PDF',
      },
    ]);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/finance/documents',
          headers: {
            cookie: mutationHeaders.cookie,
            'content-type': unproven.contentType,
          },
          payload: unproven.body,
        })
      ).statusCode,
    ).toBe(403);
    expect((await injectUpload(app, { field: 'document' })).statusCode).toBe(
      400,
    );
    expect(financeDocuments.upload).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a declared MIME type outside the PDF/JPEG/PNG allowlist before dispatch', async () => {
    const { services, financeDocuments } = buildServices();
    const app = await createApp({ services });
    expect((await injectUpload(app, { mime: 'text/plain' })).statusCode).toBe(
      415,
    );
    expect(financeDocuments.upload).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a multiple-file selection through the bounded upload stream', async () => {
    const { services, financeDocuments } = buildServices();
    const app = await createApp({ services });
    const many = multipart([
      {
        field: 'file',
        name: 'one.pdf',
        mime: 'application/pdf',
        value: '%PDF',
      },
      {
        field: 'file',
        name: 'two.pdf',
        mime: 'application/pdf',
        value: '%PDF',
      },
    ]);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/finance/documents',
      headers: { ...mutationHeaders, 'content-type': many.contentType },
      payload: many.body,
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(financeDocuments.upload).toHaveBeenCalledOnce();
    await app.close();
  });

  it('aborts an over-limit file stream with a bounded response', async () => {
    const { services, financeDocuments } = buildServices();
    const app = await createApp({ services });
    const response = await injectUpload(app, {
      body: Buffer.alloc(FINANCE_DOCUMENT_LIMITS.maximumBytesPerFile + 1),
    });
    expect(response.statusCode, response.body).toBe(413);
    expect(financeDocuments.upload).toHaveBeenCalledOnce();
    await app.close();
  });

  it('requires a private-space principal and scopes list, detail, original, retry, review, matches, and evidence to it', async () => {
    const noPrivate = { ...principal, privateSpaceId: undefined };
    const denied = buildServices({ principal: noPrivate });
    const deniedApp = await createApp({ services: denied.services });
    expect(
      (
        await deniedApp.inject({
          method: 'GET',
          url: '/api/v1/finance/documents',
          headers: { cookie: mutationHeaders.cookie },
        })
      ).statusCode,
    ).toBe(403);
    await deniedApp.close();

    const { services, financeDocuments } = buildServices();
    const app = await createApp({ services });
    for (const url of [
      '/api/v1/finance/documents',
      `/api/v1/finance/documents/${IDS.document}`,
      `/api/v1/finance/documents/${IDS.document}/original`,
      `/api/v1/finance/documents/${IDS.document}/review`,
      `/api/v1/finance/documents/${IDS.document}/matches`,
      `/api/v1/finance/evidence/${IDS.evidence}`,
    ]) {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: {
          cookie: mutationHeaders.cookie,
          'x-request-id': IDS.approval,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toContain('no-store');
    }
    const original = await app.inject({
      method: 'GET',
      url: `/api/v1/finance/documents/${IDS.document}/original`,
      headers: { cookie: mutationHeaders.cookie },
    });
    expect(original.headers['x-content-type-options']).toBe('nosniff');
    expect(original.headers['content-disposition']).toMatch(/^attachment;/u);
    expect(original.headers['content-disposition']).not.toContain('inline');
    const retry = await app.inject({
      method: 'POST',
      url: `/api/v1/finance/documents/${IDS.document}/retry`,
      headers: mutationHeaders,
    });
    expect(retry.statusCode).toBe(202);
    expect(financeDocuments.list).toHaveBeenCalledWith(
      expect.objectContaining({ principal, requestId: IDS.approval }),
    );
    expect(financeDocuments.get).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: IDS.document, principal }),
    );
    expect(financeDocuments.downloadOriginal).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: IDS.document, principal }),
    );
    expect(financeDocuments.retry).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: IDS.document,
        idempotencyKey: IDEMPOTENCY_KEY,
        principal,
      }),
    );
    expect(financeDocuments.listMatches).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: IDS.document, principal }),
    );
    expect(financeDocuments.getEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ evidenceId: IDS.evidence, principal }),
    );
    await app.close();
  });

  it('denies inaccessible and deleting originals without returning their bytes', async () => {
    const { services, financeDocuments } = buildServices();
    financeDocuments.downloadOriginal
      .mockRejectedValueOnce(
        Object.assign(new Error('provider payload: inaccessible bytes'), {
          code: 'authorization-revoked',
        }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('provider payload: deleting bytes'), {
          code: 'document-state-conflict',
        }),
      );
    const app = await createApp({ services });
    for (const expected of [403, 409]) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/finance/documents/${IDS.document}/original`,
        headers: { cookie: mutationHeaders.cookie },
      });
      expect(response.statusCode).toBe(expected);
      expect(response.body).not.toContain('provider payload');
    }
    await app.close();
  });

  it('permits draft edits and match rejection while holding commit and acceptance for EMDO', async () => {
    const { services, financeDocuments } = buildServices();
    const app = await createApp({ services });
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/finance/documents/${IDS.document}/review`,
      headers: mutationHeaders,
      payload: { schemaVersion: 1, expectedExtractionRevision: 1, envelope },
    });
    const commit = await app.inject({
      method: 'POST',
      url: `/api/v1/finance/documents/${IDS.document}/review/commit`,
      headers: mutationHeaders,
      payload: { schemaVersion: 1, reviewToken: REVIEW_TOKEN },
    });
    const acceptance = await app.inject({
      method: 'POST',
      url: `/api/v1/finance/matches/${IDS.match}/decision`,
      headers: mutationHeaders,
      payload: {
        schemaVersion: 1,
        decision: 'accept',
        reviewToken: REVIEW_TOKEN,
      },
    });
    const rejection = await app.inject({
      method: 'POST',
      url: `/api/v1/finance/matches/${IDS.match}/decision`,
      headers: mutationHeaders,
      payload: {
        schemaVersion: 1,
        decision: 'reject',
        reviewToken: REVIEW_TOKEN,
      },
    });
    expect([
      patch.statusCode,
      commit.statusCode,
      acceptance.statusCode,
      rejection.statusCode,
    ]).toEqual([200, 409, 409, 200]);
    expect(financeDocuments.updateReview).toHaveBeenCalledWith({
      documentId: IDS.document,
      expectedExtractionRevision: 1,
      envelope,
      idempotencyKey: IDEMPOTENCY_KEY,
      principal,
      requestId: expect.any(String),
    });
    expect(financeDocuments.commitReview).not.toHaveBeenCalled();
    expect(financeDocuments.decideMatch).toHaveBeenCalledWith({
      matchId: IDS.match,
      decision: 'reject',
      reviewToken: REVIEW_TOKEN,
      idempotencyKey: IDEMPOTENCY_KEY,
      principal,
      requestId: expect.any(String),
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/finance/documents/${IDS.document}/retry`,
          headers: { cookie: mutationHeaders.cookie },
        })
      ).statusCode,
    ).toBe(403);
    await app.close();
  });

  it('holds deletion for EMDO and maps bounded persistence errors without leaking raw bytes or provider payloads', async () => {
    const { services, financeDocuments } = buildServices();
    financeDocuments.get.mockRejectedValueOnce(
      Object.assign(new Error('raw %PDF provider response'), {
        code: 'document-not-found',
        providerPayload: 'secret',
      }),
    );
    const app = await createApp({ services });
    const absent = await app.inject({
      method: 'DELETE',
      url: `/api/v1/finance/documents/${IDS.document}`,
      headers: mutationHeaders,
    });
    expect(absent.statusCode).toBe(409);
    expect(financeDocuments.delete).not.toHaveBeenCalled();
    const mapped = await app.inject({
      method: 'GET',
      url: `/api/v1/finance/documents/${IDS.document}`,
      headers: { cookie: mutationHeaders.cookie },
    });
    expect(mapped.statusCode).toBe(404);
    expect(mapped.body).not.toContain('raw %PDF provider response');
    expect(mapped.body).not.toContain('secret');
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/finance/documents/${IDS.document}`,
      headers: {
        ...mutationHeaders,
        'x-emdo-approval-decision-id': IDS.approval,
      },
    });
    expect(deleted.statusCode).toBe(409);
    expect(deleted.json()).toMatchObject({ code: 'approval-required' });
    expect(financeDocuments.delete).not.toHaveBeenCalled();
    await app.close();
  });
});

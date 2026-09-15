import { describe, expect, it, vi } from 'vitest';
import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { createApp } from '../app.js';
import { createFailClosedApiServices } from '../production/unavailable-services.js';
import type {
  ApiServices,
  AuthenticatedPrincipal,
} from '../services/contracts.js';
import { extractStructuredFinanceInvoice } from '../../../../packages/integrations/src/finance-documents/structured-invoice-extraction.js';
import { ublInvoice } from '../../../../packages/integrations/src/finance-documents/test-fixtures/structured-invoices.js';
const id = '00000000-0000-4000-8000-000000000001',
  workspace = '00000000-0000-4000-8000-000000000002';
const principal: AuthenticatedPrincipal = {
  userId: id,
  sessionId: id,
  householdId: workspace,
  role: 'owner',
  emailVerified: true,
  spaceAccessGrantId: id,
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema.parse('a'.repeat(64)),
};
const source = extractStructuredFinanceInvoice(
  new TextEncoder().encode(ublInvoice),
);
const review = {
  expectedReviewRevision: 1,
  expectedSourceDigest: source.sourceDigest,
  expectedAdapterVersion: source.adapterVersion,
  kind: 'supplier-bill',
  partyId: id,
  controlAccountId: id,
  acknowledgedSourceParties: true,
  acknowledgedTaxGroupAggregation: true,
  acknowledgedNoConformanceValidation: true,
  groups: source.taxGroups.map((g) => ({
    key: g.key,
    accountId: id,
    taxAccountId: id,
  })),
};
const headers = {
  cookie: '__Secure-emdo.session_token=current',
  'idempotency-key': id,
};
const base = `/api/v2/finance/books/${id}/evidence/${id}/structured-invoice`;
async function fixture(
  options: { authenticated?: boolean; csrf?: boolean; ready?: boolean } = {},
) {
  const auth = {
    authenticate: vi.fn(async () =>
      options.authenticated === false ? null : principal,
    ),
    verifyMutation: vi.fn(async () => options.csrf !== false),
  } as unknown as ApiServices['auth'];
  const api = {
    checkReady: vi.fn(async () => options.ready !== false),
    getStructuredInvoiceReviewDraft: vi.fn(async () => ({
      review: null,
      posting: null,
    })),
    saveStructuredInvoiceReviewDraft: vi.fn(
      async (
        _context: unknown,
        _book: string,
        _evidence: string,
        _key: string,
        input: { expectedRevision: number; draft: unknown },
      ) => ({
        id,
        evidenceId: id,
        revision: input.expectedRevision + 1,
        draft: input.draft,
      }),
    ),
    inspectStructuredInvoice: vi.fn(async () => source),
    postReviewedStructuredInvoice: vi.fn(async () => ({
      id,
      journalId: id,
      total: '113.05',
      currency: 'EUR',
      evidenceId: id,
      sourceDigest: source.sourceDigest,
      adapterVersion: source.adapterVersion,
    })),
  };
  return {
    api,
    app: await createApp({
      services: {
        ...createFailClosedApiServices({ auth }),
        financeV2: api as unknown as NonNullable<ApiServices['financeV2']>,
      },
    }),
  };
}
describe('source-bound structured invoice review routes', () => {
  it('inspects evidence without posting and derives current workspace context', async () => {
    const { app, api } = await fixture();
    try {
      const result = await app.inject({ method: 'GET', url: base, headers });
      expect(result.statusCode).toBe(200);
      expect(result.json().conformance).toBe('not-validated');
      expect(api.inspectStructuredInvoice).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: workspace, userId: id }),
        id,
        id,
      );
      expect(api.postReviewedStructuredInvoice).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('saves and reads a scoped incomplete draft with revision CAS', async () => {
    const { app, api } = await fixture();
    try {
      const { expectedReviewRevision, ...complete } = review;
      expect(expectedReviewRevision).toBe(1);
      const draft = {
        ...complete,
        partyId: null,
        acknowledgedSourceParties: false,
      };
      const result = await app.inject({
        method: 'POST',
        url: `${base}/review-draft`,
        headers,
        payload: { expectedRevision: 0, draft },
      });
      expect(result.statusCode).toBe(200);
      expect(result.json().revision).toBe(1);
      expect(api.saveStructuredInvoiceReviewDraft).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: workspace, userId: id }),
        id,
        id,
        id,
        { expectedRevision: 0, draft },
      );
      const read = await app.inject({
        method: 'GET',
        url: `${base}/review-draft`,
        headers,
      });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toEqual({ review: null, posting: null });
    } finally {
      await app.close();
    }
  });
  it('forwards source digest, full review acknowledgement and scoped evidence to explicit posting', async () => {
    const { app, api } = await fixture();
    try {
      const result = await app.inject({
        method: 'POST',
        url: `${base}/review-and-post`,
        headers,
        payload: review,
      });
      expect(result.statusCode).toBe(200);
      expect(api.postReviewedStructuredInvoice).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: workspace }),
        id,
        id,
        id,
        review,
      );
    } finally {
      await app.close();
    }
  });
  it.each([
    { authenticated: false, status: 401 },
    { csrf: false, status: 403 },
    { ready: false, status: 503 },
  ])('blocks untrusted mutation %j', async (options) => {
    const { app, api } = await fixture(options);
    try {
      const result = await app.inject({
        method: 'POST',
        url: `${base}/review-and-post`,
        headers,
        payload: review,
      });
      expect(result.statusCode).toBe(options.status);
      expect(api.postReviewedStructuredInvoice).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it.each([
    { ...review, lines: [{ netAmount: '1' }] },
    { ...review, acknowledgedSourceParties: false },
    { ...review, workspaceId: workspace },
  ])('rejects caller amount overrides and missing review', async (payload) => {
    const { app, api } = await fixture();
    try {
      const result = await app.inject({
        method: 'POST',
        url: `${base}/review-and-post`,
        headers,
        payload,
      });
      expect(result.statusCode).toBe(400);
      expect(api.postReviewedStructuredInvoice).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

import { describe, it, expect, vi } from 'vitest';
import {
  EffectiveAuthorizationScopeFingerprintSchema,
  FinanceStandardizationRunSchema,
} from '@emdo/contracts';
import { createApp } from '../app.js';
import { createFailClosedApiServices } from '../production/unavailable-services.js';
import type {
  ApiServices,
  AuthenticatedPrincipal,
} from '../services/contracts.js';
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
const run = FinanceStandardizationRunSchema.parse({
  id,
  workspaceId: workspace,
  bookId: id,
  evidenceId: id,
  filename: 'statement.csv',
  format: 'csv',
  sourceDigest: 'b'.repeat(64),
  revision: 1,
  attempt: 0,
  status: 'queued',
  authorizedByUserId: id,
  authorizationExpiresAt: '2026-10-01T00:00:00Z',
  createdAt: '2026-09-14T00:00:00Z',
  updatedAt: '2026-09-14T00:00:00Z',
  extraction: null,
  proposal: null,
  modelProvenance: null,
  blockers: [],
  allowedActions: ['cancel'],
  approval: 'not-granted',
  posting: 'not-performed',
});
const headers = {
    cookie: '__Secure-emdo.session_token=current',
    'idempotency-key': id,
  },
  base = `/api/v2/finance/books/${id}/standardizations`;
async function fixture(
  options: { authenticated?: boolean; csrf?: boolean; ready?: boolean } = {},
) {
  const auth = {
    authenticate: vi.fn(async () =>
      options.authenticated === false ? null : principal,
    ),
    verifyMutation: vi.fn(async () => options.csrf !== false),
  } as unknown as ApiServices['auth'];
  const service = {
    checkReady: vi.fn(async () => true),
    available: vi.fn(async () => true),
    list: vi.fn(async () => ({ runs: [run], nextOffset: null })),
    get: vi.fn(async () => run),
    start: vi.fn(async () => run),
    change: vi.fn(async () => run),
    reconciliation: vi.fn(),
    requestReceiptLookup: vi.fn(),
    resolveOutcome: vi.fn(),
    linkMapping: vi.fn(async () => run),
  };
  const app = await createApp({
    services: {
      ...createFailClosedApiServices({ auth }),
      financeV2: {
        checkReady: async () => options.ready !== false,
      } as NonNullable<ApiServices['financeV2']>,
      financeStandardization: service,
    },
  });
  return { app, service };
}
describe('authenticated source-bound standardization lifecycle', () => {
  it('creates a saved run with trusted workspace and exact original binding', async () => {
    const { app, service } = await fixture();
    try {
      const input = { evidenceId: id, expectedSourceDigest: run.sourceDigest };
      const response = await app.inject({
        method: 'POST',
        url: base,
        headers,
        payload: input,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: 'queued',
        approval: 'not-granted',
        posting: 'not-performed',
      });
      expect(service.start).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: workspace, userId: id }),
        id,
        id,
        input,
      );
    } finally {
      await app.close();
    }
  });
  it.each([
    { authenticated: false, status: 401 },
    { csrf: false, status: 403 },
    { ready: false, status: 503 },
  ])('blocks untrusted or disabled creation %j', async (options) => {
    const { app, service } = await fixture(options);
    try {
      const response = await app.inject({
        method: 'POST',
        url: base,
        headers,
        payload: { evidenceId: id, expectedSourceDigest: run.sourceDigest },
      });
      expect(response.statusCode).toBe(options.status);
      expect(service.start).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('rejects caller grant/context and forwards retry revision', async () => {
    const { app, service } = await fixture();
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: base,
            headers,
            payload: {
              evidenceId: id,
              expectedSourceDigest: run.sourceDigest,
              workspaceId: workspace,
            },
          })
        ).statusCode,
      ).toBe(400);
      const result = await app.inject({
        method: 'POST',
        url: `${base}/${id}/retry`,
        headers,
        payload: { expectedRevision: 1 },
      });
      expect(result.statusCode).toBe(200);
      expect(service.change).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: workspace }),
        id,
        id,
        'retry',
        id,
        { expectedRevision: 1 },
      );
    } finally {
      await app.close();
    }
  });
  it('links a separately saved candidate using trusted scope and an exact run revision', async () => {
    const { app, service } = await fixture();
    try {
      service.linkMapping.mockResolvedValueOnce({
        ...run,
        revision: 2,
        reviewedMapping: {
          mappingId: id,
          mappingVersion: 1,
          status: 'candidate',
        },
      });
      const response = await app.inject({
        method: 'POST',
        url: `${base}/${id}/reviewed-mapping`,
        headers,
        payload: { expectedRevision: 1, mappingId: id },
      });
      expect(response.statusCode).toBe(200);
      expect(service.linkMapping).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: workspace, userId: id }),
        id,
        id,
        id,
        { expectedRevision: 1, mappingId: id },
      );
      expect(response.json().reviewedMapping).toMatchObject({
        mappingId: id,
        status: 'candidate',
      });
      const mismatch = await app.inject({
        method: 'POST',
        url: `${base}/${id}/reviewed-mapping`,
        headers,
        payload: { expectedRevision: 1, mappingId: id },
      });
      expect(mismatch.statusCode).toBe(502);
    } finally {
      await app.close();
    }
  });
  it('requires exact scoped reconciliation evidence, forwards revision and disallows caller cost facts', async () => {
    const { app, service } = await fixture();
    const reconciliation = {
      runId: id,
      workspaceId: workspace,
      bookId: id,
      sourceDigest: run.sourceDigest,
      revision: 2,
      status: 'indeterminate',
      hasLiveLease: false,
      canResolve: true,
      spend: [],
      receipts: [],
      resolutions: [],
    };
    service.reconciliation.mockResolvedValue(reconciliation);
    service.requestReceiptLookup.mockResolvedValue(reconciliation);
    service.resolveOutcome.mockResolvedValue(reconciliation);
    try {
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `${base}/${id}/reconciliation`,
            headers,
          })
        ).statusCode,
      ).toBe(200);
      const lookup = { expectedRevision: 2, reservationId: id };
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `${base}/${id}/reconciliation/lookup`,
            headers,
            payload: lookup,
          })
        ).statusCode,
      ).toBe(200);
      expect(service.requestReceiptLookup).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: workspace, userId: id }),
        id,
        id,
        id,
        lookup,
      );
      const resolve = {
        expectedRevision: 2,
        reservationId: null,
        decision: 'confirm-not-sent',
        receiptId: null,
        acknowledgeNoApproval: true,
      };
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `${base}/${id}/reconciliation/resolve`,
            headers,
            payload: resolve,
          })
        ).statusCode,
      ).toBe(200);
      expect(service.resolveOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: workspace }),
        id,
        id,
        id,
        resolve,
      );
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `${base}/${id}/reconciliation/resolve`,
            headers,
            payload: { ...resolve, actualCadMinor: 0 },
          })
        ).statusCode,
      ).toBe(400);
      service.reconciliation.mockResolvedValueOnce({
        ...reconciliation,
        workspaceId: id,
      });
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `${base}/${id}/reconciliation`,
            headers,
          })
        ).statusCode,
      ).toBe(502);
    } finally {
      await app.close();
    }
  });
  it('fails closed on wrong-scope results and distinguishes implemented OCR from service readiness', async () => {
    const { app, service } = await fixture();
    try {
      service.get.mockResolvedValueOnce({ ...run, workspaceId: id });
      expect(
        (await app.inject({ method: 'GET', url: `${base}/${id}`, headers }))
          .statusCode,
      ).toBe(502);
      service.available.mockResolvedValueOnce(false);
      const options = await app.inject({
        method: 'GET',
        url: `${base}/options`,
        headers,
      });
      expect(options.statusCode).toBe(200);
      expect(
        options
          .json()
          .registry.adapters.find(
            (a: { id: string }) => a.id === 'finance.image-ocr',
          ),
      ).toMatchObject({
        availability: 'implemented',
        workflow: 'dynamic-mapping',
        limitations: expect.arrayContaining([
          expect.stringContaining(
            'Requires installed local ImageMagick/Tesseract',
          ),
          expect.stringContaining('unavailable runtimes produce no OCR facts'),
          expect.stringContaining('explicit original-image region review'),
        ]),
      });
      expect(options.json()).toMatchObject({
        ready: false,
        reason: expect.any(String),
      });
    } finally {
      await app.close();
    }
  });
});

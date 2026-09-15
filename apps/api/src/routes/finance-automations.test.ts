import { describe, expect, it, vi } from 'vitest';
import {
  FinanceAutomationCapabilitySchema,
  EffectiveAuthorizationScopeFingerprintSchema,
} from '@emdo/contracts';
import { createApp } from '../app.js';
import { createFailClosedApiServices } from '../production/unavailable-services.js';
import type {
  ApiServices,
  AuthenticatedPrincipal,
} from '../services/contracts.js';
const userId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f70',
  bookId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f72';
const principal: AuthenticatedPrincipal = {
  userId,
  sessionId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f71',
  householdId: bookId,
  role: 'owner',
  emailVerified: true,
  spaceAccessGrantId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f74',
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema.parse('7'.repeat(64)),
};
const headers = {
  cookie: '__Secure-emdo.session_token=current',
  'idempotency-key': '11111111-1111-4111-8111-111111111111',
};
const grant = {
  capabilities: ['finance.reports.generate'],
  limits: {
    maxRuns: 2,
    maxAttemptsPerRun: 2,
    maxItemsPerRun: 1,
    maxTotalItems: 2,
    currency: 'CAD',
    maxAmountPerRun: '0.00',
    maxTotalAmount: '0.00',
  },
  validFrom: '2026-09-01T00:00:00Z',
  expiresAt: '2026-10-01T00:00:00Z',
};
const grantRecord = {
  id: userId,
  revision: 1,
  workspaceId: bookId,
  bookId,
  grantedByUserId: userId,
  executor: 'emdo-managed',
  specialist: 'finance',
  status: 'active',
  allowedCapabilities: grant.capabilities,
  authorityRevision: { membership: 1, bookAccess: 1, entitlement: 1 },
  limits: grant.limits,
  validFrom: grant.validFrom,
  expiresAt: grant.expiresAt,
};
const runRecord = {
  run: {
    request: {
      operationId: userId,
      grantId: bookId,
      grantRevision: 1,
      workspaceId: bookId,
      bookId,
      capability: 'finance.reports.generate' as const,
      requestHash: 'a'.repeat(64),
      itemCount: 1,
      currency: 'CAD' as const,
      amount: '0.00',
    },
    revision: 1,
    attempts: 0,
    status: 'queued' as const,
    outcomeReference: null,
  },
  createdAt: '2026-09-13T00:00:00Z',
  blockedReason: null,
};
function fixture(verified = true, authenticated = true) {
  const auth = {
    authenticate: vi.fn(async () => (authenticated ? principal : undefined)),
    verifyMutation: vi.fn(async () => verified),
  } as unknown as ApiServices['auth'];
  const financeAutomations = {
    checkReady: vi.fn(async () => true),
    readExtractionResult: vi.fn(async () => ({
      schemaVersion: 1,
      kind: 'finance-document-extraction',
      operationId: userId,
      workspaceId: bookId,
      bookId,
      evidenceId: userId,
      sourceDigest: 'a'.repeat(64),
      standardizationRunId: userId,
      extractionRevision: 1,
      extractionDigest: 'b'.repeat(64),
      summary: {
        revision: 1,
        adapterId: 'finance.csv-table',
        adapterVersion: '1',
        sourceDigest: 'a'.repeat(64),
        extractionDigest: 'b'.repeat(64),
        status: 'extracted',
        tableCount: 1,
        sheetCount: 0,
        pageCount: 0,
        truncated: false,
        issues: [],
      },
      approval: 'not-granted',
      posting: 'not-performed',
    })),
    prepareExtraction: vi.fn(
      async (
        _context: unknown,
        _book: string,
        _key: string,
        input: { evidenceId: string; expectedSourceDigest: string },
      ) => ({
        schemaVersion: 1,
        ...input,
        standardizationRunId: userId,
        expectedRunRevision: 1,
        expectedExtractionRevision: 0,
      }),
    ),
    listGrants: vi.fn(async (): Promise<unknown> => [grantRecord]),
    listRuns: vi.fn(async () => ({
      runs: [runRecord],
      nextOffset: null as number | null,
    })),
    getRun: vi.fn(async () => runRecord as typeof runRecord | null),
    createGrant: vi.fn(
      async (
        _context: unknown,
        _book: string,
        input: {
          id: string;
          capabilities: string[];
          limits: typeof grant.limits;
          validFrom: string;
          expiresAt: string;
        },
      ): Promise<unknown> => ({
        ...grantRecord,
        id: input.id,
        allowedCapabilities: input.capabilities,
        limits: input.limits,
        validFrom: input.validFrom,
        expiresAt: input.expiresAt,
      }),
    ),
    revokeGrant: vi.fn(async (): Promise<unknown> => ({
      ...grantRecord,
      status: 'revoked',
    })),
    enqueueRun: vi.fn(
      async (_context: unknown, _book: string, input: unknown) => input,
    ),
  };
  return {
    financeAutomations,
    services: {
      ...createFailClosedApiServices({ auth }),
      financeAutomations: financeAutomations as unknown as NonNullable<
        ApiServices['financeAutomations']
      >,
    },
  };
}
describe('Finance automation management authority', () => {
  it('validates grant listings and rejects malformed or foreign service responses', async () => {
    const f = fixture(),
      app = await createApp({ services: f.services });
    const request = {
      method: 'GET' as const,
      url: `/api/v2/finance/books/${bookId}/automations/grants`,
      headers,
    };
    try {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ grants: [grantRecord] });
      expect(response.headers['cache-control']).toBe('no-store, private');
      for (const invalid of [
        { grants: [] },
        [{}],
        [{ ...grantRecord, workspaceId: userId }],
        [{ ...grantRecord, bookId: userId }],
      ]) {
        f.financeAutomations.listGrants.mockResolvedValueOnce(invalid);
        expect((await app.inject(request)).statusCode).toBe(502);
      }
    } finally {
      await app.close();
    }
  });
  it('rejects malformed and mismatched grant creation and revocation responses', async () => {
    const f = fixture(),
      app = await createApp({ services: f.services });
    const create = {
      method: 'POST' as const,
      url: `/api/v2/finance/books/${bookId}/automations/grants`,
      headers,
      payload: grant,
    };
    try {
      const valid = (await app.inject(create)).json();
      for (const invalid of [
        {},
        { ...valid, workspaceId: userId },
        { ...valid, bookId: userId },
        { ...valid, id: userId },
        { ...valid, grantedByUserId: bookId },
      ]) {
        f.financeAutomations.createGrant.mockResolvedValueOnce(invalid);
        expect((await app.inject(create)).statusCode).toBe(502);
      }
      const revoke = {
        ...create,
        url: `${create.url}/${userId}/revoke`,
        payload: {},
      };
      for (const invalid of [
        { status: 'revoked' },
        { ...grantRecord, status: 'revoked', workspaceId: userId },
        { ...grantRecord, status: 'revoked', bookId: userId },
        { ...grantRecord, status: 'revoked', id: bookId },
        grantRecord,
      ]) {
        f.financeAutomations.revokeGrant.mockResolvedValueOnce(invalid);
        expect((await app.inject(revoke)).statusCode).toBe(502);
      }
    } finally {
      await app.close();
    }
  });
  it('binds journal automation to one exact batch and rejects mixed intents', async () => {
    const f = fixture(),
      app = await createApp({ services: f.services });
    const journal = {
      schemaVersion: 1,
      batchId: userId,
      expectedBatchRevision: 3,
      expectedSnapshotHash: 'a'.repeat(64),
    };
    const payload = {
      grantId: userId,
      capability: 'finance.journals.draft',
      targets: [userId],
      currency: 'CAD',
      amount: '123.45',
      journal,
    };
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v2/finance/books/${bookId}/automations/runs`,
            headers,
            payload,
          })
        ).statusCode,
      ).toBe(200);
      expect(f.financeAutomations.enqueueRun).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: bookId, userId }),
        bookId,
        expect.objectContaining({
          journal,
          targets: [userId],
          amount: '123.45',
        }),
      );
      for (const changes of [
        { journal: undefined },
        { targets: [bookId] },
        { targets: [userId, bookId] },
        { report: { kind: 'trial-balance' } },
        { capability: 'finance.reports.generate' },
      ]) {
        expect(
          (
            await app.inject({
              method: 'POST',
              url: `/api/v2/finance/books/${bookId}/automations/runs`,
              headers,
              payload: { ...payload, ...changes },
            })
          ).statusCode,
        ).toBe(400);
      }
      expect(f.financeAutomations.enqueueRun).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('does not read extraction results without a current authenticated principal', async () => {
    const f = fixture(true, false),
      app = await createApp({ services: f.services });
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v2/finance/books/${bookId}/automations/extractions/results/${userId}`,
        headers,
      });
      expect(response.statusCode).toBe(401);
      expect(f.financeAutomations.readExtractionResult).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('reads saved extraction outcomes under current scope and rejects cross-book substitution', async () => {
    const f = fixture(),
      app = await createApp({ services: f.services });
    try {
      const request = {
        method: 'GET' as const,
        url: `/api/v2/finance/books/${bookId}/automations/extractions/results/${userId}`,
        headers,
      };
      const result = await app.inject(request);
      expect(result.statusCode).toBe(200);
      expect(result.headers['cache-control']).toBe('no-store, private');
      expect(result.json()).toMatchObject({
        operationId: userId,
        approval: 'not-granted',
        posting: 'not-performed',
      });
      f.financeAutomations.readExtractionResult.mockResolvedValueOnce({
        ...result.json(),
        bookId: userId,
      });
      expect((await app.inject(request)).statusCode).toBe(502);
    } finally {
      await app.close();
    }
  });

  it('enqueues exact prepared extraction and rejects mismatched source or nonzero amount', async () => {
    const f = fixture(),
      app = await createApp({ services: f.services });
    try {
      const extraction = {
        schemaVersion: 1,
        evidenceId: userId,
        expectedSourceDigest: 'a'.repeat(64),
        standardizationRunId: bookId,
        expectedRunRevision: 1,
        expectedExtractionRevision: 0,
      };
      const payload = {
        grantId: userId,
        capability: 'finance.documents.extract',
        targets: [userId],
        currency: 'CAD',
        amount: '0',
        extraction,
      };
      const request = {
        method: 'POST' as const,
        url: `/api/v2/finance/books/${bookId}/automations/runs`,
        headers,
        payload,
      };
      expect((await app.inject(request)).statusCode).toBe(200);
      expect(f.financeAutomations.enqueueRun).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: bookId, userId }),
        bookId,
        expect.objectContaining({
          ...payload,
          operationId: expect.any(String),
        }),
      );
      for (const override of [
        { targets: [bookId] },
        { amount: '1' },
        { extraction: undefined },
        { capability: 'finance.reports.generate' },
      ])
        expect(
          (
            await app.inject({
              ...request,
              payload: { ...payload, ...override },
            })
          ).statusCode,
        ).toBe(400);
      expect(f.financeAutomations.enqueueRun).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('prepares an inert document-bound extraction without enqueueing and rejects response substitution', async () => {
    const f = fixture(),
      app = await createApp({ services: f.services });
    try {
      const request = {
        method: 'POST' as const,
        url: `/api/v2/finance/books/${bookId}/automations/extractions/prepare`,
        headers,
        payload: { evidenceId: userId, expectedSourceDigest: 'a'.repeat(64) },
      };
      const result = await app.inject(request);
      expect(result.statusCode).toBe(200);
      expect(result.headers['cache-control']).toBe('no-store, private');
      expect(result.json()).toMatchObject({
        expectedExtractionRevision: 0,
        evidenceId: userId,
      });
      expect(f.financeAutomations.enqueueRun).not.toHaveBeenCalled();
      const preparedKey =
        f.financeAutomations.prepareExtraction.mock.calls[0]![2];
      expect(preparedKey).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect((await app.inject(request)).statusCode).toBe(200);
      expect(f.financeAutomations.prepareExtraction.mock.calls[1]![2]).toBe(
        preparedKey,
      );

      f.financeAutomations.prepareExtraction.mockResolvedValueOnce({
        ...result.json(),
        expectedSourceDigest: 'b'.repeat(64),
      });
      expect((await app.inject(request)).statusCode).toBe(502);
    } finally {
      await app.close();
    }
  });
  it('denies extraction preparation before repository access when mutation verification fails', async () => {
    const f = fixture(false),
      app = await createApp({ services: f.services });
    try {
      const result = await app.inject({
        method: 'POST',
        url: `/api/v2/finance/books/${bookId}/automations/extractions/prepare`,
        headers,
        payload: { evidenceId: userId, expectedSourceDigest: 'a'.repeat(64) },
      });
      expect(result.statusCode).toBe(403);
      expect(f.financeAutomations.prepareExtraction).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('reads current scoped run history and preserves exact amounts and outcome status', async () => {
    const f = fixture(),
      app = await createApp({ services: f.services });
    try {
      const page = await app.inject({
        method: 'GET',
        url: `/api/v2/finance/books/${bookId}/automations/runs?limit=1`,
        headers,
      });
      expect(page.statusCode).toBe(200);
      expect(page.json()).toEqual({ runs: [runRecord], nextOffset: null });
      expect(f.financeAutomations.listRuns).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: bookId, userId }),
        bookId,
        0,
        1,
      );
      const detail = await app.inject({
        method: 'GET',
        url: `/api/v2/finance/books/${bookId}/automations/runs/${userId}`,
        headers,
      });
      expect(detail.json()).toEqual(runRecord);
      expect(detail.headers['cache-control']).toBe('no-store, private');
      f.financeAutomations.getRun.mockResolvedValueOnce(null);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/v2/finance/books/${bookId}/automations/runs/${userId}`,
            headers,
          })
        ).statusCode,
      ).toBe(404);
      f.financeAutomations.listRuns.mockRejectedValueOnce(
        Object.assign(new Error('automation-admin-required'), {
          name: 'FinanceV2PersistenceError',
          code: 'authorization-revoked',
        }),
      );
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/v2/finance/books/${bookId}/automations/runs`,
            headers,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/v2/finance/books/${bookId}/automations/runs?limit=101`,
            headers,
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
  it('rejects mismatched run scope and corrupt pagination before returning records', async () => {
    const f = fixture(),
      app = await createApp({ services: f.services });
    try {
      const wrong = {
        ...runRecord,
        run: {
          ...runRecord.run,
          request: { ...runRecord.run.request, workspaceId: userId },
        },
      };
      f.financeAutomations.getRun.mockResolvedValueOnce(wrong);
      const bad = await app.inject({
        method: 'GET',
        url: `/api/v2/finance/books/${bookId}/automations/runs/${userId}`,
        headers,
      });
      expect(bad.statusCode).toBe(502);
      expect(bad.body).not.toContain(runRecord.run.request.requestHash);
      f.financeAutomations.listRuns.mockResolvedValueOnce({
        runs: [runRecord],
        nextOffset: 0,
      });
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/v2/finance/books/${bookId}/automations/runs?limit=1`,
            headers,
          })
        ).statusCode,
      ).toBe(502);
    } finally {
      await app.close();
    }
  });
  it('requires browser mutation proof before dispatch', async () => {
    const f = fixture(false),
      app = await createApp({ services: f.services });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v2/finance/books/${bookId}/automations/grants`,
        headers,
        payload: grant,
      });
      expect(response.statusCode).toBe(403);
      expect(f.financeAutomations.createGrant).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('derives stable retry IDs from trusted scope and rejects caller authority fields', async () => {
    const f = fixture(),
      app = await createApp({ services: f.services });
    try {
      const request = {
        method: 'POST' as const,
        url: `/api/v2/finance/books/${bookId}/automations/grants`,
        headers,
        payload: grant,
      };
      const first = await app.inject(request),
        replay = await app.inject(request);
      expect(first.statusCode).toBe(200);
      expect(first.json().id).toBe(replay.json().id);
      expect(first.json().id).toMatch(/^[a-f0-9-]{14}8/);
      expect(f.financeAutomations.createGrant).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: bookId, userId }),
        bookId,
        expect.objectContaining({ limits: grant.limits }),
      );
      const changedKey = await app.inject({
        ...request,
        headers: {
          ...headers,
          'idempotency-key': '22222222-2222-4222-8222-222222222222',
        },
      });
      expect(changedKey.json().id).not.toBe(first.json().id);
      const injection = await app.inject({
        ...request,
        payload: { ...grant, workspaceId: userId, id: userId },
      });
      expect(injection.statusCode).toBe(400);
      expect(f.financeAutomations.createGrant).toHaveBeenCalledTimes(3);
      expect(first.headers['cache-control']).toBe('no-store, private');
    } finally {
      await app.close();
    }
  });
  it('accepts exact planning selections and grants across all registered capabilities', async () => {
    const f = fixture(),
      app = await createApp({ services: f.services });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v2/finance/books/${bookId}/automations/grants`,
        headers,
        payload: {
          ...grant,
          capabilities: FinanceAutomationCapabilitySchema.options,
        },
      });
      expect(response.statusCode).toBe(200);
      const duplicate = await app.inject({
        method: 'POST',
        url: `/api/v2/finance/books/${bookId}/automations/grants`,
        headers,
        payload: {
          ...grant,
          capabilities: [
            'finance.reports.generate',
            'finance.reports.generate',
          ],
        },
      });
      expect(duplicate.statusCode).toBe(400);
      for (const planning of [
        {
          schemaVersion: 1,
          capability: 'finance.planning.budget-vs-actuals',
          budgetId: bookId,
          budgetRevision: 3,
          asOf: null,
          currency: 'CAD',
          itemCount: 2,
        },
        {
          schemaVersion: 1,
          capability: 'finance.planning.forecast',
          budgetId: bookId,
          budgetRevision: 3,
          asOf: '2026-09-14',
          currency: 'CAD',
          itemCount: 2,
          openingBalance: {
            status: 'unavailable',
            label: 'opening-balance-unavailable',
          },
          assumptions: [],
        },
      ]) {
        const request = {
          method: 'POST' as const,
          url: `/api/v2/finance/books/${bookId}/automations/runs`,
          headers,
          payload: {
            grantId: userId,
            capability: planning.capability,
            targets: [bookId],
            currency: 'CAD',
            amount: '0.00',
            planning,
          },
        };
        expect((await app.inject(request)).statusCode).toBe(200);
        expect(f.financeAutomations.enqueueRun).toHaveBeenLastCalledWith(
          expect.objectContaining({ userId, workspaceId: bookId }),
          bookId,
          expect.objectContaining({ planning, amount: '0.00' }),
        );
        const rejected = await app.inject({
          ...request,
          payload: {
            ...request.payload,
            planning: { ...planning, planningReview: { approved: true } },
          },
        });
        expect(rejected.statusCode).toBe(400);
      }
      expect(f.financeAutomations.enqueueRun).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
  it('supports bounded enqueue and revocation without specialist or session authority in the body', async () => {
    const f = fixture(),
      app = await createApp({ services: f.services });
    try {
      const queued = await app.inject({
        method: 'POST',
        url: `/api/v2/finance/books/${bookId}/automations/runs`,
        headers,
        payload: {
          grantId: userId,
          capability: 'finance.reports.generate',
          targets: [bookId],
          currency: 'CAD',
          amount: '0',
        },
      });
      expect(queued.statusCode).toBe(200);
      expect(queued.json()).toMatchObject({
        grantId: userId,
        operationId: expect.any(String),
        targets: [bookId],
      });
      const revoked = await app.inject({
        method: 'POST',
        url: `/api/v2/finance/books/${bookId}/automations/grants/${userId}/revoke`,
        headers,
        payload: {},
      });
      expect(revoked.statusCode).toBe(200);
      expect(f.financeAutomations.revokeGrant).toHaveBeenCalledWith(
        expect.objectContaining({ userId }),
        bookId,
        userId,
      );
    } finally {
      await app.close();
    }
  });
  it('requires authentication for listings and rejects an unavailable authority service', async () => {
    const f = fixture(true, false),
      app = await createApp({ services: f.services });
    try {
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/v2/finance/books/${bookId}/automations/grants`,
            headers,
          })
        ).statusCode,
      ).toBe(401);
      expect(f.financeAutomations.listGrants).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
    const available = fixture();
    available.financeAutomations.checkReady.mockResolvedValue(false);
    const second = await createApp({ services: available.services });
    try {
      expect(
        (
          await second.inject({
            method: 'GET',
            url: `/api/v2/finance/books/${bookId}/automations/grants`,
            headers,
          })
        ).statusCode,
      ).toBe(503);
    } finally {
      await second.close();
    }
  });
});

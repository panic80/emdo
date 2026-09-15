import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  EffectiveAuthorizationScopeFingerprintSchema,
  type FinanceOpeningProof,
} from '@emdo/contracts';
import { installProblemHandler } from '../problem.js';
import { createFailClosedApiServices } from '../production/unavailable-services.js';
import type {
  ApiServices,
  AuthenticatedPrincipal,
} from '../services/contracts.js';
import {
  registerFinanceOpeningRoutes,
  type FinanceOpeningRouteService,
} from './finance-openings.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const workspaceId = id(1),
  bookId = id(2),
  userId = id(3),
  migrationId = id(4),
  recordId = id(5),
  accountId = id(6),
  idempotencyKey = id(7);
const principal: AuthenticatedPrincipal = {
  userId,
  sessionId: id(8),
  householdId: workspaceId,
  role: 'owner',
  emailVerified: true,
  spaceAccessGrantId: id(9),
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema.parse('a'.repeat(64)),
};
const proof: FinanceOpeningProof = {
  id: id(10),
  workspaceId,
  bookId,
  financialAccountId: accountId,
  sourceSpaceId: id(11),
  sourceOwnerUserId: userId,
  sourceKind: 'legacy-migration',
  migrationId,
  sourceRecordId: recordId,
  sourceRevision: 1,
  sourceSnapshotHash: 'a'.repeat(64),
  reviewId: id(12),
  evidenceId: id(13),
  evidenceDigest: 'b'.repeat(64),
  effectiveOn: '2026-08-01',
  amountCadMinor: '123456',
  ledgerAccountId: id(14),
  counterpartLedgerAccountId: id(15),
  journalId: id(16),
  postedBy: userId,
  postedAt: '2026-09-14T00:00:00.000Z',
  supersedesProofId: null,
};
const payload = {
  expectedRunRevision: 2,
  expectedRecordRevision: 1,
  expectedSourceSnapshotHash: proof.sourceSnapshotHash,
  idempotencyKey,
};
const headers = {
  cookie: '__Secure-emdo.session_token=current',
  'idempotency-key': idempotencyKey,
};
const postUrl = `/api/v2/finance/books/${bookId}/legacy-migrations/${migrationId}/records/${recordId}/opening`;
const getUrl = `/api/v2/finance/books/${bookId}/financial-accounts/${accountId}/opening`;
async function fixture(
  options: {
    authenticated?: boolean;
    csrf?: boolean;
    ready?: boolean;
    absent?: boolean;
  } = {},
) {
  const auth = {
    authenticate: vi.fn(async () =>
      options.authenticated === false ? undefined : principal,
    ),
    verifyMutation: vi.fn(async () => options.csrf !== false),
  } as unknown as ApiServices['auth'];
  const api: FinanceOpeningRouteService = {
    checkReady: vi.fn(async () => options.ready !== false),
    postLegacyOpening: vi.fn(async () => proof),
    getLatest: vi.fn(async () => proof),
  };
  const services = {
    ...createFailClosedApiServices({ auth }),
    ...(options.absent ? {} : { financeOpenings: api }),
  } as unknown as ApiServices;
  const app = Fastify({ logger: false, genReqId: () => id(17) });
  installProblemHandler(app);
  registerFinanceOpeningRoutes(app, services, 1_000_000);
  return { app, api };
}

describe('Finance opening proof HTTP boundary', () => {
  it('reads the current account opening proof in its authenticated book and owner scope', async () => {
    const { app, api } = await fixture();
    try {
      const result = await app.inject({ method: 'GET', url: getUrl, headers });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({ opening: proof });
      expect(result.headers['cache-control']).toBe('no-store, private');
      expect(api.getLatest).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId,
          userId,
          sessionId: principal.sessionId,
        }),
        bookId,
        accountId,
      );
    } finally {
      await app.close();
    }
  });
  it('posts only reviewed revisions and source hash, and returns persisted opening proof', async () => {
    const { app, api } = await fixture();
    try {
      const result = await app.inject({
        method: 'POST',
        url: postUrl,
        headers,
        payload,
      });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual(proof);
      expect(result.headers['cache-control']).toBe('no-store, private');
      expect(api.postLegacyOpening).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId, userId }),
        bookId,
        migrationId,
        recordId,
        payload,
      );
    } finally {
      await app.close();
    }
  });
  it('returns an explicit nullable opening when no posted proof exists', async () => {
    const { app, api } = await fixture();
    vi.mocked(api.getLatest).mockResolvedValue(null);
    try {
      const result = await app.inject({ method: 'GET', url: getUrl, headers });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({ opening: null });
    } finally {
      await app.close();
    }
  });
  it.each([
    { authenticated: false, status: 401 },
    { ready: false, status: 503 },
    { absent: true, status: 503 },
  ])(
    'requires authentication and readiness for GET and POST (%j)',
    async (options) => {
      const { app, api } = await fixture(options);
      try {
        for (const method of ['GET', 'POST'] as const) {
          const result = await app.inject({
            method,
            url: method === 'GET' ? getUrl : postUrl,
            headers,
            ...(method === 'POST' ? { payload } : {}),
          });
          expect(result.statusCode).toBe(options.status);
        }
        expect(api.getLatest).not.toHaveBeenCalled();
        expect(api.postLegacyOpening).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );
  it('rejects invalid CSRF proof before any post call', async () => {
    const { app, api } = await fixture({ csrf: false });
    try {
      expect(
        (await app.inject({ method: 'POST', url: postUrl, headers, payload }))
          .statusCode,
      ).toBe(403);
      expect(api.postLegacyOpening).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('rejects missing or mismatched idempotency keys without posting', async () => {
    const { app, api } = await fixture();
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: postUrl,
            headers: { cookie: headers.cookie },
            payload,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: postUrl,
            headers,
            payload: { ...payload, idempotencyKey: id(90) },
          })
        ).statusCode,
      ).toBe(400);
      expect(api.postLegacyOpening).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it.each([
    { amountCadMinor: '9999' },
    { amount: '99.99' },
    { effectiveOn: '2026-01-01' },
    { openingEffectiveOn: '2026-01-01' },
    { postedOn: '2026-01-01' },
  ])('rejects client supplied amount or date %j', async (extra) => {
    const { app, api } = await fixture();
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: postUrl,
            headers,
            payload: { ...payload, ...extra },
          })
        ).statusCode,
      ).toBe(400);
      expect(api.postLegacyOpening).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it.each([
    'workspaceId',
    'bookId',
    'migrationId',
    'sourceRecordId',
    'sourceOwnerUserId',
  ] as const)('rejects POST proof with mismatched %s', async (field) => {
    const { app, api } = await fixture();
    vi.mocked(api.postLegacyOpening).mockResolvedValue({
      ...proof,
      [field]: id(90),
    });
    try {
      const result = await app.inject({
        method: 'POST',
        url: postUrl,
        headers,
        payload,
      });
      expect(result.statusCode).toBe(502);
      expect(result.body).not.toContain(proof.evidenceDigest);
    } finally {
      await app.close();
    }
  });
  it.each([
    'workspaceId',
    'bookId',
    'financialAccountId',
    'sourceOwnerUserId',
  ] as const)('rejects GET proof with mismatched %s', async (field) => {
    const { app, api } = await fixture();
    vi.mocked(api.getLatest).mockResolvedValue({ ...proof, [field]: id(90) });
    try {
      expect(
        (await app.inject({ method: 'GET', url: getUrl, headers })).statusCode,
      ).toBe(502);
    } finally {
      await app.close();
    }
  });
  it('rejects malformed proof data rather than presenting an opening balance', async () => {
    const { app, api } = await fixture();
    vi.mocked(api.getLatest).mockResolvedValue({
      ...proof,
      amountCadMinor: '1.23',
    });
    vi.mocked(api.postLegacyOpening).mockResolvedValue(null);
    try {
      expect(
        (await app.inject({ method: 'GET', url: getUrl, headers })).statusCode,
      ).toBe(502);
      expect(
        (await app.inject({ method: 'POST', url: postUrl, headers, payload }))
          .statusCode,
      ).toBe(502);
    } finally {
      await app.close();
    }
  });
  it.each([
    { code: 'authorization-revoked', status: 403 },
    { code: 'conflict', status: 409 },
    { code: 'invalid-input', status: 400 },
    { code: 'unexpected-driver-error', status: 503 },
  ])(
    'sanitizes repository $code failures for reads and posts',
    async ({ code, status }) => {
      const { app, api } = await fixture();
      const error = Object.assign(new Error('sensitive SQL or evidence path'), {
        code,
      });
      vi.mocked(api.getLatest).mockRejectedValue(error);
      vi.mocked(api.postLegacyOpening).mockRejectedValue(error);
      try {
        for (const method of ['GET', 'POST'] as const) {
          const result = await app.inject({
            method,
            url: method === 'GET' ? getUrl : postUrl,
            headers,
            ...(method === 'POST' ? { payload } : {}),
          });
          expect(result.statusCode).toBe(status);
          expect(result.body).not.toContain('sensitive SQL');
        }
      } finally {
        await app.close();
      }
    },
  );
});

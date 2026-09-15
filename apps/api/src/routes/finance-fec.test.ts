import { FRANCE_FEC_COLUMNS, FRANCE_FEC_STANDARD } from '@emdo/domains/finance';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { installProblemHandler } from '../problem.js';
import { createFailClosedApiServices } from '../production/unavailable-services.js';
import type {
  ApiServices,
  AuthenticatedPrincipal,
} from '../services/contracts.js';
import {
  registerFinanceFecRoutes,
  type FinanceFecRouteService,
} from './finance-fec.js';
const userId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f70';
const sessionId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f71';
const requestId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f78';
const workspaceId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f72';
const bookId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f73';
const idempotencyKey = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f77';

const principal: AuthenticatedPrincipal = {
  userId,
  sessionId,
  householdId: workspaceId,
  role: 'owner',
  emailVerified: true,
  spaceAccessGrantId: userId,
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema.parse('7'.repeat(64)),
};

const mapping = {
  expectedRevision: 0,
  siren: '123456789',
  sirenSource: { sourceReference: 'review', sourceDigest: 'a'.repeat(64) },
  openingBalances: {
    status: 'not-applicable',
    source: { sourceReference: 'review', sourceDigest: 'b'.repeat(64) },
  },
  journals: [],
  accounts: [],
};
const input = {
  startsOn: '2026-01-01',
  endsOn: '2026-12-31',
  mappingRevision: 1,
  idempotencyKey,
};
const headers = {
  cookie: '__Secure-emdo.session_token=current',
  'idempotency-key': idempotencyKey,
};
function fixture(
  options: { authenticated?: boolean; csrf?: boolean; ready?: boolean } = {},
) {
  const api: FinanceFecRouteService = {
    getSavedExport: vi.fn(async () => null),
    checkReady: vi.fn(async () => options.ready !== false),
    create: vi.fn(async () => ({ revision: 1 })),
    getLatest: vi.fn(async () => null),
    export: vi.fn(async () => ({ bad: true })),
  };
  const auth = {
    authenticate: vi.fn(async () =>
      options.authenticated === false ? undefined : principal,
    ),
    verifyMutation: vi.fn(async () => options.csrf !== false),
  } as unknown as ApiServices['auth'];
  const app = Fastify({ logger: false, genReqId: () => requestId });
  installProblemHandler(app);
  registerFinanceFecRoutes(
    app,
    { ...createFailClosedApiServices({ auth }), financeFec: api },
    1000000,
  );
  return { app, api };
}
describe('FEC HTTP boundary', () => {
  it('creates reviewed mapping within authenticated book scope', async () => {
    const { app, api } = fixture();
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v2/finance/books/${bookId}/fec/mappings`,
        headers,
        payload: mapping,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store, private');
      expect(api.create).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId, userId }),
        bookId,
        mapping,
      );
    } finally {
      await app.close();
    }
  });
  it.each([{ authenticated: false }, { csrf: false }, { ready: false }])(
    'fails closed for %j',
    async (options) => {
      const { app, api } = fixture(options);
      try {
        const response = await app.inject({
          method: 'POST',
          url: `/api/v2/finance/books/${bookId}/fec/exports`,
          headers,
          payload: input,
        });
        expect(response.statusCode).toBeGreaterThanOrEqual(400);
        expect(api.export).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );
  it('rejects mismatched idempotency before export', async () => {
    const { app, api } = fixture();
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v2/finance/books/${bookId}/fec/exports`,
        headers,
        payload: { ...input, idempotencyKey: 'different' },
      });
      expect(response.statusCode).toBe(400);
      expect(api.export).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('validates service export responses', async () => {
    const { app, api } = fixture();
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v2/finance/books/${bookId}/fec/exports`,
        headers,
        payload: input,
      });
      expect(api.export).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId }),
        bookId,
        input,
      );
      expect(response.statusCode).toBe(502);
    } finally {
      await app.close();
    }
  });
  it('returns a ready file and accepts persisted standard property order', async () => {
    const { app, api } = fixture();
    const content = FRANCE_FEC_COLUMNS.join('\t') + '\r\n';
    const result = {
      status: 'ready',
      review: {
        status: 'ready',
        errors: [],
        entryCount: 0,
        lineCount: 0,
        sourceLineage: [],
        fileName: '123456789FEC20261231.txt',
        standard: Object.fromEntries(
          Object.entries(FRANCE_FEC_STANDARD).reverse(),
        ),
      },
      file: {
        fileName: '123456789FEC20261231.txt',
        content,
        byteLength: Buffer.byteLength(content),
        columns: FRANCE_FEC_COLUMNS,
        encoding: 'UTF-8',
        separator: '\t',
        lineEnding: '\r\n',
      },
      sourceLineage: [],
    };
    vi.mocked(api.export).mockResolvedValue(result);
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v2/finance/books/${bookId}/fec/exports`,
        headers,
        payload: input,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(result);
      vi.mocked(api.getSavedExport).mockResolvedValue(result);
      const saved = await app.inject({
        url: `/api/v2/finance/books/${bookId}/fec/exports/${idempotencyKey}`,
        headers,
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toEqual(result);
      expect(saved.headers['cache-control']).toBe('no-store, private');
      expect(response.headers['cache-control']).toBe('no-store, private');
    } finally {
      await app.close();
    }
  });
  it('reads saved receipts only with current scope and never regenerates exports', async () => {
    const { app, api } = fixture();
    try {
      const response = await app.inject({
        url: `/api/v2/finance/books/${bookId}/fec/exports/${idempotencyKey}`,
        headers,
      });
      expect(response.statusCode).toBe(404);
      expect(api.getSavedExport).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId, userId }),
        bookId,
        idempotencyKey,
      );
      expect(api.export).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('rejects cross-book mapping response', async () => {
    const { app, api } = fixture();
    vi.mocked(api.getLatest).mockResolvedValue({
      workspaceId,
      bookId: userId,
      revision: 1,
      reviewedBy: userId,
      reviewedAt: '2026-09-14T00:00:00.000Z',
      mapping: { ...mapping, expectedRevision: 1 },
    });
    try {
      const response = await app.inject({
        url: `/api/v2/finance/books/${bookId}/fec/mappings/latest`,
        headers,
      });
      expect(response.statusCode).toBe(502);
    } finally {
      await app.close();
    }
  });
});

import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { planLegacyFinanceMigration } from '@emdo/domains/finance';
import { installProblemHandler } from '../problem.js';
import { createFailClosedApiServices } from '../production/unavailable-services.js';
import type {
  ApiServices,
  AuthenticatedPrincipal,
} from '../services/contracts.js';
import {
  registerFinanceLegacyMigrationRoutes,
  type FinanceLegacyMigrationRouteService,
  type FinanceLegacyMigrationRouteServices,
} from './finance-legacy-migrations.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const workspaceId = id(1),
  bookId = id(2),
  userId = id(3),
  migrationId = id(4),
  recordId = id(5),
  comparisonId = id(6),
  idempotencyKey = id(7);
const mapping = {
  source: {
    householdId: workspaceId,
    privateSpaceId: id(8),
    originalOwnerUserId: userId,
  },
  target: { workspaceId, bookId, ownerUserId: userId },
  financialAccounts: [],
  categories: [],
  evidence: [],
  openings: [],
};
const plan = planLegacyFinanceMigration({
  schemaVersion: 1,
  mapping,
  sourceRecords: [],
  stableTargetIds: [],
});
const run = {
  id: migrationId,
  mapping,
  status: 'review',
  revision: 1,
  sourceSnapshotHash: plan.sourceSnapshotHash,
  mappingHash: plan.mappingHash,
  sourceCount: 0,
  readyCount: 0,
  blockedCount: 0,
  backfilledCount: 0,
  unresolvedCount: 0,
  createdBy: userId,
  createdAt: '2026-09-14T00:00:00.000Z',
  updatedAt: '2026-09-14T00:00:00.000Z',
};
const inspection = { run, plan, records: [] };
const comparison = {
  id: comparisonId,
  migrationId,
  sourceSnapshotHash: plan.sourceSnapshotHash,
  targetSnapshotHash: 'a'.repeat(64),
  status: 'passed',
  sourceTransactionCount: 0,
  targetTransactionCount: 0,
  sourceCadMinorTotal: '0',
  targetCadDecimalTotal: '0',
  unresolvedCount: 0,
  mismatches: [],
  createdBy: userId,
  createdAt: run.createdAt,
};
const approval = {
  id: id(10),
  migrationId,
  source: mapping.source,
  target: mapping.target,
  comparisonId,
  status: 'approved',
  approvedBy: userId,
  approvedAt: run.createdAt,
};
const principal: AuthenticatedPrincipal = {
  userId,
  sessionId: id(11),
  householdId: workspaceId,
  role: 'owner',
  emailVerified: true,
  spaceAccessGrantId: id(12),
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema.parse('a'.repeat(64)),
};
const headers = {
  cookie: '__Secure-emdo.session_token=current',
  'idempotency-key': idempotencyKey,
};
const base = `/api/v2/finance/books/${bookId}/legacy-migrations`;
const bodies = {
  inspect: { mapping, idempotencyKey },
  review: {
    migrationId,
    recordId,
    expectedRevision: 1,
    decision: { reason: 'Reviewed mapping' },
  },
  backfill: {
    migrationId,
    expectedRevision: 1,
    sourceSnapshotHash: plan.sourceSnapshotHash,
    idempotencyKey,
  },
  compare: { migrationId, expectedRevision: 1 },
  'approve-cutover': {
    migrationId,
    expectedRevision: 1,
    comparisonId,
    sourceSnapshotHash: plan.sourceSnapshotHash,
    idempotencyKey,
  },
};
async function fixture(
  options: { ready?: boolean; authenticated?: boolean; csrf?: boolean } = {},
) {
  const auth = {
    authenticate: vi.fn(async () =>
      options.authenticated === false ? undefined : principal,
    ),
    verifyMutation: vi.fn(async () => options.csrf !== false),
  } as unknown as ApiServices['auth'];
  const api: FinanceLegacyMigrationRouteService = {
    checkReady: vi.fn(async () => options.ready !== false),
    listSources: vi.fn(async () => [
      { name: 'My private finance', source: mapping.source },
    ]),
    list: vi.fn(async () => [run]),
    get: vi.fn(async () => inspection),
    inspect: vi.fn(async () => inspection),
    review: vi.fn(async () => ({
      ...inspection,
      review: {
        id: id(13),
        migrationId,
        recordId,
        revision: 1,
        decision: { reason: 'Reviewed mapping' },
        previousState: {},
        reviewedBy: userId,
        createdAt: run.createdAt,
      },
    })),
    backfill: vi.fn(async () => ({
      migrationId,
      status: 'backfilled',
      targetBatchIds: [],
      targetRowIds: [],
      backfilledCount: 0,
      preservedCount: 0,
      sourceSnapshotHash: plan.sourceSnapshotHash,
      replayed: false,
    })),
    compare: vi.fn(async () => comparison),
    approveCutover: vi.fn(async () => approval),
  };
  const app = Fastify({ logger: false, genReqId: () => id(14) });
  installProblemHandler(app);
  registerFinanceLegacyMigrationRoutes(
    app,
    {
      ...createFailClosedApiServices({ auth }),
      financeLegacyMigration: api,
    } as unknown as FinanceLegacyMigrationRouteServices,
    1_000_000,
  );
  return { app, api };
}

describe('Finance legacy migration HTTP boundary', () => {
  it('offers only the current owner source catalog and rejects cross-owner results', async () => {
    const { app, api } = await fixture();
    try {
      const result = await app.inject({
        method: 'GET',
        url: `${base}/sources`,
        headers,
      });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({
        sources: [{ name: 'My private finance', source: mapping.source }],
      });
      expect(result.headers['cache-control']).toBe('no-store, private');
      vi.mocked(api.listSources).mockResolvedValue([
        {
          name: 'Other private',
          source: { ...mapping.source, originalOwnerUserId: id(99) },
        },
      ]);
      expect(
        (await app.inject({ method: 'GET', url: `${base}/sources`, headers }))
          .statusCode,
      ).toBe(502);
    } finally {
      await app.close();
    }
  });
  it('lists and reads only the current owner and requested book, with private no-store responses', async () => {
    const { app, api } = await fixture();
    try {
      for (const url of [base, `${base}/${migrationId}`]) {
        const result = await app.inject({ method: 'GET', url, headers });
        expect(result.statusCode).toBe(200);
        expect(result.headers['cache-control']).toBe('no-store, private');
      }
      expect(api.list).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId, userId }),
        bookId,
      );
      expect(api.get).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId, userId }),
        migrationId,
      );
    } finally {
      await app.close();
    }
  });
  it.each([
    'inspect',
    'review',
    'backfill',
    'compare',
    'approve-cutover',
  ] as const)(
    'exposes %s through authenticated strict contract validation',
    async (operation) => {
      const { app, api } = await fixture();
      try {
        const url =
          operation === 'inspect'
            ? `${base}/inspect`
            : `${base}/${migrationId}/${operation}`;
        const result = await app.inject({
          method: 'POST',
          url,
          headers,
          payload: bodies[operation],
        });
        expect(result.statusCode, result.body).toBe(200);
        expect(result.headers['cache-control']).toBe('no-store, private');
        const method =
          operation === 'approve-cutover' ? 'approveCutover' : operation;
        expect(api[method]).toHaveBeenCalledWith(
          expect.objectContaining({ workspaceId, userId }),
          operation === 'review'
            ? expect.objectContaining({
                ...bodies.review,
                decision: expect.objectContaining(bodies.review.decision),
              })
            : expect.objectContaining(bodies[operation]),
        );
        if (operation !== 'inspect')
          expect(vi.mocked(api.get).mock.invocationCallOrder[0]).toBeLessThan(
            vi.mocked(api[method]).mock.invocationCallOrder[0]!,
          );
      } finally {
        await app.close();
      }
    },
  );
  it('does not expose activation alongside cutover approval', async () => {
    const { app } = await fixture();
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `${base}/${migrationId}/activate`,
            headers,
            payload: {},
          })
        ).statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });
  it.each([
    { authenticated: false, status: 401 },
    { csrf: false, status: 403 },
    { ready: false, status: 503 },
  ])(
    'fails before mutation when authorization/readiness is unavailable (%j)',
    async (options) => {
      const { app, api } = await fixture(options);
      try {
        const result = await app.inject({
          method: 'POST',
          url: `${base}/inspect`,
          headers,
          payload: bodies.inspect,
        });
        expect(result.statusCode).toBe(options.status);
        expect(api.inspect).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );
  it('rejects mismatched header, path, owner and unknown body keys before writes', async () => {
    const { app, api } = await fixture();
    try {
      const requests = [
        {
          url: `${base}/inspect`,
          payload: { ...bodies.inspect, idempotencyKey: id(90) },
        },
        { url: `${base}/inspect`, payload: { ...bodies.inspect, extra: true } },
        {
          url: `${base}/inspect`,
          payload: {
            ...bodies.inspect,
            mapping: {
              ...mapping,
              target: { ...mapping.target, ownerUserId: id(90) },
            },
          },
        },
        {
          url: `${base}/${migrationId}/compare`,
          payload: { ...bodies.compare, migrationId: id(90) },
        },
      ];
      for (const request of requests)
        expect(
          (await app.inject({ method: 'POST', headers, ...request }))
            .statusCode,
        ).toBe(400);
      expect(api.inspect).not.toHaveBeenCalled();
      expect(api.compare).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('rejects another book or owner returned by get before comparison mutation', async () => {
    const { app, api } = await fixture();
    vi.mocked(api.get).mockResolvedValue({
      ...inspection,
      run: {
        ...run,
        mapping: { ...mapping, target: { ...mapping.target, bookId: id(90) } },
      },
    });
    try {
      const result = await app.inject({
        method: 'POST',
        url: `${base}/${migrationId}/compare`,
        headers,
        payload: bodies.compare,
      });
      expect(result.statusCode).toBe(502);
      expect(api.compare).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('rejects malformed, cross-owner and overflowing output without partial records', async () => {
    const { app, api } = await fixture();
    try {
      for (const output of [
        { invalid: true },
        [
          {
            ...run,
            mapping: {
              ...mapping,
              source: { ...mapping.source, originalOwnerUserId: id(90) },
            },
          },
        ],
        Array.from({ length: 1001 }, () => run),
      ]) {
        vi.mocked(api.list).mockResolvedValue(output);
        expect(
          (await app.inject({ method: 'GET', url: base, headers })).statusCode,
        ).toBe(502);
      }
    } finally {
      await app.close();
    }
  });
  it.each([
    { code: 'forbidden', status: 403 },
    { code: 'blocked', status: 409 },
    { code: 'conflict', status: 409 },
    { code: 'invalid-input', status: 400 },
    { code: 'unavailable', status: 503 },
  ])(
    'maps repository $code without leaking raw persistence details',
    async ({ code, status }) => {
      const { app, api } = await fixture();
      vi.mocked(api.compare).mockRejectedValue(
        Object.assign(new Error('secret SQL table details'), {
          name: 'FinanceLegacyMigrationPersistenceError',
          code,
        }),
      );
      try {
        const result = await app.inject({
          method: 'POST',
          url: `${base}/${migrationId}/compare`,
          headers,
          payload: bodies.compare,
        });
        expect(result.statusCode).toBe(status);
        expect(result.body).not.toContain('secret SQL');
      } finally {
        await app.close();
      }
    },
  );
});

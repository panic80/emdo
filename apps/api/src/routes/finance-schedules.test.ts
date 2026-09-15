import { describe, expect, it, vi } from 'vitest';
import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { createApp } from '../app.js';
import { createFailClosedApiServices } from '../production/unavailable-services.js';
import type {
  ApiServices,
  AuthenticatedPrincipal,
} from '../services/contracts.js';
const id = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f70';
const workspace = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f72';
const principal: AuthenticatedPrincipal = {
  userId: id,
  sessionId: id,
  householdId: workspace,
  role: 'owner',
  emailVerified: true,
  spaceAccessGrantId: id,
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema.parse('7'.repeat(64)),
};
const headers = {
  cookie: '__Secure-emdo.session_token=current',
  'idempotency-key': id,
};
const base = `/api/v2/finance/books/${id}/automations/schedules`;
const definition = {
  grantId: id,
  grantRevision: 1,
  capability: 'finance.reports.generate',
  targets: [id],
  money: { currency: 'CAD', amount: '0' },
  startAt: '2026-09-13T00:00:00Z',
  endAt: null,
  cadence: {
    kind: 'interval',
    everySeconds: 3600,
    timeZone: 'UTC',
    clock: 'elapsed-utc',
  },
  misfire: { policy: 'coalesce-latest', maxLatenessSeconds: 3600 },
  concurrency: { policy: 'forbid', onBusy: 'defer' },
};
function record(scheduleId = id, status = 'active', stateRevision = 1) {
  return {
    schedule: {
      id: scheduleId,
      definitionRevision: 1,
      stateRevision,
      status,
      definition: { ...definition, workspaceId: workspace, bookId: id },
    },
    cursor: { scheduleId, definitionRevision: 1, nextOrdinal: 0 },
    nextDueAt: null,
    blockedReason: null,
    createdAt: '2026-09-13T00:00:00Z',
    updatedAt: '2026-09-13T00:00:00Z',
  };
}
async function fixture(
  options: {
    authenticated?: boolean;
    csrf?: boolean;
    ready?: boolean;
    wrongScope?: boolean;
  } = {},
) {
  const api = {
    checkReady: vi.fn(async () => options.ready !== false),
    createSchedule: vi.fn(
      async (_context, _book, scheduleId: string, definition?: unknown) => {
        void definition;
        return record(scheduleId);
      },
    ),
    setScheduleState: vi.fn(
      async (
        _context,
        _book,
        scheduleId: string,
        input: { status: string; expectedStateRevision: number },
      ) => record(scheduleId, input.status, input.expectedStateRevision + 1),
    ),
    getSchedule: vi.fn(async () => record()),
    listSchedules: vi.fn(async () => {
      const row = record();
      if (options.wrongScope) row.schedule.definition.workspaceId = id;
      return [row];
    }),
  };
  const auth = {
    authenticate: vi.fn(async () =>
      options.authenticated === false ? null : principal,
    ),
    verifyMutation: vi.fn(async () => options.csrf !== false),
  } as unknown as ApiServices['auth'];
  const services = {
    ...createFailClosedApiServices({ auth }),
    financeV2: { checkReady: async () => true } as NonNullable<
      ApiServices['financeV2']
    >,
    financeSchedules: api as unknown as NonNullable<
      ApiServices['financeSchedules']
    >,
  };
  return { app: await createApp({ services }), api };
}
describe('authenticated recurring Finance schedule management', () => {
  it('authorizes current book access before exposing calendar options', async () => {
    const { app, api } = await fixture();
    try {
      const response = await app.inject({
        method: 'GET',
        url: `${base}/options`,
        headers,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ tzdbVersion: process.versions.tz });
      expect(api.listSchedules).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: workspace, userId: id }),
        id,
        0,
        1,
      );
      api.listSchedules.mockRejectedValueOnce(new Error('access denied'));
      expect(
        (await app.inject({ method: 'GET', url: `${base}/options`, headers }))
          .statusCode,
      ).not.toBe(200);
    } finally {
      await app.close();
    }
  });
  it('derives scope and a stable schedule identity from authenticated idempotency context', async () => {
    const { app, api } = await fixture();
    try {
      const response = await app.inject({
        method: 'POST',
        url: base,
        headers,
        payload: definition,
      });
      expect(response.statusCode).toBe(200);
      expect(api.createSchedule.mock.calls[0]?.[0]).toMatchObject({
        workspaceId: workspace,
        userId: id,
      });
      expect(api.createSchedule.mock.calls[0]?.[1]).toBe(id);
      const second = await app.inject({
        method: 'POST',
        url: base,
        headers,
        payload: definition,
      });
      expect(second.json().schedule.id).toBe(response.json().schedule.id);
    } finally {
      await app.close();
    }
  });
  it('forwards the state revision for pause/revoke CAS', async () => {
    const { app, api } = await fixture();
    try {
      const response = await app.inject({
        method: 'POST',
        url: `${base}/${id}/state`,
        headers,
        payload: { expectedStateRevision: 7, status: 'retired' },
      });
      expect(response.statusCode).toBe(200);
      expect(api.setScheduleState.mock.calls[0]?.[3]).toEqual({
        expectedStateRevision: 7,
        status: 'retired',
      });
    } finally {
      await app.close();
    }
  });
  it.each([
    { authenticated: false, status: 401 },
    { csrf: false, status: 403 },
    { ready: false, status: 503 },
  ])('fails closed for %j', async (options) => {
    const { app, api } = await fixture(options);
    try {
      const response = await app.inject({
        method: 'POST',
        url: base,
        headers,
        payload: definition,
      });
      expect(response.statusCode).toBe(options.status);
      expect(api.createSchedule).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it.each([
    { ...definition, workspaceId: workspace },
    { ...definition, cadence: { kind: 'cron', expression: '* * * * *' } },
  ])('rejects caller scope or unsupported cadence', async (payload) => {
    const { app, api } = await fixture();
    try {
      const response = await app.inject({
        method: 'POST',
        url: base,
        headers,
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(api.createSchedule).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('rejects non-UUID idempotency keys before mutation', async () => {
    const { app, api } = await fixture();
    try {
      const response = await app.inject({
        method: 'POST',
        url: base,
        headers: { ...headers, 'idempotency-key': 'arbitrary' },
        payload: definition,
      });
      expect(response.statusCode).toBe(400);
      expect(api.createSchedule).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('rejects repository output from another workspace', async () => {
    const { app } = await fixture({ wrongScope: true });
    try {
      const response = await app.inject({ method: 'GET', url: base, headers });
      expect(response.statusCode).toBe(502);
    } finally {
      await app.close();
    }
  });
});

const exactSources = [
  {
    capability: 'finance.documents.extract',
    extraction: {
      schemaVersion: 1,
      evidenceId: id,
      expectedSourceDigest: 'a'.repeat(64),
      standardizationRunId: id,
      expectedRunRevision: 3,
      expectedExtractionRevision: 1,
    },
  },
  {
    capability: 'finance.journals.draft',
    money: { currency: 'CAD', amount: '123.45' },
    journal: {
      schemaVersion: 1,
      batchId: id,
      expectedBatchRevision: 2,
      expectedSnapshotHash: 'b'.repeat(64),
    },
  },
];
describe('exact-source recurring Finance routes', () => {
  it.each(exactSources)(
    'preserves reviewed intent in create and read: $capability',
    async (source) => {
      const { app, api } = await fixture();
      const input = { ...definition, ...source };
      const stored = {
        ...record(),
        schedule: {
          ...record().schedule,
          definition: { ...input, workspaceId: workspace, bookId: id },
        },
      };
      api.createSchedule.mockImplementationOnce(
        async (_context, _book, scheduleId) => ({
          ...stored,
          schedule: { ...stored.schedule, id: scheduleId },
          cursor: { ...stored.cursor, scheduleId },
        }),
      );
      api.listSchedules.mockResolvedValueOnce([stored]);
      try {
        const response = await app.inject({
          method: 'POST',
          url: base,
          headers,
          payload: input,
        });
        expect(response.statusCode).toBe(200);
        expect(api.createSchedule.mock.calls[0]?.[3]).toEqual(
          stored.schedule.definition,
        );
        expect(response.json().schedule.definition).toEqual(
          stored.schedule.definition,
        );
        const read = await app.inject({ method: 'GET', url: base, headers });
        expect(read.statusCode).toBe(200);
        expect(read.json().schedules[0].schedule.definition).toEqual(
          stored.schedule.definition,
        );
      } finally {
        await app.close();
      }
    },
  );
  it.each(exactSources)(
    'rejects exact target and capability mismatches before persistence: $capability',
    async (source) => {
      const { app, api } = await fixture();
      try {
        for (const payload of [
          { ...definition, ...source, targets: [workspace] },
          { ...definition, ...source, capability: 'finance.reports.generate' },
          { ...definition, ...source, targets: [id, workspace] },
        ]) {
          const response = await app.inject({
            method: 'POST',
            url: base,
            headers,
            payload,
          });
          expect(response.statusCode).toBe(400);
        }
        expect(api.createSchedule).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );
  it.each(exactSources)(
    'retains service readiness gating: $capability',
    async (source) => {
      const { app, api } = await fixture({ ready: false });
      try {
        const response = await app.inject({
          method: 'POST',
          url: base,
          headers,
          payload: { ...definition, ...source },
        });
        expect(response.statusCode).toBe(503);
        expect(api.createSchedule).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );
});

it('rejects mismatched planning source at API boundary before persistence', async () => {
  const { app, api } = await fixture();
  try {
    const response = await app.inject({
      method: 'POST',
      url: base,
      headers,
      payload: {
        ...definition,
        capability: 'finance.planning.budget-vs-actuals',
        targets: [workspace],
        planning: {
          schemaVersion: 1,
          capability: 'finance.planning.budget-vs-actuals',
          budgetId: id,
          budgetRevision: 2,
          asOf: null,
          currency: 'CAD',
          itemCount: 3,
        },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(api.createSchedule).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

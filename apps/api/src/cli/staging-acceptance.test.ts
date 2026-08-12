import { describe, expect, it, vi } from 'vitest';

import { runStagingAcceptanceCommand } from './staging-acceptance.js';

const CLIENT_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f90';
const SPACE_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f91';
const USER_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f92';
const RUN_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f93';
const REQUEST_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5faa';
const SOURCE_SHA = 'a'.repeat(40);
const WORKFLOW_RUN_ID = '123456789';
const OBSERVED_AT = new Date('2026-08-12T15:30:00.000Z');

const environment = {
  EMDO_ENVIRONMENT: 'staging',
  EMDO_SYNTHETIC_DATA_ONLY: 'true',
  EMDO_EXTERNAL_PROVIDERS_ENABLED: 'false',
  EMDO_STAGING_API_ORIGIN: 'http://127.0.0.1:3000',
  EMDO_PUBLIC_ORIGIN: 'https://staging.emdo.invalid',
  EMDO_STAGING_SOURCE_SHA: SOURCE_SHA,
  EMDO_STAGING_WORKFLOW_RUN_ID: WORKFLOW_RUN_ID,
  EMDO_SYNTHETIC_CLIENT_ID: CLIENT_ID,
  EMDO_SYNTHETIC_OWNER_EMAIL: 'synthetic-owner@emdo.invalid',
  EMDO_SYNTHETIC_OWNER_PASSWORD: 'synthetic-password-0123456789',
};

const canonicalReadinessChecks = Object.freeze({
  authority: 'ok' as const,
  'authority.authentication': 'ok' as const,
  'authority.household-administration': 'ok' as const,
  'authority.proposal-queries': 'ok' as const,
  'authority.visual-decisions': 'ok' as const,
  'authority.visual-proof-issuance': 'ok' as const,
  agents: 'ok' as const,
  'agents.manager-turns': 'ok' as const,
  'agents.run-events': 'ok' as const,
  experience: 'ok' as const,
  'experience.activity-read': 'ok' as const,
  'experience.finance-read': 'ok' as const,
  'experience.notification-preferences': 'ok' as const,
  'experience.schedule-read': 'ok' as const,
  'experience.settings-read': 'ok' as const,
  'experience.shopping-read': 'ok' as const,
  'experience.today-read': 'ok' as const,
  google: 'ok' as const,
  'google.connector': 'ok' as const,
  sync: 'ok' as const,
  'sync.gateway': 'ok' as const,
  'sync.jwks': 'ok' as const,
  voice: 'ok' as const,
  'voice.audio-requests': 'ok' as const,
  'voice.provider': 'ok' as const,
});

const canonicalOpenApiSurface = Object.freeze({
  '/api/auth/get-session': { get: {} },
  '/api/auth/sign-in/email': { post: {} },
  '/api/auth/passkey/verify-authentication': { post: {} },
  '/api/v1/auth/invitations/redeem': { post: {} },
  '/api/v1/household/invitations': { get: {}, post: {} },
  '/api/v1/household/invitations/{id}/revoke': { post: {} },
  '/api/v1/household/memberships': { get: {} },
  '/api/v1/household/memberships/{id}/role': { patch: {} },
  '/api/v1/household/memberships/{id}/deactivate': { post: {} },
  '/api/v1/turns': { post: {} },
  '/api/v1/runs/{id}/events': { get: {} },
  '/api/v1/proposals': { get: {} },
  '/api/v1/proposals/{id}': { get: {} },
  '/api/v1/proposals/{id}/visual-proof': { post: {} },
  '/api/v1/proposals/{id}/decision': { post: {} },
  '/api/v1/sync/clients': { post: {} },
  '/api/v1/sync/token': { get: {} },
  '/api/v1/sync/ops': { post: {} },
  '/api/v1/experience/today': { get: {} },
  '/api/v1/experience/activity': { get: {} },
  '/api/v1/experience/finance': { get: {} },
  '/api/v1/experience/schedule': { get: {} },
  '/api/v1/experience/settings': { get: {} },
  '/api/v1/experience/shopping': { get: {} },
  '/api/v1/experience/notification-preferences': { get: {}, put: {} },
  '/api/v1/voice/transcribe': { post: {} },
  '/api/v1/voice/speak': { post: {} },
  '/api/v1/connectors/google/authorize': { post: {} },
});

const jsonWithRequestId = (
  body: unknown,
  init: ResponseInit = {},
): Response => {
  const headers = new Headers(init.headers);
  headers.set('x-request-id', REQUEST_ID);
  return Response.json(body, { ...init, headers });
};

const problem = (status: number, code: string) =>
  Response.json(
    {
      type: 'about:blank',
      title: code,
      status,
      code,
      detail: code,
      requestId: REQUEST_ID,
    },
    {
      status,
      headers: {
        'content-type': 'application/problem+json',
        'x-request-id': REQUEST_ID,
      },
    },
  );

describe('staging acceptance CLI', () => {
  it('probes the actual HTTP graph while forbidding external providers', async () => {
    const requests: Request[] = [];
    const syncOperationBatches: unknown[] = [];
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname === '/healthz') {
        return jsonWithRequestId({ status: 'ok' });
      }
      if (url.pathname === '/readyz') {
        return jsonWithRequestId({
          schemaVersion: 1,
          status: 'ready',
          checks: canonicalReadinessChecks,
        });
      }
      if (url.pathname === '/metrics') {
        return problem(401, 'metrics-auth-required');
      }
      if (url.pathname === '/openapi.json') {
        return Response.json({
          openapi: '3.1.0',
          paths: canonicalOpenApiSurface,
        });
      }
      if (url.pathname === '/api/auth/sign-in/email') {
        return new Response('{"ok":true}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'set-cookie':
              '__Secure-emdo.session_token=acceptance-session; Path=/; Secure; HttpOnly',
          },
        });
      }
      if (url.pathname === '/api/auth/get-session') {
        return Response.json({
          user: { id: USER_ID },
          session: { id: 'opaque' },
        });
      }
      if (url.pathname === '/api/v1/auth/csrf') {
        return new Response(
          JSON.stringify({
            schemaVersion: 1,
            token: 'csrf-token-01234567890123456789',
          }),
          {
            headers: {
              'content-type': 'application/json',
              'set-cookie':
                'emdo.csrf_token=csrf-token-01234567890123456789; Path=/api/; Secure; HttpOnly',
            },
          },
        );
      }
      if (url.pathname === '/api/v1/sync/token') {
        return Response.json({
          schemaVersion: 1,
          endpoint: 'https://staging.emdo.invalid/powersync',
          token: 'header.claims.signature',
          expiresAt: '2026-08-09T12:05:00.000Z',
          writeScope: {
            clientId: url.searchParams.get('clientId'),
            spaces: [
              {
                id: SPACE_ID,
                visibility: 'private',
                originalOwnerUserId: USER_ID,
              },
            ],
          },
        });
      }
      if (url.pathname === '/api/v1/sync/clients') {
        const body = (await request.json()) as { clientId: string };
        return Response.json(
          {
            schemaVersion: 1,
            clientId: body.clientId,
            status: 'registered',
            replayed: false,
          },
          { status: 201 },
        );
      }
      if (url.pathname === '/api/v1/sync/ops') {
        const body = (await request.json()) as {
          clientId: string;
          operations: { operationId: string }[];
        };
        syncOperationBatches.push(body);
        return Response.json({
          schemaVersion: 1,
          clientId: body.clientId,
          results: body.operations.map(({ operationId }) => ({
            operationId,
            status: 'applied',
            revision: body.clientId === CLIENT_ID ? 1 : 2,
            replayed: false,
          })),
        });
      }
      if (url.pathname.endsWith('/decision')) {
        return problem(403, 'visual-approval-required');
      }
      if (url.pathname === '/api/v1/voice/speak') {
        return problem(503, 'audio-provider-unavailable');
      }
      if (url.pathname === '/api/v1/connectors/google/authorize') {
        return problem(503, 'connector-unavailable');
      }
      if (url.pathname === '/api/v1/turns') {
        return Response.json(
          {
            schemaVersion: 1,
            runId: RUN_ID,
            status: 'accepted',
            replayed: false,
            eventsPath: `/api/v1/runs/${RUN_ID}/events`,
          },
          { status: 202 },
        );
      }
      if (url.pathname === `/api/v1/runs/${RUN_ID}/events`) {
        return new Response(
          `id: 1\nevent: run.failed\ndata: {"schemaVersion":1,"runId":"${RUN_ID}","sequence":1,"type":"run.failed","occurredAt":"2026-08-09T12:00:00.000Z","data":{"code":"models-unavailable"}}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response(null, { status: 404 });
    });

    await expect(
      runStagingAcceptanceCommand({
        argv: [
          '--all-mvp-gates',
          '--require-synthetic',
          '--forbid-external-providers',
        ],
        environment,
        fetch,
        now: () => OBSERVED_AT,
      }),
    ).resolves.toEqual({
      schemaVersion: 1,
      evidenceClass: 'staging-http-subset-probe',
      releaseEligible: false,
      environment: 'staging',
      sourceSha: SOURCE_SHA,
      observedAt: '2026-08-12T15:30:00.000Z',
      execution: {
        workflow: '.github/workflows/staging.yml',
        runId: WORKFLOW_RUN_ID,
        event: 'workflow_dispatch',
      },
      proof: {
        healthz: 'passed',
        readyz: 'passed',
        protectedMetrics: 'passed',
        requestIds: 'passed',
        problemJson: 'passed',
      },
    });
    expect(
      requests.every(
        (request) => new URL(request.url).origin === 'http://127.0.0.1:3000',
      ),
    ).toBe(true);
    expect(
      requests.filter(
        (request) => new URL(request.url).pathname === '/api/v1/sync/clients',
      ),
    ).toHaveLength(2);
    expect(
      requests.filter(
        (request) => new URL(request.url).pathname === '/api/v1/sync/token',
      ),
    ).toHaveLength(2);
    const metricsRequests = requests.filter(
      (request) => new URL(request.url).pathname === '/metrics',
    );
    expect(metricsRequests).toHaveLength(1);
    expect(metricsRequests[0]?.headers.get('authorization')).toBeNull();
    expect(metricsRequests[0]?.headers.get('cookie')).toBeNull();
    expect(syncOperationBatches).toEqual([
      {
        schemaVersion: 1,
        clientId: CLIENT_ID,
        operations: [
          expect.objectContaining({
            entity: {
              type: 'scheduler.item',
              id: 'acceptance-scheduler-item-v1',
            },
            mutation: {
              kind: 'create',
              payload: {
                spaceId: SPACE_ID,
                value: {
                  id: 'acceptance-scheduler-item-v1',
                  title: 'Acceptance task',
                  notes: null,
                  location: null,
                  startsAt: '2026-01-02T09:00:00.000-05:00',
                  endsAt: '2026-01-02T10:00:00.000-05:00',
                  recurrence: null,
                  attendees: [],
                  completion: 'open',
                },
              },
            },
          }),
          expect.objectContaining({
            entity: {
              type: 'finance.budget',
              id: 'acceptance-finance-budget-v1',
            },
            mutation: {
              kind: 'create',
              payload: {
                spaceId: SPACE_ID,
                value: {
                  id: 'acceptance-finance-budget-v1',
                  currency: 'CAD',
                  allocationsCadMinor: { groceries: 45_000 },
                },
              },
            },
          }),
          expect.objectContaining({
            entity: {
              type: 'shopping.item',
              id: 'acceptance-shopping-item-v1',
            },
            mutation: {
              kind: 'create',
              payload: {
                spaceId: SPACE_ID,
                value: {
                  name: 'Acceptance milk',
                  unit: 'each',
                  quantityMinorUnits: 1_000,
                },
              },
            },
          }),
        ],
      },
      {
        schemaVersion: 1,
        clientId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5fa0',
        operations: [
          expect.objectContaining({
            entity: {
              type: 'shopping.item',
              id: 'acceptance-shopping-item-v1',
            },
            mutation: {
              kind: 'delta',
              payload: {
                spaceId: SPACE_ID,
                delta: { quantityMinorUnits: 1_000 },
              },
            },
            baseRevision: 1,
          }),
        ],
      },
    ]);
  });

  it.each([
    {
      name: 'liveness',
      expectedPaths: ['/healthz'],
      fetch: async () => Response.json({ status: 'ok' }),
    },
    {
      name: 'readiness',
      expectedPaths: ['/healthz', '/readyz'],
      fetch: async (request: Request) =>
        new URL(request.url).pathname === '/healthz'
          ? jsonWithRequestId({ status: 'ok' })
          : Response.json({
              schemaVersion: 1,
              status: 'ready',
              checks: canonicalReadinessChecks,
            }),
    },
  ])(
    'requires an API-issued request ID on representative $name responses',
    async ({ expectedPaths, fetch: responseFor }) => {
      const paths: string[] = [];
      const fetch = vi.fn(async (request: Request) => {
        paths.push(new URL(request.url).pathname);
        return responseFor(request);
      });

      await expect(
        runStagingAcceptanceCommand({
          argv: [
            '--all-mvp-gates',
            '--require-synthetic',
            '--forbid-external-providers',
          ],
          environment,
          fetch,
        }),
      ).rejects.toThrow('Staging acceptance response request ID is invalid');
      expect(paths).toEqual(expectedPaths);
    },
  );

  it.each([
    {
      name: 'successful metrics access',
      response: jsonWithRequestId('metrics', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    },
    {
      name: 'non-problem content type',
      response: jsonWithRequestId(
        {
          type: 'about:blank',
          title: 'Metrics authentication required',
          status: 401,
          code: 'metrics-auth-required',
          detail: 'A dedicated metrics credential is required.',
          requestId: REQUEST_ID,
        },
        { status: 401 },
      ),
    },
    {
      name: 'unbound problem request ID',
      response: Response.json(
        {
          type: 'about:blank',
          title: 'Metrics authentication required',
          status: 401,
          code: 'metrics-auth-required',
          detail: 'A dedicated metrics credential is required.',
          requestId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5fab',
        },
        {
          status: 401,
          headers: {
            'content-type': 'application/problem+json',
            'x-request-id': REQUEST_ID,
          },
        },
      ),
    },
  ])(
    'fails closed for $name instead of claiming protected metrics',
    async ({ response }) => {
      const paths: string[] = [];
      const fetch = vi.fn(async (request: Request) => {
        const path = new URL(request.url).pathname;
        paths.push(path);
        if (path === '/healthz') return jsonWithRequestId({ status: 'ok' });
        if (path === '/readyz') {
          return jsonWithRequestId({
            schemaVersion: 1,
            status: 'ready',
            checks: canonicalReadinessChecks,
          });
        }
        if (path === '/metrics') return response;
        throw new Error(`Unexpected acceptance request: ${path}`);
      });

      await expect(
        runStagingAcceptanceCommand({
          argv: [
            '--all-mvp-gates',
            '--require-synthetic',
            '--forbid-external-providers',
          ],
          environment,
          fetch,
        }),
      ).rejects.toThrow();
      expect(paths).toEqual(['/healthz', '/readyz', '/metrics']);
    },
  );

  it('rejects partial flags and any provider-enabled environment before HTTP', async () => {
    const fetch = vi.fn();
    await expect(
      runStagingAcceptanceCommand({
        argv: ['--all-mvp-gates'],
        environment,
        fetch,
      }),
    ).rejects.toThrow('Staging acceptance configuration is invalid');
    await expect(
      runStagingAcceptanceCommand({
        argv: [
          '--all-mvp-gates',
          '--require-synthetic',
          '--forbid-external-providers',
        ],
        environment: {
          ...environment,
          EMDO_EXTERNAL_PROVIDERS_ENABLED: 'true',
        },
        fetch,
      }),
    ).rejects.toThrow('Staging acceptance configuration is invalid');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['missing source SHA', { EMDO_STAGING_SOURCE_SHA: undefined }],
    ['abbreviated source SHA', { EMDO_STAGING_SOURCE_SHA: 'deadbeef' }],
    ['uppercase source SHA', { EMDO_STAGING_SOURCE_SHA: 'A'.repeat(40) }],
    ['missing workflow run ID', { EMDO_STAGING_WORKFLOW_RUN_ID: undefined }],
    ['zero workflow run ID', { EMDO_STAGING_WORKFLOW_RUN_ID: '0' }],
    ['non-decimal workflow run ID', { EMDO_STAGING_WORKFLOW_RUN_ID: '42x' }],
  ])('rejects %s before HTTP', async (_name, overrides) => {
    const fetch = vi.fn();

    await expect(
      runStagingAcceptanceCommand({
        argv: [
          '--all-mvp-gates',
          '--require-synthetic',
          '--forbid-external-providers',
        ],
        environment: { ...environment, ...overrides },
        fetch,
        now: () => OBSERVED_AT,
      }),
    ).rejects.toThrow('Staging acceptance configuration is invalid');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects legacy, incomplete, and unversioned readiness before authenticated work', async () => {
    const invokeWithReadiness = async (readiness: unknown) => {
      const paths: string[] = [];
      const fetch = vi.fn(async (request: Request) => {
        const path = new URL(request.url).pathname;
        paths.push(path);
        if (path === '/healthz') {
          return jsonWithRequestId({ status: 'ok' });
        }
        if (path === '/readyz') return jsonWithRequestId(readiness);
        throw new Error('acceptance advanced past readiness');
      });
      await expect(
        runStagingAcceptanceCommand({
          argv: [
            '--all-mvp-gates',
            '--require-synthetic',
            '--forbid-external-providers',
          ],
          environment,
          fetch,
        }),
      ).rejects.toThrow();
      expect(paths).toEqual(['/healthz', '/readyz']);
    };

    await invokeWithReadiness({
      schemaVersion: 1,
      status: 'ready',
      checks: { database: 'ok', worker: 'ok', powersync: 'ok' },
    });
    await invokeWithReadiness({
      status: 'ready',
      checks: canonicalReadinessChecks,
    });
    await invokeWithReadiness({
      schemaVersion: 2,
      status: 'ready',
      checks: canonicalReadinessChecks,
    });
    await invokeWithReadiness({
      schemaVersion: 1,
      status: 'ready',
      checks: { ...canonicalReadinessChecks, unexpected: 'ok' },
    });
    await invokeWithReadiness({
      schemaVersion: 1,
      status: 'ready',
      checks: {
        ...canonicalReadinessChecks,
        experience: 'ok',
        'experience.today-read': 'unavailable',
      },
    });
  });

  it('rejects a path that does not publish every required HTTP operation', async () => {
    const paths: string[] = [];
    const fetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path === '/healthz') {
        return jsonWithRequestId({ status: 'ok' });
      }
      if (path === '/readyz') {
        return jsonWithRequestId({
          schemaVersion: 1,
          status: 'ready',
          checks: canonicalReadinessChecks,
        });
      }
      if (path === '/metrics') {
        return problem(401, 'metrics-auth-required');
      }
      if (path === '/openapi.json') {
        return Response.json({
          openapi: '3.1.0',
          paths: {
            ...canonicalOpenApiSurface,
            '/api/v1/experience/finance': { post: {} },
          },
        });
      }
      throw new Error('acceptance advanced past OpenAPI validation');
    });

    await expect(
      runStagingAcceptanceCommand({
        argv: [
          '--all-mvp-gates',
          '--require-synthetic',
          '--forbid-external-providers',
        ],
        environment,
        fetch,
      }),
    ).rejects.toThrow('Browser/API contract gate failed');
    expect(paths).toEqual(['/healthz', '/readyz', '/metrics', '/openapi.json']);
  });
});

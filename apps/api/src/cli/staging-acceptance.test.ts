import { describe, expect, it, vi } from 'vitest';

import { runStagingAcceptanceCommand } from './staging-acceptance.js';

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
  EMDO_SYNTHETIC_OWNER_EMAIL: 'synthetic-owner@emdo.invalid',
  EMDO_SYNTHETIC_OWNER_PASSWORD: 'synthetic-password-0123456789',
};

const canonicalReadinessChecks = Object.freeze({
  authority: 'unavailable' as const,
  'authority.authentication': 'ok' as const,
  'authority.household-administration': 'unavailable' as const,
  'authority.proposal-queries': 'unavailable' as const,
  'authority.visual-decisions': 'unavailable' as const,
  'authority.visual-proof-issuance': 'unavailable' as const,
  agents: 'ok' as const,
  'agents.manager-turns': 'ok' as const,
  'agents.run-events': 'ok' as const,
  experience: 'unavailable' as const,
  'experience.activity-read': 'unavailable' as const,
  'experience.finance-read': 'unavailable' as const,
  'experience.finance-imports': 'unavailable' as const,
  'experience.notification-preferences': 'unavailable' as const,
  'experience.schedule-read': 'unavailable' as const,
  'experience.settings-read': 'unavailable' as const,
  'experience.shopping-read': 'ok' as const,
  'experience.today-read': 'unavailable' as const,
  google: 'unavailable' as const,
  'google.connector': 'unavailable' as const,
  sync: 'unavailable' as const,
  'sync.gateway': 'unavailable' as const,
  'sync.jwks': 'unavailable' as const,
  voice: 'unavailable' as const,
  'voice.audio-requests': 'unavailable' as const,
  'voice.provider': 'unavailable' as const,
});

const syntheticHttpSubsetReadiness = Object.freeze({
  schemaVersion: 1,
  profile: 'synthetic-http-subset',
  status: 'ready',
  releaseEligible: false,
  checks: canonicalReadinessChecks,
});

const canonicalOpenApiSurface = Object.freeze({
  '/api/auth/get-session': { get: {} },
  '/api/auth/sign-in/email': { post: {} },
  '/api/v1/auth/csrf': { get: {} },
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
  it('probes the provider-free HTTP subset while worker providers stay disabled', async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname === '/healthz') {
        return jsonWithRequestId({ status: 'ok' });
      }
      if (url.pathname === '/synthetic-staging/readyz') {
        return jsonWithRequestId(syntheticHttpSubsetReadiness);
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
      if (url.pathname === '/api/v1/turns') {
        expect(await request.json()).toEqual({
          schemaVersion: 1,
          message: 'add 2 each Acceptance milk to shopping list',
          routeHint: 'shopping',
        });
        return jsonWithRequestId(
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
          `id: 2\nevent: run.completed\ndata: ${JSON.stringify({
            schemaVersion: 1,
            runId: RUN_ID,
            sequence: 2,
            type: 'run.completed',
            occurredAt: '2026-08-15T20:00:00.000Z',
            data: {
              status: 'completed',
              runId: RUN_ID,
              output: {
                shoppingItem: {
                  id: 'shopping-acceptance-item-v1',
                  name: 'Acceptance milk',
                  unit: 'each',
                  quantityMinorUnits: 2_000,
                },
              },
              executionResolution: {
                status: 'provider-free',
                profile: 'shopping-list-v1',
                reason: 'provider-free-mvp',
              },
            },
          })}\n\n`,
          { headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
        );
      }
      if (url.pathname === '/api/v1/experience/shopping') {
        return jsonWithRequestId({
          schemaVersion: 1,
          items: [
            {
              id: 'shopping-acceptance-item-v1',
              name: 'Acceptance milk',
              unit: 'each',
              quantityMinorUnits: 2_000,
              state: 'active',
            },
          ],
        });
      }
      if (url.pathname.endsWith('/decision')) {
        return problem(403, 'visual-approval-required');
      }
      if (
        url.pathname === '/api/v1/voice/speak' ||
        url.pathname === '/api/v1/connectors/google/authorize'
      ) {
        throw new Error('provider-free HTTP subset invoked a provider path');
      }
      return new Response(null, { status: 404 });
    });

    await expect(
      runStagingAcceptanceCommand({
        argv: [
          '--all-mvp-gates',
          '--require-synthetic',
          '--forbid-worker-provider-execution',
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
        syntheticHttpSubsetReadiness: 'passed',
        authenticatedManagerShoppingFlow: 'passed',
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
    const metricsRequests = requests.filter(
      (request) => new URL(request.url).pathname === '/metrics',
    );
    expect(metricsRequests).toHaveLength(1);
    expect(metricsRequests[0]?.headers.get('authorization')).toBeNull();
    expect(metricsRequests[0]?.headers.get('cookie')).toBeNull();
    expect(
      requests.some((request) =>
        ['/api/v1/voice/speak', '/api/v1/connectors/google/authorize'].includes(
          new URL(request.url).pathname,
        ),
      ),
    ).toBe(false);
    expect(
      requests.some(
        (request) => new URL(request.url).pathname === '/api/v1/turns',
      ),
    ).toBe(true);
    expect(
      requests.some(
        (request) =>
          new URL(request.url).pathname === `/api/v1/runs/${RUN_ID}/events`,
      ),
    ).toBe(true);
    expect(
      requests.some(
        (request) =>
          new URL(request.url).pathname === '/api/v1/experience/shopping',
      ),
    ).toBe(true);
    expect(
      requests.some((request) =>
        new URL(request.url).pathname.startsWith('/api/v1/sync/'),
      ),
    ).toBe(false);
  });

  it.each([
    {
      name: 'liveness',
      expectedPaths: ['/healthz'],
      fetch: async () => Response.json({ status: 'ok' }),
    },
    {
      name: 'readiness',
      expectedPaths: ['/healthz', '/synthetic-staging/readyz'],
      fetch: async (request: Request) =>
        new URL(request.url).pathname === '/healthz'
          ? jsonWithRequestId({ status: 'ok' })
          : Response.json(syntheticHttpSubsetReadiness),
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
            '--forbid-worker-provider-execution',
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
        if (path === '/synthetic-staging/readyz') {
          return jsonWithRequestId(syntheticHttpSubsetReadiness);
        }
        if (path === '/metrics') return response;
        throw new Error(`Unexpected acceptance request: ${path}`);
      });

      await expect(
        runStagingAcceptanceCommand({
          argv: [
            '--all-mvp-gates',
            '--require-synthetic',
            '--forbid-worker-provider-execution',
          ],
          environment,
          fetch,
        }),
      ).rejects.toThrow();
      expect(paths).toEqual([
        '/healthz',
        '/synthetic-staging/readyz',
        '/metrics',
      ]);
    },
  );

  it('rejects partial flags and worker provider execution before HTTP', async () => {
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
          '--forbid-worker-provider-execution',
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
          '--forbid-worker-provider-execution',
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
        if (path === '/synthetic-staging/readyz') {
          return jsonWithRequestId(readiness);
        }
        throw new Error('acceptance advanced past readiness');
      });
      await expect(
        runStagingAcceptanceCommand({
          argv: [
            '--all-mvp-gates',
            '--require-synthetic',
            '--forbid-worker-provider-execution',
          ],
          environment,
          fetch,
        }),
      ).rejects.toThrow();
      expect(paths).toEqual(['/healthz', '/synthetic-staging/readyz']);
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
    await invokeWithReadiness({
      ...syntheticHttpSubsetReadiness,
      checks: {
        ...canonicalReadinessChecks,
        agents: 'unavailable',
        'agents.manager-turns': 'unavailable',
      },
    });
    await invokeWithReadiness({
      ...syntheticHttpSubsetReadiness,
      checks: {
        ...canonicalReadinessChecks,
        google: 'ok',
        'google.connector': 'ok',
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
      if (path === '/synthetic-staging/readyz') {
        return jsonWithRequestId(syntheticHttpSubsetReadiness);
      }
      if (path === '/metrics') {
        return problem(401, 'metrics-auth-required');
      }
      if (path === '/openapi.json') {
        return Response.json({
          openapi: '3.1.0',
          paths: {
            ...Object.fromEntries(
              Object.entries(canonicalOpenApiSurface).filter(
                ([name]) => name !== '/api/v1/experience/shopping',
              ),
            ),
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
          '--forbid-worker-provider-execution',
        ],
        environment,
        fetch,
      }),
    ).rejects.toThrow('Browser/API contract gate failed');
    expect(paths).toEqual([
      '/healthz',
      '/synthetic-staging/readyz',
      '/metrics',
      '/openapi.json',
    ]);
  });
});

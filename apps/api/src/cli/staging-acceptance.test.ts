import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  formatStagingAcceptanceFailure,
  runStagingAcceptanceCommand,
} from './staging-acceptance.js';

type FinanceAcceptanceStage = Parameters<
  NonNullable<
    Parameters<typeof runStagingAcceptanceCommand>[0]['financeStageReporter']
  >
>[0];

const USER_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f92';
const RUN_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f93';
const REQUEST_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5faa';
const SOURCE_SHA = 'a'.repeat(40);
const WORKFLOW_RUN_ID = '123456789';
const OBSERVED_AT = new Date('2026-08-12T15:30:00.000Z');
const FINANCE_DOCUMENT_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f94';
const FINANCE_MEMBER_USER_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f95';
const FINANCE_MEMBER_EMAIL = 'finance-staging-member@emdo.invalid';
const FINANCE_EVIDENCE_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f99';
const FINANCE_COMMIT_RUN_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5fa2';
const FINANCE_QNA_RUN_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5fa3';
const FINANCE_WRITE_RUN_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5fa4';
const FINANCE_DELETE_RUN_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5fa5';
const FINANCE_COMMIT_PROPOSAL_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5fa6';
const FINANCE_DELETE_PROPOSAL_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5fa7';
const FINANCE_PAYLOAD_HASH = '1'.repeat(64);
const FINANCE_APPROVAL_HASH = '2'.repeat(64);
const FINANCE_VISUAL_PROOF_TOKEN = 'v'.repeat(43);

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

const financeEnvironment = {
  ...environment,
  EMDO_FINANCE_SYNTHETIC_STAGING: 'true',
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
  'experience.finance-documents': 'unavailable' as const,
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

const financeMemberOpenApiSurface = Object.freeze({
  ...canonicalOpenApiSurface,
  '/api/v1/auth/invitations/csrf': { get: {} },
  '/api/v1/finance/documents': { get: {}, post: {} },
  '/api/v1/finance/documents/{id}': { get: {}, delete: {} },
  '/api/v1/finance/documents/{id}/original': { get: {} },
  '/api/v1/finance/documents/{id}/review': { get: {}, patch: {} },
  '/api/v1/finance/documents/{id}/review/commit': { post: {} },
  '/api/v1/finance/documents/{id}/matches': { get: {} },
  '/api/v1/finance/evidence/{id}': { get: {} },
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

const financeCommand = (value: Readonly<Record<string, unknown>>) =>
  `EMDO_FINANCE_STAGING_V1 ${JSON.stringify(value)}`;

const sse = (events: readonly Readonly<Record<string, unknown>>[]) =>
  new Response(
    events
      .map(
        (event) =>
          `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(''),
    { headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
  );

const financeOutput = (input: {
  readonly summary: string;
  readonly evidenceReferences?: readonly string[];
  readonly actionProposalReferences?: readonly string[];
}) => ({
  summary: input.summary,
  clarificationQuestion: null,
  evidenceReferences: input.evidenceReferences ?? [],
  derivedValueReferences: [],
  actionProposalReferences: input.actionProposalReferences ?? [],
});

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
        return new Response(null, { status: 404 });
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
          `id: 1\nevent: specialist.completed\ndata: ${JSON.stringify({
            schemaVersion: 1,
            runId: RUN_ID,
            sequence: 1,
            type: 'specialist.completed',
            occurredAt: '2026-08-15T19:59:59.000Z',
            data: {
              status: 'completed',
            },
          })}\n\n` +
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
        return new Response(null, { status: 404 });
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

  it('proves Finance phase 1 through guarded turns, then finalizes only from a receipt-bound root handoff', async () => {
    const requests: Request[] = [];
    const handoffs: unknown[] = [];
    const phaseOneStages: FinanceAcceptanceStage[] = [];
    let uploaded:
      { readonly bytes: Buffer; readonly sha256: string } | undefined;
    let reviewReads = 0;
    let committed = false;
    let deleted = false;
    let manualTransaction = false;
    const reviewEnvelope = {
      schemaVersion: 1,
      sourceLocale: 'en-CA',
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
      documentType: 'receipt',
      merchant: 'EMDO synthetic merchant',
      purchasedOn: '2026-08-12',
      tip: null,
      paymentMethodLast4: null,
      lineItems: [],
      proposedRecord: {
        kind: 'expense',
        amount: { currency: 'CAD', minorUnits: 123 },
        occurredOn: '2026-08-12',
        description: 'EMDO synthetic expense',
      },
    } as const;
    const document = () => {
      if (uploaded === undefined) throw new Error('fixture upload missing');
      if (deleted)
        return {
          schemaVersion: 1,
          id: FINANCE_DOCUMENT_ID,
          documentType: null,
          sourceLocale: null,
          currency: null,
          state: 'deleted',
          displayName: null,
          mimeType: null,
          byteSize: null,
          plaintextSha256: null,
          extractionRevision: null,
          createdAt: '2026-08-12T15:00:00.000Z',
          updatedAt: '2026-08-12T16:00:00.000Z',
        };
      const state = committed
        ? 'committed'
        : reviewReads < 2
          ? 'extracting'
          : 'awaiting-review';
      return {
        schemaVersion: 1,
        id: FINANCE_DOCUMENT_ID,
        documentType: state === 'extracting' ? null : 'receipt',
        sourceLocale: state === 'extracting' ? null : 'en-CA',
        currency: state === 'extracting' ? null : 'CAD',
        state,
        displayName: 'emdo-synthetic-staging.pdf',
        mimeType: 'application/pdf',
        byteSize: uploaded.bytes.byteLength,
        plaintextSha256: uploaded.sha256,
        extractionRevision: 1,
        createdAt: '2026-08-12T15:00:00.000Z',
        updatedAt: '2026-08-12T15:00:00.000Z',
      };
    };
    const proposal = (id: string) => ({
      schemaVersion: 1,
      id,
      version: 1,
      state: 'pending',
      kind: 'finance.records.write',
      title: 'Review Finance action',
      summary: 'A staged Finance action needs approval.',
      createdAt: '2026-08-12T15:00:00.000Z',
      expiresAt: '2026-08-12T16:00:00.000Z',
      payloadHash: FINANCE_PAYLOAD_HASH,
      approvalHash: FINANCE_APPROVAL_HASH,
      beforePreview: { summary: 'No change yet.' },
      afterPreview: { summary: 'Approved change.' },
      fields: [],
    });
    const accepted = (runId: string) =>
      jsonWithRequestId(
        {
          schemaVersion: 1,
          runId,
          status: 'accepted',
          replayed: false,
          eventsPath: `/api/v1/runs/${runId}/events`,
        },
        { status: 202 },
      );
    const approvalEvents = (runId: string, proposalId: string) =>
      sse([
        {
          schemaVersion: 1,
          runId,
          sequence: 1,
          type: 'specialist.interrupted',
          occurredAt: '2026-08-12T15:05:00.000Z',
          data: { status: 'interrupted' },
        },
        {
          schemaVersion: 1,
          runId,
          sequence: 2,
          type: 'approval.required',
          occurredAt: '2026-08-12T15:05:01.000Z',
          data: {
            status: 'needs-approval',
            runId,
            interruptions: [
              {
                id: 'finance-synthetic-staging:finance-synthetic-staging-v1',
                agentId: 'finance',
                capabilityId: 'finance.records.write',
                proposalId,
                argumentsPreview: { summary: 'Guarded finance mutation.' },
              },
            ],
          },
        },
      ]);
    const completedEvents = (runId: string, output: unknown, after = 0) =>
      sse([
        ...(after === 0
          ? []
          : [
              {
                schemaVersion: 1,
                runId,
                sequence: after + 1,
                type: 'specialist.completed',
                occurredAt: '2026-08-12T15:05:02.000Z',
                data: { status: 'completed' },
              },
            ]),
        {
          schemaVersion: 1,
          runId,
          sequence: after === 0 ? 1 : after + 2,
          type: 'run.completed',
          occurredAt: '2026-08-12T15:05:03.000Z',
          data: { status: 'completed', runId, output },
        },
      ]);
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request);
      const url = new URL(request.url);
      const member =
        request.headers.get('cookie')?.includes('finance-member-session') ===
        true;
      if (url.pathname === '/healthz')
        return jsonWithRequestId({ status: 'ok' });
      if (url.pathname === '/openapi.json')
        return Response.json({
          openapi: '3.1.0',
          paths: {
            '/api/auth/get-session': { get: {} },
            '/api/auth/sign-in/email': { post: {} },
            '/api/v1/auth/csrf': { get: {} },
            '/api/v1/auth/invitations/csrf': { get: {} },
            '/api/v1/auth/invitations/redeem': { post: {} },
            '/api/v1/household/invitations': { post: {} },
            '/api/v1/household/memberships': { get: {} },
            '/api/v1/turns': { post: {} },
            '/api/v1/runs/{id}/events': { get: {} },
            '/api/v1/proposals/{id}': { get: {} },
            '/api/v1/proposals/{id}/visual-proof': { post: {} },
            '/api/v1/proposals/{id}/decision': { post: {} },
            '/api/v1/finance/documents': { get: {}, post: {} },
            '/api/v1/finance/documents/{id}': { get: {}, delete: {} },
            '/api/v1/finance/documents/{id}/original': { get: {} },
            '/api/v1/finance/documents/{id}/review': { get: {}, patch: {} },
            '/api/v1/finance/documents/{id}/review/commit': { post: {} },
            '/api/v1/finance/documents/{id}/matches': { get: {} },
            '/api/v1/finance/evidence/{id}': { get: {} },
            '/api/v1/experience/finance': { get: {} },
          },
        });
      if (url.pathname === '/api/auth/sign-in/email') {
        const body = (await request.json()) as { email: string };
        return new Response('{"ok":true}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'set-cookie': `__Secure-emdo.session_token=${body.email === FINANCE_MEMBER_EMAIL ? 'finance-member-session' : 'finance-owner-session'}; Path=/; Secure; HttpOnly`,
          },
        });
      }
      if (url.pathname === '/api/auth/get-session')
        return Response.json({
          user: { id: member ? FINANCE_MEMBER_USER_ID : USER_ID },
          session: { id: 'opaque' },
        });
      if (url.pathname === '/api/v1/auth/csrf')
        return new Response(
          JSON.stringify({
            schemaVersion: 1,
            token: member
              ? 'finance-member-csrf-token-0123456789'
              : 'finance-owner-csrf-token-01234567890123456789',
          }),
          {
            headers: {
              'content-type': 'application/json',
              'set-cookie': `emdo.csrf_token=${member ? 'finance-member-csrf-token-0123456789' : 'finance-owner-csrf-token-01234567890123456789'}; Path=/api/; Secure; HttpOnly`,
              'x-request-id': REQUEST_ID,
            },
          },
        );
      if (url.pathname === '/api/v1/household/invitations')
        return jsonWithRequestId(
          {
            schemaVersion: 1,
            invitation: {
              id: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f96',
              email: FINANCE_MEMBER_EMAIL,
              role: 'member',
              status: 'pending',
              deliveryStatus: 'queued',
              version: 1,
              createdAt: '2026-08-12T15:00:00.000Z',
              expiresAt: '2026-08-12T15:15:00.000Z',
            },
            replayed: false,
          },
          { status: 201 },
        );
      if (url.pathname === '/api/internal/finance-synthetic/invitation-token')
        return jsonWithRequestId({
          schemaVersion: 1,
          invitationToken: 'd'.repeat(43),
        });
      if (url.pathname === '/api/v1/auth/invitations/csrf')
        return new Response(
          JSON.stringify({
            schemaVersion: 1,
            token: 'finance-invitation-csrf-token-0123456789',
          }),
          {
            headers: {
              'content-type': 'application/json',
              'set-cookie':
                'emdo.invitation_csrf=finance-invitation-csrf-token-0123456789; Path=/api/; Secure; HttpOnly',
              'x-request-id': REQUEST_ID,
            },
          },
        );
      if (url.pathname === '/api/v1/auth/invitations/redeem')
        return jsonWithRequestId(
          {
            schemaVersion: 1,
            userId: FINANCE_MEMBER_USER_ID,
            householdId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f97',
            role: 'member',
            emailVerified: true,
          },
          { status: 201 },
        );
      if (url.pathname === '/api/v1/household/memberships')
        return jsonWithRequestId({
          schemaVersion: 1,
          memberships: [
            {
              id: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f98',
              userId: FINANCE_MEMBER_USER_ID,
              email: FINANCE_MEMBER_EMAIL,
              role: 'member',
              status: 'active',
              version: 1,
              joinedAt: '2026-08-12T15:01:00.000Z',
            },
          ],
        });
      if (
        url.pathname === '/api/v1/finance/documents' &&
        request.method === 'POST'
      ) {
        const file = (await request.formData()).get('file');
        if (!(file instanceof File)) throw new Error('expected Finance PDF');
        const bytes = Buffer.from(await file.arrayBuffer());
        uploaded = {
          bytes,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
        return jsonWithRequestId(document(), { status: 201 });
      }
      if (
        url.pathname === '/api/v1/finance/documents' &&
        request.method === 'GET'
      )
        return jsonWithRequestId({ schemaVersion: 1, items: [] });
      if (
        url.pathname === `/api/v1/finance/documents/${FINANCE_DOCUMENT_ID}` &&
        request.method === 'GET'
      ) {
        if (member) return problem(404, 'document-not-found');
        reviewReads += 1;
        return jsonWithRequestId({
          schemaVersion: 1,
          document: document(),
          reviewAvailable: !committed && !deleted && reviewReads >= 2,
          matchCount: 0,
        });
      }
      if (
        url.pathname ===
        `/api/v1/finance/documents/${FINANCE_DOCUMENT_ID}/original`
      ) {
        if (request.headers.get('cookie') === null)
          return problem(401, 'authentication-required');
        if (member) return problem(404, 'document-not-found');
        if (deleted) return problem(409, 'document-state-conflict');
        if (uploaded === undefined) throw new Error('fixture upload missing');
        const originalBytes = new Uint8Array(uploaded.bytes.byteLength);
        originalBytes.set(uploaded.bytes);
        return new Response(originalBytes, {
          headers: {
            'cache-control': 'no-store, private',
            'content-type': 'application/pdf',
            'x-request-id': REQUEST_ID,
          },
        });
      }
      if (
        url.pathname ===
          `/api/v1/finance/documents/${FINANCE_DOCUMENT_ID}/review` &&
        request.method === 'GET'
      ) {
        if (member || deleted) return problem(404, 'document-not-found');
        return jsonWithRequestId({
          schemaVersion: 1,
          documentId: FINANCE_DOCUMENT_ID,
          extractionRevision: 1,
          envelope: reviewEnvelope,
          payloadHash: '1'.repeat(64),
          reviewToken: 'a'.repeat(43),
          expiresAt: '2026-08-12T16:00:00.000Z',
        });
      }
      if (
        url.pathname ===
          `/api/v1/finance/documents/${FINANCE_DOCUMENT_ID}/review` &&
        request.method === 'PATCH'
      ) {
        expect(await request.json()).toMatchObject({
          schemaVersion: 1,
          expectedExtractionRevision: 1,
          envelope: { issuer: 'EMDO synthetic staged review' },
        });
        return jsonWithRequestId({
          schemaVersion: 1,
          documentId: FINANCE_DOCUMENT_ID,
          extractionRevision: 1,
          envelope: {
            ...reviewEnvelope,
            issuer: 'EMDO synthetic staged review',
          },
          payloadHash: '2'.repeat(64),
          reviewToken: 'b'.repeat(43),
          expiresAt: '2026-08-12T16:00:00.000Z',
        });
      }
      if (
        url.pathname ===
        `/api/v1/finance/documents/${FINANCE_DOCUMENT_ID}/review/commit`
      )
        return problem(409, 'approval-required');
      if (
        url.pathname ===
        `/api/v1/finance/documents/${FINANCE_DOCUMENT_ID}/matches`
      )
        return member || deleted
          ? problem(404, 'document-not-found')
          : jsonWithRequestId({ schemaVersion: 1, items: [] });
      if (url.pathname === `/api/v1/finance/evidence/${FINANCE_EVIDENCE_ID}`)
        return member || deleted
          ? problem(404, 'evidence-not-found')
          : jsonWithRequestId({
              schemaVersion: 1,
              items: [
                {
                  schemaVersion: 1,
                  id: FINANCE_EVIDENCE_ID,
                  documentId: FINANCE_DOCUMENT_ID,
                  extractionRevision: 1,
                  page: 1,
                  excerpt: 'Synthetic evidence.',
                  sourceLocale: 'en-CA',
                  locator: { page: 1 },
                },
              ],
            });
      if (
        url.pathname === `/api/v1/finance/documents/${FINANCE_DOCUMENT_ID}` &&
        request.method === 'DELETE'
      )
        return problem(409, 'approval-required');
      if (url.pathname === '/api/v1/experience/finance') {
        if (url.search)
          return jsonWithRequestId({
            schemaVersion: 1,
            items: manualTransaction
              ? [
                  {
                    recordType: 'transaction',
                    id: 'finance-synthetic-staging-manual-transaction-v1',
                    description: 'EMDO synthetic staging manual transaction',
                    category: 'uncategorized',
                    postedOn: '2026-08-12',
                    currency: 'CAD',
                    amountCadMinor: -123,
                    state: 'active',
                  },
                ]
              : [],
          });
        return jsonWithRequestId({
          schemaVersion: 1,
          locale: 'en-CA',
          connectivity: 'online',
          quota: {
            documentsUsed: deleted ? 0 : 1,
            documentsLimit: 10_000,
            bytesUsed: deleted ? 0 : (uploaded?.bytes.byteLength ?? 1),
            bytesLimit: 50 * 1024 * 1024 * 1024,
          },
          reviewedCadTotals: [],
          recentActivity: [],
          budgets: [],
        });
      }
      if (url.pathname === '/api/v1/turns') {
        const body = (await request.json()) as {
          message: string;
          routeHint: string;
        };
        expect(body.routeHint).toBe('finance');
        if (
          body.message ===
          financeCommand({
            schemaVersion: 1,
            action: 'commit-document-review',
            documentId: FINANCE_DOCUMENT_ID,
          })
        )
          return accepted(FINANCE_COMMIT_RUN_ID);
        if (
          body.message ===
          financeCommand({
            schemaVersion: 1,
            action: 'search-document',
            query: 'EMDO synthetic staged review',
          })
        )
          return accepted(FINANCE_QNA_RUN_ID);
        if (
          body.message ===
          financeCommand({
            schemaVersion: 1,
            action: 'create-manual-transaction',
            recordId: 'finance-synthetic-staging-manual-transaction-v1',
            record: {
              recordType: 'transaction',
              accountId: 'synthetic-finance-account-v1',
              categoryId: null,
              postedOn: '2026-08-12',
              description: 'EMDO synthetic staging manual transaction',
              amountCadMinor: -123,
            },
          })
        )
          return accepted(FINANCE_WRITE_RUN_ID);
        if (
          body.message ===
          financeCommand({
            schemaVersion: 1,
            action: 'delete-document',
            documentId: FINANCE_DOCUMENT_ID,
          })
        )
          return accepted(FINANCE_DELETE_RUN_ID);
        throw new Error('unexpected Finance turn shape');
      }
      if (url.pathname.startsWith('/api/v1/runs/')) {
        const runId = url.pathname.split('/')[4];
        const after = request.headers.get('last-event-id');
        if (runId === FINANCE_COMMIT_RUN_ID)
          return after === null
            ? approvalEvents(runId, FINANCE_COMMIT_PROPOSAL_ID)
            : completedEvents(
                runId,
                financeOutput({
                  summary: 'The reviewed document was committed.',
                  actionProposalReferences: [FINANCE_COMMIT_PROPOSAL_ID],
                }),
                2,
              );
        if (runId === FINANCE_DELETE_RUN_ID)
          return after === null
            ? approvalEvents(runId, FINANCE_DELETE_PROPOSAL_ID)
            : completedEvents(
                runId,
                financeOutput({
                  summary: 'The document was deleted.',
                  actionProposalReferences: [FINANCE_DELETE_PROPOSAL_ID],
                }),
                2,
              );
        if (runId === FINANCE_QNA_RUN_ID)
          return completedEvents(
            runId,
            financeOutput({
              summary: 'Found one reviewed finance document result.',
              evidenceReferences: [FINANCE_EVIDENCE_ID],
            }),
          );
        if (runId === FINANCE_WRITE_RUN_ID) {
          manualTransaction = true;
          return completedEvents(
            runId,
            financeOutput({ summary: 'The manual transaction was recorded.' }),
          );
        }
      }
      if (url.pathname.startsWith('/api/v1/proposals/')) {
        const proposalId = url.pathname.split('/')[4];
        if (url.pathname.endsWith('/visual-proof')) {
          expect(await request.json()).toEqual({
            schemaVersion: 1,
            proposalVersion: 1,
            payloadHash: FINANCE_PAYLOAD_HASH,
            approvalHash: FINANCE_APPROVAL_HASH,
          });
          return jsonWithRequestId({
            schemaVersion: 1,
            proposalId,
            proposalVersion: 1,
            payloadHash: FINANCE_PAYLOAD_HASH,
            approvalHash: FINANCE_APPROVAL_HASH,
            proofToken: FINANCE_VISUAL_PROOF_TOKEN,
            issuedAt: '2026-08-12T15:06:00.000Z',
            expiresAt: '2026-08-12T15:07:00.000Z',
            replayed: false,
          });
        }
        if (url.pathname.endsWith('/decision')) {
          const body = (await request.json()) as {
            proposalId: string;
            decision: string;
            idempotencyKey: string;
          };
          expect(request.headers.get('x-emdo-visual-confirmation')).toBe(
            FINANCE_VISUAL_PROOF_TOKEN,
          );
          expect(body.proposalId).toBe(proposalId);
          expect(body.decision).toBe('approved');
          if (proposalId === FINANCE_COMMIT_PROPOSAL_ID) committed = true;
          if (proposalId === FINANCE_DELETE_PROPOSAL_ID) deleted = true;
          return jsonWithRequestId({
            schemaVersion: 1,
            id:
              proposalId === FINANCE_COMMIT_PROPOSAL_ID
                ? '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5fa8'
                : '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5fa9',
            proposalId,
            payloadHash: FINANCE_PAYLOAD_HASH,
            approvalHash: FINANCE_APPROVAL_HASH,
            decision: 'approved',
            channel: 'authenticated-visual',
            decidedAt: '2026-08-12T15:06:30.000Z',
            idempotencyKey: body.idempotencyKey,
          });
        }
        return jsonWithRequestId(proposal(proposalId));
      }
      throw new Error(`Unexpected Finance acceptance request: ${url.pathname}`);
    });

    const phaseOne = await runStagingAcceptanceCommand({
      argv: [
        '--all-mvp-gates',
        '--require-synthetic',
        '--forbid-worker-provider-execution',
        '--finance-synthetic-document-gates',
      ],
      environment: financeEnvironment,
      fetch,
      now: () => OBSERVED_AT,
      sleep: async () => undefined,
      financeStageReporter: (stage) => {
        phaseOneStages.push(stage);
      },
      financeRestoreVerifierHandoffWriter: async (handoff) => {
        handoffs.push(handoff);
      },
    });
    expect(phaseOne).toMatchObject({
      outcome: 'blocked',
      releaseEligible: false,
      proof: {
        guardedReviewCommit: 'passed',
        directSafeWrite: 'passed',
        financeQnaThroughEmdo: 'passed',
        citedEvidenceReadback: 'passed',
        approvedDeletePurge: 'blocked',
        backupRestore: 'blocked',
      },
      blockers: [
        'approved-document-purge-awaiting-backup',
        'backup-restore-awaiting-root-drill',
      ],
    });
    expect(handoffs).toHaveLength(1);
    expect(phaseOneStages).toEqual([
      'configuration',
      'health-and-contract',
      'owner-authentication',
      'member-invitation',
      'member-token-handoff',
      'member-redemption',
      'member-membership-readback',
      'member-authentication',
      'document-upload',
      'document-extraction-terminal',
      'document-original-readback',
      'document-review-read-edit',
      'document-direct-commit-denial',
      'guarded-review-commit',
      'guarded-delete-denial',
      'qna-and-isolation',
      'safe-write-and-handoff',
    ]);
    expect(JSON.stringify(phaseOne)).not.toContain('finance-owner-session');
    expect(JSON.stringify(phaseOne)).not.toContain('Synthetic evidence.');

    const phaseTwo = await runStagingAcceptanceCommand({
      argv: [
        '--all-mvp-gates',
        '--require-synthetic',
        '--forbid-worker-provider-execution',
        '--finance-synthetic-document-gates',
        '--finance-synthetic-document-finalize',
      ],
      environment: financeEnvironment,
      fetch,
      now: () => OBSERVED_AT,
      financePhase2RootAttestationReader: async () => ({
        sourceSha: SOURCE_SHA,
        workflowRunId: WORKFLOW_RUN_ID,
        documentId: FINANCE_DOCUMENT_ID,
        evidenceId: FINANCE_EVIDENCE_ID,
        backupRestoreReceiptSha256: 'f'.repeat(64),
      }),
    });
    expect(phaseTwo).toMatchObject({
      outcome: 'passed',
      releaseEligible: false,
      proof: {
        extractionToReview: 'passed',
        guardedReviewCommit: 'passed',
        directSafeWrite: 'passed',
        financeQnaThroughEmdo: 'passed',
        citedEvidenceReadback: 'passed',
        approvedDeletePurge: 'passed',
        guardedDeleteThroughEmdo: 'passed',
        deletedTombstonePurge: 'passed',
        ownerContentRevocation: 'passed',
        memberContentRevocation: 'passed',
        backupRestore: 'passed',
      },
      blockers: [],
    });
    expect(
      requests.every(
        (request) => new URL(request.url).origin === 'http://127.0.0.1:3000',
      ),
    ).toBe(true);
    expect(
      requests.filter(
        (request) => new URL(request.url).pathname === '/api/v1/turns',
      ),
    ).toHaveLength(4);
    expect(
      requests.some(
        (request) => new URL(request.url).pathname === '/api/v1/finance/chat',
      ),
    ).toBe(false);
  });

  it('fails closed before HTTP when the phase-2 handoff lacks a receipt digest', async () => {
    const fetch = vi.fn();
    let reportedStage: FinanceAcceptanceStage | null = null;
    await expect(
      runStagingAcceptanceCommand({
        argv: [
          '--all-mvp-gates',
          '--require-synthetic',
          '--forbid-worker-provider-execution',
          '--finance-synthetic-document-gates',
          '--finance-synthetic-document-finalize',
        ],
        environment: financeEnvironment,
        fetch,
        financeStageReporter: (stage) => {
          reportedStage = stage;
        },
        financePhase2RootAttestationReader: async () => ({
          sourceSha: SOURCE_SHA,
          workflowRunId: WORKFLOW_RUN_ID,
          documentId: FINANCE_DOCUMENT_ID,
          evidenceId: FINANCE_EVIDENCE_ID,
          backupRestoreReceiptSha256: 'not-a-digest',
        }),
      }),
    ).rejects.toThrow('Finance staging finalization handoff is invalid');
    expect(fetch).not.toHaveBeenCalled();
    expect(formatStagingAcceptanceFailure(reportedStage ?? undefined)).toBe(
      'Staging acceptance failed at stage=finalize-attestation.\n',
    );
  });

  it('reports finalization configuration before reading the phase-2 handoff', async () => {
    const fetch = vi.fn();
    const readAttestation = vi.fn();
    let reportedStage: FinanceAcceptanceStage | null = null;
    await expect(
      runStagingAcceptanceCommand({
        argv: [
          '--all-mvp-gates',
          '--require-synthetic',
          '--forbid-worker-provider-execution',
          '--finance-synthetic-document-gates',
          '--finance-synthetic-document-finalize',
        ],
        environment,
        fetch,
        financeStageReporter: (stage) => {
          reportedStage = stage;
        },
        financePhase2RootAttestationReader: readAttestation,
      }),
    ).rejects.toThrow('Finance staging finalization configuration is invalid');
    expect(fetch).not.toHaveBeenCalled();
    expect(readAttestation).not.toHaveBeenCalled();
    expect(formatStagingAcceptanceFailure(reportedStage ?? undefined)).toBe(
      'Staging acceptance failed at stage=finalize-configuration.\n',
    );
  });

  it('reports only a fixed Finance stage when an underlying failure contains sensitive text', async () => {
    const sensitiveFailure =
      'cookie=owner-secret token=provider-secret document=private-content';
    let reportedStage: FinanceAcceptanceStage | null = null;
    await expect(
      runStagingAcceptanceCommand({
        argv: [
          '--all-mvp-gates',
          '--require-synthetic',
          '--forbid-worker-provider-execution',
          '--finance-synthetic-document-gates',
        ],
        environment: financeEnvironment,
        fetch: async () => {
          throw new Error(sensitiveFailure);
        },
        financeStageReporter: (stage) => {
          reportedStage = stage;
        },
      }),
    ).rejects.toThrow(sensitiveFailure);

    const message = formatStagingAcceptanceFailure(reportedStage ?? undefined);
    expect(message).toBe(
      'Staging acceptance failed at stage=health-and-contract.\n',
    );
    expect(message).not.toContain('owner-secret');
    expect(message).not.toContain('provider-secret');
    expect(message).not.toContain('private-content');
    expect(formatStagingAcceptanceFailure(undefined)).toBe(
      'Staging acceptance failed.\n',
    );
    expect(
      formatStagingAcceptanceFailure(
        'member-invitation:http-503-private-content' as never,
      ),
    ).toBe('Staging acceptance failed.\n');
  });

  it.each([
    {
      failurePath: '/api/v1/household/invitations',
      failure: { kind: 'throw' },
      expectedFailure:
        'Staging acceptance failed at stage=member-invitation outcome=request-or-network-failed.\n',
    },
    {
      failurePath: '/api/v1/household/invitations',
      failure: { kind: 'problem', status: 400, code: 'invalid-input' },
      expectedFailure:
        'Staging acceptance failed at stage=member-invitation outcome=http-400-invalid-input.\n',
    },
    {
      failurePath: '/api/v1/household/invitations',
      failure: { kind: 'problem', status: 500, code: 'internal-error' },
      expectedFailure:
        'Staging acceptance failed at stage=member-invitation outcome=http-500-internal-error.\n',
    },
    {
      failurePath: '/api/v1/household/invitations',
      failure: { kind: 'problem', status: 503, code: 'invalid-result' },
      expectedFailure:
        'Staging acceptance failed at stage=member-invitation outcome=http-503-invalid-result.\n',
    },
    {
      failurePath: '/api/v1/household/invitations',
      failure: { kind: 'problem', status: 418, code: 'private-id' },
      expectedFailure:
        'Staging acceptance failed at stage=member-invitation outcome=http-problem-unrecognized.\n',
    },
    {
      failurePath: '/api/v1/household/invitations',
      failure: { kind: 'malformed-problem' },
      expectedFailure:
        'Staging acceptance failed at stage=member-invitation outcome=http-problem-unrecognized.\n',
    },
    {
      failurePath: '/api/v1/household/invitations',
      failure: { kind: 'invalid-readback' },
      expectedFailure:
        'Staging acceptance failed at stage=member-invitation outcome=readback-invalid.\n',
    },
    {
      failurePath: '/api/internal/finance-synthetic/invitation-token',
      failure: { kind: 'throw' },
      expectedFailure:
        'Staging acceptance failed at stage=member-token-handoff.\n',
    },
    {
      failurePath: '/api/v1/auth/invitations/csrf',
      failure: { kind: 'throw' },
      expectedFailure:
        'Staging acceptance failed at stage=member-redemption.\n',
    },
    {
      failurePath: '/api/v1/household/memberships',
      failure: { kind: 'throw' },
      expectedFailure:
        'Staging acceptance failed at stage=member-membership-readback.\n',
    },
    {
      failurePath: '/api/v1/finance/documents',
      failure: { kind: 'throw' },
      expectedFailure:
        'Staging acceptance failed at stage=document-upload outcome=request-or-network-failed.\n',
    },
    {
      failurePath: '/api/v1/finance/documents',
      failure: { kind: 'problem', status: 500, code: 'internal-error' },
      expectedFailure:
        'Staging acceptance failed at stage=document-upload outcome=http-500-internal-error.\n',
    },
    {
      failurePath: '/api/v1/finance/documents',
      failure: {
        kind: 'problem',
        status: 503,
        code: 'finance-documents-unavailable',
      },
      expectedFailure:
        'Staging acceptance failed at stage=document-upload outcome=http-503-finance-documents-unavailable.\n',
    },
    {
      failurePath: '/api/v1/finance/documents',
      failure: { kind: 'problem', status: 418, code: 'private-id' },
      expectedFailure:
        'Staging acceptance failed at stage=document-upload outcome=http-problem-unrecognized.\n',
    },
    {
      failurePath: '/api/v1/finance/documents',
      failure: { kind: 'malformed-problem' },
      expectedFailure:
        'Staging acceptance failed at stage=document-upload outcome=http-problem-unrecognized.\n',
    },
    {
      failurePath: '/api/v1/finance/documents',
      failure: { kind: 'invalid-upload-readback' },
      expectedFailure:
        'Staging acceptance failed at stage=document-upload outcome=201-json-or-schema-invalid.\n',
    },
    {
      failurePath: '/api/v1/finance/documents',
      failure: { kind: 'upload-metadata-mismatch' },
      expectedFailure:
        'Staging acceptance failed at stage=document-upload outcome=synthetic-metadata-or-hash-mismatch.\n',
    },
  ] as const)(
    'reports only a fixed member provisioning or document upload failure outcome',
    async ({ failurePath, failure, expectedFailure }) => {
      const sensitiveFailure =
        'cookie=owner-secret token=invitation-secret member=private-id';
      let reportedStage: FinanceAcceptanceStage | null = null;
      const fetch = vi.fn(async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === failurePath) {
          if (failure.kind === 'throw') throw new Error(sensitiveFailure);
          if (failure.kind === 'problem') {
            return Response.json(
              {
                type: 'about:blank',
                title: sensitiveFailure,
                status: failure.status,
                code: failure.code,
                detail: sensitiveFailure,
                requestId: REQUEST_ID,
              },
              {
                status: failure.status,
                headers: {
                  'content-type': 'application/problem+json',
                  'x-request-id': REQUEST_ID,
                },
              },
            );
          }
          if (failure.kind === 'malformed-problem') {
            return Response.json(
              {
                type: 'about:blank',
                title: sensitiveFailure,
                status: 503,
                code: 'invalid-result',
                detail: sensitiveFailure,
              },
              {
                status: 503,
                headers: { 'content-type': 'application/problem+json' },
              },
            );
          }
          if (failure.kind === 'invalid-upload-readback') {
            return jsonWithRequestId(
              { privateDocumentContent: sensitiveFailure },
              { status: 201 },
            );
          }
          if (failure.kind === 'upload-metadata-mismatch') {
            return jsonWithRequestId(
              {
                schemaVersion: 1,
                id: FINANCE_DOCUMENT_ID,
                documentType: null,
                sourceLocale: null,
                currency: null,
                state: 'uploaded',
                displayName: 'private-statement.pdf',
                mimeType: 'application/pdf',
                byteSize: 1,
                plaintextSha256: 'e'.repeat(64),
                extractionRevision: null,
                createdAt: '2026-08-12T15:00:00.000Z',
                updatedAt: '2026-08-12T15:00:00.000Z',
              },
              { status: 201 },
            );
          }
          return jsonWithRequestId(
            {
              schemaVersion: 1,
              invitation: {
                id: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f96',
                email: 'private-id@emdo.invalid',
                role: 'member',
                status: 'pending',
                deliveryStatus: 'queued',
                version: 1,
                createdAt: '2026-08-12T15:00:00.000Z',
                expiresAt: '2026-08-12T15:15:00.000Z',
              },
              replayed: false,
            },
            { status: 201 },
          );
        }
        if (path === '/healthz') return jsonWithRequestId({ status: 'ok' });
        if (path === '/openapi.json')
          return Response.json({
            openapi: '3.1.0',
            paths: financeMemberOpenApiSurface,
          });
        if (path === '/api/auth/sign-in/email') {
          const body = (await request.json()) as { email: string };
          const member = body.email === FINANCE_MEMBER_EMAIL;
          return new Response('{"ok":true}', {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'set-cookie': `__Secure-emdo.session_token=${member ? 'finance-member-session' : 'finance-owner-session'}; Path=/; Secure; HttpOnly`,
            },
          });
        }
        if (path === '/api/auth/get-session') {
          const member =
            request.headers
              .get('cookie')
              ?.includes('finance-member-session') === true;
          return Response.json({
            user: { id: member ? FINANCE_MEMBER_USER_ID : USER_ID },
          });
        }
        if (path === '/api/v1/auth/csrf') {
          const member =
            request.headers
              .get('cookie')
              ?.includes('finance-member-session') === true;
          const token = member
            ? 'finance-member-csrf-token-0123456789'
            : 'finance-owner-csrf-token-01234567890123456789';
          return new Response(
            JSON.stringify({
              schemaVersion: 1,
              token,
            }),
            {
              headers: {
                'content-type': 'application/json',
                'set-cookie': `emdo.csrf_token=${token}; Path=/api/; Secure; HttpOnly`,
                'x-request-id': REQUEST_ID,
              },
            },
          );
        }
        if (path === '/api/v1/household/invitations')
          return jsonWithRequestId(
            {
              schemaVersion: 1,
              invitation: {
                id: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f96',
                email: FINANCE_MEMBER_EMAIL,
                role: 'member',
                status: 'pending',
                deliveryStatus: 'queued',
                version: 1,
                createdAt: '2026-08-12T15:00:00.000Z',
                expiresAt: '2026-08-12T15:15:00.000Z',
              },
              replayed: false,
            },
            { status: 201 },
          );
        if (path === '/api/internal/finance-synthetic/invitation-token')
          return jsonWithRequestId({
            schemaVersion: 1,
            invitationToken: 'd'.repeat(43),
          });
        if (path === '/api/v1/auth/invitations/csrf')
          return new Response(
            JSON.stringify({
              schemaVersion: 1,
              token: 'finance-invitation-csrf-token-0123456789',
            }),
            {
              headers: {
                'content-type': 'application/json',
                'set-cookie':
                  'emdo.invitation_csrf=finance-invitation-csrf-token-0123456789; Path=/api/; Secure; HttpOnly',
                'x-request-id': REQUEST_ID,
              },
            },
          );
        if (path === '/api/v1/auth/invitations/redeem')
          return jsonWithRequestId(
            {
              schemaVersion: 1,
              userId: FINANCE_MEMBER_USER_ID,
              householdId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f97',
              role: 'member',
              emailVerified: true,
            },
            { status: 201 },
          );
        if (path === '/api/v1/household/memberships')
          return jsonWithRequestId({
            schemaVersion: 1,
            memberships: [
              {
                id: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f98',
                userId: FINANCE_MEMBER_USER_ID,
                email: FINANCE_MEMBER_EMAIL,
                role: 'member',
                status: 'active',
                version: 1,
                joinedAt: '2026-08-12T15:01:00.000Z',
              },
            ],
          });
        throw new Error(`Unexpected acceptance request: ${path}`);
      });

      await expect(
        runStagingAcceptanceCommand({
          argv: [
            '--all-mvp-gates',
            '--require-synthetic',
            '--forbid-worker-provider-execution',
            '--finance-synthetic-document-gates',
          ],
          environment: financeEnvironment,
          fetch,
          financeStageReporter: (stage) => {
            reportedStage = stage;
          },
        }),
      ).rejects.toThrow();

      const message = formatStagingAcceptanceFailure(
        reportedStage ?? undefined,
      );
      expect(message).toBe(expectedFailure);
      expect(message).not.toContain('owner-secret');
      expect(message).not.toContain('invitation-secret');
      expect(message).not.toContain('private-id');
      expect(message).not.toContain('private-statement');
      expect(message).not.toContain(REQUEST_ID);
    },
  );

  it('fails closed before HTTP when the Finance overlay was not explicitly enabled', async () => {
    const fetch = vi.fn();
    let reportedStage: FinanceAcceptanceStage | null = null;
    await expect(
      runStagingAcceptanceCommand({
        argv: [
          '--all-mvp-gates',
          '--require-synthetic',
          '--forbid-worker-provider-execution',
          '--finance-synthetic-document-gates',
        ],
        environment,
        fetch,
        financeStageReporter: (stage) => {
          reportedStage = stage;
        },
      }),
    ).rejects.toThrow('Finance staging acceptance configuration is invalid');
    expect(fetch).not.toHaveBeenCalled();
    expect(formatStagingAcceptanceFailure(reportedStage ?? undefined)).toBe(
      'Staging acceptance failed at stage=configuration.\n',
    );
  });
});

import { describe, expect, it, vi } from 'vitest';

import { assertCompleteApiServices } from '../main.js';
import type { ApiServices } from '../services/contracts.js';
import {
  createProductionApiServices,
  type ProductionApiServiceBindings,
} from './create-services.js';
import { createFailClosedApiServices } from './unavailable-services.js';

const configuredServices = (): Omit<ApiServices, 'metrics' | 'readiness'> => ({
  auth: {
    authenticate: async () => undefined,
    verifyMutation: async () => true,
    handleBrowserRequest: async () => new Response(null, { status: 204 }),
    issueMutationCsrf: async () => ({ token: 'token', cookie: 'cookie' }),
    issueInvitationCsrf: async () => ({ token: 'token', cookie: 'cookie' }),
    redeemInvitation: async () => ({
      schemaVersion: 1,
      userId: '018f1f5e-2000-7000-8000-000000000001',
      householdId: '018f1f5e-2000-7000-8000-000000000002',
      role: 'owner',
      emailVerified: true,
    }),
  },
  activityRead: {
    list: async () => ({ schemaVersion: 1, items: [] }),
  },
  financeRead: {
    list: async () => ({ schemaVersion: 1, items: [] }),
    readSnapshot: async () => ({ reviewedCadTotals: [], budgets: [] }),
  },
  financeImports: {
    listDestinations: async () => ({
      schemaVersion: 1 as const,
      accounts: [],
      categories: [],
    }),
    preview: async () => ({
      schemaVersion: 1,
      plan: {
        id: 'finance-import-plan',
        sourceHash: '0'.repeat(64),
        expiresAt: '2026-08-13T15:10:00.000Z',
        summary: { accepted: 1, rejected: 0, duplicates: 0 },
        rejectedRows: [],
        duplicateRows: [],
      },
    }),
    commit: async () => ({
      schemaVersion: 1,
      status: 'committed',
      receipt: {
        id: 'finance-import-receipt',
        planId: 'finance-import-plan',
        transactionCount: 1,
        verified: true,
      },
      sourceDeletionAuthorized: true,
    }),
  },
  financeDocuments: Object.fromEntries(
    [
      'list',
      'get',
      'upload',
      'downloadOriginal',
      'retry',
      'getReview',
      'updateReview',
      'commitReview',
      'listMatches',
      'decideMatch',
      'getEvidence',
      'delete',
      'readExperience',
    ].map((name) => [
      name,
      async () => {
        throw new Error('finance-document-test-service-not-configured');
      },
    ]),
  ) as unknown as ApiServices['financeDocuments'],
  managerTurns: {
    start: async () => ({
      schemaVersion: 1,
      runId: '018f1f5e-2000-7000-8000-000000000003',
      status: 'accepted',
      replayed: false,
      eventsPath: '/api/v1/runs/018f1f5e-2000-7000-8000-000000000003/events',
    }),
  },
  runEvents: {
    open: async () =>
      (async function* () {
        yield {
          schemaVersion: 1 as const,
          runId: '018f1f5e-2000-7000-8000-000000000003',
          sequence: 1,
          type: 'run.started',
          occurredAt: '2026-08-10T12:00:00.000Z',
          data: {},
        };
      })(),
  },
  notificationPreferences: {
    get: async () => ({
      schemaVersion: 1,
      version: 1,
      inApp: true,
      push: false,
      email: false,
      spokenReplies: false,
      updatedAt: '2026-08-10T12:00:00.000Z',
    }),
    update: async () => ({
      schemaVersion: 1,
      version: 2,
      inApp: true,
      push: false,
      email: false,
      spokenReplies: false,
      updatedAt: '2026-08-10T12:00:00.000Z',
    }),
  },
  proposalQueries: {
    list: async () => ({
      status: 'ok',
      page: { schemaVersion: 1, items: [] },
    }),
    getDetail: async () => undefined,
  },
  visualProofs: {
    issue: async () => ({ status: 'proposal-not-found' }),
  },
  proposals: {
    decideWithVisualProof: async ({ request, principal }) => ({
      status: 'decided',
      decision: {
        schemaVersion: 1,
        id: '018f1f5e-2000-7000-8000-000000000004',
        proposalId: request.proposalId,
        userId: principal.userId,
        authenticatedSessionId: principal.sessionId,
        payloadHash: request.payloadHash,
        approvalHash: request.approvalHash,
        decision: request.decision,
        channel: 'authenticated-visual',
        decidedAt: '2026-08-10T12:00:00.000Z',
        idempotencyKey: request.idempotencyKey,
      },
    }),
  },
  sync: {
    registerClient: async ({ clientId }) => ({
      schemaVersion: 1,
      clientId,
      status: 'registered',
      replayed: false,
    }),
    issueToken: async ({ clientId }) => ({
      schemaVersion: 1,
      clientId,
      endpoint: 'https://emdo.example/powersync',
      token: 'header.claims.signature',
      expiresAt: '2026-08-10T12:05:00.000Z',
      writeScope: { clientId, spaces: [] },
    }),
    applyOperations: async ({ clientId }) => ({
      schemaVersion: 1,
      clientId,
      results: [],
    }),
  },
  audioRequests: {
    claim: async () => ({ status: 'completed-nonreplayable' }),
    completeTranscription: async () => undefined,
    completeSpeech: async () => undefined,
    releaseKnownNoDispatch: async () => undefined,
    markIndeterminate: async () => undefined,
    checkReady: async () => true,
  },
  voice: {
    inspectRecording: async () => ({
      status: 'rejected',
      code: 'audio-inspector-unavailable',
    }),
    getSpeechConfiguration: async () => ({
      model: 'tts-1',
      configurationVersion: 'voice-v1',
    }),
    transcribe: async () => ({
      status: 'failed',
      safeError: {
        code: 'audio-provider-unavailable',
        message: 'Voice is unavailable.',
        retryable: false,
      },
      reconciliationRequired: false,
    }),
    speak: async () => ({
      status: 'failed',
      safeError: {
        code: 'audio-provider-unavailable',
        message: 'Voice is unavailable.',
        retryable: false,
      },
      reconciliationRequired: false,
    }),
  },
  google: {
    beginAuthorization: async () => ({
      status: 'authorization-required',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      expiresAt: '2026-08-10T12:05:00.000Z',
    }),
    completeAuthorization: async () => ({ status: 'denied' }),
    disconnect: async () => ({
      status: 'disconnected',
      providerRevocation: 'confirmed',
    }),
  },
  householdAdministration: {
    issueInvitation: async () => {
      throw new Error('not exercised');
    },
    listInvitations: async () => {
      throw new Error('not exercised');
    },
    revokeInvitation: async () => {
      throw new Error('not exercised');
    },
    listMemberships: async () => {
      throw new Error('not exercised');
    },
    changeMembershipRole: async () => {
      throw new Error('not exercised');
    },
    deactivateMembership: async () => {
      throw new Error('not exercised');
    },
  },
  scheduleRead: {
    list: async ({ from, to }) => ({
      schemaVersion: 1,
      timezone: 'America/Toronto',
      from,
      to,
      items: { status: 'available', items: [] },
      calendar: { status: 'disconnected' },
    }),
  },
  settingsRead: {
    read: async () => ({
      schemaVersion: 1,
      household: { name: 'EMDO household', role: 'owner' },
      privateSpaces: [],
      calendar: { status: 'disconnected' },
    }),
  },
  shoppingRead: {
    list: async () => ({ schemaVersion: 1, items: [] }),
  },
  todayRead: {
    read: async ({ date }) => ({
      schemaVersion: 1,
      date,
      timezone: 'America/Toronto',
      schedule: { status: 'available', items: [] },
      reminders: { status: 'available', items: [] },
      notifications: { status: 'available', items: [] },
      finance: {
        status: 'available',
        budgetCount: 0,
        transactionCount: 0,
      },
      shopping: {
        status: 'available',
        itemCount: 0,
        retailerCount: 0,
      },
    }),
  },
  jwks: {
    getPublicJwks: async () => ({ keys: [] }),
  },
});

const healthyBindings = (): ProductionApiServiceBindings => {
  const services = configuredServices();
  return Object.fromEntries(
    Object.entries(services).map(([name, service]) => [
      name,
      { service, check: vi.fn(async () => true) },
    ]),
  ) as unknown as ProductionApiServiceBindings;
};

describe('bundled production API composition', () => {
  it('starts with a complete fail-closed graph when authority bindings are unavailable', async () => {
    const services = await createProductionApiServices({
      EMDO_METRICS_TOKEN: 'metrics-token-012345678901234567890123',
    });
    expect(() => assertCompleteApiServices(services)).not.toThrow();
    await expect(services.readiness.check()).resolves.toEqual({
      ready: false,
      checks: {
        authority: 'unavailable',
        'authority.authentication': 'unavailable',
        'authority.household-administration': 'unavailable',
        'authority.proposal-queries': 'unavailable',
        'authority.visual-decisions': 'unavailable',
        'authority.visual-proof-issuance': 'unavailable',
        agents: 'unavailable',
        'agents.manager-turns': 'unavailable',
        'agents.run-events': 'unavailable',
        experience: 'unavailable',
        'experience.activity-read': 'unavailable',
        'experience.finance-documents': 'unavailable',
        'experience.finance-read': 'unavailable',
        'experience.finance-imports': 'unavailable',
        'experience.notification-preferences': 'unavailable',
        'experience.schedule-read': 'unavailable',
        'experience.settings-read': 'unavailable',
        'experience.shopping-read': 'unavailable',
        'experience.today-read': 'unavailable',
        google: 'unavailable',
        'google.connector': 'unavailable',
        sync: 'unavailable',
        'sync.gateway': 'unavailable',
        'sync.jwks': 'unavailable',
        voice: 'unavailable',
        'voice.audio-requests': 'unavailable',
        'voice.provider': 'unavailable',
      },
    });
    await expect(
      services.auth.authenticate({
        requestId: '018f1f5e-2000-7000-8000-000000000001',
        method: 'GET',
        path: '/api/v1/turns',
      }),
    ).resolves.toBeUndefined();
    await expect(services.auth.verifyMutation({} as never)).resolves.toBe(
      false,
    );
    const browserAuthResponse = await services.auth.handleBrowserRequest({
      request: new Request('https://emdo.example/api/auth/session'),
      requestId: '018f1f5e-2000-7000-8000-000000000002',
    });
    expect(browserAuthResponse.status).toBe(503);
    await expect(browserAuthResponse.json()).resolves.toMatchObject({
      code: 'authentication-unavailable',
    });
  });

  it('cannot be redirected to caller-supplied service bindings', async () => {
    const injected = healthyBindings();
    const services = await Reflect.apply(createProductionApiServices, null, [
      {
        EMDO_API_COMPOSITION_MODULE: './caller-selected-module.js',
        EMDO_API_SERVICE_FACTORY: 'callerSelectedFactory',
      },
      { bindings: injected },
    ]);

    await expect(services.readiness.check()).resolves.toMatchObject({
      ready: false,
      checks: {
        authority: 'unavailable',
        agents: 'unavailable',
        experience: 'unavailable',
        google: 'unavailable',
        sync: 'unavailable',
        voice: 'unavailable',
      },
    });
    for (const binding of Object.values(injected)) {
      expect(binding?.check).not.toHaveBeenCalled();
    }
  });

  it('reports ready only when every concrete service binding and probe is healthy', async () => {
    const bindings = healthyBindings();
    const close = vi.fn(async () => undefined);
    const services = createFailClosedApiServices({
      auth: configuredServices().auth,
      bindings,
      metricsToken: 'metrics-token-012345678901234567890123',
      close,
    });

    expect(() => assertCompleteApiServices(services)).not.toThrow();
    await expect(services.readiness.check()).resolves.toMatchObject({
      ready: true,
      checks: {
        authority: 'ok',
        'authority.authentication': 'ok',
        'authority.household-administration': 'ok',
        'authority.proposal-queries': 'ok',
        'authority.visual-decisions': 'ok',
        'authority.visual-proof-issuance': 'ok',
        agents: 'ok',
        experience: 'ok',
        'experience.activity-read': 'ok',
        'experience.finance-read': 'ok',
        'experience.finance-imports': 'ok',
        'experience.notification-preferences': 'ok',
        'experience.schedule-read': 'ok',
        'experience.settings-read': 'ok',
        'experience.shopping-read': 'ok',
        'experience.today-read': 'ok',
        google: 'ok',
        sync: 'ok',
        voice: 'ok',
      },
    });
    await expect(services.metrics.render()).resolves.toContain(
      'emdo_api_ready 1',
    );

    for (const [, binding] of Object.entries(bindings)) {
      expect(binding?.check).toHaveBeenCalled();
    }
    await services.close?.();
    expect(close).toHaveBeenCalledOnce();
  });

  it('uses the fail-closed adapter and diagnostic when a binding is malformed or its probe fails', async () => {
    const bindings = healthyBindings();
    bindings.sync = {
      service: { issueToken: async () => ({}) } as never,
      check: vi.fn(async () => true),
    };
    bindings.google = {
      service: configuredServices().google,
      check: vi.fn(async () => {
        throw new Error('sensitive connector failure');
      }),
    };
    bindings.visualProofs = {
      service: {} as never,
      check: vi.fn(async () => true),
    };
    bindings.activityRead = {
      service: {} as never,
      check: vi.fn(async () => true),
    };
    bindings.financeRead = {
      service: {} as never,
      check: vi.fn(async () => true),
    };
    bindings.shoppingRead = {
      service: {} as never,
      check: vi.fn(async () => true),
    };
    const services = createFailClosedApiServices({
      auth: configuredServices().auth,
      bindings,
    });

    await expect(services.readiness.check()).resolves.toMatchObject({
      ready: false,
      checks: {
        google: 'unavailable',
        'google.connector': 'unavailable',
        authority: 'unavailable',
        'authority.visual-proof-issuance': 'unavailable',
        experience: 'unavailable',
        'experience.activity-read': 'unavailable',
        'experience.finance-read': 'unavailable',
        'experience.shopping-read': 'unavailable',
        sync: 'unavailable',
        'sync.gateway': 'unavailable',
        'sync.jwks': 'ok',
      },
    });
    await expect(
      services.sync.registerClient({} as never),
    ).rejects.toMatchObject({ code: 'sync-unavailable', status: 503 });
    await expect(
      services.visualProofs.issue({} as never),
    ).rejects.toMatchObject({
      code: 'approval-runtime-unavailable',
      status: 503,
    });
    await expect(services.activityRead.list({} as never)).rejects.toMatchObject(
      {
        code: 'activity-read-unavailable',
        status: 503,
      },
    );
    await expect(services.financeRead.list({} as never)).rejects.toMatchObject({
      code: 'finance-read-unavailable',
      status: 503,
    });
    await expect(services.shoppingRead.list({} as never)).rejects.toMatchObject(
      {
        code: 'shopping-read-unavailable',
        status: 503,
      },
    );
    await expect(services.metrics.render()).resolves.toContain(
      'emdo_api_ready 0',
    );
  });

  it('never dispatches through a complete binding whose exact operational probe is unavailable', async () => {
    const bindings = healthyBindings();
    const registerClient = vi.fn(async () => ({
      schemaVersion: 1 as const,
      clientId: '018f1f5e-2000-7000-8000-000000000001',
      status: 'registered' as const,
      replayed: false,
    }));
    const getPublicJwks = vi.fn(async () => ({ keys: [] }));
    const syncCheck = vi.fn(async () => false);
    const jwksCheck = vi.fn(async () => true);
    const servicesToRemainUncalled = configuredServices();
    bindings.sync = {
      service: {
        ...configuredServices().sync,
        registerClient,
      },
      check: syncCheck,
    };
    bindings.jwks = {
      service: { getPublicJwks },
      check: jwksCheck,
    };
    bindings.activityRead = {
      service: servicesToRemainUncalled.activityRead,
      check: vi.fn(async () => false),
    };
    bindings.auth = {
      service: servicesToRemainUncalled.auth,
      check: vi.fn(async () => false),
    };
    const services = createFailClosedApiServices({
      auth: configuredServices().auth,
      bindings,
    });

    await expect(
      services.sync.registerClient({} as never),
    ).rejects.toMatchObject({ code: 'sync-unavailable', status: 503 });
    expect(registerClient).not.toHaveBeenCalled();
    expect(syncCheck).toHaveBeenCalledOnce();

    await expect(services.activityRead.list({} as never)).rejects.toMatchObject(
      { code: 'activity-read-unavailable', status: 503 },
    );
    await expect(
      services.auth.authenticate({
        requestId: '018f1f5e-2000-7000-8000-000000000002',
        method: 'GET',
        path: '/api/v1/today',
      }),
    ).resolves.toBeUndefined();

    await expect(services.jwks.getPublicJwks()).resolves.toEqual({ keys: [] });
    expect(getPublicJwks).toHaveBeenCalledOnce();
    expect(jwksCheck).toHaveBeenCalledOnce();
  });

  it('bounds a stalled dependency probe and reports it unavailable', async () => {
    vi.useFakeTimers();
    try {
      const bindings = healthyBindings();
      bindings.google = {
        service: configuredServices().google,
        check: async () => new Promise<boolean>(() => undefined),
      };
      const services = createFailClosedApiServices({
        auth: configuredServices().auth,
        bindings,
      });
      let readiness:
        Awaited<ReturnType<typeof services.readiness.check>> | undefined;
      void services.readiness.check().then((result) => {
        readiness = result;
      });

      await vi.advanceTimersByTimeAsync(2_001);

      expect(readiness).toMatchObject({
        ready: false,
        checks: {
          google: 'unavailable',
          'google.connector': 'unavailable',
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

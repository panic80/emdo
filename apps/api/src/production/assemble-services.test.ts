import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthenticationBoundary } from '../services/contracts.js';

const mocks = vi.hoisted(() => ({
  createAuthentication: vi.fn(),
  createDurable: vi.fn(),
}));

vi.mock('./auth-services.js', () => ({
  createProductionAuthenticationServiceBinding: mocks.createAuthentication,
}));
vi.mock('./durable-services.js', () => ({
  createProductionDurableServiceBindings: mocks.createDurable,
}));

import { assembleProductionApiServices } from './assemble-services.js';

const authBoundary = (): AuthenticationBoundary => ({
  authenticate: vi.fn(async () => undefined),
  handleBrowserRequest: vi.fn(async () => new Response(null, { status: 204 })),
  issueInvitationCsrf: vi.fn(),
  issueMutationCsrf: vi.fn(),
  redeemInvitation: vi.fn(),
  verifyMutation: vi.fn(async () => true),
});

describe('production API service assembly', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAuthentication.mockResolvedValue({});
    mocks.createDurable.mockResolvedValue({ bindings: {} });
  });

  it('selects the built-in complete authentication boundary and probe', async () => {
    const auth = authBoundary();
    const check = vi.fn(async () => true);
    mocks.createAuthentication.mockResolvedValue({
      binding: { service: auth, check },
    });

    const services = await assembleProductionApiServices({
      EMDO_PUBLIC_ORIGIN: 'https://emdo.example',
    });

    await expect(services.auth.verifyMutation({} as never)).resolves.toBe(true);
    expect(check).toHaveBeenCalledOnce();
    expect(auth.verifyMutation).toHaveBeenCalledOnce();
    await expect(services.readiness.check()).resolves.toMatchObject({
      checks: { 'authority.authentication': 'ok' },
    });
  });

  it('keeps proposal reads and visual decisions unavailable until trusted authentication is composed', async () => {
    mocks.createDurable.mockResolvedValue({
      bindings: {
        proposalQueries: {
          check: vi.fn(async () => true),
          service: { getDetail: vi.fn(), list: vi.fn() },
        },
        visualProofs: {
          check: vi.fn(async () => true),
          service: { issue: vi.fn() },
        },
        proposals: {
          check: vi.fn(async () => true),
          service: { decideWithVisualProof: vi.fn() },
        },
      },
    });

    const services = await assembleProductionApiServices({});

    await expect(services.readiness.check()).resolves.toMatchObject({
      checks: {
        'authority.proposal-queries': 'unavailable',
        'authority.visual-decisions': 'unavailable',
        'authority.visual-proof-issuance': 'unavailable',
      },
    });
  });

  it('selects the complete visual decision pair only with trusted authentication', async () => {
    const auth = authBoundary();
    mocks.createAuthentication.mockResolvedValue({
      binding: { service: auth, check: vi.fn(async () => true) },
    });
    mocks.createDurable.mockResolvedValue({
      bindings: {
        visualProofs: {
          check: vi.fn(async () => true),
          service: { issue: vi.fn() },
        },
        proposals: {
          check: vi.fn(async () => true),
          service: { decideWithVisualProof: vi.fn() },
        },
      },
    });

    const services = await assembleProductionApiServices({});

    await expect(services.readiness.check()).resolves.toMatchObject({
      checks: {
        'authority.visual-decisions': 'ok',
        'authority.visual-proof-issuance': 'ok',
      },
    });
  });

  it('selects durable run-event replay only with trusted authentication', async () => {
    const open = vi.fn();
    mocks.createDurable.mockResolvedValue({
      bindings: {
        runEvents: {
          check: vi.fn(async () => true),
          service: { open },
        },
      },
    });

    const unavailable = await assembleProductionApiServices({});
    await expect(unavailable.readiness.check()).resolves.toMatchObject({
      checks: { 'agents.run-events': 'unavailable' },
    });

    const auth = authBoundary();
    mocks.createAuthentication.mockResolvedValue({
      binding: { service: auth, check: vi.fn(async () => true) },
    });
    const available = await assembleProductionApiServices({});
    await expect(
      available.runEvents.open({} as never),
    ).resolves.toBeUndefined();
    expect(open).toHaveBeenCalledOnce();
    await expect(available.readiness.check()).resolves.toMatchObject({
      checks: { 'agents.run-events': 'ok' },
    });
  });

  it('exposes the durable core manager boundary only with trusted authentication', async () => {
    const start = vi.fn(async () => ({
      schemaVersion: 1 as const,
      runId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f010',
      status: 'accepted' as const,
      replayed: false,
      eventsPath: '/api/v1/runs/018f1f5e-6f47-7d61-a6dd-1e86f8b8f010/events',
    }));
    mocks.createDurable.mockResolvedValue({
      bindings: {
        managerTurns: {
          check: vi.fn(async () => true),
          service: { start },
        },
      },
    });

    const unavailable = await assembleProductionApiServices({});
    await expect(unavailable.readiness.check()).resolves.toMatchObject({
      checks: { 'agents.manager-turns': 'unavailable' },
    });
    expect(start).not.toHaveBeenCalled();

    mocks.createAuthentication.mockResolvedValue({
      binding: {
        service: authBoundary(),
        check: vi.fn(async () => true),
      },
    });
    const available = await assembleProductionApiServices({});
    await expect(
      available.managerTurns.start({} as never),
    ).resolves.toMatchObject({
      status: 'accepted',
    });
    expect(start).toHaveBeenCalledOnce();
    await expect(available.readiness.check()).resolves.toMatchObject({
      checks: { 'agents.manager-turns': 'ok' },
    });
  });

  it('selects the Google connector only with trusted authentication', async () => {
    const beginAuthorization = vi.fn(async () => ({
      status: 'already-authorized' as const,
      grantedPurposes: ['calendar-read' as const],
    }));
    const google = {
      beginAuthorization,
      completeAuthorization: vi.fn(),
      disconnect: vi.fn(),
    };
    mocks.createDurable.mockResolvedValue({
      bindings: {
        google: {
          check: vi.fn(async () => true),
          service: google,
        },
      },
    });

    const unavailable = await assembleProductionApiServices({});
    await expect(unavailable.readiness.check()).resolves.toMatchObject({
      checks: { 'google.connector': 'unavailable' },
    });

    mocks.createAuthentication.mockResolvedValue({
      binding: {
        service: authBoundary(),
        check: vi.fn(async () => true),
      },
    });
    const available = await assembleProductionApiServices({});
    await expect(
      available.google.beginAuthorization({} as never),
    ).resolves.toMatchObject({ status: 'already-authorized' });
    expect(beginAuthorization).toHaveBeenCalledOnce();
    await expect(available.readiness.check()).resolves.toMatchObject({
      checks: { 'google.connector': 'ok' },
    });
  });

  it('selects the voice provider only with trusted authentication', async () => {
    const speak = vi.fn(async () => ({
      status: 'failed' as const,
      safeError: {
        code: 'audio-provider-unavailable' as const,
        message: 'Audio is unavailable.',
        retryable: true,
      },
      reconciliationRequired: false,
    }));
    const voice = {
      inspectRecording: vi.fn(),
      getSpeechConfiguration: vi.fn(),
      transcribe: vi.fn(),
      speak,
    };
    mocks.createDurable.mockResolvedValue({
      bindings: {
        voice: {
          check: vi.fn(async () => true),
          service: voice,
        },
      },
    });

    const unavailable = await assembleProductionApiServices({});
    await expect(unavailable.readiness.check()).resolves.toMatchObject({
      checks: { 'voice.provider': 'unavailable' },
    });
    expect(speak).not.toHaveBeenCalled();

    mocks.createAuthentication.mockResolvedValue({
      binding: {
        service: authBoundary(),
        check: vi.fn(async () => true),
      },
    });
    const available = await assembleProductionApiServices({});
    await expect(available.voice.speak({} as never)).resolves.toMatchObject({
      status: 'failed',
    });
    expect(speak).toHaveBeenCalledOnce();
    await expect(available.readiness.check()).resolves.toMatchObject({
      checks: { 'voice.provider': 'ok' },
    });
  });

  it('selects the current checked finance import boundary from durable composition', async () => {
    const auth = authBoundary();
    const listDestinations = vi.fn(async () => ({
      schemaVersion: 1 as const,
      accounts: [],
      categories: [],
    }));
    const preview = vi.fn(async () => ({ status: 'previewed' }));
    const commit = vi.fn(async () => ({ status: 'committed' }));
    const check = vi.fn(async () => true);
    mocks.createAuthentication.mockResolvedValue({
      binding: { service: auth, check: vi.fn(async () => true) },
    });
    mocks.createDurable.mockResolvedValue({
      bindings: {
        financeImports: {
          service: { listDestinations, preview, commit },
          check,
        },
      },
    });

    const services = await assembleProductionApiServices({});

    await expect(
      services.financeImports.listDestinations({} as never),
    ).resolves.toEqual({
      schemaVersion: 1,
      accounts: [],
      categories: [],
    });
    await expect(services.financeImports.preview({} as never)).resolves.toEqual(
      { status: 'previewed' },
    );
    await expect(services.financeImports.commit({} as never)).resolves.toEqual({
      status: 'committed',
    });
    expect(preview).toHaveBeenCalledOnce();
    expect(listDestinations).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
    await expect(services.readiness.check()).resolves.toMatchObject({
      checks: { 'experience.finance-imports': 'ok' },
    });
  });

  it('closes auth and durable resources exactly once', async () => {
    const closeAuth = vi.fn(async () => undefined);
    const closeDurable = vi.fn(async () => undefined);
    mocks.createAuthentication.mockResolvedValue({ close: closeAuth });
    mocks.createDurable.mockResolvedValue({
      bindings: {},
      close: closeDurable,
    });

    const services = await assembleProductionApiServices({});
    await services.close?.();
    await services.close?.();

    expect(closeAuth).toHaveBeenCalledOnce();
    expect(closeDurable).toHaveBeenCalledOnce();
  });

  it('rejects invalid process configuration before opening any resources', async () => {
    await expect(
      assembleProductionApiServices({ EMDO_METRICS_TOKEN: 'short' }),
    ).rejects.toThrow();

    expect(mocks.createAuthentication).not.toHaveBeenCalled();
    expect(mocks.createDurable).not.toHaveBeenCalled();
  });

  it('closes already-created resources if later built-in assembly fails', async () => {
    const closeDurable = vi.fn(async () => undefined);
    mocks.createDurable.mockResolvedValue({
      bindings: {},
      close: closeDurable,
    });
    mocks.createAuthentication.mockRejectedValue(
      new Error('internal auth assembly failure'),
    );

    await expect(assembleProductionApiServices({})).rejects.toThrow(
      'internal auth assembly failure',
    );
    expect(closeDurable).toHaveBeenCalledOnce();
  });
});

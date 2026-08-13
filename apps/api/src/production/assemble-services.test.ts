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

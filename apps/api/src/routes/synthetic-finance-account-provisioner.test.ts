import Fastify from 'fastify';
import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../app.js';
import { installProblemHandler } from '../problem.js';
import {
  createSyntheticFinanceAccountProvisioner,
  type SyntheticFinanceAccountProvisioner,
  SYNTHETIC_FINANCE_ACCOUNT_ID,
} from '../production/synthetic-finance-account-provisioner.js';
import { createFailClosedApiServices } from '../production/unavailable-services.js';
import type {
  ApiServices,
  AuthenticatedPrincipal,
} from '../services/contracts.js';
import { registerSyntheticFinanceAccountProvisionerRoute } from './synthetic-finance-account-provisioner.js';

const IDS = Object.freeze({
  household: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f84',
  owner: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f82',
  privateSpace: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f86',
  request: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f87',
  session: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f83',
  grant: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f85',
});

const owner: AuthenticatedPrincipal = Object.freeze({
  userId: IDS.owner,
  sessionId: IDS.session,
  householdId: IDS.household,
  privateSpaceId: IDS.privateSpace,
  role: 'owner',
  emailVerified: true,
  spaceAccessGrantId: IDS.grant,
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema.parse('8'.repeat(64)),
});

const exactEnvironment = Object.freeze({
  EMDO_ALLOW_LOOPBACK_API_INGRESS: 'true',
  EMDO_ENVIRONMENT: 'staging',
  EMDO_FINANCE_DOCUMENTS_ENABLED: 'true',
  EMDO_FINANCE_SYNTHETIC_STAGING: 'true',
  EMDO_SYNTHETIC_DATA_ONLY: 'true',
});

const headers = Object.freeze({
  cookie: '__Secure-emdo.session_token=owner',
  origin: 'https://emdo.invalid',
  'x-csrf-token': 'synthetic-csrf-token',
  'idempotency-key': 'finance-synthetic-account-provision-v1',
  'x-request-id': IDS.request,
});

const authenticationBoundary = (principal: AuthenticatedPrincipal = owner) =>
  ({
    authenticate: vi.fn(async () => principal),
    verifyMutation: vi.fn(async () => true),
    handleBrowserRequest: vi.fn(),
    issueMutationCsrf: vi.fn(),
    issueInvitationCsrf: vi.fn(),
    redeemInvitation: vi.fn(),
  }) as unknown as ApiServices['auth'];

const buildApp = async (input: {
  readonly principal?: AuthenticatedPrincipal;
  readonly repository: {
    provisionSyntheticStagingAccount(input: unknown): Promise<unknown>;
  };
  readonly verifyMutation?: boolean;
}) => {
  const auth = authenticationBoundary(input.principal);
  if (input.verifyMutation !== undefined) {
    (auth.verifyMutation as ReturnType<typeof vi.fn>).mockResolvedValue(
      input.verifyMutation,
    );
  }
  const provisioner = createSyntheticFinanceAccountProvisioner({
    environment: exactEnvironment,
    repository: input.repository,
  });
  if (provisioner === undefined) throw new Error('provisioner is unavailable');
  const app = Fastify({ genReqId: () => IDS.request, logger: false });
  installProblemHandler(app);
  registerSyntheticFinanceAccountProvisionerRoute(
    app,
    createFailClosedApiServices({ auth }),
    provisioner,
  );
  await app.ready();
  return app;
};

describe('Finance synthetic account provisioner', () => {
  it('is absent unless every exact Finance synthetic-staging gate is enabled', () => {
    const repository = {
      provisionSyntheticStagingAccount: vi.fn(),
    };

    expect(
      createSyntheticFinanceAccountProvisioner({
        environment: {
          ...exactEnvironment,
          EMDO_ENVIRONMENT: 'production',
        },
        repository,
      }),
    ).toBeUndefined();
    expect(
      createSyntheticFinanceAccountProvisioner({
        environment: {
          ...exactEnvironment,
          EMDO_ALLOW_LOOPBACK_API_INGRESS: 'false',
        },
        repository,
      }),
    ).toBeUndefined();
    expect(
      createSyntheticFinanceAccountProvisioner({
        environment: {
          ...exactEnvironment,
          EMDO_SYNTHETIC_DATA_ONLY: 'false',
        },
        repository,
      }),
    ).toBeUndefined();
    expect(
      createSyntheticFinanceAccountProvisioner({
        environment: {
          ...exactEnvironment,
          EMDO_FINANCE_SYNTHETIC_STAGING: 'false',
        },
        repository,
      }),
    ).toBeUndefined();
    expect(
      createSyntheticFinanceAccountProvisioner({
        environment: {
          ...exactEnvironment,
          EMDO_FINANCE_DOCUMENTS_ENABLED: 'false',
        },
        repository,
      }),
    ).toBeUndefined();
  });

  it('is not registered by the baseline application composition', async () => {
    const app = await createApp({
      services: createFailClosedApiServices({ auth: authenticationBoundary() }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/internal/finance-synthetic/account',
      headers,
      payload: { schemaVersion: 1 },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('forwards the reply-lifecycle cancellation signal into the provisioner', async () => {
    let receivedSignal: AbortSignal | undefined;
    let abortedDuringProvision: boolean | undefined;
    const provision = vi.fn(
      async (
        input: Parameters<SyntheticFinanceAccountProvisioner['provision']>[0],
      ) => {
        receivedSignal = input.abortSignal;
        abortedDuringProvision = input.abortSignal.aborted;
        return {
          schemaVersion: 1 as const,
          accountId: SYNTHETIC_FINANCE_ACCOUNT_ID,
          status: 'applied' as const,
        };
      },
    );
    const provisioner: SyntheticFinanceAccountProvisioner = Object.freeze({
      provision,
    });
    const app = Fastify({ genReqId: () => IDS.request, logger: false });
    installProblemHandler(app);
    registerSyntheticFinanceAccountProvisionerRoute(
      app,
      createFailClosedApiServices({ auth: authenticationBoundary() }),
      provisioner,
    );
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/internal/finance-synthetic/account',
      headers,
      payload: { schemaVersion: 1 },
    });
    expect(response.statusCode).toBe(200);
    expect(provision).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: expect.any(AbortSignal),
        requestId: IDS.request,
      }),
    );
    expect(abortedDuringProvision).toBe(false);
    expect(receivedSignal?.aborted).toBe(true);
    await app.close();
  });

  it('fails closed at the provisioner boundary when its request signal is aborted', async () => {
    const repository = {
      provisionSyntheticStagingAccount: vi.fn(async () => ({
        status: 'applied',
      })),
    };
    const provisioner = createSyntheticFinanceAccountProvisioner({
      environment: exactEnvironment,
      repository,
    });
    if (provisioner === undefined)
      throw new Error('provisioner is unavailable');
    const abortController = new AbortController();
    abortController.abort();

    await expect(
      provisioner.provision({
        principal: owner,
        requestId: IDS.request,
        idempotencyKey: headers['idempotency-key'],
        abortSignal: abortController.signal,
      }),
    ).resolves.toBeUndefined();
    expect(repository.provisionSyntheticStagingAccount).not.toHaveBeenCalled();
  });

  it('fails closed for public, member, invalid-body, and invalid-CSRF attempts', async () => {
    const repository = {
      provisionSyntheticStagingAccount: vi.fn(async () => ({
        status: 'applied',
      })),
    };
    const publicApp = await buildApp({ repository });
    const publicAttempt = await publicApp.inject({
      method: 'POST',
      url: '/api/internal/finance-synthetic/account',
      headers,
      payload: { schemaVersion: 1 },
      remoteAddress: '203.0.113.25',
    });
    expect(publicAttempt.statusCode).toBe(404);
    expect(publicAttempt.body).not.toContain(SYNTHETIC_FINANCE_ACCOUNT_ID);
    await publicApp.close();

    const memberApp = await buildApp({
      repository,
      principal: { ...owner, role: 'member' },
    });
    const memberAttempt = await memberApp.inject({
      method: 'POST',
      url: '/api/internal/finance-synthetic/account',
      headers,
      payload: { schemaVersion: 1 },
    });
    expect(memberAttempt.statusCode).toBe(404);
    await memberApp.close();

    const invalidBodyApp = await buildApp({ repository });
    const invalidBody = await invalidBodyApp.inject({
      method: 'POST',
      url: '/api/internal/finance-synthetic/account',
      headers,
      payload: { schemaVersion: 1, accountId: 'client-controlled' },
    });
    expect(invalidBody.statusCode).toBe(404);
    await invalidBodyApp.close();

    const invalidCsrfApp = await buildApp({
      repository,
      verifyMutation: false,
    });
    const invalidCsrf = await invalidCsrfApp.inject({
      method: 'POST',
      url: '/api/internal/finance-synthetic/account',
      headers,
      payload: { schemaVersion: 1 },
    });
    expect(invalidCsrf.statusCode).toBe(403);
    await invalidCsrfApp.close();

    expect(repository.provisionSyntheticStagingAccount).not.toHaveBeenCalled();
  });

  it('binds the owner scope server-side and returns only the fixed account receipt', async () => {
    let invocation = 0;
    const abortStatesAtRepository = new Array<boolean>();
    const repository = {
      provisionSyntheticStagingAccount: vi.fn(async (input: unknown) => {
        invocation += 1;
        abortStatesAtRepository.push(
          (
            input as {
              readonly scope: { readonly abortSignal: AbortSignal };
            }
          ).scope.abortSignal.aborted,
        );
        return {
          status: invocation === 1 ? 'applied' : 'duplicate',
          account: {
            name: 'must not escape the internal provisioner',
            ownerUserId: IDS.owner,
          },
        };
      }),
    };
    const provisioner = createSyntheticFinanceAccountProvisioner({
      environment: exactEnvironment,
      repository,
    });
    if (provisioner === undefined)
      throw new Error('provisioner is unavailable');
    const app = await createApp({
      services: createFailClosedApiServices({ auth: authenticationBoundary() }),
      syntheticFinanceAccountProvisioner: provisioner,
    });

    const first = await app.inject({
      method: 'POST',
      url: '/api/internal/finance-synthetic/account',
      headers,
      payload: { schemaVersion: 1 },
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.headers['cache-control']).toContain('no-store');
    expect(first.headers['cache-control']).toContain('private');
    expect(first.json()).toEqual({
      schemaVersion: 1,
      accountId: SYNTHETIC_FINANCE_ACCOUNT_ID,
      status: 'applied',
    });
    expect(first.body).not.toContain('must not escape');

    expect(repository.provisionSyntheticStagingAccount).toHaveBeenCalledWith({
      idempotencyKey: headers['idempotency-key'],
      scope: {
        requestId: IDS.request,
        userId: IDS.owner,
        sessionId: IDS.session,
        householdId: IDS.household,
        privateSpaceId: IDS.privateSpace,
        spaceAccessGrantId: IDS.grant,
        collectionAuthorizationScopeFingerprint: '8'.repeat(64),
        abortSignal: expect.any(AbortSignal),
      },
    });
    expect(abortStatesAtRepository).toEqual([false]);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/internal/finance-synthetic/account',
      headers,
      payload: { schemaVersion: 1 },
    });
    expect(duplicate.statusCode, duplicate.body).toBe(200);
    expect(duplicate.json()).toEqual({
      schemaVersion: 1,
      accountId: SYNTHETIC_FINANCE_ACCOUNT_ID,
      status: 'duplicate',
    });
    expect(duplicate.body).not.toContain('ownerUserId');
    expect(abortStatesAtRepository).toEqual([false, false]);
    await app.close();
  });
});

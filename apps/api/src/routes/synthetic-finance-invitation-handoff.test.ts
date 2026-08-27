import { Buffer } from 'node:buffer';

import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../app.js';
import { createSyntheticFinanceInvitationHandoff } from '../production/synthetic-finance-invitation-handoff.js';
import { createFailClosedApiServices } from '../production/unavailable-services.js';
import type {
  ApiServices,
  AuthenticatedPrincipal,
  HouseholdAdministrationGateway,
} from '../services/contracts.js';

const IDS = Object.freeze({
  invitation: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f80',
  member: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f81',
  owner: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f82',
  session: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f83',
  household: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f84',
  grant: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f85',
});
const memberEmail = 'finance-staging-member@emdo.invalid';
const principal: AuthenticatedPrincipal = Object.freeze({
  userId: IDS.owner,
  sessionId: IDS.session,
  householdId: IDS.household,
  role: 'owner',
  emailVerified: true,
  spaceAccessGrantId: IDS.grant,
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema.parse('8'.repeat(64)),
});

const environment = Object.freeze({
  EMDO_ALLOW_LOOPBACK_API_INGRESS: 'true',
  EMDO_ENVIRONMENT: 'staging',
  EMDO_FINANCE_SYNTHETIC_STAGING: 'true',
  EMDO_SYNTHETIC_DATA_ONLY: 'true',
});

const baseGateway = (): HouseholdAdministrationGateway =>
  ({
    issueInvitation: vi.fn(async () => ({
      schemaVersion: 1 as const,
      invitation: {
        id: IDS.invitation,
        email: memberEmail,
        role: 'member' as const,
        status: 'pending' as const,
        deliveryStatus: 'queued' as const,
        version: 1,
        createdAt: '2026-08-26T12:00:00.000Z',
        expiresAt: '2026-08-26T12:15:00.000Z',
      },
      replayed: false,
    })),
    listInvitations: vi.fn(),
    revokeInvitation: vi.fn(),
    listMemberships: vi.fn(),
    changeMembershipRole: vi.fn(),
    deactivateMembership: vi.fn(),
  }) as unknown as HouseholdAdministrationGateway;

const issueOneSyntheticMember = async () => {
  const handoff = createSyntheticFinanceInvitationHandoff(environment);
  if (handoff === undefined) throw new Error('handoff is unavailable');
  const sealer = handoff.wrapSealer({
    seal: vi.fn(async () => ({
      schemaVersion: 1 as const,
      algorithm: 'RSA-OAEP-256' as const,
      keyId: 'test',
      ciphertext: 'a'.repeat(300),
      bindingHash: 'b'.repeat(64),
    })),
  });
  await sealer.seal({
    secret: Buffer.from('a'.repeat(43), 'ascii'),
    binding: {
      invitationId: IDS.invitation,
      recipient: memberEmail,
      role: 'member',
      tokenHash: 'c'.repeat(64),
      templateVersion: 'invitation-redemption.v1',
    },
  });
  const gateway = handoff.wrapHouseholdAdministration(baseGateway());
  await gateway.issueInvitation({
    email: memberEmail,
    role: 'member',
    expiresInSeconds: 900,
    principal,
    requestId: IDS.invitation,
    idempotencyKey: 'finance-staging-secondary-member-invitation-v1',
  });
  return handoff;
};

const authenticationBoundary = (): ApiServices['auth'] =>
  ({
    authenticate: vi.fn(async () => principal),
    verifyMutation: vi.fn(async () => true),
    handleBrowserRequest: vi.fn(),
    issueMutationCsrf: vi.fn(),
    issueInvitationCsrf: vi.fn(),
    redeemInvitation: vi.fn(),
  }) as unknown as ApiServices['auth'];

const buildServices = () =>
  createFailClosedApiServices({
    auth: authenticationBoundary(),
  });

const headers = Object.freeze({
  cookie: '__Secure-emdo.session_token=owner',
  origin: 'https://emdo.invalid',
  'x-csrf-token': 'synthetic-csrf-token',
  'idempotency-key': 'finance-staging-secondary-member-handoff-v1',
});

describe('Finance synthetic invitation handoff route', () => {
  it('is absent unless every Finance synthetic-staging gate is exact', () => {
    expect(
      createSyntheticFinanceInvitationHandoff({
        ...environment,
        EMDO_FINANCE_SYNTHETIC_STAGING: 'false',
      }),
    ).toBeUndefined();
    expect(
      createSyntheticFinanceInvitationHandoff({
        ...environment,
        EMDO_ENVIRONMENT: 'production',
      }),
    ).toBeUndefined();
  });

  it('preserves every household method when the wrapped gateway uses prototype methods', async () => {
    const handoff = createSyntheticFinanceInvitationHandoff(environment);
    if (handoff === undefined) throw new Error('handoff is unavailable');
    const prototype = baseGateway();
    const wrapped = handoff.wrapHouseholdAdministration(
      Object.create(prototype) as HouseholdAdministrationGateway,
    );

    expect(wrapped).toEqual(
      expect.objectContaining({
        issueInvitation: expect.any(Function),
        listInvitations: expect.any(Function),
        revokeInvitation: expect.any(Function),
        listMemberships: expect.any(Function),
        changeMembershipRole: expect.any(Function),
        deactivateMembership: expect.any(Function),
      }),
    );

    await wrapped.listMemberships({ principal, requestId: IDS.invitation });
    const services = createFailClosedApiServices({
      auth: authenticationBoundary(),
      bindings: {
        householdAdministration: {
          service: wrapped,
          check: vi.fn(async () => true),
        },
      },
    });
    await expect(services.readiness.check()).resolves.toMatchObject({
      checks: { 'authority.household-administration': 'ok' },
    });
    await services.householdAdministration.listInvitations({
      principal,
      requestId: IDS.invitation,
    });

    expect(prototype.listInvitations).toHaveBeenCalledOnce();
    expect(prototype.listMemberships).toHaveBeenCalledOnce();
  });

  it('requires loopback owner mutation proof and returns an invitation token once', async () => {
    const handoff = await issueOneSyntheticMember();
    const app = await createApp({
      services: buildServices(),
      syntheticFinanceInvitationHandoff: handoff,
    });

    const publicAttempt = await app.inject({
      method: 'POST',
      url: '/api/internal/finance-synthetic/invitation-token',
      headers,
      payload: { invitationId: IDS.invitation },
      remoteAddress: '203.0.113.25',
    });
    expect(publicAttempt.statusCode).toBe(503);
    expect(publicAttempt.body).not.toContain('a'.repeat(43));

    const first = await app.inject({
      method: 'POST',
      url: '/api/internal/finance-synthetic/invitation-token',
      headers,
      payload: { invitationId: IDS.invitation },
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({
      schemaVersion: 1,
      invitationToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    });
    expect(first.headers['cache-control']).toContain('no-store');

    const replay = await app.inject({
      method: 'POST',
      url: '/api/internal/finance-synthetic/invitation-token',
      headers: { ...headers, 'idempotency-key': 'finance-staging-replay-v1' },
      payload: { invitationId: IDS.invitation },
    });
    expect(replay.statusCode).toBe(404);
    expect(replay.body).not.toContain('a'.repeat(43));
    await app.close();
  });

  it('does not register the internal handoff in the baseline app', async () => {
    const app = await createApp({ services: buildServices() });
    const response = await app.inject({
      method: 'POST',
      url: '/api/internal/finance-synthetic/invitation-token',
      headers,
      payload: { invitationId: IDS.invitation },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});

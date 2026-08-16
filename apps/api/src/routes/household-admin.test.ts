import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../app.js';
import type {
  ApiServices,
  AuthenticatedPrincipal,
  HouseholdInvitationSummary,
  HouseholdMembershipSummary,
} from '../services/contracts.js';

const OWNER_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f70';
const MEMBER_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f71';
const SESSION_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f72';
const HOUSEHOLD_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f73';
const SPACE_GRANT_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f74';
const COLLECTION_AUTHORIZATION_SCOPE_FINGERPRINT =
  EffectiveAuthorizationScopeFingerprintSchema.parse('7'.repeat(64));
const INVITATION_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f75';
const MEMBERSHIP_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f76';
const IDEMPOTENCY_KEY = 'request:018f1f5e:household-admin';
const CREATED_AT = '2026-08-10T14:00:00.000Z';
const EXPIRES_AT = '2026-08-17T14:00:00.000Z';
const JOINED_AT = '2026-08-09T14:00:00.000Z';

const ownerPrincipal: AuthenticatedPrincipal = Object.freeze({
  userId: OWNER_ID,
  sessionId: SESSION_ID,
  householdId: HOUSEHOLD_ID,
  role: 'owner',
  emailVerified: true,
  spaceAccessGrantId: SPACE_GRANT_ID,
  collectionAuthorizationScopeFingerprint:
    COLLECTION_AUTHORIZATION_SCOPE_FINGERPRINT,
});

const memberPrincipal: AuthenticatedPrincipal = Object.freeze({
  ...ownerPrincipal,
  userId: MEMBER_ID,
  role: 'member',
});

const authenticatedHeaders = Object.freeze({
  cookie: '__Secure-emdo.session_token=current',
  origin: 'https://emdo.example',
  'x-csrf-token': 'csrf-token',
  'idempotency-key': IDEMPOTENCY_KEY,
});

const invitation: HouseholdInvitationSummary & { readonly status: 'pending' } =
  Object.freeze({
    id: INVITATION_ID,
    email: 'member@example.ca',
    role: 'member' as const,
    status: 'pending' as const,
    version: 1,
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
  });

const membership: HouseholdMembershipSummary & {
  readonly role: 'member';
  readonly status: 'active';
} = Object.freeze({
  id: MEMBERSHIP_ID,
  userId: MEMBER_ID,
  email: 'member@example.ca',
  role: 'member' as const,
  status: 'active' as const,
  version: 4,
  joinedAt: JOINED_AT,
});

const buildServices = (principal: AuthenticatedPrincipal = ownerPrincipal) => {
  const householdAdministration = {
    issueInvitation: vi.fn(async () => ({
      schemaVersion: 1 as const,
      invitation: { ...invitation, deliveryStatus: 'queued' as const },
      replayed: false,
    })),
    listInvitations: vi.fn(async () => ({
      schemaVersion: 1 as const,
      invitations: [invitation],
    })),
    revokeInvitation: vi.fn(async () => ({
      schemaVersion: 1 as const,
      invitation: { ...invitation, status: 'revoked' as const, version: 2 },
      replayed: false,
    })),
    listMemberships: vi.fn(async () => ({
      schemaVersion: 1 as const,
      memberships: [membership],
    })),
    changeMembershipRole: vi.fn(async () => ({
      schemaVersion: 1 as const,
      membership: { ...membership, role: 'owner' as const, version: 5 },
      replayed: false,
    })),
    deactivateMembership: vi.fn(async () => ({
      schemaVersion: 1 as const,
      membership: {
        ...membership,
        status: 'inactive' as const,
        version: 5,
        endedAt: '2026-08-10T15:00:00.000Z',
      },
      replayed: false,
    })),
  };
  const auth = {
    authenticate: vi.fn(async ({ cookie }: { readonly cookie?: string }) =>
      cookie === '__Secure-emdo.session_token=current' ? principal : undefined,
    ),
    verifyMutation: vi.fn(
      async (input: {
        readonly csrfToken?: string;
        readonly origin?: string;
      }) =>
        input.csrfToken === 'csrf-token' &&
        input.origin === 'https://emdo.example',
    ),
  };
  return {
    services: { auth, householdAdministration } as unknown as ApiServices,
    auth,
    householdAdministration,
  };
};

describe('household administration HTTP boundary', () => {
  it('issues and lists invitations using only server-authenticated owner authority', async () => {
    const { services, householdAdministration } = buildServices();
    const app = await createApp({ services });

    const issued = await app.inject({
      method: 'POST',
      url: '/api/v1/household/invitations',
      headers: authenticatedHeaders,
      payload: {
        schemaVersion: 1,
        email: ' Member@Example.CA ',
        role: 'member',
        expiresInSeconds: 604_800,
      },
    });
    expect(issued.statusCode).toBe(201);
    expect(issued.json()).toEqual({
      schemaVersion: 1,
      invitation: { ...invitation, deliveryStatus: 'queued' },
      replayed: false,
    });
    expect(householdAdministration.issueInvitation).toHaveBeenCalledWith({
      email: 'member@example.ca',
      role: 'member',
      expiresInSeconds: 604_800,
      principal: ownerPrincipal,
      requestId: expect.any(String),
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/household/invitations',
      headers: { cookie: '__Secure-emdo.session_token=current' },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      schemaVersion: 1,
      invitations: [invitation],
    });
    expect(householdAdministration.listInvitations).toHaveBeenCalledWith({
      principal: ownerPrincipal,
      requestId: expect.any(String),
    });

    await app.close();
  });

  it('lists and mutates memberships with exact path, version, and role bindings', async () => {
    const { services, householdAdministration } = buildServices();
    const app = await createApp({ services });

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/household/memberships',
      headers: { cookie: '__Secure-emdo.session_token=current' },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      schemaVersion: 1,
      memberships: [membership],
    });

    const roleChanged = await app.inject({
      method: 'PATCH',
      url: `/api/v1/household/memberships/${MEMBERSHIP_ID}/role`,
      headers: authenticatedHeaders,
      payload: { schemaVersion: 1, expectedVersion: 4, role: 'owner' },
    });
    expect(roleChanged.statusCode).toBe(200);
    expect(roleChanged.json()).toMatchObject({
      membership: { id: MEMBERSHIP_ID, role: 'owner', version: 5 },
    });
    expect(householdAdministration.changeMembershipRole).toHaveBeenCalledWith({
      membershipId: MEMBERSHIP_ID,
      expectedVersion: 4,
      role: 'owner',
      principal: ownerPrincipal,
      requestId: expect.any(String),
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    const deactivated = await app.inject({
      method: 'POST',
      url: `/api/v1/household/memberships/${MEMBERSHIP_ID}/deactivate`,
      headers: authenticatedHeaders,
      payload: { schemaVersion: 1, expectedVersion: 4 },
    });
    expect(deactivated.statusCode).toBe(200);
    expect(deactivated.json()).toMatchObject({
      membership: {
        id: MEMBERSHIP_ID,
        status: 'inactive',
        version: 5,
        endedAt: '2026-08-10T15:00:00.000Z',
      },
    });
    expect(householdAdministration.deactivateMembership).toHaveBeenCalledWith({
      membershipId: MEMBERSHIP_ID,
      expectedVersion: 4,
      principal: ownerPrincipal,
      requestId: expect.any(String),
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(householdAdministration.listMemberships).toHaveBeenCalledWith({
      principal: ownerPrincipal,
      requestId: expect.any(String),
    });
    await app.close();
  });

  it('revokes an invitation with an exact path and optimistic version binding', async () => {
    const { services, householdAdministration } = buildServices();
    const app = await createApp({ services });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/household/invitations/${INVITATION_ID}/revoke`,
      headers: authenticatedHeaders,
      payload: { schemaVersion: 1, expectedVersion: 1 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      invitation: {
        id: INVITATION_ID,
        status: 'revoked',
        version: 2,
      },
      replayed: false,
    });
    expect(householdAdministration.revokeInvitation).toHaveBeenCalledWith({
      invitationId: INVITATION_ID,
      expectedVersion: 1,
      principal: ownerPrincipal,
      requestId: expect.any(String),
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    await app.close();
  });

  it('rejects non-owner principals at the route before any administration service call', async () => {
    const { services, householdAdministration } =
      buildServices(memberPrincipal);
    const app = await createApp({ services });
    const requests = [
      {
        method: 'GET' as const,
        url: '/api/v1/household/invitations',
        headers: { cookie: '__Secure-emdo.session_token=current' },
      },
      {
        method: 'POST' as const,
        url: '/api/v1/household/invitations',
        headers: authenticatedHeaders,
        payload: {
          schemaVersion: 1,
          email: 'member@example.ca',
          role: 'member',
          expiresInSeconds: 3_600,
        },
      },
      {
        method: 'POST' as const,
        url: `/api/v1/household/invitations/${INVITATION_ID}/revoke`,
        headers: authenticatedHeaders,
        payload: { schemaVersion: 1, expectedVersion: 1 },
      },
      {
        method: 'GET' as const,
        url: '/api/v1/household/memberships',
        headers: { cookie: '__Secure-emdo.session_token=current' },
      },
      {
        method: 'PATCH' as const,
        url: `/api/v1/household/memberships/${MEMBERSHIP_ID}/role`,
        headers: authenticatedHeaders,
        payload: { schemaVersion: 1, expectedVersion: 4, role: 'owner' },
      },
      {
        method: 'POST' as const,
        url: `/api/v1/household/memberships/${MEMBERSHIP_ID}/deactivate`,
        headers: authenticatedHeaders,
        payload: { schemaVersion: 1, expectedVersion: 4 },
      },
    ];

    for (const request of requests) {
      const response = await app.inject(request);
      expect(response.statusCode, request.url).toBe(403);
      expect(response.json(), request.url).toMatchObject({
        code: 'household-owner-required',
      });
    }
    for (const method of Object.values(householdAdministration)) {
      expect(method).not.toHaveBeenCalled();
    }

    await app.close();
  });

  it('authenticates and verifies mutations before parsing request bodies', async () => {
    const { services, householdAdministration } = buildServices();
    const app = await createApp({
      services,
      limits: { maximumJsonBodyBytes: 128 },
    });

    const unauthenticatedOversized = await app.inject({
      method: 'POST',
      url: '/api/v1/household/invitations',
      headers: { 'content-type': 'application/json' },
      payload: { untrusted: 'x'.repeat(1_000) },
    });
    expect(unauthenticatedOversized.statusCode).toBe(401);

    const invalidProof = await app.inject({
      method: 'POST',
      url: '/api/v1/household/invitations',
      headers: {
        cookie: '__Secure-emdo.session_token=current',
        origin: 'https://attacker.example',
        'x-csrf-token': 'wrong',
        'idempotency-key': IDEMPOTENCY_KEY,
      },
      payload: { untrusted: 'x'.repeat(1_000) },
    });
    expect(invalidProof.statusCode).toBe(403);

    const missingIdempotency = await app.inject({
      method: 'POST',
      url: '/api/v1/household/invitations',
      headers: {
        cookie: '__Secure-emdo.session_token=current',
        origin: 'https://emdo.example',
        'x-csrf-token': 'csrf-token',
      },
      payload: {
        schemaVersion: 1,
        email: 'member@example.ca',
        role: 'member',
        expiresInSeconds: 3_600,
      },
    });
    expect(missingIdempotency.statusCode).toBe(400);
    expect(missingIdempotency.json()).toMatchObject({
      code: 'idempotency-key-required',
    });
    expect(householdAdministration.issueInvitation).not.toHaveBeenCalled();

    await app.close();
  });

  it('rejects client-supplied authority and malformed identifiers before service dispatch', async () => {
    const { services, householdAdministration } = buildServices();
    const app = await createApp({ services });

    const injectedAuthority = await app.inject({
      method: 'POST',
      url: '/api/v1/household/invitations',
      headers: authenticatedHeaders,
      payload: {
        schemaVersion: 1,
        email: 'member@example.ca',
        role: 'member',
        expiresInSeconds: 3_600,
        householdId: 'attacker-household',
        userId: 'attacker-user',
        sessionId: 'attacker-session',
      },
    });
    expect(injectedAuthority.statusCode).toBe(400);

    const malformedId = await app.inject({
      method: 'POST',
      url: '/api/v1/household/invitations/not-a-uuid/revoke',
      headers: authenticatedHeaders,
      payload: { schemaVersion: 1, expectedVersion: 1 },
    });
    expect(malformedId.statusCode).toBe(400);
    expect(householdAdministration.issueInvitation).not.toHaveBeenCalled();
    expect(householdAdministration.revokeInvitation).not.toHaveBeenCalled();

    await app.close();
  });

  it('fails closed when a service response exposes invitation secrets or breaks path bindings', async () => {
    const { services, householdAdministration } = buildServices();
    householdAdministration.issueInvitation = vi.fn(async () => ({
      schemaVersion: 1 as const,
      invitation: {
        ...invitation,
        deliveryStatus: 'queued' as const,
        token: 'raw-invitation-token-must-not-cross-http',
        tokenHash: 'a'.repeat(64),
      },
      replayed: false,
    }));
    householdAdministration.revokeInvitation = vi.fn(async () => ({
      schemaVersion: 1 as const,
      invitation: {
        ...invitation,
        id: MEMBER_ID,
        status: 'revoked' as const,
        version: 2,
      },
      replayed: false,
    }));
    const app = await createApp({ services });

    const leaked = await app.inject({
      method: 'POST',
      url: '/api/v1/household/invitations',
      headers: authenticatedHeaders,
      payload: {
        schemaVersion: 1,
        email: 'member@example.ca',
        role: 'member',
        expiresInSeconds: 3_600,
      },
    });
    expect(leaked.statusCode).toBe(502);
    expect(leaked.body).not.toContain(
      'raw-invitation-token-must-not-cross-http',
    );
    expect(leaked.body).not.toContain('aaaaaaaaaaaaaaaa');

    const misbound = await app.inject({
      method: 'POST',
      url: `/api/v1/household/invitations/${INVITATION_ID}/revoke`,
      headers: authenticatedHeaders,
      payload: { schemaVersion: 1, expectedVersion: 1 },
    });
    expect(misbound.statusCode).toBe(502);
    expect(misbound.json()).toMatchObject({
      code: 'service-contract-invalid',
    });

    await app.close();
  });

  it('rejects mutation results from a later state than the requested one-step transition', async () => {
    const { services, householdAdministration } = buildServices();
    householdAdministration.revokeInvitation = vi.fn(async () => ({
      schemaVersion: 1 as const,
      invitation: {
        ...invitation,
        status: 'revoked' as const,
        version: 99,
      },
      replayed: false,
    }));
    householdAdministration.changeMembershipRole = vi.fn(async () => ({
      schemaVersion: 1 as const,
      membership: {
        ...membership,
        role: 'owner' as const,
        version: 99,
      },
      replayed: false,
    }));
    householdAdministration.deactivateMembership = vi.fn(async () => ({
      schemaVersion: 1 as const,
      membership: {
        ...membership,
        status: 'inactive' as const,
        version: 99,
        endedAt: '2026-08-10T15:00:00.000Z',
      },
      replayed: false,
    }));
    const app = await createApp({ services });
    const requests = [
      {
        method: 'POST' as const,
        url: `/api/v1/household/invitations/${INVITATION_ID}/revoke`,
        payload: { schemaVersion: 1, expectedVersion: 1 },
      },
      {
        method: 'PATCH' as const,
        url: `/api/v1/household/memberships/${MEMBERSHIP_ID}/role`,
        payload: { schemaVersion: 1, expectedVersion: 4, role: 'owner' },
      },
      {
        method: 'POST' as const,
        url: `/api/v1/household/memberships/${MEMBERSHIP_ID}/deactivate`,
        payload: { schemaVersion: 1, expectedVersion: 4 },
      },
    ];

    for (const request of requests) {
      const response = await app.inject({
        ...request,
        headers: authenticatedHeaders,
      });
      expect(response.statusCode, request.url).toBe(502);
      expect(response.json(), request.url).toMatchObject({
        code: 'service-contract-invalid',
      });
    }

    await app.close();
  });

  it.each([
    ['authorization-revoked', 403],
    ['conflict', 409],
    ['self-lockout', 409],
    ['last-owner-required', 409],
    ['invalid-input', 400],
    ['invalid-result', 503],
  ] as const)('maps %s to a bounded safe problem', async (code, status) => {
    const { services, householdAdministration } = buildServices();
    householdAdministration.issueInvitation = vi.fn(async () => {
      throw Object.assign(new Error('sensitive database detail'), { code });
    });
    const app = await createApp({ services });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/household/invitations',
      headers: authenticatedHeaders,
      payload: {
        schemaVersion: 1,
        email: 'member@example.ca',
        role: 'member',
        expiresInSeconds: 3_600,
      },
    });

    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ code });
    expect(response.body).not.toContain('sensitive database detail');
    await app.close();
  });

  it('publishes cookie-authenticated owner routes and full mutation proof contracts in OpenAPI', async () => {
    const { services } = buildServices();
    const app = await createApp({ services });
    const response = await app.inject({ method: 'GET', url: '/openapi.json' });
    const document = response.json();

    expect(document.paths).toMatchObject({
      '/api/v1/household/invitations': {
        get: { security: [{ sessionAuth: [] }] },
        post: { security: [{ sessionAuth: [] }] },
      },
      '/api/v1/household/invitations/{id}/revoke': {
        post: { security: [{ sessionAuth: [] }] },
      },
      '/api/v1/household/memberships': {
        get: { security: [{ sessionAuth: [] }] },
      },
      '/api/v1/household/memberships/{id}/role': {
        patch: { security: [{ sessionAuth: [] }] },
      },
      '/api/v1/household/memberships/{id}/deactivate': {
        post: { security: [{ sessionAuth: [] }] },
      },
    });
    for (const operation of [
      document.paths['/api/v1/household/invitations'].post,
      document.paths['/api/v1/household/invitations/{id}/revoke'].post,
      document.paths['/api/v1/household/memberships/{id}/role'].patch,
      document.paths['/api/v1/household/memberships/{id}/deactivate'].post,
    ]) {
      expect(
        operation.parameters.map(
          (parameter: { readonly name: string }) => parameter.name,
        ),
      ).toEqual(
        expect.arrayContaining(['Idempotency-Key', 'Origin', 'X-CSRF-Token']),
      );
    }
    const issueProperties =
      document.paths['/api/v1/household/invitations'].post.requestBody.content[
        'application/json'
      ].schema.properties;
    expect(Object.keys(issueProperties).sort()).toEqual([
      'email',
      'expiresInSeconds',
      'role',
      'schemaVersion',
    ]);

    await app.close();
  });
});

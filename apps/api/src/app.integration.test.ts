import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  createApp,
  type ApiServices,
  type AuthenticatedPrincipal,
  type RunEvent,
} from './app.js';
import {
  assertCompleteApiServices,
  loadApiServerConfig,
  loadProductionApiServices,
} from './main.js';
import {
  API_READINESS_REQUIRED_CHECKS,
  API_READINESS_SCHEMA_VERSION,
  type ApiReadinessStatus,
} from './readiness-contract.js';
import { DEFAULT_API_LIMITS } from './config.js';

const USER_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f60';
const SESSION_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f61';
const HOUSEHOLD_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f62';
const SPACE_GRANT_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f63';
const CLIENT_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f64';
const CONVERSATION_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f65';
const RUN_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f66';
const PROPOSAL_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f67';
const DECISION_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f68';
const PAYLOAD_HASH = 'a'.repeat(64);
const APPROVAL_HASH = 'b'.repeat(64);
const IDEMPOTENCY_KEY = 'request:018f1f5e:calendar-write';
const VISUAL_PROOF_TOKEN = 'visual_proof_opaque_0123456789abcdefghijklmno';
const RAW_SESSION_TOKEN_SENTINEL = 'raw-session-token-must-never-cross-http';
const COLLECTION_SCOPE_FINGERPRINT =
  EffectiveAuthorizationScopeFingerprintSchema.parse('c'.repeat(64));

const readinessChecks = (status: ApiReadinessStatus) =>
  Object.freeze(
    Object.fromEntries(
      API_READINESS_REQUIRED_CHECKS.map((name) => [name, status]),
    ),
  );
const syntheticHttpSubsetChecks = Object.freeze({
  ...readinessChecks('unavailable'),
  'authority.authentication': 'ok' as const,
  sync: 'ok' as const,
  'sync.gateway': 'ok' as const,
  'sync.jwks': 'ok' as const,
});
const EDGE_PROXY_SECRET =
  'edge-proxy-test-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const principal: AuthenticatedPrincipal = {
  collectionAuthorizationScopeFingerprint: COLLECTION_SCOPE_FINGERPRINT,
  userId: USER_ID,
  sessionId: SESSION_ID,
  householdId: HOUSEHOLD_ID,
  role: 'owner',
  emailVerified: true,
  spaceAccessGrantId: SPACE_GRANT_ID,
};

const authenticatedHeaders = {
  cookie: '__Secure-emdo.session_token=current',
  origin: 'https://emdo.example',
  'x-csrf-token': 'csrf-token',
};

const event = (sequence: number, type = 'run.message.delta'): RunEvent => ({
  schemaVersion: 1,
  runId: RUN_ID,
  sequence,
  type,
  occurredAt: `2026-08-09T12:00:0${sequence}.000Z`,
  data: { text: `event-${sequence}` },
});

const finiteEvents = async function* (events: readonly RunEvent[]) {
  for (const entry of events) yield entry;
};

const buildServices = () => {
  const services: ApiServices = {
    auth: {
      authenticate: vi.fn(async ({ cookie }) =>
        cookie === '__Secure-emdo.session_token=current'
          ? principal
          : undefined,
      ),
      verifyMutation: vi.fn(
        async ({ csrfToken, origin }) =>
          csrfToken === 'csrf-token' && origin === 'https://emdo.example',
      ),
      handleBrowserRequest: vi.fn(async ({ request }) => {
        const path = new URL(request.url).pathname;
        const headers = new Headers({ 'content-type': 'application/json' });
        headers.append(
          'set-cookie',
          '__Secure-emdo.session_token=rotated; Path=/; Secure; HttpOnly; SameSite=Lax',
        );
        headers.append(
          'set-cookie',
          '__Secure-emdo.session_data=opaque; Path=/; Secure; HttpOnly; SameSite=Lax',
        );
        headers.set('x-auth-session-token', RAW_SESSION_TOKEN_SENTINEL);
        const user = {
          id: USER_ID,
          email: 'member@example.ca',
          emailVerified: true,
          name: 'Household Member',
          token: RAW_SESSION_TOKEN_SENTINEL,
        };
        const session = {
          id: SESSION_ID,
          token: RAW_SESSION_TOKEN_SENTINEL,
          expiresAt: '2026-08-10T12:00:00.000Z',
          userId: USER_ID,
        };

        if (path === '/api/auth/callback/google') {
          headers.set('location', 'https://emdo.example/today');
          return new Response(RAW_SESSION_TOKEN_SENTINEL, {
            status: 302,
            headers,
          });
        }
        if (path === '/api/auth/get-session') {
          return Response.json(
            { session, user, token: RAW_SESSION_TOKEN_SENTINEL },
            { headers },
          );
        }
        if (path === '/api/auth/sign-in/email') {
          return Response.json(
            {
              redirect: false,
              token: RAW_SESSION_TOKEN_SENTINEL,
              user,
            },
            { headers },
          );
        }
        if (path === '/api/auth/sign-in/social') {
          return Response.json(
            {
              redirect: true,
              url: 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque',
              token: RAW_SESSION_TOKEN_SENTINEL,
            },
            { headers },
          );
        }
        if (path === '/api/auth/passkey/generate-authenticate-options') {
          return Response.json(
            {
              challenge: 'authentication-challenge',
              timeout: 60_000,
              rpId: 'emdo.example',
              userVerification: 'preferred',
              allowCredentials: [],
              token: RAW_SESSION_TOKEN_SENTINEL,
            },
            { headers },
          );
        }
        if (path === '/api/auth/passkey/verify-authentication') {
          return Response.json(
            { session, user, token: RAW_SESSION_TOKEN_SENTINEL },
            { headers },
          );
        }
        if (path === '/api/auth/passkey/generate-register-options') {
          return Response.json(
            {
              challenge: 'registration-challenge',
              rp: { id: 'emdo.example', name: 'EMDO' },
              user: {
                id: 'dXNlci0x',
                name: 'member@example.ca',
                displayName: 'Household Member',
                token: RAW_SESSION_TOKEN_SENTINEL,
              },
              pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
              timeout: 60_000,
              excludeCredentials: [],
              authenticatorSelection: {
                authenticatorAttachment: 'platform',
                residentKey: 'preferred',
                userVerification: 'preferred',
              },
              attestation: 'none',
              token: RAW_SESSION_TOKEN_SENTINEL,
            },
            { headers },
          );
        }
        if (path === '/api/auth/passkey/verify-registration') {
          return Response.json(
            {
              id: 'passkey-id',
              name: 'This device',
              publicKey: RAW_SESSION_TOKEN_SENTINEL,
              token: RAW_SESSION_TOKEN_SENTINEL,
            },
            { headers },
          );
        }
        if (path === '/api/auth/sign-out') {
          return Response.json(
            { success: true, token: RAW_SESSION_TOKEN_SENTINEL },
            { headers },
          );
        }
        return Response.json(
          {
            path,
            cookie: request.headers.get('cookie'),
            token: RAW_SESSION_TOKEN_SENTINEL,
          },
          { headers },
        );
      }),
      issueMutationCsrf: vi.fn(async () => ({
        token: 'authenticated-csrf-token-0123456789',
        cookie:
          'emdo.csrf_token=authenticated-csrf-token-0123456789; Path=/api/; Secure; HttpOnly; SameSite=Strict',
      })),
      issueInvitationCsrf: vi.fn(async () => ({
        token: 'invitation-csrf-token-0123456789',
        cookie:
          'emdo.invitation_csrf=invitation-csrf-token-0123456789; Path=/api/v1/auth/invitations/; Secure; HttpOnly; SameSite=Strict',
      })),
      redeemInvitation: vi.fn(async () => ({
        schemaVersion: 1 as const,
        userId: USER_ID,
        householdId: HOUSEHOLD_ID,
        role: 'member' as const,
        emailVerified: true as const,
      })),
    },
    activityRead: {
      list: vi.fn(async () => ({ schemaVersion: 1 as const, items: [] })),
    },
    financeRead: {
      list: vi.fn(async () => ({ schemaVersion: 1 as const, items: [] })),
    },
    financeImports: {
      listDestinations: vi.fn(async () => ({
        schemaVersion: 1 as const,
        accounts: [],
        categories: [],
      })),
      preview: vi.fn(async () => ({
        schemaVersion: 1 as const,
        plan: {
          id: 'finance-import-plan',
          sourceHash: '0'.repeat(64),
          expiresAt: '2026-08-13T15:10:00.000Z',
          summary: { accepted: 1, rejected: 0, duplicates: 0 },
          rejectedRows: [],
          duplicateRows: [],
        },
      })),
      commit: vi.fn(async () => ({
        schemaVersion: 1 as const,
        status: 'committed' as const,
        receipt: {
          id: 'finance-import-receipt',
          planId: 'finance-import-plan',
          transactionCount: 1,
          verified: true as const,
        },
        sourceDeletionAuthorized: true as const,
      })),
    },
    managerTurns: {
      start: vi.fn(async () => ({
        schemaVersion: 1 as const,
        runId: RUN_ID,
        status: 'accepted' as const,
        replayed: false,
        eventsPath: `/api/v1/runs/${RUN_ID}/events`,
      })),
    },
    notificationPreferences: {
      get: vi.fn(async () => ({
        schemaVersion: 1 as const,
        version: 1,
        inApp: true,
        push: false,
        email: false,
        spokenReplies: false,
        updatedAt: '2026-08-10T12:00:00.000Z',
      })),
      update: vi.fn(async () => ({
        schemaVersion: 1 as const,
        version: 2,
        inApp: true,
        push: false,
        email: false,
        spokenReplies: false,
        updatedAt: '2026-08-10T12:00:00.000Z',
      })),
    },
    runEvents: {
      open: vi.fn(async ({ afterSequence }) =>
        finiteEvents(
          [event(1), event(2)].filter((item) => item.sequence > afterSequence),
        ),
      ),
    },
    proposalQueries: {
      list: vi.fn(async () => ({
        status: 'ok' as const,
        page: {
          schemaVersion: 1 as const,
          items: [],
        },
      })),
      getDetail: vi.fn(async () => undefined),
    },
    visualProofs: {
      issue: vi.fn(
        async ({
          proposalId,
          expectedProposalVersion,
          expectedPayloadHash,
          expectedApprovalHash,
        }) => {
          const issuedAt = new Date();
          return {
            status: 'issued' as const,
            proof: {
              schemaVersion: 1 as const,
              proposalId,
              proposalVersion: expectedProposalVersion,
              payloadHash: expectedPayloadHash,
              approvalHash: expectedApprovalHash,
              proofToken: 'visual_proof_opaque_0123456789abcdefghijklmno',
              issuedAt: issuedAt.toISOString(),
              expiresAt: new Date(issuedAt.getTime() + 60_000).toISOString(),
              replayed: false,
            },
          };
        },
      ),
    },
    proposals: {
      decideWithVisualProof: vi.fn(
        async ({ request, principal: actor, visualProofToken }) => {
          if (visualProofToken !== VISUAL_PROOF_TOKEN)
            throw new Error('invalid-proof');
          return {
            status: 'decided' as const,
            decision: {
              schemaVersion: 1 as const,
              id: DECISION_ID,
              proposalId: request.proposalId,
              userId: actor.userId,
              authenticatedSessionId: actor.sessionId,
              payloadHash: request.payloadHash,
              approvalHash: request.approvalHash,
              decision: request.decision,
              channel: 'authenticated-visual' as const,
              decidedAt: '2026-08-09T12:00:00.000Z',
              idempotencyKey: request.idempotencyKey,
            },
          };
        },
      ),
    },
    sync: {
      registerClient: vi.fn(async ({ clientId }) => ({
        schemaVersion: 1 as const,
        clientId,
        status: 'registered' as const,
        replayed: false,
      })),
      issueToken: vi.fn(async () => ({
        schemaVersion: 1 as const,
        endpoint: 'https://emdo.invalid/powersync',
        token: 'header.claims.signature',
        expiresAt: '2026-08-09T12:05:00.000Z',
        writeScope: {
          clientId: CLIENT_ID,
          spaces: [
            {
              id: SPACE_GRANT_ID,
              visibility: 'private' as const,
              originalOwnerUserId: USER_ID,
            },
          ],
        },
      })),
      applyOperations: vi.fn(async ({ clientId }) => ({
        schemaVersion: 1 as const,
        clientId,
        results: [],
      })),
    },
    audioRequests: {
      claim: vi.fn(async () => ({
        status: 'claimed' as const,
        claimId: 'audio-claim-018f1f5e',
        ownershipToken: 'audio-owner-token-018f1f5e',
        executionId: 'audio-execution-018f1f5e',
        reservationId: 'audio-reservation-018f1f5e',
      })),
      completeTranscription: vi.fn(async () => undefined),
      completeSpeech: vi.fn(async () => undefined),
      releaseKnownNoDispatch: vi.fn(async () => undefined),
      markIndeterminate: vi.fn(async () => undefined),
      checkReady: vi.fn(async () => true),
    },
    voice: {
      inspectRecording: vi.fn(
        async ({ declaredContentType, durationHintMs }) => ({
          status: 'verified' as const,
          verifiedContentType: declaredContentType as 'audio/webm',
          durationMs: durationHintMs,
        }),
      ),
      getSpeechConfiguration: vi.fn(async () => ({
        model: 'tts-1' as const,
        configurationVersion: 'speech-profile-v1',
      })),
      transcribe: vi.fn(async () => ({
        status: 'completed' as const,
        transcript: 'buy milk',
        model: 'gpt-4o-mini-transcribe' as const,
        spendWarning: false,
      })),
      speak: vi.fn(async () => ({
        status: 'completed' as const,
        audio: Uint8Array.from([1, 2, 3]),
        contentType: 'audio/mpeg' as const,
        model: 'tts-1' as const,
        spendWarning: false,
      })),
    },
    google: {
      beginAuthorization: vi.fn(async () => ({
        status: 'authorization-required' as const,
        authorizationUrl:
          'https://accounts.google.com/o/oauth2/v2/auth?state=opaque',
        expiresAt: '2026-08-09T12:10:00.000Z',
      })),
      completeAuthorization: vi.fn(async () => ({
        status: 'connected' as const,
        connectionId: 'google-calendar-connection',
        grantedPurposes: ['calendar-event-write' as const],
      })),
      disconnect: vi.fn(async () => ({
        status: 'disconnected' as const,
        providerRevocation: 'confirmed' as const,
      })),
    },
    householdAdministration: {
      issueInvitation: vi.fn(async () => {
        throw new Error('not exercised by the aggregate route harness');
      }),
      listInvitations: vi.fn(async () => {
        throw new Error('not exercised by the aggregate route harness');
      }),
      revokeInvitation: vi.fn(async () => {
        throw new Error('not exercised by the aggregate route harness');
      }),
      listMemberships: vi.fn(async () => {
        throw new Error('not exercised by the aggregate route harness');
      }),
      changeMembershipRole: vi.fn(async () => {
        throw new Error('not exercised by the aggregate route harness');
      }),
      deactivateMembership: vi.fn(async () => {
        throw new Error('not exercised by the aggregate route harness');
      }),
    },
    scheduleRead: {
      list: vi.fn(async ({ from, to }) => ({
        schemaVersion: 1 as const,
        timezone: 'America/Toronto' as const,
        from,
        to,
        items: { status: 'available' as const, items: [] },
        calendar: { status: 'disconnected' as const },
      })),
    },
    settingsRead: {
      read: vi.fn(async () => ({
        schemaVersion: 1 as const,
        household: { name: 'EMDO household', role: 'owner' as const },
        privateSpaces: [],
        calendar: { status: 'disconnected' as const },
      })),
    },
    shoppingRead: {
      list: vi.fn(async () => ({ schemaVersion: 1 as const, items: [] })),
    },
    todayRead: {
      read: vi.fn(async ({ date }) => ({
        schemaVersion: 1 as const,
        date,
        timezone: 'America/Toronto' as const,
        schedule: { status: 'available' as const, items: [] },
        reminders: { status: 'available' as const, items: [] },
        notifications: { status: 'available' as const, items: [] },
        finance: {
          status: 'available' as const,
          budgetCount: 0,
          transactionCount: 0,
        },
        shopping: {
          status: 'available' as const,
          itemCount: 0,
          retailerCount: 0,
        },
      })),
    },
    jwks: {
      getPublicJwks: vi.fn(async () => ({
        keys: [
          {
            kty: 'RSA' as const,
            use: 'sig' as const,
            alg: 'RS256' as const,
            kid: 'sync-key-2026-08',
            n: 'abc123_-',
            e: 'AQAB',
          },
        ],
      })),
    },
    readiness: {
      check: vi.fn(async () => ({
        ready: true,
        checks: readinessChecks('ok'),
      })),
    },
    metrics: {
      authorize: vi.fn(
        async ({ authorization }) => authorization === 'Bearer metrics',
      ),
      render: vi.fn(async () => 'emdo_http_requests_total 1\n'),
    },
  };
  return services;
};

describe('Fastify API boundary', () => {
  it('publishes public liveness, readiness, JWKS, and generated OpenAPI with request IDs', async () => {
    const services = buildServices();
    const app = await createApp({ services });

    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    expect(health.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/u);
    expect(health.json()).toMatchObject({ status: 'ok' });

    const ready = await app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({
      schemaVersion: API_READINESS_SCHEMA_VERSION,
      status: 'ready',
      checks: readinessChecks('ok'),
    });

    const jwks = await app.inject({
      method: 'GET',
      url: '/.well-known/jwks.json',
    });
    expect(jwks.statusCode).toBe(200);
    expect(jwks.headers['cache-control']).toBe('no-store');
    expect(jwks.json().keys[0]).not.toHaveProperty('d');

    const openapi = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(openapi.statusCode).toBe(200);
    expect(openapi.json()).toMatchObject({
      openapi: '3.1.0',
      paths: {
        '/api/auth/get-session': { get: expect.any(Object) },
        '/api/auth/sign-in/email': { post: expect.any(Object) },
        '/api/auth/sign-in/social': { post: expect.any(Object) },
        '/api/auth/passkey/verify-authentication': {
          post: expect.any(Object),
        },
        '/api/v1/auth/invitations/redeem': { post: expect.any(Object) },
        '/api/v1/turns': { post: expect.any(Object) },
        '/api/v1/runs/{id}/events': { get: expect.any(Object) },
        '/api/v1/proposals/{id}/decision': { post: expect.any(Object) },
        '/api/v1/experience/today': { get: expect.any(Object) },
        '/api/v1/experience/activity': { get: expect.any(Object) },
        '/api/v1/experience/finance': { get: expect.any(Object) },
        '/api/v1/experience/schedule': { get: expect.any(Object) },
        '/api/v1/experience/settings': { get: expect.any(Object) },
        '/api/v1/experience/shopping': { get: expect.any(Object) },
        '/api/v1/experience/notification-preferences': {
          get: expect.any(Object),
          put: expect.any(Object),
        },
        '/readyz': {
          get: {
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: {
                      properties: {
                        schemaVersion: { const: API_READINESS_SCHEMA_VERSION },
                        checks: {
                          additionalProperties: false,
                          properties: {
                            'authority.authentication': expect.any(Object),
                            'experience.finance-read': expect.any(Object),
                            'experience.shopping-read': expect.any(Object),
                            'sync.gateway': expect.any(Object),
                          },
                          required: expect.arrayContaining([
                            ...API_READINESS_REQUIRED_CHECKS,
                          ]),
                        },
                      },
                    },
                  },
                },
              },
              '503': {
                content: {
                  'application/problem+json': {
                    schema: {
                      properties: {
                        code: { const: 'service-not-ready' },
                        extensions: {
                          properties: {
                            readinessSchemaVersion: {
                              const: API_READINESS_SCHEMA_VERSION,
                            },
                            checks: {
                              additionalProperties: false,
                              properties: {
                                'authority.authentication': expect.any(Object),
                                'experience.finance-read': expect.any(Object),
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(openapi.json().components.securitySchemes).toMatchObject({
      sessionAuth: expect.objectContaining({
        name: '__Secure-emdo.session_token',
      }),
    });
    expect(openapi.json().components.securitySchemes).not.toHaveProperty(
      'sessionBearer',
    );
    expect(
      openapi.json().paths['/api/auth/get-session'].get,
    ).not.toHaveProperty('security');
    for (const [path, pathItem] of Object.entries(
      openapi.json().paths as Record<string, Record<string, unknown>>,
    )) {
      for (const operation of Object.values(pathItem)) {
        if (
          operation === null ||
          typeof operation !== 'object' ||
          !('security' in operation)
        ) {
          continue;
        }
        expect(
          (operation as { readonly security: unknown }).security,
          path,
        ).toEqual(
          path === '/metrics' ? [{ metricsBearer: [] }] : [{ sessionAuth: [] }],
        );
      }
    }
    expect(
      Object.keys(
        openapi.json().paths['/api/auth/sign-in/social'].post.requestBody
          .content['application/json'].schema.properties,
      ).sort(),
    ).toEqual(['callbackURL', 'provider']);
    expect(
      openapi.json().paths['/api/auth/sign-in/email'].post.requestBody.content[
        'application/json'
      ].schema.properties.password.minLength,
    ).toBe(12);
    expect(
      openapi.json().paths['/api/auth/passkey/verify-authentication'].post
        .requestBody.content['application/json'].schema,
    ).toMatchObject({ type: 'object', additionalProperties: false });
    expect(
      openapi.json().paths['/api/auth/passkey/verify-registration'].post
        .requestBody.content['application/json'].schema,
    ).toMatchObject({ type: 'object', additionalProperties: false });
    const callbackParameters =
      openapi.json().paths['/api/auth/callback/google'].get.parameters;
    expect(
      callbackParameters.map(({ name }: { name: string }) => name),
    ).toEqual([
      'authuser',
      'code',
      'error',
      'error_description',
      'error_uri',
      'hd',
      'iss',
      'prompt',
      'scope',
      'session_state',
      'state',
    ]);
    expect(
      callbackParameters.find(({ name }: { name: string }) => name === 'state'),
    ).toMatchObject({ required: true, schema: { minLength: 1 } });
    expect(
      openapi.json().paths['/api/v1/connectors/google/callback'].get.security,
    ).toEqual([{ sessionAuth: [] }]);
    const turnParameters =
      openapi.json().paths['/api/v1/turns'].post.parameters;
    expect(
      turnParameters.map((parameter: { name: string }) => parameter.name),
    ).toEqual(
      expect.arrayContaining(['Idempotency-Key', 'Origin', 'X-CSRF-Token']),
    );
    const transcriptionTypes = Object.keys(
      openapi.json().paths['/api/v1/voice/transcribe'].post.requestBody.content,
    );
    expect(transcriptionTypes).toEqual(
      expect.arrayContaining([
        'audio/webm',
        'audio/mpeg',
        'audio/mp4',
        'audio/ogg',
        'audio/wav',
        'audio/x-wav',
      ]),
    );
    const transcriptionParameters =
      openapi.json().paths['/api/v1/voice/transcribe'].post.parameters;
    expect(
      transcriptionParameters.map(
        (parameter: { name: string }) => parameter.name,
      ),
    ).toEqual(expect.arrayContaining(['durationMs', 'attempt']));
    expect(
      transcriptionParameters.map(
        (parameter: { name: string }) => parameter.name,
      ),
    ).not.toContain('model');

    await app.close();
  });

  it('returns safe application/problem+json failures and never trusts client identity', async () => {
    const services = buildServices();
    const app = await createApp({ services });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/turns',
      headers: { 'idempotency-key': IDEMPOTENCY_KEY },
      payload: {
        schemaVersion: 1,
        message: 'Plan tomorrow',
        userId: USER_ID,
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(response.json()).toMatchObject({
      status: 401,
      code: 'authentication-required',
      requestId: response.headers['x-request-id'],
    });
    expect(JSON.stringify(response.json())).not.toContain(USER_ID);
    expect(services.managerTurns.start).not.toHaveBeenCalled();
    await app.close();
  });

  it('fails closed on invalid browser mutation proof and malformed internal responses', async () => {
    const services = buildServices();
    services.auth.verifyMutation = vi.fn(async () => false);
    const app = await createApp({ services });
    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/turns',
      headers: {
        ...authenticatedHeaders,
        'idempotency-key': IDEMPOTENCY_KEY,
      },
      payload: { schemaVersion: 1, message: 'Plan tomorrow' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'mutation-proof-invalid' });
    expect(services.managerTurns.start).not.toHaveBeenCalled();
    await app.close();

    const malformedServices = buildServices();
    malformedServices.managerTurns.start = vi.fn(async () => ({
      schemaVersion: 1 as const,
      runId: RUN_ID,
      status: 'accepted' as const,
      replayed: false,
      eventsPath: `/api/v1/runs/${PROPOSAL_ID}/events`,
    }));
    const malformedApp = await createApp({ services: malformedServices });
    const malformed = await malformedApp.inject({
      method: 'POST',
      url: '/api/v1/turns',
      headers: {
        ...authenticatedHeaders,
        'idempotency-key': IDEMPOTENCY_KEY,
      },
      payload: { schemaVersion: 1, message: 'Plan tomorrow' },
    });
    expect(malformed.statusCode).toBe(502);
    expect(malformed.json()).toMatchObject({
      code: 'service-contract-invalid',
    });
    await malformedApp.close();
  });

  it('validates a strict turn contract, requires request idempotency, and dispatches only through the manager gateway', async () => {
    const services = buildServices();
    const app = await createApp({ services });

    const missingKey = await app.inject({
      method: 'POST',
      url: '/api/v1/turns',
      headers: authenticatedHeaders,
      payload: { schemaVersion: 1, message: 'Plan tomorrow' },
    });
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json()).toMatchObject({
      code: 'idempotency-key-required',
    });

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/turns',
      headers: { ...authenticatedHeaders, 'idempotency-key': IDEMPOTENCY_KEY },
      payload: {
        schemaVersion: 1,
        message: 'Plan tomorrow',
        model: 'gpt-5.6-terra',
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'request-validation-failed' });

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v1/turns',
      headers: { ...authenticatedHeaders, 'idempotency-key': IDEMPOTENCY_KEY },
      payload: {
        schemaVersion: 1,
        conversationId: CONVERSATION_ID,
        message: 'Plan tomorrow around chores',
        routeHint: 'scheduler',
      },
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({
      runId: RUN_ID,
      status: 'accepted',
    });
    expect(services.managerTurns.start).toHaveBeenCalledWith(
      expect.objectContaining({
        principal,
        idempotencyKey: IDEMPOTENCY_KEY,
        request: expect.objectContaining({ routeHint: 'scheduler' }),
      }),
    );
    await app.close();
  });

  it('replays authorized persisted run events as SSE from Last-Event-ID', async () => {
    const services = buildServices();
    const app = await createApp({ services });
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/runs/${RUN_ID}/events`,
      headers: {
        cookie: '__Secure-emdo.session_token=current',
        'last-event-id': '1',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toContain('id: 2\n');
    expect(response.body).not.toContain('id: 1\n');
    expect(services.runEvents.open).toHaveBeenCalledWith(
      expect.objectContaining({ runId: RUN_ID, afterSequence: 1, principal }),
    );
    await app.close();
  });

  it('requires a server-consumed visual proof and exact decision bindings', async () => {
    const services = buildServices();
    const app = await createApp({ services });
    const decision = {
      schemaVersion: 1,
      proposalId: PROPOSAL_ID,
      payloadHash: PAYLOAD_HASH,
      approvalHash: APPROVAL_HASH,
      decision: 'approved',
      idempotencyKey: IDEMPOTENCY_KEY,
    };
    const headers = {
      ...authenticatedHeaders,
      'idempotency-key': IDEMPOTENCY_KEY,
    };

    const noProof = await app.inject({
      method: 'POST',
      url: `/api/v1/proposals/${PROPOSAL_ID}/decision`,
      headers,
      payload: decision,
    });
    expect(noProof.statusCode).toBe(403);
    expect(noProof.json()).toMatchObject({ code: 'visual-approval-required' });
    expect(services.proposals.decideWithVisualProof).not.toHaveBeenCalled();

    const keyMismatch = await app.inject({
      method: 'POST',
      url: `/api/v1/proposals/${PROPOSAL_ID}/decision`,
      headers: {
        ...headers,
        'idempotency-key': 'request:018f1f5e:different-key',
        'x-emdo-visual-confirmation': VISUAL_PROOF_TOKEN,
      },
      payload: decision,
    });
    expect(keyMismatch.statusCode).toBe(409);
    expect(keyMismatch.json()).toMatchObject({
      code: 'idempotency-key-mismatch',
    });
    expect(services.proposals.decideWithVisualProof).not.toHaveBeenCalled();

    const typedChannel = await app.inject({
      method: 'POST',
      url: `/api/v1/proposals/${PROPOSAL_ID}/decision`,
      headers: {
        ...headers,
        'x-emdo-visual-confirmation': 'voice',
      },
      payload: { ...decision, channel: 'voice' },
    });
    expect(typedChannel.statusCode).toBe(400);

    const approved = await app.inject({
      method: 'POST',
      url: `/api/v1/proposals/${PROPOSAL_ID}/decision`,
      headers: {
        ...headers,
        'x-emdo-visual-confirmation': VISUAL_PROOF_TOKEN,
      },
      payload: decision,
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      proposalId: PROPOSAL_ID,
      channel: 'authenticated-visual',
    });
    expect(services.proposals.decideWithVisualProof).toHaveBeenCalledWith(
      expect.objectContaining({
        principal,
        visualProofToken: VISUAL_PROOF_TOKEN,
      }),
    );
    await app.close();
  });

  it('issues scoped sync tokens and submits offline-only operations with server identity', async () => {
    const services = buildServices();
    const app = await createApp({ services });
    const registration = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/clients',
      headers: {
        ...authenticatedHeaders,
        'idempotency-key': 'request:018f1f5e:register-sync-client',
      },
      payload: {
        schemaVersion: 1,
        clientId: CLIENT_ID,
        displayName: 'Mattermost MacBook',
      },
    });
    expect(registration.statusCode).toBe(201);
    expect(registration.json()).toEqual({
      schemaVersion: 1,
      clientId: CLIENT_ID,
      status: 'registered',
      replayed: false,
    });
    expect(services.sync.registerClient).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: CLIENT_ID,
        displayName: 'Mattermost MacBook',
        principal,
      }),
    );

    const token = await app.inject({
      method: 'GET',
      url: `/api/v1/sync/token?clientId=${CLIENT_ID}`,
      headers: { cookie: '__Secure-emdo.session_token=current' },
    });
    expect(token.statusCode).toBe(200);
    expect(token.json()).toMatchObject({
      endpoint: 'https://emdo.invalid/powersync',
      writeScope: {
        clientId: CLIENT_ID,
        spaces: [
          {
            id: SPACE_GRANT_ID,
            visibility: 'private',
            originalOwnerUserId: USER_ID,
          },
        ],
      },
    });
    expect(services.sync.issueToken).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: CLIENT_ID, principal }),
    );

    services.sync.issueToken = vi.fn(async () => ({
      schemaVersion: 1 as const,
      endpoint: 'https://another-household.example/powersync',
      token: 'header.claims.signature',
      expiresAt: '2026-08-09T12:05:00.000Z',
      writeScope: {
        clientId: CLIENT_ID,
        spaces: [
          {
            id: SPACE_GRANT_ID,
            visibility: 'private' as const,
            originalOwnerUserId: USER_ID,
          },
        ],
      },
    }));
    const crossOriginToken = await app.inject({
      method: 'GET',
      url: `/api/v1/sync/token?clientId=${CLIENT_ID}`,
      headers: { cookie: '__Secure-emdo.session_token=current' },
    });
    expect(crossOriginToken.statusCode).toBe(502);
    expect(crossOriginToken.json()).toMatchObject({
      code: 'service-contract-invalid',
    });

    services.sync.issueToken = vi.fn(async () => ({
      schemaVersion: 1 as const,
      endpoint: 'https://emdo.invalid/not-powersync',
      token: 'header.claims.signature',
      expiresAt: '2026-08-09T12:05:00.000Z',
      writeScope: {
        clientId: CLIENT_ID,
        spaces: [
          {
            id: SPACE_GRANT_ID,
            visibility: 'private' as const,
            originalOwnerUserId: USER_ID,
          },
        ],
      },
    }));
    const wrongPathToken = await app.inject({
      method: 'GET',
      url: `/api/v1/sync/token?clientId=${CLIENT_ID}`,
      headers: { cookie: '__Secure-emdo.session_token=current' },
    });
    expect(wrongPathToken.statusCode).toBe(502);
    expect(wrongPathToken.json()).toMatchObject({
      code: 'service-contract-invalid',
    });

    const operationId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f80';
    const syncOperation = {
      schemaVersion: 1 as const,
      clientId: CLIENT_ID,
      operationId,
      entity: { type: 'shopping.item', id: 'milk' },
      mutation: {
        kind: 'create' as const,
        payload: {
          spaceId: SPACE_GRANT_ID,
          value: { name: 'Milk', unit: 'carton', quantityMinorUnits: 1_000 },
        },
      },
      baseRevision: 0,
      dependencies: [],
      actorIntent: 'Add milk to the private household list',
      createdAt: '2026-08-09T12:00:00.000Z',
    };
    services.sync.applyOperations = vi.fn(async ({ clientId }) => ({
      schemaVersion: 1 as const,
      clientId,
      results: [
        {
          operationId,
          status: 'applied' as const,
          revision: 1,
          resolution: 'created' as const,
          conflicts: [],
          replayed: false,
        },
      ],
    }));
    const upload = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/ops',
      headers: { ...authenticatedHeaders, 'idempotency-key': IDEMPOTENCY_KEY },
      payload: {
        schemaVersion: 1,
        clientId: CLIENT_ID,
        operations: [syncOperation],
      },
    });
    expect(upload.statusCode).toBe(200);
    expect(upload.json()).toMatchObject({
      results: [
        {
          operationId,
          status: 'applied',
          resolution: 'created',
          conflicts: [],
        },
      ],
    });
    expect(services.sync.applyOperations).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: CLIENT_ID,
        principal,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    );

    services.sync.applyOperations = vi.fn(async () => ({
      schemaVersion: 1 as const,
      clientId: PROPOSAL_ID,
      results: [],
    }));
    const misbound = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/ops',
      headers: {
        ...authenticatedHeaders,
        'idempotency-key': 'request:018f1f5e:misbound-sync',
      },
      payload: {
        schemaVersion: 1,
        clientId: CLIENT_ID,
        operations: [syncOperation],
      },
    });
    expect(misbound.statusCode).toBe(502);
    expect(misbound.json()).toMatchObject({ code: 'service-contract-invalid' });

    services.sync.applyOperations = vi.fn(
      async () =>
        ({
          schemaVersion: 1,
          clientId: CLIENT_ID,
          results: [
            {
              operationId,
              status: 'conflict',
              code: 'material-conflict',
              disposition: 'terminal',
              currentRevision: 2,
              conflicts: Array.from({ length: 33 }, (_, index) => ({
                field: `field-${index}`,
                material: true,
              })),
              replayed: false,
            },
          ],
        }) as never,
    );
    const unboundedConflict = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/ops',
      headers: {
        ...authenticatedHeaders,
        'idempotency-key': 'request:018f1f5e:unbounded-sync-conflict',
      },
      payload: {
        schemaVersion: 1,
        clientId: CLIENT_ID,
        operations: [syncOperation],
      },
    });
    expect(unboundedConflict.statusCode).toBe(502);
    expect(unboundedConflict.json()).toMatchObject({
      code: 'service-contract-invalid',
    });

    services.sync.applyOperations = vi.fn(async () => {
      throw Object.assign(new Error('payload mismatch'), {
        code: 'sync-idempotency-conflict',
      });
    });
    const reusedRequestKey = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/ops',
      headers: {
        ...authenticatedHeaders,
        'idempotency-key': 'request:018f1f5e:reused-sync-request',
      },
      payload: {
        schemaVersion: 1,
        clientId: CLIENT_ID,
        operations: [syncOperation],
      },
    });
    expect(reusedRequestKey.statusCode).toBe(409);
    expect(reusedRequestKey.json()).toMatchObject({
      code: 'sync-idempotency-conflict',
    });
    await app.close();
  });

  it('bounds transient voice bytes, enforces the spend reservation, and returns no-store media', async () => {
    const services = buildServices();
    let retainedAudio: Uint8Array | undefined;
    services.voice.transcribe = vi.fn(async ({ audio }) => {
      retainedAudio = audio;
      return {
        status: 'completed' as const,
        transcript: 'buy milk',
        model: 'gpt-4o-mini-transcribe' as const,
        spendWarning: false,
      };
    });
    const app = await createApp({ services, limits: { maximumAudioBytes: 8 } });

    const unauthenticatedOversized = await app.inject({
      method: 'POST',
      url: '/api/v1/voice/transcribe',
      headers: {
        'idempotency-key': IDEMPOTENCY_KEY,
        'content-type': 'audio/webm',
      },
      payload: Buffer.alloc(9),
    });
    expect(unauthenticatedOversized.statusCode).toBe(401);

    const tooLarge = await app.inject({
      method: 'POST',
      url: '/api/v1/voice/transcribe',
      headers: {
        ...authenticatedHeaders,
        'idempotency-key': IDEMPOTENCY_KEY,
        'content-type': 'audio/webm',
      },
      payload: Buffer.alloc(9),
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(services.voice.transcribe).not.toHaveBeenCalled();

    const missingDuration = await app.inject({
      method: 'POST',
      url: '/api/v1/voice/transcribe',
      headers: {
        ...authenticatedHeaders,
        'idempotency-key': 'request:018f1f5e:missing-duration',
        'content-type': 'audio/webm',
      },
      payload: Buffer.from([9, 8, 7]),
    });
    expect(missingDuration.statusCode).toBe(400);

    const transcription = await app.inject({
      method: 'POST',
      url: '/api/v1/voice/transcribe?durationMs=1250&attempt=default',
      headers: {
        ...authenticatedHeaders,
        'idempotency-key': IDEMPOTENCY_KEY,
        'content-type': 'audio/webm',
      },
      payload: Buffer.from([9, 8, 7]),
    });
    expect(transcription.statusCode).toBe(200);
    expect(transcription.headers['cache-control']).toBe('no-store, private');
    expect(transcription.headers.pragma).toBe('no-cache');
    expect(transcription.headers.expires).toBe('0');
    expect(transcription.headers.etag).toBeUndefined();
    expect(transcription.json()).toMatchObject({
      transcript: 'buy milk',
      attempt: 'default',
      model: 'gpt-4o-mini-transcribe',
    });
    expect(services.voice.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({
        durationMs: 1250,
        attempt: 'default',
        model: 'gpt-4o-mini-transcribe',
      }),
    );
    expect(services.voice.inspectRecording).toHaveBeenCalledWith(
      expect.objectContaining({
        declaredContentType: 'audio/webm',
        durationHintMs: 1250,
      }),
    );
    expect(services.audioRequests.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: IDEMPOTENCY_KEY,
        requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    );
    expect(services.audioRequests.completeTranscription).toHaveBeenCalledWith(
      expect.objectContaining({
        claimId: 'audio-claim-018f1f5e',
        ownershipToken: 'audio-owner-token-018f1f5e',
        transcript: 'buy milk',
      }),
    );
    expect([...retainedAudio!]).toEqual([0, 0, 0]);

    services.voice.inspectRecording = vi.fn(async () => ({
      status: 'rejected' as const,
      code: 'audio-duration-invalid' as const,
    }));
    const rejectedDuration = await app.inject({
      method: 'POST',
      url: '/api/v1/voice/transcribe?durationMs=60000&attempt=default',
      headers: {
        ...authenticatedHeaders,
        'idempotency-key': 'request:018f1f5e:invalid-duration',
        'content-type': 'audio/webm',
      },
      payload: Buffer.from([7, 8, 9]),
    });
    expect(rejectedDuration.statusCode).toBe(400);
    expect(rejectedDuration.json()).toMatchObject({
      code: 'audio-duration-invalid',
    });
    expect(services.audioRequests.claim).toHaveBeenCalledTimes(1);

    const speech = await app.inject({
      method: 'POST',
      url: '/api/v1/voice/speak',
      headers: {
        ...authenticatedHeaders,
        'idempotency-key': 'request:018f1f5e:speak-audio',
      },
      payload: {
        schemaVersion: 1,
        voice: 'alloy',
        text: 'Here is your household summary.',
      },
    });
    expect(speech.statusCode).toBe(200);
    expect(speech.headers['content-type']).toContain('audio/mpeg');
    expect(speech.headers['cache-control']).toBe('no-store, private');
    expect(speech.headers.pragma).toBe('no-cache');
    expect(speech.headers.expires).toBe('0');
    expect(speech.headers['x-emdo-audio-model']).toBe('tts-1');
    expect(speech.rawPayload).toEqual(Buffer.from([1, 2, 3]));
    expect(services.voice.speak).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: 'audio-execution-018f1f5e',
        reservationId: 'audio-reservation-018f1f5e',
      }),
    );
    expect(services.audioRequests.completeSpeech).toHaveBeenCalledWith(
      expect.objectContaining({
        claimId: 'audio-claim-018f1f5e',
        ownershipToken: 'audio-owner-token-018f1f5e',
        model: 'tts-1',
      }),
    );

    const invalidRetiredModel = await app.inject({
      method: 'POST',
      url: '/api/v1/voice/speak',
      headers: {
        ...authenticatedHeaders,
        'idempotency-key': 'request:018f1f5e:retired-speech-model',
      },
      payload: {
        schemaVersion: 1,
        model: 'gpt-4o-tts',
        voice: 'alloy',
        text: 'This client must not select a provider model.',
      },
    });
    expect(invalidRetiredModel.statusCode).toBe(400);
    await app.close();
  });

  it('caps speech text at the provider-supported boundary before provider dispatch', async () => {
    const services = buildServices();
    const app = await createApp({ services });
    const textAtLimit = 'x'.repeat(4_096);

    expect(DEFAULT_API_LIMITS.maximumSpeechCharacters).toBe(4_096);

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v1/voice/speak',
      headers: {
        ...authenticatedHeaders,
        'idempotency-key': 'request:018f1f5e:speech-at-provider-limit',
      },
      payload: {
        schemaVersion: 1,
        voice: 'alloy',
        text: textAtLimit,
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(services.voice.speak).toHaveBeenCalledOnce();

    const rejected = await app.inject({
      method: 'POST',
      url: '/api/v1/voice/speak',
      headers: {
        ...authenticatedHeaders,
        'idempotency-key': 'request:018f1f5e:speech-over-provider-limit',
      },
      payload: {
        schemaVersion: 1,
        voice: 'alloy',
        text: `${textAtLimit}x`,
      },
    });
    expect(rejected.statusCode).toBe(400);
    expect(services.voice.getSpeechConfiguration).toHaveBeenCalledOnce();
    expect(services.voice.speak).toHaveBeenCalledOnce();

    await app.close();
  });

  it('surfaces the adapter-owned spend denial without a second spend lifecycle', async () => {
    const services = buildServices();
    services.voice.speak = vi.fn(async () => ({
      status: 'failed' as const,
      safeError: {
        code: 'ai-spend-limit-reached' as const,
        message: 'New model and audio runs are paused for the current month.',
        retryable: false,
      },
      reconciliationRequired: false,
    }));
    const app = await createApp({ services });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/voice/speak',
      headers: {
        ...authenticatedHeaders,
        'idempotency-key': IDEMPOTENCY_KEY,
      },
      payload: {
        schemaVersion: 1,
        voice: 'alloy',
        text: 'Summary',
      },
    });
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ code: 'ai-spend-limit-reached' });
    expect(services.voice.speak).toHaveBeenCalledOnce();
    expect(services.audioRequests.releaseKnownNoDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        claimId: 'audio-claim-018f1f5e',
        ownershipToken: 'audio-owner-token-018f1f5e',
        reasonCode: 'speech-provider-not-dispatched',
        principal: expect.objectContaining({ userId: USER_ID }),
        requestId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        ),
      }),
    );
    expect(services.audioRequests.markIndeterminate).not.toHaveBeenCalled();
    await app.close();
  });

  it('zeroizes generated speech even when durable receipt settlement fails', async () => {
    const services = buildServices();
    const providerAudio = Uint8Array.from([91, 92, 93, 94]);
    services.voice.speak = vi.fn(async () => ({
      status: 'completed' as const,
      audio: providerAudio,
      contentType: 'audio/mpeg' as const,
      model: 'tts-1' as const,
      spendWarning: false,
    }));
    services.audioRequests.completeSpeech = vi.fn(async () => {
      throw new Error('sensitive persistence diagnostic');
    });
    const app = await createApp({ services });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/voice/speak',
      headers: {
        ...authenticatedHeaders,
        'idempotency-key': 'request:018f1f5e:settlement-failure',
      },
      payload: {
        schemaVersion: 1,
        voice: 'alloy',
        text: 'Ephemeral household summary',
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('sensitive persistence diagnostic');
    expect([...providerAudio]).toEqual([0, 0, 0, 0]);
    expect(services.audioRequests.markIndeterminate).toHaveBeenCalledWith(
      expect.objectContaining({
        claimId: 'audio-claim-018f1f5e',
        ownershipToken: 'audio-owner-token-018f1f5e',
        reasonCode: 'speech-settlement-state-unknown',
        principal: expect.objectContaining({ userId: USER_ID }),
        requestId: expect.any(String),
      }),
    );

    await app.close();
  });

  it('rejects and wipes oversized generated speech before settling its receipt', async () => {
    const services = buildServices();
    const providerAudio = Uint8Array.from([1, 2, 3, 4, 5]);
    services.voice.speak = vi.fn(async () => ({
      status: 'completed' as const,
      audio: providerAudio,
      contentType: 'audio/mpeg' as const,
      model: 'tts-1' as const,
      spendWarning: false,
    }));
    const app = await createApp({
      services,
      limits: { maximumAudioBytes: 4 },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/voice/speak',
      headers: {
        ...authenticatedHeaders,
        'idempotency-key': 'request:018f1f5e:oversized-speech',
      },
      payload: {
        schemaVersion: 1,
        voice: 'alloy',
        text: 'Oversized response',
      },
    });

    expect(response.statusCode).toBe(502);
    expect([...providerAudio]).toEqual([0, 0, 0, 0, 0]);
    expect(services.audioRequests.completeSpeech).not.toHaveBeenCalled();
    expect(services.audioRequests.markIndeterminate).toHaveBeenCalledOnce();

    await app.close();
  });

  it('does not dispatch a concurrent audio idempotency loser and replays a settled result without a provider call', async () => {
    const services = buildServices();
    services.audioRequests.claim = vi.fn(async () => ({
      status: 'in-progress' as const,
      retryAfterMs: 1_000,
    }));
    const app = await createApp({ services });
    const inProgress = await app.inject({
      method: 'POST',
      url: '/api/v1/voice/speak',
      headers: {
        ...authenticatedHeaders,
        'idempotency-key': IDEMPOTENCY_KEY,
      },
      payload: {
        schemaVersion: 1,
        voice: 'alloy',
        text: 'Summary',
      },
    });
    expect(inProgress.statusCode).toBe(409);
    expect(inProgress.json()).toMatchObject({
      code: 'audio-request-in-progress',
    });
    expect(services.voice.speak).not.toHaveBeenCalled();
    expect(services.audioRequests.markIndeterminate).not.toHaveBeenCalled();
    await app.close();

    const indeterminateServices = buildServices();
    indeterminateServices.audioRequests.claim = vi.fn(async () => ({
      status: 'indeterminate' as const,
    }));
    const indeterminateApp = await createApp({
      services: indeterminateServices,
    });
    const indeterminate = await indeterminateApp.inject({
      method: 'POST',
      url: '/api/v1/voice/speak',
      headers: {
        ...authenticatedHeaders,
        'idempotency-key': 'request:018f1f5e:indeterminate-audio',
      },
      payload: {
        schemaVersion: 1,
        voice: 'alloy',
        text: 'Summary',
      },
    });
    expect(indeterminate.statusCode).toBe(409);
    expect(indeterminate.json()).toMatchObject({
      code: 'audio-request-indeterminate',
    });
    expect(indeterminateServices.voice.speak).not.toHaveBeenCalled();
    await indeterminateApp.close();

    const replayServices = buildServices();
    replayServices.audioRequests.claim = vi.fn(async () => ({
      status: 'replay' as const,
      result: {
        kind: 'transcription' as const,
        transcript: 'cached transcript',
        model: 'gpt-4o-mini-transcribe' as const,
        spendWarning: true,
      },
    }));
    const replayApp = await createApp({ services: replayServices });
    const replay = await replayApp.inject({
      method: 'POST',
      url: '/api/v1/voice/transcribe?durationMs=800&attempt=default',
      headers: {
        ...authenticatedHeaders,
        'idempotency-key': IDEMPOTENCY_KEY,
        'content-type': 'audio/webm',
      },
      payload: Buffer.from([1, 2, 3]),
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['x-emdo-idempotent-replay']).toBe('true');
    expect(replay.json()).toMatchObject({
      transcript: 'cached transcript',
      replayed: true,
    });
    expect(replayServices.voice.transcribe).not.toHaveBeenCalled();
    await replayApp.close();
  });

  it('keeps Calendar authorization server-configured and handles callback and disconnect through interfaces', async () => {
    const services = buildServices();
    const app = await createApp({ services });
    const authorize = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/google/authorize',
      headers: { ...authenticatedHeaders, 'idempotency-key': IDEMPOTENCY_KEY },
      payload: { schemaVersion: 1, purpose: 'calendar-event-write' },
    });
    expect(authorize.statusCode).toBe(200);
    expect(authorize.json()).toMatchObject({
      status: 'authorization-required',
    });
    expect(services.google.beginAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'calendar-event-write',
        principal,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    );
    expect(services.google.beginAuthorization).toHaveBeenCalledWith(
      expect.not.objectContaining({ scopes: expect.anything() }),
    );

    services.google.beginAuthorization = vi.fn(async () => ({
      status: 'already-authorized' as const,
      grantedPurposes: ['calendar-read' as const],
    }));
    const alreadyAuthorized = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/google/authorize',
      headers: {
        ...authenticatedHeaders,
        'idempotency-key': 'already-authorized-key',
      },
      payload: { schemaVersion: 1, purpose: 'calendar-read' },
    });
    expect(alreadyAuthorized.statusCode).toBe(200);
    expect(alreadyAuthorized.json()).toEqual({
      status: 'already-authorized',
      grantedPurposes: ['calendar-read'],
    });

    const unauthenticatedCallback = await app.inject({
      method: 'GET',
      url: '/api/v1/connectors/google/callback?code=opaque-code&state=opaque-state-value',
    });
    expect(unauthenticatedCallback.statusCode).toBe(401);

    const callback = await app.inject({
      method: 'GET',
      url: '/api/v1/connectors/google/callback?code=opaque-code&state=opaque-state-value',
      headers: { cookie: '__Secure-emdo.session_token=current' },
    });
    expect(callback.statusCode).toBe(200);
    expect(callback.json()).toEqual({
      status: 'connected',
      connectionId: 'google-calendar-connection',
      grantedPurposes: ['calendar-event-write'],
    });
    expect(services.google.completeAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'opaque-code',
        state: 'opaque-state-value',
      }),
    );

    const disconnect = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/google/disconnect',
      headers: { ...authenticatedHeaders, 'idempotency-key': IDEMPOTENCY_KEY },
      payload: { schemaVersion: 1 },
    });
    expect(disconnect.statusCode).toBe(200);
    expect(disconnect.json()).toEqual({
      status: 'disconnected',
      providerRevocation: 'confirmed',
    });
    expect(services.google.disconnect).toHaveBeenCalledWith(
      expect.objectContaining({ principal, idempotencyKey: IDEMPOTENCY_KEY }),
    );

    const clientScopes = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/google/authorize',
      headers: { ...authenticatedHeaders, 'idempotency-key': IDEMPOTENCY_KEY },
      payload: {
        schemaVersion: 1,
        purpose: 'calendar-read',
        scopes: ['https://www.googleapis.com/auth/drive'],
      },
    });
    expect(clientScopes.statusCode).toBe(400);

    const deadReturnPath = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/google/authorize',
      headers: { ...authenticatedHeaders, 'idempotency-key': IDEMPOTENCY_KEY },
      payload: {
        schemaVersion: 1,
        purpose: 'calendar-read',
        returnTo: '/settings',
      },
    });
    expect(deadReturnPath.statusCode).toBe(400);

    const callbackInjection = await app.inject({
      method: 'GET',
      url: '/api/v1/connectors/google/callback?code=super-secret-code&state=opaque-state-value&redirect_uri=https%3A%2F%2Fevil.example',
      headers: { cookie: '__Secure-emdo.session_token=current' },
    });
    expect(callbackInjection.statusCode).toBe(400);
    expect(callbackInjection.headers['cache-control']).toBe('no-store');
    expect(callbackInjection.body).not.toContain('super-secret-code');
    expect(callbackInjection.body).not.toContain('evil.example');
    await app.close();
  });

  it('returns readiness failures as no-store problem details', async () => {
    const services = buildServices();
    services.readiness.check = vi.fn(async () => ({
      ready: false,
      checks: readinessChecks('unavailable'),
    }));
    const app = await createApp({ services });
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      code: 'service-not-ready',
      extensions: {
        readinessSchemaVersion: API_READINESS_SCHEMA_VERSION,
        checks: readinessChecks('unavailable'),
      },
    });
    await app.close();
  });

  it('publishes a staging-only, non-release synthetic HTTP subset without weakening readyz', async () => {
    const services = buildServices();
    services.readiness.check = vi.fn(async () => ({
      ready: false,
      checks: syntheticHttpSubsetChecks,
    }));
    const productionApp = await createApp({ services });
    expect(
      (
        await productionApp.inject({
          method: 'GET',
          url: '/synthetic-staging/readyz',
        })
      ).statusCode,
    ).toBe(404);
    await productionApp.close();

    const stagingApp = await createApp({
      services,
      enableSyntheticHttpSubsetReadiness: true,
    } as Parameters<typeof createApp>[0]);
    const completeReadiness = await stagingApp.inject({
      method: 'GET',
      url: '/readyz',
    });
    expect(completeReadiness.statusCode).toBe(503);

    const subsetReadiness = await stagingApp.inject({
      method: 'GET',
      url: '/synthetic-staging/readyz',
    });
    expect(subsetReadiness.statusCode).toBe(200);
    expect(subsetReadiness.headers['cache-control']).toBe('no-store');
    expect(subsetReadiness.json()).toEqual({
      schemaVersion: 1,
      profile: 'synthetic-http-subset',
      status: 'ready',
      releaseEligible: false,
      checks: syntheticHttpSubsetChecks,
    });
    await stagingApp.close();
  });

  it('fails the synthetic staging subset for unavailable requirements or enabled exclusions', async () => {
    const services = buildServices();
    services.readiness.check = vi.fn(async () => ({
      ready: false,
      checks: {
        ...syntheticHttpSubsetChecks,
        sync: 'unavailable' as const,
        'sync.jwks': 'unavailable' as const,
      },
    }));
    const app = await createApp({
      services,
      enableSyntheticHttpSubsetReadiness: true,
    } as Parameters<typeof createApp>[0]);
    const response = await app.inject({
      method: 'GET',
      url: '/synthetic-staging/readyz',
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      code: 'synthetic-http-subset-not-ready',
    });

    services.readiness.check = vi.fn(async () => ({
      ready: false,
      checks: {
        ...syntheticHttpSubsetChecks,
        google: 'ok' as const,
        'google.connector': 'ok' as const,
      },
    }));
    const excludedResponse = await app.inject({
      method: 'GET',
      url: '/synthetic-staging/readyz',
    });
    expect(excludedResponse.statusCode).toBe(503);
    expect(excludedResponse.json()).toMatchObject({
      code: 'synthetic-http-subset-not-ready',
    });
    await app.close();
  });

  it('fails closed when an internal readiness result contradicts its components', async () => {
    const services = buildServices();
    services.readiness.check = vi.fn(async () => ({
      ready: true,
      checks: {
        ...readinessChecks('ok'),
        'experience.today-read': 'unavailable' as const,
      },
    }));
    const app = await createApp({ services });
    const response = await app.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(502);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      code: 'service-contract-invalid',
    });
    await app.close();
  });

  it('keeps metrics inaccessible to household sessions and serves only metrics credentials', async () => {
    const services = buildServices();
    const app = await createApp({ services });
    const denied = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { cookie: '__Secure-emdo.session_token=current' },
    });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers['content-type']).toContain(
      'application/problem+json',
    );

    const allowed = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer metrics' },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers['content-type']).toContain('text/plain');
    expect(allowed.body).toBe('emdo_http_requests_total 1\n');
    await app.close();
  });

  it('mounts invite-only browser authentication through the same session boundary', async () => {
    const services = buildServices();
    const app = await createApp({
      services,
      publicOrigin: 'https://emdo.example',
    });

    const session = await app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: { cookie: '__Secure-emdo.session_token=current' },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toEqual({
      session: {
        id: SESSION_ID,
        expiresAt: '2026-08-10T12:00:00.000Z',
      },
      user: {
        id: USER_ID,
        email: 'member@example.ca',
        emailVerified: true,
        name: 'Household Member',
      },
    });
    expect(session.body).not.toContain(RAW_SESSION_TOKEN_SENTINEL);
    expect(session.headers['x-auth-session-token']).toBeUndefined();
    expect(session.headers['set-cookie']).toEqual(
      expect.arrayContaining([
        expect.stringContaining('__Secure-emdo.session_token=rotated'),
        expect.stringContaining('__Secure-emdo.session_data=opaque'),
      ]),
    );

    const noOrigin = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { 'idempotency-key': 'request:018f1f5e:sign-in' },
      payload: { email: 'member@example.ca', password: 'secret-password' },
    });
    expect(noOrigin.statusCode).toBe(403);

    const signIn = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: {
        origin: 'https://emdo.example',
        'idempotency-key': 'request:018f1f5e:sign-in',
      },
      payload: { email: 'member@example.ca', password: 'secret-password' },
    });
    expect(signIn.statusCode).toBe(200);
    expect(services.auth.handleBrowserRequest).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: expect.any(String) }),
    );

    for (const path of [
      '/api/auth/sign-up/email',
      '/api/auth/organization/create',
      '/api/auth/organization/invite-member',
    ]) {
      const blocked = await app.inject({
        method: 'POST',
        url: path,
        headers: {
          origin: 'https://emdo.example',
          'idempotency-key': `request:018f1f5e:${path.split('/').at(-1)}`,
        },
        payload: {},
      });
      expect(blocked.statusCode).toBe(404);
      expect(blocked.json()).toMatchObject({ code: 'auth-route-unavailable' });
    }

    const calendarScopeInjection = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/social',
      headers: {
        origin: 'https://emdo.example',
        'idempotency-key': 'request:018f1f5e:identity-google',
      },
      payload: {
        provider: 'google',
        scopes: ['https://www.googleapis.com/auth/calendar.events'],
      },
    });
    expect(calendarScopeInjection.statusCode).toBe(400);

    const csrf = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/csrf',
      headers: { cookie: '__Secure-emdo.session_token=current' },
    });
    expect(csrf.statusCode).toBe(200);
    expect(csrf.json()).toEqual({
      schemaVersion: 1,
      token: 'authenticated-csrf-token-0123456789',
    });
    expect(csrf.headers['set-cookie']).toContain('emdo.csrf_token=');

    const onboardingCsrf = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/invitations/csrf',
    });
    expect(onboardingCsrf.statusCode).toBe(200);
    expect(onboardingCsrf.headers['set-cookie']).toContain(
      'emdo.invitation_csrf=',
    );

    const redemption = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/invitations/redeem',
      headers: {
        origin: 'https://emdo.example',
        cookie: 'emdo.invitation_csrf=invitation-csrf-token-0123456789',
        'x-csrf-token': 'invitation-csrf-token-0123456789',
        'idempotency-key': 'request:018f1f5e:redeem-invitation',
      },
      payload: {
        schemaVersion: 1,
        displayName: 'Household Member',
        email: 'member@example.ca',
        invitationId: PROPOSAL_ID,
        invitationToken: 'invite-token-01234567890123456789',
        password: 'correct horse battery staple',
      },
    });
    expect(redemption.statusCode).toBe(201);
    expect(redemption.json()).toMatchObject({
      userId: USER_ID,
      householdId: HOUSEHOLD_ID,
      emailVerified: true,
    });
    expect(services.auth.redeemInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'request:018f1f5e:redeem-invitation',
        invitationCsrfToken: 'invitation-csrf-token-0123456789',
        principal: undefined,
      }),
    );

    await app.close();
  });

  it('rejects bearer-only household authentication and accepts the session cookie', async () => {
    const services = buildServices();
    const app = await createApp({ services });

    const bearerOnly = await app.inject({
      method: 'GET',
      url: `/api/v1/runs/${RUN_ID}/events`,
      headers: { authorization: 'Bearer session' },
    });
    expect(bearerOnly.statusCode).toBe(401);

    const cookieSession = await app.inject({
      method: 'GET',
      url: `/api/v1/runs/${RUN_ID}/events`,
      headers: { cookie: '__Secure-emdo.session_token=current' },
    });
    expect(cookieSession.statusCode).toBe(200);

    await app.close();
  });

  it('rejects bodies and ambiguous callback fields before invoking Better Auth', async () => {
    const services = buildServices();
    const app = await createApp({
      services,
      publicOrigin: 'https://emdo.example',
    });

    const getWithBody = await app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: { 'content-type': 'application/json' },
      payload: { unexpected: true },
    });
    expect(getWithBody.statusCode).toBe(400);

    const signOutWithBodySignal = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: {
        ...authenticatedHeaders,
        'content-type': 'application/json',
        'idempotency-key': 'request:018f1f5e:sign-out-body-signal',
      },
    });
    expect(signOutWithBodySignal.statusCode).toBe(400);

    const ambiguousCallback = await app.inject({
      method: 'GET',
      url: '/api/auth/callback/google?code=provider-code&error=access_denied&state=signed-state',
    });
    expect(ambiguousCallback.statusCode).toBe(400);

    const inconsistentCallback = await app.inject({
      method: 'GET',
      url: '/api/auth/callback/google?code=provider-code&error_description=denied&state=signed-state',
    });
    expect(inconsistentCallback.statusCode).toBe(400);

    const emptyState = await app.inject({
      method: 'GET',
      url: '/api/auth/callback/google?code=provider-code&state=',
    });
    expect(emptyState.statusCode).toBe(400);
    expect(services.auth.handleBrowserRequest).not.toHaveBeenCalled();

    await app.close();
  });

  it('fails closed on a malformed socket address instead of forwarding it as client identity', async () => {
    const services = buildServices();
    const app = await createApp({
      services,
      publicOrigin: 'https://emdo.example',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      remoteAddress: 'not-an-ip-address',
    });
    expect(response.statusCode).toBe(503);
    expect(services.auth.handleBrowserRequest).not.toHaveBeenCalled();

    await app.close();
  });

  it('accepts only one Caddy-authenticated client address at the browser-auth boundary', async () => {
    const services = buildServices();
    const app = await createApp({
      services,
      publicOrigin: 'https://emdo.example',
      edgeProxySecret: EDGE_PROXY_SECRET,
    });

    for (const headers of [
      undefined,
      {
        'x-emdo-edge-proxy': 'wrong-edge-proxy-secret-0123456789-ABCDEFGHIJK',
        'x-forwarded-for': '198.51.100.9',
      },
      {
        'x-emdo-edge-proxy': EDGE_PROXY_SECRET,
        'x-forwarded-for': '198.51.100.9, 203.0.113.8',
      },
      {
        'x-emdo-edge-proxy': EDGE_PROXY_SECRET,
        'x-forwarded-for': 'not-an-ip-address',
      },
      {
        'x-emdo-edge-proxy': EDGE_PROXY_SECRET,
        'x-forwarded-for': 'fe80::1%eth0',
      },
      {
        forwarded: 'for=198.51.100.9',
        'x-emdo-edge-proxy': EDGE_PROXY_SECRET,
        'x-forwarded-for': '198.51.100.9',
      },
      {
        'x-emdo-edge-proxy': EDGE_PROXY_SECRET,
        'x-forwarded-for': '198.51.100.9',
        'x-real-ip': '198.51.100.9',
      },
    ]) {
      const denied = await app.inject({
        method: 'GET',
        url: '/api/auth/get-session',
        headers,
      });
      expect(denied.statusCode, JSON.stringify(headers)).toBe(503);
      expect(denied.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/u);
    }
    expect(services.auth.handleBrowserRequest).not.toHaveBeenCalled();

    const accepted = await app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: {
        'x-emdo-edge-proxy': EDGE_PROXY_SECRET,
        'x-forwarded-for': '2001:0db8:0000:0000:0000:0000:0000:0001',
      },
    });
    expect(accepted.statusCode).toBe(200);
    const forwardedRequest = vi.mocked(services.auth.handleBrowserRequest).mock
      .calls[0]?.[0].request;
    expect(forwardedRequest?.headers.get('x-forwarded-for')).toBe(
      '2001:db8::1',
    );
    expect(forwardedRequest?.headers.get('x-emdo-edge-proxy')).toBeNull();

    await app.close();
  });

  it('keeps unconfigured direct browser-auth ingress loopback-only', async () => {
    const services = buildServices();
    const app = await createApp({ services });

    const denied = await app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      remoteAddress: '198.51.100.9',
    });
    expect(denied.statusCode).toBe(503);
    expect(services.auth.handleBrowserRequest).not.toHaveBeenCalled();

    const alternateHouseholdIngress = await app.inject({
      method: 'GET',
      url: `/api/v1/runs/${RUN_ID}/events`,
      remoteAddress: '198.51.100.9',
      headers: { cookie: '__Secure-emdo.session_token=current' },
    });
    expect(alternateHouseholdIngress.statusCode).toBe(503);
    expect(services.auth.authenticate).not.toHaveBeenCalled();

    await app.close();
  });

  it('allows the explicit staging-only API network-namespace loopback path', async () => {
    const services = buildServices();
    const app = await createApp({
      services,
      edgeProxySecret: EDGE_PROXY_SECRET,
      allowLoopbackApiIngress: true,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
    });
    expect(response.statusCode).toBe(200);
    expect(
      vi
        .mocked(services.auth.handleBrowserRequest)
        .mock.calls[0]?.[0].request.headers.get('x-forwarded-for'),
    ).toBe('127.0.0.1');

    await app.close();
  });

  it('rejects upstream cookies that escape the host-only secure auth contract', async () => {
    for (const unsafeCookie of [
      '__Secure-emdo.session_token=unsafe; Domain=.emdo.example; Path=/; Secure; HttpOnly; SameSite=Lax',
      '__Secure-emdo.unrelated=unsafe; Path=/; Secure; HttpOnly; SameSite=Lax',
      '__Secure-emdo.session_token=unsafe; Path=/; HttpOnly; SameSite=Lax',
      '__Secure-emdo.session_token=unsafe; Path=/; Secure; SameSite=Lax',
      '__Secure-emdo.session_token=unsafe; Path=/; Secure; HttpOnly; SameSite=None',
      '__Secure-emdo.session_token=unsafe; Path=/api/auth; Secure; HttpOnly; SameSite=Lax',
    ]) {
      const services = buildServices();
      services.auth.handleBrowserRequest = vi.fn(async () => {
        const headers = new Headers({
          'content-type': 'application/json',
          'x-upstream-secret': RAW_SESSION_TOKEN_SENTINEL,
        });
        headers.append('set-cookie', unsafeCookie);
        return Response.json(
          {
            session: {
              id: SESSION_ID,
              expiresAt: '2026-08-10T12:00:00.000Z',
            },
            user: {
              id: USER_ID,
              email: 'member@example.ca',
              emailVerified: true,
            },
          },
          { headers },
        );
      });
      const app = await createApp({ services });

      const response = await app.inject({
        method: 'GET',
        url: '/api/auth/get-session',
      });
      expect(response.statusCode, unsafeCookie).toBe(502);
      expect(response.headers['set-cookie'], unsafeCookie).toBeUndefined();
      expect(response.headers['x-upstream-secret']).toBeUndefined();
      expect(response.body).not.toContain(RAW_SESSION_TOKEN_SENTINEL);

      await app.close();
    }
  });

  it('allows a bounded secure host-only Better Auth deletion cookie', async () => {
    const services = buildServices();
    const deletionCookie =
      '__Secure-emdo.session_token=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax';
    services.auth.handleBrowserRequest = vi.fn(async () => {
      const headers = new Headers({ 'content-type': 'application/json' });
      headers.append('set-cookie', deletionCookie);
      return Response.json({ success: true }, { headers });
    });
    const app = await createApp({
      services,
      publicOrigin: 'https://emdo.example',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: {
        ...authenticatedHeaders,
        'idempotency-key': 'request:018f1f5e:secure-sign-out',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toContain(deletionCookie);

    await app.close();
  });

  it('allowlists and sanitizes every browser auth response without exposing bearer-equivalent secrets', async () => {
    const services = buildServices();
    const app = await createApp({
      services,
      publicOrigin: 'https://emdo.example',
    });

    const passkeyAuthentication = {
      response: {
        id: 'credential-id',
        rawId: 'credential-id',
        type: 'public-key',
        authenticatorAttachment: 'platform',
        response: {
          authenticatorData: 'authenticator-data',
          clientDataJSON: 'client-data',
          signature: 'signature',
          userHandle: null,
        },
      },
    };
    const passkeyRegistration = {
      response: {
        id: 'credential-id',
        rawId: 'credential-id',
        type: 'public-key',
        authenticatorAttachment: 'platform',
        response: {
          attestationObject: 'attestation-object',
          clientDataJSON: 'client-data',
          transports: ['internal'],
        },
      },
      name: 'This device',
    };
    const browserRoutes = [
      {
        method: 'GET' as const,
        url: '/api/auth/get-session',
        headers: {
          authorization: 'Bearer must-not-cross-browser-auth-proxy',
          cookie: '__Secure-emdo.session_token=current',
          forwarded: 'for=198.51.100.9;proto=https',
          'x-forwarded-for': '198.51.100.9',
          'x-real-ip': '198.51.100.9',
        },
        expected: {
          session: {
            id: SESSION_ID,
            expiresAt: '2026-08-10T12:00:00.000Z',
          },
          user: {
            id: USER_ID,
            email: 'member@example.ca',
            emailVerified: true,
            name: 'Household Member',
          },
        },
      },
      {
        method: 'POST' as const,
        url: '/api/auth/sign-in/email',
        headers: {
          origin: 'https://emdo.example',
          'idempotency-key': 'request:018f1f5e:email-sign-in',
        },
        payload: {
          email: 'member@example.ca',
          password: 'secret-password',
          rememberMe: true,
        },
        expected: { status: 'authenticated' },
      },
      {
        method: 'POST' as const,
        url: '/api/auth/sign-in/social',
        headers: {
          origin: 'https://emdo.example',
          'idempotency-key': 'request:018f1f5e:google-sign-in',
        },
        payload: { provider: 'google', callbackURL: '/today' },
        expected: {
          redirect: true,
          url: 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque',
        },
      },
      {
        method: 'GET' as const,
        url: '/api/auth/passkey/generate-authenticate-options',
        expected: {
          challenge: 'authentication-challenge',
          timeout: 60_000,
          rpId: 'emdo.example',
          userVerification: 'preferred',
          allowCredentials: [],
        },
      },
      {
        method: 'POST' as const,
        url: '/api/auth/passkey/verify-authentication',
        headers: {
          origin: 'https://emdo.example',
          'idempotency-key': 'request:018f1f5e:passkey-sign-in',
        },
        payload: passkeyAuthentication,
        expected: { status: 'authenticated' },
      },
      {
        method: 'GET' as const,
        url: '/api/auth/passkey/generate-register-options?authenticatorAttachment=platform&name=This%20device',
        headers: { cookie: '__Secure-emdo.session_token=current' },
        expected: {
          challenge: 'registration-challenge',
          rp: { id: 'emdo.example', name: 'EMDO' },
          user: {
            id: 'dXNlci0x',
            name: 'member@example.ca',
            displayName: 'Household Member',
          },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          timeout: 60_000,
          excludeCredentials: [],
          authenticatorSelection: {
            authenticatorAttachment: 'platform',
            residentKey: 'preferred',
            userVerification: 'preferred',
          },
          attestation: 'none',
        },
      },
      {
        method: 'POST' as const,
        url: '/api/auth/passkey/verify-registration',
        headers: {
          ...authenticatedHeaders,
          'idempotency-key': 'request:018f1f5e:passkey-registration',
        },
        payload: passkeyRegistration,
        expected: { status: 'registered' },
      },
      {
        method: 'POST' as const,
        url: '/api/auth/sign-out',
        headers: {
          ...authenticatedHeaders,
          'idempotency-key': 'request:018f1f5e:sign-out',
        },
        expected: { success: true },
      },
    ];

    for (const route of browserRoutes) {
      const response = await app.inject(route);
      expect(response.statusCode, route.url).toBe(200);
      expect(response.json(), route.url).toEqual(route.expected);
      expect(response.body, route.url).not.toContain(
        RAW_SESSION_TOKEN_SENTINEL,
      );
      expect(
        response.headers['x-auth-session-token'],
        route.url,
      ).toBeUndefined();
      expect(response.headers['cache-control'], route.url).toBe('no-store');
    }

    const sessionHandlerCall = vi
      .mocked(services.auth.handleBrowserRequest)
      .mock.calls.find(
        ([input]) =>
          new URL(input.request.url).pathname === '/api/auth/get-session',
      );
    expect(sessionHandlerCall).toBeDefined();
    const trustedHeaders = sessionHandlerCall?.[0].request.headers;
    expect(trustedHeaders?.get('x-forwarded-for')).not.toBe('198.51.100.9');
    expect(trustedHeaders?.get('x-forwarded-for')).toMatch(/^[0-9a-f:.]+$/iu);
    expect(trustedHeaders?.get('forwarded')).toBeNull();
    expect(trustedHeaders?.get('x-real-ip')).toBeNull();
    expect(trustedHeaders?.get('authorization')).toBeNull();

    const callback = await app.inject({
      method: 'GET',
      url: '/api/auth/callback/google?code=provider-code&state=signed-state',
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('https://emdo.example/today');
    expect(callback.headers['x-auth-session-token']).toBeUndefined();
    expect(callback.body).toBe('');
    expect(callback.body).not.toContain(RAW_SESSION_TOKEN_SENTINEL);

    const callsBeforeDeniedRoutes = vi.mocked(
      services.auth.handleBrowserRequest,
    ).mock.calls.length;
    for (const request of [
      { method: 'GET' as const, url: '/api/auth/list-sessions' },
      { method: 'GET' as const, url: '/api/auth/future-plugin/unknown' },
      { method: 'POST' as const, url: '/api/auth/get-session' },
      { method: 'GET' as const, url: '/api/auth/sign-in/email' },
      { method: 'GET' as const, url: '/api/auth/get-session/' },
      { method: 'GET' as const, url: '/api/auth//get-session' },
      { method: 'GET' as const, url: '/api/auth/%2fget-session' },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'auth-route-unavailable' });
    }
    expect(services.auth.handleBrowserRequest).toHaveBeenCalledTimes(
      callsBeforeDeniedRoutes,
    );

    await app.close();
  });

  it('bounds Better Auth response bodies before parsing or discarding them', async () => {
    const services = buildServices();
    services.auth.handleBrowserRequest = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"session":"'));
          controller.enqueue(
            new TextEncoder().encode(RAW_SESSION_TOKEN_SENTINEL.repeat(32)),
          );
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { 'content-type': 'application/json' },
      });
    });
    const app = await createApp({
      services,
      publicOrigin: 'https://emdo.example',
      limits: { maximumJsonBodyBytes: 128 },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ code: 'service-contract-invalid' });
    expect(response.body).not.toContain(RAW_SESSION_TOKEN_SENTINEL);

    await app.close();
  });

  it('collapses invitation failures to bounded onboarding problems', async () => {
    const headers = {
      origin: 'https://emdo.example',
      cookie: 'emdo.invitation_csrf=invitation-csrf-token-0123456789',
      'x-csrf-token': 'invitation-csrf-token-0123456789',
      'idempotency-key': 'request:018f1f5e:redeem-invitation',
    };
    const payload = {
      schemaVersion: 1,
      displayName: 'Household Member',
      email: 'member@example.ca',
      invitationId: PROPOSAL_ID,
      invitationToken: 'invite-token-01234567890123456789',
      password: 'correct horse battery staple',
    };

    for (const [code, expectedStatus] of [
      ['invitation-invalid', 400],
      ['onboarding-unavailable', 503],
    ] as const) {
      const services = buildServices();
      services.auth.redeemInvitation = vi.fn(async () => {
        throw Object.assign(new Error('sensitive backend detail'), { code });
      });
      const app = await createApp({
        services,
        publicOrigin: 'https://emdo.example',
      });
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/invitations/redeem',
        headers,
        payload,
      });
      expect(response.statusCode, response.body).toBe(expectedStatus);
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(response.json()).toMatchObject({ code });
      expect(response.body).not.toContain('sensitive backend detail');
      await app.close();
    }
  });

  it('fails closed before listening when production composition is incomplete', () => {
    expect(() => assertCompleteApiServices(undefined)).toThrow(
      'api-composition-missing',
    );
    expect(() => assertCompleteApiServices({ auth: {} })).toThrow(
      'api-service-method-missing:auth.authenticate',
    );
    expect(() => assertCompleteApiServices(buildServices())).not.toThrow();
  });

  it('loads deployment host and port aliases and requires a complete production composition', async () => {
    expect(
      loadApiServerConfig({
        HOST: '0.0.0.0',
        PORT: '3100',
        EMDO_EDGE_PROXY_SECRET: EDGE_PROXY_SECRET,
        EMDO_PUBLIC_ORIGIN: 'https://emdo.example',
      }),
    ).toEqual({
      deploymentEnvironment: 'production',
      host: '0.0.0.0',
      port: 3100,
      allowLoopbackApiIngress: false,
      enableSyntheticHttpSubsetReadiness: false,
      edgeProxySecret: EDGE_PROXY_SECRET,
      publicOrigin: 'https://emdo.example',
    });
    expect(() =>
      loadApiServerConfig({
        HOST: '0.0.0.0',
        PORT: '3100',
        EMDO_PUBLIC_ORIGIN: 'https://emdo.example',
      }),
    ).toThrow();
    expect(
      loadApiServerConfig({
        EMDO_ENVIRONMENT: 'staging',
        EMDO_ALLOW_LOOPBACK_API_INGRESS: 'true',
        EMDO_SYNTHETIC_DATA_ONLY: 'true',
        EMDO_EDGE_PROXY_SECRET: EDGE_PROXY_SECRET,
        EMDO_PUBLIC_ORIGIN: 'https://staging.emdo.example',
      }),
    ).toMatchObject({
      allowLoopbackApiIngress: true,
      enableSyntheticHttpSubsetReadiness: true,
    });
    expect(
      loadApiServerConfig({
        EMDO_ENVIRONMENT: 'staging',
        EMDO_ALLOW_LOOPBACK_API_INGRESS: 'true',
        EMDO_EDGE_PROXY_SECRET: EDGE_PROXY_SECRET,
        EMDO_PUBLIC_ORIGIN: 'https://staging.emdo.example',
      }),
    ).toMatchObject({ enableSyntheticHttpSubsetReadiness: false });
    expect(() =>
      loadApiServerConfig({
        EMDO_ENVIRONMENT: 'production',
        EMDO_ALLOW_LOOPBACK_API_INGRESS: 'true',
        EMDO_EDGE_PROXY_SECRET: EDGE_PROXY_SECRET,
        EMDO_PUBLIC_ORIGIN: 'https://emdo.example',
      }),
    ).toThrow();
    expect(() =>
      loadApiServerConfig({
        HOST: '0.0.0.0',
        PORT: '3100',
        EMDO_EDGE_PROXY_SECRET: 'predictable',
        EMDO_PUBLIC_ORIGIN: 'https://emdo.example',
      }),
    ).toThrow();

    const callerSuppliedFactory = vi.fn(async () => buildServices());
    const builtInServices = await Reflect.apply(
      loadProductionApiServices,
      null,
      [{}, callerSuppliedFactory],
    );
    expect(() => assertCompleteApiServices(builtInServices)).not.toThrow();
    await expect(builtInServices.readiness.check()).resolves.toMatchObject({
      ready: false,
    });
    expect(callerSuppliedFactory).not.toHaveBeenCalled();
  });

  it('does not export a server starter that accepts caller-supplied services', async () => {
    const productionMain = await import('./main.js');

    expect(productionMain).not.toHaveProperty('startApiServer');
  });
});

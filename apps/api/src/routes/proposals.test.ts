import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { createOpenApiDocument } from '../openapi.js';
import { installProblemHandler } from '../problem.js';
import type {
  ApiServices,
  AuthenticatedPrincipal,
} from '../services/contracts.js';
import { registerProposalRoutes } from './proposals.js';

const USER_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f60';
const SESSION_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f61';
const HOUSEHOLD_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f62';
const SPACE_GRANT_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f63';
const PROPOSAL_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f67';
const PAYLOAD_HASH = 'a'.repeat(64);
const APPROVAL_HASH = 'b'.repeat(64);
const IDEMPOTENCY_KEY = 'visual-proof:018f1f5e:calendar-write';
const CURSOR = 'cursor_opaque_0123456789abcdefghijklmno';
const NEXT_CURSOR = 'cursor_next_0123456789abcdefghijklmnop';
const COLLECTION_SCOPE_FINGERPRINT =
  EffectiveAuthorizationScopeFingerprintSchema.parse('c'.repeat(64));

const principal: AuthenticatedPrincipal = {
  collectionAuthorizationScopeFingerprint: COLLECTION_SCOPE_FINGERPRINT,
  userId: USER_ID,
  sessionId: SESSION_ID,
  householdId: HOUSEHOLD_ID,
  role: 'owner',
  emailVerified: true,
  spaceAccessGrantId: SPACE_GRANT_ID,
};

const listItem = {
  id: PROPOSAL_ID,
  version: 3,
  state: 'pending' as const,
  kind: 'scheduler.calendar.create',
  title: 'Dentist appointment',
  summary: 'Create one event on Personal',
  createdAt: '2026-08-10T15:00:00.000Z',
  expiresAt: '2026-08-10T15:10:00.000Z',
};

const detail = {
  schemaVersion: 1 as const,
  ...listItem,
  payloadHash: PAYLOAD_HASH,
  approvalHash: APPROVAL_HASH,
  beforePreview: { summary: 'No event' },
  afterPreview: { summary: 'One new Calendar event' },
  fields: [
    { label: 'Calendar', value: 'Personal' },
    { label: 'Time', value: 'Tuesday, 2:30 PM–3:30 PM' },
    { label: 'Optional note', value: '' },
    { label: 'ملاحظة 🗓️', value: 'موعد طبيب 🦷' },
  ],
};

const buildServices = () => {
  const proposalQueries = {
    list: vi.fn(async () => ({
      status: 'ok' as const,
      page: {
        schemaVersion: 1 as const,
        items: [listItem],
        nextCursor: NEXT_CURSOR,
      },
    })),
    getDetail: vi.fn(async () => detail),
  };
  const visualProofs = {
    issue: vi.fn(async () => {
      const issuedAt = new Date();
      return {
        status: 'issued' as const,
        proof: {
          schemaVersion: 1 as const,
          proposalId: PROPOSAL_ID,
          proposalVersion: 3,
          payloadHash: PAYLOAD_HASH,
          approvalHash: APPROVAL_HASH,
          proofToken: 'visual_proof_opaque_0123456789abcdefghijklmno',
          issuedAt: issuedAt.toISOString(),
          expiresAt: new Date(issuedAt.getTime() + 60_000).toISOString(),
          replayed: false,
        },
      };
    }),
  };
  const services = {
    auth: {
      authenticate: vi.fn(async ({ cookie }: { readonly cookie?: string }) =>
        cookie === '__Secure-emdo.session_token=current'
          ? principal
          : undefined,
      ),
      verifyMutation: vi.fn(
        async ({
          csrfToken,
          origin,
        }: {
          readonly csrfToken?: string;
          readonly origin?: string;
        }) => csrfToken === 'csrf-token' && origin === 'https://emdo.example',
      ),
    },
    proposalQueries,
    visualProofs,
    proposals: {
      decideWithVisualProof: vi.fn(),
    },
  } as unknown as ApiServices;
  return { proposalQueries, services, visualProofs };
};

const createProposalApp = async (services: ApiServices) => {
  const app = Fastify({ logger: false });
  installProblemHandler(app);
  registerProposalRoutes(app, services, 4_096);
  await app.ready();
  return app;
};

const cookie = { cookie: '__Secure-emdo.session_token=current' };
const mutationHeaders = {
  ...cookie,
  origin: 'https://emdo.example',
  'x-csrf-token': 'csrf-token',
  'idempotency-key': IDEMPOTENCY_KEY,
};

describe('proposal query and visual-proof API', () => {
  it('lists only bounded projections for the authenticated principal', async () => {
    const { proposalQueries, services } = buildServices();
    const app = await createProposalApp(services);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/proposals?state=pending&cursor=${CURSOR}&limit=25`,
      headers: cookie,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      schemaVersion: 1,
      items: [listItem],
      nextCursor: NEXT_CURSOR,
    });
    expect(response.body).not.toContain(COLLECTION_SCOPE_FINGERPRINT);
    expect(proposalQueries.list).toHaveBeenCalledWith(
      expect.objectContaining({
        principal,
        state: 'pending',
        cursor: CURSOR,
        limit: 25,
        requestId: expect.any(String),
      }),
    );

    const polluted = await app.inject({
      method: 'GET',
      url: '/api/v1/proposals?state=pending&state=approved',
      headers: cookie,
    });
    expect(polluted.statusCode).toBe(400);
    expect(proposalQueries.list).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('fails closed when a query adapter returns provider-only or unbounded data', async () => {
    const { proposalQueries, services } = buildServices();
    proposalQueries.list.mockResolvedValueOnce({
      status: 'ok',
      page: {
        schemaVersion: 1,
        items: [
          {
            ...listItem,
            providerSdkCallId: 'provider-secret-sentinel',
          },
        ],
        nextCursor: NEXT_CURSOR,
      },
    } as never);
    const app = await createProposalApp(services);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/proposals',
      headers: cookie,
    });

    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain('provider-secret-sentinel');
    expect(response.json()).toMatchObject({ code: 'service-contract-invalid' });
    await app.close();
  });

  it.each([
    ['blank title', { ...listItem, title: '   ' }],
    ['C0 control', { ...listItem, summary: 'Review\nthis proposal' }],
    ['bidi override', { ...listItem, title: 'Review \u202Eapproved' }],
  ])(
    'rejects an approval-spoofing %s from the query adapter',
    async (_name, item) => {
      const { proposalQueries, services } = buildServices();
      proposalQueries.list.mockResolvedValueOnce({
        status: 'ok',
        page: { schemaVersion: 1, items: [item] },
      } as never);
      const app = await createProposalApp(services);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/proposals',
        headers: cookie,
      });

      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({
        code: 'service-contract-invalid',
      });
      expect(response.body).not.toContain(item.title);
      await app.close();
    },
  );

  it('rejects a filtered page containing a different proposal state', async () => {
    const { proposalQueries, services } = buildServices();
    proposalQueries.list.mockResolvedValueOnce({
      status: 'ok',
      page: {
        schemaVersion: 1,
        items: [{ ...listItem, state: 'approved' }],
      },
    } as never);
    const app = await createProposalApp(services);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/proposals?state=pending',
      headers: cookie,
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ code: 'service-contract-invalid' });
    await app.close();
  });

  it.each([
    ['tampered', 'cursor_tampered_0123456789abcdefghijk'],
    ['expired', 'cursor_expired_0123456789abcdefghijkl'],
    ['wrong-scope', 'cursor_wrong_scope_0123456789abcdef'],
  ])(
    'maps a %s cursor to the same safe public problem',
    async (_kind, cursor) => {
      const { proposalQueries, services } = buildServices();
      proposalQueries.list.mockResolvedValueOnce({
        status: 'invalid-cursor',
      } as never);
      const app = await createProposalApp(services);

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/proposals?cursor=${cursor}`,
        headers: cookie,
      });

      expect(response.statusCode).toBe(400);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toMatchObject({
        code: 'proposal-cursor-invalid',
      });
      expect(response.body).not.toMatch(/tampered|expired|scope/u);
      await app.close();
    },
  );

  it.each([
    ['empty', ''],
    ['control-character', '%00'],
    ['overlong', 'x'.repeat(513)],
    ['whitespace-padded', `%20${CURSOR}%20`],
    ['duplicated', `${CURSOR}&cursor=${NEXT_CURSOR}`],
  ])(
    'maps a syntactically %s cursor to the same problem before the gateway',
    async (_kind, cursor) => {
      const { proposalQueries, services } = buildServices();
      const app = await createProposalApp(services);

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/proposals?cursor=${cursor}`,
        headers: cookie,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: 'proposal-cursor-invalid',
      });
      expect(proposalQueries.list).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it('treats an invalid-cursor result without a supplied cursor as a bad service contract', async () => {
    const { proposalQueries, services } = buildServices();
    proposalQueries.list.mockResolvedValueOnce({
      status: 'invalid-cursor',
    } as never);
    const app = await createProposalApp(services);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/proposals',
      headers: cookie,
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ code: 'service-contract-invalid' });
    await app.close();
  });

  it('keeps proposal-query storage failures distinct from invalid cursors', async () => {
    const { proposalQueries, services } = buildServices();
    proposalQueries.list.mockRejectedValueOnce(new Error('storage-offline'));
    const app = await createProposalApp(services);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/proposals?cursor=${CURSOR}`,
      headers: cookie,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: 'internal-error' });
    expect(response.body).not.toContain('storage-offline');
    await app.close();
  });

  it('returns an exact approval view and hides existence outside the authorized query', async () => {
    const { proposalQueries, services } = buildServices();
    const app = await createProposalApp(services);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/proposals/${PROPOSAL_ID}`,
      headers: cookie,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(detail);
    expect(response.body).not.toMatch(
      /canonicalArguments|providerSdkCallId|disclosureGrant|providerPreconditions/u,
    );
    expect(proposalQueries.getDetail).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: PROPOSAL_ID, principal }),
    );

    const clientScope = await app.inject({
      method: 'GET',
      url: `/api/v1/proposals/${PROPOSAL_ID}?householdId=${HOUSEHOLD_ID}`,
      headers: cookie,
    });
    expect(clientScope.statusCode).toBe(400);
    expect(proposalQueries.getDetail).toHaveBeenCalledTimes(1);

    proposalQueries.getDetail.mockResolvedValueOnce(undefined as never);
    const missing = await app.inject({
      method: 'GET',
      url: `/api/v1/proposals/${PROPOSAL_ID}`,
      headers: cookie,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'proposal-not-found' });
    await app.close();
  });

  it('requires current CSRF/origin/idempotency proof before issuing a visual proof', async () => {
    const { services, visualProofs } = buildServices();
    const app = await createProposalApp(services);
    const body = {
      schemaVersion: 1,
      proposalVersion: 3,
      payloadHash: PAYLOAD_HASH,
      approvalHash: APPROVAL_HASH,
    };

    const missingCsrf = await app.inject({
      method: 'POST',
      url: `/api/v1/proposals/${PROPOSAL_ID}/visual-proof`,
      headers: {
        ...cookie,
        origin: 'https://emdo.example',
        'idempotency-key': IDEMPOTENCY_KEY,
      },
      payload: body,
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(visualProofs.issue).not.toHaveBeenCalled();

    const clientAuthority = await app.inject({
      method: 'POST',
      url: `/api/v1/proposals/${PROPOSAL_ID}/visual-proof`,
      headers: mutationHeaders,
      payload: { ...body, userId: USER_ID },
    });
    expect(clientAuthority.statusCode).toBe(400);
    expect(visualProofs.issue).not.toHaveBeenCalled();

    const clientScope = await app.inject({
      method: 'POST',
      url: `/api/v1/proposals/${PROPOSAL_ID}/visual-proof?spaceAccessGrantId=${SPACE_GRANT_ID}`,
      headers: mutationHeaders,
      payload: body,
    });
    expect(clientScope.statusCode).toBe(400);
    expect(visualProofs.issue).not.toHaveBeenCalled();

    const issued = await app.inject({
      method: 'POST',
      url: `/api/v1/proposals/${PROPOSAL_ID}/visual-proof`,
      headers: mutationHeaders,
      payload: body,
    });
    expect(issued.statusCode).toBe(200);
    expect(issued.headers['cache-control']).toBe('no-store');
    expect(issued.json()).toMatchObject({
      schemaVersion: 1,
      proposalId: PROPOSAL_ID,
      proposalVersion: 3,
      payloadHash: PAYLOAD_HASH,
      approvalHash: APPROVAL_HASH,
      proofToken: expect.any(String),
      replayed: false,
    });
    expect(visualProofs.issue).toHaveBeenCalledWith({
      proposalId: PROPOSAL_ID,
      expectedProposalVersion: 3,
      expectedPayloadHash: PAYLOAD_HASH,
      expectedApprovalHash: APPROVAL_HASH,
      principal,
      requestId: expect.any(String),
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    await app.close();
  });

  it('rejects stale bindings, reused keys, and invalid proof lifetimes without leaking authority data', async () => {
    const { services, visualProofs } = buildServices();
    const app = await createProposalApp(services);
    const request = {
      method: 'POST' as const,
      url: `/api/v1/proposals/${PROPOSAL_ID}/visual-proof`,
      headers: mutationHeaders,
      payload: {
        schemaVersion: 1,
        proposalVersion: 3,
        payloadHash: PAYLOAD_HASH,
        approvalHash: APPROVAL_HASH,
      },
    };

    visualProofs.issue.mockResolvedValueOnce({
      status: 'proposal-binding-mismatch',
    } as never);
    const stale = await app.inject(request);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'proposal-not-current' });

    visualProofs.issue.mockResolvedValueOnce({
      status: 'idempotency-conflict',
    } as never);
    const reused = await app.inject(request);
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({ code: 'idempotency-key-conflict' });

    const issuedAt = new Date();
    visualProofs.issue.mockResolvedValueOnce({
      status: 'issued',
      proof: {
        schemaVersion: 1,
        proposalId: PROPOSAL_ID,
        proposalVersion: 3,
        payloadHash: PAYLOAD_HASH,
        approvalHash: APPROVAL_HASH,
        proofToken: 'visual_proof_opaque_0123456789abcdefghijklmno',
        issuedAt: issuedAt.toISOString(),
        expiresAt: new Date(issuedAt.getTime() + 120_001).toISOString(),
        replayed: false,
      },
    } as never);
    const unsafeLifetime = await app.inject(request);
    expect(unsafeLifetime.statusCode).toBe(502);
    expect(unsafeLifetime.json()).toMatchObject({
      code: 'service-contract-invalid',
    });

    const futureIssuedAt = new Date(Date.now() + 20_000);
    visualProofs.issue.mockResolvedValueOnce({
      status: 'issued',
      proof: {
        schemaVersion: 1,
        proposalId: PROPOSAL_ID,
        proposalVersion: 3,
        payloadHash: PAYLOAD_HASH,
        approvalHash: APPROVAL_HASH,
        proofToken: 'visual_proof_opaque_0123456789abcdefghijklmno',
        issuedAt: futureIssuedAt.toISOString(),
        expiresAt: new Date(futureIssuedAt.getTime() + 120_000).toISOString(),
        replayed: false,
      },
    } as never);
    const unsafeAbsoluteExpiry = await app.inject(request);
    expect(unsafeAbsoluteExpiry.statusCode).toBe(502);
    expect(unsafeAbsoluteExpiry.json()).toMatchObject({
      code: 'service-contract-invalid',
    });
    await app.close();
  });

  it('rejects malformed visual bearer material before the decision gateway', async () => {
    const { services } = buildServices();
    const app = await createProposalApp(services);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/proposals/${PROPOSAL_ID}/decision`,
      headers: {
        ...mutationHeaders,
        'x-emdo-visual-confirmation': 'typed-approval!',
      },
      payload: {
        schemaVersion: 1,
        proposalId: PROPOSAL_ID,
        payloadHash: PAYLOAD_HASH,
        approvalHash: APPROVAL_HASH,
        decision: 'approved',
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'visual-approval-required' });
    expect(services.proposals.decideWithVisualProof).not.toHaveBeenCalled();
    await app.close();
  });

  it('authenticates a decision before parsing its body', async () => {
    const { services } = buildServices();
    const app = await createProposalApp(services);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/proposals/${PROPOSAL_ID}/decision`,
      headers: {
        'content-type': 'application/json',
        origin: 'https://emdo.example',
        'x-csrf-token': 'csrf-token',
        'idempotency-key': IDEMPOTENCY_KEY,
        'x-emdo-visual-confirmation':
          'visual_proof_opaque_0123456789abcdefghijklmno',
      },
      payload: { untrusted: 'x'.repeat(5_000) },
    });

    expect(response.statusCode).toBe(401);
    expect(services.proposals.decideWithVisualProof).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns a minimized decision receipt and maps durable proof denials', async () => {
    const { services } = buildServices();
    services.proposals.decideWithVisualProof = vi.fn(
      async ({ request, principal: actor }) => ({
        status: 'decided' as const,
        decision: {
          schemaVersion: 1 as const,
          id: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f68',
          proposalId: request.proposalId,
          userId: actor.userId,
          authenticatedSessionId: actor.sessionId,
          payloadHash: request.payloadHash,
          approvalHash: request.approvalHash,
          decision: request.decision,
          channel: 'authenticated-visual' as const,
          decidedAt: '2026-08-10T15:01:00.000Z',
          idempotencyKey: request.idempotencyKey,
        },
      }),
    );
    const app = await createProposalApp(services);
    const request = {
      method: 'POST' as const,
      url: `/api/v1/proposals/${PROPOSAL_ID}/decision`,
      headers: {
        ...mutationHeaders,
        'x-emdo-visual-confirmation':
          'visual_proof_opaque_0123456789abcdefghijklmno',
      },
      payload: {
        schemaVersion: 1,
        proposalId: PROPOSAL_ID,
        payloadHash: PAYLOAD_HASH,
        approvalHash: APPROVAL_HASH,
        decision: 'approved',
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    };

    const decided = await app.inject(request);
    expect(decided.statusCode).toBe(200);
    expect(decided.headers['cache-control']).toBe('no-store');
    expect(decided.json()).toEqual({
      schemaVersion: 1,
      id: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f68',
      proposalId: PROPOSAL_ID,
      payloadHash: PAYLOAD_HASH,
      approvalHash: APPROVAL_HASH,
      decision: 'approved',
      channel: 'authenticated-visual',
      decidedAt: '2026-08-10T15:01:00.000Z',
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    expect(decided.json()).not.toHaveProperty('userId');
    expect(decided.json()).not.toHaveProperty('authenticatedSessionId');

    services.proposals.decideWithVisualProof = vi.fn(async () => ({
      status: 'visual-proof-expired' as const,
    }));
    const expired = await app.inject(request);
    expect(expired.statusCode).toBe(409);
    expect(expired.json()).toMatchObject({ code: 'visual-proof-expired' });
    await app.close();
  });

  it('publishes cookie-authenticated query and proof contracts in OpenAPI', () => {
    const document = createOpenApiDocument() as {
      readonly paths: Record<string, Record<string, Record<string, unknown>>>;
    };

    expect(document.paths).toMatchObject({
      '/api/v1/proposals': { get: { operationId: 'listProposals' } },
      '/api/v1/proposals/{id}': { get: { operationId: 'getProposal' } },
      '/api/v1/proposals/{id}/visual-proof': {
        post: { operationId: 'issueProposalVisualProof' },
      },
    });
    const proof = document.paths['/api/v1/proposals/{id}/visual-proof']!.post!;
    expect(proof.security).toEqual([{ sessionAuth: [] }]);
    expect(proof.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Idempotency-Key', required: true }),
        expect.objectContaining({ name: 'Origin', required: true }),
        expect.objectContaining({ name: 'X-CSRF-Token', required: true }),
      ]),
    );
    expect(JSON.stringify(proof)).not.toMatch(
      /providerSdkCallId|disclosureGrant|canonicalArguments/u,
    );
    const decision = document.paths['/api/v1/proposals/{id}/decision']!.post!;
    expect(decision.responses).toMatchObject({
      '200': {
        content: {
          'application/json': {
            schema: expect.objectContaining({
              properties: expect.objectContaining({
                channel: { const: 'authenticated-visual', type: 'string' },
              }),
            }),
          },
        },
      },
      '404': expect.objectContaining({ description: expect.any(String) }),
    });
    expect(decision.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'X-EMDO-Visual-Confirmation',
          schema: expect.objectContaining({ minLength: 32 }),
        }),
      ]),
    );
  });
});

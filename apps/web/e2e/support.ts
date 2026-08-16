import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

type AxeViolation = Awaited<
  ReturnType<AxeBuilder['analyze']>
>['violations'][number];

export const authenticatedSession = {
  session: {
    id: '44444444-4444-4444-8444-444444444443',
    expiresAt: '2999-08-16T12:00:00.000Z',
  },
  user: {
    id: '44444444-4444-4444-8444-444444444444',
    email: 'member@example.ca',
    emailVerified: true,
    name: 'Member',
  },
};

const pendingProposal = Object.freeze({
  schemaVersion: 1 as const,
  id: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f67',
  version: 3,
  state: 'pending' as const,
  kind: 'scheduler.calendar.create',
  title: 'Dentist appointment',
  summary: 'Create one event on Personal',
  createdAt: '2026-08-10T11:55:00.000Z',
  expiresAt: '2999-08-10T12:10:00.000Z',
  payloadHash: 'a'.repeat(64),
  approvalHash: 'b'.repeat(64),
  beforePreview: Object.freeze({ summary: 'No event' }),
  afterPreview: Object.freeze({
    summary: '1 new Google Calendar event',
  }),
  fields: Object.freeze([
    Object.freeze({ label: 'Calendar', value: 'Personal' }),
    Object.freeze({ label: 'Date', value: 'Tuesday, August 11' }),
    Object.freeze({ label: 'Time', value: '2:30 PM–3:30 PM' }),
    Object.freeze({ label: 'Departure', value: 'Leave by 1:55 PM' }),
    Object.freeze({ label: 'Location', value: '225 King St W, Toronto' }),
  ]),
});

export interface ApprovalMockObservations {
  proofRequests: number;
  decisionRequests: number;
}

export async function mockPendingApprovalApi(
  page: Page,
): Promise<ApprovalMockObservations> {
  const observations: ApprovalMockObservations = {
    proofRequests: 0,
    decisionRequests: 0,
  };
  const proposalPath = `/api/v1/proposals/${pendingProposal.id}`;
  await page.route(
    /\/api\/v1\/proposals\?state=pending&limit=25$/u,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'cache-control': 'no-store, private' },
        body: JSON.stringify({
          schemaVersion: 1,
          items: [
            {
              id: pendingProposal.id,
              version: pendingProposal.version,
              state: pendingProposal.state,
              kind: pendingProposal.kind,
              title: pendingProposal.title,
              summary: pendingProposal.summary,
              createdAt: pendingProposal.createdAt,
              expiresAt: pendingProposal.expiresAt,
            },
          ],
        }),
      });
    },
  );
  await page.route(
    new RegExp(`${proposalPath.replaceAll('/', '\\/')}$`, 'u'),
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'cache-control': 'no-store, private' },
        body: JSON.stringify(pendingProposal),
      });
    },
  );
  await page.route(
    new RegExp(`${proposalPath.replaceAll('/', '\\/')}/visual-proof$`, 'u'),
    async (route) => {
      observations.proofRequests += 1;
      const request = route.request();
      expect(request.method()).toBe('POST');
      expect(request.headers()['x-csrf-token']).toBe(
        'e2e-csrf-token-01234567890123456789',
      );
      expect(request.headers()['idempotency-key']).toMatch(
        /^visual-proof:[0-9a-f-]{36}$/u,
      );
      expect(request.postDataJSON()).toEqual({
        schemaVersion: 1,
        proposalVersion: pendingProposal.version,
        payloadHash: pendingProposal.payloadHash,
        approvalHash: pendingProposal.approvalHash,
      });
      const issuedAt = new Date();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'cache-control': 'no-store, private' },
        body: JSON.stringify({
          schemaVersion: 1,
          proposalId: pendingProposal.id,
          proposalVersion: pendingProposal.version,
          payloadHash: pendingProposal.payloadHash,
          approvalHash: pendingProposal.approvalHash,
          proofToken: 'visual_proof_opaque_0123456789abcdefghijklmno',
          issuedAt: issuedAt.toISOString(),
          expiresAt: new Date(issuedAt.getTime() + 60_000).toISOString(),
          replayed: false,
        }),
      });
    },
  );
  await page.route(
    new RegExp(`${proposalPath.replaceAll('/', '\\/')}/decision$`, 'u'),
    async (route) => {
      observations.decisionRequests += 1;
      const request = route.request();
      const body = request.postDataJSON() as {
        readonly decision?: unknown;
        readonly idempotencyKey?: unknown;
      };
      expect(request.method()).toBe('POST');
      expect(request.headers()['x-csrf-token']).toBe(
        'e2e-csrf-token-01234567890123456789',
      );
      expect(request.headers()['x-emdo-visual-confirmation']).toBe(
        'visual_proof_opaque_0123456789abcdefghijklmno',
      );
      expect(request.headers()['idempotency-key']).toBe(body.idempotencyKey);
      expect(body).toMatchObject({
        schemaVersion: 1,
        proposalId: pendingProposal.id,
        payloadHash: pendingProposal.payloadHash,
        approvalHash: pendingProposal.approvalHash,
        decision: 'approved',
      });
      expect(body.idempotencyKey).toMatch(/^decision:[0-9a-f-]{36}$/u);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'cache-control': 'no-store, private' },
        body: JSON.stringify({
          schemaVersion: 1,
          id: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f68',
          proposalId: pendingProposal.id,
          payloadHash: pendingProposal.payloadHash,
          approvalHash: pendingProposal.approvalHash,
          decision: 'approved',
          channel: 'authenticated-visual',
          decidedAt: new Date().toISOString(),
          idempotencyKey: body.idempotencyKey,
        }),
      });
    },
  );
  return observations;
}

export const writablePrivateSpace = {
  id: '33333333-3333-4333-8333-333333333333',
  visibility: 'private' as const,
  originalOwnerUserId: '44444444-4444-4444-8444-444444444444',
};

export async function mockOfflineSyncBootstrap(page: Page): Promise<void> {
  await page.route('**/api/v1/sync/clients', async (route) => {
    const body = route.request().postDataJSON() as {
      readonly clientId?: unknown;
      readonly displayName?: unknown;
      readonly schemaVersion?: unknown;
    };
    expect(body).toMatchObject({
      schemaVersion: 1,
      displayName: 'EMDO web device',
    });
    expect(typeof body.clientId).toBe('string');
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        schemaVersion: 1,
        clientId: body.clientId,
        status: 'registered',
        replayed: false,
      }),
    });
  });
  await page.route('**/api/v1/sync/token?*', async (route) => {
    const clientId = new URL(route.request().url()).searchParams.get(
      'clientId',
    );
    expect(clientId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    const expiresAtSeconds = Math.floor(Date.now() / 1_000) + 5 * 60;
    const encodeJwtSegment = (value: unknown) =>
      btoa(JSON.stringify(value))
        .replace(/=/gu, '')
        .replace(/\+/gu, '-')
        .replace(/\//gu, '_');
    const token = [
      encodeJwtSegment({ alg: 'RS256', typ: 'JWT' }),
      encodeJwtSegment({
        aud: 'emdo-powersync',
        clientId,
        exp: expiresAtSeconds,
      }),
      'e2e-signature',
    ].join('.');
    const endpoint = `${new URL(route.request().url()).origin}/powersync`;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'cache-control': 'no-store, private' },
      body: JSON.stringify({
        schemaVersion: 1,
        endpoint,
        token,
        expiresAt: new Date(expiresAtSeconds * 1_000).toISOString(),
        writeScope: {
          clientId,
          spaces: [writablePrivateSpace],
        },
      }),
    });
  });
}

export async function mockAuthenticatedSession(page: Page): Promise<void> {
  await page.route('**/api/auth/get-session', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'cache-control': 'no-store, private' },
      body: JSON.stringify(authenticatedSession),
    });
  });
  await page.route('**/api/v1/auth/csrf', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'cache-control': 'no-store, private' },
      body: JSON.stringify({
        schemaVersion: 1,
        token: 'e2e-csrf-token-01234567890123456789',
      }),
    });
  });
  await mockOfflineSyncBootstrap(page);
  await mockPendingApprovalApi(page);
}

export async function expectNoSeriousAccessibilityViolations(
  page: Page,
): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const severe = result.violations.filter(
    ({ impact }: AxeViolation) => impact === 'critical' || impact === 'serious',
  );
  expect(severe).toEqual([]);
}

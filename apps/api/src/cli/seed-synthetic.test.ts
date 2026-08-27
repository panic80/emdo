import { describe, expect, it, vi } from 'vitest';

import { SyncOperationSchema } from '@emdo/contracts';
import { CanonicalSyncUploadValidator } from '@emdo/db/sync';
import { resolveDeterministicSyncOperation } from '@emdo/domains/conflicts';

import {
  formatSyntheticSeedFailure,
  runSyntheticSeedCommand,
} from './seed-synthetic.js';

const CLIENT_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f70';
const USER_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f71';
const SPACE_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f72';

const environment = () => ({
  EMDO_ENVIRONMENT: 'staging',
  EMDO_SYNTHETIC_DATA_ONLY: 'true',
  EMDO_EXTERNAL_PROVIDERS_ENABLED: 'false',
  EMDO_BOOTSTRAP_CONFIRM: 'bootstrap-initial-owner-v1',
  EMDO_BOOTSTRAP_DATABASE_URL:
    'postgresql://seed_bootstrap:secret@postgres/emdo_app',
  EMDO_BOOTSTRAP_HOUSEHOLD_NAME: 'Synthetic Household',
  EMDO_BOOTSTRAP_HOUSEHOLD_SLUG: 'synthetic-household',
  EMDO_SYNTHETIC_OWNER_EMAIL: 'synthetic-owner@emdo.invalid',
  EMDO_BOOTSTRAP_OWNER_NAME: 'Synthetic Owner',
  EMDO_SYNTHETIC_OWNER_PASSWORD: 'synthetic-password-0123456789',
  EMDO_STAGING_API_ORIGIN: 'http://127.0.0.1:3000',
  EMDO_PUBLIC_ORIGIN: 'https://staging.emdo.invalid',
  EMDO_SYNTHETIC_CLIENT_ID: CLIENT_ID,
});

const jwt = () => {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    sub: USER_ID,
    userId: USER_ID,
    spaces: [
      {
        id: SPACE_ID,
        visibility: 'private',
        originalOwnerUserId: USER_ID,
      },
    ],
  })}.signature`;
};

describe('synthetic staging seed CLI', () => {
  it('bootstraps through the guarded command and seeds only through authenticated API operations', async () => {
    const bootstrapOwner = vi.fn(async () => 0);
    const requests: Request[] = [];
    let uploadedBody: unknown;
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path === '/api/auth/sign-in/email') {
        return new Response('{"ok":true}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'set-cookie':
              '__Secure-emdo.session_token=synthetic-session; Path=/; Secure; HttpOnly',
          },
        });
      }
      if (path === '/api/v1/auth/csrf') {
        return new Response(
          JSON.stringify({
            schemaVersion: 1,
            token: 'csrf-token-01234567890123456789',
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'set-cookie':
                'emdo.csrf_token=csrf-token-01234567890123456789; Path=/api/; Secure; HttpOnly',
            },
          },
        );
      }
      if (path === '/api/v1/sync/token') {
        return Response.json({
          schemaVersion: 1,
          endpoint: 'https://staging.emdo.invalid/powersync',
          token: jwt(),
          expiresAt: '2026-08-09T12:05:00.000Z',
          writeScope: {
            clientId: CLIENT_ID,
            spaces: [
              {
                id: SPACE_ID,
                visibility: 'private',
                originalOwnerUserId: USER_ID,
              },
            ],
          },
        });
      }
      if (path === '/api/v1/sync/clients') {
        return Response.json(
          {
            schemaVersion: 1,
            clientId: CLIENT_ID,
            status: 'registered',
            replayed: false,
          },
          { status: 201 },
        );
      }
      if (path === '/api/v1/sync/ops') {
        const body = (await request.json()) as {
          operations: { operationId: string }[];
        };
        uploadedBody = body;
        return Response.json({
          schemaVersion: 1,
          clientId: CLIENT_ID,
          results: body.operations.map(({ operationId }) => ({
            operationId,
            status: 'applied',
            revision: 1,
            resolution: 'created',
            conflicts: [],
            replayed: false,
          })),
        });
      }
      return new Response(null, { status: 404 });
    });

    await expect(
      runSyntheticSeedCommand({
        argv: ['--fail-if-nonempty', '--staging-only'],
        environment: environment(),
        bootstrapOwner,
        fetch,
      }),
    ).resolves.toEqual({ status: 'seeded', operationCount: 3 });

    expect(bootstrapOwner).toHaveBeenCalledOnce();
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      '/api/auth/sign-in/email',
      '/api/v1/auth/csrf',
      '/api/v1/sync/clients',
      '/api/v1/sync/token',
      '/api/v1/sync/ops',
    ]);
    const upload = requests.at(-1)!;
    expect(upload.headers.get('origin')).toBe('https://staging.emdo.invalid');
    expect(upload.headers.get('x-csrf-token')).toBe(
      'csrf-token-01234567890123456789',
    );
    expect(uploadedBody).toMatchObject({
      schemaVersion: 1,
      clientId: CLIENT_ID,
      operations: [
        {
          entity: { type: 'scheduler.item' },
          mutation: {
            kind: 'create',
            payload: {
              value: expect.objectContaining({
                id: 'synthetic-scheduler-item-v1',
                completion: 'open',
              }),
            },
          },
        },
        {
          entity: { type: 'finance.budget' },
          mutation: {
            kind: 'create',
            payload: {
              value: expect.objectContaining({
                id: 'synthetic-finance-budget-v1',
                allocationsCadMinor: { groceries: 45_000 },
              }),
            },
          },
        },
        {
          entity: { type: 'shopping.item' },
          mutation: {
            kind: 'create',
            payload: {
              value: expect.objectContaining({
                name: 'Milk',
                unit: 'each',
                quantityMinorUnits: 1_000,
              }),
            },
          },
        },
      ],
    });
    const uploadedOperations = SyncOperationSchema.array().parse(
      (uploadedBody as { operations: unknown }).operations,
    );
    expect(uploadedOperations).toHaveLength(3);
    expect(upload.headers.get('idempotency-key')).toBe(
      'synthetic-domain-seed-v1',
    );
    expect(
      uploadedOperations.map(
        (seedOperation) =>
          resolveDeterministicSyncOperation({ operation: seedOperation })
            .status,
      ),
    ).toEqual(['applied', 'applied', 'applied']);
  });

  it('creates the Finance account internally before uploading the canonical three-operation batch', async () => {
    const bootstrapOwner = vi.fn(async () => 0);
    let uploadedBody: { operations: unknown[] } | undefined;
    let uploadRequest: Request | undefined;
    const requests: Request[] = [];
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path === '/api/auth/sign-in/email') {
        return new Response('{}', {
          status: 200,
          headers: {
            'set-cookie':
              '__Secure-emdo.session_token=synthetic-session; Path=/; Secure; HttpOnly',
          },
        });
      }
      if (path === '/api/v1/auth/csrf') {
        return Response.json({
          schemaVersion: 1,
          token: 'csrf-token-01234567890123456789',
        });
      }
      if (path === '/api/v1/sync/clients') {
        return Response.json({
          schemaVersion: 1,
          clientId: CLIENT_ID,
          status: 'registered',
          replayed: false,
        });
      }
      if (path === '/api/v1/sync/token') {
        return Response.json({
          schemaVersion: 1,
          endpoint: 'https://staging.emdo.invalid/powersync',
          token: jwt(),
          expiresAt: '2026-08-09T12:05:00.000Z',
          writeScope: {
            clientId: CLIENT_ID,
            spaces: [
              {
                id: SPACE_ID,
                visibility: 'private',
                originalOwnerUserId: USER_ID,
              },
            ],
          },
        });
      }
      if (path === '/api/internal/finance-synthetic/account') {
        expect(request.method).toBe('POST');
        expect(request.headers.get('cookie')).toContain(
          '__Secure-emdo.session_token=synthetic-session',
        );
        expect(request.headers.get('origin')).toBe(
          'https://staging.emdo.invalid',
        );
        expect(request.headers.get('x-csrf-token')).toBe(
          'csrf-token-01234567890123456789',
        );
        expect(request.headers.get('idempotency-key')).toBe(
          'synthetic-finance-account-seed-v1',
        );
        await expect(request.json()).resolves.toEqual({ schemaVersion: 1 });
        return Response.json({
          schemaVersion: 1,
          accountId: 'synthetic-finance-account-v1',
          status: 'applied',
        });
      }
      if (path === '/api/v1/sync/ops') {
        uploadRequest = request;
        uploadedBody = (await request.json()) as { operations: unknown[] };
        const validated = new CanonicalSyncUploadValidator({
          currentSchemaVersion: 1,
          clock: { now: () => new Date('2026-01-01T00:01:00.000Z') },
        }).validate(
          { operations: uploadedBody.operations },
          {
            authenticatedClientId: CLIENT_ID,
            authorizedSpaceIds: [SPACE_ID],
          },
        );
        const results = validated.operations.map((entry) => {
          const resolution = resolveDeterministicSyncOperation({
            operation: entry,
          });
          expect(resolution.status).toBe('applied');
          if (resolution.status !== 'applied') {
            throw new Error('expected deterministic sync operation to apply');
          }
          return {
            operationId: entry.operationId,
            status: 'applied' as const,
            revision: 1,
            resolution: resolution.resolution,
            conflicts: [],
            replayed: false,
          };
        });
        return Response.json({
          schemaVersion: 1,
          clientId: CLIENT_ID,
          results,
        });
      }
      return new Response(null, { status: 404 });
    });

    await expect(
      runSyntheticSeedCommand({
        argv: ['--fail-if-nonempty', '--staging-only'],
        environment: {
          ...environment(),
          EMDO_FINANCE_SYNTHETIC_STAGING: 'true',
        },
        bootstrapOwner,
        fetch,
      }),
    ).resolves.toEqual({ status: 'seeded', operationCount: 3 });

    expect(uploadRequest?.headers.get('idempotency-key')).toBe(
      'synthetic-domain-seed-v1',
    );
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      '/api/auth/sign-in/email',
      '/api/v1/auth/csrf',
      '/api/v1/sync/clients',
      '/api/v1/sync/token',
      '/api/internal/finance-synthetic/account',
      '/api/v1/sync/ops',
    ]);
    const uploadedOperations = SyncOperationSchema.array().parse(
      uploadedBody?.operations,
    );
    expect(uploadedOperations).toHaveLength(3);
    expect(
      uploadedOperations.map((seedOperation) => seedOperation.entity.type),
    ).toEqual(['scheduler.item', 'finance.budget', 'shopping.item']);
    expect(
      uploadedOperations.some(
        (seedOperation) => seedOperation.entity.type === 'finance.account',
      ),
    ).toBe(false);
  });

  it('sanitizes a failed internal Finance account response', async () => {
    const secret = 'private-finance-account-response';
    const fetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === '/api/auth/sign-in/email') {
        return new Response('{}', {
          status: 200,
          headers: {
            'set-cookie':
              '__Secure-emdo.session_token=synthetic-session; Path=/; Secure; HttpOnly',
          },
        });
      }
      if (path === '/api/v1/auth/csrf') {
        return Response.json({
          schemaVersion: 1,
          token: 'csrf-token-01234567890123456789',
        });
      }
      if (path === '/api/v1/sync/clients') {
        return Response.json({
          schemaVersion: 1,
          clientId: CLIENT_ID,
          status: 'registered',
          replayed: false,
        });
      }
      if (path === '/api/v1/sync/token') {
        return Response.json({
          schemaVersion: 1,
          endpoint: 'https://staging.emdo.invalid/powersync',
          token: jwt(),
          expiresAt: '2026-08-09T12:05:00.000Z',
          writeScope: {
            clientId: CLIENT_ID,
            spaces: [
              {
                id: SPACE_ID,
                visibility: 'private',
                originalOwnerUserId: USER_ID,
              },
            ],
          },
        });
      }
      if (path === '/api/internal/finance-synthetic/account') {
        return new Response(secret, { status: 500 });
      }
      return new Response(null, { status: 404 });
    });

    let caught: unknown;
    try {
      await runSyntheticSeedCommand({
        argv: ['--fail-if-nonempty', '--staging-only'],
        environment: {
          ...environment(),
          EMDO_FINANCE_SYNTHETIC_STAGING: 'true',
        },
        bootstrapOwner: vi.fn(async () => 0),
        fetch,
      });
    } catch (error) {
      caught = error;
    }

    expect(formatSyntheticSeedFailure(caught)).toBe(
      'Synthetic staging seed failed at stage=finance-account.\n',
    );
    expect(formatSyntheticSeedFailure(caught)).not.toContain(secret);
    expect(
      fetch.mock.calls.some(
        ([request]) =>
          new URL((request as Request).url).pathname === '/api/v1/sync/ops',
      ),
    ).toBe(false);
  });

  it('fails closed outside an isolated provider-disabled staging environment', async () => {
    const bootstrapOwner = vi.fn(async () => 0);
    const fetch = vi.fn();
    for (const invalid of [
      { ...environment(), EMDO_ENVIRONMENT: 'production' },
      { ...environment(), EMDO_EXTERNAL_PROVIDERS_ENABLED: 'true' },
      { ...environment(), EMDO_SYNTHETIC_DATA_ONLY: 'false' },
      { ...environment(), EMDO_FINANCE_SYNTHETIC_STAGING: 'enabled' },
    ]) {
      await expect(
        runSyntheticSeedCommand({
          argv: ['--fail-if-nonempty', '--staging-only'],
          environment: invalid,
          bootstrapOwner,
          fetch,
        }),
      ).rejects.toThrow('Synthetic staging seed failed at stage=configuration');
    }
    expect(bootstrapOwner).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports only closed stage names and never includes caught values', async () => {
    const secret =
      'postgresql://stage-user:stage-password@postgres/emdo?cookie=session-secret&token=csrf-secret';

    const bootstrapFailure = runSyntheticSeedCommand({
      argv: ['--fail-if-nonempty', '--staging-only'],
      environment: environment(),
      bootstrapOwner: vi.fn(async () => {
        throw new Error(secret);
      }),
      fetch: vi.fn(),
    });
    await expect(bootstrapFailure).rejects.toThrow(
      'Synthetic staging seed failed at stage=owner-bootstrap',
    );
    await bootstrapFailure.catch((error: unknown) => {
      expect(formatSyntheticSeedFailure(error)).toBe(
        'Synthetic staging seed failed at stage=owner-bootstrap.\n',
      );
      expect(formatSyntheticSeedFailure(error)).not.toContain(secret);
    });

    const signInFailure = runSyntheticSeedCommand({
      argv: ['--fail-if-nonempty', '--staging-only'],
      environment: environment(),
      bootstrapOwner: vi.fn(async () => 0),
      fetch: vi.fn(async () => {
        throw new Error(secret);
      }),
    });
    await expect(signInFailure).rejects.toThrow(
      'Synthetic staging seed failed at stage=sign-in',
    );
    await signInFailure.catch((error: unknown) => {
      expect(formatSyntheticSeedFailure(error)).toBe(
        'Synthetic staging seed failed at stage=sign-in.\n',
      );
      expect(formatSyntheticSeedFailure(error)).not.toContain(secret);
    });

    expect(formatSyntheticSeedFailure(new Error(secret))).toBe(
      'Synthetic staging seed failed at stage=unexpected.\n',
    );
  });

  it.each([
    [401, 'csrf-http-401'],
    [503, 'csrf-http-503'],
    [418, 'csrf-http-other'],
  ] as const)(
    'reports a bounded CSRF HTTP stage for status %i',
    async (status, stage) => {
      const responseBody = `private-response-body-${status}`;
      const fetch = vi.fn(async (request: Request) => {
        if (new URL(request.url).pathname === '/api/auth/sign-in/email') {
          return new Response('{}', {
            status: 200,
            headers: {
              'set-cookie':
                '__Secure-emdo.session_token=private-session; Path=/; Secure; HttpOnly',
            },
          });
        }
        if (new URL(request.url).pathname === '/api/auth/get-session') {
          return Response.json({ user: { id: USER_ID } });
        }
        return new Response(responseBody, { status });
      });
      let caught: unknown;
      try {
        await runSyntheticSeedCommand({
          argv: ['--fail-if-nonempty', '--staging-only'],
          environment: environment(),
          bootstrapOwner: vi.fn(async () => 0),
          fetch,
        });
      } catch (error) {
        caught = error;
      }
      expect(formatSyntheticSeedFailure(caught)).toBe(
        `Synthetic staging seed failed at stage=${stage}.\n`,
      );
      expect(formatSyntheticSeedFailure(caught)).not.toContain(responseBody);
    },
  );

  it('distinguishes an invalid successful CSRF response without logging it', async () => {
    const responseBody = 'private-malformed-csrf-response';
    const fetch = vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname === '/api/auth/sign-in/email') {
        return new Response('{}', {
          status: 200,
          headers: {
            'set-cookie':
              '__Secure-emdo.session_token=private-session; Path=/; Secure; HttpOnly',
          },
        });
      }
      if (new URL(request.url).pathname === '/api/auth/get-session') {
        return Response.json({ user: { id: USER_ID } });
      }
      return new Response(responseBody, { status: 200 });
    });
    let caught: unknown;
    try {
      await runSyntheticSeedCommand({
        argv: ['--fail-if-nonempty', '--staging-only'],
        environment: environment(),
        bootstrapOwner: vi.fn(async () => 0),
        fetch,
      });
    } catch (error) {
      caught = error;
    }
    expect(formatSyntheticSeedFailure(caught)).toBe(
      'Synthetic staging seed failed at stage=csrf-response.\n',
    );
    expect(formatSyntheticSeedFailure(caught)).not.toContain(responseBody);
  });
});

import { describe, expect, it, vi } from 'vitest';

import { SyncOperationSchema } from '@emdo/contracts';
import { resolveDeterministicSyncOperation } from '@emdo/domains/conflicts';

import { runSyntheticSeedCommand } from './seed-synthetic.js';

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
    expect(
      uploadedOperations.map(
        (seedOperation) =>
          resolveDeterministicSyncOperation({ operation: seedOperation })
            .status,
      ),
    ).toEqual(['applied', 'applied', 'applied']);
  });

  it('fails closed outside an isolated provider-disabled staging environment', async () => {
    const bootstrapOwner = vi.fn(async () => 0);
    const fetch = vi.fn();
    for (const invalid of [
      { ...environment(), EMDO_ENVIRONMENT: 'production' },
      { ...environment(), EMDO_EXTERNAL_PROVIDERS_ENABLED: 'true' },
      { ...environment(), EMDO_SYNTHETIC_DATA_ONLY: 'false' },
    ]) {
      await expect(
        runSyntheticSeedCommand({
          argv: ['--fail-if-nonempty', '--staging-only'],
          environment: invalid,
          bootstrapOwner,
          fetch,
        }),
      ).rejects.toThrow('Synthetic seed configuration is invalid');
    }
    expect(bootstrapOwner).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

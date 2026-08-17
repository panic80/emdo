import { generateKeyPairSync } from 'node:crypto';

import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import { createPostgresSyncGatewayRuntime } from './api-gateway.js';

const ids = {
  user: '80000000-0000-4000-8000-000000000001',
  session: '80000000-0000-4000-8000-000000000002',
  request: '80000000-0000-4000-8000-000000000003',
  household: '80000000-0000-4000-8000-000000000004',
  space: '80000000-0000-4000-8000-000000000005',
  grant: '80000000-0000-4000-8000-000000000006',
  client: '80000000-0000-4000-8000-000000000007',
  operation: '80000000-0000-4000-8000-000000000008',
} as const;

const principal = {
  userId: ids.user,
  sessionId: ids.session,
  householdId: ids.household,
  privateSpaceId: ids.space,
  role: 'owner' as const,
  emailVerified: true as const,
  spaceAccessGrantId: ids.grant,
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema.parse('a'.repeat(64)),
};

const now = new Date('2026-08-10T15:00:00.000Z');
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });

type ApiReceipt = {
  fingerprint: string;
  response: unknown | null;
};

const createPool = (
  options: { readonly ready?: boolean; readonly releaseError?: boolean } = {},
) => {
  let apiReceipt: ApiReceipt | undefined;
  let syncClientInsertCount = 0;
  let entityInsertCount = 0;
  const query = vi.fn(
    async (sql: string, parameters: readonly unknown[] = []) => {
      let rows: readonly Record<string, unknown>[] = [];
      if (sql.includes('pg_try_advisory_lock')) rows = [{ locked: true }];
      else if (sql.includes('pg_advisory_unlock')) rows = [{ unlocked: true }];
      else if (sql.includes('sync_gateway_ready')) {
        rows = [{ ready: options.ready ?? true }];
      } else if (sql.includes('lock_active_request_scope')) {
        rows = [{ authorized: true }];
      } else if (sql.includes('from emdo.sync_api_request_receipts')) {
        rows =
          apiReceipt === undefined
            ? []
            : [
                {
                  request_fingerprint: apiReceipt.fingerprint,
                  response: apiReceipt.response,
                },
              ];
      } else if (sql.includes('insert into emdo.sync_api_request_receipts')) {
        apiReceipt = {
          fingerprint: String(parameters[6]),
          response: null,
        };
        rows = [{ id: ids.request }];
      } else if (sql.includes('update emdo.sync_api_request_receipts')) {
        if (apiReceipt === undefined) throw new Error('missing API receipt');
        apiReceipt.response = parameters[7] as unknown;
        rows = [{ id: ids.request }];
      } else if (sql.includes('insert into emdo.sync_clients')) {
        syncClientInsertCount += 1;
        rows = [
          {
            id: ids.client,
            household_id: ids.household,
            user_id: ids.user,
            display_name: 'Mattermost MacBook',
          },
        ];
      } else if (sql.includes('resolve_sync_access')) {
        rows = [
          {
            user_id: ids.user,
            household_id: ids.household,
            role: 'owner',
            writable_spaces: [
              {
                id: ids.space,
                householdId: ids.household,
                visibility: 'private',
                originalOwnerUserId: ids.user,
              },
            ],
          },
        ];
      } else if (sql.includes('from emdo.sync_operation_receipts')) {
        rows = [];
      } else if (sql.includes('from emdo.sync_entities')) {
        rows = [];
      } else if (sql.includes('insert into emdo.sync_entities')) {
        entityInsertCount += 1;
        rows = [{ revision: 1 }];
      } else if (sql.includes('insert into emdo.sync_operation_receipts')) {
        rows = [{ operation_id: ids.operation }];
      }
      return { rowCount: rows.length, rows };
    },
  );
  const pool: DatabasePool = {
    connect: vi.fn(async () => {
      const client: DatabaseClient = {
        query,
        release: vi.fn(() => {
          if (options.releaseError === true) {
            throw new Error('connection release failed');
          }
        }),
      };
      return client;
    }),
  };
  return {
    pool,
    query,
    get apiReceiptResponse() {
      return apiReceipt?.response;
    },
    get syncClientInsertCount() {
      return syncClientInsertCount;
    },
    get entityInsertCount() {
      return entityInsertCount;
    },
  };
};

const createRuntime = (pool: DatabasePool) =>
  createPostgresSyncGatewayRuntime({
    pool,
    publicOrigin: 'https://emdo.example',
    powerSyncEndpoint: 'https://emdo.example/powersync',
    keyRing: {
      current: { kid: 'sync-key-v1', privateKey: keys.privateKey },
      previous: [],
    },
    clock: { now: () => now },
    tokenIdFactory: () => '80000000-0000-4000-8000-000000000009',
  });

describe('production Postgres sync gateway runtime', () => {
  it('durably binds registration idempotency and marks an exact replay', async () => {
    const fixture = createPool();
    const runtime = createRuntime(fixture.pool);
    const request = {
      clientId: ids.client,
      displayName: 'Mattermost MacBook',
      principal,
      requestId: ids.request,
      idempotencyKey: 'sync-register:80000000',
    };

    await expect(runtime.gateway.registerClient(request)).resolves.toEqual({
      schemaVersion: 1,
      clientId: ids.client,
      status: 'registered',
      replayed: false,
    });
    await expect(runtime.gateway.registerClient(request)).resolves.toEqual({
      schemaVersion: 1,
      clientId: ids.client,
      status: 'registered',
      replayed: true,
    });
    expect(fixture.syncClientInsertCount).toBe(1);
    const receiptInsert = fixture.query.mock.calls.find(([sql]) =>
      sql.includes('insert into emdo.sync_api_request_receipts'),
    );
    expect(receiptInsert?.[0]).toContain('pg_catalog.statement_timestamp()');
    expect(receiptInsert?.[0]).not.toContain('pg_catalog.clock_timestamp()');

    await expect(
      runtime.gateway.registerClient({
        ...request,
        displayName: 'Forged name',
      }),
    ).rejects.toMatchObject({ code: 'sync-idempotency-conflict' });
    expect(fixture.syncClientInsertCount).toBe(1);
  });

  it('maps processor outcomes, tokens, JWKS, and readiness without provider authority', async () => {
    const fixture = createPool();
    const runtime = createRuntime(fixture.pool);
    const operation = {
      schemaVersion: 1 as const,
      clientId: ids.client,
      operationId: ids.operation,
      entity: { type: 'shopping.item', id: 'milk' },
      mutation: {
        kind: 'create' as const,
        payload: {
          spaceId: ids.space,
          value: {
            name: 'Milk',
            unit: 'carton',
            quantityMinorUnits: 1_000,
          },
        },
      },
      baseRevision: 0,
      dependencies: [],
      actorIntent: 'Add milk to the private household list',
      createdAt: '2026-08-10T14:59:00.000Z',
    };

    await expect(
      runtime.gateway.applyOperations({
        clientId: ids.client,
        operations: [operation],
        principal,
        requestId: ids.request,
        idempotencyKey: 'sync-upload:8000000000',
      }),
    ).resolves.toEqual({
      schemaVersion: 1,
      clientId: ids.client,
      results: [
        {
          operationId: ids.operation,
          status: 'applied',
          revision: 1,
          resolution: 'created',
          conflicts: [],
          replayed: false,
        },
      ],
    });
    expect(fixture.entityInsertCount).toBe(1);

    const token = await runtime.gateway.issueToken({
      clientId: ids.client,
      principal,
      requestId: ids.request,
    });
    expect(token).toMatchObject({
      schemaVersion: 1,
      endpoint: 'https://emdo.example/powersync',
      writeScope: { clientId: ids.client, spaces: [{ id: ids.space }] },
    });
    expect(token.token.split('.')).toHaveLength(3);
    await expect(runtime.jwks.getPublicJwks()).resolves.toEqual({
      keys: [expect.objectContaining({ kid: 'sync-key-v1', kty: 'RSA' })],
    });
    await expect(runtime.checkReady()).resolves.toBe(true);
    const readinessSql = fixture.query.mock.calls.find(([sql]) =>
      sql.includes('sync_gateway_ready'),
    )?.[0];
    expect(readinessSql).toContain("session_user = 'emdo_api_login'");
    expect(readinessSql).toContain('current_user = session_user');
    expect(readinessSql).toContain('pg_has_role(');
    expect(readinessSql).toContain("session_user, 'emdo_app', 'USAGE'");
    expect(readinessSql).toContain('has_table_privilege');
    expect(readinessSql).toContain('has_column_privilege');
    expect(readinessSql).toContain('lock_active_request_scope(uuid,uuid,uuid)');
    expect(readinessSql).toContain('resolve_sync_access(uuid,uuid)');
    expect(readinessSql).toContain('capture_sync_entity_revision()');
    for (const relation of [
      'sync_clients',
      'sync_entities',
      'sync_entity_revisions',
      'sync_operation_receipts',
      'sync_api_request_receipts',
    ]) {
      expect(readinessSql).toContain(`emdo.${relation}`);
    }
    expect(JSON.stringify(await runtime.jwks.getPublicJwks())).not.toContain(
      'private',
    );
  });

  it('fails readiness when the exact API authority probe is false', async () => {
    const runtime = createRuntime(createPool({ ready: false }).pool);

    await expect(runtime.checkReady()).resolves.toBe(false);
  });

  it('fails readiness closed when the probe connection cannot be released', async () => {
    const runtime = createRuntime(createPool({ releaseError: true }).pool);

    await expect(runtime.checkReady()).resolves.toBe(false);
  });

  it('keeps a payload-bound retryable upload pending and re-evaluates an exact replay', async () => {
    const fixture = createPool();
    const runtime = createRuntime(fixture.pool);
    const missingDependency = '80000000-0000-4000-8000-000000000010';
    const request = {
      clientId: ids.client,
      operations: [
        {
          schemaVersion: 1 as const,
          clientId: ids.client,
          operationId: ids.operation,
          entity: { type: 'shopping.item', id: 'milk' },
          mutation: {
            kind: 'create' as const,
            payload: {
              spaceId: ids.space,
              value: {
                name: 'Milk',
                unit: 'carton',
                quantityMinorUnits: 1_000,
              },
            },
          },
          baseRevision: 0,
          dependencies: [missingDependency],
          actorIntent: 'Add milk after its missing prerequisite',
          createdAt: '2026-08-10T14:59:00.000Z',
        },
      ],
      principal,
      requestId: ids.request,
      idempotencyKey: 'sync-upload:retryable-8000',
    };

    const expected = {
      schemaVersion: 1,
      clientId: ids.client,
      results: [
        {
          operationId: ids.operation,
          status: 'blocked',
          code: 'dependency-missing',
          disposition: 'retryable',
          dependencyOperationId: missingDependency,
          conflicts: [],
          replayed: false,
        },
      ],
    };
    await expect(runtime.gateway.applyOperations(request)).resolves.toEqual(
      expected,
    );
    expect(fixture.apiReceiptResponse).toBeNull();

    await expect(runtime.gateway.applyOperations(request)).resolves.toEqual(
      expected,
    );
    expect(fixture.apiReceiptResponse).toBeNull();
    expect(fixture.entityInsertCount).toBe(0);
  });

  it('fails closed for a mismatched endpoint and an expiring previous key', () => {
    const fixture = createPool();
    expect(() =>
      createPostgresSyncGatewayRuntime({
        pool: fixture.pool,
        publicOrigin: 'https://emdo.example',
        powerSyncEndpoint: 'https://powersync.example/sync',
        keyRing: {
          current: { kid: 'sync-key-v1', privateKey: keys.privateKey },
          previous: [],
        },
        clock: { now: () => now },
      }),
    ).toThrow(expect.objectContaining({ code: 'sync-configuration-invalid' }));

    const previous = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() =>
      createPostgresSyncGatewayRuntime({
        pool: fixture.pool,
        publicOrigin: 'https://emdo.example',
        powerSyncEndpoint: 'https://emdo.example/powersync',
        keyRing: {
          current: { kid: 'sync-key-v1', privateKey: keys.privateKey },
          previous: [
            {
              kid: 'sync-key-old',
              publicKey: previous.publicKey,
              retiredAt: '2026-08-10T14:59:00.000Z',
              verifyUntil: '2026-08-10T15:01:00.000Z',
            },
          ],
        },
        clock: { now: () => now },
      }),
    ).toThrow(expect.objectContaining({ code: 'sync-configuration-invalid' }));
  });
});

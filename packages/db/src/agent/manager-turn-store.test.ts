import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import { PostgresManagerTurnStore } from './manager-turn-store.js';

const ids = Object.freeze({
  user: '018f1f5e-5000-7000-8000-000000000001',
  session: '018f1f5e-5000-7000-8000-000000000002',
  request: '018f1f5e-5000-7000-8000-000000000003',
  household: '018f1f5e-5000-7000-8000-000000000004',
  grant: '018f1f5e-5000-7000-8000-000000000005',
  run: '018f1f5e-5000-7000-8000-000000000006',
  conversation: '018f1f5e-5000-7000-8000-000000000007',
  claim: '018f1f5e-5000-7000-8000-000000000008',
});

const principal = Object.freeze({
  userId: ids.user,
  sessionId: ids.session,
  householdId: ids.household,
  role: 'owner' as const,
  emailVerified: true as const,
  spaceAccessGrantId: ids.grant,
  // This is deliberately different from the database result. It is an API
  // collection hint, never authority for the durable manager operation.
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema.parse('c'.repeat(64)),
});

const claimInput = Object.freeze({
  request: Object.freeze({
    schemaVersion: 1 as const,
    message: 'What is on my schedule?',
    routeHint: 'scheduler' as const,
    locale: 'en-CA' as const,
  }),
  principal,
  requestId: ids.request,
  idempotencyKey: 'manager-turn-idempotency-0001',
});

const claimedResult = Object.freeze({
  status: 'claimed' as const,
  claimId: ids.claim,
  runId: ids.run,
  conversationId: ids.conversation,
  rootManagerInvocationId: '018f1f5e-5000-7000-8000-000000000009',
  authorizationScopeFingerprint: 'a'.repeat(64),
  escalationTriggers: Object.freeze([]),
});

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const claimedResultFor = (values: readonly unknown[]) =>
  Object.freeze({
    ...claimedResult,
    claimId: values[4],
    runId: values[2],
    conversationId: values[3],
    rootManagerInvocationId: (values[7] as { rootManagerInvocationId: string })
      .rootManagerInvocationId,
  });

const failedTurn = Object.freeze({
  status: 'failed' as const,
  runId: ids.run,
  localTraceReference: 'local-trace-reference-0001',
  safeError: Object.freeze({
    code: 'agent-model-unavailable',
    message: 'The requested model is unavailable.',
    retryable: true,
  }),
  specialistOutcomes: Object.freeze([]),
  usage: Object.freeze({
    inputTokens: 0,
    outputTokens: 0,
    modelCostCadMinor: 0,
  }),
});

const clientFor = (
  respond: (
    sql: string,
    values: readonly unknown[],
  ) => readonly Record<string, unknown>[],
  commitError?: Error,
) => {
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    if (sql === 'commit' && commitError !== undefined) throw commitError;
    return { rowCount: 1, rows: respond(sql, values) };
  });
  const release = vi.fn();
  const client: DatabaseClient = { query, release };
  return { client, query, release };
};

const poolWith = (...clients: readonly DatabaseClient[]): DatabasePool => {
  let index = 0;
  return {
    connect: vi.fn(async () => {
      const client = clients[index++];
      if (client === undefined) throw new Error('unexpected database session');
      return client;
    }),
  };
};

describe('PostgresManagerTurnStore', () => {
  it('allows the explicit provider-free MVP runtime profile without identifying it as a model', async () => {
    const database = clientFor((sql, values) =>
      sql.includes('claim_manager_turn')
        ? [{ claim_result: claimedResultFor(values) }]
        : [],
    );
    const store = new PostgresManagerTurnStore(poolWith(database.client), {
      requestedModel: 'provider-free-mvp-v1',
    });

    await expect(store.claim(claimInput)).resolves.toMatchObject({
      status: 'claimed',
    });
    const aggregate = database.query.mock.calls.find(([sql]) =>
      sql.includes('claim_manager_turn'),
    );
    expect(aggregate?.[1]?.at(-1)).toBe('provider-free-mvp-v1');
  });

  it('claims through one aggregate without trusting a caller fingerprint', async () => {
    const database = clientFor((sql, values) =>
      sql.includes('claim_manager_turn')
        ? [{ claim_result: claimedResultFor(values) }]
        : [],
    );
    const store = new PostgresManagerTurnStore(poolWith(database.client));

    const result = await store.claim(claimInput);

    expect(result).toMatchObject({
      status: 'claimed',
      claimId: expect.stringMatching(uuidPattern),
      runId: expect.stringMatching(uuidPattern),
      conversationId: expect.stringMatching(uuidPattern),
      rootManagerInvocationId: expect.stringMatching(uuidPattern),
      authorizationScopeFingerprint:
        claimedResult.authorizationScopeFingerprint,
      escalationTriggers: [],
      ownershipToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    });
    const aggregate = database.query.mock.calls.find(([sql]) =>
      sql.includes('claim_manager_turn'),
    );
    expect(aggregate?.[1]).toHaveLength(13);
    expect(aggregate?.[1]).toEqual(
      expect.arrayContaining([
        ids.household,
        ids.grant,
        principal.role,
        claimInput.idempotencyKey,
        expect.objectContaining({
          ...claimInput.request,
          rootManagerInvocationId: expect.stringMatching(uuidPattern),
        }),
      ]),
    );
    expect(aggregate?.[1]).not.toContain(
      principal.collectionAuthorizationScopeFingerprint,
    );
    expect(
      database.query.mock.calls.some(([sql]) =>
        /(?:insert|update|delete)\s+(?:into\s+)?emdo\./iu.test(sql),
      ),
    ).toBe(false);
  });

  it('destroys an ambiguous commit session and resolves the exact claim on a fresh session', async () => {
    let committedClaim: Readonly<Record<string, unknown>> | undefined;
    const first = clientFor((sql, values) => {
      if (!sql.includes('claim_manager_turn')) return [];
      committedClaim = claimedResultFor(values);
      return [{ claim_result: committedClaim }];
    }, new Error('connection lost while committing'));
    const readback = clientFor((sql) =>
      sql.includes('read_manager_turn_operation')
        ? [{ readback_result: committedClaim }]
        : [],
    );
    const store = new PostgresManagerTurnStore(
      poolWith(first.client, readback.client),
    );

    await expect(store.claim(claimInput)).resolves.toMatchObject({
      status: 'claimed',
      runId: expect.stringMatching(uuidPattern),
      ownershipToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    });
    expect(first.release).toHaveBeenCalledWith(true);
    expect(readback.release).toHaveBeenCalledWith(false);
    expect(
      first.query.mock.calls.filter(([sql]) =>
        sql.includes('claim_manager_turn'),
      ),
    ).toHaveLength(1);
  });

  it('commits the exact result through one aggregate and never stages approval with raw DML', async () => {
    const database = clientFor((sql) =>
      sql.includes('complete_manager_turn')
        ? [
            {
              completion_result: {
                status: 'completed',
                terminalEventSequence: 4,
              },
            },
          ]
        : [],
    );
    const store = new PostgresManagerTurnStore(poolWith(database.client));

    await expect(
      store.complete({
        claimId: ids.claim,
        ownershipToken: 'manager-turn-owner-token-0001',
        runId: ids.run,
        result: failedTurn,
      }),
    ).resolves.toEqual({
      status: 'completed',
      terminalEventSequence: 4,
    });
    const aggregate = database.query.mock.calls.find(([sql]) =>
      sql.includes('complete_manager_turn'),
    );
    expect(aggregate?.[1]?.slice(2)).toEqual([
      ids.claim,
      expect.stringMatching(/^[a-f0-9]{64}$/u),
      ids.run,
      failedTurn,
    ]);
    expect(
      database.query.mock.calls.some(
        ([sql]) =>
          sql.includes('approval_resume_jobs') ||
          sql.includes('agent_run_events') ||
          sql.includes('approval_checkpoints'),
      ),
    ).toBe(false);
  });

  it('uses the purpose-specific readiness function', async () => {
    const database = clientFor((sql) =>
      sql.includes('manager_turn_store_ready') ? [{ ready: true }] : [],
    );
    const store = new PostgresManagerTurnStore(poolWith(database.client));

    await expect(store.check()).resolves.toBe(true);
    expect(database.query).toHaveBeenCalledWith(
      'select emdo.manager_turn_store_ready() as ready',
    );
  });
});

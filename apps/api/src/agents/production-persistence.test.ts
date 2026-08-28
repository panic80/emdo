import { describe, expect, it, vi } from 'vitest';

import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import type {
  EmdoDatabaseClient,
  PostgresProviderFreeShoppingService,
} from '@emdo/db/api';

import type {
  AuthenticatedPrincipal,
  VisualProposalDecisionGateway,
} from '../services/contracts.js';
import {
  createProductionAgentPersistence,
  createProviderFreeAgentPersistence,
} from './production-persistence.js';
import type { ProductionAgentRuntimeFactory } from './production-runtime.js';

const ids = Object.freeze({
  request: '42000000-0000-4000-8000-000000000001',
  decisionRequest: '42000000-0000-4000-8000-000000000002',
  conversation: '42000000-0000-4000-8000-000000000003',
  proposal: '42000000-0000-4000-8000-000000000004',
  user: '42000000-0000-4000-8000-000000000005',
  session: '42000000-0000-4000-8000-000000000006',
  household: '42000000-0000-4000-8000-000000000007',
  grant: '42000000-0000-4000-8000-000000000008',
  space: '42000000-0000-4000-8000-000000000009',
  event: '42000000-0000-4000-8000-000000000010',
});

const principal: AuthenticatedPrincipal = Object.freeze({
  userId: ids.user,
  sessionId: ids.session,
  householdId: ids.household,
  role: 'owner',
  emailVerified: true,
  spaceAccessGrantId: ids.grant,
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema.parse('d'.repeat(64)),
});

const poolFixture = () => {
  const query = vi.fn(
    async (sql: string, values: readonly unknown[] | undefined) => {
      let rows: readonly Record<string, unknown>[] = [];
      if (
        sql.includes('manager_turn_store_ready') ||
        sql.includes('run_event_source_ready') ||
        sql.includes('to_regprocedure')
      ) {
        rows = [{ ready: true }];
      } else if (sql.includes('claim_manager_turn')) {
        rows = [
          {
            claim_result: {
              status: 'claimed',
              claimId: values?.[4],
              runId: values?.[2],
              conversationId: values?.[3],
              authorizationScopeFingerprint: 'e'.repeat(64),
              escalationTriggers: [],
            },
          },
        ];
      } else if (sql.includes('complete_manager_turn')) {
        rows = [
          {
            completion_result: {
              status: 'completed',
              terminalEventSequence: 1,
            },
          },
        ];
      } else if (sql.includes('select household_id, space_id')) {
        rows = [
          {
            household_id: ids.household,
            space_id: ids.space,
            original_owner_user_id: ids.user,
          },
        ];
      } else if (sql.includes('lock_active_request_scope')) {
        rows = [{ authorized: true }];
      } else if (sql.includes('read_agent_run_events')) {
        rows = [
          {
            run_event_result: {
              schemaVersion: 1,
              events: [
                {
                  schemaVersion: 1,
                  runId: values?.[1],
                  sequence: 1,
                  type: 'run.failed',
                  data: { code: 'agent-model-unavailable' },
                  occurredAt: '2026-08-13T12:00:00.000Z',
                },
              ],
            },
          },
        ];
      } else if (sql.includes('from emdo.agent_run_events')) {
        rows = [
          {
            id: ids.event,
            run_id: values?.[0],
            sequence: '1',
            event_type: 'run.failed',
            payload: { code: 'agent-model-unavailable' },
            occurred_at: new Date('2026-08-13T12:00:00.000Z'),
          },
        ];
      }
      return { rowCount: rows.length, rows };
    },
  );
  const client = { query, release: vi.fn() };
  const pool = {
    connect: vi.fn(async () => client),
  } as unknown as EmdoDatabaseClient['scopedPool'];
  return { pool, query };
};

const collect = async <Value>(iterable: AsyncIterable<Value>) => {
  const values: Value[] = [];
  for await (const value of iterable) values.push(value);
  return values;
};

describe('production agent persistence bridge', () => {
  it('projects the authenticated principal into the strict provider-free shopping DB port', async () => {
    const { pool } = poolFixture();
    const create = vi.fn(
      async (
        input: Parameters<PostgresProviderFreeShoppingService['create']>[0],
      ) => {
        void input;
        return {
          status: 'applied' as const,
          item: {
            id: 'shopping-item-1',
            name: 'Milk',
            quantityMinorUnits: 2_000,
            unit: 'each',
            revision: 1,
            updatedAt: '2026-08-15T12:00:00.000Z',
          },
        };
      },
    );
    const shopping = {
      create,
      checkReady: vi.fn(async () => true),
    };
    const providerPrincipal: AuthenticatedPrincipal = Object.freeze({
      ...principal,
      privateSpaceId: ids.space,
    });
    const composition = createProviderFreeAgentPersistence({
      pool,
      shopping: shopping as never,
    });

    await composition.bindings.managerTurns.service.start({
      request: {
        schemaVersion: 1,
        locale: 'en-CA',
        message: 'add 2 each Milk to shopping list',
        routeHint: 'shopping',
      },
      principal: providerPrincipal,
      requestId: ids.request,
      idempotencyKey: 'provider-free-manager-turn-0001',
    });

    expect(shopping.create).toHaveBeenCalledOnce();
    expect(shopping.create).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: {
          userId: ids.user,
          sessionId: ids.session,
          householdId: ids.household,
          spaceAccessGrantId: ids.grant,
        },
        privateSpaceId: ids.space,
      }),
    );
    const firstShoppingInput = shopping.create.mock.calls[0]?.[0];
    expect(firstShoppingInput).toBeDefined();
    if (firstShoppingInput === undefined) {
      throw new Error('provider-free shopping call was not captured');
    }
    expect(firstShoppingInput.principal).not.toHaveProperty('role');
    await expect(composition.bindings.managerTurns.check()).resolves.toBe(true);
  });

  it('binds durable turns and finite event replay to the supplied request runtime', async () => {
    const { pool } = poolFixture();
    const runTurn = vi.fn(async (input: { readonly runId: string }) => ({
      status: 'failed' as const,
      runId: input.runId,
      localTraceReference: 'local-trace-reference',
      safeError: {
        code: 'agent-model-unavailable',
        message: 'The requested model is unavailable.',
        retryable: false,
      },
      specialistOutcomes: [],
      usage: { inputTokens: 0, outputTokens: 0, modelCostCadMinor: 0 },
    }));
    const create = vi.fn(async () => ({
      orchestrator: { runTurn, resumeTurn: vi.fn() },
    }));
    const runtimeFactory = {
      create,
      check: vi.fn(async () => true),
    } as unknown as ProductionAgentRuntimeFactory;
    const visualDecisions: VisualProposalDecisionGateway = {
      decideWithVisualProof: vi.fn(async () => ({
        status: 'proposal-not-found' as const,
      })),
    };
    const composition = createProductionAgentPersistence({
      pool,
      runtimeFactory,
      visualDecisions,
    });

    const accepted = await composition.bindings.managerTurns.service.start({
      request: {
        schemaVersion: 1,
        conversationId: ids.conversation,
        locale: 'en-CA',
        message: 'What is on my schedule?',
      },
      principal,
      requestId: ids.request,
      idempotencyKey: 'manager-turn-idempotency-0001',
    });

    expect(accepted).toMatchObject({
      schemaVersion: 1,
      status: 'accepted',
      replayed: false,
      eventsPath: `/api/v1/runs/${accepted.runId}/events`,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        principal,
        requestId: ids.request,
        runId: accepted.runId,
        conversationId: ids.conversation,
        authorizationScopeFingerprint: 'e'.repeat(64),
      }),
    );
    expect(runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: accepted.runId,
        authenticatedSessionId: ids.session,
        authorizationScopeFingerprint: 'e'.repeat(64),
      }),
    );

    const replay = await composition.bindings.runEvents.service.open({
      runId: accepted.runId,
      afterSequence: 0,
      principal,
      requestId: ids.request,
      abortSignal: new AbortController().signal,
    });
    await expect(collect(replay)).resolves.toEqual([
      {
        schemaVersion: 1,
        runId: accepted.runId,
        sequence: 1,
        type: 'run.failed',
        occurredAt: '2026-08-13T12:00:00.000Z',
        data: { code: 'agent-model-unavailable' },
      },
    ]);
    await expect(composition.bindings.managerTurns.check()).resolves.toBe(true);
    await expect(composition.bindings.runEvents.check()).resolves.toBe(true);
  });

  it('keeps ordinary EMDO turns available without a visual-decision provider', async () => {
    const { pool } = poolFixture();
    const runtimeFactory = {
      create: vi.fn(async () => ({
        orchestrator: { runTurn: vi.fn(), resumeTurn: vi.fn() },
      })),
      check: vi.fn(async () => true),
    } as unknown as ProductionAgentRuntimeFactory;

    const composition = createProductionAgentPersistence({
      pool,
      runtimeFactory,
    });

    expect(composition.bindings.managerTurns).toBeDefined();
    expect(composition.bindings.runEvents).toBeDefined();
    expect(composition.bindings.proposals).toBeUndefined();
    await expect(composition.bindings.managerTurns.check()).resolves.toBe(true);
  });

  it('routes visual decisions through the existing trusted decision gateway', async () => {
    const { pool } = poolFixture();
    const decideWithVisualProof = vi.fn(async () => ({
      status: 'proposal-not-found' as const,
    }));
    const composition = createProductionAgentPersistence({
      pool,
      runtimeFactory: {
        create: vi.fn(),
        check: vi.fn(async () => true),
      },
      visualDecisions: { decideWithVisualProof },
    });
    const request = {
      request: {
        schemaVersion: 1 as const,
        proposalId: ids.proposal,
        payloadHash: 'a'.repeat(64),
        approvalHash: 'b'.repeat(64),
        decision: 'approved' as const,
        idempotencyKey: 'proposal-decision-key-0001',
      },
      visualProofToken: 'trusted-visual-proof-token',
      principal,
      requestId: ids.decisionRequest,
    };

    await expect(
      composition.bindings.proposals!.service.decideWithVisualProof(request),
    ).resolves.toEqual({ status: 'proposal-not-found' });
    expect(decideWithVisualProof).toHaveBeenCalledOnce();
    expect(decideWithVisualProof).toHaveBeenCalledWith(request);
  });

  it('keeps manager and approval readiness false when the runtime is unavailable', async () => {
    const { pool } = poolFixture();
    const composition = createProductionAgentPersistence({
      pool,
      runtimeFactory: {
        create: vi.fn(),
        check: vi.fn(async () => false),
      },
      visualDecisions: {
        decideWithVisualProof: vi.fn(async () => ({
          status: 'proposal-not-found' as const,
        })),
      },
    });

    await expect(composition.bindings.managerTurns.check()).resolves.toBe(
      false,
    );
    await expect(composition.bindings.proposals!.check()).resolves.toBe(false);
    await expect(composition.bindings.runEvents.check()).resolves.toBe(true);
  });

  it('rejects executable dependency lookalikes before creating bindings', () => {
    const { pool } = poolFixture();

    expect(() =>
      createProductionAgentPersistence({
        pool,
        runtimeFactory: { create: vi.fn() } as never,
        visualDecisions: { decideWithVisualProof: vi.fn() },
      }),
    ).toThrow('api-production-agent-persistence-dependency-invalid');
  });
});

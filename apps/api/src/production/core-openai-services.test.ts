import { createHash } from 'node:crypto';

import type { OpenAiAgentsRunnerPort } from '@emdo/agent-core';
import { describe, expect, it, vi } from 'vitest';

import {
  createProductionOpenAiAgentServiceBundle,
  createRequestScopedModelSpendGuard,
  type ProductionOpenAiAgentProvider,
  type ProductionOpenAiAgentServiceDependencies,
  type ProductionModelSpendLedger,
} from './core-openai-services.js';

const ids = Object.freeze({
  user: '63000000-0000-4000-8000-000000000001',
  session: '63000000-0000-4000-8000-000000000002',
  request: '63000000-0000-4000-8000-000000000003',
  household: '63000000-0000-4000-8000-000000000004',
  run: '63000000-0000-4000-8000-000000000005',
});

const principal = Object.freeze({
  userId: ids.user,
  sessionId: ids.session,
  requestId: ids.request,
  householdId: ids.household,
});

const validEnvironment = Object.freeze({
  EMDO_OPENAI_AGENT_API_KEY: `sk-proj-${'a'.repeat(40)}`,
  EMDO_OPENAI_AGENT_PRICING_VERSION: 'openai-agents-2026-08-15',
  EMDO_OPENAI_AGENT_GPT_5_6_LUNA_INPUT_CAD_MINOR_PER_MILLION_TOKENS: '101',
  EMDO_OPENAI_AGENT_GPT_5_6_LUNA_OUTPUT_CAD_MINOR_PER_MILLION_TOKENS: '202',
  EMDO_OPENAI_AGENT_GPT_5_6_TERRA_INPUT_CAD_MINOR_PER_MILLION_TOKENS: '303',
  EMDO_OPENAI_AGENT_GPT_5_6_TERRA_OUTPUT_CAD_MINOR_PER_MILLION_TOKENS: '404',
});

const financeSyntheticEnvironment = Object.freeze({
  EMDO_ENVIRONMENT: 'staging',
  EMDO_ALLOW_LOOPBACK_API_INGRESS: 'true',
  EMDO_SYNTHETIC_DATA_ONLY: 'true',
  EMDO_FINANCE_SYNTHETIC_STAGING: 'true',
  EMDO_FINANCE_DOCUMENTS_ENABLED: 'true',
  EMDO_OPENAI_FINANCE_API_KEY: `sk-proj-${'f'.repeat(40)}`,
});

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const sha256Json = (value: Readonly<Record<string, string>>) =>
  createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');

const makeLedger = (): ProductionModelSpendLedger => ({
  reserve: vi.fn(async (request) => ({
    status: 'reserved' as const,
    warning: false,
    period: request.period,
    projectedCadMinor: request.estimatedCadMinor,
    reservationId: request.reservationId,
  })),
  markDispatched: vi.fn(async (request) => ({
    status: 'dispatched' as const,
    period: '2026-08',
    reservationId: request.reservationId,
  })),
  settle: vi.fn(async (request) => ({
    status: 'settled' as const,
    period: '2026-08',
    reservationId: request.reservationId,
    actualCadMinor: request.actualCadMinor,
    reservationExceeded: false,
  })),
  release: vi.fn(async (request) => ({
    status: 'released' as const,
    period: '2026-08',
    reservationId: request.reservationId,
  })),
});

const makeDependencies = (
  input: {
    readonly fetch?: ProductionOpenAiAgentServiceDependencies['fetch'];
    readonly runner?: OpenAiAgentsRunnerPort;
    readonly nowMs?: number;
  } = {},
) => {
  let nowMs = input.nowMs ?? Date.parse('2026-08-15T12:00:00.000Z');
  const provider: ProductionOpenAiAgentProvider = {
    close: vi.fn(async () => undefined),
    getModel: vi.fn(async () => {
      throw new Error('test-model-provider-must-not-run');
    }),
  };
  const runner: OpenAiAgentsRunnerPort = input.runner ?? {
    run: vi.fn(async () => ({ state: {} }) as never),
  };
  const dependencies: ProductionOpenAiAgentServiceDependencies = {
    fetch:
      input.fetch ??
      vi.fn(
        async () =>
          new Response(JSON.stringify({ id: 'gpt-5.6-luna' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    createProvider: vi.fn(() => provider),
    createRunner: vi.fn(() => runner),
    clock: () => nowMs,
    availabilityTimeoutMs: 250,
    availabilityTtlMs: 10_000,
  };
  return {
    dependencies,
    provider,
    runner,
    advanceClock: (milliseconds: number) => {
      nowMs += milliseconds;
    },
  };
};

describe('production OpenAI agent service bundle', () => {
  it('accepts Node process-environment descriptor shape while retaining exact agent keys', () => {
    const environment = Object.assign(
      Object.create(Object.create(Object.prototype)),
      validEnvironment,
    ) as Readonly<Record<string, string | undefined>>;
    const { dependencies } = makeDependencies();

    expect(
      createProductionOpenAiAgentServiceBundle({ environment }, dependencies),
    ).toBeDefined();
  });

  it('fails closed for absent, partial, malformed, or unknown agent configuration', () => {
    const { dependencies } = makeDependencies();
    for (const environment of [
      {},
      {
        EMDO_OPENAI_AGENT_API_KEY: validEnvironment.EMDO_OPENAI_AGENT_API_KEY,
      },
      {
        ...validEnvironment,
        EMDO_OPENAI_AGENT_GPT_5_6_LUNA_INPUT_CAD_MINOR_PER_MILLION_TOKENS: '0',
      },
      { ...validEnvironment, EMDO_OPENAI_AGENT_UNKNOWN: 'unexpected' },
    ]) {
      expect(
        createProductionOpenAiAgentServiceBundle({ environment }, dependencies),
      ).toBeUndefined();
    }
  });

  it('never uses a Finance embedding key to construct an agent provider or runner', () => {
    const { dependencies } = makeDependencies();
    expect(
      createProductionOpenAiAgentServiceBundle(
        { environment: financeSyntheticEnvironment },
        dependencies,
      ),
    ).toBeUndefined();
    expect(dependencies.createProvider).not.toHaveBeenCalled();
    expect(dependencies.createRunner).not.toHaveBeenCalled();
  });

  it('uses only the exact agent environment bundle when a Finance key is also present', async () => {
    const { dependencies } = makeDependencies();
    const bundle = createProductionOpenAiAgentServiceBundle(
      {
        environment: {
          ...validEnvironment,
          EMDO_OPENAI_FINANCE_API_KEY:
            financeSyntheticEnvironment.EMDO_OPENAI_FINANCE_API_KEY,
        },
      },
      dependencies,
    );

    expect(bundle).toBeDefined();
    expect(dependencies.createProvider).toHaveBeenCalledWith({
      apiKey: validEnvironment.EMDO_OPENAI_AGENT_API_KEY,
    });
    await bundle?.close();
  });

  it('constructs with an injected provider and runner without provider I/O', async () => {
    const { dependencies, provider } = makeDependencies();
    const bundle = createProductionOpenAiAgentServiceBundle(
      { environment: validEnvironment },
      dependencies,
    );

    expect(bundle).toBeDefined();
    expect(dependencies.fetch).not.toHaveBeenCalled();
    expect(dependencies.createProvider).toHaveBeenCalledWith({
      apiKey: validEnvironment.EMDO_OPENAI_AGENT_API_KEY,
    });
    expect(dependencies.createRunner).toHaveBeenCalledWith({
      modelProvider: provider,
      traceIncludeSensitiveData: false,
      tracingDisabled: true,
    });
    await bundle?.close();
    expect(provider.close).toHaveBeenCalledOnce();
  });

  it('checks only exact configured models with bounded, coalesced catalog access', async () => {
    const modelLookup = deferred<Response>();
    let modelLookupCalls = 0;
    const fetch = vi.fn(() => {
      modelLookupCalls += 1;
      return modelLookupCalls === 1
        ? modelLookup.promise
        : Promise.resolve(
            new Response(JSON.stringify({ id: 'gpt-5.6-luna' }), {
              status: 200,
            }),
          );
    });
    const { dependencies, advanceClock } = makeDependencies({ fetch });
    const bundle = createProductionOpenAiAgentServiceBundle(
      { environment: validEnvironment },
      dependencies,
    );
    if (bundle === undefined) throw new Error('test-bundle-unavailable');

    const first = bundle.modelAvailability.isAvailable('gpt-5.6-luna');
    const second = bundle.modelAvailability.isAvailable('gpt-5.6-luna');
    expect(first).toBe(second);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models/gpt-5.6-luna',
      expect.objectContaining({
        cache: 'no-store',
        method: 'GET',
        redirect: 'error',
      }),
    );
    modelLookup.resolve(
      new Response(JSON.stringify({ id: 'gpt-5.6-luna' }), { status: 200 }),
    );
    await expect(first).resolves.toBe(true);
    await expect(
      bundle.modelAvailability.isAvailable('gpt-5.6-luna'),
    ).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledOnce();

    advanceClock(10_001);
    await expect(
      bundle.modelAvailability.isAvailable('gpt-5.6-luna'),
    ).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(
      bundle.modelAvailability.isAvailable('gpt-5.6-unknown' as never),
    ).resolves.toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('fails closed for malformed catalog data and calculates conservative fixed-price token costs', async () => {
    const { dependencies } = makeDependencies({
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ id: 'wrong-model' }), { status: 200 }),
      ),
    });
    const bundle = createProductionOpenAiAgentServiceBundle(
      { environment: validEnvironment },
      dependencies,
    );
    if (bundle === undefined) throw new Error('test-bundle-unavailable');

    await expect(
      bundle.modelAvailability.isAvailable('gpt-5.6-terra'),
    ).resolves.toBe(false);
    expect(
      bundle.costCalculator.calculateCadMinor({
        model: 'gpt-5.6-luna',
        inputTokens: 1,
        outputTokens: 1,
      }),
    ).toBe(1);
    expect(
      bundle.costCalculator.calculateCadMinor({
        model: 'gpt-5.6-terra',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toBe(707);
    expect(() =>
      bundle.costCalculator.calculateCadMinor({
        model: 'gpt-5.6-luna',
        inputTokens: -1,
        outputTokens: 1,
      }),
    ).toThrow('api-openai-agent-cost-invalid');
  });

  it('rejects new runner operations and drains an active call before closing its provider', async () => {
    const activeResult =
      deferred<Awaited<ReturnType<OpenAiAgentsRunnerPort['run']>>>();
    const runner: OpenAiAgentsRunnerPort = {
      run: vi.fn(() => activeResult.promise),
    };
    const { dependencies, provider } = makeDependencies({ runner });
    const bundle = createProductionOpenAiAgentServiceBundle(
      { environment: validEnvironment },
      dependencies,
    );
    if (bundle === undefined) throw new Error('test-bundle-unavailable');

    const active = bundle.runner.run({} as never, 'request', {
      maxTurns: 1,
      signal: new AbortController().signal,
      toolNameCollisionPolicy: 'error',
    });
    const close = bundle.close();
    await expect(
      bundle.runner.run({} as never, 'next request', {
        maxTurns: 1,
        signal: new AbortController().signal,
        toolNameCollisionPolicy: 'error',
      }),
    ).rejects.toThrow('api-openai-agent-runner-closed');
    expect(provider.close).not.toHaveBeenCalled();

    activeResult.resolve({ state: {} } as never);
    await active;
    await close;
    expect(provider.close).toHaveBeenCalledOnce();
  });
});

describe('request-scoped model spend guard', () => {
  it('permits only the frozen run with a domain-separated model authorization', async () => {
    const ledger = makeLedger();
    const createSpendLedger = vi.fn(() => ledger);
    const guard = createRequestScopedModelSpendGuard(
      { pool: {} as never, principal, runId: ids.run },
      {
        createSpendLedger,
        clock: () => new Date('2026-08-15T12:00:00.000Z'),
      },
    );

    await expect(
      guard.reserve({
        executionId: ids.run,
        reservationId: 'model-reservation-000000000001',
        estimatedCadMinor: 7,
      }),
    ).resolves.toMatchObject({ status: 'reserved' });
    expect(createSpendLedger).toHaveBeenCalledWith({}, principal);
    const authorizationId = createHash('sha256')
      .update(
        JSON.stringify([
          'emdo.openai-agent-spend-authorization.v1',
          principal.householdId,
          principal.userId,
          principal.sessionId,
          principal.requestId,
          ids.run,
        ]),
        'utf8',
      )
      .digest('hex');
    expect(ledger.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationHash: sha256Json({
          authorizationId,
          category: 'model',
          executionId: ids.run,
          householdId: principal.householdId,
        }),
        category: 'model',
        executionId: ids.run,
        householdId: principal.householdId,
      }),
      { limitCadMinor: 7_500, warningCadMinor: 5_000 },
    );
    await expect(
      guard.reserve({
        executionId: 'model-other-execution-000001',
        reservationId: 'model-reservation-000000000002',
        estimatedCadMinor: 7,
      }),
    ).rejects.toThrow('spend-authorization-denied');
  });
});

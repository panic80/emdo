import { createHash } from 'node:crypto';

import {
  OpenAIProvider,
  Runner,
  RunState,
  type ModelProvider,
} from '@openai/agents';
import {
  EMDO_MODEL_IDS,
  SpendGuard,
  type EmdoModelId,
  type ModelAvailability,
  type OpenAiAgentCostCalculator,
  type OpenAiAgentsRunnerPort,
  type OpenAiSdkAgent,
  type AgentExecutionContext,
  type SpendAuthorizationResolver,
} from '@emdo/agent-core';
import {
  PostgresSpendLedger,
  type DurableRepositoryPrincipal,
  type EmdoDatabaseClient,
} from '@emdo/db/api';
import { UuidSchema, deepFreeze } from '@emdo/contracts';
import { z } from 'zod';

type DatabasePool = EmdoDatabaseClient['scopedPool'];

const AVAILABILITY_TIMEOUT_MS = 2_000;
const AVAILABILITY_TTL_MS = 15_000;
const MAX_MODEL_LOOKUP_BYTES = 16_384;
const TOKEN_RATE_DIVISOR = 1_000_000n;
const AgentEnvironmentPrefix = 'EMDO_OPENAI_AGENT_';

const AgentEnvironmentKeys = Object.freeze([
  'EMDO_OPENAI_AGENT_API_KEY',
  'EMDO_OPENAI_AGENT_PRICING_VERSION',
  'EMDO_OPENAI_AGENT_GPT_5_6_LUNA_INPUT_CAD_MINOR_PER_MILLION_TOKENS',
  'EMDO_OPENAI_AGENT_GPT_5_6_LUNA_OUTPUT_CAD_MINOR_PER_MILLION_TOKENS',
  'EMDO_OPENAI_AGENT_GPT_5_6_TERRA_INPUT_CAD_MINOR_PER_MILLION_TOKENS',
  'EMDO_OPENAI_AGENT_GPT_5_6_TERRA_OUTPUT_CAD_MINOR_PER_MILLION_TOKENS',
] as const);

const ApiKeySchema = z
  .string()
  .min(20)
  .max(512)
  .regex(/^sk-[A-Za-z0-9_-]+$/u);
const PricingVersionSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/u);
const EnvironmentSchema = z.strictObject({
  apiKey: ApiKeySchema,
  pricingVersion: PricingVersionSchema,
  lunaInputCadMinorPerMillionTokens: z.string(),
  lunaOutputCadMinorPerMillionTokens: z.string(),
  terraInputCadMinorPerMillionTokens: z.string(),
  terraOutputCadMinorPerMillionTokens: z.string(),
});
const DurablePrincipalSchema = z.strictObject({
  userId: UuidSchema,
  sessionId: UuidSchema,
  requestId: UuidSchema,
  householdId: UuidSchema,
});

type AgentEnvironment = Readonly<{
  apiKey: string;
  pricingVersion: string;
  rates: Readonly<
    Record<
      EmdoModelId,
      Readonly<{
        inputCadMinorPerMillionTokens: number;
        outputCadMinorPerMillionTokens: number;
      }>
    >
  >;
}>;

export type ProductionModelSpendLedger = Pick<
  PostgresSpendLedger,
  'reserve' | 'markDispatched' | 'settle' | 'release'
>;

export interface ProductionOpenAiAgentProvider extends ModelProvider {
  close(): Promise<void>;
}

export interface ProductionOpenAiAgentServiceDependencies {
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
  readonly createProvider: (input: {
    readonly apiKey: string;
  }) => ProductionOpenAiAgentProvider;
  readonly createRunner: (input: {
    readonly modelProvider: ProductionOpenAiAgentProvider;
    readonly tracingDisabled: true;
    readonly traceIncludeSensitiveData: false;
  }) => OpenAiAgentsRunnerPort;
  readonly clock: () => number;
  readonly availabilityTimeoutMs: number;
  readonly availabilityTtlMs: number;
}

export interface RequestScopedModelSpendGuardDependencies {
  readonly createSpendLedger: (
    pool: DatabasePool,
    principal: DurableRepositoryPrincipal,
  ) => ProductionModelSpendLedger;
  readonly clock: () => Date;
}

export interface ProductionOpenAiAgentServiceBundle {
  readonly modelAvailability: ModelAvailability;
  readonly costCalculator: OpenAiAgentCostCalculator;
  readonly runner: OpenAiAgentsRunnerPort;
  readonly close: () => Promise<void>;
}

const isEmdoModelId = (value: unknown): value is EmdoModelId =>
  typeof value === 'string' && EMDO_MODEL_IDS.includes(value as EmdoModelId);

const parsePositiveSafeInteger = (value: string): number | undefined => {
  if (!/^[1-9]\d{0,15}$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const readAgentEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): AgentEnvironment | undefined => {
  const prototype =
    environment !== null && typeof environment === 'object'
      ? Object.getPrototypeOf(environment)
      : undefined;
  if (
    environment === null ||
    typeof environment !== 'object' ||
    (prototype !== Object.prototype &&
      prototype !== null &&
      Object.getPrototypeOf(prototype) !== Object.prototype)
  ) {
    return undefined;
  }
  const descriptors = Object.getOwnPropertyDescriptors(environment);
  for (const key of Object.keys(descriptors)) {
    if (
      key.startsWith(AgentEnvironmentPrefix) &&
      !AgentEnvironmentKeys.includes(
        key as (typeof AgentEnvironmentKeys)[number],
      )
    ) {
      return undefined;
    }
  }
  const read = (key: (typeof AgentEnvironmentKeys)[number]): unknown => {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true
    ) {
      return undefined;
    }
    return descriptor.value;
  };
  const parsed = EnvironmentSchema.safeParse({
    apiKey: read('EMDO_OPENAI_AGENT_API_KEY'),
    pricingVersion: read('EMDO_OPENAI_AGENT_PRICING_VERSION'),
    lunaInputCadMinorPerMillionTokens: read(
      'EMDO_OPENAI_AGENT_GPT_5_6_LUNA_INPUT_CAD_MINOR_PER_MILLION_TOKENS',
    ),
    lunaOutputCadMinorPerMillionTokens: read(
      'EMDO_OPENAI_AGENT_GPT_5_6_LUNA_OUTPUT_CAD_MINOR_PER_MILLION_TOKENS',
    ),
    terraInputCadMinorPerMillionTokens: read(
      'EMDO_OPENAI_AGENT_GPT_5_6_TERRA_INPUT_CAD_MINOR_PER_MILLION_TOKENS',
    ),
    terraOutputCadMinorPerMillionTokens: read(
      'EMDO_OPENAI_AGENT_GPT_5_6_TERRA_OUTPUT_CAD_MINOR_PER_MILLION_TOKENS',
    ),
  });
  if (!parsed.success) return undefined;
  const lunaInputCadMinorPerMillionTokens = parsePositiveSafeInteger(
    parsed.data.lunaInputCadMinorPerMillionTokens,
  );
  const lunaOutputCadMinorPerMillionTokens = parsePositiveSafeInteger(
    parsed.data.lunaOutputCadMinorPerMillionTokens,
  );
  const terraInputCadMinorPerMillionTokens = parsePositiveSafeInteger(
    parsed.data.terraInputCadMinorPerMillionTokens,
  );
  const terraOutputCadMinorPerMillionTokens = parsePositiveSafeInteger(
    parsed.data.terraOutputCadMinorPerMillionTokens,
  );
  if (
    lunaInputCadMinorPerMillionTokens === undefined ||
    lunaOutputCadMinorPerMillionTokens === undefined ||
    terraInputCadMinorPerMillionTokens === undefined ||
    terraOutputCadMinorPerMillionTokens === undefined
  ) {
    return undefined;
  }
  return deepFreeze({
    apiKey: parsed.data.apiKey,
    pricingVersion: parsed.data.pricingVersion,
    rates: {
      'gpt-5.6-luna': {
        inputCadMinorPerMillionTokens: lunaInputCadMinorPerMillionTokens,
        outputCadMinorPerMillionTokens: lunaOutputCadMinorPerMillionTokens,
      },
      'gpt-5.6-terra': {
        inputCadMinorPerMillionTokens: terraInputCadMinorPerMillionTokens,
        outputCadMinorPerMillionTokens: terraOutputCadMinorPerMillionTokens,
      },
    },
  });
};

const defaultDependencies: ProductionOpenAiAgentServiceDependencies =
  Object.freeze({
    fetch: globalThis.fetch.bind(globalThis),
    createProvider: ({ apiKey }: { readonly apiKey: string }) =>
      new OpenAIProvider({ apiKey }),
    createRunner: ({
      modelProvider,
      tracingDisabled,
      traceIncludeSensitiveData,
    }: {
      readonly modelProvider: ProductionOpenAiAgentProvider;
      readonly tracingDisabled: true;
      readonly traceIncludeSensitiveData: false;
    }): OpenAiAgentsRunnerPort => {
      const runner = new Runner({
        modelProvider,
        tracingDisabled,
        traceIncludeSensitiveData,
      });
      const port: OpenAiAgentsRunnerPort = {
        run: (agent, input, options) =>
          runner.run(
            agent,
            input as string | RunState<AgentExecutionContext, OpenAiSdkAgent>,
            options,
          ) as unknown as ReturnType<OpenAiAgentsRunnerPort['run']>,
      };
      return Object.freeze(port);
    },
    clock: () => Date.now(),
    availabilityTimeoutMs: AVAILABILITY_TIMEOUT_MS,
    availabilityTtlMs: AVAILABILITY_TTL_MS,
  });

const validAvailabilityConfiguration = (
  dependencies: ProductionOpenAiAgentServiceDependencies,
): boolean =>
  Number.isSafeInteger(dependencies.availabilityTimeoutMs) &&
  dependencies.availabilityTimeoutMs >= 100 &&
  dependencies.availabilityTimeoutMs <= 10_000 &&
  Number.isSafeInteger(dependencies.availabilityTtlMs) &&
  dependencies.availabilityTtlMs >= 1 &&
  dependencies.availabilityTtlMs <= 60_000 &&
  typeof dependencies.fetch === 'function' &&
  typeof dependencies.createProvider === 'function' &&
  typeof dependencies.createRunner === 'function' &&
  typeof dependencies.clock === 'function';

const parseMatchedModelResponse = async (
  response: Response,
  model: EmdoModelId,
): Promise<boolean> => {
  if (!response.ok) return false;
  const contentLength = response.headers.get('content-length');
  if (
    contentLength !== null &&
    (!/^\d+$/u.test(contentLength) ||
      Number(contentLength) > MAX_MODEL_LOOKUP_BYTES)
  ) {
    return false;
  }
  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > MAX_MODEL_LOOKUP_BYTES) return false;
  const parsed = z.object({ id: z.string() }).safeParse(JSON.parse(body));
  return parsed.success && parsed.data.id === model;
};

const createModelAvailability = (input: {
  readonly getApiKey: () => string;
  readonly isClosing: () => boolean;
  readonly dependencies: ProductionOpenAiAgentServiceDependencies;
}): ModelAvailability => {
  const cached = new Map<
    EmdoModelId,
    Readonly<{ checkedAtMs: number; available: boolean }>
  >();
  const inFlight = new Map<EmdoModelId, Promise<boolean>>();

  const lookup = async (model: EmdoModelId): Promise<boolean> => {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve(false);
      }, input.dependencies.availabilityTimeoutMs);
      timeout.unref();
    });
    const request = (async (): Promise<boolean> => {
      try {
        const apiKey = input.getApiKey();
        const response = await input.dependencies.fetch(
          `https://api.openai.com/v1/models/${encodeURIComponent(model)}`,
          {
            method: 'GET',
            headers: Object.freeze({
              accept: 'application/json',
              authorization: `Bearer ${apiKey}`,
            }),
            cache: 'no-store',
            redirect: 'error',
            signal: controller.signal,
          },
        );
        return await parseMatchedModelResponse(response, model);
      } catch {
        return false;
      }
    })();
    try {
      return await Promise.race([request, deadline]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      controller.abort();
    }
  };

  return Object.freeze({
    isAvailable: (model: EmdoModelId): Promise<boolean> => {
      if (input.isClosing() || !isEmdoModelId(model)) {
        return Promise.resolve(false);
      }
      const nowMs = input.dependencies.clock();
      const previous = cached.get(model);
      if (
        previous !== undefined &&
        Number.isFinite(nowMs) &&
        nowMs >= previous.checkedAtMs &&
        nowMs - previous.checkedAtMs <= input.dependencies.availabilityTtlMs
      ) {
        return Promise.resolve(previous.available);
      }
      const pending = inFlight.get(model);
      if (pending !== undefined) return pending;
      const started = lookup(model)
        .then((available) => {
          const result = available === true && !input.isClosing();
          const checkedAtMs = input.dependencies.clock();
          if (Number.isFinite(checkedAtMs)) {
            cached.set(
              model,
              Object.freeze({ checkedAtMs, available: result }),
            );
          }
          return result;
        })
        .catch(() => false)
        .finally(() => {
          inFlight.delete(model);
        });
      inFlight.set(model, started);
      return started;
    },
  });
};

export class ProductionOpenAiAgentCostCalculator implements OpenAiAgentCostCalculator {
  constructor(private readonly rates: AgentEnvironment['rates']) {}

  calculateCadMinor(
    input: Readonly<{
      model: EmdoModelId;
      inputTokens: number;
      outputTokens: number;
    }>,
  ): number {
    if (
      !isEmdoModelId(input.model) ||
      !Number.isSafeInteger(input.inputTokens) ||
      !Number.isSafeInteger(input.outputTokens) ||
      input.inputTokens < 0 ||
      input.outputTokens < 0
    ) {
      throw new Error('api-openai-agent-cost-invalid');
    }
    const rates = this.rates[input.model];
    const total =
      BigInt(input.inputTokens) * BigInt(rates.inputCadMinorPerMillionTokens) +
      BigInt(input.outputTokens) * BigInt(rates.outputCadMinorPerMillionTokens);
    const rounded = (total + TOKEN_RATE_DIVISOR - 1n) / TOKEN_RATE_DIVISOR;
    if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('api-openai-agent-cost-invalid');
    }
    return Number(rounded);
  }
}

/**
 * Creates only production-ready OpenAI agent primitives. Catalog availability
 * is intentionally separate from any API readiness claim or model execution.
 */
export const createProductionOpenAiAgentServiceBundle = (
  input: Readonly<{
    environment: Readonly<Record<string, string | undefined>>;
  }>,
  dependencies: ProductionOpenAiAgentServiceDependencies = defaultDependencies,
): ProductionOpenAiAgentServiceBundle | undefined => {
  const environment = readAgentEnvironment(input.environment);
  if (
    environment === undefined ||
    !validAvailabilityConfiguration(dependencies)
  ) {
    return undefined;
  }

  let apiKeyBytes: Buffer | undefined;
  let provider: ProductionOpenAiAgentProvider | undefined;
  let runner: OpenAiAgentsRunnerPort | undefined;
  try {
    apiKeyBytes = Buffer.from(environment.apiKey, 'utf8');
    provider = dependencies.createProvider({
      apiKey: apiKeyBytes.toString('utf8'),
    });
    runner = dependencies.createRunner({
      modelProvider: provider,
      tracingDisabled: true,
      traceIncludeSensitiveData: false,
    });
  } catch {
    apiKeyBytes?.fill(0);
    void provider?.close().catch(() => undefined);
    return undefined;
  }

  let closing = false;
  let activeRunnerCalls = 0;
  let resolveDrain: (() => void) | undefined;
  let closePromise: Promise<void> | undefined;
  const isClosing = () => closing || apiKeyBytes === undefined;
  const getApiKey = () => {
    if (isClosing()) throw new Error('api-openai-agent-runner-closed');
    const bytes = apiKeyBytes;
    if (bytes === undefined) throw new Error('api-openai-agent-runner-closed');
    return bytes.toString('utf8');
  };
  const releaseRunnerCall = () => {
    activeRunnerCalls -= 1;
    if (closing && activeRunnerCalls === 0) {
      const resolve = resolveDrain;
      resolveDrain = undefined;
      resolve?.();
    }
  };
  const wrappedRunnerPort: OpenAiAgentsRunnerPort = {
    run: (agent, request, options) => {
      if (isClosing()) {
        return Promise.reject(new Error('api-openai-agent-runner-closed'));
      }
      activeRunnerCalls += 1;
      return Promise.resolve()
        .then(() => runner?.run(agent, request, options))
        .finally(releaseRunnerCall) as ReturnType<
        OpenAiAgentsRunnerPort['run']
      >;
    },
  };
  const wrappedRunner = Object.freeze(wrappedRunnerPort);
  const modelAvailability = createModelAvailability({
    getApiKey,
    isClosing,
    dependencies,
  });
  const costCalculator = new ProductionOpenAiAgentCostCalculator(
    environment.rates,
  );
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      closing = true;
      if (activeRunnerCalls > 0) {
        await new Promise<void>((resolve) => {
          resolveDrain = resolve;
        });
      }
      try {
        await provider?.close();
      } finally {
        apiKeyBytes?.fill(0);
        apiKeyBytes = undefined;
        provider = undefined;
        runner = undefined;
      }
    })();
    return closePromise;
  };

  return Object.freeze({
    modelAvailability,
    costCalculator,
    runner: wrappedRunner,
    close,
  });
};

const defaultModelSpendGuardDependencies: RequestScopedModelSpendGuardDependencies =
  Object.freeze({
    createSpendLedger: (
      pool: DatabasePool,
      principal: DurableRepositoryPrincipal,
    ) => new PostgresSpendLedger(pool, principal),
    clock: () => new Date(),
  });

/**
 * Binds model spend to the current durable request principal and exactly one
 * manager run. A different execution ID receives no spend authorization.
 */
export const createRequestScopedModelSpendGuard = (
  input: Readonly<{
    pool: DatabasePool;
    principal: DurableRepositoryPrincipal;
    runId: string;
  }>,
  dependencies: RequestScopedModelSpendGuardDependencies = defaultModelSpendGuardDependencies,
): SpendGuard => {
  const principal = DurablePrincipalSchema.safeParse(input.principal);
  const runId = UuidSchema.safeParse(input.runId);
  if (!principal.success || !runId.success) {
    throw new Error('api-model-spend-guard-input-invalid');
  }
  if (
    typeof dependencies.createSpendLedger !== 'function' ||
    typeof dependencies.clock !== 'function'
  ) {
    throw new Error('api-model-spend-guard-dependency-invalid');
  }
  const fixedPrincipal = deepFreeze(principal.data);
  const fixedRunId = runId.data;
  const authorizationId = createHash('sha256')
    .update(
      JSON.stringify([
        'emdo.openai-agent-spend-authorization.v1',
        fixedPrincipal.householdId,
        fixedPrincipal.userId,
        fixedPrincipal.sessionId,
        fixedPrincipal.requestId,
        fixedRunId,
      ]),
      'utf8',
    )
    .digest('hex');
  const resolver: SpendAuthorizationResolver = Object.freeze({
    resolve: async (executionId: string) =>
      executionId === fixedRunId
        ? Object.freeze({
            authorizationId,
            category: 'model' as const,
            householdId: fixedPrincipal.householdId,
          })
        : undefined,
  });
  return new SpendGuard(
    dependencies.createSpendLedger(input.pool, fixedPrincipal),
    resolver,
    dependencies.clock,
  );
};

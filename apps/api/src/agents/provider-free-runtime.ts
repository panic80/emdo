import {
  type AgentUsage,
  type JsonValue,
  type SafeAgentError,
  type SpecialistOutcome,
} from '@emdo/agent-core';
import { hashCanonicalJson } from '@emdo/toolbox';
import { z } from 'zod';

import type { AuthenticatedPrincipal } from '../services/contracts.js';
import { AuthenticatedPrincipalSchema } from '../schemas.js';

/**
 * The deliberately small provider-free shopping write boundary. The DB
 * composition owns authority checks, idempotency, and durable revisions; this
 * runtime only supplies the server-derived identity and normalized item.
 */
export interface ProviderFreeShoppingCreatePort {
  readonly checkReady?: () => Promise<boolean>;
  create(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
    readonly privateSpaceId: string;
    readonly runId: string;
    readonly item: {
      readonly id: string;
      readonly name: string;
      readonly quantityMinorUnits: number;
      readonly unit: 'each' | 'gram' | 'millilitre' | 'package';
    };
  }): Promise<ProviderFreeShoppingCreateResult>;
}

export type ProviderFreeShoppingCreateResult =
  | Readonly<{
      readonly status: 'applied' | 'duplicate';
      readonly item: Readonly<{
        readonly id: string;
        readonly name: string;
        readonly quantityMinorUnits: number;
        readonly unit: 'each' | 'gram' | 'millilitre' | 'package';
      }>;
      readonly revision: number;
      readonly updatedAt: string;
    }>
  | Readonly<{
      readonly status: 'conflict';
      readonly code: 'shopping-item-conflict' | 'service-unavailable';
      readonly message: string;
      readonly retryable: boolean;
    }>;

export interface ProviderFreeTurnInput {
  readonly requestId: string;
  readonly runId: string;
  readonly householdId: string;
  readonly userId: string;
  readonly authenticatedSessionId: string;
  readonly conversationId: string;
  readonly spaceAccessGrantId: string;
  readonly authorizationScopeFingerprint: string;
  readonly message: string;
  readonly routeHint?: 'scheduler' | 'finance' | 'shopping';
  readonly escalationTriggers?: readonly string[];
  readonly abortSignal: AbortSignal;
}

export interface ProviderFreeExecutionResolution {
  readonly status: 'provider-free';
  readonly profile: 'shopping-list-v1';
  readonly reason: 'provider-free-mvp';
}

export interface ProviderFreeCompletedTurnResult {
  readonly status: 'completed';
  readonly runId: string;
  readonly localTraceReference: string;
  readonly output: JsonValue;
  readonly specialistOutcomes: readonly SpecialistOutcome[];
  readonly hasPartialFailures: false;
  readonly usage: AgentUsage;
  readonly executionResolution: ProviderFreeExecutionResolution;
}

export interface ProviderFreeFailedTurnResult {
  readonly status: 'failed';
  readonly runId: string;
  readonly localTraceReference: string;
  readonly safeError: SafeAgentError;
  readonly specialistOutcomes: readonly SpecialistOutcome[];
  readonly usage: AgentUsage;
}

export type ProviderFreeTurnResult =
  ProviderFreeCompletedTurnResult | ProviderFreeFailedTurnResult;

export interface ProviderFreeOrchestrator {
  runTurn(input: ProviderFreeTurnInput): Promise<ProviderFreeTurnResult>;
  resumeTurn(input: unknown): Promise<never>;
}

export interface ProviderFreeMvpRuntime {
  readonly orchestrator: ProviderFreeOrchestrator;
  readonly agentIds: readonly ['manager', 'shopping'];
  readonly capabilityIds: readonly ['shopping.items.create'];
  readonly runtimeProfile: 'provider-free-mvp-v1';
}

export interface ProviderFreeMvpRuntimeFactory {
  create(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
    readonly runId: string;
    readonly conversationId: string;
  }): Promise<Pick<ProviderFreeMvpRuntime, 'orchestrator'>>;
  check(): Promise<boolean>;
}

const ZERO_USAGE: AgentUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  modelCostCadMinor: 0,
});

const EXECUTION_RESOLUTION: ProviderFreeExecutionResolution = Object.freeze({
  status: 'provider-free',
  profile: 'shopping-list-v1',
  reason: 'provider-free-mvp',
});

const COMMAND_PATTERN =
  /^add ([1-9][0-9]{0,5}) (each|gram|millilitre|package) ([A-Za-z0-9][A-Za-z0-9 .,\u0027-]{0,99}) to shopping list$/u;

const CreateResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.enum(['applied', 'duplicate']),
    item: z.strictObject({
      id: z.string().trim().min(1).max(200),
      name: z.string().trim().min(1).max(100),
      quantityMinorUnits: z.number().int().safe().positive(),
      unit: z.enum(['each', 'gram', 'millilitre', 'package']),
    }),
    revision: z.number().int().safe().positive(),
    updatedAt: z.string().trim().min(1).max(64),
  }),
  z.strictObject({
    status: z.literal('conflict'),
    code: z.enum(['shopping-item-conflict', 'service-unavailable']),
    message: z.string().trim().min(1).max(500),
    retryable: z.boolean(),
  }),
]);

const safeError = (
  code: string,
  message: string,
  retryable = false,
): SafeAgentError => Object.freeze({ code, message, retryable });

const parseCommand = (message: string) => {
  const match = COMMAND_PATTERN.exec(message.trim());
  if (match === null) return undefined;
  const quantity = Number(match[1]);
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    return undefined;
  }
  return Object.freeze({
    quantity,
    unit: match[2] as 'each' | 'gram' | 'millilitre' | 'package',
    name: match[3]!.trim(),
  });
};

const failed = (
  runId: string,
  error: SafeAgentError,
  specialistOutcomes: readonly SpecialistOutcome[] = [],
): ProviderFreeFailedTurnResult =>
  Object.freeze({
    status: 'failed' as const,
    runId,
    localTraceReference: `provider-free:${runId}`,
    safeError: error,
    specialistOutcomes: Object.freeze([...specialistOutcomes]),
    usage: ZERO_USAGE,
  });

const matchesPrincipal = (
  input: ProviderFreeTurnInput,
  principal: AuthenticatedPrincipal,
): boolean =>
  input.householdId === principal.householdId &&
  input.userId === principal.userId &&
  input.authenticatedSessionId === principal.sessionId &&
  input.spaceAccessGrantId === principal.spaceAccessGrantId;

export const createProviderFreeMvpRuntime = (input: {
  readonly shopping: ProviderFreeShoppingCreatePort;
  readonly principal: AuthenticatedPrincipal;
}): ProviderFreeMvpRuntime => {
  if (typeof input?.shopping?.create !== 'function') {
    throw new Error('provider-free-shopping-port-invalid');
  }
  const principal = AuthenticatedPrincipalSchema.parse(input.principal);
  if (principal.privateSpaceId === undefined) {
    throw new Error('provider-free-private-space-required');
  }
  const privateSpaceId = principal.privateSpaceId;

  const runTurn = async (
    turn: ProviderFreeTurnInput,
  ): Promise<ProviderFreeTurnResult> => {
    if (turn.abortSignal.aborted) {
      return failed(
        turn.runId,
        safeError(
          'provider-free-turn-aborted',
          'The shopping request was cancelled.',
        ),
      );
    }
    if (!matchesPrincipal(turn, principal)) {
      return failed(
        turn.runId,
        safeError(
          'provider-free-authority-mismatch',
          'The shopping request is not authorized for this session.',
        ),
      );
    }
    if (turn.routeHint !== undefined && turn.routeHint !== 'shopping') {
      return failed(
        turn.runId,
        safeError(
          'provider-free-command-unsupported',
          'Only the shopping list command is available in this runtime.',
        ),
      );
    }
    const command = parseCommand(turn.message);
    if (command === undefined) {
      return failed(
        turn.runId,
        safeError(
          'provider-free-command-unsupported',
          'Use: add <positive quantity> <unit> <name> to shopping list.',
        ),
      );
    }
    const item = Object.freeze({
      id: `shopping-${hashCanonicalJson({
        requestId: turn.requestId,
        runId: turn.runId,
        input: command,
      })}`,
      name: command.name,
      quantityMinorUnits: command.quantity * 1_000,
      unit: command.unit,
    });

    let rawResult: ProviderFreeShoppingCreateResult;
    try {
      rawResult = await input.shopping.create({
        principal,
        requestId: turn.requestId,
        privateSpaceId,
        runId: turn.runId,
        item,
      });
    } catch {
      return failed(
        turn.runId,
        safeError(
          'provider-free-shopping-write-failed',
          'The shopping item could not be saved.',
          true,
        ),
        [
          Object.freeze({
            delegationId: 'shopping.create',
            specialistId: 'shopping',
            status: 'failed',
            safeError: safeError(
              'provider-free-shopping-write-failed',
              'The shopping item could not be saved.',
              true,
            ),
            usage: ZERO_USAGE,
          }),
        ],
      );
    }

    const parsed = CreateResultSchema.safeParse(rawResult);
    if (!parsed.success) {
      return failed(
        turn.runId,
        safeError(
          'provider-free-shopping-result-invalid',
          'The shopping service returned an invalid result.',
          true,
        ),
      );
    }
    const result = parsed.data;
    if (result.status === 'conflict') {
      const conflictError = safeError(
        result.code,
        result.message,
        result.retryable,
      );
      return failed(turn.runId, conflictError, [
        Object.freeze({
          delegationId: 'shopping.create',
          specialistId: 'shopping',
          status: 'failed',
          safeError: conflictError,
          usage: ZERO_USAGE,
        }),
      ]);
    }

    const outcome: SpecialistOutcome = Object.freeze({
      delegationId: 'shopping.create',
      specialistId: 'shopping',
      status: 'completed',
      output: result as unknown as JsonValue,
      usage: ZERO_USAGE,
    });
    return Object.freeze({
      status: 'completed' as const,
      runId: turn.runId,
      localTraceReference: `provider-free:${turn.runId}`,
      output: Object.freeze({
        schemaVersion: 1,
        summary:
          result.status === 'duplicate'
            ? `That ${result.item.name} item is already on the shopping list.`
            : `Added ${command.quantity} ${result.item.unit} ${result.item.name} to the shopping list.`,
        clarificationQuestion: null,
        evidenceReferences: [],
        derivedValueReferences: [],
        actionProposalReferences: [],
        shoppingItem: result.item,
      }),
      specialistOutcomes: Object.freeze([outcome]),
      hasPartialFailures: false as const,
      usage: ZERO_USAGE,
      executionResolution: EXECUTION_RESOLUTION,
    });
  };

  const orchestrator: ProviderFreeOrchestrator = Object.freeze({
    runTurn,
    resumeTurn: async () => {
      throw new Error('provider-free-resume-unavailable');
    },
  });
  return Object.freeze({
    orchestrator,
    agentIds: Object.freeze(['manager', 'shopping'] as const),
    capabilityIds: Object.freeze(['shopping.items.create'] as const),
    runtimeProfile: 'provider-free-mvp-v1' as const,
  });
};

export const createProviderFreeMvpRuntimeFactory = (input: {
  readonly shopping: ProviderFreeShoppingCreatePort;
}): ProviderFreeMvpRuntimeFactory => {
  if (typeof input?.shopping?.create !== 'function') {
    throw new Error('provider-free-shopping-port-invalid');
  }
  return Object.freeze({
    create: async (
      request: Parameters<ProviderFreeMvpRuntimeFactory['create']>[0],
    ) =>
      createProviderFreeMvpRuntime({
        shopping: input.shopping,
        principal: request.principal,
      }),
    check: async () =>
      typeof input.shopping.checkReady === 'function'
        ? input.shopping.checkReady()
        : false,
  });
};

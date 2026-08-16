import {
  PostgresApprovalResumeBoundary,
  PostgresManagerTurnStore,
  PostgresProviderFreeShoppingService,
  PostgresRunEventSource,
  type ProviderFreeShoppingCreateResult as PostgresProviderFreeShoppingCreateResult,
  type EmdoDatabaseClient,
} from '@emdo/db/api';

import type { VisualProposalDecisionGateway } from '../services/contracts.js';
import { AuthenticatedPrincipalSchema } from '../schemas.js';
import {
  createProductionAgentServiceBindingsFromDependencies,
  type ProductionAgentRuntimeFactory,
} from './production-runtime.js';
import {
  createProviderFreeMvpRuntimeFactory,
  type ProviderFreeMvpRuntimeFactory,
  type ProviderFreeShoppingCreatePort,
  type ProviderFreeShoppingCreateResult,
} from './provider-free-runtime.js';

export interface ProductionAgentPersistenceInput {
  /** Shared purpose-scoped API pool; ownership and closing stay with its caller. */
  readonly pool: EmdoDatabaseClient['scopedPool'];
  /** Complete request-scoped runtime, supplied only after every agent boundary exists. */
  readonly runtimeFactory: ProductionAgentRuntimeFactory;
  /** Existing atomic visual-proof consume and decision authority. */
  readonly visualDecisions: VisualProposalDecisionGateway;
}

export interface ProviderFreeAgentPersistenceInput {
  readonly pool: EmdoDatabaseClient['scopedPool'];
  readonly shopping: PostgresProviderFreeShoppingService;
}

const isSupportedShoppingUnit = (
  value: string,
): value is 'each' | 'gram' | 'millilitre' | 'package' =>
  value === 'each' ||
  value === 'gram' ||
  value === 'millilitre' ||
  value === 'package';

/** Explicitly projects the DB aggregate shape into the runtime port shape. */
const adaptProviderFreeShoppingResult = (
  result: PostgresProviderFreeShoppingCreateResult,
): ProviderFreeShoppingCreateResult => {
  if (result.status === 'conflict') {
    return Object.freeze({
      status: 'conflict',
      code:
        result.safeError.code === 'shopping-item-id-conflict'
          ? 'shopping-item-conflict'
          : 'service-unavailable',
      message: result.safeError.message,
      retryable: false,
    });
  }
  if (!isSupportedShoppingUnit(result.item.unit)) {
    return Object.freeze({
      status: 'conflict',
      code: 'service-unavailable',
      message: 'The shopping service returned an unsupported unit.',
      retryable: false,
    });
  }
  return Object.freeze({
    status: result.status,
    item: Object.freeze({
      id: result.item.id,
      name: result.item.name,
      quantityMinorUnits: result.item.quantityMinorUnits,
      unit: result.item.unit,
    }),
    revision: result.item.revision,
    updatedAt: result.item.updatedAt,
  });
};

const providerFreeShoppingPort = (
  service: PostgresProviderFreeShoppingService,
): ProviderFreeShoppingCreatePort =>
  Object.freeze({
    create: async (
      input: Parameters<ProviderFreeShoppingCreatePort['create']>[0],
    ) =>
      adaptProviderFreeShoppingResult(
        await service.create({
          ...input,
          principal: {
            userId: input.principal.userId,
            sessionId: input.principal.sessionId,
            householdId: input.principal.householdId,
            spaceAccessGrantId: input.principal.spaceAccessGrantId,
          },
        }),
      ),
    checkReady: async () => {
      if (
        !('checkReady' in service) ||
        typeof service.checkReady !== 'function'
      ) {
        return false;
      }
      return service.checkReady();
    },
  });

export const createProviderFreeAgentPersistence = (input: {
  readonly pool: EmdoDatabaseClient['scopedPool'];
  readonly shopping: PostgresProviderFreeShoppingService;
}) => {
  if (
    typeof input?.pool?.connect !== 'function' ||
    typeof input?.shopping?.create !== 'function'
  ) {
    throw new Error('api-provider-free-agent-persistence-dependency-invalid');
  }
  const runtimeFactory: ProviderFreeMvpRuntimeFactory =
    createProviderFreeMvpRuntimeFactory({
      shopping: providerFreeShoppingPort(input.shopping),
    });
  const composition = createProductionAgentServiceBindingsFromDependencies({
    turns: new PostgresManagerTurnStore(input.pool, {
      requestedModel: 'provider-free-mvp-v1',
    }),
    runEvents: new PostgresRunEventSource(input.pool),
    runtimeFactory,
  });
  return Object.freeze({
    bindings: Object.freeze({
      managerTurns: composition.bindings.managerTurns,
      runEvents: composition.bindings.runEvents,
    }),
    runtimeFactory,
  });
};

/**
 * Composes only the durable persistence side of the production agent runtime.
 *
 * This deliberately has no environment loader and is not registered by the
 * bundled API on its own. A complete request-scoped runtime must be supplied,
 * and visual decisions continue through the existing atomic trusted gateway.
 */
export const createProductionAgentPersistence = (
  input: ProductionAgentPersistenceInput,
) => {
  if (
    typeof input?.pool?.connect !== 'function' ||
    typeof input.runtimeFactory?.create !== 'function' ||
    typeof input.runtimeFactory.check !== 'function' ||
    typeof input.visualDecisions?.decideWithVisualProof !== 'function'
  ) {
    throw new Error('api-production-agent-persistence-dependency-invalid');
  }

  const approvalResume = new PostgresApprovalResumeBoundary({
    pool: input.pool,
    decideAndLink: (decisionInput) =>
      input.visualDecisions.decideWithVisualProof({
        ...decisionInput,
        principal: AuthenticatedPrincipalSchema.parse(decisionInput.principal),
      }),
  });

  const composition = createProductionAgentServiceBindingsFromDependencies({
    turns: new PostgresManagerTurnStore(input.pool),
    runEvents: new PostgresRunEventSource(input.pool),
    runtimeFactory: input.runtimeFactory,
    approvalResume,
  });
  if (composition.bindings.proposals === undefined) {
    throw new Error('api-production-agent-persistence-dependency-invalid');
  }
  return Object.freeze({
    bindings: Object.freeze({
      managerTurns: composition.bindings.managerTurns,
      runEvents: composition.bindings.runEvents,
      proposals: composition.bindings.proposals,
    }),
  });
};

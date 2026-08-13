import {
  PostgresApprovalResumeBoundary,
  PostgresManagerTurnStore,
  PostgresRunEventSource,
  type EmdoDatabaseClient,
} from '@emdo/db/api';

import type { VisualProposalDecisionGateway } from '../services/contracts.js';
import { AuthenticatedPrincipalSchema } from '../schemas.js';
import {
  createProductionAgentServiceBindingsFromDependencies,
  type ProductionAgentRuntimeFactory,
} from './production-runtime.js';

export interface ProductionAgentPersistenceInput {
  /** Shared purpose-scoped API pool; ownership and closing stay with its caller. */
  readonly pool: EmdoDatabaseClient['scopedPool'];
  /** Complete request-scoped runtime, supplied only after every agent boundary exists. */
  readonly runtimeFactory: ProductionAgentRuntimeFactory;
  /** Existing atomic visual-proof consume and decision authority. */
  readonly visualDecisions: VisualProposalDecisionGateway;
}

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

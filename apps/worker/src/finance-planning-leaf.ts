import { FinancePlanningResultNotAppliedError } from '@emdo/db/worker';
import {
  FinanceAutomationPlanningIntentSchema,
  FinancePlanningCapabilitySchema,
  UuidSchema,
  type FinanceAutomationCapability,
} from '@emdo/contracts';
import { moneyValue } from '@emdo/domains/finance';
import type {
  FinanceAutomationLeaf,
  FinanceAutomationLeafInput,
} from './finance-automation-worker.js';

export type FinancePlanningLeafCapability = Extract<
  FinanceAutomationCapability,
  'finance.planning.budget-vs-actuals' | 'finance.planning.forecast'
>;

export interface FinancePlanningResultStore {
  generatePlanningResult(input: {
    operationId: string;
    expectedRevision: number;
    leaseToken: string;
  }): Promise<{ resultId: string }>;
}

function planningCapability(raw: unknown): FinancePlanningLeafCapability {
  return FinancePlanningCapabilitySchema.parse(raw);
}

function isRunnablePlanningInput(
  input: FinanceAutomationLeafInput,
  capability: FinancePlanningLeafCapability,
) {
  if (input.signal.aborted) return false;
  if (moneyValue(input.run.request.amount, input.run.request.currency) !== 0n)
    return false;
  if (input.run.request.capability !== capability) return false;
  const planning = input.run.request.planning;
  if (!planning || planning.capability !== capability) return false;
  if (input.targets.length !== 1 || input.targets[0] !== planning.budgetId)
    return false;
  return FinanceAutomationPlanningIntentSchema.safeParse(planning).success;
}

/** Binds one deterministic SQL planning operation to one closed capability.
 * All budget/ledger/reviewed-input values are reloaded by SQL; no arithmetic or
 * model/tool dispatch occurs in this worker process.
 */
export function createFinancePlanningLeaf(
  store: FinancePlanningResultStore,
  rawCapability: FinancePlanningLeafCapability,
): FinanceAutomationLeaf {
  const capability = planningCapability(rawCapability);
  return {
    capability,
    readiness: 'implemented',
    async execute(input) {
      if (!isRunnablePlanningInput(input, capability))
        return { application: 'not-applied' };
      try {
        const result = await store.generatePlanningResult({
          operationId: input.run.request.operationId,
          // This is the claimed automation run revision. It is intentionally
          // distinct from planning.budgetRevision.
          expectedRevision: input.run.revision,
          leaseToken: input.leaseToken,
        });
        return {
          application: 'applied',
          outcomeReference: UuidSchema.parse(result.resultId),
        };
      } catch (error) {
        if (error instanceof FinancePlanningResultNotAppliedError)
          return { application: 'not-applied' };
        // Connection loss or commit ambiguity is handled by the dispatcher as
        // indeterminate and must never be retried blindly.
        throw error;
      }
    },
  };
}

export function createFinancePlanningLeaves(
  store: FinancePlanningResultStore,
): readonly [FinanceAutomationLeaf, FinanceAutomationLeaf] {
  return [
    createFinancePlanningLeaf(store, 'finance.planning.budget-vs-actuals'),
    createFinancePlanningLeaf(store, 'finance.planning.forecast'),
  ];
}

/** Descriptive alias for production composition callers. */
export const createFinancePlanningAutomationLeaves =
  createFinancePlanningLeaves;

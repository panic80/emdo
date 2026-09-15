import {
  ModelRouter,
  createDurableFinanceStandardizationHook,
  createDurableFinanceProposalProvider,
  SPEND_LIMIT_CAD_MINOR,
  type ModelResolution,
  type SpendLedger,
} from '@emdo/agent-core';

export const exportedRuntimeSymbols = Object.freeze({
  ModelRouter,
  SPEND_LIMIT_CAD_MINOR,
  createDurableFinanceStandardizationHook,
  createDurableFinanceProposalProvider,
});

export const acceptsPublicTypes = (
  ledger: SpendLedger,
  resolution: ModelResolution,
) => Object.freeze({ ledger, resolution });

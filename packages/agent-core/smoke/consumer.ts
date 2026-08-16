import {
  ModelRouter,
  SPEND_LIMIT_CAD_MINOR,
  type ModelResolution,
  type SpendLedger,
} from '@emdo/agent-core';

export const exportedRuntimeSymbols = Object.freeze({
  ModelRouter,
  SPEND_LIMIT_CAD_MINOR,
});

export const acceptsPublicTypes = (
  ledger: SpendLedger,
  resolution: ModelResolution,
) => Object.freeze({ ledger, resolution });

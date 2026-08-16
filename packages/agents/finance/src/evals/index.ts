import { deepFreeze } from '@emdo/contracts';

import { financeManifest } from '../manifest.js';

export const agentEvalCatalog = deepFreeze({
  reference: financeManifest.evalSuite,
  agentId: financeManifest.id,
  cases: [
    { id: 'manager-forbidden-raw-tools', fixtureIds: [] },
    {
      id: 'derived-cad-total-lineage',
      fixtureIds: ['finance.import-cases'],
    },
    {
      id: 'one-run-field-scoped-disclosure',
      fixtureIds: ['finance.statement-csv'],
    },
    {
      id: 'cross-run-disclosure-reuse-denied',
      fixtureIds: ['finance.statement-csv'],
    },
    {
      id: 'disclosure-expires-before-model-dispatch',
      fixtureIds: ['finance.statement-csv'],
    },
    {
      id: 'partial-specialist-failure',
      fixtureIds: ['finance.import-cases'],
    },
    { id: 'luna-unavailable-terra-fallback', fixtureIds: [] },
    { id: 'required-terra-unavailable', fixtureIds: [] },
    { id: 'dual-model-unavailable', fixtureIds: [] },
  ],
} as const);

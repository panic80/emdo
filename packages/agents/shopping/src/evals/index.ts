import { deepFreeze } from '@emdo/contracts';

import { shoppingManifest } from '../manifest.js';

export const agentEvalCatalog = deepFreeze({
  reference: shoppingManifest.evalSuite,
  agentId: shoppingManifest.id,
  cases: [
    { id: 'manager-forbidden-raw-tools', fixtureIds: [] },
    {
      id: 'indirect-retailer-prompt-injection',
      fixtureIds: ['shopping.official-api-offer'],
    },
    {
      id: 'stale-commerce-offer-refresh',
      fixtureIds: ['shopping.official-api-offer'],
    },
    {
      id: 'partial-specialist-failure',
      fixtureIds: ['shopping.official-api-offer'],
    },
    { id: 'luna-unavailable-terra-fallback', fixtureIds: [] },
    { id: 'required-terra-unavailable', fixtureIds: [] },
    { id: 'dual-model-unavailable', fixtureIds: [] },
  ],
} as const);

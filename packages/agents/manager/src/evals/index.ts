import { deepFreeze } from '@emdo/contracts';

import { managerManifest } from '../manifest.js';

export const agentEvalCatalog = deepFreeze({
  reference: managerManifest.evalSuite,
  agentId: managerManifest.id,
  cases: [
    { id: 'route-scheduler-intent', fixtureIds: ['manager.routing'] },
    {
      id: 'independent-three-specialists-parallel',
      fixtureIds: ['manager.parallel'],
    },
    {
      id: 'dependent-cross-domain-waves',
      fixtureIds: ['manager.dependencies'],
    },
    { id: 'manager-forbidden-raw-tools', fixtureIds: [] },
    { id: 'indirect-retailer-prompt-injection', fixtureIds: [] },
    { id: 'derived-cad-total-lineage', fixtureIds: [] },
    { id: 'stale-commerce-offer-refresh', fixtureIds: [] },
    { id: 'one-run-field-scoped-disclosure', fixtureIds: [] },
    {
      id: 'partial-specialist-failure',
      fixtureIds: ['manager.partial-failure'],
    },
    { id: 'cross-run-disclosure-reuse-denied', fixtureIds: [] },
    { id: 'disclosure-expires-before-model-dispatch', fixtureIds: [] },
    { id: 'luna-unavailable-terra-fallback', fixtureIds: [] },
    { id: 'required-terra-unavailable', fixtureIds: [] },
    { id: 'dual-model-unavailable', fixtureIds: [] },
    { id: 'multiple-provider-writes-require-separate-turns', fixtureIds: [] },
    { id: 'calendar-write-authenticated-visual-resume', fixtureIds: [] },
    { id: 'typed-yes-cannot-approve', fixtureIds: [] },
  ],
} as const);

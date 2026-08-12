import { deepFreeze } from '@emdo/contracts';

import { schedulerManifest } from '../manifest.js';

export const agentEvalCatalog = deepFreeze({
  reference: schedulerManifest.evalSuite,
  agentId: schedulerManifest.id,
  cases: [
    {
      id: 'route-scheduler-intent',
      fixtureIds: ['scheduler.private-calendar-evidence'],
    },
    {
      id: 'dependent-cross-domain-waves',
      fixtureIds: ['scheduler.maps-travel-success'],
    },
    {
      id: 'multiple-provider-writes-require-separate-turns',
      fixtureIds: ['scheduler.calendar-create-success'],
    },
    {
      id: 'calendar-write-authenticated-visual-resume',
      fixtureIds: ['scheduler.calendar-create-success'],
    },
    {
      id: 'typed-yes-cannot-approve',
      fixtureIds: ['scheduler.calendar-create-success'],
    },
    { id: 'luna-unavailable-terra-fallback', fixtureIds: [] },
    { id: 'required-terra-unavailable', fixtureIds: [] },
    { id: 'dual-model-unavailable', fixtureIds: [] },
  ],
} as const);

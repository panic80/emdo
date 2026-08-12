import { deepFreeze } from '@emdo/contracts';

export const managerCapabilityReferences = deepFreeze([
  {
    id: 'agent.scheduler.delegate',
    version: '1.0.0',
    kind: 'delegation',
  },
  {
    id: 'agent.finance.delegate',
    version: '1.0.0',
    kind: 'delegation',
  },
  {
    id: 'agent.shopping.delegate',
    version: '1.0.0',
    kind: 'delegation',
  },
] as const);

import { deepFreeze } from '@emdo/contracts';

export const agentFixtureCatalog = deepFreeze({
  agentId: 'manager',
  fixtures: [
    {
      id: 'manager.routing',
      source: 'evals/fixtures/scenario-data.ts',
      description: 'Single-domain household request routing evidence.',
    },
    {
      id: 'manager.parallel',
      source: 'evals/fixtures/scenario-data.ts',
      description: 'Three independent specialist requests in one turn.',
    },
    {
      id: 'manager.dependencies',
      source: 'evals/fixtures/scenario-data.ts',
      description: 'Cross-domain work with an explicit prerequisite.',
    },
    {
      id: 'manager.partial-failure',
      source: 'evals/fixtures/scenario-data.ts',
      description: 'One failed specialist alongside two completed results.',
    },
  ],
} as const);

import { deepFreeze } from '@emdo/contracts';

export const agentFixtureCatalog = deepFreeze({
  agentId: 'shopping',
  fixtures: [
    {
      id: 'shopping.official-api-offer',
      source: 'official-api-offer.ts',
      description: 'Approved fixture-backed official offer candidate.',
    },
  ],
} as const);

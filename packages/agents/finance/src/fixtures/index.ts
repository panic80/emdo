import { deepFreeze } from '@emdo/contracts';

export const agentFixtureCatalog = deepFreeze({
  agentId: 'finance',
  fixtures: [
    {
      id: 'finance.import-cases',
      source: 'import-cases.json',
      description: 'Statement mapping, duplicate, and rejected-row cases.',
    },
    {
      id: 'finance.statement-csv',
      source: 'statement-mixed.csv',
      description: 'Mixed valid and invalid CSV statement rows.',
    },
    {
      id: 'finance.statement-ofx',
      source: 'statement-mixed.ofx',
      description: 'Mixed valid and invalid OFX statement transactions.',
    },
  ],
} as const);

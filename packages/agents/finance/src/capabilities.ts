import { deepFreeze } from '@emdo/contracts';

export const financeCapabilityReferences = deepFreeze([
  {
    id: 'finance.records.read',
    version: '1.0.0',
    kind: 'read',
  },
  {
    id: 'finance.records.write',
    version: '1.0.0',
    kind: 'local-write',
  },
  {
    id: 'finance.statement.import',
    version: '1.0.0',
    kind: 'import',
  },
  {
    id: 'finance.budget.calculate',
    version: '1.0.0',
    kind: 'read',
  },
] as const);

import { deepFreeze } from '@emdo/contracts';

export const financeCapabilityReferences = deepFreeze([
  { id: 'finance.reports.inspect', version: '1.0.0', kind: 'read' },
  {
    id: 'finance.reports.propose-mapping',
    version: '1.0.0',
    kind: 'local-write',
  },
  { id: 'finance.tax.read', version: '1.0.0', kind: 'read' },
  { id: 'finance.books.read', version: '1.0.0', kind: 'read' },
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
    id: 'finance.analytics.calculate',
    version: '1.0.0',
    kind: 'read',
  },
  {
    id: 'finance.documents.search',
    version: '1.0.0',
    kind: 'read',
  },
  {
    id: 'finance.documents.read',
    version: '1.0.0',
    kind: 'read',
  },
  {
    id: 'finance.matches.read',
    version: '1.0.0',
    kind: 'read',
  },
] as const);

import { deepFreeze } from '@emdo/contracts';

export const shoppingCapabilityReferences = deepFreeze([
  {
    id: 'shopping.items.read',
    version: '1.0.0',
    kind: 'read',
  },
  {
    id: 'shopping.items.write',
    version: '1.0.0',
    kind: 'local-write',
  },
  {
    id: 'commerce.offers.read',
    version: '1.0.0',
    kind: 'read',
  },
  {
    id: 'commerce.offers.refresh',
    version: '1.0.0',
    kind: 'read',
  },
  {
    id: 'commerce.link-out.prepare',
    version: '1.0.0',
    kind: 'read',
  },
] as const);

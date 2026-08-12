import { deepFreeze } from '@emdo/contracts';

export const schedulerCapabilityReferences = deepFreeze([
  {
    id: 'scheduler.calendar.freebusy.read',
    version: '1.0.0',
    kind: 'read',
  },
  {
    id: 'scheduler.tasks.read',
    version: '1.0.0',
    kind: 'read',
  },
  {
    id: 'scheduler.tasks.write',
    version: '1.0.0',
    kind: 'local-write',
  },
  {
    id: 'maps.travel-time.read',
    version: '1.0.0',
    kind: 'read',
  },
  {
    id: 'google-calendar.event.create',
    version: '1.0.0',
    kind: 'provider-write',
  },
  {
    id: 'google-calendar.event.update',
    version: '1.0.0',
    kind: 'provider-write',
  },
  {
    id: 'google-calendar.event.delete',
    version: '1.0.0',
    kind: 'provider-write',
  },
] as const);

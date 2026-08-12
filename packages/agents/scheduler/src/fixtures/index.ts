import { deepFreeze } from '@emdo/contracts';

export const agentFixtureCatalog = deepFreeze({
  agentId: 'scheduler',
  fixtures: [
    {
      id: 'scheduler.calendar-create-success',
      source: 'google-calendar-create-success.json',
      description: 'Recorded Google Calendar create and exact readback.',
    },
    {
      id: 'scheduler.maps-travel-success',
      source: 'maps-travel-success.json',
      description: 'Recorded deterministic Maps travel-time response.',
    },
    {
      id: 'scheduler.private-calendar-evidence',
      source: 'private-calendar-evidence.json',
      description: 'Private-calendar evidence with masked event details.',
    },
  ],
} as const);

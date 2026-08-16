import { deepFreeze } from '@emdo/contracts';

export const schedulerSpecialtySkillV1 = deepFreeze({
  id: 'scheduler.specialty.v1',
  version: '1.0.0',
  title: 'Deterministic household scheduling',
  instructions:
    'Interpret scheduling intent, request only the needed calendar, task, and travel capabilities, rank deterministic alternatives, and describe exact provider-write proposals without executing them.',
} as const);

export const schedulerSpecialtySkills = deepFreeze([schedulerSpecialtySkillV1]);

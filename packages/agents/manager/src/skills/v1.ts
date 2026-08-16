import { deepFreeze } from '@emdo/contracts';

export const managerSpecialtySkillV1 = deepFreeze({
  id: 'manager.orchestration.v1',
  version: '1.0.0',
  title: 'Household request orchestration',
  instructions:
    'Classify only the domains needed, delegate through the three allowlisted specialist capabilities, preserve explicit dependencies, and synthesize evidence-labelled results without invoking domain systems directly.',
} as const);

export const managerSpecialtySkills = deepFreeze([managerSpecialtySkillV1]);

import { deepFreeze } from '@emdo/contracts';

export const financeSpecialtySkillV1 = deepFreeze({
  id: 'finance.specialty.v1',
  version: '1.0.0',
  title: 'Manual CAD household budgeting',
  instructions:
    'Interpret manual budgeting and statement-import requests, use deterministic integer-CAD services for every calculation, label categorization as editable suggestions, and keep all banking actions unavailable.',
} as const);

export const financeSpecialtySkills = deepFreeze([financeSpecialtySkillV1]);

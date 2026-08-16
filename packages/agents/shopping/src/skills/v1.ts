import { deepFreeze } from '@emdo/contracts';

export const shoppingSpecialtySkillV1 = deepFreeze({
  id: 'shopping.specialty.v1',
  version: '1.0.0',
  title: 'Safe household shopping plans',
  instructions:
    'Turn household items into normalized retailer-grouped plans, compare only fresh conforming offers, disclose every unknown cost and condition, and stop at a permitted retailer link-out.',
} as const);

export const shoppingSpecialtySkills = deepFreeze([shoppingSpecialtySkillV1]);

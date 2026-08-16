import type { AgentPackageDefinition } from '@emdo/agent-core';
import { deepFreeze } from '@emdo/contracts';

import { shoppingCapabilityReferences } from './capabilities.js';
import { shoppingInstructions } from './instructions/v1.js';
import { shoppingManifest } from './manifest.js';
import { shoppingSpecialtySkills } from './skills/v1.js';

export const shoppingAgentDefinition = deepFreeze({
  manifest: shoppingManifest,
  instructions: shoppingInstructions,
  skills: shoppingSpecialtySkills,
  capabilityReferences: shoppingCapabilityReferences,
} as const satisfies AgentPackageDefinition);

import type { AgentPackageDefinition } from '@emdo/agent-core';
import { deepFreeze } from '@emdo/contracts';

import { managerCapabilityReferences } from './capabilities.js';
import { managerInstructions } from './instructions/v1.js';
import { managerManifest } from './manifest.js';
import { managerSpecialtySkills } from './skills/v1.js';

export const managerAgentDefinition = deepFreeze({
  manifest: managerManifest,
  instructions: managerInstructions,
  skills: managerSpecialtySkills,
  capabilityReferences: managerCapabilityReferences,
} as const satisfies AgentPackageDefinition);

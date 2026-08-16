import type { AgentPackageDefinition } from '@emdo/agent-core';
import { deepFreeze } from '@emdo/contracts';

import { financeCapabilityReferences } from './capabilities.js';
import { financeInstructions } from './instructions/v1.js';
import { financeManifest } from './manifest.js';
import { financeSpecialtySkills } from './skills/v1.js';

export const financeAgentDefinition = deepFreeze({
  manifest: financeManifest,
  instructions: financeInstructions,
  skills: financeSpecialtySkills,
  capabilityReferences: financeCapabilityReferences,
} as const satisfies AgentPackageDefinition);

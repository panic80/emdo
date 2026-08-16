import type { AgentPackageDefinition } from '@emdo/agent-core';
import { deepFreeze } from '@emdo/contracts';

import { schedulerCapabilityReferences } from './capabilities.js';
import { schedulerInstructions } from './instructions/v1.js';
import { schedulerManifest } from './manifest.js';
import { schedulerSpecialtySkills } from './skills/v1.js';

export const schedulerAgentDefinition = deepFreeze({
  manifest: schedulerManifest,
  instructions: schedulerInstructions,
  skills: schedulerSpecialtySkills,
  capabilityReferences: schedulerCapabilityReferences,
} as const satisfies AgentPackageDefinition);

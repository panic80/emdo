import { AgentManifestSchema, type AgentManifest } from '@emdo/contracts';

import { managerCapabilityReferences } from './capabilities.js';
import { managerInstructions } from './instructions/v1.js';
import { managerInputSchema, managerOutputSchema } from './schemas.js';
import { managerSpecialtySkills } from './skills/v1.js';

const foundationalSkillIds = [
  'privacy.v1',
  'clarification.v1',
  'provenance.v1',
  'toronto-time.v1',
  'cad-normalization.v1',
  'safe-errors.v1',
  'approvals.v1',
] as const;

export const managerManifest: AgentManifest = AgentManifestSchema.parse({
  schemaVersion: 1,
  id: 'manager',
  version: '1.0.0',
  kind: 'manager',
  intents: ['assistant.route', 'assistant.synthesize'],
  instructionIds: managerInstructions.map(({ id }) => id),
  skillIds: [
    ...foundationalSkillIds,
    ...managerSpecialtySkills.map(({ id }) => id),
  ],
  capabilityAllowlist: managerCapabilityReferences.map(({ id }) => id),
  readableDataClasses: [],
  modelPolicy: {
    defaultModel: 'gpt-5.6-luna',
    complexModel: 'gpt-5.6-terra',
    escalationReasons: [
      'dependent-cross-domain',
      'failed-output-validation',
      'low-confidence-reconciliation',
      'luna-unavailable',
      'complex-reasoning',
    ],
  },
  executionBudget: {
    maxTurns: 12,
    maxCapabilityCalls: 6,
    maxParallelCalls: 3,
    timeoutMs: 120_000,
    maxInputTokens: 24_000,
    maxOutputTokens: 6_000,
  },
  schemaRefs: {
    input: managerInputSchema.reference,
    output: managerOutputSchema.reference,
  },
  riskCeiling: 'none',
  evalSuite: { id: 'manager.evals', version: '1.0.0' },
});

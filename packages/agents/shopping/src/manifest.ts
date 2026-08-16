import { AgentManifestSchema, type AgentManifest } from '@emdo/contracts';

import { shoppingCapabilityReferences } from './capabilities.js';
import { shoppingInstructions } from './instructions/v1.js';
import { shoppingInputSchema, shoppingOutputSchema } from './schemas.js';
import { shoppingSpecialtySkills } from './skills/v1.js';

const foundationalSkillIds = [
  'privacy.v1',
  'clarification.v1',
  'provenance.v1',
  'toronto-time.v1',
  'cad-normalization.v1',
  'safe-errors.v1',
  'approvals.v1',
] as const;

export const shoppingManifest: AgentManifest = AgentManifestSchema.parse({
  schemaVersion: 1,
  id: 'shopping',
  version: '1.0.0',
  kind: 'specialist',
  intents: [
    'shopping.item',
    'shopping.list',
    'shopping.substitution',
    'shopping.retailer-plan',
    'shopping.offer-compare',
    'shopping.link-out',
  ],
  instructionIds: shoppingInstructions.map(({ id }) => id),
  skillIds: [
    ...foundationalSkillIds,
    ...shoppingSpecialtySkills.map(({ id }) => id),
  ],
  capabilityAllowlist: shoppingCapabilityReferences.map(({ id }) => id),
  readableDataClasses: [
    'agent.delegations',
    'agent.specialist-outcomes',
    'shopping.items',
    'shopping.preferences',
    'shopping.substitutions',
    'shopping.offers',
    'shopping.offer-history',
  ],
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
    maxTurns: 8,
    maxCapabilityCalls: 12,
    maxParallelCalls: 3,
    timeoutMs: 90_000,
    maxInputTokens: 20_000,
    maxOutputTokens: 4_000,
  },
  schemaRefs: {
    input: shoppingInputSchema.reference,
    output: shoppingOutputSchema.reference,
  },
  riskCeiling: 'local-write',
  evalSuite: { id: 'shopping.evals', version: '1.0.0' },
});

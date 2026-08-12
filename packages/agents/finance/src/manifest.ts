import { AgentManifestSchema, type AgentManifest } from '@emdo/contracts';

import { financeCapabilityReferences } from './capabilities.js';
import { financeInstructions } from './instructions/v1.js';
import { financeInputSchema, financeOutputSchema } from './schemas.js';
import { financeSpecialtySkills } from './skills/v1.js';

const foundationalSkillIds = [
  'privacy.v1',
  'clarification.v1',
  'provenance.v1',
  'toronto-time.v1',
  'cad-normalization.v1',
  'safe-errors.v1',
  'approvals.v1',
] as const;

export const financeManifest: AgentManifest = AgentManifestSchema.parse({
  schemaVersion: 1,
  id: 'finance',
  version: '1.0.0',
  kind: 'specialist',
  intents: [
    'finance.account',
    'finance.transaction',
    'finance.import',
    'finance.budget',
    'finance.bill',
    'finance.subscription',
    'finance.goal',
  ],
  instructionIds: financeInstructions.map(({ id }) => id),
  skillIds: [
    ...foundationalSkillIds,
    ...financeSpecialtySkills.map(({ id }) => id),
  ],
  capabilityAllowlist: financeCapabilityReferences.map(({ id }) => id),
  readableDataClasses: [
    'finance.accounts',
    'finance.transactions',
    'finance.categories',
    'finance.budgets',
    'finance.bills',
    'finance.subscriptions',
    'finance.goals',
    'finance.imports',
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
    input: financeInputSchema.reference,
    output: financeOutputSchema.reference,
  },
  riskCeiling: 'local-write',
  evalSuite: { id: 'finance.evals', version: '1.0.0' },
});

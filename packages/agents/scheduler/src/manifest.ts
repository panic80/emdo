import { AgentManifestSchema, type AgentManifest } from '@emdo/contracts';

import { schedulerCapabilityReferences } from './capabilities.js';
import { schedulerInstructions } from './instructions/v1.js';
import { schedulerInputSchema, schedulerOutputSchema } from './schemas.js';
import { schedulerSpecialtySkills } from './skills/v1.js';

const foundationalSkillIds = [
  'privacy.v1',
  'clarification.v1',
  'provenance.v1',
  'toronto-time.v1',
  'cad-normalization.v1',
  'safe-errors.v1',
  'approvals.v1',
] as const;

export const schedulerManifest: AgentManifest = AgentManifestSchema.parse({
  schemaVersion: 1,
  id: 'scheduler',
  version: '1.0.0',
  kind: 'specialist',
  intents: [
    'schedule.appointment',
    'schedule.task',
    'schedule.reminder',
    'schedule.chore',
    'schedule.routine',
    'schedule.workload',
  ],
  instructionIds: schedulerInstructions.map(({ id }) => id),
  skillIds: [
    ...foundationalSkillIds,
    ...schedulerSpecialtySkills.map(({ id }) => id),
  ],
  capabilityAllowlist: schedulerCapabilityReferences.map(({ id }) => id),
  readableDataClasses: [
    'calendar.events',
    'scheduler.tasks',
    'scheduler.reminders',
    'scheduler.chores',
    'scheduler.routines',
    'maps.travel-times',
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
    input: schedulerInputSchema.reference,
    output: schedulerOutputSchema.reference,
  },
  riskCeiling: 'provider-write',
  evalSuite: { id: 'scheduler.evals', version: '1.0.0' },
});

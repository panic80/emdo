import {
  IdentifierSchema,
  deepFreeze,
  type VersionedRuntimeSchema,
} from '@emdo/contracts';
import { z } from 'zod';

const SchedulerInputSchema = z.strictObject({
  request: z.string().trim().min(1).max(8_000),
});

const SchedulerOutputSchema = z.strictObject({
  summary: z.string().trim().min(1).max(12_000),
  clarificationQuestion: z.string().trim().min(1).max(500).nullable(),
  evidenceReferences: z.array(IdentifierSchema).max(128),
  derivedValueReferences: z.array(IdentifierSchema).max(128),
  actionProposalReferences: z.array(IdentifierSchema).max(64),
});

export const schedulerInputSchema = Object.freeze({
  reference: deepFreeze({ id: 'scheduler.input', version: '1.0.0' } as const),
  schema: SchedulerInputSchema,
} satisfies VersionedRuntimeSchema);

export const schedulerOutputSchema = Object.freeze({
  reference: deepFreeze({ id: 'scheduler.output', version: '1.0.0' } as const),
  schema: SchedulerOutputSchema,
} satisfies VersionedRuntimeSchema);

export const schedulerSchemaRegistrations = Object.freeze([
  schedulerInputSchema,
  schedulerOutputSchema,
] as const);

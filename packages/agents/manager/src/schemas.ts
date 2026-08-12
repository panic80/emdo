import {
  IdentifierSchema,
  deepFreeze,
  type VersionedRuntimeSchema,
} from '@emdo/contracts';
import { z } from 'zod';

const ManagerInputSchema = z.strictObject({
  request: z.string().trim().min(1).max(8_000),
});

const ManagerOutputSchema = z.strictObject({
  summary: z.string().trim().min(1).max(12_000),
  clarificationQuestion: z.string().trim().min(1).max(500).nullable(),
  evidenceReferences: z.array(IdentifierSchema).max(128),
  derivedValueReferences: z.array(IdentifierSchema).max(128),
  actionProposalReferences: z.array(IdentifierSchema).max(64),
});

export const managerInputSchema = Object.freeze({
  reference: deepFreeze({ id: 'manager.input', version: '1.0.0' } as const),
  schema: ManagerInputSchema,
} satisfies VersionedRuntimeSchema);

export const managerOutputSchema = Object.freeze({
  reference: deepFreeze({ id: 'manager.output', version: '1.0.0' } as const),
  schema: ManagerOutputSchema,
} satisfies VersionedRuntimeSchema);

export const managerSchemaRegistrations = Object.freeze([
  managerInputSchema,
  managerOutputSchema,
] as const);

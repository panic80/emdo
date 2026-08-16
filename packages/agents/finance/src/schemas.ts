import {
  IdentifierSchema,
  deepFreeze,
  type VersionedRuntimeSchema,
} from '@emdo/contracts';
import { z } from 'zod';

const FinanceInputSchema = z.strictObject({
  request: z.string().trim().min(1).max(8_000),
});

const FinanceOutputSchema = z.strictObject({
  summary: z.string().trim().min(1).max(12_000),
  clarificationQuestion: z.string().trim().min(1).max(500).nullable(),
  evidenceReferences: z.array(IdentifierSchema).max(128),
  derivedValueReferences: z.array(IdentifierSchema).max(128),
  actionProposalReferences: z.array(IdentifierSchema).max(64),
});

export const financeInputSchema = Object.freeze({
  reference: deepFreeze({ id: 'finance.input', version: '1.0.0' } as const),
  schema: FinanceInputSchema,
} satisfies VersionedRuntimeSchema);

export const financeOutputSchema = Object.freeze({
  reference: deepFreeze({ id: 'finance.output', version: '1.0.0' } as const),
  schema: FinanceOutputSchema,
} satisfies VersionedRuntimeSchema);

export const financeSchemaRegistrations = Object.freeze([
  financeInputSchema,
  financeOutputSchema,
] as const);

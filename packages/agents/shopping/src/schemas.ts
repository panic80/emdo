import {
  IdentifierSchema,
  deepFreeze,
  type VersionedRuntimeSchema,
} from '@emdo/contracts';
import { z } from 'zod';

const ShoppingInputSchema = z.strictObject({
  request: z.string().trim().min(1).max(8_000),
});

const ShoppingOutputSchema = z.strictObject({
  summary: z.string().trim().min(1).max(12_000),
  clarificationQuestion: z.string().trim().min(1).max(500).nullable(),
  evidenceReferences: z.array(IdentifierSchema).max(128),
  derivedValueReferences: z.array(IdentifierSchema).max(128),
  actionProposalReferences: z.array(IdentifierSchema).max(64),
});

export const shoppingInputSchema = Object.freeze({
  reference: deepFreeze({ id: 'shopping.input', version: '1.0.0' } as const),
  schema: ShoppingInputSchema,
} satisfies VersionedRuntimeSchema);

export const shoppingOutputSchema = Object.freeze({
  reference: deepFreeze({ id: 'shopping.output', version: '1.0.0' } as const),
  schema: ShoppingOutputSchema,
} satisfies VersionedRuntimeSchema);

export const shoppingSchemaRegistrations = Object.freeze([
  shoppingInputSchema,
  shoppingOutputSchema,
] as const);

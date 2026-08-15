import { z } from 'zod';

import {
  FinanceImportReferenceSchema,
  deepFreeze,
  type DeepReadonly,
} from './primitives.js';

const DestinationNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= 800,
    'Finance import destination name exceeds 800 UTF-8 bytes',
  )
  .refine(
    (value) => !/\p{Cc}/u.test(value),
    'Finance import destination name contains control characters',
  );

export const FinanceImportDestinationAccountSchema = z.strictObject({
  id: FinanceImportReferenceSchema,
  name: DestinationNameSchema,
  accountKind: z.enum(['cash', 'chequing', 'savings', 'credit', 'other']),
});

export const FinanceImportDestinationCategorySchema = z.strictObject({
  id: FinanceImportReferenceSchema,
  name: DestinationNameSchema,
  categoryKind: z.enum(['income', 'expense']),
});

const FinanceImportDestinationsBaseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  accounts: z.array(FinanceImportDestinationAccountSchema).max(100),
  categories: z.array(FinanceImportDestinationCategorySchema).max(100),
});

export const FinanceImportDestinationsSchema =
  FinanceImportDestinationsBaseSchema.transform(deepFreeze);

export type FinanceImportDestinations = DeepReadonly<
  z.input<typeof FinanceImportDestinationsBaseSchema>
>;

import {
  IdentifierSchema,
  OpaqueReferenceSchema,
  deepFreeze,
  type DeepReadonly,
} from '@emdo/contracts';
import { z } from 'zod';

import { isBoundedAcyclicData } from './bounded.js';

const QuantityInputSchema = z.strictObject({
  amount: z
    .string()
    .trim()
    .regex(/^\d{1,9}(?:\.\d{1,3})?$/),
  unit: z.string().trim().min(1).max(20),
});

const PreferencesSchema = z.strictObject({
  requiredTags: z.array(IdentifierSchema).max(32).default([]),
  excludedTags: z.array(IdentifierSchema).max(32).default([]),
  preferredBrands: z
    .array(z.string().trim().min(1).max(120))
    .max(32)
    .default([]),
});

const AlternativeSchema = z.strictObject({
  id: OpaqueReferenceSchema,
  label: z.string().trim().min(1).max(300),
});

const SubstitutionSchema = z.strictObject({
  policy: z.enum(['never', 'listed-only', 'similar']).default('similar'),
  alternatives: z.array(AlternativeSchema).max(32).default([]),
});

const ShoppingItemInputSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: OpaqueReferenceSchema,
    kind: z.enum(['grocery', 'general']),
    name: z.string().trim().min(1).max(300),
    quantity: QuantityInputSchema,
    preferences: PreferencesSchema.default({
      requiredTags: [],
      excludedTags: [],
      preferredBrands: [],
    }),
    substitutions: SubstitutionSchema.default({
      policy: 'similar',
      alternatives: [],
    }),
    preferredRetailers: z.array(IdentifierSchema).max(32).default([]),
  })
  .superRefine((item, context) => {
    const requiredTags = new Set(item.preferences.requiredTags);
    if (
      requiredTags.size !== item.preferences.requiredTags.length ||
      new Set(item.preferences.excludedTags).size !==
        item.preferences.excludedTags.length ||
      item.preferences.excludedTags.some((tag) => requiredTags.has(tag))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['preferences'],
        message: 'Preferences must be unique and non-contradictory',
      });
    }
    if (
      new Set(item.preferences.preferredBrands).size !==
        item.preferences.preferredBrands.length ||
      new Set(item.preferredRetailers).size !== item.preferredRetailers.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['preferences'],
        message: 'Preferences must not contain duplicates',
      });
    }

    const alternativeIds = item.substitutions.alternatives.map(
      (alternative) => alternative.id,
    );
    if (
      new Set(alternativeIds).size !== alternativeIds.length ||
      alternativeIds.includes(item.id) ||
      (item.substitutions.policy === 'never' &&
        item.substitutions.alternatives.length > 0) ||
      (item.substitutions.policy === 'listed-only' &&
        item.substitutions.alternatives.length === 0)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['substitutions'],
        message: 'Substitution policy and alternatives are inconsistent',
      });
    }
  });

const ShoppingItemBaseSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: OpaqueReferenceSchema,
    kind: z.enum(['grocery', 'general']),
    name: z.string().trim().min(1).max(300),
    quantity: z.strictObject({
      amountMilliUnits: z.number().int().safe().positive(),
      unit: z.enum(['each', 'gram', 'millilitre', 'package']),
      scale: z.literal(1_000),
    }),
    preferences: PreferencesSchema,
    substitutions: SubstitutionSchema,
    preferredRetailers: z.array(IdentifierSchema).max(32),
  })
  .superRefine((item, context) => {
    const requiredTags = new Set(item.preferences.requiredTags);
    const alternativeIds = item.substitutions.alternatives.map(
      (alternative) => alternative.id,
    );
    if (
      requiredTags.size !== item.preferences.requiredTags.length ||
      new Set(item.preferences.excludedTags).size !==
        item.preferences.excludedTags.length ||
      item.preferences.excludedTags.some((tag) => requiredTags.has(tag)) ||
      new Set(item.preferences.preferredBrands).size !==
        item.preferences.preferredBrands.length ||
      new Set(item.preferredRetailers).size !==
        item.preferredRetailers.length ||
      new Set(alternativeIds).size !== alternativeIds.length ||
      alternativeIds.includes(item.id) ||
      (item.substitutions.policy === 'never' && alternativeIds.length > 0) ||
      (item.substitutions.policy === 'listed-only' &&
        alternativeIds.length === 0)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Normalized shopping item policy is inconsistent',
      });
    }
  });

export const ShoppingItemSchema = ShoppingItemBaseSchema.transform(deepFreeze);

const UNIT_MAP = {
  each: { unit: 'each', multiplier: 1n },
  ea: { unit: 'each', multiplier: 1n },
  piece: { unit: 'each', multiplier: 1n },
  pieces: { unit: 'each', multiplier: 1n },
  g: { unit: 'gram', multiplier: 1n },
  gram: { unit: 'gram', multiplier: 1n },
  grams: { unit: 'gram', multiplier: 1n },
  kg: { unit: 'gram', multiplier: 1_000n },
  kilogram: { unit: 'gram', multiplier: 1_000n },
  kilograms: { unit: 'gram', multiplier: 1_000n },
  ml: { unit: 'millilitre', multiplier: 1n },
  millilitre: { unit: 'millilitre', multiplier: 1n },
  millilitres: { unit: 'millilitre', multiplier: 1n },
  l: { unit: 'millilitre', multiplier: 1_000n },
  litre: { unit: 'millilitre', multiplier: 1_000n },
  litres: { unit: 'millilitre', multiplier: 1_000n },
  pack: { unit: 'package', multiplier: 1n },
  package: { unit: 'package', multiplier: 1n },
  packages: { unit: 'package', multiplier: 1n },
} as const;

const normalizeQuantity = (quantity: z.output<typeof QuantityInputSchema>) => {
  const mapping =
    UNIT_MAP[quantity.unit.toLowerCase() as keyof typeof UNIT_MAP];
  if (mapping === undefined) return undefined;

  const [whole, fraction = ''] = quantity.amount.split('.');
  const thousandths = BigInt(whole!) * 1_000n + BigInt(fraction.padEnd(3, '0'));
  const amountMilliUnits = thousandths * mapping.multiplier;
  if (
    amountMilliUnits <= 0n ||
    amountMilliUnits > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return undefined;
  }

  return {
    amountMilliUnits: Number(amountMilliUnits),
    unit: mapping.unit,
    scale: 1_000 as const,
  };
};

export interface ShoppingItemSafeError {
  readonly code: 'shopping-item-invalid';
  readonly message: 'The shopping item is invalid.';
  readonly retryable: false;
}

export type ShoppingItem = DeepReadonly<
  z.output<typeof ShoppingItemBaseSchema>
>;

export type ShoppingItemNormalizationResult =
  | DeepReadonly<{ status: 'accepted'; item: ShoppingItem }>
  | DeepReadonly<{ status: 'rejected'; safeError: ShoppingItemSafeError }>;

const invalidItem = (): ShoppingItemNormalizationResult =>
  deepFreeze({
    status: 'rejected',
    safeError: {
      code: 'shopping-item-invalid',
      message: 'The shopping item is invalid.',
      retryable: false,
    },
  });

export const normalizeShoppingItem = (
  input: unknown,
): ShoppingItemNormalizationResult => {
  if (!isBoundedAcyclicData(input)) return invalidItem();
  try {
    const parsed = ShoppingItemInputSchema.safeParse(input);
    if (!parsed.success) return invalidItem();
    const quantity = normalizeQuantity(parsed.data.quantity);
    if (quantity === undefined) return invalidItem();

    const item = ShoppingItemSchema.safeParse({
      schemaVersion: 1,
      id: parsed.data.id,
      kind: parsed.data.kind,
      name: parsed.data.name,
      quantity,
      preferences: parsed.data.preferences,
      substitutions: parsed.data.substitutions,
      preferredRetailers: parsed.data.preferredRetailers,
    });
    if (!item.success) return invalidItem();
    return deepFreeze({
      status: 'accepted' as const,
      item: item.data,
    });
  } catch {
    return invalidItem();
  }
};

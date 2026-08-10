import { describe, expect, it } from 'vitest';

import { normalizeShoppingItem, type ShoppingItem } from './items.js';

const grocery = {
  schemaVersion: 1,
  id: 'milk-1',
  kind: 'grocery',
  name: 'Whole milk',
  quantity: { amount: '1.25', unit: 'L' },
  preferences: {
    requiredTags: ['lactose-free'],
    excludedTags: ['sweetened'],
    preferredBrands: ['Natrel'],
  },
  substitutions: {
    policy: 'listed-only',
    alternatives: [{ id: 'oat-beverage-1', label: 'Unsweetened oat beverage' }],
  },
  preferredRetailers: ['no-frills-ca', 'walmart-ca'],
} as const;

const readCanonicalPolicy = (item: ShoppingItem) => {
  const requiredTags: readonly string[] = item.preferences.requiredTags;
  const excludedTags: readonly string[] = item.preferences.excludedTags;
  const preferredBrands: readonly string[] = item.preferences.preferredBrands;
  const substitutionPolicy: 'never' | 'listed-only' | 'similar' =
    item.substitutions.policy;
  const alternatives: readonly {
    readonly id: string;
    readonly label: string;
  }[] = item.substitutions.alternatives;
  return {
    requiredTags,
    excludedTags,
    preferredBrands,
    substitutionPolicy,
    alternatives,
  };
};

describe('normalizeShoppingItem', () => {
  it('exposes canonical preferences and substitution policy as required fields', () => {
    const result = normalizeShoppingItem(grocery);
    if (result.status !== 'accepted') throw new Error('Invalid test fixture');
    expect(readCanonicalPolicy(result.item)).toMatchObject({
      requiredTags: ['lactose-free'],
      substitutionPolicy: 'listed-only',
    });
  });

  it('normalizes grocery quantities to exact thousandths of a base unit', () => {
    const result = normalizeShoppingItem(grocery);

    expect(result).toEqual({
      status: 'accepted',
      item: {
        schemaVersion: 1,
        id: 'milk-1',
        kind: 'grocery',
        name: 'Whole milk',
        quantity: {
          amountMilliUnits: 1_250_000,
          unit: 'millilitre',
          scale: 1_000,
        },
        preferences: {
          requiredTags: ['lactose-free'],
          excludedTags: ['sweetened'],
          preferredBrands: ['Natrel'],
        },
        substitutions: {
          policy: 'listed-only',
          alternatives: [
            { id: 'oat-beverage-1', label: 'Unsweetened oat beverage' },
          ],
        },
        preferredRetailers: ['no-frills-ca', 'walmart-ca'],
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.status === 'accepted') {
      expect(Object.isFrozen(result.item.preferences.requiredTags)).toBe(true);
    }
  });

  it.each([
    [{ amount: '3', unit: 'pieces' }, 3_000, 'each'],
    [{ amount: '2.5', unit: 'kg' }, 2_500_000, 'gram'],
    [{ amount: '750', unit: 'g' }, 750_000, 'gram'],
    [{ amount: '12', unit: 'pack' }, 12_000, 'package'],
  ] as const)(
    'normalizes %o deterministically',
    (quantity, amountMilliUnits, unit) => {
      const result = normalizeShoppingItem({
        schemaVersion: 1,
        id: 'general-item-1',
        kind: 'general',
        name: 'Household item',
        quantity,
      });

      expect(result).toMatchObject({
        status: 'accepted',
        item: {
          kind: 'general',
          quantity: { amountMilliUnits, unit, scale: 1_000 },
          preferences: {
            requiredTags: [],
            excludedTags: [],
            preferredBrands: [],
          },
          substitutions: { policy: 'similar', alternatives: [] },
          preferredRetailers: [],
        },
      });
    },
  );

  it('rejects contradictory preferences and invalid substitution policies', () => {
    expect(
      normalizeShoppingItem({
        ...grocery,
        preferences: {
          ...grocery.preferences,
          excludedTags: ['lactose-free'],
        },
      }),
    ).toMatchObject({
      status: 'rejected',
      safeError: { code: 'shopping-item-invalid', retryable: false },
    });

    expect(
      normalizeShoppingItem({
        ...grocery,
        substitutions: {
          policy: 'never',
          alternatives: grocery.substitutions.alternatives,
        },
      }),
    ).toMatchObject({ status: 'rejected' });
  });

  it.each([
    { amount: '0', unit: 'each' },
    { amount: '-1', unit: 'each' },
    { amount: '1.0001', unit: 'each' },
    { amount: '9999999999', unit: 'kg' },
    { amount: '1', unit: 'pound' },
  ])('rejects an unsafe quantity %o without reflecting input', (quantity) => {
    const result = normalizeShoppingItem({
      ...grocery,
      name: 'do-not-reflect-this',
      quantity,
    });

    expect(result).toEqual({
      status: 'rejected',
      safeError: {
        code: 'shopping-item-invalid',
        message: 'The shopping item is invalid.',
        retryable: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain('do-not-reflect-this');
  });

  it.each(['cyclic', 'too-deep', 'accessor', 'symbol'] as const)(
    'fails closed for %s untrusted input before schema parsing',
    (kind) => {
      let input: Record<string, unknown> = { ...grocery };
      if (kind === 'cyclic') {
        input.self = input;
      } else if (kind === 'accessor') {
        Object.defineProperty(input, 'name', {
          enumerable: true,
          get: () => {
            throw new Error('must not execute');
          },
        });
      } else if (kind === 'too-deep') {
        let nested: Record<string, unknown> = {};
        for (let depth = 0; depth < 70; depth += 1) {
          nested = { nested };
        }
        input = { ...grocery, extra: nested };
      } else {
        Object.defineProperty(input, Symbol('hidden'), {
          enumerable: true,
          value: 'must-be-rejected',
        });
      }

      expect(normalizeShoppingItem(input)).toMatchObject({
        status: 'rejected',
        safeError: { code: 'shopping-item-invalid' },
      });
    },
  );
});

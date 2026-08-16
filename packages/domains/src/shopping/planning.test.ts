import { describe, expect, it } from 'vitest';

import { normalizeShoppingItem, type ShoppingItem } from './items.js';
import { groupShoppingItemsByRetailer } from './planning.js';

const item = (
  id: string,
  name: string,
  preferredRetailers: readonly string[] = [],
): ShoppingItem => {
  const result = normalizeShoppingItem({
    schemaVersion: 1,
    id,
    kind: id.includes('milk') ? 'grocery' : 'general',
    name,
    quantity: { amount: '1', unit: 'each' },
    preferredRetailers,
  });
  if (result.status !== 'accepted') throw new Error('Invalid test fixture');
  return result.item;
};

describe('groupShoppingItemsByRetailer', () => {
  const milk = item('milk-1', 'Milk', ['no-frills-ca', 'walmart-ca']);
  const soap = item('soap-1', 'Dish soap', ['walmart-ca']);
  const batteries = item('batteries-1', 'Batteries');

  it('groups explicit assignments first, then first retailer preference', () => {
    const result = groupShoppingItemsByRetailer({
      items: [soap, batteries, milk],
      assignments: [{ itemId: 'soap-1', retailerId: 'canadian-tire-ca' }],
    });

    expect(result).toEqual({
      status: 'grouped',
      groups: [
        { retailerId: 'canadian-tire-ca', items: [soap] },
        { retailerId: 'no-frills-ca', items: [milk] },
        { retailerId: null, items: [batteries] },
      ],
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.status === 'grouped') {
      expect(Object.isFrozen(result.groups)).toBe(true);
    }
  });

  it('is deterministic regardless of input order', () => {
    const left = groupShoppingItemsByRetailer({
      items: [soap, milk],
      assignments: [],
    });
    const right = groupShoppingItemsByRetailer({
      items: [milk, soap],
      assignments: [],
    });

    expect(left).toEqual(right);
  });

  it.each([
    {
      items: [milk, milk],
      assignments: [],
    },
    {
      items: [milk],
      assignments: [
        { itemId: 'milk-1', retailerId: 'walmart-ca' },
        { itemId: 'milk-1', retailerId: 'no-frills-ca' },
      ],
    },
    {
      items: [milk],
      assignments: [{ itemId: 'unknown-item', retailerId: 'walmart-ca' }],
    },
    {
      items: [
        {
          ...milk,
          preferences: {
            ...milk.preferences,
            requiredTags: ['allergy-safe'],
            excludedTags: ['allergy-safe'],
          },
        },
      ],
      assignments: [],
    },
  ])('rejects ambiguous grouping input', (input) => {
    expect(groupShoppingItemsByRetailer(input)).toEqual({
      status: 'rejected',
      safeError: {
        code: 'shopping-grouping-invalid',
        message: 'The retailer grouping request is invalid.',
        retryable: false,
      },
    });
  });

  it('rejects a cyclic grouping request safely', () => {
    const input: Record<string, unknown> = {
      items: [milk],
      assignments: [],
    };
    input.self = input;

    expect(groupShoppingItemsByRetailer(input)).toMatchObject({
      status: 'rejected',
      safeError: { code: 'shopping-grouping-invalid' },
    });
  });
});

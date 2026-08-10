import { describe, expect, it } from 'vitest';

import { shoppingEvalCases } from './cases.js';

describe('shopping eval cases', () => {
  it('uses unique, bounded identifiers and routes every case to shopping', () => {
    expect(shoppingEvalCases.length).toBeGreaterThanOrEqual(5);
    expect(new Set(shoppingEvalCases.map((entry) => entry.id)).size).toBe(
      shoppingEvalCases.length,
    );
    for (const entry of shoppingEvalCases) {
      expect(entry.id).toMatch(/^shopping\.[a-z0-9-]+\.v1$/);
      expect(entry.input.length).toBeGreaterThan(0);
      expect(entry.input.length).toBeLessThanOrEqual(2_000);
      expect(entry.expected.route).toBe('shopping');
    }
  });

  it('forbids every out-of-scope commerce action in every case', () => {
    for (const entry of shoppingEvalCases) {
      expect(entry.expected.forbiddenCapabilities).toEqual([
        'scrape',
        'infer-stock',
        'login',
        'cart',
        'purchase',
        'checkout',
      ]);
    }
  });

  it('contains the mixed-list acceptance behavior and fixture provenance', () => {
    expect(
      shoppingEvalCases.find(
        (entry) => entry.id === 'shopping.mixed-retailer-plan.v1',
      ),
    ).toMatchObject({
      fixtureIds: ['fixture-official-api-offer-v1'],
      expected: {
        requiredBehaviors: expect.arrayContaining([
          'group-by-retailer',
          'show-freshness',
          'show-substitutions',
          'disclose-unknown-costs',
          'safe-product-link-out',
        ]),
      },
    });
  });
});

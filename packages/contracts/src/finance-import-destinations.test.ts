import { describe, expect, it } from 'vitest';

import { FinanceImportDestinationsSchema } from './browser.js';

describe('finance import destination contracts', () => {
  it('publishes a strict bounded browser-safe manual CAD destination projection', () => {
    const destinations = FinanceImportDestinationsSchema.parse({
      schemaVersion: 1,
      accounts: [
        {
          id: 'account::chequing',
          name: 'Everyday chequing',
          accountKind: 'chequing',
        },
      ],
      categories: [
        {
          id: 'category::groceries',
          name: 'Groceries',
          categoryKind: 'expense',
        },
      ],
    });

    expect(destinations).toEqual({
      schemaVersion: 1,
      accounts: [
        {
          id: 'account::chequing',
          name: 'Everyday chequing',
          accountKind: 'chequing',
        },
      ],
      categories: [
        {
          id: 'category::groceries',
          name: 'Groceries',
          categoryKind: 'expense',
        },
      ],
    });
    expect(() =>
      FinanceImportDestinationsSchema.parse({
        ...destinations,
        accounts: [{ ...destinations.accounts[0], balanceCadMinor: 100 }],
      }),
    ).toThrow();
    expect(() =>
      FinanceImportDestinationsSchema.parse({
        ...destinations,
        categories: Array.from({ length: 101 }, (_, index) => ({
          id: `category::${index}`,
          name: `Category ${index}`,
          categoryKind: 'expense',
        })),
      }),
    ).toThrow();
  });
});

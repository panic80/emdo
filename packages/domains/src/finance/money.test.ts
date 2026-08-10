import { describe, expect, it } from 'vitest';

import { parseCadDecimal, sumCadMinorUnits } from './money.js';

describe('CAD minor-unit arithmetic', () => {
  it.each([
    ['0', 0],
    ['12', 1_200],
    ['12.3', 1_230],
    ['$1,234.56', 123_456],
    ['-19.99', -1_999],
    ['(42.05)', -4_205],
  ] as const)(
    'parses %s without floating-point arithmetic',
    (text, expected) => {
      expect(parseCadDecimal(text)).toEqual({
        status: 'parsed',
        money: { currency: 'CAD', minorUnits: expected },
      });
    },
  );

  it.each([
    12.34,
    '12.345',
    '1,23.45',
    'USD 12.00',
    'NaN',
    '90071992547409.92',
  ])('rejects unsafe or non-CAD amount input %j', (input) => {
    expect(parseCadDecimal(input)).toEqual({
      status: 'rejected',
      safeError: {
        code: 'invalid-cad-amount',
        message: 'Enter a valid CAD amount with no more than two decimals.',
      },
    });
  });

  it('sums signed minor units exactly and rejects unsafe totals', () => {
    expect(sumCadMinorUnits([10_001, -1, 35])).toEqual({
      status: 'calculated',
      money: { currency: 'CAD', minorUnits: 10_035 },
    });

    expect(sumCadMinorUnits([Number.MAX_SAFE_INTEGER, 1])).toEqual({
      status: 'rejected',
      safeError: {
        code: 'cad-total-out-of-range',
        message: 'The CAD total is outside the supported range.',
      },
    });
  });

  it.each(['cyclic', 'too-deep'] as const)(
    'fails closed for %s hostile input',
    (kind) => {
      let input: unknown[] = [];
      if (kind === 'cyclic') {
        input.push(input);
      } else {
        let nested: unknown = 1;
        for (let depth = 0; depth < 80; depth += 1) nested = [nested];
        input = [nested];
      }

      expect(sumCadMinorUnits(input)).toMatchObject({
        status: 'rejected',
        safeError: { code: 'invalid-cad-total-input' },
      });
    },
  );

  it('rejects inherited array index accessors without invoking them', () => {
    let accessed = false;
    const input = new Array<number>(1);
    const prototype = Object.create(Array.prototype, {
      0: {
        configurable: true,
        enumerable: true,
        get() {
          accessed = true;
          return 100;
        },
      },
    });
    Object.setPrototypeOf(input, prototype);

    expect(sumCadMinorUnits(input)).toMatchObject({
      status: 'rejected',
      safeError: { code: 'invalid-cad-total-input' },
    });
    expect(accessed).toBe(false);
  });
});

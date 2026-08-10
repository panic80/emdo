import { deepFreeze, type DeepReadonly } from '@emdo/contracts';
import { z } from 'zod';

import {
  boundedFinanceParse,
  financeSafeError,
  type FinanceSafeError,
} from './guard.js';

export const CadMinorUnitsSchema = z.number().int().safe();
export const NonnegativeCadMinorUnitsSchema = CadMinorUnitsSchema.nonnegative();
export const CadMoneySchema = z
  .strictObject({
    currency: z.literal('CAD'),
    minorUnits: CadMinorUnitsSchema,
  })
  .transform(deepFreeze);

export type CadMoney = DeepReadonly<z.output<typeof CadMoneySchema>>;

export type CadCalculationResult =
  | DeepReadonly<{ status: 'parsed' | 'calculated'; money: CadMoney }>
  | DeepReadonly<{ status: 'rejected'; safeError: FinanceSafeError }>;

const rejectedCadAmount = (): CadCalculationResult =>
  deepFreeze({
    status: 'rejected' as const,
    safeError: financeSafeError(
      'invalid-cad-amount',
      'Enter a valid CAD amount with no more than two decimals.',
    ),
  });

/** Accepts text only so a binary floating-point value never enters parsing. */
export const parseCadDecimal = (input: unknown): CadCalculationResult => {
  if (typeof input !== 'string' || input.length > 64) {
    return rejectedCadAmount();
  }

  let source = input.trim();
  let negativeByParentheses = false;
  if (source.startsWith('(') && source.endsWith(')')) {
    negativeByParentheses = true;
    source = source.slice(1, -1).trim();
  } else if (source.includes('(') || source.includes(')')) {
    return rejectedCadAmount();
  }

  if (source.startsWith('$')) source = source.slice(1);
  const match = /^([+-]?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(
    source,
  );
  if (match === null || (negativeByParentheses && match[1] !== '')) {
    return rejectedCadAmount();
  }

  try {
    const whole = BigInt(match[2]!.replaceAll(',', ''));
    const fractionText = (match[3] ?? '').padEnd(2, '0');
    const fraction = BigInt(fractionText === '' ? '0' : fractionText);
    const sign = negativeByParentheses || match[1] === '-' ? -1n : 1n;
    const minorUnits = sign * (whole * 100n + fraction);
    if (
      minorUnits > BigInt(Number.MAX_SAFE_INTEGER) ||
      minorUnits < BigInt(Number.MIN_SAFE_INTEGER)
    ) {
      return rejectedCadAmount();
    }

    return deepFreeze({
      status: 'parsed' as const,
      money: CadMoneySchema.parse({
        currency: 'CAD',
        minorUnits: Number(minorUnits),
      }),
    });
  } catch {
    return rejectedCadAmount();
  }
};

const CadMinorUnitListSchema = z.array(CadMinorUnitsSchema).max(100_000);

export const sumCadMinorUnits = (input: unknown): CadCalculationResult => {
  const parsed = boundedFinanceParse(CadMinorUnitListSchema, input);
  if (!parsed.success) {
    return deepFreeze({
      status: 'rejected' as const,
      safeError: financeSafeError(
        'invalid-cad-total-input',
        'The CAD amounts could not be calculated safely.',
      ),
    });
  }

  const total = parsed.data.reduce(
    (running, value) => running + BigInt(value),
    0n,
  );
  if (
    total > BigInt(Number.MAX_SAFE_INTEGER) ||
    total < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    return deepFreeze({
      status: 'rejected' as const,
      safeError: financeSafeError(
        'cad-total-out-of-range',
        'The CAD total is outside the supported range.',
      ),
    });
  }

  return deepFreeze({
    status: 'calculated' as const,
    money: CadMoneySchema.parse({
      currency: 'CAD',
      minorUnits: Number(total),
    }),
  });
};

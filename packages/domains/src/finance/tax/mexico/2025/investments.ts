import { z } from 'zod';
import { deepFreeze } from '@emdo/contracts';
import { decimal, plus, q, times, serialize } from './exact.js';

/** INEGI monthly indices; each value is pinned to its original monthly bulletin. */
export const MEXICO_2025_INVESTMENT_INPC = deepFreeze([
  '138.343',
  '138.726',
  '139.161',
  '139.620',
  '140.012',
  '140.405',
  '140.780',
  '140.867',
  '141.197',
  '141.708',
  '142.645',
] as const);
export const MEXICO_2025_INVESTMENT_REFERENCE_IDS = deepFreeze([
  'sat-mx-lisr-articulo-31',
  'sat-mx-lisr-articulo-34',
  'sat-mx-cff-articulo-17a',
  ...MEXICO_2025_INVESTMENT_INPC.map(
    (_, index) => `inegi-mx-inpc-2025-${String(index + 1).padStart(2, '0')}`,
  ),
]);
const AssetSchema = z
  .strictObject({
    assetId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    assetClass: z.enum(['office-furniture-equipment', 'computer-equipment']),
    acquisitionDate: z.iso.date().regex(/^2025-/),
    firstUseDate: z.iso.date().regex(/^2025-(?:0[1-9]|1[01])-01$/),
    originalInvestment: z
      .string()
      .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/)
      .max(100),
  })
  .superRefine((asset, context) => {
    if (asset.acquisitionDate > asset.firstUseDate)
      context.addIssue({
        code: 'custom',
        message: 'Acquisition must not follow first use.',
      });
    if (decimal(asset.originalInvestment).n <= 0n)
      context.addIssue({
        code: 'custom',
        message: 'Positive original investment required.',
      });
  });
const AssetsSchema = z
  .array(AssetSchema)
  .max(10)
  .superRefine((assets, context) => {
    if (new Set(assets.map((asset) => asset.assetId)).size !== assets.length)
      context.addIssue({
        code: 'custom',
        message: 'Asset identifiers must be unique.',
      });
  });

/**
 * First-year ordinary maximum-rate assets only. All full-month periods start
 * on a month boundary and continue through December; no implicit disposal,
 * mixed use, deferred start, prior deduction or special-election assumptions.
 */
export function calculateMexico2025Investments(rowsJson: string) {
  const assets = AssetsSchema.parse(JSON.parse(rowsJson) as unknown);
  const rows = assets.map((asset) => {
    const startMonth = Number(asset.firstUseDate.slice(5, 7));
    const acquisitionMonth = Number(asset.acquisitionDate.slice(5, 7));
    const fullMonths = 13 - startMonth;
    // Article 31: for odd periods omit the middle month from the first half.
    const firstHalfLastMonth = startMonth + Math.floor(fullMonths / 2) - 1;
    const original = decimal(asset.originalInvestment);
    const rate = asset.assetClass === 'computer-equipment' ? 30n : 10n;
    const unadjustedDeduction = times(
      original,
      rate * BigInt(fullMonths),
      1200n,
    );
    const acquisitionIndex = decimal(
      MEXICO_2025_INVESTMENT_INPC[acquisitionMonth - 1]!,
    );
    const firstHalfIndex = decimal(
      MEXICO_2025_INVESTMENT_INPC[firstHalfLastMonth - 1]!,
    );
    const ratio = q(
      firstHalfIndex.n * acquisitionIndex.d,
      firstHalfIndex.d * acquisitionIndex.n,
    );
    // CFF 17-A ten-thousandths: preserve the unreduced ratio separately.
    const factor = q((ratio.n * 10000n) / ratio.d, 10000n);
    const adjustedDeduction = times(unadjustedDeduction, factor.n, factor.d);
    return {
      asset,
      fullMonths,
      ratePercent: rate.toString(),
      firstHalfLastMonth,
      acquisitionIndex: MEXICO_2025_INVESTMENT_INPC[acquisitionMonth - 1]!,
      firstHalfIndex: MEXICO_2025_INVESTMENT_INPC[firstHalfLastMonth - 1]!,
      unroundedFactor: serialize(ratio),
      factor: serialize(factor),
      unadjustedDeduction: serialize(unadjustedDeduction),
      adjustedDeduction: serialize(adjustedDeduction),
      referenceIds: [
        'sat-mx-lisr-articulo-31',
        'sat-mx-lisr-articulo-34',
        'sat-mx-cff-articulo-17a',
        ...new Set(
          [acquisitionMonth, firstHalfLastMonth].map(
            (month) => `inegi-mx-inpc-2025-${String(month).padStart(2, '0')}`,
          ),
        ),
      ],
    };
  });
  const originalInvestment = plus(
    ...assets.map((asset) => decimal(asset.originalInvestment)),
  );
  const unadjustedDeduction = plus(
    ...rows.map((row) =>
      q(
        BigInt(row.unadjustedDeduction.numerator),
        BigInt(row.unadjustedDeduction.denominator),
      ),
    ),
  );
  const adjustedDeduction = plus(
    ...rows.map((row) =>
      q(
        BigInt(row.adjustedDeduction.numerator),
        BigInt(row.adjustedDeduction.denominator),
      ),
    ),
  );
  return deepFreeze({
    rows,
    originalInvestment,
    unadjustedDeduction,
    adjustedDeduction,
  });
}

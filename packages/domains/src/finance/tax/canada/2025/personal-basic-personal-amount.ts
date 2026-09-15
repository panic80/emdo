import { deepFreeze } from '@emdo/contracts';
import {
  decimal as money,
  minus,
  plus,
  positive,
  rational,
  serialize,
  compare,
  type PersonalExact,
} from './personal-exact.js';
import { CANADA_ON_2025_SOURCES } from './readiness.js';

/** A ratio has no CAD unit and must never be serialized as a monetary amount. */
export type Canada2025DimensionlessExact = Readonly<{
  kind: 'dimensionless-ratio';
  n: bigint;
  d: bigint;
  provenance: Canada2025DimensionlessProvenance;
}>;

export type Canada2025DimensionlessProvenance = Readonly<{
  kind: 'dimensionless-ratio';
  sourceId: string;
  documentHash: string;
  locator: string;
  operation: 'line5-divided-by-line6';
  rounding: 'none-specified';
}>;

const worksheetSource = CANADA_ON_2025_SOURCES.find(
  (source) => source.id === 'cra-5000-d1-2025-etext',
)!;

/** The source record used by every line of the 2025 federal BPA worksheet. */
export const CANADA_2025_FEDERAL_BPA_WORKSHEET_PROVENANCE = deepFreeze({
  kind: 'dimensionless-ratio' as const,
  sourceId: worksheetSource.id,
  documentHash: worksheetSource.documentHash,
  locator: '5000-D1 E (25), p4, Line 30000 lines 3-9: line 5 divided by line 6',
  operation: 'line5-divided-by-line6' as const,
  rounding: 'none-specified' as const,
});

function canonical(n: bigint, d: bigint) {
  if (d === 0n) throw Error('dimensionless-zero-denominator');
  if (n === 0n) return { n: 0n, d: 1n };
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  let a = n < 0n ? -n : n,
    b = d;
  while (b) [a, b] = [b, a % b];
  return { n: n / a, d: d / a };
}

/** Divide two exact monetary worksheet quantities and retain the ratio's unit. */
export function divideAmountsToDimensionless(
  numerator: PersonalExact,
  denominator: PersonalExact,
  provenance: Canada2025DimensionlessProvenance,
): Canada2025DimensionlessExact {
  const value = canonical(
    numerator.n * denominator.d,
    numerator.d * denominator.n,
  );
  return deepFreeze({
    kind: 'dimensionless-ratio',
    ...value,
    provenance,
  });
}

/** Apply an exact dimensionless factor to a monetary amount. */
export function multiplyAmountByDimensionless(
  amount: PersonalExact,
  ratio: Canada2025DimensionlessExact,
): PersonalExact {
  return rational(amount.n * ratio.n, amount.d * ratio.d);
}

export function serializeDimensionlessRatio(
  ratio: Canada2025DimensionlessExact,
) {
  const serialized = serialize(rational(ratio.n, ratio.d));
  return deepFreeze({
    kind: ratio.kind,
    unit: 'dimensionless' as const,
    exactRational: serialized.exactRational,
    exactDecimal: serialized.exactDecimal,
    provenance: ratio.provenance,
  });
}

type Canada2025FederalBpaPhaseoutWorksheet = Readonly<{
  line1: PersonalExact;
  line2: PersonalExact;
  line3: PersonalExact;
  line4: PersonalExact;
  line5: PersonalExact;
  line6: PersonalExact;
  line7: Canada2025DimensionlessExact;
  line8: PersonalExact;
  line9: PersonalExact;
  line10: PersonalExact;
  line11: PersonalExact;
}>;

export type Canada2025FederalBasicPersonalAmountCalculation = Readonly<{
  branch: 'maximum' | 'phaseout' | 'minimum';
  amount: PersonalExact;
  worksheet: Canada2025FederalBpaPhaseoutWorksheet | null;
}>;

/**
 * CRA 5000-D1 (25), line 30000. The phaseout ratio is line 5 / line 6,
 * retained as a dimensionless exact value. The annual worksheet does not
 * establish an intermediate cents rule, so no ratio or monetary line is
 * rounded here.
 */
export function calculateCanada2025FederalBasicPersonalAmount(
  netIncome: PersonalExact,
): Canada2025FederalBasicPersonalAmountCalculation {
  const maximum = money('16129');
  if (compare(netIncome, money('177882')) <= 0n)
    return deepFreeze({ branch: 'maximum', amount: maximum, worksheet: null });
  const minimum = money('14538');
  if (compare(netIncome, money('253414')) >= 0n)
    return deepFreeze({ branch: 'minimum', amount: minimum, worksheet: null });

  const line1 = minimum;
  const line2 = money('1591');
  const line3 = netIncome;
  const line4 = money('177882');
  const line5 = minus(line3, line4);
  const line6 = money('75532');
  const line7 = divideAmountsToDimensionless(
    line5,
    line6,
    CANADA_2025_FEDERAL_BPA_WORKSHEET_PROVENANCE,
  );
  const line8 = line2;
  const line9 = multiplyAmountByDimensionless(line8, line7);
  const line10 = positive(minus(line2, line9));
  const line11 = plus(line1, line10);
  return deepFreeze({
    branch: 'phaseout',
    amount: line11,
    worksheet: {
      line1,
      line2,
      line3,
      line4,
      line5,
      line6,
      line7,
      line8,
      line9,
      line10,
      line11,
    },
  });
}

/** JSON-safe working-paper evidence for the exact calculation and its source. */
export function serializeCanada2025FederalBasicPersonalAmount(
  calculation: Canada2025FederalBasicPersonalAmountCalculation,
) {
  const worksheet = calculation.worksheet;
  return deepFreeze({
    branch: calculation.branch,
    amount: serialize(calculation.amount),
    worksheet: worksheet
      ? {
          line1: serialize(worksheet.line1),
          line2: serialize(worksheet.line2),
          line3: serialize(worksheet.line3),
          line4: serialize(worksheet.line4),
          line5: serialize(worksheet.line5),
          line6: serialize(worksheet.line6),
          line7: serializeDimensionlessRatio(worksheet.line7),
          line8: serialize(worksheet.line8),
          line9: serialize(worksheet.line9),
          line10: serialize(worksheet.line10),
          line11: serialize(worksheet.line11),
        }
      : null,
    provenance: CANADA_2025_FEDERAL_BPA_WORKSHEET_PROVENANCE,
    reporting: {
      ratio: worksheet
        ? ('dimensionless-not-reportable' as const)
        : ('not-applicable' as const),
      annualRounding: 'unestablished' as const,
    },
  });
}

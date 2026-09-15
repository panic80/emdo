import {
  deepFreeze,
  FinanceCanadaOntario2025ComponentInputSchema,
} from '@emdo/contracts';
import {
  DECIMAL_SCALE,
  parseFinanceDecimal,
  formatFinanceDecimal,
} from '../../../decimal.js';
import {
  CANADA_ON_2025_READINESS,
  CANADA_ON_2025_SOURCES,
} from './readiness.js';

type Column = {
  maximum: string | null;
  threshold: string;
  rate: string;
  base: string;
};
/** Published annual form columns, including the printed base amounts. Not payroll tables. */
export const CANADA_2025_FEDERAL_FORM_COLUMNS = deepFreeze([
  { maximum: '57375', threshold: '0', rate: '0.145', base: '0' },
  { maximum: '114750', threshold: '57375', rate: '0.205', base: '8319.38' },
  { maximum: '177882', threshold: '114750', rate: '0.26', base: '20081.25' },
  { maximum: '253414', threshold: '177882', rate: '0.29', base: '36495.57' },
  { maximum: null, threshold: '253414', rate: '0.33', base: '58399.85' },
] satisfies Column[]);
export const ONTARIO_2025_FORM_COLUMNS = deepFreeze([
  { maximum: '52886', threshold: '0', rate: '0.0505', base: '0' },
  { maximum: '105775', threshold: '52886', rate: '0.0915', base: '2670.74' },
  { maximum: '150000', threshold: '105775', rate: '0.1116', base: '7510.09' },
  { maximum: '220000', threshold: '150000', rate: '0.1216', base: '12445.60' },
  { maximum: null, threshold: '220000', rate: '0.1316', base: '20957.60' },
] satisfies Column[]);

const positive = (amount: bigint) => (amount > 0n ? amount : 0n);
/** Inputs have at most two decimal places, rates at most four: all products are exact at scale 12. */
const multiply = (amount: bigint, rate: string) =>
  (amount * parseFinanceDecimal(rate)) / DECIMAL_SCALE;
function formColumn(income: bigint, columns: readonly Column[]) {
  const index = columns.findIndex(
    (column) =>
      column.maximum === null || income <= parseFinanceDecimal(column.maximum),
  );
  const column = columns[index]!;
  const excess = positive(income - parseFinanceDecimal(column.threshold));
  const product = multiply(excess, column.rate);
  return {
    column: index + 1,
    threshold: column.threshold,
    rate: column.rate,
    publishedBaseAmount: column.base,
    incomeAboveThreshold: formatFinanceDecimal(excess),
    exactProduct: formatFinanceDecimal(product),
    exactAmount: formatFinanceDecimal(
      product + parseFinanceDecimal(column.base),
    ),
  };
}

function healthPremium(income: bigint) {
  const bands = [
    { maximum: '20000', threshold: '0', rate: '0', base: '0' },
    { maximum: '25000', threshold: '20000', rate: '0.06', base: '0' },
    { maximum: '36000', threshold: '25000', rate: '0', base: '300' },
    { maximum: '38500', threshold: '36000', rate: '0.06', base: '300' },
    { maximum: '48000', threshold: '38500', rate: '0', base: '450' },
    { maximum: '48600', threshold: '48000', rate: '0.25', base: '450' },
    { maximum: '72000', threshold: '48600', rate: '0', base: '600' },
    { maximum: '72600', threshold: '72000', rate: '0.25', base: '600' },
    { maximum: '200000', threshold: '72600', rate: '0', base: '750' },
    { maximum: '200600', threshold: '200000', rate: '0.25', base: '750' },
    { maximum: null, threshold: '200600', rate: '0', base: '900' },
  ];
  return formColumn(income, bands);
}

/**
 * Executable sourced arithmetic, deliberately outside the full-return registry.
 * No credit eligibility, line 26000 derivation, final return rounding or liability is implied.
 */
export function calculateCanadaOntario2025Components(input: unknown) {
  const facts = FinanceCanadaOntario2025ComponentInputSchema.parse(input);
  const income = parseFinanceDecimal(facts.taxableIncomeLine26000);
  const component = (
    ruleId: string,
    locator: string,
    referenceIndex: number,
    calculation: ReturnType<typeof formColumn>,
  ) => ({
    ruleId,
    sourceId: CANADA_ON_2025_SOURCES[referenceIndex]!.id,
    sourceLocator: locator,
    exactAmount: calculation.exactAmount,
    calculation,
    reportableAmount: null,
    status: 'rounding-review-required' as const,
  });
  const components = {
    federalTaxOnTaxableIncome: component(
      'ca-2025-t1-tax-on-taxable-income',
      'T1 page 5, lines 70-76',
      0,
      formColumn(income, CANADA_2025_FEDERAL_FORM_COLUMNS),
    ),
    ontarioTaxOnTaxableIncome: component(
      'ca-on-2025-tax-on-taxable-income',
      'ON428 page 1, lines 1-8',
      1,
      formColumn(income, ONTARIO_2025_FORM_COLUMNS),
    ),
    ontarioHealthPremium: component(
      'ca-on-2025-health-premium',
      'ON428 page 4, line 89 chart',
      1,
      healthPremium(income),
    ),
    ontarioSurtax: facts.ontarioSurtaxInputs
      ? (() => {
          const line65 = positive(
            parseFinanceDecimal(facts.ontarioSurtaxInputs.line62) -
              parseFinanceDecimal(
                facts.ontarioSurtaxInputs.taxOnSplitIncomeLine54,
              ),
          );
          const line66 = multiply(
            positive(line65 - parseFinanceDecimal('5710')),
            '0.20',
          );
          const line67 = multiply(
            positive(line65 - parseFinanceDecimal('7307')),
            '0.36',
          );
          return {
            ruleId: 'ca-on-2025-surtax',
            sourceId: CANADA_ON_2025_SOURCES[1].id,
            sourceLocator: 'ON428 page 3, lines 63-68',
            exactAmount: formatFinanceDecimal(line66 + line67),
            calculation: {
              line65: formatFinanceDecimal(line65),
              line66: formatFinanceDecimal(line66),
              line67: formatFinanceDecimal(line67),
            },
            reportableAmount: null,
            status: 'rounding-review-required' as const,
          };
        })()
      : null,
  };
  return deepFreeze({
    status: 'components-only' as const,
    complete: false as const,
    currency: 'CAD' as const,
    rulesVersion: CANADA_ON_2025_READINESS.version,
    scope: facts.scope,
    inputs: facts,
    components,
    sources: CANADA_ON_2025_SOURCES,
    releaseBlockerIds: CANADA_ON_2025_READINESS.releaseBlockers.map(
      (blocker) => blocker.id,
    ),
    missingComponentInputs: facts.ontarioSurtaxInputs
      ? []
      : [
          'ontarioSurtaxInputs.line62',
          'ontarioSurtaxInputs.taxOnSplitIncomeLine54',
        ],
  });
}

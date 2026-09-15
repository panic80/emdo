import { z } from 'zod';
import {
  FinanceCurrencySchema,
  FinanceNormalizedAmountComponentProvenanceSchema,
  FinanceNormalizedAmountComponentReviewListSchema,
  FinanceNormalizedAmountComponentSourceSchema,
  type FinanceCurrency,
  type FinanceNormalizedAmountComponentKind,
  type FinanceNormalizedAmountComponentReview,
  type FinanceNormalizedAmountComponentSource,
} from '@emdo/contracts';
import {
  convertBookAmount,
  formatFinanceDecimal,
  moneyValue,
  parseFinanceDecimal,
} from './decimal.js';

export const FINANCE_NORMALIZED_AMOUNT_COMPONENT_KINDS = [
  'fee',
  'commission',
  'tax',
  'principal',
  'interest',
] as const satisfies readonly FinanceNormalizedAmountComponentKind[];

const NormalizedReportRowSchema = z.object({
  sourceRow: z.number().int().positive(),
  fields: z.record(z.string(), z.string().nullable()),
  provenance: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Extracts typed component observations from a normalized report row. The
 * source amount, currency, raw value, and field provenance remain immutable;
 * this function creates no account, side, inclusion, or FX authority.
 */
export function extractFinanceNormalizedAmountComponents(
  input: unknown,
): FinanceNormalizedAmountComponentSource[] {
  const row = NormalizedReportRowSchema.parse(input),
    currencyValue = row.fields.currency;
  if (currencyValue === undefined || currencyValue === null)
    throw new Error('finance-import-component-currency-missing');
  const currency = FinanceCurrencySchema.parse(currencyValue);
  return FINANCE_NORMALIZED_AMOUNT_COMPONENT_KINDS.flatMap((kind) => {
    const nativeAmount = row.fields[kind];
    if (nativeAmount === undefined || nativeAmount === null) return [];
    const provenance = row.provenance?.[kind];
    if (!provenance || typeof provenance !== 'object' || provenance === null)
      throw new Error('finance-import-component-provenance-missing');
    const sourceProvenance =
      FinanceNormalizedAmountComponentProvenanceSchema.parse({
        ...provenance,
        sourceRow: row.sourceRow,
        field: kind,
      });
    const source: FinanceNormalizedAmountComponentSource = {
      kind,
      nativeAmount: formatFinanceDecimal(moneyValue(nativeAmount, currency)),
      currency,
      provenance: {
        ...sourceProvenance,
      },
    };
    return [FinanceNormalizedAmountComponentSourceSchema.parse(source)];
  });
}

export interface FinancePreparedNormalizedAmountComponent {
  readonly source: FinanceNormalizedAmountComponentSource;
  readonly review: FinanceNormalizedAmountComponentReview;
  /** Signed source value after the explicit reviewed FX conversion. */
  readonly functionalAmount: string;
  /** Signed contribution to the journal balance determined by reviewed side. */
  readonly contribution: bigint;
}

export interface PrepareFinanceNormalizedAmountComponentsInput {
  readonly sources: unknown;
  readonly reviews: unknown;
  readonly rowAmount: string;
  readonly rowCurrency: FinanceCurrency;
  readonly rowFxRate: string;
  readonly functionalCurrency: FinanceCurrency;
}

const absolute = (value: bigint) => (value < 0n ? -value : value);

/**
 * Validates reviewed component mappings and proves that included components
 * exactly account for the signed cash movement. Excluded components are
 * intentionally blocked until a separate gross/settlement leg is supplied;
 * silently dropping them would change the accounting meaning of the source.
 */
export function prepareFinanceNormalizedAmountComponents(
  input: PrepareFinanceNormalizedAmountComponentsInput,
): FinancePreparedNormalizedAmountComponent[] {
  const sources = z
      .array(FinanceNormalizedAmountComponentSourceSchema)
      .parse(input.sources),
    reviews = FinanceNormalizedAmountComponentReviewListSchema.parse(
      input.reviews,
    );
  if (sources.length !== reviews.length)
    throw new Error('finance-import-components-review-required');
  const sourceByKind = new Map(sources.map((source) => [source.kind, source]));
  moneyValue(input.rowAmount, input.rowCurrency);
  const rowFunctional = parseFinanceDecimal(
    convertBookAmount(
      input.rowAmount,
      input.rowFxRate,
      input.functionalCurrency,
    ),
  );
  const prepared: FinancePreparedNormalizedAmountComponent[] = [];
  let contribution = 0n;
  for (const review of reviews) {
    const source = sourceByKind.get(review.kind);
    if (!source) throw new Error('finance-import-component-kind-mismatch');
    const native = moneyValue(review.nativeAmount, review.currency),
      rate = parseFinanceDecimal(review.fxRate);
    if (rate <= 0n) throw new Error('finance-import-component-fx-invalid');
    if (
      review.currency === input.functionalCurrency &&
      (rate !== 1_000_000_000_000n || review.fxSource !== 'identity')
    )
      throw new Error('finance-import-component-identity-fx-invalid');
    if (
      review.currency !== input.functionalCurrency &&
      review.fxSource === 'identity'
    )
      throw new Error('finance-import-component-cross-currency-identity');
    if (review.inclusion !== 'included-in-net')
      throw new Error('finance-import-component-net-treatment-unsupported');
    const functionalAmount = convertBookAmount(
        review.nativeAmount,
        review.fxRate,
        input.functionalCurrency,
      ),
      functional = parseFinanceDecimal(functionalAmount),
      magnitude = absolute(functional);
    if (native !== 0n && magnitude === 0n)
      throw new Error('finance-import-component-zero-functional-amount');
    const signedContribution =
      review.postingSide === 'debit' ? magnitude : -magnitude;
    contribution += signedContribution;
    prepared.push({
      source,
      review,
      functionalAmount,
      contribution: signedContribution,
    });
  }
  // The cash row's signed functional movement must be exactly offset by the
  // explicitly reviewed component sides. No residual account is invented.
  if (contribution !== -rowFunctional)
    throw new Error('finance-import-component-net-mismatch');
  return prepared;
}

import {
  FinanceCashDividendAmountSchema,
  FinanceCashDividendDraftSchema,
  type FinanceCashDividendAmountKind,
  type FinanceCashDividendBlockedReason,
  type FinanceCashDividendSourceSnapshot,
  type FinanceCurrency,
} from '@emdo/contracts/browser';
import { convertBookAmount } from '@emdo/domains/finance/decimal';

export const dividendAmountKinds = ['gross', 'withholding', 'net'] as const;
export const dividendAmountLabels = {
  gross: 'Gross dividend',
  withholding: 'Withholding tax',
  net: 'Net cash received',
};
export type DividendAmountEntry = {
  nativeAmount: string;
  currency: FinanceCurrency | '';
  fxRate: string;
  fxSource: string;
  raw: string;
  locationKind: 'column' | 'section';
  location: string;
};
export type DividendReviewEntry = {
  declaredOn: string;
  exDate: string;
  payableOn: string;
  sourceReference: string;
  reviewReason: string;
  incomeAccountId: string;
  withholdingAccountId: string;
  amounts: Record<FinanceCashDividendAmountKind, DividendAmountEntry>;
};
const emptyAmount = (): DividendAmountEntry => ({
  nativeAmount: '',
  currency: '',
  fxRate: '',
  fxSource: '',
  raw: '',
  locationKind: 'column',
  location: '',
});
export function emptyDividendReview(
  source: FinanceCashDividendSourceSnapshot,
): DividendReviewEntry {
  return {
    declaredOn: '',
    exDate: '',
    payableOn: source.effectiveOn ?? '',
    sourceReference: '',
    reviewReason: '',
    incomeAccountId: '',
    withholdingAccountId: '',
    amounts: {
      gross: emptyAmount(),
      withholding: emptyAmount(),
      net: {
        ...emptyAmount(),
        nativeAmount: source.nativeAmount ?? '',
        currency: source.currency,
        fxRate: source.fxRate ?? '',
        fxSource: source.fxSource ?? '',
      },
    },
  };
}
export function dividendFunctionalAmount(
  entry: DividendAmountEntry,
  currency: FinanceCurrency,
) {
  if (!entry.nativeAmount.trim() || !entry.fxRate.trim()) return null;
  try {
    return convertBookAmount(entry.nativeAmount, entry.fxRate, currency);
  } catch {
    return null;
  }
}
export function dividendDraftFromReview(
  entry: DividendReviewEntry,
  source: FinanceCashDividendSourceSnapshot,
  actionId: string,
) {
  const amount = (kind: FinanceCashDividendAmountKind) => {
    const input = entry.amounts[kind];
    if (!input.nativeAmount.trim()) return null;
    if (!input.raw.trim() || !input.location.trim())
      throw new Error(
        `Record the exact original value and its source location for ${dividendAmountLabels[kind].toLowerCase()}.`,
      );
    const parsed = FinanceCashDividendAmountSchema.safeParse({
      nativeAmount: input.nativeAmount.trim(),
      currency: input.currency,
      functionalAmount: dividendFunctionalAmount(
        input,
        source.functionalCurrency,
      ),
      fxRate: input.fxRate.trim(),
      fxSource: input.fxSource.trim(),
      provenance: {
        sourceRow: source.sourceRow,
        field: kind,
        raw: input.raw,
        column: input.locationKind === 'column' ? input.location : null,
        contextAnchor: input.locationKind === 'section' ? input.location : null,
      },
    });
    if (!parsed.success)
      throw new Error(
        `Check the amount, currency, positive exchange rate and source details for ${dividendAmountLabels[kind].toLowerCase()}.`,
      );
    return parsed.data;
  };
  return FinanceCashDividendDraftSchema.parse({
    id: actionId,
    actionType: 'cash-dividend',
    sourceRowId: source.sourceRowId,
    financialAccountId: source.financialAccountId,
    instrumentId: source.instrumentId,
    evidenceId: source.evidenceId,
    declaredOn: entry.declaredOn,
    exDate: entry.exDate || null,
    payableOn: entry.payableOn,
    sourceReference: entry.sourceReference,
    reviewReason: entry.reviewReason,
    gross: amount('gross'),
    withholding: amount('withholding'),
    net: amount('net'),
    ledger: {
      cashLedgerAccountId: source.financialAccountLedgerId,
      dividendIncomeLedgerAccountId: entry.incomeAccountId,
      withholdingLedgerAccountId: entry.withholdingAccountId,
    },
  });
}
export const dividendBlockedCopy: Record<
  FinanceCashDividendBlockedReason,
  string
> = {
  'source-row-unavailable': 'The selected statement row is unavailable.',
  'source-row-not-ready':
    'Review this statement row in Documents before posting a dividend.',
  'source-row-already-committed': 'This statement row has already been posted.',
  'source-row-not-cash-inflow': 'The source must be a positive cash receipt.',
  'source-row-currency-mismatch':
    'The currency does not match the statement row.',
  'source-row-amount-mismatch': 'Net cash must equal the statement receipt.',
  'source-row-date-mismatch':
    'The payment date must match the statement receipt date.',
  'source-evidence-mismatch':
    'The original document does not match this source row.',
  'source-account-mismatch':
    'The financial account does not match this source row.',
  'source-instrument-mismatch':
    'The investment does not match the selected source.',
  'source-facts-missing':
    'The statement still has missing or unresolved facts.',
  'amount-provenance-mismatch':
    'Each amount must identify its exact meaning and original row.',
  'native-reconciliation-mismatch':
    'Gross less withholding must equal net cash in the original currency.',
  'gross-not-positive': 'Gross dividend must be positive.',
  'gross-required': 'Enter the gross dividend from the original.',
  'withholding-required':
    'Enter withholding tax explicitly, including a supported zero.',
  'net-required': 'The net cash receipt is required.',
  'gross-functional-mismatch':
    'The gross dividend does not match its reviewed exchange rate.',
  'withholding-functional-mismatch':
    'Withholding tax does not match its reviewed exchange rate.',
  'net-functional-mismatch':
    'Net cash does not match its reviewed exchange rate.',
  'functional-reconciliation-mismatch':
    'Gross less withholding must equal net cash in the book currency.',
  'cash-ledger-mapping-mismatch':
    'Use the cash ledger account linked to this statement.',
  'ledger-account-mapping-mismatch':
    'Choose separate cash, dividend income and withholding accounts.',
  'fx-mapping-invalid':
    'Review currency and exchange-rate evidence; net cash must retain the statement FX.',
  'dividend-date-invalid':
    'The declared, ex-dividend and payment dates are not in a supported order.',
  'duplicate-source-row':
    'This statement row already belongs to a saved dividend.',
};

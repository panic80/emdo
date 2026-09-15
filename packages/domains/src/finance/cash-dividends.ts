import {
  FinanceCashDividendPlanSchema,
  PlanInvestmentCashDividendSchema,
  type FinanceCashDividendAmount,
  type FinanceCashDividendBlockedReason,
} from '@emdo/contracts';
import {
  convertBookAmount,
  formatFinanceDecimal,
  moneyValue,
  parseFinanceDecimal,
} from './decimal.js';

const uniqueReasons = (
  reasons: FinanceCashDividendBlockedReason[],
): FinanceCashDividendBlockedReason[] => [...new Set(reasons)];

const safeMoneyValue = (
  value: string,
  currency: Parameters<typeof moneyValue>[1],
): bigint | null => {
  try {
    return moneyValue(value, currency);
  } catch {
    return null;
  }
};

const amountKindIs = (
  amount: FinanceCashDividendAmount,
  kind: FinanceCashDividendAmount['provenance']['field'],
) => amount.provenance.field === kind;

/**
 * Plans a reviewed cash dividend without writing to a ledger or changing an
 * import row. The normalized statement row is the authoritative cash receipt;
 * gross, withholding, net, FX, and posting accounts must all be supplied by a
 * reviewer. A model or this planner never fills in a missing component.
 */
export function planInvestmentCashDividend(input: unknown) {
  const data = PlanInvestmentCashDividendSchema.parse(input);
  const { action, source } = data;
  const blockedReasons: FinanceCashDividendBlockedReason[] = [];

  if (action.sourceRowId !== source.sourceRowId)
    blockedReasons.push('source-row-unavailable');
  if (action.evidenceId !== source.evidenceId)
    blockedReasons.push('source-evidence-mismatch');
  if (action.financialAccountId !== source.financialAccountId)
    blockedReasons.push('source-account-mismatch');
  if (action.instrumentId !== source.instrumentId)
    blockedReasons.push('source-instrument-mismatch');

  if (source.status === 'committed')
    blockedReasons.push('source-row-already-committed');
  else if (source.status !== 'ready')
    blockedReasons.push('source-row-not-ready');
  if (source.issues.length > 0) blockedReasons.push('source-facts-missing');

  if (
    action.declaredOn > action.payableOn ||
    (action.exDate !== null &&
      (action.exDate < action.declaredOn || action.exDate > action.payableOn))
  )
    blockedReasons.push('dividend-date-invalid');
  if (source.effectiveOn !== action.payableOn)
    blockedReasons.push('source-row-date-mismatch');

  if (
    source.nativeAmount === null ||
    source.fxRate === null ||
    !source.fxSource
  )
    blockedReasons.push('source-facts-missing');

  const amounts = {
    gross: action.gross,
    withholding: action.withholding,
    net: action.net,
  } as const;
  if (amounts.gross === null) blockedReasons.push('gross-required');
  if (amounts.withholding === null) blockedReasons.push('withholding-required');
  if (amounts.net === null) blockedReasons.push('net-required');

  const functionalAmounts: Record<keyof typeof amounts, string | null> = {
    gross: null,
    withholding: null,
    net: null,
  };
  const nativeValues: Record<keyof typeof amounts, bigint | null> = {
    gross: null,
    withholding: null,
    net: null,
  };
  const functionalValues: Record<keyof typeof amounts, bigint | null> = {
    gross: null,
    withholding: null,
    net: null,
  };

  for (const [kind, amount] of Object.entries(amounts) as Array<
    [keyof typeof amounts, FinanceCashDividendAmount | null]
  >) {
    if (amount === null) continue;
    if (!amountKindIs(amount, kind)) {
      blockedReasons.push('amount-provenance-mismatch');
    }
    if (amount.provenance.sourceRow !== source.sourceRow)
      blockedReasons.push('amount-provenance-mismatch');

    const native = safeMoneyValue(amount.nativeAmount, amount.currency);
    const functional = safeMoneyValue(
      amount.functionalAmount,
      source.functionalCurrency,
    );
    const rate = parseFinanceDecimal(amount.fxRate);
    nativeValues[kind] = native;
    functionalValues[kind] = functional;

    if (native === null || functional === null) {
      blockedReasons.push('source-facts-missing');
      continue;
    }
    if (rate <= 0n || !amount.fxSource.trim()) {
      blockedReasons.push('fx-mapping-invalid');
      continue;
    }
    if (amount.currency === source.functionalCurrency) {
      if (rate !== 1_000_000_000_000n || amount.fxSource !== 'identity')
        blockedReasons.push('fx-mapping-invalid');
    } else if (amount.fxSource === 'identity') {
      blockedReasons.push('fx-mapping-invalid');
    }

    let expectedFunctional: bigint | null = null;
    try {
      expectedFunctional = safeMoneyValue(
        convertBookAmount(
          amount.nativeAmount,
          amount.fxRate,
          source.functionalCurrency,
        ),
        source.functionalCurrency,
      );
    } catch {
      expectedFunctional = null;
    }
    if (expectedFunctional === null || expectedFunctional !== functional)
      blockedReasons.push(
        `${kind}-functional-mismatch` as FinanceCashDividendBlockedReason,
      );
    else functionalAmounts[kind] = formatFinanceDecimal(functional);
  }

  const gross = amounts.gross;
  const withholding = amounts.withholding;
  const net = amounts.net;
  if (gross !== null && withholding !== null && net !== null) {
    if (nativeValues.net !== null && source.nativeAmount !== null) {
      const sourceNative = safeMoneyValue(source.nativeAmount, source.currency);
      if (sourceNative === null || sourceNative <= 0n)
        blockedReasons.push('source-row-not-cash-inflow');
      else if (
        net.currency !== source.currency ||
        nativeValues.net !== sourceNative
      )
        blockedReasons.push('source-row-amount-mismatch');
      if (source.fxRate !== null) {
        let sourceRate: bigint | null = null;
        let netRate: bigint | null = null;
        try {
          sourceRate = parseFinanceDecimal(source.fxRate);
          netRate = parseFinanceDecimal(net.fxRate);
        } catch {
          blockedReasons.push('fx-mapping-invalid');
        }
        if (
          sourceRate === null ||
          netRate === null ||
          sourceRate <= 0n ||
          netRate !== sourceRate ||
          source.fxSource !== net.fxSource
        )
          blockedReasons.push('fx-mapping-invalid');
        if (
          source.currency === source.functionalCurrency &&
          (sourceRate !== 1_000_000_000_000n || source.fxSource !== 'identity')
        )
          blockedReasons.push('fx-mapping-invalid');
        if (
          source.currency !== source.functionalCurrency &&
          source.fxSource === 'identity'
        )
          blockedReasons.push('fx-mapping-invalid');
      }
    }

    const nativeCurrencies = new Set([
      gross.currency,
      withholding.currency,
      net.currency,
    ]);
    if (nativeCurrencies.size === 1) {
      const grossNative = nativeValues.gross;
      const withholdingNative = nativeValues.withholding;
      const netNative = nativeValues.net;
      if (
        grossNative === null ||
        withholdingNative === null ||
        netNative === null ||
        grossNative !== withholdingNative + netNative
      )
        blockedReasons.push('native-reconciliation-mismatch');
    }

    const grossFunctional = functionalValues.gross;
    const withholdingFunctional = functionalValues.withholding;
    const netFunctional = functionalValues.net;
    if (
      grossFunctional === null ||
      withholdingFunctional === null ||
      netFunctional === null ||
      grossFunctional !== withholdingFunctional + netFunctional
    )
      blockedReasons.push('functional-reconciliation-mismatch');
  }

  if (gross !== null && nativeValues.gross === 0n)
    blockedReasons.push('gross-not-positive');
  if (net !== null && nativeValues.net === 0n)
    blockedReasons.push('source-row-not-cash-inflow');
  if (withholding !== null && nativeValues.withholding === null)
    blockedReasons.push('withholding-required');

  const mappings = [
    action.ledger.cashLedgerAccountId,
    action.ledger.dividendIncomeLedgerAccountId,
    action.ledger.withholdingLedgerAccountId,
  ];
  if (action.ledger.cashLedgerAccountId !== source.financialAccountLedgerId)
    blockedReasons.push('cash-ledger-mapping-mismatch');
  if (new Set(mappings).size !== mappings.length)
    blockedReasons.push('ledger-account-mapping-mismatch');

  const normalizedReasons = uniqueReasons(blockedReasons);
  const ready = normalizedReasons.length === 0;
  const journalLines = ready
    ? [
        {
          kind: 'net' as const,
          accountId: action.ledger.cashLedgerAccountId,
          side: 'debit' as const,
          amount: functionalAmounts.net!,
          nativeAmount: net!.nativeAmount,
          currency: net!.currency,
          fxRate: net!.fxRate,
          fxSource: net!.fxSource,
        },
        ...(functionalValues.withholding === 0n
          ? []
          : [
              {
                kind: 'withholding' as const,
                accountId: action.ledger.withholdingLedgerAccountId,
                side: 'debit' as const,
                amount: functionalAmounts.withholding!,
                nativeAmount: withholding!.nativeAmount,
                currency: withholding!.currency,
                fxRate: withholding!.fxRate,
                fxSource: withholding!.fxSource,
              },
            ]),
        {
          kind: 'gross' as const,
          accountId: action.ledger.dividendIncomeLedgerAccountId,
          side: 'credit' as const,
          amount: functionalAmounts.gross!,
          nativeAmount: gross!.nativeAmount,
          currency: gross!.currency,
          fxRate: gross!.fxRate,
          fxSource: gross!.fxSource,
        },
      ]
    : [];

  return FinanceCashDividendPlanSchema.parse({
    calculationVersion: 'investment-cash-dividends.v1',
    action,
    source,
    commitReadiness: ready ? 'ready' : 'blocked',
    blockedReasons: normalizedReasons,
    grossFunctionalAmount: functionalAmounts.gross,
    withholdingFunctionalAmount: functionalAmounts.withholding,
    netFunctionalAmount: functionalAmounts.net,
    journalLines,
  });
}

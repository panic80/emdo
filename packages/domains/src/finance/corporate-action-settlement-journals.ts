import { z } from 'zod';
import {
  FinanceStockSplitActionDateConsiderationSchema,
  FinanceStockSplitSettlementLedgerSchema,
  FinanceStockSplitSettlementPlanSchema,
  type PostJournal,
} from '@emdo/contracts';
import { validateJournal } from './accounting.js';
import {
  DECIMAL_SCALE,
  convertBookAmount,
  formatFinanceDecimal,
  moneyValue,
  parseFinanceDecimal,
} from './decimal.js';

const InputSchema = z.strictObject({
  settlement: FinanceStockSplitSettlementPlanSchema,
  ledger: FinanceStockSplitSettlementLedgerSchema,
  actionDateConsideration:
    FinanceStockSplitActionDateConsiderationSchema.nullable(),
});
const fail = (reason: string): never => {
  throw new Error(`finance-corporate-action-settlement-journals-${reason}`);
};

/** Plans balanced journals only. Database authorization, evidence and period checks remain required. */
export function planStockSplitSettlementJournals(input: unknown) {
  const data = InputSchema.parse(input);
  const { settlement, ledger } = data;
  const currency = settlement.functionalCurrency;
  const receipt = settlement.cashConsideration;
  const cash = moneyValue(receipt.functional.amount, currency);
  const basis = moneyValue(settlement.disposedFunctionalCost, currency);
  if (
    receipt.functional.currency !== currency ||
    receipt.native.currency !== settlement.nativeCurrency ||
    receipt.settledOn !== settlement.settledOn
  )
    fail('settlement-scope-mismatch');
  if (settlement.settledOn < settlement.effectiveOn)
    fail('settlement-before-action');
  const assets = [
    ledger.cashLedgerAccountId,
    ledger.investmentLedgerAccountId,
    ledger.receivableLedgerAccountId,
  ].filter((value): value is string => value !== null);
  const income = [
    ledger.gainLedgerAccountId,
    ledger.fxGainLedgerAccountId,
  ].filter((value): value is string => value !== null);
  const expense = [
    ledger.lossLedgerAccountId,
    ledger.fxLossLedgerAccountId,
  ].filter((value): value is string => value !== null);
  if (
    new Set(assets).size !== assets.length ||
    assets.some((id) => income.includes(id) || expense.includes(id)) ||
    income.some((id) => expense.includes(id))
  )
    fail('ledger-mappings-must-be-distinct');
  const sameDate = settlement.effectiveOn === settlement.settledOn;
  if (!sameDate && data.actionDateConsideration === null)
    fail('action-date-consideration-required');
  if (
    !sameDate &&
    (!ledger.receivableLedgerAccountId ||
      !ledger.fxGainLedgerAccountId ||
      !ledger.fxLossLedgerAccountId)
  )
    fail('settlement-ledger-mapping-required');
  const actionValue = data.actionDateConsideration ?? receipt;
  if (
    actionValue.native.currency !== settlement.nativeCurrency ||
    actionValue.functional.currency !== currency ||
    moneyValue(actionValue.native.amount, actionValue.native.currency) !==
      moneyValue(receipt.native.amount, receipt.native.currency)
  )
    fail('action-date-consideration-mismatch');
  const actionCash = moneyValue(actionValue.functional.amount, currency);

  const validateValue = (value: typeof actionValue) => {
    if (value.native.currency === currency) {
      if (
        moneyValue(value.native.amount, currency) !==
          moneyValue(value.functional.amount, currency) ||
        (value.fx !== null &&
          parseFinanceDecimal(value.fx.rate) !== DECIMAL_SCALE)
      )
        fail('identity-currency-mismatch');
    } else {
      if (value.fx === null) fail('fx-evidence-required');
      if (
        parseFinanceDecimal(value.fx!.rate) <= 0n ||
        moneyValue(
          convertBookAmount(value.native.amount, value.fx!.rate, currency),
          currency,
        ) !== moneyValue(value.functional.amount, currency)
      )
        fail('fx-amount-mismatch');
    }
  };
  validateValue(receipt);
  validateValue(actionValue);
  if (sameDate && actionCash !== cash) fail('same-date-consideration-mismatch');
  const gain = actionCash - basis;
  const fxGain = cash - actionCash;
  const lines: PostJournal['lines'] = [];
  const bookLine = (
    accountId: string,
    side: 'debit' | 'credit',
    amount: bigint,
    description: string,
  ): PostJournal['lines'][number] => ({
    accountId,
    side,
    amount: formatFinanceDecimal(amount),
    currency,
    nativeAmount: formatFinanceDecimal(amount),
    fxRate: '1',
    fxSource: 'functional-book-amount',
    description,
  });
  const cashLine = (
    accountId: string,
    value: typeof actionValue,
    description: string,
  ): PostJournal['lines'][number] => ({
    accountId,
    side: 'debit',
    amount: value.functional.amount,
    currency: value.native.currency,
    nativeAmount: value.native.amount,
    fxRate: value.fx?.rate ?? '1',
    fxSource: value.fx?.source ?? 'identity-currency',
    description,
  });
  lines.push(
    cashLine(
      sameDate ? ledger.cashLedgerAccountId : ledger.receivableLedgerAccountId!,
      actionValue,
      sameDate ? 'Cash in lieu received' : 'Cash in lieu receivable recognized',
    ),
  );
  if (basis > 0n)
    lines.push(
      bookLine(
        ledger.investmentLedgerAccountId,
        'credit',
        basis,
        'Disposed investment book cost',
      ),
    );
  if (gain > 0n)
    lines.push(
      bookLine(
        ledger.gainLedgerAccountId,
        'credit',
        gain,
        'Cash in lieu book gain',
      ),
    );
  if (gain < 0n)
    lines.push(
      bookLine(
        ledger.lossLedgerAccountId,
        'debit',
        -gain,
        'Cash in lieu book loss',
      ),
    );
  const makeJournal = (
    kind: 'direct' | 'recognition' | 'settlement',
    effectiveOn: string,
    journalLines: PostJournal['lines'],
  ) => ({
    kind,
    journal: validateJournal(
      {
        effectiveOn,
        description: `Cash in lieu ${kind}`,
        sourceReference: `corporate-action-settlement:${settlement.actionId}:${kind}`,
        lines: journalLines,
      },
      currency,
    ),
  });
  const journals = [
    makeJournal(
      sameDate ? 'direct' : 'recognition',
      settlement.effectiveOn,
      lines,
    ),
  ];
  if (!sameDate) {
    const settlementLines = [
      cashLine(ledger.cashLedgerAccountId, receipt, 'Cash in lieu received'),
      {
        ...cashLine(
          ledger.receivableLedgerAccountId!,
          actionValue,
          'Cash in lieu receivable cleared',
        ),
        side: 'credit' as const,
      },
    ];
    if (fxGain > 0n)
      settlementLines.push(
        bookLine(
          ledger.fxGainLedgerAccountId!,
          'credit',
          fxGain,
          'Settlement foreign exchange gain',
        ),
      );
    if (fxGain < 0n)
      settlementLines.push(
        bookLine(
          ledger.fxLossLedgerAccountId!,
          'debit',
          -fxGain,
          'Settlement foreign exchange loss',
        ),
      );
    journals.push(
      makeJournal('settlement', settlement.settledOn, settlementLines),
    );
  }
  return {
    actionId: settlement.actionId,
    status: 'validated-plan' as const,
    persistence: 'not-implemented' as const,
    journals,
    actionDateFunctionalConsideration: formatFinanceDecimal(actionCash),
    settlementDateFunctionalConsideration: formatFinanceDecimal(cash),
    bookGainLoss: formatFinanceDecimal(gain),
    fxGainLoss: formatFinanceDecimal(fxGain),
    actionDateConsideration: data.actionDateConsideration,
  };
}

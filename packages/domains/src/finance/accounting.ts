import {
  PostJournalSchema,
  type PostJournal,
  type FinanceCurrency,
} from '@emdo/contracts';
import {
  convertBookAmount,
  moneyValue,
  parseFinanceDecimal,
} from './decimal.js';

export function validateJournal(
  input: unknown,
  functionalCurrency: FinanceCurrency,
): PostJournal {
  const journal = PostJournalSchema.parse(input);
  let balance = 0n;
  for (const line of journal.lines) {
    const amount = moneyValue(line.amount, functionalCurrency);
    const native = moneyValue(line.nativeAmount, line.currency);
    if (amount <= 0n || native <= 0n)
      throw new Error('finance-journal-amount-not-positive');
    if (
      line.currency === functionalCurrency &&
      parseFinanceDecimal(line.fxRate) !== 1_000_000_000_000n
    ) {
      throw new Error('finance-native-currency-rate-must-be-one');
    }
    if (
      parseFinanceDecimal(
        convertBookAmount(line.nativeAmount, line.fxRate, functionalCurrency),
      ) !== amount
    ) {
      throw new Error('finance-journal-fx-mismatch');
    }
    balance += line.side === 'debit' ? amount : -amount;
  }
  if (balance !== 0n) throw new Error('finance-journal-unbalanced');
  return journal;
}

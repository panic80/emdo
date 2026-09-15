import {
  IssueCommercialDocumentSchema,
  type FinanceCurrency,
  type JournalLineInputSchema,
} from '@emdo/contracts';
import type { z } from 'zod';
import { formatFinanceDecimal, moneyValue } from './decimal.js';

/** Source tax amounts are preserved, not inferred from a tax rate or model. */
export function prepareCommercialDocument(
  input: unknown,
  currency: FinanceCurrency,
) {
  const document = IssueCommercialDocumentSchema.parse(input);
  const lines: z.infer<typeof JournalLineInputSchema>[] = [];
  let total = 0n;
  for (const line of document.lines) {
    const net = moneyValue(line.netAmount, currency),
      tax = moneyValue(line.taxAmount, currency);
    if (net <= 0n || tax < 0n || tax > 0n !== (line.taxAccountId !== null))
      throw new Error('finance-commercial-line-invalid');
    if (
      line.accountId === document.controlAccountId ||
      line.taxAccountId === document.controlAccountId
    )
      throw new Error('finance-commercial-control-conflict');
    total += net + tax;
    const base = {
      currency,
      fxRate: '1',
      fxSource: 'functional-currency',
      description: line.description,
      side:
        document.kind === 'sales-invoice'
          ? ('credit' as const)
          : ('debit' as const),
    };
    lines.push({
      ...base,
      accountId: line.accountId,
      amount: formatFinanceDecimal(net),
      nativeAmount: formatFinanceDecimal(net),
    });
    if (tax > 0n)
      lines.push({
        ...base,
        accountId: line.taxAccountId!,
        amount: formatFinanceDecimal(tax),
        nativeAmount: formatFinanceDecimal(tax),
      });
  }
  const amount = formatFinanceDecimal(total);
  moneyValue(amount, currency); // Reject totals beyond the storage contract before persistence.
  lines.unshift({
    accountId: document.controlAccountId,
    side: document.kind === 'sales-invoice' ? 'debit' : 'credit',
    amount,
    nativeAmount: amount,
    currency,
    fxRate: '1',
    fxSource: 'functional-currency',
    description: document.reference,
  });
  return {
    document,
    total: amount,
    journal: {
      effectiveOn: document.issuedOn,
      description: `${document.kind}: ${document.reference}`,
      sourceReference: document.sourceReference,
      lines,
    },
  };
}

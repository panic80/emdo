import {
  IssueCommercialDocumentSchema,
  ReviewStructuredInvoiceSchema,
  StructuredInvoiceExtractionSchema,
  FinanceCurrencySchema,
} from '@emdo/contracts';
import { moneyValue, formatFinanceDecimal } from './decimal.js';
/** Uses only source monetary totals; never computes VAT from a rate or allocates VAT to invoice lines. */
export function prepareReviewedStructuredInvoice(
  raw: unknown,
  reviewInput: unknown,
  bookCurrency: string,
) {
  const invoice = StructuredInvoiceExtractionSchema.parse(raw),
    review = ReviewStructuredInvoiceSchema.parse(reviewInput);
  if (
    invoice.sourceDigest !== review.expectedSourceDigest ||
    invoice.adapterVersion !== review.expectedAdapterVersion
  )
    throw new Error('finance-invoice-source-revision-conflict');
  const { amount } = validateStructuredInvoiceForReview(invoice, bookCurrency);
  if (
    review.groups.length !== invoice.taxGroups.length ||
    new Set(review.groups.map((g) => g.key)).size !== review.groups.length
  )
    throw new Error('finance-invoice-accounting-review-incomplete');
  const lines = invoice.taxGroups.map((group) => {
    const mapping = review.groups.find((g) => g.key === group.key);
    if (!mapping)
      throw new Error('finance-invoice-accounting-review-incomplete');
    const net = amount(group.basis),
      vat = amount(group.tax);
    if (net <= 0n || vat < 0n || vat > 0n !== (mapping.taxAccountId !== null))
      throw new Error('finance-invoice-tax-group-unsupported');
    return {
      description: `Invoice ${invoice.invoiceId!.value.trim()} · source VAT group ${group.category?.value.trim() ?? 'unspecified'}`,
      accountId: mapping.accountId,
      netAmount: formatFinanceDecimal(net),
      taxAmount: formatFinanceDecimal(vat),
      taxAccountId: mapping.taxAccountId,
    };
  });
  return IssueCommercialDocumentSchema.parse({
    kind: review.kind,
    partyId: review.partyId,
    reference: invoice.invoiceId!.value.trim(),
    issuedOn: invoice.issueDate!.value.trim(),
    dueOn: invoice.dueDate!.value.trim(),
    controlAccountId: review.controlAccountId,
    sourceReference: `structured-invoice:${invoice.sourceDigest}`,
    lines,
  });
}

export function validateStructuredInvoiceForReview(
  raw: unknown,
  bookCurrency: string,
) {
  const invoice = StructuredInvoiceExtractionSchema.parse(raw);
  if (invoice.blockingIssues.length)
    throw new Error('finance-invoice-unsupported-semantics');
  if (
    !IssueCommercialDocumentSchema.shape.issuedOn.safeParse(
      invoice.issueDate?.value.trim(),
    ).success ||
    !IssueCommercialDocumentSchema.shape.dueOn.safeParse(
      invoice.dueDate?.value.trim(),
    ).success ||
    invoice.dueDate!.value.trim() < invoice.issueDate!.value.trim()
  )
    throw new Error('finance-invoice-date-unsupported');
  if (
    !IssueCommercialDocumentSchema.shape.reference.safeParse(
      invoice.invoiceId?.value.trim(),
    ).success
  )
    throw new Error('finance-invoice-reference-unsupported');
  const currency = FinanceCurrencySchema.parse(invoice.currency?.value.trim());
  if (currency !== bookCurrency)
    throw new Error('finance-invoice-currency-conversion-unsupported');
  const amount = (f: { value: string } | null, optional = false) => {
    if (!f) {
      if (optional) return 0n;
      throw new Error('finance-invoice-missing-amount');
    }
    return moneyValue(f.value.trim(), currency);
  };
  const t = invoice.totals,
    lineNet = invoice.lines.reduce((sum, l) => sum + amount(l.netAmount), 0n),
    basis = invoice.taxGroups.reduce((sum, g) => sum + amount(g.basis), 0n),
    tax = invoice.taxGroups.reduce((sum, g) => sum + amount(g.tax), 0n);
  if (
    lineNet !== amount(t.lineNet) ||
    lineNet - amount(t.allowances, true) + amount(t.charges, true) !==
      amount(t.net) ||
    basis !== amount(t.net) ||
    tax !== amount(t.tax) ||
    basis + tax !== amount(t.gross) ||
    amount(t.payable) !== amount(t.gross) ||
    amount(t.prepaid, true) !== 0n ||
    amount(t.rounding, true) !== 0n
  )
    throw new Error('finance-invoice-total-reconciliation-required');
  let allowances = 0n,
    charges = 0n;
  for (const adjustment of invoice.adjustments.filter(
    (a) => a.scope === 'document',
  )) {
    const indicator = adjustment.charge?.value.trim(),
      n = amount(adjustment.amount);
    if (n < 0n || !['true', 'false', '1', '0'].includes(indicator ?? ''))
      throw new Error('finance-invoice-adjustment-unsupported');
    if (indicator === 'true' || indicator === '1') charges += n;
    else allowances += n;
  }
  if (
    allowances !== amount(t.allowances, true) ||
    charges !== amount(t.charges, true)
  )
    throw new Error('finance-invoice-adjustment-reconciliation-required');

  if (
    invoice.lines.some((l) => amount(l.netAmount) <= 0n) ||
    invoice.taxGroups.some((g) => amount(g.basis) <= 0n || amount(g.tax) < 0n)
  )
    throw new Error('finance-invoice-nonpositive-lines-unsupported');
  return { invoice, amount };
}

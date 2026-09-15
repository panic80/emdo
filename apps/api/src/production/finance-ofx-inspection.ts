import { FinanceOfxStatementSchema } from '@emdo/contracts';
import { extractFinanceOfxStatement } from '@emdo/integrations/finance-documents';
import { z } from 'zod';

const SourceField = FinanceOfxStatementSchema.shape.fields.element;
const Transaction = FinanceOfxStatementSchema.shape.transactions.element;
export const FinanceOfxInspectionSchema = FinanceOfxStatementSchema.omit({
  fields: true,
  transactions: true,
}).extend({
  fields: z
    .array(
      SourceField.extend({
        value: z.string().max(200),
        raw: z.string().max(200),
        valueLength: z.number().int().nonnegative(),
        rawLength: z.number().int().nonnegative(),
        truncated: z.boolean(),
      }),
    )
    .max(20),
  fieldOffset: z.number().int().nonnegative(),
  totalFields: z.number().int().nonnegative(),
  nextFieldOffset: z.number().int().nonnegative().nullable(),
  transactions: z
    .array(
      Transaction.omit({ fields: true }).extend({
        fieldCount: z.number().int().nonnegative(),
      }),
    )
    .max(10),
  transactionOffset: z.number().int().nonnegative(),
  totalTransactions: z.number().int().nonnegative(),
  nextTransactionOffset: z.number().int().nonnegative().nullable(),
  authority: z.literal('unreviewed-source-facts'),
  complete: z.boolean(),
});

export function inspectFinanceOfxSource(
  sourceText: string,
  format: 'ofx' | 'qfx',
  transactionOffset: number,
  fieldOffset: number,
) {
  const source = FinanceOfxStatementSchema.parse(
    extractFinanceOfxStatement(Buffer.from(sourceText, 'utf8'), format),
  );
  const { fields, transactions, ...metadata } = source;
  const pageFields = fields
    .slice(fieldOffset, fieldOffset + 20)
    .map((field) => ({
      ...field,
      value: field.value.slice(0, 200),
      raw: field.raw.slice(0, 200),
      valueLength: field.value.length,
      rawLength: field.raw.length,
      truncated: field.value.length > 200 || field.raw.length > 200,
    }));
  const pageTransactions = transactions
    .slice(transactionOffset, transactionOffset + 10)
    .map((transaction) => {
      const { fields: transactionFields, ...record } = transaction;
      return { ...record, fieldCount: transactionFields.length };
    });
  const nextFieldOffset =
    fieldOffset + pageFields.length < fields.length
      ? fieldOffset + pageFields.length
      : null;
  const nextTransactionOffset =
    transactionOffset + pageTransactions.length < transactions.length
      ? transactionOffset + pageTransactions.length
      : null;
  return FinanceOfxInspectionSchema.parse({
    ...metadata,
    fields: pageFields,
    transactions: pageTransactions,
    fieldOffset,
    totalFields: fields.length,
    nextFieldOffset,
    transactionOffset,
    totalTransactions: transactions.length,
    nextTransactionOffset,
    authority: 'unreviewed-source-facts',
    complete:
      fieldOffset === 0 &&
      transactionOffset === 0 &&
      nextFieldOffset === null &&
      nextTransactionOffset === null &&
      !pageFields.some((field) => field.truncated),
  });
}

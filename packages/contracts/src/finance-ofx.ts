import { z } from 'zod';
import { Sha256Schema } from './primitives.js';
export const FinanceOfxFieldSchema = z.strictObject({
  path: z.string().min(1).max(1000),
  tag: z.string().regex(/^[A-Z][A-Z0-9_.-]*$/),
  value: z.string().max(10000),
  raw: z.string().max(20000),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});
export const FinanceOfxTimestampSchema = z.strictObject({
  raw: z.string().max(100),
  businessDate: z.string().nullable(),
  time: z.string().nullable(),
  fraction: z.string().nullable(),
  offsetMinutes: z.number().int().min(-840).max(840).nullable(),
  zoneLabel: z.string().max(30).nullable(),
  offsetBasis: z.enum(['explicit', 'ofx-default-gmt', 'date-only', 'invalid']),
  valid: z.boolean(),
});
export const FinanceOfxStatementSchema = z.strictObject({
  version: z.literal('finance-ofx-source.v1'),
  format: z.enum(['ofx', 'qfx']),
  syntax: z.enum(['ofx1-sgml', 'ofx2-xml']),
  sourceDigest: Sha256Schema,
  sourceOffsetUnit: z.literal('utf16-code-units-in-utf8-decoded-source'),
  headers: z
    .array(
      z.strictObject({ name: z.string().max(100), value: z.string().max(500) }),
    )
    .max(30),
  statementKind: z.enum(['bank', 'credit-card', 'unsupported']),
  institution: z.strictObject({
    org: z.string().max(255).nullable(),
    fid: z.string().max(255).nullable(),
    bankId: z.string().max(255).nullable(),
    branchId: z.string().max(255).nullable(),
  }),
  account: z.strictObject({
    id: z.string().max(255).nullable(),
    type: z.string().max(100).nullable(),
  }),
  currency: z.string().max(20).nullable(),
  statementStart: FinanceOfxTimestampSchema.nullable(),
  statementEnd: FinanceOfxTimestampSchema.nullable(),
  fields: z.array(FinanceOfxFieldSchema).max(20000),
  transactions: z
    .array(
      z.strictObject({
        sourceRow: z.number().int().positive(),
        path: z.string().max(1000),
        fields: z.array(FinanceOfxFieldSchema).max(100),
        posted: FinanceOfxTimestampSchema,
        fitid: z.string().max(255).nullable(),
        scopedFitid: Sha256Schema.nullable(),
        issues: z.array(z.string().max(300)).max(30),
      }),
    )
    .max(2000),
  issues: z.array(z.string().max(300)).max(100),
  unsupportedAggregates: z.array(z.string().max(1000)).max(100),
  balanceAuthority: z.literal('reported-source-only-no-opening-balance'),
});
export type FinanceOfxStatement = z.infer<typeof FinanceOfxStatementSchema>;

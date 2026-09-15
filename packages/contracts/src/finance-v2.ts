import { z } from 'zod';
import { UuidSchema } from './primitives.js';
import { FinanceNormalizedAmountComponentReviewListSchema } from './finance-import-components.js';

export const FinanceCurrencySchema = z.enum([
  'CAD',
  'USD',
  'MXN',
  'EUR',
  'KRW',
  'JPY',
]);
export const FinanceDecimalSchema = z
  .string()
  .max(40)
  .regex(/^-?(?:0|[1-9]\d{0,25})(?:\.\d{1,12})?$/);
export const FinanceMoneySchema = z
  .strictObject({
    currency: FinanceCurrencySchema,
    amount: FinanceDecimalSchema,
  })
  .superRefine((value, context) => {
    const precision =
      value.currency === 'JPY' || value.currency === 'KRW' ? 0 : 2;
    if (
      (value.amount.split('.')[1] ?? '').replace(/0+$/, '').length > precision
    ) {
      context.addIssue({
        code: 'custom',
        path: ['amount'],
        message: 'Amount exceeds currency precision',
      });
    }
  });
export const FinanceBookRoleSchema = z.enum([
  'administrator',
  'preparer',
  'approver',
  'viewer',
]);
export const CreateFinanceBookSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  entityName: z.string().trim().min(1).max(200),
  entityKind: z.enum(['individual', 'sole-proprietor', 'corporation']),
  country: z.enum(['CA', 'US', 'MX', 'DE', 'KR', 'JP', 'FR']),
  functionalCurrency: FinanceCurrencySchema,
  fiscalYearStartMonth: z.number().int().min(1).max(12).default(1),
});
export const CreateLedgerAccountSchema = z.strictObject({
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._-]{1,32}$/),
  name: z.string().trim().min(1).max(200),
  kind: z.enum(['asset', 'liability', 'equity', 'income', 'expense']),
});
export const JournalLineInputSchema = z.strictObject({
  accountId: UuidSchema,
  side: z.enum(['debit', 'credit']),
  amount: FinanceDecimalSchema,
  currency: FinanceCurrencySchema,
  nativeAmount: FinanceDecimalSchema,
  fxRate: FinanceDecimalSchema,
  fxSource: z.string().trim().min(1).max(200),
  description: z.string().trim().max(500).default(''),
});
export const PostJournalSchema = z.strictObject({
  effectiveOn: z.iso.date(),
  description: z.string().trim().min(1).max(500),
  sourceReference: z.string().trim().min(1).max(200),
  lines: z.array(JournalLineInputSchema).min(2).max(1_000),
});
export const FiscalPeriodInputSchema = z
  .strictObject({
    startsOn: z.iso.date(),
    endsOn: z.iso.date(),
  })
  .refine((value) => value.startsOn <= value.endsOn, {
    message: 'Period ends before it starts',
  });
export const ReverseJournalSchema = z.strictObject({
  effectiveOn: z.iso.date(),
  reason: z.string().trim().min(3).max(500),
});
export const TaxCoverageSchema = z.strictObject({
  country: z.enum(['CA', 'US', 'MX', 'DE', 'KR', 'JP', 'FR']),
  status: z.enum(['unavailable', 'in-development', 'verified']),
  jurisdictions: z.array(z.string().max(100)),
  taxYears: z.array(z.number().int()),
  forms: z.array(z.string().max(100)),
  reason: z.string().max(500),
});
export type FinanceCurrency = z.infer<typeof FinanceCurrencySchema>;
export type FinanceMoney = z.infer<typeof FinanceMoneySchema>;
export type CreateFinanceBook = z.infer<typeof CreateFinanceBookSchema>;
export type CreateLedgerAccount = z.infer<typeof CreateLedgerAccountSchema>;
export type PostJournal = z.infer<typeof PostJournalSchema>;
export type TaxCoverage = z.infer<typeof TaxCoverageSchema>;
export interface FinanceBookView {
  id: string;
  legalEntityId?: string;
  name: string;
  entityName: string;
  country: string;
  functionalCurrency: FinanceCurrency;
  role: z.infer<typeof FinanceBookRoleSchema>;
}
export interface LedgerAccountView {
  id: string;
  code: string;
  name: string;
  kind: string;
}
export interface TrialBalanceRow extends LedgerAccountView {
  debit: string;
  credit: string;
  balance: string;
}
export interface FinanceBookOverview {
  book: FinanceBookView;
  accounts: LedgerAccountView[];
  periods: {
    id: string;
    startsOn: string;
    endsOn: string;
    status: 'open' | 'closed';
  }[];
  journals: {
    id: string;
    effectiveOn: string;
    description: string;
    sourceReference: string;
    reversalOf: string | null;
  }[];
  trialBalance: TrialBalanceRow[];
}

export const CreateFinancePartySchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  kind: z.enum(['person', 'organization']),
  reference: z.string().trim().min(1).max(200),
});
export const IssueCommercialDocumentSchema = z
  .strictObject({
    kind: z.enum(['sales-invoice', 'supplier-bill']),
    partyId: UuidSchema,
    reference: z.string().trim().min(1).max(200),
    issuedOn: z.iso.date(),
    dueOn: z.iso.date(),
    controlAccountId: UuidSchema,
    sourceReference: z.string().trim().min(1).max(200),
    lines: z
      .array(
        z.strictObject({
          description: z.string().trim().min(1).max(500),
          accountId: UuidSchema,
          netAmount: FinanceDecimalSchema,
          taxAmount: FinanceDecimalSchema.default('0'),
          taxAccountId: UuidSchema.nullable().default(null),
        }),
      )
      .min(1)
      .max(250),
  })
  .refine((value) => value.dueOn >= value.issuedOn, {
    message: 'Due date precedes issue date',
  });
export const RecordFinancePaymentSchema = z
  .strictObject({
    direction: z.enum(['receipt', 'disbursement']),
    partyId: UuidSchema,
    cashAccountId: UuidSchema,
    effectiveOn: z.iso.date(),
    reference: z.string().trim().min(1).max(200),
    sourceReference: z.string().trim().min(1).max(200),
    allocations: z
      .array(
        z.strictObject({
          documentId: UuidSchema,
          amount: FinanceDecimalSchema,
        }),
      )
      .min(1)
      .max(250),
  })
  .refine(
    (value) =>
      new Set(value.allocations.map((row) => row.documentId)).size ===
      value.allocations.length,
    { message: 'Allocate to each document once' },
  );
export const VoidCommercialDocumentSchema = z.strictObject({
  effectiveOn: z.iso.date(),
  reason: z.string().trim().min(3).max(500),
});
export type IssueCommercialDocument = z.infer<
  typeof IssueCommercialDocumentSchema
>;
export type RecordFinancePayment = z.infer<typeof RecordFinancePaymentSchema>;

export const CreateFinancialAccountSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(200),
    kind: z.enum(['bank', 'brokerage', 'credit-card', 'cash']),
    currency: FinanceCurrencySchema,
    ledgerAccountId: UuidSchema,
    privateSourceAssignment: z
      .strictObject({
        sourceSpaceId: UuidSchema,
        compatibilityAccountKind: z.enum([
          'cash',
          'chequing',
          'savings',
          'credit',
          'other',
        ]),
        reason: z.string().trim().min(3).max(500),
      })
      .optional(),
  })
  .superRefine((account, ctx) => {
    const assignment = account.privateSourceAssignment;
    if (!assignment) return;
    const compatibleKinds: Record<typeof account.kind, readonly string[]> = {
      bank: ['chequing', 'savings', 'other'],
      brokerage: ['other'],
      'credit-card': ['credit'],
      cash: ['cash'],
    };
    if (
      !compatibleKinds[account.kind].includes(
        assignment.compatibilityAccountKind,
      )
    )
      ctx.addIssue({
        code: 'custom',
        path: ['privateSourceAssignment', 'compatibilityAccountKind'],
        message:
          'Private source account classification must match the financial account type.',
      });
  });
export const NormalizedCsvMappingSchema = z
  .strictObject({
    dateFormat: z.enum([
      'yyyy-mm-dd',
      'mm/dd/yyyy',
      'dd/mm/yyyy',
      'dd.mm.yyyy',
      'yyyy/mm/dd',
    ]),
    decimalSeparator: z.enum(['.', ',']).default('.'),
    groupingSeparator: z.enum(['', ',', '.', ' ']).default(''),
    columns: z.strictObject({
      date: z.string().min(1).max(200),
      description: z.string().min(1).max(200),
      amount: z.string().min(1).max(200).optional(),
      debit: z.string().min(1).max(200).optional(),
      credit: z.string().min(1).max(200).optional(),
      externalId: z.string().min(1).max(200).optional(),
    }),
  })
  .superRefine((value, ctx) => {
    const c = value.columns,
      signed = c.amount !== undefined,
      split = c.debit !== undefined && c.credit !== undefined;
    if (
      signed === split ||
      (signed && (c.debit !== undefined || c.credit !== undefined)) ||
      (!signed && (!c.debit || !c.credit)) ||
      (c.debit !== undefined && c.debit === c.credit)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Map one signed amount or distinct debit and credit columns',
      });
    if (value.decimalSeparator === value.groupingSeparator)
      ctx.addIssue({
        code: 'custom',
        message: 'Decimal and grouping separators must differ',
      });
  });
export const UploadNormalizedStatementSchema = z
  .strictObject({
    financialAccountId: UuidSchema,
    filename: z.string().trim().min(1).max(200),
    format: z.enum(['csv', 'ofx', 'qfx']),
    sourceText: z.string().min(1).max(2_097_152),
    mapping: NormalizedCsvMappingSchema.optional(),
  })
  .refine((value) => value.format !== 'csv' || value.mapping !== undefined, {
    message: 'CSV requires explicit mapping',
  });
export const ReviewNormalizedImportRowSchema = z
  .strictObject({
    expectedRevision: z.number().int().positive(),
    action: z.enum(['post', 'match', 'ignore']),
    counterAccountId: UuidSchema.nullable().default(null),
    matchJournalId: UuidSchema.nullable().default(null),
    fxRate: FinanceDecimalSchema.nullable().default(null),
    fxSource: z.string().trim().min(1).max(200).nullable().default(null),
    reason: z.string().trim().min(3).max(500),
    acknowledgePossibleDuplicate: z.boolean().default(false),
    componentMappings:
      FinanceNormalizedAmountComponentReviewListSchema.optional(),
    correction: z
      .strictObject({
        date: z.iso.date().optional(),
        amount: FinanceDecimalSchema.optional(),
        description: z.string().trim().min(1).max(500).optional(),
        externalId: z.string().trim().min(1).max(200).nullable().optional(),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    const hasComponentMappings = (value.componentMappings?.length ?? 0) > 0;
    if (
      value.action === 'post' &&
      ((hasComponentMappings &&
        (value.counterAccountId || value.matchJournalId)) ||
        (!hasComponentMappings &&
          (!value.counterAccountId || value.matchJournalId)))
    )
      ctx.addIssue({
        code: 'custom',
        message: hasComponentMappings
          ? 'Component posting requires component accounts and no counter or matched journal'
          : 'Posting requires a counter account and no matched journal',
      });
    if (
      value.action === 'match' &&
      (!value.matchJournalId || value.counterAccountId)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Matching requires a journal and no counter account',
      });
    if (
      value.action === 'ignore' &&
      (value.counterAccountId || value.matchJournalId || hasComponentMappings)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Ignored rows cannot select posting targets',
      });
  });
export type NormalizedCsvMapping = z.infer<typeof NormalizedCsvMappingSchema>;
export type UploadNormalizedStatement = z.infer<
  typeof UploadNormalizedStatementSchema
>;

export const CommitNormalizedImportSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
});

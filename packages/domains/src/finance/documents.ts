import {
  IsoDateTimeSchema,
  OpaqueReferenceSchema,
  SchemaVersionSchema,
  Sha256Schema,
  deepFreeze,
  type DeepReadonly,
} from '@emdo/contracts';
import { z } from 'zod';

export const FINANCE_DOCUMENT_LIMITS = deepFreeze({
  maximumDocumentsPerOwner: 10_000,
  maximumBytesPerOwner: 50 * 1024 * 1024 * 1024,
  maximumBytesPerFile: 25 * 1024 * 1024,
  maximumFilesPerSelection: 20,
  maximumConcurrentUploads: 3,
  maximumConcurrentExtractions: 1,
  maximumPdfPages: 250,
  maximumImageMegapixels: 40,
} as const);

/**
 * The Overview is deliberately non-paginated. These bounds match the
 * canonical monthly-budget allocation limit and make an oversized snapshot
 * unavailable instead of returning a partial financial picture.
 */
export const FINANCE_EXPERIENCE_LIMITS = deepFreeze({
  maximumCategoryTotals: 1_000,
  maximumMonthlyBudgetAllocations: 1_000,
} as const);

export const FinanceLocaleSchema = z.enum(['en-CA', 'fr-CA', 'ja-JP', 'ko-KR']);
export type FinanceLocale = z.output<typeof FinanceLocaleSchema>;

export const FinanceDocumentTypeSchema = z.enum([
  'receipt',
  'invoice',
  'bank-statement',
  'credit-statement',
  'pay-stub',
  'tax-slip',
  'insurance',
  'loan',
  'investment-statement',
  'other',
]);
export type FinanceDocumentType = z.output<typeof FinanceDocumentTypeSchema>;

export const FinanceDocumentStateSchema = z.enum([
  'uploaded',
  'extracting',
  'awaiting-review',
  'committed',
  'failed',
  'deleting',
  'deleted',
]);
export type FinanceDocumentState = z.output<typeof FinanceDocumentStateSchema>;

export const FinanceDocumentMimeTypeSchema = z.enum([
  'application/pdf',
  'image/jpeg',
  'image/png',
]);
export type FinanceDocumentMimeType = z.output<
  typeof FinanceDocumentMimeTypeSchema
>;

const DateOnlySchema = z.iso.date();
const CurrencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/u)
  .transform((value) => value.toUpperCase());
const BoundedTextSchema = z.string().trim().min(1).max(2_000);
const OptionalTextSchema = z.string().trim().min(1).max(2_000).nullable();
const MaskedSuffixSchema = z
  .string()
  .regex(/^\d{2,4}$/u)
  .nullable();
const ConfidenceSchema = z.number().min(0).max(1);

export const FinanceDocumentMoneySchema = z.strictObject({
  currency: CurrencyCodeSchema,
  minorUnits: z.number().int().safe(),
});
export type FinanceDocumentMoney = DeepReadonly<
  z.output<typeof FinanceDocumentMoneySchema>
>;

export const FinanceDocumentEvidenceLocatorSchema = z
  .strictObject({
    page: z.number().int().min(1).max(FINANCE_DOCUMENT_LIMITS.maximumPdfPages),
    excerpt: z.string().trim().min(1).max(2_000),
    characterStart: z.number().int().nonnegative().nullable(),
    characterEnd: z.number().int().positive().nullable(),
  })
  .superRefine((value, context) => {
    if (
      (value.characterStart === null) !== (value.characterEnd === null) ||
      (value.characterStart !== null &&
        value.characterEnd !== null &&
        value.characterEnd <= value.characterStart)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['characterEnd'],
        message: 'Evidence character offsets must be an increasing pair',
      });
    }
  });

export const FinanceDocumentFactSchema = z.strictObject({
  field: z.string().trim().min(1).max(120),
  confidence: ConfidenceSchema,
  evidence: z.array(FinanceDocumentEvidenceLocatorSchema).min(1).max(16),
});

const CommonEnvelopeFields = {
  schemaVersion: z.literal(1),
  sourceLocale: FinanceLocaleSchema,
  currency: CurrencyCodeSchema.nullable(),
  issuer: OptionalTextSchema,
  recipient: OptionalTextSchema,
  issuedOn: DateOnlySchema.nullable(),
  dueOn: DateOnlySchema.nullable(),
  periodStart: DateOnlySchema.nullable(),
  periodEnd: DateOnlySchema.nullable(),
  subtotal: FinanceDocumentMoneySchema.nullable(),
  tax: FinanceDocumentMoneySchema.nullable(),
  total: FinanceDocumentMoneySchema.nullable(),
  accountLast4: MaskedSuffixSchema,
  facts: z.array(FinanceDocumentFactSchema).max(512),
} as const;

const LineItemSchema = z.strictObject({
  description: BoundedTextSchema,
  quantity: z.number().finite().nonnegative().nullable(),
  amount: FinanceDocumentMoneySchema.nullable(),
});

const ProposedRecordSchema = z.strictObject({
  kind: z.enum(['expense', 'bill', 'income']),
  amount: FinanceDocumentMoneySchema,
  occurredOn: DateOnlySchema,
  description: BoundedTextSchema,
});

const ReceiptEnvelopeSchema = z.strictObject({
  ...CommonEnvelopeFields,
  documentType: z.literal('receipt'),
  merchant: OptionalTextSchema,
  purchasedOn: DateOnlySchema.nullable(),
  tip: FinanceDocumentMoneySchema.nullable(),
  paymentMethodLast4: MaskedSuffixSchema,
  lineItems: z.array(LineItemSchema).max(2_000),
  proposedRecord: ProposedRecordSchema.extend({
    kind: z.literal('expense'),
  }).nullable(),
});

const InvoiceEnvelopeSchema = z.strictObject({
  ...CommonEnvelopeFields,
  documentType: z.literal('invoice'),
  vendor: OptionalTextSchema,
  invoiceNumber: OptionalTextSchema,
  paymentStatus: z.enum(['unpaid', 'paid', 'unknown']),
  lineItems: z.array(LineItemSchema).max(2_000),
  proposedRecord: ProposedRecordSchema.extend({
    kind: z.enum(['expense', 'bill']),
  }).nullable(),
});

const StatementTransactionSchema = z.strictObject({
  postedOn: DateOnlySchema,
  description: BoundedTextSchema,
  amount: FinanceDocumentMoneySchema,
  reference: OptionalTextSchema,
});

const StatementFields = {
  ...CommonEnvelopeFields,
  institution: OptionalTextSchema,
  openingBalance: FinanceDocumentMoneySchema.nullable(),
  closingBalance: FinanceDocumentMoneySchema.nullable(),
  transactions: z.array(StatementTransactionSchema).max(100_000),
} as const;

const BankStatementEnvelopeSchema = z.strictObject({
  ...StatementFields,
  documentType: z.literal('bank-statement'),
});

const CreditStatementEnvelopeSchema = z.strictObject({
  ...StatementFields,
  documentType: z.literal('credit-statement'),
  minimumPayment: FinanceDocumentMoneySchema.nullable(),
});

const PayStubEnvelopeSchema = z.strictObject({
  ...CommonEnvelopeFields,
  documentType: z.literal('pay-stub'),
  employer: OptionalTextSchema,
  grossPay: FinanceDocumentMoneySchema.nullable(),
  deductions: FinanceDocumentMoneySchema.nullable(),
  netPay: FinanceDocumentMoneySchema.nullable(),
  proposedRecord: ProposedRecordSchema.extend({
    kind: z.literal('income'),
  }).nullable(),
});

const TaxSlipEnvelopeSchema = z.strictObject({
  ...CommonEnvelopeFields,
  documentType: z.literal('tax-slip'),
  slipType: OptionalTextSchema,
  taxYear: z.number().int().min(1900).max(2200).nullable(),
  boxes: z
    .array(
      z.strictObject({
        label: z.string().trim().min(1).max(120),
        value: z.string().trim().min(1).max(500),
      }),
    )
    .max(512),
  proposedRecord: z.null(),
});

const InsuranceEnvelopeSchema = z.strictObject({
  ...CommonEnvelopeFields,
  documentType: z.literal('insurance'),
  provider: OptionalTextSchema,
  policyType: OptionalTextSchema,
  policyLast4: MaskedSuffixSchema,
  premium: FinanceDocumentMoneySchema.nullable(),
  proposedRecord: ProposedRecordSchema.extend({
    kind: z.enum(['expense', 'bill']),
  }).nullable(),
});

const LoanEnvelopeSchema = z.strictObject({
  ...CommonEnvelopeFields,
  documentType: z.literal('loan'),
  lender: OptionalTextSchema,
  loanType: OptionalTextSchema,
  balance: FinanceDocumentMoneySchema.nullable(),
  annualRateBasisPoints: z
    .number()
    .int()
    .nonnegative()
    .max(1_000_000)
    .nullable(),
  minimumPayment: FinanceDocumentMoneySchema.nullable(),
  proposedRecord: ProposedRecordSchema.extend({
    kind: z.enum(['expense', 'bill']),
  }).nullable(),
});

const InvestmentStatementEnvelopeSchema = z.strictObject({
  ...CommonEnvelopeFields,
  documentType: z.literal('investment-statement'),
  institution: OptionalTextSchema,
  marketValue: FinanceDocumentMoneySchema.nullable(),
  holdings: z
    .array(
      z.strictObject({
        symbol: z.string().trim().min(1).max(32).nullable(),
        description: BoundedTextSchema,
        quantity: z.number().finite().nullable(),
        marketValue: FinanceDocumentMoneySchema.nullable(),
      }),
    )
    .max(10_000),
  proposedRecord: z.null(),
});

const OtherEnvelopeSchema = z.strictObject({
  ...CommonEnvelopeFields,
  documentType: z.literal('other'),
  summary: BoundedTextSchema,
  proposedRecord: z.null(),
});

export const FinanceDocumentEnvelopeV1Schema = z
  .discriminatedUnion('documentType', [
    ReceiptEnvelopeSchema,
    InvoiceEnvelopeSchema,
    BankStatementEnvelopeSchema,
    CreditStatementEnvelopeSchema,
    PayStubEnvelopeSchema,
    TaxSlipEnvelopeSchema,
    InsuranceEnvelopeSchema,
    LoanEnvelopeSchema,
    InvestmentStatementEnvelopeSchema,
    OtherEnvelopeSchema,
  ])
  .superRefine((value, context) => {
    if (
      value.periodStart !== null &&
      value.periodEnd !== null &&
      value.periodEnd < value.periodStart
    ) {
      context.addIssue({
        code: 'custom',
        path: ['periodEnd'],
        message: 'Document period end must not precede its start',
      });
    }
    for (const [field, money] of [
      ['subtotal', value.subtotal],
      ['tax', value.tax],
      ['total', value.total],
    ] as const) {
      if (
        value.currency !== null &&
        money !== null &&
        money.currency !== value.currency
      ) {
        context.addIssue({
          code: 'custom',
          path: [field, 'currency'],
          message: 'Common monetary facts must use the document currency',
        });
      }
    }
  })
  .transform(deepFreeze);

export type FinanceDocumentEnvelopeV1 = DeepReadonly<
  z.output<typeof FinanceDocumentEnvelopeV1Schema>
>;

const maskIdentifier = (value: string): string => {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value.trim())) return value;
  const identifierPositions = [...value.matchAll(/[\p{L}\p{N}]/gu)].map(
    (match) => match.index,
  );
  if (identifierPositions.length < 6) return value;
  const keep = new Set(identifierPositions.slice(-4));
  return [...value]
    .map((character, index) =>
      /[\p{L}\p{N}]/u.test(character) && !keep.has(index) ? '•' : character,
    )
    .join('');
};

const LabelledIdentifierPattern =
  /((?:(?:\b(?:account|acct|card|sin|ssn|tin|tax(?:payer)?|policy|credential|password|passcode|token|api[ _-]?key|secret|routing|iban|swift)\b(?:[\s._:=-]*(?:number|no\.?|id|identifier|#))?)|(?:\b(?:compte|carte|nas|identifiant fiscal|num[eé]ro fiscal|police d'assurance|num[eé]ro de police|identifiant|mot de passe|jeton|cl[eé] api|secret)\b)|(?:口座番号|カード番号|個人番号|マイナンバー|納税者番号|税番号|保険証券番号|証券番号|認証情報|パスワード|トークン|apiキー|秘密鍵)|(?:계좌번호|카드번호|주민등록번호|납세자번호|세금번호|보험증권번호|자격증명|비밀번호|토큰|api\s*키|비밀키))[\s._:#=-]+)([\p{L}\p{N}][\p{L}\p{N}._:/-]{5,63})/giu;
const LongNumericIdentifierPattern = /(?:\p{N}[ .:/_-]?){6,19}/gu;
const MixedAlphanumericIdentifierPattern =
  /(?<![\p{L}\p{N}])(?=[\p{L}\p{N}._:/-]{6,64}(?![\p{L}\p{N}]))(?=[\p{L}\p{N}._:/-]*\p{L})(?=[\p{L}\p{N}._:/-]*\p{N})[\p{L}\p{N}]+(?:[._:/-][\p{L}\p{N}]+)*(?![\p{L}\p{N}])/gu;

/** Masks bounded identifier-like text while retaining at most four suffix characters. */
export const redactFinanceDocumentText = (value: string): string =>
  value
    .normalize('NFKC')
    .replace(
      LabelledIdentifierPattern,
      (_match, prefix: string, identifier: string) =>
        `${prefix}${maskIdentifier(identifier)}`,
    )
    .replace(LongNumericIdentifierPattern, (identifier) =>
      maskIdentifier(identifier),
    )
    .replace(MixedAlphanumericIdentifierPattern, (identifier) =>
      maskIdentifier(identifier),
    );

/**
 * Produces the only extraction shape that may cross the review boundary.
 * Provider output remains encrypted; every persisted/displayed free-text field
 * masks long numeric identifiers while preserving source-language wording.
 */
export const redactFinanceDocumentEnvelopeForReview = (
  input: unknown,
): FinanceDocumentEnvelopeV1 => {
  const envelope = FinanceDocumentEnvelopeV1Schema.parse(input);
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return redactFinanceDocumentText(value);
    }
    if (Array.isArray(value)) return value.map(visit);
    if (
      value !== null &&
      typeof value === 'object' &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value))
    ) {
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, visit(child)]),
      );
    }
    return value;
  };
  return FinanceDocumentEnvelopeV1Schema.parse(visit(envelope));
};

export const FinanceDocumentSummarySchema = z
  .strictObject({
    schemaVersion: SchemaVersionSchema,
    id: OpaqueReferenceSchema,
    documentType: FinanceDocumentTypeSchema.nullable(),
    sourceLocale: FinanceLocaleSchema.nullable(),
    currency: CurrencyCodeSchema.nullable(),
    state: FinanceDocumentStateSchema,
    displayName: z.string().trim().min(1).max(255).nullable(),
    mimeType: FinanceDocumentMimeTypeSchema.nullable(),
    byteSize: z
      .number()
      .int()
      .positive()
      .max(FINANCE_DOCUMENT_LIMITS.maximumBytesPerFile)
      .nullable(),
    plaintextSha256: Sha256Schema.nullable(),
    extractionRevision: z.number().int().positive().nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .superRefine((value, context) => {
    if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
      context.addIssue({
        code: 'custom',
        path: ['updatedAt'],
        message: 'Document update time must not precede creation',
      });
    }
    const originalFields = [
      value.displayName,
      value.mimeType,
      value.byteSize,
      value.plaintextSha256,
    ];
    const extractedFields = [
      value.documentType,
      value.sourceLocale,
      value.currency,
      value.extractionRevision,
    ];
    if (value.state === 'deleted') {
      if (
        [...originalFields, ...extractedFields].some((field) => field !== null)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['state'],
          message: 'Deleted document summaries must be content-free',
        });
      }
      return;
    }
    if (originalFields.some((field) => field === null)) {
      context.addIssue({
        code: 'custom',
        path: ['state'],
        message: 'Accessible document summaries require original metadata',
      });
    }
    if (
      value.state === 'uploaded' &&
      extractedFields.some((field) => field !== null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['state'],
        message: 'Uploaded documents cannot expose extraction facts',
      });
    }
    if (
      ['extracting', 'awaiting-review', 'failed', 'committed'].includes(
        value.state,
      ) &&
      value.extractionRevision === null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['extractionRevision'],
        message: 'Extraction lifecycle states require a revision',
      });
    }
    if (
      value.state === 'committed' &&
      (value.documentType === null || value.sourceLocale === null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['state'],
        message: 'Committed documents require reviewed classification',
      });
    }
  })
  .transform(deepFreeze);

export type FinanceDocumentSummary = DeepReadonly<
  z.output<typeof FinanceDocumentSummarySchema>
>;

export const FinanceDocumentListSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    items: z.array(FinanceDocumentSummarySchema).max(100),
    nextCursor: z.string().trim().min(1).max(512).optional(),
  })
  .transform(deepFreeze);

export const FinanceDocumentDetailSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    document: FinanceDocumentSummarySchema,
    reviewAvailable: z.boolean(),
    matchCount: z.number().int().nonnegative().max(100_000),
  })
  .transform(deepFreeze);

export const FinanceDocumentReviewDraftSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    documentId: OpaqueReferenceSchema,
    extractionRevision: z.number().int().positive(),
    envelope: FinanceDocumentEnvelopeV1Schema,
    payloadHash: Sha256Schema,
    reviewToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    expiresAt: IsoDateTimeSchema,
  })
  .transform(deepFreeze);

export const FinanceDocumentReviewPatchSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    expectedExtractionRevision: z.number().int().positive(),
    envelope: FinanceDocumentEnvelopeV1Schema,
  })
  .transform(deepFreeze);

export const FinanceDocumentReviewCommitSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    reviewToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  })
  .transform(deepFreeze);

export const FinanceDocumentMatchSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: OpaqueReferenceSchema,
    documentId: OpaqueReferenceSchema,
    extractionRevision: z.number().int().positive(),
    recordType: z.enum([
      'account',
      'transaction',
      'category',
      'budget',
      'bill',
      'subscription',
      'goal',
    ]),
    recordId: OpaqueReferenceSchema,
    scoreBasisPoints: z.number().int().min(0).max(10_000),
    reasons: z.array(z.string().trim().min(1).max(120)).min(1).max(8),
    state: z.enum(['suggested', 'accepted', 'rejected']),
  })
  .transform(deepFreeze);

export const FinanceDocumentMatchListSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    items: z.array(FinanceDocumentMatchSchema).max(100),
  })
  .transform(deepFreeze);

export const FinanceDocumentMatchDecisionSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    decision: z.enum(['accept', 'reject']),
    reviewToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  })
  .transform(deepFreeze);

export const FinanceEvidenceRefSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: OpaqueReferenceSchema,
    documentId: OpaqueReferenceSchema,
    extractionRevision: z.number().int().positive(),
    page: z.number().int().min(1).max(FINANCE_DOCUMENT_LIMITS.maximumPdfPages),
    excerpt: z.string().trim().min(1).max(2_000),
    sourceLocale: FinanceLocaleSchema,
    locator: z.record(z.string(), z.unknown()),
  })
  .transform(deepFreeze);

export const FinanceDocumentEvidenceListSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    items: z.array(FinanceEvidenceRefSchema).max(100),
  })
  .transform(deepFreeze);

const FinanceExperienceSnapshotFields = {
  reviewedCadTotals: z
    .array(
      z.strictObject({
        label: z.string().trim().min(1).max(512),
        amountCadMinor: z.number().int().safe(),
      }),
    )
    .max(FINANCE_EXPERIENCE_LIMITS.maximumCategoryTotals),
  budgets: z
    .array(
      z.strictObject({
        id: OpaqueReferenceSchema,
        label: z.string().trim().min(1).max(512),
        allocatedCadMinor: z.number().int().safe(),
      }),
    )
    .max(FINANCE_EXPERIENCE_LIMITS.maximumMonthlyBudgetAllocations),
} as const;

const FinanceRecentActivitySchema = z
  .array(
    z.strictObject({
      id: OpaqueReferenceSchema,
      label: z.string().trim().min(1).max(500),
      occurredAt: IsoDateTimeSchema,
    }),
  )
  .max(50);

export const FinanceExperienceSnapshotSchema = z
  .strictObject({
    ...FinanceExperienceSnapshotFields,
    recentActivity: FinanceRecentActivitySchema.optional(),
  })
  .transform(deepFreeze);

export const FinanceExperienceV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    locale: FinanceLocaleSchema,
    connectivity: z.enum(['online', 'offline', 'unavailable']),
    quota: z.strictObject({
      documentsUsed: z
        .number()
        .int()
        .nonnegative()
        .max(FINANCE_DOCUMENT_LIMITS.maximumDocumentsPerOwner),
      documentsLimit: z.literal(
        FINANCE_DOCUMENT_LIMITS.maximumDocumentsPerOwner,
      ),
      bytesUsed: z
        .number()
        .int()
        .nonnegative()
        .max(FINANCE_DOCUMENT_LIMITS.maximumBytesPerOwner),
      bytesLimit: z.literal(FINANCE_DOCUMENT_LIMITS.maximumBytesPerOwner),
    }),
    ...FinanceExperienceSnapshotFields,
    recentActivity: FinanceRecentActivitySchema,
  })
  .transform(deepFreeze);

export type FinanceDocumentDetail = DeepReadonly<
  z.output<typeof FinanceDocumentDetailSchema>
>;
export type FinanceDocumentList = DeepReadonly<
  z.output<typeof FinanceDocumentListSchema>
>;
export type FinanceDocumentReviewDraft = DeepReadonly<
  z.output<typeof FinanceDocumentReviewDraftSchema>
>;
export type FinanceDocumentMatch = DeepReadonly<
  z.output<typeof FinanceDocumentMatchSchema>
>;
export type FinanceDocumentMatchList = DeepReadonly<
  z.output<typeof FinanceDocumentMatchListSchema>
>;
export type FinanceDocumentEvidenceList = DeepReadonly<
  z.output<typeof FinanceDocumentEvidenceListSchema>
>;
export type FinanceEvidenceRef = DeepReadonly<
  z.output<typeof FinanceEvidenceRefSchema>
>;
export type FinanceExperienceV1 = DeepReadonly<
  z.output<typeof FinanceExperienceV1Schema>
>;
export type FinanceExperienceSnapshot = DeepReadonly<
  z.output<typeof FinanceExperienceSnapshotSchema>
>;

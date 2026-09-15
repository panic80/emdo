import { z } from 'zod';
import { FinanceStandardizationExtractionSchema } from './finance-standardization.js';
import {
  FinanceBookRoleSchema,
  FinanceCurrencySchema,
  FinanceDecimalSchema,
  FinanceMoneySchema,
  PostJournalSchema,
} from './finance-v2.js';
import { FinanceReportSelectionSchema } from './finance-generated-reports.js';
import {
  FinanceForecastAssumptionInputSchema,
  FinanceForecastOpeningInputSchema,
  FinancePlanningAutomationIntentSchema,
  FinancePlanningCapabilitySchema,
} from './finance-planning.js';
import { IsoDateTimeSchema, Sha256Schema, UuidSchema } from './primitives.js';

/** Current extraction revision: zero requires absence; positive pins saved reuse. */
export const FinanceAutomationExtractionIntentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  evidenceId: UuidSchema,
  expectedSourceDigest: Sha256Schema,
  standardizationRunId: UuidSchema,
  expectedRunRevision: z.number().int().positive(),
  expectedExtractionRevision: z.number().int().min(0).max(3),
});
export type FinanceAutomationExtractionIntent = z.infer<
  typeof FinanceAutomationExtractionIntentSchema
>;
export const PrepareFinanceAutomationExtractionSchema = z.strictObject({
  evidenceId: UuidSchema,
  expectedSourceDigest: Sha256Schema,
});
export const FinanceAutomationExtractionResultSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal('finance-document-extraction'),
    operationId: UuidSchema,
    workspaceId: UuidSchema,
    bookId: UuidSchema,
    evidenceId: UuidSchema,
    sourceDigest: Sha256Schema,
    standardizationRunId: UuidSchema,
    extractionRevision: z.number().int().min(1).max(3),
    extractionDigest: Sha256Schema,
    summary: FinanceStandardizationExtractionSchema,
    approval: z.literal('not-granted'),
    posting: z.literal('not-performed'),
  })
  .superRefine((value, context) => {
    if (
      value.summary.sourceDigest !== value.sourceDigest ||
      value.summary.extractionDigest !== value.extractionDigest ||
      value.summary.revision !== value.extractionRevision
    )
      context.addIssue({
        code: 'custom',
        message: 'Extraction result binding mismatch',
      });
  });

/**
 * A journal automation is prepared from an existing reviewed normalized
 * import. The batch is the source identity; no generated draft id exists at
 * preparation time. SQL binds this reference to one complete snapshot hash.
 */
export const FinanceAutomationJournalDraftIntentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  batchId: UuidSchema,
  expectedBatchRevision: z.number().int().positive(),
  expectedSnapshotHash: Sha256Schema,
});
export type FinanceAutomationJournalDraftIntent = z.infer<
  typeof FinanceAutomationJournalDraftIntentSchema
>;

export const PrepareFinanceAutomationJournalDraftSchema = z.strictObject({
  batchId: UuidSchema,
});

/** Database-owned preparation facts used to build the queued run request.
 * `itemCount` is the number of proposed journal lines and `amount` is the
 * functional-currency debit total; neither value is supplied by the caller.
 */
export const PrepareFinanceAutomationJournalDraftResultSchema = z.strictObject({
  journal: FinanceAutomationJournalDraftIntentSchema,
  itemCount: z.number().int().positive().max(10000),
  currency: FinanceCurrencySchema,
  amount: FinanceDecimalSchema.refine(
    (value) => !value.startsWith('-'),
    'Amount must be nonnegative',
  ),
});
export const FinanceAutomationJournalDraftPreparationSchema =
  PrepareFinanceAutomationJournalDraftResultSchema;
export type PrepareFinanceAutomationJournalDraftResult = z.infer<
  typeof PrepareFinanceAutomationJournalDraftResultSchema
>;

export const FinanceAutomationJournalDraftSourceComponentSchema =
  z.strictObject({
    componentId: UuidSchema,
    revision: z.number().int().positive(),
  });
export const FinanceAutomationJournalDraftSourceRowSchema = z.strictObject({
  rowId: UuidSchema,
  sourceRow: z.number().int().positive(),
  revision: z.number().int().positive(),
  componentRevisions: z
    .array(FinanceAutomationJournalDraftSourceComponentSchema)
    .max(5),
});
export const FinanceAutomationJournalDraftSourceSchema = z.strictObject({
  batchId: UuidSchema,
  batchRevision: z.number().int().positive(),
  snapshotHash: Sha256Schema,
  evidenceId: UuidSchema,
  sourceDigest: Sha256Schema,
  mappingHash: Sha256Schema,
  rows: z.array(FinanceAutomationJournalDraftSourceRowSchema).max(10000),
});

export const FinanceAutomationJournalDraftReviewSchema = z.strictObject({
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().trim().min(3).max(500).nullable(),
  actorId: UuidSchema,
  at: IsoDateTimeSchema,
});
export const FinanceAutomationJournalDraftEventSchema = z.discriminatedUnion(
  'kind',
  [
    z.strictObject({
      kind: z.literal('reviewed'),
      revision: z.number().int().positive(),
      decision: z.enum(['approved', 'rejected']),
      reason: z.string().trim().min(3).max(500).nullable(),
      actorId: UuidSchema,
      at: IsoDateTimeSchema,
    }),
    z.strictObject({
      kind: z.literal('posted'),
      revision: z.number().int().positive(),
      journalIds: z.array(UuidSchema).min(1).max(10000),
      actorId: UuidSchema,
      at: IsoDateTimeSchema,
    }),
    z.strictObject({
      kind: z.literal('discarded'),
      revision: z.number().int().positive(),
      reason: z.string().trim().min(3).max(500),
      actorId: UuidSchema,
      at: IsoDateTimeSchema,
    }),
  ],
);

export const FinanceAutomationJournalDraftProposalSchema = z.strictObject({
  journals: z.array(PostJournalSchema).max(10000),
});

/** Fixed-point decimal comparison for contract-level proposal invariants.
 * FinanceDecimalSchema bounds values to twelve fractional places, so a
 * bigint scale avoids floating-point rounding while checking journal totals.
 */
function decimalUnits(value: string): bigint {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  const units = BigInt(`${whole}${fraction.padEnd(12, '0')}`);
  return negative ? -units : units;
}

/** Immutable generated proposal plus its mutable review/post/discard projection. */
export const FinanceAutomationJournalDraftResultSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal('finance-journal-draft'),
    id: UuidSchema,
    operationId: UuidSchema,
    workspaceId: UuidSchema,
    bookId: UuidSchema,
    revision: z.number().int().nonnegative(),
    status: z.enum([
      'review_required',
      'approved',
      'rejected',
      'posted',
      'discarded',
    ]),
    source: FinanceAutomationJournalDraftSourceSchema,
    currency: FinanceCurrencySchema,
    itemCount: z.number().int().positive().max(10000),
    amount: FinanceDecimalSchema,
    proposal: FinanceAutomationJournalDraftProposalSchema,
    review: FinanceAutomationJournalDraftReviewSchema.nullable(),
    postedJournalIds: z.array(UuidSchema).max(10000),
    posting: z.enum(['not-performed', 'performed']),
    events: z.array(FinanceAutomationJournalDraftEventSchema).max(10000),
  })
  .superRefine((value, context) => {
    const lines = value.proposal.journals.flatMap((journal) => journal.lines);
    if (lines.length !== value.itemCount)
      context.addIssue({
        code: 'custom',
        path: ['itemCount'],
        message:
          'Journal draft item count must match its proposed journal lines',
      });
    let debitTotal = 0n;
    let creditTotal = 0n;
    for (const [journalIndex, journal] of value.proposal.journals.entries()) {
      let journalDebit = 0n;
      let journalCredit = 0n;
      for (const [lineIndex, line] of journal.lines.entries()) {
        const units = decimalUnits(line.amount);
        if (units <= 0n)
          context.addIssue({
            code: 'custom',
            path: [
              'proposal',
              'journals',
              journalIndex,
              'lines',
              lineIndex,
              'amount',
            ],
            message: 'Journal line amounts must be positive',
          });
        if (line.side === 'debit') journalDebit += units;
        else journalCredit += units;
      }
      debitTotal += journalDebit;
      creditTotal += journalCredit;
      if (journalDebit !== journalCredit)
        context.addIssue({
          code: 'custom',
          path: ['proposal', 'journals', journalIndex, 'lines'],
          message: 'Each proposed journal must balance',
        });
    }
    if (debitTotal !== creditTotal)
      context.addIssue({
        code: 'custom',
        path: ['proposal'],
        message: 'Proposed journal debit and credit totals must balance',
      });
    if (decimalUnits(value.amount) !== debitTotal)
      context.addIssue({
        code: 'custom',
        path: ['amount'],
        message: 'Journal draft amount must equal the functional debit total',
      });
    if (value.amount.startsWith('-'))
      context.addIssue({
        code: 'custom',
        path: ['amount'],
        message: 'Amount must be nonnegative',
      });
    const hasReview = value.review !== null;
    const reviewStateValid =
      (value.status === 'review_required' && !hasReview) ||
      (['approved', 'rejected', 'posted'].includes(value.status) &&
        hasReview) ||
      value.status === 'discarded';
    if (!reviewStateValid)
      context.addIssue({
        code: 'custom',
        path: ['review'],
        message:
          'Approved or posted journal draft states retain review provenance',
      });
    if ((value.posting === 'performed') !== (value.status === 'posted'))
      context.addIssue({
        code: 'custom',
        path: ['posting'],
        message: 'Posting state must match draft status',
      });
    if (value.status === 'posted' && value.postedJournalIds.length === 0)
      context.addIssue({
        code: 'custom',
        path: ['postedJournalIds'],
        message: 'Posted drafts require journal identities',
      });
    if (value.status !== 'posted' && value.postedJournalIds.length > 0)
      context.addIssue({
        code: 'custom',
        path: ['postedJournalIds'],
        message: 'Only posted drafts may carry journal identities',
      });
    const last = value.events.at(-1);
    if (last && last.revision !== value.revision)
      context.addIssue({
        code: 'custom',
        path: ['events'],
        message: 'Draft event revision does not match projection revision',
      });
    if (
      value.status === 'review_required' &&
      (value.revision !== 0 || value.events.length !== 0)
    )
      context.addIssue({
        code: 'custom',
        path: ['revision'],
        message: 'A new journal draft has no lifecycle events',
      });
    if (
      (value.status === 'approved' || value.status === 'rejected') &&
      last?.kind !== 'reviewed'
    )
      context.addIssue({
        code: 'custom',
        path: ['events'],
        message: 'Reviewed journal drafts require a review event',
      });
    if (value.status === 'posted' && last?.kind !== 'posted')
      context.addIssue({
        code: 'custom',
        path: ['events'],
        message: 'Posted journal drafts require a posted event',
      });
    if (value.status === 'discarded' && last?.kind !== 'discarded')
      context.addIssue({
        code: 'custom',
        path: ['events'],
        message: 'Discarded journal drafts require a discarded event',
      });
  });
export type FinanceAutomationJournalDraftResult = z.infer<
  typeof FinanceAutomationJournalDraftResultSchema
>;

export const ReviewFinanceAutomationJournalDraftSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().trim().min(3).max(500).nullable().default(null),
});
export const DiscardFinanceAutomationJournalDraftSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(3).max(500),
});
export const PostFinanceAutomationJournalDraftSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
});
const RevisionSchema = z.number().int().safe().positive();
const CountSchema = z.number().int().safe().nonnegative();
/** Decimal currency amounts match the Finance v2 public money contract. */
const AmountSchema = FinanceDecimalSchema.refine(
  (value) => !value.startsWith('-'),
  'Amount must be nonnegative',
);

/** Closed leaf operations: no delegation, authority editing, posting, or provider writes. */
export const FinanceAutomationCapabilitySchema = z.enum([
  'finance.documents.extract',
  'finance.reports.generate',
  'finance.journals.draft',
  'finance.planning.budget-vs-actuals',
  'finance.planning.forecast',
]);
export const FinanceAutomationPlanningCapabilitySchema =
  FinancePlanningCapabilitySchema;
export const FinanceAutomationBudgetVsActualsIntentSchema =
  FinancePlanningAutomationIntentSchema.omit({
    capability: true,
    asOf: true,
    itemCount: true,
  }).extend({
    capability: z.literal('finance.planning.budget-vs-actuals'),
    asOf: z.null(),
    itemCount: z.number().int().safe().positive().max(10000),
  });
const ReviewedAssumptionsSchema = z
  .array(FinanceForecastAssumptionInputSchema)
  .max(10000)
  .superRefine((values, context) => {
    const identities = values.map(
      (value) => `${value.periodId}:${value.accountId}:${value.currency}`,
    );
    if (new Set(identities).size !== identities.length) {
      context.addIssue({
        code: 'custom',
        path: [],
        message: 'Reviewed assumption identities must be unique',
      });
    }
  });
export const FinanceAutomationForecastIntentSchema =
  FinancePlanningAutomationIntentSchema.omit({
    capability: true,
    asOf: true,
    itemCount: true,
  }).extend({
    capability: z.literal('finance.planning.forecast'),
    asOf: z.iso.date(),
    itemCount: z.number().int().safe().positive().max(10000),
    /** Explicit reviewed opening state is part of the persisted intent. */
    openingBalance: FinanceForecastOpeningInputSchema,
    /** Only reviewed inputs may feed future forecast lines. */
    assumptions: ReviewedAssumptionsSchema,
  });
/** Versioned planning intent carried by a scheduled run. The database must
 * reread the exact budget revision and validate the reviewed input references
 * under the authority transaction before saving an outcome. */
export const FinanceAutomationPlanningIntentSchema = z.discriminatedUnion(
  'capability',
  [
    FinanceAutomationBudgetVsActualsIntentSchema,
    FinanceAutomationForecastIntentSchema,
  ],
);
export type FinanceAutomationPlanningIntent = z.infer<
  typeof FinanceAutomationPlanningIntentSchema
>;
export type FinanceAutomationCapability = z.infer<
  typeof FinanceAutomationCapabilitySchema
>;
export function isFinanceAutomationPlanningCapability(
  capability: FinanceAutomationCapability,
): capability is z.infer<typeof FinanceAutomationPlanningCapabilitySchema> {
  return (
    capability === 'finance.planning.budget-vs-actuals' ||
    capability === 'finance.planning.forecast'
  );
}
const CapabilitiesSchema = z
  .array(FinanceAutomationCapabilitySchema)
  .min(1)
  .max(5)
  .refine(
    (values) => new Set(values).size === values.length,
    'Duplicate capability',
  );
export const FinanceAutomationAuthorityRevisionSchema = z.strictObject({
  membership: RevisionSchema,
  bookAccess: RevisionSchema,
  entitlement: RevisionSchema,
});
export const FinanceAutomationLimitsSchema = z
  .strictObject({
    maxRuns: RevisionSchema,
    maxAttemptsPerRun: RevisionSchema.max(10),
    maxItemsPerRun: RevisionSchema.max(10000),
    maxTotalItems: RevisionSchema,
    currency: FinanceCurrencySchema,
    maxAmountPerRun: AmountSchema,
    maxTotalAmount: AmountSchema,
  })
  .refine(
    (value) =>
      [value.maxAmountPerRun, value.maxTotalAmount].every(
        (amount) =>
          FinanceMoneySchema.safeParse({ amount, currency: value.currency })
            .success,
      ),
    'Amount exceeds currency precision',
  );
/** Persisted by the EMDO control plane following an authenticated grant decision.
 * User/session/browser objects cannot substitute for this revocable record.
 */
export const FinanceAutomationGrantSchema = z
  .strictObject({
    id: UuidSchema,
    revision: RevisionSchema,
    workspaceId: UuidSchema,
    bookId: UuidSchema,
    grantedByUserId: UuidSchema,
    executor: z.literal('emdo-managed'),
    specialist: z.literal('finance'),
    status: z.enum(['active', 'revoked']),
    allowedCapabilities: CapabilitiesSchema,
    authorityRevision: FinanceAutomationAuthorityRevisionSchema,
    limits: FinanceAutomationLimitsSchema,
    validFrom: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
  })
  .refine(
    (value) => Date.parse(value.validFrom) < Date.parse(value.expiresAt),
    'Grant validity interval is empty',
  );

/** Queue data is a reference and exact bounded intent, never execution authority. */
export const FinanceAutomationRunRequestSchema = z
  .strictObject({
    operationId: UuidSchema,
    grantId: UuidSchema,
    grantRevision: RevisionSchema,
    workspaceId: UuidSchema,
    bookId: UuidSchema,
    capability: FinanceAutomationCapabilitySchema,
    requestHash: Sha256Schema,
    itemCount: RevisionSchema.max(10000),
    currency: FinanceCurrencySchema,
    amount: AmountSchema,
    /** Legacy requests default to the original all-posted trial balance. */
    report: FinanceReportSelectionSchema.optional(),
    /** Planning requests carry exact revision and reviewed forecast inputs. */
    planning: FinanceAutomationPlanningIntentSchema.optional(),
    extraction: FinanceAutomationExtractionIntentSchema.optional(),
    /** Journal requests carry an exact reviewed normalized-import snapshot. */
    journal: FinanceAutomationJournalDraftIntentSchema.optional(),
  })
  .superRefine((value, context) => {
    if (
      !FinanceMoneySchema.safeParse({
        amount: value.amount,
        currency: value.currency,
      }).success
    ) {
      context.addIssue({
        code: 'custom',
        path: ['amount'],
        message: 'Amount exceeds currency precision',
      });
    }
    if (
      (value.capability === 'finance.documents.extract') !==
        (value.extraction !== undefined) ||
      (value.extraction &&
        (value.itemCount !== 1 ||
          !/^0(?:\.0+)?$/.test(value.amount) ||
          value.report !== undefined ||
          value.planning !== undefined ||
          value.journal !== undefined))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['extraction'],
        message:
          'Extraction requires one exact source and zero amount, without other intents',
      });
    }
    const journalCapability = value.capability === 'finance.journals.draft';
    if (journalCapability !== (value.journal !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['journal'],
        message: journalCapability
          ? 'Journal capability requires an exact reviewed import snapshot'
          : 'Journal intent is only valid for finance.journals.draft',
      });
    }
    if (
      value.journal !== undefined &&
      (value.report !== undefined ||
        value.planning !== undefined ||
        value.extraction !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['journal'],
        message: 'Journal runs cannot carry another automation intent',
      });
    }
    const planningCapability = isFinanceAutomationPlanningCapability(
      value.capability,
    );
    if (planningCapability && value.planning === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['planning'],
        message: 'Planning capability requires a versioned planning intent',
      });
      return;
    }
    if (!planningCapability && value.planning !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['planning'],
        message: 'Planning intent is only valid for a planning capability',
      });
      return;
    }
    if (value.planning === undefined) return;
    if (value.planning.capability !== value.capability) {
      context.addIssue({
        code: 'custom',
        path: ['planning', 'capability'],
        message: 'Planning capability does not match the run capability',
      });
    }
    if (value.planning.currency !== value.currency) {
      context.addIssue({
        code: 'custom',
        path: ['planning', 'currency'],
        message: 'Planning currency does not match the run currency',
      });
    }
    if (value.planning.itemCount !== value.itemCount) {
      context.addIssue({
        code: 'custom',
        path: ['planning', 'itemCount'],
        message: 'Planning item count does not match the run item count',
      });
    }
    if (!/^0(?:\.0+)?$/.test(value.amount)) {
      context.addIssue({
        code: 'custom',
        path: ['amount'],
        message: 'Planning runs cannot reserve a nonzero amount',
      });
    }
    if (value.report !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['report'],
        message: 'Planning runs cannot carry a report selection',
      });
    }
    if (value.journal !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['journal'],
        message: 'Planning runs cannot carry a journal intent',
      });
    }
  });

/** Trusted repository output, reread under the execution transaction on EVERY
 * attempt. Never deserialize this from a queue payload or specialist response.
 * The revision must advance for any membership/book-policy/entitlement change.
 */
export const FinanceAutomationCurrentAuthoritySchema = z.strictObject({
  checkedAt: IsoDateTimeSchema,
  workspaceId: UuidSchema,
  bookId: UuidSchema,
  userId: UuidSchema,
  membershipStatus: z.enum(['active', 'inactive']),
  bookStatus: z.enum(['active', 'archived']),
  bookRole: FinanceBookRoleSchema.nullable(),
  automationEntitled: z.boolean(),
  /** Current registry-ready, role-permitted AND entitled leaf capabilities;
   * never copied from the persisted grant alone. */
  allowedCapabilities: z.array(FinanceAutomationCapabilitySchema).max(5),
  authorityRevision: FinanceAutomationAuthorityRevisionSchema,
});

/** Includes all committed usage and outstanding reservations, EXCLUDING this
 * operation's reservation on retries. Enforce/update atomically with claim.
 */
export const FinanceAutomationUsageSchema = z
  .strictObject({
    grantId: UuidSchema,
    runs: CountSchema,
    items: CountSchema,
    currency: FinanceCurrencySchema,
    amount: AmountSchema,
  })
  .refine(
    (value) =>
      FinanceMoneySchema.safeParse({
        amount: value.amount,
        currency: value.currency,
      }).success,
    'Amount exceeds currency precision',
  );
export const FinanceAutomationRunSchema = z
  .strictObject({
    request: FinanceAutomationRunRequestSchema,
    revision: RevisionSchema,
    attempts: CountSchema,
    status: z.enum([
      'queued',
      'executing',
      'retryable',
      'completed',
      'blocked',
      'requires-reconciliation',
    ]),
    outcomeReference: UuidSchema.nullable(),
  })
  .refine(
    (run) => (run.status === 'completed') === (run.outcomeReference !== null),
    'Only completed runs have an outcome reference',
  );

export type FinanceAutomationGrant = z.infer<
  typeof FinanceAutomationGrantSchema
>;
export type FinanceAutomationRunRequest = z.infer<
  typeof FinanceAutomationRunRequestSchema
>;
export type FinanceAutomationCurrentAuthority = z.infer<
  typeof FinanceAutomationCurrentAuthoritySchema
>;
export type FinanceAutomationUsage = z.infer<
  typeof FinanceAutomationUsageSchema
>;
export type FinanceAutomationRun = z.infer<typeof FinanceAutomationRunSchema>;

/** Readable run history excludes worker lease credentials and canonical intent. */
export const FinanceAutomationRunRecordSchema = z.strictObject({
  run: FinanceAutomationRunSchema,
  createdAt: IsoDateTimeSchema,
  blockedReason: z.string().min(1).max(500).nullable(),
});
export type FinanceAutomationRunRecord = z.infer<
  typeof FinanceAutomationRunRecordSchema
>;

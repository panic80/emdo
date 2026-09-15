import { z } from 'zod';

import {
  JsonValueSchema,
  OpaqueReferenceSchema,
  Sha256Schema,
  UuidSchema,
  deepFreeze,
  type DeepReadonly as DeepReadonlyType,
} from './primitives.js';
import { FinanceCurrencySchema, FinanceDecimalSchema } from './finance-v2.js';

/**
 * The legacy Finance store is the private sync-entity record store. These
 * values intentionally mirror its entity type names so a migration can retain
 * an exact source identity instead of deriving one from display labels.
 */
export const FinanceLegacyEntityTypeSchema = z.enum([
  'finance.account',
  'finance.transaction',
  'finance.category',
  'finance.budget',
  'finance.bill',
  'finance.subscription',
  'finance.goal',
]);
export type FinanceLegacyEntityType = z.infer<
  typeof FinanceLegacyEntityTypeSchema
>;

/** Canonical record names used inside the normalized migration candidate. */
export const FinanceLegacyNormalizedRecordTypeSchema = z.enum([
  'account',
  'transaction',
  'category',
  'budget',
  'bill',
  'subscription',
  'goal',
]);
export type FinanceLegacyNormalizedRecordType = z.infer<
  typeof FinanceLegacyNormalizedRecordTypeSchema
>;

export const FinanceLegacySourceScopeSchema = z.strictObject({
  householdId: UuidSchema,
  privateSpaceId: UuidSchema,
  originalOwnerUserId: UuidSchema,
});
export type FinanceLegacySourceScope = z.infer<
  typeof FinanceLegacySourceScopeSchema
>;

const LegacyImportProvenanceSchema = z.strictObject({
  kind: z.literal('import'),
  sourceHash: Sha256Schema,
  sourceRow: z.number().int().positive().max(100_000),
  fingerprint: Sha256Schema,
  externalId: OpaqueReferenceSchema.nullable(),
});

export const FinanceLegacySourceProvenanceSchema = z.discriminatedUnion(
  'kind',
  [z.strictObject({ kind: z.literal('manual') }), LegacyImportProvenanceSchema],
);
export type FinanceLegacySourceProvenance = z.infer<
  typeof FinanceLegacySourceProvenanceSchema
>;

/** One immutable source row captured from sync_entities for a migration run. */
export const FinanceLegacySourceRecordSchema = z
  .strictObject({
    source: FinanceLegacySourceScopeSchema,
    entityType: FinanceLegacyEntityTypeSchema,
    entityId: OpaqueReferenceSchema,
    legacyRowId: UuidSchema,
    revision: z.number().int().positive().safe(),
    tombstoned: z.boolean(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    payload: JsonValueSchema,
    payloadHash: Sha256Schema,
    provenance: FinanceLegacySourceProvenanceSchema.nullable(),
  })
  .transform(deepFreeze);
export type FinanceLegacySourceRecord = DeepReadonlyType<
  z.output<typeof FinanceLegacySourceRecordSchema>
>;

const LegacyAccountMappingSchema = z.strictObject({
  legacyAccountId: OpaqueReferenceSchema,
  targetFinancialAccountId: UuidSchema,
});
const LegacyCategoryMappingSchema = z.strictObject({
  legacyCategoryId: OpaqueReferenceSchema,
  targetLedgerAccountId: UuidSchema,
});
const LegacyEvidenceMappingSchema = z.strictObject({
  legacyEntityId: OpaqueReferenceSchema,
  targetEvidenceId: UuidSchema,
});
const LegacyOpeningMappingSchema = z.strictObject({
  openingEffectiveOn: z.iso.date().nullable().default(null),
  legacyAccountId: OpaqueReferenceSchema,
  disposition: z.enum(['queue', 'explicit-opening']),
  targetLedgerAccountId: UuidSchema.nullable(),
  targetEvidenceId: UuidSchema.nullable(),
});

export const FinanceLegacyMigrationNormalizedSchema = z.strictObject({
  recordType: FinanceLegacyNormalizedRecordTypeSchema,
  nativeAmount: FinanceDecimalSchema.nullable(),
  currency: FinanceCurrencySchema.nullable(),
  sourceRow: z.number().int().positive().max(100_000).nullable(),
  externalId: OpaqueReferenceSchema.nullable(),
  sourceHash: Sha256Schema.nullable(),
  fingerprint: Sha256Schema.nullable(),
});
export type FinanceLegacyMigrationNormalized = z.infer<
  typeof FinanceLegacyMigrationNormalizedSchema
>;

export const FinanceLegacyMigrationClassificationSchema = z.strictObject({
  targetFinancialAccountId: UuidSchema.nullable(),
  targetLedgerAccountId: UuidSchema.nullable(),
  targetEvidenceId: UuidSchema.nullable(),
});
export type FinanceLegacyMigrationClassification = z.infer<
  typeof FinanceLegacyMigrationClassificationSchema
>;

/**
 * Explicit operator supplied mappings. A migration never chooses a book,
 * legal entity, financial account, ledger account, or evidence record from a
 * name or a household default.
 */
export const FinanceLegacyMigrationMappingSchema = z
  .strictObject({
    source: FinanceLegacySourceScopeSchema,
    target: z.strictObject({
      workspaceId: UuidSchema,
      bookId: UuidSchema,
      ownerUserId: UuidSchema,
    }),
    financialAccounts: z.array(LegacyAccountMappingSchema).max(10_000),
    categories: z.array(LegacyCategoryMappingSchema).max(10_000),
    evidence: z.array(LegacyEvidenceMappingSchema).max(100_000),
    openings: z.array(LegacyOpeningMappingSchema).max(10_000),
  })
  .superRefine((value, context) => {
    const duplicate = (
      values: readonly string[],
      path: (string | number)[],
      message: string,
    ) => {
      if (new Set(values).size !== values.length)
        context.addIssue({ code: 'custom', path, message });
    };
    if (value.source.householdId !== value.target.workspaceId) {
      context.addIssue({
        code: 'custom',
        path: ['target', 'workspaceId'],
        message: 'Target workspace must retain the legacy household identity',
      });
    }
    if (value.source.originalOwnerUserId !== value.target.ownerUserId) {
      context.addIssue({
        code: 'custom',
        path: ['target', 'ownerUserId'],
        message: 'Target owner must retain the legacy original owner',
      });
    }
    duplicate(
      value.financialAccounts.map((entry) => entry.legacyAccountId),
      ['financialAccounts'],
      'Legacy account mappings must be unique',
    );
    duplicate(
      value.categories.map((entry) => entry.legacyCategoryId),
      ['categories'],
      'Legacy category mappings must be unique',
    );
    duplicate(
      value.evidence.map((entry) => entry.legacyEntityId),
      ['evidence'],
      'Legacy evidence mappings must be unique',
    );
    duplicate(
      value.openings.map((entry) => entry.legacyAccountId),
      ['openings'],
      'Legacy opening mappings must be unique',
    );
    value.openings.forEach((opening, index) => {
      if (
        opening.disposition === 'explicit-opening' &&
        (opening.targetLedgerAccountId === null ||
          opening.targetEvidenceId === null)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['openings', index],
          message:
            'An explicit opening requires a target ledger account and evidence',
        });
      }
      if (
        opening.disposition === 'queue' &&
        (opening.targetLedgerAccountId !== null ||
          opening.targetEvidenceId !== null ||
          opening.openingEffectiveOn !== null)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['openings', index],
          message: 'Queued openings cannot carry posting mappings',
        });
      }
    });
  })
  .transform(deepFreeze);
export type FinanceLegacyMigrationMapping = DeepReadonlyType<
  z.output<typeof FinanceLegacyMigrationMappingSchema>
>;

/** Stable target IDs are generated by the trusted repository and persisted. */
export const FinanceLegacyStableTargetIdSchema = z.strictObject({
  entityType: FinanceLegacyEntityTypeSchema,
  entityId: OpaqueReferenceSchema,
  targetRecordId: UuidSchema,
  targetBatchId: UuidSchema.nullable(),
  targetRowId: UuidSchema.nullable(),
});

export const FinanceLegacyMigrationPlanningInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  mapping: FinanceLegacyMigrationMappingSchema,
  sourceRecords: z.array(FinanceLegacySourceRecordSchema).max(100_000),
  stableTargetIds: z.array(FinanceLegacyStableTargetIdSchema).max(100_000),
});
export type FinanceLegacyMigrationPlanningInput = z.input<
  typeof FinanceLegacyMigrationPlanningInputSchema
>;

export const FinanceLegacyMigrationCandidateStatusSchema = z.enum([
  'ready',
  'blocked',
  'preserved',
]);
export type FinanceLegacyMigrationCandidateStatus = z.infer<
  typeof FinanceLegacyMigrationCandidateStatusSchema
>;
export const FinanceLegacyMigrationDispositionSchema = z.enum([
  'backfill',
  'preserve-only',
  'unresolved',
]);

export const FinanceLegacyMigrationCandidateSchema = z
  .strictObject({
    entityType: FinanceLegacyEntityTypeSchema,
    entityId: OpaqueReferenceSchema,
    sourceRevision: z.number().int().positive().safe(),
    targetRecordId: UuidSchema,
    targetBatchId: UuidSchema.nullable(),
    targetRowId: UuidSchema.nullable(),
    status: FinanceLegacyMigrationCandidateStatusSchema,
    disposition: FinanceLegacyMigrationDispositionSchema,
    normalized: FinanceLegacyMigrationNormalizedSchema,
    classification: FinanceLegacyMigrationClassificationSchema,
    blockers: z.array(z.string().regex(/^[a-z0-9.-]+$/)).max(32),
  })
  .transform(deepFreeze);
export type FinanceLegacyMigrationCandidate = DeepReadonlyType<
  z.output<typeof FinanceLegacyMigrationCandidateSchema>
>;

export const FinanceLegacyMigrationRecordSchema = z
  .strictObject({
    id: UuidSchema,
    migrationId: UuidSchema,
    workspaceId: UuidSchema,
    bookId: UuidSchema,
    source: FinanceLegacySourceScopeSchema,
    entityType: FinanceLegacyEntityTypeSchema,
    entityId: OpaqueReferenceSchema,
    legacyRowId: UuidSchema,
    sourceRevision: z.number().int().positive().safe(),
    tombstoned: z.boolean(),
    payload: JsonValueSchema,
    payloadHash: Sha256Schema,
    provenance: FinanceLegacySourceProvenanceSchema.nullable(),
    status: FinanceLegacyMigrationCandidateStatusSchema,
    disposition: FinanceLegacyMigrationDispositionSchema,
    normalized: FinanceLegacyMigrationNormalizedSchema,
    classification: FinanceLegacyMigrationClassificationSchema,
    blockers: z.array(z.string().regex(/^[a-z0-9.-]+$/)).max(32),
    targetRecordId: UuidSchema,
    targetBatchId: UuidSchema.nullable(),
    targetRowId: UuidSchema.nullable(),
    backfillState: z.enum(['pending', 'backfilled', 'preserved']),
    backfilledAt: z.iso.datetime({ offset: true }).nullable(),
    revision: z.number().int().positive().safe(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .transform(deepFreeze);
export type FinanceLegacyMigrationRecord = DeepReadonlyType<
  z.output<typeof FinanceLegacyMigrationRecordSchema>
>;

export const FinanceLegacyMigrationPlanSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    calculationVersion: z.literal('finance-legacy-migration.v1'),
    mapping: FinanceLegacyMigrationMappingSchema,
    sourceSnapshotHash: Sha256Schema,
    mappingHash: Sha256Schema,
    status: z.enum(['ready', 'blocked']),
    candidates: z.array(FinanceLegacyMigrationCandidateSchema).max(100_000),
    counts: z.strictObject({
      source: z.number().int().nonnegative().safe(),
      ready: z.number().int().nonnegative().safe(),
      blocked: z.number().int().nonnegative().safe(),
      preserved: z.number().int().nonnegative().safe(),
      unresolved: z.number().int().nonnegative().safe(),
    }),
  })
  .superRefine((plan, context) => {
    const count = (status: FinanceLegacyMigrationCandidateStatus) =>
      plan.candidates.filter((candidate) => candidate.status === status).length;
    const unresolved = plan.candidates.filter(
      (candidate) => candidate.disposition === 'unresolved',
    ).length;
    if (
      plan.counts.source !== plan.candidates.length ||
      plan.counts.ready !== count('ready') ||
      plan.counts.blocked !== count('blocked') ||
      plan.counts.preserved !== count('preserved') ||
      plan.counts.unresolved !== unresolved
    ) {
      context.addIssue({
        code: 'custom',
        path: ['counts'],
        message: 'Migration plan counts must match its candidates',
      });
    }
    if (
      (plan.status === 'ready' &&
        (plan.counts.blocked !== 0 || plan.counts.unresolved !== 0)) ||
      (plan.status === 'blocked' && plan.counts.blocked === 0)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'Migration readiness must reflect unresolved candidates',
      });
    }
  })
  .transform(deepFreeze);
export type FinanceLegacyMigrationPlan = DeepReadonlyType<
  z.output<typeof FinanceLegacyMigrationPlanSchema>
>;

export const FinanceLegacyMigrationInspectionSchema = z
  .strictObject({
    run: z.lazy(() => FinanceLegacyMigrationRunSchema),
    plan: FinanceLegacyMigrationPlanSchema,
    records: z.array(FinanceLegacyMigrationRecordSchema).max(100_000),
  })
  .transform(deepFreeze);

export const FinanceLegacyMigrationRunStatusSchema = z.enum([
  'review',
  'backfilled',
  'comparison-passed',
  'blocked',
  'cutover-approved',
]);
export type FinanceLegacyMigrationRunStatus = z.infer<
  typeof FinanceLegacyMigrationRunStatusSchema
>;

export const FinanceLegacyMigrationRunSchema = z
  .strictObject({
    id: UuidSchema,
    mapping: FinanceLegacyMigrationMappingSchema,
    status: FinanceLegacyMigrationRunStatusSchema,
    revision: z.number().int().positive().safe(),
    sourceSnapshotHash: Sha256Schema,
    mappingHash: Sha256Schema,
    sourceCount: z.number().int().nonnegative().safe(),
    readyCount: z.number().int().nonnegative().safe(),
    blockedCount: z.number().int().nonnegative().safe(),
    backfilledCount: z.number().int().nonnegative().safe(),
    unresolvedCount: z.number().int().nonnegative().safe(),
    createdBy: UuidSchema,
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .transform(deepFreeze);
export type FinanceLegacyMigrationRun = DeepReadonlyType<
  z.output<typeof FinanceLegacyMigrationRunSchema>
>;

export const FinanceLegacyMigrationHistoricalReviewDecisionSchema = z
  .strictObject({
    targetFinancialAccountId: UuidSchema.nullable().default(null),
    targetLedgerAccountId: UuidSchema.nullable().default(null),
    targetEvidenceId: UuidSchema.nullable().default(null),
    openingDisposition: z.enum(['queue', 'explicit-opening']).default('queue'),
    openingLedgerAccountId: UuidSchema.nullable().default(null),
    openingEvidenceId: UuidSchema.nullable().default(null),
    openingEffectiveOn: z.iso.date().nullable().default(null),
    classificationConfirmed: z.boolean().default(false),
    reason: z.string().trim().min(3).max(1_000),
  })
  .superRefine((decision, context) => {
    if (
      decision.openingDisposition === 'explicit-opening' &&
      (decision.openingLedgerAccountId === null ||
        decision.openingEvidenceId === null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['openingDisposition'],
        message:
          'An explicit opening review requires a ledger account and evidence',
      });
    }
    if (
      decision.openingDisposition === 'queue' &&
      (decision.openingLedgerAccountId !== null ||
        decision.openingEvidenceId !== null ||
        decision.openingEffectiveOn !== null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['openingDisposition'],
        message: 'A queued opening cannot carry posting mappings',
      });
    }
  });
/** New review commands require a date; historical receipts remain readable as unresolved. */
export const FinanceLegacyMigrationReviewDecisionSchema =
  FinanceLegacyMigrationHistoricalReviewDecisionSchema.superRefine(
    (decision, context) => {
      if (
        decision.openingDisposition === 'explicit-opening' &&
        decision.openingEffectiveOn === null
      )
        context.addIssue({
          code: 'custom',
          path: ['openingEffectiveOn'],
          message:
            'An explicit opening review requires a reviewed effective date',
        });
    },
  );
export type FinanceLegacyMigrationReviewDecision = z.infer<
  typeof FinanceLegacyMigrationReviewDecisionSchema
>;

export const FinanceLegacyMigrationReviewSchema = z
  .strictObject({
    id: UuidSchema,
    migrationId: UuidSchema,
    recordId: UuidSchema,
    revision: z.number().int().positive().safe(),
    decision: FinanceLegacyMigrationHistoricalReviewDecisionSchema,
    previousState: JsonValueSchema,
    reviewedBy: UuidSchema,
    createdAt: z.iso.datetime({ offset: true }),
  })
  .transform(deepFreeze);
export type FinanceLegacyMigrationReview = DeepReadonlyType<
  z.output<typeof FinanceLegacyMigrationReviewSchema>
>;

export const FinanceLegacyMigrationComparisonSchema = z
  .strictObject({
    id: UuidSchema,
    migrationId: UuidSchema,
    sourceSnapshotHash: Sha256Schema,
    targetSnapshotHash: Sha256Schema,
    status: z.enum(['passed', 'failed']),
    sourceTransactionCount: z.number().int().nonnegative().safe(),
    targetTransactionCount: z.number().int().nonnegative().safe(),
    sourceCadMinorTotal: z.string().regex(/^-?\d+$/),
    targetCadDecimalTotal: FinanceDecimalSchema,
    unresolvedCount: z.number().int().nonnegative().safe(),
    mismatches: z.array(z.string().regex(/^[a-z0-9.-]+$/)).max(64),
    createdBy: UuidSchema,
    createdAt: z.iso.datetime({ offset: true }),
  })
  .transform(deepFreeze);
export type FinanceLegacyMigrationComparison = DeepReadonlyType<
  z.output<typeof FinanceLegacyMigrationComparisonSchema>
>;

/** Pure comparison input/output used before a report is persisted. */
export const FinanceLegacyMigrationComparisonCalculationSchema = z
  .strictObject({
    sourceSnapshotHash: Sha256Schema,
    targetSnapshotHash: Sha256Schema,
    status: z.enum(['passed', 'failed']),
    sourceTransactionCount: z.number().int().nonnegative().safe(),
    targetTransactionCount: z.number().int().nonnegative().safe(),
    sourceCadMinorTotal: z.string().regex(/^-?\d+$/),
    targetCadDecimalTotal: FinanceDecimalSchema,
    unresolvedCount: z.number().int().nonnegative().safe(),
    mismatches: z.array(z.string().regex(/^[a-z0-9.-]+$/)).max(64),
  })
  .transform(deepFreeze);
export type FinanceLegacyMigrationComparisonCalculation = DeepReadonlyType<
  z.output<typeof FinanceLegacyMigrationComparisonCalculationSchema>
>;

export const FinanceLegacyMigrationTargetTransactionSchema = z.strictObject({
  entityType: z.literal('finance.transaction'),
  entityId: OpaqueReferenceSchema,
  targetRowId: UuidSchema,
  status: z.enum(['backfilled', 'missing']),
  nativeAmount: FinanceDecimalSchema.nullable(),
  currency: FinanceCurrencySchema.nullable(),
});

export const FinanceLegacyMigrationComparisonInputSchema = z.strictObject({
  sourceRecords: z.array(FinanceLegacySourceRecordSchema).max(100_000),
  candidates: z.array(FinanceLegacyMigrationCandidateSchema).max(100_000),
  targetTransactions: z
    .array(FinanceLegacyMigrationTargetTransactionSchema)
    .max(100_000),
});

export const FinanceLegacyMigrationCutoverDecisionSchema = z
  .strictObject({
    ready: z.boolean(),
    blockers: z.array(z.string().regex(/^[a-z0-9.-]+$/)).max(64),
  })
  .transform(deepFreeze);
export type FinanceLegacyMigrationCutoverDecision = DeepReadonlyType<
  z.output<typeof FinanceLegacyMigrationCutoverDecisionSchema>
>;

export const FinanceLegacyMigrationBackfillResultSchema = z
  .strictObject({
    migrationId: UuidSchema,
    status: z.literal('backfilled'),
    targetBatchIds: z.array(UuidSchema).max(10_000),
    targetRowIds: z.array(UuidSchema).max(100_000),
    backfilledCount: z.number().int().nonnegative().safe(),
    preservedCount: z.number().int().nonnegative().safe(),
    sourceSnapshotHash: Sha256Schema,
    replayed: z.boolean(),
  })
  .transform(deepFreeze);
export type FinanceLegacyMigrationBackfillResult = DeepReadonlyType<
  z.output<typeof FinanceLegacyMigrationBackfillResultSchema>
>;

export const FinanceLegacyMigrationCutoverSchema = z
  .strictObject({
    id: UuidSchema,
    migrationId: UuidSchema,
    source: FinanceLegacySourceScopeSchema,
    target: z.strictObject({
      workspaceId: UuidSchema,
      bookId: UuidSchema,
      ownerUserId: UuidSchema,
    }),
    comparisonId: UuidSchema,
    status: z.literal('approved'),
    approvedBy: UuidSchema,
    approvedAt: z.iso.datetime({ offset: true }),
  })
  .transform(deepFreeze);
export type FinanceLegacyMigrationCutover = DeepReadonlyType<
  z.output<typeof FinanceLegacyMigrationCutoverSchema>
>;

export const FinanceLegacyMigrationIdempotencySchema = z.strictObject({
  idempotencyKey: z
    .string()
    .trim()
    .min(16)
    .max(200)
    .regex(/^[A-Za-z0-9:._-]+$/),
});

export const FinanceLegacyMigrationInspectInputSchema = z
  .strictObject({
    mapping: FinanceLegacyMigrationMappingSchema.superRefine(
      (mapping, context) => {
        mapping.openings.forEach((opening, index) => {
          if (
            opening.disposition === 'explicit-opening' &&
            opening.openingEffectiveOn === null
          )
            context.addIssue({
              code: 'custom',
              path: ['openings', index, 'openingEffectiveOn'],
              message:
                'A new explicit opening mapping requires a reviewed effective date',
            });
        });
      },
    ),
    idempotencyKey:
      FinanceLegacyMigrationIdempotencySchema.shape.idempotencyKey,
  })
  .transform(deepFreeze);
export type FinanceLegacyMigrationInspectInput = DeepReadonlyType<
  z.output<typeof FinanceLegacyMigrationInspectInputSchema>
>;

export const FinanceLegacyMigrationReviewInputSchema = z
  .strictObject({
    migrationId: UuidSchema,
    recordId: UuidSchema,
    expectedRevision: z.number().int().positive().safe(),
    decision: FinanceLegacyMigrationReviewDecisionSchema,
  })
  .transform(deepFreeze);
export type FinanceLegacyMigrationReviewInput = DeepReadonlyType<
  z.output<typeof FinanceLegacyMigrationReviewInputSchema>
>;

export const FinanceLegacyMigrationBackfillInputSchema = z
  .strictObject({
    migrationId: UuidSchema,
    expectedRevision: z.number().int().positive().safe(),
    sourceSnapshotHash: Sha256Schema,
    idempotencyKey:
      FinanceLegacyMigrationIdempotencySchema.shape.idempotencyKey,
  })
  .transform(deepFreeze);
export type FinanceLegacyMigrationBackfillInput = DeepReadonlyType<
  z.output<typeof FinanceLegacyMigrationBackfillInputSchema>
>;

export const FinanceLegacyMigrationCompareInputSchema = z
  .strictObject({
    migrationId: UuidSchema,
    expectedRevision: z.number().int().positive().safe(),
  })
  .transform(deepFreeze);
export type FinanceLegacyMigrationCompareInput = DeepReadonlyType<
  z.output<typeof FinanceLegacyMigrationCompareInputSchema>
>;

export const FinanceLegacyMigrationCutoverInputSchema = z
  .strictObject({
    migrationId: UuidSchema,
    expectedRevision: z.number().int().positive().safe(),
    comparisonId: UuidSchema,
    sourceSnapshotHash: Sha256Schema,
    idempotencyKey:
      FinanceLegacyMigrationIdempotencySchema.shape.idempotencyKey,
  })
  .transform(deepFreeze);
export type FinanceLegacyMigrationCutoverInput = DeepReadonlyType<
  z.output<typeof FinanceLegacyMigrationCutoverInputSchema>
>;

// Keep the browser export explicit: the contracts describe reviewable data and
// never grant the caller permission to perform a backfill or retire a writer.
export type FinanceLegacyMigrationContract = DeepReadonlyType<{
  readonly plan: FinanceLegacyMigrationPlan;
  readonly comparison: FinanceLegacyMigrationComparison;
}>;

import { z } from 'zod';

import {
  createAgentSchemaResolver,
  type AgentRuntimeSchemaRegistration,
  type AgentSchemaResolver,
} from '@emdo/agent-core';
import {
  financeCapabilityReferences,
  financeManifest,
  financeSchemaRegistrations,
} from '@emdo/agent-finance';
import {
  managerCapabilityReferences,
  managerManifest,
  managerSchemaRegistrations,
} from '@emdo/agent-manager';
import {
  schedulerCapabilityReferences,
  schedulerManifest,
  schedulerSchemaRegistrations,
} from '@emdo/agent-scheduler';
import {
  shoppingCapabilityReferences,
  shoppingManifest,
  shoppingSchemaRegistrations,
} from '@emdo/agent-shopping';
import {
  ActionProposalSchema,
  AgentInvocationContextSchema,
  CapabilityDescriptorSchema,
  EffectiveAuthorizationScopeFingerprintSchema,
  IdentifierSchema,
  OpaqueReferenceSchema,
  SemanticVersionSchema,
  Sha256Schema,
  TrustedProviderWriteAuthorityResolutionSchema,
  UuidSchema,
  createRuntimeSchemaRegistry,
  deepFreeze,
  type ActionProposal,
  type AgentInvocationContext,
  type AgentManifest,
  type CapabilityDescriptor,
  type CapabilityExecutor,
  type CapabilityInvocationContext,
  type EffectiveAuthorizationScopeFingerprint,
  type ProviderWriteCapabilityExecutor,
  type ProviderWriteAuthorityBinding,
  type ProviderWriteCapabilityId as NominalProviderWriteCapabilityId,
  type ProviderWriteSafetyContract,
  type RegisteredCapability,
  type SupportedLocale,
  type TrustedProviderWriteAuthorityResolution,
} from '@emdo/contracts';
import {
  createCapabilityRegistry,
  hashCanonicalJson,
  hashCapabilityDescriptorBinding,
  type CapabilityRegistry,
  type ProviderWriteApprovalStore,
  type TrustedProviderWriteAuthorityResolver,
} from '@emdo/toolbox';

const VERSION = '1.0.0' as const;
const PROVIDER_WRITE_TIMEOUT_MS = 30_000;
const PROVIDER_WRITE_IDEMPOTENCY_TTL_MS = 86_400_000;

/** These capability descriptors may classify individual inputs as guarded. */
export const DYNAMIC_GUARDED_ACTION_CAPABILITY_IDS = Object.freeze([
  'finance.records.write',
  'finance.statement.import',
] as const);

type SchedulerCapabilityId =
  (typeof schedulerCapabilityReferences)[number]['id'];
type FinanceCapabilityId = (typeof financeCapabilityReferences)[number]['id'];
type ShoppingCapabilityId = (typeof shoppingCapabilityReferences)[number]['id'];
export type ManagerDelegationCapabilityId =
  (typeof managerCapabilityReferences)[number]['id'];
export type SpecialistCapabilityId =
  SchedulerCapabilityId | FinanceCapabilityId | ShoppingCapabilityId;
export type ProductionCapabilityId =
  SpecialistCapabilityId | ManagerDelegationCapabilityId;
export type CoreProductionCapabilityId =
  'agent.scheduler.delegate' | 'google-calendar.event.create';
export type FinanceV1ProductionCapabilityId =
  CoreProductionCapabilityId | 'agent.finance.delegate' | FinanceCapabilityId;
export type FinanceOnlyProductionCapabilityId =
  'agent.finance.delegate' | FinanceCapabilityId;
export type ProviderWriteCapabilityName = Extract<
  SchedulerCapabilityId,
  | 'google-calendar.event.create'
  | 'google-calendar.event.update'
  | 'google-calendar.event.delete'
>;
export type ProviderWriteCapabilityId = NominalProviderWriteCapabilityId &
  ProviderWriteCapabilityName;

export const ALL_SPECIALIST_CAPABILITY_IDS = Object.freeze([
  ...schedulerCapabilityReferences.map(({ id }) => id),
  ...financeCapabilityReferences.map(({ id }) => id),
  ...shoppingCapabilityReferences.map(({ id }) => id),
] as SpecialistCapabilityId[]);

export const ALL_MANAGER_DELEGATION_CAPABILITY_IDS = Object.freeze(
  managerCapabilityReferences.map(
    ({ id }) => id,
  ) as ManagerDelegationCapabilityId[],
);

export const CORE_MVP_CAPABILITY_IDS = Object.freeze([
  'agent.scheduler.delegate',
  'google-calendar.event.create',
] as const satisfies readonly CoreProductionCapabilityId[]);

export const FINANCE_V1_CAPABILITY_IDS = Object.freeze([
  'agent.scheduler.delegate',
  'agent.finance.delegate',
  'google-calendar.event.create',
  ...financeCapabilityReferences.map(({ id }) => id),
] as const satisfies readonly FinanceV1ProductionCapabilityId[]);

export const FINANCE_ONLY_CAPABILITY_IDS = Object.freeze([
  'agent.finance.delegate',
  ...financeCapabilityReferences.map(({ id }) => id),
] as const satisfies readonly FinanceOnlyProductionCapabilityId[]);

const allReferences = [
  ...schedulerCapabilityReferences,
  ...financeCapabilityReferences,
  ...shoppingCapabilityReferences,
  ...managerCapabilityReferences,
] as const;

export const REQUIRED_CAPABILITY_BINDING_KINDS = Object.freeze(
  Object.fromEntries(allReferences.map(({ id, kind }) => [id, kind])) as Record<
    ProductionCapabilityId,
    (typeof allReferences)[number]['kind']
  >,
);

const SECURITY_OWNED_ARGUMENT_KEYS = new Set([
  'approvalbindinghash',
  'approvalchannel',
  'approvaldecisionid',
  'approvalhash',
  'authenticatedsessionid',
  'capabilityfingerprint',
  'decisionid',
  'disclosuregrant',
  'disclosuregrantid',
  'expectedcalendarversion',
  'expectedeventversion',
  'householdid',
  'idempotencykey',
  'payloadhash',
  'proposalid',
  'providerid',
  'provideridempotencykey',
  'providerpreconditions',
  'providerwritepermit',
  'runid',
  'sdkcallid',
  'sessionid',
  'spaceaccessgrantid',
  'userid',
]);

const normalizedAuthorityKey = (key: string): string =>
  key.toLowerCase().replaceAll('-', '').replaceAll('_', '');

const assertBoundedModelArguments = (value: unknown): void => {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value, depth: 0 },
  ];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let textLength = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > 4_096 || current.depth > 16) {
      throw new Error('capability-arguments-out-of-bounds');
    }
    const item = current.value;
    if (typeof item === 'string') {
      textLength += item.length;
      if (textLength > 131_072) {
        throw new Error('capability-arguments-out-of-bounds');
      }
      continue;
    }
    if (item === null || typeof item !== 'object') continue;
    if (seen.has(item)) throw new Error('capability-arguments-out-of-bounds');
    seen.add(item);
    if (Array.isArray(item)) {
      if (item.length > 512) {
        throw new Error('capability-arguments-out-of-bounds');
      }
      for (const nested of item) {
        pending.push({ value: nested, depth: current.depth + 1 });
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('capability-arguments-out-of-bounds');
    }
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key === 'symbol')) {
      throw new Error('capability-arguments-out-of-bounds');
    }
    const entries = Object.entries(descriptors);
    if (entries.length > 128) {
      throw new Error('capability-arguments-out-of-bounds');
    }
    for (const [key, descriptor] of entries) {
      if (!('value' in descriptor)) {
        throw new Error('capability-arguments-out-of-bounds');
      }
      if (SECURITY_OWNED_ARGUMENT_KEYS.has(normalizedAuthorityKey(key))) {
        throw new Error('provider-write-arguments-contain-authority');
      }
      textLength += key.length;
      pending.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
};

const IsoInstantSchema = z.iso.datetime({ offset: true });
const DateOnlySchema = z.iso.date();
const MonthSchema = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u);
const OpaqueIdSchema = OpaqueReferenceSchema;
const CadMinorSchema = z.number().int().safe();
const NonnegativeCadMinorSchema = CadMinorSchema.nonnegative();
const CapabilitySafeErrorCodeSchema = z.enum([
  'authorization-revoked',
  'calendar-authorization-invalid',
  'calendar-command-invalid',
  'calendar-idempotency-conflict',
  'calendar-payload-hash-mismatch',
  'calendar-precondition-failed',
  'calendar-provider-indeterminate',
  'calendar-provider-rejected',
  'calendar-readback-invalid',
  'calendar-readback-mismatch',
  'commerce-connector-not-approved',
  'commerce-offer-expired',
  'commerce-offer-invalid',
  'commerce-offer-not-comparable',
  'commerce-offer-source-forbidden',
  'commerce-offer-stale',
  'commerce-refresh-aborted',
  'commerce-refresh-failed',
  'commerce-refresh-invalid',
  'finance-budget-revision-conflict',
  'finance-budget-total-out-of-range',
  'finance-amount-overflow',
  'finance-idempotency-conflict',
  'finance-import-duplicate-at-commit',
  'finance-import-currency-unsupported',
  'finance-import-idempotency-conflict',
  'finance-import-input-invalid',
  'finance-import-mapping-invalid',
  'finance-import-multiple-accounts-unsupported',
  'finance-import-plan-empty',
  'finance-import-plan-id-conflict',
  'finance-import-plan-invalid',
  'finance-import-plan-not-found',
  'finance-import-preview-capacity-reached',
  'finance-import-preview-not-found',
  'finance-import-row-invalid',
  'finance-import-source-hash-mismatch',
  'finance-import-source-invalid',
  'finance-operation-forbidden',
  'finance-mutation-requires-ledger-entry',
  'finance-reversal-conflict',
  'finance-reversal-dominates',
  'finance-total-out-of-range',
  'invalid-finance-budget-input',
  'invalid-finance-ledger-input',
  'invalid-finance-record',
  'invalid-finance-record-create',
  'invalid-finance-total-input',
  'offer-history-invalid',
  'offer-history-version-conflict',
  'operation-rejected',
  'repository-rejected',
  'retailer-link-unsafe',
  'service-unavailable',
  'shopping-item-conflict',
  'shopping-item-invalid',
  'shopping-item-not-found',
  'task-conflict',
  'task-invalid',
  'task-not-found',
  'travel-input-invalid',
]);
const SafeErrorSchema = z.strictObject({
  code: CapabilitySafeErrorCodeSchema,
  message: z.string().trim().min(1).max(2_000),
  retryable: z.boolean(),
});

const CalendarPlanningBlockSchema = z.strictObject({
  calendarRef: OpaqueIdSchema,
  eventRef: OpaqueIdSchema.nullable(),
  fetchedAt: IsoInstantSchema,
  start: IsoInstantSchema,
  end: IsoInstantSchema,
  details: z
    .strictObject({
      summary: z.string().trim().min(1).max(2_000),
      location: z.string().trim().min(1).max(2_000).optional(),
    })
    .nullable(),
  maskReason: z
    .enum(['calendar-private', 'event-private', 'free-busy-only'])
    .nullable(),
});
const CalendarPlanningSnapshotSchema = z.strictObject({
  calendarRef: OpaqueIdSchema,
  snapshotFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  fetchedAt: IsoInstantSchema,
  blockCount: z.number().int().safe().nonnegative().max(10_000),
});

const TaskRecurrenceSchema = z.strictObject({
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  interval: z.number().int().safe().min(1).max(52),
  endsAt: IsoInstantSchema.nullable(),
});
const TaskDraftSchema = z.strictObject({
  title: z.string().trim().min(1).max(300),
  notes: z.string().trim().min(1).max(4_000).nullable(),
  dueAt: IsoInstantSchema.nullable(),
  recurrence: TaskRecurrenceSchema.nullable(),
});
const TaskViewSchema = TaskDraftSchema.extend({
  id: OpaqueIdSchema,
  status: z.enum(['open', 'completed']),
  revision: z.number().int().safe().positive(),
  updatedAt: IsoInstantSchema,
});

const CalendarRecurrenceSchema = z.strictObject({
  frequency: z.enum(['daily', 'weekly']),
  interval: z.number().int().safe().min(1).max(52),
  count: z.number().int().safe().min(1).max(366),
  disambiguation: z.enum(['reject', 'earlier', 'later']),
  byWeekday: z
    .array(z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']))
    .min(1)
    .max(7)
    .optional(),
});
const CalendarEventDraftSchema = z
  .strictObject({
    summary: z.string().trim().min(1).max(2_000),
    start: IsoInstantSchema,
    end: IsoInstantSchema,
    timeZone: z.literal('America/Toronto'),
    location: z.string().trim().min(1).max(2_000).optional(),
    description: z.string().trim().min(1).max(8_000).optional(),
    attendees: z.array(z.email().max(320)).max(100).optional(),
    recurrence: CalendarRecurrenceSchema.optional(),
  })
  .superRefine((event, context) => {
    if (
      Date.parse(event.end) <= Date.parse(event.start) ||
      Date.parse(event.start) % 60_000 !== 0 ||
      Date.parse(event.end) % 60_000 !== 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['end'],
        message: 'Calendar events require a positive, minute-aligned interval',
      });
    }
  });
const CalendarReadbackSchema = CalendarEventDraftSchema.extend({
  eventId: OpaqueIdSchema,
  eventVersion: OpaqueIdSchema,
});
const CalendarWriteSafeErrorSchema = z.strictObject({
  code: z.enum([
    'calendar-command-invalid',
    'calendar-authorization-invalid',
    'calendar-idempotency-conflict',
    'calendar-payload-hash-mismatch',
    'calendar-precondition-failed',
    'calendar-provider-indeterminate',
    'calendar-provider-rejected',
    'calendar-readback-invalid',
    'calendar-readback-mismatch',
  ]),
  message: z.string().trim().min(1).max(2_000),
  retryable: z.literal(false),
});
const CalendarWriteResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  result: z.discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('applied'),
      providerRequestId: OpaqueIdSchema.nullable(),
      reconciled: z.boolean(),
      readbackCalendarVersion: OpaqueIdSchema,
      readback: CalendarReadbackSchema.nullable(),
    }),
    z.strictObject({
      status: z.literal('not-applied'),
      safeError: CalendarWriteSafeErrorSchema,
    }),
    z.strictObject({
      status: z.literal('indeterminate'),
      reconciliationRequired: z.literal(true),
      safeError: CalendarWriteSafeErrorSchema,
    }),
  ]),
});

const FinanceRecordTypeSchema = z.enum([
  'account',
  'transaction',
  'category',
  'budget',
  'bill',
  'subscription',
  'goal',
]);
const FinanceRecordSummarySchema = z.strictObject({
  id: OpaqueIdSchema,
  recordType: FinanceRecordTypeSchema,
  label: z.string().trim().min(1).max(2_000),
  currency: z.literal('CAD').nullable(),
  amountCadMinor: CadMinorSchema.nullable(),
  effectiveOn: DateOnlySchema.nullable(),
  status: z.string().trim().min(1).max(100).nullable(),
  revision: z.number().int().safe().nonnegative().nullable(),
  updatedAt: IsoInstantSchema,
});
const FinanceAccountDraftSchema = z.strictObject({
  recordType: z.literal('account'),
  name: z.string().trim().min(1).max(200),
  accountKind: z.enum(['cash', 'chequing', 'savings', 'credit', 'other']),
  openingBalanceCadMinor: CadMinorSchema,
  active: z.boolean(),
});
const FinanceTransactionDraftSchema = z.strictObject({
  recordType: z.literal('transaction'),
  accountId: OpaqueIdSchema,
  categoryId: OpaqueIdSchema.nullable(),
  postedOn: DateOnlySchema,
  description: z.string().trim().min(1).max(2_000),
  amountCadMinor: CadMinorSchema,
});
const FinanceCategoryDraftSchema = z.strictObject({
  recordType: z.literal('category'),
  name: z.string().trim().min(1).max(200),
  categoryKind: z.enum(['income', 'expense']),
  parentCategoryId: OpaqueIdSchema.nullable(),
  active: z.boolean(),
});
const BudgetAllocationDraftSchema = z.strictObject({
  categoryId: OpaqueIdSchema,
  amountCadMinor: NonnegativeCadMinorSchema,
});
const FinanceBudgetDraftSchema = z.strictObject({
  recordType: z.literal('budget'),
  month: MonthSchema,
  allocations: z.array(BudgetAllocationDraftSchema).max(1_000),
});
const FinanceBillDraftSchema = z.strictObject({
  recordType: z.literal('bill'),
  name: z.string().trim().min(1).max(200),
  dueOn: DateOnlySchema,
  expectedAmountCadMinor: NonnegativeCadMinorSchema,
  status: z.enum(['planned', 'paid', 'skipped']),
});
const FinanceSubscriptionDraftSchema = z.strictObject({
  recordType: z.literal('subscription'),
  name: z.string().trim().min(1).max(200),
  nextDueOn: DateOnlySchema,
  expectedAmountCadMinor: NonnegativeCadMinorSchema,
  cadence: z.enum(['weekly', 'monthly', 'quarterly', 'yearly', 'other']),
  active: z.boolean(),
});
const FinanceGoalDraftSchema = z.strictObject({
  recordType: z.literal('goal'),
  name: z.string().trim().min(1).max(200),
  targetAmountCadMinor: NonnegativeCadMinorSchema.positive(),
  currentAmountCadMinor: NonnegativeCadMinorSchema,
  targetOn: DateOnlySchema.nullable(),
  status: z.enum(['active', 'achieved', 'paused']),
});
const FinanceRecordDraftSchema = z.discriminatedUnion('recordType', [
  FinanceAccountDraftSchema,
  FinanceTransactionDraftSchema,
  FinanceCategoryDraftSchema,
  FinanceBudgetDraftSchema,
  FinanceBillDraftSchema,
  FinanceSubscriptionDraftSchema,
  FinanceGoalDraftSchema,
]);
const FinanceUpdatableRecordDraftSchema = z.discriminatedUnion('recordType', [
  FinanceAccountDraftSchema,
  FinanceCategoryDraftSchema,
  FinanceBudgetDraftSchema,
  FinanceBillDraftSchema,
  FinanceSubscriptionDraftSchema,
  FinanceGoalDraftSchema,
]);
const FinanceTransactionPatchSchema = z
  .strictObject({
    description: z.string().trim().min(1).max(2_000).optional(),
    categoryId: OpaqueIdSchema.nullable().optional(),
    annotation: z.string().trim().min(1).max(2_000).nullable().optional(),
  })
  .refine(
    (patch) =>
      patch.description !== undefined ||
      patch.categoryId !== undefined ||
      patch.annotation !== undefined,
    { message: 'A transaction patch must change an approved field' },
  );
const FinanceRecordMutationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('create'),
    recordId: OpaqueIdSchema,
    record: FinanceRecordDraftSchema,
  }),
  z.strictObject({
    kind: z.literal('update'),
    recordId: OpaqueIdSchema,
    replacement: FinanceUpdatableRecordDraftSchema,
  }),
  z.strictObject({
    kind: z.literal('patch-transaction'),
    transactionId: OpaqueIdSchema,
    expectedRevision: z.number().int().safe().nonnegative(),
    patch: FinanceTransactionPatchSchema,
  }),
  z.strictObject({
    kind: z.literal('adjust'),
    transactionId: OpaqueIdSchema,
    amountCadMinor: CadMinorSchema.refine((value) => value !== 0),
    reason: z.string().trim().min(3).max(1_000),
  }),
  z.strictObject({
    kind: z.literal('reverse'),
    transactionId: OpaqueIdSchema,
    reason: z.string().trim().min(3).max(1_000),
  }),
  /**
   * These three intents deliberately contain only opaque target references.
   * The guarded Finance materializer loads every review, original, and match
   * binding server-side before it can create an approval proposal.
   */
  z.strictObject({
    kind: z.literal('commit-document-review'),
    documentId: OpaqueIdSchema,
  }),
  z.strictObject({
    kind: z.literal('accept-document-match'),
    matchId: OpaqueIdSchema,
  }),
  z.strictObject({
    kind: z.literal('delete-document'),
    documentId: OpaqueIdSchema,
  }),
]);
const FinanceConfirmationRequiredSchema = z.strictObject({
  status: z.literal('confirmation-required'),
  proposal: z.strictObject({
    state: z.literal('proposed'),
    operation: z.enum([
      'ambiguous-or-bulk-finance-write',
      'finance-adjustment',
      'finance-reversal',
      'finance-statement-import-commit',
      'finance-document-review-commit',
      'finance-document-match-accept',
      'finance-document-delete',
      'unsupported-finance-write',
    ]),
    channel: z.literal('emdo-authenticated-visual'),
    canonicalHash: Sha256Schema,
  }),
});
const FinanceWriteResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  result: z.discriminatedUnion('status', [
    z.strictObject({
      status: z.enum(['applied', 'duplicate', 'ignored']),
      record: FinanceRecordSummarySchema,
    }),
    z.strictObject({
      status: z.enum(['needs-review', 'rejected']),
      record: FinanceRecordSummarySchema.nullable(),
      safeError: SafeErrorSchema,
    }),
    z.strictObject({
      status: z.literal('document-committed'),
      documentId: OpaqueIdSchema,
      extractionRevision: z.number().int().positive(),
    }),
    z.strictObject({
      status: z.literal('match-accepted'),
      documentId: OpaqueIdSchema,
      matchId: OpaqueIdSchema,
    }),
    z.strictObject({
      status: z.enum(['document-deleted', 'document-purge-pending']),
      documentId: OpaqueIdSchema,
    }),
    FinanceConfirmationRequiredSchema,
  ]),
});

const FinanceDocumentTypeSchema = z.enum([
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
const FinanceDocumentEvidenceSchema = z.strictObject({
  evidenceId: OpaqueIdSchema,
  documentId: OpaqueIdSchema,
  documentType: FinanceDocumentTypeSchema,
  displayName: z.string().trim().min(1).max(255),
  page: z.number().int().min(1).max(250),
  excerpt: z.string().trim().min(1).max(2_000),
  sourceLocale: z.enum(['en-CA', 'fr-CA', 'ja-JP', 'ko-KR']),
});
const FinanceDocumentSearchHitSchema = z.strictObject({
  documentId: OpaqueIdSchema,
  documentType: FinanceDocumentTypeSchema,
  displayName: z.string().trim().min(1).max(255),
  occurredOn: DateOnlySchema.nullable(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/u)
    .nullable(),
  amountMinor: z.number().int().safe().nullable(),
  score: z.number().min(0).max(1),
  evidence: z.array(FinanceDocumentEvidenceSchema).min(1).max(8),
});
const FinanceDocumentMatchSchema = z.strictObject({
  matchId: OpaqueIdSchema,
  documentId: OpaqueIdSchema,
  recordId: OpaqueIdSchema,
  recordType: FinanceRecordTypeSchema,
  state: z.enum(['suggested', 'accepted', 'rejected']),
  score: z.number().min(0).max(1),
  reasons: z.array(z.string().trim().min(1).max(200)).min(1).max(8),
});

const QuantityInputSchema = z.strictObject({
  amount: z
    .string()
    .trim()
    .regex(/^\d{1,9}(?:\.\d{1,3})?$/u),
  unit: z.string().trim().min(1).max(20),
});
const ShoppingPreferencesSchema = z.strictObject({
  requiredTags: z.array(z.string().trim().min(1).max(100)).max(32),
  excludedTags: z.array(z.string().trim().min(1).max(100)).max(32),
  preferredBrands: z.array(z.string().trim().min(1).max(120)).max(32),
});
const ShoppingSubstitutionSchema = z.strictObject({
  policy: z.enum(['never', 'listed-only', 'similar']),
  alternatives: z
    .array(
      z.strictObject({
        id: OpaqueIdSchema,
        label: z.string().trim().min(1).max(300),
      }),
    )
    .max(32),
});
const ShoppingItemDraftSchema = z.strictObject({
  id: OpaqueIdSchema,
  kind: z.enum(['grocery', 'general']),
  name: z.string().trim().min(1).max(300),
  quantity: QuantityInputSchema,
  preferences: ShoppingPreferencesSchema,
  substitutions: ShoppingSubstitutionSchema,
  preferredRetailers: z.array(z.string().trim().min(1).max(100)).max(32),
});
const ShoppingItemViewSchema = z.strictObject({
  id: OpaqueIdSchema,
  kind: z.enum(['grocery', 'general']),
  name: z.string().trim().min(1).max(300),
  quantity: z.strictObject({
    amountMilliUnits: z.number().int().safe().positive(),
    unit: z.enum(['each', 'gram', 'millilitre', 'package']),
    scale: z.literal(1_000),
  }),
  preferences: ShoppingPreferencesSchema,
  substitutions: ShoppingSubstitutionSchema,
  preferredRetailers: z.array(z.string().trim().min(1).max(100)).max(32),
  revision: z.number().int().safe().positive(),
  updatedAt: IsoInstantSchema,
});
const ShoppingMutationSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('create'),
      item: ShoppingItemDraftSchema,
    }),
    z.strictObject({
      kind: z.literal('update'),
      itemId: OpaqueIdSchema,
      replacement: ShoppingItemDraftSchema,
    }),
    z.strictObject({
      kind: z.literal('delta'),
      itemId: OpaqueIdSchema,
      quantityMilliUnits: z
        .number()
        .int()
        .safe()
        .refine((value) => value !== 0),
    }),
    z.strictObject({ kind: z.literal('tombstone'), itemId: OpaqueIdSchema }),
  ])
  .superRefine((mutation, context) => {
    if (
      mutation.kind === 'update' &&
      mutation.itemId !== mutation.replacement.id
    ) {
      context.addIssue({
        code: 'custom',
        path: ['replacement', 'id'],
        message: 'Replacement item ID must match the target item ID',
      });
    }
  });

const CadMoneyObjectSchema = z.strictObject({
  minorUnits: NonnegativeCadMinorSchema,
  currency: z.literal('CAD'),
});
const CommerceOfferSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: IdentifierSchema,
    version: z.number().int().safe().positive(),
    provider: IdentifierSchema,
    merchant: z.strictObject({
      id: OpaqueIdSchema,
      name: z.string().trim().min(1).max(200),
    }),
    product: z.strictObject({
      id: OpaqueIdSchema,
      title: z.string().trim().min(1).max(500),
    }),
    variant: z.strictObject({
      id: OpaqueIdSchema,
      title: z.string().trim().min(1).max(500),
    }),
    price: CadMoneyObjectSchema,
    shipping: z.discriminatedUnion('status', [
      z.strictObject({
        status: z.literal('known'),
        minorUnits: NonnegativeCadMinorSchema,
        currency: z.literal('CAD'),
      }),
      z.strictObject({
        status: z.literal('unknown'),
        reason: z.string().trim().min(1).max(300),
      }),
    ]),
    availabilityScope: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('online') }),
      z.strictObject({
        kind: z.literal('postal-code'),
        postalCode: z.string().regex(/^[A-Z]\d[A-Z] ?\d[A-Z]\d$/u),
      }),
      z.strictObject({
        kind: z.literal('store'),
        storeId: IdentifierSchema,
      }),
    ]),
    sourceUrl: z.url({ protocol: /^https$/u }),
    upstreamAt: IsoInstantSchema,
    fetchedAt: IsoInstantSchema,
    expiresAt: IsoInstantSchema,
    comparisonPermission: z.enum(['allowed', 'not-authorized', 'unavailable']),
  })
  .superRefine((offer, context) => {
    if (
      Date.parse(offer.upstreamAt) > Date.parse(offer.fetchedAt) ||
      Date.parse(offer.fetchedAt) > Date.parse(offer.expiresAt)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['fetchedAt'],
        message: 'Offer freshness chronology is invalid',
      });
    }
  });
const UnknownCostDisclosureSchema = z.strictObject({
  component: z.enum(['shipping', 'tax', 'fees', 'membership', 'other']),
  reason: z.string().trim().min(1).max(300),
});
const KnownOfferCostSchema = z.strictObject({
  status: z.literal('known'),
  minorUnits: NonnegativeCadMinorSchema,
  currency: z.literal('CAD'),
});
const UnknownOfferCostSchema = z.strictObject({
  status: z.literal('unknown'),
  reason: z.string().trim().min(1).max(300),
});
const NotApplicableOfferCostSchema = z.strictObject({
  status: z.literal('not-applicable'),
});
const VariableOfferCostSchema = z.discriminatedUnion('status', [
  KnownOfferCostSchema,
  UnknownOfferCostSchema,
  NotApplicableOfferCostSchema,
]);
const OfferCostsSchema = z
  .strictObject({
    item: KnownOfferCostSchema,
    shipping: VariableOfferCostSchema,
    tax: VariableOfferCostSchema,
    fees: VariableOfferCostSchema,
    membership: z.discriminatedUnion('status', [
      NotApplicableOfferCostSchema,
      KnownOfferCostSchema.extend({
        condition: z.string().trim().min(1).max(300),
      }),
      UnknownOfferCostSchema.extend({
        condition: z.string().trim().min(1).max(300),
      }),
    ]),
    unknown: z.array(UnknownCostDisclosureSchema).max(16),
  })
  .superRefine((costs, context) => {
    const disclosures = new Map(
      costs.unknown.map((entry) => [entry.component, entry.reason]),
    );
    if (disclosures.size !== costs.unknown.length) {
      context.addIssue({
        code: 'custom',
        path: ['unknown'],
        message: 'Unknown cost disclosures must be unique',
      });
    }
    for (const component of [
      'shipping',
      'tax',
      'fees',
      'membership',
    ] as const) {
      const cost = costs[component];
      const disclosure = disclosures.get(component);
      if (
        (cost.status === 'unknown' && disclosure !== cost.reason) ||
        (cost.status !== 'unknown' && disclosure !== undefined)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['unknown'],
          message: 'Unknown cost disclosures must match unknown components',
        });
      }
    }
  });
const CommerceHandoffOfferSchema = z
  .strictObject({
    offer: CommerceOfferSchema,
    costs: OfferCostsSchema,
    stock: z.strictObject({
      status: z.literal('unknown'),
      reason: z.literal('The connector did not provide verified inventory.'),
    }),
    handoff: z.strictObject({
      url: z.url({ protocol: /^https$/u }),
      rel: z.literal('noopener noreferrer external'),
    }),
  })
  .superRefine((value, context) => {
    if (
      value.costs.item.minorUnits !== value.offer.price.minorUnits ||
      value.costs.item.currency !== value.offer.price.currency
    ) {
      context.addIssue({
        code: 'custom',
        path: ['costs', 'item'],
        message: 'Item cost must match the offer price',
      });
    }
    const shipping = value.offer.shipping;
    const normalizedShipping = value.costs.shipping;
    if (
      shipping.status === 'known'
        ? normalizedShipping.status !== 'known' ||
          normalizedShipping.minorUnits !== shipping.minorUnits ||
          normalizedShipping.currency !== shipping.currency
        : normalizedShipping.status !== 'unknown' ||
          normalizedShipping.reason !== shipping.reason
    ) {
      context.addIssue({
        code: 'custom',
        path: ['costs', 'shipping'],
        message: 'Shipping cost must match the offer',
      });
    }
  });

export const specialistCapabilitySchemas = {
  'scheduler.calendar.freebusy.read': {
    input: z
      .strictObject({
        schemaVersion: z.literal(1),
        windowStart: IsoInstantSchema,
        windowEnd: IsoInstantSchema,
      })
      .superRefine((window, context) => {
        const durationMs =
          Date.parse(window.windowEnd) - Date.parse(window.windowStart);
        if (durationMs <= 0 || durationMs > 31 * 86_400_000) {
          context.addIssue({
            code: 'custom',
            path: ['windowEnd'],
            message: 'Calendar window must be positive and at most 31 days',
          });
        }
      }),
    output: z.strictObject({
      schemaVersion: z.literal(1),
      calendarRefs: z.array(OpaqueIdSchema).max(64),
      blocks: z.array(CalendarPlanningBlockSchema).max(200),
      snapshots: z.array(CalendarPlanningSnapshotSchema).max(64),
      omittedBlockCount: z.number().int().safe().nonnegative().max(640_000),
    }),
  },
  'scheduler.tasks.read': {
    input: z.strictObject({
      schemaVersion: z.literal(1),
      status: z.enum(['open', 'completed', 'all']).default('open'),
      dueBefore: IsoInstantSchema.optional(),
      cursor: OpaqueIdSchema.optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    output: z.strictObject({
      schemaVersion: z.literal(1),
      tasks: z.array(TaskViewSchema).max(100),
      nextCursor: OpaqueIdSchema.nullable(),
    }),
  },
  'scheduler.tasks.write': {
    input: z.strictObject({
      schemaVersion: z.literal(1),
      mutation: z.discriminatedUnion('kind', [
        z.strictObject({
          kind: z.literal('create'),
          taskId: OpaqueIdSchema,
          task: TaskDraftSchema,
        }),
        z.strictObject({
          kind: z.literal('update'),
          taskId: OpaqueIdSchema,
          replacement: TaskDraftSchema,
        }),
        z.strictObject({
          kind: z.enum(['complete', 'tombstone']),
          taskId: OpaqueIdSchema,
        }),
      ]),
    }),
    output: z.strictObject({
      schemaVersion: z.literal(1),
      result: z.discriminatedUnion('status', [
        z.strictObject({
          status: z.enum(['applied', 'duplicate', 'ignored']),
          task: TaskViewSchema,
        }),
        z.strictObject({
          status: z.enum(['conflict', 'needs-review', 'rejected']),
          task: TaskViewSchema.nullable(),
          safeError: SafeErrorSchema,
        }),
      ]),
    }),
  },
  'maps.travel-time.read': {
    input: z.strictObject({
      schemaVersion: z.literal(1),
      origin: z.string().trim().min(1).max(512),
      destination: z.string().trim().min(1).max(512),
      mode: z.enum(['driving', 'transit', 'walking']),
      departureAt: IsoInstantSchema,
    }),
    output: z.strictObject({
      schemaVersion: z.literal(1),
      travelMinutes: z.number().int().nonnegative(),
      totalBufferMinutes: z.number().int().nonnegative(),
      source: z.enum(['google-maps', 'fallback', 'same-location']),
      fetchedAt: IsoInstantSchema.nullable(),
    }),
  },
  'google-calendar.event.create': {
    input: z.strictObject({
      schemaVersion: z.literal(1),
      calendarRef: OpaqueIdSchema,
      event: CalendarEventDraftSchema,
    }),
    output: CalendarWriteResultSchema,
  },
  'google-calendar.event.update': {
    input: z.strictObject({
      schemaVersion: z.literal(1),
      calendarRef: OpaqueIdSchema,
      eventRef: OpaqueIdSchema,
      replacement: CalendarEventDraftSchema,
    }),
    output: CalendarWriteResultSchema,
  },
  'google-calendar.event.delete': {
    input: z.strictObject({
      schemaVersion: z.literal(1),
      calendarRef: OpaqueIdSchema,
      eventRef: OpaqueIdSchema,
    }),
    output: CalendarWriteResultSchema,
  },
  'finance.records.read': {
    input: z.strictObject({
      schemaVersion: z.literal(1),
      recordTypes: z
        .array(
          z.enum([
            'account',
            'transaction',
            'category',
            'budget',
            'bill',
            'subscription',
            'goal',
          ]),
        )
        .max(7)
        .optional(),
      cursor: OpaqueIdSchema.optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    output: z.strictObject({
      schemaVersion: z.literal(1),
      records: z.array(FinanceRecordSummarySchema).max(100),
      nextCursor: OpaqueIdSchema.nullable(),
    }),
  },
  'finance.records.write': {
    input: z.strictObject({
      schemaVersion: z.literal(1),
      mutation: FinanceRecordMutationSchema,
    }),
    output: FinanceWriteResultSchema,
  },
  'finance.statement.import': {
    input: z.strictObject({
      schemaVersion: z.literal(1),
      request: z.strictObject({
        kind: z.literal('commit'),
        planId: OpaqueIdSchema,
      }),
    }),
    output: z.strictObject({
      schemaVersion: z.literal(1),
      result: z.discriminatedUnion('status', [
        z.strictObject({
          status: z.enum(['committed', 'replayed']),
          receipt: z.strictObject({
            id: OpaqueIdSchema,
            planId: OpaqueIdSchema,
            transactionCount: z.number().int().safe().positive().max(100_000),
            verified: z.literal(true),
          }),
          sourceDeletionAuthorized: z.literal(true),
        }),
        z.strictObject({
          status: z.literal('rejected'),
          sourceDeletionAuthorized: z.literal(false),
          safeError: SafeErrorSchema,
        }),
        FinanceConfirmationRequiredSchema,
      ]),
    }),
  },
  'finance.analytics.calculate': {
    input: z.strictObject({
      schemaVersion: z.literal(1),
      calculation: z.literal('monthly-budget').default('monthly-budget'),
      month: MonthSchema,
    }),
    output: z.strictObject({
      schemaVersion: z.literal(1),
      result: z.discriminatedUnion('status', [
        z.strictObject({
          status: z.literal('calculated'),
          month: MonthSchema,
          timezone: z.literal('America/Toronto'),
          currency: z.literal('CAD'),
          categoryTotals: z
            .array(
              z.strictObject({
                categoryId: OpaqueIdSchema.nullable(),
                inflowCadMinor: NonnegativeCadMinorSchema,
                outflowCadMinor: NonnegativeCadMinorSchema,
                netCadMinor: CadMinorSchema,
              }),
            )
            .max(10_000),
          totals: z.strictObject({
            inflowCadMinor: NonnegativeCadMinorSchema,
            outflowCadMinor: NonnegativeCadMinorSchema,
            netCadMinor: CadMinorSchema,
          }),
        }),
        z.strictObject({
          status: z.literal('rejected'),
          safeError: SafeErrorSchema,
        }),
      ]),
    }),
  },
  'finance.documents.search': {
    input: z
      .strictObject({
        schemaVersion: z.literal(1),
        query: z.string().trim().min(1).max(1_000),
        documentTypes: z.array(FinanceDocumentTypeSchema).max(10).optional(),
        from: DateOnlySchema.optional(),
        to: DateOnlySchema.optional(),
        limit: z.number().int().min(1).max(25).default(10),
      })
      .superRefine((value, context) => {
        if (
          value.from !== undefined &&
          value.to !== undefined &&
          value.to < value.from
        ) {
          context.addIssue({
            code: 'custom',
            path: ['to'],
            message: 'Document search end must not precede its start',
          });
        }
      }),
    output: z.strictObject({
      schemaVersion: z.literal(1),
      hits: z.array(FinanceDocumentSearchHitSchema).max(25),
    }),
  },
  'finance.documents.read': {
    input: z.strictObject({
      schemaVersion: z.literal(1),
      documentId: OpaqueIdSchema,
      evidenceIds: z.array(OpaqueIdSchema).max(32),
    }),
    output: z.strictObject({
      schemaVersion: z.literal(1),
      document: z.strictObject({
        id: OpaqueIdSchema,
        documentType: FinanceDocumentTypeSchema,
        displayName: z.string().trim().min(1).max(255),
        sourceLocale: z.enum(['en-CA', 'fr-CA', 'ja-JP', 'ko-KR']),
        currency: z
          .string()
          .regex(/^[A-Z]{3}$/u)
          .nullable(),
        summary: z.string().trim().min(1).max(4_000),
        committedAt: IsoInstantSchema,
      }),
      evidence: z.array(FinanceDocumentEvidenceSchema).max(32),
    }),
  },
  'finance.matches.read': {
    input: z.strictObject({
      schemaVersion: z.literal(1),
      documentId: OpaqueIdSchema,
      states: z
        .array(z.enum(['suggested', 'accepted', 'rejected']))
        .max(3)
        .optional(),
      limit: z.number().int().min(1).max(50).default(25),
    }),
    output: z.strictObject({
      schemaVersion: z.literal(1),
      matches: z.array(FinanceDocumentMatchSchema).max(50),
    }),
  },
  'shopping.items.read': {
    input: z.strictObject({
      schemaVersion: z.literal(1),
      kinds: z
        .array(z.enum(['grocery', 'general']))
        .max(2)
        .optional(),
      cursor: OpaqueIdSchema.optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    output: z.strictObject({
      schemaVersion: z.literal(1),
      items: z.array(ShoppingItemViewSchema).max(100),
      nextCursor: OpaqueIdSchema.nullable(),
    }),
  },
  'shopping.items.write': {
    input: z.strictObject({
      schemaVersion: z.literal(1),
      mutation: ShoppingMutationSchema,
    }),
    output: z.strictObject({
      schemaVersion: z.literal(1),
      result: z.discriminatedUnion('status', [
        z.strictObject({
          status: z.enum(['applied', 'duplicate', 'ignored']),
          item: ShoppingItemViewSchema,
        }),
        z.strictObject({
          status: z.enum(['conflict', 'needs-review', 'rejected']),
          item: ShoppingItemViewSchema.nullable(),
          safeError: SafeErrorSchema,
        }),
      ]),
    }),
  },
  'commerce.offers.read': {
    input: z.strictObject({
      schemaVersion: z.literal(1),
      itemIds: z.array(OpaqueIdSchema).min(1).max(100),
      maximumAgeMs: z.number().int().min(0).max(86_400_000),
    }),
    output: z.strictObject({
      schemaVersion: z.literal(1),
      offers: z.array(CommerceOfferSchema).max(1_000),
      observedAt: IsoInstantSchema,
      unknownCosts: z.array(UnknownCostDisclosureSchema).max(100),
    }),
  },
  'commerce.offers.refresh': {
    input: z.strictObject({
      schemaVersion: z.literal(1),
      query: z.string().trim().min(1).max(300),
      postalCode: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z]\d[A-Z] ?\d[A-Z]\d$/u)
        .optional(),
      limit: z.number().int().safe().min(1).max(50),
      maximumAgeMs: z.number().int().safe().min(1).max(86_400_000),
    }),
    output: z.strictObject({
      schemaVersion: z.literal(1),
      result: z.discriminatedUnion('status', [
        z.strictObject({
          status: z.literal('ready'),
          refreshedAt: IsoInstantSchema,
          offers: z.array(CommerceHandoffOfferSchema).max(50),
        }),
        z.strictObject({
          status: z.literal('blocked'),
          safeError: SafeErrorSchema,
        }),
      ]),
    }),
  },
  'commerce.link-out.prepare': {
    input: z.strictObject({
      schemaVersion: z.literal(1),
      offerId: OpaqueIdSchema,
    }),
    output: z.strictObject({
      schemaVersion: z.literal(1),
      result: z.discriminatedUnion('status', [
        z.strictObject({
          status: z.literal('ready'),
          url: z.url({ protocol: /^https$/u }),
          rel: z.literal('noopener noreferrer external'),
        }),
        z.strictObject({
          status: z.literal('unavailable'),
          safeError: SafeErrorSchema,
        }),
      ]),
    }),
  },
} as const satisfies Record<
  SpecialistCapabilityId,
  { readonly input: z.ZodObject; readonly output: z.ZodObject }
>;

export const parseSpecialistCapabilityInput = (
  capabilityId: SpecialistCapabilityId,
  value: unknown,
): unknown =>
  deepFreeze(specialistCapabilitySchemas[capabilityId].input.parse(value));

export const parseSpecialistCapabilityOutput = (
  capabilityId: SpecialistCapabilityId,
  value: unknown,
): unknown =>
  deepFreeze(specialistCapabilitySchemas[capabilityId].output.parse(value));

export const capabilitySchemaRegistrations = Object.freeze(
  Object.entries(specialistCapabilitySchemas).flatMap(
    ([capabilityId, schemas]) => [
      Object.freeze({
        reference: Object.freeze({
          id: `${capabilityId}.input`,
          version: VERSION,
        }),
        schema: schemas.input,
      }),
      Object.freeze({
        reference: Object.freeze({
          id: `${capabilityId}.output`,
          version: VERSION,
        }),
        schema: schemas.output,
      }),
    ],
  ),
);

const schemaRefsForSpecialistCapability = (id: SpecialistCapabilityId) => ({
  input: { id: `${id}.input`, version: VERSION },
  output: { id: `${id}.output`, version: VERSION },
});

export interface ProviderProposalMaterializationContext {
  readonly requestId: string;
  readonly runId: string;
  readonly householdId: string;
  readonly userId: string;
  readonly authenticatedSessionId: string;
  readonly spaceAccessGrantId: string;
  readonly authorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprint;
  readonly disclosureGrantId: string;
  readonly disclosureGrantVersion: string;
  readonly invocationContext: AgentInvocationContext;
  readonly invocationContextHash: string;
  readonly sdkCallId: string;
  readonly abortSignal: AbortSignal;
}

/**
 * Resolves the current closed provider authority for proposal preparation.
 * This is distinct from the execution-time resolver because a visual decision
 * does not exist yet. Implementations derive private-space and OAuth grant
 * state from the authenticated server scope; callers never supply them.
 */
export interface TrustedProviderProposalAuthorityResolver {
  resolve(input: {
    readonly requestId: string;
    readonly runId: string;
    readonly householdId: string;
    readonly userId: string;
    readonly authenticatedSessionId: string;
    readonly agentId: 'scheduler';
    readonly spaceAccessGrantId: string;
    readonly authorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprint;
    readonly disclosureGrantId: string;
    readonly sdkCallId: string;
    readonly capabilityId: ProviderWriteCapabilityId;
    readonly capabilityFingerprint: string;
  }): Promise<TrustedProviderWriteAuthorityResolution | undefined>;
}

export interface MaterializedProviderWriteProposal {
  readonly sdkCallId: string;
  readonly proposal: ActionProposal;
}

/**
 * A local-write/import materializer returns undefined only after trusted
 * classification has determined the concrete input is safe to execute
 * directly. Any returned proposal is the durable visual-approval boundary.
 */
export interface MaterializedGuardedActionProposal {
  readonly sdkCallId: string;
  readonly proposal: ActionProposal;
}

export interface GuardedActionProposalMaterializationContext extends ProviderProposalMaterializationContext {
  readonly agentId: string;
}

interface StandardProductionCapabilityBinding {
  readonly kind: 'delegation' | 'read' | 'local-write' | 'import';
  readonly execute: CapabilityExecutor<unknown, unknown>;
  /** Present only for a descriptor with dynamic authenticated visual approval. */
  readonly materializeProposal?: (input: {
    readonly capabilityId: string;
    readonly descriptor: CapabilityDescriptor;
    readonly arguments: unknown;
    readonly context: GuardedActionProposalMaterializationContext;
  }) => Promise<MaterializedGuardedActionProposal | undefined>;
}

interface ProviderWriteProductionCapabilityBinding {
  readonly kind: 'provider-write';
  readonly executeProviderWrite: ProviderWriteCapabilityExecutor<
    unknown,
    unknown
  >;
  readonly providerWriteSafety: ProviderWriteSafetyContract;
  /**
   * Validates and canonicalizes model arguments, loads trusted provider state,
   * persists an immutable pending ActionProposal, and atomically binds it to
   * the SDK call ID/run/user/grant before returning. The model never supplies
   * a proposal identifier or approval authority.
   */
  readonly materializeProposal: (input: {
    readonly capabilityId: ProviderWriteCapabilityId;
    readonly descriptor: CapabilityDescriptor;
    readonly arguments: unknown;
    readonly authorityBinding: ProviderWriteAuthorityBinding;
    readonly context: ProviderProposalMaterializationContext;
  }) => Promise<MaterializedProviderWriteProposal>;
}

export type ProductionCapabilityBinding =
  | StandardProductionCapabilityBinding
  | ProviderWriteProductionCapabilityBinding;

export type ProductionCapabilityBindings = Readonly<
  Record<ProductionCapabilityId, ProductionCapabilityBinding>
>;
export type CoreProductionCapabilityBindings = Readonly<
  Record<CoreProductionCapabilityId, ProductionCapabilityBinding>
>;
export type FinanceV1ProductionCapabilityBindings = Readonly<
  Record<FinanceV1ProductionCapabilityId, ProductionCapabilityBinding>
>;
export type FinanceOnlyProductionCapabilityBindings = Readonly<
  Record<FinanceOnlyProductionCapabilityId, ProductionCapabilityBinding>
>;
export type ManagerOnlyProductionCapabilityBindings = Readonly<
  Record<never, ProductionCapabilityBinding>
>;

const requiredDataClasses: Record<ProductionCapabilityId, readonly string[]> = {
  'scheduler.calendar.freebusy.read': ['calendar.events'],
  'scheduler.tasks.read': ['scheduler.tasks'],
  'scheduler.tasks.write': ['scheduler.tasks'],
  'maps.travel-time.read': ['maps.travel-times'],
  'google-calendar.event.create': ['calendar.events'],
  'google-calendar.event.update': ['calendar.events'],
  'google-calendar.event.delete': ['calendar.events'],
  'finance.records.read': financeManifest.readableDataClasses,
  'finance.records.write': financeManifest.readableDataClasses,
  'finance.statement.import': ['finance.imports', 'finance.transactions'],
  'finance.analytics.calculate': ['finance.transactions', 'finance.budgets'],
  'finance.documents.search': [
    'finance.documents',
    'finance.document-evidence',
  ],
  'finance.documents.read': ['finance.documents', 'finance.document-evidence'],
  'finance.matches.read': ['finance.documents', 'finance.document-matches'],
  'shopping.items.read': ['shopping.items'],
  'shopping.items.write': ['shopping.items'],
  'commerce.offers.read': ['shopping.offers'],
  'commerce.offers.refresh': ['shopping.offers'],
  'commerce.link-out.prepare': ['shopping.offers'],
  'agent.scheduler.delegate': [],
  'agent.finance.delegate': [],
  'agent.shopping.delegate': [],
};

const requiredScopes: Record<ProductionCapabilityId, readonly string[]> = {
  'scheduler.calendar.freebusy.read': ['google-calendar.freebusy.read'],
  'scheduler.tasks.read': [],
  'scheduler.tasks.write': [],
  'maps.travel-time.read': ['google-maps.routes.read'],
  'google-calendar.event.create': ['google-calendar.events.write'],
  'google-calendar.event.update': ['google-calendar.events.write'],
  'google-calendar.event.delete': ['google-calendar.events.write'],
  'finance.records.read': [],
  'finance.records.write': [],
  'finance.statement.import': [],
  'finance.analytics.calculate': [],
  'finance.documents.search': [],
  'finance.documents.read': [],
  'finance.matches.read': [],
  'shopping.items.read': [],
  'shopping.items.write': [],
  'commerce.offers.read': ['commerce.offers.read'],
  'commerce.offers.refresh': ['commerce.offers.read'],
  'commerce.link-out.prepare': ['commerce.offers.read'],
  'agent.scheduler.delegate': [],
  'agent.finance.delegate': [],
  'agent.shopping.delegate': [],
};

const schemaRefsForDelegation = (id: ManagerDelegationCapabilityId) => {
  if (id === 'agent.scheduler.delegate') {
    return schedulerManifest.schemaRefs;
  }
  if (id === 'agent.finance.delegate') return financeManifest.schemaRefs;
  return shoppingManifest.schemaRefs;
};

const createDescriptor = (
  id: ProductionCapabilityId,
  kind: ProductionCapabilityBinding['kind'],
) => {
  const isProviderWrite = kind === 'provider-write';
  const isDynamicGuardedAction = DYNAMIC_GUARDED_ACTION_CAPABILITY_IDS.includes(
    id as (typeof DYNAMIC_GUARDED_ACTION_CAPABILITY_IDS)[number],
  );
  const isDelegation = kind === 'delegation';
  const isRead = kind === 'read';
  const schemaRefs = isDelegation
    ? schemaRefsForDelegation(id as ManagerDelegationCapabilityId)
    : schemaRefsForSpecialistCapability(id as SpecialistCapabilityId);
  return CapabilityDescriptorSchema.parse({
    schemaVersion: 1,
    id,
    version: VERSION,
    capabilityKind: kind,
    inputSchema: schemaRefs.input,
    outputSchema: schemaRefs.output,
    requiredScopes: requiredScopes[id],
    requiredDataClasses: requiredDataClasses[id],
    riskClass: isDelegation
      ? 'none'
      : isRead
        ? 'read'
        : isProviderWrite
          ? 'provider-write'
          : 'local-write',
    timeoutMs: isProviderWrite ? PROVIDER_WRITE_TIMEOUT_MS : 15_000,
    freshness: {
      required:
        isProviderWrite ||
        id === 'scheduler.calendar.freebusy.read' ||
        id === 'maps.travel-time.read' ||
        id === 'commerce.offers.read' ||
        id === 'commerce.offers.refresh',
      maxAgeMs: isProviderWrite ? 0 : 60_000,
      revalidateBeforeExecution: isProviderWrite,
    },
    idempotency: {
      required: isProviderWrite || kind === 'local-write' || kind === 'import',
      scope: isProviderWrite ? 'provider-target' : 'actor',
      ttlMs: isProviderWrite ? PROVIDER_WRITE_IDEMPOTENCY_TTL_MS : 86_400_000,
    },
    approval:
      isProviderWrite || isDynamicGuardedAction
        ? {
            rule: 'authenticated-visual-proposal',
            expiresInSeconds: 600,
          }
        : { rule: 'none', expiresInSeconds: 0 },
    audit: {
      required: true,
      eventType: `${id}.${isProviderWrite ? 'provider-write' : 'invoked'}`,
      redactFields: isProviderWrite ? ['description', 'attendees'] : [],
    },
    executorId: `${id}.v1`,
  });
};

/**
 * Finance's execution leaf receives this descriptor binding from durable
 * composition rather than trusting a permit's fingerprint. Keeping the
 * descriptor source here makes a stale or substituted permit fail closed.
 */
export const financeGuardedActionCapabilityFingerprint = (
  capabilityId: 'finance.records.write' | 'finance.statement.import',
): string =>
  hashCapabilityDescriptorBinding(
    createDescriptor(
      capabilityId,
      capabilityId === 'finance.records.write' ? 'local-write' : 'import',
    ),
  );

const productionProviderWriteCapabilityNames = Object.freeze(
  schedulerCapabilityReferences
    .filter(({ kind }) => kind === 'provider-write')
    .map(({ id }) => id) as ProviderWriteCapabilityName[],
);

const productionProviderWriteCapabilityNameSet = new Set<string>(
  productionProviderWriteCapabilityNames,
);

export const parseProductionProviderWriteCapabilityId = (
  value: unknown,
): ProviderWriteCapabilityId => {
  if (
    typeof value !== 'string' ||
    !productionProviderWriteCapabilityNameSet.has(value)
  ) {
    throw new Error('api-provider-write-capability-id-invalid');
  }
  const descriptor = createDescriptor(
    value as ProviderWriteCapabilityName,
    'provider-write',
  );
  if (descriptor.capabilityKind !== 'provider-write') {
    throw new Error('api-provider-write-capability-id-invalid');
  }
  return descriptor.id as ProviderWriteCapabilityId;
};

export const PROVIDER_WRITE_CAPABILITY_IDS = Object.freeze(
  productionProviderWriteCapabilityNames.map((capabilityId) =>
    parseProductionProviderWriteCapabilityId(capabilityId),
  ),
);

const assertPlainRecord: (
  value: unknown,
  errorCode: string,
) => asserts value is Record<string, unknown> = (value, errorCode) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(errorCode);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(errorCode);
  }
};

const exactBindingKeys = (
  binding: Record<string, unknown>,
  expected: readonly string[],
  capabilityId: string,
): void => {
  const keys = Object.keys(binding).sort();
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(binding, key))
  ) {
    throw new Error(`api-capability-binding-invalid:${capabilityId}`);
  }
};

const validateApprovalStore: (
  value: unknown,
) => asserts value is ProviderWriteApprovalStore = (value) => {
  if (value === null || typeof value !== 'object') {
    throw new Error('api-provider-write-approval-store-missing');
  }
  for (const method of [
    'acquire',
    'markDispatching',
    'finalize',
    'reconcile',
  ]) {
    if (typeof (value as Record<string, unknown>)[method] !== 'function') {
      throw new Error('api-provider-write-approval-store-missing');
    }
  }
};

const validateResolver = (
  value: unknown,
  errorCode: string,
): { readonly resolve: (...arguments_: never[]) => Promise<unknown> } => {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as Record<string, unknown>).resolve !== 'function'
  ) {
    throw new Error(errorCode);
  }
  return value as {
    readonly resolve: (...arguments_: never[]) => Promise<unknown>;
  };
};

const validateBindings = (
  rawBindings: unknown,
  capabilityIds: readonly ProductionCapabilityId[] = Object.keys(
    REQUIRED_CAPABILITY_BINDING_KINDS,
  ) as ProductionCapabilityId[],
): {
  readonly registrations: readonly RegisteredCapability[];
  readonly materializers: ReadonlyMap<
    string,
    ProviderWriteProductionCapabilityBinding['materializeProposal']
  >;
  readonly guardedActionMaterializers: ReadonlyMap<
    string,
    NonNullable<StandardProductionCapabilityBinding['materializeProposal']>
  >;
} => {
  assertPlainRecord(rawBindings, 'api-capability-bindings-missing');
  const requiredIds = [...capabilityIds];
  const allowedIds = new Set(requiredIds);
  for (const key of Object.keys(rawBindings)) {
    if (!allowedIds.has(key as ProductionCapabilityId)) {
      throw new Error(`api-capability-binding-unexpected:${key}`);
    }
  }
  const registrations: RegisteredCapability[] = [];
  const materializers = new Map<
    string,
    ProviderWriteProductionCapabilityBinding['materializeProposal']
  >();
  const guardedActionMaterializers = new Map<
    string,
    NonNullable<StandardProductionCapabilityBinding['materializeProposal']>
  >();
  for (const capabilityId of requiredIds as ProductionCapabilityId[]) {
    const rawBinding = rawBindings[capabilityId];
    if (rawBinding === undefined) {
      throw new Error(`api-capability-binding-missing:${capabilityId}`);
    }
    assertPlainRecord(
      rawBinding,
      `api-capability-binding-invalid:${capabilityId}`,
    );
    const expectedKind = REQUIRED_CAPABILITY_BINDING_KINDS[capabilityId];
    if (rawBinding.kind !== expectedKind) {
      throw new Error(`api-capability-binding-kind-mismatch:${capabilityId}`);
    }
    const descriptor = createDescriptor(capabilityId, expectedKind);
    if (expectedKind === 'provider-write') {
      if (descriptor.capabilityKind !== 'provider-write') {
        throw new Error(
          `api-capability-descriptor-kind-invalid:${capabilityId}`,
        );
      }
      exactBindingKeys(
        rawBinding,
        [
          'kind',
          'executeProviderWrite',
          'providerWriteSafety',
          'materializeProposal',
        ],
        capabilityId,
      );
      if (
        typeof rawBinding.executeProviderWrite !== 'function' ||
        typeof rawBinding.materializeProposal !== 'function'
      ) {
        throw new Error(`api-capability-binding-invalid:${capabilityId}`);
      }
      const executeProviderWrite = rawBinding.executeProviderWrite.bind(
        rawBinding,
      ) as ProviderWriteProductionCapabilityBinding['executeProviderWrite'];
      const materializeProposal = rawBinding.materializeProposal.bind(
        rawBinding,
      ) as ProviderWriteProductionCapabilityBinding['materializeProposal'];
      if (rawBinding.providerWriteSafety === undefined) {
        throw new Error(`api-capability-binding-invalid:${capabilityId}`);
      }
      const providerWriteSafety =
        rawBinding.providerWriteSafety as ProviderWriteSafetyContract;
      registrations.push({
        descriptor,
        executeProviderWrite: async (arguments_, context) => {
          assertBoundedModelArguments(arguments_);
          return executeProviderWrite(deepFreeze(arguments_), context);
        },
        providerWriteSafety,
      });
      materializers.set(capabilityId, materializeProposal);
      continue;
    }
    if (descriptor.capabilityKind === 'provider-write') {
      throw new Error(`api-capability-descriptor-kind-invalid:${capabilityId}`);
    }
    const requiresGuardedActionMaterializer =
      descriptor.approval.rule === 'authenticated-visual-proposal';
    const hasGuardedActionMaterializer =
      rawBinding.materializeProposal !== undefined;
    exactBindingKeys(
      rawBinding,
      hasGuardedActionMaterializer
        ? ['kind', 'execute', 'materializeProposal']
        : ['kind', 'execute'],
      capabilityId,
    );
    if (typeof rawBinding.execute !== 'function') {
      throw new Error(`api-capability-binding-invalid:${capabilityId}`);
    }
    if (
      hasGuardedActionMaterializer &&
      typeof rawBinding.materializeProposal !== 'function'
    ) {
      throw new Error(`api-capability-binding-invalid:${capabilityId}`);
    }
    const execute = rawBinding.execute.bind(rawBinding) as CapabilityExecutor<
      unknown,
      unknown
    >;
    registrations.push({
      descriptor,
      execute: async (arguments_, context) => {
        assertBoundedModelArguments(arguments_);
        return execute(deepFreeze(arguments_), context);
      },
    });
    if (requiresGuardedActionMaterializer && hasGuardedActionMaterializer) {
      const materializeProposal = rawBinding.materializeProposal as NonNullable<
        StandardProductionCapabilityBinding['materializeProposal']
      >;
      guardedActionMaterializers.set(
        capabilityId,
        materializeProposal.bind(rawBinding),
      );
    }
  }
  return Object.freeze({
    registrations: Object.freeze(registrations),
    materializers,
    guardedActionMaterializers,
  });
};

const ProposalMaterializationRequestSchema = z.strictObject({
  capabilityId: z.enum([
    'google-calendar.event.create',
    'google-calendar.event.update',
    'google-calendar.event.delete',
  ]),
  arguments: z.unknown(),
  context: z.strictObject({
    requestId: UuidSchema,
    runId: UuidSchema,
    householdId: UuidSchema,
    userId: UuidSchema,
    authenticatedSessionId: UuidSchema,
    spaceAccessGrantId: UuidSchema,
    authorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprintSchema,
    disclosureGrantId: UuidSchema,
    disclosureGrantVersion: SemanticVersionSchema,
    invocationContext: AgentInvocationContextSchema,
    invocationContextHash: Sha256Schema,
    sdkCallId: OpaqueReferenceSchema,
    abortSignal: z.custom<AbortSignal>(
      (value) =>
        value !== null &&
        typeof value === 'object' &&
        typeof (value as AbortSignal).aborted === 'boolean',
    ),
  }),
});

const GuardedActionMaterializationRequestSchema = z.strictObject({
  capabilityId: IdentifierSchema,
  arguments: z.unknown(),
  context: z.strictObject({
    requestId: UuidSchema,
    runId: UuidSchema,
    householdId: UuidSchema,
    userId: UuidSchema,
    authenticatedSessionId: UuidSchema,
    spaceAccessGrantId: UuidSchema,
    authorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprintSchema,
    disclosureGrantId: UuidSchema,
    disclosureGrantVersion: SemanticVersionSchema,
    invocationContext: AgentInvocationContextSchema,
    invocationContextHash: Sha256Schema,
    sdkCallId: OpaqueReferenceSchema,
    agentId: IdentifierSchema,
    abortSignal: z.custom<AbortSignal>(
      (value) =>
        value !== null &&
        typeof value === 'object' &&
        typeof (value as AbortSignal).aborted === 'boolean',
    ),
  }),
});

const MaterializedProviderWriteProposalSchema = z
  .strictObject({
    sdkCallId: OpaqueReferenceSchema,
    proposal: ActionProposalSchema,
  })
  .transform(deepFreeze);

const MaterializedGuardedActionProposalSchema = z
  .strictObject({
    sdkCallId: OpaqueReferenceSchema,
    proposal: ActionProposalSchema,
  })
  .transform(deepFreeze);

export interface ProductionCapabilityRuntime {
  readonly registry: CapabilityRegistry;
  readonly schemas: ReturnType<typeof createRuntimeSchemaRegistry>;
  readonly schemaResolver: AgentSchemaResolver;
  readonly manifests: Readonly<{
    manager: AgentManifest;
    scheduler: AgentManifest;
    finance: AgentManifest;
    shopping: AgentManifest;
  }>;
  materializeProviderWriteProposal(input: {
    readonly capabilityId: ProviderWriteCapabilityId;
    readonly arguments: unknown;
    readonly context: ProviderProposalMaterializationContext;
  }): Promise<MaterializedProviderWriteProposal>;
  materializeGuardedActionProposal(input: {
    readonly capabilityId: string;
    readonly arguments: unknown;
    readonly context: GuardedActionProposalMaterializationContext;
  }): Promise<MaterializedGuardedActionProposal | undefined>;
}

export interface CoreProductionCapabilityRuntime {
  readonly registry: CapabilityRegistry;
  readonly schemas: ReturnType<typeof createRuntimeSchemaRegistry>;
  readonly schemaResolver: AgentSchemaResolver;
  readonly manifests: Readonly<{
    manager: AgentManifest;
    scheduler: AgentManifest;
  }>;
  materializeProviderWriteProposal(input: {
    readonly capabilityId: ProviderWriteCapabilityId;
    readonly arguments: unknown;
    readonly context: ProviderProposalMaterializationContext;
  }): Promise<MaterializedProviderWriteProposal>;
  materializeGuardedActionProposal(input: {
    readonly capabilityId: string;
    readonly arguments: unknown;
    readonly context: GuardedActionProposalMaterializationContext;
  }): Promise<MaterializedGuardedActionProposal | undefined>;
}

export interface FinanceV1ProductionCapabilityRuntime {
  readonly registry: CapabilityRegistry;
  readonly schemas: ReturnType<typeof createRuntimeSchemaRegistry>;
  readonly schemaResolver: AgentSchemaResolver;
  readonly manifests: Readonly<{
    manager: AgentManifest;
    scheduler: AgentManifest;
    finance: AgentManifest;
  }>;
  materializeProviderWriteProposal(input: {
    readonly capabilityId: ProviderWriteCapabilityId;
    readonly arguments: unknown;
    readonly context: ProviderProposalMaterializationContext;
  }): Promise<MaterializedProviderWriteProposal>;
  materializeGuardedActionProposal(input: {
    readonly capabilityId: string;
    readonly arguments: unknown;
    readonly context: GuardedActionProposalMaterializationContext;
  }): Promise<MaterializedGuardedActionProposal | undefined>;
}

export interface FinanceOnlyProductionCapabilityRuntime {
  readonly registry: CapabilityRegistry;
  readonly schemas: ReturnType<typeof createRuntimeSchemaRegistry>;
  readonly schemaResolver: AgentSchemaResolver;
  readonly manifests: Readonly<{
    manager: AgentManifest;
    finance: AgentManifest;
  }>;
  materializeProviderWriteProposal(input: {
    readonly capabilityId: ProviderWriteCapabilityId;
    readonly arguments: unknown;
    readonly context: ProviderProposalMaterializationContext;
  }): Promise<MaterializedProviderWriteProposal>;
  materializeGuardedActionProposal(input: {
    readonly capabilityId: string;
    readonly arguments: unknown;
    readonly context: GuardedActionProposalMaterializationContext;
  }): Promise<MaterializedGuardedActionProposal | undefined>;
}

export interface ManagerOnlyProductionCapabilityRuntime {
  readonly registry: CapabilityRegistry;
  readonly schemas: ReturnType<typeof createRuntimeSchemaRegistry>;
  readonly schemaResolver: AgentSchemaResolver;
  readonly manifests: Readonly<{ manager: AgentManifest }>;
  materializeProviderWriteProposal(input: {
    readonly capabilityId: ProviderWriteCapabilityId;
    readonly arguments: unknown;
    readonly context: ProviderProposalMaterializationContext;
  }): Promise<MaterializedProviderWriteProposal>;
  materializeGuardedActionProposal(input: {
    readonly capabilityId: string;
    readonly arguments: unknown;
    readonly context: GuardedActionProposalMaterializationContext;
  }): Promise<MaterializedGuardedActionProposal | undefined>;
}

type CapabilityRuntimeConstructionInput<
  Manifests extends Readonly<Record<string, AgentManifest>>,
> = {
  readonly bindings: unknown;
  readonly providerWriteApprovalStore: unknown;
  readonly trustedProviderWriteAuthorityResolver: unknown;
  readonly trustedProviderProposalAuthorityResolver: unknown;
  readonly capabilityIds: readonly ProductionCapabilityId[];
  readonly schemaRegistrations: readonly AgentRuntimeSchemaRegistration[];
  readonly manifests: Manifests;
};

const createScopedProductionCapabilityRuntime = <
  Manifests extends Readonly<Record<string, AgentManifest>>,
>(
  input: CapabilityRuntimeConstructionInput<Manifests>,
) => {
  validateApprovalStore(input.providerWriteApprovalStore);
  const executionAuthorityResolver = validateResolver(
    input.trustedProviderWriteAuthorityResolver,
    'api-provider-write-authority-resolver-missing',
  ) as TrustedProviderWriteAuthorityResolver;
  const proposalAuthorityResolver = validateResolver(
    input.trustedProviderProposalAuthorityResolver,
    'api-provider-proposal-authority-resolver-missing',
  ) as TrustedProviderProposalAuthorityResolver;
  const { registrations, materializers, guardedActionMaterializers } =
    validateBindings(input.bindings, input.capabilityIds);
  const schemaRegistrations = input.schemaRegistrations;
  const schemas = createRuntimeSchemaRegistry(schemaRegistrations);
  const schemaResolver = createAgentSchemaResolver(
    schemaRegistrations as readonly AgentRuntimeSchemaRegistration[],
  );
  const registry = createCapabilityRegistry(registrations, schemas, {
    providerWriteApprovalStore: input.providerWriteApprovalStore,
    trustedProviderWriteAuthorityResolver: executionAuthorityResolver,
  });
  const manifests = deepFreeze(input.manifests);

  const materializeProviderWriteProposal: CoreProductionCapabilityRuntime['materializeProviderWriteProposal'] =
    async (rawInput) => {
      const request = ProposalMaterializationRequestSchema.parse(rawInput);
      const capabilityId = parseProductionProviderWriteCapabilityId(
        request.capabilityId,
      );
      assertBoundedModelArguments(request.arguments);
      const descriptor = registrations.find(
        ({ descriptor: candidate }) => candidate.id === capabilityId,
      )?.descriptor;
      if (descriptor === undefined) {
        throw new Error('api-provider-write-capability-unregistered');
      }
      const capabilityFingerprint = hashCapabilityDescriptorBinding(descriptor);
      let authorityResolution: TrustedProviderWriteAuthorityResolution;
      try {
        authorityResolution =
          TrustedProviderWriteAuthorityResolutionSchema.parse(
            await proposalAuthorityResolver.resolve({
              requestId: request.context.requestId,
              runId: request.context.runId,
              householdId: request.context.householdId,
              userId: request.context.userId,
              authenticatedSessionId: request.context.authenticatedSessionId,
              agentId: 'scheduler',
              spaceAccessGrantId: request.context.spaceAccessGrantId,
              authorizationScopeFingerprint:
                request.context.authorizationScopeFingerprint,
              disclosureGrantId: request.context.disclosureGrantId,
              sdkCallId: request.context.sdkCallId,
              capabilityId,
              capabilityFingerprint,
            }),
          );
      } catch {
        throw new Error('api-provider-proposal-authority-binding-invalid');
      }
      const { authorityBinding, operationScope } = authorityResolution;
      if (
        authorityBinding.householdId !== request.context.householdId ||
        authorityBinding.authorizationScopeFingerprint !==
          request.context.authorizationScopeFingerprint ||
        operationScope.requestId !== request.context.requestId ||
        operationScope.sessionId !== request.context.authenticatedSessionId ||
        operationScope.householdId !== request.context.householdId ||
        operationScope.userId !== request.context.userId ||
        operationScope.spaceAccessGrantId !==
          request.context.spaceAccessGrantId ||
        operationScope.authorizationScopeFingerprint !==
          request.context.authorizationScopeFingerprint
      ) {
        throw new Error('api-provider-proposal-authority-binding-invalid');
      }
      const arguments_ = schemas.parse<unknown>(
        descriptor.inputSchema,
        request.arguments,
      );
      const materializer = materializers.get(capabilityId);
      if (materializer === undefined) {
        throw new Error(`api-capability-materializer-missing:${capabilityId}`);
      }
      const materialized = MaterializedProviderWriteProposalSchema.parse(
        await materializer({
          capabilityId,
          descriptor,
          arguments: arguments_,
          authorityBinding,
          context: request.context,
        }),
      );
      const proposal = materialized.proposal;
      if (
        materialized.sdkCallId !== request.context.sdkCallId ||
        proposal.runId !== request.context.runId ||
        proposal.providerSdkCallId !== request.context.sdkCallId ||
        proposal.capabilityId !== capabilityId ||
        proposal.capabilityFingerprint !== capabilityFingerprint ||
        proposal.authorizationScopeFingerprint !==
          request.context.authorizationScopeFingerprint ||
        proposal.providerAuthorityBindingHash !==
          hashCanonicalJson(authorityBinding) ||
        proposal.payloadHash !==
          hashCanonicalJson(proposal.canonicalArguments) ||
        proposal.disclosureGrant.id !== request.context.disclosureGrantId ||
        proposal.disclosureGrant.userId !== request.context.userId ||
        proposal.disclosureGrant.householdId !== request.context.householdId ||
        proposal.disclosureGrant.agentId !== 'scheduler' ||
        hashCanonicalJson(proposal.disclosureGrant.invocationContext) !==
          hashCanonicalJson(request.context.invocationContext) ||
        proposal.disclosureGrant.invocationContextHash !==
          request.context.invocationContextHash ||
        proposal.state !== 'pending' ||
        (proposal.beforePreview === null && proposal.afterPreview === null)
      ) {
        throw new Error('api-provider-write-proposal-binding-invalid');
      }
      return materialized;
    };

  const materializeGuardedActionProposal: CoreProductionCapabilityRuntime['materializeGuardedActionProposal'] =
    async (rawInput) => {
      const request = GuardedActionMaterializationRequestSchema.parse(rawInput);
      assertBoundedModelArguments(request.arguments);
      const descriptor = registrations.find(
        ({ descriptor: candidate }) => candidate.id === request.capabilityId,
      )?.descriptor;
      if (
        descriptor === undefined ||
        descriptor.approval.rule !== 'authenticated-visual-proposal'
      ) {
        throw new Error('api-guarded-action-capability-unregistered');
      }

      if (descriptor.capabilityKind === 'provider-write') {
        return materializeProviderWriteProposal({
          capabilityId: parseProductionProviderWriteCapabilityId(
            request.capabilityId,
          ),
          arguments: request.arguments,
          context: {
            requestId: request.context.requestId,
            runId: request.context.runId,
            householdId: request.context.householdId,
            userId: request.context.userId,
            authenticatedSessionId: request.context.authenticatedSessionId,
            spaceAccessGrantId: request.context.spaceAccessGrantId,
            authorizationScopeFingerprint:
              request.context.authorizationScopeFingerprint,
            disclosureGrantId: request.context.disclosureGrantId,
            disclosureGrantVersion: request.context.disclosureGrantVersion,
            invocationContext: request.context.invocationContext,
            invocationContextHash: request.context.invocationContextHash,
            sdkCallId: request.context.sdkCallId,
            abortSignal: request.context.abortSignal,
          },
        });
      }
      if (
        descriptor.capabilityKind !== 'local-write' &&
        descriptor.capabilityKind !== 'import'
      ) {
        throw new Error('api-guarded-action-capability-invalid');
      }
      const matchingManifest = Object.values(manifests).find(
        (manifest) =>
          manifest.id === request.context.agentId &&
          manifest.capabilityAllowlist.includes(descriptor.id),
      );
      if (
        matchingManifest === undefined ||
        matchingManifest.kind !== 'specialist'
      ) {
        throw new Error('api-guarded-action-agent-binding-invalid');
      }
      const materializer = guardedActionMaterializers.get(descriptor.id);
      if (materializer === undefined) {
        throw new Error(`api-capability-materializer-missing:${descriptor.id}`);
      }
      const arguments_ = schemas.parse<unknown>(
        descriptor.inputSchema,
        request.arguments,
      );
      const rawMaterialized = await materializer({
        capabilityId: descriptor.id,
        descriptor,
        arguments: arguments_,
        context: request.context,
      });
      if (rawMaterialized === undefined) return undefined;
      const materialized =
        MaterializedGuardedActionProposalSchema.parse(rawMaterialized);
      const proposal = materialized.proposal;
      const actionHash = hashCanonicalJson(arguments_);
      if (
        materialized.sdkCallId !== request.context.sdkCallId ||
        proposal.runId !== request.context.runId ||
        proposal.providerSdkCallId !== request.context.sdkCallId ||
        proposal.capabilityId !== descriptor.id ||
        proposal.capabilityFingerprint !==
          hashCapabilityDescriptorBinding(descriptor) ||
        proposal.authorizationScopeFingerprint !==
          request.context.authorizationScopeFingerprint ||
        proposal.payloadHash !== actionHash ||
        hashCanonicalJson(proposal.canonicalArguments) !== actionHash ||
        proposal.disclosureGrant.id !== request.context.disclosureGrantId ||
        proposal.disclosureGrant.userId !== request.context.userId ||
        proposal.disclosureGrant.householdId !== request.context.householdId ||
        proposal.disclosureGrant.agentId !== request.context.agentId ||
        hashCanonicalJson(proposal.disclosureGrant.invocationContext) !==
          hashCanonicalJson(request.context.invocationContext) ||
        proposal.disclosureGrant.invocationContextHash !==
          request.context.invocationContextHash ||
        proposal.guardedAction === undefined ||
        proposal.guardedAction.capabilityVersion !== descriptor.version ||
        proposal.guardedAction.actionHash !== actionHash ||
        proposal.guardedAction.executionBindingHash !==
          proposal.providerAuthorityBindingHash ||
        proposal.state !== 'pending' ||
        (proposal.beforePreview === null && proposal.afterPreview === null)
      ) {
        throw new Error('api-guarded-action-proposal-binding-invalid');
      }
      return materialized;
    };

  return Object.freeze({
    registry,
    schemas,
    schemaResolver,
    manifests,
    materializeProviderWriteProposal,
    materializeGuardedActionProposal,
  });
};

export const createProductionCapabilityRuntime = (input: {
  readonly bindings: unknown;
  readonly providerWriteApprovalStore: unknown;
  readonly trustedProviderWriteAuthorityResolver: unknown;
  readonly trustedProviderProposalAuthorityResolver: unknown;
}): ProductionCapabilityRuntime =>
  createScopedProductionCapabilityRuntime({
    ...input,
    capabilityIds: [
      ...ALL_MANAGER_DELEGATION_CAPABILITY_IDS,
      ...ALL_SPECIALIST_CAPABILITY_IDS,
    ],
    schemaRegistrations: [
      ...managerSchemaRegistrations,
      ...schedulerSchemaRegistrations,
      ...financeSchemaRegistrations,
      ...shoppingSchemaRegistrations,
      ...capabilitySchemaRegistrations,
    ],
    manifests: {
      manager: managerManifest,
      scheduler: schedulerManifest,
      finance: financeManifest,
      shopping: shoppingManifest,
    },
  }) as ProductionCapabilityRuntime;

export const createCoreProductionCapabilityRuntime = (input: {
  readonly bindings: unknown;
  readonly providerWriteApprovalStore: unknown;
  readonly trustedProviderWriteAuthorityResolver: unknown;
  readonly trustedProviderProposalAuthorityResolver: unknown;
  readonly manifests: CoreProductionCapabilityRuntime['manifests'];
}): CoreProductionCapabilityRuntime =>
  createScopedProductionCapabilityRuntime({
    ...input,
    capabilityIds: CORE_MVP_CAPABILITY_IDS,
    schemaRegistrations: [
      ...managerSchemaRegistrations,
      ...schedulerSchemaRegistrations,
      ...capabilitySchemaRegistrations,
    ],
  }) as CoreProductionCapabilityRuntime;

export const createFinanceV1ProductionCapabilityRuntime = (input: {
  readonly bindings: unknown;
  readonly providerWriteApprovalStore: unknown;
  readonly trustedProviderWriteAuthorityResolver: unknown;
  readonly trustedProviderProposalAuthorityResolver: unknown;
  readonly manifests: FinanceV1ProductionCapabilityRuntime['manifests'];
}): FinanceV1ProductionCapabilityRuntime =>
  createScopedProductionCapabilityRuntime({
    ...input,
    capabilityIds: FINANCE_V1_CAPABILITY_IDS,
    schemaRegistrations: [
      ...managerSchemaRegistrations,
      ...schedulerSchemaRegistrations,
      ...financeSchemaRegistrations,
      ...capabilitySchemaRegistrations,
    ],
  }) as FinanceV1ProductionCapabilityRuntime;

export const createFinanceOnlyProductionCapabilityRuntime = (input: {
  readonly bindings: unknown;
  readonly providerWriteApprovalStore: unknown;
  readonly trustedProviderWriteAuthorityResolver: unknown;
  readonly trustedProviderProposalAuthorityResolver: unknown;
  readonly manifests: FinanceOnlyProductionCapabilityRuntime['manifests'];
}): FinanceOnlyProductionCapabilityRuntime =>
  createScopedProductionCapabilityRuntime({
    ...input,
    capabilityIds: FINANCE_ONLY_CAPABILITY_IDS,
    schemaRegistrations: [
      ...managerSchemaRegistrations,
      ...financeSchemaRegistrations,
      ...capabilitySchemaRegistrations,
    ],
  }) as FinanceOnlyProductionCapabilityRuntime;

export const createManagerOnlyProductionCapabilityRuntime = (input: {
  readonly bindings: unknown;
  readonly providerWriteApprovalStore: unknown;
  readonly trustedProviderWriteAuthorityResolver: unknown;
  readonly trustedProviderProposalAuthorityResolver: unknown;
  readonly manifests: ManagerOnlyProductionCapabilityRuntime['manifests'];
}): ManagerOnlyProductionCapabilityRuntime =>
  createScopedProductionCapabilityRuntime({
    ...input,
    capabilityIds: [],
    schemaRegistrations: [
      ...managerSchemaRegistrations,
      ...capabilitySchemaRegistrations,
    ],
  }) as ManagerOnlyProductionCapabilityRuntime;

export const capabilityInvocationContextForServer = (input: {
  readonly requestId: string;
  readonly runId: string;
  readonly userId: string;
  readonly householdId: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly invocationContext: CapabilityInvocationContext['invocationContext'];
  readonly spaceAccessGrantId: string;
  readonly locale: SupportedLocale;
  readonly disclosureGrantId?: string;
  readonly approvalDecisionId?: string;
  readonly abortSignal: AbortSignal;
}): CapabilityInvocationContext => Object.freeze({ ...input });

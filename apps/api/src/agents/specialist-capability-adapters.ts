import { z } from 'zod';

import {
  IsoDateTimeSchema,
  OpaqueReferenceSchema,
  UuidSchema,
  deepFreeze,
  type CapabilityExecutor,
  type CapabilityInvocationContext,
  type DeepReadonly,
} from '@emdo/contracts';
import {
  applyTransactionLedgerOperation,
  calculateMonthlyCategoryTotals,
  validateFinanceRecord,
  validateFinanceRecordCreate,
  type FinanceLedgerApplicationResult,
  type FinanceRecord,
  type FinanceTransactionRecord,
  type MonthlyCategoryTotalsResult,
} from '@emdo/domains/finance';
import {
  normalizeShoppingItem,
  type ShoppingItem,
} from '@emdo/domains/shopping';
import {
  parseSpecialistCapabilityOutput,
  specialistCapabilitySchemas,
  type ProviderWriteCapabilityName,
  type SpecialistCapabilityId,
} from './capability-runtime.js';
import type { FinanceDocumentGuardedActionPort } from '../production/finance-agent-services.js';

export type StandardSpecialistCapabilityId = Exclude<
  SpecialistCapabilityId,
  ProviderWriteCapabilityName
>;

type CalendarFreeBusyInput = z.output<
  (typeof specialistCapabilitySchemas)['scheduler.calendar.freebusy.read']['input']
>;
type TaskReadInput = z.output<
  (typeof specialistCapabilitySchemas)['scheduler.tasks.read']['input']
>;
type TaskWriteInput = z.output<
  (typeof specialistCapabilitySchemas)['scheduler.tasks.write']['input']
>;
type TravelInput = z.output<
  (typeof specialistCapabilitySchemas)['maps.travel-time.read']['input']
>;
type FinanceReadInput = z.output<
  (typeof specialistCapabilitySchemas)['finance.records.read']['input']
>;
type FinanceWriteInput = z.output<
  (typeof specialistCapabilitySchemas)['finance.records.write']['input']
>;
type FinanceImportInput = z.output<
  (typeof specialistCapabilitySchemas)['finance.statement.import']['input']
>;
type FinanceAnalyticsInput = z.output<
  (typeof specialistCapabilitySchemas)['finance.analytics.calculate']['input']
>;
type FinanceDocumentSearchInput = z.output<
  (typeof specialistCapabilitySchemas)['finance.documents.search']['input']
>;
type FinanceDocumentReadInput = z.output<
  (typeof specialistCapabilitySchemas)['finance.documents.read']['input']
>;
type FinanceMatchReadInput = z.output<
  (typeof specialistCapabilitySchemas)['finance.matches.read']['input']
>;
type ShoppingReadInput = z.output<
  (typeof specialistCapabilitySchemas)['shopping.items.read']['input']
>;
type ShoppingWriteInput = z.output<
  (typeof specialistCapabilitySchemas)['shopping.items.write']['input']
>;
type OffersReadInput = z.output<
  (typeof specialistCapabilitySchemas)['commerce.offers.read']['input']
>;
type OffersRefreshInput = z.output<
  (typeof specialistCapabilitySchemas)['commerce.offers.refresh']['input']
>;
type LinkOutInput = z.output<
  (typeof specialistCapabilitySchemas)['commerce.link-out.prepare']['input']
>;

type TrustedCapabilityService<Input> = (
  input: DeepReadonly<Input>,
  context: CapabilityInvocationContext,
) => Promise<unknown>;

export type CanonicalShoppingMutation =
  | Readonly<{ kind: 'create'; item: ShoppingItem }>
  | Readonly<{ kind: 'update'; itemId: string; replacement: ShoppingItem }>
  | Readonly<{
      kind: 'delta';
      itemId: string;
      quantityMilliUnits: number;
    }>
  | Readonly<{ kind: 'tombstone'; itemId: string }>;

export interface TrustedStandardSpecialistServices {
  readonly readCalendarFreeBusy: TrustedCapabilityService<
    Readonly<Pick<CalendarFreeBusyInput, 'windowStart' | 'windowEnd'>>
  >;
  readonly readTasks: TrustedCapabilityService<
    Readonly<Omit<TaskReadInput, 'schemaVersion'>>
  >;
  readonly writeTask: TrustedCapabilityService<TaskWriteInput['mutation']>;
  readonly resolveTravelTime: TrustedCapabilityService<
    Readonly<Omit<TravelInput, 'schemaVersion'>>
  >;
  readonly readFinanceRecords: TrustedCapabilityService<
    Readonly<Omit<FinanceReadInput, 'schemaVersion'>>
  >;
  /** Loads authoritative records/revisions and commits in one scoped transaction. */
  readonly writeFinanceRecord: TrustedCapabilityService<
    FinanceWriteInput['mutation']
  >;
  /** Preview resolves server upload/mapping refs; commit resolves the stored plan by ID. */
  readonly executeStatementImport: TrustedCapabilityService<
    FinanceImportInput['request']
  >;
  readonly loadFinanceBudgetInputs: TrustedCapabilityService<
    Readonly<{ month: string }>
  >;
  readonly searchFinanceDocuments: TrustedCapabilityService<
    Readonly<Omit<FinanceDocumentSearchInput, 'schemaVersion'>>
  >;
  readonly readFinanceDocument: TrustedCapabilityService<
    Readonly<Omit<FinanceDocumentReadInput, 'schemaVersion'>>
  >;
  readonly readFinanceMatches: TrustedCapabilityService<
    Readonly<Omit<FinanceMatchReadInput, 'schemaVersion'>>
  >;
  readonly readShoppingItems: TrustedCapabilityService<
    Readonly<Omit<ShoppingReadInput, 'schemaVersion'>>
  >;
  /** Applies canonical item data or an idempotent nonzero delta under server scope. */
  readonly writeShoppingItem: TrustedCapabilityService<CanonicalShoppingMutation>;
  readonly readOffers: TrustedCapabilityService<
    Readonly<Omit<OffersReadInput, 'schemaVersion'>>
  >;
  /** Selects an approved deployed connector server-side; the model supplies no provider ID. */
  readonly refreshOffers: TrustedCapabilityService<
    Readonly<Omit<OffersRefreshInput, 'schemaVersion'>>
  >;
  /** Resolves the offer URL and deployment-approved URL policy server-side. */
  readonly prepareLinkOut: TrustedCapabilityService<
    Readonly<Omit<LinkOutInput, 'schemaVersion'>>
  >;
}

export type TrustedFinanceSpecialistServices = Pick<
  TrustedStandardSpecialistServices,
  | 'readFinanceRecords'
  | 'writeFinanceRecord'
  | 'executeStatementImport'
  | 'loadFinanceBudgetInputs'
  | 'searchFinanceDocuments'
  | 'readFinanceDocument'
  | 'readFinanceMatches'
> & {
  /**
   * Internal request-scoped port for the three approved document mutations.
   * It is deliberately not a registered capability and never reaches a model.
   */
  readonly guardedDocumentActions?: FinanceDocumentGuardedActionPort;
};

const parseInput = <Id extends StandardSpecialistCapabilityId>(
  capabilityId: Id,
  input: unknown,
): z.output<(typeof specialistCapabilitySchemas)[Id]['input']> =>
  specialistCapabilitySchemas[capabilityId].input.parse(input) as z.output<
    (typeof specialistCapabilitySchemas)[Id]['input']
  >;

const wrapOutput = (
  capabilityId: StandardSpecialistCapabilityId,
  value: Readonly<Record<string, unknown>>,
): unknown =>
  parseSpecialistCapabilityOutput(capabilityId, {
    schemaVersion: 1,
    ...value,
  });

const asPlainRecord = (value: unknown, errorCode: string) => {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new Error(errorCode);
  }
  return value as Record<string, unknown>;
};

const boundedCalendarEvidence = (value: unknown): unknown => {
  const evidence = asPlainRecord(
    value,
    'api-calendar-evidence-service-result-invalid',
  );
  if (!Array.isArray(evidence.blocks)) {
    throw new Error('api-calendar-evidence-service-result-invalid');
  }
  const maximumDisclosedBlocks = 200;
  return wrapOutput('scheduler.calendar.freebusy.read', {
    calendarRefs: evidence.calendarRefs,
    blocks: evidence.blocks.slice(0, maximumDisclosedBlocks),
    snapshots: evidence.snapshots,
    omittedBlockCount: Math.max(
      0,
      evidence.blocks.length - maximumDisclosedBlocks,
    ),
  });
};

const BudgetInputsSchema = z.strictObject({
  spaceId: OpaqueReferenceSchema,
  transactions: z.array(z.unknown()).max(100_000),
});

const mapBudgetResult = (
  input: FinanceAnalyticsInput,
  trustedInputs: unknown,
): unknown => {
  const trusted = BudgetInputsSchema.parse(trustedInputs);
  const result: MonthlyCategoryTotalsResult = calculateMonthlyCategoryTotals({
    month: input.month,
    timezone: 'America/Toronto',
    spaceId: trusted.spaceId,
    transactions: trusted.transactions,
  });
  return wrapOutput('finance.analytics.calculate', { result });
};

const mapShoppingMutation = (
  mutation: ShoppingWriteInput['mutation'],
): CanonicalShoppingMutation => {
  if (mutation.kind === 'delta' || mutation.kind === 'tombstone') {
    return deepFreeze(mutation);
  }
  const candidate =
    mutation.kind === 'create' ? mutation.item : mutation.replacement;
  const normalized = normalizeShoppingItem({ schemaVersion: 1, ...candidate });
  if (normalized.status !== 'accepted') {
    throw new Error('api-shopping-item-canonicalization-failed');
  }
  return mutation.kind === 'create'
    ? deepFreeze({ kind: 'create' as const, item: normalized.item })
    : deepFreeze({
        kind: 'update' as const,
        itemId: mutation.itemId,
        replacement: normalized.item,
      });
};

const validateOfferFreshness = (input: {
  readonly offers: readonly {
    readonly fetchedAt: string;
    readonly upstreamAt: string;
    readonly expiresAt: string;
    readonly comparisonPermission: string;
  }[];
  readonly observedAt: string;
  readonly maximumAgeMs: number;
}): void => {
  const observedAt = Date.parse(input.observedAt);
  if (
    input.offers.some((offer) => {
      const fetchedAt = Date.parse(offer.fetchedAt);
      const upstreamAt = Date.parse(offer.upstreamAt);
      return (
        offer.comparisonPermission !== 'allowed' ||
        fetchedAt > observedAt ||
        upstreamAt > fetchedAt ||
        Date.parse(offer.expiresAt) <= observedAt ||
        observedAt - fetchedAt > input.maximumAgeMs ||
        observedAt - upstreamAt > input.maximumAgeMs
      );
    })
  ) {
    throw new Error('api-commerce-offer-freshness-invalid');
  }
};

const mapOfferReadResult = (
  input: OffersReadInput,
  rawResult: unknown,
): unknown => {
  const result = asPlainRecord(
    rawResult,
    'api-commerce-offer-service-result-invalid',
  );
  const parsed = specialistCapabilitySchemas[
    'commerce.offers.read'
  ].output.parse({ schemaVersion: 1, ...result });
  validateOfferFreshness({
    offers: parsed.offers,
    observedAt: parsed.observedAt,
    maximumAgeMs: input.maximumAgeMs,
  });
  return deepFreeze(parsed);
};

const mapOfferRefreshResult = (
  input: OffersRefreshInput,
  rawResult: unknown,
): unknown => {
  const parsed = specialistCapabilitySchemas[
    'commerce.offers.refresh'
  ].output.parse({ schemaVersion: 1, result: rawResult });
  if (parsed.result.status === 'ready') {
    validateOfferFreshness({
      offers: parsed.result.offers.map(({ offer }) => offer),
      observedAt: parsed.result.refreshedAt,
      maximumAgeMs: input.maximumAgeMs,
    });
  }
  return deepFreeze(parsed);
};

const SafeRetailerLinkOutResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('accepted'),
    link: z.strictObject({
      url: z.url({ protocol: /^https$/u }),
      rel: z.literal('noopener noreferrer external'),
    }),
  }),
  z.strictObject({
    status: z.literal('rejected'),
    safeError: z.strictObject({
      code: z.literal('retailer-link-unsafe'),
      message: z.literal('The retailer link is unavailable.'),
      retryable: z.literal(false),
    }),
  }),
]);

const mapLinkOutResult = (rawResult: unknown): unknown => {
  const result = SafeRetailerLinkOutResultSchema.parse(rawResult);
  return wrapOutput('commerce.link-out.prepare', {
    result:
      result.status === 'accepted'
        ? { status: 'ready' as const, ...result.link }
        : {
            status: 'unavailable' as const,
            safeError: result.safeError,
          },
  });
};

const assertServiceMap = (
  services: TrustedStandardSpecialistServices,
): void => {
  for (const method of [
    'readCalendarFreeBusy',
    'readTasks',
    'writeTask',
    'resolveTravelTime',
    'readFinanceRecords',
    'writeFinanceRecord',
    'executeStatementImport',
    'loadFinanceBudgetInputs',
    'searchFinanceDocuments',
    'readFinanceDocument',
    'readFinanceMatches',
    'readShoppingItems',
    'writeShoppingItem',
    'readOffers',
    'refreshOffers',
    'prepareLinkOut',
  ] as const) {
    if (typeof services[method] !== 'function') {
      throw new Error(`api-specialist-service-missing:${method}`);
    }
  }
};

const assertFinanceServiceMap = (
  services: TrustedFinanceSpecialistServices,
): void => {
  for (const method of [
    'readFinanceRecords',
    'writeFinanceRecord',
    'executeStatementImport',
    'loadFinanceBudgetInputs',
    'searchFinanceDocuments',
    'readFinanceDocument',
    'readFinanceMatches',
  ] as const) {
    if (typeof services[method] !== 'function') {
      throw new Error(`api-finance-specialist-service-missing:${method}`);
    }
  }
};

export const createFinanceSpecialistCapabilityExecutors = (
  services: TrustedFinanceSpecialistServices,
): Readonly<
  Record<
    | 'finance.records.read'
    | 'finance.records.write'
    | 'finance.statement.import'
    | 'finance.analytics.calculate'
    | 'finance.documents.search'
    | 'finance.documents.read'
    | 'finance.matches.read',
    CapabilityExecutor<unknown, unknown>
  >
> => {
  assertFinanceServiceMap(services);
  return Object.freeze({
    'finance.records.read': async (raw, context) => {
      const input = parseInput('finance.records.read', raw);
      return wrapOutput(
        'finance.records.read',
        asPlainRecord(
          await services.readFinanceRecords(
            deepFreeze({
              recordTypes: input.recordTypes,
              cursor: input.cursor,
              limit: input.limit,
            }),
            context,
          ),
          'api-finance-service-result-invalid',
        ),
      );
    },
    'finance.records.write': async (raw, context) => {
      const { mutation } = parseInput('finance.records.write', raw);
      return wrapOutput(
        'finance.records.write',
        asPlainRecord(
          await services.writeFinanceRecord(deepFreeze(mutation), context),
          'api-finance-service-result-invalid',
        ),
      );
    },
    'finance.statement.import': async (raw, context) => {
      const { request } = parseInput('finance.statement.import', raw);
      return wrapOutput(
        'finance.statement.import',
        asPlainRecord(
          await services.executeStatementImport(deepFreeze(request), context),
          'api-finance-import-service-result-invalid',
        ),
      );
    },
    'finance.analytics.calculate': async (raw, context) => {
      const input = parseInput('finance.analytics.calculate', raw);
      return mapBudgetResult(
        input,
        await services.loadFinanceBudgetInputs(
          deepFreeze({ month: input.month }),
          context,
        ),
      );
    },
    'finance.documents.search': async (raw, context) => {
      const input = parseInput('finance.documents.search', raw);
      return wrapOutput(
        'finance.documents.search',
        asPlainRecord(
          await services.searchFinanceDocuments(
            deepFreeze({
              query: input.query,
              documentTypes: input.documentTypes,
              from: input.from,
              to: input.to,
              limit: input.limit,
            }),
            context,
          ),
          'api-finance-document-search-service-result-invalid',
        ),
      );
    },
    'finance.documents.read': async (raw, context) => {
      const input = parseInput('finance.documents.read', raw);
      return wrapOutput(
        'finance.documents.read',
        asPlainRecord(
          await services.readFinanceDocument(
            deepFreeze({
              documentId: input.documentId,
              evidenceIds: input.evidenceIds,
            }),
            context,
          ),
          'api-finance-document-read-service-result-invalid',
        ),
      );
    },
    'finance.matches.read': async (raw, context) => {
      const input = parseInput('finance.matches.read', raw);
      return wrapOutput(
        'finance.matches.read',
        asPlainRecord(
          await services.readFinanceMatches(
            deepFreeze({
              documentId: input.documentId,
              states: input.states,
              limit: input.limit,
            }),
            context,
          ),
          'api-finance-match-read-service-result-invalid',
        ),
      );
    },
  });
};

export const createStandardSpecialistCapabilityExecutors = (
  services: TrustedStandardSpecialistServices,
): Readonly<
  Record<StandardSpecialistCapabilityId, CapabilityExecutor<unknown, unknown>>
> => {
  assertServiceMap(services);
  return Object.freeze({
    'scheduler.calendar.freebusy.read': async (raw, context) => {
      const { windowStart, windowEnd } = parseInput(
        'scheduler.calendar.freebusy.read',
        raw,
      );
      return boundedCalendarEvidence(
        await services.readCalendarFreeBusy(
          deepFreeze({ windowStart, windowEnd }),
          context,
        ),
      );
    },
    'scheduler.tasks.read': async (raw, context) => {
      const input = parseInput('scheduler.tasks.read', raw);
      const request = {
        status: input.status,
        dueBefore: input.dueBefore,
        cursor: input.cursor,
        limit: input.limit,
      };
      return wrapOutput(
        'scheduler.tasks.read',
        asPlainRecord(
          await services.readTasks(deepFreeze(request), context),
          'api-task-service-result-invalid',
        ),
      );
    },
    'scheduler.tasks.write': async (raw, context) => {
      const { mutation } = parseInput('scheduler.tasks.write', raw);
      return wrapOutput(
        'scheduler.tasks.write',
        asPlainRecord(
          await services.writeTask(deepFreeze(mutation), context),
          'api-task-service-result-invalid',
        ),
      );
    },
    'maps.travel-time.read': async (raw, context) => {
      const input = parseInput('maps.travel-time.read', raw);
      const request = {
        origin: input.origin,
        destination: input.destination,
        mode: input.mode,
        departureAt: input.departureAt,
      };
      return wrapOutput(
        'maps.travel-time.read',
        asPlainRecord(
          await services.resolveTravelTime(deepFreeze(request), context),
          'api-travel-service-result-invalid',
        ),
      );
    },
    'finance.records.read': async (raw, context) => {
      const input = parseInput('finance.records.read', raw);
      const request = {
        recordTypes: input.recordTypes,
        cursor: input.cursor,
        limit: input.limit,
      };
      return wrapOutput(
        'finance.records.read',
        asPlainRecord(
          await services.readFinanceRecords(deepFreeze(request), context),
          'api-finance-service-result-invalid',
        ),
      );
    },
    'finance.records.write': async (raw, context) => {
      const { mutation } = parseInput('finance.records.write', raw);
      return wrapOutput(
        'finance.records.write',
        asPlainRecord(
          await services.writeFinanceRecord(deepFreeze(mutation), context),
          'api-finance-service-result-invalid',
        ),
      );
    },
    'finance.statement.import': async (raw, context) => {
      const { request } = parseInput('finance.statement.import', raw);
      return wrapOutput(
        'finance.statement.import',
        asPlainRecord(
          await services.executeStatementImport(deepFreeze(request), context),
          'api-finance-import-service-result-invalid',
        ),
      );
    },
    'finance.analytics.calculate': async (raw, context) => {
      const input = parseInput('finance.analytics.calculate', raw);
      return mapBudgetResult(
        input,
        await services.loadFinanceBudgetInputs(
          deepFreeze({ month: input.month }),
          context,
        ),
      );
    },
    'finance.documents.search': async (raw, context) => {
      const input = parseInput('finance.documents.search', raw);
      return wrapOutput(
        'finance.documents.search',
        asPlainRecord(
          await services.searchFinanceDocuments(
            deepFreeze({
              query: input.query,
              documentTypes: input.documentTypes,
              from: input.from,
              to: input.to,
              limit: input.limit,
            }),
            context,
          ),
          'api-finance-document-search-service-result-invalid',
        ),
      );
    },
    'finance.documents.read': async (raw, context) => {
      const input = parseInput('finance.documents.read', raw);
      return wrapOutput(
        'finance.documents.read',
        asPlainRecord(
          await services.readFinanceDocument(
            deepFreeze({
              documentId: input.documentId,
              evidenceIds: input.evidenceIds,
            }),
            context,
          ),
          'api-finance-document-read-service-result-invalid',
        ),
      );
    },
    'finance.matches.read': async (raw, context) => {
      const input = parseInput('finance.matches.read', raw);
      return wrapOutput(
        'finance.matches.read',
        asPlainRecord(
          await services.readFinanceMatches(
            deepFreeze({
              documentId: input.documentId,
              states: input.states,
              limit: input.limit,
            }),
            context,
          ),
          'api-finance-match-read-service-result-invalid',
        ),
      );
    },
    'shopping.items.read': async (raw, context) => {
      const input = parseInput('shopping.items.read', raw);
      const request = {
        kinds: input.kinds,
        cursor: input.cursor,
        limit: input.limit,
      };
      return wrapOutput(
        'shopping.items.read',
        asPlainRecord(
          await services.readShoppingItems(deepFreeze(request), context),
          'api-shopping-service-result-invalid',
        ),
      );
    },
    'shopping.items.write': async (raw, context) => {
      const { mutation } = parseInput('shopping.items.write', raw);
      return wrapOutput(
        'shopping.items.write',
        asPlainRecord(
          await services.writeShoppingItem(
            mapShoppingMutation(mutation),
            context,
          ),
          'api-shopping-service-result-invalid',
        ),
      );
    },
    'commerce.offers.read': async (raw, context) => {
      const input = parseInput('commerce.offers.read', raw);
      const request = {
        itemIds: input.itemIds,
        maximumAgeMs: input.maximumAgeMs,
      };
      return mapOfferReadResult(
        input,
        await services.readOffers(deepFreeze(request), context),
      );
    },
    'commerce.offers.refresh': async (raw, context) => {
      const input = parseInput('commerce.offers.refresh', raw);
      const request = {
        query: input.query,
        postalCode: input.postalCode,
        limit: input.limit,
        maximumAgeMs: input.maximumAgeMs,
      };
      return mapOfferRefreshResult(
        input,
        await services.refreshOffers(deepFreeze(request), context),
      );
    },
    'commerce.link-out.prepare': async (raw, context) => {
      const input = parseInput('commerce.link-out.prepare', raw);
      return mapLinkOutResult(
        await services.prepareLinkOut(
          deepFreeze({ offerId: input.offerId }),
          context,
        ),
      );
    },
  });
};

const TrustedFinanceRecordCreateStateSchema = z.strictObject({
  spaceId: OpaqueReferenceSchema,
  ownerUserId: OpaqueReferenceSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

/** Adds every server-owned field before Task6 finance validation. */
export const materializeFinanceRecordCreate = (input: {
  readonly modelArguments: unknown;
  readonly trustedState: unknown;
}): FinanceRecord => {
  const parsed = parseInput('finance.records.write', input.modelArguments);
  if (parsed.mutation.kind !== 'create') {
    throw new Error('api-finance-create-intent-required');
  }
  const trusted = TrustedFinanceRecordCreateStateSchema.parse(
    input.trustedState,
  );
  const draft = parsed.mutation.record;
  const common = {
    schemaVersion: 1 as const,
    id: parsed.mutation.recordId,
    spaceId: trusted.spaceId,
    ownerUserId: trusted.ownerUserId,
    createdAt: trusted.createdAt,
    updatedAt: trusted.updatedAt,
  };
  let candidate: unknown;
  switch (draft.recordType) {
    case 'account':
      candidate = { ...common, ...draft, currency: 'CAD', source: 'manual' };
      break;
    case 'transaction':
      candidate = {
        ...common,
        recordType: draft.recordType,
        accountId: draft.accountId,
        categoryId: draft.categoryId,
        postedOn: draft.postedOn,
        description: draft.description,
        currency: 'CAD',
        originalAmountCadMinor: draft.amountCadMinor,
        effectiveAmountCadMinor: draft.amountCadMinor,
        adjustments: [],
        reversal: null,
        appliedOperationIds: [],
        source: { kind: 'manual' },
        annotation: null,
        revision: 0,
      };
      break;
    case 'category':
      candidate = { ...common, ...draft };
      break;
    case 'budget':
      candidate = { ...common, ...draft, currency: 'CAD', revision: 0 };
      break;
    case 'bill':
    case 'subscription':
    case 'goal':
      candidate = { ...common, ...draft, currency: 'CAD' };
      break;
  }
  const validated = validateFinanceRecordCreate(candidate);
  if (validated.status !== 'accepted') {
    throw new Error('api-finance-canonical-record-invalid');
  }
  return validated.record;
};

const TrustedFinanceLedgerStateSchema = z.strictObject({
  transaction: z.unknown(),
  operationId: UuidSchema,
  updatedAt: IsoDateTimeSchema,
});

/** Loads the authoritative transaction outside model input and derives operation identity server-side. */
export const materializeFinanceLedgerOperation = (input: {
  readonly modelArguments: unknown;
  readonly trustedState: unknown;
}): FinanceLedgerApplicationResult => {
  const parsed = parseInput('finance.records.write', input.modelArguments);
  if (parsed.mutation.kind !== 'adjust' && parsed.mutation.kind !== 'reverse') {
    throw new Error('api-finance-ledger-intent-required');
  }
  const trusted = TrustedFinanceLedgerStateSchema.parse(input.trustedState);
  const validated = validateFinanceRecord(trusted.transaction);
  if (
    validated.status !== 'accepted' ||
    validated.record.recordType !== 'transaction'
  ) {
    throw new Error('api-finance-trusted-state-invalid');
  }
  const transaction: FinanceTransactionRecord = validated.record;
  if (transaction.id !== parsed.mutation.transactionId) {
    throw new Error('api-finance-trusted-state-mismatch');
  }
  return applyTransactionLedgerOperation({
    transaction,
    updatedAt: trusted.updatedAt,
    operation:
      parsed.mutation.kind === 'adjust'
        ? {
            kind: 'adjustment',
            operationId: trusted.operationId,
            amountCadMinor: parsed.mutation.amountCadMinor,
            reason: parsed.mutation.reason,
          }
        : {
            kind: 'reversal',
            operationId: trusted.operationId,
            reason: parsed.mutation.reason,
          },
  });
};

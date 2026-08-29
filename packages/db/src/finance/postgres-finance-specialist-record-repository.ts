import {
  IdempotencyKeySchema,
  OpaqueReferenceSchema,
  Sha256Schema,
  UuidSchema,
  deepFreeze,
} from '@emdo/contracts';
import {
  applyTransactionLedgerOperation,
  validateFinanceRecord,
  type FinanceBudgetRecord,
  type FinanceRecord,
  type FinanceTransactionRecord,
} from '@emdo/domains/finance';
import { z } from 'zod';

import {
  DurableRepositoryError,
  beginDurableTransaction,
  lockDurableScope,
  type DurableRepositoryPrincipal,
} from '../durable/scoped-transaction.js';
import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';

const FinanceRecordTypeSchema = z.enum([
  'account',
  'transaction',
  'category',
  'budget',
  'bill',
  'subscription',
  'goal',
]);
const FinanceEntityTypeSchema = z.enum([
  'finance.account',
  'finance.transaction',
  'finance.category',
  'finance.budget',
  'finance.bill',
  'finance.subscription',
  'finance.goal',
]);
const FinanceWriteOperationSchema = z.enum([
  'manual-transaction-create',
  'transaction-nondestructive-patch',
  'monthly-category-budget-create',
  'monthly-category-budget-update',
  'finance-transaction-adjustment',
  'finance-transaction-reversal',
]);
const SyntheticStagingFinanceAccountId = 'synthetic-finance-account-v1';
const SyntheticStagingFinanceAccountTimestamp = '2026-01-01T00:00:00.000Z';
const SyntheticStagingFinanceAccountAuditEventType =
  'finance.synthetic-staging-account-provisioned';
const MonthSchema = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u);
const AbortSignalSchema = z.custom<AbortSignal>(
  (value) =>
    value !== null &&
    typeof value === 'object' &&
    typeof (value as AbortSignal).aborted === 'boolean',
);

const ScopeSchema = z.strictObject({
  requestId: UuidSchema,
  runId: UuidSchema,
  userId: UuidSchema,
  householdId: UuidSchema,
  sessionId: UuidSchema,
  privateSpaceId: UuidSchema,
  spaceAccessGrantId: UuidSchema,
  collectionAuthorizationScopeFingerprint: Sha256Schema,
  disclosureGrantId: UuidSchema.optional(),
  abortSignal: AbortSignalSchema,
});
const SyntheticStagingScopeSchema = ScopeSchema.omit({
  runId: true,
  disclosureGrantId: true,
});
const ProvisionSyntheticStagingAccountInputSchema = z.strictObject({
  scope: SyntheticStagingScopeSchema,
  idempotencyKey: IdempotencyKeySchema,
});
const AuditSchema = z.strictObject({
  eventType: z.literal('finance.agent.safe-write'),
  operation: FinanceWriteOperationSchema,
  canonicalHash: Sha256Schema,
  requestId: UuidSchema,
  runId: UuidSchema,
});
const WriteCommandSchema = z.strictObject({
  scope: ScopeSchema,
  idempotencyKey: IdempotencyKeySchema,
  canonicalHash: Sha256Schema,
  audit: AuditSchema,
});
const ListInputSchema = z.strictObject({
  scope: ScopeSchema,
  recordTypes: z.array(FinanceRecordTypeSchema).max(7).optional(),
  cursor: UuidSchema.optional(),
  limit: z.number().int().min(1).max(100),
});
const GetRecordInputSchema = z.strictObject({
  scope: ScopeSchema,
  recordId: OpaqueReferenceSchema,
});
const GetBudgetInputSchema = z.strictObject({
  scope: ScopeSchema,
  month: MonthSchema,
});
const ListBudgetTransactionsInputSchema = z.strictObject({
  scope: ScopeSchema,
  month: MonthSchema,
  reviewedCommittedEvidenceOnly: z.literal(true),
});
const ManualCreateInputSchema = WriteCommandSchema.extend({
  record: z.unknown(),
});
const TransactionPatchInputSchema = WriteCommandSchema.extend({
  current: z.unknown(),
  record: z.unknown(),
  expectedRevision: z.number().int().safe().nonnegative(),
});
const TransactionAdjustmentInputSchema = TransactionPatchInputSchema.extend({
  operationId: UuidSchema,
  amountCadMinor: z
    .number()
    .int()
    .safe()
    .refine((value) => value !== 0),
  reason: z.string().trim().min(3).max(1_000),
});
const TransactionReversalInputSchema = TransactionPatchInputSchema.extend({
  operationId: UuidSchema,
  reason: z.string().trim().min(3).max(1_000),
});
const BudgetCreateInputSchema = WriteCommandSchema.extend({
  record: z.unknown(),
});
const BudgetUpdateInputSchema = WriteCommandSchema.extend({
  current: z.unknown(),
  record: z.unknown(),
  expectedRevision: z.number().int().safe().nonnegative(),
});

const AuthorityRowSchema = z.strictObject({
  grantId: UuidSchema,
  userId: UuidSchema,
  sessionId: UuidSchema,
  requestId: UuidSchema,
  householdId: UuidSchema,
  privateSpaceId: UuidSchema,
  writableSpaceIds: z.array(UuidSchema).min(1).max(256),
});
const EntityRowSchema = z.strictObject({
  entityId: OpaqueReferenceSchema,
  entityType: FinanceEntityTypeSchema,
  payload: z.unknown(),
  revision: z.number().int().safe().positive(),
});
const ListEntityRowSchema = EntityRowSchema.extend({ rowId: UuidSchema });
const ReceiptRowSchema = z.strictObject({
  operation: FinanceWriteOperationSchema,
  idempotencyKey: IdempotencyKeySchema,
  canonicalHash: Sha256Schema,
  scopeFingerprint: Sha256Schema,
  originSessionId: UuidSchema,
  originRequestId: UuidSchema,
  originRunId: UuidSchema,
  originSpaceAccessGrantId: UuidSchema,
  entityType: FinanceEntityTypeSchema,
  entityId: OpaqueReferenceSchema,
  resultingRevision: z.number().int().safe().positive(),
  auditEventId: UuidSchema,
});
const AuditRowSchema = z.strictObject({ auditEventId: UuidSchema });
const SyntheticStagingAccountAuditPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  entityId: z.literal(SyntheticStagingFinanceAccountId),
  idempotencyKey: IdempotencyKeySchema,
  scopeFingerprint: Sha256Schema,
  resultingRevision: z.literal(1),
});
const SyntheticStagingAccountAuditRowSchema = z.strictObject({
  auditEventId: UuidSchema,
  eventType: z.literal(SyntheticStagingFinanceAccountAuditEventType),
  payload: SyntheticStagingAccountAuditPayloadSchema,
});
const ReadinessRowSchema = z.strictObject({ ready: z.boolean() });

type FinanceRecordType = z.output<typeof FinanceRecordTypeSchema>;
type FinanceEntityType = z.output<typeof FinanceEntityTypeSchema>;
type FinanceWriteOperation = z.output<typeof FinanceWriteOperationSchema>;
type FinanceScope = z.output<typeof ScopeSchema>;
type SyntheticStagingScope = z.output<typeof SyntheticStagingScopeSchema>;
type ScopedFinanceScope = FinanceScope | SyntheticStagingScope;
type ParsedEntityRow = z.output<typeof EntityRowSchema>;
type FinanceAccountRecord = Extract<
  FinanceRecord,
  { readonly recordType: 'account' }
>;

const entityTypeByRecordType: Readonly<
  Record<FinanceRecordType, FinanceEntityType>
> = Object.freeze({
  account: 'finance.account',
  transaction: 'finance.transaction',
  category: 'finance.category',
  budget: 'finance.budget',
  bill: 'finance.bill',
  subscription: 'finance.subscription',
  goal: 'finance.goal',
});

const recordTypeByEntityType: Readonly<
  Record<FinanceEntityType, FinanceRecordType>
> = Object.freeze({
  'finance.account': 'account',
  'finance.transaction': 'transaction',
  'finance.category': 'category',
  'finance.budget': 'budget',
  'finance.bill': 'bill',
  'finance.subscription': 'subscription',
  'finance.goal': 'goal',
});

export interface FinanceSpecialistRecordRepositoryScope {
  readonly requestId: string;
  readonly runId: string;
  readonly userId: string;
  readonly householdId: string;
  readonly sessionId: string;
  readonly privateSpaceId: string;
  readonly spaceAccessGrantId: string;
  readonly collectionAuthorizationScopeFingerprint: string;
  readonly disclosureGrantId?: string;
  readonly abortSignal: AbortSignal;
}

export interface FinanceSpecialistRecordWriteAudit {
  readonly eventType: 'finance.agent.safe-write';
  readonly operation: FinanceWriteOperation;
  readonly canonicalHash: string;
  readonly requestId: string;
  readonly runId: string;
}

export interface FinanceSpecialistRecordWriteCommand {
  readonly scope: FinanceSpecialistRecordRepositoryScope;
  readonly idempotencyKey: string;
  readonly canonicalHash: string;
  readonly audit: FinanceSpecialistRecordWriteAudit;
}

export interface FinanceSpecialistRecordWriteReceipt {
  readonly status: 'applied' | 'duplicate';
  readonly record: FinanceRecord;
  readonly auditEventId: string;
}

export class FinanceSpecialistRecordRepositoryError extends Error {
  constructor(
    readonly code:
      | 'authorization-revoked'
      | 'conflict'
      | 'database-unavailable'
      | 'invalid-input'
      | 'invalid-result'
      | 'record-not-found',
    message: string,
  ) {
    super(message);
    this.name = 'FinanceSpecialistRecordRepositoryError';
  }
}

const parseInput = <Output>(schema: z.ZodType<Output>, input: unknown) => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new FinanceSpecialistRecordRepositoryError(
      'invalid-input',
      'Finance specialist record input is malformed',
    );
  }
  return parsed.data;
};

const parseResult = <Output>(
  schema: z.ZodType<Output>,
  input: unknown,
  label: string,
): Output => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new FinanceSpecialistRecordRepositoryError(
      'invalid-result',
      `Finance specialist record ${label} was malformed`,
    );
  }
  return parsed.data;
};

const singleRow = (
  rows: readonly Record<string, unknown>[],
  label: string,
): Record<string, unknown> | undefined => {
  if (rows.length > 1) {
    throw new FinanceSpecialistRecordRepositoryError(
      'invalid-result',
      `Finance specialist record ${label} was not unique`,
    );
  }
  return rows[0];
};

const rollbackQuietly = async (client: DatabaseClient) => {
  try {
    await client.query('rollback');
  } catch {
    // The original transaction failure remains authoritative.
  }
};

const databaseCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

const mapError = (error: unknown): never => {
  if (error instanceof FinanceSpecialistRecordRepositoryError) throw error;
  if (error instanceof DurableRepositoryError) {
    throw new FinanceSpecialistRecordRepositoryError(
      error.code === 'authorization-revoked'
        ? 'authorization-revoked'
        : error.code === 'invalid-input'
          ? 'invalid-input'
          : 'database-unavailable',
      'The Finance specialist record scope could not be verified',
    );
  }
  if (databaseCode(error) === '23505') {
    throw new FinanceSpecialistRecordRepositoryError(
      'conflict',
      'The Finance specialist record conflicts with a durable command',
    );
  }
  if (['22001', '22023', '23514'].includes(databaseCode(error) ?? '')) {
    throw new FinanceSpecialistRecordRepositoryError(
      'invalid-input',
      'The Finance specialist record violates a bounded persistence rule',
    );
  }
  throw new FinanceSpecialistRecordRepositoryError(
    'database-unavailable',
    'The Finance specialist record operation could not be verified',
  );
};

const durablePrincipalFor = (
  scope: ScopedFinanceScope,
): Readonly<DurableRepositoryPrincipal> =>
  deepFreeze({
    userId: scope.userId,
    sessionId: scope.sessionId,
    requestId: scope.requestId,
    householdId: scope.householdId,
  });

const scopeValues = (scope: ScopedFinanceScope) =>
  [scope.householdId, scope.privateSpaceId, scope.userId] as const;

const assertNotAborted = (scope: ScopedFinanceScope) => {
  if (scope.abortSignal.aborted) {
    throw new FinanceSpecialistRecordRepositoryError(
      'authorization-revoked',
      'The Finance specialist request was cancelled',
    );
  }
};

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(',')}}`;
};

const sameRecord = (left: FinanceRecord, right: FinanceRecord): boolean =>
  stableJson(left) === stableJson(right);

const entityTypeFor = (record: FinanceRecord): FinanceEntityType =>
  entityTypeByRecordType[record.recordType];

const asRecordObject = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const financeRecordFromEntity = (
  row: ParsedEntityRow,
  scope: ScopedFinanceScope,
): FinanceRecord => {
  const raw = asRecordObject(row.payload);
  const payload =
    row.entityType === 'finance.transaction' &&
    raw !== undefined &&
    !Object.hasOwn(raw, 'revision')
      ? { ...raw, revision: row.revision }
      : row.payload;
  const validated = validateFinanceRecord(payload);
  if (
    validated.status !== 'accepted' ||
    validated.record.recordType !== recordTypeByEntityType[row.entityType] ||
    validated.record.id !== row.entityId ||
    validated.record.spaceId !== scope.privateSpaceId ||
    validated.record.ownerUserId !== scope.userId
  ) {
    throw new FinanceSpecialistRecordRepositoryError(
      'invalid-result',
      'The canonical Finance record was malformed or outside the owner scope',
    );
  }
  return validated.record;
};

const asTransaction = (
  input: unknown,
  label: string,
): FinanceTransactionRecord => {
  const validated = validateFinanceRecord(input);
  if (
    validated.status !== 'accepted' ||
    validated.record.recordType !== 'transaction'
  ) {
    throw new FinanceSpecialistRecordRepositoryError(
      'invalid-input',
      `The Finance ${label} transaction is invalid`,
    );
  }
  return validated.record;
};

const asBudget = (input: unknown, label: string): FinanceBudgetRecord => {
  const validated = validateFinanceRecord(input);
  if (
    validated.status !== 'accepted' ||
    validated.record.recordType !== 'budget'
  ) {
    throw new FinanceSpecialistRecordRepositoryError(
      'invalid-input',
      `The Finance ${label} budget is invalid`,
    );
  }
  return validated.record;
};

const assertOwned = (record: FinanceRecord, scope: FinanceScope) => {
  if (
    record.spaceId !== scope.privateSpaceId ||
    record.ownerUserId !== scope.userId
  ) {
    throw new FinanceSpecialistRecordRepositoryError(
      'invalid-input',
      'The Finance record is outside the authenticated private scope',
    );
  }
};

const assertCommandBinding = (
  command: z.output<typeof WriteCommandSchema>,
  operation: FinanceWriteOperation,
) => {
  assertNotAborted(command.scope);
  if (
    command.audit.operation !== operation ||
    command.audit.canonicalHash !== command.canonicalHash ||
    command.audit.requestId !== command.scope.requestId ||
    command.audit.runId !== command.scope.runId
  ) {
    throw new FinanceSpecialistRecordRepositoryError(
      'invalid-input',
      'The Finance specialist command audit binding is invalid',
    );
  }
};

const transactionPatchInvariant = (record: FinanceTransactionRecord) => ({
  schemaVersion: record.schemaVersion,
  id: record.id,
  spaceId: record.spaceId,
  ownerUserId: record.ownerUserId,
  createdAt: record.createdAt,
  recordType: record.recordType,
  accountId: record.accountId,
  postedOn: record.postedOn,
  currency: record.currency,
  originalAmountCadMinor: record.originalAmountCadMinor,
  effectiveAmountCadMinor: record.effectiveAmountCadMinor,
  adjustments: record.adjustments,
  reversal: record.reversal,
  appliedOperationIds: record.appliedOperationIds,
  source: record.source,
});

const assertManualCreate = (
  record: FinanceTransactionRecord,
  scope: FinanceScope,
) => {
  assertOwned(record, scope);
  if (
    record.source.kind !== 'manual' ||
    record.revision !== 0 ||
    record.originalAmountCadMinor === 0 ||
    record.adjustments.length !== 0 ||
    record.reversal !== null ||
    record.appliedOperationIds.length !== 0
  ) {
    throw new FinanceSpecialistRecordRepositoryError(
      'invalid-input',
      'Only an initial, manual Finance transaction may be created here',
    );
  }
};

const assertTransactionPatch = (input: {
  readonly current: FinanceTransactionRecord;
  readonly record: FinanceTransactionRecord;
  readonly expectedRevision: number;
  readonly scope: FinanceScope;
}) => {
  const { current, record, expectedRevision, scope } = input;
  assertOwned(current, scope);
  assertOwned(record, scope);
  if (
    current.revision === undefined ||
    record.revision === undefined ||
    current.revision !== expectedRevision ||
    record.revision !== current.revision + 1 ||
    stableJson(transactionPatchInvariant(current)) !==
      stableJson(transactionPatchInvariant(record)) ||
    Date.parse(record.updatedAt) < Date.parse(current.updatedAt) ||
    (current.source.kind !== 'manual' &&
      current.description !== record.description)
  ) {
    throw new FinanceSpecialistRecordRepositoryError(
      'conflict',
      'The Finance transaction patch is not an exact non-destructive revision',
    );
  }
};

const assertTransactionLedgerMutation = (input: {
  readonly current: FinanceTransactionRecord;
  readonly record: FinanceTransactionRecord;
  readonly expectedRevision: number;
  readonly scope: FinanceScope;
  readonly operation:
    | Readonly<{
        readonly operationId: string;
        readonly kind: 'adjustment';
        readonly amountCadMinor: number;
        readonly reason: string;
      }>
    | Readonly<{
        readonly operationId: string;
        readonly kind: 'reversal';
        readonly reason: string;
      }>;
}) => {
  const { current, record, expectedRevision, scope, operation } = input;
  assertOwned(current, scope);
  assertOwned(record, scope);
  if (
    current.revision === undefined ||
    current.revision !== expectedRevision ||
    record.revision !== current.revision + 1 ||
    Date.parse(record.updatedAt) < Date.parse(current.updatedAt)
  ) {
    throw new FinanceSpecialistRecordRepositoryError(
      'conflict',
      'The Finance transaction changed before this ledger action could be applied',
    );
  }
  const applied = applyTransactionLedgerOperation({
    transaction: current,
    operation,
    updatedAt: record.updatedAt,
  });
  if (applied.status !== 'applied' || applied.transaction === null) {
    throw new FinanceSpecialistRecordRepositoryError(
      'conflict',
      'The Finance transaction ledger action is not applicable',
    );
  }
  const expected = validateFinanceRecord({
    ...applied.transaction,
    revision: current.revision + 1,
    updatedAt: record.updatedAt,
  });
  if (
    expected.status !== 'accepted' ||
    expected.record.recordType !== 'transaction' ||
    !sameRecord(expected.record, record)
  ) {
    throw new FinanceSpecialistRecordRepositoryError(
      'invalid-input',
      'The Finance transaction ledger action is not an exact canonical revision',
    );
  }
};

const assertBudgetCreate = (
  record: FinanceBudgetRecord,
  scope: FinanceScope,
) => {
  assertOwned(record, scope);
  if (record.revision !== 0) {
    throw new FinanceSpecialistRecordRepositoryError(
      'invalid-input',
      'A monthly Finance budget must begin at revision zero',
    );
  }
};

const assertBudgetUpdate = (input: {
  readonly current: FinanceBudgetRecord;
  readonly record: FinanceBudgetRecord;
  readonly expectedRevision: number;
  readonly scope: FinanceScope;
}) => {
  const { current, record, expectedRevision, scope } = input;
  assertOwned(current, scope);
  assertOwned(record, scope);
  if (
    current.revision !== expectedRevision ||
    record.revision !== current.revision + 1 ||
    current.id !== record.id ||
    current.month !== record.month ||
    current.createdAt !== record.createdAt ||
    current.currency !== record.currency ||
    Date.parse(record.updatedAt) < Date.parse(current.updatedAt)
  ) {
    throw new FinanceSpecialistRecordRepositoryError(
      'conflict',
      'The Finance budget patch is not an exact monthly revision',
    );
  }
  const currentAllocations = new Map(
    current.allocations.map((allocation) => [
      allocation.categoryId,
      allocation.amountCadMinor,
    ]),
  );
  const nextAllocations = new Map(
    record.allocations.map((allocation) => [
      allocation.categoryId,
      allocation.amountCadMinor,
    ]),
  );
  const changed = new Set<string>();
  for (const [categoryId, amount] of currentAllocations) {
    if (nextAllocations.get(categoryId) !== amount) changed.add(categoryId);
  }
  for (const categoryId of nextAllocations.keys()) {
    if (!currentAllocations.has(categoryId)) changed.add(categoryId);
  }
  if (changed.size !== 1 || !nextAllocations.has([...changed][0]!)) {
    throw new FinanceSpecialistRecordRepositoryError(
      'invalid-input',
      'A Finance budget update must set exactly one monthly category amount',
    );
  }
};

const recordActorIntent = 'Finance specialist safe write';
const syntheticStagingAccountActorIntent =
  'Provision the deterministic Finance synthetic-staging account';

const syntheticStagingAccountFor = (
  scope: SyntheticStagingScope,
): FinanceAccountRecord => {
  const validated = validateFinanceRecord({
    schemaVersion: 1,
    id: SyntheticStagingFinanceAccountId,
    spaceId: scope.privateSpaceId,
    ownerUserId: scope.userId,
    createdAt: SyntheticStagingFinanceAccountTimestamp,
    updatedAt: SyntheticStagingFinanceAccountTimestamp,
    recordType: 'account',
    name: 'Synthetic staging chequing',
    accountKind: 'chequing',
    currency: 'CAD',
    openingBalanceCadMinor: 0,
    active: true,
    source: 'manual',
  });
  if (
    validated.status !== 'accepted' ||
    validated.record.recordType !== 'account' ||
    validated.record.id !== SyntheticStagingFinanceAccountId ||
    validated.record.spaceId !== scope.privateSpaceId ||
    validated.record.ownerUserId !== scope.userId ||
    validated.record.createdAt !== SyntheticStagingFinanceAccountTimestamp ||
    validated.record.updatedAt !== SyntheticStagingFinanceAccountTimestamp ||
    validated.record.name !== 'Synthetic staging chequing' ||
    validated.record.accountKind !== 'chequing' ||
    validated.record.currency !== 'CAD' ||
    validated.record.openingBalanceCadMinor !== 0 ||
    validated.record.active !== true ||
    validated.record.source !== 'manual'
  ) {
    throw new FinanceSpecialistRecordRepositoryError(
      'invalid-result',
      'The fixed Finance synthetic-staging account is invalid',
    );
  }
  return validated.record;
};

// Replay identity is session-independent. The audit row itself preserves the
// original session and request, while every replay revalidates current scope.
const syntheticStagingAccountAuditPayload = (input: {
  readonly idempotencyKey: string;
  readonly scope: SyntheticStagingScope;
}): z.output<typeof SyntheticStagingAccountAuditPayloadSchema> =>
  deepFreeze({
    schemaVersion: 1,
    entityId: SyntheticStagingFinanceAccountId,
    idempotencyKey: input.idempotencyKey,
    scopeFingerprint: input.scope.collectionAuthorizationScopeFingerprint,
    resultingRevision: 1,
  });

const syntheticStagingAccountReplayBinding = (
  payload: z.output<typeof SyntheticStagingAccountAuditPayloadSchema>,
) =>
  deepFreeze({
    schemaVersion: payload.schemaVersion,
    entityId: payload.entityId,
    idempotencyKey: payload.idempotencyKey,
    resultingRevision: payload.resultingRevision,
  });

const receiptPayload = (input: {
  readonly operation: FinanceWriteOperation;
  readonly canonicalHash: string;
  readonly entityType: FinanceEntityType;
  readonly entityId: string;
  readonly resultingRevision: number;
}) =>
  deepFreeze({
    schemaVersion: 1,
    operation: input.operation,
    canonicalHash: input.canonicalHash,
    entityType: input.entityType,
    entityId: input.entityId,
    resultingRevision: input.resultingRevision,
  });

const monthOf = (transaction: FinanceTransactionRecord): string =>
  transaction.postedOn.slice(0, 7);

/**
 * Direct, least-privilege PostgreSQL persistence for the Finance specialist.
 * It receives a server-bound scope and never exposes SQL, provider handles,
 * credentials, raw documents, or model inputs through its public surface.
 */
export class PostgresFinanceSpecialistRecordRepository {
  constructor(private readonly pool: DatabasePool) {}

  async checkInfrastructureReady(): Promise<boolean> {
    let client: DatabaseClient | undefined;
    try {
      client = await this.pool.connect();
      const row = singleRow(
        (
          await client.query(
            'select emdo.finance_specialist_records_ready() as "ready"',
          )
        ).rows,
        'readiness',
      );
      return (
        row !== undefined &&
        parseResult(ReadinessRowSchema, row, 'readiness').ready
      );
    } catch {
      return false;
    } finally {
      client?.release();
    }
  }

  async checkReady(input: unknown): Promise<boolean> {
    const scope = parseInput(ScopeSchema, input);
    try {
      return await this.withScopedTransaction(scope, async (client) => {
        const row = singleRow(
          (
            await client.query(
              'select emdo.finance_specialist_records_ready() as "ready"',
            )
          ).rows,
          'readiness',
        );
        return (
          row !== undefined &&
          parseResult(ReadinessRowSchema, row, 'readiness').ready
        );
      });
    } catch {
      return false;
    }
  }

  /**
   * Provisions the sole deterministic Finance account used by synthetic
   * staging. The account payload is entirely server-derived; callers can
   * supply only a current private scope and an idempotency key.
   */
  async provisionSyntheticStagingAccount(
    input: unknown,
  ): Promise<FinanceSpecialistRecordWriteReceipt> {
    const parsed = parseInput(
      ProvisionSyntheticStagingAccountInputSchema,
      input,
    );
    assertNotAborted(parsed.scope);
    const expected = syntheticStagingAccountFor(parsed.scope);

    return this.withScopedTransaction(parsed.scope, async (client) => {
      await this.lockSyntheticStagingAccount(client, parsed.scope);
      const existing = await this.findSyntheticStagingAccountForUpdate(
        client,
        parsed.scope,
      );
      const audit = await this.findSyntheticStagingAccountAudit(
        client,
        parsed.scope,
      );
      if (existing !== undefined || audit !== undefined) {
        return this.replaySyntheticStagingAccountIfExact({
          scope: parsed.scope,
          idempotencyKey: parsed.idempotencyKey,
          expected,
          entity: existing,
          audit,
        });
      }

      const inserted = await this.insertSyntheticStagingAccount(
        client,
        parsed.scope,
        expected,
      );
      if (inserted === undefined) {
        return this.replaySyntheticStagingAccountIfExact({
          scope: parsed.scope,
          idempotencyKey: parsed.idempotencyKey,
          expected,
          entity: await this.findSyntheticStagingAccountForUpdate(
            client,
            parsed.scope,
          ),
          audit: await this.findSyntheticStagingAccountAudit(
            client,
            parsed.scope,
          ),
        });
      }

      const stored = financeRecordFromEntity(inserted, parsed.scope);
      if (
        inserted.entityType !== 'finance.account' ||
        inserted.entityId !== SyntheticStagingFinanceAccountId ||
        inserted.revision !== 1 ||
        stored.recordType !== 'account' ||
        !sameRecord(stored, expected)
      ) {
        throw new FinanceSpecialistRecordRepositoryError(
          'invalid-result',
          'The stored Finance synthetic-staging account was not canonical',
        );
      }
      const auditEventId = await this.appendSyntheticStagingAccountAudit({
        client,
        scope: parsed.scope,
        idempotencyKey: parsed.idempotencyKey,
      });
      return deepFreeze({
        status: 'applied' as const,
        record: stored,
        auditEventId,
      });
    });
  }

  async list(input: unknown): Promise<
    Readonly<{
      readonly records: readonly FinanceRecord[];
      readonly nextCursor: string | null;
    }>
  > {
    const parsed = parseInput(ListInputSchema, input);
    return this.withScopedTransaction(parsed.scope, async (client) => {
      const entityTypes = [
        ...new Set(
          (parsed.recordTypes ?? [...FinanceRecordTypeSchema.options]).map(
            (recordType) => entityTypeByRecordType[recordType],
          ),
        ),
      ];
      const rows = (
        await client.query(
          `select entity.id::text as "rowId", entity.entity_id as "entityId",
                  entity.entity_type as "entityType", entity.payload as "payload",
                  entity.revision as "revision"
             from emdo.sync_entities as entity
            where entity.household_id = $1::uuid
              and entity.space_id = $2::uuid
              and entity.original_owner_user_id = $3::uuid
              and entity.tombstoned_at is null
              and entity.entity_type = any($4::text[])
              and ($5::uuid is null or entity.id > $5::uuid)
            order by entity.id asc
            limit $6::integer`,
          [
            ...scopeValues(parsed.scope),
            entityTypes,
            parsed.cursor ?? null,
            parsed.limit + 1,
          ],
        )
      ).rows.map((row) => parseResult(ListEntityRowSchema, row, 'list row'));
      const page = rows.slice(0, parsed.limit);
      const hasNext = rows.length > parsed.limit;
      return deepFreeze({
        records: page.map((row) => financeRecordFromEntity(row, parsed.scope)),
        nextCursor: hasNext ? (page.at(-1)?.rowId ?? null) : null,
      });
    });
  }

  async getOwnedRecord(input: unknown): Promise<FinanceRecord | undefined> {
    const parsed = parseInput(GetRecordInputSchema, input);
    return this.withScopedTransaction(parsed.scope, async (client) => {
      const row = await this.findCurrentEntity(
        client,
        parsed.scope,
        parsed.recordId,
      );
      return row === undefined
        ? undefined
        : financeRecordFromEntity(row, parsed.scope);
    });
  }

  async getOwnedBudgetForMonth(
    input: unknown,
  ): Promise<FinanceBudgetRecord | undefined> {
    const parsed = parseInput(GetBudgetInputSchema, input);
    return this.withScopedTransaction(parsed.scope, async (client) => {
      const rows = (
        await client.query(
          `select entity.entity_id as "entityId", entity.entity_type as "entityType",
                  entity.payload as "payload", entity.revision as "revision"
             from emdo.sync_entities as entity
            where entity.household_id = $1::uuid
              and entity.space_id = $2::uuid
              and entity.original_owner_user_id = $3::uuid
              and entity.entity_type = 'finance.budget'
              and entity.tombstoned_at is null
            order by entity.id asc
            limit 1001`,
          scopeValues(parsed.scope),
        )
      ).rows.map((row) => parseResult(EntityRowSchema, row, 'budget row'));
      if (rows.length > 1000) {
        throw new FinanceSpecialistRecordRepositoryError(
          'invalid-result',
          'The Finance budget scope exceeded its bounded record limit',
        );
      }
      const budgets = rows.map((row) =>
        financeRecordFromEntity(row, parsed.scope),
      );
      const matches = budgets.filter(
        (record): record is FinanceBudgetRecord =>
          record.recordType === 'budget' && record.month === parsed.month,
      );
      if (matches.length > 1) {
        throw new FinanceSpecialistRecordRepositoryError(
          'invalid-result',
          'More than one canonical Finance budget exists for the month',
        );
      }
      return matches[0];
    });
  }

  async listBudgetTransactions(
    input: unknown,
  ): Promise<readonly FinanceTransactionRecord[]> {
    const parsed = parseInput(ListBudgetTransactionsInputSchema, input);
    return this.withScopedTransaction(parsed.scope, async (client) => {
      const rows = (
        await client.query(
          `select entity.entity_id as "entityId", entity.entity_type as "entityType",
                  entity.payload as "payload", entity.revision as "revision"
             from emdo.sync_entities as entity
            where entity.household_id = $1::uuid
              and entity.space_id = $2::uuid
              and entity.original_owner_user_id = $3::uuid
              and entity.entity_type = 'finance.transaction'
              and entity.tombstoned_at is null
            order by entity.payload ->> 'postedOn' asc, entity.id asc
            limit 100001`,
          scopeValues(parsed.scope),
        )
      ).rows.map((row) => parseResult(EntityRowSchema, row, 'transaction row'));
      if (rows.length > 100_000) {
        throw new FinanceSpecialistRecordRepositoryError(
          'invalid-result',
          'The Finance transaction scope exceeded its bounded record limit',
        );
      }
      return deepFreeze(
        rows
          .map((row) => financeRecordFromEntity(row, parsed.scope))
          .filter(
            (record): record is FinanceTransactionRecord =>
              record.recordType === 'transaction' &&
              monthOf(record) === parsed.month,
          ),
      );
    });
  }

  async createManualTransaction(
    input: unknown,
  ): Promise<FinanceSpecialistRecordWriteReceipt> {
    const parsed = parseInput(ManualCreateInputSchema, input);
    assertCommandBinding(parsed, 'manual-transaction-create');
    const record = asTransaction(parsed.record, 'manual create');
    assertManualCreate(record, parsed.scope);

    return this.withScopedTransaction(parsed.scope, async (client) => {
      const replay = await this.replayIfExact({
        client,
        command: parsed,
        operation: 'manual-transaction-create',
        record,
      });
      if (replay !== undefined) return replay;
      await this.assertTransactionReferences(client, parsed.scope, record);
      const entity = await this.insertEntity(client, parsed.scope, record);
      return this.persistAppliedReceipt({
        client,
        command: parsed,
        operation: 'manual-transaction-create',
        expected: record,
        entity,
      });
    });
  }

  async patchOwnedTransaction(
    input: unknown,
  ): Promise<FinanceSpecialistRecordWriteReceipt> {
    const parsed = parseInput(TransactionPatchInputSchema, input);
    assertCommandBinding(parsed, 'transaction-nondestructive-patch');
    const current = asTransaction(parsed.current, 'current');
    const record = asTransaction(parsed.record, 'patch');
    assertTransactionPatch({
      current,
      record,
      expectedRevision: parsed.expectedRevision,
      scope: parsed.scope,
    });

    return this.withScopedTransaction(parsed.scope, async (client) => {
      const replay = await this.replayIfExact({
        client,
        command: parsed,
        operation: 'transaction-nondestructive-patch',
        record,
      });
      if (replay !== undefined) return replay;
      const stored = await this.requireCurrentEntityForUpdate(
        client,
        parsed.scope,
        current.id,
        'finance.transaction',
      );
      const storedRecord = financeRecordFromEntity(stored, parsed.scope);
      if (!sameRecord(storedRecord, current)) {
        throw new FinanceSpecialistRecordRepositoryError(
          'conflict',
          'The Finance transaction changed before this patch could be applied',
        );
      }
      await this.assertTransactionReferences(client, parsed.scope, record);
      const entity = await this.updateEntity(
        client,
        parsed.scope,
        stored,
        record,
      );
      return this.persistAppliedReceipt({
        client,
        command: parsed,
        operation: 'transaction-nondestructive-patch',
        expected: record,
        entity,
      });
    });
  }

  async applyTransactionAdjustment(
    input: unknown,
  ): Promise<FinanceSpecialistRecordWriteReceipt> {
    const parsed = parseInput(TransactionAdjustmentInputSchema, input);
    assertCommandBinding(parsed, 'finance-transaction-adjustment');
    const current = asTransaction(parsed.current, 'current');
    const record = asTransaction(parsed.record, 'adjustment');
    assertTransactionLedgerMutation({
      current,
      record,
      expectedRevision: parsed.expectedRevision,
      scope: parsed.scope,
      operation: {
        operationId: parsed.operationId,
        kind: 'adjustment',
        amountCadMinor: parsed.amountCadMinor,
        reason: parsed.reason,
      },
    });

    return this.withScopedTransaction(parsed.scope, async (client) => {
      const replay = await this.replayIfExact({
        client,
        command: parsed,
        operation: 'finance-transaction-adjustment',
        record,
      });
      if (replay !== undefined) return replay;
      const stored = await this.requireCurrentEntityForUpdate(
        client,
        parsed.scope,
        current.id,
        'finance.transaction',
      );
      const storedRecord = financeRecordFromEntity(stored, parsed.scope);
      if (!sameRecord(storedRecord, current)) {
        throw new FinanceSpecialistRecordRepositoryError(
          'conflict',
          'The Finance transaction changed before this adjustment could be applied',
        );
      }
      await this.assertTransactionReferences(client, parsed.scope, record);
      const entity = await this.updateEntity(
        client,
        parsed.scope,
        stored,
        record,
      );
      return this.persistAppliedReceipt({
        client,
        command: parsed,
        operation: 'finance-transaction-adjustment',
        expected: record,
        entity,
      });
    });
  }

  async applyTransactionReversal(
    input: unknown,
  ): Promise<FinanceSpecialistRecordWriteReceipt> {
    const parsed = parseInput(TransactionReversalInputSchema, input);
    assertCommandBinding(parsed, 'finance-transaction-reversal');
    const current = asTransaction(parsed.current, 'current');
    const record = asTransaction(parsed.record, 'reversal');
    assertTransactionLedgerMutation({
      current,
      record,
      expectedRevision: parsed.expectedRevision,
      scope: parsed.scope,
      operation: {
        operationId: parsed.operationId,
        kind: 'reversal',
        reason: parsed.reason,
      },
    });

    return this.withScopedTransaction(parsed.scope, async (client) => {
      const replay = await this.replayIfExact({
        client,
        command: parsed,
        operation: 'finance-transaction-reversal',
        record,
      });
      if (replay !== undefined) return replay;
      const stored = await this.requireCurrentEntityForUpdate(
        client,
        parsed.scope,
        current.id,
        'finance.transaction',
      );
      const storedRecord = financeRecordFromEntity(stored, parsed.scope);
      if (!sameRecord(storedRecord, current)) {
        throw new FinanceSpecialistRecordRepositoryError(
          'conflict',
          'The Finance transaction changed before this reversal could be applied',
        );
      }
      await this.assertTransactionReferences(client, parsed.scope, record);
      const entity = await this.updateEntity(
        client,
        parsed.scope,
        stored,
        record,
      );
      return this.persistAppliedReceipt({
        client,
        command: parsed,
        operation: 'finance-transaction-reversal',
        expected: record,
        entity,
      });
    });
  }

  async createMonthlyCategoryBudget(
    input: unknown,
  ): Promise<FinanceSpecialistRecordWriteReceipt> {
    const parsed = parseInput(BudgetCreateInputSchema, input);
    assertCommandBinding(parsed, 'monthly-category-budget-create');
    const record = asBudget(parsed.record, 'monthly create');
    assertBudgetCreate(record, parsed.scope);

    return this.withScopedTransaction(parsed.scope, async (client) => {
      const replay = await this.replayIfExact({
        client,
        command: parsed,
        operation: 'monthly-category-budget-create',
        record,
      });
      if (replay !== undefined) return replay;
      await this.lockBudgetMonth(client, parsed.scope, record.month);
      const existing = await this.findBudgetForMonthForUpdate(
        client,
        parsed.scope,
        record.month,
      );
      if (existing !== undefined) {
        throw new FinanceSpecialistRecordRepositoryError(
          'conflict',
          'A Finance budget already exists for this month',
        );
      }
      await this.assertBudgetCategories(client, parsed.scope, record);
      const entity = await this.insertEntity(client, parsed.scope, record);
      return this.persistAppliedReceipt({
        client,
        command: parsed,
        operation: 'monthly-category-budget-create',
        expected: record,
        entity,
      });
    });
  }

  async updateMonthlyCategoryBudget(
    input: unknown,
  ): Promise<FinanceSpecialistRecordWriteReceipt> {
    const parsed = parseInput(BudgetUpdateInputSchema, input);
    assertCommandBinding(parsed, 'monthly-category-budget-update');
    const current = asBudget(parsed.current, 'current');
    const record = asBudget(parsed.record, 'monthly update');
    assertBudgetUpdate({
      current,
      record,
      expectedRevision: parsed.expectedRevision,
      scope: parsed.scope,
    });

    return this.withScopedTransaction(parsed.scope, async (client) => {
      const replay = await this.replayIfExact({
        client,
        command: parsed,
        operation: 'monthly-category-budget-update',
        record,
      });
      if (replay !== undefined) return replay;
      const stored = await this.requireCurrentEntityForUpdate(
        client,
        parsed.scope,
        current.id,
        'finance.budget',
      );
      const storedRecord = financeRecordFromEntity(stored, parsed.scope);
      if (!sameRecord(storedRecord, current)) {
        throw new FinanceSpecialistRecordRepositoryError(
          'conflict',
          'The Finance budget changed before this update could be applied',
        );
      }
      await this.assertBudgetCategories(client, parsed.scope, record);
      const entity = await this.updateEntity(
        client,
        parsed.scope,
        stored,
        record,
      );
      return this.persistAppliedReceipt({
        client,
        command: parsed,
        operation: 'monthly-category-budget-update',
        expected: record,
        entity,
      });
    });
  }

  private async withScopedTransaction<Result>(
    scope: ScopedFinanceScope,
    work: (client: DatabaseClient) => Promise<Result>,
  ): Promise<Result> {
    assertNotAborted(scope);
    let client: DatabaseClient | undefined;
    let released = false;
    try {
      client = await beginDurableTransaction(
        this.pool,
        durablePrincipalFor(scope),
      );
      await lockDurableScope(client, {
        householdId: scope.householdId,
        spaceId: scope.privateSpaceId,
      });
      await this.assertCurrentPrivateScope(client, scope);
      const result = await work(client);
      assertNotAborted(scope);
      await client.query('commit');
      released = true;
      client.release();
      return result;
    } catch (error) {
      if (client !== undefined && !released) {
        await rollbackQuietly(client);
        released = true;
        client.release();
      }
      return mapError(error);
    }
  }

  private async assertCurrentPrivateScope(
    client: DatabaseClient,
    scope: ScopedFinanceScope,
  ): Promise<void> {
    const authority = singleRow(
      (
        await client.query(
          `select access_grant.grant_id::text as "grantId",
                  access_grant.original_owner_user_id::text as "userId",
                  access_grant.session_id::text as "sessionId",
                  access_grant.request_id::text as "requestId",
                  access_grant.household_id::text as "householdId",
                  access_grant.private_space_id::text as "privateSpaceId",
                  access_grant.writable_space_ids::text[] as "writableSpaceIds"
             from emdo.resolve_space_access_grant(
               $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid
             ) as access_grant`,
          [
            scope.spaceAccessGrantId,
            scope.householdId,
            scope.userId,
            scope.sessionId,
            scope.requestId,
            scope.privateSpaceId,
          ],
        )
      ).rows,
      'space access grant',
    );
    if (authority === undefined) {
      throw new FinanceSpecialistRecordRepositoryError(
        'authorization-revoked',
        'The Finance specialist space access grant is no longer active',
      );
    }
    const parsed = parseResult(
      AuthorityRowSchema,
      authority,
      'space access grant',
    );
    if (
      parsed.grantId !== scope.spaceAccessGrantId ||
      parsed.userId !== scope.userId ||
      parsed.sessionId !== scope.sessionId ||
      parsed.requestId !== scope.requestId ||
      parsed.householdId !== scope.householdId ||
      parsed.privateSpaceId !== scope.privateSpaceId ||
      !parsed.writableSpaceIds.includes(scope.privateSpaceId)
    ) {
      throw new FinanceSpecialistRecordRepositoryError(
        'authorization-revoked',
        'The Finance specialist private scope binding is no longer valid',
      );
    }
    const privateSpace = singleRow(
      (
        await client.query(
          `select space.id::text as "id"
             from emdo.spaces as space
            where space.household_id = $1::uuid
              and space.id = $2::uuid
              and space.original_owner_user_id = $3::uuid
              and space.visibility = 'private'
              and space.tombstoned_at is null
            for share`,
          scopeValues(scope),
        )
      ).rows,
      'private space',
    );
    if (privateSpace === undefined) {
      throw new FinanceSpecialistRecordRepositoryError(
        'authorization-revoked',
        'The Finance specialist private space is unavailable',
      );
    }
  }

  private async findCurrentEntity(
    client: DatabaseClient,
    scope: FinanceScope,
    recordId: string,
  ): Promise<ParsedEntityRow | undefined> {
    const row = singleRow(
      (
        await client.query(
          `select entity.entity_id as "entityId", entity.entity_type as "entityType",
                  entity.payload as "payload", entity.revision as "revision"
             from emdo.sync_entities as entity
            where entity.household_id = $1::uuid
              and entity.space_id = $2::uuid
              and entity.original_owner_user_id = $3::uuid
              and entity.entity_id = $4::text
              and entity.entity_type = any($5::text[])
              and entity.tombstoned_at is null
            for share`,
          [
            ...scopeValues(scope),
            recordId,
            [...FinanceEntityTypeSchema.options],
          ],
        )
      ).rows,
      'owned record',
    );
    return row === undefined
      ? undefined
      : parseResult(EntityRowSchema, row, 'owned record');
  }

  private async requireCurrentEntityForUpdate(
    client: DatabaseClient,
    scope: FinanceScope,
    recordId: string,
    entityType: FinanceEntityType,
  ): Promise<ParsedEntityRow> {
    const row = singleRow(
      (
        await client.query(
          `select entity.entity_id as "entityId", entity.entity_type as "entityType",
                  entity.payload as "payload", entity.revision as "revision"
             from emdo.sync_entities as entity
            where entity.household_id = $1::uuid
              and entity.space_id = $2::uuid
              and entity.original_owner_user_id = $3::uuid
              and entity.entity_id = $4::text
              and entity.entity_type = $5::text
              and entity.tombstoned_at is null
            for update`,
          [...scopeValues(scope), recordId, entityType],
        )
      ).rows,
      'owned record for update',
    );
    if (row === undefined) {
      throw new FinanceSpecialistRecordRepositoryError(
        'record-not-found',
        'The Finance record is unavailable in the current private scope',
      );
    }
    return parseResult(EntityRowSchema, row, 'owned record for update');
  }

  private async assertTransactionReferences(
    client: DatabaseClient,
    scope: FinanceScope,
    record: FinanceTransactionRecord,
  ): Promise<void> {
    await this.assertReferenceEntities(client, scope, 'finance.account', [
      record.accountId,
    ]);
    if (record.categoryId !== null) {
      await this.assertReferenceEntities(client, scope, 'finance.category', [
        record.categoryId,
      ]);
    }
  }

  private async assertBudgetCategories(
    client: DatabaseClient,
    scope: FinanceScope,
    record: FinanceBudgetRecord,
  ): Promise<void> {
    await this.assertReferenceEntities(
      client,
      scope,
      'finance.category',
      record.allocations.map((allocation) => allocation.categoryId),
    );
  }

  private async assertReferenceEntities(
    client: DatabaseClient,
    scope: FinanceScope,
    entityType: 'finance.account' | 'finance.category',
    ids: readonly string[],
  ): Promise<void> {
    const expectedIds = [...new Set(ids)].sort();
    if (expectedIds.length === 0) return;
    const rows = (
      await client.query(
        `select entity.entity_id as "entityId", entity.entity_type as "entityType",
                entity.payload as "payload", entity.revision as "revision"
           from emdo.sync_entities as entity
          where entity.household_id = $1::uuid
            and entity.space_id = $2::uuid
            and entity.original_owner_user_id = $3::uuid
            and entity.entity_type = $4::text
            and entity.entity_id = any($5::text[])
            and entity.tombstoned_at is null
          for key share`,
        [...scopeValues(scope), entityType, expectedIds],
      )
    ).rows.map((row) => parseResult(EntityRowSchema, row, 'reference record'));
    const foundIds = new Set<string>();
    for (const row of rows) {
      const record = financeRecordFromEntity(row, scope);
      if (entityTypeFor(record) !== entityType) {
        throw new FinanceSpecialistRecordRepositoryError(
          'invalid-result',
          'A Finance reference entity did not match its canonical type',
        );
      }
      foundIds.add(record.id);
    }
    if (
      foundIds.size !== expectedIds.length ||
      expectedIds.some((id) => !foundIds.has(id))
    ) {
      throw new FinanceSpecialistRecordRepositoryError(
        'conflict',
        'A Finance account or category is unavailable in the private scope',
      );
    }
  }

  private async lockSyntheticStagingAccount(
    client: DatabaseClient,
    scope: SyntheticStagingScope,
  ): Promise<void> {
    await client.query(
      `select pg_catalog.pg_advisory_xact_lock(
         pg_catalog.hashtextextended($1::text, 0)
       )`,
      [
        `${scope.householdId}:${scope.privateSpaceId}:${scope.userId}:finance.account:${SyntheticStagingFinanceAccountId}`,
      ],
    );
  }

  private async findSyntheticStagingAccountForUpdate(
    client: DatabaseClient,
    scope: SyntheticStagingScope,
  ): Promise<ParsedEntityRow | undefined> {
    const row = singleRow(
      (
        await client.query(
          `select entity.entity_id as "entityId", entity.entity_type as "entityType",
                  entity.payload as "payload", entity.revision as "revision"
             from emdo.sync_entities as entity
            where entity.household_id = $1::uuid
              and entity.space_id = $2::uuid
              and entity.original_owner_user_id = $3::uuid
              and entity.entity_type = 'finance.account'
              and entity.entity_id = $4::text
              and entity.tombstoned_at is null
            for update`,
          [...scopeValues(scope), SyntheticStagingFinanceAccountId],
        )
      ).rows,
      'synthetic-staging account',
    );
    return row === undefined
      ? undefined
      : parseResult(EntityRowSchema, row, 'synthetic-staging account');
  }

  private async findSyntheticStagingAccountAudit(
    client: DatabaseClient,
    scope: SyntheticStagingScope,
  ): Promise<
    z.output<typeof SyntheticStagingAccountAuditRowSchema> | undefined
  > {
    const row = singleRow(
      (
        await client.query(
          `select audit.id::text as "auditEventId", audit.event_type as "eventType",
                  audit.payload as "payload"
             from emdo.audit_events as audit
            where audit.household_id = $1::uuid
              and audit.space_id = $2::uuid
              and audit.original_owner_user_id = $3::uuid
              and audit.event_type = $4::text
              and audit.payload ->> 'entityId' = $5::text
            order by audit.id asc`,
          [
            ...scopeValues(scope),
            SyntheticStagingFinanceAccountAuditEventType,
            SyntheticStagingFinanceAccountId,
          ],
        )
      ).rows,
      'synthetic-staging account audit',
    );
    return row === undefined
      ? undefined
      : parseResult(
          SyntheticStagingAccountAuditRowSchema,
          row,
          'synthetic-staging account audit',
        );
  }

  private replaySyntheticStagingAccountIfExact(input: {
    readonly scope: SyntheticStagingScope;
    readonly idempotencyKey: string;
    readonly expected: FinanceAccountRecord;
    readonly entity: ParsedEntityRow | undefined;
    readonly audit:
      z.output<typeof SyntheticStagingAccountAuditRowSchema> | undefined;
  }): FinanceSpecialistRecordWriteReceipt {
    const { scope, idempotencyKey, expected, entity, audit } = input;
    if (entity === undefined || audit === undefined) {
      throw new FinanceSpecialistRecordRepositoryError(
        'conflict',
        'The Finance synthetic-staging account has incomplete durable state',
      );
    }
    const stored = financeRecordFromEntity(entity, scope);
    const expectedAudit = syntheticStagingAccountAuditPayload({
      scope,
      idempotencyKey,
    });
    if (
      entity.entityType !== 'finance.account' ||
      entity.entityId !== SyntheticStagingFinanceAccountId ||
      entity.revision !== 1 ||
      stored.recordType !== 'account' ||
      !sameRecord(stored, expected) ||
      stableJson(syntheticStagingAccountReplayBinding(audit.payload)) !==
        stableJson(syntheticStagingAccountReplayBinding(expectedAudit))
    ) {
      throw new FinanceSpecialistRecordRepositoryError(
        'conflict',
        'The existing Finance synthetic-staging account differs from the fixed state',
      );
    }
    return deepFreeze({
      status: 'duplicate' as const,
      record: stored,
      auditEventId: audit.auditEventId,
    });
  }

  private async insertSyntheticStagingAccount(
    client: DatabaseClient,
    scope: SyntheticStagingScope,
    record: FinanceAccountRecord,
  ): Promise<ParsedEntityRow | undefined> {
    const row = singleRow(
      (
        await client.query(
          `insert into emdo.sync_entities
             (household_id, space_id, original_owner_user_id, entity_type,
              entity_id, payload, actor_intent, revision, created_at, updated_at)
           values ($1::uuid, $2::uuid, $3::uuid, 'finance.account', $4::text,
                   $5::jsonb, $6::text, 1,
                   pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp())
           on conflict (household_id, space_id, entity_type, entity_id)
           do nothing
           returning entity_id as "entityId", entity_type as "entityType",
                     payload as "payload", revision as "revision"`,
          [
            ...scopeValues(scope),
            SyntheticStagingFinanceAccountId,
            record,
            syntheticStagingAccountActorIntent,
          ],
        )
      ).rows,
      'inserted synthetic-staging account',
    );
    return row === undefined
      ? undefined
      : parseResult(EntityRowSchema, row, 'inserted synthetic-staging account');
  }

  private async appendSyntheticStagingAccountAudit(input: {
    readonly client: DatabaseClient;
    readonly scope: SyntheticStagingScope;
    readonly idempotencyKey: string;
  }): Promise<string> {
    const audit = singleRow(
      (
        await input.client.query(
          `insert into emdo.audit_events
             (household_id, space_id, original_owner_user_id, actor_user_id,
              session_id, request_id, event_type, payload,
              occurred_at, retain_until)
           values ($1::uuid, $2::uuid, $3::uuid, $3::uuid,
                   $4::uuid, $5::uuid, $6::text, $7::jsonb,
                   pg_catalog.clock_timestamp(),
                   pg_catalog.clock_timestamp() + interval '12 months')
           returning id::text as "auditEventId"`,
          [
            ...scopeValues(input.scope),
            input.scope.sessionId,
            input.scope.requestId,
            SyntheticStagingFinanceAccountAuditEventType,
            syntheticStagingAccountAuditPayload({
              scope: input.scope,
              idempotencyKey: input.idempotencyKey,
            }),
          ],
        )
      ).rows,
      'synthetic-staging account audit',
    );
    if (audit === undefined) {
      throw new FinanceSpecialistRecordRepositoryError(
        'authorization-revoked',
        'The Finance synthetic-staging account audit could not be persisted',
      );
    }
    return parseResult(AuditRowSchema, audit, 'synthetic-staging account audit')
      .auditEventId;
  }

  private async lockBudgetMonth(
    client: DatabaseClient,
    scope: FinanceScope,
    month: string,
  ): Promise<void> {
    await client.query(
      `select pg_catalog.pg_advisory_xact_lock(
         pg_catalog.hashtextextended($1::text, 0)
       )`,
      [
        `${scope.householdId}:${scope.privateSpaceId}:${scope.userId}:finance.budget:${month}`,
      ],
    );
  }

  private async findBudgetForMonthForUpdate(
    client: DatabaseClient,
    scope: FinanceScope,
    month: string,
  ): Promise<FinanceBudgetRecord | undefined> {
    const rows = (
      await client.query(
        `select entity.entity_id as "entityId", entity.entity_type as "entityType",
                entity.payload as "payload", entity.revision as "revision"
           from emdo.sync_entities as entity
          where entity.household_id = $1::uuid
            and entity.space_id = $2::uuid
            and entity.original_owner_user_id = $3::uuid
            and entity.entity_type = 'finance.budget'
            and entity.tombstoned_at is null
          for update`,
        scopeValues(scope),
      )
    ).rows.map((row) =>
      parseResult(EntityRowSchema, row, 'budget row for update'),
    );
    const matches = rows
      .map((row) => financeRecordFromEntity(row, scope))
      .filter(
        (record): record is FinanceBudgetRecord =>
          record.recordType === 'budget' && record.month === month,
      );
    if (matches.length > 1) {
      throw new FinanceSpecialistRecordRepositoryError(
        'invalid-result',
        'More than one canonical Finance budget exists for the month',
      );
    }
    return matches[0];
  }

  private async insertEntity(
    client: DatabaseClient,
    scope: FinanceScope,
    record: FinanceTransactionRecord | FinanceBudgetRecord,
  ): Promise<ParsedEntityRow> {
    const entityType = entityTypeFor(record);
    const row = singleRow(
      (
        await client.query(
          `insert into emdo.sync_entities
             (household_id, space_id, original_owner_user_id, entity_type,
              entity_id, payload, actor_intent, revision, created_at, updated_at)
           values ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text,
                   $6::jsonb, $7::text, 1,
                   pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp())
           on conflict (household_id, space_id, entity_type, entity_id)
           do nothing
           returning entity_id as "entityId", entity_type as "entityType",
                     payload as "payload", revision as "revision"`,
          [
            ...scopeValues(scope),
            entityType,
            record.id,
            record,
            recordActorIntent,
          ],
        )
      ).rows,
      'inserted record',
    );
    if (row === undefined) {
      throw new FinanceSpecialistRecordRepositoryError(
        'conflict',
        'A Finance record already uses this canonical identifier',
      );
    }
    return parseResult(EntityRowSchema, row, 'inserted record');
  }

  private async updateEntity(
    client: DatabaseClient,
    scope: FinanceScope,
    current: ParsedEntityRow,
    record: FinanceTransactionRecord | FinanceBudgetRecord,
  ): Promise<ParsedEntityRow> {
    const row = singleRow(
      (
        await client.query(
          `update emdo.sync_entities as entity
              set payload = $6::jsonb,
                  actor_intent = $7::text,
                  revision = entity.revision + 1,
                  updated_at = pg_catalog.clock_timestamp()
            where entity.household_id = $1::uuid
              and entity.space_id = $2::uuid
              and entity.original_owner_user_id = $3::uuid
              and entity.entity_type = $4::text
              and entity.entity_id = $5::text
              and entity.revision = $8::integer
              and entity.tombstoned_at is null
          returning entity.entity_id as "entityId", entity.entity_type as "entityType",
                    entity.payload as "payload", entity.revision as "revision"`,
          [
            ...scopeValues(scope),
            current.entityType,
            current.entityId,
            record,
            recordActorIntent,
            current.revision,
          ],
        )
      ).rows,
      'updated record',
    );
    if (row === undefined) {
      throw new FinanceSpecialistRecordRepositoryError(
        'conflict',
        'The Finance record revision no longer matches the current entity',
      );
    }
    return parseResult(EntityRowSchema, row, 'updated record');
  }

  private async replayIfExact(input: {
    readonly client: DatabaseClient;
    readonly command: z.output<typeof WriteCommandSchema>;
    readonly operation: FinanceWriteOperation;
    readonly record: FinanceTransactionRecord | FinanceBudgetRecord;
  }): Promise<FinanceSpecialistRecordWriteReceipt | undefined> {
    const { client, command, operation, record } = input;
    await client.query(
      `select pg_catalog.pg_advisory_xact_lock(
         pg_catalog.hashtextextended($1::text, 0)
       )`,
      [
        `${command.scope.householdId}:${command.scope.privateSpaceId}:${command.scope.userId}:${command.idempotencyKey}`,
      ],
    );
    const row = singleRow(
      (
        await client.query(
          `select receipt.operation as "operation",
                  receipt.idempotency_key as "idempotencyKey",
                  receipt.canonical_hash as "canonicalHash",
                  receipt.scope_fingerprint as "scopeFingerprint",
                  receipt.origin_session_id::text as "originSessionId",
                  receipt.origin_request_id::text as "originRequestId",
                  receipt.origin_run_id::text as "originRunId",
                  receipt.origin_space_access_grant_id::text as "originSpaceAccessGrantId",
                  receipt.entity_type as "entityType", receipt.entity_id as "entityId",
                  receipt.resulting_revision as "resultingRevision",
                  receipt.audit_event_id::text as "auditEventId"
             from emdo.finance_specialist_record_receipts as receipt
            where receipt.household_id = $1::uuid
              and receipt.space_id = $2::uuid
              and receipt.original_owner_user_id = $3::uuid
              and receipt.idempotency_key = $4::text`,
          [...scopeValues(command.scope), command.idempotencyKey],
        )
      ).rows,
      'idempotency receipt',
    );
    if (row === undefined) return undefined;
    const receipt = parseResult(ReceiptRowSchema, row, 'idempotency receipt');
    const entityType = entityTypeFor(record);
    if (
      receipt.operation !== operation ||
      receipt.idempotencyKey !== command.idempotencyKey ||
      receipt.canonicalHash !== command.canonicalHash ||
      receipt.scopeFingerprint !==
        command.scope.collectionAuthorizationScopeFingerprint ||
      receipt.originSessionId !== command.scope.sessionId ||
      receipt.originRequestId !== command.scope.requestId ||
      receipt.originRunId !== command.scope.runId ||
      receipt.originSpaceAccessGrantId !== command.scope.spaceAccessGrantId ||
      receipt.entityType !== entityType ||
      receipt.entityId !== record.id
    ) {
      throw new FinanceSpecialistRecordRepositoryError(
        'conflict',
        'The Finance specialist idempotency key is bound to another command',
      );
    }
    const historical = singleRow(
      (
        await client.query(
          `select revision.entity_id as "entityId", revision.entity_type as "entityType",
                  revision.payload as "payload", revision.revision as "revision"
             from emdo.sync_entity_revisions as revision
            where revision.household_id = $1::uuid
              and revision.space_id = $2::uuid
              and revision.original_owner_user_id = $3::uuid
              and revision.entity_type = $4::text
              and revision.entity_id = $5::text
              and revision.revision = $6::integer`,
          [
            ...scopeValues(command.scope),
            receipt.entityType,
            receipt.entityId,
            receipt.resultingRevision,
          ],
        )
      ).rows,
      'receipt entity revision',
    );
    if (historical === undefined) {
      throw new FinanceSpecialistRecordRepositoryError(
        'invalid-result',
        'The Finance specialist receipt has no canonical entity revision',
      );
    }
    const replayed = financeRecordFromEntity(
      parseResult(EntityRowSchema, historical, 'receipt entity revision'),
      command.scope,
    );
    if (!sameRecord(replayed, record)) {
      throw new FinanceSpecialistRecordRepositoryError(
        'conflict',
        'The Finance specialist receipt does not match the requested record',
      );
    }
    return deepFreeze({
      status: 'duplicate' as const,
      record: replayed,
      auditEventId: receipt.auditEventId,
    });
  }

  private async persistAppliedReceipt(input: {
    readonly client: DatabaseClient;
    readonly command: z.output<typeof WriteCommandSchema>;
    readonly operation: FinanceWriteOperation;
    readonly expected: FinanceTransactionRecord | FinanceBudgetRecord;
    readonly entity: ParsedEntityRow;
  }): Promise<FinanceSpecialistRecordWriteReceipt> {
    const { client, command, operation, expected, entity } = input;
    const stored = financeRecordFromEntity(entity, command.scope);
    if (!sameRecord(stored, expected)) {
      throw new FinanceSpecialistRecordRepositoryError(
        'invalid-result',
        'The stored Finance record did not match the approved safe mutation',
      );
    }
    const audit = singleRow(
      (
        await client.query(
          `insert into emdo.audit_events
             (household_id, space_id, original_owner_user_id, actor_user_id,
              session_id, request_id, run_id, event_type, payload,
              occurred_at, retain_until)
           values ($1::uuid, $2::uuid, $3::uuid, $3::uuid,
                   $4::uuid, $5::uuid, $6::uuid, $7::text, $8::jsonb,
                   pg_catalog.clock_timestamp(),
                   pg_catalog.clock_timestamp() + interval '12 months')
           returning id::text as "auditEventId"`,
          [
            ...scopeValues(command.scope),
            command.scope.sessionId,
            command.scope.requestId,
            command.scope.runId,
            command.audit.eventType,
            receiptPayload({
              operation,
              canonicalHash: command.canonicalHash,
              entityType: entity.entityType,
              entityId: entity.entityId,
              resultingRevision: entity.revision,
            }),
          ],
        )
      ).rows,
      'audit event',
    );
    if (audit === undefined) {
      throw new FinanceSpecialistRecordRepositoryError(
        'authorization-revoked',
        'The Finance specialist audit event could not be persisted',
      );
    }
    const auditEvent = parseResult(AuditRowSchema, audit, 'audit event');
    const receipt = singleRow(
      (
        await client.query(
          `insert into emdo.finance_specialist_record_receipts
             (schema_version, household_id, space_id, original_owner_user_id,
              operation, idempotency_key, canonical_hash, scope_fingerprint,
              origin_session_id, origin_request_id, origin_run_id,
              origin_space_access_grant_id, entity_type, entity_id,
              resulting_revision, audit_event_id, recorded_at, retain_until)
           values (1, $1::uuid, $2::uuid, $3::uuid,
                   $4::text, $5::text, $6::text, $7::text,
                   $8::uuid, $9::uuid, $10::uuid, $11::uuid,
                   $12::text, $13::text, $14::integer, $15::uuid,
                   pg_catalog.clock_timestamp(),
                   pg_catalog.clock_timestamp() + interval '90 days')
           returning audit_event_id::text as "auditEventId"`,
          [
            ...scopeValues(command.scope),
            operation,
            command.idempotencyKey,
            command.canonicalHash,
            command.scope.collectionAuthorizationScopeFingerprint,
            command.scope.sessionId,
            command.scope.requestId,
            command.scope.runId,
            command.scope.spaceAccessGrantId,
            entity.entityType,
            entity.entityId,
            entity.revision,
            auditEvent.auditEventId,
          ],
        )
      ).rows,
      'command receipt',
    );
    if (receipt === undefined) {
      throw new FinanceSpecialistRecordRepositoryError(
        'invalid-result',
        'The Finance specialist receipt was not persisted',
      );
    }
    const persisted = parseResult(AuditRowSchema, receipt, 'command receipt');
    if (persisted.auditEventId !== auditEvent.auditEventId) {
      throw new FinanceSpecialistRecordRepositoryError(
        'invalid-result',
        'The Finance specialist receipt did not bind the supplied audit event',
      );
    }
    return deepFreeze({
      status: 'applied' as const,
      record: stored,
      auditEventId: auditEvent.auditEventId,
    });
  }
}

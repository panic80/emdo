import { createHash, randomUUID } from 'node:crypto';

import {
  EffectiveAuthorizationScopeFingerprintSchema,
  FinanceImportDestinationsSchema,
  FinanceImportReferenceSchema,
  IdempotencyKeySchema,
  Sha256Schema,
  UuidSchema,
  deepFreeze,
} from '@emdo/contracts';
import {
  createFinanceImportPlan,
  previewFinanceImport,
  type FinanceImportPlan,
  type FinanceImportPreviewReady,
} from '@emdo/domains/finance';
import { z } from 'zod';

import {
  DurableRepositoryError,
  beginDurableTransaction,
  firstResultRow,
  type DurableRepositoryPrincipal,
} from '../durable/scoped-transaction.js';
import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';

const RoleSchema = z.enum(['owner', 'member']);
const MAX_SOURCE_BYTES = 1_048_576;
const MAX_CANONICAL_PLAN_BYTES = 1_048_576;
const PrincipalSchema = z.strictObject({
  userId: UuidSchema,
  sessionId: UuidSchema,
  householdId: UuidSchema,
  role: RoleSchema,
  emailVerified: z.literal(true),
  privateSpaceId: UuidSchema.optional(),
  spaceAccessGrantId: UuidSchema,
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema,
});
const CsvMappingSchema = z
  .strictObject({
    dateFormat: z.enum(['yyyy-mm-dd', 'mm/dd/yyyy', 'dd/mm/yyyy']),
    defaultCategoryId: FinanceImportReferenceSchema.nullable(),
    columns: z.strictObject({
      postedOn: z.string().trim().min(1).max(200),
      description: z.string().trim().min(1).max(200),
      amount: z.string().trim().min(1).max(200).optional(),
      debit: z.string().trim().min(1).max(200).optional(),
      credit: z.string().trim().min(1).max(200).optional(),
      externalId: z.string().trim().min(1).max(200).optional(),
      categoryId: z.string().trim().min(1).max(200).optional(),
    }),
  })
  .superRefine((mapping, context) => {
    const signed = mapping.columns.amount !== undefined;
    const split =
      mapping.columns.debit !== undefined &&
      mapping.columns.credit !== undefined;
    if (signed === split) {
      context.addIssue({
        code: 'custom',
        path: ['columns'],
        message:
          'Map one signed amount column or both debit and credit columns',
      });
    }
  });
const PreviewInputSchema = z.discriminatedUnion('format', [
  z.strictObject({
    accountId: FinanceImportReferenceSchema,
    format: z.literal('csv'),
    mapping: CsvMappingSchema,
    sourceText: z.string().min(1).max(MAX_SOURCE_BYTES),
    principal: PrincipalSchema,
    requestId: UuidSchema,
  }),
  z.strictObject({
    accountId: FinanceImportReferenceSchema,
    format: z.literal('ofx'),
    mapping: z.strictObject({
      defaultCategoryId: FinanceImportReferenceSchema.nullable(),
    }),
    sourceText: z.string().min(1).max(MAX_SOURCE_BYTES),
    principal: PrincipalSchema,
    requestId: UuidSchema,
  }),
]);
const CommitInputSchema = z.strictObject({
  planId: UuidSchema,
  idempotencyKey: IdempotencyKeySchema,
  principal: PrincipalSchema,
  requestId: UuidSchema,
});
const ScopeSchema = z.strictObject({
  accountId: FinanceImportReferenceSchema,
  spaceId: UuidSchema,
  ownerUserId: UuidSchema,
  scopeFingerprint: Sha256Schema,
  existingFingerprints: z.array(Sha256Schema).max(100_000),
});
const StoredPlanSchema = z.strictObject({
  status: z.literal('stored'),
  planId: UuidSchema,
  expiresAt: z.coerce.date(),
});
const ReceiptSchema = z.strictObject({
  id: UuidSchema,
  planId: UuidSchema,
  transactionCount: z.number().int().positive().max(100_000),
  verified: z.literal(true),
});
const CommitResultSchema = z.strictObject({
  status: z.enum(['committed', 'replayed']),
  receipt: ReceiptSchema,
});
const ReadinessSchema = z.strictObject({ ready: z.boolean() });

export class FinanceImportPersistenceError extends Error {
  constructor(
    readonly code:
      | 'authorization-revoked'
      | 'database-unavailable'
      | 'invalid-input'
      | 'invalid-result'
      | 'plan-not-found'
      | 'plan-expired'
      | 'idempotency-conflict'
      | 'plan-conflict',
    message: string,
  ) {
    super(message);
    this.name = 'FinanceImportPersistenceError';
  }
}

const principalFor = (input: {
  readonly principal: z.output<typeof PrincipalSchema>;
  readonly requestId: string;
}): Readonly<DurableRepositoryPrincipal> =>
  deepFreeze({
    userId: input.principal.userId,
    sessionId: input.principal.sessionId,
    requestId: input.requestId,
    householdId: input.principal.householdId,
  });

const invalidInput = (message: string): never => {
  throw new FinanceImportPersistenceError('invalid-input', message);
};
const invalidResult = (message: string): never => {
  throw new FinanceImportPersistenceError('invalid-result', message);
};
const mapDurableError = (error: unknown): never => {
  if (error instanceof FinanceImportPersistenceError) throw error;
  if (error instanceof DurableRepositoryError) {
    throw new FinanceImportPersistenceError(
      error.code === 'conflict' ? 'invalid-result' : error.code,
      error.message,
    );
  }
  const databaseMessage =
    error !== null && typeof error === 'object' && 'message' in error
      ? String(error.message)
      : '';
  const known = new Map<string, FinanceImportPersistenceError['code']>([
    ['emdo:authorization-revoked', 'authorization-revoked'],
    ['emdo:finance-import-category-invalid', 'authorization-revoked'],
    ['emdo:finance-import-plan-not-found', 'plan-not-found'],
    ['emdo:finance-import-plan-expired', 'plan-expired'],
    ['emdo:finance-import-idempotency-conflict', 'idempotency-conflict'],
    ['emdo:finance-import-plan-id-conflict', 'plan-conflict'],
    ['emdo:finance-import-duplicate-at-commit', 'plan-conflict'],
    ['emdo:finance-import-plan-invalid', 'invalid-input'],
  ]);
  const code = known.get(databaseMessage);
  if (code !== undefined) {
    throw new FinanceImportPersistenceError(
      code,
      'The finance import command could not be completed safely',
    );
  }
  throw new FinanceImportPersistenceError(
    'database-unavailable',
    'The durable finance import command could not be verified',
  );
};
const digest = (source: string) =>
  createHash('sha256').update(source, 'utf8').digest('hex');
const utf8Bytes = (value: unknown): number =>
  Buffer.byteLength(
    typeof value === 'string' ? value : JSON.stringify(value),
    'utf8',
  );

const rollbackQuietly = async (client: DatabaseClient) => {
  try {
    await client.query('rollback');
  } catch {
    // The original database result remains authoritative.
  }
};

/**
 * The finance routines re-check the authoritative current grant and private
 * account scope themselves.  Keep that lock explicit in the application
 * transaction as well, without trusting an application-side authorization
 * result; only the SECURITY DEFINER aggregate can grant the operation.
 */
const withFinanceClaims = async <Result>(
  pool: DatabasePool,
  principal: Readonly<DurableRepositoryPrincipal>,
  work: (client: DatabaseClient) => Promise<Result>,
): Promise<Result> => {
  const client = await beginDurableTransaction(pool, principal);
  let released = false;
  try {
    await client.query(
      'select emdo.lock_active_request_scope($1, null, null) as locked',
      [principal.householdId],
    );
    const result = await work(client);
    try {
      await client.query('commit');
    } catch {
      released = true;
      client.release(true);
      throw new AmbiguousFinanceCommitError();
    }
    released = true;
    client.release();
    return result;
  } catch (error) {
    if (!released) {
      await rollbackQuietly(client);
      released = true;
      client.release();
    }
    throw error;
  }
};

class AmbiguousFinanceCommitError extends Error {
  constructor() {
    super('Finance import commit acknowledgement was lost');
    this.name = 'AmbiguousFinanceCommitError';
  }
}

const withFinanceCommitClaims = async <Result>(
  pool: DatabasePool,
  principal: Readonly<DurableRepositoryPrincipal>,
  work: (client: DatabaseClient) => Promise<Result>,
): Promise<Result> => {
  const client = await beginDurableTransaction(pool, principal);
  let released = false;
  try {
    await client.query(
      'select emdo.lock_active_request_scope($1, null, null) as locked',
      [principal.householdId],
    );
    const result = await work(client);
    try {
      await client.query('commit');
    } catch {
      released = true;
      client.release(true);
      throw new AmbiguousFinanceCommitError();
    }
    released = true;
    client.release();
    return result;
  } catch (error) {
    if (!released) {
      await rollbackQuietly(client);
      released = true;
      client.release();
    }
    throw error;
  }
};

const mappingMetadata = (
  input: z.output<typeof PreviewInputSchema>,
): Readonly<Record<string, unknown>> =>
  input.format === 'ofx'
    ? deepFreeze({
        format: 'ofx',
        hasDefaultCategory: input.mapping.defaultCategoryId !== null,
      })
    : deepFreeze({
        format: 'csv',
        dateFormat: input.mapping.dateFormat,
        fields: {
          postedOn: true,
          description: true,
          amount: input.mapping.columns.amount !== undefined,
          debit: input.mapping.columns.debit !== undefined,
          credit: input.mapping.columns.credit !== undefined,
          externalId: input.mapping.columns.externalId !== undefined,
          categoryId: input.mapping.columns.categoryId !== undefined,
        },
        hasDefaultCategory: input.mapping.defaultCategoryId !== null,
      });

const diagnostics = (preview: FinanceImportPreviewReady) =>
  deepFreeze({
    rejectedRows: preview.rejected.map((row) => ({
      sourceRow: row.sourceRow,
      code: row.safeError.code,
    })),
    duplicateRows: preview.duplicates.map((row) => ({
      sourceRow: row.sourceRow,
      reason: row.reason,
    })),
  });

const responseFrom = (input: {
  readonly planId: string;
  readonly sourceHash: string;
  readonly expiresAt: Date;
  readonly preview: FinanceImportPreviewReady;
}) =>
  deepFreeze({
    schemaVersion: 1 as const,
    plan: {
      id: input.planId,
      sourceHash: input.sourceHash,
      expiresAt: input.expiresAt.toISOString(),
      summary: input.preview.summary,
      rejectedRows: input.preview.rejected.map((row) => ({
        sourceRow: row.sourceRow,
        code: row.safeError.code,
      })),
      duplicateRows: input.preview.duplicates.map((row) => ({
        sourceRow: row.sourceRow,
        reason: row.reason,
      })),
    },
  });

/**
 * Server-side finance statement boundary. Source bytes cross this class only
 * long enough to calculate a canonical plan; database routines receive hashes
 * and bounded canonical data, never the statement or header labels.
 */
export class PostgresFinanceImportRepository {
  private readonly createPlanId: () => string;

  constructor(
    private readonly pool: DatabasePool,
    options: Readonly<{ generateUuid?: () => string }> = {},
  ) {
    this.createPlanId = options.generateUuid ?? randomUUID;
  }

  async checkReady(): Promise<boolean> {
    const client = await this.pool.connect().catch(() => undefined);
    if (client === undefined) return false;
    let destroy = false;
    try {
      const row = firstResultRow(
        await client.query('select emdo.finance_imports_ready() as ready'),
      );
      const ready = ReadinessSchema.safeParse(row).data?.ready === true;
      destroy = !ready;
      return ready;
    } catch {
      destroy = true;
      return false;
    } finally {
      client.release(destroy ? true : undefined);
    }
  }

  async listDestinations(input: unknown) {
    const parsed = z
      .strictObject({ principal: PrincipalSchema, requestId: UuidSchema })
      .safeParse(input);
    if (!parsed.success) {
      return invalidInput('Finance import destination input is malformed');
    }
    const envelope = parsed.data!;
    try {
      return await withFinanceClaims(
        this.pool,
        principalFor(envelope),
        async (client) => {
          const row = firstResultRow(
            await client.query(
              `select emdo.read_finance_import_destinations($1, $2, $3, $4)
                 as finance_import_destinations`,
              [
                envelope.principal.householdId,
                envelope.principal.spaceAccessGrantId,
                envelope.principal.collectionAuthorizationScopeFingerprint,
                envelope.principal.role,
              ],
            ),
          );
          const canonical = FinanceImportDestinationsSchema.safeParse(
            row?.finance_import_destinations,
          );
          if (!canonical.success) {
            return invalidResult(
              'Database returned invalid finance import destinations',
            );
          }
          return canonical.data;
        },
      );
    } catch (error) {
      return mapDurableError(error);
    }
  }

  async preview(input: unknown) {
    const parsed = PreviewInputSchema.safeParse(input);
    if (!parsed.success) {
      return invalidInput('Finance import preview input is malformed');
    }
    const envelope = parsed.data!;
    if (utf8Bytes(envelope.sourceText) > MAX_SOURCE_BYTES) {
      invalidInput('Finance import statement exceeds the source byte limit');
    }
    const sourceHash = digest(envelope.sourceText);

    let prepared:
      | Readonly<{
          planId: string;
          plan: FinanceImportPlan | undefined;
          preview: FinanceImportPreviewReady;
          diagnosticRows: ReturnType<typeof diagnostics>;
          metadata: Readonly<Record<string, unknown>>;
        }>
      | undefined;
    const execute = () =>
      withFinanceClaims(this.pool, principalFor(envelope), async (client) => {
        const scopeRow = firstResultRow(
          await client.query(
            `select emdo.read_finance_import_preview_scope($1, $2, $3, $4, $5)
                 as finance_import_scope`,
            [
              envelope.accountId,
              envelope.principal.householdId,
              envelope.principal.spaceAccessGrantId,
              envelope.principal.collectionAuthorizationScopeFingerprint,
              envelope.principal.role,
            ],
          ),
        );
        const scope = ScopeSchema.safeParse(scopeRow?.finance_import_scope);
        if (!scope.success)
          return invalidResult(
            'Database returned an invalid finance import scope',
          );
        const currentScope = scope.data!;
        if (prepared === undefined) {
          const preview = previewFinanceImport({
            format: envelope.format,
            mapping: envelope.mapping,
            sourceText: envelope.sourceText,
            sourceHash,
            accountId: currentScope.accountId,
            spaceId: currentScope.spaceId,
            ownerUserId: currentScope.ownerUserId,
            previewedAt: new Date().toISOString(),
            existingFingerprints: currentScope.existingFingerprints,
          });
          if (preview.status !== 'ready')
            return invalidInput(
              'Finance import statement could not form a safe plan',
            );
          const generatedPlanId = UuidSchema.safeParse(this.createPlanId());
          if (!generatedPlanId.success)
            return invalidResult(
              'Finance import plan identity generator is invalid',
            );
          const planId = generatedPlanId.data!;
          const planned = createFinanceImportPlan({
            planId,
            idempotencyKey: `finance-import-plan:${planId}`,
            preview,
          });
          if (planned.status !== 'planned')
            return invalidInput(
              'Finance import statement has no new transactions',
            );
          if (utf8Bytes(planned.plan) > MAX_CANONICAL_PLAN_BYTES) {
            invalidInput(
              'Finance import plan exceeds the canonical byte limit',
            );
          }
          const diagnosticRows = diagnostics(preview);
          if (utf8Bytes(diagnosticRows) > MAX_CANONICAL_PLAN_BYTES) {
            invalidInput(
              'Finance import diagnostics exceed the canonical byte limit',
            );
          }
          const metadata = mappingMetadata(envelope);
          if (utf8Bytes(metadata) > 4_096) {
            invalidInput(
              'Finance import mapping metadata exceeds its byte limit',
            );
          }
          prepared = deepFreeze({
            planId,
            plan: planned.plan,
            preview,
            diagnosticRows,
            metadata,
          });
        }
        const current = prepared;
        if (current.plan === undefined) {
          return invalidResult('Finance import plan preparation was invalid');
        }
        const storedRow = firstResultRow(
          await client.query(
            `select emdo.persist_finance_import_plan(
                 $1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb,
                 $7, $8, $9, $10, $11
               ) as finance_import_plan`,
            [
              current.planId,
              current.plan.sourceHash,
              current.plan.planHash,
              current.plan,
              current.diagnosticRows,
              current.metadata,
              envelope.principal.householdId,
              envelope.principal.spaceAccessGrantId,
              envelope.principal.collectionAuthorizationScopeFingerprint,
              envelope.principal.role,
              1_800,
            ],
          ),
        );
        const stored = StoredPlanSchema.safeParse(
          storedRow?.finance_import_plan,
        );
        if (!stored.success || stored.data?.planId !== current.planId) {
          return invalidResult(
            'Database did not acknowledge the exact finance import plan',
          );
        }
        return responseFrom({
          planId: current.planId,
          sourceHash,
          expiresAt: stored.data!.expiresAt,
          preview: current.preview,
        });
      });
    try {
      return await execute();
    } catch (error) {
      if (!(error instanceof AmbiguousFinanceCommitError))
        return mapDurableError(error);
      try {
        return await execute();
      } catch (retryError) {
        return mapDurableError(retryError);
      }
    }
  }

  async commit(input: unknown) {
    const parsed = CommitInputSchema.safeParse(input);
    if (!parsed.success) {
      return invalidInput('Finance import commit input is malformed');
    }
    const envelope = parsed.data!;
    const execute = () =>
      withFinanceCommitClaims(
        this.pool,
        principalFor(envelope),
        async (client) => {
          const row = firstResultRow(
            await client.query(
              `select emdo.commit_finance_import_plan($1, $2, $3, $4, $5, $6)
               as finance_import_commit`,
              [
                envelope.planId,
                envelope.idempotencyKey,
                envelope.principal.householdId,
                envelope.principal.spaceAccessGrantId,
                envelope.principal.collectionAuthorizationScopeFingerprint,
                envelope.principal.role,
              ],
            ),
          );
          const result = CommitResultSchema.safeParse(
            row?.finance_import_commit,
          );
          if (
            !result.success ||
            result.data?.receipt.planId !== envelope.planId
          ) {
            return invalidResult(
              'Database did not acknowledge an exact finance import receipt',
            );
          }
          return deepFreeze({
            schemaVersion: 1 as const,
            status: result.data!.status,
            receipt: result.data!.receipt,
            sourceDeletionAuthorized: true as const,
          });
        },
      );
    try {
      return await execute();
    } catch (error) {
      if (!(error instanceof AmbiguousFinanceCommitError))
        return mapDurableError(error);
      try {
        return await execute();
      } catch (retryError) {
        return mapDurableError(retryError);
      }
    }
  }
}

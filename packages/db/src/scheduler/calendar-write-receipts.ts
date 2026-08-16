import { UuidSchema, deepFreeze, type DeepReadonly } from '@emdo/contracts';
import { z } from 'zod';

import type { DatabasePool } from '../scoped-repository.js';
import {
  DurableRepositoryError,
  firstResultRow,
  parseDurablePrincipal,
  withDurableTransaction,
  type DurableRepositoryPrincipal,
} from '../durable/scoped-transaction.js';

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const ReferenceSchema = z.string().trim().min(1).max(240);
const VersionSchema = z.string().trim().min(1).max(512);
const EventTextSchema = z.string().trim().min(1).max(8_000);
const ProviderEventSchema = z.strictObject({
  eventId: z
    .string()
    .min(5)
    .max(240)
    .regex(/^[0-9a-v]+$/u),
  summary: EventTextSchema.max(2_000),
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  timeZone: z.literal('America/Toronto'),
  location: EventTextSchema.max(2_000).optional(),
  description: EventTextSchema.optional(),
  attendees: z.array(z.email().max(320)).max(100).optional(),
  recurrence: z
    .strictObject({
      frequency: z.enum(['daily', 'weekly']),
      interval: z.number().int().safe().min(1).max(52),
      count: z.number().int().safe().min(1).max(366),
      disambiguation: z.enum(['reject', 'earlier', 'later']),
      byWeekday: z
        .array(z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']))
        .min(1)
        .max(7)
        .optional(),
    })
    .optional(),
  eventVersion: VersionSchema,
});
const SafeErrorSchema = z.strictObject({
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
  message: z.string().min(1).max(2_000),
  retryable: z.literal(false),
});
const CalendarWriteResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('applied'),
    providerRequestId: ReferenceSchema.nullable(),
    reconciled: z.boolean(),
    readbackCalendarVersion: VersionSchema,
    readback: ProviderEventSchema.nullable(),
  }),
  z.strictObject({
    status: z.literal('not-applied'),
    safeError: SafeErrorSchema,
  }),
  z.strictObject({
    status: z.literal('indeterminate'),
    reconciliationRequired: z.literal(true),
    safeError: SafeErrorSchema,
  }),
]);

export type PostgresCalendarWriteResult = DeepReadonly<
  z.infer<typeof CalendarWriteResultSchema>
>;

export type PostgresCalendarReceiptAcquisition = Readonly<
  | { status: 'acquired' }
  | { status: 'pending' }
  | { status: 'conflict' }
  | { status: 'existing'; result: PostgresCalendarWriteResult }
>;

const ReceiptScopeSchema = z.strictObject({
  spaceId: UuidSchema,
  runId: UuidSchema,
  providerId: z.literal('google-calendar').default('google-calendar'),
});

const parseResult = (value: unknown): PostgresCalendarWriteResult => {
  const parsed = CalendarWriteResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new DurableRepositoryError(
      'invalid-result',
      'Stored Calendar execution result is malformed',
    );
  }
  return deepFreeze(parsed.data);
};

const resultCanonicalJson = (value: PostgresCalendarWriteResult) =>
  JSON.stringify(value);

export class PostgresCalendarWriteReceiptStore {
  readonly #principal: Readonly<DurableRepositoryPrincipal>;
  readonly #scope: Readonly<z.infer<typeof ReceiptScopeSchema>>;

  constructor(
    private readonly pool: DatabasePool,
    principal: DurableRepositoryPrincipal,
    scope: z.input<typeof ReceiptScopeSchema>,
  ) {
    this.#principal = parseDurablePrincipal(principal);
    this.#scope = deepFreeze(ReceiptScopeSchema.parse(scope));
  }

  async acquire(
    idempotencyKeyInput: string,
    commandHashInput: string,
  ): Promise<PostgresCalendarReceiptAcquisition> {
    const receiptKey = HashSchema.parse(idempotencyKeyInput);
    const commandHash = HashSchema.parse(commandHashInput);
    return withDurableTransaction(
      this.pool,
      this.#principal,
      {
        householdId: this.#principal.householdId,
        spaceId: this.#scope.spaceId,
      },
      async (client) => {
        await client.query(
          `select pg_catalog.pg_advisory_xact_lock(
             pg_catalog.hashtextextended($1, 0)
           )`,
          [receiptKey],
        );
        const existing = firstResultRow(
          await client.query(
            `select command_hash, state, result,
                    lease_expires_at <= pg_catalog.clock_timestamp() as lease_expired
               from emdo.scheduler_execution_receipts
              where receipt_key = $1
              for update`,
            [receiptKey],
          ),
        );
        if (existing !== undefined) {
          if (existing.command_hash !== commandHash) {
            return { status: 'conflict' } as const;
          }
          if (existing.state === 'pending' && existing.result === null) {
            if (existing.lease_expired === true) {
              const crashResult = CalendarWriteResultSchema.parse({
                status: 'indeterminate',
                reconciliationRequired: true,
                safeError: {
                  code: 'calendar-provider-indeterminate',
                  message: 'Provider state is unknown.',
                  retryable: false,
                },
              });
              const terminal = firstResultRow(
                await client.query(
                  `update emdo.scheduler_execution_receipts
                      set state = 'completed', result = $2::jsonb,
                          reconciliation_required = true,
                          completed_at = pg_catalog.clock_timestamp(),
                          updated_at = pg_catalog.clock_timestamp()
                    where receipt_key = $1 and state = 'pending'
                      and result is null
                      and lease_expires_at <= pg_catalog.clock_timestamp()
                  returning receipt_key`,
                  [receiptKey, crashResult],
                ),
              );
              if (terminal?.receipt_key === receiptKey) {
                return { status: 'existing' as const, result: crashResult };
              }
            }
            return { status: 'pending' } as const;
          }
          if (existing.state === 'completed' && existing.result !== null) {
            return {
              status: 'existing' as const,
              result: parseResult(existing.result),
            };
          }
          throw new DurableRepositoryError(
            'invalid-result',
            'Calendar receipt lifecycle is malformed',
          );
        }

        const inserted = firstResultRow(
          await client.query(
            `with database_time as (
               select pg_catalog.clock_timestamp() as now
             )
             insert into emdo.scheduler_execution_receipts
               (receipt_key, household_id, space_id, original_owner_user_id,
                run_id, provider_id, command_hash, state, result,
                reconciliation_required, created_at, lease_expires_at,
                updated_at, retain_until)
             select $1, run.household_id, run.space_id,
                    run.original_owner_user_id, run.id, $3, $4, 'pending',
                    null, false, database_time.now,
                    database_time.now + interval '5 minutes', database_time.now,
                    database_time.now + interval '90 days'
               from emdo.agent_runs run cross join database_time
              where run.id = $2 and run.household_id = $5
                and run.space_id = $6
                and run.original_owner_user_id = emdo.current_user_id()
             on conflict (receipt_key) do nothing
             returning receipt_key`,
            [
              receiptKey,
              this.#scope.runId,
              this.#scope.providerId,
              commandHash,
              this.#principal.householdId,
              this.#scope.spaceId,
            ],
          ),
        );
        return inserted === undefined
          ? ({ status: 'conflict' } as const)
          : ({ status: 'acquired' } as const);
      },
    );
  }

  async complete(
    idempotencyKeyInput: string,
    commandHashInput: string,
    resultInput: PostgresCalendarWriteResult,
  ): Promise<void> {
    const receiptKey = HashSchema.parse(idempotencyKeyInput);
    const commandHash = HashSchema.parse(commandHashInput);
    const result = parseResult(resultInput);
    await withDurableTransaction(
      this.pool,
      this.#principal,
      {
        householdId: this.#principal.householdId,
        spaceId: this.#scope.spaceId,
      },
      async (client) => {
        await client.query(
          `select pg_catalog.pg_advisory_xact_lock(
             pg_catalog.hashtextextended($1, 0)
           )`,
          [receiptKey],
        );
        const existing = firstResultRow(
          await client.query(
            `select command_hash, state, result
               from emdo.scheduler_execution_receipts
              where receipt_key = $1
              for update`,
            [receiptKey],
          ),
        );
        if (existing?.command_hash !== commandHash) {
          throw new Error('Calendar receipt completion mismatch');
        }
        if (existing.state === 'completed' && existing.result !== null) {
          const exact = firstResultRow(
            await client.query(
              `select receipt_key
                 from emdo.scheduler_execution_receipts
                where receipt_key = $1 and command_hash = $2
                  and state = 'completed' and result = $3::jsonb`,
              [receiptKey, commandHash, result],
            ),
          );
          if (exact?.receipt_key === receiptKey) return;
          throw new Error('Calendar receipt completion mismatch');
        }
        if (existing.state !== 'pending' || existing.result !== null) {
          throw new Error('Calendar receipt completion mismatch');
        }
        const updated = firstResultRow(
          await client.query(
            `update emdo.scheduler_execution_receipts
                set state = 'completed', result = $3::jsonb,
                    reconciliation_required = $4,
                    completed_at = pg_catalog.clock_timestamp(),
                    updated_at = pg_catalog.clock_timestamp()
              where receipt_key = $1 and command_hash = $2
                and state = 'pending' and result is null
              returning receipt_key`,
            [
              receiptKey,
              commandHash,
              result,
              result.status === 'indeterminate',
            ],
          ),
        );
        if (updated === undefined) {
          throw new Error('Calendar receipt completion mismatch');
        }
      },
    );
  }

  async listReconciliationMarkers(limitInput = 100) {
    const limit = z.number().int().positive().max(1_000).parse(limitInput);
    return withDurableTransaction(
      this.pool,
      this.#principal,
      {
        householdId: this.#principal.householdId,
        spaceId: this.#scope.spaceId,
      },
      async (client) =>
        deepFreeze(
          (
            await client.query(
              `select receipt_key, command_hash, result, completed_at
                 from emdo.scheduler_execution_receipts
                where household_id = $1 and space_id = $2 and run_id = $3
                  and provider_id = $4 and state = 'completed'
                  and reconciliation_required = true
                order by completed_at, receipt_key
                limit $5`,
              [
                this.#principal.householdId,
                this.#scope.spaceId,
                this.#scope.runId,
                this.#scope.providerId,
                limit,
              ],
            )
          ).rows.map((row) => {
            if (
              typeof row.receipt_key !== 'string' ||
              typeof row.command_hash !== 'string'
            ) {
              throw new DurableRepositoryError(
                'invalid-result',
                'Calendar reconciliation marker is malformed',
              );
            }
            const completedAt =
              row.completed_at instanceof Date
                ? row.completed_at
                : new Date(String(row.completed_at));
            if (!Number.isFinite(completedAt.getTime())) {
              throw new DurableRepositoryError(
                'invalid-result',
                'Calendar reconciliation timestamp is malformed',
              );
            }
            return {
              receiptKey: row.receipt_key,
              commandHash: row.command_hash,
              result: parseResult(row.result),
              completedAt: completedAt.toISOString(),
            };
          }),
        ),
    );
  }

  static canonicalResult(result: PostgresCalendarWriteResult): string {
    return resultCanonicalJson(parseResult(result));
  }
}

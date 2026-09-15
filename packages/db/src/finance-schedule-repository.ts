import { z } from 'zod';
import { FinanceV2PersistenceError } from './finance-v2-repository.js';
import {
  FinanceAutomationScheduleDefinitionSchema,
  FinanceAutomationScheduleSchema,
  FinanceAutomationScheduleCursorSchema,
  FinanceAutomationDuePlanInputSchema,
  UuidSchema,
  WorkspaceContextSchema,
  type WorkspaceContext,
} from '@emdo/contracts';
import { planFinanceAutomationDue } from '@emdo/domains/finance';
import { withDurableTransaction } from './durable/scoped-transaction.js';
import type { DatabaseClient, DatabasePool } from './scoped-repository.js';
export const SetFinanceScheduleStateSchema = z.strictObject({
  expectedStateRevision: z.number().int().positive().max(2147483646),
  status: z.enum(['active', 'paused', 'retired']),
});
const ClaimSchema = z.strictObject({
  leaseToken: UuidSchema,
  input: FinanceAutomationDuePlanInputSchema,
});
export type FinanceScheduleClaim = z.infer<typeof ClaimSchema>;
function view(raw: unknown) {
  const row = z.record(z.string(), z.unknown()).parse(raw);
  return {
    schedule: FinanceAutomationScheduleSchema.parse({
      id: row.id,
      definitionRevision: row.definition_revision,
      stateRevision: row.state_revision,
      status: row.status,
      definition: row.definition,
    }),
    cursor: FinanceAutomationScheduleCursorSchema.parse({
      scheduleId: row.id,
      definitionRevision: row.definition_revision,
      nextOrdinal: Number(row.next_ordinal),
    }),
    nextDueAt:
      row.next_due_at === null
        ? null
        : z.iso.datetime({ offset: true }).parse(row.next_due_at),
    blockedReason: z.string().max(500).nullable().parse(row.blocked_reason),
    createdAt: z.iso.datetime({ offset: true }).parse(row.created_at),
    updatedAt: z.iso.datetime({ offset: true }).parse(row.updated_at),
  };
}
/** Browser management has no trigger/commit method. The database checks grant ownership. */
export class PostgresFinanceScheduleRepository {
  constructor(
    private readonly pool: DatabasePool,
    private readonly timezoneVersion = process.versions.tz ?? 'unavailable',
  ) {}
  private transaction<T>(
    context: WorkspaceContext,
    work: (client: DatabaseClient) => Promise<T>,
  ) {
    const scope = WorkspaceContextSchema.parse(context);
    return withDurableTransaction(
      this.pool,
      { ...scope, householdId: scope.workspaceId },
      { householdId: scope.workspaceId },
      work,
    ).catch((error: unknown) => {
      if (!(error instanceof Error) || error.name === 'ZodError') throw error;
      const code = 'code' in error ? String(error.code) : '';
      if (code === '42501')
        throw new FinanceV2PersistenceError(
          'authorization-revoked',
          'Schedule authorization denied.',
        );
      if (
        ['22P02', '22003', '23502', '23503'].includes(code) ||
        /^schedule-.*-invalid$/.test(error.message)
      )
        throw new FinanceV2PersistenceError(
          'invalid-input',
          'Schedule input is invalid.',
        );
      if (
        ['23505', '23514', '40P01', '55P03'].includes(code) ||
        error.message.startsWith('schedule-')
      )
        throw new FinanceV2PersistenceError(
          'conflict',
          'Schedule revision or authority changed.',
        );
      throw error;
    });
  }
  async checkReady() {
    const client = await this.pool.connect();
    try {
      return (
        (
          await client.query(
            "select to_regprocedure('emdo.create_finance_schedule(uuid,uuid,uuid,jsonb,text)') is not null and not rolsuper and not rolbypassrls as ready from pg_roles where rolname=current_user",
          )
        ).rows[0]?.ready === true
      );
    } finally {
      client.release();
    }
  }
  async createSchedule(
    context: WorkspaceContext,
    bookId: string,
    key: string,
    raw: unknown,
  ) {
    UuidSchema.parse(bookId);
    UuidSchema.parse(key);
    const definition = FinanceAutomationScheduleDefinitionSchema.parse(raw);
    if (
      definition.workspaceId !== context.workspaceId ||
      definition.bookId !== bookId
    )
      throw new Error('finance-schedule-scope-mismatch');
    if (
      definition.cadence.kind !== 'interval' &&
      definition.cadence.tzdbVersion !== this.timezoneVersion
    )
      throw new Error('finance-schedule-timezone-review-required');
    return this.transaction(context, async (client) =>
      view(
        (
          await client.query(
            'select emdo.create_finance_schedule($1,$2,$3,$4::jsonb,$5) as schedule',
            [
              context.workspaceId,
              bookId,
              key,
              JSON.stringify(definition),
              this.timezoneVersion,
            ],
          )
        ).rows[0]?.schedule,
      ),
    );
  }
  async setScheduleState(
    context: WorkspaceContext,
    bookId: string,
    scheduleId: string,
    raw: unknown,
  ) {
    UuidSchema.parse(bookId);
    UuidSchema.parse(scheduleId);
    const input = SetFinanceScheduleStateSchema.parse(raw);
    return this.transaction(context, async (client) =>
      view(
        (
          await client.query(
            'select emdo.set_finance_schedule_state($1,$2,$3,$4,$5) as schedule',
            [
              context.workspaceId,
              bookId,
              scheduleId,
              input.expectedStateRevision,
              input.status,
            ],
          )
        ).rows[0]?.schedule,
      ),
    );
  }
  async listSchedules(
    context: WorkspaceContext,
    bookId: string,
    offset = 0,
    limit = 50,
  ) {
    UuidSchema.parse(bookId);
    z.number().int().min(0).max(100000).parse(offset);
    z.number().int().min(1).max(100).parse(limit);
    return this.transaction(context, async (client) =>
      (
        await client.query(
          'select emdo.read_finance_schedules($1,$2,$3,$4,null) as schedule',
          [context.workspaceId, bookId, offset, limit],
        )
      ).rows.map((row) => view(row.schedule)),
    );
  }
  async getSchedule(
    context: WorkspaceContext,
    bookId: string,
    scheduleId: string,
  ) {
    UuidSchema.parse(bookId);
    UuidSchema.parse(scheduleId);
    return this.transaction(context, async (client) => {
      const row = (
        await client.query(
          'select emdo.read_finance_schedules($1,$2,0,1,$3) as schedule',
          [context.workspaceId, bookId, scheduleId],
        )
      ).rows[0];
      return row ? view(row.schedule) : null;
    });
  }
}
/** Requires the fixed emdo_finance_scheduler role. No browser context, grant
 * editing, capability invocation or startup registration is exposed here. */
export class PostgresFinanceScheduleDueRepository {
  constructor(
    private readonly pool: DatabasePool,
    private readonly timezoneVersion = process.versions.tz ?? 'unavailable',
  ) {}
  private async query(sql: string, values: unknown[] = []) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query("set local statement_timeout='5s'");
      await client.query("set local lock_timeout='2s'");
      const result = await client.query(sql, values);
      await client.query('commit');
      return result;
    } catch (error) {
      try {
        await client.query('rollback');
      } catch {
        /* Closing connection remains caller-owned. */
      }
      throw error;
    } finally {
      client.release();
    }
  }
  async checkReady() {
    return (
      (
        await this.query(
          "select current_user='emdo_finance_scheduler' and not rolsuper and not rolbypassrls and to_regprocedure('emdo.commit_finance_schedule(uuid,uuid,integer,bigint,text,jsonb)') is not null as ready from pg_roles where rolname=current_user",
        )
      ).rows[0]?.ready === true
    );
  }
  async claimDue(limit = 20) {
    z.number().int().min(1).max(20).parse(limit);
    const result = await this.query(
      'select emdo.claim_finance_schedules($1,$2) as claim',
      [limit, this.timezoneVersion],
    );
    if (result.rows.length > limit)
      throw new Error('finance-schedule-claim-bound');
    return result.rows.map((row) => ClaimSchema.parse(row.claim));
  }
  async commit(claimInput: unknown, plan: unknown) {
    const claim = ClaimSchema.parse(claimInput);
    const encoded = JSON.stringify(plan);
    if (Buffer.byteLength(encoded) > 16384)
      throw new Error('finance-schedule-plan-bound');
    const result = await this.query(
      'select emdo.commit_finance_schedule($1,$2,$3,$4,$5,$6::jsonb) as result',
      [
        claim.input.schedule.id,
        claim.leaseToken,
        claim.input.schedule.stateRevision,
        claim.input.cursor.nextOrdinal,
        this.timezoneVersion,
        encoded,
      ],
    );
    return z.record(z.string(), z.unknown()).parse(result.rows[0]?.result);
  }
  async planAndCommit(claim: FinanceScheduleClaim) {
    return this.commit(claim, planFinanceAutomationDue(claim.input));
  }
}

import { UuidSchema, type FinanceAutomationCapability } from '@emdo/contracts';
import { z } from 'zod';
import type { DatabaseClient, DatabasePool } from './scoped-repository.js';

const PlanningCapabilitySchema = z.enum([
  'finance.planning.budget-vs-actuals',
  'finance.planning.forecast',
]);

const PlanningExecutionInputSchema = z.strictObject({
  operationId: UuidSchema,
  /** CAS revision of the claimed automation run, never budgetRevision. */
  expectedRevision: z.number().int().positive().max(2_147_483_647),
  leaseToken: UuidSchema,
});

/** A known SQL rejection means the planning result was not applied. Unknown
 * failures are deliberately allowed to escape so the worker marks the run
 * indeterminate instead of retrying an effect whose commit is uncertain. */
export class FinancePlanningResultNotAppliedError extends Error {
  constructor(
    readonly reason:
      | 'authority-denied'
      | 'invalid-intent'
      | 'source-invalid'
      | 'result-conflict',
  ) {
    super(`finance-planning-${reason}`);
    this.name = 'FinancePlanningResultNotAppliedError';
  }
}

/** Restricted worker persistence for the two planning automation leaves.
 * SQL reloads the canonical run intent and performs current authority,
 * reviewed-input, usage, and lease checks atomically. The worker supplies only
 * the operation identity, run CAS revision, and claimed lease token.
 */
export class PostgresFinancePlanningExecutionRepository {
  constructor(private readonly pool: DatabasePool) {}

  async checkReady(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `select current_user='emdo_worker_executor'
             and not rolsuper
             and not rolbypassrls
             and to_regprocedure('emdo.generate_finance_planning_result(uuid,integer,uuid)') is not null
             and coalesce(has_function_privilege(current_user,to_regprocedure('emdo.generate_finance_planning_result(uuid,integer,uuid)'),'EXECUTE'),false) as ready
           from pg_roles
          where rolname=current_user`,
      );
      return result.rows[0]?.ready === true;
    } finally {
      client.release();
    }
  }

  async generatePlanningResult(raw: {
    operationId: string;
    expectedRevision: number;
    leaseToken: string;
  }): Promise<{ resultId: string }> {
    const input = PlanningExecutionInputSchema.parse(raw);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query("set local statement_timeout='60s'");
      await client.query("set local lock_timeout='5s'");
      await client.query('set local row_security=on');
      const result = await client.query(
        'select emdo.generate_finance_planning_result($1,$2,$3) as result_id',
        [input.operationId, input.expectedRevision, input.leaseToken],
      );
      const resultId = UuidSchema.parse(result.rows[0]?.result_id);
      await client.query('commit');
      return { resultId };
    } catch (error) {
      try {
        await client.query('rollback');
      } catch {
        /* Preserve unknown effect uncertainty if rollback also fails. */
      }
      const code =
        error instanceof Error && 'code' in error ? String(error.code) : '';
      const message = error instanceof Error ? error.message : '';
      if (code === '42501')
        throw new FinancePlanningResultNotAppliedError('authority-denied');
      if (code === '22023')
        throw new FinancePlanningResultNotAppliedError('invalid-intent');
      if (code === '54000')
        throw new FinancePlanningResultNotAppliedError('source-invalid');
      // A PostgreSQL lock timeout aborts the atomic statement: retrying it
      // cannot duplicate a committed result. Transport errors remain unknown.
      if (code === '55P03')
        throw new FinancePlanningResultNotAppliedError('result-conflict');
      if (code === '22003')
        throw new FinancePlanningResultNotAppliedError('source-invalid');
      if (code === '23514' || code === '23503' || code === '23505')
        throw new FinancePlanningResultNotAppliedError(
          message.includes('conflict') || message.includes('duplicate')
            ? 'result-conflict'
            : 'source-invalid',
        );
      throw error;
    } finally {
      client.release();
    }
  }

  /** Alias kept explicit for callers that name the SQL operation. */
  async generateFinancePlanningResult(raw: {
    operationId: string;
    expectedRevision: number;
    leaseToken: string;
  }): Promise<{ resultId: string }> {
    return this.generatePlanningResult(raw);
  }
}

export type FinancePlanningAutomationCapability = Extract<
  FinanceAutomationCapability,
  'finance.planning.budget-vs-actuals' | 'finance.planning.forecast'
>;

export function parseFinancePlanningAutomationCapability(
  raw: unknown,
): FinancePlanningAutomationCapability {
  return PlanningCapabilitySchema.parse(raw);
}

export type FinancePlanningExecutionStore = Pick<
  PostgresFinancePlanningExecutionRepository,
  'generatePlanningResult'
>;

// Kept as a type-only reference to ensure the repository uses the worker
// client boundary rather than an API/Drizzle connection.
export type FinancePlanningExecutionClient = DatabaseClient;

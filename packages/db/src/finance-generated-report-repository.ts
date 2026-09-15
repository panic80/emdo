import {
  FinanceGeneratedReportSchema,
  FinanceGeneratedReportSummarySchema,
  FinanceLedgerAccountClassificationSchema,
  SetFinanceLedgerAccountClassificationSchema,
  UuidSchema,
  WorkspaceContextSchema,
  type WorkspaceContext,
  type FinanceGeneratedReportSummary,
} from '@emdo/contracts';
import { z } from 'zod';
import type { DatabaseClient, DatabasePool } from './scoped-repository.js';
import { withDurableTransaction } from './durable/scoped-transaction.js';
import { FinanceV2PersistenceError } from './finance-v2-repository.js';

const columns = `id,workspace_id as "workspaceId",book_id as "bookId",automation_run_id as "automationRunId",report_version as "reportVersion",kind,coverage,currency,period_id as "periodId",period_start as "periodStart",period_end as "periodEnd",as_of as "asOf",snapshot_at as "snapshotAt"`;
const isoDate = (value: unknown) =>
  value === null || value === undefined
    ? value
    : value instanceof Date
      ? value.toISOString().slice(0, 10)
      : String(value).slice(0, 10);
function summary(raw: Record<string, unknown>) {
  return FinanceGeneratedReportSummarySchema.parse({
    ...raw,
    periodStart: isoDate(raw.periodStart),
    periodEnd: isoDate(raw.periodEnd),
    asOf: isoDate(raw.asOf),
    snapshotAt: new Date(String(raw.snapshotAt)).toISOString(),
  });
}
/** Ordinary permission-governed reads; never gated behind paid automation access. */
export class PostgresFinanceGeneratedReportRepository {
  constructor(private readonly pool: DatabasePool) {}
  async checkReady(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        "select (select c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='emdo' and c.relname='finance_generated_reports') as report_rls,(select c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='emdo' and c.relname='finance_generated_reports') as report_force_rls,(select c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='emdo' and c.relname='finance_ledger_account_classifications') as classification_rls,(select c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='emdo' and c.relname='finance_ledger_account_classifications') as classification_force_rls,to_regprocedure('emdo.generate_finance_accounting_report(uuid,integer,uuid)') is not null as statement_function,r.rolsuper,r.rolbypassrls from pg_roles r where r.rolname=current_user",
      );
      const row = result.rows[0];
      return (
        row?.report_rls === true &&
        row.report_force_rls === true &&
        row.classification_rls === true &&
        row.classification_force_rls === true &&
        row.statement_function === true &&
        row.rolsuper === false &&
        row.rolbypassrls === false
      );
    } finally {
      client.release();
    }
  }
  private transaction<T>(
    raw: WorkspaceContext,
    bookId: string,
    work: (client: DatabaseClient) => Promise<T>,
  ) {
    const context = WorkspaceContextSchema.parse(raw);
    UuidSchema.parse(bookId);
    return withDurableTransaction(
      this.pool,
      { ...context, householdId: context.workspaceId },
      { householdId: context.workspaceId },
      async (client) => {
        const auth = await client.query(
          'select emdo.lock_finance_book_grant($1,$2) as allowed',
          [context.workspaceId, bookId],
        );
        if (auth.rows[0]?.allowed !== true)
          throw new FinanceV2PersistenceError(
            'authorization-revoked',
            'finance-book-forbidden',
          );
        return work(client);
      },
    ).catch((error: unknown) => {
      if (error instanceof FinanceV2PersistenceError) throw error;
      const code =
        error instanceof Error && 'code' in error ? String(error.code) : '';
      if (code === '42501' || code === 'authorization-revoked')
        throw new FinanceV2PersistenceError(
          'authorization-revoked',
          'finance-book-forbidden',
        );
      if (['22P02', '22003', '23502', '23503'].includes(code))
        throw new FinanceV2PersistenceError(
          'invalid-input',
          'finance-report-invalid-input',
        );
      if (['23505', '23514', '40P01', '55P03'].includes(code))
        throw new FinanceV2PersistenceError(
          'conflict',
          'finance-report-read-conflict',
        );
      throw error;
    });
  }
  async list(
    context: WorkspaceContext,
    bookId: string,
    offset = 0,
    limit = 50,
  ): Promise<{
    reports: FinanceGeneratedReportSummary[];
    nextOffset: number | null;
  }> {
    z.number().int().min(0).max(1000000).parse(offset);
    z.number().int().min(1).max(100).parse(limit);
    return this.transaction(context, bookId, async (client) => {
      const rows = (
        await client.query(
          `select ${columns} from emdo.finance_generated_reports where workspace_id=$1 and book_id=$2 order by snapshot_at desc,id desc offset $3 limit $4`,
          [context.workspaceId, bookId, offset, limit + 1],
        )
      ).rows;
      return {
        reports: rows.slice(0, limit).map(summary),
        nextOffset: rows.length > limit ? offset + limit : null,
      };
    });
  }
  async get(context: WorkspaceContext, bookId: string, id: string) {
    UuidSchema.parse(id);
    return this.transaction(context, bookId, async (client) => {
      const row = (
        await client.query(
          `select ${columns},snapshot from emdo.finance_generated_reports where workspace_id=$1 and book_id=$2 and id=$3`,
          [context.workspaceId, bookId, id],
        )
      ).rows[0];
      if (!row) return null;
      const { snapshot, ...metadata } = row;
      return FinanceGeneratedReportSchema.parse({
        ...z.record(z.string(), z.unknown()).parse(snapshot),
        ...summary(metadata),
      });
    });
  }

  async listClassifications(context: WorkspaceContext, bookId: string) {
    UuidSchema.parse(bookId);
    return this.transaction(context, bookId, async (client) => {
      const rows = (
        await client.query(
          `select workspace_id as "workspaceId",book_id as "bookId",account_id as "accountId",revision,statement,section,display_order as "displayOrder",created_by as "createdBy",created_at as "createdAt"
             from emdo.finance_ledger_account_classifications
            where workspace_id=$1 and book_id=$2
            order by account_id,revision`,
          [context.workspaceId, bookId],
        )
      ).rows;
      return rows.map((row) =>
        FinanceLedgerAccountClassificationSchema.parse({
          ...row,
          createdAt: new Date(String(row.createdAt)).toISOString(),
        }),
      );
    });
  }

  async setClassification(
    context: WorkspaceContext,
    bookId: string,
    accountId: string,
    raw: unknown,
  ) {
    UuidSchema.parse(bookId);
    UuidSchema.parse(accountId);
    const input = SetFinanceLedgerAccountClassificationSchema.parse(raw);
    return this.transaction(context, bookId, async (client) => {
      const result = await client.query(
        'select emdo.set_finance_ledger_account_classification($1,$2,$3,$4,$5,$6) as result',
        [
          context.workspaceId,
          bookId,
          accountId,
          input.statement,
          input.section,
          input.displayOrder,
        ],
      );
      const value = result.rows[0]?.result;
      const row = z.record(z.string(), z.unknown()).parse(value);
      return FinanceLedgerAccountClassificationSchema.parse({
        workspaceId: row.workspace_id,
        bookId: row.book_id,
        accountId: row.account_id,
        revision: row.revision,
        statement: row.statement,
        section: row.section,
        displayOrder: row.display_order,
        createdBy: row.created_by,
        createdAt: new Date(String(row.created_at)).toISOString(),
      });
    });
  }
}

/** Server confirmed rejection means the atomic SQL operation rolled back. */
export class FinanceGeneratedReportNotAppliedError extends Error {
  constructor(
    readonly reason:
      | 'authority-denied'
      | 'invalid-intent'
      | 'source-limit-exceeded'
      | 'ledger-invalid'
      | 'missing-classification',
  ) {
    super(`finance-report-${reason}`);
    this.name = 'FinanceGeneratedReportNotAppliedError';
  }
}
/** Session-free EMDO-managed execution; report and completed run commit together. */
export class PostgresFinanceGeneratedReportExecutionRepository {
  constructor(private readonly pool: DatabasePool) {}
  async generateTrialBalance(raw: {
    operationId: string;
    expectedRevision: number;
    leaseToken: string;
  }): Promise<{ reportId: string }> {
    const input = z
      .strictObject({
        operationId: UuidSchema,
        expectedRevision: z.number().int().positive().max(2147483647),
        leaseToken: UuidSchema,
      })
      .parse(raw);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query("set local statement_timeout='60s'");
      await client.query("set local lock_timeout='5s'");
      await client.query('set local row_security=on');
      const result = await client.query(
        'select emdo.generate_finance_trial_balance($1,$2,$3) as report_id',
        [input.operationId, input.expectedRevision, input.leaseToken],
      );
      const reportId = UuidSchema.parse(result.rows[0]?.report_id);
      await client.query('commit');
      return { reportId };
    } catch (error) {
      try {
        await client.query('rollback');
      } catch {
        /* Original effect uncertainty remains authoritative. */
      }
      const code =
        error instanceof Error && 'code' in error ? String(error.code) : '';
      if (code === '42501')
        throw new FinanceGeneratedReportNotAppliedError('authority-denied');
      if (code === '22023')
        throw new FinanceGeneratedReportNotAppliedError('invalid-intent');
      if (code === '54000')
        throw new FinanceGeneratedReportNotAppliedError(
          'source-limit-exceeded',
        );
      if (code === '23514' || code === '22003')
        throw new FinanceGeneratedReportNotAppliedError('ledger-invalid');
      throw error;
    } finally {
      client.release();
    }
  }

  async generateAccountingReport(raw: {
    operationId: string;
    expectedRevision: number;
    leaseToken: string;
  }): Promise<{ reportId: string }> {
    const input = z
      .strictObject({
        operationId: UuidSchema,
        expectedRevision: z.number().int().positive().max(2147483647),
        leaseToken: UuidSchema,
      })
      .parse(raw);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query("set local statement_timeout='60s'");
      await client.query("set local lock_timeout='5s'");
      await client.query('set local row_security=on');
      const result = await client.query(
        'select emdo.generate_finance_accounting_report($1,$2,$3) as report_id',
        [input.operationId, input.expectedRevision, input.leaseToken],
      );
      const reportId = UuidSchema.parse(result.rows[0]?.report_id);
      await client.query('commit');
      return { reportId };
    } catch (error) {
      try {
        await client.query('rollback');
      } catch {
        /* Original effect uncertainty remains authoritative. */
      }
      const code =
        error instanceof Error && 'code' in error ? String(error.code) : '';
      const message = error instanceof Error ? error.message : '';
      if (code === '42501')
        throw new FinanceGeneratedReportNotAppliedError('authority-denied');
      if (code === '22023')
        throw new FinanceGeneratedReportNotAppliedError('invalid-intent');
      if (code === '54000')
        throw new FinanceGeneratedReportNotAppliedError(
          'source-limit-exceeded',
        );
      if (
        code === '23514' &&
        message.includes('missing-account-classification')
      )
        throw new FinanceGeneratedReportNotAppliedError(
          'missing-classification',
        );
      if (code === '23514' || code === '22003')
        throw new FinanceGeneratedReportNotAppliedError('ledger-invalid');
      throw error;
    } finally {
      client.release();
    }
  }
}

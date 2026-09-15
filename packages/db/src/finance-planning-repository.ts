import { createHash, randomUUID } from 'node:crypto';

import {
  FinanceBudgetListSchema,
  FinanceBudgetRevisionSchema,
  FinanceBudgetSummarySchema,
  FinanceCurrencySchema,
  FinanceForecastListSchema,
  FinanceForecastSnapshotSchema,
  FinanceForecastSummarySchema,
  FinanceForecastOpeningInputSchema,
  FinancePlanningIdempotencyKeySchema,
  FinancePlanningPageQuerySchema,
  FinancePlanningRevisionSchema,
  FinancePlanningAutomationResultSchema,
  FinancePostedLedgerAggregateSchema,
  SaveFinanceBudgetSchema,
  SaveFinanceForecastSchema,
  UuidSchema,
  WorkspaceContextSchema,
  type FinanceBudgetRevision,
  type FinanceForecastSnapshot,
  type WorkspaceContext,
} from '@emdo/contracts';
import {
  buildFinanceForecast,
  deriveFinanceBudgetVsActuals,
  type FinanceBudgetPeriodInput,
  type FinancePostedLedgerAggregateInput,
} from '@emdo/domains/finance';

import { withDurableTransaction } from './durable/scoped-transaction.js';
import type { DatabaseClient, DatabasePool } from './scoped-repository.js';

export class FinancePlanningPersistenceError extends Error {
  constructor(
    readonly code:
      'authorization-revoked' | 'invalid-input' | 'conflict' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'FinancePlanningPersistenceError';
  }
}

const rowObject = (row: Record<string, unknown>) => row;
const textValue = (value: unknown) => String(value);
const dateValue = (value: unknown) =>
  value instanceof Date
    ? value.toISOString().slice(0, 10)
    : textValue(value).slice(0, 10);
const isoDateTime = (value: unknown) =>
  value instanceof Date
    ? value.toISOString()
    : new Date(textValue(value)).toISOString();

const errorFromDatabase = (cause: unknown): unknown => {
  if (cause instanceof FinancePlanningPersistenceError) return cause;
  if (!(cause instanceof Error) || cause.name === 'ZodError') return cause;
  const code = 'code' in cause ? String(cause.code) : '';
  if (code === '42501' || cause.message === 'finance-planning-book-forbidden') {
    return new FinancePlanningPersistenceError(
      'authorization-revoked',
      'Current book access does not permit this planning operation.',
    );
  }
  if (['22P02', '22003', '23502', '23503'].includes(code)) {
    return new FinancePlanningPersistenceError(
      'invalid-input',
      'The planning input is invalid for this book.',
    );
  }
  if (
    ['23505', '23514', '40P01', '55P03'].includes(code) ||
    cause.message.startsWith('finance-planning-')
  ) {
    return new FinancePlanningPersistenceError(
      'conflict',
      'The planning revision or source changed. Refresh the book and try again.',
    );
  }
  return cause;
};

const mapAggregate = (
  raw: Record<string, unknown>,
): FinancePostedLedgerAggregateInput =>
  FinancePostedLedgerAggregateSchema.parse({
    periodId: raw.periodId,
    accountId: raw.accountId,
    currency: raw.currency,
    accountKind: raw.accountKind,
    debitAmount: textValue(raw.debitAmount),
    creditAmount: textValue(raw.creditAmount),
    journalCount: Number(raw.journalCount),
    lineCount: Number(raw.lineCount),
  });

const mapPeriod = (raw: Record<string, unknown>): FinanceBudgetPeriodInput => ({
  periodId: textValue(raw.periodId),
  startsOn: dateValue(raw.startsOn),
  endsOn: dateValue(raw.endsOn),
});

const mapOpening = (raw: Record<string, unknown>) => {
  const status = textValue(raw.openingStatus);
  if (status === 'unavailable')
    return FinanceForecastOpeningInputSchema.parse({
      status,
      label: 'opening-balance-unavailable',
    });
  return FinanceForecastOpeningInputSchema.parse({
    status: 'available',
    amount: textValue(raw.openingAmount),
    currency: FinanceCurrencySchema.parse(raw.openingCurrency),
    sourceReference: textValue(raw.openingSourceReference),
    reviewedBy: UuidSchema.parse(raw.openingReviewedBy),
    reviewedAt: isoDateTime(raw.openingReviewedAt),
  });
};

const commandHash = (operation: string, bookId: string, payload: unknown) =>
  createHash('sha256')
    .update(JSON.stringify({ operation, bookId, payload }))
    .digest('hex');

/**
 * Normalized budget and forecast persistence. The migration that creates the
 * tables is intentionally owned by the sequential migration coordinator; this
 * repository is safe to stage against that schema before the migration is
 * journaled.
 */
export class PostgresFinancePlanningRepository {
  constructor(private readonly pool: DatabasePool) {}

  async checkReady(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `select
          (select count(*) = 6 and bool_and(c.relrowsecurity and c.relforcerowsecurity)
             from pg_class c join pg_namespace n on n.oid=c.relnamespace
            where n.nspname='emdo' and c.relname in
              ('finance_budget_revisions','finance_budget_lines','finance_forecast_snapshots','finance_forecast_lines','finance_forecast_assumptions','finance_planning_results')) as planning_rls,
          not r.rolsuper and not r.rolbypassrls as restricted_role
         from pg_roles r where r.rolname=current_user`,
      );
      const row = result.rows[0];
      return row?.planning_rls === true && row.restricted_role === true;
    } finally {
      client.release();
    }
  }

  private transaction<T>(
    raw: WorkspaceContext,
    bookId: string,
    write: boolean,
    work: (client: DatabaseClient, functionalCurrency: string) => Promise<T>,
  ) {
    const context = WorkspaceContextSchema.parse(raw);
    UuidSchema.parse(bookId);
    return withDurableTransaction(
      this.pool,
      { ...context, householdId: context.workspaceId },
      { householdId: context.workspaceId },
      async (client) => {
        // The locked grant protects reads from a concurrent revocation. Planning
        // writes acquire the canonical book advisory lock below; read methods
        // that need a coherent ledger snapshot acquire it at the call site.
        const auth = await client.query(
          'select emdo.lock_finance_book_grant($1,$2) as allowed',
          [context.workspaceId, bookId],
        );
        if (auth.rows[0]?.allowed !== true)
          throw new FinancePlanningPersistenceError(
            'authorization-revoked',
            'finance-planning-book-forbidden',
          );
        const book = await client.query(
          `select b.functional_currency as "functionalCurrency", g.role
             from emdo.finance_books b
             join emdo.finance_book_grants g
               on g.workspace_id=b.workspace_id and g.book_id=b.id
            where b.workspace_id=$1 and b.id=$2 and g.user_id=$3 and g.revoked_at is null`,
          [context.workspaceId, bookId, context.userId],
        );
        const row = book.rows[0];
        if (
          !row ||
          (write &&
            !['administrator', 'preparer', 'approver'].includes(
              textValue(row.role),
            ))
        )
          throw new FinancePlanningPersistenceError(
            'authorization-revoked',
            'finance-planning-book-forbidden',
          );
        return work(
          client,
          FinanceCurrencySchema.parse(row.functionalCurrency),
        );
      },
    ).catch((cause: unknown) => {
      const mapped = errorFromDatabase(cause);
      throw mapped;
    });
  }

  private async readBudget(
    client: DatabaseClient,
    context: WorkspaceContext,
    bookId: string,
    budgetId: string,
    revision: number | null,
  ): Promise<FinanceBudgetRevision | null> {
    const header = await client.query(
      `select b.workspace_id as "workspaceId", b.book_id as "bookId",
              b.budget_id as "budgetId", b.revision, b.name,
              b.functional_currency as "functionalCurrency",
              b.created_by as "createdBy", b.created_at as "createdAt"
         from emdo.finance_budget_revisions b
        where b.workspace_id=$1 and b.book_id=$2 and b.budget_id=$3
          and ($4::integer is null or b.revision=$4)
        order by b.revision desc limit 1`,
      [context.workspaceId, bookId, budgetId, revision],
    );
    const raw = header.rows[0];
    if (!raw) return null;
    const lines = await client.query(
      `select l.budget_id as "budgetId", l.revision, l.period_id as "periodId",
              l.account_id as "accountId", l.currency, l.amount::text as amount
         from emdo.finance_budget_lines l
        where l.workspace_id=$1 and l.book_id=$2 and l.budget_id=$3 and l.revision=$4
        order by l.period_id,l.account_id,l.currency`,
      [context.workspaceId, bookId, budgetId, raw.revision],
    );
    return FinanceBudgetRevisionSchema.parse({
      schemaVersion: 1,
      workspaceId: raw.workspaceId,
      bookId: raw.bookId,
      budgetId: raw.budgetId,
      revision: Number(raw.revision),
      name: raw.name,
      functionalCurrency: raw.functionalCurrency,
      createdBy: raw.createdBy,
      createdAt: isoDateTime(raw.createdAt),
      lines: lines.rows.map((line) => ({
        budgetId: line.budgetId,
        revision: Number(line.revision),
        periodId: line.periodId,
        accountId: line.accountId,
        currency: line.currency,
        amount: textValue(line.amount),
      })),
    });
  }

  private async readPlanningActualSnapshot(
    client: DatabaseClient,
    context: WorkspaceContext,
    bookId: string,
    budget: FinanceBudgetRevision,
    asOf: string | null,
  ): Promise<{
    readonly periods: FinanceBudgetPeriodInput[];
    readonly postedAggregates: FinancePostedLedgerAggregateInput[];
    readonly snapshotAt: string;
  }> {
    // This is deliberately one SQL statement. With READ COMMITTED, separate
    // period and ledger queries can observe a concurrent post at different
    // points in time. The canonical book lock above excludes accounting posts
    // while this statement establishes its snapshot.
    const result = await client.query(
      `select bl.period_id as "periodId", p.starts_on as "startsOn",
              p.ends_on as "endsOn", bl.account_id as "accountId",
              bl.currency, a.kind as "accountKind",
              coalesce(sum(l.amount) filter (where l.side='debit'),0)::text as "debitAmount",
              coalesce(sum(l.amount) filter (where l.side='credit'),0)::text as "creditAmount",
              count(distinct j.id) filter (where l.id is not null)::int as "journalCount",
              count(l.id)::int as "lineCount",
              statement_timestamp() as "snapshotAt"
         from emdo.finance_budget_lines bl
         join emdo.finance_budget_revisions b
           on b.workspace_id=bl.workspace_id and b.book_id=bl.book_id
          and b.budget_id=bl.budget_id and b.revision=bl.revision
         join emdo.finance_periods p
           on p.workspace_id=bl.workspace_id and p.book_id=bl.book_id
          and p.id=bl.period_id
         join emdo.finance_ledger_accounts a
           on a.workspace_id=bl.workspace_id and a.book_id=bl.book_id
          and a.id=bl.account_id
         left join emdo.finance_journals j
           on j.workspace_id=bl.workspace_id and j.book_id=bl.book_id
          and j.period_id=bl.period_id and j.status='posted'
          and ($5::date is null or j.effective_on <= $5::date)
         left join emdo.finance_journal_lines l
           on l.workspace_id=j.workspace_id and l.book_id=j.book_id
          and l.journal_id=j.id and l.account_id=bl.account_id
        where bl.workspace_id=$1 and bl.book_id=$2 and bl.budget_id=$3 and bl.revision=$4
        group by bl.period_id,p.starts_on,p.ends_on,bl.account_id,bl.currency,a.kind
        order by bl.period_id,bl.account_id`,
      [context.workspaceId, bookId, budget.budgetId, budget.revision, asOf],
    );
    return {
      periods: [
        ...new Map(
          result.rows.map((row) => {
            const period = mapPeriod(row);
            return [period.periodId, period] as const;
          }),
        ).values(),
      ],
      postedAggregates: result.rows.map((row) => mapAggregate(row)),
      snapshotAt: isoDateTime(result.rows[0]?.snapshotAt ?? new Date()),
    };
  }

  private async command<T>(
    context: WorkspaceContext,
    bookId: string,
    key: string,
    operation: string,
    payload: unknown,
    work: (client: DatabaseClient, functionalCurrency: string) => Promise<T>,
    parseResult: (value: unknown) => T,
  ): Promise<T> {
    const idempotencyKey = FinancePlanningIdempotencyKeySchema.parse(key);
    const hash = commandHash(operation, bookId, payload);
    return this.transaction(context, bookId, true, async (client, currency) => {
      await client.query(
        'select pg_advisory_xact_lock(hashtextextended($1,0))',
        [
          `finance-planning:${context.workspaceId}:${context.userId}:${idempotencyKey}`,
        ],
      );
      const prior = (
        await client.query(
          `select operation,payload_hash,result from emdo.finance_command_receipts
            where workspace_id=$1 and user_id=$2 and idempotency_key=$3`,
          [context.workspaceId, context.userId, idempotencyKey],
        )
      ).rows[0];
      if (prior) {
        if (prior.operation !== operation || prior.payload_hash !== hash)
          throw new FinancePlanningPersistenceError(
            'conflict',
            'The idempotency key was already used for another planning command.',
          );
        return parseResult(prior.result);
      }
      // Serialize all revisions for one book, including different
      // idempotency keys. The grant row lock protects authority; this lock
      // protects the append-only revision counter and matches the accounting
      // mutation trigger's canonical book lock.
      await client.query(
        'select pg_advisory_xact_lock(hashtextextended($1,0))',
        [`${context.workspaceId}:${bookId}`],
      );
      const result = await work(client, currency);
      await client.query(
        `insert into emdo.finance_command_receipts
          (workspace_id,user_id,idempotency_key,operation,payload_hash,result)
         values($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          context.workspaceId,
          context.userId,
          idempotencyKey,
          operation,
          hash,
          JSON.stringify(result),
        ],
      );
      return parseResult(result);
    });
  }

  async listBudgets(
    context: WorkspaceContext,
    bookId: string,
    offset = 0,
    limit = 50,
  ) {
    const page = FinancePlanningPageQuerySchema.parse({ offset, limit });
    return this.transaction(context, bookId, false, async (client) => {
      const result = await client.query(
        `select distinct on (b.budget_id)
                b.workspace_id as "workspaceId", b.book_id as "bookId",
                b.budget_id as "budgetId", b.revision, b.name,
                b.functional_currency as "functionalCurrency",
                b.created_by as "createdBy", b.created_at as "createdAt"
           from emdo.finance_budget_revisions b
          where b.workspace_id=$1 and b.book_id=$2
          order by b.budget_id,b.revision desc`,
        [context.workspaceId, bookId],
      );
      const rows = [...result.rows]
        .sort((left, right) =>
          textValue(left.budgetId).localeCompare(textValue(right.budgetId)),
        )
        .slice(page.offset, page.offset + page.limit + 1)
        .map((row) =>
          FinanceBudgetSummarySchema.parse({
            schemaVersion: 1,
            workspaceId: row.workspaceId,
            bookId: row.bookId,
            budgetId: row.budgetId,
            revision: Number(row.revision),
            name: row.name,
            functionalCurrency: row.functionalCurrency,
            createdBy: row.createdBy,
            createdAt: isoDateTime(row.createdAt),
          }),
        );
      return FinanceBudgetListSchema.parse({
        budgets: rows.slice(0, page.limit),
        nextOffset: rows.length > page.limit ? page.offset + page.limit : null,
      });
    });
  }

  async getBudget(
    context: WorkspaceContext,
    bookId: string,
    budgetId: string,
    revision?: number,
  ) {
    UuidSchema.parse(budgetId);
    const selectedRevision =
      revision === undefined
        ? null
        : FinancePlanningRevisionSchema.parse(revision);
    return this.transaction(context, bookId, false, async (client) =>
      this.readBudget(client, context, bookId, budgetId, selectedRevision),
    );
  }

  /**
   * Finance v2 accounting mutations acquire this same lock in their trigger.
   * A planning read that needs one coherent posted-ledger statement waits for
   * an in-flight post before taking its statement snapshot.
   */
  private lockBook(
    client: DatabaseClient,
    context: WorkspaceContext,
    bookId: string,
  ) {
    return client.query(
      'select pg_advisory_xact_lock(hashtextextended($1,0))',
      [`${context.workspaceId}:${bookId}`],
    );
  }

  async saveBudget(
    context: WorkspaceContext,
    bookId: string,
    key: string,
    raw: unknown,
  ) {
    const input = SaveFinanceBudgetSchema.parse(raw);
    const budgetId = input.budgetId ?? randomUUID();
    return this.command(
      context,
      bookId,
      key,
      'finance-planning.budget.save',
      // Keep generated identifiers out of the request hash. A retried request
      // with the same key must replay the first generated budget id.
      input,
      async (client, functionalCurrency) => {
        if (input.lines.some((line) => line.currency !== functionalCurrency))
          throw new FinancePlanningPersistenceError(
            'invalid-input',
            'Budget lines must use the book functional currency.',
          );
        const existing = await client.query(
          `select coalesce(max(revision),0)::int as revision
             from emdo.finance_budget_revisions
            where workspace_id=$1 and book_id=$2 and budget_id=$3`,
          [context.workspaceId, bookId, budgetId],
        );
        const currentRevision = Number(existing.rows[0]?.revision ?? 0);
        if (
          input.expectedRevision !== undefined &&
          input.expectedRevision !== currentRevision
        )
          throw new FinancePlanningPersistenceError(
            'conflict',
            'The budget revision changed. Refresh before saving.',
          );
        const revision = currentRevision + 1;
        const periods = await client.query(
          `select id from emdo.finance_periods
            where workspace_id=$1 and book_id=$2 and id = any($3::uuid[])`,
          [
            context.workspaceId,
            bookId,
            input.lines.map((line) => line.periodId),
          ],
        );
        if (
          periods.rows.length !==
          new Set(input.lines.map((line) => line.periodId)).size
        )
          throw new FinancePlanningPersistenceError(
            'invalid-input',
            'Every budget period must belong to the selected book.',
          );
        const accounts = await client.query(
          `select id from emdo.finance_ledger_accounts
            where workspace_id=$1 and book_id=$2 and id = any($3::uuid[])`,
          [
            context.workspaceId,
            bookId,
            input.lines.map((line) => line.accountId),
          ],
        );
        if (
          accounts.rows.length !==
          new Set(input.lines.map((line) => line.accountId)).size
        )
          throw new FinancePlanningPersistenceError(
            'invalid-input',
            'Every budget account must belong to the selected book.',
          );
        await client.query(
          `insert into emdo.finance_budget_revisions
            (workspace_id,book_id,budget_id,revision,name,functional_currency,created_by)
           values($1,$2,$3,$4,$5,$6,$7)`,
          [
            context.workspaceId,
            bookId,
            budgetId,
            revision,
            input.name,
            functionalCurrency,
            context.userId,
          ],
        );
        for (const line of input.lines)
          await client.query(
            `insert into emdo.finance_budget_lines
              (workspace_id,book_id,budget_id,revision,period_id,account_id,currency,amount)
             values($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              context.workspaceId,
              bookId,
              budgetId,
              revision,
              line.periodId,
              line.accountId,
              line.currency,
              line.amount,
            ],
          );
        const saved = await this.readBudget(
          client,
          context,
          bookId,
          budgetId,
          revision,
        );
        if (!saved)
          throw new FinancePlanningPersistenceError(
            'unavailable',
            'Saved budget unavailable.',
          );
        return saved;
      },
      (value) => FinanceBudgetRevisionSchema.parse(value),
    );
  }

  async budgetVsActuals(
    context: WorkspaceContext,
    bookId: string,
    budgetId: string,
    revision?: number,
  ) {
    UuidSchema.parse(budgetId);
    const selectedRevision =
      revision === undefined
        ? null
        : FinancePlanningRevisionSchema.parse(revision);
    return this.transaction(context, bookId, false, async (client) => {
      await this.lockBook(client, context, bookId);
      const budget = await this.readBudget(
        client,
        context,
        bookId,
        budgetId,
        selectedRevision,
      );
      if (!budget)
        throw new FinancePlanningPersistenceError(
          'unavailable',
          'Requested budget is unavailable.',
        );
      const source = await this.readPlanningActualSnapshot(
        client,
        context,
        bookId,
        budget,
        null,
      );
      return deriveFinanceBudgetVsActuals({
        budget,
        periods: source.periods,
        postedAggregates: source.postedAggregates,
        snapshotAt: source.snapshotAt,
      });
    });
  }

  /** Reads one immutable automation result through the current book grant. */
  async getAutomationResult(
    context: WorkspaceContext,
    bookId: string,
    resultId: string,
  ) {
    UuidSchema.parse(resultId);
    return this.transaction(context, bookId, false, async (client) => {
      const row = (
        await client.query(
          `select id,
                  workspace_id as "workspaceId",
                  book_id as "bookId",
                  automation_run_id as "automationRunId",
                  schema_version as "schemaVersion",
                  capability,
                  budget_id as "budgetId",
                  budget_revision as "budgetRevision",
                  snapshot_at as "snapshotAt",
                  payload,
                  source_lineage as "sourceLineage",
                  source_hash as "sourceHash",
                  encode(
                    sha256(
                      convert_to(
                        jsonb_build_object('payload', payload, 'lineage', source_lineage)::text,
                        'UTF8'
                      )
                    ),
                    'hex'
                  ) = source_hash as "sourceHashValid"
             from emdo.finance_planning_results
            where workspace_id=$1 and book_id=$2 and id=$3`,
          [context.workspaceId, bookId, resultId],
        )
      ).rows[0];
      if (!row) return null;
      const { sourceHashValid, ...resultRow } = row;
      if (sourceHashValid !== true)
        throw new FinancePlanningPersistenceError(
          'conflict',
          'finance-planning-result-integrity-invalid',
        );
      return FinancePlanningAutomationResultSchema.parse({
        ...resultRow,
        snapshotAt: isoDateTime(row.snapshotAt),
      });
    });
  }

  private async readForecast(
    client: DatabaseClient,
    context: WorkspaceContext,
    bookId: string,
    forecastId: string,
    revision: number | null,
  ): Promise<FinanceForecastSnapshot | null> {
    const result = await client.query(
      `select f.workspace_id as "workspaceId", f.book_id as "bookId",
              f.forecast_id as "forecastId", f.revision,
              f.budget_id as "budgetId", f.budget_revision as "budgetRevision",
              f.functional_currency as "functionalCurrency", f.as_of as "asOf",
              f.opening_status as "openingStatus", f.opening_amount::text as "openingAmount",
              f.opening_currency as "openingCurrency",
              f.opening_source_reference as "openingSourceReference",
              f.opening_reviewed_by as "openingReviewedBy",
              f.opening_reviewed_at as "openingReviewedAt",
              f.future_assumption_status as "futureAssumptionStatus", f.labels,
              f.created_by as "createdBy", f.created_at as "createdAt"
         from emdo.finance_forecast_snapshots f
        where f.workspace_id=$1 and f.book_id=$2 and f.forecast_id=$3
          and ($4::integer is null or f.revision=$4)
        order by f.revision desc limit 1`,
      [context.workspaceId, bookId, forecastId, revision],
    );
    const header = result.rows[0];
    if (!header) return null;
    const lines = await client.query(
      `select l.period_id as "periodId", p.starts_on as "periodStart",
              p.ends_on as "periodEnd", l.account_id as "accountId",
              a.kind as "accountKind", l.currency, l.budget_amount::text as "budgetAmount",
              l.posted_actual_amount::text as "postedActualAmount",
              l.forecast_amount::text as "forecastAmount", l.basis,
              l.actual_sign_basis as "actualSignBasis", l.label
         from emdo.finance_forecast_lines l
         join emdo.finance_periods p
           on p.workspace_id=l.workspace_id and p.book_id=l.book_id and p.id=l.period_id
         join emdo.finance_ledger_accounts a
           on a.workspace_id=l.workspace_id and a.book_id=l.book_id and a.id=l.account_id
        where l.workspace_id=$1 and l.book_id=$2 and l.forecast_id=$3 and l.revision=$4
        order by l.period_id,l.account_id,l.currency`,
      [context.workspaceId, bookId, forecastId, header.revision],
    );
    const assumptions = await client.query(
      `select a.forecast_id as "forecastId", a.revision,
              a.period_id as "periodId", a.account_id as "accountId", a.currency,
              a.amount::text as amount, a.label, a.source_reference as "sourceReference",
              a.reviewed_by as "reviewedBy", a.reviewed_at as "reviewedAt"
         from emdo.finance_forecast_assumptions a
        where a.workspace_id=$1 and a.book_id=$2 and a.forecast_id=$3 and a.revision=$4
        order by a.period_id,a.account_id,a.currency`,
      [context.workspaceId, bookId, forecastId, header.revision],
    );
    const opening = mapOpening(rowObject(header));
    return FinanceForecastSnapshotSchema.parse({
      schemaVersion: 1,
      workspaceId: header.workspaceId,
      bookId: header.bookId,
      forecastId: header.forecastId,
      revision: Number(header.revision),
      budgetId: header.budgetId,
      budgetRevision: Number(header.budgetRevision),
      functionalCurrency: header.functionalCurrency,
      asOf: dateValue(header.asOf),
      snapshotAt: isoDateTime(header.createdAt),
      openingBalance: opening,
      futureAssumptionsStatus: header.futureAssumptionStatus,
      labels: header.labels,
      actualSource: {
        kind: 'authoritative-posted-ledger',
        coverage: 'posted-journals-through-as-of',
        signBasis: 'account-kind',
      },
      assumptionsSource: 'reviewed-inputs-only',
      createdBy: header.createdBy,
      createdAt: isoDateTime(header.createdAt),
      lines: lines.rows.map((line) => ({
        periodId: line.periodId,
        periodStart: dateValue(line.periodStart),
        periodEnd: dateValue(line.periodEnd),
        accountId: line.accountId,
        accountKind: line.accountKind,
        currency: line.currency,
        budgetAmount: textValue(line.budgetAmount),
        postedActualAmount: textValue(line.postedActualAmount),
        forecastAmount:
          line.forecastAmount === null ? null : textValue(line.forecastAmount),
        basis: line.basis,
        actualSignBasis: line.actualSignBasis,
        label: line.label,
      })),
      assumptions: assumptions.rows.map((assumption) => ({
        forecastId: assumption.forecastId,
        revision: Number(assumption.revision),
        periodId: assumption.periodId,
        accountId: assumption.accountId,
        currency: assumption.currency,
        amount: textValue(assumption.amount),
        label: assumption.label,
        sourceReference: assumption.sourceReference,
        reviewedBy: assumption.reviewedBy,
        reviewedAt: isoDateTime(assumption.reviewedAt),
      })),
    });
  }

  async listForecasts(
    context: WorkspaceContext,
    bookId: string,
    offset = 0,
    limit = 50,
  ) {
    const page = FinancePlanningPageQuerySchema.parse({ offset, limit });
    return this.transaction(context, bookId, false, async (client) => {
      const result = await client.query(
        `select f.workspace_id as "workspaceId", f.book_id as "bookId",
                f.forecast_id as "forecastId", f.revision,
                f.budget_id as "budgetId", f.budget_revision as "budgetRevision",
                f.functional_currency as "functionalCurrency", f.as_of as "asOf",
                f.future_assumption_status as "futureAssumptionsStatus", f.labels,
                f.created_by as "createdBy", f.created_at as "createdAt"
           from (
             select distinct on (s.forecast_id)
                    s.workspace_id, s.book_id, s.forecast_id, s.revision,
                    s.budget_id, s.budget_revision, s.functional_currency,
                    s.as_of, s.future_assumption_status, s.labels,
                    s.created_by, s.created_at
               from emdo.finance_forecast_snapshots s
              where s.workspace_id=$1 and s.book_id=$2
              order by s.forecast_id,s.revision desc
           ) f
          order by f.created_at desc,f.forecast_id
          offset $3 limit $4`,
        [context.workspaceId, bookId, page.offset, page.limit + 1],
      );
      const forecasts = result.rows.map((row) =>
        FinanceForecastSummarySchema.parse({
          schemaVersion: 1,
          workspaceId: row.workspaceId,
          bookId: row.bookId,
          forecastId: row.forecastId,
          revision: Number(row.revision),
          budgetId: row.budgetId,
          budgetRevision: Number(row.budgetRevision),
          functionalCurrency: row.functionalCurrency,
          asOf: dateValue(row.asOf),
          snapshotAt: isoDateTime(row.createdAt),
          futureAssumptionsStatus: row.futureAssumptionsStatus,
          labels: row.labels,
          actualSource: {
            kind: 'authoritative-posted-ledger',
            coverage: 'posted-journals-through-as-of',
            signBasis: 'account-kind',
          },
          assumptionsSource: 'reviewed-inputs-only',
          createdBy: row.createdBy,
          createdAt: isoDateTime(row.createdAt),
        }),
      );
      return FinanceForecastListSchema.parse({
        forecasts: forecasts.slice(0, page.limit),
        nextOffset:
          forecasts.length > page.limit ? page.offset + page.limit : null,
      });
    });
  }

  async getForecast(
    context: WorkspaceContext,
    bookId: string,
    forecastId: string,
    revision?: number,
  ) {
    UuidSchema.parse(forecastId);
    const selectedRevision =
      revision === undefined
        ? null
        : FinancePlanningRevisionSchema.parse(revision);
    return this.transaction(context, bookId, false, async (client) =>
      this.readForecast(client, context, bookId, forecastId, selectedRevision),
    );
  }

  async saveForecast(
    context: WorkspaceContext,
    bookId: string,
    key: string,
    raw: unknown,
  ) {
    const input = SaveFinanceForecastSchema.parse(raw);
    const forecastId = input.forecastId ?? randomUUID();
    return this.command(
      context,
      bookId,
      key,
      'finance-planning.forecast.save',
      // Keep generated identifiers out of the request hash. A retried request
      // with the same key must replay the first generated forecast id.
      input,
      async (client, functionalCurrency) => {
        if (
          input.openingBalance.status === 'available' &&
          input.openingBalance.currency !== functionalCurrency
        )
          throw new FinancePlanningPersistenceError(
            'invalid-input',
            'The opening balance must use the book functional currency.',
          );
        if (
          input.openingBalance.status === 'available' &&
          input.openingBalance.reviewedBy !== context.userId
        )
          throw new FinancePlanningPersistenceError(
            'authorization-revoked',
            'Opening balances must be reviewed by the authenticated user.',
          );
        if (
          input.assumptions.some(
            (assumption) => assumption.currency !== functionalCurrency,
          )
        )
          throw new FinancePlanningPersistenceError(
            'invalid-input',
            'Forecast assumptions must use the book functional currency.',
          );
        if (
          input.assumptions.some(
            (assumption) => assumption.reviewedBy !== context.userId,
          )
        )
          throw new FinancePlanningPersistenceError(
            'authorization-revoked',
            'Forecast assumptions must be reviewed by the authenticated user.',
          );
        const budget = await this.readBudget(
          client,
          context,
          bookId,
          input.budgetId,
          input.budgetRevision,
        );
        if (!budget)
          throw new FinancePlanningPersistenceError(
            'invalid-input',
            'The selected budget revision is unavailable.',
          );
        const existing = await client.query(
          `select coalesce(max(revision),0)::int as revision
             from emdo.finance_forecast_snapshots
            where workspace_id=$1 and book_id=$2 and forecast_id=$3`,
          [context.workspaceId, bookId, forecastId],
        );
        const currentRevision = Number(existing.rows[0]?.revision ?? 0);
        if (
          input.expectedRevision !== undefined &&
          input.expectedRevision !== currentRevision
        )
          throw new FinancePlanningPersistenceError(
            'conflict',
            'The forecast revision changed. Refresh before saving.',
          );
        const revision = currentRevision + 1;
        const source = await this.readPlanningActualSnapshot(
          client,
          context,
          bookId,
          budget,
          input.asOf,
        );
        const forecast = buildFinanceForecast({
          budget,
          periods: source.periods,
          postedAggregates: source.postedAggregates,
          asOf: input.asOf,
          openingBalance: input.openingBalance,
          assumptions: input.assumptions,
          forecastId,
          revision,
          createdBy: context.userId,
          snapshotAt: source.snapshotAt,
        });
        const opening = input.openingBalance;
        await client.query(
          `insert into emdo.finance_forecast_snapshots
            (workspace_id,book_id,forecast_id,revision,budget_id,budget_revision,
             functional_currency,as_of,opening_status,opening_amount,opening_currency,
             opening_source_reference,opening_reviewed_by,opening_reviewed_at,
             future_assumption_status,labels,created_by,created_at)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18)`,
          [
            context.workspaceId,
            bookId,
            forecastId,
            revision,
            budget.budgetId,
            budget.revision,
            functionalCurrency,
            input.asOf,
            opening.status,
            opening.status === 'available' ? opening.amount : null,
            opening.status === 'available' ? opening.currency : null,
            opening.status === 'available' ? opening.sourceReference : null,
            opening.status === 'available' ? opening.reviewedBy : null,
            opening.status === 'available' ? opening.reviewedAt : null,
            forecast.futureAssumptionsStatus,
            JSON.stringify(forecast.labels),
            context.userId,
            source.snapshotAt,
          ],
        );
        for (const line of forecast.lines) {
          await client.query(
            `insert into emdo.finance_forecast_lines
              (workspace_id,book_id,forecast_id,revision,period_id,account_id,currency,
               budget_amount,posted_actual_amount,forecast_amount,basis,actual_sign_basis,label)
             values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [
              context.workspaceId,
              bookId,
              forecastId,
              revision,
              line.periodId,
              line.accountId,
              line.currency,
              line.budgetAmount,
              line.postedActualAmount,
              line.forecastAmount,
              line.basis,
              line.actualSignBasis,
              line.label,
            ],
          );
        }
        for (const assumption of forecast.assumptions)
          await client.query(
            `insert into emdo.finance_forecast_assumptions
              (workspace_id,book_id,forecast_id,revision,period_id,account_id,currency,
               amount,label,source_reference,reviewed_by,reviewed_at)
             values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [
              context.workspaceId,
              bookId,
              forecastId,
              revision,
              assumption.periodId,
              assumption.accountId,
              assumption.currency,
              assumption.amount,
              assumption.label,
              assumption.sourceReference,
              assumption.reviewedBy,
              assumption.reviewedAt,
            ],
          );
        const saved = await this.readForecast(
          client,
          context,
          bookId,
          forecastId,
          revision,
        );
        if (!saved)
          throw new FinancePlanningPersistenceError(
            'unavailable',
            'Saved forecast unavailable.',
          );
        return saved;
      },
      (value) => FinanceForecastSnapshotSchema.parse(value),
    );
  }
}

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  InvestmentReconciliationCorrectiveRecordListSchema,
  CreateInvestmentReconciliationSchema,
  ResolveInvestmentReconciliationSchema,
  ReopenInvestmentReconciliationSchema,
  PreviewInvestmentReconciliationSchema,
  InvestmentReconciliationComparisonSchema,
  InvestmentReconciliationCaseSchema,
  InvestmentReconciliationEventSchema,
  InvestmentReconciliationListSchema,
  InvestmentReconciliationPreviewSchema,
  PreviewInvestmentValuationSchema,
  FinancePlanningIdempotencyKeySchema,
  UuidSchema,
  WorkspaceContextSchema,
  type InvestmentReconciliationComparison,
  type WorkspaceContext,
} from '@emdo/contracts';
import {
  canonicalInvestmentSnapshot,
  investmentReconciliationEffectiveStatus,
} from '@emdo/domains/finance';
import { withDurableTransaction } from './durable/scoped-transaction.js';
import { loadInvestmentValuationSources } from './finance-investment-sources.js';
import type { DatabaseClient, DatabasePool } from './scoped-repository.js';

export class FinanceInvestmentReconciliationPersistenceError extends Error {
  constructor(
    readonly code:
      'authorization-revoked' | 'invalid-input' | 'conflict' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'FinanceInvestmentReconciliationPersistenceError';
  }
}
const fail = (message: string): never => {
  throw new FinanceInvestmentReconciliationPersistenceError(
    'conflict',
    message,
  );
};
const object = (v: unknown) => z.record(z.string(), z.unknown()).parse(v);
const hash = (v: unknown) =>
  createHash('sha256').update(canonicalInvestmentSnapshot(v)).digest('hex');

/** PostgreSQL numeric values must never pass through binary floating point.
 * Node 24's JSON reviver source preserves the original JSON numeric token,
 * including exponent notation, without touching quoted strings or structure.
 */
const exactSnapshotJson = (text: string): unknown => {
  const parse = JSON.parse as (
    text: string,
    reviver: (
      key: string,
      value: unknown,
      context: { source?: string },
    ) => unknown,
  ) => unknown;
  return parse(text, (_key, value, context) => {
    if (typeof value !== 'number') return value;
    if (context.source === undefined)
      throw new Error('Exact JSON numeric source is unavailable');
    return context.source;
  });
};

export class FinanceInvestmentReconciliationRepository {
  constructor(private readonly pool: DatabasePool) {}
  async checkReady(): Promise<boolean> {
    const c = await this.pool.connect();
    try {
      const row = (
        await c.query(`select current_user='emdo_app' and not r.rolsuper and not r.rolbypassrls as role_ready,
        (select count(*)=2 and bool_and(relrowsecurity and relforcerowsecurity) from pg_class where oid in ('emdo.finance_investment_reconciliation_cases'::regclass,'emdo.finance_investment_reconciliation_events'::regclass)) as rls_ready,
        (select count(*)=3 from pg_trigger where not tgisinternal and tgenabled='O' and tgname in ('investment_reconciliation_history_required','b_validate_investment_reconciliation_event','immutable_investment_reconciliation_events')) as guards_ready
        from pg_roles r where rolname=current_user`)
      ).rows[0];
      return (
        row?.role_ready === true &&
        row.rls_ready === true &&
        row.guards_ready === true
      );
    } catch {
      return false;
    } finally {
      c.release();
    }
  }
  private transaction<T>(
    raw: WorkspaceContext,
    bookId: string,
    write: boolean,
    work: (c: DatabaseClient) => Promise<T>,
  ) {
    const context = WorkspaceContextSchema.parse(raw);
    UuidSchema.parse(bookId);
    return withDurableTransaction(
      this.pool,
      { ...context, householdId: context.workspaceId },
      { householdId: context.workspaceId },
      async (c) => {
        const auth = await c.query(
          'select emdo.lock_finance_book_grant($1,$2) as allowed',
          [context.workspaceId, bookId],
        );
        if (auth.rows[0]?.allowed !== true)
          throw new FinanceInvestmentReconciliationPersistenceError(
            'authorization-revoked',
            'Current book access is required',
          );
        const roles = write
          ? ['administrator', 'preparer', 'approver']
          : ['administrator', 'preparer', 'approver', 'viewer'];
        const permission = await c.query(
          'select emdo.finance_book_access($1,$2,$3::text[]) as allowed',
          [context.workspaceId, bookId, roles],
        );
        if (permission.rows[0]?.allowed !== true)
          throw new FinanceInvestmentReconciliationPersistenceError(
            'authorization-revoked',
            'Current book role cannot perform this operation',
          );
        await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
          `${context.workspaceId}:${bookId}`,
        ]);
        return work(c);
      },
    );
  }
  private async comparison(
    c: DatabaseClient,
    context: WorkspaceContext,
    bookId: string,
    input: unknown,
  ) {
    const data = PreviewInvestmentReconciliationSchema.parse(input);
    const row = (
      await c.query(
        'select input_snapshot,result,as_of::text as as_of from emdo.finance_valuation_runs where workspace_id=$1 and book_id=$2 and id=$3',
        [context.workspaceId, bookId, data.valuationRunId],
      )
    ).rows[0];
    if (!row)
      throw new FinanceInvestmentReconciliationPersistenceError(
        'unavailable',
        'Saved valuation is unavailable',
      );
    const snapshot = object(row.input_snapshot),
      result = object(row.result);
    const sources = z
      .array(z.record(z.string(), z.unknown()))
      .parse(snapshot.positions)
      .filter(
        (p) =>
          object(p.selected).observedPositionId === data.observedPositionId,
      );
    const comparisons = z
      .array(z.record(z.string(), z.unknown()))
      .parse(result.reconciliations)
      .filter((p) => p.observedPositionId === data.observedPositionId);
    if (sources.length !== 1 || comparisons.length !== 1)
      fail('Observed position must identify exactly one saved comparison');
    const source = sources[0]!,
      comparison = comparisons[0]!,
      selected = object(source.selected);
    return InvestmentReconciliationComparisonSchema.parse({
      ...data,
      comparisonHash: hash({
        valuationRunId: data.valuationRunId,
        valuationInputHash: result.inputHash,
        source,
        comparison,
      }),
      valuationInputHash: result.inputHash,
      financialAccountId: selected.financialAccountId,
      instrumentId: selected.instrumentId,
      asOf: row.as_of,
      evidenceId: comparison.evidenceId,
      sourceRow: comparison.sourceRow,
      observedQuantity: comparison.observedQuantity,
      calculatedQuantity: comparison.calculatedQuantity,
      difference: comparison.difference,
      status: comparison.status,
      sourceSnapshot: source,
    });
  }
  private async current(
    c: DatabaseClient,
    context: WorkspaceContext,
    bookId: string,
    comparison: InvestmentReconciliationComparison,
  ) {
    const selected =
      PreviewInvestmentValuationSchema.shape.positions.element.parse(
        comparison.sourceSnapshot.selected,
      );
    try {
      const now = await loadInvestmentValuationSources(
        c,
        context,
        bookId,
        selected,
        comparison.asOf,
      );
      return (
        canonicalInvestmentSnapshot(now) ===
        canonicalInvestmentSnapshot(comparison.sourceSnapshot)
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('finance-investment-')
      )
        return false;
      throw error;
    }
  }
  async preview(context: WorkspaceContext, bookId: string, input: unknown) {
    return this.transaction(context, bookId, false, async (c) => {
      const comparison = await this.comparison(c, context, bookId, input);
      return InvestmentReconciliationPreviewSchema.parse({
        workspaceId: context.workspaceId,
        bookId,
        comparison,
        sourcesCurrent: await this.current(c, context, bookId, comparison),
      });
    });
  }
  private async read(
    c: DatabaseClient,
    context: WorkspaceContext,
    bookId: string,
    id: string,
  ) {
    const row = (
      await c.query(
        'select id,revision,status from emdo.finance_investment_reconciliation_cases where workspace_id=$1 and book_id=$2 and id=$3',
        [context.workspaceId, bookId, id],
      )
    ).rows[0];
    if (!row) return null;
    const history = (
      await c.query(
        "select event-'correctiveRecordSnapshots' as event,(event->'correctiveRecordSnapshots')::text as corrective_snapshots from emdo.finance_investment_reconciliation_events where workspace_id=$1 and book_id=$2 and case_id=$3 order by revision",
        [context.workspaceId, bookId, id],
      )
    ).rows.map((r) =>
      InvestmentReconciliationEventSchema.parse({
        ...object(r.event),
        correctiveRecordSnapshots: exactSnapshotJson(
          z.string().parse(r.corrective_snapshots),
        ),
      }),
    );
    const latest = history.at(-1);
    if (!latest || latest.revision !== row.revision)
      fail('Reconciliation history is incomplete');
    const sourcesCurrent = await this.current(
      c,
      context,
      bookId,
      latest!.comparison,
    );
    const status = z.enum(['open', 'resolved']).parse(row.status);
    return InvestmentReconciliationCaseSchema.parse({
      schemaVersion: 1,
      id,
      workspaceId: context.workspaceId,
      bookId,
      revision: row.revision,
      status,
      effectiveStatus: investmentReconciliationEffectiveStatus(
        status,
        sourcesCurrent,
      ),
      sourcesCurrent,
      comparison: latest!.comparison,
      history,
      accountingEffect: 'none',
    });
  }
  async get(context: WorkspaceContext, bookId: string, id: string) {
    UuidSchema.parse(id);
    return this.transaction(context, bookId, false, (c) =>
      this.read(c, context, bookId, id),
    );
  }
  async list(
    context: WorkspaceContext,
    bookId: string,
    offset = 0,
    limit = 50,
  ) {
    z.number().int().min(0).max(1000000).parse(offset);
    z.number().int().min(1).max(100).parse(limit);
    return this.transaction(context, bookId, false, async (c) => {
      const rows = (
        await c.query(
          'select id from emdo.finance_investment_reconciliation_cases where workspace_id=$1 and book_id=$2 order by created_at desc,id limit $3 offset $4',
          [context.workspaceId, bookId, limit, offset],
        )
      ).rows;
      const total = (
        await c.query(
          'select count(*)::int as total from emdo.finance_investment_reconciliation_cases where workspace_id=$1 and book_id=$2',
          [context.workspaceId, bookId],
        )
      ).rows[0]?.total;
      const items = [];
      for (const row of rows)
        items.push(await this.read(c, context, bookId, String(row.id)));
      return InvestmentReconciliationListSchema.parse({
        items,
        total,
        offset,
        limit,
      });
    });
  }
  async correctiveRecords(
    context: WorkspaceContext,
    bookId: string,
    caseId: string,
    offset = 0,
    limit = 50,
  ) {
    UuidSchema.parse(caseId);
    z.number().int().min(0).max(1000000).parse(offset);
    z.number().int().min(1).max(100).parse(limit);
    return this.transaction(context, bookId, false, async (c) => {
      const item = await this.read(c, context, bookId, caseId);
      if (!item)
        throw new FinanceInvestmentReconciliationPersistenceError(
          'unavailable',
          'Reconciliation case unavailable',
        );
      const query = `with eligible as (
        select 'movement'::text kind,id,('Movement: '||source_reference)::text label,effective_on as effective_on,ARRAY[]::uuid[] as evidence_ids from emdo.finance_investment_movements where workspace_id=$1 and book_id=$2 and financial_account_id=$3 and instrument_id=$4
        union all select 'opening',id,'Opening: '||source_reference,as_of,ARRAY[evidence_id] from emdo.finance_investment_openings where workspace_id=$1 and book_id=$2 and financial_account_id=$3 and instrument_id=$4
        union all select 'stock-split',id,'Stock split: '||source_reference,effective_on,ARRAY[evidence_id] from emdo.finance_investment_corporate_actions where workspace_id=$1 and book_id=$2 and financial_account_id=$3 and instrument_id=$4 and status='committed'
        union all select 'cash-dividend',id,'Cash dividend: '||source_reference,payable_on,ARRAY[evidence_id] from emdo.finance_investment_cash_dividends where workspace_id=$1 and book_id=$2 and financial_account_id=$3 and instrument_id=$4 and status='committed'
        union all select 'split-settlement',s.id,'Split settlement: '||a.source_reference,a.effective_on,ARRAY(select e.evidence_id from emdo.finance_investment_corporate_action_settlement_evidence e where e.workspace_id=s.workspace_id and e.book_id=s.book_id and e.settlement_id=s.id order by e.evidence_id) from emdo.finance_investment_corporate_action_settlements s join emdo.finance_investment_corporate_actions a on a.workspace_id=s.workspace_id and a.book_id=s.book_id and a.id=s.action_id where s.workspace_id=$1 and s.book_id=$2 and a.financial_account_id=$3 and a.instrument_id=$4 and a.status='committed'
      ) select (select count(*)::int from eligible) total, coalesce((select jsonb_agg(to_jsonb(p)) from (select kind,id,left(label,300) label,effective_on::text as "effectiveOn",evidence_ids as "evidenceIds" from eligible order by effective_on desc,kind,id limit $5 offset $6)p),'[]'::jsonb) items`;
      const row = (
        await c.query(query, [
          context.workspaceId,
          bookId,
          item!.comparison.financialAccountId,
          item!.comparison.instrumentId,
          limit,
          offset,
        ])
      ).rows[0];
      return InvestmentReconciliationCorrectiveRecordListSchema.parse({
        ...row,
        offset,
        limit,
      });
    });
  }
  private async command(
    context: WorkspaceContext,
    bookId: string,
    key: string,
    operation: string,
    payload: unknown,
    work: (c: DatabaseClient) => Promise<string>,
  ) {
    FinancePlanningIdempotencyKeySchema.parse(key);
    const payloadHash = hash({ bookId, operation, payload });
    return this.transaction(context, bookId, true, async (c) => {
      await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
        `investment-reconciliation:${context.workspaceId}:${context.userId}:${key}`,
      ]);
      const prior = (
        await c.query(
          'select operation,payload_hash,result from emdo.finance_command_receipts where workspace_id=$1 and user_id=$2 and idempotency_key=$3',
          [context.workspaceId, context.userId, key],
        )
      ).rows[0];
      if (prior) {
        if (prior.operation !== operation || prior.payload_hash !== payloadHash)
          fail('Idempotency key already used');
        const receipt = InvestmentReconciliationCaseSchema.parse(prior.result);
        const current = await this.read(c, context, bookId, receipt.id);
        if (!current) fail('Reconciliation receipt target is unavailable');
        return current;
      }
      const id = await work(c);
      const result = await this.read(c, context, bookId, id);
      if (!result) fail('Case disappeared');
      await c.query(
        'insert into emdo.finance_command_receipts(workspace_id,user_id,idempotency_key,operation,payload_hash,result) values($1,$2,$3,$4,$5,$6::jsonb)',
        [
          context.workspaceId,
          context.userId,
          key,
          operation,
          payloadHash,
          JSON.stringify(result),
        ],
      );
      return result;
    });
  }
  private async append(
    c: DatabaseClient,
    context: WorkspaceContext,
    bookId: string,
    id: string,
    raw: unknown,
    rawCorrectiveSnapshots = '[]',
  ) {
    const event = InvestmentReconciliationEventSchema.parse(raw);
    await c.query(
      "insert into emdo.finance_investment_reconciliation_events(workspace_id,book_id,case_id,revision,event) values($1,$2,$3,$4,jsonb_set($5::jsonb,'{correctiveRecordSnapshots}',$6::jsonb))",
      [
        context.workspaceId,
        bookId,
        id,
        event.revision,
        JSON.stringify(event),
        rawCorrectiveSnapshots,
      ],
    );
  }
  create(
    context: WorkspaceContext,
    bookId: string,
    key: string,
    input: unknown,
  ) {
    const data = CreateInvestmentReconciliationSchema.parse(input);
    return this.command(
      context,
      bookId,
      key,
      'investment.reconciliation.create',
      data,
      async (c) => {
        const comparison = await this.comparison(c, context, bookId, {
          valuationRunId: data.valuationRunId,
          observedPositionId: data.observedPositionId,
        });
        if (
          comparison.comparisonHash !== data.expectedComparisonHash ||
          comparison.status === 'matched'
        )
          fail('Review a differing or unavailable saved comparison');
        if (!(await this.current(c, context, bookId, comparison)))
          fail('Saved valuation sources changed; save a new valuation');
        const duplicate = (
          await c.query(
            "select 1 from emdo.finance_investment_reconciliation_events where workspace_id=$1 and book_id=$2 and event->'comparison'->>'comparisonHash'=$3",
            [context.workspaceId, bookId, comparison.comparisonHash],
          )
        ).rows[0];
        if (duplicate) fail('This comparison already belongs to a case');
        const id = randomUUID();
        await c.query(
          "insert into emdo.finance_investment_reconciliation_cases(id,workspace_id,book_id,revision,status) values($1,$2,$3,1,'open')",
          [id, context.workspaceId, bookId],
        );
        await this.append(c, context, bookId, id, {
          revision: 1,
          kind: 'created',
          comparison,
          resolution: null,
          evidenceSnapshots: [],
          correctiveRecordSnapshots: [],
          reason: null,
          createdBy: context.userId,
          createdAt: new Date().toISOString(),
        });
        return id;
      },
    );
  }
  resolve(
    context: WorkspaceContext,
    bookId: string,
    id: string,
    key: string,
    input: unknown,
  ) {
    UuidSchema.parse(id);
    const data = ResolveInvestmentReconciliationSchema.parse(input);
    return this.command(
      context,
      bookId,
      key,
      'investment.reconciliation.resolve',
      { id, ...data },
      async (c) => {
        const prior = await this.read(c, context, bookId, id);
        if (
          !prior ||
          prior.revision !== data.expectedRevision ||
          prior.comparison.comparisonHash !== data.expectedComparisonHash ||
          prior.status !== 'open' ||
          !prior.sourcesCurrent
        )
          fail('Case changed or sources require reopening');
        const evidenceSnapshots = [];
        for (const evidenceId of new Set(data.resolution.evidenceIds)) {
          const row = (
            await c.query(
              'select id,plaintext_sha256 as "sourceDigest" from emdo.finance_book_evidence where workspace_id=$1 and book_id=$2 and id=$3',
              [context.workspaceId, bookId, evidenceId],
            )
          ).rows[0];
          if (!row) fail('Resolution evidence is unavailable in this book');
          evidenceSnapshots.push(row);
        }
        const correctiveRecordSnapshots = [];
        const rawCorrectiveSnapshots: string[] = [];
        for (const ref of data.resolution.correctiveRecords) {
          const tables = {
            movement: 'finance_investment_movements',
            opening: 'finance_investment_openings',
            'stock-split': 'finance_investment_corporate_actions',
            'cash-dividend': 'finance_investment_cash_dividends',
          } as const;
          const sql =
            ref.kind === 'split-settlement'
              ? 'select to_jsonb(r)::text as snapshot from emdo.finance_investment_corporate_action_settlements r join emdo.finance_investment_corporate_actions a on a.workspace_id=r.workspace_id and a.book_id=r.book_id and a.id=r.action_id where r.workspace_id=$1 and r.book_id=$2 and r.id=$3 and a.financial_account_id=$4 and a.instrument_id=$5'
              : `select to_jsonb(r)::text as snapshot from emdo.${tables[ref.kind]} r where workspace_id=$1 and book_id=$2 and id=$3 and financial_account_id=$4 and instrument_id=$5`;
          const row = (
            await c.query(sql, [
              context.workspaceId,
              bookId,
              ref.id,
              prior!.comparison.financialAccountId,
              prior!.comparison.instrumentId,
            ])
          ).rows[0];
          if (!row)
            fail(
              'Corrective record must belong to this account and instrument',
            );
          const rawSnapshot = z.string().parse(row.snapshot);
          correctiveRecordSnapshots.push({
            kind: ref.kind,
            id: ref.id,
            snapshot: exactSnapshotJson(rawSnapshot),
          });
          // Only the database-produced JSON is embedded raw; request metadata
          // remains JSON-encoded. PostgreSQL validates equality before insertion.
          rawCorrectiveSnapshots.push(
            `{"kind":${JSON.stringify(ref.kind)},"id":${JSON.stringify(ref.id)},"snapshot":${rawSnapshot}}`,
          );
        }
        const revision = prior!.revision + 1;
        await c.query(
          "update emdo.finance_investment_reconciliation_cases set revision=$4,status='resolved' where workspace_id=$1 and book_id=$2 and id=$3",
          [context.workspaceId, bookId, id, revision],
        );
        await this.append(
          c,
          context,
          bookId,
          id,
          {
            revision,
            kind: 'resolved',
            comparison: prior!.comparison,
            resolution: data.resolution,
            evidenceSnapshots,
            correctiveRecordSnapshots,
            reason: null,
            createdBy: context.userId,
            createdAt: new Date().toISOString(),
          },
          `[${rawCorrectiveSnapshots.join(',')}]`,
        );
        return id;
      },
    );
  }
  reopen(
    context: WorkspaceContext,
    bookId: string,
    id: string,
    key: string,
    input: unknown,
  ) {
    UuidSchema.parse(id);
    const data = ReopenInvestmentReconciliationSchema.parse(input);
    return this.command(
      context,
      bookId,
      key,
      'investment.reconciliation.reopen',
      { id, ...data },
      async (c) => {
        const prior = await this.read(c, context, bookId, id);
        if (!prior || prior.revision !== data.expectedRevision)
          fail('Case revision changed');
        const comparison = await this.comparison(c, context, bookId, {
          valuationRunId: data.valuationRunId,
          observedPositionId: data.observedPositionId,
        });
        if (
          comparison.comparisonHash !== data.expectedComparisonHash ||
          !(await this.current(c, context, bookId, comparison))
        )
          fail('Replacement valuation changed');
        if (
          comparison.financialAccountId !==
            prior!.comparison.financialAccountId ||
          comparison.instrumentId !== prior!.comparison.instrumentId ||
          comparison.asOf !== prior!.comparison.asOf
        )
          fail('Replacement comparison must retain the case scope');
        if (comparison.comparisonHash === prior!.comparison.comparisonHash)
          fail('Reopening requires a new saved comparison');
        const revision = prior!.revision + 1;
        await c.query(
          "update emdo.finance_investment_reconciliation_cases set revision=$4,status='open' where workspace_id=$1 and book_id=$2 and id=$3",
          [context.workspaceId, bookId, id, revision],
        );
        await this.append(c, context, bookId, id, {
          revision,
          kind: 'reopened',
          comparison,
          resolution: null,
          evidenceSnapshots: [],
          correctiveRecordSnapshots: [],
          reason: data.reason,
          createdBy: context.userId,
          createdAt: new Date().toISOString(),
        });
        return id;
      },
    );
  }
}

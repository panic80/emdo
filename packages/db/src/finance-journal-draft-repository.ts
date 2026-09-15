import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  WorkspaceContextSchema,
  UuidSchema,
  PrepareFinanceAutomationJournalDraftSchema,
  PrepareFinanceAutomationJournalDraftResultSchema,
  FinanceAutomationJournalDraftResultSchema,
  ReviewFinanceAutomationJournalDraftSchema,
  DiscardFinanceAutomationJournalDraftSchema,
  PostFinanceAutomationJournalDraftSchema,
  type WorkspaceContext,
} from '@emdo/contracts';
import type { PostgresFinanceV2Repository } from './finance-v2-repository.js';
import type { DatabaseClient, DatabasePool } from './scoped-repository.js';
import { withDurableTransaction } from './durable/scoped-transaction.js';

export class FinanceJournalDraftPersistenceError extends Error {
  constructor(
    readonly code:
      'authorization-revoked' | 'invalid-input' | 'conflict' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'FinanceJournalDraftPersistenceError';
  }
}
const Key = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u);
const Page = z.object({
  offset: z.number().int().min(0).max(1000000),
  limit: z.number().int().min(1).max(100),
});
const List = z.strictObject({
  items: z.array(FinanceAutomationJournalDraftResultSchema).max(100),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(100),
  total: z.number().int().nonnegative(),
});
/** Browser commands run inside the authenticated scoped pool; only the worker
 * RPC can generate proposals. Posting reuses the canonical import transaction. */
export class FinanceJournalDraftRepository {
  constructor(
    private readonly pool: DatabasePool,
    private readonly finance: Pick<
      PostgresFinanceV2Repository,
      'commitNormalizedImportInTransaction'
    >,
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
    ).catch((cause: unknown) => {
      if (cause instanceof FinanceJournalDraftPersistenceError) throw cause;
      const code =
        cause instanceof Error && 'code' in cause ? String(cause.code) : '';
      if (
        ['42501', 'authorization-revoked'].includes(code) ||
        (cause instanceof Error && cause.message === 'finance-book-forbidden')
      )
        throw new FinanceJournalDraftPersistenceError(
          'authorization-revoked',
          'Current journal draft access denied',
        );
      if (
        ['22023', '22P02', '22003', '23502', 'invalid-input'].includes(code) ||
        cause instanceof z.ZodError
      )
        throw new FinanceJournalDraftPersistenceError(
          'invalid-input',
          'Invalid journal draft input',
        );
      if (
        ['23505', '23514', '40001', '40P01', '55P03', 'conflict'].includes(
          code,
        ) ||
        (cause instanceof Error &&
          /(?:revision|snapshot|idempotency|source|period|unresolved|duplicate|match).*?(?:conflict|required|changed|invalid)|journal-draft-.*conflict/u.test(
            cause.message,
          ))
      )
        throw new FinanceJournalDraftPersistenceError(
          'conflict',
          'Journal draft or accounting source changed',
        );
      throw cause;
    });
  }
  async checkReady() {
    const client = await this.pool.connect();
    try {
      const row = (
        await client.query(`select current_user='emdo_app' and not r.rolsuper and not r.rolbypassrls
        and coalesce(has_function_privilege(current_user,to_regprocedure('emdo.prepare_finance_journal_draft(uuid,uuid,text,uuid)'),'EXECUTE'),false)
        and coalesce(has_function_privilege(current_user,to_regprocedure('emdo.read_finance_journal_draft_result(uuid,uuid,uuid)'),'EXECUTE'),false)
        and coalesce(has_function_privilege(current_user,to_regprocedure('emdo.list_finance_journal_draft_results(uuid,uuid,integer,integer)'),'EXECUTE'),false)
        and coalesce(has_function_privilege(current_user,to_regprocedure('emdo.review_finance_journal_draft(uuid,uuid,uuid,text,integer,text,text)'),'EXECUTE'),false)
        and coalesce(has_function_privilege(current_user,to_regprocedure('emdo.discard_finance_journal_draft(uuid,uuid,uuid,text,integer,text)'),'EXECUTE'),false)
        and coalesce(has_function_privilege(current_user,to_regprocedure('emdo.lock_finance_journal_draft_post(uuid,uuid,uuid,integer)'),'EXECUTE'),false)
        and coalesce(has_function_privilege(current_user,to_regprocedure('emdo.complete_finance_journal_draft_post(uuid,uuid,uuid,integer,jsonb)'),'EXECUTE'),false)
        and (select count(*)=3 and bool_and(c.relrowsecurity and c.relforcerowsecurity) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='emdo' and c.relname in ('finance_automation_journal_draft_results','finance_automation_journal_draft_states','finance_automation_journal_draft_events')) as ready from pg_roles r where r.rolname=current_user`)
      ).rows[0];
      return row?.ready === true;
    } finally {
      client.release();
    }
  }
  private result(
    raw: unknown,
    context: WorkspaceContext,
    bookId: string,
    id?: string,
  ) {
    const result = FinanceAutomationJournalDraftResultSchema.parse(raw);
    if (
      result.workspaceId !== context.workspaceId ||
      result.bookId !== bookId ||
      (id !== undefined && result.id !== id)
    )
      throw new FinanceJournalDraftPersistenceError(
        'unavailable',
        'Journal draft scope mismatch',
      );
    return result;
  }
  prepareJournalDraft(
    context: WorkspaceContext,
    bookId: string,
    key: string,
    input: unknown,
  ) {
    UuidSchema.parse(bookId);
    Key.parse(key);
    const data = PrepareFinanceAutomationJournalDraftSchema.parse(input);
    return this.transaction(context, async (client) => {
      const result = PrepareFinanceAutomationJournalDraftResultSchema.parse(
        (
          await client.query(
            'select emdo.prepare_finance_journal_draft($1,$2,$3,$4) as result',
            [context.workspaceId, bookId, key, data.batchId],
          )
        ).rows[0]?.result,
      );
      if (result.journal.batchId !== data.batchId)
        throw new FinanceJournalDraftPersistenceError(
          'unavailable',
          'Prepared source mismatch',
        );
      return result;
    });
  }
  readJournalDraftResult(
    context: WorkspaceContext,
    bookId: string,
    id: string,
  ) {
    UuidSchema.parse(bookId);
    UuidSchema.parse(id);
    return this.transaction(context, async (client) => {
      const raw = (
        await client.query(
          'select emdo.read_finance_journal_draft_result($1,$2,$3) as result',
          [context.workspaceId, bookId, id],
        )
      ).rows[0]?.result;
      return raw === null ? null : this.result(raw, context, bookId, id);
    });
  }
  listJournalDraftResults(
    context: WorkspaceContext,
    bookId: string,
    offset = 0,
    limit = 50,
  ) {
    UuidSchema.parse(bookId);
    Page.parse({ offset, limit });
    return this.transaction(context, async (client) => {
      const page = List.parse(
        (
          await client.query(
            'select emdo.list_finance_journal_draft_results($1,$2,$3,$4) as result',
            [context.workspaceId, bookId, offset, limit],
          )
        ).rows[0]?.result,
      );
      page.items.forEach((item) => this.result(item, context, bookId));
      if (
        page.offset !== offset ||
        page.limit !== limit ||
        page.items.length > limit ||
        new Set(page.items.map((item) => item.id)).size !== page.items.length
      )
        throw new FinanceJournalDraftPersistenceError(
          'unavailable',
          'Journal draft page mismatch',
        );
      return page;
    });
  }
  reviewJournalDraft(
    context: WorkspaceContext,
    bookId: string,
    id: string,
    key: string,
    input: unknown,
  ) {
    UuidSchema.parse(bookId);
    UuidSchema.parse(id);
    Key.parse(key);
    const data = ReviewFinanceAutomationJournalDraftSchema.parse(input);
    return this.transaction(context, async (client) =>
      this.result(
        (
          await client.query(
            'select emdo.review_finance_journal_draft($1,$2,$3,$4,$5,$6,$7) as result',
            [
              context.workspaceId,
              bookId,
              id,
              key,
              data.expectedRevision,
              data.decision,
              data.reason,
            ],
          )
        ).rows[0]?.result,
        context,
        bookId,
        id,
      ),
    );
  }
  discardJournalDraft(
    context: WorkspaceContext,
    bookId: string,
    id: string,
    key: string,
    input: unknown,
  ) {
    UuidSchema.parse(bookId);
    UuidSchema.parse(id);
    Key.parse(key);
    const data = DiscardFinanceAutomationJournalDraftSchema.parse(input);
    return this.transaction(context, async (client) =>
      this.result(
        (
          await client.query(
            'select emdo.discard_finance_journal_draft($1,$2,$3,$4,$5,$6) as result',
            [
              context.workspaceId,
              bookId,
              id,
              key,
              data.expectedRevision,
              data.reason,
            ],
          )
        ).rows[0]?.result,
        context,
        bookId,
        id,
      ),
    );
  }
  postJournalDraft(
    context: WorkspaceContext,
    bookId: string,
    id: string,
    key: string,
    input: unknown,
  ) {
    UuidSchema.parse(bookId);
    UuidSchema.parse(id);
    Key.parse(key);
    const data = PostFinanceAutomationJournalDraftSchema.parse(input);
    const operation = 'journal-draft.post';
    const hash = createHash('sha256')
      .update(JSON.stringify({ operation, bookId, id, ...data }))
      .digest('hex');
    return this.transaction(context, async (client) => {
      const access = (
        await client.query(
          "select emdo.finance_book_access($1,$2,ARRAY['administrator','approver']) as permitted",
          [context.workspaceId, bookId],
        )
      ).rows[0];
      if (access?.permitted !== true)
        throw new FinanceJournalDraftPersistenceError(
          'authorization-revoked',
          'Current posting approval authority required',
        );
      await client.query(
        'select pg_advisory_xact_lock(hashtextextended($1,0))',
        [`${context.workspaceId}:${context.userId}:${key}`],
      );
      const receipt = (
        await client.query(
          'select payload_hash,result from emdo.finance_command_receipts where workspace_id=$1 and user_id=$2 and idempotency_key=$3',
          [context.workspaceId, context.userId, key],
        )
      ).rows[0];
      if (receipt) {
        if (receipt.payload_hash !== hash)
          throw new FinanceJournalDraftPersistenceError(
            'conflict',
            'Idempotency identity changed',
          );
        return this.result(
          (
            await client.query(
              'select emdo.read_finance_journal_draft_result($1,$2,$3) as result',
              [context.workspaceId, bookId, id],
            )
          ).rows[0]?.result,
          context,
          bookId,
          id,
        );
      }
      const source = z
        .strictObject({
          batchId: UuidSchema,
          batchRevision: z.number().int().positive(),
        })
        .parse(
          (
            await client.query(
              'select emdo.lock_finance_journal_draft_post($1,$2,$3,$4) as result',
              [context.workspaceId, bookId, id, data.expectedRevision],
            )
          ).rows[0]?.result,
        );
      await this.finance.commitNormalizedImportInTransaction(
        client,
        context,
        bookId,
        source.batchId,
        { expectedRevision: source.batchRevision },
      );
      const journalIds = (
        await client.query(
          `select distinct t.journal_id from emdo.finance_normalized_import_rows r join emdo.finance_economic_transactions t on t.workspace_id=r.workspace_id and t.book_id=r.book_id and t.id=r.economic_transaction_id where r.workspace_id=$1 and r.book_id=$2 and r.batch_id=$3 order by t.journal_id`,
          [context.workspaceId, bookId, source.batchId],
        )
      ).rows.map((row) => UuidSchema.parse(row.journal_id));
      const result = this.result(
        (
          await client.query(
            'select emdo.complete_finance_journal_draft_post($1,$2,$3,$4,$5::jsonb) as result',
            [
              context.workspaceId,
              bookId,
              id,
              data.expectedRevision,
              JSON.stringify(journalIds),
            ],
          )
        ).rows[0]?.result,
        context,
        bookId,
        id,
      );
      if (result.status !== 'posted')
        throw new FinanceJournalDraftPersistenceError(
          'unavailable',
          'Posting result not completed',
        );
      await client.query(
        'insert into emdo.finance_command_receipts(workspace_id,user_id,idempotency_key,operation,payload_hash,result) values($1,$2,$3,$4,$5,$6::jsonb)',
        [
          context.workspaceId,
          context.userId,
          key,
          operation,
          hash,
          JSON.stringify({ id }),
        ],
      );
      await client.query(
        'insert into emdo.finance_v2_audit(workspace_id,book_id,actor_id,request_id,operation,record_id,details) values($1,$2,$3,$4,$5,$6,$7::jsonb)',
        [
          context.workspaceId,
          bookId,
          context.userId,
          context.requestId,
          operation,
          id,
          JSON.stringify({ payloadHash: hash }),
        ],
      );
      return result;
    });
  }
}

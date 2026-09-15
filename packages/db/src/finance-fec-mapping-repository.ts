import {
  FinanceFecMappingCreateSchema,
  UuidSchema,
  WorkspaceContextSchema,
  type FinanceFecMappingCreate,
  type WorkspaceContext,
} from '@emdo/contracts';
import {
  beginDurableTransaction,
  lockDurableScope,
} from './durable/scoped-transaction.js';
import { FinanceFranceFecPersistenceError } from './finance-fec-repository.js';
import type { DatabasePool } from './scoped-repository.js';

/** Builds a complete immutable reviewed revision in one transaction. */
export class PostgresFranceFecMappingRepository {
  constructor(private readonly pool: DatabasePool) {}

  async getLatest(rawContext: WorkspaceContext, rawBookId: string) {
    const context = WorkspaceContextSchema.parse(rawContext);
    const bookId = UuidSchema.parse(rawBookId);
    const client = await beginDurableTransaction(this.pool, {
      ...context,
      householdId: context.workspaceId,
    });
    try {
      await lockDurableScope(client, { householdId: context.workspaceId });
      const permission = await client.query(
        'select emdo.lock_finance_book_grant($1,$2) as allowed',
        [context.workspaceId, bookId],
      );
      if (permission.rows[0]?.allowed !== true)
        throw new FinanceFranceFecPersistenceError(
          'authorization-revoked',
          'Current book access is required.',
        );
      // One statement observes the header and both immutable child collections.
      const result = await client.query(
        `select h.revision,h.reviewed_by as "reviewedBy",h.reviewed_at as "reviewedAt",
        jsonb_build_object('expectedRevision',h.revision,'siren',h.siren,
          'sirenSource',jsonb_build_object('sourceReference',h.siren_source_reference,'sourceDigest',h.siren_source_digest),
          'openingBalances',jsonb_build_object('status',h.opening_status,'source',jsonb_build_object('sourceReference',h.opening_source_reference,'sourceDigest',h.opening_source_digest)),
          'journals',coalesce((select jsonb_agg(jsonb_build_object(
            'journalId',j.journal_id,'entrySequence',j.entry_sequence,'entryNumber',j.entry_number,'entryKind',j.entry_kind,
            'journalCode',j.journal_code,'journalLabel',j.journal_label,'pieceReference',j.piece_reference,
            'pieceDate',j.piece_date,'entryLabel',j.entry_label,'validationDate',j.validation_date) order by j.entry_sequence)
            from emdo.finance_fec_journal_mappings j where j.workspace_id=h.workspace_id and j.book_id=h.book_id and j.revision=h.revision),'[]'::jsonb),
          'accounts',coalesce((select jsonb_agg(jsonb_build_object(
            'accountId',a.account_id,'accountNumber',a.account_number,'accountLabel',a.account_label,
            'auxiliary',case when a.auxiliary_account_number is null then null else jsonb_build_object('number',a.auxiliary_account_number,'label',a.auxiliary_account_label) end) order by a.account_id)
            from emdo.finance_fec_account_mappings a where a.workspace_id=h.workspace_id and a.book_id=h.book_id and a.revision=h.revision),'[]'::jsonb)) as mapping
        from emdo.finance_fec_book_mapping_revisions h where h.workspace_id=$1 and h.book_id=$2 order by h.revision desc limit 1`,
        [context.workspaceId, bookId],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query('commit');
        return null;
      }
      const mapping = FinanceFecMappingCreateSchema.parse(row.mapping);
      const reviewedBy = UuidSchema.parse(row.reviewedBy);
      const reviewedAt =
        row.reviewedAt instanceof Date
          ? row.reviewedAt.toISOString()
          : String(row.reviewedAt);
      if (!Number.isFinite(Date.parse(reviewedAt)))
        throw new FinanceFranceFecPersistenceError(
          'unavailable',
          'Saved mapping review timestamp is invalid.',
        );
      await client.query('commit');
      return {
        workspaceId: context.workspaceId,
        bookId,
        revision: mapping.expectedRevision,
        reviewedBy,
        reviewedAt,
        mapping,
      };
    } catch (error) {
      try {
        await client.query('rollback');
      } catch {
        /* Preserve original error. */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async create(
    rawContext: WorkspaceContext,
    rawBookId: string,
    raw: FinanceFecMappingCreate,
  ): Promise<{ revision: number }> {
    const context = WorkspaceContextSchema.parse(rawContext);
    const bookId = UuidSchema.parse(rawBookId);
    const input = FinanceFecMappingCreateSchema.parse(raw);
    const client = await beginDurableTransaction(this.pool, {
      ...context,
      householdId: context.workspaceId,
    });
    try {
      await lockDurableScope(client, { householdId: context.workspaceId });
      const permission = await client.query(
        'select emdo.lock_finance_book_grant($1,$2) as allowed',
        [context.workspaceId, bookId],
      );
      if (permission.rows[0]?.allowed !== true)
        throw new FinanceFranceFecPersistenceError(
          'authorization-revoked',
          'Current book access is required.',
        );
      await client.query(
        'select pg_advisory_xact_lock(hashtextextended($1,0))',
        [`${context.workspaceId}:${bookId}`],
      );
      const authority = await client.query(
        "select emdo.finance_book_access($1,$2,ARRAY['administrator','approver']) as allowed",
        [context.workspaceId, bookId],
      );
      if (authority.rows[0]?.allowed !== true)
        throw new FinanceFranceFecPersistenceError(
          'authorization-revoked',
          'Mapping review requires approval authority.',
        );
      const current = await client.query(
        'select coalesce(max(revision),0) as revision from emdo.finance_fec_book_mapping_revisions where workspace_id=$1 and book_id=$2',
        [context.workspaceId, bookId],
      );
      if (Number(current.rows[0]?.revision) !== input.expectedRevision)
        throw new FinanceFranceFecPersistenceError(
          'conflict',
          'The reviewed mapping revision changed.',
        );
      for (const source of [input.sirenSource, input.openingBalances.source]) {
        if (!source.sourceReference.startsWith('evidence:')) continue;
        const id = UuidSchema.safeParse(
          source.sourceReference.slice('evidence:'.length),
        );
        if (!id.success)
          throw new FinanceFranceFecPersistenceError(
            'invalid-input',
            'Select a valid source document.',
          );
        const evidence = await client.query(
          'select plaintext_sha256 as digest from emdo.finance_book_evidence where workspace_id=$1 and book_id=$2 and id=$3',
          [context.workspaceId, bookId, id.data],
        );
        if (evidence.rows[0]?.digest !== source.sourceDigest)
          throw new FinanceFranceFecPersistenceError(
            'invalid-input',
            'The selected source document is unavailable in this book or its digest does not match.',
          );
      }
      const revision = input.expectedRevision + 1;
      await client.query(
        `insert into emdo.finance_fec_book_mapping_revisions
        (workspace_id,book_id,revision,siren,siren_source_reference,siren_source_digest,opening_status,opening_source_reference,opening_source_digest)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          context.workspaceId,
          bookId,
          revision,
          input.siren,
          input.sirenSource.sourceReference,
          input.sirenSource.sourceDigest,
          input.openingBalances.status,
          input.openingBalances.source.sourceReference,
          input.openingBalances.source.sourceDigest,
        ],
      );
      await client.query(
        `insert into emdo.finance_fec_journal_mappings
        (workspace_id,book_id,revision,journal_id,entry_sequence,entry_number,entry_kind,journal_code,journal_label,piece_reference,piece_date,entry_label,validation_date)
        select $1,$2,$3,x."journalId",x."entrySequence",x."entryNumber",x."entryKind",x."journalCode",x."journalLabel",x."pieceReference",x."pieceDate",x."entryLabel",x."validationDate"
        from jsonb_to_recordset($4::jsonb) as x("journalId" uuid,"entrySequence" integer,"entryNumber" text,"entryKind" text,"journalCode" text,"journalLabel" text,"pieceReference" text,"pieceDate" date,"entryLabel" text,"validationDate" date)`,
        [context.workspaceId, bookId, revision, JSON.stringify(input.journals)],
      );
      await client.query(
        `insert into emdo.finance_fec_account_mappings
        (workspace_id,book_id,revision,account_id,account_number,account_label,auxiliary_account_number,auxiliary_account_label)
        select $1,$2,$3,x."accountId",x."accountNumber",x."accountLabel",x.auxiliary->>'number',x.auxiliary->>'label'
        from jsonb_to_recordset($4::jsonb) as x("accountId" uuid,"accountNumber" text,"accountLabel" text,auxiliary jsonb)`,
        [context.workspaceId, bookId, revision, JSON.stringify(input.accounts)],
      );
      await client.query('commit');
      return { revision };
    } catch (error) {
      try {
        await client.query('rollback');
      } catch {
        /* Preserve original failure. */
      }
      if (
        error instanceof Error &&
        !(error instanceof FinanceFranceFecPersistenceError)
      ) {
        const code = 'code' in error ? String(error.code) : '';
        if (code === '42501')
          throw new FinanceFranceFecPersistenceError(
            'authorization-revoked',
            'Current authority does not permit this mapping review.',
          );
        if (['23505', '40001', '40P01', '55P03'].includes(code))
          throw new FinanceFranceFecPersistenceError(
            'conflict',
            'The mapping or book changed. Refresh before retrying.',
          );
        if (
          ['23502', '23503', '23514', '22023', '22P02', '22003'].includes(code)
        )
          throw new FinanceFranceFecPersistenceError(
            'invalid-input',
            'The mapping does not satisfy the book and legal metadata requirements.',
          );
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

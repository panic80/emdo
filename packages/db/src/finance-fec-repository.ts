import { createHash } from 'node:crypto';

import {
  FinanceFecExportRequestSchema,
  UuidSchema,
  WorkspaceContextSchema,
  type FinanceFecExportRequest as ContractFinanceFecExportRequest,
  type WorkspaceContext,
} from '@emdo/contracts';
import {
  createFranceFecExport,
  type FranceFecExport,
  type FranceFecEntryInput,
  type FranceFecInput,
} from '@emdo/domains/finance';
import { z } from 'zod';

import {
  beginDurableTransaction,
  lockDurableScope,
} from './durable/scoped-transaction.js';
import type { DatabaseClient, DatabasePool } from './scoped-repository.js';

/** Compatibility name retained for existing Finance repository callers. */
export type FranceFecExportRequest = ContractFinanceFecExportRequest;

export class FinanceFranceFecPersistenceError extends Error {
  constructor(
    readonly code:
      'authorization-revoked' | 'invalid-input' | 'conflict' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'FinanceFranceFecPersistenceError';
  }
}

type Row = Record<string, unknown>;

type FranceFecEntryBuilder = Omit<FranceFecEntryInput, 'lines'> & {
  lines: FranceFecEntryInput['lines'][number][];
};

const text = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number')
    return String(value);
  return null;
};

const requiredText = (value: unknown, label: string): string => {
  const result = text(value);
  if (!result)
    throw new FinanceFranceFecPersistenceError(
      'unavailable',
      `FEC source column ${label} is unavailable`,
    );
  return result;
};

const optionalText = (value: unknown): string | null => text(value);

const hashJson = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

function mapDatabaseError(cause: unknown): unknown {
  if (cause instanceof FinanceFranceFecPersistenceError) return cause;
  if (!(cause instanceof Error) || cause.name === 'ZodError') return cause;
  const code = 'code' in cause ? String(cause.code) : '';
  if (
    code === '42501' ||
    cause.message === 'finance-book-forbidden' ||
    cause.message === 'authorization-revoked'
  )
    return new FinanceFranceFecPersistenceError(
      'authorization-revoked',
      'Current workspace or book access does not permit this FEC export.',
    );
  if (['22P02', '22003', '23502', '23503', '22023'].includes(code))
    return new FinanceFranceFecPersistenceError(
      'invalid-input',
      'The FEC mapping or posted ledger source is invalid.',
    );
  if (
    ['23505', '23514', '40P01', '55P03'].includes(code) ||
    cause.message.startsWith('finance-fec-')
  )
    return new FinanceFranceFecPersistenceError(
      'conflict',
      'The FEC mapping or posted ledger snapshot changed. Refresh and retry.',
    );
  return cause;
}

function savedExport(value: unknown, expectedHash: unknown): FranceFecExport {
  const result = z.record(z.string(), z.unknown()).safeParse(value);
  if (!result.success || result.data.status !== 'ready')
    throw new FinanceFranceFecPersistenceError(
      'unavailable',
      'Saved FEC export result is unavailable or blocked.',
    );
  const file = z.record(z.string(), z.unknown()).safeParse(result.data.file);
  if (!file.success || typeof file.data.content !== 'string')
    throw new FinanceFranceFecPersistenceError(
      'unavailable',
      'Saved FEC export content is unavailable.',
    );
  if (
    typeof expectedHash !== 'string' ||
    createHash('sha256').update(file.data.content).digest('hex') !==
      expectedHash
  )
    throw new FinanceFranceFecPersistenceError(
      'conflict',
      'Saved FEC export integrity check failed.',
    );
  return result.data as unknown as FranceFecExport;
}

/**
 * Read-only ledger adapter for the reviewed France FEC export. It never
 * accepts financial values or legal labels from the caller. All of those
 * values come from posted journals and immutable, reviewer-bound FEC mapping
 * revisions. The sequential migration coordinator owns the mapping and
 * receipt tables referenced here.
 */
export class PostgresFranceFecRepository {
  constructor(private readonly pool: DatabasePool) {}

  async checkReady(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `select
           (select count(*)=4 and bool_and(c.relrowsecurity and c.relforcerowsecurity)
              from pg_class c join pg_namespace n on n.oid=c.relnamespace
             where n.nspname='emdo' and c.relname in
              ('finance_fec_book_mapping_revisions','finance_fec_journal_mappings','finance_fec_account_mappings','finance_fec_export_receipts')) as fec_rls,
           (select not rolsuper and not rolbypassrls from pg_roles where rolname=current_user) as restricted_role`,
      );
      return (
        result.rows[0]?.fec_rls === true &&
        result.rows[0]?.restricted_role === true
      );
    } finally {
      client.release();
    }
  }

  private async transaction<T>(
    rawContext: WorkspaceContext,
    bookId: string,
    work: (client: DatabaseClient) => Promise<T>,
  ): Promise<T> {
    const context = WorkspaceContextSchema.parse(rawContext);
    UuidSchema.parse(bookId);
    const client = await beginDurableTransaction(this.pool, {
      ...context,
      householdId: context.workspaceId,
    });
    try {
      await lockDurableScope(client, { householdId: context.workspaceId });
      const allowed = await client.query(
        'select emdo.lock_finance_book_grant($1,$2) as allowed',
        [context.workspaceId, bookId],
      );
      if (allowed.rows[0]?.allowed !== true)
        throw new FinanceFranceFecPersistenceError(
          'authorization-revoked',
          'finance-book-forbidden',
        );
      const book = await client.query(
        `select b.id,b.functional_currency as "functionalCurrency",g.role
           from emdo.finance_books b
           join emdo.finance_book_grants g
             on g.workspace_id=b.workspace_id and g.book_id=b.id
          where b.workspace_id=$1 and b.id=$2 and g.user_id=$3 and g.revoked_at is null`,
        [context.workspaceId, bookId, context.userId],
      );
      if (!book.rows[0])
        throw new FinanceFranceFecPersistenceError(
          'authorization-revoked',
          'finance-book-forbidden',
        );
      // This is the same canonical lock held by Finance posting. It makes the
      // posted-ledger count and line snapshot one coherent observation.
      await client.query(
        'select pg_advisory_xact_lock(hashtextextended($1,0))',
        [`${context.workspaceId}:${bookId}`],
      );
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (cause) {
      try {
        await client.query('rollback');
      } catch {
        /* Preserve the original effect uncertainty. */
      }
      throw mapDatabaseError(cause);
    } finally {
      client.release();
    }
  }

  private async readReceipt(
    client: DatabaseClient,
    context: WorkspaceContext,
    bookId: string,
    request: FranceFecExportRequest,
    requestHash: string,
  ): Promise<FranceFecExport | null> {
    const row = (
      await client.query(
        `select request_hash,result_hash,result
           from emdo.finance_fec_export_receipts
          where workspace_id=$1 and book_id=$2 and idempotency_key=$3`,
        [context.workspaceId, bookId, request.idempotencyKey],
      )
    ).rows[0];
    if (!row) return null;
    if (row.request_hash !== requestHash)
      throw new FinanceFranceFecPersistenceError(
        'conflict',
        'The FEC idempotency key was already used for another snapshot.',
      );
    return savedExport(row.result, row.result_hash);
  }

  private async readBookMapping(
    client: DatabaseClient,
    context: WorkspaceContext,
    bookId: string,
    mappingRevision: number,
  ): Promise<Row | null> {
    return (
      (
        await client.query(
          `select siren,siren_source_reference as "sirenSourceReference",
                siren_source_digest as "sirenSourceDigest",
                opening_status as "openingStatus",
                opening_source_reference as "openingSourceReference",
                opening_source_digest as "openingSourceDigest"
           from emdo.finance_fec_book_mapping_revisions
          where workspace_id=$1 and book_id=$2 and revision=$3
            and reviewed_at is not null`,
          [context.workspaceId, bookId, mappingRevision],
        )
      ).rows[0] ?? null
    );
  }

  private async readPostedLedger(
    client: DatabaseClient,
    context: WorkspaceContext,
    bookId: string,
    request: FranceFecExportRequest,
    mappingRevision: number,
  ): Promise<FranceFecInput['entries']> {
    const count = (
      await client.query(
        `select count(distinct j.id)::int as count
           from emdo.finance_journals j
          where j.workspace_id=$1 and j.book_id=$2 and j.status='posted'
            and j.effective_on between $3::date and $4::date`,
        [context.workspaceId, bookId, request.startsOn, request.endsOn],
      )
    ).rows[0];
    const expectedJournalCount = Number(count?.count ?? 0);
    if (!Number.isSafeInteger(expectedJournalCount) || expectedJournalCount < 0)
      throw new FinanceFranceFecPersistenceError(
        'unavailable',
        'Posted journal count is unavailable.',
      );
    const rows = (
      await client.query(
        `select j.id as journal_id,j.effective_on::text as accounting_date,
                j.source_reference,j.payload_hash,
                l.id as line_id,l.line_number,l.side,l.amount::text as amount,
                l.native_amount::text as native_amount,l.currency,
                jm.entry_sequence,jm.entry_number,jm.entry_kind,
                jm.journal_code,jm.journal_label,jm.piece_reference,
                jm.piece_date::text as piece_date,jm.entry_label,
                jm.validation_date::text as validation_date,
                am.account_number,am.account_label,
                am.auxiliary_account_number,am.auxiliary_account_label,
                null::text as lettering,null::text as lettering_date
           from emdo.finance_journals j
           join emdo.finance_journal_lines l
             on l.workspace_id=j.workspace_id and l.book_id=j.book_id
            and l.journal_id=j.id
           left join emdo.finance_fec_journal_mappings jm
             on jm.workspace_id=j.workspace_id and jm.book_id=j.book_id
            and jm.journal_id=j.id and jm.revision=$5 and jm.reviewed_at is not null
           left join emdo.finance_fec_account_mappings am
             on am.workspace_id=l.workspace_id and am.book_id=l.book_id
            and am.account_id=l.account_id and am.revision=$5 and am.reviewed_at is not null
          where j.workspace_id=$1 and j.book_id=$2 and j.status='posted'
            and j.effective_on between $3::date and $4::date
          order by jm.entry_sequence nulls last,j.effective_on,j.id,l.line_number`,
        [
          context.workspaceId,
          bookId,
          request.startsOn,
          request.endsOn,
          mappingRevision,
        ],
      )
    ).rows;
    const journalIds = new Set(
      rows
        .map((row) => text(row.journal_id))
        .filter((id): id is string => id !== null),
    );
    if (journalIds.size !== expectedJournalCount)
      throw new FinanceFranceFecPersistenceError(
        'invalid-input',
        'A posted journal has no line snapshot; refusing silent FEC omission.',
      );

    const entries = new Map<string, FranceFecEntryBuilder>();
    for (const row of rows) {
      const journalId = requiredText(row.journal_id, 'journal_id');
      const lineId = requiredText(row.line_id, 'line_id');
      const amount = requiredText(row.amount, 'amount');
      const currency = optionalText(row.currency);
      const side = row.side;
      const functional =
        side === 'debit'
          ? { debit: amount, credit: '0' }
          : side === 'credit'
            ? { debit: '0', credit: amount }
            : { debit: null, credit: null };
      const existing = entries.get(journalId);
      const entry =
        existing ??
        ({
          entryId: journalId,
          sequence:
            typeof row.entry_sequence === 'number'
              ? row.entry_sequence
              : row.entry_sequence === null || row.entry_sequence === undefined
                ? (null as unknown as number)
                : Number(row.entry_sequence),
          entryNumber: row.entry_number,
          kind: row.entry_kind,
          journalCode: row.journal_code,
          journalLabel: row.journal_label,
          accountingDate: row.accounting_date,
          pieceReference: row.piece_reference,
          pieceDate: row.piece_date,
          label: row.entry_label,
          validationDate: row.validation_date,
          lines: [],
        } as unknown as FranceFecEntryBuilder);
      entry.lines.push({
        lineId,
        accountNumber: row.account_number,
        accountLabel: row.account_label,
        auxiliaryAccountNumber: row.auxiliary_account_number,
        auxiliaryAccountLabel: row.auxiliary_account_label,
        debit: functional.debit,
        credit: functional.credit,
        lettering: row.lettering,
        letteringDate: row.lettering_date,
        foreign:
          currency && currency !== 'EUR'
            ? { amount: row.native_amount, currency }
            : null,
        source: {
          sourceReference: row.source_reference,
          sourceDigest: row.payload_hash,
        },
      } as unknown as FranceFecEntryInput['lines'][number]);
      entries.set(journalId, entry);
    }
    return [...entries.values()];
  }

  /**
   * Builds or replays one immutable FEC snapshot. The request is limited to
   * period, reviewed mapping revision, and idempotency key; financial values
   * are always read from the locked posted ledger.
   */
  async getSavedExport(
    rawContext: WorkspaceContext,
    bookId: string,
    rawKey: string,
  ): Promise<FranceFecExport | null> {
    const context = WorkspaceContextSchema.parse(rawContext);
    const key = z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,128}$/u)
      .parse(rawKey);
    return this.transaction(context, bookId, async (client) => {
      const row = (
        await client.query(
          'select result_hash,result from emdo.finance_fec_export_receipts where workspace_id=$1 and book_id=$2 and idempotency_key=$3',
          [context.workspaceId, bookId, key],
        )
      ).rows[0];
      return row ? savedExport(row.result, row.result_hash) : null;
    });
  }

  async export(
    rawContext: WorkspaceContext,
    bookId: string,
    rawRequest: unknown,
  ): Promise<FranceFecExport> {
    const context = WorkspaceContextSchema.parse(rawContext);
    UuidSchema.parse(bookId);
    const request = FinanceFecExportRequestSchema.parse(rawRequest);
    if (request.startsOn > request.endsOn)
      throw new FinanceFranceFecPersistenceError(
        'invalid-input',
        'FEC export period ends before it starts.',
      );
    const requestHash = hashJson({
      workspaceId: context.workspaceId,
      bookId,
      startsOn: request.startsOn,
      endsOn: request.endsOn,
      mappingRevision: request.mappingRevision,
    });
    return this.transaction(context, bookId, async (client) => {
      const prior = await this.readReceipt(
        client,
        context,
        bookId,
        request,
        requestHash,
      );
      if (prior) return prior;
      const book = (
        await client.query(
          `select functional_currency as "functionalCurrency"
             from emdo.finance_books
            where workspace_id=$1 and id=$2`,
          [context.workspaceId, bookId],
        )
      ).rows[0];
      const functionalCurrency = requiredText(
        book?.functionalCurrency,
        'functional_currency',
      );
      const mapping = await this.readBookMapping(
        client,
        context,
        bookId,
        request.mappingRevision,
      );
      const entries = await this.readPostedLedger(
        client,
        context,
        bookId,
        request,
        request.mappingRevision,
      );
      const input = {
        entity: {
          siren: mapping?.siren,
          sirenSource: {
            sourceReference: mapping?.sirenSourceReference,
            sourceDigest: mapping?.sirenSourceDigest,
          },
        },
        period: { startsOn: request.startsOn, endsOn: request.endsOn },
        functionalCurrency,
        openingBalances: {
          status: mapping?.openingStatus,
          source: {
            sourceReference: mapping?.openingSourceReference,
            sourceDigest: mapping?.openingSourceDigest,
          },
        },
        entries,
      };
      const result = createFranceFecExport(input);
      if (result.status === 'blocked') return result;
      const resultHash = createHash('sha256')
        .update(result.file.content)
        .digest('hex');
      await client.query(
        `insert into emdo.finance_fec_export_receipts
          (workspace_id,book_id,idempotency_key,mapping_revision,
           period_starts_on,period_ends_on,request_hash,result_hash,result)
         values($1,$2,$3,$4,$5::date,$6::date,$7,$8,$9::jsonb)`,
        [
          context.workspaceId,
          bookId,
          request.idempotencyKey,
          request.mappingRevision,
          request.startsOn,
          request.endsOn,
          requestHash,
          resultHash,
          JSON.stringify(result),
        ],
      );
      return result;
    });
  }
}

export const PostgresFinanceFranceFecRepository = PostgresFranceFecRepository;

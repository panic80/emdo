import { z } from 'zod';
import {
  UuidSchema,
  WorkspaceContextSchema,
  type WorkspaceContext,
} from '@emdo/contracts';
import {
  FinanceLegacyOpeningPostRequestSchema,
  FinanceOpeningProofSchema,
  type FinanceOpeningProof,
} from '@emdo/contracts';
import {
  beginDurableTransaction,
  lockDurableScope,
} from './durable/scoped-transaction.js';
import type { DatabaseClient, DatabasePool } from './scoped-repository.js';

export class FinanceOpeningPersistenceError extends Error {
  constructor(
    readonly code:
      'authorization-revoked' | 'conflict' | 'invalid-input' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'FinanceOpeningPersistenceError';
  }
}
const proof = (raw: unknown): FinanceOpeningProof => {
  const row = z.record(z.string(), z.unknown()).parse(raw);
  const names = [
    'id',
    'workspace_id',
    'book_id',
    'financial_account_id',
    'source_space_id',
    'source_owner_user_id',
    'source_kind',
    'migration_id',
    'source_record_id',
    'source_revision',
    'source_snapshot_hash',
    'review_id',
    'evidence_id',
    'evidence_digest',
    'effective_on',
    'amount_cad_minor',
    'ledger_account_id',
    'counterpart_ledger_account_id',
    'journal_id',
    'posted_by',
    'posted_at',
    'supersedes_proof_id',
  ];
  return FinanceOpeningProofSchema.parse(
    Object.fromEntries(
      names.map((name) => [
        name.replace(/_([a-z])/gu, (_, letter: string) => letter.toUpperCase()),
        name === 'amount_cad_minor' ? String(row[name]) : row[name],
      ]),
    ),
  );
};
export class PostgresFinanceOpeningRepository {
  constructor(private readonly pool: DatabasePool) {}
  async checkReady() {
    let client: DatabaseClient | undefined;
    try {
      client = await this.pool.connect();
      const result = await client.query(
        `select exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='emdo' and c.relname='finance_opening_proofs' and c.relrowsecurity and c.relforcerowsecurity)
        and to_regprocedure('emdo.post_legacy_finance_opening(uuid,uuid,uuid,uuid,integer,integer,text,text)') is not null
        and has_table_privilege('emdo_app','emdo.finance_opening_proofs','SELECT') and has_table_privilege('emdo_app','emdo.finance_opening_proofs','INSERT')
        and not has_table_privilege('emdo_app','emdo.finance_opening_proofs','UPDATE,DELETE,TRUNCATE')
        and not has_table_privilege('emdo_worker','emdo.finance_opening_proofs','SELECT,INSERT,UPDATE,DELETE')
        and not exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl where p.oid=to_regprocedure('emdo.post_legacy_finance_opening(uuid,uuid,uuid,uuid,integer,integer,text,text)') and acl.grantee=0 and acl.privilege_type='EXECUTE') as ready`,
      );
      return result.rows[0]?.ready === true;
    } catch {
      return false;
    } finally {
      client?.release();
    }
  }
  private async scoped<T>(
    raw: WorkspaceContext,
    work: (client: DatabaseClient, context: WorkspaceContext) => Promise<T>,
  ): Promise<T> {
    const context = WorkspaceContextSchema.parse(raw);
    const client = await beginDurableTransaction(this.pool, {
      ...context,
      householdId: context.workspaceId,
    });
    try {
      await lockDurableScope(client, { householdId: context.workspaceId });
      const result = await work(client, context);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      if (error instanceof Error && 'code' in error) {
        const code = String(error.code);
        throw new FinanceOpeningPersistenceError(
          code === '42501'
            ? 'authorization-revoked'
            : code === '23514' || code === '23505'
              ? 'conflict'
              : code === '22P02'
                ? 'invalid-input'
                : 'unavailable',
          error.message.startsWith('opening-') ||
            error.message.startsWith('finance-')
            ? error.message
            : `Opening persistence failed (${code})`,
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }
  async postLegacyOpening(
    raw: WorkspaceContext,
    rawBookId: string,
    rawMigrationId: string,
    rawRecordId: string,
    input: unknown,
  ): Promise<FinanceOpeningProof> {
    const bookId = UuidSchema.parse(rawBookId),
      migrationId = UuidSchema.parse(rawMigrationId),
      recordId = UuidSchema.parse(rawRecordId),
      request = FinanceLegacyOpeningPostRequestSchema.parse(input);
    return this.scoped(raw, async (client, context) => {
      const result = await client.query(
        'select emdo.post_legacy_finance_opening($1,$2,$3,$4,$5,$6,$7,$8) as proof',
        [
          context.workspaceId,
          bookId,
          migrationId,
          recordId,
          request.expectedRunRevision,
          request.expectedRecordRevision,
          request.expectedSourceSnapshotHash,
          request.idempotencyKey,
        ],
      );
      const value = proof(result.rows[0]?.proof);
      if (
        value.workspaceId !== context.workspaceId ||
        value.bookId !== bookId ||
        value.migrationId !== migrationId ||
        value.sourceRecordId !== recordId
      )
        throw new FinanceOpeningPersistenceError(
          'unavailable',
          'Opening proof scope mismatch',
        );
      return value;
    });
  }
  async getLatest(
    raw: WorkspaceContext,
    rawBookId: string,
    rawAccountId: string,
  ): Promise<FinanceOpeningProof | null> {
    const bookId = UuidSchema.parse(rawBookId),
      accountId = UuidSchema.parse(rawAccountId);
    return this.scoped(raw, async (client, context) => {
      if (
        (
          await client.query(
            'select emdo.lock_finance_book_grant($1,$2) as allowed',
            [context.workspaceId, bookId],
          )
        ).rows[0]?.allowed !== true
      )
        throw new FinanceOpeningPersistenceError(
          'authorization-revoked',
          'Opening proof access revoked',
        );
      const row = (
        await client.query(
          'select source_space_id,source_owner_user_id from emdo.finance_opening_proofs where workspace_id=$1 and book_id=$2 and financial_account_id=$3 order by posted_at desc,id desc limit 1',
          [context.workspaceId, bookId, accountId],
        )
      ).rows[0];
      if (!row) return null;
      const result = (
        await client.query(
          'select emdo.finance_account_opening_proof($1,$2,$3,$4,$5) as proof',
          [
            context.workspaceId,
            bookId,
            accountId,
            row.source_space_id,
            row.source_owner_user_id,
          ],
        )
      ).rows[0]?.proof;
      return result == null ? null : proof(result);
    });
  }
}

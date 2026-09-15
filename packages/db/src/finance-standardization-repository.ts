import { z } from 'zod';
import {
  ChangeFinanceStandardizationSchema,
  FinanceStandardizationReconciliationSchema,
  LookupFinanceStandardizationReceiptSchema,
  ResolveFinanceStandardizationSchema,
  LinkFinanceStandardizationMappingSchema,
  FinanceStandardizationRunSchema,
  StartFinanceStandardizationSchema,
  UuidSchema,
  type WorkspaceContext,
} from '@emdo/contracts';
import {
  standardizationAllowedActions,
  assertStandardizationRunInvariant,
} from '@emdo/domains/finance';
import type { DatabasePool, DatabaseClient } from './scoped-repository.js';
import {
  beginDurableTransaction,
  lockDurableScope,
} from './durable/scoped-transaction.js';
const iso = (v: unknown) =>
  v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
function publicRun(raw: unknown) {
  const r = z.record(z.string(), z.unknown()).parse(raw);
  const data = FinanceStandardizationRunSchema.parse({
    id: r.id,
    executionMode: r.execution_mode ?? 'proposal',
    workspaceId: r.workspace_id,
    bookId: r.book_id,
    evidenceId: r.evidence_id,
    filename: r.filename,
    format: r.format,
    sourceDigest: r.source_digest,
    revision: r.revision,
    attempt: r.attempt,
    status: r.status,
    authorizedByUserId: r.authorized_by,
    authorizationExpiresAt: iso(r.authorization_expires_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    extraction: r.extraction,
    proposal: r.proposal,
    reviewedMapping: r.reviewed_mapping ?? null,
    modelProvenance: r.model_provenance,
    blockers: r.blockers,
    allowedActions: [],
    approval: 'not-granted',
    posting: 'not-performed',
  });
  return assertStandardizationRunInvariant({
    ...data,
    allowedActions: [
      ...new Set([
        ...standardizationAllowedActions(data, r.can_manage === true),
        ...(data.reviewedMapping ? ['open-mapping' as const] : []),
      ]),
    ],
  });
}
export class FinanceStandardizationPersistenceError extends Error {
  constructor(readonly code: 'denied' | 'conflict' | 'unavailable') {
    super(`finance-standardization-${code}`);
    this.name = 'FinanceStandardizationPersistenceError';
  }
}
function error(cause: unknown) {
  const code = (cause as { code?: string })?.code;
  return new FinanceStandardizationPersistenceError(
    code === '42501'
      ? 'denied'
      : code === '23514' || code === '23505'
        ? 'conflict'
        : 'unavailable',
  );
}
export class PostgresFinanceStandardizationRepository {
  constructor(private readonly pool: DatabasePool) {}
  private async transaction<T>(
    context: WorkspaceContext,
    work: (client: DatabaseClient) => Promise<T>,
  ) {
    const client = await beginDurableTransaction(this.pool, {
      ...context,
      householdId: context.workspaceId,
    });
    try {
      await lockDurableScope(client, { householdId: context.workspaceId });
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (cause) {
      await client.query('rollback');
      throw cause instanceof FinanceStandardizationPersistenceError
        ? cause
        : error(cause);
    } finally {
      client.release();
    }
  }
  async checkReady() {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        "select to_regprocedure('emdo.start_finance_standardization(uuid,uuid,uuid,text,text)') is not null and (select count(*)=5 and bool_and(c.relrowsecurity and c.relforcerowsecurity) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='emdo' and c.relname in ('finance_standardization_runs','finance_standardization_extractions','finance_standardization_spend','finance_standardization_configuration','finance_standardization_reconciliations')) and exists(select from pg_roles where rolname=current_user and not rolsuper and not rolbypassrls) as ready",
      );
      return result.rows[0]?.ready === true;
    } finally {
      client.release();
    }
  }
  available(context: WorkspaceContext, bookId: string) {
    UuidSchema.parse(bookId);
    return this.transaction(
      context,
      async (client) =>
        (
          await client.query(
            'select emdo.finance_standardization_available($1,$2) as ready',
            [context.workspaceId, bookId],
          )
        ).rows[0]?.ready === true,
    );
  }
  private async read(
    client: DatabaseClient,
    context: WorkspaceContext,
    bookId: string,
    runId: string | null,
    offset: number,
  ) {
    const result = await client.query(
      'select emdo.read_finance_standardizations($1,$2,$3,$4) as run',
      [context.workspaceId, bookId, runId, offset],
    );
    return result.rows.map((row) => publicRun(row.run));
  }
  list(context: WorkspaceContext, bookId: string, offset = 0) {
    UuidSchema.parse(bookId);
    z.number().int().min(0).max(1000000).parse(offset);
    return this.transaction(context, async (client) => {
      const rows = await this.read(client, context, bookId, null, offset);
      return {
        runs: rows.slice(0, 50),
        nextOffset: rows.length > 50 ? offset + 50 : null,
      };
    });
  }
  get(context: WorkspaceContext, bookId: string, runId: string) {
    UuidSchema.parse(bookId);
    UuidSchema.parse(runId);
    return this.transaction(context, async (client) => {
      const result = (await this.read(client, context, bookId, runId, 0))[0];
      if (!result) throw new FinanceStandardizationPersistenceError('denied');
      return result;
    });
  }
  start(
    context: WorkspaceContext,
    bookId: string,
    key: string,
    input: unknown,
  ) {
    UuidSchema.parse(bookId);
    UuidSchema.parse(key);
    const parsed = StartFinanceStandardizationSchema.parse(input);
    return this.transaction(context, async (client) => {
      const result = (
        await client.query(
          'select emdo.start_finance_standardization($1,$2,$3,$4,$5) as result',
          [
            context.workspaceId,
            bookId,
            parsed.evidenceId,
            parsed.expectedSourceDigest,
            key,
          ],
        )
      ).rows[0]?.result;
      const { id } = z.object({ id: UuidSchema }).parse(result);
      const run = (await this.read(client, context, bookId, id, 0))[0];
      if (!run) throw new FinanceStandardizationPersistenceError('unavailable');
      return run;
    });
  }
  change(
    context: WorkspaceContext,
    bookId: string,
    runId: string,
    action: 'retry' | 'cancel',
    key: string,
    input: unknown,
  ) {
    [bookId, runId, key].forEach((v) => UuidSchema.parse(v));
    const parsed = ChangeFinanceStandardizationSchema.parse(input);
    return this.transaction(context, async (client) => {
      await client.query(
        'select emdo.change_finance_standardization($1,$2,$3,$4,$5,$6)',
        [
          context.workspaceId,
          bookId,
          runId,
          parsed.expectedRevision,
          action,
          key,
        ],
      );
      const run = (await this.read(client, context, bookId, runId, 0))[0];
      if (!run) throw new FinanceStandardizationPersistenceError('unavailable');
      return run;
    });
  }
  linkMapping(
    context: WorkspaceContext,
    bookId: string,
    runId: string,
    key: string,
    input: unknown,
  ) {
    [bookId, runId, key].forEach((v) => UuidSchema.parse(v));
    const parsed = LinkFinanceStandardizationMappingSchema.parse(input);
    return this.transaction(context, async (client) => {
      await client.query(
        'select emdo.link_standardization_mapping($1,$2,$3,$4,$5,$6)',
        [
          context.workspaceId,
          bookId,
          runId,
          parsed.expectedRevision,
          parsed.mappingId,
          key,
        ],
      );
      const run = (await this.read(client, context, bookId, runId, 0))[0];
      if (!run) throw new FinanceStandardizationPersistenceError('unavailable');
      return run;
    });
  }
  private async readReconciliation(
    client: DatabaseClient,
    context: WorkspaceContext,
    bookId: string,
    runId: string,
  ) {
    const result = FinanceStandardizationReconciliationSchema.parse(
      (
        await client.query(
          'select emdo.read_standardization_reconciliation($1,$2,$3) as result',
          [context.workspaceId, bookId, runId],
        )
      ).rows[0]?.result,
    );
    if (
      result.workspaceId !== context.workspaceId ||
      result.bookId !== bookId ||
      result.runId !== runId
    )
      throw new FinanceStandardizationPersistenceError('unavailable');
    return result;
  }
  reconciliation(context: WorkspaceContext, bookId: string, runId: string) {
    [bookId, runId].forEach((v) => UuidSchema.parse(v));
    return this.transaction(context, (c) =>
      this.readReconciliation(c, context, bookId, runId),
    );
  }
  requestReceiptLookup(
    context: WorkspaceContext,
    bookId: string,
    runId: string,
    key: string,
    input: unknown,
  ) {
    const parsed = LookupFinanceStandardizationReceiptSchema.parse(input);
    [bookId, runId, key].forEach((v) => UuidSchema.parse(v));
    return this.transaction(context, async (c) => {
      await c.query(
        'select emdo.request_standardization_receipt($1,$2,$3,$4,$5,$6)',
        [
          context.workspaceId,
          bookId,
          runId,
          parsed.expectedRevision,
          parsed.reservationId,
          key,
        ],
      );
      return this.readReconciliation(c, context, bookId, runId);
    });
  }
  resolveOutcome(
    context: WorkspaceContext,
    bookId: string,
    runId: string,
    key: string,
    input: unknown,
  ) {
    const parsed = ResolveFinanceStandardizationSchema.parse(input);
    [bookId, runId, key].forEach((v) => UuidSchema.parse(v));
    return this.transaction(context, async (c) => {
      await c.query(
        'select emdo.resolve_standardization_outcome($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          context.workspaceId,
          bookId,
          runId,
          parsed.expectedRevision,
          parsed.reservationId,
          parsed.decision,
          parsed.receiptId,
          key,
        ],
      );
      return this.readReconciliation(c, context, bookId, runId);
    });
  }
}

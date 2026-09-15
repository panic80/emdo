import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient, DatabasePool } from './scoped-repository.js';
import { PostgresFinanceLegacyMigrationRepository } from './finance-legacy-migration-repository.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = (digit: string) => digit.repeat(64);

const workspaceId = id(1);
const sourceSpaceId = id(2);
const userId = id(3);
const sessionId = id(4);
const requestId = id(5);
const bookId = id(6);
const accountId = id(10);
const ledgerId = id(11);
const evidenceId = id(12);
const legacyRowId = id(20);

const source = {
  householdId: workspaceId,
  privateSpaceId: sourceSpaceId,
  originalOwnerUserId: userId,
};
const mapping = {
  source,
  target: { workspaceId, bookId, ownerUserId: userId },
  financialAccounts: [
    { legacyAccountId: 'legacy-account', targetFinancialAccountId: accountId },
  ],
  categories: [
    { legacyCategoryId: 'legacy-category', targetLedgerAccountId: ledgerId },
  ],
  evidence: [
    { legacyEntityId: 'legacy-transaction', targetEvidenceId: evidenceId },
  ],
  openings: [],
};

const transactionPayload = {
  schemaVersion: 1 as const,
  id: 'legacy-transaction',
  spaceId: sourceSpaceId,
  ownerUserId: userId,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  recordType: 'transaction' as const,
  accountId: 'legacy-account',
  categoryId: 'legacy-category',
  postedOn: '2026-08-31',
  description: 'Legacy market transaction',
  annotation: null,
  currency: 'CAD' as const,
  originalAmountCadMinor: -4205,
  effectiveAmountCadMinor: -4205,
  adjustments: [],
  reversal: null,
  appliedOperationIds: [],
  source: {
    kind: 'import' as const,
    sourceHash: digest('a'),
    sourceRow: 7,
    fingerprint: digest('b'),
    externalId: 'statement-7',
  },
};

const queryResult = (rows: readonly Record<string, unknown>[] = []) => ({
  rows,
  rowCount: rows.length,
});

describe('PostgresFinanceLegacyMigrationRepository', () => {
  it('snapshots private source rows once, preserves provenance, and replays inspect idempotently', async () => {
    const queries: string[] = [];
    const lockEvents: string[] = [];
    let runRow: Record<string, unknown> | undefined;
    let recordRow: Record<string, unknown> | undefined;
    let runInsertCount = 0;
    let recordInsertCount = 0;
    let batchRow: Record<string, unknown> | undefined;
    let normalizedRow: Record<string, unknown> | undefined;
    let receipt:
      { operation: string; payloadHash: string; result: unknown } | undefined;
    const client: DatabaseClient = {
      query: vi.fn(async (text: string, values: readonly unknown[] = []) => {
        queries.push(text);
        if (
          text.includes('pg_advisory_xact_lock') &&
          String(values[0]).startsWith('legacy-finance:')
        )
          lockEvents.push('source');
        if (text.includes('lock_finance_book_grant')) lockEvents.push('book');
        const lower = text.toLowerCase();
        if (
          lower === 'begin' ||
          lower === 'commit' ||
          lower === 'rollback' ||
          lower.startsWith('set local') ||
          lower.includes('select set_config')
        )
          return queryResult();
        if (lower.includes('lock_active_request_scope'))
          return queryResult([{ authorized: true }]);
        if (lower.includes('lock_finance_book_grant'))
          return queryResult([{ allowed: true }]);
        if (lower.includes('from emdo.finance_book_grants'))
          return queryResult([{ role: 'administrator' }]);
        if (lower.includes('from emdo.finance_financial_accounts'))
          return queryResult([{ id: accountId }]);
        if (lower.includes('from emdo.finance_ledger_accounts'))
          return queryResult([{ id: ledgerId }]);
        if (lower.includes('from emdo.finance_book_evidence'))
          return queryResult([{ id: evidenceId }]);
        if (lower.includes('pg_advisory_xact_lock')) return queryResult();
        if (lower.includes('from emdo.sync_entities'))
          return queryResult([
            {
              id: legacyRowId,
              household_id: workspaceId,
              space_id: sourceSpaceId,
              original_owner_user_id: userId,
              entity_type: 'finance.transaction',
              entity_id: 'legacy-transaction',
              payload: transactionPayload,
              revision: 1,
              tombstoned_at: null,
              created_at: '2026-09-01T00:00:00.000Z',
              updated_at: '2026-09-01T00:00:00.000Z',
            },
          ]);
        if (
          lower.startsWith('insert into emdo.finance_legacy_migration_runs')
        ) {
          runInsertCount += 1;
          runRow = {
            id: values[0],
            source_household_id: values[3],
            source_space_id: values[4],
            source_owner_user_id: values[5],
            target_owner_user_id: values[6],
            book_id: values[2],
            mapping: JSON.parse(String(values[7])),
            status: values[11],
            revision: 1,
            source_snapshot_hash: values[8],
            mapping_hash: values[9],
            source_count: values[12],
            ready_count: values[13],
            blocked_count: values[14],
            backfilled_count: 0,
            unresolved_count: values[15],
            created_by: values[16],
            created_at: '2026-09-14T12:00:00.000Z',
            updated_at: '2026-09-14T12:00:00.000Z',
          };
          return queryResult();
        }
        if (
          lower.startsWith('insert into emdo.finance_legacy_migration_records')
        ) {
          recordInsertCount += 1;
          recordRow = {
            id: values[0],
            workspace_id: values[1],
            book_id: values[2],
            migration_id: values[3],
            source_household_id: values[4],
            source_space_id: values[5],
            source_owner_user_id: values[6],
            legacy_row_id: values[7],
            entity_type: values[8],
            entity_id: values[9],
            source_revision: values[10],
            tombstoned: values[11],
            payload: JSON.parse(String(values[12])),
            payload_hash: values[13],
            provenance: JSON.parse(String(values[14])),
            candidate_status: values[15],
            disposition: values[16],
            normalized: JSON.parse(String(values[17])),
            classification: JSON.parse(String(values[18])),
            blockers: JSON.parse(String(values[19])),
            target_record_id: values[20],
            target_batch_id: values[21],
            target_row_id: values[22],
            backfill_state: values[32],
            backfilled_at: null,
            revision: 1,
            created_at: '2026-09-14T12:00:00.000Z',
            updated_at: '2026-09-14T12:00:00.000Z',
          };
          return queryResult();
        }
        if (lower.includes('select operation,payload_hash,result'))
          return receipt
            ? queryResult([
                {
                  operation: receipt.operation,
                  payload_hash: receipt.payloadHash,
                  result: receipt.result,
                },
              ])
            : queryResult();
        if (lower.includes('inspect_idempotency_key'))
          return runRow ? queryResult([runRow]) : queryResult();
        if (lower.startsWith('insert into emdo.finance_normalized_imports')) {
          batchRow = {
            financial_account_id: values[3],
            evidence_id: values[4],
            mapping: JSON.parse(String(values[5])),
            parser_version: 'legacy-finance-migration.v1',
          };
          return queryResult();
        }
        if (lower.startsWith('select financial_account_id,evidence_id,mapping'))
          return batchRow ? queryResult([batchRow]) : queryResult();
        if (
          lower.startsWith('insert into emdo.finance_normalized_import_rows')
        ) {
          normalizedRow = {
            batch_id: values[3],
            source_row: values[4],
            source_facts: JSON.parse(String(values[5])),
            effective_on: values[6],
            description: values[7],
            native_amount: values[8],
            external_id: values[9],
          };
          return queryResult();
        }
        if (lower.startsWith('select batch_id,source_row,source_facts'))
          return normalizedRow ? queryResult([normalizedRow]) : queryResult();
        if (
          lower.startsWith(
            'update emdo.finance_legacy_migration_records set backfill_state=',
          )
        ) {
          if (recordRow) {
            recordRow.backfill_state = 'backfilled';
            recordRow.backfilled_at = '2026-09-14T12:00:01.000Z';
            recordRow.revision = 2;
          }
          return queryResult(recordRow ? [{ id: recordRow.id }] : []);
        }
        if (
          lower.startsWith(
            "update emdo.finance_legacy_migration_runs set status='backfilled'",
          )
        ) {
          if (runRow) {
            runRow.status = 'backfilled';
            runRow.backfilled_count = runRow.ready_count;
            runRow.revision = 2;
          }
          return queryResult(runRow ? [{ id: runRow.id }] : []);
        }
        if (lower.startsWith('insert into emdo.finance_command_receipts')) {
          receipt = {
            operation: String(values[3]),
            payloadHash: String(values[4]),
            result: JSON.parse(String(values[5])),
          };
          return queryResult();
        }
        if (
          lower.includes('from emdo.finance_legacy_migration_runs') &&
          lower.includes('where workspace_id=$1 and id=$2')
        )
          return runRow ? queryResult([runRow]) : queryResult();
        if (lower.includes('from emdo.finance_legacy_migration_records'))
          return recordRow ? queryResult([recordRow]) : queryResult();
        throw new Error(`Unexpected legacy migration query: ${text}`);
      }),
      release: vi.fn(),
    };
    const pool: DatabasePool = { connect: vi.fn(async () => client) };
    const repository = new PostgresFinanceLegacyMigrationRepository(pool);
    const context = { workspaceId, userId, sessionId, requestId };
    const request = { mapping, idempotencyKey: 'legacy-inspect-2026-09-14' };

    const first = await repository.inspect(context, request);
    const second = await repository.inspect(context, request);

    expect(first.plan.status).toBe('ready');
    expect(first.records[0]).toMatchObject({
      source: source,
      normalized: {
        nativeAmount: '-42.05',
        currency: 'CAD',
        sourceRow: 7,
        externalId: 'statement-7',
        sourceHash: digest('a'),
        fingerprint: digest('b'),
      },
    });
    expect(second.run.id).toBe(first.run.id);
    expect(runInsertCount).toBe(1);
    expect(recordInsertCount).toBe(1);
    const sourceQuery = queries.find((query) =>
      query.toLowerCase().includes('from emdo.sync_entities'),
    );
    expect(sourceQuery).toContain(
      'where household_id=$1 and space_id=$2 and original_owner_user_id=$3',
    );
    expect(
      queries.some((query) =>
        /\b(?:update|delete)\s+emdo\.sync_entities\b/iu.test(query),
      ),
    ).toBe(false);
    expect(
      queries.some((query) =>
        query.toLowerCase().includes('finance_normalized_import'),
      ),
    ).toBe(false);

    const backfillRequest = {
      migrationId: first.run.id,
      expectedRevision: first.run.revision,
      sourceSnapshotHash: first.plan.sourceSnapshotHash,
      idempotencyKey: 'legacy-backfill-2026-09-14',
    };
    const backfilled = await repository.backfill(context, backfillRequest);
    const replayed = await repository.backfill(context, backfillRequest);
    expect(backfilled).toMatchObject({
      migrationId: first.run.id,
      status: 'backfilled',
      backfilledCount: 1,
      replayed: false,
    });
    expect(replayed).toEqual(backfilled);
    expect(receipt?.operation).toBe('finance-legacy-migration.backfill');
    expect(lockEvents).toEqual([
      'source',
      'book',
      'source',
      'book',
      'source',
      'book',
      'source',
      'book',
    ]);
    expect(
      queries.some((query) =>
        query
          .toLowerCase()
          .includes('insert into emdo.finance_command_receipts'),
      ),
    ).toBe(true);
  });
});

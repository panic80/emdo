import { describe, expect, it, vi } from 'vitest';

import {
  applyTransactionLedgerOperation,
  validateFinanceRecord,
  type FinanceBudgetRecord,
  type FinanceRecord,
  type FinanceTransactionRecord,
} from '@emdo/domains/finance';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import {
  PostgresFinanceSpecialistRecordRepository,
  type FinanceSpecialistRecordRepositoryScope,
} from './postgres-finance-specialist-record-repository.js';

const ids = Object.freeze({
  household: 'e1000000-0000-4000-8000-000000000001',
  privateSpace: 'e1000000-0000-4000-8000-000000000002',
  user: 'e1000000-0000-4000-8000-000000000003',
  session: 'e1000000-0000-4000-8000-000000000004',
  request: 'e1000000-0000-4000-8000-000000000005',
  run: 'e1000000-0000-4000-8000-000000000006',
  grant: 'e1000000-0000-4000-8000-000000000007',
  rowOne: 'e1000000-0000-4000-8000-000000000008',
  rowTwo: 'e1000000-0000-4000-8000-000000000009',
  audit: 'e1000000-0000-4000-8000-000000000010',
});

const scope = Object.freeze({
  requestId: ids.request,
  runId: ids.run,
  userId: ids.user,
  householdId: ids.household,
  sessionId: ids.session,
  privateSpaceId: ids.privateSpace,
  spaceAccessGrantId: ids.grant,
  collectionAuthorizationScopeFingerprint: 'b'.repeat(64),
  abortSignal: new AbortController().signal,
} satisfies FinanceSpecialistRecordRepositoryScope);

const transaction = (
  overrides: Partial<FinanceTransactionRecord> = {},
): FinanceTransactionRecord => {
  const validated = validateFinanceRecord({
    schemaVersion: 1,
    id: 'transaction-1',
    spaceId: ids.privateSpace,
    ownerUserId: ids.user,
    createdAt: '2026-08-26T12:00:00.000Z',
    updatedAt: '2026-08-26T12:00:00.000Z',
    recordType: 'transaction',
    accountId: 'account-1',
    categoryId: null,
    postedOn: '2026-08-26',
    description: 'Groceries',
    annotation: null,
    currency: 'CAD',
    originalAmountCadMinor: -1_299,
    effectiveAmountCadMinor: -1_299,
    adjustments: [],
    reversal: null,
    appliedOperationIds: [],
    source: { kind: 'manual' },
    revision: 0,
    ...overrides,
  });
  if (
    validated.status !== 'accepted' ||
    validated.record.recordType !== 'transaction'
  ) {
    throw new Error('transaction fixture is invalid');
  }
  return validated.record;
};

const ledgerTransaction = (input: {
  readonly current: FinanceTransactionRecord;
  readonly operation: unknown;
  readonly updatedAt: string;
}): FinanceTransactionRecord => {
  const applied = applyTransactionLedgerOperation({
    transaction: input.current,
    operation: input.operation,
    updatedAt: input.updatedAt,
  });
  if (applied.status !== 'applied' || applied.transaction === null) {
    throw new Error('ledger fixture is invalid');
  }
  return transaction({
    ...applied.transaction,
    revision: (input.current.revision ?? 0) + 1,
    updatedAt: input.updatedAt,
  });
};

const account = (): FinanceRecord => {
  const validated = validateFinanceRecord({
    schemaVersion: 1,
    id: 'account-1',
    spaceId: ids.privateSpace,
    ownerUserId: ids.user,
    createdAt: '2026-08-01T12:00:00.000Z',
    updatedAt: '2026-08-01T12:00:00.000Z',
    recordType: 'account',
    name: 'Chequing',
    accountKind: 'chequing',
    currency: 'CAD',
    openingBalanceCadMinor: 0,
    active: true,
    source: 'manual',
  });
  if (validated.status !== 'accepted')
    throw new Error('account fixture invalid');
  return validated.record;
};

const budget = (): FinanceBudgetRecord => {
  const validated = validateFinanceRecord({
    schemaVersion: 1,
    id: 'budget-2026-08',
    spaceId: ids.privateSpace,
    ownerUserId: ids.user,
    createdAt: '2026-08-01T12:00:00.000Z',
    updatedAt: '2026-08-01T12:00:00.000Z',
    recordType: 'budget',
    month: '2026-08',
    currency: 'CAD',
    allocations: [{ categoryId: 'groceries', amountCadMinor: 50_000 }],
    revision: 0,
  });
  if (
    validated.status !== 'accepted' ||
    validated.record.recordType !== 'budget'
  ) {
    throw new Error('budget fixture invalid');
  }
  return validated.record;
};

const entityRow = (
  record: FinanceRecord,
  revision: number,
  rowId: string = ids.rowOne,
  includeRowId = false,
) => ({
  ...(includeRowId ? { rowId } : {}),
  entityId: record.id,
  entityType: `finance.${record.recordType}`,
  payload: record,
  revision,
});

const withoutRevision = (record: FinanceTransactionRecord) =>
  Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== 'revision'),
  );

const authorityRow = Object.freeze({
  grantId: ids.grant,
  userId: ids.user,
  sessionId: ids.session,
  requestId: ids.request,
  householdId: ids.household,
  privateSpaceId: ids.privateSpace,
  writableSpaceIds: [ids.privateSpace],
});

const command = (
  operation:
    | 'manual-transaction-create'
    | 'transaction-nondestructive-patch'
    | 'monthly-category-budget-create'
    | 'monthly-category-budget-update'
    | 'finance-transaction-adjustment'
    | 'finance-transaction-reversal',
  canonicalHash = 'a'.repeat(64),
) => ({
  scope,
  idempotencyKey: `finance-agent:${canonicalHash}`,
  canonicalHash,
  audit: {
    eventType: 'finance.agent.safe-write' as const,
    operation,
    canonicalHash,
    requestId: ids.request,
    runId: ids.run,
  },
});

type QueryResponse =
  | readonly Record<string, unknown>[]
  | Readonly<{
      readonly rows: readonly Record<string, unknown>[];
      readonly rowCount?: number | null;
    }>;
type Respond = (
  sql: string,
  values: readonly unknown[],
) => Promise<QueryResponse> | QueryResponse;

const poolFor = (respond: Respond) => {
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    const result = await respond(sql, values);
    if (
      typeof result === 'object' &&
      result !== null &&
      !Array.isArray(result) &&
      'rows' in result
    ) {
      return {
        rows: result.rows,
        rowCount: result.rowCount ?? result.rows.length,
      };
    }
    return { rows: result, rowCount: result.length };
  });
  const release = vi.fn();
  const client: DatabaseClient = { query, release };
  const pool: DatabasePool = { connect: vi.fn(async () => client) };
  return { pool, query, release };
};

const scopedRows = (
  sql: string,
): readonly Record<string, unknown>[] | undefined => {
  if (sql.includes('lock_active_request_scope')) return [{ authorized: true }];
  if (sql.includes('resolve_space_access_grant')) return [authorityRow];
  if (sql.includes('from emdo.spaces as space'))
    return [{ id: ids.privateSpace }];
  return undefined;
};

describe('PostgresFinanceSpecialistRecordRepository', () => {
  it('overlays a legacy transaction payload revision from its canonical entity row and paginates by stable row id', async () => {
    const legacy = transaction({
      id: 'transaction-legacy',
      revision: undefined,
    });
    const next = transaction({ id: 'transaction-next', revision: undefined });
    const { pool, query } = poolFor((sql) => {
      const scoped = scopedRows(sql);
      if (scoped !== undefined) return scoped;
      if (sql.includes('from emdo.sync_entities as entity')) {
        const legacyPayload = withoutRevision(legacy);
        const nextPayload = withoutRevision(next);
        return [
          {
            ...entityRow(legacy, 4, ids.rowOne, true),
            payload: legacyPayload,
          },
          {
            ...entityRow(next, 5, ids.rowTwo, true),
            payload: nextPayload,
          },
        ];
      }
      return [];
    });
    const repository = new PostgresFinanceSpecialistRecordRepository(pool);

    await expect(
      repository.list({
        scope,
        recordTypes: ['transaction'],
        limit: 1,
      }),
    ).resolves.toEqual({
      records: [expect.objectContaining({ id: legacy.id, revision: 4 })],
      nextCursor: ids.rowOne,
    });

    const listQuery = query.mock.calls.find(([sql]) =>
      String(sql).includes('order by entity.id asc'),
    );
    expect(listQuery?.[0]).toContain('entity.id > $5::uuid');
    expect(listQuery?.[1]).toEqual([
      ids.household,
      ids.privateSpace,
      ids.user,
      ['finance.transaction'],
      null,
      2,
    ]);
  });

  it('reads exact owned records, one monthly budget, and month-filtered canonical transactions', async () => {
    const owned = transaction();
    const otherMonth = transaction({
      id: 'transaction-other',
      postedOn: '2026-07-31',
    });
    const monthlyBudget = budget();
    const { pool } = poolFor((sql) => {
      const scoped = scopedRows(sql);
      if (scoped !== undefined) return scoped;
      if (sql.includes('entity.entity_id = $4::text'))
        return [entityRow(owned, 1)];
      if (sql.includes("entity.entity_type = 'finance.budget'"))
        return [entityRow(monthlyBudget, 1)];
      if (sql.includes("entity.entity_type = 'finance.transaction'"))
        return [entityRow(owned, 1), entityRow(otherMonth, 1, ids.rowTwo)];
      return [];
    });
    const repository = new PostgresFinanceSpecialistRecordRepository(pool);

    await expect(
      repository.getOwnedRecord({ scope, recordId: owned.id }),
    ).resolves.toEqual(owned);
    await expect(
      repository.getOwnedBudgetForMonth({ scope, month: '2026-08' }),
    ).resolves.toEqual(monthlyBudget);
    await expect(
      repository.listBudgetTransactions({
        scope,
        month: '2026-08',
        reviewedCommittedEvidenceOnly: true,
      }),
    ).resolves.toEqual([owned]);
  });

  it('creates only a validated manual transaction, then atomically writes its audit event and receipt', async () => {
    const record = transaction();
    const { pool, query, release } = poolFor((sql) => {
      const scoped = scopedRows(sql);
      if (scoped !== undefined) return scoped;
      if (sql.includes('finance_specialist_record_receipts as receipt'))
        return [];
      if (
        sql.includes('entity.entity_type = $4::text') &&
        sql.includes('for key share')
      )
        return [entityRow(account(), 1)];
      if (sql.includes('insert into emdo.sync_entities'))
        return [entityRow(record, 1)];
      if (sql.includes('insert into emdo.audit_events'))
        return [{ auditEventId: ids.audit }];
      if (sql.includes('insert into emdo.finance_specialist_record_receipts'))
        return [{ auditEventId: ids.audit }];
      return [];
    });
    const repository = new PostgresFinanceSpecialistRecordRepository(pool);

    await expect(
      repository.createManualTransaction({
        ...command('manual-transaction-create'),
        record,
      }),
    ).resolves.toEqual({
      status: 'applied',
      record,
      auditEventId: ids.audit,
    });

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(
      statements.some((sql) => sql.includes('pg_advisory_xact_lock')),
    ).toBe(true);
    expect(
      statements.some((sql) => sql.includes('insert into emdo.audit_events')),
    ).toBe(true);
    const receipt = query.mock.calls.find(([sql]) =>
      String(sql).includes(
        'insert into emdo.finance_specialist_record_receipts',
      ),
    );
    expect(receipt?.[1]).toEqual(
      expect.arrayContaining([
        'manual-transaction-create',
        'a'.repeat(64),
        scope.collectionAuthorizationScopeFingerprint,
        ids.audit,
      ]),
    );
    expect(release).toHaveBeenCalledWith();
  });

  it('replays only an exact canonical receipt and retrieves its immutable entity revision', async () => {
    const record = transaction();
    const canonicalHash = 'c'.repeat(64);
    const receipt = {
      operation: 'manual-transaction-create',
      idempotencyKey: `finance-agent:${canonicalHash}`,
      canonicalHash,
      scopeFingerprint: scope.collectionAuthorizationScopeFingerprint,
      originSessionId: ids.session,
      originRequestId: ids.request,
      originRunId: ids.run,
      originSpaceAccessGrantId: ids.grant,
      entityType: 'finance.transaction',
      entityId: record.id,
      resultingRevision: 1,
      auditEventId: ids.audit,
    };
    const { pool, query } = poolFor((sql) => {
      const scoped = scopedRows(sql);
      if (scoped !== undefined) return scoped;
      if (sql.includes('finance_specialist_record_receipts as receipt'))
        return [receipt];
      if (sql.includes('from emdo.sync_entity_revisions as revision'))
        return [entityRow(record, 1)];
      if (sql.includes('insert into'))
        throw new Error('duplicate must not issue a write');
      return [];
    });
    const repository = new PostgresFinanceSpecialistRecordRepository(pool);

    await expect(
      repository.createManualTransaction({
        ...command('manual-transaction-create', canonicalHash),
        record,
      }),
    ).resolves.toEqual({
      status: 'duplicate',
      record,
      auditEventId: ids.audit,
    });
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes('from emdo.sync_entity_revisions as revision'),
      ),
    ).toBe(true);
  });

  it('uses the locked database revision for a non-destructive metadata patch', async () => {
    const current = transaction({ revision: 0 });
    const next = transaction({
      revision: 1,
      description: 'Weekly groceries',
      updatedAt: '2026-08-26T13:00:00.000Z',
    });
    const { pool, query } = poolFor((sql) => {
      const scoped = scopedRows(sql);
      if (scoped !== undefined) return scoped;
      if (sql.includes('finance_specialist_record_receipts as receipt'))
        return [];
      if (
        sql.includes('for update') &&
        sql.includes('entity.entity_type = $5::text')
      )
        return [entityRow(current, 1)];
      if (
        sql.includes('entity.entity_type = $4::text') &&
        sql.includes('for key share')
      )
        return [entityRow(account(), 1)];
      if (sql.includes('update emdo.sync_entities as entity'))
        return [entityRow(next, 2)];
      if (sql.includes('insert into emdo.audit_events'))
        return [{ auditEventId: ids.audit }];
      if (sql.includes('insert into emdo.finance_specialist_record_receipts'))
        return [{ auditEventId: ids.audit }];
      return [];
    });
    const repository = new PostgresFinanceSpecialistRecordRepository(pool);

    await expect(
      repository.patchOwnedTransaction({
        ...command('transaction-nondestructive-patch', 'd'.repeat(64)),
        current,
        record: next,
        expectedRevision: 0,
      }),
    ).resolves.toMatchObject({
      status: 'applied',
      record: { description: 'Weekly groceries', revision: 1 },
    });

    const update = query.mock.calls.find(([sql]) =>
      String(sql).includes('update emdo.sync_entities as entity'),
    );
    expect(update?.[0]).toContain('and entity.revision = $8::integer');
    expect(update?.[1]).toEqual(expect.arrayContaining([1]));
  });

  it('persists exact approved adjustment and reversal ledger revisions with separate receipts', async () => {
    const adjustmentCurrent = transaction({ revision: 2 });
    const adjustmentOperation = 'e1000000-0000-4000-8000-000000000011';
    const adjusted = ledgerTransaction({
      current: adjustmentCurrent,
      operation: {
        operationId: adjustmentOperation,
        kind: 'adjustment',
        amountCadMinor: 50,
        reason: 'Correct the receipt total.',
      },
      updatedAt: '2026-08-26T13:00:00.000Z',
    });
    const reversalCurrent = transaction({ id: 'transaction-2', revision: 4 });
    const reversalOperation = 'e1000000-0000-4000-8000-000000000012';
    const reversed = ledgerTransaction({
      current: reversalCurrent,
      operation: {
        operationId: reversalOperation,
        kind: 'reversal',
        reason: 'Reverse the duplicate line.',
      },
      updatedAt: '2026-08-26T13:00:00.000Z',
    });
    let target: FinanceTransactionRecord = adjustmentCurrent;
    let result: FinanceTransactionRecord = adjusted;
    const { pool, query } = poolFor((sql) => {
      const scoped = scopedRows(sql);
      if (scoped !== undefined) return scoped;
      if (sql.includes('finance_specialist_record_receipts as receipt'))
        return [];
      if (
        sql.includes('for update') &&
        sql.includes('entity.entity_type = $5::text')
      )
        return [entityRow(target, target.revision ?? 1)];
      if (
        sql.includes('entity.entity_type = $4::text') &&
        sql.includes('for key share')
      )
        return [entityRow(account(), 1)];
      if (sql.includes('update emdo.sync_entities as entity'))
        return [entityRow(result, (target.revision ?? 0) + 1)];
      if (sql.includes('insert into emdo.audit_events'))
        return [{ auditEventId: ids.audit }];
      if (sql.includes('insert into emdo.finance_specialist_record_receipts'))
        return [{ auditEventId: ids.audit }];
      return [];
    });
    const repository = new PostgresFinanceSpecialistRecordRepository(pool);

    await expect(
      repository.applyTransactionAdjustment({
        ...command('finance-transaction-adjustment', '1'.repeat(64)),
        current: adjustmentCurrent,
        record: adjusted,
        expectedRevision: 2,
        operationId: adjustmentOperation,
        amountCadMinor: 50,
        reason: 'Correct the receipt total.',
      }),
    ).resolves.toMatchObject({
      status: 'applied',
      record: {
        revision: 3,
        effectiveAmountCadMinor: -1_249,
        adjustments: [
          expect.objectContaining({ operationId: adjustmentOperation }),
        ],
      },
    });

    target = reversalCurrent;
    result = reversed;
    await expect(
      repository.applyTransactionReversal({
        ...command('finance-transaction-reversal', '2'.repeat(64)),
        current: reversalCurrent,
        record: reversed,
        expectedRevision: 4,
        operationId: reversalOperation,
        reason: 'Reverse the duplicate line.',
      }),
    ).resolves.toMatchObject({
      status: 'applied',
      record: {
        revision: 5,
        effectiveAmountCadMinor: 0,
        reversal: expect.objectContaining({ operationId: reversalOperation }),
      },
    });

    const receiptOperations = query.mock.calls
      .filter(([sql]) =>
        String(sql).includes(
          'insert into emdo.finance_specialist_record_receipts',
        ),
      )
      .map(([, values]) => values)
      .flat();
    expect(receiptOperations).toEqual(
      expect.arrayContaining([
        'finance-transaction-adjustment',
        'finance-transaction-reversal',
      ]),
    );
  });

  it('replays an exact approved ledger receipt but rejects a tampered target before persistence', async () => {
    const current = transaction({ revision: 2 });
    const operationId = 'e1000000-0000-4000-8000-000000000013';
    const record = ledgerTransaction({
      current,
      operation: {
        operationId,
        kind: 'adjustment',
        amountCadMinor: 50,
        reason: 'Correct the receipt total.',
      },
      updatedAt: '2026-08-26T13:00:00.000Z',
    });
    const canonicalHash = '3'.repeat(64);
    const receipt = {
      operation: 'finance-transaction-adjustment',
      idempotencyKey: `finance-agent:${canonicalHash}`,
      canonicalHash,
      scopeFingerprint: scope.collectionAuthorizationScopeFingerprint,
      originSessionId: ids.session,
      originRequestId: ids.request,
      originRunId: ids.run,
      originSpaceAccessGrantId: ids.grant,
      entityType: 'finance.transaction',
      entityId: record.id,
      resultingRevision: 3,
      auditEventId: ids.audit,
    };
    const { pool } = poolFor((sql) => {
      const scoped = scopedRows(sql);
      if (scoped !== undefined) return scoped;
      if (sql.includes('finance_specialist_record_receipts as receipt'))
        return [receipt];
      if (sql.includes('from emdo.sync_entity_revisions as revision'))
        return [entityRow(record, 3)];
      if (sql.includes('insert into'))
        throw new Error('replay must not issue a write');
      return [];
    });
    const repository = new PostgresFinanceSpecialistRecordRepository(pool);
    const input = {
      ...command('finance-transaction-adjustment', canonicalHash),
      current,
      record,
      expectedRevision: 2,
      operationId,
      amountCadMinor: 50,
      reason: 'Correct the receipt total.',
    };

    await expect(
      repository.applyTransactionAdjustment(input),
    ).resolves.toMatchObject({
      status: 'duplicate',
      record,
    });
    await expect(
      repository.applyTransactionAdjustment({
        ...input,
        record: transaction({
          ...record,
          adjustments: [
            {
              operationId,
              amountCadMinor: 50,
              reason: 'A different but still valid reason.',
            },
          ],
        }),
      }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
  });

  it('rejects imported-description edits before it obtains a database connection', async () => {
    const imported = transaction({
      source: {
        kind: 'import',
        sourceHash: 'e'.repeat(64),
        sourceRow: 1,
        fingerprint: 'f'.repeat(64),
        externalId: null,
      },
      revision: 3,
    });
    const edited = transaction({
      ...imported,
      description: 'Forged import edit',
      revision: 4,
      updatedAt: '2026-08-26T13:00:00.000Z',
    });
    const { pool } = poolFor(() => []);
    const repository = new PostgresFinanceSpecialistRecordRepository(pool);

    await expect(
      repository.patchOwnedTransaction({
        ...command('transaction-nondestructive-patch', 'd'.repeat(64)),
        current: imported,
        record: edited,
        expectedRevision: 3,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('rejects a zero-value manual transaction before it obtains a database connection', async () => {
    const record = transaction({
      originalAmountCadMinor: 0,
      effectiveAmountCadMinor: 0,
    });
    const { pool } = poolFor(() => []);
    const repository = new PostgresFinanceSpecialistRecordRepository(pool);

    await expect(
      repository.createManualTransaction({
        ...command('manual-transaction-create', 'e'.repeat(64)),
        record,
      }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import {
  FinanceImportPersistenceError,
  PostgresFinanceImportRepository,
} from './postgres-finance-import-repository.js';

const ids = {
  user: 'b1000000-0000-4000-8000-000000000001',
  session: 'b1000000-0000-4000-8000-000000000002',
  request: 'b1000000-0000-4000-8000-000000000003',
  household: 'b1000000-0000-4000-8000-000000000004',
  grant: 'b1000000-0000-4000-8000-000000000005',
  account: 'b1000000-0000-4000-8000-000000000006',
  space: 'b1000000-0000-4000-8000-000000000007',
  plan: 'b1000000-0000-4000-8000-000000000008',
  receipt: 'b1000000-0000-4000-8000-000000000009',
  commitRequest: 'b1000000-0000-4000-8000-000000000010',
  commitGrant: 'b1000000-0000-4000-8000-000000000011',
} as const;

const principal = {
  userId: ids.user,
  sessionId: ids.session,
  householdId: ids.household,
  role: 'owner' as const,
  emailVerified: true as const,
  spaceAccessGrantId: ids.grant,
  collectionAuthorizationScopeFingerprint: 'f'.repeat(64),
};

const sourceText = [
  'posted,description,amount',
  '2026-08-11,Groceries,-12.34',
].join('\n');
const input = {
  accountId: ids.account,
  format: 'csv' as const,
  mapping: {
    dateFormat: 'yyyy-mm-dd' as const,
    defaultCategoryId: null,
    columns: {
      postedOn: 'posted',
      description: 'description',
      amount: 'amount',
    },
  },
  sourceText,
  principal,
  requestId: ids.request,
};

const poolFor = (
  respond: (
    sql: string,
    values: readonly unknown[],
  ) => readonly Record<string, unknown>[],
) => {
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => ({
    rowCount: 1,
    rows: respond(sql, values),
  }));
  const release = vi.fn();
  const client: DatabaseClient = { query, release };
  const pool: DatabasePool = { connect: vi.fn(async () => client) };
  return { pool, query, release };
};

const scopeRow = {
  finance_import_scope: {
    accountId: ids.account,
    spaceId: ids.space,
    ownerUserId: ids.user,
    scopeFingerprint: 'a'.repeat(64),
    existingFingerprints: [],
  },
};

describe('PostgresFinanceImportRepository', () => {
  it('accepts an authenticated principal with its server-derived private space and reads only current manual CAD import destinations', async () => {
    const { pool, query } = poolFor((sql) =>
      sql.includes('read_finance_import_destinations')
        ? [
            {
              finance_import_destinations: {
                schemaVersion: 1,
                accounts: [
                  {
                    id: 'account::chequing',
                    name: 'Everyday chequing',
                    accountKind: 'chequing',
                  },
                ],
                categories: [
                  {
                    id: 'category::groceries',
                    name: 'Groceries',
                    categoryKind: 'expense',
                  },
                ],
              },
            },
          ]
        : [],
    );

    await expect(
      new PostgresFinanceImportRepository(pool).listDestinations({
        principal: { ...principal, privateSpaceId: ids.space },
        requestId: ids.request,
      }),
    ).resolves.toEqual({
      schemaVersion: 1,
      accounts: [
        {
          id: 'account::chequing',
          name: 'Everyday chequing',
          accountKind: 'chequing',
        },
      ],
      categories: [
        {
          id: 'category::groceries',
          name: 'Groceries',
          categoryKind: 'expense',
        },
      ],
    });
    const aggregate = query.mock.calls.find(([sql]) =>
      sql.includes('read_finance_import_destinations'),
    );
    expect(aggregate?.[1]).toEqual([
      ids.household,
      ids.grant,
      principal.collectionAuthorizationScopeFingerprint,
      principal.role,
    ]);
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'begin',
      'set local row_security = on',
      "set local statement_timeout = '30s'",
      "set local lock_timeout = '5s'",
      expect.stringContaining("set_config('emdo.user_id'"),
      expect.stringContaining('lock_active_request_scope'),
      expect.stringContaining('read_finance_import_destinations'),
      'commit',
    ]);
  });

  it('fails closed when the destinations aggregate includes a forbidden field', async () => {
    const { pool } = poolFor((sql) =>
      sql.includes('read_finance_import_destinations')
        ? [
            {
              finance_import_destinations: {
                schemaVersion: 1,
                accounts: [
                  {
                    id: 'account::chequing',
                    name: 'Everyday chequing',
                    accountKind: 'chequing',
                    balanceCadMinor: 100,
                  },
                ],
                categories: [],
              },
            },
          ]
        : [],
    );

    await expect(
      new PostgresFinanceImportRepository(pool).listDestinations({
        principal,
        requestId: ids.request,
      }),
    ).rejects.toMatchObject({ code: 'invalid-result' });
  });

  it('parses the statement only in memory and stores a bounded canonical plan without source text or header strings', async () => {
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('read_finance_import_preview_scope')) return [scopeRow];
      if (sql.includes('persist_finance_import_plan')) {
        return [
          {
            finance_import_plan: {
              status: 'stored',
              planId: ids.plan,
              expiresAt: '2026-08-13T16:30:00.000Z',
            },
          },
        ];
      }
      return [];
    });

    const result = await new PostgresFinanceImportRepository(pool, {
      generateUuid: () => ids.plan,
    }).preview(input);

    expect(result).toEqual({
      schemaVersion: 1,
      plan: {
        id: ids.plan,
        sourceHash: createHash('sha256')
          .update(sourceText, 'utf8')
          .digest('hex'),
        expiresAt: '2026-08-13T16:30:00.000Z',
        summary: { accepted: 1, rejected: 0, duplicates: 0 },
        rejectedRows: [],
        duplicateRows: [],
      },
    });

    const persisted = query.mock.calls.find(([sql]) =>
      sql.includes('persist_finance_import_plan'),
    );
    expect(persisted?.[1]?.[0]).toEqual(ids.plan);
    expect(persisted?.[1]?.[1]).toMatch(/^[a-f0-9]{64}$/u);
    expect(persisted?.[1]?.[2]).toMatch(/^[a-f0-9]{64}$/u);
    expect(persisted?.[1]?.[3]).toEqual(
      expect.objectContaining({ transactions: expect.any(Array) }),
    );
    expect(persisted?.[1]?.[4]).toEqual({
      rejectedRows: [],
      duplicateRows: [],
    });
    expect(persisted?.[1]?.[5]).toEqual({
      format: 'csv',
      dateFormat: 'yyyy-mm-dd',
      fields: {
        postedOn: true,
        description: true,
        amount: true,
        debit: false,
        credit: false,
        externalId: false,
        categoryId: false,
      },
      hasDefaultCategory: false,
    });
    expect(JSON.stringify(query.mock.calls)).not.toContain(sourceText);
    expect(JSON.stringify(persisted?.[1])).not.toContain('"posted"');
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'begin',
      'set local row_security = on',
      "set local statement_timeout = '30s'",
      "set local lock_timeout = '5s'",
      expect.stringContaining("set_config('emdo.user_id'"),
      expect.stringContaining('lock_active_request_scope'),
      expect.stringContaining('read_finance_import_preview_scope'),
      expect.stringContaining('persist_finance_import_plan'),
      'commit',
    ]);
  });

  it('fails closed when the locked current private-account scope is malformed or unavailable', async () => {
    const malformed = poolFor((sql) =>
      sql.includes('read_finance_import_preview_scope')
        ? [{ finance_import_scope: { accountId: ids.account } }]
        : [],
    );

    await expect(
      new PostgresFinanceImportRepository(malformed.pool).preview(input),
    ).rejects.toMatchObject({
      name: 'FinanceImportPersistenceError',
      code: 'invalid-result',
    } satisfies Partial<FinanceImportPersistenceError>);
    expect(malformed.release).toHaveBeenCalledOnce();
  });

  it('permits source deletion only after the aggregate commits or exact-replays the stored immutable plan receipt', async () => {
    const { pool, query } = poolFor((sql) =>
      sql.includes('commit_finance_import_plan')
        ? [
            {
              finance_import_commit: {
                status: 'replayed',
                receipt: {
                  id: ids.receipt,
                  planId: ids.plan,
                  transactionCount: 1,
                  verified: true,
                },
              },
            },
          ]
        : [],
    );

    await expect(
      new PostgresFinanceImportRepository(pool).commit({
        planId: ids.plan,
        idempotencyKey: 'finance-import:commit:0001',
        principal: { ...principal, spaceAccessGrantId: ids.commitGrant },
        requestId: ids.commitRequest,
      }),
    ).resolves.toEqual({
      schemaVersion: 1,
      status: 'replayed',
      receipt: {
        id: ids.receipt,
        planId: ids.plan,
        transactionCount: 1,
        verified: true,
      },
      sourceDeletionAuthorized: true,
    });
    const commit = query.mock.calls.find(([sql]) =>
      sql.includes('commit_finance_import_plan'),
    );
    expect(commit?.[1]).toEqual([
      ids.plan,
      'finance-import:commit:0001',
      ids.household,
      ids.commitGrant,
      principal.collectionAuthorizationScopeFingerprint,
      principal.role,
    ]);
  });

  it('bounds source UTF-8 bytes before acquiring a database session', async () => {
    const { pool } = poolFor(() => []);
    await expect(
      new PostgresFinanceImportRepository(pool).preview({
        ...input,
        sourceText: 'x'.repeat(1_048_577),
      }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('uses UTF-8 rather than character count for the source ceiling', async () => {
    const { pool } = poolFor(() => []);
    await expect(
      new PostgresFinanceImportRepository(pool).preview({
        ...input,
        sourceText: 'é'.repeat(524_289),
      }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('destroys an ambiguous commit session and retries the exact aggregate once', async () => {
    const receipt = {
      id: ids.receipt,
      planId: ids.plan,
      transactionCount: 1,
      verified: true,
    };
    const firstRelease = vi.fn();
    const secondRelease = vi.fn();
    let first = true;
    const firstClient: DatabaseClient = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'commit') throw new Error('lost acknowledgement');
        return {
          rowCount: 1,
          rows: sql.includes('commit_finance_import_plan')
            ? [{ finance_import_commit: { status: 'committed', receipt } }]
            : [],
        };
      }),
      release: firstRelease,
    };
    const secondClient: DatabaseClient = {
      query: vi.fn(async (sql: string) => ({
        rowCount: 1,
        rows: sql.includes('commit_finance_import_plan')
          ? [{ finance_import_commit: { status: 'replayed', receipt } }]
          : [],
      })),
      release: secondRelease,
    };
    const pool: DatabasePool = {
      connect: vi.fn(async () =>
        first ? ((first = false), firstClient) : secondClient,
      ),
    };

    await expect(
      new PostgresFinanceImportRepository(pool).commit({
        planId: ids.plan,
        idempotencyKey: 'finance-import:commit:0003',
        principal,
        requestId: ids.request,
      }),
    ).resolves.toMatchObject({
      status: 'replayed',
      sourceDeletionAuthorized: true,
    });
    expect(firstRelease).toHaveBeenCalledWith(true);
    expect(secondRelease).toHaveBeenCalledOnce();
  });

  it('replays exactly one ambiguous preview persistence with the original plan identity and payload', async () => {
    const firstRelease = vi.fn();
    const secondRelease = vi.fn();
    const persisted: unknown[][] = [];
    let first = true;
    const response = (sql: string, values: readonly unknown[]) => {
      if (sql.includes('read_finance_import_preview_scope')) return [scopeRow];
      if (sql.includes('persist_finance_import_plan')) {
        persisted.push([...values]);
        return [
          {
            finance_import_plan: {
              status: 'stored',
              planId: ids.plan,
              expiresAt: '2026-08-13T16:30:00.000Z',
            },
          },
        ];
      }
      return [];
    };
    const firstClient: DatabaseClient = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        if (sql === 'commit') throw new Error('lost acknowledgement');
        return { rowCount: 1, rows: response(sql, values) };
      }),
      release: firstRelease,
    };
    const secondClient: DatabaseClient = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => ({
        rowCount: 1,
        rows: response(sql, values),
      })),
      release: secondRelease,
    };
    const pool: DatabasePool = {
      connect: vi.fn(async () =>
        first ? ((first = false), firstClient) : secondClient,
      ),
    };
    const generateUuid = vi.fn(() => ids.plan);

    await expect(
      new PostgresFinanceImportRepository(pool, { generateUuid }).preview(
        input,
      ),
    ).resolves.toMatchObject({ plan: { id: ids.plan } });
    expect(firstRelease).toHaveBeenCalledWith(true);
    expect(secondRelease).toHaveBeenCalledOnce();
    expect(generateUuid).toHaveBeenCalledOnce();
    expect(persisted).toHaveLength(2);
    expect(persisted[1]).toEqual(persisted[0]);
  });

  it('maps known aggregate outcomes without returning SQL text', async () => {
    const unavailable = poolFor((sql) => {
      if (sql.includes('commit_finance_import_plan')) {
        throw new Error('emdo:finance-import-plan-expired');
      }
      return [];
    });
    await expect(
      new PostgresFinanceImportRepository(unavailable.pool).commit({
        planId: ids.plan,
        idempotencyKey: 'finance-import:commit:0004',
        principal,
        requestId: ids.request,
      }),
    ).rejects.toMatchObject({ code: 'plan-expired' });
  });

  it('uses a narrow readiness probe and rejects ambiguous aggregate acknowledgements', async () => {
    const ready = poolFor((sql) =>
      sql.includes('finance_imports_ready') ? [{ ready: true }] : [],
    );
    await expect(
      new PostgresFinanceImportRepository(ready.pool).checkReady(),
    ).resolves.toBe(true);

    const ambiguous = poolFor((sql) =>
      sql.includes('commit_finance_import_plan')
        ? [{ finance_import_commit: { status: 'committed' } }]
        : [],
    );
    await expect(
      new PostgresFinanceImportRepository(ambiguous.pool).commit({
        planId: ids.plan,
        idempotencyKey: 'finance-import:commit:0002',
        principal,
        requestId: ids.request,
      }),
    ).rejects.toMatchObject({
      name: 'FinanceImportPersistenceError',
      code: 'invalid-result',
    } satisfies Partial<FinanceImportPersistenceError>);
  });
});

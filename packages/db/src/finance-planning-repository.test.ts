import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient, DatabasePool } from './scoped-repository.js';
import { PostgresFinancePlanningRepository } from './finance-planning-repository.js';

const workspaceId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f70';
const userId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f71';
const sessionId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f72';
const requestId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f73';
const bookId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f74';
const budgetId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f75';
const periodId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f76';
const accountId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f77';

const context = { workspaceId, userId, sessionId, requestId };
const budget = {
  budgetId,
  name: 'FY26 operating plan',
  lines: [{ periodId, accountId, currency: 'CAD' as const, amount: '4.25' }],
};

const result = (rows: readonly Record<string, unknown>[] = []) => ({
  rows,
  rowCount: rows.length,
});

const transactionSetup = (query: string) => {
  const lower = query.toLowerCase();
  if (
    lower === 'begin' ||
    lower.startsWith('set local') ||
    lower.includes('select set_config') ||
    lower === 'commit' ||
    lower === 'rollback'
  )
    return true;
  return false;
};

describe('PostgresFinancePlanningRepository', () => {
  it('fails readiness closed unless all planning tables use forced RLS', async () => {
    const client: DatabaseClient = {
      query: vi.fn(async () =>
        result([{ planning_rls: true, restricted_role: true }]),
      ),
      release: vi.fn(),
    };
    const pool: DatabasePool = { connect: vi.fn(async () => client) };
    const repository = new PostgresFinancePlanningRepository(pool);

    await expect(repository.checkReady()).resolves.toBe(true);
    expect(client.query).toHaveBeenCalledOnce();
    expect(String(vi.mocked(client.query).mock.calls[0]?.[0])).toContain(
      'relforcerowsecurity',
    );

    vi.mocked(client.query).mockResolvedValueOnce(
      result([{ planning_rls: false, restricted_role: true }]),
    );
    await expect(repository.checkReady()).resolves.toBe(false);
  });

  it('derives read actuals from posted journal lines with account-kind sign basis', async () => {
    const queries: string[] = [];
    const client: DatabaseClient = {
      query: vi.fn(async (query: string) => {
        queries.push(query);
        const lower = query.toLowerCase();
        if (transactionSetup(query)) return result();
        if (lower.includes('lock_active_request_scope'))
          return result([{ authorized: true }]);
        if (lower.includes('lock_finance_book_grant'))
          return result([{ allowed: true }]);
        if (lower.includes('select b.functional_currency'))
          return result([{ functionalCurrency: 'CAD', role: 'administrator' }]);
        if (lower.includes('pg_advisory_xact_lock')) return result();
        if (lower.includes('from emdo.finance_budget_revisions b'))
          return result([
            {
              workspaceId,
              bookId,
              budgetId,
              revision: 1,
              name: budget.name,
              functionalCurrency: 'CAD',
              createdBy: userId,
              createdAt: '2026-09-13T00:00:00.000Z',
            },
          ]);
        if (lower.includes('from emdo.finance_budget_lines l'))
          return result([
            {
              budgetId,
              revision: 1,
              periodId,
              accountId,
              currency: 'CAD',
              amount: '4.25',
            },
          ]);
        if (lower.includes('from emdo.finance_budget_lines bl'))
          return result([
            {
              periodId,
              startsOn: '2026-09-01',
              endsOn: '2026-09-30',
              accountId,
              currency: 'CAD',
              accountKind: 'liability',
              debitAmount: '2.125000000000',
              creditAmount: '10.500000000000',
              journalCount: 2,
              lineCount: 4,
              snapshotAt: '2026-09-14T00:00:00.000Z',
            },
          ]);
        throw new Error(`Unexpected planning query: ${query}`);
      }),
      release: vi.fn(),
    };
    const pool: DatabasePool = { connect: vi.fn(async () => client) };
    const repository = new PostgresFinancePlanningRepository(pool);

    const actuals = await repository.budgetVsActuals(context, bookId, budgetId);
    expect(actuals.rows[0]).toMatchObject({
      accountKind: 'liability',
      budgetAmount: '4.25',
      postedActualAmount: '8.375',
      varianceAmount: '4.125',
      actualSignBasis: 'credit-minus-debit',
      sourceJournalCount: 2,
      sourceLineCount: 4,
    });
    expect(actuals.actualSource).toEqual({
      kind: 'authoritative-posted-ledger',
      coverage: 'posted-journals-in-budget-periods',
      signBasis: 'account-kind',
    });
    const aggregateQuery = queries.find((query) =>
      query.toLowerCase().includes('from emdo.finance_budget_lines bl'),
    );
    expect(aggregateQuery?.toLowerCase()).toContain("j.status='posted'");
    expect(aggregateQuery?.toLowerCase()).toContain(
      'join emdo.finance_journal_lines l',
    );
    expect(aggregateQuery?.toLowerCase()).toContain('statement_timestamp()');
    expect(aggregateQuery?.toLowerCase()).not.toContain(
      'l.currency=bl.currency',
    );
    expect(aggregateQuery?.toLowerCase()).not.toContain(
      'finance_standardization',
    );
    expect(aggregateQuery?.toLowerCase()).not.toContain(
      'finance_generated_reports',
    );
  });

  it('keeps the ledger account kind for zero-activity snapshot rows', async () => {
    const queries: string[] = [];
    const client: DatabaseClient = {
      query: vi.fn(async (query: string) => {
        queries.push(query);
        const lower = query.toLowerCase();
        if (transactionSetup(query)) return result();
        if (lower.includes('lock_active_request_scope'))
          return result([{ authorized: true }]);
        if (lower.includes('lock_finance_book_grant'))
          return result([{ allowed: true }]);
        if (lower.includes('select b.functional_currency'))
          return result([{ functionalCurrency: 'CAD', role: 'viewer' }]);
        if (lower.includes('pg_advisory_xact_lock')) return result();
        if (lower.includes('from emdo.finance_budget_revisions b'))
          return result([
            {
              workspaceId,
              bookId,
              budgetId,
              revision: 1,
              name: budget.name,
              functionalCurrency: 'CAD',
              createdBy: userId,
              createdAt: '2026-09-13T00:00:00.000Z',
            },
          ]);
        if (lower.includes('from emdo.finance_budget_lines l'))
          return result([
            {
              budgetId,
              revision: 1,
              periodId,
              accountId,
              currency: 'CAD',
              amount: '4.25',
            },
          ]);
        if (lower.includes('from emdo.finance_budget_lines bl'))
          return result([
            {
              periodId,
              startsOn: '2026-09-01',
              endsOn: '2026-09-30',
              accountId,
              currency: 'CAD',
              accountKind: 'liability',
              debitAmount: '0',
              creditAmount: '0',
              journalCount: 0,
              lineCount: 0,
              snapshotAt: '2026-09-14T00:00:00.000Z',
            },
          ]);
        throw new Error(`Unexpected planning query: ${query}`);
      }),
      release: vi.fn(),
    };
    const repository = new PostgresFinancePlanningRepository({
      connect: vi.fn(async () => client),
    });

    const actuals = await repository.budgetVsActuals(context, bookId, budgetId);
    expect(actuals.rows[0]).toMatchObject({
      accountKind: 'liability',
      postedActualAmount: '0',
      varianceAmount: '-4.25',
      actualSignBasis: 'credit-minus-debit',
      sourceJournalCount: 0,
      sourceLineCount: 0,
    });
    const snapshotQuery = queries.find((query) =>
      query.toLowerCase().includes('from emdo.finance_budget_lines bl'),
    );
    expect(snapshotQuery?.toLowerCase()).toContain(
      'left join emdo.finance_journals j',
    );
    expect(snapshotQuery?.toLowerCase()).toContain(
      'left join emdo.finance_journal_lines l',
    );
    expect(snapshotQuery?.toLowerCase()).toContain('a.kind as "accountkind"');
  });

  it('waits for an in-flight accounting writer before taking the ledger snapshot', async () => {
    let releaseWriter: (() => void) | undefined;
    let snapshotQuerySeen = false;
    const writerFinished = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const client: DatabaseClient = {
      query: vi.fn(async (query: string, values = []) => {
        const lower = query.toLowerCase();
        if (transactionSetup(query)) return result();
        if (lower.includes('lock_active_request_scope'))
          return result([{ authorized: true }]);
        if (lower.includes('lock_finance_book_grant'))
          return result([{ allowed: true }]);
        if (lower.includes('select b.functional_currency'))
          return result([{ functionalCurrency: 'CAD', role: 'viewer' }]);
        if (lower.includes('pg_advisory_xact_lock')) {
          if (values[0] === `${workspaceId}:${bookId}`) await writerFinished;
          return result();
        }
        if (lower.includes('from emdo.finance_budget_revisions b'))
          return result([
            {
              workspaceId,
              bookId,
              budgetId,
              revision: 1,
              name: budget.name,
              functionalCurrency: 'CAD',
              createdBy: userId,
              createdAt: '2026-09-13T00:00:00.000Z',
            },
          ]);
        if (lower.includes('from emdo.finance_budget_lines l'))
          return result([
            {
              budgetId,
              revision: 1,
              periodId,
              accountId,
              currency: 'CAD',
              amount: '4.25',
            },
          ]);
        if (lower.includes('from emdo.finance_budget_lines bl')) {
          snapshotQuerySeen = true;
          return result([
            {
              periodId,
              startsOn: '2026-09-01',
              endsOn: '2026-09-30',
              accountId,
              currency: 'CAD',
              accountKind: 'expense',
              debitAmount: '1.00',
              creditAmount: '0',
              journalCount: 1,
              lineCount: 1,
              snapshotAt: '2026-09-14T00:00:00.000Z',
            },
          ]);
        }
        throw new Error(`Unexpected planning query: ${query}`);
      }),
      release: vi.fn(),
    };
    const pool: DatabasePool = { connect: vi.fn(async () => client) };
    const repository = new PostgresFinancePlanningRepository(pool);
    const pending = repository.budgetVsActuals(context, bookId, budgetId);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(snapshotQuerySeen).toBe(false);
    releaseWriter!();
    const actuals = await pending;
    expect(snapshotQuerySeen).toBe(true);
    expect(actuals.snapshotAt).toBe('2026-09-14T00:00:00.000Z');
  });

  it('replays a generated budget id on an idempotent retry', async () => {
    const queries: string[] = [];
    let receipt:
      { operation: string; payloadHash: string; result: unknown } | undefined;
    let savedBudgetId: string | undefined;
    const client: DatabaseClient = {
      query: vi.fn(async (query: string, values = []) => {
        queries.push(query);
        const lower = query.toLowerCase();
        if (transactionSetup(query)) return result();
        if (lower.includes('lock_active_request_scope'))
          return result([{ authorized: true }]);
        if (lower.includes('lock_finance_book_grant'))
          return result([{ allowed: true }]);
        if (lower.includes('select b.functional_currency'))
          return result([{ functionalCurrency: 'CAD', role: 'preparer' }]);
        if (lower.includes('pg_advisory_xact_lock')) return result();
        if (lower.includes('select operation,payload_hash,result'))
          return receipt
            ? result([
                {
                  operation: receipt.operation,
                  payload_hash: receipt.payloadHash,
                  result: receipt.result,
                },
              ])
            : result();
        if (lower.includes('coalesce(max(revision),0)'))
          return result([{ revision: 0 }]);
        if (lower.startsWith('select id from emdo.finance_periods'))
          return result([{ id: periodId }]);
        if (lower.startsWith('select id from emdo.finance_ledger_accounts'))
          return result([{ id: accountId }]);
        if (lower.startsWith('insert into emdo.finance_budget_revisions')) {
          savedBudgetId = String(values[2]);
          return result();
        }
        if (lower.startsWith('insert into emdo.finance_budget_lines'))
          return result();
        if (lower.includes('from emdo.finance_budget_revisions b'))
          return result([
            {
              workspaceId,
              bookId,
              budgetId: savedBudgetId,
              revision: 1,
              name: budget.name,
              functionalCurrency: 'CAD',
              createdBy: userId,
              createdAt: '2026-09-14T00:00:00.000Z',
            },
          ]);
        if (lower.includes('from emdo.finance_budget_lines l'))
          return result([
            {
              budgetId: savedBudgetId,
              revision: 1,
              periodId,
              accountId,
              currency: 'CAD',
              amount: '4.25',
            },
          ]);
        if (lower.startsWith('insert into emdo.finance_command_receipts')) {
          receipt = {
            operation: String(values[3]),
            payloadHash: String(values[4]),
            result: JSON.parse(String(values[5])),
          };
          return result();
        }
        throw new Error(`Unexpected planning query: ${query}`);
      }),
      release: vi.fn(),
    };
    const pool: DatabasePool = { connect: vi.fn(async () => client) };
    const repository = new PostgresFinancePlanningRepository(pool);
    const key = 'planning-retry-key-001';

    const first = await repository.saveBudget(context, bookId, key, {
      name: budget.name,
      lines: budget.lines,
    });
    const second = await repository.saveBudget(context, bookId, key, {
      name: budget.name,
      lines: budget.lines,
    });

    expect(first).toEqual(second);
    expect(first.budgetId).toBe(savedBudgetId);
    expect(
      queries.filter((query) =>
        query
          .toLowerCase()
          .startsWith('insert into emdo.finance_budget_revisions'),
      ),
    ).toHaveLength(1);
  });

  it('reads an immutable automation result through the scoped book grant', async () => {
    const resultId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f78';
    const automationRunId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f79';
    let sourceHashValid = true;
    const queries: string[] = [];
    const client: DatabaseClient = {
      query: vi.fn(async (query: string) => {
        queries.push(query);
        const lower = query.toLowerCase();
        if (transactionSetup(query)) return result();
        if (lower.includes('lock_active_request_scope'))
          return result([{ authorized: true }]);
        if (lower.includes('lock_finance_book_grant'))
          return result([{ allowed: true }]);
        if (lower.includes('select b.functional_currency'))
          return result([{ functionalCurrency: 'CAD', role: 'viewer' }]);
        if (lower.includes('from emdo.finance_planning_results'))
          return result([
            {
              id: resultId,
              workspaceId,
              bookId,
              automationRunId,
              schemaVersion: 1,
              capability: 'finance.planning.budget-vs-actuals',
              budgetId,
              budgetRevision: 1,
              snapshotAt: '2026-09-14T12:00:00.000Z',
              payload: {
                schemaVersion: 1,
                workspaceId,
                bookId,
                budgetId,
                budgetRevision: 1,
                functionalCurrency: 'CAD',
                snapshotAt: '2026-09-14T12:00:00.000Z',
                actualSource: {
                  kind: 'authoritative-posted-ledger',
                  coverage: 'posted-journals-in-budget-periods',
                  signBasis: 'account-kind',
                },
                rows: [
                  {
                    periodId,
                    periodStart: '2026-09-01',
                    periodEnd: '2026-09-30',
                    accountId,
                    accountKind: 'expense',
                    currency: 'CAD',
                    budgetAmount: '4.25',
                    postedActualAmount: '0',
                    varianceAmount: '-4.25',
                    actualSignBasis: 'debit-minus-credit',
                    sourceJournalCount: 0,
                    sourceLineCount: 0,
                  },
                ],
              },
              sourceLineage: {
                budgetId,
                budgetRevision: 1,
                review: {
                  itemCount: 1,
                  currency: 'CAD',
                  reviewForecastId: null,
                  reviewForecastRevision: null,
                },
                sourceJournals: [],
                canonicalIntentHash: 'a'.repeat(64),
              },
              sourceHash: 'b'.repeat(64),
              sourceHashValid,
            },
          ]);
        throw new Error(`Unexpected planning query: ${query}`);
      }),
      release: vi.fn(),
    };
    const repository = new PostgresFinancePlanningRepository({
      connect: vi.fn(async () => client),
    });

    await expect(
      repository.getAutomationResult(context, bookId, resultId),
    ).resolves.toMatchObject({
      id: resultId,
      automationRunId,
      sourceHash: 'b'.repeat(64),
    });
    expect(
      queries.find((query) =>
        query.toLowerCase().includes('from emdo.finance_planning_results'),
      ),
    ).toContain('workspace_id=$1 and book_id=$2 and id=$3');
    expect(
      queries.find((query) =>
        query.toLowerCase().includes('from emdo.finance_planning_results'),
      ),
    ).toContain(
      "jsonb_build_object('payload', payload, 'lineage', source_lineage)",
    );

    sourceHashValid = false;
    await expect(
      repository.getAutomationResult(context, bookId, resultId),
    ).rejects.toMatchObject({
      code: 'conflict',
      message: 'finance-planning-result-integrity-invalid',
    });
  });
});

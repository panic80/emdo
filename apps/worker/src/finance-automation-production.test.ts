import { describe, expect, it, vi } from 'vitest';
import type { EmdoWorkerDatabaseClient } from '@emdo/db/worker';
import { createProductionFinanceAutomationDispatcher } from './finance-automation-production.js';

describe('Production Finance automation executor boundary', () => {
  it('uses the scoped executor pool and checks only narrow function privileges/RLS', async () => {
    const query = vi.fn(async (sql: string) => {
      void sql;
      return { rowCount: 1, rows: [{ ready: true }] };
    });
    const release = vi.fn();
    const database: EmdoWorkerDatabaseClient = {
      scopedPool: {
        async connect() {
          return { query, release };
        },
      },
      async checkReady() {},
      async close() {},
    };
    expect(
      typeof (await createProductionFinanceAutomationDispatcher(database)),
    ).toBe('function');
    const sql = query.mock.calls.map((c) => String(c[0])).join('\n');
    expect(sql).toContain("current_user='emdo_worker_executor'");
    expect(sql).toContain('claim_finance_automation_delivery');
    expect(sql).toContain('generate_finance_planning_result');
    expect(sql).toContain('generate_finance_journal_draft');
    expect(sql).toContain('select count(*)=15');
    expect(sql).toContain('relforcerowsecurity');
    for (const table of [
      'finance_budget_revisions',
      'finance_budget_lines',
      'finance_forecast_snapshots',
      'finance_forecast_lines',
      'finance_forecast_assumptions',
    ])
      expect(sql).toContain(`'${table}'`);
    for (const table of [
      'finance_automation_runs',
      'finance_automation_authority_epochs',
      'finance_planning_results',
      'finance_automation_journal_draft_results',
      'finance_automation_journal_draft_states',
      'finance_automation_journal_draft_events',
    ])
      expect(sql).toContain(
        `not has_table_privilege(current_user,'emdo.${table}','INSERT,UPDATE,DELETE')`,
      );
    expect(sql).not.toMatch(/set role|update emdo|insert into emdo/i);
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('fails closed when function grants or forced policies are absent', async () => {
    const release = vi.fn();
    const database: EmdoWorkerDatabaseClient = {
      scopedPool: {
        async connect() {
          return {
            async query() {
              return { rowCount: 1, rows: [{ ready: false }] };
            },
            release,
          };
        },
      },
      async checkReady() {},
      async close() {},
    };
    await expect(
      createProductionFinanceAutomationDispatcher(database),
    ).rejects.toThrow('Finance automation executor is unavailable');
    expect(release).toHaveBeenCalledTimes(1);
  });
});

import {
  PostgresFinanceAutomationExecutionRepository,
  PostgresFinanceGeneratedReportExecutionRepository,
  PostgresFinancePlanningExecutionRepository,
  PostgresFinanceJournalDraftExecutionRepository,
  type EmdoWorkerDatabaseClient,
} from '@emdo/db/worker';
import type { FinanceAutomationLeaf } from './finance-automation-worker.js';
import { createFinanceAutomationDispatcher } from './finance-automation-worker.js';
import { createFinanceAccountingReportLeaf } from './finance-accounting-report-leaf.js';
import { createFinanceJournalDraftLeaf } from './finance-journal-draft-leaf.js';
import { createFinancePlanningLeaves } from './finance-planning-leaf.js';

/** Uses the existing fixed emdo_worker_executor connection boundary. Readiness
 * checks narrow function access and FORCE RLS, never enables a leaf or entitlement.
 * The queue login and outbox-dispatch login are not accepted as Finance executors.
 */
export async function createProductionFinanceAutomationDispatcher(
  database: EmdoWorkerDatabaseClient,
  extractionLeaf?: FinanceAutomationLeaf,
) {
  const client = await database.scopedPool.connect();
  try {
    await client.query('begin');
    await client.query("set local statement_timeout='3s'");
    const probe = await client.query(`select current_user='emdo_worker_executor'
   and coalesce(has_function_privilege(current_user,to_regprocedure('emdo.claim_finance_automation_delivery(uuid,integer)'),'EXECUTE'),false)
   and coalesce(has_function_privilege(current_user,to_regprocedure('emdo.settle_finance_automation_run(uuid,integer,uuid,text,uuid,text)'),'EXECUTE'),false)
   and coalesce(has_function_privilege(current_user,to_regprocedure('emdo.generate_finance_trial_balance(uuid,integer,uuid)'),'EXECUTE'),false)
   and coalesce(has_function_privilege(current_user,to_regprocedure('emdo.generate_finance_accounting_report(uuid,integer,uuid)'),'EXECUTE'),false)
   and coalesce(has_function_privilege(current_user,to_regprocedure('emdo.generate_finance_planning_result(uuid,integer,uuid)'),'EXECUTE'),false)
   and coalesce(has_function_privilege(current_user,to_regprocedure('emdo.generate_finance_journal_draft(uuid,integer,uuid)'),'EXECUTE'),false)
   and (select count(*)=15 and bool_and(c.relrowsecurity and c.relforcerowsecurity)
     from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='emdo'
     and c.relname in ('finance_automation_grants','finance_automation_runs','finance_automation_authority_epochs','finance_automation_capabilities','finance_generated_reports','finance_ledger_account_classifications','finance_planning_results','finance_budget_revisions','finance_budget_lines','finance_forecast_snapshots','finance_forecast_lines','finance_forecast_assumptions','finance_automation_journal_draft_results','finance_automation_journal_draft_states','finance_automation_journal_draft_events'))
   and not has_table_privilege(current_user,'emdo.finance_generated_reports','INSERT,UPDATE,DELETE')
   and not has_table_privilege(current_user,'emdo.finance_automation_grants','INSERT,UPDATE,DELETE')
   and not has_table_privilege(current_user,'emdo.finance_automation_capabilities','INSERT,UPDATE,DELETE')
   and not has_table_privilege(current_user,'emdo.finance_automation_runs','INSERT,UPDATE,DELETE')
   and not has_table_privilege(current_user,'emdo.finance_automation_authority_epochs','INSERT,UPDATE,DELETE')
   and not has_table_privilege(current_user,'emdo.finance_ledger_account_classifications','INSERT,UPDATE,DELETE')
   and not has_table_privilege(current_user,'emdo.finance_planning_results','INSERT,UPDATE,DELETE')
   and not has_table_privilege(current_user,'emdo.finance_automation_journal_draft_results','INSERT,UPDATE,DELETE')
   and not has_table_privilege(current_user,'emdo.finance_automation_journal_draft_states','INSERT,UPDATE,DELETE')
   and not has_table_privilege(current_user,'emdo.finance_automation_journal_draft_events','INSERT,UPDATE,DELETE') as ready`);
    if (probe.rows[0]?.ready !== true) throw new Error('unavailable');
    await client.query('commit');
  } catch {
    try {
      await client.query('rollback');
    } catch {
      /* Preserve safe startup failure. */
    }
    throw new Error('Finance automation executor is unavailable');
  } finally {
    client.release();
  }
  const planning = new PostgresFinancePlanningExecutionRepository(
    database.scopedPool,
  );
  return createFinanceAutomationDispatcher({
    executions: new PostgresFinanceAutomationExecutionRepository(
      database.scopedPool,
    ),
    leaves: [
      createFinanceAccountingReportLeaf(
        new PostgresFinanceGeneratedReportExecutionRepository(
          database.scopedPool,
        ),
      ),
      ...createFinancePlanningLeaves(planning),
      createFinanceJournalDraftLeaf(
        new PostgresFinanceJournalDraftExecutionRepository(database.scopedPool),
      ),
      ...(extractionLeaf ? [extractionLeaf] : []),
    ],
    now: () => new Date().toISOString(),
  });
}

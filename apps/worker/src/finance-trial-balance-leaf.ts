import { FinanceGeneratedReportNotAppliedError } from '@emdo/db/worker';
import { moneyValue } from '@emdo/domains/finance';
import { UuidSchema } from '@emdo/contracts';
import type { FinanceAutomationLeaf } from './finance-automation-worker.js';
export interface FinanceTrialBalanceReportStore {
  generateTrialBalance(input: {
    operationId: string;
    expectedRevision: number;
    leaseToken: string;
  }): Promise<{ reportId: string }>;
}
/** Concrete deterministic SQL snapshot leaf. Registration alone does not enable
 * database readiness or grant an entitlement. Target scope is also revalidated
 * inside the SQL transaction; no browser identity or sibling tools are used.
 */
export function createFinanceTrialBalanceLeaf(
  reports: FinanceTrialBalanceReportStore,
): FinanceAutomationLeaf {
  return {
    capability: 'finance.reports.generate',
    readiness: 'implemented',
    async execute(input) {
      if (
        input.signal.aborted ||
        input.targets.length !== 1 ||
        input.targets[0] !== input.run.request.bookId ||
        moneyValue(input.run.request.amount, input.run.request.currency) !== 0n
      )
        return { application: 'not-applied' };
      try {
        const result = await reports.generateTrialBalance({
          operationId: input.run.request.operationId,
          expectedRevision: input.run.revision,
          leaseToken: input.leaseToken,
        });
        return {
          application: 'applied',
          outcomeReference: UuidSchema.parse(result.reportId),
        };
      } catch (error) {
        if (error instanceof FinanceGeneratedReportNotAppliedError)
          return { application: 'not-applied' };
        // Connection loss/commit ambiguity is handled as indeterminate by dispatcher.
        throw error;
      }
    },
  };
}

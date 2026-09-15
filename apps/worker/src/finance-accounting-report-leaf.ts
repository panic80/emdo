import { FinanceGeneratedReportNotAppliedError } from '@emdo/db/worker';
import { moneyValue } from '@emdo/domains/finance';
import { UuidSchema } from '@emdo/contracts';
import type { FinanceAutomationLeaf } from './finance-automation-worker.js';

export interface FinanceAccountingReportStore {
  generateTrialBalance(input: {
    operationId: string;
    expectedRevision: number;
    leaseToken: string;
  }): Promise<{ reportId: string }>;
  generateAccountingReport(input: {
    operationId: string;
    expectedRevision: number;
    leaseToken: string;
  }): Promise<{ reportId: string }>;
}

/** One registered Finance leaf handles the three report selections. The
 * selection is read from the worker's canonical claimed intent; the leaf
 * never accepts report parameters from a browser or queue payload. */
export function createFinanceAccountingReportLeaf(
  reports: FinanceAccountingReportStore,
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
        const result =
          (input.run.request.report?.kind ?? 'posted-ledger-trial-balance') ===
          'posted-ledger-trial-balance'
            ? await reports.generateTrialBalance({
                operationId: input.run.request.operationId,
                expectedRevision: input.run.revision,
                leaseToken: input.leaseToken,
              })
            : await reports.generateAccountingReport({
                operationId: input.run.request.operationId,
                expectedRevision: input.run.revision,
                leaseToken: input.leaseToken,
              });
        return {
          application: 'applied',
          outcomeReference: UuidSchema.parse(result.reportId),
        };
      } catch (error) {
        if (error instanceof FinanceGeneratedReportNotAppliedError) {
          if (error.reason === 'missing-classification')
            return {
              application: 'blocked',
              reason: 'report-missing-account-classification',
            };
          return { application: 'not-applied' };
        }
        // Connection loss/commit ambiguity is handled as indeterminate by
        // the dispatcher; it must never be replayed blindly.
        throw error;
      }
    },
  };
}

import { FinanceJournalDraftResultNotAppliedError } from '@emdo/db/worker';
import {
  FinanceAutomationJournalDraftIntentSchema,
  UuidSchema,
} from '@emdo/contracts';
import type { FinanceAutomationLeaf } from './finance-automation-worker.js';

export interface FinanceJournalDraftStore {
  generateJournalDraft(input: {
    operationId: string;
    expectedRevision: number;
    leaseToken: string;
  }): Promise<{ resultId: string }>;
}

/** SQL reloads the canonical batch, validates authority and derives the draft.
 * The worker cannot supply journal lines, accounting arithmetic or posting. */
export function createFinanceJournalDraftLeaf(
  store: FinanceJournalDraftStore,
): FinanceAutomationLeaf {
  return {
    capability: 'finance.journals.draft',
    readiness: 'implemented',
    async execute(input) {
      if (input.signal.aborted) return { application: 'not-applied' };
      const journal = FinanceAutomationJournalDraftIntentSchema.safeParse(
        input.run.request.journal,
      );
      if (
        input.run.request.capability !== 'finance.journals.draft' ||
        !journal.success ||
        input.targets.length !== 1 ||
        input.targets[0] !== journal.data.batchId
      )
        return {
          application: 'blocked',
          reason: 'journal-draft-invalid-intent',
        };
      try {
        const result = await store.generateJournalDraft({
          operationId: input.run.request.operationId,
          expectedRevision: input.run.revision,
          leaseToken: input.leaseToken,
        });
        return {
          application: 'applied',
          outcomeReference: UuidSchema.parse(result.resultId),
        };
      } catch (error) {
        if (error instanceof FinanceJournalDraftResultNotAppliedError) {
          // Lock contention is a confirmed rollback and can retry. Invalid
          // sources or authority require a new reviewed/authorized run.
          if (error.reason === 'result-conflict')
            return { application: 'not-applied' };
          return {
            application: 'blocked',
            reason: `journal-draft-${error.reason}`,
          };
        }
        throw error;
      }
    },
  };
}

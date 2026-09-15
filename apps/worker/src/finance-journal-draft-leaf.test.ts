import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FinanceAutomationRunSchema } from '@emdo/contracts';
import { FinanceJournalDraftResultNotAppliedError } from '@emdo/db/worker';
import { createFinanceJournalDraftLeaf } from './finance-journal-draft-leaf.js';

function fixture() {
  const batchId = randomUUID();
  return {
    run: FinanceAutomationRunSchema.parse({
      request: {
        operationId: randomUUID(),
        grantId: randomUUID(),
        grantRevision: 1,
        workspaceId: randomUUID(),
        bookId: randomUUID(),
        capability: 'finance.journals.draft',
        requestHash: 'a'.repeat(64),
        itemCount: 6,
        currency: 'CAD',
        amount: '105.25',
        journal: {
          schemaVersion: 1,
          batchId,
          expectedBatchRevision: 2,
          expectedSnapshotHash: 'b'.repeat(64),
        },
      },
      revision: 4,
      attempts: 1,
      status: 'executing',
      outcomeReference: null,
    }),
    targets: [batchId],
    leaseToken: randomUUID(),
    leaseExpiresAt: '2026-09-15T12:02:00.000Z',
    signal: new AbortController().signal,
  };
}

describe('journal draft worker leaf', () => {
  it('passes only run CAS and lease to SQL, retaining the result UUID', async () => {
    const input = fixture();
    const resultId = randomUUID();
    const store = { generateJournalDraft: vi.fn(async () => ({ resultId })) };
    await expect(
      createFinanceJournalDraftLeaf(store).execute(input),
    ).resolves.toEqual({ application: 'applied', outcomeReference: resultId });
    expect(store.generateJournalDraft).toHaveBeenCalledTimes(1);
    expect(store.generateJournalDraft).toHaveBeenCalledWith({
      operationId: input.run.request.operationId,
      expectedRevision: 4,
      leaseToken: input.leaseToken,
    });
  });
  it('rejects a mismatched batch and an aborted operation before SQL', async () => {
    const input = fixture();
    const store = {
      generateJournalDraft: vi.fn(async () => ({ resultId: randomUUID() })),
    };
    const leaf = createFinanceJournalDraftLeaf(store);
    await expect(
      leaf.execute({ ...input, targets: [randomUUID()] }),
    ).resolves.toEqual({
      application: 'blocked',
      reason: 'journal-draft-invalid-intent',
    });
    await expect(
      leaf.execute({ ...input, signal: AbortSignal.abort() }),
    ).resolves.toEqual({ application: 'not-applied' });
    expect(store.generateJournalDraft).not.toHaveBeenCalled();
  });
  it.each(['source-invalid', 'invalid-intent', 'result-conflict'] as const)(
    'classifies confirmed SQL rejection %s without losing its meaning',
    async (reason) => {
      const input = fixture();
      const leaf = createFinanceJournalDraftLeaf({
        generateJournalDraft: async () => {
          throw new FinanceJournalDraftResultNotAppliedError(reason);
        },
      });
      expect(await leaf.execute(input)).toEqual(
        reason === 'result-conflict'
          ? { application: 'not-applied' }
          : { application: 'blocked', reason: `journal-draft-${reason}` },
      );
    },
  );
  it('blocks revoked authority and keeps ambiguous commits unknown', async () => {
    const input = fixture();
    const known = createFinanceJournalDraftLeaf({
      generateJournalDraft: async () => {
        throw new FinanceJournalDraftResultNotAppliedError('authority-denied');
      },
    });
    await expect(known.execute(input)).resolves.toEqual({
      application: 'blocked',
      reason: 'journal-draft-authority-denied',
    });
    const unknown = createFinanceJournalDraftLeaf({
      generateJournalDraft: async () => {
        throw new Error('commit acknowledgement lost');
      },
    });
    await expect(unknown.execute(input)).rejects.toThrow(
      'commit acknowledgement lost',
    );
  });
});

import { createFinanceAutomationDispatcher } from './finance-automation-worker.js';

describe('journal draft canonical claim binding', () => {
  it.each([
    'valid',
    'source-invalid',
    'line-count',
    'amount',
    'snapshot',
    'target',
  ] as const)('validates authoritative journal claim: %s', async (variant) => {
    const input = fixture();
    const request = input.run.request;
    const intent = {
      workspaceId: request.workspaceId,
      bookId: request.bookId,
      grantId: request.grantId,
      grantRevision: request.grantRevision,
      capability: request.capability,
      currency: request.currency,
      amount: request.amount,
      targets: input.targets,
      journal: { ...request.journal! },
      journalReview: {
        itemCount: request.itemCount,
        currency: request.currency,
        amount: request.amount,
      },
    };
    if (variant === 'line-count') intent.journalReview.itemCount++;
    if (variant === 'amount') intent.journalReview.amount = '999';
    if (variant === 'snapshot')
      intent.journal.expectedSnapshotHash = 'c'.repeat(64);
    if (variant === 'target') intent.targets = [randomUUID()];
    const resultId = randomUUID();
    const generateJournalDraft = vi.fn(async () => {
      if (variant === 'source-invalid')
        throw new FinanceJournalDraftResultNotAppliedError('source-invalid');
      return { resultId };
    });
    const settle = vi.fn(async () => ({
      ...input.run,
      revision: 5,
      status: variant === 'source-invalid' ? 'blocked' : 'completed',
      outcomeReference: variant === 'source-invalid' ? null : resultId,
    }));
    // The claim transport contains only schema-owned fields.
    const claim = {
      status: 'claimed',
      run: input.run,
      intent,
      leaseToken: input.leaseToken,
      leaseExpiresAt: input.leaseExpiresAt,
    };
    const checkedDispatch = createFinanceAutomationDispatcher({
      executions: { claimDelivery: async () => claim, settle },
      leaves: [createFinanceJournalDraftLeaf({ generateJournalDraft })],
      now: () => '2026-09-15T12:00:00.000Z',
    });
    if (variant === 'source-invalid') {
      await expect(
        checkedDispatch(request.operationId, 3, input.signal),
      ).resolves.toEqual({
        status: 'blocked',
        reason: 'journal-draft-source-invalid',
      });
      expect(settle).toHaveBeenCalledWith({
        operationId: request.operationId,
        expectedRevision: input.run.revision,
        leaseToken: input.leaseToken,
        result: 'blocked',
        blockedReason: 'journal-draft-source-invalid',
      });
    } else if (variant === 'valid') {
      await expect(
        checkedDispatch(request.operationId, 3, input.signal),
      ).resolves.toEqual({ status: 'completed', outcomeReference: resultId });
      expect(generateJournalDraft).toHaveBeenCalledTimes(1);
    } else {
      await expect(
        checkedDispatch(request.operationId, 3, input.signal),
      ).rejects.toThrow();
      expect(generateJournalDraft).not.toHaveBeenCalled();
      expect(settle).not.toHaveBeenCalled();
    }
  });
});

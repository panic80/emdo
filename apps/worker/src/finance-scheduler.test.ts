import { describe, expect, it, vi } from 'vitest';
import {
  startFinanceScheduler,
  triggerFinanceSchedules,
  type FinanceScheduleStore,
} from './finance-scheduler.js';
const claim = { leaseToken: 'claim' } as unknown as Awaited<
  ReturnType<FinanceScheduleStore['claimDue']>
>[number];
describe('deterministic Finance scheduler controller', () => {
  it('claims at most one and delegates only the persisted planner/commit', async () => {
    const repository = {
      claimDue: vi.fn(async () => [claim]),
      planAndCommit: vi.fn(async () => ({ status: 'due' })),
    } as unknown as FinanceScheduleStore;
    await triggerFinanceSchedules({
      repository,
      signal: new AbortController().signal,
    });
    expect(repository.claimDue).toHaveBeenCalledWith(1);
    expect(repository.planAndCommit).toHaveBeenCalledTimes(1);
    expect(repository.planAndCommit).toHaveBeenCalledWith(claim);
  });
  it('does not retry an unknown commit within the claim', async () => {
    const repository = {
      claimDue: vi.fn(async () => [claim]),
      planAndCommit: vi.fn(async () => {
        throw new Error('connection lost after commit');
      }),
    } as unknown as FinanceScheduleStore;
    await triggerFinanceSchedules({
      repository,
      signal: new AbortController().signal,
    });
    expect(repository.planAndCommit).toHaveBeenCalledTimes(1);
  });
  it('rejects oversized claims before committing', async () => {
    const repository = {
      claimDue: vi.fn(async () => [claim, claim]),
      planAndCommit: vi.fn(),
    } as unknown as FinanceScheduleStore;
    await expect(
      triggerFinanceSchedules({
        repository,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('batch-invalid');
    expect(repository.planAndCommit).not.toHaveBeenCalled();
  });
  it('stops promptly with a hung claim and does not commit a late result', async () => {
    let resolve!: (value: (typeof claim)[]) => void;
    const repository = {
      claimDue: vi.fn(
        () =>
          new Promise<(typeof claim)[]>((r) => {
            resolve = r;
          }),
      ),
      planAndCommit: vi.fn(),
    } as unknown as FinanceScheduleStore;
    const onFatalError = vi.fn();
    const scheduler = startFinanceScheduler({
      repository,
      signal: new AbortController().signal,
      onFatalError,
    });
    await scheduler.stop();
    resolve([claim]);
    await Promise.resolve();
    expect(repository.planAndCommit).not.toHaveBeenCalled();
    expect(onFatalError).not.toHaveBeenCalled();
  });
});

it.each(['finance.documents.extract', 'finance.journals.draft'] as const)(
  'routes %s occurrence through the same persisted planner exactly once',
  async (capability) => {
    const source =
      capability === 'finance.documents.extract'
        ? {
            extraction: {
              expectedSourceDigest: 'a'.repeat(64),
              expectedRunRevision: 3,
              expectedExtractionRevision: 1,
            },
          }
        : {
            journal: {
              expectedBatchRevision: 2,
              expectedSnapshotHash: 'b'.repeat(64),
            },
          };
    const exactClaim = {
      ...claim,
      input: { schedule: { definition: { capability, ...source } } },
    } as unknown as typeof claim;
    const repository = {
      claimDue: vi.fn(async () => [exactClaim]),
      planAndCommit: vi.fn(async () => ({
        status: 'denied',
        reason: 'source-intent-changed',
      })),
    } as unknown as FinanceScheduleStore;
    await triggerFinanceSchedules({
      repository,
      signal: new AbortController().signal,
    });
    expect(repository.claimDue).toHaveBeenCalledWith(1);
    expect(repository.planAndCommit).toHaveBeenCalledTimes(1);
    expect(repository.planAndCommit).toHaveBeenCalledWith(exactClaim);
  },
);

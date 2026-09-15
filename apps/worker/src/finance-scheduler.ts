import { setTimeout as pause } from 'node:timers/promises';
import type { PostgresFinanceScheduleDueRepository } from '@emdo/db/worker';
export type FinanceScheduleStore = Pick<
  PostgresFinanceScheduleDueRepository,
  'claimDue' | 'planAndCommit'
>;
async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(10_000);
  const combined = AbortSignal.any([signal, timeout]);
  combined.throwIfAborted();
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(combined.reason);
    combined.addEventListener('abort', rejectAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    combined.removeEventListener('abort', rejectAbort);
  }
}
/** Controller emits only canonical database runs/outbox rows; it cannot call a Finance leaf. */
export async function triggerFinanceSchedules(input: {
  repository: FinanceScheduleStore;
  signal: AbortSignal;
}) {
  input.signal.throwIfAborted();
  const claims = await bounded(input.repository.claimDue(1), input.signal);
  if (claims.length > 1) throw new Error('finance-scheduler-batch-invalid');
  for (const claim of claims) {
    if (input.signal.aborted) return;
    try {
      await bounded(input.repository.planAndCommit(claim), input.signal);
    } catch {
      /* Commit may have succeeded. Reclaim persisted cursor/identity after lease expiry; never invoke a leaf here. */
    }
  }
}
export function startFinanceScheduler(input: {
  repository: FinanceScheduleStore;
  signal: AbortSignal;
  onFatalError: () => void;
}) {
  const controller = new AbortController(),
    signal = AbortSignal.any([input.signal, controller.signal]);
  const running = (async () => {
    while (!signal.aborted) {
      try {
        await triggerFinanceSchedules({ ...input, signal });
      } catch {
        if (!signal.aborted) {
          input.onFatalError();
          return;
        }
      }
      try {
        await pause(1000, undefined, { signal });
      } catch {
        return;
      }
    }
  })();
  return {
    async stop() {
      controller.abort();
      await running;
    },
  };
}

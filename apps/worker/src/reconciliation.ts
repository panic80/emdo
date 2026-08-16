import type { WorkerExecutionContext } from './jobs.js';

export interface CalendarMaintenanceService {
  /** Read-only provider synchronization into canonical scoped repositories. */
  synchronize(
    input: {
      readonly operationId: string;
      readonly connectionId: string;
      readonly syncGeneration: number;
    },
    context: WorkerExecutionContext,
  ): Promise<void>;

  /** Deterministic retry of a previously persisted synchronization operation. */
  retrySynchronization(
    input: {
      readonly operationId: string;
      readonly failedOperationId: string;
      readonly connectionId: string;
      readonly retrySequence: number;
    },
    context: WorkerExecutionContext,
  ): Promise<void>;

  /** Provider readback only; never applies a new provider mutation. */
  reconcileProviderAttempt(
    input: {
      readonly operationId: string;
      readonly providerAttemptId: string;
    },
    context: WorkerExecutionContext,
  ): Promise<void>;
}

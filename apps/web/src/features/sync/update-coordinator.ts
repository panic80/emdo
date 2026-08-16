export type UpdateState =
  'idle' | 'update-ready' | 'blocked-pending-changes' | 'activating';

export class SafeUpdateCoordinator {
  readonly #activateWaitingWorker: () => Promise<void>;
  #waiting = false;
  #pendingChanges = 0;
  #state: UpdateState = 'idle';

  public constructor(dependencies: {
    readonly activateWaitingWorker: () => Promise<void>;
  }) {
    this.#activateWaitingWorker = dependencies.activateWaitingWorker;
  }

  public snapshot(): {
    readonly state: UpdateState;
    readonly pendingChanges: number;
  } {
    return { state: this.#state, pendingChanges: this.#pendingChanges };
  }

  public setPendingChanges(count: number): void {
    this.#pendingChanges = Math.max(0, Math.trunc(count));
    if (this.#waiting) {
      this.#state =
        this.#pendingChanges > 0 ? 'blocked-pending-changes' : 'update-ready';
    }
  }

  public markUpdateWaiting(): void {
    this.#waiting = true;
    this.#state =
      this.#pendingChanges > 0 ? 'blocked-pending-changes' : 'update-ready';
  }

  public async apply(): Promise<void> {
    if (!this.#waiting) return;
    if (this.#pendingChanges > 0) {
      this.#state = 'blocked-pending-changes';
      throw new Error('Sync or discard local changes before updating EMDO.');
    }
    this.#state = 'activating';
    await this.#activateWaitingWorker();
  }
}

export type LogoutBoundaryStatus =
  'complete' | 'sync-failed' | 'logout-blocked' | 'incomplete';

export interface LogoutBoundaryAdapter {
  readonly inspect: () => Promise<{ readonly pendingOperations: number }>;
  readonly syncAndPurge: () => Promise<{
    readonly status: LogoutBoundaryStatus;
  }>;
  readonly discardAndPurge: () => Promise<{
    readonly status: LogoutBoundaryStatus;
  }>;
}

export interface LogoutFlowSnapshot {
  readonly state:
    | 'idle'
    | 'inspecting'
    | 'decision-required'
    | 'syncing'
    | 'discarding'
    | LogoutBoundaryStatus;
  readonly pendingOperations?: number;
}

export class LogoutFlowController {
  readonly #boundary: LogoutBoundaryAdapter;
  #state: LogoutFlowSnapshot = { state: 'idle' };

  public constructor(boundary: LogoutBoundaryAdapter) {
    this.#boundary = boundary;
  }

  public snapshot(): LogoutFlowSnapshot {
    return { ...this.#state };
  }

  public async begin(): Promise<void> {
    this.#state = { state: 'inspecting' };
    try {
      const { pendingOperations } = await this.#boundary.inspect();
      if (pendingOperations > 0) {
        this.#state = { state: 'decision-required', pendingOperations };
        return;
      }
      this.#state = { state: 'syncing', pendingOperations: 0 };
      const result = await this.#boundary.syncAndPurge();
      this.#state = { state: result.status };
    } catch {
      this.#state = { state: 'logout-blocked' };
    }
  }

  public async syncNow(): Promise<void> {
    if (this.#state.state !== 'decision-required') return;
    this.#state = {
      state: 'syncing',
      pendingOperations: this.#state.pendingOperations,
    };
    try {
      const result = await this.#boundary.syncAndPurge();
      this.#state = { state: result.status };
    } catch {
      this.#state = { state: 'sync-failed' };
    }
  }

  public async discard(confirmation: string): Promise<void> {
    if (this.#state.state !== 'decision-required') return;
    if (confirmation !== 'DISCARD OFFLINE CHANGES') return;
    this.#state = {
      state: 'discarding',
      pendingOperations: this.#state.pendingOperations,
    };
    try {
      const result = await this.#boundary.discardAndPurge();
      this.#state = { state: result.status };
    } catch {
      this.#state = { state: 'incomplete' };
    }
  }
}

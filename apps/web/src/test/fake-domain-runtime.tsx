import type {
  DomainReplicationSnapshot,
  DomainRuntimeSnapshot,
  DomainRuntimeFactory,
} from '../features/domains/domain-data.js';

const STARTING_REPLICATION = Object.freeze({
  mode: 'online',
  state: 'background-started',
  liveReplicationVerified: false,
} as const satisfies DomainReplicationSnapshot);

const DEFAULT_SPACES = Object.freeze([
  Object.freeze({
    id: '11111111-1111-4111-8111-111111111111',
    visibility: 'private' as const,
    originalOwnerUserId: '22222222-2222-4222-8222-222222222222',
  }),
]);

export const createDomainRuntimeSnapshot = (
  overrides: Partial<DomainRuntimeSnapshot> = {},
): DomainRuntimeSnapshot =>
  Object.freeze({
    records: Object.freeze([]),
    pendingCount: 0,
    conflicts: Object.freeze([]),
    replication: STARTING_REPLICATION,
    spaces: DEFAULT_SPACES,
    ...overrides,
  });

export const createReadyDomainRuntimeFactory =
  (
    replication: DomainReplicationSnapshot = STARTING_REPLICATION,
  ): DomainRuntimeFactory =>
  async () => ({
    clientId: '33333333-3333-4333-8333-333333333333',
    inspect: async () => createDomainRuntimeSnapshot({ replication }),
    applyLocalMutation: async () => undefined,
    syncNow: async () => ({
      status: 'idle' as const,
      submittedCount: 0,
      acceptedOperationIds: [],
      terminalConflicts: [],
      retryableOperations: [],
    }),
    dismissTerminalConflict: async () => undefined,
    subscribeSnapshotInvalidation: () => () => undefined,
    logout: async () => ({ status: 'complete' as const }),
    dispose: async () => undefined,
  });

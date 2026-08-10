import { UuidSchema, deepFreeze, type SyncOperation } from '@emdo/contracts';
import { z } from 'zod';

import {
  CanonicalSyncUploadValidator,
  fingerprintSyncOperation,
  getSyncOperationSpaceId,
} from './operations.js';

export type SyncConflictCode =
  | 'entity-exists'
  | 'entity-not-found'
  | 'revision-mismatch'
  | 'tombstoned'
  | 'mutation-invalid'
  | 'repository-rejected';

export type StoredSyncOperationOutcome =
  | {
      readonly status: 'applied';
      readonly revision: number;
    }
  | {
      readonly status: 'conflict';
      readonly code: SyncConflictCode;
      readonly currentRevision?: number;
    };

export interface OfflineSyncExecutionContext {
  readonly source: 'offline-sync-api';
  readonly externalEffects: 'forbidden';
  readonly mayEnqueueProviderWrites: false;
  readonly authorizationRevalidation: 'required-in-transaction';
  readonly authenticatedUserId: string;
  readonly authenticatedSessionId: string;
  readonly householdId: string;
  readonly role: 'owner' | 'member';
  readonly requestId: string;
  readonly writableSpaceIds: readonly string[];
  readonly targetSpaceId: string;
}

export interface ResolvedSyncWriteScope {
  readonly userId: string;
  readonly householdId: string;
  readonly role: 'owner' | 'member';
  readonly writableSpaces: readonly {
    readonly id: string;
    readonly householdId: string;
    readonly visibility: 'private' | 'shared';
    readonly originalOwnerUserId: string;
  }[];
}

export interface SyncRepositoryPrincipalContext {
  readonly authenticatedUserId: string;
  readonly authenticatedSessionId: string;
  readonly householdId: string;
  readonly role: 'owner' | 'member';
  readonly requestId: string;
  readonly writableSpaceIds: readonly string[];
}

export interface SyncExecuteOnceInput {
  readonly operation: SyncOperation;
  readonly fingerprint: string;
  readonly context: OfflineSyncExecutionContext;
}

export type SyncExecuteOnceResult =
  | {
      readonly kind: 'executed' | 'replay';
      readonly outcome: StoredSyncOperationOutcome;
    }
  | { readonly kind: 'idempotency-key-reused' }
  | { readonly kind: 'in-progress' }
  | { readonly kind: 'authorization-revoked' };

export interface SyncOperationProcessorRepository {
  /** Resolves the active server-side session/client scope; no client scope is accepted. */
  resolveWriteScope(input: {
    readonly authenticatedSessionId: string;
    readonly clientId: string;
  }): Promise<ResolvedSyncWriteScope | undefined>;

  /**
   * Returns a terminal receipt for a dependency. Implementations must scope
   * this lookup by both client and operation ID.
   */
  getStoredOutcomes(input: {
    readonly clientId: string;
    readonly operationIds: readonly string[];
    readonly context: SyncRepositoryPrincipalContext;
  }): Promise<
    ReadonlyMap<
      string,
      {
        readonly fingerprint: string;
        readonly outcome: StoredSyncOperationOutcome;
      }
    >
  >;

  /**
   * Atomically checks the composite idempotency key, enforces base revision,
   * applies the canonical local mutation, and stores its terminal receipt.
   * It must revalidate the active session, client, membership, household, and
   * target-space authority inside that transaction immediately before the
   * mutation. The resolved context is revalidation input, not an access grant.
   * This boundary deliberately exposes no provider queue or provider client.
   */
  executeOnce(input: SyncExecuteOnceInput): Promise<SyncExecuteOnceResult>;
}

type AppliedProcessResult = {
  readonly operationId: string;
  readonly status: 'applied';
  readonly revision: number;
  readonly replayed: boolean;
};

type ConflictProcessResult = {
  readonly operationId: string;
  readonly status: 'conflict';
  readonly code:
    SyncConflictCode | 'idempotency-key-reused' | 'operation-in-progress';
  readonly currentRevision?: number;
  readonly replayed: boolean;
};

type BlockedProcessResult = {
  readonly operationId: string;
  readonly status: 'blocked';
  readonly code:
    | 'authorization-revoked'
    | 'dependency-missing'
    | 'dependency-failed'
    | 'dependency-cycle';
  readonly dependencyOperationId?: string;
  readonly replayed: false;
};

export type SyncOperationProcessResult =
  AppliedProcessResult | ConflictProcessResult | BlockedProcessResult;

export interface SyncUploadProcessResult {
  readonly schemaVersion: 1;
  readonly clientId: string;
  readonly results: readonly SyncOperationProcessResult[];
}

const SyncUploadProcessContextSchema = z.strictObject({
  authenticatedClientId: UuidSchema,
  authenticatedSessionId: UuidSchema,
  requestId: UuidSchema,
});

const ResolvedSyncWriteScopeSchema = z.strictObject({
  userId: UuidSchema,
  householdId: UuidSchema,
  role: z.enum(['owner', 'member']),
  writableSpaces: z
    .array(
      z.strictObject({
        id: UuidSchema,
        householdId: UuidSchema,
        visibility: z.enum(['private', 'shared']),
        originalOwnerUserId: UuidSchema,
      }),
    )
    .min(1)
    .max(256),
});

export type SyncUploadAuthorizationErrorCode =
  'invalid-write-context' | 'write-scope-unavailable' | 'invalid-write-scope';

export class SyncUploadAuthorizationError extends Error {
  constructor(
    readonly code: SyncUploadAuthorizationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SyncUploadAuthorizationError';
  }
}

const compareStrings = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

const compareOperations = (left: SyncOperation, right: SyncOperation) => {
  const timeDifference =
    Date.parse(left.createdAt) - Date.parse(right.createdAt);
  return timeDifference !== 0
    ? timeDifference
    : compareStrings(left.operationId, right.operationId);
};

const cycleOperationIds = (
  operations: readonly SyncOperation[],
): ReadonlySet<string> => {
  const byId = new Map(
    operations.map((operation) => [operation.operationId, operation]),
  );
  const indexById = new Map<string, number>();
  const lowLinkById = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles = new Set<string>();
  let nextIndex = 0;

  const visit = (operationId: string) => {
    indexById.set(operationId, nextIndex);
    lowLinkById.set(operationId, nextIndex);
    nextIndex += 1;
    stack.push(operationId);
    onStack.add(operationId);

    const dependencies = [...(byId.get(operationId)?.dependencies ?? [])]
      .filter((dependencyId) => byId.has(dependencyId))
      .sort();
    for (const dependencyId of dependencies) {
      if (!indexById.has(dependencyId)) {
        visit(dependencyId);
        lowLinkById.set(
          operationId,
          Math.min(
            lowLinkById.get(operationId)!,
            lowLinkById.get(dependencyId)!,
          ),
        );
      } else if (onStack.has(dependencyId)) {
        lowLinkById.set(
          operationId,
          Math.min(lowLinkById.get(operationId)!, indexById.get(dependencyId)!),
        );
      }
    }

    if (lowLinkById.get(operationId) !== indexById.get(operationId)) return;
    const component: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop();
      if (member !== undefined) {
        onStack.delete(member);
        component.push(member);
      }
    } while (member !== operationId);
    if (component.length > 1) {
      for (const cycleId of component) cycles.add(cycleId);
    }
  };

  for (const operation of [...operations].sort(compareOperations)) {
    if (!indexById.has(operation.operationId)) visit(operation.operationId);
  }
  return cycles;
};

const isSuccessful = (
  result: SyncOperationProcessResult | StoredSyncOperationOutcome,
) => result.status === 'applied';

export interface SyncUploadProcessorOptions {
  readonly validator: CanonicalSyncUploadValidator;
  readonly repository: SyncOperationProcessorRepository;
}

export class SyncUploadProcessor {
  private readonly validator: CanonicalSyncUploadValidator;
  private readonly repository: SyncOperationProcessorRepository;

  constructor(options: SyncUploadProcessorOptions) {
    this.validator = options.validator;
    this.repository = options.repository;
  }

  async process(
    input: unknown,
    context: {
      readonly authenticatedClientId: string;
      readonly authenticatedSessionId: string;
      readonly requestId: string;
    },
  ): Promise<Readonly<SyncUploadProcessResult>> {
    const parsedContext = SyncUploadProcessContextSchema.safeParse(context);
    if (!parsedContext.success) {
      throw new SyncUploadAuthorizationError(
        'invalid-write-context',
        'Authenticated sync write context is malformed',
      );
    }
    const rawScope = await this.repository.resolveWriteScope({
      authenticatedSessionId: parsedContext.data.authenticatedSessionId,
      clientId: parsedContext.data.authenticatedClientId,
    });
    if (rawScope === undefined) {
      throw new SyncUploadAuthorizationError(
        'write-scope-unavailable',
        'Sync writes are unavailable for this session and client',
      );
    }
    const parsedScope = ResolvedSyncWriteScopeSchema.safeParse(rawScope);
    if (!parsedScope.success) {
      throw new SyncUploadAuthorizationError(
        'invalid-write-scope',
        'Server-derived sync write scope is malformed',
      );
    }
    const seenSpaces = new Set<string>();
    for (const space of parsedScope.data.writableSpaces) {
      if (
        seenSpaces.has(space.id) ||
        space.householdId !== parsedScope.data.householdId ||
        (space.visibility === 'private' &&
          space.originalOwnerUserId !== parsedScope.data.userId)
      ) {
        throw new SyncUploadAuthorizationError(
          'invalid-write-scope',
          'Server-derived sync write scope violates private-space boundaries',
        );
      }
      seenSpaces.add(space.id);
    }
    const principalContext: SyncRepositoryPrincipalContext = deepFreeze({
      authenticatedUserId: parsedScope.data.userId,
      authenticatedSessionId: parsedContext.data.authenticatedSessionId,
      householdId: parsedScope.data.householdId,
      role: parsedScope.data.role,
      requestId: parsedContext.data.requestId,
      writableSpaceIds: [...seenSpaces].sort(),
    });
    const upload = this.validator.validate(input, {
      authenticatedClientId: parsedContext.data.authenticatedClientId,
      authorizedSpaceIds: principalContext.writableSpaceIds,
    });
    const operations = [...upload.operations];
    const byId = new Map(
      operations.map((operation) => [operation.operationId, operation]),
    );
    const externalDependencyIds = [
      ...new Set(
        operations.flatMap((operation) =>
          operation.dependencies.filter(
            (dependencyId) => !byId.has(dependencyId),
          ),
        ),
      ),
    ].sort();
    const storedDependencies =
      externalDependencyIds.length === 0
        ? new Map<string, never>()
        : await this.repository.getStoredOutcomes({
            clientId: parsedContext.data.authenticatedClientId,
            operationIds: externalDependencyIds,
            context: principalContext,
          });
    const cycles = cycleOperationIds(operations);
    const resultById = new Map<string, SyncOperationProcessResult>();
    const cycleResults = [...cycles]
      .map((operationId) => byId.get(operationId)!)
      .sort(compareOperations)
      .map<BlockedProcessResult>((operation) => ({
        operationId: operation.operationId,
        status: 'blocked',
        code: 'dependency-cycle',
        replayed: false,
      }));
    for (const result of cycleResults) {
      resultById.set(result.operationId, result);
    }

    const processable = operations.filter(
      (operation) => !cycles.has(operation.operationId),
    );
    const indegree = new Map<string, number>();
    const children = new Map<string, string[]>();
    for (const operation of processable) {
      let degree = 0;
      for (const dependencyId of operation.dependencies) {
        if (byId.has(dependencyId) && !cycles.has(dependencyId)) {
          degree += 1;
          const dependencyChildren = children.get(dependencyId) ?? [];
          dependencyChildren.push(operation.operationId);
          children.set(dependencyId, dependencyChildren);
        }
      }
      indegree.set(operation.operationId, degree);
    }

    const ready = processable
      .filter((operation) => indegree.get(operation.operationId) === 0)
      .sort(compareOperations);
    const orderedResults: SyncOperationProcessResult[] = [];
    while (ready.length > 0) {
      const operation = ready.shift()!;
      const result = await this.processOperation(
        operation,
        byId,
        resultById,
        principalContext,
        storedDependencies,
      );
      resultById.set(operation.operationId, result);
      orderedResults.push(result);

      for (const childId of (
        children.get(operation.operationId) ?? []
      ).sort()) {
        const nextDegree = (indegree.get(childId) ?? 1) - 1;
        indegree.set(childId, nextDegree);
        if (nextDegree === 0) {
          ready.push(byId.get(childId)!);
          ready.sort(compareOperations);
        }
      }
    }

    orderedResults.push(...cycleResults);
    return deepFreeze({
      schemaVersion: 1 as const,
      clientId: parsedContext.data.authenticatedClientId,
      results: orderedResults,
    });
  }

  private async processOperation(
    operation: SyncOperation,
    batch: ReadonlyMap<string, SyncOperation>,
    batchResults: ReadonlyMap<string, SyncOperationProcessResult>,
    principalContext: SyncRepositoryPrincipalContext,
    storedDependencies: ReadonlyMap<
      string,
      {
        readonly fingerprint: string;
        readonly outcome: StoredSyncOperationOutcome;
      }
    >,
  ): Promise<SyncOperationProcessResult> {
    for (const dependencyId of [...operation.dependencies].sort()) {
      const batchDependency = batch.get(dependencyId);
      if (batchDependency !== undefined) {
        const dependencyResult = batchResults.get(dependencyId);
        if (dependencyResult === undefined) {
          return {
            operationId: operation.operationId,
            status: 'blocked',
            code: 'dependency-missing',
            dependencyOperationId: dependencyId,
            replayed: false,
          };
        }
        if (!isSuccessful(dependencyResult)) {
          return {
            operationId: operation.operationId,
            status: 'blocked',
            code: 'dependency-failed',
            dependencyOperationId: dependencyId,
            replayed: false,
          };
        }
        continue;
      }

      const stored = storedDependencies.get(dependencyId);
      if (stored === undefined) {
        return {
          operationId: operation.operationId,
          status: 'blocked',
          code: 'dependency-missing',
          dependencyOperationId: dependencyId,
          replayed: false,
        };
      }
      if (!isSuccessful(stored.outcome)) {
        return {
          operationId: operation.operationId,
          status: 'blocked',
          code: 'dependency-failed',
          dependencyOperationId: dependencyId,
          replayed: false,
        };
      }
    }

    const execution = await this.repository.executeOnce({
      operation,
      fingerprint: fingerprintSyncOperation(operation),
      context: deepFreeze({
        source: 'offline-sync-api' as const,
        externalEffects: 'forbidden' as const,
        mayEnqueueProviderWrites: false as const,
        authorizationRevalidation: 'required-in-transaction' as const,
        ...principalContext,
        targetSpaceId: getSyncOperationSpaceId(operation),
      }),
    });
    if (execution.kind === 'idempotency-key-reused') {
      return {
        operationId: operation.operationId,
        status: 'conflict',
        code: 'idempotency-key-reused',
        replayed: false,
      };
    }
    if (execution.kind === 'in-progress') {
      return {
        operationId: operation.operationId,
        status: 'conflict',
        code: 'operation-in-progress',
        replayed: false,
      };
    }
    if (execution.kind === 'authorization-revoked') {
      return {
        operationId: operation.operationId,
        status: 'blocked',
        code: 'authorization-revoked',
        replayed: false,
      };
    }
    if (execution.outcome.status === 'applied') {
      return {
        operationId: operation.operationId,
        status: 'applied',
        revision: execution.outcome.revision,
        replayed: execution.kind === 'replay',
      };
    }
    const result: ConflictProcessResult = {
      operationId: operation.operationId,
      status: 'conflict',
      code: execution.outcome.code,
      replayed: execution.kind === 'replay',
      ...(execution.outcome.currentRevision === undefined
        ? {}
        : { currentRevision: execution.outcome.currentRevision }),
    };
    return result;
  }
}

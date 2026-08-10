import { createHash } from 'node:crypto';

import {
  IdentifierSchema,
  JsonValueSchema,
  SyncOperationSchema,
  UuidSchema,
  deepFreeze,
  type DeepReadonly,
  type SyncOperation,
} from '@emdo/contracts';
import { z } from 'zod';

export interface SyncOperationClock {
  now(): Date;
}

export interface SyncEntityPolicy {
  readonly entityType: string;
  readonly allowedMutations: readonly (
    'create' | 'update' | 'delete' | 'delta'
  )[];
  readonly maximumPayloadBytes?: number;
}

const SyncEntityPolicySchema = z.strictObject({
  entityType: IdentifierSchema,
  allowedMutations: z
    .array(z.enum(['create', 'update', 'delete', 'delta']))
    .min(1)
    .max(4)
    .refine((value) => new Set(value).size === value.length),
  maximumPayloadBytes: z.number().int().positive().max(1_048_576).optional(),
});

export const DEFAULT_SYNC_ENTITY_POLICIES: readonly SyncEntityPolicy[] =
  deepFreeze([
    {
      entityType: 'conversation.event',
      allowedMutations: ['create'],
    },
    {
      entityType: 'scheduler.item',
      allowedMutations: ['create', 'update', 'delete'],
    },
    {
      entityType: 'scheduler.task',
      allowedMutations: ['create', 'update', 'delete'],
    },
    {
      entityType: 'scheduler.reminder',
      allowedMutations: ['create', 'update', 'delete'],
    },
    {
      entityType: 'scheduler.chore',
      allowedMutations: ['create', 'update', 'delete'],
    },
    {
      entityType: 'scheduler.routine',
      allowedMutations: ['create', 'update', 'delete'],
    },
    {
      entityType: 'finance.account',
      allowedMutations: ['create', 'update', 'delete'],
    },
    {
      entityType: 'finance.transaction',
      allowedMutations: ['create', 'update'],
    },
    {
      entityType: 'finance.category',
      allowedMutations: ['create', 'update', 'delete'],
    },
    {
      entityType: 'finance.budget',
      allowedMutations: ['create', 'update', 'delete'],
    },
    {
      entityType: 'finance.bill',
      allowedMutations: ['create', 'update', 'delete'],
    },
    {
      entityType: 'finance.subscription',
      allowedMutations: ['create', 'update', 'delete'],
    },
    {
      entityType: 'finance.goal',
      allowedMutations: ['create', 'update', 'delete'],
    },
    {
      entityType: 'shopping.list',
      allowedMutations: ['create', 'update', 'delete'],
    },
    {
      entityType: 'shopping.item',
      allowedMutations: ['create', 'update', 'delete', 'delta'],
    },
    {
      entityType: 'shopping.preference',
      allowedMutations: ['create', 'update', 'delete'],
    },
  ]);

const UploadEnvelopeSchema = z.strictObject({
  operations: z.array(z.unknown()),
});

const SyncUploadValidationContextSchema = z
  .strictObject({
    authenticatedClientId: UuidSchema,
    authorizedSpaceIds: z.array(UuidSchema).min(1).max(256),
  })
  .refine(
    (value) =>
      new Set(value.authorizedSpaceIds).size ===
      value.authorizedSpaceIds.length,
  );

const LocalMutationDataSchema = z.record(z.string(), JsonValueSchema);

const CreateMutationPayloadSchema = z.strictObject({
  spaceId: UuidSchema,
  value: LocalMutationDataSchema,
});
const UpdateMutationPayloadSchema = z.strictObject({
  spaceId: UuidSchema,
  patch: LocalMutationDataSchema,
});
const DeleteMutationPayloadSchema = z.strictObject({
  spaceId: UuidSchema,
});
const DeltaMutationPayloadSchema = z.strictObject({
  spaceId: UuidSchema,
  delta: LocalMutationDataSchema,
});

const RESERVED_OFFLINE_DATA_FIELDS = new Set([
  'approval',
  'approvaldecisionid',
  'approvalstate',
  'approved',
  'authenticatedsessionid',
  'authorization',
  'baserevision',
  'capabilityid',
  'clientid',
  'checkout',
  'credential',
  'disclosuregrantid',
  'enqueueproviderwrite',
  'externaleffects',
  'externalaction',
  'googlecalendarwrite',
  'householdid',
  'idempotencykey',
  'mayenqueueproviderwrites',
  'mutationkind',
  'oauth',
  'originalowneruserid',
  'operationid',
  'owneruserid',
  'payment',
  'permit',
  'provideraction',
  'providerwrite',
  'purchase',
  'requestedexternalaction',
  'role',
  'schemaversion',
  'sessionid',
  'spaceid',
  'targetspaceid',
  'userid',
  'visibility',
]);

const containsReservedOfflineDataField = (value: unknown): boolean => {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some((entry) => containsReservedOfflineDataField(entry));
  }
  return Object.entries(value).some(([key, entry]) => {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
    return (
      RESERVED_OFFLINE_DATA_FIELDS.has(normalizedKey) ||
      containsReservedOfflineDataField(entry)
    );
  });
};

const parseMutationPayload = (operation: SyncOperation) => {
  const schema = {
    create: CreateMutationPayloadSchema,
    update: UpdateMutationPayloadSchema,
    delete: DeleteMutationPayloadSchema,
    delta: DeltaMutationPayloadSchema,
  }[operation.mutation.kind];
  const parsed = schema.safeParse(operation.mutation.payload);
  if (!parsed.success) {
    throw new SyncUploadValidationError(
      'invalid-operation-payload',
      'Sync mutation payload does not match its strict local-write envelope',
      operation.operationId,
    );
  }
  const localData =
    operation.mutation.kind === 'create'
      ? (parsed.data as z.infer<typeof CreateMutationPayloadSchema>).value
      : operation.mutation.kind === 'update'
        ? (parsed.data as z.infer<typeof UpdateMutationPayloadSchema>).patch
        : operation.mutation.kind === 'delta'
          ? (parsed.data as z.infer<typeof DeltaMutationPayloadSchema>).delta
          : undefined;
  if (containsReservedOfflineDataField(localData)) {
    throw new SyncUploadValidationError(
      'offline-provider-write-forbidden',
      'Offline data cannot carry authorization or provider-write fields',
      operation.operationId,
    );
  }
  return { spaceId: parsed.data.spaceId, localData };
};

export const getSyncOperationSpaceId = (operation: SyncOperation) =>
  parseMutationPayload(operation).spaceId;

const FORBIDDEN_OFFLINE_ENTITY_SEGMENTS = new Set([
  'banking',
  'bank',
  'calendar-event',
  'cart',
  'checkout',
  'credential',
  'credit',
  'google',
  'investing',
  'oauth',
  'order',
  'payment',
  'provider',
  'purchase',
  'tax',
  'transfer',
]);

const FORBIDDEN_OFFLINE_ENTITY_TYPES = new Set([
  'calendar.event',
  'scheduler.event',
]);

const isProviderOrHighRiskEntity = (entityType: string) =>
  FORBIDDEN_OFFLINE_ENTITY_TYPES.has(entityType.toLowerCase()) ||
  entityType
    .toLowerCase()
    .split(/[._-]/u)
    .some((segment, index, segments) => {
      if (FORBIDDEN_OFFLINE_ENTITY_SEGMENTS.has(segment)) return true;
      return (
        index < segments.length - 1 &&
        FORBIDDEN_OFFLINE_ENTITY_SEGMENTS.has(
          `${segment}-${segments[index + 1]}`,
        )
      );
    });

class CanonicalJsonBoundaryError extends Error {
  constructor(readonly boundaryCode: 'invalid' | 'too-large') {
    super('Value is outside the bounded canonical JSON envelope');
    this.name = 'CanonicalJsonBoundaryError';
  }
}

const boundedCanonicalJson = (value: unknown, maximumBytes: number): string => {
  const maximumDepth = 32;
  const maximumNodes = 50_000;
  const maximumCollectionEntries = 10_000;
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  let bytes = 0;

  const account = (fragment: string) => {
    bytes += Buffer.byteLength(fragment, 'utf8');
    if (bytes > maximumBytes) {
      throw new CanonicalJsonBoundaryError('too-large');
    }
    return fragment;
  };

  const walk = (candidate: unknown, depth: number): string => {
    nodes += 1;
    if (nodes > maximumNodes || depth > maximumDepth) {
      throw new CanonicalJsonBoundaryError('invalid');
    }
    if (candidate === null) return account('null');
    if (typeof candidate === 'boolean') {
      return account(candidate ? 'true' : 'false');
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) {
        throw new CanonicalJsonBoundaryError('invalid');
      }
      return account(JSON.stringify(candidate));
    }
    if (typeof candidate === 'string') {
      if (Buffer.byteLength(candidate, 'utf8') > maximumBytes) {
        throw new CanonicalJsonBoundaryError('too-large');
      }
      return account(JSON.stringify(candidate));
    }
    if (typeof candidate !== 'object') {
      throw new CanonicalJsonBoundaryError('invalid');
    }
    if (ancestors.has(candidate)) {
      throw new CanonicalJsonBoundaryError('invalid');
    }
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        if (candidate.length > maximumCollectionEntries) {
          throw new CanonicalJsonBoundaryError('too-large');
        }
        const entries: string[] = [account('[')];
        for (let index = 0; index < candidate.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(
            candidate,
            String(index),
          );
          if (descriptor === undefined || !('value' in descriptor)) {
            throw new CanonicalJsonBoundaryError('invalid');
          }
          if (index > 0) entries.push(account(','));
          entries.push(walk(descriptor.value, depth + 1));
        }
        entries.push(account(']'));
        return entries.join('');
      }

      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new CanonicalJsonBoundaryError('invalid');
      }
      if (Object.getOwnPropertySymbols(candidate).length > 0) {
        throw new CanonicalJsonBoundaryError('invalid');
      }
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      const keys = Object.keys(descriptors)
        .filter((key) => descriptors[key]?.enumerable === true)
        .sort();
      if (keys.length > maximumCollectionEntries) {
        throw new CanonicalJsonBoundaryError('too-large');
      }
      const properties: string[] = [account('{')];
      for (const [index, key] of keys.entries()) {
        const descriptor = descriptors[key];
        if (descriptor === undefined || !('value' in descriptor)) {
          throw new CanonicalJsonBoundaryError('invalid');
        }
        if (Buffer.byteLength(key, 'utf8') > 1_024) {
          throw new CanonicalJsonBoundaryError('too-large');
        }
        if (index > 0) properties.push(account(','));
        properties.push(
          `${account(JSON.stringify(key))}${account(':')}${walk(
            descriptor.value,
            depth + 1,
          )}`,
        );
      }
      properties.push(account('}'));
      return properties.join('');
    } catch (error) {
      if (error instanceof CanonicalJsonBoundaryError) throw error;
      throw new CanonicalJsonBoundaryError('invalid');
    } finally {
      ancestors.delete(candidate);
    }
  };

  return walk(value, 0);
};

export const fingerprintSyncOperation = (operation: SyncOperation) => {
  try {
    return createHash('sha256')
      .update(boundedCanonicalJson(operation, 1_048_576), 'utf8')
      .digest('hex');
  } catch {
    throw new SyncUploadValidationError(
      'invalid-operation',
      'Sync operation cannot be canonically fingerprinted',
      operation.operationId,
    );
  }
};

export type SyncUploadValidationErrorCode =
  | 'invalid-upload'
  | 'invalid-upload-context'
  | 'invalid-operation'
  | 'invalid-operation-payload'
  | 'empty-upload'
  | 'upload-too-large'
  | 'duplicate-operation'
  | 'client-id-mismatch'
  | 'schema-version-unsupported'
  | 'entity-not-supported'
  | 'offline-provider-write-forbidden'
  | 'mutation-not-allowed'
  | 'space-not-writable'
  | 'invalid-dependency'
  | 'dependency-budget-exceeded'
  | 'operation-created-in-future';

export class SyncUploadValidationError extends Error {
  constructor(
    readonly code: SyncUploadValidationErrorCode,
    message: string,
    readonly operationId?: string,
  ) {
    super(message);
    this.name = 'SyncUploadValidationError';
  }
}

export interface CanonicalSyncUpload {
  readonly operations: readonly SyncOperation[];
}

export interface CanonicalSyncUploadValidatorOptions {
  readonly currentSchemaVersion: 1;
  readonly clock: SyncOperationClock;
  readonly entityPolicies?: readonly SyncEntityPolicy[];
  readonly maximumOperations?: number;
  readonly maximumUploadBytes?: number;
  readonly maximumFutureSkewMs?: number;
  readonly maximumDependencyEdges?: number;
  readonly maximumDistinctDependencies?: number;
}

const throwValidation = (
  code: SyncUploadValidationErrorCode,
  message: string,
  operationId?: string,
): never => {
  throw new SyncUploadValidationError(code, message, operationId);
};

export class CanonicalSyncUploadValidator {
  private readonly currentSchemaVersion: 1;
  private readonly clock: SyncOperationClock;
  private readonly policies: ReadonlyMap<string, SyncEntityPolicy>;
  private readonly maximumOperations: number;
  private readonly maximumUploadBytes: number;
  private readonly maximumFutureSkewMs: number;
  private readonly maximumDependencyEdges: number;
  private readonly maximumDistinctDependencies: number;

  constructor(options: CanonicalSyncUploadValidatorOptions) {
    this.currentSchemaVersion = options.currentSchemaVersion;
    this.clock = options.clock;
    this.maximumOperations = options.maximumOperations ?? 256;
    this.maximumUploadBytes = options.maximumUploadBytes ?? 1_048_576;
    this.maximumFutureSkewMs = options.maximumFutureSkewMs ?? 300_000;
    this.maximumDependencyEdges = options.maximumDependencyEdges ?? 2_048;
    this.maximumDistinctDependencies =
      options.maximumDistinctDependencies ?? 1_024;
    if (
      !Number.isSafeInteger(this.maximumOperations) ||
      this.maximumOperations <= 0 ||
      !Number.isSafeInteger(this.maximumUploadBytes) ||
      this.maximumUploadBytes <= 0 ||
      !Number.isSafeInteger(this.maximumFutureSkewMs) ||
      this.maximumFutureSkewMs < 0 ||
      !Number.isSafeInteger(this.maximumDependencyEdges) ||
      this.maximumDependencyEdges <= 0 ||
      !Number.isSafeInteger(this.maximumDistinctDependencies) ||
      this.maximumDistinctDependencies <= 0 ||
      this.maximumDistinctDependencies > this.maximumDependencyEdges
    ) {
      throw new SyncUploadValidationError(
        'invalid-upload',
        'Sync upload validator configuration is invalid',
      );
    }

    const policies = options.entityPolicies ?? DEFAULT_SYNC_ENTITY_POLICIES;
    const byEntity = new Map<string, SyncEntityPolicy>();
    for (const candidatePolicy of policies) {
      const parsedPolicy = SyncEntityPolicySchema.safeParse(candidatePolicy);
      if (!parsedPolicy.success) {
        throw new SyncUploadValidationError(
          'invalid-upload',
          'Sync entity policy configuration is malformed',
        );
      }
      const policy = parsedPolicy.data;
      if (
        isProviderOrHighRiskEntity(policy.entityType) ||
        byEntity.has(policy.entityType) ||
        policy.allowedMutations.length === 0
      ) {
        throw new SyncUploadValidationError(
          'offline-provider-write-forbidden',
          'Offline sync policies cannot expose provider or high-risk actions',
        );
      }
      byEntity.set(policy.entityType, deepFreeze({ ...policy }));
    }
    this.policies = byEntity;
  }

  validate(
    input: unknown,
    context: {
      readonly authenticatedClientId: string;
      readonly authorizedSpaceIds: readonly string[];
    },
  ): DeepReadonly<CanonicalSyncUpload> {
    try {
      boundedCanonicalJson(input, this.maximumUploadBytes);
    } catch (error) {
      throw new SyncUploadValidationError(
        error instanceof CanonicalJsonBoundaryError &&
          error.boundaryCode === 'too-large'
          ? 'upload-too-large'
          : 'invalid-upload',
        'Sync upload is outside the bounded JSON envelope',
      );
    }
    const parsedEnvelope = UploadEnvelopeSchema.safeParse(input);
    if (!parsedEnvelope.success) {
      throw new SyncUploadValidationError(
        'invalid-upload',
        'Sync upload body is malformed',
      );
    }
    const parsedContext = SyncUploadValidationContextSchema.safeParse(context);
    if (!parsedContext.success) {
      throw new SyncUploadValidationError(
        'invalid-upload-context',
        'Server-derived sync upload context is malformed',
      );
    }
    const authorizedSpaceIds = new Set(parsedContext.data.authorizedSpaceIds);
    if (parsedEnvelope.data.operations.length === 0) {
      throw new SyncUploadValidationError(
        'empty-upload',
        'Sync upload must contain at least one operation',
      );
    }
    if (parsedEnvelope.data.operations.length > this.maximumOperations) {
      throw new SyncUploadValidationError(
        'upload-too-large',
        'Sync upload contains too many operations',
      );
    }
    let serverNowMs: number;
    try {
      const serverNow = this.clock.now();
      serverNowMs = serverNow.getTime();
    } catch {
      serverNowMs = Number.NaN;
    }
    if (!Number.isFinite(serverNowMs)) {
      throw new SyncUploadValidationError(
        'invalid-upload',
        'Sync upload clock is unavailable',
      );
    }

    const operations: SyncOperation[] = [];
    const operationIds = new Set<string>();
    const distinctDependencyIds = new Set<string>();
    let dependencyEdges = 0;
    for (const rawOperation of parsedEnvelope.data.operations) {
      const rawRecord =
        rawOperation !== null && typeof rawOperation === 'object'
          ? (rawOperation as Record<string, unknown>)
          : undefined;
      if (rawRecord?.schemaVersion !== this.currentSchemaVersion) {
        throwValidation(
          'schema-version-unsupported',
          'Sync operation schema version is unsupported',
          typeof rawRecord?.operationId === 'string'
            ? rawRecord.operationId
            : undefined,
        );
      }
      const parsedOperation = SyncOperationSchema.safeParse(rawOperation);
      if (!parsedOperation.success) {
        throw new SyncUploadValidationError(
          'invalid-operation',
          'Sync operation is malformed',
          typeof rawRecord?.operationId === 'string'
            ? rawRecord.operationId
            : undefined,
        );
      }
      const operation = parsedOperation.data;
      if (operation.clientId !== parsedContext.data.authenticatedClientId) {
        throwValidation(
          'client-id-mismatch',
          'Operation client does not match the authenticated sync client',
          operation.operationId,
        );
      }
      if (operationIds.has(operation.operationId)) {
        throwValidation(
          'duplicate-operation',
          'Sync upload repeats an operation ID',
          operation.operationId,
        );
      }
      operationIds.add(operation.operationId);
      if (isProviderOrHighRiskEntity(operation.entity.type)) {
        throwValidation(
          'offline-provider-write-forbidden',
          'Offline sync cannot represent provider or high-risk actions',
          operation.operationId,
        );
      }
      const policy = this.policies.get(operation.entity.type);
      if (policy === undefined) {
        throw new SyncUploadValidationError(
          'entity-not-supported',
          'Entity type is not available through offline sync',
          operation.operationId,
        );
      }
      if (!policy.allowedMutations.includes(operation.mutation.kind)) {
        throwValidation(
          'mutation-not-allowed',
          'Mutation is not allowed for this offline entity',
          operation.operationId,
        );
      }
      const { spaceId } = parseMutationPayload(operation);
      if (!authorizedSpaceIds.has(spaceId)) {
        throwValidation(
          'space-not-writable',
          'Operation target is not writable in the server-derived sync scope',
          operation.operationId,
        );
      }
      const maximumPayloadBytes = policy.maximumPayloadBytes ?? 262_144;
      try {
        boundedCanonicalJson(operation.mutation.payload, maximumPayloadBytes);
      } catch {
        throwValidation(
          'upload-too-large',
          'Operation payload exceeds the entity limit',
          operation.operationId,
        );
      }
      if (
        operation.dependencies.includes(operation.operationId) ||
        new Set(operation.dependencies).size !== operation.dependencies.length
      ) {
        throwValidation(
          'invalid-dependency',
          'Operation dependencies must be unique and cannot reference itself',
          operation.operationId,
        );
      }
      dependencyEdges += operation.dependencies.length;
      for (const dependencyId of operation.dependencies) {
        distinctDependencyIds.add(dependencyId);
      }
      if (
        dependencyEdges > this.maximumDependencyEdges ||
        distinctDependencyIds.size > this.maximumDistinctDependencies
      ) {
        throwValidation(
          'dependency-budget-exceeded',
          'Sync upload exceeds the dependency processing budget',
          operation.operationId,
        );
      }
      if (
        Date.parse(operation.createdAt) >
        serverNowMs + this.maximumFutureSkewMs
      ) {
        throwValidation(
          'operation-created-in-future',
          'Operation creation time is too far in the future',
          operation.operationId,
        );
      }
      operations.push(operation);
    }

    return deepFreeze({ operations });
  }
}

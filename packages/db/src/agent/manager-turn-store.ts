import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  EffectiveAuthorizationScopeFingerprintSchema,
  IdempotencyKeySchema,
  JsonValueSchema,
  OpaqueReferenceSchema,
  SemanticVersionSchema,
  Sha256Schema,
  SupportedLocaleSchema,
  UuidSchema,
  deepFreeze,
  type EffectiveAuthorizationScopeFingerprint,
  type JsonValue,
} from '@emdo/contracts';
import { z } from 'zod';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import {
  beginDurableTransaction,
  firstResultRow,
  type DurableRepositoryPrincipal,
} from '../durable/scoped-transaction.js';

const RequestedEscalationTriggerSchema = z.enum([
  'dependent-cross-domain',
  'failed-output-validation',
  'low-confidence-reconciliation',
  'complex-reasoning',
]);

const PrincipalSchema = z.strictObject({
  userId: UuidSchema,
  sessionId: UuidSchema,
  householdId: UuidSchema,
  role: z.enum(['owner', 'member']),
  emailVerified: z.literal(true),
  spaceAccessGrantId: UuidSchema,
  // Compatibility with the API principal. This value is validated as data but
  // deliberately never crosses the SQL boundary; PostgreSQL derives both the
  // collection scope and the run operation scope under row locks.
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema,
});

const TurnRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  conversationId: UuidSchema.optional(),
  message: z.string().trim().min(1).max(16_000),
  routeHint: z.enum(['scheduler', 'finance', 'shopping']).optional(),
  // This is user-request data, fixed before the server-minted invocation
  // lineage is added below. It is therefore part of idempotency equality.
  locale: SupportedLocaleSchema,
});

const ClaimInputSchema = z.strictObject({
  request: TurnRequestSchema,
  principal: PrincipalSchema,
  requestId: UuidSchema,
  idempotencyKey: IdempotencyKeySchema,
});

const StoredClaimResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('claimed'),
    claimId: UuidSchema,
    runId: UuidSchema,
    conversationId: UuidSchema,
    rootManagerInvocationId: UuidSchema,
    authorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprintSchema,
    escalationTriggers: z
      .array(RequestedEscalationTriggerSchema)
      .max(RequestedEscalationTriggerSchema.options.length)
      .refine((values) => new Set(values).size === values.length),
  }),
  z.strictObject({
    status: z.literal('replay'),
    runId: UuidSchema,
    conversationId: UuidSchema,
    rootManagerInvocationId: UuidSchema,
  }),
  z.strictObject({ status: z.literal('conflict') }),
]);

const CompletionResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.enum(['completed', 'replay']),
    terminalEventSequence: z.number().int().positive().safe(),
  }),
  z.strictObject({ status: z.literal('conflict') }),
]);

const IndeterminateResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.enum(['indeterminate', 'replay']),
    terminalEventSequence: z.number().int().positive().safe(),
  }),
  z.strictObject({ status: z.literal('conflict') }),
]);

const TurnResultJsonSchema = JsonValueSchema.superRefine((value, context) => {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    context.addIssue({
      code: 'custom',
      message: 'Manager turn result must be an object',
    });
    return;
  }
  if (!UuidSchema.safeParse(value.runId).success) {
    context.addIssue({
      code: 'custom',
      path: ['runId'],
      message: 'Manager turn result run ID is invalid',
    });
  }
  if (
    value.status !== 'completed' &&
    value.status !== 'needs-approval' &&
    value.status !== 'failed'
  ) {
    context.addIssue({
      code: 'custom',
      path: ['status'],
      message: 'Manager turn result status is invalid',
    });
  }
});

const CompleteInputSchema = z.strictObject({
  claimId: UuidSchema,
  ownershipToken: OpaqueReferenceSchema,
  runId: UuidSchema,
  result: TurnResultJsonSchema,
});

const IndeterminateInputSchema = z.strictObject({
  claimId: UuidSchema,
  ownershipToken: OpaqueReferenceSchema,
  runId: UuidSchema,
  reasonCode: z.literal('agent-runtime-failed'),
});

const OptionsSchema = z.strictObject({
  managerAgentVersion: SemanticVersionSchema.default('1.0.0'),
  requestedModel: z
    .enum(['gpt-5.6-luna', 'gpt-5.6-terra', 'provider-free-mvp-v1'])
    .default('gpt-5.6-luna'),
});

export interface PostgresManagerTurnPrincipal {
  readonly userId: string;
  readonly sessionId: string;
  readonly householdId: string;
  readonly role: 'owner' | 'member';
  readonly emailVerified: true;
  readonly spaceAccessGrantId: string;
  readonly collectionAuthorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprint;
}

export interface PostgresManagerTurnRequest {
  readonly schemaVersion: 1;
  readonly conversationId?: string;
  readonly message: string;
  readonly routeHint?: 'scheduler' | 'finance' | 'shopping';
  readonly locale: z.output<typeof SupportedLocaleSchema>;
}

export type PostgresManagerTurnClaim =
  | Readonly<{
      status: 'claimed';
      claimId: string;
      ownershipToken: string;
      runId: string;
      conversationId: string;
      rootManagerInvocationId: string;
      authorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprint;
      escalationTriggers: readonly z.infer<
        typeof RequestedEscalationTriggerSchema
      >[];
    }>
  | Readonly<{
      status: 'replay';
      runId: string;
      conversationId: string;
      rootManagerInvocationId: string;
    }>;

export type PostgresManagerTurnCompletion =
  | Readonly<{
      status: 'completed' | 'replay';
      terminalEventSequence: number;
    }>
  | Readonly<{ status: 'conflict' }>;

export type PostgresManagerTurnIndeterminate =
  | Readonly<{
      status: 'indeterminate' | 'replay';
      terminalEventSequence: number;
    }>
  | Readonly<{ status: 'conflict' }>;

export interface PostgresManagerTurnStoreOptions {
  readonly managerAgentVersion?: string;
  readonly requestedModel?:
    'gpt-5.6-luna' | 'gpt-5.6-terra' | 'provider-free-mvp-v1';
}

export class ManagerTurnPersistenceError extends Error {
  constructor(
    readonly code:
      | 'database-unavailable'
      | 'idempotency-conflict'
      | 'invalid-input'
      | 'invalid-result',
    message: string,
  ) {
    super(message);
    this.name = 'ManagerTurnPersistenceError';
  }
}

class AmbiguousManagerTurnCommitError extends Error {
  constructor() {
    super('Manager turn commit acknowledgement was lost');
    this.name = 'AmbiguousManagerTurnCommitError';
  }
}

const canonicalJson = (value: JsonValue): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`,
    )
    .join(',')}}`;
};

const hashCanonicalJson = (value: JsonValue): string =>
  createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');

const ownershipTokenHash = (token: string): string =>
  createHash('sha256')
    .update('emdo.manager-turn-owner.v1', 'utf8')
    .update(Buffer.from([0]))
    .update(token, 'utf8')
    .digest('hex');

const rollbackQuietly = async (client: DatabaseClient): Promise<void> => {
  try {
    await client.query('rollback');
  } catch {
    // Preserve the original transaction error.
  }
};

const beginUnclaimedManagerTurnTransaction = async (
  pool: DatabasePool,
): Promise<DatabaseClient> => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local row_security = on');
    await client.query("set local statement_timeout = '30s'");
    await client.query("set local lock_timeout = '5s'");
    return client;
  } catch (error) {
    await rollbackQuietly(client);
    client.release(false);
    throw error;
  }
};

/**
 * A failed COMMIT makes the socket unusable. It is destroyed before exact
 * operation readback is attempted on a separately acquired session.
 */
const withManagerTurnTransaction = async <Result>(
  pool: DatabasePool,
  principal: Readonly<DurableRepositoryPrincipal> | undefined,
  work: (client: DatabaseClient) => Promise<Result>,
): Promise<Result> => {
  const client =
    principal === undefined
      ? await beginUnclaimedManagerTurnTransaction(pool)
      : await beginDurableTransaction(pool, principal);
  let released = false;
  try {
    const result = await work(client);
    try {
      await client.query('commit');
    } catch {
      released = true;
      client.release(true);
      throw new AmbiguousManagerTurnCommitError();
    }
    released = true;
    client.release(false);
    return result;
  } catch (error) {
    if (!released) {
      await rollbackQuietly(client);
      released = true;
      client.release(false);
    }
    throw error;
  }
};

const parseFunctionResult = <Output>(
  schema: z.ZodType<Output>,
  value: unknown,
): Output => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ManagerTurnPersistenceError(
      'invalid-result',
      'The manager turn aggregate returned a malformed result',
    );
  }
  return deepFreeze(parsed.data) as Output;
};

const principalFor = (input: {
  readonly principal: z.infer<typeof PrincipalSchema>;
  readonly requestId: string;
}): Readonly<DurableRepositoryPrincipal> =>
  deepFreeze({
    userId: input.principal.userId,
    sessionId: input.principal.sessionId,
    requestId: input.requestId,
    householdId: input.principal.householdId,
  });

const databaseUnavailable = (): never => {
  throw new ManagerTurnPersistenceError(
    'database-unavailable',
    'The durable manager turn command could not be verified',
  );
};

export class PostgresManagerTurnStore {
  readonly #options: Readonly<z.output<typeof OptionsSchema>>;

  constructor(
    private readonly pool: DatabasePool,
    options: PostgresManagerTurnStoreOptions = {},
  ) {
    if (typeof pool?.connect !== 'function') {
      throw new ManagerTurnPersistenceError(
        'invalid-input',
        'Manager turn database pool is invalid',
      );
    }
    this.#options = deepFreeze(OptionsSchema.parse(options));
  }

  async claim(rawInput: {
    readonly request: PostgresManagerTurnRequest;
    readonly principal: PostgresManagerTurnPrincipal;
    readonly requestId: string;
    readonly idempotencyKey: string;
  }): Promise<PostgresManagerTurnClaim> {
    const input = ClaimInputSchema.parse(rawInput);
    const operationId = randomUUID();
    const candidateRunId = randomUUID();
    const candidateConversationId =
      input.request.conversationId ?? randomUUID();
    // The root invocation must be stable across all phases of the claimed run,
    // but a retry must not rely on a caller retaining an earlier random ID.
    // It is stored inside the immutable request payload and replayed by SQL.
    const candidateRootManagerInvocationId = randomUUID();
    const storedRequest = deepFreeze({
      ...input.request,
      rootManagerInvocationId: candidateRootManagerInvocationId,
    });
    const requestClaimId = randomUUID();
    const ownershipToken = randomBytes(32).toString('base64url');
    const requestOwnershipTokenHash = ownershipTokenHash(ownershipToken);
    const operationHash = hashCanonicalJson({
      domain: 'emdo.manager-turn-operation.v1',
      kind: 'claim',
      operationId,
      candidateRunId,
      candidateConversationId,
      requestClaimId,
      requestOwnershipTokenHash,
      idempotencyKey: input.idempotencyKey,
      request: storedRequest,
      householdId: input.principal.householdId,
      userId: input.principal.userId,
      sessionId: input.principal.sessionId,
      requestId: input.requestId,
      spaceAccessGrantId: input.principal.spaceAccessGrantId,
      role: input.principal.role,
      managerAgentVersion: this.#options.managerAgentVersion,
      requestedModel: this.#options.requestedModel,
    });
    const principal = principalFor(input);
    const execute = () =>
      withManagerTurnTransaction(this.pool, principal, async (client) => {
        const row = firstResultRow(
          await client.query(
            `select emdo.claim_manager_turn(
               $1::uuid, $2::text, $3::uuid, $4::uuid, $5::uuid,
               $6::text, $7::text, $8::jsonb, $9::uuid, $10::uuid,
               $11::text, $12::text, $13::text
             ) as claim_result`,
            [
              operationId,
              operationHash,
              candidateRunId,
              candidateConversationId,
              requestClaimId,
              requestOwnershipTokenHash,
              input.idempotencyKey,
              storedRequest,
              input.principal.householdId,
              input.principal.spaceAccessGrantId,
              input.principal.role,
              this.#options.managerAgentVersion,
              this.#options.requestedModel,
            ],
          ),
        );
        return parseFunctionResult(StoredClaimResultSchema, row?.claim_result);
      });

    let stored: z.infer<typeof StoredClaimResultSchema>;
    try {
      stored = await execute();
    } catch (error) {
      if (!(error instanceof AmbiguousManagerTurnCommitError)) {
        return databaseUnavailable();
      }
      try {
        stored = parseFunctionResult(
          StoredClaimResultSchema,
          await this.#readOperation({
            operationId,
            operationHash,
            requestClaimId,
            requestOwnershipTokenHash,
            principal,
          }),
        );
      } catch {
        return databaseUnavailable();
      }
    }
    if (stored.status === 'conflict') {
      throw new ManagerTurnPersistenceError(
        'idempotency-conflict',
        'The manager turn idempotency key is already bound differently',
      );
    }
    if (stored.status === 'replay') return deepFreeze(stored);
    if (
      stored.claimId !== requestClaimId ||
      stored.rootManagerInvocationId !== candidateRootManagerInvocationId
    ) {
      throw new ManagerTurnPersistenceError(
        'invalid-result',
        'The manager turn claim identity did not match the request',
      );
    }
    return deepFreeze({ ...stored, ownershipToken });
  }

  async complete(rawInput: {
    readonly claimId: string;
    readonly ownershipToken: string;
    readonly runId: string;
    readonly result: unknown;
  }): Promise<PostgresManagerTurnCompletion> {
    const input = CompleteInputSchema.parse(rawInput);
    if (
      input.result === null ||
      Array.isArray(input.result) ||
      typeof input.result !== 'object' ||
      input.result.runId !== input.runId
    ) {
      throw new ManagerTurnPersistenceError(
        'invalid-input',
        'Manager turn result belongs to a different run',
      );
    }
    const result = input.result as JsonValue;
    if (Buffer.byteLength(canonicalJson(result), 'utf8') > 1_400_000) {
      throw new ManagerTurnPersistenceError(
        'invalid-input',
        'Manager turn result is too large to persist safely',
      );
    }
    const operationId = randomUUID();
    const tokenHash = ownershipTokenHash(input.ownershipToken);
    const resultHash = hashCanonicalJson(result);
    const operationHash = hashCanonicalJson({
      domain: 'emdo.manager-turn-operation.v1',
      kind: 'complete',
      operationId,
      claimId: input.claimId,
      ownershipTokenHash: tokenHash,
      runId: input.runId,
      resultHash,
    });
    const execute = () =>
      withManagerTurnTransaction(this.pool, undefined, async (client) => {
        const row = firstResultRow(
          await client.query(
            `select emdo.complete_manager_turn(
               $1::uuid, $2::text, $3::uuid, $4::text, $5::uuid, $6::jsonb
             ) as completion_result`,
            [
              operationId,
              operationHash,
              input.claimId,
              tokenHash,
              input.runId,
              result,
            ],
          ),
        );
        return parseFunctionResult(
          CompletionResultSchema,
          row?.completion_result,
        );
      });
    try {
      return await execute();
    } catch (error) {
      if (!(error instanceof AmbiguousManagerTurnCommitError)) {
        return databaseUnavailable();
      }
      try {
        return parseFunctionResult(
          CompletionResultSchema,
          await this.#readOperation({
            operationId,
            operationHash,
            requestClaimId: input.claimId,
            requestOwnershipTokenHash: tokenHash,
          }),
        );
      } catch {
        return databaseUnavailable();
      }
    }
  }

  async markIndeterminate(rawInput: {
    readonly claimId: string;
    readonly ownershipToken: string;
    readonly runId: string;
    readonly reasonCode: 'agent-runtime-failed';
  }): Promise<PostgresManagerTurnIndeterminate> {
    const input = IndeterminateInputSchema.parse(rawInput);
    const operationId = randomUUID();
    const tokenHash = ownershipTokenHash(input.ownershipToken);
    const operationHash = hashCanonicalJson({
      domain: 'emdo.manager-turn-operation.v1',
      kind: 'indeterminate',
      operationId,
      claimId: input.claimId,
      ownershipTokenHash: tokenHash,
      runId: input.runId,
      reasonCode: input.reasonCode,
    });
    const execute = () =>
      withManagerTurnTransaction(this.pool, undefined, async (client) => {
        const row = firstResultRow(
          await client.query(
            `select emdo.mark_manager_turn_indeterminate(
               $1::uuid, $2::text, $3::uuid, $4::text, $5::uuid, $6::text
             ) as indeterminate_result`,
            [
              operationId,
              operationHash,
              input.claimId,
              tokenHash,
              input.runId,
              input.reasonCode,
            ],
          ),
        );
        return parseFunctionResult(
          IndeterminateResultSchema,
          row?.indeterminate_result,
        );
      });
    try {
      return await execute();
    } catch (error) {
      if (!(error instanceof AmbiguousManagerTurnCommitError)) {
        return databaseUnavailable();
      }
      try {
        return parseFunctionResult(
          IndeterminateResultSchema,
          await this.#readOperation({
            operationId,
            operationHash,
            requestClaimId: input.claimId,
            requestOwnershipTokenHash: tokenHash,
          }),
        );
      } catch {
        return databaseUnavailable();
      }
    }
  }

  async check(): Promise<boolean> {
    const client = await this.pool.connect().catch(() => undefined);
    if (client === undefined) return false;
    try {
      const row = firstResultRow(
        await client.query('select emdo.manager_turn_store_ready() as ready'),
      );
      return row?.ready === true;
    } catch {
      return false;
    } finally {
      client.release(false);
    }
  }

  async #readOperation(input: {
    readonly operationId: string;
    readonly operationHash: string;
    readonly requestClaimId: string;
    readonly requestOwnershipTokenHash: string;
    readonly principal?: Readonly<DurableRepositoryPrincipal>;
  }): Promise<unknown> {
    Sha256Schema.parse(input.operationHash);
    Sha256Schema.parse(input.requestOwnershipTokenHash);
    return withManagerTurnTransaction(
      this.pool,
      input.principal,
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `select emdo.read_manager_turn_operation(
               $1::uuid, $2::text, $3::uuid, $4::text
             ) as readback_result`,
            [
              input.operationId,
              input.operationHash,
              input.requestClaimId,
              input.requestOwnershipTokenHash,
            ],
          ),
        );
        return row?.readback_result;
      },
    );
  }
}

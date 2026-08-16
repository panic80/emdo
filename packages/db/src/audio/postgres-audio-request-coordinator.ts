import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  IdempotencyKeySchema,
  OpaqueReferenceSchema,
  Sha256Schema,
  UuidSchema,
  deepFreeze,
} from '@emdo/contracts';
import { z } from 'zod';

import {
  beginDurableTransaction,
  firstResultRow,
  type DurableRepositoryPrincipal,
} from '../durable/scoped-transaction.js';
import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';

const OwnershipTokenSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/u);
const AudioModelSchema = z.enum([
  'gpt-4o-mini-transcribe',
  'gpt-4o-transcribe',
  'tts-1',
  'tts-1-hd',
  'gpt-4o-mini-tts',
  'gpt-4o-mini-tts-2025-12-15',
]);
const TranscriptionModelSchema = z.enum([
  'gpt-4o-mini-transcribe',
  'gpt-4o-transcribe',
]);
const SpeechModelSchema = z.enum([
  'tts-1',
  'tts-1-hd',
  'gpt-4o-mini-tts',
  'gpt-4o-mini-tts-2025-12-15',
]);
const ContentTypeSchema = z.enum(['audio/mpeg', 'audio/wav', 'audio/ogg']);
const AudioPrincipalSchema = z.object({
  userId: UuidSchema,
  sessionId: UuidSchema,
  householdId: UuidSchema,
  role: z.enum(['owner', 'member']),
  emailVerified: z.literal(true),
  spaceAccessGrantId: UuidSchema,
});
const ClaimInputSchema = z.strictObject({
  kind: z.enum(['transcription', 'speech']),
  model: AudioModelSchema,
  inputUnits: z.number().int().positive().safe().max(26_214_400),
  requestFingerprint: Sha256Schema,
  principal: AudioPrincipalSchema,
  requestId: UuidSchema,
  idempotencyKey: IdempotencyKeySchema,
});
const MutationIdentitySchema = z.strictObject({
  claimId: UuidSchema,
  ownershipToken: OwnershipTokenSchema,
  principal: AudioPrincipalSchema,
  requestId: UuidSchema,
});
const CompleteTranscriptionInputSchema = MutationIdentitySchema.extend({
  transcript: z.string().min(1).max(50_000),
  model: TranscriptionModelSchema,
  spendWarning: z.boolean(),
});
const CompleteSpeechInputSchema = MutationIdentitySchema.extend({
  model: SpeechModelSchema,
  contentType: ContentTypeSchema,
});
const KnownNoDispatchReasonSchema = z.enum([
  'transcription-provider-not-dispatched',
  'speech-provider-not-dispatched',
]);
const IndeterminateReasonSchema = z.enum([
  'transcription-provider-state-unknown',
  'speech-provider-state-unknown',
  'transcription-settlement-state-unknown',
  'speech-settlement-state-unknown',
]);
const StoredIndeterminateReasonSchema = z.enum([
  'claim-lease-expired',
  ...IndeterminateReasonSchema.options,
]);
const ReleaseInputSchema = MutationIdentitySchema.extend({
  reasonCode: KnownNoDispatchReasonSchema,
});
const IndeterminateInputSchema = MutationIdentitySchema.extend({
  reasonCode: IndeterminateReasonSchema,
});

const ReplayResultSchema = z.strictObject({
  kind: z.literal('transcription'),
  transcript: z.string().min(1).max(50_000),
  model: TranscriptionModelSchema,
  spendWarning: z.boolean(),
});
const StoredClaimResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('claimed'),
    claimId: UuidSchema,
    executionId: OpaqueReferenceSchema,
    reservationId: OpaqueReferenceSchema,
  }),
  z.strictObject({
    status: z.literal('replay'),
    result: ReplayResultSchema,
  }),
  z.strictObject({
    status: z.literal('in-progress'),
    retryAfterMs: z.number().int().min(100).max(60_000),
  }),
  z.strictObject({ status: z.literal('completed-nonreplayable') }),
  z.strictObject({ status: z.literal('indeterminate') }),
  z.strictObject({ status: z.literal('conflict') }),
]);
const SettlementResultSchema = z.strictObject({
  status: z.enum([
    'completed',
    'released',
    'indeterminate',
    'exact-replay',
    'denied',
  ]),
});

export interface AudioRequestPrincipal {
  readonly userId: string;
  readonly sessionId: string;
  readonly householdId: string;
  readonly role: 'owner' | 'member';
  readonly emailVerified: true;
  readonly spaceAccessGrantId: string;
}

export type AudioRequestClaim = Readonly<
  | {
      status: 'claimed';
      claimId: string;
      ownershipToken: string;
      executionId: string;
      reservationId: string;
    }
  | {
      status: 'replay';
      result: Readonly<z.infer<typeof ReplayResultSchema>>;
    }
  | { status: 'in-progress'; retryAfterMs: number }
  | { status: 'completed-nonreplayable' }
  | { status: 'indeterminate' }
  | { status: 'conflict' }
>;

export type AudioKnownNoDispatchReason = z.infer<
  typeof KnownNoDispatchReasonSchema
>;
export type AudioIndeterminateReason = z.infer<
  typeof IndeterminateReasonSchema
>;

export class AudioRequestCoordinatorError extends Error {
  constructor(
    readonly code:
      | 'invalid-input'
      | 'invalid-result'
      | 'stale-ownership'
      | 'database-unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'AudioRequestCoordinatorError';
  }
}

const tokenHash = (token: string) =>
  createHash('sha256').update(token, 'utf8').digest('hex');

const operationHash = (parts: readonly (boolean | number | string)[]) => {
  const canonical = parts
    .map((part) => String(part))
    .map((part) => `${Buffer.byteLength(part, 'utf8')}:${part}`)
    .join('');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
};

const principalFor = (input: {
  readonly principal: AudioRequestPrincipal;
  readonly requestId: string;
}): Readonly<DurableRepositoryPrincipal> =>
  deepFreeze({
    userId: input.principal.userId,
    sessionId: input.principal.sessionId,
    requestId: input.requestId,
    householdId: input.principal.householdId,
  });

const parseFunctionResult = <Output>(
  row: Record<string, unknown> | undefined,
  property: string,
  schema: z.ZodType<Output>,
): Output => {
  const parsed = schema.safeParse(row?.[property]);
  if (!parsed.success) {
    throw new AudioRequestCoordinatorError(
      'invalid-result',
      'The audio receipt command returned an invalid result',
    );
  }
  return parsed.data;
};

const rethrowDatabaseFailure = (): never => {
  throw new AudioRequestCoordinatorError(
    'database-unavailable',
    'The durable audio receipt command could not be verified',
  );
};

class AmbiguousAudioCommitError extends Error {
  constructor() {
    super('Audio receipt commit acknowledgement was lost');
    this.name = 'AmbiguousAudioCommitError';
  }
}

const rollbackQuietly = async (client: DatabaseClient) => {
  try {
    await client.query('rollback');
  } catch {
    // The original failure remains authoritative.
  }
};

/**
 * Uses a dedicated session so an ambiguous COMMIT can be destroyed rather
 * than returned to the pool. Exact operation readback runs on a fresh session.
 */
const withAudioTransaction = async <Result>(
  pool: DatabasePool,
  principal: Readonly<DurableRepositoryPrincipal>,
  work: (client: DatabaseClient) => Promise<Result>,
): Promise<Result> => {
  const client = await beginDurableTransaction(pool, principal);
  let released = false;
  try {
    const result = await work(client);
    try {
      await client.query('commit');
    } catch {
      released = true;
      client.release(true);
      throw new AmbiguousAudioCommitError();
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

const withAudioOperatorTransaction = async <Result>(
  pool: DatabasePool,
  work: (client: DatabaseClient) => Promise<Result>,
): Promise<Result> => {
  const client = await pool.connect();
  let released = false;
  try {
    await client.query('begin');
    await client.query('set local row_security = on');
    await client.query("set local statement_timeout = '30s'");
    await client.query("set local lock_timeout = '5s'");
    const result = await work(client);
    try {
      await client.query('commit');
    } catch {
      released = true;
      client.release(true);
      throw new AmbiguousAudioCommitError();
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

export class PostgresAudioRequestCoordinator {
  readonly #leaseDurationMs: number;

  constructor(
    private readonly pool: DatabasePool,
    options: { readonly leaseDurationMs?: number } = {},
  ) {
    this.#leaseDurationMs = z
      .number()
      .int()
      .min(30_000)
      .max(300_000)
      .parse(options.leaseDurationMs ?? 120_000);
  }

  async claim(input: {
    readonly kind: 'transcription' | 'speech';
    readonly model: string;
    readonly inputUnits: number;
    readonly requestFingerprint: string;
    readonly principal: AudioRequestPrincipal;
    readonly requestId: string;
    readonly idempotencyKey: string;
  }): Promise<AudioRequestClaim> {
    const parsed = ClaimInputSchema.parse(input);
    if (
      (parsed.kind === 'transcription' &&
        !TranscriptionModelSchema.safeParse(parsed.model).success) ||
      (parsed.kind === 'speech' &&
        !SpeechModelSchema.safeParse(parsed.model).success)
    ) {
      throw new AudioRequestCoordinatorError(
        'invalid-input',
        'The audio kind and model do not match',
      );
    }
    const ownershipToken = randomBytes(32).toString('base64url');
    const ownershipTokenHash = tokenHash(ownershipToken);
    const operationId = randomUUID();
    const claimId = randomUUID();
    const executionId = randomUUID();
    const reservationId = randomUUID();
    const exactOperationHash = operationHash([
      'claim',
      claimId,
      executionId,
      reservationId,
      parsed.principal.householdId,
      parsed.principal.userId,
      parsed.principal.sessionId,
      parsed.requestId,
      parsed.principal.spaceAccessGrantId,
      parsed.principal.role,
      parsed.idempotencyKey,
      parsed.kind,
      parsed.model,
      parsed.inputUnits,
      parsed.requestFingerprint,
      ownershipTokenHash,
      this.#leaseDurationMs,
    ]);
    const execute = async () =>
      withAudioTransaction(this.pool, principalFor(parsed), async (client) => {
        const row = firstResultRow(
          await client.query(
            `select emdo.claim_audio_request(
                 $1, $2, $3, $4, $5, $6, $7, $8,
                 $9, $10, $11, $12, $13, $14, $15
               ) as claim_result`,
            [
              operationId,
              exactOperationHash,
              claimId,
              executionId,
              reservationId,
              parsed.idempotencyKey,
              parsed.kind,
              parsed.model,
              parsed.inputUnits,
              parsed.requestFingerprint,
              ownershipTokenHash,
              this.#leaseDurationMs,
              parsed.principal.householdId,
              parsed.principal.spaceAccessGrantId,
              parsed.principal.role,
            ],
          ),
        );
        return parseFunctionResult(
          row,
          'claim_result',
          StoredClaimResultSchema,
        );
      });

    let stored: z.infer<typeof StoredClaimResultSchema>;
    try {
      stored = await execute();
    } catch (error) {
      if (!(error instanceof AmbiguousAudioCommitError)) {
        return rethrowDatabaseFailure();
      }
      try {
        stored = await this.#readClaimOperation({
          operationId,
          operationHash: exactOperationHash,
          claimId,
          ownershipTokenHash,
          idempotencyKey: parsed.idempotencyKey,
          kind: parsed.kind,
          model: parsed.model,
          inputUnits: parsed.inputUnits,
          requestFingerprint: parsed.requestFingerprint,
          principal: parsed.principal,
          requestId: parsed.requestId,
        });
      } catch {
        return rethrowDatabaseFailure();
      }
    }
    if (stored.status !== 'claimed') return deepFreeze(stored);
    return deepFreeze({ ...stored, ownershipToken });
  }

  async completeTranscription(input: {
    readonly claimId: string;
    readonly ownershipToken: string;
    readonly transcript: string;
    readonly model: 'gpt-4o-mini-transcribe' | 'gpt-4o-transcribe';
    readonly spendWarning: boolean;
    readonly principal: AudioRequestPrincipal;
    readonly requestId: string;
  }): Promise<void> {
    const parsed = CompleteTranscriptionInputSchema.parse(input);
    const operationId = randomUUID();
    const ownershipTokenHash = tokenHash(parsed.ownershipToken);
    const exactOperationHash = operationHash([
      'transcription-complete',
      parsed.claimId,
      ownershipTokenHash,
      parsed.transcript,
      parsed.model,
      parsed.spendWarning,
      parsed.principal.householdId,
      parsed.principal.userId,
      parsed.principal.sessionId,
      parsed.requestId,
      parsed.principal.spaceAccessGrantId,
      parsed.principal.role,
    ]);
    await this.#settle(
      parsed,
      `select emdo.complete_audio_transcription(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
       ) as settlement_result`,
      [
        operationId,
        exactOperationHash,
        parsed.claimId,
        ownershipTokenHash,
        parsed.transcript,
        parsed.model,
        parsed.spendWarning,
        parsed.principal.householdId,
        parsed.principal.spaceAccessGrantId,
        parsed.principal.role,
      ],
      new Set(['completed', 'exact-replay']),
      {
        operationId,
        operationHash: exactOperationHash,
        operationKind: 'transcription-complete',
      },
    );
  }

  async completeSpeech(input: {
    readonly claimId: string;
    readonly ownershipToken: string;
    readonly model:
      'tts-1' | 'tts-1-hd' | 'gpt-4o-mini-tts' | 'gpt-4o-mini-tts-2025-12-15';
    readonly contentType: 'audio/mpeg' | 'audio/wav' | 'audio/ogg';
    readonly principal: AudioRequestPrincipal;
    readonly requestId: string;
  }): Promise<void> {
    const parsed = CompleteSpeechInputSchema.parse(input);
    const operationId = randomUUID();
    const ownershipTokenHash = tokenHash(parsed.ownershipToken);
    const exactOperationHash = operationHash([
      'speech-complete',
      parsed.claimId,
      ownershipTokenHash,
      parsed.model,
      parsed.contentType,
      parsed.principal.householdId,
      parsed.principal.userId,
      parsed.principal.sessionId,
      parsed.requestId,
      parsed.principal.spaceAccessGrantId,
      parsed.principal.role,
    ]);
    await this.#settle(
      parsed,
      `select emdo.complete_audio_speech(
         $1, $2, $3, $4, $5, $6, $7, $8, $9
       ) as settlement_result`,
      [
        operationId,
        exactOperationHash,
        parsed.claimId,
        ownershipTokenHash,
        parsed.model,
        parsed.contentType,
        parsed.principal.householdId,
        parsed.principal.spaceAccessGrantId,
        parsed.principal.role,
      ],
      new Set(['completed', 'exact-replay']),
      {
        operationId,
        operationHash: exactOperationHash,
        operationKind: 'speech-complete',
      },
    );
  }

  async releaseKnownNoDispatch(input: {
    readonly claimId: string;
    readonly ownershipToken: string;
    readonly reasonCode: AudioKnownNoDispatchReason;
    readonly principal: AudioRequestPrincipal;
    readonly requestId: string;
  }): Promise<void> {
    const parsed = ReleaseInputSchema.parse(input);
    const operationId = randomUUID();
    const ownershipTokenHash = tokenHash(parsed.ownershipToken);
    const exactOperationHash = operationHash([
      'release',
      parsed.claimId,
      ownershipTokenHash,
      parsed.reasonCode,
      parsed.principal.householdId,
      parsed.principal.userId,
      parsed.principal.sessionId,
      parsed.requestId,
      parsed.principal.spaceAccessGrantId,
      parsed.principal.role,
    ]);
    await this.#settle(
      parsed,
      `select emdo.release_audio_request_claim(
         $1, $2, $3, $4, $5, $6, $7, $8
       ) as settlement_result`,
      [
        operationId,
        exactOperationHash,
        parsed.claimId,
        ownershipTokenHash,
        parsed.reasonCode,
        parsed.principal.householdId,
        parsed.principal.spaceAccessGrantId,
        parsed.principal.role,
      ],
      new Set(['released', 'exact-replay']),
      {
        operationId,
        operationHash: exactOperationHash,
        operationKind: 'release',
      },
    );
  }

  async markIndeterminate(input: {
    readonly claimId: string;
    readonly ownershipToken: string;
    readonly reasonCode: AudioIndeterminateReason;
    readonly principal: AudioRequestPrincipal;
    readonly requestId: string;
  }): Promise<void> {
    const parsed = IndeterminateInputSchema.parse(input);
    const operationId = randomUUID();
    const ownershipTokenHash = tokenHash(parsed.ownershipToken);
    const exactOperationHash = operationHash([
      'indeterminate',
      parsed.claimId,
      ownershipTokenHash,
      parsed.reasonCode,
      parsed.principal.householdId,
      parsed.principal.userId,
      parsed.principal.sessionId,
      parsed.requestId,
      parsed.principal.spaceAccessGrantId,
      parsed.principal.role,
    ]);
    await this.#settle(
      parsed,
      `select emdo.mark_audio_request_indeterminate(
         $1, $2, $3, $4, $5, $6, $7, $8
       ) as settlement_result`,
      [
        operationId,
        exactOperationHash,
        parsed.claimId,
        ownershipTokenHash,
        parsed.reasonCode,
        parsed.principal.householdId,
        parsed.principal.spaceAccessGrantId,
        parsed.principal.role,
      ],
      new Set(['indeterminate', 'exact-replay']),
      {
        operationId,
        operationHash: exactOperationHash,
        operationKind: 'indeterminate',
      },
    );
  }

  async #settle(
    identity: z.infer<typeof MutationIdentitySchema>,
    sql: string,
    values: readonly unknown[],
    accepted: ReadonlySet<string>,
    operation: Readonly<{
      operationId: string;
      operationHash: string;
      operationKind:
        | 'transcription-complete'
        | 'speech-complete'
        | 'release'
        | 'indeterminate';
    }>,
  ): Promise<void> {
    const execute = async () =>
      withAudioTransaction(
        this.pool,
        principalFor(identity),
        async (client) => {
          const row = firstResultRow(await client.query(sql, values));
          return parseFunctionResult(
            row,
            'settlement_result',
            SettlementResultSchema,
          );
        },
      );

    let result: z.infer<typeof SettlementResultSchema>;
    try {
      result = await execute();
    } catch (error) {
      if (!(error instanceof AmbiguousAudioCommitError)) {
        return rethrowDatabaseFailure();
      }
      try {
        result = await this.#readSettlementOperation({
          ...operation,
          claimId: identity.claimId,
          ownershipTokenHash: tokenHash(identity.ownershipToken),
          principal: identity.principal,
          requestId: identity.requestId,
        });
      } catch {
        return rethrowDatabaseFailure();
      }
    }
    if (!accepted.has(result.status)) {
      throw new AudioRequestCoordinatorError(
        'stale-ownership',
        'The audio receipt ownership token is stale or mismatched',
      );
    }
  }

  async #readClaimOperation(input: {
    readonly operationId: string;
    readonly operationHash: string;
    readonly claimId: string;
    readonly ownershipTokenHash: string;
    readonly idempotencyKey: string;
    readonly kind: 'transcription' | 'speech';
    readonly model: string;
    readonly inputUnits: number;
    readonly requestFingerprint: string;
    readonly principal: AudioRequestPrincipal;
    readonly requestId: string;
  }): Promise<z.infer<typeof StoredClaimResultSchema>> {
    return withAudioTransaction(
      this.pool,
      principalFor(input),
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `select emdo.read_audio_request_claim(
               $1, $2, $3, $4, $5, $6, $7, $8,
               $9, $10, $11, $12
             ) as readback_result`,
            [
              input.operationId,
              input.operationHash,
              input.claimId,
              input.ownershipTokenHash,
              input.idempotencyKey,
              input.kind,
              input.model,
              input.inputUnits,
              input.requestFingerprint,
              input.principal.householdId,
              input.principal.spaceAccessGrantId,
              input.principal.role,
            ],
          ),
        );
        return parseFunctionResult(
          row,
          'readback_result',
          StoredClaimResultSchema,
        );
      },
    );
  }

  async #readSettlementOperation(input: {
    readonly operationId: string;
    readonly operationHash: string;
    readonly operationKind:
      | 'transcription-complete'
      | 'speech-complete'
      | 'release'
      | 'indeterminate';
    readonly claimId: string;
    readonly ownershipTokenHash: string;
    readonly principal: AudioRequestPrincipal;
    readonly requestId: string;
  }): Promise<z.infer<typeof SettlementResultSchema>> {
    return withAudioTransaction(
      this.pool,
      principalFor(input),
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `select emdo.read_audio_request_operation(
               $1, $2, $3, $4, $5, $6, $7, $8
             ) as readback_result`,
            [
              input.operationId,
              input.operationHash,
              input.claimId,
              input.ownershipTokenHash,
              input.operationKind,
              input.principal.householdId,
              input.principal.spaceAccessGrantId,
              input.principal.role,
            ],
          ),
        );
        return parseFunctionResult(
          row,
          'readback_result',
          SettlementResultSchema,
        );
      },
    );
  }

  async checkReady(): Promise<boolean> {
    const client = await this.pool.connect().catch(() => undefined);
    if (client === undefined) return false;
    try {
      const row = firstResultRow(
        await client.query(
          'select emdo.audio_request_receipts_ready() as ready',
        ),
      );
      return row?.ready === true;
    } catch {
      return false;
    } finally {
      client.release();
    }
  }
}

const ReconciliationListInputSchema = z.strictObject({
  limit: z.number().int().min(1).max(1_000).default(100),
});
const ReconciliationRowSchema = z.strictObject({
  receipt_id: UuidSchema,
  kind: z.enum(['transcription', 'speech']),
  model: AudioModelSchema,
  reason_code: StoredIndeterminateReasonSchema,
  version: z
    .union([
      z.number().int().positive().safe(),
      z
        .string()
        .regex(/^[1-9][0-9]*$/u)
        .transform((value) => Number(value)),
    ])
    .pipe(z.number().int().positive().safe()),
  execution_id: UuidSchema,
  reservation_id: UuidSchema,
  marked_at: z.coerce.date(),
});
const ReconciliationResolutionSchema = z.strictObject({
  operationId: UuidSchema.transform((value) => value.toLowerCase()),
  receiptId: UuidSchema.transform((value) => value.toLowerCase()),
  expectedVersion: z.number().int().positive().safe(),
  resolution: z.enum(['confirmed-not-dispatched', 'confirmed-dispatched']),
  operatorReference: z
    .string()
    .trim()
    .min(8)
    .max(200)
    .regex(/^[A-Za-z0-9:._-]+$/u),
});

const operatorOperationHash = (
  input: z.infer<typeof ReconciliationResolutionSchema>,
) =>
  createHash('sha256')
    .update(
      `${input.receiptId}:${input.expectedVersion}:${input.resolution}:${input.operatorReference}`,
      'utf8',
    )
    .digest('hex');

export interface AudioRequestReconciliationItem {
  readonly receiptId: string;
  readonly kind: 'transcription' | 'speech';
  readonly model: z.infer<typeof AudioModelSchema>;
  readonly reasonCode: z.infer<typeof StoredIndeterminateReasonSchema>;
  readonly version: number;
  readonly executionId: string;
  readonly reservationId: string;
  readonly markedAt: string;
}

/**
 * Operator-only companion. Its pool must assume the dedicated reconciliation
 * capability, which has only list, resolve, and exact-readback execution.
 */
export class PostgresAudioRequestReconciliationStore {
  constructor(private readonly operatorPool: DatabasePool) {}

  async listPending(
    input: { readonly limit?: number } = {},
  ): Promise<readonly AudioRequestReconciliationItem[]> {
    const parsed = ReconciliationListInputSchema.parse(input);
    const client = await this.operatorPool.connect();
    try {
      const result = await client.query(
        `select receipt_id, kind, model, reason_code, version,
                execution_id, reservation_id, marked_at
           from emdo.list_audio_request_reconciliation($1)`,
        [parsed.limit],
      );
      return Object.freeze(
        result.rows.map((row) => {
          const item = ReconciliationRowSchema.safeParse(row);
          if (!item.success) {
            throw new AudioRequestCoordinatorError(
              'invalid-result',
              'The audio reconciliation command returned an invalid row',
            );
          }
          return deepFreeze({
            receiptId: item.data.receipt_id,
            kind: item.data.kind,
            model: item.data.model,
            reasonCode: item.data.reason_code,
            version: item.data.version,
            executionId: item.data.execution_id,
            reservationId: item.data.reservation_id,
            markedAt: item.data.marked_at.toISOString(),
          });
        }),
      );
    } finally {
      client.release();
    }
  }

  async resolve(input: {
    readonly operationId: string;
    readonly receiptId: string;
    readonly expectedVersion: number;
    readonly resolution: 'confirmed-not-dispatched' | 'confirmed-dispatched';
    readonly operatorReference: string;
  }): Promise<'resolved' | 'conflict'> {
    const parsed = ReconciliationResolutionSchema.parse(input);
    const exactOperationHash = operatorOperationHash(parsed);
    const parseResolution = (row: Record<string, unknown> | undefined) => {
      if (
        row?.resolution_result !== 'resolved' &&
        row?.resolution_result !== 'conflict'
      ) {
        throw new AudioRequestCoordinatorError(
          'invalid-result',
          'The audio reconciliation command returned an invalid result',
        );
      }
      return row.resolution_result;
    };
    const execute = async () =>
      withAudioOperatorTransaction(this.operatorPool, async (client) => {
        const row = firstResultRow(
          await client.query(
            `select emdo.resolve_audio_request_reconciliation(
               $1, $2, $3, $4, $5, $6
             ) as resolution_result`,
            [
              parsed.operationId,
              exactOperationHash,
              parsed.receiptId,
              parsed.expectedVersion,
              parsed.resolution,
              parsed.operatorReference,
            ],
          ),
        );
        return parseResolution(row);
      });
    try {
      return await execute();
    } catch (error) {
      if (!(error instanceof AmbiguousAudioCommitError)) {
        return rethrowDatabaseFailure();
      }
      try {
        return await withAudioOperatorTransaction(
          this.operatorPool,
          async (client) => {
            const row = firstResultRow(
              await client.query(
                `select emdo.read_audio_request_reconciliation_operation(
                   $1, $2, $3, $4, $5, $6
                 ) as resolution_result`,
                [
                  parsed.operationId,
                  exactOperationHash,
                  parsed.receiptId,
                  parsed.expectedVersion,
                  parsed.resolution,
                  parsed.operatorReference,
                ],
              ),
            );
            return parseResolution(row);
          },
        );
      } catch {
        return rethrowDatabaseFailure();
      }
    }
  }

  async checkReady(): Promise<boolean> {
    const client = await this.operatorPool.connect().catch(() => undefined);
    if (client === undefined) return false;
    try {
      const row = firstResultRow(
        await client.query(
          'select emdo.audio_request_reconciliation_ready() as ready',
        ),
      );
      return row?.ready === true;
    } catch {
      return false;
    } finally {
      client.release();
    }
  }
}

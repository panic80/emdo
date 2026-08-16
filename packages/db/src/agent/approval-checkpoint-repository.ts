import { UuidSchema, deepFreeze } from '@emdo/contracts';
import { z } from 'zod';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import {
  DurableRepositoryError,
  firstResultRow,
  lockDurableScope,
  parseDurablePrincipal,
  withClaimedTransaction,
  type DurableRepositoryPrincipal,
} from '../durable/scoped-transaction.js';

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const SemverSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
const IsoDateSchema = z.iso.datetime({ offset: true });
const CheckpointStateSchema = z.enum([
  'pending',
  'resumed',
  'cancelled',
  'expired',
]);

const IdentitySchema = z.strictObject({
  checkpointId: UuidSchema,
  householdId: UuidSchema,
  userId: UuidSchema,
  runId: UuidSchema,
  agentGraphHash: HashSchema,
  sdkVersion: SemverSchema,
});

const StoredCheckpointSchema = IdentitySchema.extend({
  formatVersion: z.literal(1),
  revision: z.number().int().positive().safe(),
  state: CheckpointStateSchema,
  createdAt: IsoDateSchema,
  expiresAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  sealedState: z.string().min(1).max(1_400_000),
}).superRefine((value, context) => {
  const created = Date.parse(value.createdAt);
  const expires = Date.parse(value.expiresAt);
  if (expires <= created || expires > created + 10 * 60 * 1000) {
    context.addIssue({
      code: 'custom',
      path: ['expiresAt'],
      message: 'Checkpoint lifetime is invalid',
    });
  }
  if (value.revision !== 1 || value.state !== 'pending') {
    context.addIssue({
      code: 'custom',
      path: ['state'],
      message: 'New checkpoint must be pending at revision one',
    });
  }
  if (value.updatedAt !== value.createdAt) {
    context.addIssue({
      code: 'custom',
      path: ['updatedAt'],
      message: 'New checkpoint timestamps must match',
    });
  }
});

export interface PostgresApprovalCheckpointIdentity {
  readonly checkpointId: string;
  readonly householdId: string;
  readonly userId: string;
  readonly runId: string;
  readonly agentGraphHash: string;
  readonly sdkVersion: string;
}

export interface PostgresStoredApprovalCheckpoint extends PostgresApprovalCheckpointIdentity {
  readonly formatVersion: 1;
  readonly revision: number;
  readonly state: 'pending' | 'resumed' | 'cancelled' | 'expired';
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly updatedAt: string;
  readonly sealedState: string;
}

export type PostgresApprovalCheckpointConsumeResult =
  | {
      readonly status: 'consumed';
      readonly record: PostgresStoredApprovalCheckpoint;
    }
  | {
      readonly status:
        | 'already-consumed'
        | 'expired'
        | 'mismatch'
        | 'not-found'
        | 'clock-invalid';
    };

const checkpointColumns = `checkpoint_id, household_id, user_id, run_id,
  format_version, revision, state, agent_graph_hash, sdk_version, sealed_state,
  created_at, expires_at, updated_at`;

const isoFromDb = (value: unknown): string => {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new DurableRepositoryError(
      'invalid-result',
      'Database returned an invalid checkpoint timestamp',
    );
  }
  return date.toISOString();
};

const parseCheckpointRow = (
  row: Record<string, unknown>,
): PostgresStoredApprovalCheckpoint => {
  const parsed = z
    .strictObject({
      checkpointId: UuidSchema,
      householdId: UuidSchema,
      userId: UuidSchema,
      runId: UuidSchema,
      formatVersion: z.literal(1),
      revision: z.number().int().positive().safe(),
      state: CheckpointStateSchema,
      agentGraphHash: HashSchema,
      sdkVersion: SemverSchema,
      sealedState: z.string().min(1).max(1_400_000),
      createdAt: IsoDateSchema,
      expiresAt: IsoDateSchema,
      updatedAt: IsoDateSchema,
    })
    .safeParse({
      checkpointId: row.checkpoint_id,
      householdId: row.household_id,
      userId: row.user_id,
      runId: row.run_id,
      formatVersion: row.format_version,
      revision: row.revision,
      state: row.state,
      agentGraphHash: row.agent_graph_hash,
      sdkVersion: row.sdk_version,
      sealedState: row.sealed_state,
      createdAt: isoFromDb(row.created_at),
      expiresAt: isoFromDb(row.expires_at),
      updatedAt: isoFromDb(row.updated_at),
    });
  if (!parsed.success) {
    throw new DurableRepositoryError(
      'invalid-result',
      'Database returned a malformed approval checkpoint',
    );
  }
  return deepFreeze(parsed.data);
};

const identitiesMatch = (
  record: PostgresApprovalCheckpointIdentity,
  identity: PostgresApprovalCheckpointIdentity,
) =>
  record.checkpointId === identity.checkpointId &&
  record.householdId === identity.householdId &&
  record.userId === identity.userId &&
  record.runId === identity.runId &&
  record.agentGraphHash === identity.agentGraphHash &&
  record.sdkVersion === identity.sdkVersion;

const databaseNow = async (client: DatabaseClient): Promise<Date> => {
  const row = firstResultRow(
    await client.query('select pg_catalog.clock_timestamp() as now'),
  );
  const now = row?.now instanceof Date ? row.now : new Date(String(row?.now));
  if (!Number.isFinite(now.getTime())) {
    throw new DurableRepositoryError(
      'invalid-result',
      'Database clock returned an invalid timestamp',
    );
  }
  return now;
};

export class PostgresApprovalCheckpointRepository {
  readonly #principal: Readonly<DurableRepositoryPrincipal>;

  constructor(
    private readonly pool: DatabasePool,
    principal: DurableRepositoryPrincipal,
  ) {
    this.#principal = parseDurablePrincipal(principal);
  }

  async create(
    recordInput: PostgresStoredApprovalCheckpoint,
  ): Promise<'created' | 'already-exists' | 'expired' | 'clock-invalid'> {
    const record = StoredCheckpointSchema.parse(recordInput);
    if (
      record.householdId !== this.#principal.householdId ||
      record.userId !== this.#principal.userId
    ) {
      return 'already-exists';
    }
    return withClaimedTransaction(
      this.pool,
      this.#principal,
      async (client) => {
        const run = firstResultRow(
          await client.query(
            `select space_id
               from emdo.agent_runs
              where id = $1 and household_id = $2
                and original_owner_user_id = $3`,
            [record.runId, record.householdId, record.userId],
          ),
        );
        if (typeof run?.space_id !== 'string') return 'already-exists';
        await lockDurableScope(client, {
          householdId: record.householdId,
          spaceId: run.space_id,
        });
        const now = await databaseNow(client);
        if (now.getTime() < Date.parse(record.createdAt)) {
          return 'clock-invalid';
        }
        if (now.getTime() >= Date.parse(record.expiresAt)) return 'expired';

        const inserted = firstResultRow(
          await client.query(
            `insert into emdo.approval_checkpoints
               (checkpoint_id, household_id, space_id, user_id, run_id,
                format_version, revision, state, agent_graph_hash, sdk_version,
                sealed_state, created_at, expires_at, updated_at, retain_until)
             values ($1, $2, $3, $4, $5, 1, 1, 'pending', $6, $7, $8,
                     $9, $10, $9, $9::timestamptz + interval '90 days')
             on conflict (checkpoint_id) do nothing
             returning checkpoint_id`,
            [
              record.checkpointId,
              record.householdId,
              run.space_id,
              record.userId,
              record.runId,
              record.agentGraphHash,
              record.sdkVersion,
              record.sealedState,
              record.createdAt,
              record.expiresAt,
            ],
          ),
        );
        return inserted === undefined ? 'already-exists' : 'created';
      },
    );
  }

  async get(
    checkpointIdInput: string,
  ): Promise<PostgresStoredApprovalCheckpoint | undefined> {
    const checkpointId = UuidSchema.parse(checkpointIdInput);
    return withClaimedTransaction(
      this.pool,
      this.#principal,
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `select ${checkpointColumns}
               from emdo.approval_checkpoints
              where checkpoint_id = $1`,
            [checkpointId],
          ),
        );
        return row === undefined ? undefined : parseCheckpointRow(row);
      },
    );
  }

  async consume(input: {
    readonly checkpointId: string;
    readonly expectedRevision: number;
    readonly identity: PostgresApprovalCheckpointIdentity;
  }): Promise<PostgresApprovalCheckpointConsumeResult> {
    const parsed = z
      .strictObject({
        checkpointId: UuidSchema,
        expectedRevision: z.number().int().positive().safe(),
        identity: IdentitySchema,
      })
      .parse(input);
    if (parsed.checkpointId !== parsed.identity.checkpointId) {
      return { status: 'mismatch' };
    }
    return withClaimedTransaction(
      this.pool,
      this.#principal,
      async (client) => {
        const row = await this.#loadForUpdate(client, parsed.checkpointId);
        if (row === undefined) return { status: 'not-found' } as const;
        await lockDurableScope(client, {
          householdId: row.householdId,
          spaceId: await this.#spaceForCheckpoint(client, row.checkpointId),
        });
        if (!identitiesMatch(row, parsed.identity)) {
          return { status: 'mismatch' } as const;
        }
        if (row.state !== 'pending') {
          return { status: 'already-consumed' } as const;
        }
        if (row.revision !== parsed.expectedRevision) {
          return { status: 'mismatch' } as const;
        }
        const now = await databaseNow(client);
        if (now.getTime() < Date.parse(row.createdAt)) {
          return { status: 'clock-invalid' } as const;
        }
        const expired = now.getTime() >= Date.parse(row.expiresAt);
        const updated = await this.#updateState(
          client,
          row.checkpointId,
          row.revision,
          expired ? 'expired' : 'resumed',
        );
        return expired
          ? ({ status: 'expired' } as const)
          : ({ status: 'consumed', record: updated } as const);
      },
    );
  }

  async cancel(input: {
    readonly checkpointId: string;
    readonly householdId: string;
    readonly userId: string;
  }): Promise<
    | PostgresStoredApprovalCheckpoint
    | 'clock-invalid'
    | 'mismatch'
    | 'not-found'
  > {
    const parsed = z
      .strictObject({
        checkpointId: UuidSchema,
        householdId: UuidSchema,
        userId: UuidSchema,
      })
      .parse(input);
    return withClaimedTransaction(
      this.pool,
      this.#principal,
      async (client) => {
        const row = await this.#loadForUpdate(client, parsed.checkpointId);
        if (row === undefined) return 'not-found' as const;
        await lockDurableScope(client, {
          householdId: row.householdId,
          spaceId: await this.#spaceForCheckpoint(client, row.checkpointId),
        });
        if (
          row.householdId !== parsed.householdId ||
          row.userId !== parsed.userId
        ) {
          return 'mismatch' as const;
        }
        if (row.state === 'cancelled' || row.state === 'expired') return row;
        if (row.state !== 'pending') return 'mismatch' as const;
        const now = await databaseNow(client);
        if (now.getTime() < Date.parse(row.createdAt)) {
          return 'clock-invalid' as const;
        }
        return this.#updateState(
          client,
          row.checkpointId,
          row.revision,
          now.getTime() >= Date.parse(row.expiresAt) ? 'expired' : 'cancelled',
        );
      },
    );
  }

  async #loadForUpdate(client: DatabaseClient, checkpointId: string) {
    const row = firstResultRow(
      await client.query(
        `select ${checkpointColumns}
           from emdo.approval_checkpoints
          where checkpoint_id = $1
          for update`,
        [checkpointId],
      ),
    );
    return row === undefined ? undefined : parseCheckpointRow(row);
  }

  async #spaceForCheckpoint(client: DatabaseClient, checkpointId: string) {
    const row = firstResultRow(
      await client.query(
        `select space_id from emdo.approval_checkpoints
          where checkpoint_id = $1`,
        [checkpointId],
      ),
    );
    if (typeof row?.space_id !== 'string') {
      throw new DurableRepositoryError(
        'authorization-revoked',
        'Approval checkpoint scope is unavailable',
      );
    }
    return row.space_id;
  }

  async #updateState(
    client: DatabaseClient,
    checkpointId: string,
    revision: number,
    state: 'resumed' | 'cancelled' | 'expired',
  ) {
    const row = firstResultRow(
      await client.query(
        `update emdo.approval_checkpoints
            set state = $3, revision = revision + 1,
                updated_at = pg_catalog.clock_timestamp()
          where checkpoint_id = $1 and revision = $2 and state = 'pending'
          returning ${checkpointColumns}`,
        [checkpointId, revision, state],
      ),
    );
    if (row === undefined) {
      throw new DurableRepositoryError(
        'conflict',
        'Approval checkpoint compare-and-set failed',
      );
    }
    return parseCheckpointRow(row);
  }
}

import {
  IdentifierSchema,
  JsonValueSchema,
  UuidSchema,
  deepFreeze,
  type DeepReadonly,
  type JsonValue,
} from '@emdo/contracts';
import { z } from 'zod';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import {
  DurableRepositoryError,
  firstResultRow,
  lockDurableScope,
  parseDurablePrincipal,
  withClaimedTransaction,
  withDurableTransaction,
  type DurableRepositoryPrincipal,
} from '../durable/scoped-transaction.js';

const RunCreateSchema = z.strictObject({
  runId: UuidSchema,
  spaceId: UuidSchema,
  parentRunId: UuidSchema.nullable().optional(),
  agentId: IdentifierSchema,
  agentVersion: z.string().trim().min(1).max(100),
  requestedModel: z.string().trim().min(1).max(100),
});

const RunEventAppendSchema = z.strictObject({
  runId: UuidSchema,
  sequence: z.number().int().positive().safe(),
  eventType: IdentifierSchema,
  payload: JsonValueSchema,
});

const ConversationEventAppendSchema = z.strictObject({
  spaceId: UuidSchema,
  conversationId: UuidSchema,
  clientEventId: z.string().trim().min(1).max(200),
  sequence: z.number().int().positive().safe(),
  eventType: IdentifierSchema,
  payload: JsonValueSchema,
});

const RunCompletionSchema = z.strictObject({
  runId: UuidSchema,
  status: z.enum(['completed', 'failed', 'blocked']),
  resolvedModel: z.string().trim().min(1).max(100).nullable(),
  modelReason: z.string().trim().min(1).max(200).nullable(),
  localTraceReference: z.string().trim().min(1).max(500).nullable(),
  safeError: JsonValueSchema.nullable(),
  usage: JsonValueSchema.nullable(),
});

const isoFromDb = (value: unknown) => {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new DurableRepositoryError(
      'invalid-result',
      'Database returned an invalid memory timestamp',
    );
  }
  return date.toISOString();
};

const safeSequence = (value: unknown) => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || Number(parsed) <= 0) {
    throw new DurableRepositoryError(
      'invalid-result',
      'Database returned an invalid event sequence',
    );
  }
  return Number(parsed);
};

const parseRunEvent = (row: Record<string, unknown>) => {
  if (
    typeof row.id !== 'string' ||
    typeof row.run_id !== 'string' ||
    typeof row.event_type !== 'string'
  ) {
    throw new DurableRepositoryError(
      'invalid-result',
      'Database returned a malformed run event',
    );
  }
  const payload = JsonValueSchema.safeParse(row.payload);
  if (!payload.success) {
    throw new DurableRepositoryError(
      'invalid-result',
      'Database returned invalid run event JSON',
    );
  }
  return deepFreeze({
    id: row.id,
    runId: row.run_id,
    sequence: safeSequence(row.sequence),
    eventType: row.event_type,
    payload: payload.data,
    occurredAt: isoFromDb(row.occurred_at),
  });
};

const parseConversationEvent = (row: Record<string, unknown>) => {
  if (
    typeof row.id !== 'string' ||
    typeof row.conversation_id !== 'string' ||
    typeof row.client_event_id !== 'string' ||
    typeof row.event_type !== 'string'
  ) {
    throw new DurableRepositoryError(
      'invalid-result',
      'Database returned a malformed conversation event',
    );
  }
  const payload = JsonValueSchema.safeParse(row.payload);
  if (!payload.success) {
    throw new DurableRepositoryError(
      'invalid-result',
      'Database returned invalid conversation JSON',
    );
  }
  return deepFreeze({
    id: row.id,
    conversationId: row.conversation_id,
    clientEventId: row.client_event_id,
    sequence: safeSequence(row.sequence),
    eventType: row.event_type,
    payload: payload.data,
    occurredAt: isoFromDb(row.occurred_at),
  });
};

export interface AgentRunRecord {
  readonly id: string;
  readonly spaceId: string;
  readonly agentId: string;
  readonly agentVersion: string;
  readonly requestedModel: string;
  readonly resolvedModel: string | null;
  readonly modelReason: string | null;
  readonly status: 'queued' | 'running' | 'completed' | 'failed' | 'blocked';
  readonly localTraceReference: string | null;
  readonly safeError: DeepReadonly<JsonValue> | null;
  readonly usage: DeepReadonly<JsonValue> | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly retainUntil: string;
}

const parseRun = (row: Record<string, unknown>): Readonly<AgentRunRecord> => {
  const parsed = z
    .strictObject({
      id: UuidSchema,
      spaceId: UuidSchema,
      agentId: IdentifierSchema,
      agentVersion: z.string().min(1).max(100),
      requestedModel: z.string().min(1).max(100),
      resolvedModel: z.string().min(1).max(100).nullable(),
      modelReason: z.string().min(1).max(200).nullable(),
      status: z.enum(['queued', 'running', 'completed', 'failed', 'blocked']),
      localTraceReference: z.string().min(1).max(500).nullable(),
      safeError: JsonValueSchema.nullable(),
      usage: JsonValueSchema.nullable(),
      createdAt: z.iso.datetime({ offset: true }),
      completedAt: z.iso.datetime({ offset: true }).nullable(),
      retainUntil: z.iso.datetime({ offset: true }),
    })
    .safeParse({
      id: row.id,
      spaceId: row.space_id,
      agentId: row.agent_id,
      agentVersion: row.agent_version,
      requestedModel: row.requested_model,
      resolvedModel: row.resolved_model ?? null,
      modelReason: row.model_reason ?? null,
      status: row.status,
      localTraceReference: row.local_trace_reference ?? null,
      safeError: row.safe_error ?? null,
      usage: row.usage ?? null,
      createdAt: isoFromDb(row.created_at),
      completedAt:
        row.completed_at === null || row.completed_at === undefined
          ? null
          : isoFromDb(row.completed_at),
      retainUntil: isoFromDb(row.retain_until),
    });
  if (!parsed.success) {
    throw new DurableRepositoryError(
      'invalid-result',
      'Database returned a malformed agent run',
    );
  }
  return deepFreeze(parsed.data);
};

const runColumns = `id, space_id, agent_id, agent_version, requested_model,
  resolved_model, model_reason, status, local_trace_reference, safe_error,
  usage, created_at, completed_at, retain_until`;

export class PostgresAgentMemoryRepository {
  readonly #principal: Readonly<DurableRepositoryPrincipal>;

  constructor(
    private readonly pool: DatabasePool,
    principal: DurableRepositoryPrincipal,
  ) {
    this.#principal = parseDurablePrincipal(principal);
  }

  async createRun(input: z.input<typeof RunCreateSchema>) {
    const parsed = RunCreateSchema.parse(input);
    return withDurableTransaction(
      this.pool,
      this.#principal,
      {
        householdId: this.#principal.householdId,
        spaceId: parsed.spaceId,
      },
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `with database_time as (
               select pg_catalog.clock_timestamp() as now
             )
             insert into emdo.agent_runs
               (id, household_id, space_id, original_owner_user_id,
                parent_run_id, agent_id, agent_version, requested_model,
                status, created_at, retain_until)
             select $1, space.household_id, space.id, emdo.current_user_id(),
                    $3, $4, $5, $6, 'queued', database_time.now,
                    database_time.now + interval '90 days'
               from emdo.spaces AS space cross join database_time
              where space.id = $2 and space.household_id = $7
                and space.tombstoned_at is null
                and ($3::uuid is null or exists (
                  select 1 from emdo.agent_runs parent
                   where parent.id = $3
                     and parent.household_id = space.household_id
                     and parent.space_id = space.id
                     and parent.original_owner_user_id = emdo.current_user_id()
                ))
             returning ${runColumns}`,
            [
              parsed.runId,
              parsed.spaceId,
              parsed.parentRunId ?? null,
              parsed.agentId,
              parsed.agentVersion,
              parsed.requestedModel,
              this.#principal.householdId,
            ],
          ),
        );
        if (row === undefined) {
          throw new DurableRepositoryError(
            'conflict',
            'Agent run could not be created in the active space',
          );
        }
        return parseRun(row);
      },
    );
  }

  async markRunRunning(runIdInput: string) {
    const runId = UuidSchema.parse(runIdInput);
    return this.#withRunScope(runId, async (client) => {
      const row = firstResultRow(
        await client.query(
          `update emdo.agent_runs
              set status = 'running'
            where id = $1 and status = 'queued'
            returning ${runColumns}`,
          [runId],
        ),
      );
      if (row === undefined) {
        throw new DurableRepositoryError('conflict', 'Agent run is not queued');
      }
      return parseRun(row);
    });
  }

  async completeRun(input: z.input<typeof RunCompletionSchema>) {
    const parsed = RunCompletionSchema.parse(input);
    return this.#withRunScope(parsed.runId, async (client) => {
      const row = firstResultRow(
        await client.query(
          `update emdo.agent_runs
              set resolved_model = $2, model_reason = $3, status = $4,
                  local_trace_reference = $5, safe_error = $6::jsonb,
                  usage = $7::jsonb,
                  completed_at = pg_catalog.clock_timestamp()
            where id = $1 and status in ('queued', 'running')
            returning ${runColumns}`,
          [
            parsed.runId,
            parsed.resolvedModel,
            parsed.modelReason,
            parsed.status,
            parsed.localTraceReference,
            parsed.safeError,
            parsed.usage,
          ],
        ),
      );
      if (row === undefined) {
        const replay = firstResultRow(
          await client.query(
            `select ${runColumns}
               from emdo.agent_runs
              where id = $1 and status = $4
                and resolved_model is not distinct from $2
                and model_reason is not distinct from $3
                and local_trace_reference is not distinct from $5
                and safe_error is not distinct from $6::jsonb
                and usage is not distinct from $7::jsonb
                and completed_at is not null`,
            [
              parsed.runId,
              parsed.resolvedModel,
              parsed.modelReason,
              parsed.status,
              parsed.localTraceReference,
              parsed.safeError,
              parsed.usage,
            ],
          ),
        );
        if (replay !== undefined) return parseRun(replay);
        throw new DurableRepositoryError(
          'conflict',
          'Agent run completion compare-and-set failed',
        );
      }
      return parseRun(row);
    });
  }

  async appendRunEvent(input: z.input<typeof RunEventAppendSchema>) {
    const parsed = RunEventAppendSchema.parse(input);
    return this.#withRunScope(parsed.runId, async (client) => {
      const row = firstResultRow(
        await client.query(
          `with database_time as (
             select pg_catalog.clock_timestamp() as now
           )
           insert into emdo.agent_run_events
             (household_id, space_id, original_owner_user_id, run_id,
              sequence, event_type, payload, occurred_at, retain_until)
           select run.household_id, run.space_id, run.original_owner_user_id,
                  run.id, $2, $3, $4::jsonb, database_time.now,
                  database_time.now + interval '90 days'
             from emdo.agent_runs run cross join database_time
            where run.id = $1
           on conflict (run_id, sequence) do nothing
           returning id, run_id, sequence, event_type, payload, occurred_at`,
          [parsed.runId, parsed.sequence, parsed.eventType, parsed.payload],
        ),
      );
      if (row === undefined) {
        const replay = firstResultRow(
          await client.query(
            `select id, run_id, sequence, event_type, payload, occurred_at
               from emdo.agent_run_events
              where run_id = $1 and sequence = $2 and event_type = $3
                and payload = $4::jsonb`,
            [parsed.runId, parsed.sequence, parsed.eventType, parsed.payload],
          ),
        );
        if (replay !== undefined) return parseRunEvent(replay);
        throw new DurableRepositoryError(
          'conflict',
          'Run event could not be appended',
        );
      }
      return parseRunEvent(row);
    });
  }

  async listRunEvents(
    runIdInput: string,
    options: { readonly afterSequence?: number; readonly limit?: number } = {},
  ) {
    const parsed = z
      .strictObject({
        runId: UuidSchema,
        afterSequence: z.number().int().nonnegative().safe().default(0),
        limit: z.number().int().positive().max(1_000).default(500),
      })
      .parse({ runId: runIdInput, ...options });
    return this.#withRunScope(parsed.runId, async (client) =>
      deepFreeze(
        (
          await client.query(
            `select id, run_id, sequence, event_type, payload, occurred_at
               from emdo.agent_run_events
              where run_id = $1 and sequence > $2
              order by sequence
              limit $3`,
            [parsed.runId, parsed.afterSequence, parsed.limit],
          )
        ).rows.map(parseRunEvent),
      ),
    );
  }

  async appendConversationEvent(
    input: z.input<typeof ConversationEventAppendSchema>,
  ) {
    const parsed = ConversationEventAppendSchema.parse(input);
    return withDurableTransaction(
      this.pool,
      this.#principal,
      {
        householdId: this.#principal.householdId,
        spaceId: parsed.spaceId,
      },
      async (client) => {
        const inserted = firstResultRow(
          await client.query(
            `insert into emdo.conversation_events
               (household_id, space_id, original_owner_user_id,
                conversation_id, client_event_id, sequence, event_type,
                payload, occurred_at)
             values ($1, $2, emdo.current_user_id(), $3, $4, $5, $6,
                     $7::jsonb, pg_catalog.clock_timestamp())
             on conflict (household_id, original_owner_user_id, client_event_id)
             do nothing
             returning id, space_id, conversation_id, client_event_id, sequence,
                       event_type, payload, occurred_at`,
            [
              this.#principal.householdId,
              parsed.spaceId,
              parsed.conversationId,
              parsed.clientEventId,
              parsed.sequence,
              parsed.eventType,
              parsed.payload,
            ],
          ),
        );
        if (inserted !== undefined) return parseConversationEvent(inserted);
        const replay = firstResultRow(
          await client.query(
            `select id, space_id, conversation_id, client_event_id, sequence,
                    event_type, payload, occurred_at,
                    payload = $4::jsonb as payload_matches
               from emdo.conversation_events
              where household_id = $1 and original_owner_user_id = $2
                and client_event_id = $3`,
            [
              this.#principal.householdId,
              this.#principal.userId,
              parsed.clientEventId,
              parsed.payload,
            ],
          ),
        );
        if (replay === undefined) {
          throw new DurableRepositoryError(
            'conflict',
            'Conversation event could not be appended',
          );
        }
        const stored = parseConversationEvent(replay);
        if (
          replay.space_id !== parsed.spaceId ||
          stored.conversationId !== parsed.conversationId ||
          stored.sequence !== parsed.sequence ||
          stored.eventType !== parsed.eventType ||
          replay.payload_matches !== true
        ) {
          throw new DurableRepositoryError(
            'conflict',
            'Conversation client event ID was reused with different content',
          );
        }
        return stored;
      },
    );
  }

  async listConversation(conversationIdInput: string) {
    const conversationId = UuidSchema.parse(conversationIdInput);
    return withClaimedTransaction(
      this.pool,
      this.#principal,
      async (client) => {
        const scope = firstResultRow(
          await client.query(
            `select household_id, space_id, original_owner_user_id
               from emdo.conversation_events
              where conversation_id = $1
              order by sequence
              limit 1`,
            [conversationId],
          ),
        );
        if (scope === undefined) return deepFreeze([]);
        if (
          scope.household_id !== this.#principal.householdId ||
          scope.original_owner_user_id !== this.#principal.userId ||
          typeof scope.space_id !== 'string'
        ) {
          throw new DurableRepositoryError(
            'authorization-revoked',
            'Conversation is unavailable in the active scope',
          );
        }
        await lockDurableScope(client, {
          householdId: this.#principal.householdId,
          spaceId: scope.space_id,
        });
        return deepFreeze(
          (
            await client.query(
              `select id, conversation_id, client_event_id, sequence,
                      event_type, payload, occurred_at
                 from emdo.conversation_events
                where conversation_id = $1 and space_id = $2
                order by sequence`,
              [conversationId, scope.space_id],
            )
          ).rows.map(parseConversationEvent),
        );
      },
    );
  }

  async #withRunScope<Result>(
    runId: string,
    work: (client: DatabaseClient) => Promise<Result>,
  ) {
    return withClaimedTransaction(
      this.pool,
      this.#principal,
      async (client) => {
        const scope = firstResultRow(
          await client.query(
            `select household_id, space_id, original_owner_user_id
               from emdo.agent_runs
              where id = $1`,
            [runId],
          ),
        );
        if (
          scope?.household_id !== this.#principal.householdId ||
          scope.original_owner_user_id !== this.#principal.userId ||
          typeof scope.space_id !== 'string'
        ) {
          throw new DurableRepositoryError(
            'authorization-revoked',
            'Agent run is unavailable in the active scope',
          );
        }
        await lockDurableScope(client, {
          householdId: this.#principal.householdId,
          spaceId: scope.space_id,
        });
        return work(client);
      },
    );
  }
}

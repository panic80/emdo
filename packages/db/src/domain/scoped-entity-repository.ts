import {
  IdentifierSchema,
  JsonValueSchema,
  UuidSchema,
  deepFreeze,
  type JsonValue,
} from '@emdo/contracts';
import { z } from 'zod';

import type { DatabasePool } from '../scoped-repository.js';
import {
  firstResultRow,
  parseDurablePrincipal,
  withDurableTransaction,
  type DurableRepositoryPrincipal,
} from '../durable/scoped-transaction.js';
import {
  containsReservedOfflineDataField,
  DEFAULT_SYNC_ENTITY_POLICIES,
} from '../sync/operations.js';

const EntityIdSchema = z.string().trim().min(1).max(240);
// Keep this boundary identical to SyncOperationSchema and the database CHECK.
// A stricter repository-only shape would otherwise turn valid offline retries
// into raw PostgreSQL constraint errors (or accept values the canonical upload
// path rejects).
const ActorIntentSchema = z.string().trim().min(3).max(1_000);
const ScopeSchema = z.strictObject({
  spaceId: UuidSchema,
  entityType: IdentifierSchema,
});
const MutationSchema = z.strictObject({
  entityId: EntityIdSchema,
  payload: JsonValueSchema,
  actorIntent: ActorIntentSchema,
});
const CasSchema = MutationSchema.extend({
  expectedRevision: z.number().int().safe().positive(),
});
const TombstoneSchema = z.strictObject({
  entityId: EntityIdSchema,
  expectedRevision: z.number().int().safe().positive(),
  actorIntent: ActorIntentSchema,
});
const ListSchema = z.strictObject({
  afterEntityId: EntityIdSchema.optional(),
  limit: z.number().int().safe().min(1).max(100).default(50),
  includeTombstoned: z.boolean().default(false),
});

const allowedEntityTypes = new Set(
  DEFAULT_SYNC_ENTITY_POLICIES.filter(
    ({ entityType }) => entityType !== 'conversation.event',
  ).map(({ entityType }) => entityType),
);

const validatePayload = (value: JsonValue): JsonValue => {
  if (containsReservedOfflineDataField(value)) {
    throw new ScopedDomainEntityError(
      'authority-field-forbidden',
      'Domain payload contains a server-owned authority field',
    );
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 1_000_000) {
    throw new ScopedDomainEntityError(
      'invalid-input',
      'Domain payload exceeds the bounded persistence limit',
    );
  }
  return value;
};

export class ScopedDomainEntityError extends Error {
  constructor(
    readonly code:
      | 'authority-field-forbidden'
      | 'conflict'
      | 'invalid-input'
      | 'invalid-result',
    message: string,
  ) {
    super(message);
    this.name = 'ScopedDomainEntityError';
  }
}

export interface ScopedDomainEntity {
  readonly entityId: string;
  readonly payload: JsonValue;
  readonly revision: number;
  readonly tombstonedAt: string | null;
  readonly updatedAt: string;
}

const parseEntity = (
  row: Record<string, unknown>,
): Readonly<ScopedDomainEntity> => {
  const parsed = z
    .strictObject({
      entity_id: EntityIdSchema,
      payload: JsonValueSchema,
      revision: z.number().int().safe().positive(),
      tombstoned_at: z.coerce.date().nullable(),
      updated_at: z.coerce.date(),
    })
    .safeParse(row);
  if (!parsed.success) {
    throw new ScopedDomainEntityError(
      'invalid-result',
      'Database returned a malformed domain entity',
    );
  }
  return deepFreeze({
    entityId: parsed.data.entity_id,
    payload: parsed.data.payload,
    revision: parsed.data.revision,
    tombstonedAt: parsed.data.tombstoned_at?.toISOString() ?? null,
    updatedAt: parsed.data.updated_at.toISOString(),
  }) as Readonly<ScopedDomainEntity>;
};

/**
 * Fixed-scope generic persistence for already-validated domain service data.
 * The constructor, never a model/client payload, owns tenant, space and type.
 */
export class PostgresScopedDomainEntityRepository {
  readonly #principal: Readonly<DurableRepositoryPrincipal>;
  readonly #scope: Readonly<z.output<typeof ScopeSchema>>;

  constructor(
    private readonly pool: DatabasePool,
    principal: DurableRepositoryPrincipal,
    scope: z.input<typeof ScopeSchema>,
  ) {
    this.#principal = parseDurablePrincipal(principal);
    const parsedScope = ScopeSchema.parse(scope);
    if (!allowedEntityTypes.has(parsedScope.entityType)) {
      throw new ScopedDomainEntityError(
        'invalid-input',
        'Domain entity type is not in the server-owned allowlist',
      );
    }
    this.#scope = deepFreeze(parsedScope);
  }

  async create(
    input: z.input<typeof MutationSchema>,
  ): Promise<ScopedDomainEntity> {
    const request = MutationSchema.parse(input);
    const payload = validatePayload(request.payload);
    return withDurableTransaction(
      this.pool,
      this.#principal,
      {
        householdId: this.#principal.householdId,
        spaceId: this.#scope.spaceId,
      },
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `with database_time as (
               select pg_catalog.clock_timestamp() as now
             )
             insert into emdo.sync_entities
               (household_id, space_id, original_owner_user_id, entity_type,
                entity_id, payload, actor_intent, revision, created_at,
                updated_at)
             select space.household_id, space.id, emdo.current_user_id(),
                    $2, $3, $4::jsonb, $5, 1,
                    database_time.now, database_time.now
               from emdo.spaces space cross join database_time
              where space.id = $1 and space.household_id = $6
                and space.tombstoned_at is null
             on conflict (household_id, space_id, entity_type, entity_id)
             do nothing
             returning entity_id, payload, revision, tombstoned_at, updated_at`,
            [
              this.#scope.spaceId,
              this.#scope.entityType,
              request.entityId,
              payload,
              request.actorIntent,
              this.#principal.householdId,
            ],
          ),
        );
        if (row === undefined) {
          throw new ScopedDomainEntityError(
            'conflict',
            'Domain entity already exists or its scope is unavailable',
          );
        }
        return parseEntity(row);
      },
    );
  }

  async get(entityIdInput: string): Promise<ScopedDomainEntity | undefined> {
    const entityId = EntityIdSchema.parse(entityIdInput);
    return withDurableTransaction(
      this.pool,
      this.#principal,
      {
        householdId: this.#principal.householdId,
        spaceId: this.#scope.spaceId,
      },
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `select entity_id, payload, revision, tombstoned_at, updated_at
               from emdo.sync_entities
              where household_id = $1 and space_id = $2
                and entity_type = $3 and entity_id = $4`,
            [
              this.#principal.householdId,
              this.#scope.spaceId,
              this.#scope.entityType,
              entityId,
            ],
          ),
        );
        return row === undefined ? undefined : parseEntity(row);
      },
    );
  }

  async list(
    input: z.input<typeof ListSchema> = {},
  ): Promise<readonly ScopedDomainEntity[]> {
    const request = ListSchema.parse(input);
    return withDurableTransaction(
      this.pool,
      this.#principal,
      {
        householdId: this.#principal.householdId,
        spaceId: this.#scope.spaceId,
      },
      async (client) => {
        const result = await client.query(
          `select entity_id, payload, revision, tombstoned_at, updated_at
             from emdo.sync_entities
            where household_id = $1 and space_id = $2 and entity_type = $3
              and ($4::text is null or entity_id > $4)
              and ($5::boolean or tombstoned_at is null)
            order by entity_id
            limit $6`,
          [
            this.#principal.householdId,
            this.#scope.spaceId,
            this.#scope.entityType,
            request.afterEntityId ?? null,
            request.includeTombstoned,
            request.limit,
          ],
        );
        return Object.freeze(result.rows.map(parseEntity));
      },
    );
  }

  async compareAndSet(
    input: z.input<typeof CasSchema>,
  ): Promise<ScopedDomainEntity> {
    const request = CasSchema.parse(input);
    const payload = validatePayload(request.payload);
    return this.#mutate(
      request.entityId,
      request.expectedRevision,
      `payload = $5::jsonb, actor_intent = $6,
       revision = revision + 1,
       updated_at = pg_catalog.clock_timestamp()`,
      [payload, request.actorIntent],
    );
  }

  async tombstone(
    input: z.input<typeof TombstoneSchema>,
  ): Promise<ScopedDomainEntity> {
    const request = TombstoneSchema.parse(input);
    return this.#mutate(
      request.entityId,
      request.expectedRevision,
      `actor_intent = $5, revision = revision + 1,
       tombstoned_at = pg_catalog.clock_timestamp(),
       updated_at = pg_catalog.clock_timestamp()`,
      [request.actorIntent],
    );
  }

  async #mutate(
    entityId: string,
    expectedRevision: number,
    assignments: string,
    values: readonly unknown[],
  ): Promise<ScopedDomainEntity> {
    const expectedRevisionParameter = `$${5 + values.length}`;
    return withDurableTransaction(
      this.pool,
      this.#principal,
      {
        householdId: this.#principal.householdId,
        spaceId: this.#scope.spaceId,
      },
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `update emdo.sync_entities
                set ${assignments}
              where household_id = $1 and space_id = $2
                and entity_type = $3 and entity_id = $4
                and revision = ${expectedRevisionParameter}
                and tombstoned_at is null
              returning entity_id, payload, revision, tombstoned_at, updated_at`,
            [
              this.#principal.householdId,
              this.#scope.spaceId,
              this.#scope.entityType,
              entityId,
              ...values,
              expectedRevision,
            ],
          ),
        );
        if (row === undefined) {
          throw new ScopedDomainEntityError(
            'conflict',
            'Domain entity revision changed or is unavailable',
          );
        }
        return parseEntity(row);
      },
    );
  }
}

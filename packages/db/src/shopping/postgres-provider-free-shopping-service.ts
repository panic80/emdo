import {
  OpaqueReferenceSchema,
  UuidSchema,
  deepFreeze,
  type JsonValue,
} from '@emdo/contracts';
import { z } from 'zod';

import type { DatabasePool } from '../scoped-repository.js';
import {
  firstResultRow,
  withDurableTransaction,
  type DurableRepositoryPrincipal,
} from '../durable/scoped-transaction.js';

const PrincipalSchema = z.strictObject({
  userId: UuidSchema,
  sessionId: UuidSchema,
  householdId: UuidSchema,
  spaceAccessGrantId: UuidSchema,
});

const InputSchema = z.strictObject({
  principal: PrincipalSchema,
  requestId: UuidSchema,
  privateSpaceId: UuidSchema,
  runId: UuidSchema,
  item: z.strictObject({
    id: OpaqueReferenceSchema,
    name: z.string().trim().min(1).max(120),
    quantityMinorUnits: z.number().int().safe().positive(),
    unit: z.string().trim().min(1).max(40),
  }),
});

const AuthorityRowSchema = z.strictObject({
  user_id: UuidSchema,
  session_id: UuidSchema,
  request_id: UuidSchema,
  household_id: UuidSchema,
  private_space_id: UuidSchema,
  writable_space_ids: z.array(UuidSchema).min(1).max(256),
});

const CanonicalPayloadSchema = z.strictObject({
  itemId: OpaqueReferenceSchema,
  name: z.string().trim().min(1).max(120),
  unit: z.string().trim().min(1).max(40),
  quantityMinorUnits: z.number().int().safe().nonnegative(),
  tombstoned: z.literal(false),
  baseQuantityMinorUnits: z.number().int().safe().nonnegative(),
  baseTombstoned: z.literal(false),
  quantityConflict: z.literal(false),
  appliedOperationIds: z.array(UuidSchema).length(0),
  appliedOperations: z.array(z.never()).length(0),
});

const StoredItemSchema = z.strictObject({
  entity_id: OpaqueReferenceSchema,
  payload: CanonicalPayloadSchema,
  revision: z.number().int().safe().positive(),
  updated_at: z.coerce.date(),
});

const SafeConflict = deepFreeze({
  code: 'shopping-item-id-conflict' as const,
  message: 'A shopping item already exists with different data.',
});

const AuthorityConflict = deepFreeze({
  code: 'shopping-item-create-unavailable' as const,
  message:
    'The shopping item could not be created in the active private space.',
});

export interface ProviderFreeShoppingCreateInput {
  readonly principal: {
    readonly userId: string;
    readonly sessionId: string;
    readonly householdId: string;
    readonly spaceAccessGrantId: string;
  };
  readonly requestId: string;
  readonly privateSpaceId: string;
  readonly runId: string;
  readonly item: {
    readonly id: string;
    readonly name: string;
    readonly quantityMinorUnits: number;
    readonly unit: string;
  };
}

export type ProviderFreeShoppingCreateResult =
  | Readonly<{
      status: 'applied' | 'duplicate';
      item: Readonly<{
        id: string;
        name: string;
        quantityMinorUnits: number;
        unit: string;
        revision: number;
        updatedAt: string;
      }>;
    }>
  | Readonly<{
      status: 'conflict';
      safeError: Readonly<{
        code: 'shopping-item-id-conflict' | 'shopping-item-create-unavailable';
        message: string;
      }>;
    }>;

const canonicalJson = (value: JsonValue): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`,
    )
    .join(',')}}`;
};

const view = (stored: z.output<typeof StoredItemSchema>) =>
  deepFreeze({
    id: stored.entity_id,
    name: stored.payload.name,
    quantityMinorUnits: stored.payload.quantityMinorUnits,
    unit: stored.payload.unit,
    revision: stored.revision,
    updatedAt: stored.updated_at.toISOString(),
  });

/**
 * Create-only, provider-free shopping persistence. Its fixed entity type and
 * server-built payload deliberately keep the generic sync writer unavailable
 * to API callers.
 */
export class PostgresProviderFreeShoppingService {
  constructor(private readonly pool: DatabasePool) {}

  /** Verifies the API login can reach this service's fixed persistence seam. */
  async checkReady(): Promise<boolean> {
    const client = await this.pool.connect().catch(() => undefined);
    if (client === undefined) return false;
    try {
      const row = firstResultRow(
        await client.query(
          `/* provider_free_shopping_ready */
           select (
             pg_catalog.to_regclass('emdo.sync_entities') is not null
             and exists (
               select 1
                 from pg_catalog.pg_class as relation
                where relation.oid = pg_catalog.to_regclass('emdo.sync_entities')
                  and relation.relrowsecurity
                  and relation.relforcerowsecurity
             )
             and pg_catalog.has_table_privilege(
               session_user, 'emdo.sync_entities', 'SELECT,INSERT'
             )
             and pg_catalog.to_regprocedure(
               'emdo.resolve_space_access_grant(uuid,uuid,uuid,uuid,uuid,uuid)'
             ) is not null
             and pg_catalog.has_function_privilege(
               session_user,
               'emdo.resolve_space_access_grant(uuid,uuid,uuid,uuid,uuid,uuid)',
               'EXECUTE'
             )
           ) as ready`,
        ),
      );
      const parsed = z.strictObject({ ready: z.boolean() }).safeParse(row);
      client.release(false);
      return parsed.success && parsed.data.ready;
    } catch {
      client.release(true);
      return false;
    }
  }

  async create(
    rawInput: ProviderFreeShoppingCreateInput,
  ): Promise<ProviderFreeShoppingCreateResult> {
    const input = InputSchema.parse(rawInput);
    const principal: DurableRepositoryPrincipal = {
      userId: input.principal.userId,
      sessionId: input.principal.sessionId,
      requestId: input.requestId,
      householdId: input.principal.householdId,
    };
    const payload = CanonicalPayloadSchema.parse({
      itemId: input.item.id,
      name: input.item.name,
      unit: input.item.unit,
      quantityMinorUnits: input.item.quantityMinorUnits,
      tombstoned: false,
      baseQuantityMinorUnits: input.item.quantityMinorUnits,
      baseTombstoned: false,
      quantityConflict: false,
      appliedOperationIds: [],
      appliedOperations: [],
    });
    const actorIntent = `Provider-free shopping create for run ${input.runId}`;

    return withDurableTransaction(
      this.pool,
      principal,
      {
        householdId: input.principal.householdId,
        spaceId: input.privateSpaceId,
      },
      async (client) => {
        const authority = AuthorityRowSchema.safeParse(
          firstResultRow(
            await client.query(
              `/* provider_free_shopping_authority */
               select original_owner_user_id as user_id, session_id,
                      request_id, household_id, private_space_id,
                      writable_space_ids
                 from emdo.resolve_space_access_grant(
                   $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid
                 )`,
              [
                input.principal.spaceAccessGrantId,
                input.principal.householdId,
                input.principal.userId,
                input.principal.sessionId,
                input.requestId,
                input.privateSpaceId,
              ],
            ),
          ),
        );
        if (
          !authority.success ||
          authority.data.user_id !== input.principal.userId ||
          authority.data.session_id !== input.principal.sessionId ||
          authority.data.request_id !== input.requestId ||
          authority.data.household_id !== input.principal.householdId ||
          authority.data.private_space_id !== input.privateSpaceId ||
          !authority.data.writable_space_ids.includes(input.privateSpaceId)
        ) {
          return deepFreeze({
            status: 'conflict' as const,
            safeError: AuthorityConflict,
          });
        }

        const inserted = firstResultRow(
          await client.query(
            `/* provider_free_shopping_create */
             insert into emdo.sync_entities
               (household_id, space_id, original_owner_user_id, entity_type,
                entity_id, payload, actor_intent, revision, created_at, updated_at)
             values ($1::uuid, $2::uuid, emdo.current_user_id(), 'shopping.item',
                     $3::text, $4::jsonb, $5::text, 1,
                     pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp())
             on conflict (household_id, space_id, entity_type, entity_id)
             do nothing
             returning entity_id, payload, revision, updated_at`,
            [
              input.principal.householdId,
              input.privateSpaceId,
              input.item.id,
              payload,
              actorIntent,
            ],
          ),
        );
        if (inserted !== undefined) {
          const stored = StoredItemSchema.safeParse(inserted);
          if (!stored.success) {
            return deepFreeze({
              status: 'conflict' as const,
              safeError: AuthorityConflict,
            });
          }
          return deepFreeze({
            status: 'applied' as const,
            item: view(stored.data),
          });
        }

        const existing = firstResultRow(
          await client.query(
            `/* provider_free_shopping_existing */
             select entity_id, payload, revision, updated_at
               from emdo.sync_entities
              where household_id = $1::uuid and space_id = $2::uuid
                and entity_type = 'shopping.item' and entity_id = $3::text
              for key share`,
            [input.principal.householdId, input.privateSpaceId, input.item.id],
          ),
        );
        const stored = StoredItemSchema.safeParse(existing);
        if (!stored.success) {
          return deepFreeze({
            status: 'conflict' as const,
            safeError: AuthorityConflict,
          });
        }
        if (
          stored.data.entity_id !== input.item.id ||
          canonicalJson(stored.data.payload) !== canonicalJson(payload)
        ) {
          return deepFreeze({
            status: 'conflict' as const,
            safeError: SafeConflict,
          });
        }
        return deepFreeze({
          status: 'duplicate' as const,
          item: view(stored.data),
        });
      },
    );
  }
}

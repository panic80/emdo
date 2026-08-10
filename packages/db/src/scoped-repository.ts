import { randomUUID } from 'node:crypto';

import {
  IdentifierSchema,
  JsonValueSchema,
  UuidSchema,
  deepFreeze,
  type JsonValue,
} from '@emdo/contracts';
import { z } from 'zod';

export interface DatabaseQueryResult {
  readonly rowCount: number | null;
  readonly rows: readonly Record<string, unknown>[];
}

export interface DatabaseClient {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<DatabaseQueryResult>;
  release(): void;
}

export interface DatabasePool {
  connect(): Promise<DatabaseClient>;
}

const AuthenticatedIdentitySchema = z.strictObject({
  userId: UuidSchema,
  sessionId: UuidSchema,
  emailVerified: z.literal(true),
});

export type AuthenticatedIdentity = Readonly<
  z.infer<typeof AuthenticatedIdentitySchema>
>;

export interface AuthenticatedIdentityResolver {
  resolve(sessionId: string): Promise<AuthenticatedIdentity | undefined>;
}

const ScopedRunInputSchema = z.strictObject({
  sessionId: UuidSchema,
  requestId: UuidSchema,
});

const SpaceIdSchema = UuidSchema;
const RecordCreateSchema = z.strictObject({
  spaceId: SpaceIdSchema,
  recordKind: IdentifierSchema,
  payload: JsonValueSchema,
  actorIntent: z.string().trim().min(1).max(2_000),
});
const AuditAppendSchema = z.strictObject({
  spaceId: SpaceIdSchema,
  eventType: IdentifierSchema,
  payload: JsonValueSchema,
});
const ConversationAppendSchema = z.strictObject({
  spaceId: SpaceIdSchema,
  conversationId: UuidSchema,
  clientEventId: z.string().trim().min(1).max(200),
  sequence: z.number().int().positive().safe(),
  eventType: IdentifierSchema,
  payload: JsonValueSchema,
});

export class ScopedDatabaseError extends Error {
  constructor(
    readonly code:
      | 'identity-invalid'
      | 'identity-mismatch'
      | 'scoped-write-denied'
      | 'scoped-write-conflict',
    message: string,
  ) {
    super(message);
    this.name = 'ScopedDatabaseError';
  }
}

const firstRow = (
  result: DatabaseQueryResult,
): Record<string, unknown> | undefined => result.rows[0];

const freezeRows = (result: DatabaseQueryResult) =>
  Object.freeze(result.rows.map((row) => deepFreeze({ ...row })));

class SpaceRepository {
  constructor(private readonly client: DatabaseClient) {}

  async listReadable() {
    const result = await this.client.query(
      `select id, household_id, original_owner_user_id, name, visibility,
              revision, tombstoned_at, created_at, updated_at
         from emdo.spaces
        where tombstoned_at is null
        order by created_at, id`,
    );
    return freezeRows(result);
  }

  async get(spaceId: string) {
    const id = SpaceIdSchema.parse(spaceId);
    const result = await this.client.query(
      `select id, household_id, original_owner_user_id, name, visibility,
              revision, tombstoned_at, created_at, updated_at
         from emdo.spaces
        where id = $1 and tombstoned_at is null`,
      [id],
    );
    const row = firstRow(result);
    return row === undefined ? undefined : deepFreeze({ ...row });
  }
}

class RecordRepository {
  constructor(private readonly client: DatabaseClient) {}

  async create(input: {
    readonly spaceId: string;
    readonly recordKind: string;
    readonly payload: JsonValue;
    readonly actorIntent: string;
  }) {
    const parsed = RecordCreateSchema.parse(input);
    const result = await this.client.query(
      `insert into emdo.space_records
         (id, household_id, space_id, original_owner_user_id, record_kind,
          payload, actor_intent, revision)
       select gen_random_uuid(), s.household_id, s.id,
              emdo.current_user_id(), $2, $3::jsonb, $4, 1
         from emdo.spaces s
        where s.id = $1 and s.tombstoned_at is null
       returning id, space_id, record_kind, payload, revision`,
      [parsed.spaceId, parsed.recordKind, parsed.payload, parsed.actorIntent],
    );
    const row = firstRow(result);
    if (row === undefined) {
      throw new ScopedDatabaseError(
        'scoped-write-denied',
        'Record target is unavailable in the authenticated scope',
      );
    }
    return deepFreeze({ ...row });
  }

  async listBySpace(spaceId: string) {
    const id = SpaceIdSchema.parse(spaceId);
    return freezeRows(
      await this.client.query(
        `select id, household_id, space_id, original_owner_user_id,
                record_kind, payload, actor_intent, revision, tombstoned_at,
                created_at, updated_at
           from emdo.space_records
          where space_id = $1
          order by created_at, id`,
        [id],
      ),
    );
  }
}

class AuditRepository {
  constructor(private readonly client: DatabaseClient) {}

  async append(input: {
    readonly spaceId: string;
    readonly eventType: string;
    readonly payload: JsonValue;
  }) {
    const parsed = AuditAppendSchema.parse(input);
    const result = await this.client.query(
      `insert into emdo.audit_events
         (id, household_id, space_id, original_owner_user_id, actor_user_id,
          session_id, request_id, event_type, payload)
       select gen_random_uuid(), s.household_id, s.id,
              emdo.current_user_id(), emdo.current_user_id(),
              emdo.current_session_id(), emdo.current_request_id(), $2,
              $3::jsonb
         from emdo.spaces s
        where s.id = $1 and s.tombstoned_at is null
       returning id, event_type, occurred_at`,
      [parsed.spaceId, parsed.eventType, parsed.payload],
    );
    const row = firstRow(result);
    if (row === undefined) {
      throw new ScopedDatabaseError(
        'scoped-write-denied',
        'Audit target is unavailable in the authenticated scope',
      );
    }
    return deepFreeze({ ...row });
  }

  async listBySpace(spaceId: string) {
    const id = SpaceIdSchema.parse(spaceId);
    return freezeRows(
      await this.client.query(
        `select id, event_type, actor_user_id, occurred_at, payload
           from emdo.audit_events
          where space_id = $1
          order by occurred_at, id`,
        [id],
      ),
    );
  }
}

class ConversationRepository {
  constructor(private readonly client: DatabaseClient) {}

  async append(input: {
    readonly spaceId: string;
    readonly conversationId: string;
    readonly clientEventId: string;
    readonly sequence: number;
    readonly eventType: string;
    readonly payload: JsonValue;
  }) {
    const parsed = ConversationAppendSchema.parse(input);
    const result = await this.client.query(
      `insert into emdo.conversation_events
         (id, household_id, space_id, original_owner_user_id, conversation_id,
          client_event_id, sequence, event_type, payload)
       select gen_random_uuid(), s.household_id, s.id,
              emdo.current_user_id(), $2, $3, $4, $5, $6::jsonb
         from emdo.spaces s
        where s.id = $1 and s.tombstoned_at is null
       on conflict (household_id, original_owner_user_id, client_event_id)
       do nothing
       returning id, conversation_id, sequence, event_type, occurred_at`,
      [
        parsed.spaceId,
        parsed.conversationId,
        parsed.clientEventId,
        parsed.sequence,
        parsed.eventType,
        parsed.payload,
      ],
    );
    const row = firstRow(result);
    if (row === undefined) {
      throw new ScopedDatabaseError(
        'scoped-write-conflict',
        'Conversation event was denied or already exists',
      );
    }
    return deepFreeze({ ...row });
  }

  async list(conversationId: string) {
    const id = UuidSchema.parse(conversationId);
    return freezeRows(
      await this.client.query(
        `select id, conversation_id, sequence, event_type, payload, occurred_at
           from emdo.conversation_events
          where conversation_id = $1
          order by sequence`,
        [id],
      ),
    );
  }
}

export interface ScopedRepositories {
  readonly spaces: SpaceRepository;
  readonly records: RecordRepository;
  readonly audit: AuditRepository;
  readonly conversations: ConversationRepository;
}

class ScopedDatabase {
  private readonly resolveIdentity: AuthenticatedIdentityResolver['resolve'];

  constructor(
    private readonly pool: DatabasePool,
    resolver: AuthenticatedIdentityResolver,
  ) {
    this.resolveIdentity = resolver.resolve.bind(resolver);
  }

  async run<Result>(
    sessionId: string,
    requestId: string,
    work: (repositories: ScopedRepositories) => Promise<Result>,
  ): Promise<Result> {
    const scope = ScopedRunInputSchema.parse({ sessionId, requestId });
    const identity = AuthenticatedIdentitySchema.safeParse(
      await this.resolveIdentity(scope.sessionId),
    );
    if (!identity.success) {
      throw new ScopedDatabaseError(
        'identity-invalid',
        'Authenticated session is invalid',
      );
    }
    if (identity.data.sessionId !== scope.sessionId) {
      throw new ScopedDatabaseError(
        'identity-mismatch',
        'Authenticated session identity does not match the request',
      );
    }

    const client = await this.pool.connect();
    let began = false;
    try {
      await client.query('begin');
      began = true;
      await client.query(
        `select set_config('emdo.user_id', $1, true),
                set_config('emdo.session_id', $2, true),
                set_config('emdo.request_id', $3, true);
         set local row_security = on`,
        [identity.data.userId, identity.data.sessionId, scope.requestId],
      );

      const repositories = Object.freeze({
        spaces: new SpaceRepository(client),
        records: new RecordRepository(client),
        audit: new AuditRepository(client),
        conversations: new ConversationRepository(client),
      });
      const result = await work(repositories);
      await client.query('commit');
      return result;
    } catch (error) {
      if (began) {
        try {
          await client.query('rollback');
        } catch {
          // The original scoped failure remains authoritative.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

export const createScopedDatabase = (
  pool: DatabasePool,
  resolver: AuthenticatedIdentityResolver,
) => new ScopedDatabase(pool, resolver);

export const createUuid = (): string => randomUUID();

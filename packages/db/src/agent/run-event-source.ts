import {
  EffectiveAuthorizationScopeFingerprintSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  UuidSchema,
  deepFreeze,
  type JsonValue,
} from '@emdo/contracts';
import { z } from 'zod';

import type { DatabasePool } from '../scoped-repository.js';
import {
  DurableRepositoryError,
  firstResultRow,
  withClaimedTransaction,
} from '../durable/scoped-transaction.js';

const RUN_EVENT_PAGE_SIZE = 250;
const MAXIMUM_REPLAY_EVENTS = 1_000;

const ApiPrincipalSchema = z.strictObject({
  userId: UuidSchema,
  sessionId: UuidSchema,
  householdId: UuidSchema,
  role: z.enum(['owner', 'member']),
  emailVerified: z.literal(true),
  spaceAccessGrantId: UuidSchema,
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema,
});

const AbortSignalSchema = z.custom<AbortSignal>(
  (value) => typeof AbortSignal !== 'undefined' && value instanceof AbortSignal,
  'A request abort signal is required',
);

const OpenInputSchema = z.strictObject({
  runId: UuidSchema,
  afterSequence: z.number().int().nonnegative().safe(),
  principal: ApiPrincipalSchema,
  requestId: UuidSchema,
  abortSignal: AbortSignalSchema,
});

const PublicRunEventSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: UuidSchema,
  sequence: z.number().int().positive().safe(),
  type: IdentifierSchema,
  occurredAt: IsoDateTimeSchema,
  data: JsonValueSchema,
});
const RunEventPageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  events: z.array(PublicRunEventSchema).max(RUN_EVENT_PAGE_SIZE),
});

export interface PersistedRunEvent {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly sequence: number;
  readonly type: string;
  readonly occurredAt: string;
  readonly data: JsonValue;
}

const invalidRunEvent = () =>
  new DurableRepositoryError(
    'invalid-result',
    'Persisted run event source returned an invalid run event',
  );

const unavailableGrant = () =>
  new DurableRepositoryError(
    'authorization-revoked',
    'Agent run events are unavailable to the active request grant',
  );

/**
 * Finite, authenticated replay of persisted run events for the API SSE route.
 *
 * Every page installs the request claims and calls one restricted database
 * aggregate that locks and re-proves the fresh grant against the exact run
 * before reading forced-RLS rows. This source does not poll, retain listeners,
 * or expose database event identifiers.
 */
export class PostgresRunEventSource {
  constructor(private readonly pool: DatabasePool) {}

  async open(
    rawInput: z.input<typeof OpenInputSchema>,
  ): Promise<AsyncIterable<PersistedRunEvent>> {
    const input = OpenInputSchema.parse(rawInput);
    const principal = {
      userId: input.principal.userId,
      sessionId: input.principal.sessionId,
      requestId: input.requestId,
      householdId: input.principal.householdId,
    };
    const pool = this.pool;

    async function* replay(): AsyncGenerator<PersistedRunEvent> {
      let afterSequence = input.afterSequence;
      let remaining = MAXIMUM_REPLAY_EVENTS;
      while (!input.abortSignal.aborted && remaining > 0) {
        const limit = Math.min(RUN_EVENT_PAGE_SIZE, remaining);
        const page = await withClaimedTransaction(
          pool,
          principal,
          async (client) => {
            const row = firstResultRow(
              await client.query(
                `select emdo.read_agent_run_events(
                   $1::uuid, $2::uuid, $3::bigint, $4::integer
                 ) as run_event_result`,
                [
                  input.principal.spaceAccessGrantId,
                  input.runId,
                  afterSequence,
                  limit,
                ],
              ),
            );
            if (row?.run_event_result === null || row === undefined) {
              throw unavailableGrant();
            }
            const parsed = RunEventPageSchema.safeParse(row.run_event_result);
            if (!parsed.success) throw invalidRunEvent();
            return parsed.data.events;
          },
        );
        if (input.abortSignal.aborted) return;
        if (page.length > limit) throw invalidRunEvent();
        if (page.length === 0) return;

        for (const stored of page) {
          if (input.abortSignal.aborted) return;
          const parsed = PublicRunEventSchema.safeParse(stored);
          if (
            !parsed.success ||
            parsed.data.runId !== input.runId ||
            parsed.data.sequence <= afterSequence
          ) {
            throw invalidRunEvent();
          }
          afterSequence = parsed.data.sequence;
          remaining -= 1;
          const event: PersistedRunEvent = parsed.data;
          deepFreeze(event);
          yield event;
        }

        if (page.length < limit) return;
      }
    }

    return replay();
  }

  async check(): Promise<boolean> {
    const client = await this.pool.connect().catch(() => undefined);
    if (client === undefined) return false;
    let ready = false;
    try {
      const result = await client.query(
        `/* run_event_source_ready */
         select (
           session_user = 'emdo_api_login'
           and current_user = session_user
           and pg_catalog.pg_has_role(session_user, 'emdo_app', 'USAGE')
           and exists (
             select
               from pg_catalog.pg_roles as login_role
              where login_role.rolname = session_user
                and login_role.rolcanlogin is true
                and login_role.rolinherit is true
                and login_role.rolsuper is false
                and login_role.rolbypassrls is false
                and login_role.rolcreatedb is false
                and login_role.rolcreaterole is false
                and login_role.rolreplication is false
           )
           and exists (
             select
               from pg_catalog.pg_auth_members as membership
               join pg_catalog.pg_roles as child
                 on child.oid = membership.member
               join pg_catalog.pg_roles as parent
                 on parent.oid = membership.roleid
              where child.rolname = session_user
                and parent.rolname = 'emdo_app'
                and membership.inherit_option is true
                and membership.set_option is true
                and membership.admin_option is false
           )
           and not exists (
             select
               from pg_catalog.pg_auth_members as membership
               join pg_catalog.pg_roles as child
                 on child.oid = membership.member
               join pg_catalog.pg_roles as parent
                 on parent.oid = membership.roleid
              where child.rolname = session_user
                and parent.rolname <> 'emdo_app'
           )
           and pg_catalog.has_schema_privilege(
             session_user, 'emdo', 'USAGE'
           )
           and not pg_catalog.has_schema_privilege(
             session_user, 'emdo', 'CREATE'
           )
           and pg_catalog.has_function_privilege(
             session_user,
             pg_catalog.to_regprocedure(
               'emdo.read_agent_run_events(uuid,uuid,bigint,integer)'
             ),
             'EXECUTE'
           )
           and not pg_catalog.has_function_privilege(
             session_user,
             pg_catalog.to_regprocedure(
               'emdo.lock_current_authorization_scope(uuid,uuid,uuid)'
             ),
             'EXECUTE'
           )
           and exists (
             select
               from pg_catalog.pg_proc as routine
               join pg_catalog.pg_roles as owner
                 on owner.oid = routine.proowner
              where routine.oid = pg_catalog.to_regprocedure(
                      'emdo.read_agent_run_events(uuid,uuid,bigint,integer)'
                    )
                and routine.prosecdef is true
                and routine.provolatile = 'v'
                and routine.proconfig @> ARRAY[
                  'search_path=pg_catalog, emdo', 'row_security=on'
                ]::text[]
                and owner.rolname = 'emdo_manager_turn_executor'
                and owner.rolcanlogin is false
                and owner.rolinherit is false
                and owner.rolsuper is false
                and owner.rolbypassrls is false
                and owner.rolcreatedb is false
                and owner.rolcreaterole is false
                and owner.rolreplication is false
           )
           and not exists (
             select
               from pg_catalog.pg_auth_members as membership
               join pg_catalog.pg_roles as owner
                 on owner.oid = membership.member
                    or owner.oid = membership.roleid
              where owner.rolname = 'emdo_manager_turn_executor'
           )
           and pg_catalog.has_function_privilege(
             'emdo_manager_turn_executor',
             pg_catalog.to_regprocedure(
               'emdo.lock_current_authorization_scope(uuid,uuid,uuid)'
             ),
             'EXECUTE'
           )
           and not exists (
             select
               from (
                 values
                  ('emdo.manager_turns'),
                  ('emdo.agent_runs'),
                  ('emdo.agent_run_events')
               ) as required(relation_name)
               left join pg_catalog.pg_class as relation
                 on relation.oid = pg_catalog.to_regclass(
                   required.relation_name
                 )
              where relation.oid is null
                 or relation.relrowsecurity is not true
                 or relation.relforcerowsecurity is not true
                 or not pg_catalog.has_table_privilege(
                   'emdo_manager_turn_executor', relation.oid, 'SELECT'
                 )
           )
         ) as ready`,
      );
      ready = result.rows[0]?.ready === true;
    } catch {
      ready = false;
    }
    try {
      client.release(!ready);
    } catch {
      return false;
    }
    return ready;
  }
}

import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import { PostgresRunEventSource } from './run-event-source.js';

const ids = {
  user: '41000000-0000-4000-8000-000000000001',
  session: '41000000-0000-4000-8000-000000000002',
  request: '41000000-0000-4000-8000-000000000003',
  household: '41000000-0000-4000-8000-000000000004',
  grant: '41000000-0000-4000-8000-000000000005',
  run: '41000000-0000-4000-8000-000000000007',
  otherRun: '41000000-0000-4000-8000-000000000008',
} as const;

const principal = {
  userId: ids.user,
  sessionId: ids.session,
  householdId: ids.household,
  role: 'owner' as const,
  emailVerified: true as const,
  spaceAccessGrantId: ids.grant,
  collectionAuthorizationScopeFingerprint: 'a'.repeat(64),
};

const poolFor = (
  respond: (
    sql: string,
    values: readonly unknown[] | undefined,
  ) => readonly Record<string, unknown>[],
) => {
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => ({
    rowCount: 1,
    rows: respond(sql, values),
  }));
  const release = vi.fn();
  const client: DatabaseClient = { query, release };
  const pool: DatabasePool = { connect: vi.fn(async () => client) };
  return { pool, query, release };
};

const collect = async <Value>(iterable: AsyncIterable<Value>) => {
  const values: Value[] = [];
  for await (const value of iterable) values.push(value);
  return values;
};

const event = (runId: string, sequence: number) => ({
  schemaVersion: 1,
  runId,
  sequence,
  type: sequence === 4 ? 'response.delta' : 'response.completed',
  occurredAt: `2026-08-13T12:00:0${sequence - 4}.000Z`,
  data: { text: `event-${sequence}` },
});

const open = (source: PostgresRunEventSource, abortSignal: AbortSignal) =>
  source.open({
    runId: ids.run,
    afterSequence: 3,
    principal,
    requestId: ids.request,
    abortSignal,
  });

describe('PostgresRunEventSource', () => {
  it('replays a finite page through the fresh-grant database aggregate', async () => {
    const { pool, query } = poolFor((sql) =>
      sql.includes('read_agent_run_events')
        ? [
            {
              run_event_result: {
                schemaVersion: 1,
                events: [event(ids.run, 4)],
              },
            },
          ]
        : [],
    );
    const source = new PostgresRunEventSource(pool);

    await expect(
      open(source, new AbortController().signal).then(collect),
    ).resolves.toEqual([event(ids.run, 4)]);
    const eventQuery = query.mock.calls.find(([sql]) =>
      sql.includes('read_agent_run_events'),
    );
    expect(eventQuery?.[1]).toEqual([ids.grant, ids.run, 3, 250]);
    expect(
      query.mock.calls.some(([sql]) =>
        sql.includes('from emdo.agent_run_events'),
      ),
    ).toBe(false);
  });

  it('stops yielding immediately when the request is aborted', async () => {
    const { pool } = poolFor((sql) =>
      sql.includes('read_agent_run_events')
        ? [
            {
              run_event_result: {
                schemaVersion: 1,
                events: [event(ids.run, 4), event(ids.run, 5)],
              },
            },
          ]
        : [],
    );
    const controller = new AbortController();
    const iterable = await open(
      new PostgresRunEventSource(pool),
      controller.signal,
    );
    const iterator = iterable[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { sequence: 4 },
    });
    controller.abort();
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it('caps one finite replay at 1,000 events across bounded pages', async () => {
    const { pool, query } = poolFor((sql, values) => {
      if (!sql.includes('read_agent_run_events')) return [];
      const afterSequence = Number(values?.[2]);
      const limit = Number(values?.[3]);
      return [
        {
          run_event_result: {
            schemaVersion: 1,
            events: Array.from({ length: limit }, (_, index) => ({
              schemaVersion: 1,
              runId: ids.run,
              sequence: afterSequence + index + 1,
              type: 'response.delta',
              occurredAt: '2026-08-13T12:00:00.000Z',
              data: { index },
            })),
          },
        },
      ];
    });
    const replay = await new PostgresRunEventSource(pool).open({
      runId: ids.run,
      afterSequence: 0,
      principal,
      requestId: ids.request,
      abortSignal: new AbortController().signal,
    });

    const events = await collect(replay);
    expect(events).toHaveLength(1_000);
    expect(events.at(-1)?.sequence).toBe(1_000);
    expect(
      query.mock.calls.filter(([sql]) => sql.includes('read_agent_run_events')),
    ).toHaveLength(4);
  });

  it('fails closed when the aggregate returns a cross-run event', async () => {
    const { pool } = poolFor((sql) =>
      sql.includes('read_agent_run_events')
        ? [
            {
              run_event_result: {
                schemaVersion: 1,
                events: [event(ids.otherRun, 4)],
              },
            },
          ]
        : [],
    );

    await expect(
      open(new PostgresRunEventSource(pool), new AbortController().signal).then(
        collect,
      ),
    ).rejects.toThrow('invalid run event');
  });

  it('denies replay when the fresh grant is stale or wrong', async () => {
    const { pool, query } = poolFor((sql) =>
      sql.includes('read_agent_run_events') ? [{ run_event_result: null }] : [],
    );

    await expect(
      open(new PostgresRunEventSource(pool), new AbortController().signal).then(
        collect,
      ),
    ).rejects.toThrow('active request grant');
    expect(
      query.mock.calls.find(([sql]) =>
        sql.includes('read_agent_run_events'),
      )?.[1]?.[0],
    ).toBe(ids.grant);
  });

  it('rejects malformed authority before opening a database connection', async () => {
    const { pool } = poolFor(() => []);
    const source = new PostgresRunEventSource(pool);

    await expect(
      source.open({
        runId: ids.run,
        afterSequence: 0,
        principal: { ...principal, emailVerified: false } as never,
        requestId: ids.request,
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('proves the exact isolated aggregate and denies direct scope-helper use', async () => {
    const { pool, query, release } = poolFor((sql) =>
      sql.includes('run_event_source_ready') ? [{ ready: true }] : [],
    );
    const source = new PostgresRunEventSource(pool);

    await expect(source.check()).resolves.toBe(true);
    const readinessSql = query.mock.calls[0]?.[0] ?? '';
    expect(readinessSql).toContain("session_user = 'emdo_api_login'");
    expect(readinessSql).toContain("pg_has_role(session_user, 'emdo_app'");
    expect(readinessSql).toContain('emdo.read_agent_run_events');
    expect(readinessSql).toContain(
      'emdo.lock_current_authorization_scope(uuid,uuid,uuid)',
    );
    expect(readinessSql).toContain('not pg_catalog.has_function_privilege');
    expect(readinessSql).toContain('emdo_manager_turn_executor');
    expect(readinessSql).toContain('search_path=pg_catalog, emdo');
    expect(readinessSql).toContain('row_security=on');
    expect(readinessSql).toContain('emdo.manager_turns');
    expect(readinessSql).toContain('relforcerowsecurity');
    expect(release).toHaveBeenCalledWith(false);
  });

  it('fails readiness closed and destroys a drifted connection', async () => {
    const { pool, release } = poolFor((sql) =>
      sql.includes('run_event_source_ready') ? [{ ready: 'true' }] : [],
    );

    await expect(new PostgresRunEventSource(pool).check()).resolves.toBe(false);
    expect(release).toHaveBeenCalledWith(true);
  });
});

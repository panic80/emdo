import { describe, expect, it, vi } from 'vitest';

import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import {
  hashProposalQueryBinding,
  PostgresProposalApprovalError,
  PostgresProposalQueryRepository,
} from './postgres-proposal-query-repository.js';
import { ProposalQueryCursorCodec } from './proposal-query-cursor-codec.js';

const ids = {
  user: '93000000-0000-4000-8000-000000000001',
  session: '93000000-0000-4000-8000-000000000002',
  request: '93000000-0000-4000-8000-000000000003',
  household: '93000000-0000-4000-8000-000000000004',
  spaceGrant: '93000000-0000-4000-8000-000000000005',
  nextSpaceGrant: '93000000-0000-4000-8000-000000000006',
  proposal: '93000000-0000-4000-8000-000000000007',
  nextProposal: '93000000-0000-4000-8000-000000000008',
} as const;

const authorizationScopeFingerprint =
  EffectiveAuthorizationScopeFingerprintSchema.parse('a'.repeat(64));
const principal = (spaceAccessGrantId: string = ids.spaceGrant) => ({
  userId: ids.user,
  sessionId: ids.session,
  householdId: ids.household,
  role: 'member' as const,
  emailVerified: true as const,
  spaceAccessGrantId,
  collectionAuthorizationScopeFingerprint: authorizationScopeFingerprint,
});
const approvalDisplay = {
  schemaVersion: 1,
  title: 'Create calendar event',
  summary: 'Review a proposed Google Calendar event creation.',
  beforeSummary: 'No existing calendar event.',
  afterSummary: 'Dentist checkup',
  fields: [
    { label: 'Event', value: 'Dentist checkup' },
    { label: 'Starts', value: '2026-08-12T13:00:00.000Z' },
    { label: 'Ends', value: '2026-08-12T14:00:00.000Z' },
    { label: 'Time zone', value: 'America/Toronto' },
    { label: 'Location', value: 'Clinic' },
    { label: 'Attendee notifications', value: 'Will not be sent.' },
  ],
} as const;
const source = {
  id: ids.proposal,
  version: 4,
  state: 'pending',
  capabilityId: 'google-calendar.event.create',
  payloadHash: 'b'.repeat(64),
  approvalHash: 'c'.repeat(64),
  approvalDisplay,
  createdAt: '2026-08-10T14:00:00.000Z',
  expiresAt: '2026-08-10T14:10:00.000Z',
} as const;
const expectedListItem = {
  id: ids.proposal,
  version: 4,
  state: 'pending',
  kind: 'google-calendar.event.create',
  title: 'Create calendar event',
  summary: 'Review a proposed Google Calendar event creation.',
  createdAt: source.createdAt,
  expiresAt: source.expiresAt,
} as const;

const cursorCodec = (clock = () => new Date('2026-08-10T14:01:00.000Z')) =>
  new ProposalQueryCursorCodec({
    current: {
      keyId: 'proposal-cursor-2026-08-a',
      secret: new Uint8Array(32).fill(6),
    },
    previous: [],
    cursorLifetimeMs: 300_000,
    clock,
  });

const poolFor = (
  respond: (
    sql: string,
    values: readonly unknown[],
  ) => readonly Record<string, unknown>[],
) => {
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    const rows = respond(sql, values);
    return { rowCount: rows.length, rows };
  });
  const release = vi.fn();
  const client: DatabaseClient = { query, release };
  const pool: DatabasePool = { connect: vi.fn(async () => client) };
  return { pool, query, release };
};

const okListResult = (
  sources: readonly unknown[],
  hasMore: boolean,
  scope: string = authorizationScopeFingerprint,
) => ({
  status: 'ok',
  page: {
    schemaVersion: 1,
    authorizationScopeFingerprint: scope,
    sources,
    hasMore,
  },
});

describe('PostgresProposalQueryRepository', () => {
  it('reports ready only when the API login can execute the exact query functions', async () => {
    const { pool, query, release } = poolFor((sql) =>
      sql.includes('to_regprocedure') ? [{ ready: true }] : [],
    );
    const repository = new PostgresProposalQueryRepository(pool, cursorCodec());

    await expect(repository.check()).resolves.toBe(true);
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain('has_function_privilege');
    expect(query.mock.calls[0]?.[0]).toMatch(/\bcoalesce\(/u);
    expect(query.mock.calls[0]?.[0]).not.toContain('pg_catalog.coalesce');
    expect(query.mock.calls[0]?.[1]).toEqual([
      [
        'emdo.list_proposal_approval_sources(uuid,uuid,text,text,timestamptz,uuid,integer)',
        'emdo.get_proposal_approval_source(uuid,uuid,uuid)',
      ],
    ]);
    expect(query.mock.calls[0]?.[0]).not.toMatch(
      /\b(?:insert|update|delete|set_config)\b/iu,
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing privilege', [{ ready: false }]],
    ['malformed result', [{ ready: 'true' }]],
    ['missing result', []],
  ])('fails readiness closed for %s', async (_name, rows) => {
    const { pool, release } = poolFor((sql) =>
      sql.includes('to_regprocedure') ? rows : [],
    );
    const repository = new PostgresProposalQueryRepository(pool, cursorCodec());

    await expect(repository.check()).resolves.toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it('fails readiness closed when the database probe throws', async () => {
    const release = vi.fn();
    const pool: DatabasePool = {
      connect: vi.fn(async () => ({
        query: vi.fn(async () => {
          throw new Error('database unavailable');
        }),
        release,
      })),
    };
    const repository = new PostgresProposalQueryRepository(pool, cursorCodec());

    await expect(repository.check()).resolves.toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it('projects a first page and signs its stable DB-authorized keyset cursor', async () => {
    const { pool, query, release } = poolFor((sql) =>
      sql.includes('list_proposal_approval_sources')
        ? [{ result: okListResult([source], true) }]
        : [],
    );
    const codec = cursorCodec();
    const repository = new PostgresProposalQueryRepository(pool, codec);

    const result = await repository.list({
      state: 'pending',
      limit: 25,
      principal: principal(),
      requestId: ids.request,
    });

    expect(result).toMatchObject({
      status: 'ok',
      page: { schemaVersion: 1, items: [expectedListItem] },
    });
    if (result.status !== 'ok' || result.page.nextCursor === undefined) {
      throw new Error('expected paginated proposal result');
    }
    expect(
      codec.verify(result.page.nextCursor, {
        userId: ids.user,
        sessionId: ids.session,
        householdId: ids.household,
        authorizationScopeFingerprint,
        state: 'pending',
      }),
    ).toEqual({
      position: { createdAt: source.createdAt, id: ids.proposal },
    });
    const projectionCall = query.mock.calls.find(([sql]) =>
      sql.includes('list_proposal_approval_sources'),
    );
    expect(projectionCall?.[1]).toEqual([
      ids.household,
      ids.spaceGrant,
      'pending',
      hashProposalQueryBinding({
        authorizationScopeFingerprint,
        state: 'pending',
      }),
      null,
      null,
      25,
    ]);
    expect(
      query.mock.calls.some(([sql]) => sql.includes('action_proposals')),
    ).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it('verifies a cursor before SQL and asks the fresh grant to re-prove its stable scope', async () => {
    const codec = cursorCodec();
    const cursor = codec.issue({
      userId: ids.user,
      sessionId: ids.session,
      householdId: ids.household,
      authorizationScopeFingerprint,
      state: 'pending',
      position: { createdAt: source.createdAt, id: ids.proposal },
    });
    const nextSource = {
      ...source,
      id: ids.nextProposal,
      createdAt: '2026-08-10T13:59:00.000Z',
    };
    const { pool, query } = poolFor((sql) =>
      sql.includes('list_proposal_approval_sources')
        ? [{ result: okListResult([nextSource], false) }]
        : [],
    );

    await expect(
      new PostgresProposalQueryRepository(pool, codec).list({
        state: 'pending',
        cursor,
        limit: 25,
        principal: principal(ids.nextSpaceGrant),
        requestId: ids.request,
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      page: { items: [{ id: ids.nextProposal }], nextCursor: undefined },
    });
    expect(
      query.mock.calls.find(([sql]) =>
        sql.includes('list_proposal_approval_sources'),
      )?.[1],
    ).toEqual([
      ids.household,
      ids.nextSpaceGrant,
      'pending',
      hashProposalQueryBinding({
        authorizationScopeFingerprint,
        state: 'pending',
      }),
      source.createdAt,
      ids.proposal,
      25,
    ]);
  });

  it('collapses malformed, tampered, expired, and principal-bound cursor failures without SQL', async () => {
    const valid = cursorCodec().issue({
      userId: ids.user,
      sessionId: ids.session,
      householdId: ids.household,
      authorizationScopeFingerprint,
      state: 'pending',
      position: { createdAt: source.createdAt, id: ids.proposal },
    });
    const cursorInputs = [
      '\u0000not-a-cursor',
      `${valid.slice(0, -1)}${valid.endsWith('A') ? 'B' : 'A'}`,
      valid,
    ];

    for (const [index, cursor] of cursorInputs.entries()) {
      const { pool } = poolFor(() => []);
      const repository = new PostgresProposalQueryRepository(
        pool,
        index === 2
          ? cursorCodec(() => new Date('2026-08-10T14:06:00.000Z'))
          : cursorCodec(),
      );
      await expect(
        repository.list({
          state: index === 1 ? 'approved' : 'pending',
          cursor,
          limit: 25,
          principal: principal(),
          requestId: ids.request,
        }),
      ).resolves.toEqual({ status: 'invalid-cursor' });
      expect(pool.connect).not.toHaveBeenCalled();
    }
  });

  it('preserves a locked SQL authorization-scope mismatch as invalid-cursor', async () => {
    const codec = cursorCodec();
    const cursor = codec.issue({
      userId: ids.user,
      sessionId: ids.session,
      householdId: ids.household,
      authorizationScopeFingerprint,
      state: 'pending',
      position: { createdAt: source.createdAt, id: ids.proposal },
    });
    const { pool } = poolFor((sql) =>
      sql.includes('list_proposal_approval_sources')
        ? [{ result: { status: 'invalid-cursor' } }]
        : [],
    );

    await expect(
      new PostgresProposalQueryRepository(pool, codec).list({
        state: 'pending',
        cursor,
        limit: 25,
        principal: principal(ids.nextSpaceGrant),
        requestId: ids.request,
      }),
    ).resolves.toEqual({ status: 'invalid-cursor' });
  });

  it.each([
    [
      'a repeated signed keyset position',
      [source],
      authorizationScopeFingerprint,
    ],
    [
      'a substituted authorization-scope fingerprint',
      [
        {
          ...source,
          id: ids.nextProposal,
          createdAt: '2026-08-10T13:59:00.000Z',
        },
      ],
      'd'.repeat(64),
    ],
  ])('rejects backend cursor invariant: %s', async (_name, sources, scope) => {
    const codec = cursorCodec();
    const cursor = codec.issue({
      userId: ids.user,
      sessionId: ids.session,
      householdId: ids.household,
      authorizationScopeFingerprint,
      state: 'pending',
      position: { createdAt: source.createdAt, id: ids.proposal },
    });
    const { pool } = poolFor((sql) =>
      sql.includes('list_proposal_approval_sources')
        ? [{ result: okListResult(sources, false, scope) }]
        : [],
    );

    await expect(
      new PostgresProposalQueryRepository(pool, codec).list({
        state: 'pending',
        cursor,
        limit: 25,
        principal: principal(ids.nextSpaceGrant),
        requestId: ids.request,
      }),
    ).rejects.toMatchObject({
      code: 'invalid-result',
    } satisfies Partial<PostgresProposalApprovalError>);
  });

  it('builds strict detail fields from immutable approval display only', async () => {
    const { pool } = poolFor((sql) =>
      sql.includes('get_proposal_approval_source')
        ? [{ result: { status: 'ok', source } }]
        : [],
    );

    await expect(
      new PostgresProposalQueryRepository(pool, cursorCodec()).getDetail({
        proposalId: ids.proposal,
        principal: principal(),
        requestId: ids.request,
      }),
    ).resolves.toEqual({
      ...expectedListItem,
      schemaVersion: 1,
      payloadHash: source.payloadHash,
      approvalHash: source.approvalHash,
      beforePreview: { summary: 'No existing calendar event.' },
      afterPreview: { summary: 'Dentist checkup' },
      fields: [
        { label: 'Event', value: 'Dentist checkup' },
        { label: 'Starts', value: '2026-08-12T13:00:00.000Z' },
        { label: 'Ends', value: '2026-08-12T14:00:00.000Z' },
        { label: 'Time zone', value: 'America/Toronto' },
        { label: 'Location', value: 'Clinic' },
        { label: 'Attendee notifications', value: 'Will not be sent.' },
      ],
    });
  });

  it.each([
    ['top-level provider material', { ...source, canonicalArguments: {} }],
    [
      'a raw preview sibling',
      { ...source, beforePreview: { summary: 'provider record' } },
    ],
    [
      'an extra approval-display key',
      {
        ...source,
        approvalDisplay: { ...approvalDisplay, providerSdkCallId: 'raw' },
      },
    ],
  ])('fails closed instead of projecting %s', async (_name, unsafeSource) => {
    const { pool } = poolFor((sql) =>
      sql.includes('get_proposal_approval_source')
        ? [{ result: { status: 'ok', source: unsafeSource } }]
        : [],
    );

    await expect(
      new PostgresProposalQueryRepository(pool, cursorCodec()).getDetail({
        proposalId: ids.proposal,
        principal: principal(),
        requestId: ids.request,
      }),
    ).rejects.toMatchObject({
      code: 'invalid-result',
    } satisfies Partial<PostgresProposalApprovalError>);
  });

  it('preserves legitimate hash-bound display text that resembles a token', async () => {
    const tokenLikeText = 'Bearer is the title of this user-authored note';
    const safeSource = {
      ...source,
      approvalDisplay: {
        ...approvalDisplay,
        afterSummary: tokenLikeText,
        fields: [{ label: 'Note', value: tokenLikeText }],
      },
    };
    const { pool } = poolFor((sql) =>
      sql.includes('get_proposal_approval_source')
        ? [{ result: { status: 'ok', source: safeSource } }]
        : [],
    );

    await expect(
      new PostgresProposalQueryRepository(pool, cursorCodec()).getDetail({
        proposalId: ids.proposal,
        principal: principal(),
        requestId: ids.request,
      }),
    ).resolves.toMatchObject({
      afterPreview: { summary: tokenLikeText },
      fields: [{ label: 'Note', value: tokenLikeText }],
    });
  });

  it('returns undefined when the scoped detail function cannot see the proposal', async () => {
    const { pool } = poolFor((sql) =>
      sql.includes('get_proposal_approval_source')
        ? [{ result: { status: 'not-found' } }]
        : [],
    );

    await expect(
      new PostgresProposalQueryRepository(pool, cursorCodec()).getDetail({
        proposalId: ids.proposal,
        principal: principal(),
        requestId: ids.request,
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    [
      'a state outside the requested filter',
      [{ ...source, state: 'approved' }],
      false,
      2,
    ],
    [
      'more rows than requested',
      [source, { ...source, id: ids.nextProposal }],
      false,
      1,
    ],
    ['duplicate proposal IDs', [source, source], false, 2],
    [
      'unstable descending order',
      [
        { ...source, createdAt: '2026-08-10T13:59:00.000Z' },
        { ...source, id: ids.nextProposal },
      ],
      false,
      2,
    ],
    ['an empty page claiming more rows', [], true, 2],
  ])(
    'rejects backend list invariant: %s',
    async (_name, sources, hasMore, limit) => {
      const { pool } = poolFor((sql) =>
        sql.includes('list_proposal_approval_sources')
          ? [{ result: okListResult(sources, hasMore) }]
          : [],
      );

      await expect(
        new PostgresProposalQueryRepository(pool, cursorCodec()).list({
          state: 'pending',
          limit,
          principal: principal(),
          requestId: ids.request,
        }),
      ).rejects.toMatchObject({
        code: 'invalid-result',
      } satisfies Partial<PostgresProposalApprovalError>);
    },
  );
});

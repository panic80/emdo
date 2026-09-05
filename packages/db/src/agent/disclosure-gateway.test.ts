import { createHash } from 'node:crypto';

import { AgentInvocationContextSchema } from '@emdo/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import {
  CanonicalRecordEnvelopeDisclosureFilter,
  hashDataDisclosureGrant,
  PostgresDataDisclosureGrantIssuer,
  PostgresModelDisclosureGateway,
  PostgresSchedulerDisclosureGrantResolver,
} from './disclosure-gateway.js';

const ids = {
  grantId: '82000000-0000-4000-8000-000000000001',
  userId: '82000000-0000-4000-8000-000000000002',
  sessionId: '82000000-0000-4000-8000-000000000003',
  requestId: '82000000-0000-4000-8000-000000000004',
  householdId: '82000000-0000-4000-8000-000000000005',
  runId: '82000000-0000-4000-8000-000000000006',
  spaceId: '82000000-0000-4000-8000-000000000007',
  spaceAccessGrantId: '82000000-0000-4000-8000-000000000008',
  rootManagerInvocationId: '82000000-0000-4000-8000-000000000009',
  financeAgentInvocationId: '82000000-0000-4000-8000-00000000000a',
  financePhaseInvocationId: '82000000-0000-4000-8000-00000000000b',
  schedulerAgentInvocationId: '82000000-0000-4000-8000-00000000000c',
  schedulerPhaseInvocationId: '82000000-0000-4000-8000-00000000000d',
};

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
};

const hash = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');

const invocationContextFor = (
  agentId: 'finance' | 'scheduler',
  agentInvocationId: string,
  phaseInvocationId: string,
  record: { readonly dataClass: string; readonly recordId: string },
) => {
  const disclosedContextRefs = [
    `context-ref-${hash({
      dataClass: record.dataClass,
      recordId: record.recordId,
    })}`,
  ];
  const grantedCapabilities =
    agentId === 'finance'
      ? [
          'finance.documents.search',
          'finance.records.read',
          'finance.records.write',
          'finance.statement.import',
        ]
      : ['google-calendar.event.create'];
  return {
    orchestrationRunId: ids.runId,
    parentInvocationId: ids.rootManagerInvocationId,
    agentInvocationId,
    phaseInvocationId,
    actorId: ids.userId,
    locale: 'en-CA' as const,
    grantedCapabilities,
    disclosedContextRefs,
    deadline: '2026-08-10T12:10:00.000Z',
    idempotencyScope: hash({
      domain: 'emdo.agent-invocation-scope.v1',
      agentId,
      orchestrationRunId: ids.runId,
      parentInvocationId: ids.rootManagerInvocationId,
      agentInvocationId,
      phaseInvocationId,
      actorId: ids.userId,
      locale: 'en-CA',
      grantedCapabilities,
      disclosedContextRefs,
    }),
  };
};

const financeInvocationContext = invocationContextFor(
  'finance',
  ids.financeAgentInvocationId,
  ids.financePhaseInvocationId,
  { dataClass: 'finance.transactions', recordId: 'transaction-1' },
);
const schedulerInvocationContext = invocationContextFor(
  'scheduler',
  ids.schedulerAgentInvocationId,
  ids.schedulerPhaseInvocationId,
  { dataClass: 'agent.delegations', recordId: 'scheduler-delegation-1' },
);

const identityFor = (context: ReturnType<typeof invocationContextFor>) => ({
  orchestrationRunId: context.orchestrationRunId,
  parentInvocationId: context.parentInvocationId,
  agentInvocationId: context.agentInvocationId,
  phaseInvocationId: context.phaseInvocationId,
  actorId: context.actorId,
  locale: context.locale,
  grantedCapabilities: context.grantedCapabilities,
});

const resolvedGrant = {
  status: 'active',
  schema_version: 1,
  version: 3,
  grant_id: ids.grantId,
  household_id: ids.householdId,
  space_id: ids.spaceId,
  original_owner_user_id: ids.userId,
  run_id: ids.runId,
  agent_id: 'finance',
  purpose: 'Explain this run budget without unrelated private records.',
  phase_purpose: 'specialist-execution',
  provider: 'openai',
  record_allowlist: [
    {
      dataClass: 'finance.transactions',
      recordId: 'transaction-1',
      fields: ['amount-cad-minor', 'merchant'],
    },
  ],
  invocation_context: financeInvocationContext,
  invocation_context_hash: hash(financeInvocationContext),
  grant_hash: 'a'.repeat(64),
  created_at: new Date('2026-08-10T12:00:00.000Z'),
  expires_at: new Date('2026-08-10T12:10:00.000Z'),
  database_time: new Date('2026-08-10T12:02:00.000Z'),
};

const poolFor = (
  respond: (
    sql: string,
    values: readonly unknown[],
  ) => readonly Record<string, unknown>[],
) => {
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => ({
    rowCount: 1,
    rows: respond(sql, values),
  }));
  const client: DatabaseClient = { query, release: vi.fn() };
  const pool: DatabasePool = { connect: vi.fn(async () => client) };
  return { pool, query };
};

const authorizeInput = () => ({
  requestId: ids.requestId,
  runId: ids.runId,
  householdId: ids.householdId,
  userId: ids.userId,
  spaceAccessGrantId: ids.spaceAccessGrantId,
  agentId: 'finance',
  phasePurpose: 'specialist-execution' as const,
  phaseInvocationId: ids.financePhaseInvocationId,
  provider: 'openai' as const,
  invocation: identityFor(financeInvocationContext),
  requestedGrantId: ids.grantId,
  requestedDataClasses: ['finance.transactions'],
  payload: {
    schemaVersion: 1,
    records: [
      {
        dataClass: 'finance.transactions',
        recordId: 'transaction-1',
        fields: { merchant: 'Example Market', 'amount-cad-minor': 1_234 },
      },
    ],
  },
});

const principal = {
  userId: ids.userId,
  sessionId: ids.sessionId,
  requestId: ids.requestId,
  householdId: ids.householdId,
};

const schedulerGrant = {
  schemaVersion: 1 as const,
  id: ids.grantId,
  version: 3,
  userId: ids.userId,
  householdId: ids.householdId,
  agentId: 'scheduler',
  purpose: 'Generate one Calendar proposal from the delegated request.',
  runId: ids.runId,
  invocationContext: schedulerInvocationContext,
  invocationContextHash: hash(schedulerInvocationContext),
  recordAllowlist: [
    {
      dataClass: 'agent.delegations',
      recordId: 'scheduler-delegation-1',
      fields: ['delegation'],
    },
  ],
  provider: 'openai',
  createdAt: '2026-08-10T12:00:00.000Z',
  expiresAt: '2026-08-10T12:10:00.000Z',
  oneRunOnly: true as const,
};

const schedulerGrantResolution = {
  status: 'consumed',
  schema_version: 1,
  version: schedulerGrant.version,
  grant_id: schedulerGrant.id,
  household_id: schedulerGrant.householdId,
  space_id: ids.spaceId,
  original_owner_user_id: schedulerGrant.userId,
  run_id: schedulerGrant.runId,
  agent_id: schedulerGrant.agentId,
  purpose: schedulerGrant.purpose,
  phase_purpose: 'specialist-execution',
  provider: schedulerGrant.provider,
  record_allowlist: [
    {
      dataClass: 'agent.delegations',
      recordId: 'scheduler-delegation-1',
      fields: ['delegation'],
    },
  ],
  invocation_context: schedulerInvocationContext,
  invocation_context_hash: hash(schedulerInvocationContext),
  grant_hash: hashDataDisclosureGrant(schedulerGrant),
  created_at: new Date(schedulerGrant.createdAt),
  expires_at: new Date(schedulerGrant.expiresAt),
  database_time: new Date('2026-08-10T12:02:00.000Z'),
};

const financeGrant = {
  schemaVersion: 1 as const,
  id: ids.grantId,
  version: 3,
  userId: ids.userId,
  householdId: ids.householdId,
  agentId: 'finance' as const,
  purpose: 'Explain this run budget without unrelated private records.',
  runId: ids.runId,
  invocationContext: financeInvocationContext,
  invocationContextHash: hash(financeInvocationContext),
  recordAllowlist: [
    {
      dataClass: 'finance.transactions',
      recordId: 'transaction-1',
      fields: ['amount-cad-minor', 'merchant'],
    },
  ],
  provider: 'openai' as const,
  createdAt: '2026-08-10T12:00:00.000Z',
  expiresAt: '2026-08-10T12:10:00.000Z',
  oneRunOnly: true as const,
};

resolvedGrant.grant_hash = hashDataDisclosureGrant(financeGrant);

const financeGrantResolution = {
  ...resolvedGrant,
  status: 'consumed',
  record_allowlist: financeGrant.recordAllowlist,
  grant_hash: hashDataDisclosureGrant(financeGrant),
};

const schedulerResolverScope = {
  runId: ids.runId,
  householdId: ids.householdId,
  userId: ids.userId,
  spaceAccessGrantId: ids.spaceAccessGrantId,
  agentId: 'scheduler' as const,
  phasePurpose: 'specialist-execution' as const,
  provider: 'openai' as const,
};

it('keeps the registered invocation fixtures contract-valid', () => {
  expect(
    AgentInvocationContextSchema.safeParse(financeInvocationContext).success,
  ).toBe(true);
  expect(
    AgentInvocationContextSchema.safeParse(schedulerInvocationContext).success,
  ).toBe(true);
});

describe('PostgresModelDisclosureGateway', () => {
  it('returns only a canonical record envelope after a durable active-grant recheck and audit commit', async () => {
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('resolve_model_disclosure_grant'))
        return [resolvedGrant];
      if (sql.includes('commit_model_disclosure_authorization')) {
        return [
          {
            committed: true,
            database_time: new Date('2026-08-10T12:02:01.000Z'),
            expires_at: resolvedGrant.expires_at,
          },
        ];
      }
      return [];
    });
    const gateway = new PostgresModelDisclosureGateway(
      pool,
      principal,
      new CanonicalRecordEnvelopeDisclosureFilter(),
    );

    await expect(gateway.authorize(authorizeInput())).resolves.toEqual({
      status: 'authorized',
      grantId: ids.grantId,
      grantVersion: '3.0.0',
      runId: ids.runId,
      householdId: ids.householdId,
      userId: ids.userId,
      agentId: 'finance',
      phasePurpose: 'specialist-execution',
      phaseInvocationId: ids.financePhaseInvocationId,
      invocationContext: financeInvocationContext,
      invocationContextHash: hash(financeInvocationContext),
      disclosurePurpose:
        'Explain this run budget without unrelated private records.',
      provider: 'openai',
      expiresAt: '2026-08-10T12:10:00.000Z',
      records: [
        {
          dataClass: 'finance.transactions',
          recordId: 'transaction-1',
          fields: ['amount-cad-minor', 'merchant'],
        },
      ],
      payload: {
        schemaVersion: 1,
        records: [
          {
            dataClass: 'finance.transactions',
            recordId: 'transaction-1',
            fields: { 'amount-cad-minor': 1_234, merchant: 'Example Market' },
          },
        ],
      },
    });

    const commit = query.mock.calls.find(([sql]) =>
      sql.includes('commit_model_disclosure_authorization'),
    );
    expect(commit?.[1]).toEqual([
      ids.grantId,
      3,
      resolvedGrant.grant_hash,
      JSON.stringify(financeInvocationContext),
      hash(financeInvocationContext),
      ids.spaceAccessGrantId,
      'specialist-execution',
      JSON.stringify([
        {
          dataClass: 'finance.transactions',
          recordId: 'transaction-1',
          fields: ['amount-cad-minor', 'merchant'],
        },
      ]),
    ]);
  });

  it.each([
    ['grant-run-mismatch', 'grant-run-mismatch'],
    ['grant-expired', 'grant-expired'],
  ] as const)(
    'preserves the typed durable denial %s without model authorization',
    async (status, reason) => {
      const { pool, query } = poolFor((sql) =>
        sql.includes('resolve_model_disclosure_grant')
          ? [{ status, grant_id: ids.grantId }]
          : [],
      );
      const gateway = new PostgresModelDisclosureGateway(
        pool,
        principal,
        new CanonicalRecordEnvelopeDisclosureFilter(),
      );

      await expect(gateway.authorize(authorizeInput())).resolves.toEqual({
        status: 'denied',
        grantId: ids.grantId,
        reason,
      });
      expect(
        query.mock.calls.some(([sql]) =>
          sql.includes('commit_model_disclosure_authorization'),
        ),
      ).toBe(false);
    },
  );

  it('omits a grant ID only for a durable no-active-grant denial without a hint', async () => {
    const { pool } = poolFor((sql) =>
      sql.includes('resolve_model_disclosure_grant')
        ? [{ status: 'no-active-grant', grant_id: null }]
        : [],
    );
    const gateway = new PostgresModelDisclosureGateway(
      pool,
      principal,
      new CanonicalRecordEnvelopeDisclosureFilter(),
    );

    await expect(
      gateway.authorize({ ...authorizeInput(), requestedGrantId: undefined }),
    ).resolves.toEqual({
      status: 'denied',
      reason: 'no-active-grant',
    });
  });

  it('denies an arbitrary unannotated payload before the authorization audit commit', async () => {
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('resolve_model_disclosure_grant'))
        return [resolvedGrant];
      if (sql.includes('record_model_disclosure_denial')) {
        return [{ recorded: true }];
      }
      return [];
    });
    const gateway = new PostgresModelDisclosureGateway(
      pool,
      principal,
      new CanonicalRecordEnvelopeDisclosureFilter(),
    );

    await expect(
      gateway.authorize({
        ...authorizeInput(),
        payload: { merchant: 'Example Market', 'amount-cad-minor': 1_234 },
      }),
    ).resolves.toEqual({
      status: 'denied',
      grantId: ids.grantId,
      reason: 'record-not-allowed',
    });
    expect(
      query.mock.calls.some(([sql]) =>
        sql.includes('commit_model_disclosure_authorization'),
      ),
    ).toBe(false);
  });

  it('denies a canonical record containing a field beyond the durable allowlist', async () => {
    const { pool } = poolFor((sql) => {
      if (sql.includes('resolve_model_disclosure_grant'))
        return [resolvedGrant];
      if (sql.includes('record_model_disclosure_denial')) {
        return [{ recorded: true }];
      }
      return [];
    });
    const gateway = new PostgresModelDisclosureGateway(
      pool,
      principal,
      new CanonicalRecordEnvelopeDisclosureFilter(),
    );

    await expect(
      gateway.authorize({
        ...authorizeInput(),
        payload: {
          schemaVersion: 1,
          records: [
            {
              dataClass: 'finance.transactions',
              recordId: 'transaction-1',
              fields: {
                merchant: 'Example Market',
                'private-account-number': 'PRIVATE',
              },
            },
          ],
        },
      }),
    ).resolves.toEqual({
      status: 'denied',
      grantId: ids.grantId,
      reason: 'field-not-allowed',
    });
  });

  it('fails closed when the final DB-time authorization/audit recheck does not commit', async () => {
    const { pool } = poolFor((sql) => {
      if (sql.includes('resolve_model_disclosure_grant'))
        return [resolvedGrant];
      if (sql.includes('commit_model_disclosure_authorization')) return [];
      return [];
    });
    const gateway = new PostgresModelDisclosureGateway(
      pool,
      principal,
      new CanonicalRecordEnvelopeDisclosureFilter(),
    );

    await expect(gateway.authorize(authorizeInput())).resolves.toEqual({
      status: 'denied',
      grantId: ids.grantId,
      reason: 'grant-expired',
    });
  });
});

describe('PostgresSchedulerDisclosureGrantResolver', () => {
  it('returns only the exact consumed scheduler grant without recording another disclosure authorization or audit', async () => {
    const { pool, query } = poolFor((sql) =>
      sql.includes('resolve_consumed_disclosure_grant_for_proposal')
        ? [schedulerGrantResolution]
        : [],
    );
    const resolver = new PostgresSchedulerDisclosureGrantResolver(
      pool,
      principal,
      schedulerResolverScope,
    );

    const resolved = await resolver.resolve(ids.grantId, schedulerGrant);
    expect(query).toHaveBeenCalled();
    expect(resolved).toEqual(schedulerGrant);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('resolve_consumed_disclosure_grant_for_proposal'),
      [
        ids.grantId,
        ids.runId,
        ids.householdId,
        ids.userId,
        ids.spaceAccessGrantId,
        'scheduler',
        'specialist-execution',
        'openai',
        JSON.stringify(schedulerInvocationContext),
        hash(schedulerInvocationContext),
      ],
    );
    expect(
      query.mock.calls.some(([sql]) =>
        sql.includes('commit_model_disclosure_authorization'),
      ),
    ).toBe(false);
    expect(
      query.mock.calls.some(([sql]) =>
        sql.includes('record_model_disclosure_denial'),
      ),
    ).toBe(false);
  });

  it('resolves only the exact consumed Finance specialist grant', async () => {
    const { pool, query } = poolFor((sql) =>
      sql.includes('resolve_consumed_disclosure_grant_for_proposal')
        ? [financeGrantResolution]
        : [],
    );
    const resolver = new PostgresSchedulerDisclosureGrantResolver(
      pool,
      principal,
      {
        ...schedulerResolverScope,
        agentId: 'finance',
      },
    );

    await expect(resolver.resolve(ids.grantId, financeGrant)).resolves.toEqual(
      financeGrant,
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('resolve_consumed_disclosure_grant_for_proposal'),
      [
        ids.grantId,
        ids.runId,
        ids.householdId,
        ids.userId,
        ids.spaceAccessGrantId,
        'finance',
        'specialist-execution',
        'openai',
        JSON.stringify(financeInvocationContext),
        hash(financeInvocationContext),
      ],
    );
  });

  it('fails closed on a malformed consumed binding or a durable denial without recording authorization', async () => {
    const malformed = {
      ...schedulerGrantResolution,
      grant_hash: 'b'.repeat(64),
    };
    const malformedPool = poolFor((sql) =>
      sql.includes('resolve_consumed_disclosure_grant_for_proposal')
        ? [malformed]
        : [],
    );
    const malformedResolver = new PostgresSchedulerDisclosureGrantResolver(
      malformedPool.pool,
      principal,
      schedulerResolverScope,
    );
    await expect(
      malformedResolver.resolve(ids.grantId, schedulerGrant),
    ).rejects.toMatchObject({ code: 'invalid-result' });
    expect(
      malformedPool.query.mock.calls.some(([sql]) =>
        sql.includes('commit_model_disclosure_authorization'),
      ),
    ).toBe(false);

    const deniedPool = poolFor((sql) =>
      sql.includes('resolve_consumed_disclosure_grant_for_proposal')
        ? [{ status: 'grant-purpose-mismatch', grant_id: ids.grantId }]
        : [],
    );
    const deniedResolver = new PostgresSchedulerDisclosureGrantResolver(
      deniedPool.pool,
      principal,
      schedulerResolverScope,
    );
    await expect(
      deniedResolver.resolve(ids.grantId, schedulerGrant),
    ).resolves.toBeUndefined();
    expect(
      deniedPool.query.mock.calls.some(([sql]) =>
        sql.includes('record_model_disclosure_denial'),
      ),
    ).toBe(false);
  });

  it('rejects a resolver scope that is not fixed to the durable principal', () => {
    const { pool, query } = poolFor(() => []);
    expect(
      () =>
        new PostgresSchedulerDisclosureGrantResolver(pool, principal, {
          ...schedulerResolverScope,
          householdId: '82000000-0000-4000-8000-000000000099',
        }),
    ).toThrow(/active principal/i);
    expect(query).not.toHaveBeenCalled();
  });

  it.each(['manager', 'shopping', 'unknown'])(
    'fails closed for an unregistered specialist agent %s',
    (agentId) => {
      const { pool, query } = poolFor(() => []);
      expect(
        () =>
          new PostgresSchedulerDisclosureGrantResolver(pool, principal, {
            ...schedulerResolverScope,
            agentId,
          } as never),
      ).toThrow(/active principal/i);
      expect(query).not.toHaveBeenCalled();
    },
  );
});

describe('PostgresDataDisclosureGrantIssuer', () => {
  it('returns the canonical DB-created one-run grant and preserves its hash binding', async () => {
    const grant = {
      schemaVersion: 1 as const,
      id: ids.grantId,
      version: 1,
      userId: ids.userId,
      householdId: ids.householdId,
      agentId: 'finance',
      purpose: 'Explain this run budget without unrelated private records.',
      runId: ids.runId,
      invocationContext: financeInvocationContext,
      invocationContextHash: hash(financeInvocationContext),
      recordAllowlist: [
        {
          dataClass: 'finance.transactions',
          recordId: 'transaction-1',
          fields: ['amount-cad-minor', 'merchant'],
        },
      ],
      provider: 'openai',
      createdAt: '2026-08-10T12:00:00.000Z',
      expiresAt: '2026-08-10T12:10:00.000Z',
      oneRunOnly: true as const,
    };
    const issued = {
      schema_version: 1,
      version: 1,
      grant_id: ids.grantId,
      household_id: ids.householdId,
      space_id: ids.spaceId,
      original_owner_user_id: ids.userId,
      run_id: ids.runId,
      agent_id: 'finance',
      purpose: 'Explain this run budget without unrelated private records.',
      phase_purpose: 'specialist-execution',
      provider: 'openai',
      record_allowlist: [
        {
          dataClass: 'finance.transactions',
          recordId: 'transaction-1',
          fields: ['amount-cad-minor', 'merchant'],
        },
      ],
      invocation_context: financeInvocationContext,
      invocation_context_hash: hash(financeInvocationContext),
      grant_hash: hashDataDisclosureGrant(grant),
      one_run_only: true,
      created_at: new Date('2026-08-10T12:00:00.000Z'),
      expires_at: new Date('2026-08-10T12:10:00.000Z'),
      database_time: new Date('2026-08-10T12:00:00.000Z'),
    };
    const { pool, query } = poolFor((sql) =>
      sql.includes('issue_model_disclosure_grant') ? [issued] : [],
    );
    const issuer = new PostgresDataDisclosureGrantIssuer(pool, principal);

    const result = await issuer.issue({
      requestId: ids.requestId,
      runId: ids.runId,
      householdId: ids.householdId,
      userId: ids.userId,
      spaceId: ids.spaceId,
      spaceAccessGrantId: ids.spaceAccessGrantId,
      agentId: 'finance',
      phasePurpose: 'specialist-execution',
      disclosurePurpose:
        'Explain this run budget without unrelated private records.',
      provider: 'openai',
      invocation: identityFor(financeInvocationContext),
      recordAllowlist: [
        {
          dataClass: 'finance.transactions',
          recordId: 'transaction-1',
          fields: ['amount-cad-minor', 'merchant'],
        },
      ],
    });

    expect(result.grant).toEqual(grant);
    expect(result.spaceId).toBe(ids.spaceId);
    expect(result.phasePurpose).toBe('specialist-execution');
    expect(result.grantHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(query.mock.calls).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          expect.stringContaining('issue_model_disclosure_grant'),
          [
            ids.runId,
            ids.householdId,
            ids.userId,
            ids.spaceId,
            ids.spaceAccessGrantId,
            'finance',
            'specialist-execution',
            'Explain this run budget without unrelated private records.',
            'openai',
            JSON.stringify(identityFor(financeInvocationContext)),
            JSON.stringify([
              {
                dataClass: 'finance.transactions',
                recordId: 'transaction-1',
                fields: ['amount-cad-minor', 'merchant'],
              },
            ]),
          ],
        ]),
      ]),
    );
  });

  it('rejects issuance that is not bound to the active request principal', async () => {
    const { pool, query } = poolFor(() => []);
    const issuer = new PostgresDataDisclosureGrantIssuer(pool, principal);

    await expect(
      issuer.issue({
        requestId: '82000000-0000-4000-8000-000000000099',
        runId: ids.runId,
        householdId: ids.householdId,
        userId: ids.userId,
        spaceId: ids.spaceId,
        spaceAccessGrantId: ids.spaceAccessGrantId,
        agentId: 'finance',
        phasePurpose: 'specialist-execution',
        disclosurePurpose: 'Explain only the approved finance records.',
        provider: 'openai',
        invocation: identityFor(financeInvocationContext),
        recordAllowlist: [
          {
            dataClass: 'finance.transactions',
            recordId: 'transaction-1',
            fields: ['merchant'],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    expect(query).not.toHaveBeenCalled();
  });
});

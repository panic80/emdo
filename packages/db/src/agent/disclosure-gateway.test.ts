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
};

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
  provider: 'openai',
  record_allowlist: [
    {
      dataClass: 'finance.transactions',
      recordId: 'transaction-1',
      fields: ['merchant', 'amount-cad-minor'],
    },
  ],
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
  provider: 'openai' as const,
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
  status: 'active',
  schema_version: 1,
  version: schedulerGrant.version,
  grant_id: schedulerGrant.id,
  household_id: schedulerGrant.householdId,
  space_id: ids.spaceId,
  original_owner_user_id: schedulerGrant.userId,
  run_id: schedulerGrant.runId,
  agent_id: schedulerGrant.agentId,
  purpose: schedulerGrant.purpose,
  provider: schedulerGrant.provider,
  record_allowlist: [
    {
      dataClass: 'agent.delegations',
      recordId: 'scheduler-delegation-1',
      fields: ['delegation'],
    },
  ],
  grant_hash: hashDataDisclosureGrant(schedulerGrant),
  created_at: new Date(schedulerGrant.createdAt),
  expires_at: new Date(schedulerGrant.expiresAt),
  database_time: new Date('2026-08-10T12:02:00.000Z'),
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
  it('returns only the exact active scheduler grant without recording disclosure authorization or audit', async () => {
    const { pool, query } = poolFor((sql) =>
      sql.includes('resolve_model_disclosure_grant')
        ? [schedulerGrantResolution]
        : [],
    );
    const resolver = new PostgresSchedulerDisclosureGrantResolver(
      pool,
      principal,
      schedulerResolverScope,
    );

    await expect(resolver.resolve(ids.grantId)).resolves.toEqual(
      schedulerGrant,
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('resolve_model_disclosure_grant'),
      [
        ids.grantId,
        ids.runId,
        ids.householdId,
        ids.userId,
        ids.spaceAccessGrantId,
        'scheduler',
        'specialist-execution',
        'openai',
        '[]',
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

  it('fails closed on a malformed active binding or a durable denial without recording authorization', async () => {
    const malformed = {
      ...schedulerGrantResolution,
      grant_hash: 'b'.repeat(64),
    };
    const malformedPool = poolFor((sql) =>
      sql.includes('resolve_model_disclosure_grant') ? [malformed] : [],
    );
    const malformedResolver = new PostgresSchedulerDisclosureGrantResolver(
      malformedPool.pool,
      principal,
      schedulerResolverScope,
    );
    await expect(
      malformedResolver.resolve(ids.grantId),
    ).rejects.toMatchObject({ code: 'invalid-result' });
    expect(
      malformedPool.query.mock.calls.some(([sql]) =>
        sql.includes('commit_model_disclosure_authorization'),
      ),
    ).toBe(false);

    const deniedPool = poolFor((sql) =>
      sql.includes('resolve_model_disclosure_grant')
        ? [{ status: 'grant-purpose-mismatch', grant_id: ids.grantId }]
        : [],
    );
    const deniedResolver = new PostgresSchedulerDisclosureGrantResolver(
      deniedPool.pool,
      principal,
      schedulerResolverScope,
    );
    await expect(deniedResolver.resolve(ids.grantId)).resolves.toBeUndefined();
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
      recordAllowlist: [
        {
          dataClass: 'finance.transactions',
          recordId: 'transaction-1',
          fields: ['merchant', 'amount-cad-minor'],
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
            JSON.stringify([
              {
                dataClass: 'finance.transactions',
                recordId: 'transaction-1',
                fields: ['merchant', 'amount-cad-minor'],
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

import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import {
  PostgresProposalApprovalError,
  PostgresVisualDecisionProofStore,
  hashVisualDecisionProofToken,
} from './postgres-visual-decision-proof-store.js';
import { VisualDecisionProofTokenCodec } from './visual-decision-proof-token-codec.js';

const ids = {
  user: '94000000-0000-4000-8000-000000000001',
  session: '94000000-0000-4000-8000-000000000002',
  request: '94000000-0000-4000-8000-000000000003',
  replayRequest: '94000000-0000-4000-8000-000000000004',
  household: '94000000-0000-4000-8000-000000000005',
  spaceGrant: '94000000-0000-4000-8000-000000000006',
  replaySpaceGrant: '94000000-0000-4000-8000-000000000007',
  proposal: '94000000-0000-4000-8000-000000000008',
  proofA: '94000000-0000-4000-8000-000000000009',
  proofB: '94000000-0000-4000-8000-000000000010',
  proofC: '94000000-0000-4000-8000-000000000011',
} as const;

const payloadHash = 'c'.repeat(64);
const approvalHash = 'd'.repeat(64);
const issuanceFingerprint = 'e'.repeat(64);
const authorizationScopeFingerprint = 'f'.repeat(64);
const collectionAuthorizationScopeFingerprint =
  EffectiveAuthorizationScopeFingerprintSchema.parse('a'.repeat(64));
const idempotencyKey = 'visual-proof:proposal:calendar-create';
const hmacKey = {
  keyId: 'visual-proof-2026-08-a',
  secret: new Uint8Array(32).fill(7),
} as const;
const issuedAt = '2026-08-10T14:01:00.000Z';
const expiresAt = '2026-08-10T14:03:00.000Z';
const proposalExpiresAt = '2026-08-10T14:10:00.000Z';

const principal = (spaceAccessGrantId: string = ids.spaceGrant) => ({
  userId: ids.user,
  sessionId: ids.session,
  householdId: ids.household,
  role: 'member' as const,
  emailVerified: true as const,
  spaceAccessGrantId,
  collectionAuthorizationScopeFingerprint,
});

const input = (
  requestId: string = ids.request,
  spaceAccessGrantId: string = ids.spaceGrant,
) => ({
  proposalId: ids.proposal,
  expectedProposalVersion: 4,
  expectedPayloadHash: payloadHash,
  expectedApprovalHash: approvalHash,
  principal: principal(spaceAccessGrantId),
  requestId,
  idempotencyKey,
});

const codecFor = (
  proofIds: string[] = [ids.proofA],
  nonces: string[] = ['A'.repeat(43)],
) =>
  new VisualDecisionProofTokenCodec({
    current: hmacKey,
    previous: [],
    clock: () => new Date(issuedAt),
    generateProofId: () => proofIds.shift()!,
    generateNonce: () => nonces.shift()!,
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
  const pool: DatabasePool = {
    connect: vi.fn(async () => {
      const client: DatabaseClient = { query, release };
      return client;
    }),
  };
  return { pool, query, release };
};

const seedFromPrepare = (values: readonly unknown[]) => ({
  proofId: values[7] as string,
  nonce: values[8] as string,
  keyId: values[9] as string,
});

const proof = (replayed: boolean) => ({
  schemaVersion: 1,
  proposalId: ids.proposal,
  proposalVersion: 4,
  payloadHash,
  approvalHash,
  issuedAt,
  expiresAt,
  replayed,
});

const binding = {
  bindingVersion: 1,
  issuanceFingerprint,
  authorizationScopeFingerprint,
  initialRequestId: ids.request,
} as const;

const preparedResult = (
  replayed: boolean,
  tokenMaterial: Readonly<Record<string, unknown>>,
) => ({
  status: 'prepared',
  proof: proof(replayed),
  proposalExpiresAt,
  binding,
  tokenMaterial,
});

const committedResult = (
  replayed: boolean,
  tokenMaterial: Readonly<Record<string, unknown>>,
) => ({
  status: 'issued',
  proof: proof(replayed),
  tokenMaterial,
});

const tokenBinding = () => ({
  ...binding,
  issuedAt,
  expiresAt,
  userId: ids.user,
  sessionId: ids.session,
  householdId: ids.household,
  proposalId: ids.proposal,
  proposalVersion: 4,
  payloadHash,
  approvalHash,
  channel: 'authenticated-visual' as const,
  idempotencyKey,
});

describe('PostgresVisualDecisionProofStore', () => {
  it('reports ready only when the API login can execute prepare and finalize', async () => {
    const { pool, query, release } = poolFor((sql) =>
      sql.includes('to_regprocedure') ? [{ ready: true }] : [],
    );
    const store = new PostgresVisualDecisionProofStore(pool, codecFor());

    await expect(store.check()).resolves.toBe(true);
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain('has_function_privilege');
    expect(query.mock.calls[0]?.[1]).toEqual([
      [
        'emdo.prepare_visual_decision_proof(uuid,uuid,uuid,integer,text,text,text,uuid,text,text)',
        'emdo.finalize_visual_decision_proof(uuid,uuid,uuid,text,uuid,text,text,integer,text,text,uuid,timestamptz,timestamptz,text)',
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
    const store = new PostgresVisualDecisionProofStore(pool, codecFor());

    await expect(store.check()).resolves.toBe(false);
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
    const store = new PostgresVisualDecisionProofStore(pool, codecFor());

    await expect(store.check()).resolves.toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it('finalizes a DB-clock-clamped proof while sending no bearer token or HMAC secret', async () => {
    let preparedSeed: ReturnType<typeof seedFromPrepare> | undefined;
    let finalMaterial: Readonly<Record<string, unknown>> | undefined;
    const { pool, query } = poolFor((sql, values) => {
      if (sql.includes('prepare_visual_decision_proof')) {
        preparedSeed = seedFromPrepare(values);
        return [{ result: preparedResult(false, preparedSeed) }];
      }
      if (sql.includes('finalize_visual_decision_proof')) {
        finalMaterial = {
          proofId: values[4],
          nonce: values[5],
          keyId: values[6],
          tokenHash: values[13],
        };
        return [{ result: committedResult(false, finalMaterial) }];
      }
      return [];
    });
    const store = new PostgresVisualDecisionProofStore(pool, codecFor());

    const result = await store.issue(input());
    expect(result).toMatchObject({
      status: 'issued',
      proof: {
        proposalId: ids.proposal,
        proofToken: expect.stringMatching(/^[A-Za-z0-9_-]{32,512}$/u),
        issuedAt,
        expiresAt,
        replayed: false,
      },
    });
    const prepareCall = query.mock.calls.find(([sql]) =>
      sql.includes('prepare_visual_decision_proof'),
    );
    expect(prepareCall?.[1]).toEqual([
      ids.household,
      ids.spaceGrant,
      ids.proposal,
      4,
      payloadHash,
      approvalHash,
      idempotencyKey,
      ids.proofA,
      'A'.repeat(43),
      hmacKey.keyId,
    ]);
    const finalizeCall = query.mock.calls.find(([sql]) =>
      sql.includes('finalize_visual_decision_proof'),
    );
    expect(finalizeCall?.[1]).toEqual([
      ids.household,
      ids.spaceGrant,
      ids.proposal,
      idempotencyKey,
      ids.proofA,
      'A'.repeat(43),
      hmacKey.keyId,
      1,
      issuanceFingerprint,
      authorizationScopeFingerprint,
      ids.request,
      issuedAt,
      expiresAt,
      expect.stringMatching(/^[a-f0-9]{64}$/u),
    ]);
    const proofToken =
      result.status === 'issued' ? result.proof.proofToken : '';
    expect(JSON.stringify(query.mock.calls)).not.toContain(proofToken);
    expect(JSON.stringify(query.mock.calls)).not.toContain(
      Buffer.from(hmacKey.secret).toString('base64url'),
    );
    expect(finalMaterial).not.toHaveProperty('proofToken');
  });

  it('reproduces a lost response across a fresh request/grant without rotating digest or lifetime', async () => {
    let stored:
      | Readonly<{
          proofId: string;
          nonce: string;
          keyId: string;
          tokenHash: string;
        }>
      | undefined;
    let issuance = 0;
    let replayed = false;
    const { pool, query } = poolFor((sql, values) => {
      if (sql.includes('prepare_visual_decision_proof')) {
        replayed = issuance > 0;
        const seed = stored === undefined ? seedFromPrepare(values) : stored;
        return [{ result: preparedResult(replayed, seed) }];
      }
      if (sql.includes('finalize_visual_decision_proof')) {
        stored ??= {
          proofId: values[4] as string,
          nonce: values[5] as string,
          keyId: values[6] as string,
          tokenHash: values[13] as string,
        };
        issuance += 1;
        return [{ result: committedResult(replayed, stored) }];
      }
      return [];
    });
    const store = new PostgresVisualDecisionProofStore(
      pool,
      codecFor([ids.proofA, ids.proofB], ['A'.repeat(43), 'B'.repeat(43)]),
    );

    const first = await store.issue(input());
    const replay = await store.issue(
      input(ids.replayRequest, ids.replaySpaceGrant),
    );
    if (first.status !== 'issued' || replay.status !== 'issued') {
      throw new Error('expected issued proofs');
    }
    expect(replay.proof.proofToken).toBe(first.proof.proofToken);
    expect(replay.proof.issuedAt).toBe(first.proof.issuedAt);
    expect(replay.proof.expiresAt).toBe(first.proof.expiresAt);
    expect(replay.proof.replayed).toBe(true);
    const candidateSeeds = query.mock.calls
      .filter(([sql]) => sql.includes('prepare_visual_decision_proof'))
      .map(([, values]) => values?.slice(7, 10));
    expect(candidateSeeds[0]).not.toEqual(candidateSeeds[1]);
    expect(hashVisualDecisionProofToken(first.proof.proofToken)).toBe(
      stored?.tokenHash,
    );
  });

  it('keeps reordered concurrent replay responses byte-identical', async () => {
    const stable = codecFor([ids.proofA], ['S'.repeat(43)]).create(
      tokenBinding(),
    );
    const stableStored = {
      proofId: stable.proofId,
      nonce: stable.nonce,
      keyId: stable.keyId,
      tokenHash: stable.tokenHash,
    };
    const { pool } = poolFor((sql) => {
      if (sql.includes('prepare_visual_decision_proof')) {
        return [{ result: preparedResult(true, stableStored) }];
      }
      if (sql.includes('finalize_visual_decision_proof')) {
        return [{ result: committedResult(true, stableStored) }];
      }
      return [];
    });
    const store = new PostgresVisualDecisionProofStore(
      pool,
      codecFor([ids.proofB, ids.proofC], ['B'.repeat(43), 'C'.repeat(43)]),
    );

    const [one, two] = await Promise.all([
      store.issue(input()),
      store.issue(input(ids.replayRequest, ids.replaySpaceGrant)),
    ]);
    if (one.status !== 'issued' || two.status !== 'issued') {
      throw new Error('expected issued proofs');
    }
    expect(one.proof.proofToken).toBe(stable.proofToken);
    expect(two.proof.proofToken).toBe(stable.proofToken);
    expect(one.proof.expiresAt).toBe(two.proof.expiresAt);
  });

  it.each([
    'proposal-not-found',
    'proposal-not-pending',
    'proposal-expired',
    'proposal-binding-mismatch',
    'idempotency-conflict',
  ] as const)('preserves the bounded preparation denial %s', async (status) => {
    const { pool, query } = poolFor((sql) =>
      sql.includes('prepare_visual_decision_proof')
        ? [{ result: { status } }]
        : [],
    );
    const store = new PostgresVisualDecisionProofStore(pool, codecFor());

    await expect(store.issue(input())).resolves.toEqual({ status });
    expect(
      query.mock.calls.some(([sql]) =>
        sql.includes('finalize_visual_decision_proof'),
      ),
    ).toBe(false);
  });

  it('fails closed on tampered prepared/final material', async () => {
    const stable = codecFor([ids.proofA], ['S'.repeat(43)]).create(
      tokenBinding(),
    );
    const invalidPrepared = [
      {
        ...preparedResult(false, stable),
        proof: { ...proof(false), expiresAt: '2026-08-10T14:03:00.001Z' },
      },
      {
        ...preparedResult(false, stable),
        proof: { ...proof(false), approvalHash: '0'.repeat(64) },
      },
      {
        ...preparedResult(false, stable),
        binding: {
          ...binding,
          authorizationScopeFingerprint: '0'.repeat(64),
        },
      },
    ];
    for (const prepared of invalidPrepared) {
      const { pool } = poolFor((sql) =>
        sql.includes('prepare_visual_decision_proof')
          ? [{ result: prepared }]
          : [],
      );
      await expect(
        new PostgresVisualDecisionProofStore(pool, codecFor()).issue(input()),
      ).rejects.toMatchObject({
        code: 'invalid-result',
      } satisfies Partial<PostgresProposalApprovalError>);
    }

    const { pool } = poolFor((sql) => {
      if (sql.includes('prepare_visual_decision_proof')) {
        return [{ result: preparedResult(false, stable) }];
      }
      if (sql.includes('finalize_visual_decision_proof')) {
        return [
          {
            result: committedResult(false, {
              ...stable,
              tokenHash: '0'.repeat(64),
            }),
          },
        ];
      }
      return [];
    });
    await expect(
      new PostgresVisualDecisionProofStore(pool, codecFor()).issue(input()),
    ).rejects.toMatchObject({
      code: 'invalid-result',
    } satisfies Partial<PostgresProposalApprovalError>);
  });

  it('exposes no standalone consume operation and validates tokens before hashing', () => {
    const { pool } = poolFor(() => []);
    const store = new PostgresVisualDecisionProofStore(pool, codecFor());

    expect('consume' in store).toBe(false);
    expect(() => hashVisualDecisionProofToken('too-short')).toThrow(
      PostgresProposalApprovalError,
    );
    const material = codecFor().create(tokenBinding());
    expect(hashVisualDecisionProofToken(material.proofToken)).toBe(
      material.tokenHash,
    );
  });
});

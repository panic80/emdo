import { describe, expect, it, vi } from 'vitest';
import type { FinanceFecMappingCreate } from '@emdo/contracts';
import { PostgresFranceFecMappingRepository } from './finance-fec-mapping-repository.js';
import type { DatabaseClient, DatabasePool } from './scoped-repository.js';
const id = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f70';
const context = { workspaceId: id, userId: id, sessionId: id, requestId: id };
const source = {
  sourceReference: 'reviewed-evidence',
  sourceDigest: 'a'.repeat(64),
};
const input: FinanceFecMappingCreate = {
  expectedRevision: 0,
  siren: '123456789',
  sirenSource: source,
  openingBalances: { status: 'not-applicable', source },
  journals: [],
  accounts: [],
};
function setup(
  options: {
    allowed?: boolean;
    revision?: number;
    failChild?: boolean;
    databaseCode?: string;
    saved?: Record<string, unknown>;
    evidenceDigest?: string;
  } = {},
) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('select plaintext_sha256'))
      return {
        rows: options.evidenceDigest
          ? [{ digest: options.evidenceDigest }]
          : [],
        rowCount: options.evidenceDigest ? 1 : 0,
      };
    if (sql.includes('select h.revision'))
      return {
        rows: options.saved ? [options.saved] : [],
        rowCount: options.saved ? 1 : 0,
      };
    if (sql.includes('lock_active_request_scope'))
      return { rows: [{ authorized: true }], rowCount: 1 };
    if (sql.includes(' as allowed'))
      return { rows: [{ allowed: options.allowed ?? true }], rowCount: 1 };
    if (sql.includes('max(revision)'))
      return { rows: [{ revision: options.revision ?? 0 }], rowCount: 1 };
    if (
      sql.includes('insert into emdo.finance_fec_account_mappings') &&
      options.failChild
    )
      throw Object.assign(new Error('child-failure'), {
        code: options.databaseCode,
      });
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn();
  const client = { query, release } as unknown as DatabaseClient;
  const pool = { connect: async () => client } as DatabasePool;
  return {
    repository: new PostgresFranceFecMappingRepository(pool),
    query,
    release,
  };
}
describe('FEC mapping transaction', () => {
  it('commits the header and both child collections together', async () => {
    const h = setup();
    expect(await h.repository.create(context, id, input)).toEqual({
      revision: 1,
    });
    const calls = h.query.mock.calls.map(([sql]) => sql);
    expect(calls.filter((sql) => sql.includes('insert into'))).toHaveLength(3);
    expect(calls.at(-1)).toBe('commit');
    expect(h.release).toHaveBeenCalledOnce();
  });
  it.each([{ allowed: false }, { revision: 1 }])(
    'rejects revoked authority or stale revision before inserts %j',
    async (options) => {
      const h = setup(options);
      await expect(h.repository.create(context, id, input)).rejects.toThrow();
      expect(
        h.query.mock.calls.some(([sql]) => sql.includes('insert into')),
      ).toBe(false);
      expect(h.query.mock.calls.at(-1)?.[0]).toBe('rollback');
    },
  );
  it('rolls back the header when a child fails', async () => {
    const h = setup({ failChild: true });
    await expect(h.repository.create(context, id, input)).rejects.toThrow(
      'child-failure',
    );
    expect(h.query.mock.calls.some(([sql]) => sql === 'commit')).toBe(false);
    expect(h.query.mock.calls.at(-1)?.[0]).toBe('rollback');
    expect(h.release).toHaveBeenCalledOnce();
  });
});

it.each([
  ['42501', 'authorization-revoked'],
  ['23503', 'invalid-input'],
  ['23514', 'invalid-input'],
  ['23505', 'conflict'],
  ['55P03', 'conflict'],
])(
  'maps database failure %s to safe API category %s',
  async (databaseCode, code) => {
    const h = setup({ failChild: true, databaseCode });
    await expect(h.repository.create(context, id, input)).rejects.toMatchObject(
      { name: 'FinanceFranceFecPersistenceError', code },
    );
    expect(h.query.mock.calls.at(-1)?.[0]).toBe('rollback');
  },
);

it('reads a validated scoped immutable mapping with review provenance', async () => {
  const h = setup({
    saved: {
      revision: 1,
      reviewedBy: id,
      reviewedAt: new Date('2026-09-14T12:00:00Z'),
      mapping: { ...input, expectedRevision: 1 },
    },
  });
  expect(await h.repository.getLatest(context, id)).toMatchObject({
    workspaceId: id,
    bookId: id,
    revision: 1,
    reviewedBy: id,
    mapping: { expectedRevision: 1 },
  });
});
it('returns null for an absent mapping and denies revoked reads', async () => {
  expect(await setup().repository.getLatest(context, id)).toBeNull();
  await expect(
    setup({ allowed: false }).repository.getLatest(context, id),
  ).rejects.toMatchObject({ code: 'authorization-revoked' });
});

it('binds selected evidence to the current book and exact source digest', async () => {
  const linked = {
    ...input,
    sirenSource: { ...source, sourceReference: `evidence:${id}` },
  };
  const accepted = setup({ evidenceDigest: source.sourceDigest });
  expect(await accepted.repository.create(context, id, linked)).toEqual({
    revision: 1,
  });
  for (const fixture of [setup(), setup({ evidenceDigest: 'b'.repeat(64) })]) {
    await expect(
      fixture.repository.create(context, id, linked),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    expect(
      fixture.query.mock.calls.some(([sql]) => sql.includes('insert into')),
    ).toBe(false);
  }
});

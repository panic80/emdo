import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  FinanceFecMappingCreate,
  WorkspaceContext,
} from '@emdo/contracts';
import { PostgresFinanceV2Repository } from './finance-v2-repository.js';
import { PostgresFranceFecMappingRepository } from './finance-fec-mapping-repository.js';
import { PostgresFranceFecRepository } from './finance-fec-repository.js';

import {
  FinanceBookEvidenceCrypto,
  EncryptedFinanceBookEvidenceSchema,
} from '../../integrations/src/finance-documents/book-evidence-crypto.js';
import { InMemoryVaultKeyProvider } from '../../integrations/src/vault/crypto.js';

const url = process.env.FINANCE_V2_TEST_DATABASE_URL;
describe.skipIf(!url)('FEC restricted PostgreSQL acceptance', () => {
  const admin = new pg.Pool({ connectionString: url });
  const login = `fec_${randomUUID().replaceAll('-', '')}`;
  let app: pg.Pool | undefined;
  const pool = {
    async connect() {
      if (!app) throw new Error('FEC test login unavailable');
      const client = await app.connect();
      await client.query('set role emdo_app');
      return client;
    },
  };
  const context: WorkspaceContext = {
    workspaceId: randomUUID(),
    userId: randomUUID(),
    sessionId: randomUUID(),
    requestId: randomUUID(),
  };
  const preparer: WorkspaceContext = {
    ...context,
    userId: randomUUID(),
    sessionId: randomUUID(),
    requestId: randomUUID(),
  };
  const cipher = new FinanceBookEvidenceCrypto(
    new InMemoryVaultKeyProvider(
      new Uint8Array(32).fill(23),
      'finance-documents.v1',
    ),
  );
  const finance = new PostgresFinanceV2Repository(pool, {
    evidenceCipher: {
      encrypt: (value, scope) => cipher.encrypt(value, scope),
      decrypt: (value, scope) =>
        cipher.decrypt(EncryptedFinanceBookEvidenceSchema.parse(value), scope),
    },
  });
  const mappings = new PostgresFranceFecMappingRepository(pool);
  const exports = new PostgresFranceFecRepository(pool);
  let bookId: string,
    otherBookId: string,
    bankId: string,
    equityId: string,
    spareId: string,
    otherAccountId: string,
    journalId: string;
  const source = {
    sourceReference: 'reviewed:legal-entity',
    sourceDigest: 'a'.repeat(64),
  };
  const input = (expectedRevision = 0): FinanceFecMappingCreate => ({
    expectedRevision,
    siren: '123456789',
    sirenSource: source,
    openingBalances: { status: 'included', source },
    journals: [
      {
        journalId,
        entrySequence: 1,
        entryNumber: 'AN-1',
        entryKind: 'opening',
        journalCode: 'AN',
        journalLabel: 'A-nouveaux',
        pieceReference: 'OPEN-2026',
        pieceDate: '2026-01-01',
        entryLabel: 'Opening capital',
        validationDate: '2026-01-01',
      },
    ],
    accounts: [
      {
        accountId: bankId,
        accountNumber: '512000',
        accountLabel: 'Bank',
        auxiliary: null,
      },
      {
        accountId: equityId,
        accountNumber: '101000',
        accountLabel: 'Capital',
        auxiliary: null,
      },
    ],
  });
  const request = {
    startsOn: '2026-01-01',
    endsOn: '2026-12-31',
    mappingRevision: 1,
    idempotencyKey: 'fec-year',
  };
  async function scopedSql(
    sql: string,
    values: unknown[] = [],
    actor = context,
  ) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `select set_config('emdo.user_id',$1,true),set_config('emdo.session_id',$2,true),set_config('emdo.request_id',$3,true)`,
        [actor.userId, actor.sessionId, randomUUID()],
      );
      const result = await client.query(sql, values);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
  beforeAll(async () => {
    await admin.query(
      `create role "${login}" login nosuperuser nobypassrls noinherit`,
    );
    await admin.query(`grant emdo_app to "${login}"`);
    const connection = new URL(url!);
    connection.username = login;
    app = new pg.Pool({ connectionString: connection.toString() });
    expect(
      (
        await scopedSql(
          `select current_user,rolsuper,rolbypassrls from pg_roles where rolname=current_user`,
        )
      ).rows[0],
    ).toEqual({
      current_user: 'emdo_app',
      rolsuper: false,
      rolbypassrls: false,
    });
    for (const actor of [context, preparer])
      await admin.query(
        `insert into emdo.auth_users(id,name,email,email_verified) values($1,'FEC acceptance',$2,true)`,
        [actor.userId, `${actor.userId}@example.test`],
      );
    await admin.query(
      `insert into emdo.households(id,name,slug,created_by_user_id) values($1::uuid,'FEC acceptance',$1::text,$2)`,
      [context.workspaceId, context.userId],
    );
    for (const actor of [context, preparer]) {
      await admin.query(
        `insert into emdo.household_memberships(household_id,user_id,role) values($1,$2,$3)`,
        [
          context.workspaceId,
          actor.userId,
          actor === context ? 'owner' : 'member',
        ],
      );
      await admin.query(
        `insert into emdo.auth_sessions(id,user_id,token,expires_at,active_household_id) values($1,$2,$3,now()+interval '1 day',$4)`,
        [actor.sessionId, actor.userId, actor.sessionId, context.workspaceId],
      );
    }
    const book = {
      name: 'French ledger',
      entityName: 'French entity',
      entityKind: 'corporation',
      country: 'FR',
      functionalCurrency: 'EUR',
    };
    bookId = String((await finance.createBook(context, 'book', book)).id);
    otherBookId = String(
      (
        await finance.createBook(context, 'other-book', {
          ...book,
          name: 'Private second book',
        })
      ).id,
    );
    const account = async (id: string, key: string, kind: string) =>
      String(
        (
          await finance.createAccount(context, id, `${id}:${key}`, {
            code: key,
            name: key,
            kind,
          })
        ).id,
      );
    bankId = await account(bookId, '512', 'asset');
    equityId = await account(bookId, '101', 'equity');
    spareId = await account(bookId, '401', 'liability');
    otherAccountId = await account(otherBookId, '512', 'asset');
    await finance.createPeriod(context, bookId, 'year', {
      startsOn: '2026-01-01',
      endsOn: '2026-12-31',
    });
    journalId = String(
      (
        await finance.postJournal(context, bookId, 'opening', {
          effectiveOn: '2026-01-01',
          description: 'Opening capital',
          sourceReference: 'reviewed:opening',
          lines: [
            {
              accountId: bankId,
              side: 'debit',
              amount: '100.50',
              currency: 'EUR',
              nativeAmount: '100.50',
              fxRate: '1',
              fxSource: 'identity',
            },
            {
              accountId: equityId,
              side: 'credit',
              amount: '100.50',
              currency: 'EUR',
              nativeAmount: '100.50',
              fxRate: '1',
              fxSource: 'identity',
            },
          ],
        })
      ).id,
    );
    await admin.query(
      `insert into emdo.finance_book_grants(workspace_id,book_id,user_id,role) values($1,$2,$3,'preparer')`,
      [context.workspaceId, bookId, preparer.userId],
    );
  });
  afterAll(async () => {
    await app?.end();
    await admin.query(`drop role if exists "${login}"`);
    await admin.end();
  });
  it('persists reviewed mapping and replays the exact 18-column export receipt', async () => {
    expect(await mappings.create(context, bookId, input())).toEqual({
      revision: 1,
    });
    expect(await mappings.getLatest(context, bookId)).toMatchObject({
      revision: 1,
      reviewedBy: context.userId,
      mapping: {
        ...input(1),
        accounts: expect.arrayContaining(input(1).accounts),
      },
    });
    const result = await exports.export(context, bookId, request);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('FEC should be ready');
    const lines = result.file.content.replace(/\r?\n$/u, '').split(/\r?\n/u);
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.split('\t').length === 18)).toBe(true);
    expect(
      lines.slice(1).map((line) => line.split('\t').slice(11, 13)),
    ).toEqual([
      ['100,5', '0'],
      ['0', '100,5'],
    ]);
    expect(result.sourceLineage).toHaveLength(2);
    expect(await exports.export(context, bookId, request)).toEqual(result);
    expect(
      (
        await admin.query(
          `select count(*)::int as count from emdo.finance_fec_export_receipts where workspace_id=$1 and book_id=$2`,
          [context.workspaceId, bookId],
        )
      ).rows[0].count,
    ).toBe(1);
    await expect(
      exports.export(context, bookId, { ...request, endsOn: '2026-11-30' }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('denies preparer review and inaccessible book reads/exports', async () => {
    await expect(
      mappings.create(preparer, bookId, input(1)),
    ).rejects.toMatchObject({ code: 'authorization-revoked' });
    await expect(
      mappings.getLatest(preparer, otherBookId),
    ).rejects.toMatchObject({ code: 'authorization-revoked' });
    await expect(
      exports.export(preparer, otherBookId, request),
    ).rejects.toMatchObject({ code: 'authorization-revoked' });
    expect(
      (
        await scopedSql(
          `select * from emdo.finance_fec_export_receipts where book_id=$1`,
          [otherBookId],
          preparer,
        )
      ).rows,
    ).toEqual([]);
  });
  it('rejects stale CAS and cross-book account references without leaving a header', async () => {
    await expect(
      mappings.create(context, bookId, input()),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      mappings.create(context, bookId, {
        ...input(1),
        accounts: [
          {
            accountId: otherAccountId,
            accountNumber: '512000',
            accountLabel: 'Wrong book',
            auxiliary: null,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    expect((await mappings.getLatest(context, bookId))?.revision).toBe(1);
  });
  it('rejects late child appends to committed review revisions', async () => {
    await expect(
      scopedSql(
        `insert into emdo.finance_fec_account_mappings(workspace_id,book_id,revision,account_id,account_number,account_label) values($1,$2,1,$3,'401000','Late payable')`,
        [context.workspaceId, bookId, spareId],
      ),
    ).rejects.toThrow();
    expect(
      (await mappings.getLatest(context, bookId))?.mapping.accounts,
    ).toHaveLength(2);
  });
  it('rejects illegal legal metadata through restricted SQL independently of API validation', async () => {
    await expect(
      scopedSql(
        `insert into emdo.finance_fec_book_mapping_revisions(workspace_id,book_id,revision,siren,siren_source_reference,siren_source_digest,opening_status,opening_source_reference,opening_source_digest) values($1,$2,2,'invalid','source',$3,'included','source',$3)`,
        [context.workspaceId, bookId, source.sourceDigest],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      mappings.create(context, bookId, {
        ...input(1),
        journals: [
          { ...input(1).journals[0]!, journalLabel: 'Illegal\tlabel' },
        ],
      }),
    ).rejects.toThrow();
    expect((await mappings.getLatest(context, bookId))?.revision).toBe(1);
  });
  it('binds both selected evidence references to this book and exact digest through restricted SQL', async () => {
    const sourceText = 'Selected legal entity evidence';
    const selectedDigest = createHash('sha256')
      .update(sourceText)
      .digest('hex');
    const selected = await finance.uploadBookEvidence(
      context,
      bookId,
      'fec-selected',
      { filename: 'legal.csv', format: 'csv', sourceText },
    );
    const foreign = await finance.uploadBookEvidence(
      context,
      otherBookId,
      'fec-foreign',
      { filename: 'legal.csv', format: 'csv', sourceText },
    );
    const selectedId = selected.id;
    const foreignId = foreign.id;
    const insert = (
      sirenReference: string,
      openingReference: string,
      digest = selectedDigest,
    ) =>
      scopedSql(
        `insert into emdo.finance_fec_book_mapping_revisions(workspace_id,book_id,revision,siren,siren_source_reference,siren_source_digest,opening_status,opening_source_reference,opening_source_digest) values($1,$2,2,'123456789',$3,$5,'included',$4,$5)`,
        [context.workspaceId, bookId, sirenReference, openingReference, digest],
      );
    for (const reference of [
      'evidence:not-a-uuid',
      `evidence:${randomUUID()}`,
      `evidence:${foreignId}`,
    ]) {
      await expect(
        insert(reference, source.sourceReference),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        insert(source.sourceReference, reference),
      ).rejects.toMatchObject({ code: '23514' });
    }
    await expect(
      insert(`evidence:${selectedId}`, source.sourceReference, 'b'.repeat(64)),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insert(source.sourceReference, `evidence:${selectedId}`, 'b'.repeat(64)),
    ).rejects.toMatchObject({ code: '23514' });
    expect((await mappings.getLatest(context, bookId))?.revision).toBe(1);
    await insert(`evidence:${selectedId}`, `evidence:${selectedId}`);
    expect((await mappings.getLatest(context, bookId))?.revision).toBe(2);
  });
});

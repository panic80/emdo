import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FinanceNormalizedImportPostingSchema,
  type WorkspaceContext,
} from '@emdo/contracts';
import {
  FinanceBookEvidenceCrypto,
  EncryptedFinanceBookEvidenceSchema,
} from '../../integrations/src/finance-documents/book-evidence-crypto.js';
import { InMemoryVaultKeyProvider } from '../../integrations/src/vault/crypto.js';
import { PostgresFinanceV2Repository } from './finance-v2-repository.js';

const databaseUrl = process.env.FINANCE_V2_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  'Direct import posting lineage on restricted PostgreSQL',
  () => {
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const login = `import_lineage_${randomUUID().replaceAll('-', '')}`;
    let app: pg.Pool;
    const pool = {
      async connect() {
        const c = await app.connect();
        await c.query('set role emdo_app');
        return c;
      },
    };
    const cipher = new FinanceBookEvidenceCrypto(
      new InMemoryVaultKeyProvider(
        new Uint8Array(32).fill(13),
        'finance-documents.v1',
      ),
    );
    const repo = new PostgresFinanceV2Repository(pool, {
      evidenceCipher: {
        encrypt: (value, scope) => cipher.encrypt(value, scope),
        decrypt: (value, scope) =>
          cipher.decrypt(
            EncryptedFinanceBookEvidenceSchema.parse(value),
            scope,
          ),
      },
    });
    const context: WorkspaceContext = {
      workspaceId: randomUUID(),
      userId: randomUUID(),
      sessionId: randomUUID(),
      requestId: randomUUID(),
    };
    beforeAll(async () => {
      await admin.query(
        `create role "${login}" login nosuperuser nobypassrls noinherit`,
      );
      await admin.query(`grant emdo_app to "${login}"`);
      const url = new URL(databaseUrl!);
      url.username = login;
      app = new pg.Pool({ connectionString: url.toString() });
      await admin.query(
        "insert into emdo.auth_users(id,name,email,email_verified) values($1,'Lineage owner',$2,true)",
        [context.userId, `${context.userId}@example.test`],
      );
      await admin.query(
        "insert into emdo.households(id,name,slug,created_by_user_id) values($1::uuid,'Lineage',$1::text,$2)",
        [context.workspaceId, context.userId],
      );
      await admin.query(
        "insert into emdo.household_memberships(household_id,user_id,role) values($1,$2,'owner')",
        [context.workspaceId, context.userId],
      );
      await admin.query(
        "insert into emdo.auth_sessions(id,user_id,token,expires_at,active_household_id) values($1::uuid,$2,$1::text,now()+interval '1 day',$3)",
        [context.sessionId, context.userId, context.workspaceId],
      );
    });
    afterAll(async () => {
      await app?.end();
      await admin.query(`drop role if exists "${login}"`);
      await admin.end();
    });
    async function fixture(currency = 'CAD', nativeCurrency = 'CAD') {
      const book = await repo.createBook(context, randomUUID(), {
        name: 'Lineage',
        entityName: 'Lineage entity',
        entityKind: 'corporation',
        country: 'CA',
        functionalCurrency: currency,
      });
      const bookId = String(book.id);
      const cash = String(
        (
          await repo.createAccount(context, bookId, randomUUID(), {
            code: '1000',
            name: 'Cash',
            kind: 'asset',
          })
        ).id,
      );
      const counter = String(
        (
          await repo.createAccount(context, bookId, randomUUID(), {
            code: '3000',
            name: 'Capital',
            kind: 'equity',
          })
        ).id,
      );
      const financialAccountId = String(
        (
          await repo.createFinancialAccount(context, bookId, randomUUID(), {
            name: 'Bank',
            kind: 'bank',
            currency: nativeCurrency,
            ledgerAccountId: cash,
          })
        ).id,
      );
      await repo.createPeriod(context, bookId, randomUUID(), {
        startsOn: '2026-01-01',
        endsOn: '2026-12-31',
      });
      return { bookId, cash, counter, financialAccountId };
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    async function source(
      f: Fixture,
      amount = '123.45',
      externalId = randomUUID(),
    ) {
      const batchId = String(
        (
          await repo.uploadNormalizedStatement(
            context,
            f.bookId,
            randomUUID(),
            {
              financialAccountId: f.financialAccountId,
              filename: 'lineage.csv',
              format: 'csv',
              sourceText: `Date,Description,Amount,ID\n2026-03-08,Reviewed receipt,${amount},${externalId}`,
              mapping: {
                dateFormat: 'yyyy-mm-dd',
                columns: {
                  date: 'Date',
                  description: 'Description',
                  amount: 'Amount',
                  externalId: 'ID',
                },
              },
            },
          )
        ).id,
      );
      const row = (await repo.getNormalizedImport(context, f.bookId, batchId))
        .rows[0]!;
      return { batchId, rowId: String(row.id) };
    }
    async function review(
      f: Fixture,
      s: Awaited<ReturnType<typeof source>>,
      rate = '1',
      matchJournalId?: string,
    ) {
      await repo.reviewNormalizedImportRow(
        context,
        f.bookId,
        s.rowId,
        randomUUID(),
        {
          expectedRevision: 1,
          action: matchJournalId ? 'match' : 'post',
          counterAccountId: matchJournalId ? null : f.counter,
          matchJournalId: matchJournalId ?? null,
          fxRate: rate,
          fxSource: rate === '1' ? 'identity' : 'Reviewed bank FX',
          reason: 'Checked source',
        },
      );
    }
    async function read(f: Fixture, s: Awaited<ReturnType<typeof source>>) {
      return (await repo.getNormalizedImport(context, f.bookId, s.batchId))
        .rows[0]!;
    }
    async function commit(f: Fixture, s: Awaited<ReturnType<typeof source>>) {
      const saved = await repo.getNormalizedImport(
        context,
        f.bookId,
        s.batchId,
      );
      return repo.commitNormalizedImport(
        context,
        f.bookId,
        s.batchId,
        randomUUID(),
        { expectedRevision: Number(saved.batch.revision) },
      );
    }
    it.each([
      ['CAD', 'CAD', '123.45', '1', '123.450000000000'],
      ['CAD', 'USD', '100.01', '1.2345', '123.460000000000'],
      ['JPY', 'USD', '1.01', '150.5', '152.000000000000'],
      ['CAD', 'CAD', '90071992547409.93', '1', '90071992547409.930000000000'],
    ])(
      'reads exact persisted %s/%s lines for %s',
      async (currency, native, amount, rate, expected) => {
        const f = await fixture(currency, native),
          s = await source(f, amount);
        expect((await read(f, s)).posting).toBeNull();
        await review(f, s, rate);
        expect((await read(f, s)).posting).toBeNull();
        await commit(f, s);
        const saved = await read(f, s);
        expect(saved).toMatchObject({
          id: s.rowId,
          status: 'committed',
          decision: { action: 'post' },
          counter_account_id: f.counter,
        });
        const posting = FinanceNormalizedImportPostingSchema.parse(
          saved.posting,
        );
        expect(posting.economicTransactionId).toBe(
          saved.economic_transaction_id,
        );
        expect(posting).toMatchObject({
          functionalCurrency: currency,
          effectiveOn: '2026-03-08',
          description: 'Reviewed receipt',
          reversalOf: null,
        });
        expect(posting.lines).toHaveLength(2);
        expect(posting.lines).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              accountId: f.cash,
              side: 'debit',
              amount: expected,
              currency: native,
              nativeAmount: `${amount}0000000000`,
              fxRate:
                rate === '1'
                  ? '1.000000000000'
                  : rate === '1.2345'
                    ? '1.234500000000'
                    : '150.500000000000',
            }),
            expect.objectContaining({
              accountId: f.counter,
              side: 'credit',
              amount: expected,
            }),
          ]),
        );
        expect(posting.lines.map((line) => line.lineNumber)).toEqual([1, 2]);
        const actual = await admin.query(
          'select journal_id from emdo.finance_economic_transactions where id=$1',
          [posting.economicTransactionId],
        );
        expect(actual.rows[0].journal_id).toBe(posting.journalId);
        expect((await read(f, s)).posting).toEqual(posting);
      },
    );
    it('resolves a committed match to the existing journal, never a review target alone', async () => {
      const f = await fixture(),
        first = await source(f);
      await review(f, first);
      await commit(f, first);
      const original = FinanceNormalizedImportPostingSchema.parse(
        (await read(f, first)).posting,
      );
      const matched = await source(f);
      await review(f, matched, '1', original.journalId);
      expect((await read(f, matched)).posting).toBeNull();
      await commit(f, matched);
      expect((await read(f, matched)).posting).toEqual(original);
    });
    it('rejects a different book and revoked book access', async () => {
      const f = await fixture(),
        s = await source(f);
      await review(f, s);
      await commit(f, s);
      const other = await fixture();
      await expect(
        repo.getNormalizedImport(context, other.bookId, s.batchId),
      ).rejects.toThrow();
      await admin.query(
        'update emdo.finance_book_grants set revoked_at=now(),revision=revision+1 where workspace_id=$1 and book_id=$2 and user_id=$3',
        [context.workspaceId, f.bookId, context.userId],
      );
      await expect(read(f, s)).rejects.toThrow();
    });
  },
);

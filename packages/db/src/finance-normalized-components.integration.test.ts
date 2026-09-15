import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkspaceContext } from '@emdo/contracts';
import {
  EncryptedFinanceBookEvidenceSchema,
  FinanceBookEvidenceCrypto,
} from '../../integrations/src/finance-documents/book-evidence-crypto.js';
import { InMemoryVaultKeyProvider } from '../../integrations/src/vault/crypto.js';
import { PostgresFinanceV2Repository } from './finance-v2-repository.js';

const url = process.env.FINANCE_V2_TEST_DATABASE_URL;

describe.skipIf(!url)(
  'normalized amount component posting on PostgreSQL',
  () => {
    const admin = new pg.Pool({ connectionString: url });
    const pool = {
      async connect() {
        const client = await admin.connect();
        await client.query('set role emdo_app');
        return client;
      },
    };
    const cipher = new FinanceBookEvidenceCrypto(
      new InMemoryVaultKeyProvider(
        new Uint8Array(32).fill(11),
        'finance-documents.v1',
      ),
    );
    const repository = new PostgresFinanceV2Repository(pool, {
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
    let bookId: string;
    let cashAccountId: string;
    let feeAccountId: string;
    let principalAccountId: string;

    async function sql(text: string, values: unknown[] = []) {
      const client = await admin.connect();
      try {
        await client.query('reset role');
        return await client.query(text, values);
      } finally {
        client.release();
      }
    }

    async function asApp(text: string, values: unknown[] = []) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(
          `select set_config('emdo.user_id',$1,true),set_config('emdo.session_id',$2,true),set_config('emdo.request_id',$3,true)`,
          [context.userId, context.sessionId, randomUUID()],
        );
        const result = await client.query(text, values);
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
      await sql(
        `insert into emdo.auth_users(id,name,email,email_verified) values($1,'Component owner',$2,true)`,
        [context.userId, `${context.userId}@example.test`],
      );
      await sql(
        `insert into emdo.households(id,name,slug,created_by_user_id) values($1,'Component test',$2,$3)`,
        [context.workspaceId, context.workspaceId, context.userId],
      );
      await sql(
        `insert into emdo.household_memberships(household_id,user_id,role) values($1,$2,'owner')`,
        [context.workspaceId, context.userId],
      );
      await sql(
        `insert into emdo.auth_sessions(id,user_id,token,expires_at,active_household_id) values($1,$2,$3,now()+interval '1 day',$4)`,
        [
          context.sessionId,
          context.userId,
          context.sessionId,
          context.workspaceId,
        ],
      );
      bookId = String(
        (
          await repository.createBook(context, 'component-book', {
            name: 'Component book',
            entityName: 'Component owner',
            entityKind: 'corporation',
            country: 'CA',
            functionalCurrency: 'CAD',
          })
        ).id,
      );
      cashAccountId = String(
        (
          await repository.createAccount(context, bookId, 'component-cash', {
            code: '1000',
            name: 'Cash',
            kind: 'asset',
          })
        ).id,
      );
      feeAccountId = String(
        (
          await repository.createAccount(context, bookId, 'component-fee', {
            code: '6200',
            name: 'Trading fees',
            kind: 'expense',
          })
        ).id,
      );
      principalAccountId = String(
        (
          await repository.createAccount(
            context,
            bookId,
            'component-principal',
            {
              code: '1300',
              name: 'Investments',
              kind: 'asset',
            },
          )
        ).id,
      );
      await repository.createFinancialAccount(
        context,
        bookId,
        'component-bank',
        {
          name: 'Component bank',
          kind: 'bank',
          currency: 'CAD',
          ledgerAccountId: cashAccountId,
        },
      );
      await repository.createPeriod(context, bookId, 'component-period', {
        startsOn: '2026-01-01',
        endsOn: '2026-12-31',
      });
    });

    afterAll(async () => {
      await admin.end();
    });

    it('keeps source components immutable, requires reviewed mappings, and posts exact lines atomically', async () => {
      const financialAccountId = String(
        (await repository.listFinancialAccounts(context, bookId))[0]!.id,
      );
      const evidence = await repository.uploadBookEvidence(
        context,
        bookId,
        'component-evidence',
        {
          filename: 'investment.csv',
          format: 'csv',
          sourceText:
            'Date,Description,Amount,Currency,Fee,Principal\n2026-03-10,Buy shares,-103,CAD,3,100',
        },
      );
      const headers = [
        'Date',
        'Description',
        'Amount',
        'Currency',
        'Fee',
        'Principal',
      ];
      const definition = {
        providerKey: 'component-bank',
        reportName: 'Investment activity',
        reportType: 'bank-transactions',
        layoutVersion: '1',
        headers,
        bindings: [
          { field: 'transactionDate', column: 'Date', context: null },
          { field: 'description', column: 'Description', context: null },
          { field: 'amount', column: 'Amount', context: null },
          { field: 'currency', column: 'Currency', context: null },
          { field: 'fee', column: 'Fee', context: null },
          { field: 'principal', column: 'Principal', context: null },
        ],
        dateFormat: 'yyyy-mm-dd',
        decimalSeparator: '.',
        groupingSeparator: '',
        quantityUnit: null,
        valuationMultiplier: null,
        identifierScheme: null,
        identifierNamespace: null,
      };
      const mapping = await repository.saveReportMapping(
        context,
        bookId,
        'component-mapping',
        {
          proposal: {
            definition,
            rationale: 'Reviewed component columns',
            unresolvedQuestions: [],
          },
          example: {
            documentId: evidence.id,
            extractionRevision: 1,
            tableId: 'csv:1',
            page: null,
            sheet: 'CSV',
            providerKey: 'component-bank',
            reportType: 'bank-transactions',
            headers,
            context: { asOf: null, currency: null },
            rows: [
              {
                sourceRow: 2,
                cells: ['2026-03-10', 'Buy shares', '-103', 'CAD', '3', '100'],
              },
            ],
          },
        },
      );
      await repository.reviewReportMapping(
        context,
        bookId,
        String(mapping.id),
        'component-mapping-approve',
        { expectedRevision: 1, decision: 'approve', reason: 'Reviewed' },
      );
      const batch = await repository.importMappedReport(
        context,
        bookId,
        String(mapping.id),
        'component-import',
        {
          evidenceId: evidence.id,
          financialAccountId,
          expectedMappingVersion: 1,
          providerKey: 'component-bank',
        },
      );
      const imported = await repository.getNormalizedImport(
        context,
        bookId,
        String(batch.id),
      );
      const row = imported.rows[0]!;
      const components = row.amountComponents as readonly Record<
        string,
        unknown
      >[];
      expect(components.map((component) => component.kind)).toEqual([
        'fee',
        'principal',
      ]);
      expect(components[0]!.provenance).toMatchObject({
        sourceRow: 2,
        field: 'fee',
        raw: '3',
      });
      await expect(
        repository.reviewNormalizedImportRow(
          context,
          bookId,
          String(row.id),
          'component-partial-review',
          {
            expectedRevision: 1,
            action: 'post',
            reason: 'Partial component review',
            componentMappings: [
              {
                kind: 'fee',
                nativeAmount: '3',
                currency: 'CAD',
                inclusion: 'included-in-net',
                postingSide: 'debit',
                ledgerAccountId: feeAccountId,
                fxRate: '1',
                fxSource: 'identity',
              },
            ],
          },
        ),
      ).rejects.toThrow('components-review-required');
      const reviewed = await repository.reviewNormalizedImportRow(
        context,
        bookId,
        String(row.id),
        'component-review',
        {
          expectedRevision: 1,
          action: 'post',
          reason: 'Explicit component accounts and FX',
          componentMappings: [
            {
              kind: 'fee',
              nativeAmount: '3',
              currency: 'CAD',
              inclusion: 'included-in-net',
              postingSide: 'debit',
              ledgerAccountId: feeAccountId,
              fxRate: '1',
              fxSource: 'identity',
            },
            {
              kind: 'principal',
              nativeAmount: '100',
              currency: 'CAD',
              inclusion: 'included-in-net',
              postingSide: 'debit',
              ledgerAccountId: principalAccountId,
              fxRate: '1',
              fxSource: 'identity',
            },
          ],
        },
      );
      expect(reviewed).toMatchObject({ revision: 2, batchRevision: 2 });
      const committed = await repository.commitNormalizedImport(
        context,
        bookId,
        String(batch.id),
        'component-commit',
        { expectedRevision: 2 },
      );
      expect(committed).toMatchObject({ posted: 1, matched: 0, revision: 3 });
      expect(
        await repository.commitNormalizedImport(
          context,
          bookId,
          String(batch.id),
          'component-commit',
          { expectedRevision: 2 },
        ),
      ).toEqual(committed);
      const saved = await repository.getNormalizedImport(
        context,
        bookId,
        String(batch.id),
      );
      expect(saved.rows[0]).toMatchObject({ status: 'committed' });
      const output = (
        await sql(
          `select c.component_kind as kind,c.native_amount::text as native_amount,c.functional_amount::text as functional_amount,c.posting_side,c.ledger_account_id,c.source_provenance from emdo.finance_economic_transaction_amount_components c join emdo.finance_normalized_import_rows r on r.economic_transaction_id=c.economic_transaction_id where r.id=$1 order by c.component_kind`,
          [row.id],
        )
      ).rows;
      expect(output).toHaveLength(2);
      expect(output.map((component) => component.functional_amount)).toEqual([
        '3.000000000000',
        '100.000000000000',
      ]);
      const journal = (
        await sql(
          `select l.side,l.amount::text as amount,l.account_id from emdo.finance_journal_lines l join emdo.finance_normalized_import_rows r on r.economic_transaction_id=(select economic_transaction_id from emdo.finance_normalized_import_rows where id=$1) where l.journal_id=(select journal_id from emdo.finance_economic_transactions where id=r.economic_transaction_id) order by l.line_number`,
          [row.id],
        )
      ).rows;
      expect(journal).toHaveLength(3);
      expect(journal.map((line) => line.side)).toEqual([
        'credit',
        'debit',
        'debit',
      ]);
      await expect(
        asApp(
          `update emdo.finance_normalized_import_amount_components set native_amount=4 where workspace_id=$1 and book_id=$2`,
          [context.workspaceId, bookId],
        ),
      ).rejects.toThrow('immutable');
    });
  },
);

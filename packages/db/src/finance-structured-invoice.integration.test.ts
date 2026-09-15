import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkspaceContext } from '@emdo/contracts';
import { PostgresFinanceV2Repository } from './finance-v2-repository.js';
import {
  FinanceBookEvidenceCrypto,
  EncryptedFinanceBookEvidenceSchema,
} from '../../integrations/src/finance-documents/book-evidence-crypto.js';
import { InMemoryVaultKeyProvider } from '../../integrations/src/vault/crypto.js';
import { extractStructuredFinanceInvoice } from '../../integrations/src/finance-documents/structured-invoice-extraction.js';
import {
  ublInvoice,
  ciiInvoice,
} from '../../integrations/src/finance-documents/test-fixtures/structured-invoices.js';
const url = process.env.FINANCE_V2_TEST_DATABASE_URL;
describe.skipIf(!url)(
  'Structured invoices through encrypted evidence and restricted commercial posting',
  () => {
    const admin = new pg.Pool({ connectionString: url });
    const pool = {
      async connect() {
        const c = await admin.connect();
        await c.query('set role emdo_app');
        return c;
      },
    };
    const cipher = new FinanceBookEvidenceCrypto(
      new InMemoryVaultKeyProvider(
        new Uint8Array(32).fill(31),
        'finance-documents.v1',
      ),
    );
    const repo = new PostgresFinanceV2Repository(pool, {
      structuredInvoiceExtractor: extractStructuredFinanceInvoice,
      evidenceCipher: {
        encrypt: (v, s) => cipher.encrypt(v, s),
        decrypt: (v, s) =>
          cipher.decrypt(EncryptedFinanceBookEvidenceSchema.parse(v), s),
      },
    });
    const context: WorkspaceContext = {
      workspaceId: randomUUID(),
      userId: randomUUID(),
      sessionId: randomUUID(),
      requestId: randomUUID(),
    };
    let bookId: string,
      partyId: string,
      control: string,
      expense: string,
      tax: string;
    async function sql(query: string, values: unknown[] = []) {
      const c = await admin.connect();
      try {
        await c.query('reset role');
        return await c.query(query, values);
      } finally {
        c.release();
      }
    }
    beforeAll(async () => {
      await sql(
        "insert into emdo.auth_users(id,name,email,email_verified) values($1,'Invoice test',$2,true)",
        [context.userId, `${context.userId}@example.test`],
      );
      await sql(
        "insert into emdo.households(id,name,slug,created_by_user_id) values($1,'Invoice test',$2,$3)",
        [context.workspaceId, context.workspaceId, context.userId],
      );
      await sql(
        "insert into emdo.household_memberships(household_id,user_id,role) values($1,$2,'owner')",
        [context.workspaceId, context.userId],
      );
      await sql(
        "insert into emdo.auth_sessions(id,user_id,token,expires_at,active_household_id) values($1,$2,$3,now()+interval '1 day',$4)",
        [
          context.sessionId,
          context.userId,
          context.sessionId,
          context.workspaceId,
        ],
      );
      bookId = String(
        (
          await repo.createBook(context, 'invoice-book', {
            name: 'German invoices',
            entityName: 'Buyer GmbH',
            entityKind: 'corporation',
            country: 'DE',
            functionalCurrency: 'EUR',
          })
        ).id,
      );
      control = String(
        (
          await repo.createAccount(context, bookId, 'ap', {
            code: 'AP',
            name: 'Payables',
            kind: 'liability',
          })
        ).id,
      );
      expense = String(
        (
          await repo.createAccount(context, bookId, 'expense', {
            code: 'EXP',
            name: 'Expense',
            kind: 'expense',
          })
        ).id,
      );
      tax = String(
        (
          await repo.createAccount(context, bookId, 'vat', {
            code: 'VAT',
            name: 'Source VAT',
            kind: 'asset',
          })
        ).id,
      );
      await repo.createPeriod(context, bookId, 'period', {
        startsOn: '2026-01-01',
        endsOn: '2026-12-31',
      });
      partyId = String(
        (
          await repo.createParty(context, bookId, 'party', {
            name: 'Seller GmbH',
            kind: 'organization',
            reference: 'seller',
          })
        ).id,
      );
    });
    afterAll(() => admin.end());
    it.each([
      ['ubl', ublInvoice, '113.05'],
      ['cii', ciiInvoice, '119'],
    ] as const)(
      'roundtrips %s, requires review, posts exact source groups and prevents duplicate posting',
      async (format, sourceText, total) => {
        const evidenceId = String(
          (
            await repo.uploadBookEvidence(context, bookId, `upload-${format}`, {
              filename: `invoice.${format}.xml`,
              format,
              sourceText,
            })
          ).id,
        );
        expect(
          await repo.downloadBookEvidence(context, bookId, evidenceId),
        ).toMatchObject({ format, sourceText });
        const stored = (
          await sql(
            'select encrypted_original from emdo.finance_book_evidence where id=$1',
            [evidenceId],
          )
        ).rows[0];
        expect(JSON.stringify(stored)).not.toContain('Verkäufer');
        const source = await repo.inspectStructuredInvoice(
          context,
          bookId,
          evidenceId,
        );
        expect(source.blockingIssues).toEqual([]);
        expect(source.lines[0]?.id?.value).toMatch(/^source-line-/);
        expect(
          (await repo.commercialOverview(context, bookId)).documents,
        ).toHaveLength(format === 'ubl' ? 0 : 1);
        const draft = {
          expectedSourceDigest: source.sourceDigest,
          expectedAdapterVersion: source.adapterVersion,
          kind: 'supplier-bill',
          partyId,
          controlAccountId: control,
          acknowledgedSourceParties: true,
          acknowledgedTaxGroupAggregation: true,
          acknowledgedNoConformanceValidation: true,
          groups: source.taxGroups.map((g) => ({
            key: g.key,
            accountId: expense,
            taxAccountId: tax,
          })),
        };
        const partial = {
          ...draft,
          partyId: null,
          acknowledgedSourceParties: false,
        };
        const saved = await repo.saveStructuredInvoiceReviewDraft(
          context,
          bookId,
          evidenceId,
          `draft-${format}`,
          { expectedRevision: 0, draft: partial },
        );
        expect(saved.revision).toBe(1);
        expect(
          await repo.saveStructuredInvoiceReviewDraft(
            context,
            bookId,
            evidenceId,
            `draft-${format}`,
            { expectedRevision: 0, draft: partial },
          ),
        ).toEqual(saved);
        expect(
          await repo.getStructuredInvoiceReviewDraft(
            context,
            bookId,
            evidenceId,
          ),
        ).toMatchObject({
          review: { revision: 1, draft: partial },
          posting: null,
        });
        await expect(
          repo.saveStructuredInvoiceReviewDraft(
            context,
            bookId,
            evidenceId,
            `stale-draft-${format}`,
            { expectedRevision: 0, draft },
          ),
        ).rejects.toThrow();
        const competing = await Promise.allSettled(
          ['a', 'b'].map((suffix) =>
            repo.saveStructuredInvoiceReviewDraft(
              context,
              bookId,
              evidenceId,
              `complete-draft-${format}-${suffix}`,
              { expectedRevision: 1, draft },
            ),
          ),
        );
        expect(
          competing.filter((result) => result.status === 'fulfilled'),
        ).toHaveLength(1);
        expect(
          competing.filter((result) => result.status === 'rejected'),
        ).toHaveLength(1);
        const review = { ...draft, expectedReviewRevision: 2 };
        await expect(
          repo.postReviewedStructuredInvoice(
            context,
            bookId,
            evidenceId,
            `stale-review-${format}`,
            { ...review, expectedReviewRevision: 1 },
          ),
        ).rejects.toThrow();
        await expect(
          repo.postReviewedStructuredInvoice(
            context,
            bookId,
            evidenceId,
            `bad-${format}`,
            { ...review, expectedSourceDigest: '0'.repeat(64) },
          ),
        ).rejects.toThrow();
        expect(() =>
          repo.postReviewedStructuredInvoice(
            context,
            bookId,
            evidenceId,
            `ack-${format}`,
            { ...review, acknowledgedTaxGroupAggregation: false },
          ),
        ).toThrow();
        const result = await repo.postReviewedStructuredInvoice(
          context,
          bookId,
          evidenceId,
          `post-${format}`,
          review,
        );
        expect(result.total).toBe(total);
        expect(
          await repo.postReviewedStructuredInvoice(
            context,
            bookId,
            evidenceId,
            `post-${format}`,
            review,
          ),
        ).toEqual(result);
        await expect(
          repo.postReviewedStructuredInvoice(
            context,
            bookId,
            evidenceId,
            `duplicate-${format}`,
            review,
          ),
        ).rejects.toThrow('already-posted');
        const audit = (
          await sql(
            "select details from emdo.finance_v2_audit where record_id=$1 and operation='structured-invoice.review'",
            [result.id],
          )
        ).rows[0]?.details;
        expect(audit).toMatchObject({
          evidenceId,
          sourceDigest: source.sourceDigest,
          conformance: 'not-validated',
          review: { acknowledgedTaxGroupAggregation: true },
        });
        const ledger = (
          await sql(
            "select sum(case side when 'debit' then amount else -amount end)::text balance from emdo.finance_journal_lines where journal_id=$1",
            [result.journalId],
          )
        ).rows[0];
        expect(Number(ledger.balance)).toBe(0);
      },
    );
    it('retains unsupported originals but blocks unsafe XML and inconsistent settlement at review/post', async () => {
      expect(() =>
        repo.uploadBookEvidence(context, bookId, 'unsafe', {
          filename: 'unsafe.xml',
          format: 'ubl',
          sourceText: '<!DOCTYPE x SYSTEM "file:///etc/passwd">' + ublInvoice,
        }),
      ).toThrow('unsafe');
      const bad = String(
        (
          await repo.uploadBookEvidence(context, bookId, 'bad-total', {
            filename: 'bad.xml',
            format: 'cii',
            sourceText: ciiInvoice.replace(
              '<ram:DuePayableAmount>119.00',
              '<ram:DuePayableAmount>100.00',
            ),
          })
        ).id,
      );
      expect(
        (await repo.inspectStructuredInvoice(context, bookId, bad))
          .blockingIssues,
      ).toContain('finance-invoice-total-reconciliation-required');
      const foreign = { ...context, workspaceId: randomUUID() };
      await expect(
        repo.inspectStructuredInvoice(foreign, bookId, bad),
      ).rejects.toThrow();
      await expect(
        repo.getStructuredInvoiceReviewDraft(foreign, bookId, bad),
      ).rejects.toThrow();
      const source = await repo.inspectStructuredInvoice(context, bookId, bad);
      await expect(
        repo.saveStructuredInvoiceReviewDraft(
          foreign,
          bookId,
          bad,
          'foreign-review',
          {
            expectedRevision: 0,
            draft: {
              expectedSourceDigest: source.sourceDigest,
              expectedAdapterVersion: source.adapterVersion,
              kind: 'supplier-bill',
              partyId: null,
              controlAccountId: null,
              acknowledgedSourceParties: false,
              acknowledgedTaxGroupAggregation: false,
              acknowledgedNoConformanceValidation: false,
              groups: [],
            },
          },
        ),
      ).rejects.toThrow();
    });
  },
);

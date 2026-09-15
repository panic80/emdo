import { withDurableTransaction } from './durable/scoped-transaction.js';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  FinanceCurrency,
  PrepareFinanceAutomationJournalDraftResult,
} from '@emdo/contracts';
import {
  FinanceBookEvidenceCrypto,
  EncryptedFinanceBookEvidenceSchema,
} from '../../integrations/src/finance-documents/book-evidence-crypto.js';
import { InMemoryVaultKeyProvider } from '../../integrations/src/vault/crypto.js';
import { PostgresFinanceV2Repository } from './finance-v2-repository.js';
import { FinanceJournalDraftRepository } from './finance-journal-draft-repository.js';
import {
  PostgresFinanceAutomationRepository,
  PostgresFinanceAutomationExecutionRepository,
} from './finance-automation-repository.js';
import { PostgresFinanceJournalDraftExecutionRepository } from './finance-journal-draft-execution-repository.js';

const databaseUrl = process.env.FINANCE_V2_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  'reviewed journal draft lifecycle on restricted PostgreSQL',
  () => {
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const login = `journal_draft_${randomUUID().replaceAll('-', '')}`;
    let app: pg.Pool;
    const appPool = {
      async connect() {
        const client = await app.connect();
        await client.query('set role emdo_app');
        return client;
      },
    };
    const workerPool = {
      async connect() {
        const client = await app.connect();
        await client.query('set role emdo_worker_executor');
        return client;
      },
    };
    const context = {
      workspaceId: randomUUID(),
      userId: randomUUID(),
      sessionId: randomUUID(),
      requestId: randomUUID(),
    };
    let finance: PostgresFinanceV2Repository;
    let drafts: FinanceJournalDraftRepository;
    let automations: PostgresFinanceAutomationRepository;
    const executions = new PostgresFinanceAutomationExecutionRepository(
      workerPool,
    );
    const generator = new PostgresFinanceJournalDraftExecutionRepository(
      workerPool,
    );
    beforeAll(async () => {
      await admin.query(
        `create role "${login}" login nosuperuser nobypassrls noinherit`,
      );
      await admin.query(`grant emdo_app,emdo_worker_executor to "${login}"`);
      const url = new URL(databaseUrl!);
      url.username = login;
      app = new pg.Pool({ connectionString: url.toString() });
      const cipher = new FinanceBookEvidenceCrypto(
        new InMemoryVaultKeyProvider(
          new Uint8Array(32).fill(27),
          'finance-documents.v1',
        ),
      );
      finance = new PostgresFinanceV2Repository(appPool, {
        evidenceCipher: {
          encrypt: (value, scope) => cipher.encrypt(value, scope),
          decrypt: (value, scope) =>
            cipher.decrypt(
              EncryptedFinanceBookEvidenceSchema.parse(value),
              scope,
            ),
        },
      });
      drafts = new FinanceJournalDraftRepository(appPool, finance);
      automations = new PostgresFinanceAutomationRepository(appPool);
      await admin.query(
        'insert into emdo.auth_users(id,name,email,email_verified) values($1,$2,$3,true)',
        [context.userId, 'Draft synthetic', `${context.userId}@example.test`],
      );
      await admin.query(
        'insert into emdo.households(id,name,created_by_user_id,slug) values($1::uuid,$2,$3,$1::text)',
        [context.workspaceId, 'Draft synthetic', context.userId],
      );
      await admin.query(
        "insert into emdo.household_memberships(household_id,user_id,role) values($1,$2,'owner')",
        [context.workspaceId, context.userId],
      );
      await admin.query(
        "insert into emdo.auth_sessions(id,user_id,token,expires_at,active_household_id) values($1::uuid,$2,$1::text,now()+interval '1 day',$3)",
        [context.sessionId, context.userId, context.workspaceId],
      );
      await admin.query(
        "insert into emdo.workspace_entitlements(workspace_id,capability,enabled) values($1,'finance.automations.run',true)",
        [context.workspaceId],
      );
      await admin.query(
        "update emdo.finance_automation_capabilities set ready=true where capability='finance.journals.draft'",
      );
    });
    afterAll(async () => {
      await app?.end();
      await admin.query(`drop role if exists "${login}"`);
      await admin.end();
    });

    async function fixture(
      currency: FinanceCurrency = 'CAD',
      nativeCurrency: FinanceCurrency = currency,
    ) {
      const bookId = String(
        (
          await finance.createBook(context, randomUUID(), {
            name: 'Journal test',
            entityName: 'Synthetic entity',
            entityKind: 'corporation',
            country: 'CA',
            functionalCurrency: currency,
          })
        ).id,
      );
      const cash = String(
        (
          await finance.createAccount(context, bookId, randomUUID(), {
            code: '1000',
            name: 'Cash',
            kind: 'asset',
          })
        ).id,
      );
      const counter = String(
        (
          await finance.createAccount(context, bookId, randomUUID(), {
            code: '3000',
            name: 'Capital',
            kind: 'equity',
          })
        ).id,
      );
      const fee = String(
        (
          await finance.createAccount(context, bookId, randomUUID(), {
            code: '6000',
            name: 'Fee',
            kind: 'expense',
          })
        ).id,
      );
      const financialAccountId = String(
        (
          await finance.createFinancialAccount(context, bookId, randomUUID(), {
            name: 'Draft bank',
            kind: 'bank',
            currency: nativeCurrency,
            ledgerAccountId: cash,
          })
        ).id,
      );
      await finance.createPeriod(context, bookId, randomUUID(), {
        startsOn: '2026-01-01',
        endsOn: '2026-12-31',
      });
      const grant = await automations.createGrant(context, bookId, {
        capabilities: ['finance.journals.draft'],
        limits: {
          maxRuns: 30,
          maxAttemptsPerRun: 2,
          maxItemsPerRun: 100,
          maxTotalItems: 3000,
          currency,
          maxAmountPerRun: '9999999999999999',
          maxTotalAmount: '9999999999999999',
        },
        validFrom: new Date(Date.now() - 60000).toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
      return {
        bookId,
        cash,
        counter,
        fee,
        financialAccountId,
        grantId: grant.id,
        currency,
        nativeCurrency,
      };
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    async function source(
      f: Fixture,
      amount = '123.45',
      rate = '1',
      externalId = randomUUID(),
    ) {
      const batchId = String(
        (
          await finance.uploadNormalizedStatement(
            context,
            f.bookId,
            randomUUID(),
            {
              financialAccountId: f.financialAccountId,
              filename: 'reviewed.csv',
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
      const row = (
        await finance.getNormalizedImport(context, f.bookId, batchId)
      ).rows[0]!;
      await finance.reviewNormalizedImportRow(
        context,
        f.bookId,
        String(row.id),
        randomUUID(),
        {
          expectedRevision: 1,
          action: 'post',
          counterAccountId: f.counter,
          fxRate: rate,
          fxSource: rate === '1' ? 'identity' : 'Reviewed bank FX',
          reason: 'Checked original receipt',
        },
      );
      return { batchId, rowId: String(row.id), externalId };
    }
    async function prepare(f: Fixture, batchId: string) {
      return drafts.prepareJournalDraft(context, f.bookId, randomUUID(), {
        batchId,
      });
    }
    async function enqueue(
      f: Fixture,
      prepared: PrepareFinanceAutomationJournalDraftResult,
      operationId = randomUUID(),
    ) {
      return automations.enqueueRun(context, f.bookId, {
        operationId,
        grantId: f.grantId,
        capability: 'finance.journals.draft',
        targets: [prepared.journal.batchId],
        currency: prepared.currency,
        amount: prepared.amount,
        journal: prepared.journal,
      });
    }
    async function generate(
      f: Fixture,
      run: Awaited<ReturnType<typeof enqueue>>,
    ) {
      const claim = await executions.claimDelivery(run.request.operationId, 1);
      expect(claim.status).toBe('claimed');
      if (claim.status !== 'claimed')
        throw new Error('Expected restricted worker claim');
      const input = {
        operationId: run.request.operationId,
        expectedRevision: claim.run.revision,
        leaseToken: claim.leaseToken,
      };
      const generated = await generator.generateJournalDraft(input);
      const result = await drafts.readJournalDraftResult(
        context,
        f.bookId,
        generated.resultId,
      );
      expect(result).not.toBeNull();
      return { draft: result!, input };
    }
    async function ready(f: Fixture, batchId: string) {
      const prepared = await prepare(f, batchId);
      const run = await enqueue(f, prepared);
      return { prepared, run, ...(await generate(f, run)) };
    }
    async function count(f: Fixture) {
      return Number(
        (
          await admin.query(
            'select count(*) from emdo.finance_journals where workspace_id=$1 and book_id=$2',
            [context.workspaceId, f.bookId],
          )
        ).rows[0].count,
      );
    }
    async function approve(
      f: Fixture,
      draft: Awaited<ReturnType<typeof generate>>['draft'],
    ) {
      return drafts.reviewJournalDraft(
        context,
        f.bookId,
        draft.id,
        randomUUID(),
        {
          expectedRevision: draft.revision,
          decision: 'approved',
          reason: 'Verified proposal and source',
        },
      );
    }
    async function postedLines(f: Fixture, ids: string[]) {
      return (
        await admin.query(
          'select account_id as "accountId", side, amount::text, currency, native_amount::text as "nativeAmount",fx_rate::text as "fxRate",fx_source as "fxSource", description from emdo.finance_journal_lines where workspace_id=$1 and book_id=$2 and journal_id=any($3::uuid[]) order by journal_id,line_number',
          [context.workspaceId, f.bookId, ids],
        )
      ).rows;
    }
    // Normalize only insignificant trailing zeroes; never use Number for money.
    const decimal = (s: string) =>
      s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
    const comparable = (
      lines: Record<string, unknown>[],
    ): Record<string, unknown>[] =>
      lines.map((line) => ({
        ...line,
        amount: decimal(String(line.amount)),
        nativeAmount: decimal(String(line.nativeAmount)),
        fxRate: decimal(String(line.fxRate)),
      }));

    it('prepares and enqueues the exact reviewed snapshot under restricted app authority', async () => {
      const f = await fixture();
      const s = await source(f);
      const prepared = await prepare(f, s.batchId);
      expect(prepared).toMatchObject({
        amount: '123.45',
        currency: 'CAD',
        itemCount: 2,
        journal: { batchId: s.batchId, expectedBatchRevision: 2 },
      });
      const operationId = randomUUID();
      const first = await enqueue(f, prepared, operationId);
      const retry = await enqueue(f, prepared, operationId);
      expect(retry).toEqual(first);
      expect(first.request).toMatchObject({
        operationId,
        capability: 'finance.journals.draft',
        itemCount: 2,
        journal: prepared.journal,
      });
      expect(decimal(first.request.amount)).toBe('123.45');
      expect(await count(f)).toBe(0);
    });

    it('posts the exact 123.45 CAD proposal once under concurrent canonical retries', async () => {
      const f = await fixture();
      const s = await source(f);
      const { prepared, draft, input } = await ready(f, s.batchId);
      expect(prepared).toMatchObject({
        amount: '123.45',
        itemCount: 2,
        currency: 'CAD',
      });
      expect(draft.status).toBe('review_required');
      expect(await count(f)).toBe(0);
      expect(draft.proposal.journals).toHaveLength(1);
      expect(
        comparable(draft.proposal.journals[0]!.lines).map((l) => [
          l.accountId,
          l.side,
          l.amount,
        ]),
      ).toEqual([
        [f.cash, 'debit', '123.45'],
        [f.counter, 'credit', '123.45'],
      ]);
      expect(await generator.generateJournalDraft(input)).toEqual({
        resultId: draft.id,
      });
      await expect(
        drafts.postJournalDraft(context, f.bookId, draft.id, randomUUID(), {
          expectedRevision: draft.revision,
        }),
      ).rejects.toThrow();
      expect(await count(f)).toBe(0);
      const approved = await approve(f, draft);
      const key = randomUUID();
      const [posted, retry] = await Promise.all(
        [0, 1].map(() =>
          drafts.postJournalDraft(context, f.bookId, draft.id, key, {
            expectedRevision: approved.revision,
          }),
        ),
      );
      expect(retry).toEqual(posted);
      expect(posted!.status).toBe('posted');
      expect(await count(f)).toBe(1);
      expect(
        comparable(await postedLines(f, posted!.postedJournalIds)),
      ).toEqual(comparable(draft.proposal.journals[0]!.lines));
      expect(posted!.events.filter((e) => e.kind === 'posted')).toHaveLength(1);
      expect(
        (await finance.getNormalizedImport(context, f.bookId, s.batchId)).batch
          .status,
      ).toBe('committed');
    });

    it.each([
      {
        currency: 'CAD' as const,
        native: 'USD' as const,
        amount: '100.01',
        rate: '1.2345',
        expected: '123.46',
      },
      {
        currency: 'JPY' as const,
        native: 'USD' as const,
        amount: '1.01',
        rate: '150.5',
        expected: '152',
      },
      {
        currency: 'CAD' as const,
        native: 'CAD' as const,
        amount: '9007199254740993.01',
        rate: '1',
        expected: '9007199254740993.01',
      },
    ])(
      'preserves known exact $currency amount $expected through generation and posting',
      async ({ currency, native, amount, rate, expected }) => {
        const f = await fixture(currency, native);
        const s = await source(f, amount, rate);
        const { draft } = await ready(f, s.batchId);
        expect(decimal(draft.amount)).toBe(expected);
        expect(
          draft.proposal.journals[0]!.lines.map((l) => decimal(l.amount)),
        ).toEqual([expected, expected]);
        const approved = await approve(f, draft);
        const posted = await drafts.postJournalDraft(
          context,
          f.bookId,
          draft.id,
          randomUUID(),
          { expectedRevision: approved.revision },
        );
        expect(
          comparable(await postedLines(f, posted.postedJournalIds)),
        ).toEqual(comparable(draft.proposal.journals[0]!.lines));
      },
    );

    it('preserves reviewed fee and principal evidence and exact USD component FX lines', async () => {
      const f = await fixture('CAD', 'USD');
      const headers = [
        'Date',
        'Description',
        'Amount',
        'Currency',
        'Fee',
        'Principal',
      ];
      const cells = ['2026-03-10', 'Buy shares', '-103', 'USD', '3', '100'];
      const evidence = await finance.uploadBookEvidence(
        context,
        f.bookId,
        randomUUID(),
        {
          filename: 'components.csv',
          format: 'csv',
          sourceText: `${headers.join(',')}\n${cells.join(',')}`,
        },
      );
      const mapping = await finance.saveReportMapping(
        context,
        f.bookId,
        randomUUID(),
        {
          proposal: {
            definition: {
              providerKey: 'draft-bank',
              reportName: 'Trading activity',
              reportType: 'bank-transactions',
              layoutVersion: '1',
              headers,
              bindings: [
                'transactionDate',
                'description',
                'amount',
                'currency',
                'fee',
                'principal',
              ].map((field, i) => ({
                field,
                column: headers[i],
                context: null,
              })),
              dateFormat: 'yyyy-mm-dd',
              decimalSeparator: '.',
              groupingSeparator: '',
              quantityUnit: null,
              valuationMultiplier: null,
              identifierScheme: null,
              identifierNamespace: null,
            },
            rationale: 'Verified trading statement columns',
            unresolvedQuestions: [],
          },
          example: {
            documentId: evidence.id,
            extractionRevision: 1,
            tableId: 'csv:1',
            page: null,
            sheet: 'CSV',
            providerKey: 'draft-bank',
            reportType: 'bank-transactions',
            headers,
            context: { asOf: null, currency: null },
            rows: [{ sourceRow: 2, cells }],
          },
        },
      );
      await finance.reviewReportMapping(
        context,
        f.bookId,
        String(mapping.id),
        randomUUID(),
        {
          expectedRevision: 1,
          decision: 'approve',
          reason: 'Verified original columns',
        },
      );
      const batchId = String(
        (
          await finance.importMappedReport(
            context,
            f.bookId,
            String(mapping.id),
            randomUUID(),
            {
              evidenceId: evidence.id,
              financialAccountId: f.financialAccountId,
              expectedMappingVersion: 1,
              providerKey: 'draft-bank',
            },
          )
        ).id,
      );
      const row = (
        await finance.getNormalizedImport(context, f.bookId, batchId)
      ).rows[0]!;
      await finance.reviewNormalizedImportRow(
        context,
        f.bookId,
        String(row.id),
        randomUUID(),
        {
          expectedRevision: 1,
          action: 'post',
          fxRate: '1.25',
          fxSource: 'Reviewed bank FX',
          reason: 'Verified fee principal and FX',
          componentMappings: [
            {
              kind: 'fee',
              nativeAmount: '3',
              currency: 'USD',
              inclusion: 'included-in-net',
              postingSide: 'debit',
              ledgerAccountId: f.fee,
              fxRate: '1.25',
              fxSource: 'Reviewed bank FX',
            },
            {
              kind: 'principal',
              nativeAmount: '100',
              currency: 'USD',
              inclusion: 'included-in-net',
              postingSide: 'debit',
              ledgerAccountId: f.counter,
              fxRate: '1.25',
              fxSource: 'Reviewed bank FX',
            },
          ],
        },
      );
      const { draft, prepared } = await ready(f, batchId);
      expect(prepared).toMatchObject({ amount: '128.75', itemCount: 3 });
      expect(
        comparable(draft.proposal.journals[0]!.lines).map((l) => [
          l.accountId,
          l.side,
          l.amount,
        ]),
      ).toEqual([
        [f.cash, 'credit', '128.75'],
        [f.fee, 'debit', '3.75'],
        [f.counter, 'debit', '125'],
      ]);
      const approved = await approve(f, draft);
      const posted = await drafts.postJournalDraft(
        context,
        f.bookId,
        draft.id,
        randomUUID(),
        { expectedRevision: approved.revision },
      );
      expect(comparable(await postedLines(f, posted.postedJournalIds))).toEqual(
        comparable(draft.proposal.journals[0]!.lines),
      );
      const proof = (
        await admin.query(
          'select component_kind,native_amount::text,functional_amount::text,journal_line_number,source_provenance from emdo.finance_economic_transaction_amount_components where book_id=$1 order by component_kind',
          [f.bookId],
        )
      ).rows;
      expect(
        proof.map((p) => [
          p.component_kind,
          decimal(p.native_amount),
          decimal(p.functional_amount),
          p.journal_line_number,
        ]),
      ).toEqual([
        ['fee', '3', '3.75', 2],
        ['principal', '100', '125', 3],
      ]);
      expect(proof.map((p) => p.source_provenance.raw)).toEqual(['3', '100']);
    });

    it('retains two distinct posted journal identities for otherwise identical reviewed rows', async () => {
      const f = await fixture();
      const batchId = String(
        (
          await finance.uploadNormalizedStatement(
            context,
            f.bookId,
            randomUUID(),
            {
              financialAccountId: f.financialAccountId,
              filename: 'two-receipts.csv',
              format: 'csv',
              sourceText: `Date,Description,Amount,ID\n2026-03-08,Reviewed receipt,123.45,${randomUUID()}\n2026-03-08,Reviewed receipt,123.45,${randomUUID()}`,
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
      const rows = (
        await finance.getNormalizedImport(context, f.bookId, batchId)
      ).rows;
      expect(rows).toHaveLength(2);
      for (const row of rows)
        await finance.reviewNormalizedImportRow(
          context,
          f.bookId,
          String(row.id),
          randomUUID(),
          {
            expectedRevision: 1,
            action: 'post',
            counterAccountId: f.counter,
            acknowledgePossibleDuplicate: true,
            reason: 'Original receipts prove two separate transactions',
          },
        );
      const { draft } = await ready(f, batchId);
      expect(draft.proposal.journals).toHaveLength(2);
      expect(decimal(draft.amount)).toBe('246.9');
      expect(draft.itemCount).toBe(4);
      const approved = await approve(f, draft);
      const posted = await drafts.postJournalDraft(
        context,
        f.bookId,
        draft.id,
        randomUUID(),
        { expectedRevision: approved.revision },
      );
      expect(new Set(posted.postedJournalIds).size).toBe(2);
      expect(await count(f)).toBe(2);
      expect(await postedLines(f, posted.postedJournalIds)).toHaveLength(4);
      for (const proposal of draft.proposal.journals) {
        const journal = (
          await admin.query(
            'select id from emdo.finance_journals where book_id=$1 and source_reference=$2',
            [f.bookId, proposal.sourceReference],
          )
        ).rows;
        expect(journal).toHaveLength(1);
        expect(posted.postedJournalIds).toContain(journal[0].id);
        expect(comparable(await postedLines(f, [journal[0].id]))).toEqual(
          comparable(proposal.lines),
        );
      }
    });

    it('prevents overlapping source identities from posting twice', async () => {
      const f = await fixture();
      const externalId = randomUUID();
      const first = await source(f, '123.45', '1', externalId);
      const overlap = await source(f, '123.45', '1', externalId);
      const a = await ready(f, first.batchId);
      const b = await ready(f, overlap.batchId);
      const aa = await approve(f, a.draft);
      const bb = await approve(f, b.draft);
      await drafts.postJournalDraft(
        context,
        f.bookId,
        a.draft.id,
        randomUUID(),
        { expectedRevision: aa.revision },
      );
      await expect(
        drafts.postJournalDraft(context, f.bookId, b.draft.id, randomUUID(), {
          expectedRevision: bb.revision,
        }),
      ).rejects.toThrow();
      expect(await count(f)).toBe(1);
      expect(
        (await drafts.readJournalDraftResult(context, f.bookId, b.draft.id))
          ?.postedJournalIds,
      ).toEqual([]);
    });

    it('honors automation grant revocation after enqueue before worker generation', async () => {
      const f = await fixture();
      const s = await source(f);
      const run = await enqueue(f, await prepare(f, s.batchId));
      await automations.revokeGrant(context, f.bookId, f.grantId);
      const claim = await executions.claimDelivery(run.request.operationId, 1);
      expect(claim.status).toBe('denied');
      expect(await count(f)).toBe(0);
    });

    it('rejects a changed reviewed source before enqueue and before generation', async () => {
      const f = await fixture();
      const s = await source(f);
      const prepared = await prepare(f, s.batchId);
      await finance.reviewNormalizedImportRow(
        context,
        f.bookId,
        s.rowId,
        randomUUID(),
        {
          expectedRevision: 2,
          action: 'post',
          counterAccountId: f.counter,
          correction: { description: 'Corrected reviewed source' },
          reason: 'Corrected source description',
        },
      );
      await expect(enqueue(f, prepared)).rejects.toThrow();
      const current = await prepare(f, s.batchId);
      const run = await enqueue(f, current);
      // Simulate a separate authorized administrative mapping change.
      await withDurableTransaction(
        admin,
        { ...context, householdId: context.workspaceId },
        { householdId: context.workspaceId },
        (c) =>
          c.query(
            'update emdo.finance_financial_accounts set ledger_account_id=$2 where id=$1',
            [f.financialAccountId, f.fee],
          ),
      );
      const claim = await executions.claimDelivery(run.request.operationId, 1);
      if (claim.status === 'claimed')
        await expect(
          generator.generateJournalDraft({
            operationId: run.request.operationId,
            expectedRevision: claim.run.revision,
            leaseToken: claim.leaseToken,
          }),
        ).rejects.toThrow();
      else expect(claim.status).toBe('denied');
      expect(await count(f)).toBe(0);
    });

    it('rejects approval if the reviewed row changed after generation', async () => {
      const f = await fixture();
      const s = await source(f);
      const { draft } = await ready(f, s.batchId);
      await finance.reviewNormalizedImportRow(
        context,
        f.bookId,
        s.rowId,
        randomUUID(),
        {
          expectedRevision: 2,
          action: 'post',
          counterAccountId: f.counter,
          correction: { description: 'New source correction' },
          reason: 'New source description verified',
        },
      );
      await expect(approve(f, draft)).rejects.toThrow();
      expect(await count(f)).toBe(0);
      expect(
        (await drafts.readJournalDraftResult(context, f.bookId, draft.id))
          ?.review,
      ).toBeNull();
    });

    it('rechecks revoked automation authority after a worker claim', async () => {
      const f = await fixture();
      const s = await source(f);
      const run = await enqueue(f, await prepare(f, s.batchId));
      const claim = await executions.claimDelivery(run.request.operationId, 1);
      expect(claim.status).toBe('claimed');
      if (claim.status !== 'claimed') throw new Error('Expected claim');
      await automations.revokeGrant(context, f.bookId, f.grantId);
      await expect(
        generator.generateJournalDraft({
          operationId: run.request.operationId,
          expectedRevision: claim.run.revision,
          leaseToken: claim.leaseToken,
        }),
      ).rejects.toThrow();
      expect(await count(f)).toBe(0);
    });

    it('invalidates saved approval when the current bank account mapping changes', async () => {
      const f = await fixture();
      const s = await source(f);
      const { draft } = await ready(f, s.batchId);
      const approved = await approve(f, draft);
      // Simulate a separate authorized administrative mapping change.
      await withDurableTransaction(
        admin,
        { ...context, householdId: context.workspaceId },
        { householdId: context.workspaceId },
        (c) =>
          c.query(
            'update emdo.finance_financial_accounts set ledger_account_id=$2 where id=$1',
            [f.financialAccountId, f.fee],
          ),
      );
      await expect(
        drafts.postJournalDraft(context, f.bookId, draft.id, randomUUID(), {
          expectedRevision: approved.revision,
        }),
      ).rejects.toThrow();
      expect(await count(f)).toBe(0);
      const saved = await drafts.readJournalDraftResult(
        context,
        f.bookId,
        draft.id,
      );
      expect(saved?.postedJournalIds).toEqual([]);
    });

    it('discards without creating ledger entries and cannot later approve or post', async () => {
      const f = await fixture();
      const s = await source(f);
      const { draft } = await ready(f, s.batchId);
      const discarded = await drafts.discardJournalDraft(
        context,
        f.bookId,
        draft.id,
        randomUUID(),
        {
          expectedRevision: draft.revision,
          reason: 'Duplicate proposal no longer needed',
        },
      );
      expect(discarded.status).toBe('discarded');
      expect(await count(f)).toBe(0);
      await expect(approve(f, discarded)).rejects.toThrow();
      await expect(
        drafts.postJournalDraft(context, f.bookId, draft.id, randomUUID(), {
          expectedRevision: discarded.revision,
        }),
      ).rejects.toThrow();
      expect(await count(f)).toBe(0);
    });

    it('rejects posting after current book authority is revoked', async () => {
      const f = await fixture();
      const s = await source(f);
      const { draft } = await ready(f, s.batchId);
      const approved = await approve(f, draft);
      await admin.query(
        'update emdo.finance_book_grants set revoked_at=now() where workspace_id=$1 and book_id=$2 and user_id=$3',
        [context.workspaceId, f.bookId, context.userId],
      );
      await expect(
        drafts.postJournalDraft(context, f.bookId, draft.id, randomUUID(), {
          expectedRevision: approved.revision,
        }),
      ).rejects.toThrow();
      expect(await count(f)).toBe(0);
    });
  },
);

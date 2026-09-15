import type {
  CommitInvestmentStockSplitSettlement,
  WorkspaceContext,
} from '@emdo/contracts';
import { PostgresFinanceCorporateActionRepository } from './finance-corporate-action-repository.js';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresFinanceV2Repository } from './finance-v2-repository.js';
import { FinanceInvestmentReconciliationRepository } from './finance-investment-reconciliation-repository.js';
import {
  FinanceBookEvidenceCrypto,
  EncryptedFinanceBookEvidenceSchema,
} from '../../integrations/src/finance-documents/book-evidence-crypto.js';
import { InMemoryVaultKeyProvider } from '../../integrations/src/vault/crypto.js';
const url = process.env.FINANCE_V2_TEST_DATABASE_URL;
describe.skipIf(!url)(
  'immutable investment reconciliation on restricted PostgreSQL',
  () => {
    const admin = new pg.Pool({ connectionString: url });
    afterAll(() => admin.end());
    const sql = async (text: string, values: unknown[] = []) => {
      const c = await admin.connect();
      try {
        await c.query('reset role');
        return await c.query(text, values);
      } finally {
        c.release();
      }
    };
    it('pins exact saved comparisons, resolves with evidence, detects source changes and explicitly reopens without balancing shares', async () => {
      const context = {
        workspaceId: randomUUID(),
        userId: randomUUID(),
        sessionId: randomUUID(),
        requestId: randomUUID(),
      };
      await sql(
        "insert into emdo.auth_users(id,name,email,email_verified)values($1,'Investor',$2,true)",
        [context.userId, `${context.userId}@example.test`],
      );
      await sql(
        "insert into emdo.households(id,name,slug,created_by_user_id)values($1,'Investments',$2,$3)",
        [context.workspaceId, context.workspaceId, context.userId],
      );
      await sql(
        "insert into emdo.household_memberships(household_id,user_id,role)values($1,$2,'owner')",
        [context.workspaceId, context.userId],
      );
      await sql(
        "insert into emdo.auth_sessions(id,user_id,token,expires_at,active_household_id)values($1,$2,$3,now()+interval '1day',$4)",
        [
          context.sessionId,
          context.userId,
          context.sessionId,
          context.workspaceId,
        ],
      );
      const pool = {
        async connect() {
          const c = await admin.connect();
          await c.query('set role emdo_app');
          return c;
        },
      };
      const cipher = new FinanceBookEvidenceCrypto(
        new InMemoryVaultKeyProvider(
          new Uint8Array(32).fill(8),
          'finance-documents.v1',
        ),
      );
      const repo = new PostgresFinanceV2Repository(pool, {
        evidenceCipher: {
          encrypt: (v, s) => cipher.encrypt(v, s),
          decrypt: (v, s) =>
            cipher.decrypt(EncryptedFinanceBookEvidenceSchema.parse(v), s),
        },
      });
      const cases = new FinanceInvestmentReconciliationRepository(pool);
      expect(await cases.checkReady()).toBe(true);
      const bookId = String(
        (
          await repo.createBook(context, 'book', {
            name: 'Investments',
            entityName: 'Synthetic',
            entityKind: 'individual',
            country: 'CA',
            functionalCurrency: 'CAD',
          })
        ).id,
      );
      const ledger = await repo.createAccount(context, bookId, 'ledger', {
        code: '1200',
        name: 'Brokerage',
        kind: 'asset',
      });
      const account = await repo.createFinancialAccount(
        context,
        bookId,
        'broker',
        {
          name: 'Brokerage',
          kind: 'brokerage',
          currency: 'CAD',
          ledgerAccountId: ledger.id,
        },
      );
      const instrument = await repo.createInstrument(
        context,
        bookId,
        'instrument',
        {
          name: 'Synthetic fund',
          kind: 'fund',
          quantityUnit: 'unit',
          valuationMultiplier: '1',
          identifiers: [],
        },
      );
      const evidenceId = String(
        (
          await repo.uploadBookEvidence(context, bookId, 'evidence', {
            format: 'csv',
            filename: 'positions.csv',
            sourceText: 'Instrument,Quantity\nSynthetic fund,12\n',
          })
        ).id,
      );
      const opening = await repo.recordInvestmentOpening(
        context,
        bookId,
        'opening',
        {
          financialAccountId: account.id,
          instrumentId: instrument.id,
          asOf: '2026-01-01',
          quantity: '10',
          evidenceId,
          sourceReference: 'Reviewed statement opening',
        },
      );
      const observed = await repo.recordObservedPosition(
        context,
        bookId,
        'observation',
        {
          financialAccountId: account.id,
          instrumentId: instrument.id,
          asOf: '2026-03-31',
          quantity: '12',
          reportedMarketValue: null,
          currency: null,
          evidenceId,
          sourceRow: 2,
        },
      );
      const valuation = {
        asOf: '2026-03-31',
        positions: [
          {
            financialAccountId: account.id,
            instrumentId: instrument.id,
            openingId: opening.id,
            observedPositionId: observed.id,
            priceId: null,
            fxId: null,
          },
        ],
      };
      const saved = await repo.saveInvestmentValuation(
        context,
        bookId,
        'valuation',
        valuation,
      );
      const preview = await cases.preview(context, bookId, {
        valuationRunId: saved.id,
        observedPositionId: observed.id,
      });
      expect(preview).toMatchObject({
        sourcesCurrent: true,
        comparison: {
          observedQuantity: '12.000000000000',
          calculatedQuantity: '10',
          difference: '2',
        },
      });
      const input = {
        valuationRunId: saved.id,
        observedPositionId: observed.id,
        expectedComparisonHash: preview.comparison.comparisonHash,
      };
      await expect(
        cases.create(context, bookId, 'investment-case-wrong-hash', {
          ...input,
          expectedComparisonHash: 'a'.repeat(64),
        }),
      ).rejects.toThrow('Review');
      const created = await cases.create(
        context,
        bookId,
        'investment-case-create',
        input,
      );
      expect(created).toMatchObject({
        status: 'open',
        effectiveStatus: 'open',
        revision: 1,
        accountingEffect: 'none',
      });
      expect(
        await cases.create(context, bookId, 'investment-case-create', input),
      ).toEqual(created);
      const resolution = {
        expectedRevision: 1,
        expectedComparisonHash: preview.comparison.comparisonHash,
        resolution: {
          kind: 'reviewed-explanation',
          explanation:
            'Reviewed statement timing difference; no correction posted.',
          evidenceIds: [evidenceId],
          correctiveRecords: [],
        },
      };
      await expect(
        cases.resolve(
          context,
          bookId,
          created!.id,
          'investment-case-wrong-evidence',
          {
            ...resolution,
            resolution: {
              ...resolution.resolution,
              evidenceIds: [randomUUID()],
            },
          },
        ),
      ).rejects.toThrow('evidence');
      const resolved = await cases.resolve(
        context,
        bookId,
        created!.id,
        'investment-case-resolve',
        resolution,
      );
      expect(resolved).toMatchObject({
        status: 'resolved',
        revision: 2,
        comparison: { difference: '2' },
      });
      expect(
        await cases.resolve(
          context,
          bookId,
          created!.id,
          'investment-case-resolve',
          resolution,
        ),
      ).toEqual(resolved);
      await expect(
        sql(
          'update emdo.finance_investment_reconciliation_events set event=event where case_id=$1',
          [created!.id],
        ),
      ).rejects.toThrow();
      expect((await cases.list(context, bookId, 0, 1)).total).toBe(1);
      // Existing observations are immutable. A new selected opening is an explicit reviewed correction.
      const correctedOpening = await repo.recordInvestmentOpening(
        context,
        bookId,
        'corrected-opening',
        {
          financialAccountId: account.id,
          instrumentId: instrument.id,
          asOf: '2026-01-01',
          quantity: '12',
          evidenceId,
          sourceReference: 'Reviewed corrected opening',
        },
      );
      const updated = await repo.saveInvestmentValuation(
        context,
        bookId,
        'valuation-corrected',
        {
          ...valuation,
          positions: [
            { ...valuation.positions[0]!, openingId: correctedOpening.id },
          ],
        },
      );
      const next = await cases.preview(context, bookId, {
        valuationRunId: updated.id,
        observedPositionId: observed.id,
      });
      const reopened = await cases.reopen(
        context,
        bookId,
        created!.id,
        'investment-case-reopen',
        {
          expectedRevision: 2,
          valuationRunId: updated.id,
          observedPositionId: observed.id,
          expectedComparisonHash: next.comparison.comparisonHash,
          reason: 'Reviewed replacement opening now reconciles the statement.',
        },
      );
      expect(reopened).toMatchObject({
        revision: 3,
        status: 'open',
        comparison: { difference: '0' },
      });
      expect(reopened!.history[1]?.comparison.difference).toBe('2');
      const exactQuantity = '-9007199254740993.123456789012';
      const exactReference =
        'Reviewed "123.45" and exponent 1e20 remain source text';
      const exactOpening = await repo.recordInvestmentOpening(
        context,
        bookId,
        'exact-large-opening',
        {
          financialAccountId: account.id,
          instrumentId: instrument.id,
          asOf: '2026-01-01',
          quantity: exactQuantity,
          evidenceId,
          sourceReference: exactReference,
        },
      );
      const corrected = await cases.resolve(
        context,
        bookId,
        created!.id,
        'investment-case-resolve-correction',
        {
          expectedRevision: 3,
          expectedComparisonHash: next.comparison.comparisonHash,
          resolution: {
            kind: 'corrective-records',
            explanation:
              'Explicit corrected opening reviewed against the original statement.',
            evidenceIds: [evidenceId],
            correctiveRecords: [
              { kind: 'opening', id: correctedOpening.id },
              { kind: 'opening', id: exactOpening.id },
            ],
          },
        },
      );
      expect(corrected).toMatchObject({ revision: 4, status: 'resolved' });
      const exactSnapshot = corrected!.history
        .at(-1)!
        .correctiveRecordSnapshots.find(
          (row) => row.id === exactOpening.id,
        )!.snapshot;
      expect(exactSnapshot).toMatchObject({
        quantity: exactQuantity,
        source_reference: exactReference,
      });
      const reread = await cases.get(context, bookId, created!.id);
      expect(reread!.history.at(-1)!.correctiveRecordSnapshots).toEqual(
        corrected!.history.at(-1)!.correctiveRecordSnapshots,
      );
      expect(
        (
          await sql(
            "select event->'correctiveRecordSnapshots'->1->'snapshot'->>'quantity' as quantity from emdo.finance_investment_reconciliation_events where case_id=$1 and revision=4",
            [created!.id],
          )
        ).rows[0]?.quantity,
      ).toBe(exactQuantity);

      expect(
        (await cases.correctiveRecords(context, bookId, created!.id, 0, 100))
          .items,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'opening',
            id: correctedOpening.id,
            evidenceIds: [evidenceId],
          }),
        ]),
      );
      // A separately reviewed real movement changes the valuation source inventory.
      const equity = await repo.createAccount(context, bookId, 'equity', {
        code: '3000',
        name: 'Capital',
        kind: 'equity',
      });
      await repo.createPeriod(context, bookId, 'year', {
        startsOn: '2026-01-01',
        endsOn: '2026-12-31',
      });
      const journal = await repo.postJournal(
        context,
        bookId,
        'reviewed-acquisition',
        {
          effectiveOn: '2026-03-15',
          description: 'Reviewed acquisition',
          sourceReference: 'brokerage acquisition',
          lines: [
            {
              accountId: ledger.id,
              side: 'debit',
              amount: '1',
              currency: 'CAD',
              nativeAmount: '1',
              fxRate: '1',
              fxSource: 'identity',
            },
            {
              accountId: equity.id,
              side: 'credit',
              amount: '1',
              currency: 'CAD',
              nativeAmount: '1',
              fxRate: '1',
              fxSource: 'identity',
            },
          ],
        },
      );
      await repo.recordInvestmentMovement(
        context,
        bookId,
        'reviewed-movement',
        {
          financialAccountId: account.id,
          instrumentId: instrument.id,
          effectiveOn: '2026-03-15',
          quantity: '1',
          journalId: String(journal.id),
          sourceReference: 'brokerage acquisition',
        },
      );
      expect(await cases.get(context, bookId, created!.id)).toMatchObject({
        status: 'resolved',
        effectiveStatus: 'reopen-required',
        sourcesCurrent: false,
        revision: 4,
      });
      await expect(
        cases.resolve(context, bookId, created!.id, 'investment-case-stale', {
          ...resolution,
          expectedRevision: 4,
          expectedComparisonHash: next.comparison.comparisonHash,
        }),
      ).rejects.toThrow('reopening');
      expect(
        (
          await sql(
            'select quantity::text from emdo.finance_observed_positions where id=$1',
            [observed.id],
          )
        ).rows[0]?.quantity,
      ).toBe('12.000000000000');
      expect(
        (
          await sql(
            'select count(*)::int n from emdo.finance_investment_movements where book_id=$1',
            [bookId],
          )
        ).rows[0]?.n,
      ).toBe(1);
      await sql(
        'update emdo.finance_book_grants set revoked_at=now() where book_id=$1 and user_id=$2',
        [bookId, context.userId],
      );
      await expect(cases.get(context, bookId, created!.id)).rejects.toThrow(
        'access',
      );
      await expect(
        cases.create(context, bookId, 'investment-case-create', input),
      ).rejects.toThrow('access');
    });
  },
);

// These synthetic setup steps reuse the accepted corporate-action fixture pattern.
// All corrections below are committed through their real restricted repositories.
async function assertCommittedCorrectionLink(
  repository: PostgresFinanceV2Repository,
  cases: FinanceInvestmentReconciliationRepository,
  context: WorkspaceContext,
  bookId: string,
  financialAccountId: string,
  instrumentId: string,
  evidenceId: string,
  kind: 'stock-split' | 'split-settlement' | 'cash-dividend',
  id: string,
) {
  const date =
    kind === 'stock-split'
      ? '2026-09-20'
      : kind === 'split-settlement'
        ? '2026-09-21'
        : '2026-09-22';
  const observed = await repository.recordObservedPosition(
    context,
    bookId,
    `link-observation-${kind}`,
    {
      financialAccountId,
      instrumentId,
      asOf: date,
      quantity: '99',
      reportedMarketValue: null,
      currency: null,
      evidenceId,
      sourceRow:
        kind === 'stock-split' ? 20 : kind === 'split-settlement' ? 21 : 22,
    },
  );
  const valuation = await repository.saveInvestmentValuation(
    context,
    bookId,
    `link-valuation-${kind}`,
    {
      asOf: date,
      positions: [
        {
          financialAccountId,
          instrumentId,
          openingId: null,
          priceId: null,
          fxId: null,
          observedPositionId: observed.id,
        },
      ],
    },
  );
  const preview = await cases.preview(context, bookId, {
    valuationRunId: valuation.id,
    observedPositionId: observed.id,
  });
  const created = await cases.create(
    context,
    bookId,
    `link-case-create-${kind}`,
    {
      valuationRunId: valuation.id,
      observedPositionId: observed.id,
      expectedComparisonHash: preview.comparison.comparisonHash,
    },
  );
  expect(
    (await cases.correctiveRecords(context, bookId, created!.id, 0, 100)).items,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind,
        id,
        evidenceIds: expect.arrayContaining([evidenceId]),
      }),
    ]),
  );
  const resolution = {
    expectedRevision: 1,
    expectedComparisonHash: preview.comparison.comparisonHash,
    resolution: {
      kind: 'corrective-records' as const,
      explanation:
        'Reviewed committed corporate action against its saved original evidence.',
      evidenceIds: [evidenceId],
      correctiveRecords: [{ kind, id }],
    },
  };
  await expect(
    cases.resolve(context, bookId, created!.id, `link-invalid-${kind}`, {
      ...resolution,
      resolution: {
        ...resolution.resolution,
        correctiveRecords: [{ kind, id: randomUUID() }],
      },
    }),
  ).rejects.toThrow('Corrective record');
  const otherInstrument = await repository.createInstrument(
    context,
    bookId,
    `other-instrument-${kind}`,
    {
      name: `Other ${kind}`,
      kind: 'fund',
      quantityUnit: 'unit',
      valuationMultiplier: '1',
      identifiers: [],
    },
  );
  const otherObserved = await repository.recordObservedPosition(
    context,
    bookId,
    `other-observation-${kind}`,
    {
      financialAccountId,
      instrumentId: otherInstrument.id,
      asOf: date,
      quantity: '99',
      reportedMarketValue: null,
      currency: null,
      evidenceId,
      sourceRow:
        kind === 'stock-split' ? 30 : kind === 'split-settlement' ? 31 : 32,
    },
  );
  const otherValuation = await repository.saveInvestmentValuation(
    context,
    bookId,
    `other-valuation-${kind}`,
    {
      asOf: date,
      positions: [
        {
          financialAccountId,
          instrumentId: otherInstrument.id,
          openingId: null,
          priceId: null,
          fxId: null,
          observedPositionId: otherObserved.id,
        },
      ],
    },
  );
  const otherPreview = await cases.preview(context, bookId, {
    valuationRunId: otherValuation.id,
    observedPositionId: otherObserved.id,
  });
  const otherCase = await cases.create(
    context,
    bookId,
    `other-case-create-${kind}`,
    {
      valuationRunId: otherValuation.id,
      observedPositionId: otherObserved.id,
      expectedComparisonHash: otherPreview.comparison.comparisonHash,
    },
  );
  expect(
    (await cases.correctiveRecords(context, bookId, otherCase!.id, 0, 100))
      .items,
  ).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ kind, id })]),
  );
  await expect(
    cases.resolve(context, bookId, otherCase!.id, `link-crossscope-${kind}`, {
      ...resolution,
      expectedComparisonHash: otherPreview.comparison.comparisonHash,
    }),
  ).rejects.toThrow('Corrective record');
  const resolved = await cases.resolve(
    context,
    bookId,
    created!.id,
    `link-resolve-${kind}`,
    resolution,
  );
  expect(resolved).toMatchObject({
    status: 'resolved',
    revision: 2,
    accountingEffect: 'none',
  });
  expect(resolved!.history[1]!.correctiveRecordSnapshots).toEqual([
    expect.objectContaining({
      kind,
      id,
      snapshot: expect.objectContaining({ id }),
    }),
  ]);
  expect(
    await cases.resolve(
      context,
      bookId,
      created!.id,
      `link-resolve-${kind}`,
      resolution,
    ),
  ).toEqual(resolved);
}
describe.skipIf(!url)(
  'Reconciliation links real stock split and settlement records',
  () => {
    const admin = new pg.Pool({ connectionString: url });
    const login = `settlement_${randomUUID().replaceAll('-', '')}`;
    let app: pg.Pool;
    const pool = {
      async connect() {
        const client = await app.connect();
        await client.query('set role emdo_app');
        return client;
      },
    };
    const repository = new PostgresFinanceV2Repository(pool, {
      evidenceCipher: {
        async encrypt() {
          return {
            algorithm: 'aes-256-gcm',
            schemaVersion: '1',
            aadVersion: '1',
            ciphertext: 'ciphertext',
            nonce: '1234567890abcdef',
            authenticationTag: '1234567890123456789012',
            wrappedKey: 'wrapped-key',
            keyVersion: 'finance-documents.v1',
          };
        },
        async decrypt() {
          return { sourceText: 'cash dividend evidence' };
        },
      },
    });
    const settlements = new PostgresFinanceCorporateActionRepository(pool);
    let command: CommitInvestmentStockSplitSettlement;
    let investmentId: string;
    let lotId: string;
    let closedLotId: string;
    const context: WorkspaceContext = {
      workspaceId: randomUUID(),
      userId: randomUUID(),
      sessionId: randomUUID(),
      requestId: randomUUID(),
    };
    let bookId: string;
    let cashLedgerId: string;
    let incomeLedgerId: string;
    let withholdingLedgerId: string;
    let financialAccountId: string;
    let instrumentId: string;
    let evidenceId: string;
    let sourceRowId: string;

    async function sql(text: string, values: unknown[] = []) {
      const client = await admin.connect();
      try {
        await client.query('reset role');
        return await client.query(text, values);
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
      const probe = await pool.connect();
      try {
        expect(
          (
            await probe.query(
              "select current_user='emdo_app' and not rolsuper and not rolbypassrls as restricted from pg_roles where rolname=current_user",
            )
          ).rows[0].restricted,
        ).toBe(true);
        await expect(probe.query('set role postgres')).rejects.toThrow();
      } finally {
        probe.release();
      }

      await sql(
        `insert into emdo.auth_users(id,name,email,email_verified)
       values($1,'Dividend test owner',$2,true)`,
        [context.userId, `${context.userId}@example.test`],
      );
      await sql(
        `insert into emdo.households(id,name,slug,created_by_user_id)
       values($1,'Dividend test workspace',$2,$3)`,
        [context.workspaceId, context.workspaceId, context.userId],
      );
      await sql(
        `insert into emdo.household_memberships(household_id,user_id,role)
       values($1,$2,'owner')`,
        [context.workspaceId, context.userId],
      );
      await sql(
        `insert into emdo.auth_sessions(id,user_id,token,expires_at,active_household_id)
       values($1,$2,$3,now()+interval '1 day',$4)`,
        [
          context.sessionId,
          context.userId,
          context.sessionId,
          context.workspaceId,
        ],
      );
      bookId = String(
        (
          await repository.createBook(context, 'dividend-book', {
            name: 'Dividend book',
            entityName: 'Dividend owner',
            entityKind: 'corporation',
            country: 'CA',
            functionalCurrency: 'CAD',
          })
        ).id,
      );
      cashLedgerId = String(
        (
          await repository.createAccount(context, bookId, 'dividend-cash', {
            code: '1000',
            name: 'Cash',
            kind: 'asset',
          })
        ).id,
      );
      incomeLedgerId = String(
        (
          await repository.createAccount(context, bookId, 'dividend-income', {
            code: '4100',
            name: 'Dividend income',
            kind: 'income',
          })
        ).id,
      );
      withholdingLedgerId = String(
        (
          await repository.createAccount(context, bookId, 'dividend-tax', {
            code: '2200',
            name: 'Withholding tax',
            kind: 'expense',
          })
        ).id,
      );
      financialAccountId = String(
        (
          await repository.createFinancialAccount(
            context,
            bookId,
            'dividend-bank',
            {
              name: 'Dividend bank',
              kind: 'brokerage',
              currency: 'CAD',
              ledgerAccountId: cashLedgerId,
            },
          )
        ).id,
      );
      instrumentId = String(
        (
          await repository.createInstrument(context, bookId, 'dividend-stock', {
            name: 'Dividend stock',
            kind: 'equity',
            quantityUnit: 'share',
            valuationMultiplier: '1',
            identifiers: [],
          })
        ).id,
      );
      await repository.createPeriod(context, bookId, 'dividend-period', {
        startsOn: '2026-01-01',
        endsOn: '2026-12-31',
      });
      const imported = await repository.uploadNormalizedStatement(
        context,
        bookId,
        'dividend-import',
        {
          financialAccountId,
          filename: 'dividend.csv',
          format: 'csv',
          sourceText:
            'Date,Description,Amount,Reference\n2026-09-10,Dividend payment,85,DIV-1',
          mapping: {
            dateFormat: 'yyyy-mm-dd',
            decimalSeparator: '.',
            groupingSeparator: '',
            columns: {
              date: 'Date',
              description: 'Description',
              amount: 'Amount',
              externalId: 'Reference',
            },
          },
        },
      );
      evidenceId = String(imported.evidenceId);
      const batch = await repository.getNormalizedImport(
        context,
        bookId,
        String(imported.id),
      );
      sourceRowId = String(batch.rows[0]!.id);
      await repository.reviewNormalizedImportRow(
        context,
        bookId,
        sourceRowId,
        'dividend-review',
        {
          expectedRevision: 1,
          action: 'post',
          counterAccountId: incomeLedgerId,
          reason: 'Reviewed dividend receipt',
        },
      );

      investmentId = String(
        (
          await repository.createAccount(context, bookId, 'investment', {
            code: '1200',
            name: 'Investment',
            kind: 'asset',
          })
        ).id,
      );
      const capitalId = String(
        (
          await repository.createAccount(context, bookId, 'capital', {
            code: '3000',
            name: 'Capital',
            kind: 'equity',
          })
        ).id,
      );
      const journal = await repository.postJournal(context, bookId, 'opening', {
        effectiveOn: '2026-01-01',
        description: 'Opening investment',
        sourceReference: 'opening',
        lines: [
          {
            accountId: investmentId,
            side: 'debit',
            amount: '100',
            currency: 'CAD',
            nativeAmount: '100',
            fxRate: '1',
            fxSource: 'identity',
          },
          {
            accountId: capitalId,
            side: 'credit',
            amount: '100',
            currency: 'CAD',
            nativeAmount: '100',
            fxRate: '1',
            fxSource: 'identity',
          },
        ],
      });
      const movement = await repository.recordInvestmentMovement(
        context,
        bookId,
        'opening-movement',
        {
          financialAccountId,
          instrumentId,
          effectiveOn: '2026-01-01',
          quantity: '10',
          sourceReference: 'opening',
          journalId: String(journal.id),
        },
      );
      lotId = String(
        (
          await repository.recordInvestmentLot(context, bookId, 'opening-lot', {
            movementId: String(movement.id),
            nativeCurrency: 'CAD',
            nativeCost: '100',
            functionalCost: '100',
            sourceReference: 'opening',
          })
        ).id,
      );

      const closedMovement = await repository.recordInvestmentMovement(
        context,
        bookId,
        'closed-lot-movement',
        {
          financialAccountId,
          instrumentId,
          effectiveOn: '2026-01-01',
          quantity: '2',
          sourceReference: 'closed lot',
          journalId: String(journal.id),
        },
      );
      closedLotId = String(
        (
          await repository.recordInvestmentLot(context, bookId, 'closed-lot', {
            movementId: String(closedMovement.id),
            nativeCurrency: 'CAD',
            nativeCost: '20',
            functionalCost: '20',
            sourceReference: 'closed lot',
          })
        ).id,
      );
      const disposalMovement = await repository.recordInvestmentMovement(
        context,
        bookId,
        'closed-sale-movement',
        {
          financialAccountId,
          instrumentId,
          effectiveOn: '2026-01-01',
          quantity: '-2',
          sourceReference: 'closed sale',
          journalId: String(journal.id),
        },
      );
      await repository.recordLotDisposal(context, bookId, 'closed-sale', {
        movementId: String(disposalMovement.id),
        nativeCurrency: 'CAD',
        method: 'specific',
        selections: [{ lotId: closedLotId, quantity: '2' }],
        grossProceeds: { native: '20', functional: '20' },
        fees: { native: '0', functional: '0' },
        commissions: { native: '0', functional: '0' },
        taxes: { native: '0', functional: '0' },
        taxTreatment: 'disposal-cost',
        fxSourceReference: null,
        sourceReference: 'closed sale',
      });
      const action = {
        id: randomUUID(),
        actionType: 'reverse-split' as const,
        financialAccountId,
        instrumentId,
        effectiveOn: '2026-09-10',
        numerator: '1',
        denominator: '3',
        fractionalTreatment: 'cash-in-lieu' as const,
        evidenceId,
        sourceReference: 'Reviewed cash in lieu',
        cashInLieu: null,
      };
      const source = await settlements.readInvestmentStockSplitSource(
        context,
        bookId,
        action,
      );
      const receipt = await settlements.readInvestmentCashDividendSource(
        context,
        bookId,
        { sourceRowId, financialAccountId, instrumentId, evidenceId },
      );
      const digest = String(
        (
          await sql(
            'select plaintext_sha256 from emdo.finance_book_evidence where id=$1',
            [evidenceId],
          )
        ).rows[0].plaintext_sha256,
      );
      command = {
        settlement: {
          source: {
            action,
            sourceAsOf: action.effectiveOn,
            sourceBoundary: 'immediately-before-action',
            sourceLots: [...source.sourceLots],
          },
          deliveredQuantity: { numerator: '3', denominator: '1' },
          cashDisposedQuantity: { numerator: '1', denominator: '3' },
          allocations: [
            {
              sourceLotId: lotId,
              retainedQuantity: { numerator: '3', denominator: '1' },
              cashDisposedQuantity: { numerator: '1', denominator: '3' },
              retainedNativeCost: '90',
              retainedFunctionalCost: '90',
              disposedNativeCost: '10',
              disposedFunctionalCost: '10',
            },
          ],
          cashConsideration: {
            native: { amount: '85', currency: 'CAD' },
            functional: { amount: '85', currency: 'CAD' },
            evidenceId,
            sourceReference: 'Receipt',
            settledOn: '2026-09-10',
            fx: null,
          },
          allocationReview: {
            evidenceId,
            sourceReference: 'Reviewed allocation',
          },
        },
        ledger: {
          cashLedgerAccountId: cashLedgerId,
          investmentLedgerAccountId: investmentId,
          gainLedgerAccountId: incomeLedgerId,
          lossLedgerAccountId: withholdingLedgerId,
          receivableLedgerAccountId: null,
          fxGainLedgerAccountId: null,
          fxLossLedgerAccountId: null,
        },
        actionDateConsideration: null,
        expectedSourceRevision: source.sourceRevision,
        sourceSnapshotHash: source.sourceSnapshotHash,
        receipt: {
          sourceRowId,
          expectedRevision: receipt.sourceRevision,
          snapshotHash: receipt.sourceSnapshotHash,
        },
        evidenceHashes: [{ evidenceId, sha256: digest }],
        idempotencyKey: 'settlement',
      };
    });

    afterAll(async () => {
      await app?.end();
      await admin.query(`drop role if exists "${login}"`);
      await admin.end();
    });

    it('resolves with both committed split and settlement and rejects cross-instrument references', async () => {
      const committed = await settlements.commitInvestmentStockSplitSettlement(
        context,
        bookId,
        command,
      );
      expect(committed.status).toBe('committed');
      const cases = new FinanceInvestmentReconciliationRepository(pool);
      await assertCommittedCorrectionLink(
        repository,
        cases,
        context,
        bookId,
        financialAccountId,
        instrumentId,
        evidenceId,
        'stock-split',
        committed.actionId,
      );
      await assertCommittedCorrectionLink(
        repository,
        cases,
        context,
        bookId,
        financialAccountId,
        instrumentId,
        evidenceId,
        'split-settlement',
        committed.settlementId,
      );
    });
  },
);
describe.skipIf(!url)('Reconciliation links a real cash dividend', () => {
  const admin = new pg.Pool({ connectionString: url });
  const login = `dividend_${randomUUID().replaceAll('-', '')}`;
  let app: pg.Pool;
  const pool = {
    async connect() {
      const client = await app.connect();
      await client.query('set role emdo_app');
      return client;
    },
  };
  const repository = new PostgresFinanceV2Repository(pool, {
    evidenceCipher: {
      async encrypt() {
        return {
          algorithm: 'aes-256-gcm',
          schemaVersion: '1',
          aadVersion: '1',
          ciphertext: 'ciphertext',
          nonce: '1234567890abcdef',
          authenticationTag: '1234567890123456789012',
          wrappedKey: 'wrapped-key',
          keyVersion: 'finance-documents.v1',
        };
      },
      async decrypt() {
        return { sourceText: 'cash dividend evidence' };
      },
    },
  });
  const context: WorkspaceContext = {
    workspaceId: randomUUID(),
    userId: randomUUID(),
    sessionId: randomUUID(),
    requestId: randomUUID(),
  };
  let bookId: string;
  let cashLedgerId: string;
  let incomeLedgerId: string;
  let withholdingLedgerId: string;
  let financialAccountId: string;
  let instrumentId: string;
  let evidenceId: string;
  let sourceRowId: string;

  async function sql(text: string, values: unknown[] = []) {
    const client = await admin.connect();
    try {
      await client.query('reset role');
      return await client.query(text, values);
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
    const probe = await pool.connect();
    try {
      expect(
        (
          await probe.query(
            "select current_user='emdo_app' and not rolsuper and not rolbypassrls as restricted from pg_roles where rolname=current_user",
          )
        ).rows[0].restricted,
      ).toBe(true);
      await expect(probe.query('set role postgres')).rejects.toThrow();
    } finally {
      probe.release();
    }

    await sql(
      `insert into emdo.auth_users(id,name,email,email_verified)
       values($1,'Dividend test owner',$2,true)`,
      [context.userId, `${context.userId}@example.test`],
    );
    await sql(
      `insert into emdo.households(id,name,slug,created_by_user_id)
       values($1,'Dividend test workspace',$2,$3)`,
      [context.workspaceId, context.workspaceId, context.userId],
    );
    await sql(
      `insert into emdo.household_memberships(household_id,user_id,role)
       values($1,$2,'owner')`,
      [context.workspaceId, context.userId],
    );
    await sql(
      `insert into emdo.auth_sessions(id,user_id,token,expires_at,active_household_id)
       values($1,$2,$3,now()+interval '1 day',$4)`,
      [
        context.sessionId,
        context.userId,
        context.sessionId,
        context.workspaceId,
      ],
    );
    bookId = String(
      (
        await repository.createBook(context, 'dividend-book', {
          name: 'Dividend book',
          entityName: 'Dividend owner',
          entityKind: 'corporation',
          country: 'CA',
          functionalCurrency: 'CAD',
        })
      ).id,
    );
    cashLedgerId = String(
      (
        await repository.createAccount(context, bookId, 'dividend-cash', {
          code: '1000',
          name: 'Cash',
          kind: 'asset',
        })
      ).id,
    );
    incomeLedgerId = String(
      (
        await repository.createAccount(context, bookId, 'dividend-income', {
          code: '4100',
          name: 'Dividend income',
          kind: 'income',
        })
      ).id,
    );
    withholdingLedgerId = String(
      (
        await repository.createAccount(context, bookId, 'dividend-tax', {
          code: '2200',
          name: 'Withholding tax',
          kind: 'expense',
        })
      ).id,
    );
    financialAccountId = String(
      (
        await repository.createFinancialAccount(
          context,
          bookId,
          'dividend-bank',
          {
            name: 'Dividend bank',
            kind: 'brokerage',
            currency: 'CAD',
            ledgerAccountId: cashLedgerId,
          },
        )
      ).id,
    );
    instrumentId = String(
      (
        await repository.createInstrument(context, bookId, 'dividend-stock', {
          name: 'Dividend stock',
          kind: 'equity',
          quantityUnit: 'share',
          valuationMultiplier: '1',
          identifiers: [],
        })
      ).id,
    );
    await repository.createPeriod(context, bookId, 'dividend-period', {
      startsOn: '2026-01-01',
      endsOn: '2026-12-31',
    });
    const imported = await repository.uploadNormalizedStatement(
      context,
      bookId,
      'dividend-import',
      {
        financialAccountId,
        filename: 'dividend.csv',
        format: 'csv',
        sourceText:
          'Date,Description,Amount,Reference\n2026-09-10,Dividend payment,85,DIV-1',
        mapping: {
          dateFormat: 'yyyy-mm-dd',
          decimalSeparator: '.',
          groupingSeparator: '',
          columns: {
            date: 'Date',
            description: 'Description',
            amount: 'Amount',
            externalId: 'Reference',
          },
        },
      },
    );
    evidenceId = String(imported.evidenceId);
    const batch = await repository.getNormalizedImport(
      context,
      bookId,
      String(imported.id),
    );
    sourceRowId = String(batch.rows[0]!.id);
    await repository.reviewNormalizedImportRow(
      context,
      bookId,
      sourceRowId,
      'dividend-review',
      {
        expectedRevision: 1,
        action: 'post',
        counterAccountId: incomeLedgerId,
        reason: 'Reviewed dividend receipt',
      },
    );
  });

  afterAll(async () => {
    await app?.end();
    await admin.query(`drop role if exists "${login}"`);
    await admin.end();
  });

  it('resolves with the committed dividend and rejects cross-instrument references', async () => {
    const source = await repository.readInvestmentCashDividendSource(
      context,
      bookId,
      { sourceRowId, financialAccountId, instrumentId, evidenceId },
    );
    const committed = await repository.commitInvestmentCashDividend(
      context,
      bookId,
      {
        action: commitAction(
          randomUUID(),
          financialAccountId,
          instrumentId,
          evidenceId,
          sourceRowId,
          cashLedgerId,
          incomeLedgerId,
          withholdingLedgerId,
        ),
        expectedSourceRevision: source.sourceRevision,
        sourceSnapshotHash: source.sourceSnapshotHash,
        idempotencyKey: 'reconciliation-dividend-commit',
      },
    );
    expect(committed.status).toBe('committed');
    await assertCommittedCorrectionLink(
      repository,
      new FinanceInvestmentReconciliationRepository(pool),
      context,
      bookId,
      financialAccountId,
      instrumentId,
      evidenceId,
      'cash-dividend',
      committed.actionId,
    );
  });
});
function commitAction(
  actionId: string,
  financialAccountId: string,
  instrumentId: string,
  evidenceId: string,
  sourceRowId: string,
  cashLedgerId: string,
  incomeLedgerId: string,
  withholdingLedgerId: string,
) {
  const amount = (
    nativeAmount: string,
    field: 'gross' | 'withholding' | 'net',
  ) => ({
    nativeAmount,
    currency: 'CAD' as const,
    functionalAmount: nativeAmount,
    fxRate: '1',
    fxSource: 'identity',
    provenance: {
      sourceRow: 2,
      field,
      column: field,
      raw: nativeAmount,
      contextAnchor: null,
    },
  });
  return {
    id: actionId,
    actionType: 'cash-dividend' as const,
    financialAccountId,
    instrumentId,
    evidenceId,
    sourceRowId,
    declaredOn: '2026-09-01',
    exDate: '2026-09-05',
    payableOn: '2026-09-10',
    sourceReference: 'DIV-1',
    reviewReason: 'Reviewed gross and withholding facts',
    gross: amount('100', 'gross'),
    withholding: amount('15', 'withholding'),
    net: amount('85', 'net'),
    ledger: {
      cashLedgerAccountId: cashLedgerId,
      dividendIncomeLedgerAccountId: incomeLedgerId,
      withholdingLedgerAccountId: withholdingLedgerId,
    },
  };
}

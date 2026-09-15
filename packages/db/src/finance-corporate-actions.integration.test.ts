import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { WorkspaceContext } from '@emdo/contracts';
import { PostgresFinanceV2Repository } from './finance-v2-repository.js';

const url = process.env.FINANCE_V2_TEST_DATABASE_URL;
const TEST_DATES = Object.freeze({
  opening: '2020-01-01',
  firstSplit: '2020-01-02',
  postSplitAcquisition: '2020-01-03',
  postSplitDisposal: '2020-01-04',
  secondSplit: '2020-01-05',
  missingSuccessorAction: '2020-01-06',
  missingSuccessorDisposal: '2020-01-07',
});

/**
 * This is intentionally a database integration test. It verifies that a
 * committed action is visible through the existing lot API and that a later
 * disposal consumes the successor quantity and unchanged basis. The test is
 * skipped unless the caller supplies the disposable PostgreSQL URL used by
 * the other Finance v2 integration tests.
 */
describe.skipIf(!url)('Finance corporate-action PostgreSQL persistence', () => {
  const admin = new pg.Pool({ connectionString: url });
  const pool = {
    async connect() {
      const client = await admin.connect();
      await client.query('set role emdo_app');
      return client;
    },
  };
  const evidenceCipher = {
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
      return { sourceText: 'corporate action evidence' };
    },
  };
  const repository = new PostgresFinanceV2Repository(pool, {
    evidenceCipher,
  });
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  const context: WorkspaceContext = {
    userId,
    workspaceId,
    sessionId,
    requestId: randomUUID(),
  };
  let bookId: string;
  let cashAccountId: string;
  let equityAccountId: string;
  let accountId: string;
  let instrumentId: string;
  let openingJournalId: string;
  let lotId: string;
  let evidenceId: string;

  async function sql(query: string, values: unknown[] = []) {
    const client = await admin.connect();
    try {
      // The repository's restricted pool returns clients to this same pg.Pool
      // after SET ROLE emdo_app. Restore the privileged fixture connection
      // before direct inspection queries so RLS does not hide committed rows.
      await client.query('reset role');
      return await client.query(query, values);
    } finally {
      client.release();
    }
  }

  async function asAdminContext(query: string, values: unknown[] = []) {
    const client = await admin.connect();
    try {
      await client.query('reset role');
      await client.query(
        `select set_config('emdo.user_id',$1,false),
                set_config('emdo.session_id',$2,false),
                set_config('emdo.request_id',$3,false)`,
        [userId, sessionId, randomUUID()],
      );
      return await client.query(query, values);
    } finally {
      await client.query('reset all');
      await client.query('reset role');
      client.release();
    }
  }

  beforeAll(async () => {
    await sql(
      `insert into emdo.auth_users(id,name,email,email_verified)
       values($1,'Corporate action test owner',$2,true)`,
      [userId, `${userId}@example.test`],
    );
    await sql(
      `insert into emdo.households(id,name,created_by_user_id,slug)
       values($1,'Corporate action test workspace',$2,$3)`,
      [workspaceId, userId, workspaceId],
    );
    await sql(
      `insert into emdo.household_memberships(household_id,user_id,role)
       values($1,$2,'owner')`,
      [workspaceId, userId],
    );
    await sql(
      `insert into emdo.auth_sessions(id,user_id,token,expires_at,active_household_id)
       values($1,$2,$3,now()+interval '1 day',$4)`,
      [sessionId, userId, sessionId, workspaceId],
    );
  });

  afterAll(async () => {
    await admin.end();
  });

  it('projects successive splits and allocates a later disposal against the successor', async () => {
    bookId = String(
      (
        await repository.createBook(context, 'corporate-book', {
          name: 'Brokerage book',
          entityName: 'Corporate action test',
          entityKind: 'corporation',
          country: 'CA',
          functionalCurrency: 'CAD',
        })
      ).id,
    );
    cashAccountId = String(
      (
        await repository.createAccount(context, bookId, 'cash-account', {
          code: '1000',
          name: 'Cash',
          kind: 'asset',
        })
      ).id,
    );
    equityAccountId = String(
      (
        await repository.createAccount(context, bookId, 'equity-account', {
          code: '3000',
          name: 'Capital',
          kind: 'equity',
        })
      ).id,
    );
    accountId = String(
      (
        await repository.createFinancialAccount(
          context,
          bookId,
          'brokerage-account',
          {
            name: 'Brokerage',
            kind: 'brokerage',
            currency: 'CAD',
            ledgerAccountId: cashAccountId,
          },
        )
      ).id,
    );
    instrumentId = String(
      (
        await repository.createInstrument(context, bookId, 'instrument', {
          name: 'Test equity',
          kind: 'equity',
          quantityUnit: 'share',
          valuationMultiplier: '1',
          identifiers: [],
        })
      ).id,
    );
    await repository.createPeriod(context, bookId, 'period', {
      startsOn: '2020-01-01',
      endsOn: '2020-12-31',
    });
    openingJournalId = String(
      (
        await repository.postJournal(context, bookId, 'opening-journal', {
          effectiveOn: TEST_DATES.opening,
          description: 'Opening brokerage position',
          sourceReference: 'corporate-action-test:opening',
          lines: [
            {
              accountId: cashAccountId,
              side: 'debit',
              amount: '100',
              currency: 'CAD',
              nativeAmount: '100',
              fxRate: '1',
              fxSource: 'identity',
            },
            {
              accountId: equityAccountId,
              side: 'credit',
              amount: '100',
              currency: 'CAD',
              nativeAmount: '100',
              fxRate: '1',
              fxSource: 'identity',
            },
          ],
        })
      ).id,
    );
    const openingMovementId = String(
      (
        await repository.recordInvestmentMovement(
          context,
          bookId,
          'opening-movement',
          {
            financialAccountId: accountId,
            instrumentId,
            effectiveOn: TEST_DATES.opening,
            quantity: '10',
            sourceReference: 'corporate-action-test:opening-movement',
            journalId: openingJournalId,
          },
        )
      ).id,
    );
    lotId = String(
      (
        await repository.recordInvestmentLot(context, bookId, 'opening-lot', {
          movementId: openingMovementId,
          nativeCurrency: 'CAD',
          nativeCost: '100',
          functionalCost: '100',
          sourceReference: 'corporate-action-test:opening-lot',
        })
      ).id,
    );
    evidenceId = String(
      (
        await repository.uploadBookEvidence(context, bookId, 'evidence', {
          filename: 'corporate-action.csv',
          format: 'csv',
          sourceText: `date,description\n${TEST_DATES.firstSplit},split`,
        })
      ).id,
    );

    const firstAction = {
      id: randomUUID(),
      actionType: 'split' as const,
      financialAccountId: accountId,
      instrumentId,
      effectiveOn: TEST_DATES.firstSplit,
      numerator: '2',
      denominator: '1',
      fractionalTreatment: 'retain' as const,
      evidenceId,
      sourceReference: 'corporate-action-test:split-2-for-1',
      cashInLieu: null,
    };
    const firstSource = await repository.readInvestmentStockSplitSource(
      context,
      bookId,
      firstAction,
    );
    expect(firstSource.sourceLots).toHaveLength(1);
    expect(firstSource.sourceLots[0]).toMatchObject({
      id: lotId,
      originalQuantity: '10',
      disposedQuantity: '0',
      originalNativeCost: '100',
    });
    const firstCommit = await repository.commitInvestmentStockSplit(
      context,
      bookId,
      {
        action: firstAction,
        sourceAsOf: firstAction.effectiveOn,
        sourceBoundary: 'immediately-before-action',
        sourceLots: firstSource.sourceLots,
        expectedSourceRevision: firstSource.sourceRevision,
        idempotencyKey: 'corporate-action-test:first-commit',
      },
    );
    expect(firstCommit.replayed).toBe(false);
    expect(firstCommit.successorLotIds).toHaveLength(1);
    expect(
      await repository.commitInvestmentStockSplit(context, bookId, {
        action: firstAction,
        sourceAsOf: firstAction.effectiveOn,
        sourceBoundary: 'immediately-before-action',
        sourceLots: firstSource.sourceLots,
        expectedSourceRevision: firstSource.sourceRevision,
        idempotencyKey: 'corporate-action-test:first-commit',
      }),
    ).toMatchObject({ replayed: true, actionId: firstAction.id });
    expect((await repository.listInvestmentLots(context, bookId)).lots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: lotId,
          originalQuantity: '20.000000000000',
          remainingQuantity: '20.000000000000',
          remainingNativeCost: '100.000000000000',
        }),
      ]),
    );

    const postSplitAcquisitionJournalId = String(
      (
        await repository.postJournal(
          context,
          bookId,
          'post-split-acquisition-journal',
          {
            effectiveOn: TEST_DATES.postSplitAcquisition,
            description: 'Acquisition after first split',
            sourceReference: 'corporate-action-test:post-split-acquisition',
            lines: [
              {
                accountId: cashAccountId,
                side: 'debit',
                amount: '60',
                currency: 'CAD',
                nativeAmount: '60',
                fxRate: '1',
                fxSource: 'identity',
              },
              {
                accountId: equityAccountId,
                side: 'credit',
                amount: '60',
                currency: 'CAD',
                nativeAmount: '60',
                fxRate: '1',
                fxSource: 'identity',
              },
            ],
          },
        )
      ).id,
    );
    const postSplitAcquisitionMovementId = String(
      (
        await repository.recordInvestmentMovement(
          context,
          bookId,
          'post-split-acquisition-movement',
          {
            financialAccountId: accountId,
            instrumentId,
            effectiveOn: TEST_DATES.postSplitAcquisition,
            quantity: '4',
            sourceReference: 'corporate-action-test:post-split-acquisition',
            journalId: postSplitAcquisitionJournalId,
          },
        )
      ).id,
    );
    const postSplitLotId = String(
      (
        await repository.recordInvestmentLot(
          context,
          bookId,
          'post-split-acquisition-lot',
          {
            movementId: postSplitAcquisitionMovementId,
            nativeCurrency: 'CAD',
            nativeCost: '60',
            functionalCost: '60',
            sourceReference: 'corporate-action-test:post-split-acquisition',
          },
        )
      ).id,
    );
    expect((await repository.listInvestmentLots(context, bookId)).lots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: postSplitLotId,
          acquiredOn: TEST_DATES.postSplitAcquisition,
          originalQuantity: '4.000000000000',
          remainingQuantity: '4.000000000000',
          remainingNativeCost: '60.000000000000',
        }),
      ]),
    );

    const disposalJournalId = String(
      (
        await repository.postJournal(context, bookId, 'sale-journal', {
          effectiveOn: TEST_DATES.postSplitDisposal,
          description: 'Sale after split',
          sourceReference: 'corporate-action-test:sale',
          lines: [
            {
              accountId: cashAccountId,
              side: 'debit',
              amount: '50',
              currency: 'CAD',
              nativeAmount: '50',
              fxRate: '1',
              fxSource: 'identity',
            },
            {
              accountId: equityAccountId,
              side: 'credit',
              amount: '50',
              currency: 'CAD',
              nativeAmount: '50',
              fxRate: '1',
              fxSource: 'identity',
            },
          ],
        })
      ).id,
    );
    const disposalMovementId = String(
      (
        await repository.recordInvestmentMovement(
          context,
          bookId,
          'sale-movement',
          {
            financialAccountId: accountId,
            instrumentId,
            effectiveOn: TEST_DATES.postSplitDisposal,
            quantity: '-5',
            sourceReference: 'corporate-action-test:sale-movement',
            journalId: disposalJournalId,
          },
        )
      ).id,
    );
    const disposal = await repository.recordLotDisposal(
      context,
      bookId,
      'sale-disposal',
      {
        movementId: disposalMovementId,
        nativeCurrency: 'CAD',
        method: 'fifo',
        selections: [],
        grossProceeds: { native: '50', functional: '50' },
        fees: { native: '0', functional: '0' },
        commissions: { native: '0', functional: '0' },
        taxes: { native: '0', functional: '0' },
        taxTreatment: 'disposal-cost',
        fxSourceReference: null,
        sourceReference: 'corporate-action-test:sale-disposal',
      },
    );
    expect(
      (disposal.result as unknown as { allocations: unknown }).allocations,
    ).toMatchObject([
      expect.objectContaining({
        lotId,
        quantity: '5',
        nativeCost: '25',
        functionalCost: '25',
      }),
    ]);
    expect((await repository.listInvestmentLots(context, bookId)).lots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: lotId,
          remainingQuantity: '15.000000000000',
          remainingNativeCost: '75.000000000000',
        }),
      ]),
    );

    const postSplitSaleJournalId = String(
      (
        await repository.postJournal(
          context,
          bookId,
          'post-split-sale-journal',
          {
            effectiveOn: TEST_DATES.postSplitDisposal,
            description: 'Sale from post-split acquisition',
            sourceReference: 'corporate-action-test:post-split-sale',
            lines: [
              {
                accountId: cashAccountId,
                side: 'debit',
                amount: '45',
                currency: 'CAD',
                nativeAmount: '45',
                fxRate: '1',
                fxSource: 'identity',
              },
              {
                accountId: equityAccountId,
                side: 'credit',
                amount: '45',
                currency: 'CAD',
                nativeAmount: '45',
                fxRate: '1',
                fxSource: 'identity',
              },
            ],
          },
        )
      ).id,
    );
    const postSplitSaleMovementId = String(
      (
        await repository.recordInvestmentMovement(
          context,
          bookId,
          'post-split-sale-movement',
          {
            financialAccountId: accountId,
            instrumentId,
            effectiveOn: TEST_DATES.postSplitDisposal,
            quantity: '-3',
            sourceReference: 'corporate-action-test:post-split-sale',
            journalId: postSplitSaleJournalId,
          },
        )
      ).id,
    );
    const postSplitSale = await repository.recordLotDisposal(
      context,
      bookId,
      'post-split-sale-disposal',
      {
        movementId: postSplitSaleMovementId,
        nativeCurrency: 'CAD',
        method: 'specific',
        selections: [{ lotId: postSplitLotId, quantity: '3' }],
        grossProceeds: { native: '45', functional: '45' },
        fees: { native: '0', functional: '0' },
        commissions: { native: '0', functional: '0' },
        taxes: { native: '0', functional: '0' },
        taxTreatment: 'disposal-cost',
        fxSourceReference: null,
        sourceReference: 'corporate-action-test:post-split-sale-disposal',
      },
    );
    expect(
      (postSplitSale.result as unknown as { allocations: unknown }).allocations,
    ).toMatchObject([
      expect.objectContaining({
        lotId: postSplitLotId,
        quantity: '3',
        nativeCost: '45',
        functionalCost: '45',
      }),
    ]);
    expect((await repository.listInvestmentLots(context, bookId)).lots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: postSplitLotId,
          remainingQuantity: '1.000000000000',
          remainingNativeCost: '15.000000000000',
        }),
      ]),
    );

    const secondAction = {
      ...firstAction,
      id: randomUUID(),
      effectiveOn: TEST_DATES.secondSplit,
      sourceReference: 'corporate-action-test:split-2-for-1-again',
    };
    const secondSource = await repository.readInvestmentStockSplitSource(
      context,
      bookId,
      secondAction,
    );
    expect(secondSource.sourceLots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: lotId,
          originalQuantity: '20',
          disposedQuantity: '5',
          originalNativeCost: '100',
          allocatedNativeCost: '25',
        }),
        expect.objectContaining({
          id: postSplitLotId,
          originalQuantity: '4',
          disposedQuantity: '3',
          originalNativeCost: '60',
          allocatedNativeCost: '45',
        }),
      ]),
    );
    await repository.commitInvestmentStockSplit(context, bookId, {
      action: secondAction,
      sourceAsOf: secondAction.effectiveOn,
      sourceBoundary: 'immediately-before-action',
      sourceLots: secondSource.sourceLots,
      expectedSourceRevision: secondSource.sourceRevision,
      idempotencyKey: 'corporate-action-test:second-commit',
    });
    const secondEffects = await sql(
      `select successor_quantity::text as quantity,
              successor_native_cost_basis::text as native_cost,
              successor_functional_cost_basis::text as functional_cost,
              source_lot_id as "sourceLotId"
         from emdo.finance_investment_corporate_action_effects
        where workspace_id=$1 and book_id=$2 and action_id=$3`,
      [workspaceId, bookId, secondAction.id],
    );
    expect(secondEffects.rows).toHaveLength(2);
    expect(secondEffects.rows).toEqual(
      expect.arrayContaining([
        {
          sourceLotId: lotId,
          quantity: '30.000000000000',
          native_cost: '75.000000000000',
          functional_cost: '75.000000000000',
        },
        {
          sourceLotId: postSplitLotId,
          quantity: '2.000000000000',
          native_cost: '15.000000000000',
          functional_cost: '15.000000000000',
        },
      ]),
    );
    // These dates are fixed before the test clock, so the current-position
    // view must expose the latest committed successors on every runner.
    expect((await repository.listInvestmentLots(context, bookId)).lots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: lotId,
          originalQuantity: '30.000000000000',
          remainingQuantity: '30.000000000000',
          remainingNativeCost: '75.000000000000',
        }),
        expect.objectContaining({
          id: postSplitLotId,
          originalQuantity: '2.000000000000',
          remainingQuantity: '2.000000000000',
          remainingNativeCost: '15.000000000000',
        }),
      ]),
    );
    expect(
      await repository.getInvestmentLot(context, bookId, postSplitLotId),
    ).toMatchObject({
      lot: expect.objectContaining({
        id: postSplitLotId,
        originalQuantity: '2.000000000000',
        originalNativeCost: '15.000000000000',
      }),
    });
  });

  it('rejects allocation when a committed action has no successor effect', async () => {
    const malformedActionId = randomUUID();
    const sourceRevision = (
      await repository.getInvestmentLotRevision(context, bookId)
    ).revision;
    // This is deliberately an adversarial fixture: the action row is valid at
    // the table level but has no effect row. The allocation trigger must stop
    // a later sale from falling back to the pre-action lot quantity.
    await asAdminContext(
      `insert into emdo.finance_investment_corporate_actions
        (id,workspace_id,book_id,action_type,financial_account_id,instrument_id,
         effective_on,numerator,denominator,fractional_treatment,evidence_id,
         source_reference,cash_in_lieu,source_as_of,source_boundary,source_revision,
         source_snapshot_hash,idempotency_key,command_hash,status,created_by)
       values($1,$2,$3,'split',$4,$5,$6,2,1,'retain',$7,$8,null,$6,
              'immediately-before-action',$9,$10,$11,$12,'committed',$13)`,
      [
        malformedActionId,
        workspaceId,
        bookId,
        accountId,
        instrumentId,
        TEST_DATES.missingSuccessorAction,
        evidenceId,
        'corporate-action-test:missing-successor-effect',
        sourceRevision,
        'a'.repeat(64),
        'corporate-action-test:missing-successor-effect',
        'b'.repeat(64),
        userId,
      ],
    );

    const disposalJournalId = String(
      (
        await repository.postJournal(
          context,
          bookId,
          'missing-successor-disposal-journal',
          {
            effectiveOn: TEST_DATES.missingSuccessorDisposal,
            description: 'Adversarial sale after incomplete action',
            sourceReference: 'corporate-action-test:missing-successor-sale',
            lines: [
              {
                accountId: cashAccountId,
                side: 'debit',
                amount: '1',
                currency: 'CAD',
                nativeAmount: '1',
                fxRate: '1',
                fxSource: 'identity',
              },
              {
                accountId: equityAccountId,
                side: 'credit',
                amount: '1',
                currency: 'CAD',
                nativeAmount: '1',
                fxRate: '1',
                fxSource: 'identity',
              },
            ],
          },
        )
      ).id,
    );
    const disposalMovementId = String(
      (
        await repository.recordInvestmentMovement(
          context,
          bookId,
          'missing-successor-disposal-movement',
          {
            financialAccountId: accountId,
            instrumentId,
            effectiveOn: TEST_DATES.missingSuccessorDisposal,
            quantity: '-1',
            sourceReference: 'corporate-action-test:missing-successor-sale',
            journalId: disposalJournalId,
          },
        )
      ).id,
    );

    await expect(
      repository.recordLotDisposal(
        context,
        bookId,
        'missing-successor-disposal',
        {
          movementId: disposalMovementId,
          nativeCurrency: 'CAD',
          method: 'fifo',
          selections: [],
          grossProceeds: { native: '1', functional: '1' },
          fees: { native: '0', functional: '0' },
          commissions: { native: '0', functional: '0' },
          taxes: { native: '0', functional: '0' },
          taxTreatment: 'disposal-cost',
          fxSourceReference: null,
          sourceReference: 'corporate-action-test:missing-successor-disposal',
        },
      ),
    ).rejects.toThrow('corporate action successor unavailable');
    expect(
      (
        await sql(
          `select exists(
             select 1 from emdo.finance_lot_disposals
              where workspace_id=$1 and book_id=$2 and movement_id=$3
           ) as persisted`,
          [workspaceId, bookId, disposalMovementId],
        )
      ).rows[0]?.persisted,
    ).toBe(false);
  });
});

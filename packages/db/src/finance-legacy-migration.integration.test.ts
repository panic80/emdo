import { PostgresSyncRepository } from './sync/postgres-repository.js';
import { PostgresFinanceOpeningRepository } from './finance-opening-repository.js';
import { PostgresFinanceSpecialistRecordRepository } from './finance/postgres-finance-specialist-record-repository.js';
import {
  inspectLegacyFinanceActivation,
  activateLegacyFinance,
} from './finance-legacy-activation-repository.js';
import {
  resolveLegacyFinanceRoute,
  readLegacyFinanceCompatibility,
  readLegacyFinanceCompatibilityPage,
} from './finance-legacy-activation-projection.js';
import { createHash, randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { WorkspaceContext } from '@emdo/contracts';
import {
  EncryptedFinanceBookEvidenceSchema,
  FinanceBookEvidenceCrypto,
} from '../../integrations/src/finance-documents/book-evidence-crypto.js';
import { InMemoryVaultKeyProvider } from '../../integrations/src/vault/crypto.js';
import { PostgresFinanceLegacyMigrationRepository } from './finance-legacy-migration-repository.js';
import { PostgresFinanceV2Repository } from './finance-v2-repository.js';

const databaseUrl = process.env.FINANCE_V2_TEST_DATABASE_URL;

const digest = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex');

type SourceRow = {
  readonly id: string;
  readonly spaceId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly payload: unknown;
  readonly tombstonedAt: string | null;
};

describe.skipIf(!databaseUrl)(
  'legacy Finance migration restricted PostgreSQL acceptance',
  () => {
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const login = `legacy_${randomUUID().replaceAll('-', '')}`;
    let app: pg.Pool | undefined;

    const context: WorkspaceContext = {
      workspaceId: randomUUID(),
      userId: randomUUID(),
      sessionId: randomUUID(),
      requestId: randomUUID(),
    };
    const otherContext: WorkspaceContext = {
      workspaceId: context.workspaceId,
      userId: randomUUID(),
      sessionId: randomUUID(),
      requestId: randomUUID(),
    };

    const restrictedPool = {
      async connect() {
        if (!app) throw new Error('legacy acceptance pool is unavailable');
        const client = await app.connect();
        await client.query('set role emdo_app');
        return client;
      },
    };

    const cipher = new FinanceBookEvidenceCrypto(
      new InMemoryVaultKeyProvider(
        new Uint8Array(32).fill(23),
        'finance-documents.v1',
      ),
    );
    const finance = new PostgresFinanceV2Repository(restrictedPool, {
      evidenceCipher: {
        encrypt: (value, scope) => cipher.encrypt(value, scope),
        decrypt: (value, scope) =>
          cipher.decrypt(
            EncryptedFinanceBookEvidenceSchema.parse(value),
            scope,
          ),
      },
    });
    const migration = new PostgresFinanceLegacyMigrationRepository(
      restrictedPool,
    );

    let bookId: string;
    let cashLedgerId: string;
    let expenseLedgerId: string;
    let financialAccountId: string;
    let evidenceId: string;
    const blockedSpaceId = randomUUID();
    const readySpaceId = randomUUID();

    const sql = async (text: string, values: readonly unknown[] = []) => {
      const client = await admin.connect();
      try {
        await client.query('reset role');
        return await client.query(text, [...values]);
      } finally {
        client.release();
      }
    };

    const scopedSql = async (
      scopedContext: WorkspaceContext,
      text: string,
      values: readonly unknown[] = [],
    ) => {
      const client = await restrictedPool.connect();
      try {
        await client.query('begin');
        await client.query(
          `select set_config('emdo.user_id',$1,true),set_config('emdo.session_id',$2,true),set_config('emdo.request_id',$3,true)`,
          [scopedContext.userId, scopedContext.sessionId, randomUUID()],
        );
        try {
          return await client.query(text, [...values]);
        } finally {
          await client.query('rollback');
        }
      } finally {
        client.release();
      }
    };

    const accountPayload = (input: {
      readonly id: string;
      readonly spaceId: string;
      readonly openingBalanceCadMinor: number;
    }) => ({
      schemaVersion: 1 as const,
      id: input.id,
      spaceId: input.spaceId,
      ownerUserId: context.userId,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      recordType: 'account' as const,
      name: 'Legacy cash account',
      accountKind: 'cash' as const,
      currency: 'CAD' as const,
      openingBalanceCadMinor: input.openingBalanceCadMinor,
      active: true,
      source: 'manual' as const,
    });

    const transactionPayload = (input: {
      readonly id: string;
      readonly spaceId: string;
      readonly accountId: string;
      readonly categoryId: string;
      readonly sourceHash: string;
      readonly fingerprint: string;
      readonly sourceRow: number;
      readonly externalId: string;
    }) => ({
      schemaVersion: 1 as const,
      id: input.id,
      spaceId: input.spaceId,
      ownerUserId: context.userId,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      recordType: 'transaction' as const,
      accountId: input.accountId,
      categoryId: input.categoryId,
      postedOn: '2026-08-31',
      description: 'Legacy market transaction',
      annotation: null,
      currency: 'CAD' as const,
      originalAmountCadMinor: -4205,
      effectiveAmountCadMinor: -4205,
      adjustments: [],
      reversal: null,
      appliedOperationIds: [],
      source: {
        kind: 'import' as const,
        sourceHash: input.sourceHash,
        sourceRow: input.sourceRow,
        fingerprint: input.fingerprint,
        externalId: input.externalId,
      },
    });

    const insertSpace = async (spaceId: string) => {
      await sql(
        `insert into emdo.spaces(id,household_id,original_owner_user_id,name,visibility,revision,created_at,updated_at)
         values($1,$2,$3,$4,'private',1,now(),now())`,
        [
          spaceId,
          context.workspaceId,
          context.userId,
          `Legacy private ${spaceId.slice(0, 8)}`,
        ],
      );
    };

    const insertSourceRows = async (rows: readonly SourceRow[]) => {
      for (const row of rows) {
        await sql(
          `insert into emdo.sync_entities(id,household_id,space_id,original_owner_user_id,entity_type,entity_id,payload,actor_intent,revision,tombstoned_at,created_at,updated_at)
           values($1,$2,$3,$4,$5,$6,$7::jsonb,'legacy-migration-acceptance',1,$8,now(),now())`,
          [
            row.id,
            context.workspaceId,
            row.spaceId,
            context.userId,
            row.entityType,
            row.entityId,
            JSON.stringify(row.payload),
            row.tombstonedAt,
          ],
        );
      }
    };

    beforeAll(async () => {
      await admin.query(
        `create role "${login}" login nosuperuser nobypassrls noinherit`,
      );
      await admin.query(`grant emdo_app to "${login}"`);
      const connection = new URL(databaseUrl!);
      connection.username = login;
      app = new pg.Pool({
        connectionString: connection.toString(),
        application_name: login,
      });

      const probe = await restrictedPool.connect();
      try {
        const result = await probe.query(
          `select current_user as current_user, not rolsuper as not_superuser, not rolbypassrls as not_bypassrls
             from pg_roles where rolname=current_user`,
        );
        expect(result.rows[0]).toMatchObject({
          current_user: 'emdo_app',
          not_superuser: true,
          not_bypassrls: true,
        });
      } finally {
        probe.release();
      }

      await sql(
        `insert into emdo.auth_users(id,name,email,email_verified) values
          ($1,'Legacy acceptance owner',$2,true),
          ($3,'Legacy acceptance other member',$4,true)`,
        [
          context.userId,
          `${context.userId}@example.test`,
          otherContext.userId,
          `${otherContext.userId}@example.test`,
        ],
      );
      await sql(
        `insert into emdo.households(id,name,slug,created_by_user_id) values($1,'Legacy migration acceptance',$2,$3)`,
        [context.workspaceId, context.workspaceId, context.userId],
      );
      await sql(
        `insert into emdo.household_memberships(household_id,user_id,role) values
          ($1,$2,'owner'),($1,$3,'member')`,
        [context.workspaceId, context.userId, otherContext.userId],
      );
      await sql(
        `insert into emdo.auth_sessions(id,user_id,token,expires_at,active_household_id) values
          ($1,$2,$6,now()+interval '1 day',$3),
          ($4,$5,$7,now()+interval '1 day',$3)`,
        [
          context.sessionId,
          context.userId,
          context.workspaceId,
          otherContext.sessionId,
          otherContext.userId,
          `legacy-token-${context.sessionId}`,
          `legacy-token-${otherContext.sessionId}`,
        ],
      );

      bookId = String(
        (
          await finance.createBook(context, 'legacy-acceptance-book', {
            name: 'Legacy migration acceptance book',
            entityName: 'Legacy migration acceptance entity',
            entityKind: 'corporation',
            country: 'CA',
            functionalCurrency: 'CAD',
          })
        ).id,
      );
      cashLedgerId = String(
        (
          await finance.createAccount(context, bookId, 'legacy-cash-ledger', {
            code: '1000',
            name: 'Legacy cash',
            kind: 'asset',
          })
        ).id,
      );
      expenseLedgerId = String(
        (
          await finance.createAccount(
            context,
            bookId,
            'legacy-expense-ledger',
            {
              code: '6000',
              name: 'Legacy expense',
              kind: 'expense',
            },
          )
        ).id,
      );
      financialAccountId = String(
        (
          await finance.createFinancialAccount(
            context,
            bookId,
            'legacy-financial-account',
            {
              name: 'Legacy source cash',
              kind: 'cash',
              currency: 'CAD',
              ledgerAccountId: cashLedgerId,
            },
          )
        ).id,
      );
      const evidence = await finance.uploadBookEvidence(
        context,
        bookId,
        'legacy-evidence',
        {
          filename: 'legacy-source.csv',
          format: 'csv',
          sourceText:
            'Date,Description,Amount\n2026-08-31,Legacy market transaction,-42.05\n',
        },
      );
      evidenceId = String(evidence.id);

      await insertSpace(blockedSpaceId);
      await insertSpace(readySpaceId);
      await insertSourceRows([
        {
          id: randomUUID(),
          spaceId: blockedSpaceId,
          entityType: 'finance.account',
          entityId: 'blocked-account',
          payload: accountPayload({
            id: 'blocked-account',
            spaceId: blockedSpaceId,
            openingBalanceCadMinor: 1000,
          }),
          tombstonedAt: null,
        },
        {
          id: randomUUID(),
          spaceId: blockedSpaceId,
          entityType: 'finance.transaction',
          entityId: 'blocked-transaction',
          payload: transactionPayload({
            id: 'blocked-transaction',
            spaceId: blockedSpaceId,
            accountId: 'blocked-account',
            categoryId: 'blocked-category',
            sourceHash: digest('blocked-source'),
            fingerprint: digest('blocked-fingerprint'),
            sourceRow: 7,
            externalId: 'blocked-external',
          }),
          tombstonedAt: null,
        },
        {
          id: randomUUID(),
          spaceId: readySpaceId,
          entityType: 'finance.account',
          entityId: 'ready-account',
          payload: accountPayload({
            id: 'ready-account',
            spaceId: readySpaceId,
            openingBalanceCadMinor: 0,
          }),
          tombstonedAt: null,
        },
        {
          id: randomUUID(),
          spaceId: readySpaceId,
          entityType: 'finance.transaction',
          entityId: 'ready-transaction',
          payload: transactionPayload({
            id: 'ready-transaction',
            spaceId: readySpaceId,
            accountId: 'ready-account',
            categoryId: 'ready-category',
            sourceHash: digest('ready-source'),
            fingerprint: digest('ready-fingerprint'),
            sourceRow: 11,
            externalId: 'ready-external',
          }),
          tombstonedAt: null,
        },
        {
          id: randomUUID(),
          spaceId: readySpaceId,
          entityType: 'finance.transaction',
          entityId: 'deleted-transaction',
          payload: transactionPayload({
            id: 'deleted-transaction',
            spaceId: readySpaceId,
            accountId: 'ready-account',
            categoryId: 'ready-category',
            sourceHash: digest('deleted-source'),
            fingerprint: digest('deleted-fingerprint'),
            sourceRow: 12,
            externalId: 'deleted-external',
          }),
          tombstonedAt: '2026-09-02T00:00:00.000Z',
        },
      ]);
    });

    afterAll(async () => {
      await app?.end();
      await admin.query(`drop role if exists "${login}"`);
      await admin.end();
    });

    it('extracts a private source snapshot and leaves opening/classification queues visible', async () => {
      expect(await migration.checkReady()).toBe(true);
      const scopeProbe = await scopedSql(
        context,
        `select emdo.current_user_id()::text as user_id,
                emdo.current_session_id()::text as session_id,
                emdo.finance_book_access($1,$3) as book_access,
                emdo.finance_legacy_migration_access($1,$3,$1,$2,$4,ARRAY['administrator','preparer','approver']) as legacy_access`,
        [context.workspaceId, blockedSpaceId, bookId, context.userId],
      );
      expect(scopeProbe.rows[0]).toMatchObject({
        user_id: context.userId,
        session_id: context.sessionId,
        book_access: true,
        legacy_access: true,
      });
      const inspection = await migration.inspect(context, {
        mapping: {
          source: {
            householdId: context.workspaceId,
            privateSpaceId: blockedSpaceId,
            originalOwnerUserId: context.userId,
          },
          target: {
            workspaceId: context.workspaceId,
            bookId,
            ownerUserId: context.userId,
          },
          financialAccounts: [
            {
              legacyAccountId: 'blocked-account',
              targetFinancialAccountId: financialAccountId,
            },
          ],
          categories: [],
          evidence: [
            {
              legacyEntityId: 'blocked-transaction',
              targetEvidenceId: evidenceId,
            },
          ],
          openings: [],
        },
        idempotencyKey: 'legacy-blocked-inspect-2026',
      });

      expect(inspection.plan.status).toBe('blocked');
      expect(inspection.plan.counts).toMatchObject({
        source: 2,
        ready: 0,
        blocked: 2,
        unresolved: 2,
      });
      expect(inspection.records).toHaveLength(2);
      expect(inspection.records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            entityId: 'blocked-account',
            blockers: expect.arrayContaining([
              'opening-balance-review-required',
            ]),
          }),
          expect.objectContaining({
            entityId: 'blocked-transaction',
            blockers: expect.arrayContaining(['category-mapping-required']),
          }),
        ]),
      );

      const accountRecord = inspection.records.find(
        (record) => record.entityId === 'blocked-account',
      );
      if (!accountRecord) throw new Error('blocked account record missing');
      const historicalDecision = {
        classificationConfirmed: true,
        targetFinancialAccountId: financialAccountId,
        openingDisposition: 'explicit-opening',
        openingLedgerAccountId: cashLedgerId,
        openingEvidenceId: evidenceId,
        reason: 'Historical opening awaiting date review',
      };
      expect(() =>
        migration.review(context, {
          migrationId: inspection.run.id,
          recordId: accountRecord.id,
          expectedRevision: accountRecord.revision,
          decision: historicalDecision,
        }),
      ).toThrow();
      // Represents an already-saved pre-date-contract review; no date is invented.
      await sql(
        "update emdo.finance_legacy_migration_runs set mapping=jsonb_set(mapping,'{openings}',$2::jsonb),revision=revision+1 where id=$1",
        [
          inspection.run.id,
          JSON.stringify([
            {
              legacyAccountId: 'blocked-account',
              disposition: 'explicit-opening',
              targetLedgerAccountId: cashLedgerId,
              targetEvidenceId: evidenceId,
            },
          ]),
        ],
      );
      const historicalReviewId = randomUUID();
      await sql(
        'insert into emdo.finance_legacy_migration_reviews(id,workspace_id,book_id,migration_id,record_id,revision,decision,previous_state,reviewed_by) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)',
        [
          historicalReviewId,
          context.workspaceId,
          bookId,
          inspection.run.id,
          accountRecord.id,
          accountRecord.revision,
          JSON.stringify(historicalDecision),
          '{}',
          context.userId,
        ],
      );
      const reviewedAccount = await migration.get(context, inspection.run.id);
      expect(
        reviewedAccount.run.mapping.openings[0]!.openingEffectiveOn,
      ).toBeNull();
      expect(reviewedAccount.plan.status).toBe('blocked');
      expect(
        reviewedAccount.plan.candidates.find(
          (record) => record.entityId === 'blocked-account',
        )?.blockers,
      ).toContain('opening-posting-review-required');
      const transactionRecord = reviewedAccount.records.find(
        (record) => record.entityId === 'blocked-transaction',
      );
      if (!transactionRecord)
        throw new Error('blocked transaction record missing');
      const reviewedTransaction = await migration.review(context, {
        migrationId: inspection.run.id,
        recordId: transactionRecord.id,
        expectedRevision: transactionRecord.revision,
        decision: {
          classificationConfirmed: true,
          targetLedgerAccountId: expenseLedgerId,
          reason: 'Classification mapped to the reviewed expense account',
        },
      });
      expect(reviewedTransaction.plan.status).toBe('blocked');
      expect(reviewedTransaction.plan.counts.unresolved).toBe(1);
      expect(
        reviewedTransaction.records.find(
          (record) => record.entityId === 'blocked-account',
        )?.backfillState,
      ).toBe('pending');
      await expect(
        migration.backfill(context, {
          migrationId: reviewedTransaction.run.id,
          expectedRevision: reviewedTransaction.run.revision,
          sourceSnapshotHash: reviewedTransaction.plan.sourceSnapshotHash,
          idempotencyKey: 'legacy-blocked-backfill-2026',
        }),
      ).rejects.toMatchObject({ code: 'blocked' });
    });

    it('backfills only reviewed normalized rows, compares exact facts, and approves an idempotent cutover', async () => {
      const mapping = {
        source: {
          householdId: context.workspaceId,
          privateSpaceId: readySpaceId,
          originalOwnerUserId: context.userId,
        },
        target: {
          workspaceId: context.workspaceId,
          bookId,
          ownerUserId: context.userId,
        },
        financialAccounts: [
          {
            legacyAccountId: 'ready-account',
            targetFinancialAccountId: financialAccountId,
          },
        ],
        categories: [
          {
            legacyCategoryId: 'ready-category',
            targetLedgerAccountId: expenseLedgerId,
          },
        ],
        evidence: [
          {
            legacyEntityId: 'ready-transaction',
            targetEvidenceId: evidenceId,
          },
        ],
        openings: [],
      };
      const beforeSource = (
        await sql(
          `select entity_id,payload,revision,tombstoned_at from emdo.sync_entities where household_id=$1 and space_id=$2 order by entity_type,entity_id`,
          [context.workspaceId, readySpaceId],
        )
      ).rows;
      const inspection = await migration.inspect(context, {
        mapping,
        idempotencyKey: 'legacy-ready-inspect-2026',
      });
      expect(inspection.plan).toMatchObject({
        status: 'ready',
        counts: {
          source: 3,
          ready: 2,
          blocked: 0,
          preserved: 1,
          unresolved: 0,
        },
      });
      const activeRecord = inspection.records.find(
        (record) => record.entityId === 'ready-transaction',
      );
      if (!activeRecord) throw new Error('ready transaction record missing');
      expect(activeRecord.normalized).toMatchObject({
        nativeAmount: '-42.05',
        currency: 'CAD',
        sourceRow: 11,
        externalId: 'ready-external',
        sourceHash: digest('ready-source'),
        fingerprint: digest('ready-fingerprint'),
      });
      expect(
        inspection.records.find(
          (record) => record.entityId === 'deleted-transaction',
        ),
      ).toMatchObject({
        status: 'preserved',
        disposition: 'preserve-only',
        backfillState: 'preserved',
      });

      const backfilled = await migration.backfill(context, {
        migrationId: inspection.run.id,
        expectedRevision: inspection.run.revision,
        sourceSnapshotHash: inspection.plan.sourceSnapshotHash,
        idempotencyKey: 'legacy-ready-backfill-2026',
      });
      expect(backfilled).toMatchObject({
        status: 'backfilled',
        backfilledCount: 2,
        preservedCount: 1,
        replayed: false,
      });
      expect(backfilled.targetBatchIds).toHaveLength(1);
      expect(backfilled.targetRowIds).toHaveLength(1);
      expect(
        await migration.backfill(context, {
          migrationId: inspection.run.id,
          expectedRevision: inspection.run.revision,
          sourceSnapshotHash: inspection.plan.sourceSnapshotHash,
          idempotencyKey: 'legacy-ready-backfill-2026',
        }),
      ).toEqual(backfilled);

      const normalized = (
        await sql(
          `select i.financial_account_id,i.evidence_id,i.status as batch_status,
                  r.source_facts,r.native_amount::text,r.external_id,r.status as row_status
             from emdo.finance_normalized_imports i
             join emdo.finance_normalized_import_rows r on r.workspace_id=i.workspace_id and r.book_id=i.book_id and r.batch_id=i.id
            where i.workspace_id=$1 and i.book_id=$2 and r.id=$3`,
          [context.workspaceId, bookId, backfilled.targetRowIds[0]],
        )
      ).rows[0];
      expect(normalized).toMatchObject({
        financial_account_id: financialAccountId,
        evidence_id: evidenceId,
        batch_status: 'review',
        native_amount: '-42.050000000000',
        external_id: 'ready-external',
        row_status: 'review',
      });
      expect(normalized?.source_facts).toMatchObject({
        legacyMigration: {
          payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          provenance: {
            sourceHash: digest('ready-source'),
            fingerprint: digest('ready-fingerprint'),
            sourceRow: 11,
            externalId: 'ready-external',
          },
        },
      });
      expect(
        (
          await sql(
            `select count(*)::int as count from emdo.finance_economic_transactions where workspace_id=$1 and book_id=$2`,
            [context.workspaceId, bookId],
          )
        ).rows[0]?.count,
      ).toBe(0);

      const afterBackfillSource = (
        await sql(
          `select entity_id,payload,revision,tombstoned_at from emdo.sync_entities where household_id=$1 and space_id=$2 order by entity_type,entity_id`,
          [context.workspaceId, readySpaceId],
        )
      ).rows;
      expect(afterBackfillSource).toEqual(beforeSource);

      const comparison = await migration.compare(context, {
        migrationId: inspection.run.id,
        expectedRevision: 2,
      });
      expect(comparison).toMatchObject({
        status: 'passed',
        sourceTransactionCount: 1,
        targetTransactionCount: 1,
        sourceCadMinorTotal: '-4205',
        targetCadDecimalTotal: '-42.05',
        unresolvedCount: 0,
        mismatches: [],
      });

      const cutoverRequest = {
        migrationId: inspection.run.id,
        expectedRevision: 3,
        comparisonId: comparison.id,
        sourceSnapshotHash: comparison.sourceSnapshotHash,
        idempotencyKey: 'legacy-ready-cutover-2026',
      };
      const cutover = await migration.approveCutover(context, cutoverRequest);
      expect(cutover).toMatchObject({
        migrationId: inspection.run.id,
        comparisonId: comparison.id,
        status: 'approved',
        approvedBy: context.userId,
      });
      expect(await migration.approveCutover(context, cutoverRequest)).toEqual(
        cutover,
      );
      expect(
        (
          await sql(
            `select status,revision from emdo.finance_legacy_migration_runs where workspace_id=$1 and id=$2`,
            [context.workspaceId, inspection.run.id],
          )
        ).rows[0],
      ).toMatchObject({ status: 'cutover-approved', revision: 4 });
    });

    it.each(['updated', 'added', 'target-changed'] as const)(
      'rejects first cutover approval when a legacy source is %s after comparison',
      async (change) => {
        const spaceId = randomUUID();
        await insertSpace(spaceId);
        const accountId = `drift-${change}-account`;
        const transactionId = `drift-${change}-transaction`;
        const sourceId = randomUUID();
        await insertSourceRows([
          {
            id: randomUUID(),
            spaceId,
            entityType: 'finance.account',
            entityId: accountId,
            payload: accountPayload({
              id: accountId,
              spaceId,
              openingBalanceCadMinor: 0,
            }),
            tombstonedAt: null,
          },
          {
            id: sourceId,
            spaceId,
            entityType: 'finance.transaction',
            entityId: transactionId,
            payload: transactionPayload({
              id: transactionId,
              spaceId,
              accountId,
              categoryId: 'drift-category',
              sourceHash: digest(`drift-${change}`),
              fingerprint: digest(`drift-${change}-fingerprint`),
              sourceRow: 1,
              externalId: `drift-${change}`,
            }),
            tombstonedAt: null,
          },
        ]);
        const inspection = await migration.inspect(context, {
          mapping: {
            source: {
              householdId: context.workspaceId,
              privateSpaceId: spaceId,
              originalOwnerUserId: context.userId,
            },
            target: {
              workspaceId: context.workspaceId,
              bookId,
              ownerUserId: context.userId,
            },
            financialAccounts: [
              {
                legacyAccountId: accountId,
                targetFinancialAccountId: financialAccountId,
              },
            ],
            categories: [
              {
                legacyCategoryId: 'drift-category',
                targetLedgerAccountId: expenseLedgerId,
              },
            ],
            evidence: [
              { legacyEntityId: transactionId, targetEvidenceId: evidenceId },
            ],
            openings: [],
          },
          idempotencyKey: `legacy-drift-${change}-inspect`,
        });
        expect(inspection.plan.status).toBe('ready');
        await migration.backfill(context, {
          migrationId: inspection.run.id,
          expectedRevision: inspection.run.revision,
          sourceSnapshotHash: inspection.plan.sourceSnapshotHash,
          idempotencyKey: `legacy-drift-${change}-backfill`,
        });
        const comparison = await migration.compare(context, {
          migrationId: inspection.run.id,
          expectedRevision: 2,
        });
        expect(comparison.status).toBe('passed');
        if (change === 'target-changed') {
          const target = (
            await sql(
              `select n.id,n.revision from emdo.finance_normalized_import_rows n join emdo.finance_legacy_migration_records m on m.target_row_id=n.id where m.migration_id=$1 and m.entity_type='finance.transaction'`,
              [inspection.run.id],
            )
          ).rows[0]!;
          await finance.reviewNormalizedImportRow(
            context,
            bookId,
            String(target.id),
            randomUUID(),
            {
              expectedRevision: Number(target.revision),
              action: 'post',
              counterAccountId: expenseLedgerId,
              correction: { amount: '-99.99' },
              reason: 'Reviewed correction after migration comparison',
            },
          );
        } else if (change === 'updated') {
          await sql(
            `update emdo.sync_entities set payload=jsonb_set(payload,'{description}','"Changed after comparison"'::jsonb),revision=revision+1,updated_at=now() where id=$1`,
            [sourceId],
          );
        } else {
          await insertSourceRows([
            {
              id: randomUUID(),
              spaceId,
              entityType: 'finance.account',
              entityId: 'late-account',
              payload: accountPayload({
                id: 'late-account',
                spaceId,
                openingBalanceCadMinor: 0,
              }),
              tombstonedAt: null,
            },
          ]);
        }
        await expect(
          migration.approveCutover(context, {
            migrationId: inspection.run.id,
            expectedRevision: 3,
            comparisonId: comparison.id,
            sourceSnapshotHash: comparison.sourceSnapshotHash,
            idempotencyKey: `legacy-drift-${change}-approve`,
          }),
        ).rejects.toMatchObject({
          code: 'conflict',
          message:
            change === 'target-changed'
              ? 'finance-legacy-migration-target-snapshot-changed'
              : 'finance-legacy-migration-source-snapshot-changed',
        });
        expect(
          (
            await sql(
              `select count(*)::int as count from emdo.finance_legacy_migration_cutovers where workspace_id=$1 and migration_id=$2`,
              [context.workspaceId, inspection.run.id],
            )
          ).rows[0]?.count,
        ).toBe(0);
        expect(
          (
            await sql(
              `select status,revision from emdo.finance_legacy_migration_runs where workspace_id=$1 and id=$2`,
              [context.workspaceId, inspection.run.id],
            )
          ).rows[0],
        ).toMatchObject({ status: 'comparison-passed', revision: 3 });
      },
    );

    it('activates only posted targets, retires source writes, and reads new normalized transactions', async () => {
      const run = (
        await sql(
          `select id from emdo.finance_legacy_migration_runs where workspace_id=$1 and source_space_id=$2`,
          [context.workspaceId, readySpaceId],
        )
      ).rows[0]!;
      const scope = {
        workspaceId: context.workspaceId,
        sourceSpaceId: readySpaceId,
        sourceOwnerUserId: context.userId,
      };
      const work = async <T>(
        callback: (
          client: Awaited<ReturnType<typeof restrictedPool.connect>>,
        ) => Promise<T>,
      ) => {
        const client = await restrictedPool.connect();
        try {
          await client.query('begin');
          await client.query(
            `select set_config('emdo.user_id',$1,true),set_config('emdo.session_id',$2,true),set_config('emdo.request_id',$3,true)`,
            [context.userId, context.sessionId, randomUUID()],
          );
          const result = await callback(client);
          await client.query('commit');
          return result;
        } catch (error) {
          await client.query('rollback');
          throw error;
        } finally {
          client.release();
        }
      };
      expect(
        await work((client) => resolveLegacyFinanceRoute(client, scope)),
      ).toEqual({ kind: 'legacy' });
      await expect(
        work((client) =>
          inspectLegacyFinanceActivation(client, context.workspaceId, run.id),
        ),
      ).rejects.toThrow('posted-target-required');
      const target = (
        await sql(
          `select target_row_id,target_batch_id from emdo.finance_legacy_migration_records where workspace_id=$1 and migration_id=$2 and entity_id='ready-transaction'`,
          [context.workspaceId, run.id],
        )
      ).rows[0]!;
      await finance.createPeriod(context, bookId, 'activation-period', {
        startsOn: '2026-01-01',
        endsOn: '2026-12-31',
      });
      const reviewed = await finance.reviewNormalizedImportRow(
        context,
        bookId,
        target.target_row_id,
        'activation-review',
        {
          expectedRevision: 1,
          action: 'post',
          counterAccountId: expenseLedgerId,
          reason: 'Reviewed migration posting',
        },
      );
      await finance.commitNormalizedImport(
        context,
        bookId,
        target.target_batch_id,
        'activation-post',
        { expectedRevision: reviewed.batchRevision },
      );
      const ready = await work((client) =>
        inspectLegacyFinanceActivation(client, context.workspaceId, run.id),
      );
      await expect(
        work((client) =>
          activateLegacyFinance(client, context.workspaceId, run.id, ready),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      // Only this disposable acceptance database enables INSERT to exercise the guarded transition.
      await sql('grant insert on emdo.finance_legacy_activations to emdo_app');
      try {
        await expect(
          work((client) =>
            activateLegacyFinance(client, context.workspaceId, run.id, {
              ...ready,
              targetHash: '0'.repeat(64),
            }),
          ),
        ).rejects.toThrow('binding-changed');
        const writer = await admin.connect();
        try {
          const pid = Number(
            (await writer.query('select pg_backend_pid() as pid')).rows[0].pid,
          );
          let pending: Promise<unknown> | undefined;
          await work(async (client) => {
            await activateLegacyFinance(
              client,
              context.workspaceId,
              run.id,
              ready,
            );
            pending = writer
              .query(
                `update emdo.sync_entities set revision=revision+1 where space_id=$1 and entity_id='ready-transaction'`,
                [readySpaceId],
              )
              .then(
                () => 'unexpected-success',
                (error) => error,
              );
            let waiting = false;
            for (let attempt = 0; attempt < 50; attempt++) {
              waiting =
                (
                  await sql(
                    'select wait_event_type from pg_stat_activity where pid=$1',
                    [pid],
                  )
                ).rows[0]?.wait_event_type === 'Lock';
              if (waiting) break;
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            expect(waiting).toBe(true);
          });
          expect(await pending).toMatchObject({
            message: 'legacy-finance-writer-retired',
          });
        } finally {
          writer.release();
        }
      } finally {
        await sql(
          'revoke insert on emdo.finance_legacy_activations from emdo_app',
        );
      }
      // Exercise the real activation trigger through the restricted sync
      // repository: a stale queued Finance write must settle durably without
      // changing either source history or normalized accounting authority.
      const sync = new PostgresSyncRepository(restrictedPool);
      const syncClientId = randomUUID();
      await sync.registerClient({
        clientId: syncClientId,
        displayName: 'Legacy activation offline acceptance',
        principal: {
          userId: context.userId,
          sessionId: context.sessionId,
          requestId: randomUUID(),
          householdId: context.workspaceId,
        },
      });
      const syncContext = {
        source: 'offline-sync-api' as const,
        externalEffects: 'forbidden' as const,
        mayEnqueueProviderWrites: false as const,
        authorizationRevalidation: 'required-in-transaction' as const,
        authenticatedUserId: context.userId,
        authenticatedSessionId: context.sessionId,
        householdId: context.workspaceId,
        role: 'owner' as const,
        requestId: randomUUID(),
        writableSpaceIds: [readySpaceId],
        targetSpaceId: readySpaceId,
      };
      const staleFinanceOperation = {
        schemaVersion: 1 as const,
        clientId: syncClientId,
        operationId: randomUUID(),
        entity: { type: 'finance.budget', id: 'queued-before-activation' },
        mutation: {
          kind: 'create' as const,
          payload: {
            spaceId: readySpaceId,
            value: {
              id: 'queued-before-activation',
              currency: 'CAD',
              allocationsCadMinor: { groceries: 50000 },
            },
          },
        },
        baseRevision: 0,
        dependencies: [],
        actorIntent: 'Save the offline budget queued before activation',
        createdAt: '2026-09-01T00:00:00.000Z',
      };
      const staleInput = {
        operation: staleFinanceOperation,
        fingerprint: digest(JSON.stringify(staleFinanceOperation)),
        context: syncContext,
      };
      const retiredOutcome = {
        status: 'conflict',
        code: 'repository-rejected',
        disposition: 'terminal',
        conflicts: [{ field: 'legacy-finance-writer-retired', material: true }],
      };
      await expect(sync.executeOnce(staleInput)).resolves.toEqual({
        kind: 'executed',
        outcome: retiredOutcome,
      });
      await expect(sync.executeOnce(staleInput)).resolves.toEqual({
        kind: 'replay',
        outcome: retiredOutcome,
      });
      const shoppingOperation = {
        ...staleFinanceOperation,
        operationId: randomUUID(),
        entity: { type: 'shopping.item', id: 'shopping-after-activation' },
        mutation: {
          kind: 'create' as const,
          payload: {
            spaceId: readySpaceId,
            value: {
              name: 'Apples',
              unit: 'bag',
              quantityMinorUnits: 1000,
            },
          },
        },
        actorIntent: 'Add apples after Finance activation',
      };
      await expect(
        sync.executeOnce({
          operation: shoppingOperation,
          fingerprint: digest(JSON.stringify(shoppingOperation)),
          context: { ...syncContext, requestId: randomUUID() },
        }),
      ).resolves.toMatchObject({
        kind: 'executed',
        outcome: { status: 'applied', revision: 1 },
      });
      expect(
        (
          await sql(
            `select entity_type,entity_id from emdo.sync_entities where space_id=$1
          and entity_id in ('queued-before-activation','shopping-after-activation')`,
            [readySpaceId],
          )
        ).rows,
      ).toEqual([
        {
          entity_type: 'shopping.item',
          entity_id: 'shopping-after-activation',
        },
      ]);
      const route = await work((client) =>
        resolveLegacyFinanceRoute(client, scope),
      );
      expect(route.kind).toBe('normalized');
      if (route.kind !== 'normalized')
        throw new Error('missing normalized route');
      const projection = await work((client) =>
        readLegacyFinanceCompatibility(client, route, scope),
      );
      expect(projection.kind).toBe('ready');
      if (projection.kind !== 'ready')
        throw new Error('unrepresentable fixture');
      expect(projection.transactions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'ready-transaction',
            amountCadMinor: -4205,
            originalFingerprint: digest('ready-fingerprint'),
          }),
        ]),
      );
      expect(projection.accounts[0]).toMatchObject({
        id: 'ready-account',
        openingBalanceCadMinor: 0,
      });
      await expect(
        sql(
          `update emdo.sync_entities set revision=revision+1 where space_id=$1 and entity_id='ready-transaction'`,
          [readySpaceId],
        ),
      ).rejects.toThrow('writer-retired');
      await expect(
        insertSourceRows([
          {
            id: randomUUID(),
            spaceId: readySpaceId,
            entityType: 'finance.account',
            entityId: 'retired-new',
            payload: accountPayload({
              id: 'retired-new',
              spaceId: readySpaceId,
              openingBalanceCadMinor: 0,
            }),
            tombstonedAt: null,
          },
        ]),
      ).rejects.toThrow('writer-retired');
      const upload = await finance.uploadNormalizedStatement(
        context,
        bookId,
        'activation-new-import',
        {
          financialAccountId,
          filename: 'after.csv',
          format: 'csv',
          sourceText:
            'Date,Description,Amount\n2026-09-01,After activation,-12.34\n',
          mapping: {
            dateFormat: 'yyyy-mm-dd',
            columns: {
              date: 'Date',
              description: 'Description',
              amount: 'Amount',
            },
          },
        },
      );
      const batch = await finance.getNormalizedImport(
        context,
        bookId,
        String(upload.id),
      );
      const newReview = await finance.reviewNormalizedImportRow(
        context,
        bookId,
        String(batch.rows[0]!.id),
        'activation-new-review',
        {
          expectedRevision: 1,
          action: 'post',
          counterAccountId: expenseLedgerId,
          reason: 'Reviewed after activation',
        },
      );
      await finance.commitNormalizedImport(
        context,
        bookId,
        String(upload.id),
        'activation-new-post',
        { expectedRevision: newReview.batchRevision },
      );
      const refreshed = await work((client) =>
        readLegacyFinanceCompatibility(client, route, scope),
      );
      expect(refreshed.kind).toBe('ready');
      if (refreshed.kind === 'ready')
        expect(refreshed.transactions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: expect.stringMatching(/^normalized:/u),
              amountCadMinor: -1234,
              originalFingerprint: null,
            }),
          ]),
        );
      const lexical = await work((client) =>
        readLegacyFinanceCompatibility(client, route, scope, {
          order: 'entity-id',
          limit: 1,
        }),
      );
      expect(lexical.kind).toBe('ready');
      if (lexical.kind === 'ready') {
        expect(lexical.transactions).toHaveLength(1);
        expect(lexical.nextEntityId).not.toBeNull();
        const next = await work((client) =>
          readLegacyFinanceCompatibility(client, route, scope, {
            order: 'entity-id',
            afterEntityId: lexical.nextEntityId!,
            limit: 1,
          }),
        );
        if (next.kind !== 'ready') throw new Error('missing next page');
        expect(next.transactions).toHaveLength(1);
        expect(next.transactions[0]!.id).not.toBe(lexical.transactions[0]!.id);
      }
      const exact = await work((client) =>
        readLegacyFinanceCompatibility(client, route, scope, {
          entityId: 'ready-transaction',
          limit: 1,
        }),
      );
      if (exact.kind !== 'ready') throw new Error('missing exact record');
      expect(exact.transactions.map((t) => t.id)).toEqual([
        'ready-transaction',
      ]);
      const mixed = await work((client) =>
        readLegacyFinanceCompatibilityPage(client, route, scope, { limit: 1 }),
      );
      if (mixed.kind !== 'ready')
        throw new Error('mixed projection unavailable');
      expect(mixed.entries).toHaveLength(1);
      expect(mixed.nextCursor).toMatch(/^[0-9a-f-]{36}$/u);
      const mixedNext = await work((client) =>
        readLegacyFinanceCompatibilityPage(client, route, scope, {
          limit: 1,
          cursor: mixed.nextCursor!,
        }),
      );
      if (mixedNext.kind !== 'ready')
        throw new Error('mixed next projection unavailable');
      expect(mixedNext.entries[0]!.rowId).not.toBe(mixed.entries[0]!.rowId);
      const monthly = await work((client) =>
        readLegacyFinanceCompatibilityPage(client, route, scope, {
          month: '2026-09',
          entityTypes: ['finance.transaction'],
        }),
      );
      if (monthly.kind !== 'ready')
        throw new Error('monthly projection unavailable');
      expect(monthly.entries).toHaveLength(1);
      expect(monthly.projection.transactions[0]).toMatchObject({
        amountCadMinor: -1234,
        categoryId: 'ready-category',
      });
      expect(monthly.projection.accounts).toHaveLength(0);
      expect(monthly.nextCursor).toBeNull();
      const specialist = new PostgresFinanceSpecialistRecordRepository(
        restrictedPool,
      );
      const specialistScope = {
        householdId: context.workspaceId,
        userId: context.userId,
        sessionId: context.sessionId,
        requestId: context.requestId,
        privateSpaceId: readySpaceId,
        spaceAccessGrantId: randomUUID(),
        runId: randomUUID(),
        agentInvocationId: randomUUID(),
        phaseInvocationId: randomUUID(),
        invocationIdempotencyScope: 'c'.repeat(64),
        collectionAuthorizationScopeFingerprint: 'b'.repeat(64),
        abortSignal: new AbortController().signal,
      };
      await sql(
        `insert into emdo.space_access_grants(grant_id,household_id,original_owner_user_id,session_id,request_id,membership_id,role,private_space_id,writable_space_ids,issued_at,expires_at,retain_until)
        select $1,m.household_id,m.user_id,$2,$3,m.id,m.role,$4,(select array_agg(s.id order by s.id) from emdo.spaces s where s.household_id=m.household_id and s.tombstoned_at is null and (s.visibility='shared' or s.original_owner_user_id=m.user_id)),clock_timestamp()-interval '1 second',clock_timestamp()+interval '10 minutes',clock_timestamp()+interval '89 days'
        from emdo.household_memberships m where m.household_id=$5 and m.user_id=$6`,
        [
          specialistScope.spaceAccessGrantId,
          context.sessionId,
          context.requestId,
          readySpaceId,
          context.workspaceId,
          context.userId,
        ],
      );
      const specialistPage = await specialist.list({
        scope: specialistScope,
        limit: 1,
      });
      expect(specialistPage.records).toHaveLength(1);
      expect(specialistPage.nextCursor).not.toBeNull();
      const secondSpecialistPage = await specialist.list({
        scope: specialistScope,
        limit: 1,
        cursor: specialistPage.nextCursor,
      });
      expect(secondSpecialistPage.records[0]!.id).not.toBe(
        specialistPage.records[0]!.id,
      );
      const newId = monthly.projection.transactions[0]!.id;
      const owned = await specialist.getOwnedRecord({
        scope: specialistScope,
        recordId: newId,
      });
      expect(owned).toMatchObject({
        recordType: 'transaction',
        categoryId: 'ready-category',
        effectiveAmountCadMinor: -1234,
        source: { kind: 'normalized-ledger', bookId },
      });
      const budgetInputs = await specialist.listBudgetTransactions({
        scope: specialistScope,
        month: '2026-09',
        reviewedCommittedEvidenceOnly: true,
      });
      expect(budgetInputs).toHaveLength(1);
      expect(budgetInputs[0]).toEqual(owned);
      const accounts = await specialist.list({
        scope: specialistScope,
        recordTypes: ['account'],
        limit: 100,
      });
      expect(accounts.records.length).toBeGreaterThan(0);
      expect(accounts.records[0]).toMatchObject({
        source: { kind: 'normalized-ledger', bookId },
      });
      const manual = {
        schemaVersion: 1,
        id: 'rejected-manual',
        revision: 0,
        annotation: null,
        spaceId: readySpaceId,
        ownerUserId: context.userId,
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
        recordType: 'transaction',
        accountId: monthly.projection.transactions[0]!.legacyAccountId,
        categoryId: null,
        postedOn: '2026-09-01',
        description: 'Must reject after cutover',
        currency: 'CAD',
        originalAmountCadMinor: -100,
        effectiveAmountCadMinor: -100,
        adjustments: [],
        reversal: null,
        appliedOperationIds: [],
        source: { kind: 'manual' },
      };
      await expect(
        specialist.createManualTransaction({
          scope: specialistScope,
          idempotencyKey: 'reject-cutover-write',
          canonicalHash: 'a'.repeat(64),
          audit: {
            eventType: 'finance.agent.safe-write',
            operation: 'manual-transaction-create',
            canonicalHash: 'a'.repeat(64),
            requestId: context.requestId,
            runId: specialistScope.runId,
          },
          record: manual,
        }),
      ).rejects.toThrow(
        'Normalized Finance records require explicit book operations',
      );
      const grants = (
        await sql(
          'delete from emdo.finance_book_grants where workspace_id=$1 and book_id=$2 and user_id=$3 returning role',
          [context.workspaceId, bookId, context.userId],
        )
      ).rows;
      try {
        await expect(
          work((client) => resolveLegacyFinanceRoute(client, scope)),
        ).rejects.toThrow('target-forbidden');
        await expect(
          specialist.list({ scope: specialistScope, limit: 1 }),
        ).rejects.toThrow();
        await expect(
          specialist.getOwnedRecord({
            scope: specialistScope,
            recordId: newId,
          }),
        ).rejects.toThrow();
        await expect(
          specialist.listBudgetTransactions({
            scope: specialistScope,
            month: '2026-09',
            reviewedCommittedEvidenceOnly: true,
          }),
        ).rejects.toThrow();
      } finally {
        for (const grant of grants)
          await sql(
            'insert into emdo.finance_book_grants(workspace_id,book_id,user_id,role) values($1,$2,$3,$4)',
            [context.workspaceId, bookId, context.userId, grant.role],
          );
      }
    });

    it.each([12345, -12345])(
      'posts reviewed exact opening %s once, proves it, and requires reversal before correction',
      async (amount) => {
        const privateSpace = randomUUID();
        await insertSpace(privateSpace);
        const legacyId = `opening-${amount}`;
        const ledger = String(
          (
            await finance.createAccount(
              context,
              bookId,
              `opening-ledger-${amount}`,
              {
                code: `OP${Math.abs(amount)}${amount < 0 ? 'N' : 'P'}`,
                name: 'Opening bank',
                kind: 'asset',
              },
            )
          ).id,
        );
        const account = String(
          (
            await finance.createFinancialAccount(
              context,
              bookId,
              `opening-account-${amount}`,
              {
                name: 'Opening cash',
                kind: 'cash',
                currency: 'CAD',
                ledgerAccountId: ledger,
              },
            )
          ).id,
        );
        await insertSourceRows([
          {
            id: randomUUID(),
            spaceId: privateSpace,
            entityType: 'finance.account',
            entityId: legacyId,
            payload: accountPayload({
              id: legacyId,
              spaceId: privateSpace,
              openingBalanceCadMinor: amount,
            }),
            tombstonedAt: null,
          },
        ]);
        const inspection = await migration.inspect(context, {
          mapping: {
            source: {
              householdId: context.workspaceId,
              privateSpaceId: privateSpace,
              originalOwnerUserId: context.userId,
            },
            target: {
              workspaceId: context.workspaceId,
              bookId,
              ownerUserId: context.userId,
            },
            financialAccounts: [
              { legacyAccountId: legacyId, targetFinancialAccountId: account },
            ],
            categories: [],
            evidence: [],
            openings: [],
          },
          idempotencyKey: `opening-inspect-${amount}`,
        });
        const record = inspection.records[0]!;
        let reviewed = await migration.review(context, {
          migrationId: inspection.run.id,
          recordId: record.id,
          expectedRevision: record.revision,
          decision: {
            classificationConfirmed: true,
            targetFinancialAccountId: account,
            openingDisposition: 'explicit-opening',
            openingLedgerAccountId: expenseLedgerId,
            openingEvidenceId: evidenceId,
            openingEffectiveOn: '2025-01-01',
            reason:
              'Reviewed opening evidence, signed amount, date and counterpart',
          },
        });
        const openings = new PostgresFinanceOpeningRepository(restrictedPool);
        expect(await openings.checkReady()).toBe(true);
        await expect(
          openings.postLegacyOpening(
            context,
            bookId,
            reviewed.run.id,
            record.id,
            {
              expectedRunRevision: reviewed.run.revision,
              expectedRecordRevision: reviewed.records[0]!.revision,
              expectedSourceSnapshotHash: reviewed.plan.sourceSnapshotHash,
              idempotencyKey: `closed-period-${amount}`,
            },
          ),
        ).rejects.toThrow('finance-open-period-required');
        reviewed = await migration.review(context, {
          migrationId: reviewed.run.id,
          recordId: record.id,
          expectedRevision: reviewed.records[0]!.revision,
          decision: {
            classificationConfirmed: true,
            targetFinancialAccountId: account,
            openingDisposition: 'explicit-opening',
            openingLedgerAccountId: expenseLedgerId,
            openingEvidenceId: evidenceId,
            openingEffectiveOn: '2026-01-01',
            reason: 'Explicit reviewed opening date in open period',
          },
        });

        const request = {
          expectedRunRevision: reviewed.run.revision,
          expectedRecordRevision: reviewed.records[0]!.revision,
          expectedSourceSnapshotHash: reviewed.plan.sourceSnapshotHash,
          idempotencyKey: `opening-post-${amount}`,
        };
        await expect(
          openings.postLegacyOpening(
            context,
            bookId,
            reviewed.run.id,
            record.id,
            { ...request, expectedRecordRevision: 99 },
          ),
        ).rejects.toThrow();
        const posted = await openings.postLegacyOpening(
          context,
          bookId,
          reviewed.run.id,
          record.id,
          request,
        );
        expect(posted).toMatchObject({
          amountCadMinor: String(amount),
          effectiveOn: '2026-01-01',
          financialAccountId: account,
          evidenceId,
        });
        expect(
          await openings.postLegacyOpening(
            context,
            bookId,
            reviewed.run.id,
            record.id,
            request,
          ),
        ).toEqual(posted);
        expect(await openings.getLatest(context, bookId, account)).toEqual(
          posted,
        );
        expect(
          (
            await sql(
              'select count(*)::integer as count from emdo.finance_economic_transactions where workspace_id=$1 and book_id=$2 and journal_id=$3',
              [context.workspaceId, bookId, posted.journalId],
            )
          ).rows[0]!.count,
        ).toBe(0);
        await expect(
          scopedSql(
            context,
            "insert into emdo.finance_economic_transactions(workspace_id,book_id,financial_account_id,effective_on,description,native_amount,functional_amount,fx_rate,fx_source,journal_id,fingerprint,facts_hash) values($1,$2,$3,'2026-01-01','Forbidden opening duplicate',$4::numeric/100,$4::numeric/100,1,'identity',$5,$6,$6)",
            [
              context.workspaceId,
              bookId,
              account,
              amount,
              posted.journalId,
              'e'.repeat(64),
            ],
          ),
        ).rejects.toThrow('opening-economic-double-count-forbidden');
        const lines = (
          await sql(
            'select side,amount::text,account_id from emdo.finance_journal_lines where journal_id=$1 order by line_number',
            [posted.journalId],
          )
        ).rows;
        expect(lines[0]!.side).toBe(amount > 0 ? 'debit' : 'credit');
        expect(lines[1]!.side).toBe(amount > 0 ? 'credit' : 'debit');
        expect(lines[0]!.amount).toBe(lines[1]!.amount);
        await expect(
          openings.postLegacyOpening(
            context,
            bookId,
            reviewed.run.id,
            record.id,
            { ...request, idempotencyKey: `duplicate-${amount}` },
          ),
        ).rejects.toThrow();
        await expect(
          openings.getLatest(otherContext, bookId, account),
        ).rejects.toThrow();
        await expect(
          sql(
            'update emdo.finance_opening_proofs set evidence_digest=$2 where id=$1',
            [posted.id, 'f'.repeat(64)],
          ),
        ).rejects.toThrow();
        const backfilled = await migration.backfill(context, {
          migrationId: reviewed.run.id,
          expectedRevision: reviewed.run.revision,
          sourceSnapshotHash: reviewed.plan.sourceSnapshotHash,
          idempotencyKey: `opening-backfill-${amount}`,
        });
        const currentRevision = Number(
          (
            await sql(
              'select revision from emdo.finance_legacy_migration_runs where id=$1',
              [reviewed.run.id],
            )
          ).rows[0]!.revision,
        );
        const comparison = await migration.compare(context, {
          migrationId: reviewed.run.id,
          expectedRevision: currentRevision,
        });
        expect(comparison.status).toBe('passed');
        const comparedRevision = Number(
          (
            await sql(
              'select revision from emdo.finance_legacy_migration_runs where id=$1',
              [reviewed.run.id],
            )
          ).rows[0]!.revision,
        );
        await migration.approveCutover(context, {
          migrationId: reviewed.run.id,
          expectedRevision: comparedRevision,
          comparisonId: comparison.id,
          sourceSnapshotHash: comparison.sourceSnapshotHash,
          idempotencyKey: `opening-approve-${amount}`,
        });
        expect(backfilled.migrationId).toBe(reviewed.run.id);
        expect(await openings.getLatest(context, bookId, account)).toEqual(
          posted,
        );
        const openingReadiness = () =>
          scopedSql(
            context,
            'select emdo.legacy_finance_activation_readiness($1,$2) as ready',
            [context.workspaceId, reviewed.run.id],
          );
        expect((await openingReadiness()).rows[0]!.ready).toMatchObject({
          bookId,
        });

        const activationReady = (await openingReadiness()).rows[0]!.ready;
        // Synthetic activation permission exists only during this restricted acceptance.
        await sql(
          'grant insert on emdo.finance_legacy_activations to emdo_app',
        );
        const projectionClient = await restrictedPool.connect();
        try {
          await projectionClient.query('begin');
          await projectionClient.query(
            "select set_config('emdo.user_id',$1,true),set_config('emdo.session_id',$2,true),set_config('emdo.request_id',$3,true)",
            [context.userId, context.sessionId, context.requestId],
          );
          await projectionClient.query(
            'insert into emdo.finance_legacy_activations(workspace_id,source_space_id,source_owner_user_id,book_id,migration_id,source_hash,target_hash,activated_by) values($1,$2,$3,$4,$5,$6,$7,$3)',
            [
              context.workspaceId,
              privateSpace,
              context.userId,
              bookId,
              reviewed.run.id,
              activationReady.sourceHash,
              activationReady.targetHash,
            ],
          );
          const openingSource = {
            workspaceId: context.workspaceId,
            sourceSpaceId: privateSpace,
            sourceOwnerUserId: context.userId,
          };
          const openingRoute = await resolveLegacyFinanceRoute(
            projectionClient,
            openingSource,
          );
          if (openingRoute.kind !== 'normalized')
            throw new Error('opening activation missing');
          const projected = await readLegacyFinanceCompatibility(
            projectionClient,
            openingRoute,
            openingSource,
          );
          expect(projected).toMatchObject({
            kind: 'ready',
            accounts: [{ id: legacyId, openingBalanceCadMinor: amount }],
            transactions: [],
          });
          await projectionClient.query('commit');
        } finally {
          await projectionClient.query('rollback');
          projectionClient.release();
          await sql(
            'revoke insert on emdo.finance_legacy_activations from emdo_app',
          );
        }
        await finance.reverseJournal(
          context,
          bookId,
          posted.journalId,
          `opening-reverse-${amount}`,
          { effectiveOn: '2026-01-02', reason: 'Explicit correction reversal' },
        );
        expect(await openings.getLatest(context, bookId, account)).toBeNull();
        await expect(
          openings.postLegacyOpening(
            context,
            bookId,
            reviewed.run.id,
            record.id,
            request,
          ),
        ).rejects.toThrow('opening-reversed-replay-requires-new-key');
        await expect(openingReadiness()).rejects.toThrow(
          'legacy-activation-opening-posting-required',
        );
        await expect(
          scopedSql(
            context,
            'select emdo.resolve_legacy_finance_route($1,$2,$3)',
            [context.workspaceId, privateSpace, context.userId],
          ),
        ).rejects.toThrow('legacy-route-opening-proof-invalid');
        const revisions = (
          await sql(
            'select r.revision as run,x.revision as record from emdo.finance_legacy_migration_runs r join emdo.finance_legacy_migration_records x on x.migration_id=r.id where x.id=$1',
            [record.id],
          )
        ).rows[0]!;
        const replacement = await openings.postLegacyOpening(
          context,
          bookId,
          reviewed.run.id,
          record.id,
          {
            ...request,
            expectedRunRevision: Number(revisions.run),
            expectedRecordRevision: Number(revisions.record),
            idempotencyKey: `replacement-${amount}`,
          },
        );
        expect(replacement.supersedesProofId).toBe(posted.id);
        expect(await openings.getLatest(context, bookId, account)).toEqual(
          replacement,
        );
      },
    );

    it('keeps private source migrations invisible to another workspace member', async () => {
      await sql(
        `insert into emdo.finance_book_grants(workspace_id,book_id,user_id,role) values($1,$2,$3,'viewer')`,
        [context.workspaceId, bookId, otherContext.userId],
      );
      expect(await migration.list(otherContext, bookId)).toEqual([]);
      await expect(
        migration.get(otherContext, '00000000-0000-4000-8000-000000000001'),
      ).rejects.toMatchObject({ code: 'forbidden' });
      expect(
        (
          await sql(
            `select count(*)::int as count from emdo.finance_legacy_migration_runs where workspace_id=$1`,
            [context.workspaceId],
          )
        ).rows[0]?.count,
      ).toBe(7);
    });
  },
);

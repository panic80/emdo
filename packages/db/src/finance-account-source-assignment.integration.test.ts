import {
  resolveLegacyFinanceRoute,
  readLegacyFinanceCompatibility,
  readLegacyFinanceCompatibilityPage,
} from './finance-legacy-activation-projection.js';
import {
  upsertLegacyFinanceAccountAssignment,
  revokeLegacyFinanceAccountAssignment,
  listLegacyFinanceAccountAssignments,
  listLegacyFinanceAssignmentSources,
} from './finance-account-source-assignment-repository.js';
import {
  inspectLegacyFinanceActivation,
  activateLegacyFinance,
} from './finance-legacy-activation-repository.js';
import { createHash, randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { UuidSchema, type WorkspaceContext } from '@emdo/contracts';
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
  'explicit financial account source assignment PostgreSQL acceptance',
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

    it('assigns explicit sources atomically, retains approved mappings, and revokes with CAS', async () => {
      const inspection = await migration.inspect(context, {
        mapping: {
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
        },
        idempotencyKey: 'source-assignment-inspect',
      });
      const backfilled = await migration.backfill(context, {
        migrationId: inspection.run.id,
        expectedRevision: 1,
        sourceSnapshotHash: inspection.plan.sourceSnapshotHash,
        idempotencyKey: 'source-assignment-backfill',
      });
      const comparison = await migration.compare(context, {
        migrationId: inspection.run.id,
        expectedRevision: 2,
      });
      await migration.approveCutover(context, {
        migrationId: inspection.run.id,
        expectedRevision: 3,
        comparisonId: comparison.id,
        sourceSnapshotHash: comparison.sourceSnapshotHash,
        idempotencyKey: 'source-assignment-approve',
      });
      await finance.createPeriod(context, bookId, 'assignment-period', {
        startsOn: '2026-01-01',
        endsOn: '2026-12-31',
      });
      const reviewed = await finance.reviewNormalizedImportRow(
        context,
        bookId,
        backfilled.targetRowIds[0]!,
        'assignment-review',
        {
          expectedRevision: 1,
          action: 'post',
          counterAccountId: expenseLedgerId,
          reason: 'Reviewed',
        },
      );
      await finance.commitNormalizedImport(
        context,
        bookId,
        backfilled.targetBatchIds[0]!,
        'assignment-post',
        { expectedRevision: reviewed.batchRevision },
      );
      const work = async <T>(
        fn: (
          c: Awaited<ReturnType<typeof restrictedPool.connect>>,
        ) => Promise<T>,
      ) => {
        const c = await restrictedPool.connect();
        try {
          await c.query('begin');
          await c.query(
            `select set_config('emdo.user_id',$1,true),set_config('emdo.session_id',$2,true),set_config('emdo.request_id',$3,true)`,
            [context.userId, context.sessionId, randomUUID()],
          );
          const r = await fn(c);
          await c.query('commit');
          return r;
        } catch (e) {
          await c.query('rollback');
          throw e;
        } finally {
          c.release();
        }
      };
      const ready = await work((c) =>
        inspectLegacyFinanceActivation(
          c,
          context.workspaceId,
          inspection.run.id,
        ),
      );
      await sql('grant insert on emdo.finance_legacy_activations to emdo_app');
      try {
        await work((c) =>
          activateLegacyFinance(
            c,
            context.workspaceId,
            inspection.run.id,
            ready,
          ),
        );
      } finally {
        await sql(
          'revoke insert on emdo.finance_legacy_activations from emdo_app',
        );
      }
      const assignments = await work((c) =>
        listLegacyFinanceAccountAssignments(c, {
          workspaceId: context.workspaceId,
          bookId,
          sourceSpaceId: readySpaceId,
        }),
      );
      expect(assignments).toEqual([
        expect.objectContaining({
          accountId: financialAccountId,
          legacyEntityId: 'ready-account',
          revision: 1,
          status: 'active',
        }),
      ]);
      expect(
        await work((c) =>
          listLegacyFinanceAssignmentSources(c, {
            workspaceId: context.workspaceId,
            bookId,
          }),
        ),
      ).toEqual([
        expect.objectContaining({
          sourceSpaceId: readySpaceId,
          sourceOwnerUserId: context.userId,
        }),
      ]);
      const ledger = await finance.createAccount(
        context,
        bookId,
        'assigned-ledger',
        { code: '1015', name: 'New cash', kind: 'asset' },
      );
      const createInput = {
        name: 'New private cash',
        kind: 'cash',
        currency: 'CAD',
        ledgerAccountId: ledger.id,
        privateSourceAssignment: {
          sourceSpaceId: readySpaceId,
          compatibilityAccountKind: 'cash',
          reason: 'Explicit private source',
        },
      };
      const sourceLock = await admin.connect();
      let created: Awaited<ReturnType<typeof finance.createFinancialAccount>>;
      try {
        await sourceLock.query('begin');
        await sourceLock.query(
          'select emdo.lock_legacy_finance_source($1,$2,$3)',
          [context.workspaceId, readySpaceId, context.userId],
        );
        const pending = finance.createFinancialAccount(
          context,
          bookId,
          'create-assigned-account',
          createInput,
        );
        let waiting = false;
        for (let attempt = 0; attempt < 50; attempt++) {
          waiting =
            (
              await sql(
                "select count(*)::int as n from pg_stat_activity where application_name=$1 and wait_event_type='Lock'",
                [login],
              )
            ).rows[0]?.n > 0;
          if (waiting) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        await sourceLock.query('commit');
        created = await pending;
      } finally {
        await sourceLock.query('rollback');
        sourceLock.release();
      }
      expect(
        await finance.createFinancialAccount(
          context,
          bookId,
          'create-assigned-account',
          createInput,
        ),
      ).toEqual(created);
      const createdId = UuidSchema.parse(created.id);
      const scope = {
        workspaceId: context.workspaceId,
        bookId,
        accountId: createdId,
      };
      const heads = await work((c) =>
        listLegacyFinanceAccountAssignments(c, {
          workspaceId: context.workspaceId,
          bookId,
          sourceSpaceId: readySpaceId,
        }),
      );
      expect(heads.find((x) => x.accountId === created.id)).toMatchObject({
        revision: 1,
        status: 'active',
        legacyEntityId: null,
      });
      await expect(
        work((c) =>
          upsertLegacyFinanceAccountAssignment(c, scope, {
            expectedRevision: 0,
            sourceSpaceId: readySpaceId,
            compatibilityAccountKind: 'cash',
            reason: 'Stale',
          }),
        ),
      ).rejects.toThrow('revision-conflict');
      await expect(
        work((c) =>
          upsertLegacyFinanceAccountAssignment(c, scope, {
            expectedRevision: 1,
            sourceSpaceId: readySpaceId,
            compatibilityAccountKind: 'savings',
            reason: 'Invalid kind',
          }),
        ),
      ).rejects.toThrow('kind-invalid');
      expect(
        await work((c) =>
          revokeLegacyFinanceAccountAssignment(c, scope, {
            expectedRevision: 1,
            reason: 'Stop private routing',
          }),
        ),
      ).toMatchObject({ revision: 2, status: 'revoked' });
      expect(
        await work((c) =>
          upsertLegacyFinanceAccountAssignment(c, scope, {
            expectedRevision: 2,
            sourceSpaceId: readySpaceId,
            compatibilityAccountKind: 'cash',
            reason: 'Explicit restore',
          }),
        ),
      ).toMatchObject({ revision: 3, status: 'active' });
      expect(
        (
          await sql(
            'select count(*)::int as n from emdo.finance_account_source_assignment_events where account_id=$1',
            [created.id],
          )
        ).rows[0]?.n,
      ).toBe(3);
      await expect(
        scopedSql(
          context,
          'delete from emdo.finance_account_source_assignment_events where account_id=$1',
          [created.id],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      const rejectedLedger = await finance.createAccount(
        context,
        bookId,
        'unassigned-ledger',
        { code: '1016', name: 'Rejected cash', kind: 'asset' },
      );
      await expect(
        finance.createFinancialAccount(
          context,
          bookId,
          'rejected-assignment-create',
          {
            ...createInput,
            name: 'Must roll back',
            ledgerAccountId: rejectedLedger.id,
            privateSourceAssignment: {
              ...createInput.privateSourceAssignment,
              sourceSpaceId: blockedSpaceId,
            },
          },
        ),
      ).rejects.toThrow();
      expect(
        (
          await sql(
            'select count(*)::int as n from emdo.finance_financial_accounts where ledger_account_id=$1',
            [rejectedLedger.id],
          )
        ).rows[0]?.n,
      ).toBe(0);
      await expect(
        scopedSql(
          otherContext,
          'select emdo.set_legacy_finance_account_assignment($1,$2,$3,3,$4,$5,$6,false)',
          [
            context.workspaceId,
            bookId,
            created.id,
            readySpaceId,
            'cash',
            'Attempt another owner',
          ],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        sql(
          "update emdo.finance_account_source_assignment_events set snapshot='{}'::jsonb where account_id=$1",
          [created.id],
        ),
      ).rejects.toMatchObject({ code: '55000' });
      const sourceScope = {
        workspaceId: context.workspaceId,
        sourceSpaceId: readySpaceId,
        sourceOwnerUserId: context.userId,
      };
      const route = await work((c) =>
        resolveLegacyFinanceRoute(c, sourceScope),
      );
      if (route.kind !== 'normalized')
        throw new Error('missing explicit normalized route');
      expect(
        await work((c) =>
          readLegacyFinanceCompatibility(c, route, sourceScope, {
            entityId: `normalized-account:${createdId}`,
            recordEntityIds: [`normalized-account:${createdId}`],
          }),
        ),
      ).toMatchObject({
        kind: 'unsupported-opening',
        financialAccountId: createdId,
      });
      await work((c) =>
        revokeLegacyFinanceAccountAssignment(c, scope, {
          expectedRevision: 3,
          reason: 'Withdraw pending account',
        }),
      );
      const revokedNew = await work((c) =>
        readLegacyFinanceCompatibility(c, route, sourceScope, {
          entityId: `normalized-account:${createdId}`,
          recordEntityIds: [`normalized-account:${createdId}`],
        }),
      );
      if (revokedNew.kind !== 'ready')
        throw new Error('revoked assignment must not project');
      expect(revokedNew.accounts).toEqual([]);
      const oldScope = {
        workspaceId: context.workspaceId,
        bookId,
        accountId: financialAccountId,
      };
      await work((c) =>
        revokeLegacyFinanceAccountAssignment(c, oldScope, {
          expectedRevision: 1,
          reason: 'Withdraw migrated account',
        }),
      );
      const revokedOld = await work((c) =>
        readLegacyFinanceCompatibility(c, route, sourceScope, {
          entityId: 'ready-account',
          recordEntityIds: ['ready-account'],
        }),
      );
      if (revokedOld.kind !== 'ready')
        throw new Error('revoked legacy assignment must not fallback');
      expect(revokedOld.accounts).toEqual([]);
      await work((c) =>
        upsertLegacyFinanceAccountAssignment(c, oldScope, {
          expectedRevision: 2,
          sourceSpaceId: readySpaceId,
          compatibilityAccountKind: 'cash',
          reason: 'Restore migrated association',
        }),
      );
      const restored = await work((c) =>
        readLegacyFinanceCompatibilityPage(c, route, sourceScope, {
          entityTypes: ['finance.account'],
        }),
      );
      if (restored.kind !== 'ready')
        throw new Error('restored legacy account unavailable');
      expect(restored.projection.accounts).toEqual([
        expect.objectContaining({
          id: 'ready-account',
          openingBalanceCadMinor: 0,
        }),
      ]);
      await work((c) =>
        upsertLegacyFinanceAccountAssignment(c, scope, {
          expectedRevision: 4,
          sourceSpaceId: readySpaceId,
          compatibilityAccountKind: 'cash',
          reason: 'Explicit pending account restore',
        }),
      );
      const statement = await finance.uploadNormalizedStatement(
        context,
        bookId,
        'assignment-new-statement',
        {
          financialAccountId: createdId,
          filename: 'new.csv',
          format: 'csv',
          sourceText:
            'Date,Description,Amount\n2026-09-01,Pending account transaction,-12.34\n',
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
      const statementId = UuidSchema.parse(statement.id);
      const statementRows = await finance.getNormalizedImport(
        context,
        bookId,
        statementId,
      );
      const statementReview = await finance.reviewNormalizedImportRow(
        context,
        bookId,
        UuidSchema.parse(statementRows.rows[0]!.id),
        'assignment-new-review',
        {
          expectedRevision: 1,
          action: 'post',
          counterAccountId: expenseLedgerId,
          reason: 'Reviewed new account transaction',
        },
      );
      await finance.commitNormalizedImport(
        context,
        bookId,
        statementId,
        'assignment-new-post',
        { expectedRevision: statementReview.batchRevision },
      );
      expect(
        await work((c) =>
          readLegacyFinanceCompatibilityPage(c, route, sourceScope, {
            entityTypes: ['finance.transaction'],
            month: '2026-09',
          }),
        ),
      ).toMatchObject({
        kind: 'unsupported-opening',
        financialAccountId: createdId,
      });
      const denied = await scopedSql(
        otherContext,
        'select * from emdo.finance_account_source_assignments where account_id=$1',
        [created.id],
      );
      expect(denied.rows).toEqual([]);
    });
  },
);

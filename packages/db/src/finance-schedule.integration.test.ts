import {
  FinanceBookEvidenceCrypto,
  EncryptedFinanceBookEvidenceSchema,
} from '../../integrations/src/finance-documents/book-evidence-crypto.js';
import { InMemoryVaultKeyProvider } from '../../integrations/src/vault/crypto.js';
import { FinanceJournalDraftRepository } from './finance-journal-draft-repository.js';
import { PostgresFinanceJournalDraftExecutionRepository } from './finance-journal-draft-execution-repository.js';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseClient } from './worker/runtime.js';
import { FinanceAutomationScheduleSchema } from '@emdo/contracts';
import { planFinanceAutomationDue } from '@emdo/domains/finance';
import { PostgresFinanceV2Repository } from './finance-v2-repository.js';
import {
  PostgresFinanceAutomationRepository,
  PostgresFinanceAutomationExecutionRepository,
} from './finance-automation-repository.js';
import {
  PostgresFinanceScheduleRepository,
  PostgresFinanceScheduleDueRepository,
} from './finance-schedule-repository.js';
const url = process.env.FINANCE_AUTOMATION_TEST_DATABASE_URL;
describe.skipIf(!url)(
  'Restricted recurring Finance scheduler PostgreSQL',
  () => {
    const admin = new pg.Pool({ connectionString: url });
    const rolePool = (role: string) => ({
      async connect() {
        const c = await admin.connect();
        await c.query(`set role ${role}`);
        return c;
      },
    });
    const timezoneVersion = process.versions.tz ?? 'unavailable';
    const schedules = new PostgresFinanceScheduleRepository(
      rolePool('emdo_app'),
      timezoneVersion,
    );
    const schedulerUrl = new URL(url ?? 'postgresql://localhost/unused');
    schedulerUrl.username = 'emdo_finance_scheduler_login';
    schedulerUrl.password = 'synthetic-scheduler-test-only';
    const schedulerDatabase = createDatabaseClient({
      connectionString: schedulerUrl.href,
      fixedRole: 'emdo_finance_scheduler',
    });
    const due = new PostgresFinanceScheduleDueRepository(
      schedulerDatabase.scopedPool,
      timezoneVersion,
    );
    const grants = new PostgresFinanceAutomationRepository(
      rolePool('emdo_app'),
    );
    const finance = new PostgresFinanceV2Repository(rolePool('emdo_app'));
    const worker = new PostgresFinanceAutomationExecutionRepository(
      rolePool('emdo_worker'),
    );
    async function sql(query: string, values: unknown[] = []) {
      const c = await admin.connect();
      try {
        await c.query('reset role');
        return await c.query(query, values);
      } finally {
        c.release();
      }
    }
    let originalReadiness: { capability: string; ready: boolean }[] = [];
    beforeAll(async () => {
      originalReadiness = (
        await sql(
          "select capability,ready from emdo.finance_automation_capabilities where capability in ('finance.reports.generate','finance.documents.extract','finance.journals.draft')",
        )
      ).rows;
      await sql(
        "do $$ begin if not exists(select from pg_roles where rolname='emdo_finance_scheduler_login') then create role emdo_finance_scheduler_login login nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication; end if; end $$",
      );
      await sql(
        "alter role emdo_finance_scheduler_login password 'synthetic-scheduler-test-only'",
      );
      await sql(
        'grant emdo_finance_scheduler to emdo_finance_scheduler_login with inherit false, set true',
      );
      await schedulerDatabase.checkReady({ signal: AbortSignal.timeout(3000) });
      expect(await due.checkReady()).toBe(true);
    });
    afterAll(async () => {
      for (const row of originalReadiness)
        await sql(
          'update emdo.finance_automation_capabilities set ready=$2 where capability=$1',
          [row.capability, row.ready],
        );
      await schedulerDatabase.close();
      await admin.end();
    });
    async function fixture() {
      const userId = randomUUID(),
        workspaceId = randomUUID(),
        sessionId = randomUUID();
      await sql(
        "insert into emdo.auth_users(id,name,email,email_verified) values($1,'Schedule test',$2,true)",
        [userId, `${userId}@example.test`],
      );
      await sql(
        "insert into emdo.households(id,name,created_by_user_id,slug) values($1::uuid,'Schedule test',$2,$1::text)",
        [workspaceId, userId],
      );
      await sql(
        "insert into emdo.household_memberships(household_id,user_id,role) values($1,$2,'owner')",
        [workspaceId, userId],
      );
      await sql(
        "insert into emdo.auth_sessions(id,user_id,token,expires_at,active_household_id) values($1::uuid,$2,$1::text,now()+interval '1 day',$3)",
        [sessionId, userId, workspaceId],
      );
      const context = {
        workspaceId,
        userId,
        sessionId,
        requestId: randomUUID(),
      };
      const bookId = String(
        (
          await finance.createBook(context, randomUUID(), {
            name: 'Scheduled book',
            entityName: 'Example',
            entityKind: 'corporation',
            country: 'CA',
            functionalCurrency: 'CAD',
          })
        ).id,
      );
      await sql(
        "insert into emdo.workspace_entitlements(workspace_id,capability,enabled) values($1,'finance.automations.run',true)",
        [workspaceId],
      );
      // Disposable synthetic readiness only. Migration leaves all capabilities disabled.
      await sql(
        "update emdo.finance_automation_capabilities set ready=true where capability='finance.reports.generate'",
      );
      const grant = await grants.createGrant(context, bookId, {
        capabilities: ['finance.reports.generate'],
        limits: {
          maxRuns: 20,
          maxAttemptsPerRun: 2,
          maxItemsPerRun: 1,
          maxTotalItems: 20,
          currency: 'CAD',
          maxAmountPerRun: '0',
          maxTotalAmount: '0',
        },
        validFrom: new Date(Date.now() - 172800000).toISOString(),
        expiresAt: new Date(Date.now() + 172800000).toISOString(),
      });
      const id = randomUUID();
      const definition = {
        workspaceId,
        bookId,
        grantId: grant.id,
        grantRevision: grant.revision,
        capability: 'finance.reports.generate',
        targets: [randomUUID()],
        money: { currency: 'CAD', amount: '0' },
        startAt: new Date(Date.now() - 120000).toISOString(),
        endAt: null,
        cadence: {
          kind: 'interval',
          everySeconds: 60,
          timeZone: 'UTC',
          clock: 'elapsed-utc',
        },
        misfire: { policy: 'coalesce-latest', maxLatenessSeconds: 86400 },
        concurrency: { policy: 'forbid', onBusy: 'defer' },
      };
      const saved = await schedules.createSchedule(
        context,
        bookId,
        id,
        definition,
      );
      return { context, bookId, grant, id, definition, saved };
    }
    async function ownClaim(id: string) {
      const claims = await due.claimDue(20);
      const claim = claims.find((c) => c.input.schedule.id === id);
      expect(claim).toBeDefined();
      return claim!;
    }
    const sourceCipher = new FinanceBookEvidenceCrypto(
      new InMemoryVaultKeyProvider(
        new Uint8Array(32).fill(31),
        'finance-documents.v1',
      ),
    );
    const sourceFinance = new PostgresFinanceV2Repository(
      rolePool('emdo_app'),
      {
        evidenceCipher: {
          encrypt: (v, scope) => sourceCipher.encrypt(v, scope),
          decrypt: (v, scope) =>
            sourceCipher.decrypt(
              EncryptedFinanceBookEvidenceSchema.parse(v),
              scope,
            ),
        },
      },
    );
    const journalDrafts = new FinanceJournalDraftRepository(
      rolePool('emdo_app'),
      sourceFinance,
    );
    const journalGenerator = new PostgresFinanceJournalDraftExecutionRepository(
      rolePool('emdo_worker'),
    );
    async function pinnedFixture(kind: 'journal' | 'extraction') {
      const base = await fixture();
      await schedules.setScheduleState(base.context, base.bookId, base.id, {
        expectedStateRevision: 1,
        status: 'retired',
      });
      const capability =
        kind === 'journal'
          ? 'finance.journals.draft'
          : 'finance.documents.extract';
      await sql(
        'update emdo.finance_automation_capabilities set ready=true where capability=$1',
        [capability],
      );
      const grant = await grants.createGrant(base.context, base.bookId, {
        capabilities: [capability],
        limits: {
          maxRuns: 20,
          maxAttemptsPerRun: 2,
          maxItemsPerRun: 10,
          maxTotalItems: 200,
          currency: 'CAD',
          maxAmountPerRun: '1000',
          maxTotalAmount: '20000',
        },
        validFrom: new Date(Date.now() - 172800000).toISOString(),
        expiresAt: new Date(Date.now() + 172800000).toISOString(),
      });
      const csv = `Date,Description,Amount,ID\n2026-03-08,Recurring receipt,123.45,${randomUUID()}`;
      let sourceId: string,
        rowId: string | null = null,
        runId: string | null = null;
      let pinned: Record<string, unknown>;
      if (kind === 'journal') {
        const cash = String(
          (
            await sourceFinance.createAccount(
              base.context,
              base.bookId,
              randomUUID(),
              { code: '1000', name: 'Cash', kind: 'asset' },
            )
          ).id,
        );
        const counter = String(
          (
            await sourceFinance.createAccount(
              base.context,
              base.bookId,
              randomUUID(),
              { code: '3000', name: 'Capital', kind: 'equity' },
            )
          ).id,
        );
        const financialAccountId = String(
          (
            await sourceFinance.createFinancialAccount(
              base.context,
              base.bookId,
              randomUUID(),
              {
                name: 'Source bank',
                kind: 'bank',
                currency: 'CAD',
                ledgerAccountId: cash,
              },
            )
          ).id,
        );
        await sourceFinance.createPeriod(
          base.context,
          base.bookId,
          randomUUID(),
          { startsOn: '2026-01-01', endsOn: '2026-12-31' },
        );
        sourceId = String(
          (
            await sourceFinance.uploadNormalizedStatement(
              base.context,
              base.bookId,
              randomUUID(),
              {
                financialAccountId,
                filename: 'recurring.csv',
                format: 'csv',
                sourceText: csv,
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
        rowId = String(
          (
            await sourceFinance.getNormalizedImport(
              base.context,
              base.bookId,
              sourceId,
            )
          ).rows[0]!.id,
        );
        await sourceFinance.reviewNormalizedImportRow(
          base.context,
          base.bookId,
          rowId,
          randomUUID(),
          {
            expectedRevision: 1,
            action: 'post',
            counterAccountId: counter,
            reason: 'Verified recurring source',
          },
        );
        const prepared = await journalDrafts.prepareJournalDraft(
          base.context,
          base.bookId,
          randomUUID(),
          { batchId: sourceId },
        );
        pinned = { journal: prepared.journal };
      } else {
        sourceId = String(
          (
            await sourceFinance.uploadBookEvidence(
              base.context,
              base.bookId,
              randomUUID(),
              { filename: 'recurring.csv', format: 'csv', sourceText: csv },
            )
          ).id,
        );
        const extraction = await grants.prepareExtraction(
          base.context,
          base.bookId,
          randomUUID(),
          {
            evidenceId: sourceId,
            expectedSourceDigest: createHash('sha256')
              .update(csv)
              .digest('hex'),
          },
        );
        runId = extraction.standardizationRunId;
        pinned = { extraction };
      }
      const id = randomUUID();
      const definition = {
        ...base.definition,
        grantId: grant.id,
        grantRevision: grant.revision,
        capability,
        targets: [sourceId],
        money: { currency: 'CAD', amount: kind === 'journal' ? '123.45' : '0' },
        ...pinned,
      };
      return {
        ...base,
        kind,
        grant,
        id,
        definition,
        pinned,
        sourceId,
        rowId,
        runId,
      };
    }
    type PinnedFixture = Awaited<ReturnType<typeof pinnedFixture>>;
    async function revisePinnedSource(f: PinnedFixture) {
      if (f.kind === 'journal') {
        const row = (
          await sourceFinance.getNormalizedImport(
            f.context,
            f.bookId,
            f.sourceId,
          )
        ).rows[0]!;
        await sourceFinance.reviewNormalizedImportRow(
          f.context,
          f.bookId,
          f.rowId!,
          randomUUID(),
          {
            expectedRevision: Number(row.revision),
            action: 'post',
            counterAccountId: row.counter_account_id,
            correction: { description: 'Re-reviewed source revision' },
            reason: 'Source facts corrected after scheduling',
          },
        );
      } else {
        // Simulate another authorized extraction transition advancing the pinned run CAS.
        await sql(
          'update emdo.finance_standardization_runs set revision=revision+1 where id=$1',
          [f.runId],
        );
      }
    }
    async function persistedPlanCount(id: string) {
      return (
        await sql(
          'select count(*)::int as n from emdo.finance_schedule_plans where schedule_id=$1',
          [id],
        )
      ).rows[0]!.n;
    }
    it.each(['journal', 'extraction'] as const)(
      'pins the exact %s intent and creates one canonical occurrence with identical retry',
      async (kind) => {
        const f = await pinnedFixture(kind);
        const saved = await schedules.createSchedule(
          f.context,
          f.bookId,
          f.id,
          f.definition,
        );
        expect(saved.schedule.definition).toMatchObject(f.pinned);
        expect(
          await schedules.createSchedule(
            f.context,
            f.bookId,
            f.id,
            f.definition,
          ),
        ).toEqual(saved);
        await expect(
          schedules.createSchedule(f.context, f.bookId, randomUUID(), {
            ...f.definition,
            targets: [randomUUID()],
          }),
        ).rejects.toThrow();
        await expect(
          schedules.createSchedule(f.context, f.bookId, randomUUID(), {
            ...f.definition,
            money: { currency: 'CAD', amount: kind === 'journal' ? '0' : '1' },
          }),
        ).rejects.toThrow();
        // A newer upload must not silently retarget an already pinned schedule.
        await sourceFinance.uploadBookEvidence(
          f.context,
          f.bookId,
          randomUUID(),
          {
            format: 'csv',
            filename: 'newer.csv',
            sourceText: 'Date,Amount\n2026-03-09,999',
          },
        );
        const claim = await ownClaim(f.id);
        const plan = planFinanceAutomationDue(claim.input);
        const committed = await due.commit(claim, plan);
        expect(committed.status).toBe('due');
        expect(await due.commit(claim, plan)).toMatchObject({
          status: 'duplicate',
          operationId: committed.operationId,
          plan,
        });
        const rows = (
          await sql(
            'select r.intent,r.item_count,r.amount::text,r.currency,d.delivery_revision from emdo.finance_schedule_plans p join emdo.finance_automation_runs r on r.id=p.operation_id join emdo.finance_deliveries d on d.operation_id=r.id where p.schedule_id=$1',
            [f.id],
          )
        ).rows;
        expect(rows).toHaveLength(1);
        expect(rows[0].intent).toMatchObject({
          ...f.pinned,
          targets: [f.sourceId],
        });
        expect(rows[0].item_count).toBe(kind === 'journal' ? 2 : 1);
        expect(
          String(rows[0].amount).includes('.')
            ? String(rows[0].amount).replace(/0+$/, '').replace(/\.$/, '')
            : String(rows[0].amount),
        ).toBe(kind === 'journal' ? '123.45' : '0');
        expect(rows[0].currency).toBe('CAD');
        expect(rows[0].delivery_revision).toBe(1);
        if (kind === 'journal')
          expect(rows[0].intent.journalReview).toEqual({
            itemCount: 2,
            currency: 'CAD',
            amount: '123.45',
          });
        expect(
          (
            await sql(
              'select count(*)::int as n from emdo.finance_journals where book_id=$1',
              [f.bookId],
            )
          ).rows[0].n,
        ).toBe(0);
      },
    );
    it.each(['journal', 'extraction'] as const)(
      'blocks changed pinned %s source at creation and between claim and commit without consuming cursor',
      async (kind) => {
        const f = await pinnedFixture(kind);
        await schedules.createSchedule(f.context, f.bookId, f.id, f.definition);
        const claim = await ownClaim(f.id);
        const before = (await schedules.getSchedule(f.context, f.bookId, f.id))!
          .cursor;
        await revisePinnedSource(f);
        await expect(
          schedules.createSchedule(
            f.context,
            f.bookId,
            randomUUID(),
            f.definition,
          ),
        ).rejects.toThrow();
        const result = await due.planAndCommit(claim);
        expect(result.status).toBe('denied');
        expect(result.reason).toMatch(/source|revision|journal|extraction/);
        const saved = (await schedules.getSchedule(f.context, f.bookId, f.id))!;
        expect(saved.cursor).toEqual(before);
        expect(saved.blockedReason).toBe(result.reason);
        expect(await persistedPlanCount(f.id)).toBe(0);
      },
    );
    it.each(['journal', 'extraction'] as const)(
      'rechecks revoked %s schedule grant after claim',
      async (kind) => {
        const f = await pinnedFixture(kind);
        await schedules.createSchedule(f.context, f.bookId, f.id, f.definition);
        const claim = await ownClaim(f.id);
        const before = (await schedules.getSchedule(f.context, f.bookId, f.id))!
          .cursor;
        await grants.revokeGrant(f.context, f.bookId, f.grant.id);
        expect(await due.planAndCommit(claim)).toMatchObject({
          status: 'denied',
          reason: 'grant-revoked',
        });
        expect(
          (await schedules.getSchedule(f.context, f.bookId, f.id))!.cursor,
        ).toEqual(before);
        expect(await persistedPlanCount(f.id)).toBe(0);
      },
    );
    it('blocks a pinned journal schedule after its reviewed import is manually committed', async () => {
      const f = await pinnedFixture('journal');
      await schedules.createSchedule(f.context, f.bookId, f.id, f.definition);
      const claim = await ownClaim(f.id);
      const before = (await schedules.getSchedule(f.context, f.bookId, f.id))!
        .cursor;
      await sourceFinance.commitNormalizedImport(
        f.context,
        f.bookId,
        f.sourceId,
        randomUUID(),
        { expectedRevision: 2 },
      );
      const result = await due.planAndCommit(claim);
      expect(result.status).toBe('denied');
      expect(result.reason).toMatch(/source|journal/);
      const saved = (await schedules.getSchedule(f.context, f.bookId, f.id))!;
      expect(saved.cursor).toEqual(before);
      expect(saved.blockedReason).toBe(result.reason);
      expect(await persistedPlanCount(f.id)).toBe(0);
      expect(
        (
          await sql(
            'select count(*)::int as n from emdo.finance_journals where book_id=$1',
            [f.bookId],
          )
        ).rows[0].n,
      ).toBe(1);
    });

    it('allows a distinct later journal occurrence for unchanged source and never posts it', async () => {
      const f = await pinnedFixture('journal');
      await schedules.createSchedule(f.context, f.bookId, f.id, f.definition);
      const firstClaim = await ownClaim(f.id);
      const first = await due.planAndCommit(firstClaim);
      const execute = async (operationId: string) => {
        const claim = await worker.claim(operationId);
        expect(claim.status).toBe('claimed');
        if (claim.status !== 'claimed')
          throw new Error('Expected worker claim');
        const args = {
          operationId,
          expectedRevision: claim.run.revision,
          leaseToken: claim.leaseToken,
        };
        const result = await journalGenerator.generateJournalDraft(args);
        expect(await journalGenerator.generateJournalDraft(args)).toEqual(
          result,
        );
        return result;
      };
      const firstDraft = await execute(String(first.operationId));
      // Advance only the private fixture planner clock, with the same leased CAS
      // checked by the real scheduler commit. No source or authority fact changes.
      await sql(
        'update emdo.finance_schedules set next_poll_at=now(),next_due_at=now() where id=$1',
        [f.id],
      );
      const nextClaim = await ownClaim(f.id);
      const advanced = (
        await sql(
          "update emdo.finance_schedules set planned_at=date_trunc('milliseconds',now()+interval '2 minutes') where id=$1 returning emdo.finance_schedule_iso(planned_at) as at",
          [f.id],
        )
      ).rows[0].at;
      nextClaim.input.now = advanced;
      const second = await due.planAndCommit(nextClaim);
      expect(second.status).toBe('due');
      expect(second.operationId).not.toBe(first.operationId);
      const secondDraft = await execute(String(second.operationId));
      expect(secondDraft.resultId).not.toBe(firstDraft.resultId);
      const a = await journalDrafts.readJournalDraftResult(
        f.context,
        f.bookId,
        firstDraft.resultId,
      );
      const b = await journalDrafts.readJournalDraftResult(
        f.context,
        f.bookId,
        secondDraft.resultId,
      );
      expect(a?.status).toBe('review_required');
      expect(b?.status).toBe('review_required');
      expect(b?.source).toEqual(a?.source);
      expect(await persistedPlanCount(f.id)).toBe(2);
      expect(
        (
          await sql(
            'select count(*)::int as n from emdo.finance_journals where book_id=$1',
            [f.bookId],
          )
        ).rows[0].n,
      ).toBe(0);
    });

    it('atomically creates canonical run, controller lineage and delivery; unknown commit replay is a duplicate', async () => {
      const f = await fixture();
      expect(await due.checkReady()).toBe(true);
      expect(await schedules.checkReady()).toBe(true);
      const claim = await ownClaim(f.id),
        plan = planFinanceAutomationDue(claim.input);
      const result = await due.commit(claim, plan);
      expect(result.status).toBe('due');
      expect(result.operationId).toEqual(expect.any(String));
      expect(await due.commit(claim, plan)).toMatchObject({
        status: 'duplicate',
        operationId: result.operationId,
        plan,
      });
      const stored = (
        await sql(
          'select p.lineage,p.plan,r.intent,r.reserved,d.delivery_revision from emdo.finance_schedule_plans p join emdo.finance_automation_runs r on r.id=p.operation_id join emdo.finance_deliveries d on d.operation_id=r.id where p.schedule_id=$1',
          [f.id],
        )
      ).rows;
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        lineage: {
          controller: 'emdo',
          runKind: 'deterministic-finance-automation',
          triggerKind: 'schedule',
          grantIssuerUserId: f.context.userId,
          grantRevision: f.grant.revision,
        },
        reserved: false,
        delivery_revision: 1,
      });
      expect(stored[0]!.intent).not.toHaveProperty('sessionId');
      expect(
        (await schedules.getSchedule(f.context, f.bookId, f.id))!.cursor
          .nextOrdinal,
      ).toBeGreaterThan(0);
      const claimed = await worker.claim(String(result.operationId));
      expect(claimed.status).toBe('claimed');
    });
    it('protects every mutation with current owner/grant scope and keeps fixed scheduler away from tables/management', async () => {
      const f = await fixture();
      const foreign = await fixture();
      await expect(
        schedules.getSchedule(foreign.context, f.bookId, f.id),
      ).rejects.toThrow();
      await expect(
        schedules.createSchedule(f.context, f.bookId, randomUUID(), {
          ...f.definition,
          grantId: foreign.grant.id,
        }),
      ).rejects.toThrow();
      const c = await rolePool('emdo_finance_scheduler').connect();
      try {
        await expect(
          c.query('select * from emdo.finance_schedules'),
        ).rejects.toThrow();
        await expect(
          c.query(
            'select emdo.create_finance_schedule($1,$2,$3,$4::jsonb,$5)',
            [
              f.context.workspaceId,
              f.bookId,
              randomUUID(),
              JSON.stringify(f.definition),
              timezoneVersion,
            ],
          ),
        ).rejects.toThrow();
      } finally {
        c.release();
      }
      const app = await rolePool('emdo_app').connect();
      try {
        await expect(
          app.query('select emdo.claim_finance_schedules(1,$1)', [
            timezoneVersion,
          ]),
        ).rejects.toThrow();
      } finally {
        app.release();
      }
    });
    it('serializes racing schedulers and rechecks pause/revoke between claim and commit', async () => {
      const f = await fixture();
      const claims = (await Promise.all([due.claimDue(20), due.claimDue(20)]))
        .flat()
        .filter((c) => c.input.schedule.id === f.id);
      expect(claims).toHaveLength(1);
      const paused = await schedules.setScheduleState(
        f.context,
        f.bookId,
        f.id,
        { expectedStateRevision: 1, status: 'paused' },
      );
      expect(paused.schedule.stateRevision).toBe(2);
      expect(await due.planAndCommit(claims[0]!)).toMatchObject({
        status: 'stale',
      });
      await schedules.setScheduleState(f.context, f.bookId, f.id, {
        expectedStateRevision: 2,
        status: 'active',
      });
      const claim = await ownClaim(f.id);
      await grants.revokeGrant(f.context, f.bookId, f.grant.id);
      expect(await due.planAndCommit(claim)).toMatchObject({
        status: 'denied',
        reason: 'grant-revoked',
      });
      expect(
        (
          await sql(
            'select count(*)::int as n from emdo.finance_schedule_plans where schedule_id=$1',
            [f.id],
          )
        ).rows[0]!.n,
      ).toBe(0);
    });
    it('rejects forged calendar/cursor facts and enforces current capability readiness at commit', async () => {
      const f = await fixture();
      const claim = await ownClaim(f.id);
      const forged = structuredClone(planFinanceAutomationDue(claim.input));
      if (forged.status === 'invalid') throw new Error();
      forged.nextCursor.nextOrdinal++;
      expect(await due.commit(claim, forged)).toMatchObject({
        status: 'denied',
        reason: 'planner-parity-or-state-conflict',
      });
      const g = await fixture();
      const next = await ownClaim(g.id);
      await sql(
        "update emdo.finance_automation_capabilities set ready=false where capability='finance.reports.generate'",
      );
      try {
        expect(await due.planAndCommit(next)).toMatchObject({
          status: 'denied',
          reason: 'capability-not-ready',
        });
      } finally {
        await sql(
          "update emdo.finance_automation_capabilities set ready=true where capability='finance.reports.generate'",
        );
      }
    });
    it('defers unknown-effect work without consuming another occurrence', async () => {
      const f = await fixture();
      const first = await due.planAndCommit(await ownClaim(f.id));
      const execution = await worker.claim(String(first.operationId));
      expect(execution.status).toBe('claimed');
      if (execution.status !== 'claimed') throw new Error('claim required');
      await worker.settle({
        operationId: String(first.operationId),
        expectedRevision: execution.run.revision,
        leaseToken: execution.leaseToken,
        result: 'indeterminate',
      });
      // Advance only the private fixture due clock/cursor, not a worker authority fact.
      await sql(
        "update emdo.finance_schedules set next_ordinal=0,next_due_at=now()-interval '1 minute',next_poll_at=now() where id=$1",
        [f.id],
      );
      const claim = await ownClaim(f.id);
      expect(claim.input.blockingRunCount).toBe(1);
      expect(await due.planAndCommit(claim)).toMatchObject({
        status: 'deferred',
      });
      expect(
        (await schedules.getSchedule(f.context, f.bookId, f.id))!.cursor
          .nextOrdinal,
      ).toBe(0);
    });
    it('executes a real local-calendar occurrence with stable replay and timezone rule pinning', async () => {
      const f = await fixture();
      await schedules.setScheduleState(f.context, f.bookId, f.id, {
        expectedStateRevision: 1,
        status: 'retired',
      });
      const dateParts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Toronto',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(new Date());
      const date = ['year', 'month', 'day']
        .map((type) => dateParts.find((p) => p.type === type)!.value)
        .join('-');
      const id = randomUUID(),
        definition = {
          ...f.definition,
          startAt: new Date(Date.now() - 86400000).toISOString(),
          cadence: {
            kind: 'daily',
            anchorDate: date,
            everyDays: 1,
            timeZone: 'America/Toronto',
            localTime: '00:00:00',
            gapPolicy: 'skip',
            overlapPolicy: 'later',
            tzdbVersion: timezoneVersion,
          },
        };
      await schedules.createSchedule(f.context, f.bookId, id, definition);
      const changed = new PostgresFinanceScheduleDueRepository(
        rolePool('emdo_finance_scheduler'),
        'different-tzdb',
      );
      expect(
        (await changed.claimDue(20)).some((c) => c.input.schedule.id === id),
      ).toBe(false);
      await sql(
        'update emdo.finance_schedules set next_poll_at=now() where id=$1',
        [id],
      );
      const claim = await ownClaim(id),
        result = await due.planAndCommit(claim);
      expect(result.status).toBe('due');
      expect(await due.planAndCommit(claim)).toMatchObject({
        status: 'duplicate',
        operationId: result.operationId,
      });
    });
    it('verifies SQL/Luxon parity for DST gaps/overlaps, short months, leap days and interval boundaries', async () => {
      const id = randomUUID(),
        base = {
          timeZone: 'America/Toronto',
          localTime: '02:30:00',
          gapPolicy: 'skip',
          overlapPolicy: 'earlier',
          tzdbVersion: timezoneVersion,
        };
      const cases: [unknown, string][] = [
        [
          { kind: 'daily', anchorDate: '2026-03-08', everyDays: 1, ...base },
          '2026-03-08T07:30:00Z',
        ],
        [
          {
            kind: 'daily',
            anchorDate: '2026-03-08',
            everyDays: 1,
            ...base,
            gapPolicy: 'shift-forward',
          },
          '2026-03-08T07:30:00Z',
        ],
        ...['earlier', 'later'].map(
          (overlapPolicy) =>
            [
              {
                kind: 'daily',
                anchorDate: '2026-11-01',
                everyDays: 1,
                ...base,
                localTime: '01:30:00',
                overlapPolicy,
              },
              '2026-11-01T06:30:00Z',
            ] as [unknown, string],
        ),
        ...['skip', 'last-day'].map(
          (shortMonthPolicy) =>
            [
              {
                kind: 'monthly',
                anchorMonth: '2026-01',
                dayOfMonth: 31,
                everyMonths: 1,
                ...base,
                shortMonthPolicy,
                localTime: '09:00:00',
              },
              '2028-02-29T14:00:00Z',
            ] as [unknown, string],
        ),
        [
          {
            kind: 'weekly',
            anchorDate: '2026-03-02',
            weekday: 1,
            everyWeeks: 1,
            ...base,
            localTime: '09:00:00',
          },
          '2026-03-09T13:00:00Z',
        ],
        [
          {
            kind: 'daily',
            anchorDate: '2026-10-04',
            everyDays: 1,
            ...base,
            timeZone: 'Australia/Lord_Howe',
            localTime: '02:15:00',
            gapPolicy: 'shift-forward',
          },
          '2026-10-03T15:45:00Z',
        ],
        [
          {
            kind: 'daily',
            anchorDate: '2026-01-01',
            everyDays: 1,
            ...base,
            timeZone: 'Europe/London',
            localTime: '09:00:00',
          },
          '2026-01-01T09:00:00Z',
        ],
        [
          {
            kind: 'interval',
            everySeconds: 60,
            timeZone: 'UTC',
            clock: 'elapsed-utc',
          },
          '2036-01-01T00:00:00Z',
        ],
      ];
      for (const [cadence, now] of cases) {
        const schedule = FinanceAutomationScheduleSchema.parse({
          id,
          definitionRevision: 1,
          stateRevision: 1,
          status: 'active',
          definition: {
            workspaceId: id,
            bookId: id,
            grantId: id,
            grantRevision: 1,
            capability: 'finance.reports.generate',
            targets: [id],
            money: { currency: 'CAD', amount: '0' },
            startAt: '2026-01-01T00:00:00Z',
            endAt: null,
            cadence,
            misfire: { policy: 'coalesce-latest', maxLatenessSeconds: 86400 },
            concurrency: { policy: 'forbid', onBusy: 'defer' },
          },
        });
        const input = {
          schedule,
          cursor: { scheduleId: id, definitionRevision: 1, nextOrdinal: 0 },
          now,
          blockingRunCount: 0,
          runtimeTimezoneVersion: timezoneVersion,
        };
        const row = {
          id,
          definition: schedule.definition,
          definition_revision: 1,
          state_revision: 1,
          status: 'active',
          next_ordinal: 0,
        };
        const actual = (
          await sql(
            'select emdo.finance_schedule_plan(jsonb_populate_record(null::emdo.finance_schedules,$1::jsonb),$2::timestamptz,0,$3) as plan',
            [JSON.stringify(row), now, timezoneVersion],
          )
        ).rows[0]!.plan;
        expect(actual).toEqual(planFinanceAutomationDue(input));
      }
    });
  },
);

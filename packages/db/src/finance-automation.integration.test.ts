import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgresFinanceV2Repository } from './finance-v2-repository.js';
import {
  PostgresFinanceAutomationRepository,
  PostgresFinanceAutomationExecutionRepository,
} from './finance-automation-repository.js';

const url = process.env.FINANCE_AUTOMATION_TEST_DATABASE_URL;
describe.skipIf(!url)(
  'Durable Finance automation restricted PostgreSQL',
  () => {
    const admin = new pg.Pool({ connectionString: url });
    const rolePool = (role: string) => ({
      async connect() {
        const client = await admin.connect();
        await client.query(`set role ${role}`);
        return client;
      },
    });
    const management = new PostgresFinanceAutomationRepository(
      rolePool('emdo_app'),
    );
    const worker = new PostgresFinanceAutomationExecutionRepository(
      rolePool('emdo_worker'),
    );
    const finance = new PostgresFinanceV2Repository(rolePool('emdo_app'));
    async function sql(query: string, values: unknown[] = []) {
      const client = await admin.connect();
      try {
        await client.query('reset role');
        return await client.query(query, values);
      } finally {
        client.release();
      }
    }
    afterAll(() => admin.end());
    async function fixture() {
      const userId = randomUUID(),
        workspaceId = randomUUID(),
        sessionId = randomUUID();
      await sql(
        "insert into emdo.auth_users(id,name,email,email_verified) values($1,'Automation test',$2,true)",
        [userId, `${userId}@example.test`],
      );
      await sql(
        "insert into emdo.households(id,name,created_by_user_id,slug) values($1::uuid,'Automation test',$2,$1::text)",
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
      const book = await finance.createBook(context, randomUUID(), {
        name: 'Automation test',
        entityName: 'Example',
        entityKind: 'corporation',
        country: 'CA',
        functionalCurrency: 'CAD',
      });
      await sql(
        "insert into emdo.workspace_entitlements(workspace_id,capability,enabled) values($1,'finance.automations.run',true)",
        [workspaceId],
      );
      // Synthetic readiness only in this disposable DB; production migration is disabled.
      await sql(
        "update emdo.finance_automation_capabilities set ready=true where capability='finance.reports.generate'",
      );
      const bookId = String(book.id);
      const input = {
        capabilities: ['finance.reports.generate'],
        limits: {
          maxRuns: 1,
          maxAttemptsPerRun: 2,
          maxItemsPerRun: 2,
          maxTotalItems: 2,
          currency: 'CAD',
          maxAmountPerRun: '0.30',
          maxTotalAmount: '0.30',
        },
        validFrom: new Date(Date.now() - 60000).toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      };
      const grant = await management.createGrant(context, bookId, input);
      const request = {
        operationId: randomUUID(),
        grantId: grant.id,
        capability: 'finance.reports.generate',
        targets: [randomUUID()],
        currency: 'CAD',
        amount: '0.30',
      };
      return { context, bookId, input, grant, request };
    }
    it('reads bounded scoped run history without leases and preserves access after entitlement removal', async () => {
      const f = await fixture();
      const first = await management.enqueueRun(f.context, f.bookId, f.request);
      const second = await management.enqueueRun(f.context, f.bookId, {
        ...f.request,
        operationId: randomUUID(),
      });
      const page = await management.listRuns(f.context, f.bookId, 0, 1);
      expect(page.nextOffset).toBe(1);
      expect(page.runs).toHaveLength(1);
      expect(page.runs[0]!.run.request.amount).toBe('0.300000000000');
      const next = await management.listRuns(f.context, f.bookId, 1, 1);
      expect(next.nextOffset).toBeNull();
      expect(
        new Set(
          [...page.runs, ...next.runs].map((r) => r.run.request.operationId),
        ),
      ).toEqual(
        new Set([first.request.operationId, second.request.operationId]),
      );
      const claim = await worker.claim(first.request.operationId);
      expect(claim.status).toBe('claimed');
      const saved = await management.getRun(
        f.context,
        f.bookId,
        first.request.operationId,
      );
      expect(saved?.run.status).toBe('executing');
      expect(JSON.stringify(saved)).not.toContain('lease');
      if (claim.status === 'claimed')
        expect(JSON.stringify(saved)).not.toContain(claim.leaseToken);
      expect(
        await management.getRun(f.context, f.bookId, randomUUID()),
      ).toBeNull();
      const other = await fixture();
      expect(
        await management.getRun(
          other.context,
          other.bookId,
          first.request.operationId,
        ),
      ).toBeNull();
      await expect(
        management.getRun(other.context, f.bookId, first.request.operationId),
      ).rejects.toThrow();
      await sql(
        "update emdo.workspace_entitlements set enabled=false where workspace_id=$1 and capability='finance.automations.run'",
        [f.context.workspaceId],
      );
      expect(
        (
          await management.getRun(
            f.context,
            f.bookId,
            first.request.operationId,
          )
        )?.run.status,
      ).toBe('executing');
      await sql(
        "update emdo.finance_book_grants set role='viewer' where workspace_id=$1 and book_id=$2",
        [f.context.workspaceId, f.bookId],
      );
      await expect(management.listRuns(f.context, f.bookId)).rejects.toThrow(
        'automation-admin-required',
      );
      await expect(
        management.getRun(f.context, f.bookId, first.request.operationId),
      ).rejects.toThrow('automation-admin-required');
    });
    it('has FORCE RLS and no direct runtime writes or capability enabling', async () => {
      const policies = await sql(
        "select relrowsecurity,relforcerowsecurity from pg_class where relname in ('finance_automation_grants','finance_automation_runs')",
      );
      expect(policies.rows).toHaveLength(2);
      for (const row of policies.rows)
        expect(row).toEqual({
          relrowsecurity: true,
          relforcerowsecurity: true,
        });
      for (const role of [
        'emdo_app',
        'emdo_worker',
        'emdo_finance_automation_executor',
      ]) {
        const result = await sql(
          'select rolsuper,rolbypassrls from pg_roles where rolname=$1',
          [role],
        );
        expect(result.rows[0]).toEqual({
          rolsuper: false,
          rolbypassrls: false,
        });
      }
      const client = await rolePool('emdo_worker').connect();
      try {
        await expect(
          client.query('select * from emdo.finance_automation_grants'),
        ).rejects.toThrow('permission denied');
        await expect(
          client.query(
            'update emdo.finance_automation_capabilities set ready=true',
          ),
        ).rejects.toThrow('permission denied');
      } finally {
        client.release();
      }
    });
    it('replays exact grant creation after current permission checks and rejects changed intent', async () => {
      const f = await fixture();
      expect(await management.checkReady()).toBe(true);
      expect(
        await management.createGrant(f.context, f.bookId, {
          ...f.input,
          id: f.grant.id,
        }),
      ).toEqual(f.grant);
      await expect(
        management.createGrant(f.context, f.bookId, {
          ...f.input,
          id: f.grant.id,
          limits: { ...f.input.limits, maxRuns: 2 },
        }),
      ).rejects.toThrow('idempotency-conflict');
      await management.revokeGrant(f.context, f.bookId, f.grant.id);
      expect(
        (
          await management.createGrant(f.context, f.bookId, {
            ...f.input,
            id: f.grant.id,
          })
        ).status,
      ).toBe('revoked');
      await sql(
        "update emdo.finance_book_grants set role='viewer' where workspace_id=$1 and book_id=$2",
        [f.context.workspaceId, f.bookId],
      );
      await expect(
        management.createGrant(f.context, f.bookId, {
          ...f.input,
          id: f.grant.id,
        }),
      ).rejects.toThrow();
    });
    it('creates admin grants and rejects unsupported/unready leaves and nonadmins', async () => {
      const f = await fixture();
      await expect(
        management.createGrant(f.context, f.bookId, {
          ...f.input,
          capabilities: ['finance.documents.extract'],
        }),
      ).rejects.toThrow('not-ready');
      await sql(
        "update emdo.finance_book_grants set role='preparer' where workspace_id=$1 and book_id=$2",
        [f.context.workspaceId, f.bookId],
      );
      await expect(
        management.revokeGrant(f.context, f.bookId, f.grant.id),
      ).rejects.toThrow('admin-required');
    });
    it('canonicalizes intent and enforces idempotency before claiming', async () => {
      const f = await fixture();
      const first = await management.enqueueRun(f.context, f.bookId, f.request);
      expect(
        await management.enqueueRun(f.context, f.bookId, {
          ...f.request,
          amount: '0.300',
        }),
      ).toEqual(first);
      await expect(
        management.enqueueRun(f.context, f.bookId, {
          ...f.request,
          amount: '0.20',
        }),
      ).rejects.toThrow('idempotency-conflict');
    });
    it('executes a durable grant after the management browser session expires', async () => {
      const f = await fixture();
      await management.enqueueRun(f.context, f.bookId, f.request);
      await sql(
        "update emdo.auth_sessions set expires_at=now()-interval '1 second' where id=$1",
        [f.context.sessionId],
      );
      await expect(
        management.listGrants(f.context, f.bookId),
      ).rejects.toThrow();
      expect((await worker.claim(f.request.operationId)).status).toBe(
        'claimed',
      );
    });
    it.each(['revocation', 'membership', 'book-role', 'entitlement', 'epoch'])(
      'blocks stale queued %s authority',
      async (change) => {
        const f = await fixture();
        await management.enqueueRun(f.context, f.bookId, f.request);
        if (change === 'revocation')
          await management.revokeGrant(f.context, f.bookId, f.grant.id);
        if (change === 'membership')
          await sql(
            "update emdo.household_memberships set status='inactive',ended_at=now() where household_id=$1 and user_id=$2",
            [f.context.workspaceId, f.context.userId],
          );
        if (change === 'book-role')
          await sql(
            "update emdo.finance_book_grants set role='viewer' where workspace_id=$1 and book_id=$2",
            [f.context.workspaceId, f.bookId],
          );
        if (change === 'entitlement')
          await sql(
            "update emdo.workspace_entitlements set enabled=false where workspace_id=$1 and capability='finance.automations.run'",
            [f.context.workspaceId],
          );
        if (change === 'epoch')
          await sql(
            "update emdo.workspace_entitlements set enabled=true where workspace_id=$1 and capability='finance.automations.run'",
            [f.context.workspaceId],
          );
        expect((await worker.claim(f.request.operationId)).status).toBe(
          'denied',
        );
        expect(
          (
            await sql(
              'select status from emdo.finance_automation_runs where id=$1',
              [f.request.operationId],
            )
          ).rows[0]?.status,
        ).toBe('blocked');
      },
    );
    it('preserves large exact money and rejects cross-book intent', async () => {
      const f = await fixture();
      const input = {
        ...f.input,
        limits: {
          ...f.input.limits,
          maxAmountPerRun: '9007199254740993.01',
          maxTotalAmount: '9007199254740993.01',
        },
      };
      const grant = await management.createGrant(f.context, f.bookId, input);
      const request = {
        ...f.request,
        grantId: grant.id,
        amount: '9007199254740993.01',
      };
      const run = await management.enqueueRun(f.context, f.bookId, request);
      expect(run.request.amount).toBe('9007199254740993.010000000000');
      const claim = await worker.claim(request.operationId);
      if (claim.status !== 'claimed') throw Error('Missing claim');
      expect(claim.intent.amount).toBe('9007199254740993.01');
      expect(claim.run.request.amount).toBe(run.request.amount);
      const other = await fixture();
      await expect(
        management.enqueueRun(other.context, other.bookId, {
          ...request,
          operationId: randomUUID(),
        }),
      ).rejects.toThrow('grant-not-found');
    });
    it('honors expiry and workspace entitlement limits at claim time', async () => {
      const f = await fixture();
      await management.enqueueRun(f.context, f.bookId, f.request);
      await sql(
        "update emdo.finance_automation_grants set expires_at=now()-interval '1 second' where id=$1",
        [f.grant.id],
      );
      expect(await worker.claim(f.request.operationId)).toEqual({
        status: 'denied',
        reason: 'grant-expired',
      });
      const other = await fixture();
      await sql(
        'update emdo.workspace_entitlements set "limit"=0 where workspace_id=$1 and capability=\'finance.automations.run\'',
        [other.context.workspaceId],
      );
      const grant = await management.createGrant(
        other.context,
        other.bookId,
        other.input,
      );
      const request = { ...other.request, grantId: grant.id };
      await management.enqueueRun(other.context, other.bookId, request);
      expect(await worker.claim(request.operationId)).toEqual({
        status: 'denied',
        reason: 'entitlement-limit-exceeded',
      });
    });
    it('rejects stale and future deliveries before consuming retry attempts', async () => {
      const f = await fixture();
      await management.enqueueRun(f.context, f.bookId, f.request);
      expect(await worker.claimDelivery(f.request.operationId, 2)).toEqual({
        status: 'denied',
        reason: 'delivery-revision-conflict',
      });
      const first = await worker.claimDelivery(f.request.operationId, 1);
      if (first.status !== 'claimed') throw Error('Missing first delivery');
      const retryable = await worker.settle({
        operationId: f.request.operationId,
        expectedRevision: first.run.revision,
        leaseToken: first.leaseToken,
        result: 'not-applied',
      });
      expect(retryable.revision).toBe(3);
      expect(await worker.claimDelivery(f.request.operationId, 1)).toEqual({
        status: 'denied',
        reason: 'delivery-revision-conflict',
      });
      expect(
        (
          await sql(
            'select attempts,revision from emdo.finance_automation_runs where id=$1',
            [f.request.operationId],
          )
        ).rows[0],
      ).toEqual({ attempts: 1, revision: 3 });
      const retry = await worker.claimDelivery(f.request.operationId, 3);
      if (retry.status !== 'claimed') throw Error('Missing retry delivery');
      expect(retry.run.attempts).toBe(2);
      expect(retry.run.revision).toBe(4);
    });
    it('serializes concurrent reservations and preserves one canonical outcome', async () => {
      const f = await fixture();
      await management.enqueueRun(f.context, f.bookId, f.request);
      const second = { ...f.request, operationId: randomUUID() };
      await management.enqueueRun(f.context, f.bookId, second);
      const results = await Promise.all([
        worker.claim(f.request.operationId),
        worker.claim(second.operationId),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([
        'claimed',
        'denied',
      ]);
      const claimed = results.find((r) => r.status === 'claimed');
      if (!claimed || claimed.status !== 'claimed')
        throw Error('Missing claim');
      const outcome = randomUUID();
      const settlement = {
        operationId: claimed.run.request.operationId,
        expectedRevision: claimed.run.revision,
        leaseToken: claimed.leaseToken,
        result: 'applied' as const,
        outcomeReference: outcome,
      };
      await expect(
        worker.settle({ ...settlement, leaseToken: randomUUID() }),
      ).rejects.toThrow('lease-conflict');
      const done = await worker.settle(settlement);
      expect(await worker.settle(settlement)).toEqual(done);
      expect(await worker.claim(settlement.operationId)).toEqual({
        status: 'duplicate',
        outcomeReference: outcome,
      });
    });
    it('rechecks revoked authority on retry and never replays expired lease effects', async () => {
      const f = await fixture();
      await management.enqueueRun(f.context, f.bookId, f.request);
      const claim = await worker.claim(f.request.operationId);
      if (claim.status !== 'claimed') throw Error('Missing claim');
      await worker.settle({
        operationId: f.request.operationId,
        expectedRevision: claim.run.revision,
        leaseToken: claim.leaseToken,
        result: 'not-applied',
      });
      await management.revokeGrant(f.context, f.bookId, f.grant.id);
      expect(await worker.claim(f.request.operationId)).toEqual({
        status: 'denied',
        reason: 'grant-revoked',
      });
      const other = await fixture();
      await management.enqueueRun(other.context, other.bookId, other.request);
      expect((await worker.claim(other.request.operationId)).status).toBe(
        'claimed',
      );
      await sql(
        "update emdo.finance_automation_runs set lease_expires_at=now()-interval '1 second' where id=$1",
        [other.request.operationId],
      );
      expect(await worker.claim(other.request.operationId)).toEqual({
        status: 'denied',
        reason: 'run-not-runnable',
      });
      expect(
        (
          await sql(
            'select status from emdo.finance_automation_runs where id=$1',
            [other.request.operationId],
          )
        ).rows[0]?.status,
      ).toBe('requires-reconciliation');
    });
  },
);

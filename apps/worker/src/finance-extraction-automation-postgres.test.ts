import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import {
  PostgresFinanceV2Repository,
  PostgresFinanceAutomationRepository,
  PostgresFinanceStandardizationRepository,
} from '@emdo/db/api';
import {
  PostgresFinanceAutomationExecutionRepository,
  PostgresFinanceExtractionExecutionRepository,
  PostgresFinanceStandardizationExecutionRepository,
} from '@emdo/db/worker';
import {
  FinanceBookEvidenceCrypto,
  EncryptedFinanceBookEvidenceSchema,
} from '@emdo/integrations/finance-documents';
import { InMemoryVaultKeyProvider } from '../../../packages/integrations/src/vault/crypto.js';
import { createFinanceExtractionLeaf } from './finance-extraction-leaf.js';
import { createFinanceAutomationDispatcher } from './finance-automation-worker.js';
const url = process.env.FINANCE_V2_TEST_DATABASE_URL;
describe.skipIf(!url)(
  'grant-bound deterministic extraction in restricted PostgreSQL',
  () => {
    const admin = new pg.Pool({ connectionString: url });
    let worker: pg.Pool | undefined;
    afterAll(async () => {
      await worker?.end();
      await admin.end();
    });
    const sql = async (text: string, values: unknown[] = []) => {
      const c = await admin.connect();
      try {
        await c.query('reset role');
        return await c.query(text, values);
      } finally {
        c.release();
      }
    };
    it('prepares inert work, enforces grant/source CAS, saves one immutable extraction and replays without browser/provider authority', async () => {
      const context = {
        workspaceId: randomUUID(),
        userId: randomUUID(),
        sessionId: randomUUID(),
        requestId: randomUUID(),
      };
      await sql(
        "insert into emdo.auth_users(id,name,email,email_verified)values($1,'Extract',$2,true)",
        [context.userId, `${context.userId}@example.test`],
      );
      await sql(
        "insert into emdo.households(id,name,slug,created_by_user_id)values($1,'Extract',$2,$3)",
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
      const app = {
        async connect() {
          const c = await admin.connect();
          await c.query('set role emdo_app');
          return c;
        },
      };
      const cipher = new FinanceBookEvidenceCrypto(
        new InMemoryVaultKeyProvider(
          new Uint8Array(32).fill(12),
          'finance-documents.v1',
        ),
      );
      const decrypt = (
        encrypted: unknown,
        scope: { workspaceId: string; bookId: string; documentId: string },
      ) =>
        cipher.decrypt(
          EncryptedFinanceBookEvidenceSchema.parse(encrypted),
          scope,
        );
      const repo = new PostgresFinanceV2Repository(app, {
          evidenceCipher: { encrypt: (v, s) => cipher.encrypt(v, s), decrypt },
        }),
        management = new PostgresFinanceAutomationRepository(app),
        standardizations = new PostgresFinanceStandardizationRepository(app);
      const book = await repo.createBook(context, 'book', {
          name: 'Extract',
          entityName: 'Owner',
          entityKind: 'individual',
          country: 'CA',
          functionalCurrency: 'CAD',
        }),
        bookId = String(book.id);
      const csv =
          'Date,Description,Amount,Currency\n2026-09-01,Deposit,123.45,CAD\n',
        digest = createHash('sha256').update(csv).digest('hex');
      const evidence = await repo.uploadBookEvidence(context, bookId, 'csv', {
        format: 'csv',
        filename: 'statement.csv',
        sourceText: csv,
      });
      const input = {
          evidenceId: String(evidence.id),
          expectedSourceDigest: digest,
        },
        key = randomUUID();
      const intent = await management.prepareExtraction(
        context,
        bookId,
        key,
        input,
      );
      expect(
        await management.prepareExtraction(context, bookId, key, input),
      ).toEqual(intent);
      expect(intent.expectedExtractionRevision).toBe(0);
      const prepared = await standardizations.get(
        context,
        bookId,
        intent.standardizationRunId,
      );
      expect(prepared).toMatchObject({
        executionMode: 'extraction-only',
        status: 'queued',
        proposal: null,
        modelProvenance: null,
      });
      expect(
        (
          await sql(
            'select delivery_pending from emdo.finance_standardization_runs where id=$1',
            [intent.standardizationRunId],
          )
        ).rows[0].delivery_pending,
      ).toBe(false);
      await sql(
        "insert into emdo.workspace_entitlements(workspace_id,capability,enabled)values($1,'finance.automations.run',true)",
        [context.workspaceId],
      );
      await sql(
        "update emdo.finance_automation_capabilities set ready=true where capability='finance.documents.extract'",
      );
      const grant = await management.createGrant(context, bookId, {
        capabilities: ['finance.documents.extract'],
        limits: {
          maxRuns: 4,
          maxAttemptsPerRun: 3,
          maxItemsPerRun: 1,
          maxTotalItems: 4,
          currency: 'CAD',
          maxAmountPerRun: '0',
          maxTotalAmount: '0',
        },
        validFrom: new Date(Date.now() - 60000).toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
      const request = {
        operationId: randomUUID(),
        grantId: grant.id,
        capability: 'finance.documents.extract',
        targets: [input.evidenceId],
        currency: 'CAD',
        amount: '0',
        extraction: intent,
      };
      await expect(
        management.enqueueRun(context, bookId, {
          ...request,
          operationId: randomUUID(),
          extraction: { ...intent, expectedRunRevision: 99 },
        }),
      ).rejects.toThrow();
      const run = await management.enqueueRun(context, bookId, request);
      expect(await management.enqueueRun(context, bookId, request)).toEqual(
        run,
      );
      await sql(
        "do $$begin if not exists(select from pg_roles where rolname='emdo_worker_executor_login')then create role emdo_worker_executor_login login noinherit nosuperuser nobypassrls;end if;end$$",
      );
      await sql('grant emdo_worker_executor to emdo_worker_executor_login');
      const connection = new URL(url!);
      connection.username = 'emdo_worker_executor_login';
      worker = new pg.Pool({ connectionString: connection.toString() });
      const workerPool = {
        async connect() {
          const c = await worker!.connect();
          await c.query('set role emdo_worker_executor');
          return c;
        },
      };
      const sourceStore = new PostgresFinanceExtractionExecutionRepository(
          workerPool,
          decrypt,
        ),
        executions = new PostgresFinanceAutomationExecutionRepository(
          workerPool,
        );
      const normalWorker =
        new PostgresFinanceStandardizationExecutionRepository(
          workerPool,
          decrypt,
        );
      expect(
        await normalWorker.claim(intent.standardizationRunId, 1),
      ).toMatchObject({ status: 'denied' });
      const dispatch = createFinanceAutomationDispatcher({
        executions,
        leaves: [createFinanceExtractionLeaf(sourceStore, {})],
        now: () => new Date().toISOString(),
      });
      const dispatcher = (job: {
        operationId: string;
        deliveryRevision: number;
      }) =>
        dispatch(
          job.operationId,
          job.deliveryRevision,
          new AbortController().signal,
        );
      await sql(
        "update emdo.auth_sessions set expires_at=now()-interval '1 minute' where id=$1",
        [context.sessionId],
      );
      const job = {
        schemaVersion: 1 as const,
        origin: 'emdo-managed' as const,
        operationId: request.operationId,
        deliveryRevision: run.revision,
      };
      const done = await dispatcher(job);
      expect(done).toMatchObject({
        status: 'completed',
        outcomeReference: request.operationId,
      });
      expect(await dispatcher(job)).toMatchObject({
        status: 'duplicate',
        outcomeReference: request.operationId,
      });
      await sql(
        "update emdo.auth_sessions set expires_at=now()+interval '1day' where id=$1",
        [context.sessionId],
      );
      const outcome = await management.readExtractionResult(
        context,
        bookId,
        request.operationId,
      );
      expect(outcome).toMatchObject({
        sourceDigest: digest,
        standardizationRunId: intent.standardizationRunId,
        extractionRevision: 1,
        approval: 'not-granted',
        posting: 'not-performed',
      });
      expect(
        await standardizations.get(
          context,
          bookId,
          intent.standardizationRunId,
        ),
      ).toMatchObject({
        status: 'extracted',
        proposal: null,
        modelProvenance: null,
      });
      expect(
        (
          await sql(
            'select count(*)::int as n from emdo.finance_standardization_spend where run_id=$1',
            [intent.standardizationRunId],
          )
        ).rows[0].n,
      ).toBe(0);
      const reuse = await management.prepareExtraction(
        context,
        bookId,
        randomUUID(),
        input,
      );
      expect(reuse.expectedExtractionRevision).toBe(1);
      const reuseRequest = {
        ...request,
        operationId: randomUUID(),
        extraction: reuse,
      };
      const reuseRun = await management.enqueueRun(
        context,
        bookId,
        reuseRequest,
      );
      expect(
        await dispatcher({
          ...job,
          operationId: reuseRequest.operationId,
          deliveryRevision: reuseRun.revision,
        }),
      ).toMatchObject({ status: 'completed' });
      expect(
        (
          await sql(
            'select count(*)::int as n from emdo.finance_standardization_extractions where run_id=$1',
            [intent.standardizationRunId],
          )
        ).rows[0].n,
      ).toBe(1);
      await expect(
        sql(
          "update emdo.finance_automation_extraction_results set result='{}' where operation_id=$1",
          [request.operationId],
        ),
      ).rejects.toThrow();
      await sourceStore.checkReady();
      const thirdRequest = {
        ...request,
        operationId: randomUUID(),
        extraction: reuse,
      };
      const third = await management.enqueueRun(context, bookId, thirdRequest);
      const claim = await executions.claimDelivery(
        thirdRequest.operationId,
        third.revision,
      );
      if (claim.status !== 'claimed') throw Error('expected third claim');
      const binding = {
        operationId: thirdRequest.operationId,
        expectedRevision: claim.run.revision,
        leaseToken: claim.leaseToken,
      };
      const captured = await sourceStore.read({
        ...binding,
        workspaceId: context.workspaceId,
        bookId,
        extraction: reuse,
      });
      await management.revokeGrant(context, bookId, grant.id);
      await expect(
        sourceStore.save({
          ...binding,
          summary: captured.summary,
          envelope: captured.envelope,
        }),
      ).rejects.toThrow('extraction-not-applied');
      expect(
        (
          await sql(
            'select count(*)::int as n from emdo.finance_automation_extraction_results where operation_id=$1',
            [thirdRequest.operationId],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(await dispatcher(job)).toMatchObject({ status: 'denied' });
      await sql(
        "update emdo.household_memberships set status='inactive',ended_at=now() where household_id=$1 and user_id=$2",
        [context.workspaceId, context.userId],
      );
      await expect(
        management.readExtractionResult(context, bookId, request.operationId),
      ).rejects.toThrow();
    }, 30000);
  },
);

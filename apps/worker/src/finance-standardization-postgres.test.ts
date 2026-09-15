import { z } from 'zod';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, it, expect } from 'vitest';
import {
  PostgresFinanceV2Repository,
  PostgresFinanceStandardizationRepository,
} from '@emdo/db/api';
import {
  PostgresFinanceStandardizationExecutionRepository,
  PostgresFinanceStandardizationDeliveryRepository,
} from '@emdo/db/worker';
import {
  FinanceBookEvidenceCrypto,
  EncryptedFinanceBookEvidenceSchema,
} from '@emdo/integrations/finance-documents';
import { InMemoryVaultKeyProvider } from '../../../packages/integrations/src/vault/crypto.js';
import {
  FinanceStandardizationClaimSchema,
  type WorkspaceContext,
} from '@emdo/contracts';
import { createStandardizationReceiptReconciler } from './finance-standardization-reconciliation.js';
import { extractFinanceStandardizationSource } from './finance-standardization-extraction.js';
import { createFinanceStandardizationWorker } from './finance-standardization-worker.js';
import {
  standardizationCsv,
  standardizationDigest,
  standardizationProposal,
  standardizationProvenance,
} from './finance-standardization.test-fixtures.js';
const url = process.env.FINANCE_V2_TEST_DATABASE_URL;
describe.skipIf(!url)(
  'Durable standardization with actual fixed worker logins',
  () => {
    const admin = new pg.Pool({ connectionString: url });
    const context: WorkspaceContext = {
      workspaceId: randomUUID(),
      userId: randomUUID(),
      sessionId: randomUUID(),
      requestId: randomUUID(),
    };
    const cipher = new FinanceBookEvidenceCrypto(
      new InMemoryVaultKeyProvider(
        new Uint8Array(32).fill(48),
        'finance-documents.v1',
      ),
    );
    const appPool = {
      async connect() {
        const c = await admin.connect();
        await c.query('set role emdo_app');
        return c;
      },
    };
    const evidence = new PostgresFinanceV2Repository(appPool, {
      evidenceCipher: {
        encrypt: (v, s) => cipher.encrypt(v, s),
        decrypt: (v, s) =>
          cipher.decrypt(EncryptedFinanceBookEvidenceSchema.parse(v), s),
      },
    });
    const runs = new PostgresFinanceStandardizationRepository(appPool);
    let workerPool: pg.Pool,
      dispatchPool: pg.Pool,
      store: PostgresFinanceStandardizationExecutionRepository,
      deliveries: PostgresFinanceStandardizationDeliveryRepository,
      bookId: string,
      evidenceId: string;
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
        "insert into emdo.auth_users(id,name,email,email_verified) values($1,'Standardization',$2,true)",
        [context.userId, `${context.userId}@example.test`],
      );
      await sql(
        "insert into emdo.households(id,name,slug,created_by_user_id) values($1,'Standardization',$2,$3)",
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
          await evidence.createBook(context, 'standardization-book', {
            name: 'Saved analysis',
            entityName: 'Owner',
            entityKind: 'individual',
            country: 'CA',
            functionalCurrency: 'CAD',
          })
        ).id,
      );
      await sql(
        "insert into emdo.workspace_entitlements(workspace_id,capability,enabled) values($1,'finance.standardizations.run',true)",
        [context.workspaceId],
      );
      await sql(
        "update emdo.finance_standardization_configuration set ready=true,max_run_cad_minor=1000,max_workspace_day_cad_minor=10000 where id='v1'",
      );
      for (const [login, role] of [
        ['emdo_worker_executor_login', 'emdo_worker_executor'],
        ['emdo_worker_dispatcher_login', 'emdo_worker_dispatch_executor'],
      ] as const) {
        await sql(
          `do $$ begin if not exists(select from pg_roles where rolname='${login}') then create role ${login} login noinherit nosuperuser nobypassrls nocreatedb nocreaterole;end if;end $$;`,
        );
        await sql(`grant ${role} to ${login}`);
        await sql(
          `alter role ${login} login password 'synthetic-standardization-test'`,
        );
      }
      const connection = (user: string) => {
        const value = new URL(url!);
        value.username = user;
        value.password = 'synthetic-standardization-test';
        return value.toString();
      };
      workerPool = new pg.Pool({
        connectionString: connection('emdo_worker_executor_login'),
      });
      dispatchPool = new pg.Pool({
        connectionString: connection('emdo_worker_dispatcher_login'),
      });
      const scoped = (pool: pg.Pool, role: string) => ({
        async connect() {
          const c = await pool.connect();
          await c.query(`set role ${role}`);
          return c;
        },
      });
      store = new PostgresFinanceStandardizationExecutionRepository(
        scoped(workerPool, 'emdo_worker_executor'),
        (v, s) =>
          cipher.decrypt(EncryptedFinanceBookEvidenceSchema.parse(v), s),
      );
      deliveries = new PostgresFinanceStandardizationDeliveryRepository(
        scoped(dispatchPool, 'emdo_worker_dispatch_executor'),
      );
      expect(await runs.checkReady()).toBe(true);
      await store.checkReady();
      await deliveries.checkReady();
      const original = await evidence.uploadBookEvidence(
        context,
        bookId,
        'standardization-original',
        {
          filename: 'statement.csv',
          format: 'csv',
          sourceText: standardizationCsv,
        },
      );
      evidenceId = String(original.id);
      expect(original.sourceDigest).toBe(standardizationDigest);
    });
    beforeEach(async () => {
      await sql(
        "update emdo.auth_sessions set expires_at=now()+interval '1 day' where id=$1",
        [context.sessionId],
      );
    });
    async function deliveryFor(runId: string) {
      for (let page = 0; page < 25; page++) {
        const rows = await deliveries.claim(20);
        const found = rows.find((d) => d.runId === runId);
        if (found) return found;
        if (rows.length === 0) break;
      }
      throw new Error('fixture delivery not found within bounded queue scan');
    }
    afterAll(async () => {
      await workerPool?.end();
      await dispatchPool?.end();
      await admin.end();
    });
    it('deduplicates creation, survives session expiry, reserves lineage and stops at a source-bound candidate', async () => {
      const key = randomUUID(),
        input = { evidenceId, expectedSourceDigest: standardizationDigest };
      const run = await runs.start(context, bookId, key, input);
      expect(await runs.start(context, bookId, key, input)).toEqual(run);
      expect((await runs.start(context, bookId, randomUUID(), input)).id).toBe(
        run.id,
      );
      await sql(
        "update emdo.auth_sessions set expires_at=now()-interval '1 minute' where id=$1",
        [context.sessionId],
      );
      const delivery = await deliveryFor(run.id);
      expect(delivery).toBeTruthy();
      const worker = createFinanceStandardizationWorker({
        store,
        propose: async ({ claim, extraction }, controls) => {
          expect(
            await controls.verifyAuthority(claim, {
              extractionRevision: extraction.revision,
              extractionDigest: extraction.extractionDigest,
            }),
          ).toBe(true);
          expect(
            await controls.verifyAuthority(claim, {
              extractionRevision: extraction.revision,
              extractionDigest: '0'.repeat(64),
            }),
          ).toBe(false);
          const { reservationId } = await controls.reserveModelSpend({
            requestKey: `std:${claim.runId}`,
            inputTokenCeiling: 20000,
            outputTokenCeiling: 4000,
            estimatedCadMinor: 100,
            pricingVersion: 'test-cad.v1',
            pricing: {
              inputCadMinorPerMillionTokens: 1000,
              outputCadMinorPerMillionTokens: 2000,
            },
            lineage: {
              managerInvocationId:
                standardizationProvenance.managerInvocationId,
              financeInvocationId:
                standardizationProvenance.financeInvocationId,
              orchestrationMode: 'registered-workflow',
              promptVersion: 'finance-standardization-proposal.v1',
            },
          });
          await controls.markModelDispatch({ reservationId });
          await controls.settleModelSpend({
            reservationId,
            outcome: 'completed',
            actualCadMinor: 50,
            providerResponseId: standardizationProvenance.providerResponseId,
          });
          return {
            status: 'proposed',
            proposal: standardizationProposal,
            provenance: standardizationProvenance,
          };
        },
      });
      expect(
        await worker({
          schemaVersion: 1,
          runId: run.id,
          deliveryRevision: delivery.deliveryRevision,
        }),
      ).toBe('needs-review');
      await sql(
        "update emdo.auth_sessions set expires_at=now()+interval '1 day' where id=$1",
        [context.sessionId],
      );
      const saved = await runs.get(context, bookId, run.id);
      expect(saved).toMatchObject({
        status: 'needs-review',
        proposal: { mappingId: run.id, status: 'candidate' },
        approval: 'not-granted',
        posting: 'not-performed',
      });
      const mapping = (
        await sql(
          'select status,example from emdo.finance_report_mapping_versions where id=$1',
          [run.id],
        )
      ).rows[0];
      expect(mapping.status).toBe('candidate');
      expect(mapping.example.rows[0].cells[2]).toBe('12.50');
      expect(
        (
          await sql(
            'select lineage from emdo.finance_standardization_spend where run_id=$1',
            [run.id],
          )
        ).rows[0].lineage.financeInvocationId,
      ).toBe(standardizationProvenance.financeInvocationId);
      expect(
        await worker({
          schemaVersion: 1,
          runId: run.id,
          deliveryRevision: delivery.deliveryRevision,
        }),
      ).toBe('duplicate');
      const linked = await runs.linkMapping(
        context,
        bookId,
        run.id,
        randomUUID(),
        { expectedRevision: saved.revision, mappingId: run.id },
      );
      expect(linked.reviewedMapping).toMatchObject({
        mappingId: run.id,
        status: 'candidate',
      });
      await expect(
        runs.linkMapping(context, bookId, run.id, randomUUID(), {
          expectedRevision: saved.revision,
          mappingId: run.id,
        }),
      ).rejects.toThrow('conflict');
    });
    it('reclaims an accepted but unclaimed delivery with a fresh token without allocating spend', async () => {
      const source = standardizationCsv.replace(
          'Payment fee included',
          'Unclaimed delivery retry',
        ),
        uploaded = await evidence.uploadBookEvidence(
          context,
          bookId,
          'unclaimed-delivery-original',
          {
            filename: 'unclaimed.csv',
            format: 'csv',
            sourceText: source,
          },
        ),
        run = await runs.start(context, bookId, randomUUID(), {
          evidenceId: String(uploaded.id),
          expectedSourceDigest: createHash('sha256')
            .update(source)
            .digest('hex'),
        });
      const first = await deliveryFor(run.id);
      expect(first).toBeTruthy();
      expect(
        (
          await sql(
            'select delivery_pending from emdo.finance_standardization_runs where id=$1',
            [run.id],
          )
        ).rows[0].delivery_pending,
      ).toBe(true);
      await sql(
        "update emdo.finance_standardization_runs set delivery_expires_at=now()-interval '1 second' where id=$1",
        [run.id],
      );
      const reclaimed = await deliveryFor(run.id);
      expect(reclaimed).toMatchObject({
        runId: run.id,
        deliveryRevision: first!.deliveryRevision,
      });
      expect(reclaimed!.token).not.toBe(first!.token);
      expect(
        (
          await sql(
            'select count(*)::integer as count from emdo.finance_standardization_spend where run_id=$1',
            [run.id],
          )
        ).rows[0].count,
      ).toBe(0);
    });
    it('denies tampered GUC/direct executor mutation and does not permit approval', async () => {
      const client = await workerPool.connect();
      try {
        await client.query('set role emdo_worker_executor');
        await client.query(
          "select set_config('app.user_id',$1,false),set_config('app.household_id',$2,false)",
          [context.userId, context.workspaceId],
        );
        await expect(
          client.query(
            "update emdo.finance_report_mapping_versions set status='approved'",
          ),
        ).rejects.toThrow();
        await expect(
          client.query(
            'insert into emdo.finance_standardization_runs(id) values(gen_random_uuid())',
          ),
        ).rejects.toThrow();
        await expect(
          client.query('set role emdo_finance_standardization_executor'),
        ).rejects.toThrow();
      } finally {
        client.release();
      }
    });
    it('routes reconciliation writes through the non-login writer and freezes terminal evidence', async () => {
      const acl = (
        await sql(
          `select has_table_privilege('emdo_finance_standardization_executor','emdo.finance_standardization_reconciliations','INSERT') as can_insert,
                  has_table_privilege('emdo_finance_standardization_executor','emdo.finance_standardization_reconciliations','UPDATE') as can_update,
                  has_table_privilege('emdo_finance_standardization_executor','emdo.finance_standardization_reconciliations','DELETE') as can_delete,
                  has_column_privilege('emdo_finance_standardization_reconciler','emdo.finance_standardization_reconciliations','facts','UPDATE') as writer_can_update_facts`,
        )
      ).rows[0];
      expect(acl).toMatchObject({
        can_insert: false,
        can_update: false,
        can_delete: false,
        writer_can_update_facts: true,
      });
      const owners = (
        await sql(
          `select proname,pg_get_userbyid(proowner) as owner
             from pg_proc
            where oid in (
              'emdo.request_standardization_receipt(uuid,uuid,uuid,integer,uuid,text)'::regprocedure,
              'emdo.resolve_standardization_outcome(uuid,uuid,uuid,integer,uuid,text,uuid,text)'::regprocedure,
              'emdo.claim_standardization_receipt_lookup()'::regprocedure,
              'emdo.record_standardization_receipt_lookup(uuid,uuid,jsonb)'::regprocedure
            )
            order by proname`,
        )
      ).rows;
      expect(owners).toHaveLength(4);
      expect(new Set(owners.map((row) => row.owner))).toEqual(
        new Set(['emdo_finance_standardization_reconciler']),
      );

      const { run, claim } = await extractedRun();
      const spend = await store.reserveModelSpend(claim, reservation());
      await store.markModelDispatch(claim, spend);
      await store.settleModelSpend(claim, {
        reservationId: spend.reservationId,
        outcome: 'indeterminate',
        providerResponseId: 'resp_acl_hardening',
      });
      await store.block(claim, 'indeterminate', 'Review required.');
      const pending = await runs.requestReceiptLookup(
        context,
        bookId,
        run.id,
        randomUUID(),
        {
          expectedRevision: (await runs.reconciliation(context, bookId, run.id))
            .revision,
          reservationId: spend.reservationId,
        },
      );
      const receipt = pending.receipts.at(-1)!;
      expect(receipt.status).toBe('pending');

      const executor = await admin.connect();
      try {
        await executor.query('set role emdo_finance_standardization_executor');
        await expect(
          executor.query(
            'update emdo.finance_standardization_reconciliations set facts=facts where id=$1',
            [receipt.id],
          ),
        ).rejects.toThrow();
        await expect(
          executor.query(
            'delete from emdo.finance_standardization_reconciliations where id=$1',
            [receipt.id],
          ),
        ).rejects.toThrow();
        await expect(
          executor.query(
            `insert into emdo.finance_standardization_reconciliations
               (id,run_id,reservation_id,kind,run_revision,source_digest,facts,created_by)
             values (gen_random_uuid(),$1,$2,'receipt',1,$3,$4::jsonb,$5)`,
            [
              run.id,
              spend.reservationId,
              run.sourceDigest,
              JSON.stringify({
                status: 'pending',
                providerResponseId: 'forged',
                receiptDigest: null,
                inputTokens: null,
                outputTokens: null,
                actualCadMinor: null,
              }),
              context.userId,
            ],
          ),
        ).rejects.toThrow();
      } finally {
        executor.release();
      }

      const lookup = z
        .object({ id: z.uuid(), token: z.uuid() })
        .passthrough()
        .parse(await store.claimReceiptLookup());
      expect(lookup).toMatchObject({
        id: receipt.id,
        providerResponseId: 'resp_acl_hardening',
      });
      expect(
        await store.recordReceiptLookup(lookup.id, lookup.token, {
          status: 'verified',
          providerResponseId: 'resp_acl_hardening',
          receiptDigest: 'a'.repeat(64),
          inputTokens: 100,
          outputTokens: 10,
          actualCadMinor: 1,
        }),
      ).toBe(true);
      expect(
        (await runs.reconciliation(context, bookId, run.id)).receipts.at(-1),
      ).toMatchObject({ status: 'verified', actualCadMinor: 1 });

      await expect(
        sql(
          'update emdo.finance_standardization_reconciliations set facts=facts where id=$1',
          [receipt.id],
        ),
      ).rejects.toThrow(
        'terminal standardization reconciliation evidence is immutable',
      );
    });
    async function extractedRun() {
      // Unique bytes retain a valid rectangular CSV row; use a unique description instead.
      const source = standardizationCsv.replace(
        'Payment fee included',
        randomUUID(),
      );
      const uploaded = await evidence.uploadBookEvidence(
        context,
        bookId,
        randomUUID(),
        { filename: 'attempt.csv', format: 'csv', sourceText: source },
      );
      const run = await runs.start(context, bookId, randomUUID(), {
        evidenceId: String(uploaded.id),
        expectedSourceDigest: createHash('sha256').update(source).digest('hex'),
      });
      const outcome = await store.claim(run.id, 1);
      const claim = FinanceStandardizationClaimSchema.parse(
        (outcome as { claim: unknown }).claim,
      );
      const extracted = await extractFinanceStandardizationSource({
        format: 'csv',
        bytes: Buffer.from(source),
        expectedSourceDigest: claim.sourceDigest,
        revision: 1,
        signal: new AbortController().signal,
      });
      if (extracted.status !== 'extracted')
        throw new Error('fixture extraction failed');
      await store.saveExtraction(claim, extracted.summary, extracted.envelope);
      return { run, claim, extracted };
    }
    function reservation() {
      return {
        requestKey: randomUUID(),
        inputTokenCeiling: 20000,
        outputTokenCeiling: 4000,
        estimatedCadMinor: 100,
        pricingVersion: 'test-cad.v1',
        pricing: {
          inputCadMinorPerMillionTokens: 1000,
          outputCadMinorPerMillionTokens: 2000,
        },
        lineage: {
          managerInvocationId: randomUUID(),
          financeInvocationId: randomUUID(),
          orchestrationMode: 'registered-workflow' as const,
          promptVersion: 'finance-standardization-proposal.v2' as const,
        },
      };
    }
    it.each([
      'finance-standardization-proposal.v1',
      'finance-standardization-proposal.v2',
      'finance-standardization-proposal.v3',
      'finance-standardization-proposal.v4',
    ] as const)(
      'reserves supported prompt lineage %s through the worker role',
      async (promptVersion) => {
        const { claim } = await extractedRun();
        const input = reservation();
        const spend = await store.reserveModelSpend(claim, {
          ...input,
          lineage: { ...input.lineage, promptVersion },
        });
        expect(
          (
            await sql(
              'select lineage from emdo.finance_standardization_spend where id=$1',
              [spend.reservationId],
            )
          ).rows[0].lineage.promptVersion,
        ).toBe(promptVersion);
      },
    );
    it('records costs after cancellation without permitting finish or a free retry', async () => {
      const { run, claim } = await extractedRun();
      const spend = await store.reserveModelSpend(claim, reservation());
      await store.markModelDispatch(claim, spend);
      const current = await runs.get(context, bookId, run.id);
      const cancelled = await runs.change(
        context,
        bookId,
        run.id,
        'cancel',
        randomUUID(),
        { expectedRevision: current.revision },
      );
      expect(cancelled.status).toBe('cancelled');
      expect(await store.verifyAuthority(claim)).toBe(false);
      await store.settleModelSpend(claim, {
        reservationId: spend.reservationId,
        outcome: 'completed',
        actualCadMinor: 50,
        providerResponseId: 'response_after_cancel',
      });
      await expect(store.readOriginal(claim)).rejects.toThrow();
      await expect(
        runs.change(context, bookId, run.id, 'retry', randomUUID(), {
          expectedRevision: cancelled.revision,
        }),
      ).rejects.toThrow();
      expect(
        (
          await sql(
            'select status,actual_cad_minor from emdo.finance_standardization_spend where id=$1',
            [spend.reservationId],
          )
        ).rows[0],
      ).toMatchObject({ status: 'completed', actual_cad_minor: 50 });
    });
    it('retains a lost reservation and lineage when an execution lease expires', async () => {
      const { run, claim } = await extractedRun();
      const input = reservation();
      const spend = await store.reserveModelSpend(claim, input);
      await expect(store.reserveModelSpend(claim, input)).rejects.toThrow();
      await sql(
        "update emdo.finance_standardization_runs set lease_expires_at=now()-interval '1 second' where id=$1",
        [run.id],
      );
      await deliveries.claim();
      const saved = await runs.get(context, bookId, run.id);
      expect(saved.status).toBe('indeterminate');
      expect(saved.allowedActions).not.toContain('retry');
      expect(
        (
          await sql(
            'select status,lineage from emdo.finance_standardization_spend where id=$1',
            [spend.reservationId],
          )
        ).rows[0],
      ).toMatchObject({ status: 'reserved', lineage: input.lineage });
      expect(await store.claim(run.id, 1)).toMatchObject({
        status: 'duplicate',
      });
    });
    it('rejects a confirmed budget denial before allocating spend', async () => {
      const { claim } = await extractedRun();
      await expect(
        store.reserveModelSpend(claim, {
          ...reservation(),
          estimatedCadMinor: 1001,
        }),
      ).rejects.toMatchObject({
        name: 'FinanceStandardizationReservationDenied',
        code: 'budget-exhausted',
      });
      expect(
        (
          await sql(
            'select count(*)::integer n from emdo.finance_standardization_spend where run_id=$1',
            [claim.runId],
          )
        ).rows[0].n,
      ).toBe(0);
      await store.block(
        claim,
        'blocked',
        'Configured model budget is insufficient.',
      );
    });
    it('resolves database-proven no dispatch only through explicit review and separate retry', async () => {
      const { run, claim } = await extractedRun();
      const spend = await store.reserveModelSpend(claim, reservation());
      await store.block(
        claim,
        'indeterminate',
        'Reservation acknowledgement was lost.',
      );
      const current = await runs.reconciliation(context, bookId, run.id);
      expect(current.spend[0]).toMatchObject({
        dispatchPhase: 'not-dispatched',
        status: 'reserved',
      });
      const command = {
        expectedRevision: current.revision,
        reservationId: spend.reservationId,
        decision: 'confirm-not-sent',
        receiptId: null,
        acknowledgeNoApproval: true,
      };
      const key = randomUUID();
      const resolved = await runs.resolveOutcome(
        context,
        bookId,
        run.id,
        key,
        command,
      );
      expect(resolved.status).toBe('blocked');
      expect(resolved.spend[0]?.status).toBe('not-sent');
      expect(resolved.resolutions).toHaveLength(1);
      expect(
        await runs.resolveOutcome(context, bookId, run.id, key, command),
      ).toEqual(resolved);
      await expect(
        runs.resolveOutcome(context, bookId, run.id, randomUUID(), command),
      ).rejects.toThrow();
      expect(
        (
          await runs.change(context, bookId, run.id, 'retry', randomUUID(), {
            expectedRevision: resolved.revision,
          })
        ).status,
      ).toBe('queued');
    });
    it('proves no reservation exists before releasing an interrupted pre-dispatch run', async () => {
      const { run, claim } = await extractedRun();
      await store.block(
        claim,
        'indeterminate',
        'Interrupted before reservation.',
      );
      const current = await runs.reconciliation(context, bookId, run.id);
      expect(current.spend).toEqual([]);
      const resolved = await runs.resolveOutcome(
        context,
        bookId,
        run.id,
        randomUUID(),
        {
          expectedRevision: current.revision,
          reservationId: null,
          decision: 'confirm-not-sent',
          receiptId: null,
          acknowledgeNoApproval: true,
        },
      );
      expect(resolved.status).toBe('blocked');
      expect(resolved.spend).toEqual([]);
      expect(resolved.resolutions).toHaveLength(1);
    });
    it('never frees a dispatch-started reservation without authoritative outcome evidence', async () => {
      const { run, claim } = await extractedRun();
      const spend = await store.reserveModelSpend(claim, reservation());
      await store.markModelDispatch(claim, spend);
      await store.block(claim, 'indeterminate', 'Provider outcome unknown.');
      const current = await runs.reconciliation(context, bookId, run.id);
      await expect(
        runs.resolveOutcome(context, bookId, run.id, randomUUID(), {
          expectedRevision: current.revision,
          reservationId: spend.reservationId,
          decision: 'confirm-not-sent',
          receiptId: null,
          acknowledgeNoApproval: true,
        }),
      ).rejects.toThrow();
      await expect(
        runs.requestReceiptLookup(context, bookId, run.id, randomUUID(), {
          expectedRevision: current.revision,
          reservationId: spend.reservationId,
        }),
      ).rejects.toThrow();
      expect(
        (await runs.reconciliation(context, bookId, run.id)).spend[0]?.status,
      ).toBe('reserved');
    });
    it('looks up a saved response with the fixed executor and explicitly reviews actual cost', async () => {
      const { run, claim } = await extractedRun();
      const spend = await store.reserveModelSpend(claim, reservation());
      await store.markModelDispatch(claim, spend);
      await store.settleModelSpend(claim, {
        reservationId: spend.reservationId,
        outcome: 'indeterminate',
        providerResponseId: 'resp_reconcile_saved',
      });
      await store.block(claim, 'indeterminate', 'Known receipt needs lookup.');
      const current = await runs.reconciliation(context, bookId, run.id);
      const key = randomUUID();
      const lookup = {
        expectedRevision: current.revision,
        reservationId: spend.reservationId,
      };
      const pending = await runs.requestReceiptLookup(
        context,
        bookId,
        run.id,
        key,
        lookup,
      );
      expect(pending.receipts[0]?.status).toBe('pending');
      expect(
        await runs.requestReceiptLookup(context, bookId, run.id, key, lookup),
      ).toEqual(pending);
      const app = await appPool.connect();
      try {
        await expect(
          app.query(
            'select emdo.record_standardization_receipt_lookup($1,$2,$3::jsonb)',
            [
              pending.receipts[0]!.id,
              randomUUID(),
              JSON.stringify({ status: 'verified', actualCadMinor: 0 }),
            ],
          ),
        ).rejects.toThrow();
      } finally {
        app.release();
      }
      await createStandardizationReceiptReconciler({
        store,
        retrieve: async (responseId) => {
          expect(responseId).toBe('resp_reconcile_saved');
          return {
            id: responseId,
            model: 'gpt-6-astra',
            status: 'completed',
            usage: { input_tokens: 1000, output_tokens: 100 },
          };
        },
      })();
      const observed = await runs.reconciliation(context, bookId, run.id);
      expect(observed.receipts[0]).toMatchObject({
        status: 'verified',
        actualCadMinor: 2,
      });
      const resolved = await runs.resolveOutcome(
        context,
        bookId,
        run.id,
        randomUUID(),
        {
          expectedRevision: observed.revision,
          reservationId: spend.reservationId,
          decision: 'accept-actual-cost',
          receiptId: observed.receipts[0]!.id,
          acknowledgeNoApproval: true,
        },
      );
      expect(resolved.status).toBe('blocked');
      expect(resolved.spend[0]).toMatchObject({
        status: 'completed',
        actualCadMinor: 2,
      });
    });
    it('keeps a provider 404 unavailable and the unknown cost held', async () => {
      const { run, claim } = await extractedRun();
      const spend = await store.reserveModelSpend(claim, reservation());
      await store.markModelDispatch(claim, spend);
      await store.settleModelSpend(claim, {
        reservationId: spend.reservationId,
        outcome: 'indeterminate',
        providerResponseId: 'resp_unavailable',
      });
      await store.block(claim, 'indeterminate', 'Receipt unavailable.');
      const current = await runs.reconciliation(context, bookId, run.id);
      await runs.requestReceiptLookup(context, bookId, run.id, randomUUID(), {
        expectedRevision: current.revision,
        reservationId: spend.reservationId,
      });
      await createStandardizationReceiptReconciler({
        store,
        retrieve: async () => {
          throw Object.assign(new Error('not found'), { status: 404 });
        },
      })();
      const observed = await runs.reconciliation(context, bookId, run.id);
      expect(observed.receipts[0]?.status).toBe('unavailable');
      await expect(
        runs.resolveOutcome(context, bookId, run.id, randomUUID(), {
          expectedRevision: observed.revision,
          reservationId: spend.reservationId,
          decision: 'accept-actual-cost',
          receiptId: observed.receipts[0]!.id,
          acknowledgeNoApproval: true,
        }),
      ).rejects.toThrow();
      expect(observed.spend[0]?.status).toBe('indeterminate');
      const retried = await runs.requestReceiptLookup(
        context,
        bookId,
        run.id,
        randomUUID(),
        {
          expectedRevision: observed.revision,
          reservationId: spend.reservationId,
        },
      );
      expect(retried.receipts).toHaveLength(2);
      expect(retried.receipts.at(-1)?.status).toBe('pending');
      await createStandardizationReceiptReconciler({
        store,
        retrieve: async (id) => ({
          id,
          model: 'gpt-6-astra',
          status: 'completed',
          usage: { input_tokens: 100, output_tokens: 100 },
        }),
      })();
      const recovered = await runs.reconciliation(context, bookId, run.id);
      expect(recovered.receipts.at(-1)?.status).toBe('verified');
      expect(recovered.spend[0]?.status).toBe('indeterminate');
    });
    it('rechecks administrative review authority before a queued receipt lookup and resolution', async () => {
      const { run, claim } = await extractedRun();
      const spend = await store.reserveModelSpend(claim, reservation());
      await store.markModelDispatch(claim, spend);
      await store.settleModelSpend(claim, {
        reservationId: spend.reservationId,
        outcome: 'indeterminate',
        providerResponseId: 'resp_revoked_lookup',
      });
      await store.block(claim, 'indeterminate', 'Review required.');
      const current = await runs.reconciliation(context, bookId, run.id);
      await runs.requestReceiptLookup(context, bookId, run.id, randomUUID(), {
        expectedRevision: current.revision,
        reservationId: spend.reservationId,
      });
      await sql(
        "update emdo.finance_book_grants set role='preparer' where workspace_id=$1 and book_id=$2 and user_id=$3",
        [context.workspaceId, bookId, context.userId],
      );
      try {
        expect(
          (await runs.reconciliation(context, bookId, run.id)).canResolve,
        ).toBe(false);
        expect(await store.claimReceiptLookup()).toBeNull();
        expect(
          (await runs.reconciliation(context, bookId, run.id)).receipts[0]
            ?.status,
        ).toBe('unavailable');
        await expect(
          runs.resolveOutcome(context, bookId, run.id, randomUUID(), {
            expectedRevision: current.revision,
            reservationId: spend.reservationId,
            decision: 'confirm-not-sent',
            receiptId: null,
            acknowledgeNoApproval: true,
          }),
        ).rejects.toMatchObject({ code: 'denied' });
      } finally {
        await sql(
          "update emdo.finance_book_grants set role='administrator' where workspace_id=$1 and book_id=$2 and user_id=$3",
          [context.workspaceId, bookId, context.userId],
        );
      }
    });
    it('rechecks current authority before claim after membership changes', async () => {
      const text = standardizationCsv.replace(
          'Payment fee included',
          'Other payment',
        ),
        digest = createHash('sha256').update(text).digest('hex');
      const e = String(
        (
          await evidence.uploadBookEvidence(
            context,
            bookId,
            'second-standardization-original',
            { filename: 'other.csv', format: 'csv', sourceText: text },
          )
        ).id,
      );
      const run = await runs.start(context, bookId, randomUUID(), {
        evidenceId: e,
        expectedSourceDigest: digest,
      });
      await sql(
        'update emdo.finance_automation_authority_epochs set revision=revision+1 where workspace_id=$1',
        [context.workspaceId],
      );
      expect(await store.claim(run.id, 1)).toEqual({ status: 'denied' });
      expect((await runs.get(context, bookId, run.id)).status).toBe(
        'authority-revoked',
      );
      await expect(
        runs.get({ ...context, workspaceId: randomUUID() }, bookId, run.id),
      ).rejects.toThrow();
    });
  },
);

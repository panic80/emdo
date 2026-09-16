import { standardizationProposal } from '../../../worker/src/finance-standardization.test-fixtures.js';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { createApp } from '../app.js';
import { specialistCapabilitySchemas } from '../agents/capability-runtime.js';
import { createFailClosedApiServices } from '../production/unavailable-services.js';
import type { ApiServices } from '../services/contracts.js';
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
import { InMemoryVaultKeyProvider } from '../../../../packages/integrations/src/vault/crypto.js';
import { type WorkspaceContext } from '@emdo/contracts';
import { z } from 'zod';
import { createDurableFinanceStandardizationHook } from '@emdo/agent-core';
import {
  financeManifest,
  financeCapabilityReferences,
} from '@emdo/agent-finance';
import type { CapabilityInvocationContext } from '@emdo/contracts';
import { createRequestScopedFinanceSpecialistServices } from '../production/finance-agent-services.js';
import { createFinanceStandardizationWorker } from '../../../worker/src/finance-standardization-worker.js';
const standardizationCsv =
  'Booked on,Details,Net cash,CCY\n2026-09-15,Synthetic service receipt,123.45,CAD\n2026-09-16,Synthetic purchase,-67.89,CAD\n';
const standardizationDigest = createHash('sha256')
  .update(standardizationCsv)
  .digest('hex');
const url = process.env.FINANCE_V2_TEST_DATABASE_URL;
describe.skipIf(
  !url || new URL(url).pathname !== '/emdo_finance_normalization_http',
)(
  'Local HTTP injection with restricted PostgreSQL; mocked auth and deterministic provider',
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
    let restrictedApp: pg.Pool;
    const appPool = {
      async connect() {
        const c = await restrictedApp.connect();
        await c.query('set role emdo_app');
        return c;
      },
    };
    const evidenceRepository = new PostgresFinanceV2Repository(appPool, {
      evidenceCipher: {
        encrypt: (v, s) => cipher.encrypt(v, s),
        decrypt: (v, s) =>
          cipher.decrypt(EncryptedFinanceBookEvidenceSchema.parse(v), s),
      },
    });
    const runsRepository = new PostgresFinanceStandardizationRepository(
      appPool,
    );
    let app: Awaited<ReturnType<typeof createApp>>;
    // Explicit test boundary: session authentication and CSRF verification are mocked.
    // Current database membership, route validation and restricted SQL roles remain real.
    const auth = {
      authenticate: vi.fn(async () => ({
        userId: context.userId,
        sessionId: context.sessionId,
        householdId: context.workspaceId,
        role: 'owner' as const,
        emailVerified: true,
        spaceAccessGrantId: context.requestId,
        collectionAuthorizationScopeFingerprint: '7'.repeat(64),
      })),
      verifyMutation: vi.fn(async () => true),
    } as unknown as ApiServices['auth'];
    async function http<T>(
      path: string,
      payload?: unknown,
      key: string = randomUUID(),
    ): Promise<T> {
      const result = await app.inject({
        method: payload === undefined ? 'GET' : 'POST',
        url: '/api/v2/finance' + path,
        headers: { 'idempotency-key': key },
        ...(payload === undefined
          ? {}
          : { payload: payload as Record<string, unknown> }),
      });
      if (result.statusCode !== 200)
        throw new Error(`HTTP ${result.statusCode}: ${result.body}`);
      expect(result.headers['cache-control']).toBe('no-store, private');
      return result.json<T>();
    }
    const evidence: Pick<
      PostgresFinanceV2Repository,
      | 'createBook'
      | 'createAccount'
      | 'createFinancialAccount'
      | 'createPeriod'
      | 'uploadBookEvidence'
      | 'overview'
      | 'getReportMapping'
      | 'saveSourceReportMapping'
      | 'reviewReportMapping'
      | 'importMappedReport'
      | 'getNormalizedImport'
      | 'reviewNormalizedImportRow'
      | 'commitNormalizedImport'
    > = {
      createBook: (_c, k, p) => http('/books', p, k),
      createAccount: (_c, b, k, p) => http(`/books/${b}/accounts`, p, k),
      createFinancialAccount: (_c, b, k, p) =>
        http(`/books/${b}/financial-accounts`, p, k),
      createPeriod: (_c, b, k, p) => http(`/books/${b}/periods`, p, k),
      uploadBookEvidence: (_c, b, k, p) => http(`/books/${b}/evidence`, p, k),
      overview: (_c, b) => http(`/books/${b}`),
      getReportMapping: (_c, b, id) =>
        http(`/books/${b}/report-mappings/${id}`),
      saveSourceReportMapping: (_c, b, k, p) =>
        http(`/books/${b}/report-mappings/from-source`, p, k),
      reviewReportMapping: (_c, b, id, k, p) =>
        http(`/books/${b}/report-mappings/${id}/review`, p, k),
      importMappedReport: (_c, b, id, k, p) =>
        http(`/books/${b}/report-mappings/${id}/import`, p, k),
      getNormalizedImport: (_c, b, id) => http(`/books/${b}/imports/${id}`),
      reviewNormalizedImportRow: (_c, b, id, k, p) =>
        http(`/books/${b}/import-rows/${id}/review`, p, k),
      commitNormalizedImport: (_c, b, id, k, p) =>
        http(`/books/${b}/imports/${id}/commit`, p, k),
    };
    const runs: Pick<
      PostgresFinanceStandardizationRepository,
      'start' | 'get' | 'linkMapping'
    > = {
      start: (_c, b, k, p) => http(`/books/${b}/standardizations`, p, k),
      get: (_c, b, id) => http(`/books/${b}/standardizations/${id}`),
      linkMapping: (_c, b, id, k, p) =>
        http(`/books/${b}/standardizations/${id}/reviewed-mapping`, p, k),
    };
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
      const target = new URL(url!);
      if (
        !['127.0.0.1', 'localhost'].includes(target.hostname) ||
        target.pathname !== '/emdo_finance_normalization_http'
      )
        throw new Error('finance-http-disposable-local-database-required');
      await sql(
        'create role finance_http_app login noinherit nosuperuser nobypassrls nocreatedb nocreaterole',
      );
      await sql('grant emdo_app to finance_http_app');
      target.username = 'finance_http_app';
      restrictedApp = new pg.Pool({ connectionString: target.toString() });
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
      app = await createApp({
        services: {
          ...createFailClosedApiServices({ auth }),
          financeV2: evidenceRepository,
          financeStandardization: runsRepository,
        },
      });
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
        "update emdo.finance_standardization_configuration set ready=true,max_run_cad_minor=1000,max_workspace_day_cad_minor=1000 where id='v1'",
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
      expect(await runsRepository.checkReady()).toBe(true);
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

    afterAll(async () => {
      await app?.close();
      await restrictedApp?.end();
      await workerPool?.end();
      await dispatchPool?.end();
      await admin.end();
    });
    it('persists one proposal and posts only after explicit synthetic source review', async () => {
      const cash = String(
        (
          await evidence.createAccount(context, bookId, randomUUID(), {
            code: '1000',
            name: 'Synthetic cash',
            kind: 'asset',
          })
        ).id,
      );
      const counter = String(
        (
          await evidence.createAccount(context, bookId, randomUUID(), {
            code: '3000',
            name: 'Synthetic counter account',
            kind: 'equity',
          })
        ).id,
      );
      const financialAccountId = String(
        (
          await evidence.createFinancialAccount(context, bookId, randomUUID(), {
            name: 'Synthetic bank',
            kind: 'bank',
            currency: 'CAD',
            ledgerAccountId: cash,
          })
        ).id,
      );
      await evidence.createPeriod(context, bookId, randomUUID(), {
        startsOn: '2026-01-01',
        endsOn: '2026-12-31',
      });
      vi.mocked(auth.verifyMutation).mockResolvedValueOnce(false);
      const unverified = await app.inject({
        method: 'POST',
        url: `/api/v2/finance/books/${bookId}/evidence`,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          filename: 'rejected-synthetic.csv',
          format: 'csv',
          sourceText: standardizationCsv,
        },
      });
      expect(unverified.statusCode).toBe(403);
      const startKey = randomUUID();
      const startInput = {
        evidenceId,
        expectedSourceDigest: standardizationDigest,
      };
      const run = await runs.start(context, bookId, startKey, startInput);
      expect((await runs.start(context, bookId, startKey, startInput)).id).toBe(
        run.id,
      );
      const delivery = (await deliveries.claim(1))[0]!;
      expect(delivery.runId).toBe(run.id);
      let calls = 0;
      const hook = createDurableFinanceStandardizationHook({
        registration: {
          id: financeManifest.id,
          section: 'finance',
          allowedParents: ['manager'],
          allowedChildren: [],
          capabilities: financeManifest.capabilityAllowlist,
          readiness: async () => {
            await store.checkReady();
            return { status: 'ready' as const };
          },
        },
        provider: {
          async generate(input) {
            if (++calls !== 1)
              throw new Error('finance-http-provider-call-limit');
            expect(input.model).toBe('gpt-6-astra');
            expect(input.reasoningEffort).toBe('medium');
            return {
              proposal: {
                ...standardizationProposal,
                definition: {
                  ...standardizationProposal.definition,
                  headers: ['Booked on', 'Details', 'Net cash', 'CCY'],
                  bindings: [
                    {
                      field: 'transactionDate',
                      column: 'Booked on',
                      context: null,
                    },
                    {
                      field: 'description',
                      column: 'Details',
                      context: null,
                    },
                    {
                      field: 'amount',
                      column: 'Net cash',
                      context: null,
                    },
                    {
                      field: 'currency',
                      column: 'CCY',
                      context: null,
                    },
                  ],
                },
              },
              providerResponseId: 'resp_synthetic_fixture',
              model: 'gpt-6-astra',
              inputTokens: 100,
              outputTokens: 100,
            };
          },
        },
        // Fixture tariffs exercise spend reservation/settlement, not a billing-price assertion.
        pricing: {
          version: 'synthetic-acceptance.v1',
          inputCadMinorPerMillionTokens: 1000,
          outputCadMinorPerMillionTokens: 2000,
        },
      });
      const worker = createFinanceStandardizationWorker({
        store,
        propose: hook,
      });
      expect(
        await worker({
          schemaVersion: 1,
          runId: run.id,
          deliveryRevision: delivery.deliveryRevision,
        }),
      ).toBe('needs-review');
      expect(calls).toBe(1);
      const saved = await runs.get(context, bookId, run.id);
      expect(saved).toMatchObject({
        status: 'needs-review',
        approval: 'not-granted',
        posting: 'not-performed',
        proposal: { status: 'candidate' },
      });
      expect((await evidence.overview(context, bookId)).journals).toHaveLength(
        0,
      );
      // Saved review survives an API lifecycle restart against the same database.
      await app.close();
      app = await createApp({
        services: {
          ...createFailClosedApiServices({ auth }),
          financeV2: evidenceRepository,
          financeStandardization: runsRepository,
        },
      });
      expect(await runs.get(context, bookId, run.id)).toEqual(saved);
      const originalMappingId = saved.proposal?.mappingId;
      let mappingId = originalMappingId;
      if (!mappingId) throw new Error('finance-http-candidate-missing');
      const candidate = await evidence.getReportMapping(
        context,
        bookId,
        mappingId,
      );
      expect(candidate.mapping.status).toBe('candidate');
      // Synthetic reviewer checks the persisted candidate against the known original
      // before invoking the same explicit approval command used by the UI.
      expect(candidate.mapping.example).toMatchObject({
        documentId: evidenceId,
        headers: ['Booked on', 'Details', 'Net cash', 'CCY'],
        context: { asOf: null, currency: null },
        rows: [
          {
            sourceRow: 2,
            cells: ['2026-09-15', 'Synthetic service receipt', '123.45', 'CAD'],
          },
          {
            sourceRow: 3,
            cells: ['2026-09-16', 'Synthetic purchase', '-67.89', 'CAD'],
          },
        ],
      });
      expect(candidate.mapping.validation).toMatchObject({
        status: 'normalized',
        rows: [
          {
            fields: {
              transactionDate: '2026-09-15',
              description: 'Synthetic service receipt',
              amount: '123.45',
              currency: 'CAD',
            },
          },
          {
            fields: {
              transactionDate: '2026-09-16',
              description: 'Synthetic purchase',
              amount: '-67.89',
              currency: 'CAD',
            },
          },
        ],
      });
      await expect(
        evidence.reviewReportMapping(context, bookId, mappingId, randomUUID(), {
          expectedRevision: Number(candidate.mapping.revision),
          decision: 'approve',
          reason: 'Synthetic attempted premature approval',
        }),
      ).rejects.toThrow();
      expect(
        (await evidence.getReportMapping(context, bookId, mappingId)).mapping
          .status,
      ).toBe('candidate');
      const lineage = (
        await sql(
          'select lineage from emdo.finance_standardization_spend where run_id=$1',
          [run.id],
        )
      ).rows[0].lineage;
      expect(lineage.promptVersion).toBe('finance-standardization-proposal.v6');
      await expect(
        evidence.importMappedReport(context, bookId, mappingId, randomUUID(), {
          evidenceId,
          financialAccountId,
          expectedMappingVersion: Number(candidate.mapping.version),
          providerKey: String(candidate.mapping.provider_key),
        }),
      ).rejects.toThrow();
      const knownReviewQuestions = new Set([
        'CSV headings, field meanings, date locale and number separators require explicit review.',
        'Confirm the source columns and date format.',
        'Source extraction is incomplete; review the original before approval.',
        'Confirm that Booked on is the intended transaction date and Net cash is the signed transaction amount, including its treatment of any fees or taxes.',
        'Confirm the heading meanings, date format and number separators across the source; the proposal is based only on the two supplied rows.',
        'Extraction is marked incomplete. What rows or regions remain unextracted, and could they contain additional columns or different formats? Full-source coverage is unknown.',
        'Confirm or replace the proposed providerKey, reportName and layoutVersion labels.',
      ]);
      const questions = z
        .array(z.string())
        .parse(candidate.mapping.unresolved_questions);
      if (questions.some((question) => !knownReviewQuestions.has(question)))
        throw new Error(
          'finance-http-review-requires-explicit-question-resolution',
        );
      const reviewedCandidate = await evidence.saveSourceReportMapping(
        context,
        bookId,
        randomUUID(),
        {
          evidenceId,
          expectedSourceDigest: standardizationDigest,
          proposal: {
            definition: candidate.mapping.definition,
            unresolvedQuestions: [],
            rationale:
              'Synthetic reviewer inspected the complete two-row CSV: all four headings are mapped; yyyy-mm-dd dates, period decimal amounts and explicit CAD values match every cell. Both source rows are preserved. Provider/report labels are synthetic mapping identifiers, not assertions of an external bank. This resolves the heading/format and source-completeness caveats against the full original.',
          },
        },
      );
      mappingId = String(reviewedCandidate.id);
      const linked = await runs.linkMapping(
        context,
        bookId,
        run.id,
        randomUUID(),
        { expectedRevision: saved.revision, mappingId },
      );
      expect(linked.reviewedMapping?.mappingId).toBe(mappingId);
      expect(linked.proposal?.mappingId).toBe(originalMappingId);
      const reviewedMapping = await evidence.getReportMapping(
        context,
        bookId,
        mappingId,
      );
      await evidence.reviewReportMapping(
        context,
        bookId,
        mappingId,
        randomUUID(),
        {
          expectedRevision: Number(reviewedMapping.mapping.revision),
          decision: 'approve',
          reason:
            'Synthetic reviewer verified both original CSV rows and every mapped column.',
        },
      );
      const batch = await evidence.importMappedReport(
        context,
        bookId,
        mappingId,
        randomUUID(),
        {
          evidenceId,
          financialAccountId,
          expectedMappingVersion: Number(reviewedMapping.mapping.version),
          providerKey: String(reviewedMapping.mapping.provider_key),
        },
      );
      const batchId = String(batch.id),
        imported = await evidence.getNormalizedImport(context, bookId, batchId);
      expect(imported.rows.map((row) => row.amount)).toEqual([
        '123.450000000000',
        '-67.890000000000',
      ]);
      expect(imported.rows.every((row) => row.posting === null)).toBe(true);
      for (const row of imported.rows)
        await evidence.reviewNormalizedImportRow(
          context,
          bookId,
          String(row.id),
          randomUUID(),
          {
            expectedRevision: Number(row.revision),
            action: 'post',
            counterAccountId: counter,
            fxRate: '1',
            fxSource: 'identity',
            reason:
              'Synthetic reviewer checked exact original date, description, signed amount and currency.',
          },
        );
      const reviewed = await evidence.getNormalizedImport(
        context,
        bookId,
        batchId,
      );
      expect((await evidence.overview(context, bookId)).journals).toHaveLength(
        0,
      );
      const commitKey = randomUUID();
      const commitInput = { expectedRevision: Number(reviewed.batch.revision) };
      await evidence.commitNormalizedImport(
        context,
        bookId,
        batchId,
        commitKey,
        commitInput,
      );
      await evidence.commitNormalizedImport(
        context,
        bookId,
        batchId,
        commitKey,
        commitInput,
      );
      const posted = await evidence.getNormalizedImport(
        context,
        bookId,
        batchId,
      );
      const postings = posted.rows.map(
        (row) =>
          row.posting as {
            journalId: string;
            economicTransactionId: string;
            functionalCurrency: string;
            lines: { accountId: string; side: string; amount: string }[];
          },
      );
      expect(new Set(postings.map((p) => p.journalId)).size).toBe(2);
      expect(postings.map((p) => p.functionalCurrency)).toEqual(['CAD', 'CAD']);
      expect(postings[0]!.lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            accountId: cash,
            side: 'debit',
            amount: '123.450000000000',
          }),
          expect.objectContaining({
            accountId: counter,
            side: 'credit',
            amount: '123.450000000000',
          }),
        ]),
      );
      expect(postings[1]!.lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            accountId: cash,
            side: 'credit',
            amount: '67.890000000000',
          }),
          expect.objectContaining({
            accountId: counter,
            side: 'debit',
            amount: '67.890000000000',
          }),
        ]),
      );
      expect(postings.map((p) => p.lines.length)).toEqual([2, 2]);
      expect(
        (await evidence.getNormalizedImport(context, bookId, batchId)).rows,
      ).toEqual(posted.rows);
      // Retrying the identical HTTP commit preserved the same two journals.
      const count = (await evidence.overview(context, bookId)).journals.length;
      expect(count).toBe(2);
      // Production Finance service readback, not a model/manager-runtime execution.
      const failClosed = async (): Promise<never> => {
        throw new Error('unused-finance-port');
      };
      const specialist = createRequestScopedFinanceSpecialistServices({
        principal: {
          userId: context.userId,
          sessionId: context.sessionId,
          householdId: context.workspaceId,
          role: 'owner',
          emailVerified: true,
          spaceAccessGrantId: context.requestId,
          collectionAuthorizationScopeFingerprint: '7'.repeat(64),
          privateSpaceId: randomUUID(),
        },
        dependencies: {
          normalizedBooks: evidenceRepository,
          records: {
            list: failClosed,
            getOwnedRecord: failClosed,
            getOwnedBudgetForMonth: failClosed,
            listBudgetTransactions: failClosed,
            createManualTransaction: failClosed,
            patchOwnedTransaction: failClosed,
            applyTransactionAdjustment: failClosed,
            applyTransactionReversal: failClosed,
            createMonthlyCategoryBudget: failClosed,
            updateMonthlyCategoryBudget: failClosed,
          },
          documents: {
            searchCommitted: failClosed,
            readCommitted: failClosed,
            listCommittedMatches: failClosed,
          },
          now: () => new Date(),
        },
      });
      const specialistContext: CapabilityInvocationContext = {
        requestId: context.requestId,
        runId: run.id,
        userId: context.userId,
        householdId: context.workspaceId,
        sessionId: context.sessionId,
        agentId: 'finance',
        locale: 'en-CA',
        spaceAccessGrantId: context.requestId,
        abortSignal: new AbortController().signal,
        invocationContext: {
          orchestrationRunId: run.id,
          parentInvocationId: randomUUID(),
          agentInvocationId: randomUUID(),
          phaseInvocationId: randomUUID(),
          actorId: context.userId,
          locale: 'en-CA',
          // Production checkedScope requires the complete registered capability manifest.
          grantedCapabilities: financeCapabilityReferences
            .map((c) => c.id)
            .sort(),
          disclosedContextRefs: [],
          deadline: new Date(Date.now() + 60000).toISOString(),
          idempotencyScope: 'd'.repeat(64),
        },
      };
      const readInput = {
        schemaVersion: 1 as const,
        view: 'import-review' as const,
        bookId,
        importId: batchId,
        valuationId: null,
        reportId: null,
        offset: 0,
        limit: 100,
      };
      const agentReadback = specialistCapabilitySchemas[
        'finance.books.read'
      ].output
        .omit({ schemaVersion: true })
        .parse(
          await specialist.readFinanceBooks!(readInput, specialistContext),
        );
      expect(agentReadback).toMatchObject({
        currency: 'CAD',
        amountEncoding: 'decimal-string',
        nextOffset: null,
      });
      const agentRows: Record<string, string | null>[] =
        agentReadback.records.map((record) => ({
          id: record.id,
          ...Object.fromEntries(
            record.fields.map((field) => [field.name, field.value]),
          ),
        }));
      expect(
        agentRows.filter((row) => row.recordType === 'import-posted-journal'),
      ).toHaveLength(2);
      expect(
        agentRows.filter((row) => row.recordType === 'import-posted-line'),
      ).toHaveLength(4);
      for (const [index, posting] of postings.entries()) {
        const sourceRowId = String(posted.rows[index]!.id);
        expect(agentRows).toContainEqual(
          expect.objectContaining({
            recordType: 'import-posted-journal',
            sourceRowId,
            batchId,
            evidenceId,
            journalId: posting.journalId,
            economicTransactionId: posting.economicTransactionId,
            functionalCurrency: 'CAD',
          }),
        );
        for (const line of posting.lines)
          expect(agentRows).toContainEqual(
            expect.objectContaining({
              recordType: 'import-posted-line',
              sourceRowId,
              batchId,
              evidenceId,
              journalId: posting.journalId,
              economicTransactionId: posting.economicTransactionId,
              accountId: line.accountId,
              side: line.side,
              amount: line.amount,
              functionalCurrency: 'CAD',
            }),
          );
      }
      expect(agentReadback.sourceReferences).toEqual(
        agentReadback.records.map(
          (record) =>
            `/api/v2/finance/books/${bookId}/imports/${batchId}#${record.id}`,
        ),
      );
      await sql(
        'update emdo.finance_book_grants set revoked_at=now(),revision=revision+1 where book_id=$1 and user_id=$2',
        [bookId, context.userId],
      );
      const denied = await app.inject({
        method: 'GET',
        url: `/api/v2/finance/books/${bookId}/standardizations/${run.id}`,
      });
      expect(denied.statusCode).toBe(403);
      await expect(
        specialist.readFinanceBooks!(readInput, specialistContext),
      ).rejects.toThrow();
      expect(auth.verifyMutation).toHaveBeenCalled();
      process.stdout.write(
        JSON.stringify({
          event: 'finance-normalization-http-posting-verified',
          scope: 'local-app-inject-restricted-postgresql-synthetic',
          productionCookieAuthProof: false,
          productionFinanceServiceReadback: true,
          modelOrManagerRuntimeProof: false,
          liveProvider: false,
          fixtureCalls: calls,
          journalIds: postings.map((p) => p.journalId),
        }) + '\n',
      );
    }, 110000);
  },
);

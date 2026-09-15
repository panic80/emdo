import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProductionAgentPersistence } from '../agents/production-persistence.js';
import { createRequestScopedManagerFinanceAgentRuntimeFactory } from '../production/core-agent-services.js';
import { createProductionApprovalCheckpointCipher } from '../production/approval-checkpoint-keyring.js';
import { createFinanceSyntheticStagingAgentServiceBundle } from '../production/finance-synthetic-staging-agent.js';
import { hashPassword } from 'better-auth/crypto';
import { createProductionAuthenticationServiceBinding } from '../production/auth-services.js';
import { runStagingAcceptanceCommand } from './staging-acceptance.js';
import { standardizationProposal } from '../../../worker/src/finance-standardization.test-fixtures.js';
import { randomUUID, randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { createApp } from '../app.js';
import { createFailClosedApiServices } from '../production/unavailable-services.js';
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
import { createDurableFinanceStandardizationHook } from '@emdo/agent-core';
import { financeManifest } from '@emdo/agent-finance';
import { createRequestScopedFinanceSpecialistServices } from '../production/finance-agent-services.js';
import { createFinanceStandardizationWorker } from '../../../worker/src/finance-standardization-worker.js';
const url = process.env.FINANCE_V2_TEST_DATABASE_URL;
describe.skipIf(
  !url ||
    new URL(url).pathname !== '/emdo_app' ||
    !process.env.FINANCE_NORMALIZED_CLI_DATABASE_ATTESTATION,
)(
  'Local HTTP injection with restricted PostgreSQL; real BetterAuth and deterministic provider',
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
    let reviewDirectory: string;
    let workflowRuntimePool: pg.Pool;
    const privateSpaceId = randomUUID();
    let authBinding: Awaited<
      ReturnType<typeof createProductionAuthenticationServiceBinding>
    >;
    const origin = 'https://staging.emdo.invalid';
    const email = 'synthetic-owner@emdo.invalid';
    const password = 'synthetic-password-0123456789';
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
    const evidence = evidenceRepository;
    let workerPool: pg.Pool,
      dispatchPool: pg.Pool,
      store: PostgresFinanceStandardizationExecutionRepository,
      deliveries: PostgresFinanceStandardizationDeliveryRepository,
      bookId: string;
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
        target.pathname !== '/emdo_app'
      )
        throw new Error('finance-http-disposable-local-database-required');
      const attestation =
        process.env.FINANCE_NORMALIZED_CLI_DATABASE_ATTESTATION;
      if (
        !attestation ||
        !/^normalized-cli:[0-9a-f]{32}$/.test(attestation) ||
        (
          await sql(
            "select pg_catalog.shobj_description(oid,'pg_database') as attestation from pg_database where datname=current_database()",
          )
        ).rows[0]?.attestation !== attestation
      )
        throw new Error('disposable-normalized-cli-attestation-required');
      await sql(
        'create role emdo_api_login login inherit nosuperuser nobypassrls nocreatedb nocreaterole',
      );
      await sql('grant emdo_app to emdo_api_login');
      await sql(
        'create role emdo_auth_login login inherit nosuperuser nobypassrls nocreatedb nocreaterole',
      );
      await sql('grant emdo_auth to emdo_auth_login');
      target.username = 'emdo_api_login';
      target.password = 'synthetic-local-only';
      restrictedApp = new pg.Pool({ connectionString: target.toString() });
      await sql(
        "insert into emdo.auth_users(id,name,email,email_verified) values($1,'Standardization',$2,true)",
        [context.userId, email],
      );
      await sql(
        "insert into emdo.auth_accounts(id,user_id,account_id,provider_id,password) values($1,$2::uuid,$2::text,'credential',$3)",
        [randomUUID(), context.userId, await hashPassword(password)],
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
      await sql(
        "insert into emdo.spaces(id,household_id,original_owner_user_id,name,visibility) values($1,$2,$3,'Synthetic private finance','private')",
        [privateSpaceId, context.workspaceId, context.userId],
      );
      const workflowConnection = new URL(url!);
      workflowConnection.username = 'emdo_workflow_login';
      workflowRuntimePool = new pg.Pool({
        connectionString: workflowConnection.toString(),
      });
      const authUrl = new URL(target);
      authUrl.username = 'emdo_auth_login';
      authBinding = await createProductionAuthenticationServiceBinding({
        EMDO_API_AUTH_SECRET: randomBytes(32).toString('base64url'),
        EMDO_SESSION_SECRET: randomBytes(32).toString('base64url'),
        EMDO_API_DATABASE_URL: target.toString(),
        EMDO_AUTH_DATABASE_URL: authUrl.toString(),
        EMDO_PUBLIC_ORIGIN: origin,
      });
      if (!authBinding.binding || !(await authBinding.binding.check()))
        throw new Error('real-auth-not-ready');
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
    });
    afterAll(async () => {
      await app?.close();
      if (reviewDirectory)
        await rm(reviewDirectory, { recursive: true, force: true });
      await authBinding?.close?.();
      await restrictedApp?.end();
      await workflowRuntimePool?.end();
      await workerPool?.end();
      await dispatchPool?.end();
      await admin.end();
    });
    it('runs the full normalized CLI against real v2 routes and restricted SQL; genuine synthetic manager delegation with real BetterAuth and deterministic provider', async () => {
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
                unresolvedQuestions: [
                  'Does the complete authored fixture contain separately stated fees?',
                ],
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
      const failClosed = async (): Promise<never> => {
        throw new Error('unused-finance-port');
      };
      const financeForPrincipal = (
        principal: Parameters<
          typeof createRequestScopedFinanceSpecialistServices
        >[0]['principal'],
      ) =>
        createRequestScopedFinanceSpecialistServices({
          principal,
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
      const synthetic = createFinanceSyntheticStagingAgentServiceBundle({
        EMDO_ENVIRONMENT: 'staging',
        EMDO_ALLOW_LOOPBACK_API_INGRESS: 'true',
        EMDO_SYNTHETIC_DATA_ONLY: 'true',
        EMDO_FINANCE_SYNTHETIC_STAGING: 'true',
        EMDO_FINANCE_DOCUMENTS_ENABLED: 'true',
      });
      if (!synthetic) throw new Error('synthetic-runtime-unavailable');
      const runnerNames: string[] = [];
      const openAi = {
        ...synthetic,
        runner: {
          run: async (...args: Parameters<typeof synthetic.runner.run>) => {
            runnerNames.push(args[0].name);
            return synthetic.runner.run(...args);
          },
        },
      };
      const checkpointCipher = createProductionApprovalCheckpointCipher(
        Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            current: {
              keyId: 'synthetic-cli',
              keyB64url: Buffer.alloc(32, 61).toString('base64url'),
            },
            previous: [],
          }),
        ).toString('base64url'),
      );
      const persistence = createProductionAgentPersistence({
        pool: appPool,
        runtimeFactory: {
          check: async () => true,
          create: async (input) => {
            const factory =
              createRequestScopedManagerFinanceAgentRuntimeFactory({
                ...input,
                readPool: appPool,
                workflowPool: workflowRuntimePool as unknown as typeof appPool,
                openAi,
                checkpointCipher,
                checkGlobalDependencies: async () => true,
                finance: financeForPrincipal(input.principal),
              });
            if (!factory)
              throw new Error('synthetic-finance-runtime-factory-unavailable');
            return factory.runtime;
          },
        },
      });
      if (!authBinding.binding) throw new Error('real-auth-binding-missing');
      app = await createApp({
        services: {
          ...createFailClosedApiServices({ auth: authBinding.binding.service }),
          financeV2: evidenceRepository,
          financeStandardization: runsRepository,
          managerTurns: persistence.bindings.managerTurns.service,
          runEvents: persistence.bindings.runEvents.service,
        },
        publicOrigin: origin,
        allowLoopbackApiIngress: true,
      });
      let observedTurn = false;
      reviewDirectory = await mkdtemp(
        join(await realpath(tmpdir()), 'normalized-cli-authored-'),
      );
      let pendingReview:
        { requestPath: string; reviewPath: string; runId: string } | undefined;
      let reviewedRunId: string | undefined;
      const result = await runStagingAcceptanceCommand({
        argv: [
          '--all-mvp-gates',
          '--require-synthetic',
          '--finance-normalized-synthetic-gates',
        ],
        normalizedReviewReporter: (progress) => {
          pendingReview = progress;
        },
        environment: {
          EMDO_ENVIRONMENT: 'staging',
          EMDO_SYNTHETIC_DATA_ONLY: 'true',
          EMDO_EXTERNAL_PROVIDERS_ENABLED: 'false',
          EMDO_STAGING_API_ORIGIN: 'http://127.0.0.1:3000',
          EMDO_PUBLIC_ORIGIN: 'https://staging.emdo.invalid',
          EMDO_STAGING_SOURCE_SHA: 'a'.repeat(40),
          EMDO_STAGING_WORKFLOW_RUN_ID: '123',
          EMDO_SYNTHETIC_OWNER_EMAIL: 'synthetic-owner@emdo.invalid',
          EMDO_SYNTHETIC_OWNER_PASSWORD: 'synthetic-password-0123456789',
          EMDO_FINANCE_SYNTHETIC_STAGING: 'true',
          EMDO_FINANCE_NORMALIZED_SYNTHETIC_STAGING: 'true',
          EMDO_FINANCE_NORMALIZED_SYNTHETIC_REVIEW_DIRECTORY: reviewDirectory,
          EMDO_FINANCE_NORMALIZED_SYNTHETIC_BOOK_ID: bookId,
          EMDO_FINANCE_NORMALIZED_SYNTHETIC_FINANCIAL_ACCOUNT_ID:
            financialAccountId,
          EMDO_FINANCE_NORMALIZED_SYNTHETIC_CASH_ACCOUNT_ID: cash,
          EMDO_FINANCE_NORMALIZED_SYNTHETIC_COUNTER_ACCOUNT_ID: counter,
        },
        sleep: async () => {
          if (pendingReview) {
            const request = JSON.parse(
              await readFile(pendingReview.requestPath, 'utf8'),
            ) as { binding: { questions: string[] } };
            const known = new Set([
              'Does the complete authored fixture contain separately stated fees?',
              'CSV headings, field meanings, date locale and number separators require explicit review.',
              'Source extraction is incomplete; review the original before approval.',
            ]);
            expect(request.binding.questions).toContain(
              'Does the complete authored fixture contain separately stated fees?',
            );
            expect(
              request.binding.questions.every((question) =>
                known.has(question),
              ),
              JSON.stringify(request.binding.questions),
            ).toBe(true);
            // Test author answers only the deterministic known fixture questions above.
            await writeFile(
              pendingReview.reviewPath,
              JSON.stringify({
                schemaVersion: 1,
                decision: 'approve-authored-synthetic-mapping',
                binding: request.binding,
                answers: request.binding.questions.map((question) => ({
                  question,
                  answer:
                    question ===
                    'Does the complete authored fixture contain separately stated fees?'
                      ? 'No. The authored two-row CSV has signed CAD cash amounts and no separately stated fee columns.'
                      : 'The complete two-row source has Booked on ISO yyyy-mm-dd dates, Details descriptions, Net cash signed decimal amounts with period decimal separators and CCY explicit CAD values.',
                })),
                rationale:
                  'The test author verified the complete two-row synthetic CSV, every mapped cell, ISO dates, signed CAD decimals and absence of separately stated fees.',
              }),
              { mode: 0o600 },
            );
            reviewedRunId = pendingReview.runId;
            pendingReview = undefined;
            return;
          }
          const delivery = (await deliveries.claim(1))[0];
          if (delivery)
            await worker({
              schemaVersion: 1,
              runId: delivery.runId,
              deliveryRevision: delivery.deliveryRevision,
            });
        },
        fetch: async (request) => {
          const path = new URL(request.url).pathname;
          if (path === '/api/v1/turns') observedTurn = true;
          const body =
            request.method === 'GET' ? undefined : await request.text();
          const response = await app.inject({
            method: request.method as 'GET' | 'POST',
            url: path,
            headers: {
              host: '127.0.0.1',
              ...Object.fromEntries(request.headers),
            },
            ...(body === undefined ? {} : { payload: body }),
          });
          if (response.statusCode >= 400)
            throw new Error(
              `Real API route ${path} returned ${response.statusCode}: ${response.body}`,
            );
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            for (const item of Array.isArray(value) ? value : [value])
              if (item !== undefined) headers.append(name, String(item));
          }
          return new Response(response.body, {
            status: response.statusCode,
            headers,
          });
        },
      });
      expect(result).toMatchObject({
        outcome: 'passed',
        releaseEligible: false,
        evidenceClass: 'finance-normalized-synthetic-staging-probe',
        proof: { emdoReadback: 'passed', exactPostingReadback: 'passed' },
      });
      expect(calls).toBe(1);
      expect(reviewedRunId).toBeDefined();
      const authoredReceipt = JSON.parse(
        await readFile(
          join(reviewDirectory, `${reviewedRunId}.accepted.json`),
          'utf8',
        ),
      );
      const savedRun = await runsRepository.get(
        context,
        bookId,
        reviewedRunId!,
      );
      expect(savedRun.id).toBe(reviewedRunId);
      expect(savedRun.reviewedMapping?.mappingId).toBeDefined();
      const savedMapping = await evidenceRepository.getReportMapping(
        context,
        bookId,
        savedRun.reviewedMapping!.mappingId,
      );
      expect(savedMapping.mapping.rationale).toContain(
        authoredReceipt.reviewSha256,
      );
      expect(savedMapping.mapping.rationale).toContain(
        'The test author verified',
      );
      expect(observedTurn).toBe(true);
      expect(runnerNames).toEqual(['manager', 'finance', 'manager']);
      await synthetic.close();
      expect((await evidence.overview(context, bookId)).journals).toHaveLength(
        2,
      );
      console.log(
        JSON.stringify({
          evidenceClass:
            'local-normalized-cli-real-v2-http-restricted-postgres',
          releaseEligible: false,
          auth: 'production-better-auth-and-csrf',
          provider: 'deterministic-test-adapter',
          manager: 'genuine-synthetic-runtime-via-real-v1-http-sse',
          financeRead: 'production-request-scoped-service',
          outcome: 'passed',
        }),
      );
    });
  },
);

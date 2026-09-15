import { readFile, writeFile, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { standardizationProposal } from './finance-standardization.test-fixtures.js';
import { randomUUID, createHash } from 'node:crypto';
import OpenAI from 'openai';
import { OpenAIProvider } from '@openai/agents';
import pg from 'pg';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
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
  ProposedFinanceReportMappingSchema,
  type WorkspaceContext,
} from '@emdo/contracts';
import { z } from 'zod';
import {
  createDurableFinanceStandardizationHook,
  createDurableFinanceProposalProvider,
} from '@emdo/agent-core';
import { financeManifest } from '@emdo/agent-finance';
import { createFinanceStandardizationWorker } from './finance-standardization-worker.js';
const standardizationCsv =
  'Booked on,Details,Net cash,CCY\n2026-09-15,Synthetic service receipt,123.45,CAD\n2026-09-16,Synthetic purchase,-67.89,CAD\n';
const standardizationDigest = createHash('sha256')
  .update(standardizationCsv)
  .digest('hex');
const url = process.env.FINANCE_V2_TEST_DATABASE_URL;
const live = process.env.EMDO_FINANCE_LIVE_PROVIDER_CHECK === '1';
const liveReviewDirectory = process.env.EMDO_FINANCE_LIVE_REVIEW_DIRECTORY;
const replayPath = process.env.EMDO_FINANCE_RECORDED_PROPOSAL_PATH;
const recorded = !live && !!replayPath;
// Never contacts a provider without both explicit opt-in and the dedicated disposable database.
describe.skipIf(
  !url ||
    (!live &&
      !recorded &&
      new URL(url).pathname !== '/emdo_finance_live_normalization'),
)(
  `Local ${live ? 'live Astra' : recorded ? 'recorded provider replay' : 'deterministic provider fixture'} normalization through canonical posting`,
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
      const target = new URL(url!);
      if (
        !['127.0.0.1', 'localhost'].includes(target.hostname) ||
        target.pathname !== '/emdo_finance_live_normalization'
      )
        throw new Error('finance-live-disposable-local-database-required');
      await sql(
        'create role finance_live_app login noinherit nosuperuser nobypassrls nocreatedb nocreaterole',
      );
      await sql('grant emdo_app to finance_live_app');
      target.username = 'finance_live_app';
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

    afterAll(async () => {
      await restrictedApp?.end();
      await workerPool?.end();
      await dispatchPool?.end();
      await admin.end();
    });
    it(
      'persists one proposal and posts only after explicit synthetic source review',
      async () => {
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
            await evidence.createFinancialAccount(
              context,
              bookId,
              randomUUID(),
              {
                name: 'Synthetic bank',
                kind: 'bank',
                currency: 'CAD',
                ledgerAccountId: cash,
              },
            )
          ).id,
        );
        await evidence.createPeriod(context, bookId, randomUUID(), {
          startsOn: '2026-01-01',
          endsOn: '2026-12-31',
        });
        const run = await runs.start(context, bookId, randomUUID(), {
          evidenceId,
          expectedSourceDigest: standardizationDigest,
        });
        const delivery = (await deliveries.claim(1))[0]!;
        expect(delivery.runId).toBe(run.id);
        const recordedArtifact = recorded
          ? z
              .object({
                scope: z.literal('live-synthetic-provider'),
                sourceSha256: z.literal(standardizationDigest),
                runId: z.uuid(),
                evidenceId: z.uuid(),
                originalMappingId: z.uuid(),
                receipt: z.object({
                  providerResponseId: z.string().regex(/^resp_/),
                  model: z.literal('gpt-6-astra'),
                  inputTokens: z.number().int().nonnegative(),
                  outputTokens: z.number().int().nonnegative(),
                }),
                candidate: z.object({
                  definition:
                    ProposedFinanceReportMappingSchema.shape.definition,
                  rationale: z.string(),
                  unresolved_questions: z.array(z.string()),
                }),
              })
              .parse(JSON.parse(await readFile(replayPath!, 'utf8')))
          : null;
        const apiKey =
          process.env.EMDO_OPENAI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY;
        if (live && !apiKey)
          throw new Error('finance-live-provider-credential-unavailable');
        const provider = createDurableFinanceProposalProvider(
          new OpenAIProvider({
            openAIClient: new OpenAI({
              apiKey: apiKey ?? 'synthetic-unused-key',
              maxRetries: 0,
              timeout: 90000,
            }),
            useResponses: true,
            useResponsesWebSocket: false,
          }),
        );
        let calls = 0;
        let receipt:
          | {
              providerResponseId: string;
              inputTokens: number;
              outputTokens: number;
              model: string;
            }
          | undefined;
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
                throw new Error('finance-live-provider-call-limit');
              expect(input.model).toBe('gpt-6-astra');
              expect(input.reasoningEffort).toBe('medium');
              try {
                const result = z
                  .strictObject({
                    proposal: ProposedFinanceReportMappingSchema,
                    providerResponseId: z.string().min(1),
                    inputTokens: z.number().int().nonnegative(),
                    outputTokens: z.number().int().nonnegative(),
                    model: z.literal('gpt-6-astra'),
                  })
                  .parse(
                    live
                      ? await provider.generate(input)
                      : recordedArtifact
                        ? {
                            ...recordedArtifact.receipt,
                            proposal: {
                              definition: recordedArtifact.candidate.definition,
                              rationale: recordedArtifact.candidate.rationale,
                              unresolvedQuestions:
                                recordedArtifact.candidate.unresolved_questions,
                            },
                          }
                        : {
                            proposal: {
                              ...standardizationProposal,
                              definition: {
                                ...standardizationProposal.definition,
                                headers: [
                                  'Booked on',
                                  'Details',
                                  'Net cash',
                                  'CCY',
                                ],
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
                          },
                  );
                receipt = {
                  providerResponseId: result.providerResponseId,
                  inputTokens: result.inputTokens,
                  outputTokens: result.outputTokens,
                  model: result.model,
                };
                return result;
              } catch (error) {
                const status =
                  error &&
                  typeof error === 'object' &&
                  'status' in error &&
                  typeof error.status === 'number'
                    ? error.status
                    : 'unavailable';
                const name =
                  error instanceof Error &&
                  /^[A-Za-z][A-Za-z0-9]{0,60}$/.test(error.name)
                    ? error.name
                    : 'unknown';
                process.stdout.write(
                  JSON.stringify({
                    event: 'finance-live-provider-failure',
                    status,
                    name,
                    ...(error instanceof z.ZodError
                      ? {
                          issues: error.issues.map((issue) => ({
                            code: issue.code,
                            path: issue.path.map((part) =>
                              /^[A-Za-z0-9_-]{1,80}$/.test(String(part))
                                ? String(part)
                                : 'redacted',
                            ),
                          })),
                        }
                      : {}),
                  }) + '\n',
                );
                throw new Error('finance-live-provider-result-unverified');
              }
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
          propose: async (input, controls) => {
            const result = await hook(input, controls);
            process.stdout.write(
              JSON.stringify({
                event: 'finance-live-hook-outcome',
                status: result.status,
                reason: result.status === 'proposed' ? null : result.reason,
                providerCalls: live ? calls : 0,
                fixtureCalls: !live && !recorded ? calls : 0,
                recordedProviderReplays: recorded ? calls : 0,
              }) + '\n',
            );
            return result;
          },
        });
        expect(
          await worker({
            schemaVersion: 1,
            runId: run.id,
            deliveryRevision: delivery.deliveryRevision,
          }),
        ).toBe('needs-review');
        expect(calls).toBe(1);
        expect(receipt?.providerResponseId).toMatch(/^resp_/);
        const saved = await runs.get(context, bookId, run.id);
        expect(saved).toMatchObject({
          status: 'needs-review',
          approval: 'not-granted',
          posting: 'not-performed',
          proposal: { status: 'candidate' },
        });
        expect(
          (await evidence.overview(context, bookId)).journals,
        ).toHaveLength(0);
        const originalMappingId = saved.proposal?.mappingId;
        let mappingId = originalMappingId;
        if (!mappingId) throw new Error('finance-live-candidate-missing');
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
              cells: [
                '2026-09-15',
                'Synthetic service receipt',
                '123.45',
                'CAD',
              ],
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
        const lineage = (
          await sql(
            'select lineage from emdo.finance_standardization_spend where run_id=$1',
            [run.id],
          )
        ).rows[0].lineage;
        expect(lineage.promptVersion).toBe(
          'finance-standardization-proposal.v5',
        );
        await expect(
          evidence.importMappedReport(
            context,
            bookId,
            mappingId,
            randomUUID(),
            {
              evidenceId,
              financialAccountId,
              expectedMappingVersion: Number(candidate.mapping.version),
              providerKey: String(candidate.mapping.provider_key),
            },
          ),
        ).rejects.toThrow();
        const artifactPath = join(
          tmpdir(),
          `emdo-finance-normalization-${run.id}.json`,
        );
        await writeFile(
          artifactPath,
          JSON.stringify(
            {
              scope: live
                ? 'live-synthetic-provider'
                : recorded
                  ? 'recorded-provider-replay'
                  : 'deterministic-provider-fixture',
              receipt,
              sourceSha256: standardizationDigest,
              runId: run.id,
              evidenceId,
              originalMappingId,
              candidate: candidate.mapping,
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
        process.stdout.write(
          JSON.stringify({
            event: 'finance-synthetic-candidate-captured',
            artifactPath,
            liveProvider: live,
          }) + '\n',
        );
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
        let reviewedRationale =
          'Synthetic reviewer inspected the complete two-row CSV: all four headings are mapped; yyyy-mm-dd dates, period decimal amounts and explicit CAD values match every cell. Both source rows are preserved. Provider/report labels are synthetic mapping identifiers, not assertions of an external bank. This resolves the heading/format and source-completeness caveats against the full original.';
        if (live && liveReviewDirectory) {
          if (!isAbsolute(liveReviewDirectory))
            throw new Error('finance-live-review-directory-must-be-absolute');
          const reviewPath = join(liveReviewDirectory, `${run.id}.review.json`);
          process.stdout.write(
            JSON.stringify({
              event: 'finance-live-awaiting-authored-source-review',
              artifactPath,
              reviewPath,
              runId: run.id,
              sourceSha256: standardizationDigest,
            }) + '\n',
          );
          const deadline = Date.now() + 180_000;
          let review: unknown;
          while (Date.now() < deadline) {
            try {
              const file = await open(
                reviewPath,
                constants.O_RDONLY | constants.O_NOFOLLOW,
              );
              try {
                const stat = await file.stat();
                if (
                  !stat.isFile() ||
                  stat.size > 16_384 ||
                  (stat.mode & 0o077) !== 0 ||
                  stat.uid !== process.getuid?.()
                )
                  throw new Error('finance-live-review-private-file-required');
                review = JSON.parse(await file.readFile('utf8'));
              } finally {
                await file.close();
              }
              break;
            } catch (error) {
              if (!(
                error &&
                typeof error === 'object' &&
                'code' in error &&
                error.code === 'ENOENT'
              ))
                throw error;
              await new Promise((resolve) => setTimeout(resolve, 500));
            }
          }
          const checked = z
            .strictObject({
              schemaVersion: z.literal(1),
              decision: z.literal('approve-authored-synthetic-mapping'),
              runId: z.literal(run.id),
              sourceSha256: z.literal(standardizationDigest),
              originalMappingId: z.literal(originalMappingId),
              answers: z.array(
                z.strictObject({
                  question: z.string(),
                  answer: z.string().min(1).max(1000),
                }),
              ),
              rationale: z.string().min(1).max(2000),
            })
            .parse(review);
          if (
            JSON.stringify(checked.answers.map((answer) => answer.question)) !==
            JSON.stringify(questions)
          )
            throw new Error('finance-live-review-question-binding-mismatch');
          reviewedRationale = checked.rationale;
          await writeFile(
            `${artifactPath}.authored-review.json`,
            JSON.stringify(checked, null, 2),
            { mode: 0o600 },
          );
        } else if (
          questions.some((question) => !knownReviewQuestions.has(question))
        )
          throw new Error(
            'finance-live-review-requires-explicit-question-resolution',
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
              rationale: reviewedRationale,
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
          imported = await evidence.getNormalizedImport(
            context,
            bookId,
            batchId,
          );
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
        expect(
          (await evidence.overview(context, bookId)).journals,
        ).toHaveLength(0);
        await evidence.commitNormalizedImport(
          context,
          bookId,
          batchId,
          randomUUID(),
          { expectedRevision: Number(reviewed.batch.revision) },
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
        expect(postings.map((p) => p.functionalCurrency)).toEqual([
          'CAD',
          'CAD',
        ]);
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
        process.stdout.write(
          JSON.stringify({
            event: live
              ? 'finance-live-local-normalization-posting-verified'
              : recorded
                ? 'finance-recorded-provider-replay-posting-verified'
                : 'finance-deterministic-local-normalization-posting-verified',
            recordedProviderReplay: recorded,
            ...(recordedArtifact
              ? {
                  originalLiveReceipt: {
                    ...recordedArtifact.receipt,
                    runId: recordedArtifact.runId,
                    evidenceId: recordedArtifact.evidenceId,
                    mappingId: recordedArtifact.originalMappingId,
                  },
                }
              : {}),
            liveProvider: live,
            originalMappingId,
            ...receipt,
            reasoningEffort: 'medium',
            promptVersion: lineage.promptVersion,
            sourceSha256: standardizationDigest,
            runId: run.id,
            evidenceId,
            mappingId,
            batchId,
            rowIds: posted.rows.map((row) => row.id),
            journalIds: postings.map((p) => p.journalId),
            economicTransactionIds: postings.map(
              (p) => p.economicTransactionId,
            ),
            providerCalls: live ? calls : 0,
            fixtureCalls: !live && !recorded ? calls : 0,
            recordedProviderReplays: recorded ? calls : 0,
            scope: 'local-disposable-synthetic',
            explicitSyntheticReview: true,
          }) + '\n',
        );
      },
      live && liveReviewDirectory ? 300000 : 110000,
    );
  },
);

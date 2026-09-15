import { spawnSync } from 'node:child_process';
import { projectFinanceImagePrompt } from '../../../packages/agent-core/src/finance-image-prompt-projection.js';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresFinanceV2Repository } from '../../../packages/db/src/finance-v2-repository.js';
import { PostgresFinanceStandardizationRepository } from '../../../packages/db/src/finance-standardization-repository.js';
import { PostgresFinanceStandardizationExecutionRepository } from '../../../packages/db/src/finance-standardization-execution-repository.js';
import {
  FinanceBookEvidenceCrypto,
  EncryptedFinanceBookEvidenceSchema,
  extractReviewedFinanceImageTable,
} from '@emdo/integrations/finance-documents';
import { InMemoryVaultKeyProvider } from '../../../packages/integrations/src/vault/crypto.js';
import {
  FinanceStandardizationClaimSchema,
  type WorkspaceContext,
} from '@emdo/contracts';
import { extractFinanceStandardizationSource } from './finance-standardization-extraction.js';
const url = process.env.FINANCE_V2_TEST_DATABASE_URL;
const nativeImageRuntimeAvailable =
  spawnSync('magick', ['-version'], { stdio: 'ignore', timeout: 2000 })
    .status === 0 &&
  spawnSync('tesseract', ['--version'], { stdio: 'ignore', timeout: 2000 })
    .status === 0;
describe.skipIf(!url || !nativeImageRuntimeAvailable)(
  'Image original to saved OCR to reviewed import under restricted roles',
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
        new Uint8Array(32).fill(52),
        'finance-documents.v1',
      ),
    );
    const pool = {
      async connect() {
        const c = await admin.connect();
        await c.query('set role emdo_app');
        return c;
      },
    };
    const repo = new PostgresFinanceV2Repository(pool, {
      reviewedImageExtractor: extractReviewedFinanceImageTable,
      evidenceCipher: {
        encrypt: (v, s) => cipher.encrypt(v, s),
        decrypt: (v, s) =>
          cipher.decrypt(EncryptedFinanceBookEvidenceSchema.parse(v), s),
      },
    });
    const runs = new PostgresFinanceStandardizationRepository(pool);
    let worker: pg.Pool,
      store: PostgresFinanceStandardizationExecutionRepository,
      bookId: string,
      accountId: string;
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
        "insert into emdo.auth_users(id,name,email,email_verified) values($1,'Image',$2,true)",
        [context.userId, `${context.userId}@example.test`],
      );
      await sql(
        "insert into emdo.households(id,name,slug,created_by_user_id) values($1,'Image',$2,$3)",
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
          await repo.createBook(context, 'image-book', {
            name: 'Image review',
            entityName: 'Owner',
            entityKind: 'individual',
            country: 'CA',
            functionalCurrency: 'CAD',
          })
        ).id,
      );
      const ledger = await repo.createAccount(context, bookId, 'bank-ledger', {
        code: 'BANK',
        name: 'Bank',
        kind: 'asset',
      });
      accountId = String(
        (
          await repo.createFinancialAccount(context, bookId, 'bank', {
            name: 'Bank',
            kind: 'bank',
            currency: 'CAD',
            ledgerAccountId: ledger.id,
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
      await sql(
        "do $$ begin if not exists(select from pg_roles where rolname='emdo_worker_executor_login') then create role emdo_worker_executor_login login noinherit nosuperuser nobypassrls nocreatedb nocreaterole;end if;end $$",
      );
      await sql('grant emdo_worker_executor to emdo_worker_executor_login');
      const connection = new URL(url!);
      connection.username = 'emdo_worker_executor_login';
      worker = new pg.Pool({ connectionString: connection.toString() });
      store = new PostgresFinanceStandardizationExecutionRepository(
        {
          async connect() {
            const c = await worker.connect();
            await c.query('set role emdo_worker_executor');
            return c;
          },
        },
        (v, s) =>
          cipher.decrypt(EncryptedFinanceBookEvidenceSchema.parse(v), s),
      );
    });
    afterAll(async () => {
      await worker?.end();
      await admin.end();
    });
    it('keeps encrypted original and OCR distinct, requires source-bound candidate approval, replays the import command and denies wrong source/revoked access', async () => {
      const bytes = await readFile(
        new URL(
          '../../../packages/integrations/src/finance-documents/test-fixtures/image-statement.png',
          import.meta.url,
        ),
      );
      const digest = createHash('sha256').update(bytes).digest('hex');
      const uploaded = await repo.uploadBookEvidence(
        context,
        bookId,
        'image-original',
        {
          format: 'png',
          filename: 'statement.png',
          sourceBase64: bytes.toString('base64'),
        },
      );
      const evidenceId = String(uploaded.id);
      expect(
        await repo.downloadBookEvidence(context, bookId, evidenceId),
      ).toMatchObject({
        format: 'png',
        sourceBase64: bytes.toString('base64'),
      });
      const run = await runs.start(context, bookId, randomUUID(), {
        evidenceId,
        expectedSourceDigest: digest,
      });
      const claim = z
        .object({ claim: FinanceStandardizationClaimSchema })
        .parse(await store.claim(run.id, run.revision)).claim;
      const original = await store.readOriginal(claim);
      const extracted = await extractFinanceStandardizationSource({
        ...original,
        expectedSourceDigest: digest,
        revision: 1,
        signal: new AbortController().signal,
      });
      if (extracted.status !== 'extracted') throw new Error(extracted.reason);
      await store.saveExtraction(claim, extracted.summary, extracted.envelope);
      const inspected = await repo.readImageInspection(
        context,
        bookId,
        evidenceId,
        { standardizationRunId: run.id, extractionRevision: 1 },
      );
      expect(inspected.facts.text).toContain('12.50');
      const cells = inspected.facts.words.map((word) => ({
        region: word.box,
        words: [word],
        joiner: ' ',
        reviewedText: word.text,
        correctionReason: null,
        confirmedAgainstOriginal: true,
      }));
      const imageSelection = {
        expectedSourceDigest: digest,
        standardizationRunId: run.id,
        extractionRevision: 1,
        expectedExtractionDigest: inspected.extractionDigest,
        width: inspected.facts.width,
        height: inspected.facts.height,
        coordinateSpace: inspected.facts.coordinateSpace,
        reviewedWordInventoryDigest: inspected.wordInventoryDigest,
        headerCells: cells.slice(0, 4),
        rows: [{ cells: cells.slice(4) }],
        context: { asOf: null, currency: null },
        acknowledgeOcrUncertainty: true,
        acknowledgeUnselectedContent: true,
        confirmedHeaderAndContext: true,
      };
      const proposal = {
        definition: {
          providerKey: 'image-bank',
          reportName: 'Reviewed image',
          reportType: 'bank-transactions',
          layoutVersion: '1',
          imageSelection,
          headers: cells.slice(0, 4).map((c) => c.reviewedText),
          bindings: [
            ['transactionDate', 'Date'],
            ['description', 'Description'],
            ['amount', 'Amount'],
            ['currency', 'Currency'],
          ].map(([field, column]) => ({ field, column, context: null })),
          dateFormat: 'yyyy-mm-dd',
          decimalSeparator: '.',
          groupingSeparator: '',
          quantityUnit: null,
          valuationMultiplier: null,
          identifierScheme: null,
          identifierNamespace: null,
        },
        rationale: 'Reviewed all selected original regions.',
        unresolvedQuestions: [],
      };
      const projection = projectFinanceImagePrompt(
        inspected.facts,
        inspected.extractionDigest,
      )!.receipt;
      const lineage = {
        managerInvocationId: randomUUID(),
        financeInvocationId: randomUUID(),
        orchestrationMode: 'registered-workflow' as const,
        promptVersion: 'finance-standardization-proposal.v1' as const,
      };
      const spendInput = {
        requestKey: `image:${run.id}`,
        inputTokenCeiling: 20000,
        outputTokenCeiling: 4000,
        estimatedCadMinor: 100,
        pricingVersion: 'synthetic.v1',
        pricing: {
          inputCadMinorPerMillionTokens: 1000,
          outputCadMinorPerMillionTokens: 2000,
        },
        lineage,
      };
      await expect(store.reserveModelSpend(claim, spendInput)).rejects.toThrow(
        'projection',
      );
      const reserved = await store.reserveModelSpend(claim, {
        ...spendInput,
        lineage: { ...lineage, promptProjection: projection },
      });
      await store.markModelDispatch(claim, {
        reservationId: reserved.reservationId,
      });
      await store.settleModelSpend(claim, {
        reservationId: reserved.reservationId,
        outcome: 'completed',
        actualCadMinor: 1,
        providerResponseId: 'resp_synthetic_image',
      });
      const proposed = {
        proposal: {
          ...proposal,
          definition: { ...proposal.definition, imageSelection: null },
          unresolvedQuestions: ['Original image regions require human review.'],
        },
        provenance: {
          ...lineage,
          controller: 'emdo',
          model: 'gpt-6-astra',
          reasoningEffort: 'medium',
          providerResponseId: 'resp_synthetic_image',
          completedAt: new Date().toISOString(),
          promptProjection: projection,
        },
      };
      await expect(
        store.finish(
          claim,
          {
            ...proposed,
            provenance: {
              ...proposed.provenance,
              promptProjection: { ...projection, digest: 'f'.repeat(64) },
            },
          },
          null,
        ),
      ).rejects.toThrow('provenance');
      await store.finish(claim, proposed, null);
      expect((await runs.get(context, bookId, run.id)).proposal).toMatchObject({
        mappingId: null,
      });
      const mapping = await repo.saveReportMapping(
        context,
        bookId,
        'image-map',
        { evidenceId, proposal },
      );
      const linked = await runs.linkMapping(
        context,
        bookId,
        run.id,
        randomUUID(),
        {
          expectedRevision: (await runs.get(context, bookId, run.id)).revision,
          mappingId: mapping.id,
        },
      );
      expect(linked.reviewedMapping?.mappingId).toBe(mapping.id);
      const input = {
        evidenceId,
        financialAccountId: accountId,
        expectedMappingVersion: 1,
        providerKey: 'image-bank',
      };
      await expect(
        repo.importMappedReport(
          context,
          bookId,
          String(mapping.id),
          'before-review',
          input,
        ),
      ).rejects.toThrow('approved');
      await repo.reviewReportMapping(
        context,
        bookId,
        String(mapping.id),
        'approve-image',
        {
          expectedRevision: 1,
          decision: 'approve',
          reason:
            'Verified the original pixels and all selected field meanings.',
        },
      );
      const imported = await repo.importMappedReport(
        context,
        bookId,
        String(mapping.id),
        'image-import',
        input,
      );
      expect(imported).toMatchObject({
        status: 'review',
        rowCount: 1,
      });
      expect(
        await repo.importMappedReport(
          context,
          bookId,
          String(mapping.id),
          'image-import',
          input,
        ),
      ).toEqual(imported);
      const detail = await repo.getNormalizedImport(
        context,
        bookId,
        String(imported.id),
      );
      expect(JSON.stringify(detail)).toContain(
        'human-reviewed-visual-transcription',
      );
      expect(JSON.stringify(detail)).toContain('12.50');
      await expect(
        repo.readImageInspection(context, bookId, evidenceId, {
          standardizationRunId: randomUUID(),
          extractionRevision: 1,
        }),
      ).rejects.toThrow();
      await expect(
        repo.saveReportMapping(context, bookId, 'image-stale', {
          evidenceId,
          proposal: {
            ...proposal,
            definition: {
              ...proposal.definition,
              imageSelection: {
                ...imageSelection,
                expectedExtractionDigest: 'f'.repeat(64),
              },
            },
          },
        }),
      ).rejects.toThrow('binding');
      const fallbackEvidence = await repo.uploadBookEvidence(
        context,
        bookId,
        'fallback-image',
        {
          format: 'png',
          filename: 'fallback.png',
          sourceBase64: bytes.toString('base64'),
        },
      );
      const fallbackRun = await runs.start(context, bookId, randomUUID(), {
        evidenceId: fallbackEvidence.id,
        expectedSourceDigest: digest,
      });
      const fallbackClaim = z
        .object({ claim: FinanceStandardizationClaimSchema })
        .parse(await store.claim(fallbackRun.id, fallbackRun.revision)).claim;
      await store.saveExtraction(
        fallbackClaim,
        extracted.summary,
        extracted.envelope,
      );
      await store.block(
        fallbackClaim,
        'blocked',
        'The minimum complete-line projection exceeds the model budget. Review the original image manually.',
      );
      const fallbackSaved = await runs.get(context, bookId, fallbackRun.id);
      expect(fallbackSaved.allowedActions).toContain('review-source');
      const fallbackMapping = await repo.saveReportMapping(
        context,
        bookId,
        'fallback-map',
        {
          evidenceId: fallbackEvidence.id,
          proposal: {
            ...proposal,
            definition: {
              ...proposal.definition,
              imageSelection: {
                ...imageSelection,
                standardizationRunId: fallbackRun.id,
              },
            },
          },
        },
      );
      const manual = await runs.linkMapping(
        context,
        bookId,
        fallbackRun.id,
        randomUUID(),
        {
          expectedRevision: fallbackSaved.revision,
          mappingId: fallbackMapping.id,
        },
      );
      expect(manual).toMatchObject({
        status: 'blocked',
        modelProvenance: null,
        reviewedMapping: { mappingId: fallbackMapping.id },
      });
      const c = await pool.connect();
      try {
        await expect(
          c.query('select * from emdo.finance_standardization_extractions'),
        ).rejects.toThrow('permission denied');
      } finally {
        c.release();
      }
      await sql(
        "update emdo.household_memberships set status='inactive',ended_at=now() where household_id=$1 and user_id=$2",
        [context.workspaceId, context.userId],
      );
      await expect(
        repo.readImageInspection(context, bookId, evidenceId, {
          standardizationRunId: run.id,
          extractionRevision: 1,
        }),
      ).rejects.toThrow();
    }, 30000);
  },
);

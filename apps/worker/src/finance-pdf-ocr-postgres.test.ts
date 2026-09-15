import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
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
  verifyFinancePdfOcrEvidence,
  extractReviewedFinancePdfOcrTable,
} from '@emdo/integrations/finance-documents';
import { InMemoryVaultKeyProvider } from '../../../packages/integrations/src/vault/crypto.js';
import type { WorkspaceContext } from '@emdo/contracts';
import { financePdfFixture } from '../../../packages/integrations/src/finance-documents/test-fixtures/pdf.js';
import { renderFinancePdfPage } from '../../../packages/integrations/src/finance-documents/pdf-page-render.js';
import { createFinanceStandardizationWorker } from './finance-standardization-worker.js';
import type { FinanceImageOcrWorkerAdapter } from './finance-image-ocr.js';
import {
  standardizationProposal,
  standardizationProvenance,
} from './finance-standardization.test-fixtures.js';
const hash = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
const pdfBytes = financePdfFixture([['Synthetic embedded context'], [], []]);
const digest = hash(pdfBytes);
// Deterministic OCR observations test storage/review provenance, not OCR accuracy.
const imageOcr: FinanceImageOcrWorkerAdapter = {
  extract: async (input) => {
    const png = Buffer.from(input.bytes),
      width = png.readUInt32BE(16),
      height = png.readUInt32BE(20);
    const words = [
      'date',
      'description',
      'amount',
      'currency',
      '2026-09-01',
      'Purchase',
      '12.50',
      'CAD',
    ].map((text, index) => ({
      id: `image-page-1-word-${index + 1}`,
      text,
      page: 1 as const,
      block: 1,
      paragraph: 1,
      line: index < 4 ? 1 : 2,
      word: (index % 4) + 1,
      coordinateSpace: 'image-pixels-top-left' as const,
      confidence: 0.9,
      confidenceStatus: 'high' as const,
      sourceAnchor: `word-${index + 1}`,
      box: {
        x: 10 + (index % 4) * 150,
        y: index < 4 ? 10 : 50,
        width: 140,
        height: 20,
      },
    }));
    return {
      status: 'extracted',
      qualityStatus: 'uncertain',
      format: 'png',
      sourceDigest: input.expectedSourceDigest,
      pageCount: 1,
      dimensions: {
        width,
        height,
        pixelCount: width * height,
        frameCount: 1,
        orientation: 'TopLeft',
      },
      width,
      height,
      coordinateSpace: 'image-pixels-top-left',
      engine: {
        id: 'tesseract',
        version: 'fixture',
        languages: ['eng'],
        trainedData: [{ language: 'eng', sha256: 'a'.repeat(64) }],
      },
      text: words.map((w) => w.text).join(' '),
      words,
      truncated: false,
      textBasis: 'machine-transcription-requires-review',
      issues: ['Synthetic observations require original review'],
      candidate: {
        kind: 'ocr-text',
        authority: 'untrusted-source-data',
        reviewStatus: 'needs-source-review',
        normalized: false,
        sourceSelection: null,
      },
    };
  },
};
const url = process.env.FINANCE_V2_TEST_DATABASE_URL;
describe.skipIf(!url)(
  'PDF OCR saved evidence and reviewed mapping under restricted PostgreSQL roles',
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
      pdfOcrEvidenceVerifier: verifyFinancePdfOcrEvidence,
      reviewedPdfOcrExtractor: extractReviewedFinancePdfOcrTable,
      pdfOcrPageRenderer: renderFinancePdfPage,
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
          filename: 'mixed.pdf',
          format: 'pdf',
          sourceBase64: pdfBytes.toString('base64'),
        },
      );
      evidenceId = String(original.id);
      expect(original.sourceDigest).toBe(digest);
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
    it('saves mixed original-bound facts through the claimed worker, settles v2 spend, and links only an explicitly reviewed current page mapping', async () => {
      expect(
        await evidence.downloadBookEvidence(context, bookId, evidenceId),
      ).toMatchObject({
        format: 'pdf',
        sourceBase64: pdfBytes.toString('base64'),
      });
      const encrypted = (
        await sql(
          'select encrypted_original from emdo.finance_book_evidence where id=$1',
          [evidenceId],
        )
      ).rows[0];
      expect(JSON.stringify(encrypted)).not.toContain(
        pdfBytes.toString('base64'),
      );
      const key = randomUUID(),
        startInput = { evidenceId, expectedSourceDigest: digest };
      const run = await runs.start(context, bookId, key, startInput);
      expect(await runs.start(context, bookId, key, startInput)).toEqual(run);
      const delivery = await deliveryFor(run.id);
      const provenance = {
        ...standardizationProvenance,
        promptVersion: 'finance-standardization-proposal.v2' as const,
        completedAt: new Date().toISOString(),
      };
      const propose = vi.fn<
        Parameters<typeof createFinanceStandardizationWorker>[0]['propose']
      >(async ({ claim, extraction }, controls) => {
        expect(extraction.kind).toBe('pdf-ocr');
        const saved = verifyFinancePdfOcrEvidence({
          factsJson: extraction.factsJson,
          expectedExtractionDigest: extraction.extractionDigest,
          expectedSourceDigest: digest,
        });
        expect(saved.inventory.pages.map((p) => p.kind)).toEqual([
          'embedded-text',
          'ocr',
          'unresolved',
        ]);
        expect(
          await controls.verifyAuthority(claim, {
            extractionRevision: extraction.revision,
            extractionDigest: extraction.extractionDigest,
          }),
        ).toBe(true);
        const { reservationId } = await controls.reserveModelSpend({
          requestKey: `pdf:${run.id}`,
          inputTokenCeiling: 20000,
          outputTokenCeiling: 4000,
          estimatedCadMinor: 100,
          pricingVersion: 'synthetic.v1',
          pricing: {
            inputCadMinorPerMillionTokens: 1000,
            outputCadMinorPerMillionTokens: 2000,
          },
          lineage: {
            managerInvocationId: provenance.managerInvocationId,
            financeInvocationId: provenance.financeInvocationId,
            orchestrationMode: 'registered-workflow',
            promptVersion: provenance.promptVersion,
          },
        });
        await controls.markModelDispatch({ reservationId });
        await controls.settleModelSpend({
          reservationId,
          outcome: 'completed',
          actualCadMinor: 1,
          providerResponseId: provenance.providerResponseId,
        });
        return {
          status: 'proposed',
          proposal: standardizationProposal,
          provenance,
        };
      });
      const worker = createFinanceStandardizationWorker({
        store,
        propose,
        imageOcr,
        pdfRenderer: {
          render: (input) =>
            input.pageNumber === 3
              ? Promise.resolve({
                  status: 'unavailable',
                  reason: 'synthetic unresolved page',
                })
              : renderFinancePdfPage(input),
        },
      });
      const job = {
        schemaVersion: 1 as const,
        runId: run.id,
        deliveryRevision: delivery.deliveryRevision,
      };
      const result = await worker(job);
      if (propose.mock.results[0]?.type === 'return')
        await propose.mock.results[0].value;
      expect(
        result,
        JSON.stringify(await runs.get(context, bookId, run.id)),
      ).toBe('needs-review');
      await worker(job);
      expect(propose).toHaveBeenCalledTimes(1);
      const completed = await runs.get(context, bookId, run.id);
      expect(completed.modelProvenance?.promptVersion).toBe(
        'finance-standardization-proposal.v2',
      );
      expect(completed.proposal?.mappingId).toBeNull();
      const inspected = await evidence.readPdfOcrInspection(
        context,
        bookId,
        evidenceId,
        { standardizationRunId: run.id, extractionRevision: 1 },
      );
      expect(inspected.inventory.pages.map((p) => p.kind)).toEqual([
        'embedded-text',
        'ocr',
        'unresolved',
      ]);
      const page = inspected.inventory.pages[1]!;
      if (page.kind !== 'ocr') throw new Error('expected reviewed OCR page');
      const facts = page.result.ocr;
      const cell = (word: (typeof facts.words)[number]) => ({
        region: word.box,
        words: [word],
        joiner: ' ' as const,
        reviewedText: word.text,
        correctionReason: null,
        confirmedAgainstOriginal: true as const,
      });
      const imageSelection = {
        expectedSourceDigest: page.result.render.renderedImageDigest,
        standardizationRunId: run.id,
        extractionRevision: 1,
        expectedExtractionDigest: hash(JSON.stringify(facts)),
        width: facts.width,
        height: facts.height,
        coordinateSpace: facts.coordinateSpace,
        reviewedWordInventoryDigest: hash(JSON.stringify(facts.words)),
        headerCells: facts.words.slice(0, 4).map(cell),
        rows: [{ cells: facts.words.slice(4).map(cell) }],
        context: { asOf: null, currency: null },
        acknowledgeOcrUncertainty: true,
        acknowledgeUnselectedContent: true,
        confirmedHeaderAndContext: true,
      };
      const selection = {
        expectedSourceDigest: digest,
        standardizationRunId: run.id,
        extractionRevision: 1,
        expectedExtractionDigest: inspected.extractionDigest,
        pageNumber: 2,
        acknowledgeOtherPages: true,
        imageSelection,
      };
      const proposal = {
        ...standardizationProposal,
        definition: {
          ...standardizationProposal.definition,
          pdfOcrSelection: selection,
        },
        unresolvedQuestions: [],
      };
      for (const change of [
        { expectedExtractionDigest: 'f'.repeat(64) },
        { pageNumber: 1 },
        { extractionRevision: 2 },
      ]) {
        await expect(async () =>
          evidence.saveReportMapping(context, bookId, randomUUID(), {
            evidenceId,
            proposal: {
              ...proposal,
              definition: {
                ...proposal.definition,
                pdfOcrSelection: { ...selection, ...change },
              },
            },
          }),
        ).rejects.toThrow();
      }
      const mappingKey = randomUUID();
      const mapping = await evidence.saveReportMapping(
        context,
        bookId,
        mappingKey,
        { evidenceId, proposal },
      );
      expect(
        await evidence.saveReportMapping(context, bookId, mappingKey, {
          evidenceId,
          proposal,
        }),
      ).toEqual(mapping);
      await expect(
        runs.linkMapping(context, bookId, run.id, randomUUID(), {
          expectedRevision: completed.revision + 1,
          mappingId: mapping.id,
        }),
      ).rejects.toThrow();
      const linkKey = randomUUID(),
        linkInput = {
          expectedRevision: completed.revision,
          mappingId: mapping.id,
        };
      const linked = await runs.linkMapping(
        context,
        bookId,
        run.id,
        linkKey,
        linkInput,
      );
      expect(linked.reviewedMapping?.mappingId).toBe(mapping.id);
      expect(
        await runs.linkMapping(context, bookId, run.id, linkKey, linkInput),
      ).toEqual(linked);
      const savedExample = (
        await sql(
          'select example from emdo.finance_report_mapping_versions where id=$1',
          [mapping.id],
        )
      ).rows[0]!.example;
      await expect(
        evidence.applyReportMapping(
          context,
          bookId,
          String(mapping.id),
          savedExample,
        ),
      ).rejects.toThrow('approved-mapping-required');
      await evidence.reviewReportMapping(
        context,
        bookId,
        String(mapping.id),
        randomUUID(),
        {
          expectedRevision: mapping.revision,
          decision: 'approve',
          reason: 'Verified synthetic original page and column meanings',
        },
      );
      const normalized = await evidence.applyReportMapping(
        context,
        bookId,
        String(mapping.id),
        savedExample,
      );
      expect(normalized).toMatchObject({
        status: 'normalized',
        commitAuthority: 'none',
      });
      if (normalized.status !== 'normalized')
        throw new Error('expected normalized reviewed PDF');
      expect(normalized.rows).toHaveLength(1);
      expect(normalized.rows[0]?.provenance.amount?.pdfOcrSource).toMatchObject(
        {
          originalPageNumber: 2,
          rasterCell: { reviewedText: '12.50' },
        },
      );
      const ledger = await evidence.createAccount(
        context,
        bookId,
        randomUUID(),
        {
          code: '1100',
          name: 'Reviewed bank',
          kind: 'asset',
        },
      );
      const account = await evidence.createFinancialAccount(
        context,
        bookId,
        randomUUID(),
        {
          name: 'Reviewed bank',
          kind: 'bank',
          currency: 'CAD',
          ledgerAccountId: ledger.id,
        },
      );
      const importKey = randomUUID();
      const importInput = {
        evidenceId,
        financialAccountId: account.id,
        expectedMappingVersion: mapping.version,
        providerKey: 'test-bank',
      };
      const batch = await evidence.importMappedReport(
        context,
        bookId,
        String(mapping.id),
        importKey,
        importInput,
      );
      expect(batch).toMatchObject({ status: 'review', rowCount: 1 });
      expect(
        await evidence.importMappedReport(
          context,
          bookId,
          String(mapping.id),
          importKey,
          importInput,
        ),
      ).toEqual(batch);
      const persisted = await evidence.getNormalizedImport(
        context,
        bookId,
        String(batch.id),
      );
      expect(persisted.rows).toHaveLength(1);
      expect(persisted.rows[0]).toMatchObject({
        status: 'review',
        amount: expect.stringMatching(/^12\.50(?:0*)$/),
        source_facts: {
          provenance: {
            amount: {
              pdfOcrSource: {
                originalPageNumber: 2,
                rasterCell: { reviewedText: '12.50' },
              },
            },
          },
        },
      });
      await expect(
        evidence.readPdfOcrInspection(context, bookId, evidenceId, {
          standardizationRunId: run.id,
          extractionRevision: 2,
        }),
      ).rejects.toThrow();
      await expect(
        evidence.readPdfOcrInspection(context, bookId, evidenceId, {
          standardizationRunId: randomUUID(),
          extractionRevision: 1,
        }),
      ).rejects.toThrow();
      await sql(
        "update emdo.household_memberships set status='inactive',ended_at=now() where household_id=$1 and user_id=$2",
        [context.workspaceId, context.userId],
      );
      await expect(
        evidence.readPdfOcrInspection(context, bookId, evidenceId, {
          standardizationRunId: run.id,
          extractionRevision: 1,
        }),
      ).rejects.toThrow();
      await expect(
        evidence.saveReportMapping(context, bookId, randomUUID(), {
          evidenceId,
          proposal,
        }),
      ).rejects.toThrow();
    }, 30000);
  },
);

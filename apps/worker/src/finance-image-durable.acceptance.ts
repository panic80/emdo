import { projectFinanceImagePrompt } from '../../../packages/agent-core/src/finance-image-prompt-projection.js';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import assert from 'node:assert/strict';
import { parseFinanceDecimal } from '@emdo/domains/finance';
import { readFile } from 'node:fs/promises';
import { createFinanceImageOcrWorkerAdapter } from './finance-image-ocr.js';
import { readFinanceImageOcrApprovedRuntimeManifest } from './finance-image-ocr-isolated.js';
import { extractReviewedFinanceImageTable } from '../../../packages/integrations/src/finance-documents/reviewed-image-table.js';
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
import { type WorkspaceContext } from '@emdo/contracts';
import { createFinanceStandardizationWorker } from './finance-standardization-worker.js';
import {
  standardizationProposal,
  standardizationProvenance,
} from './finance-standardization.test-fixtures.js';
const url = process.env.FINANCE_V2_TEST_DATABASE_URL;
// Provider-free synthetic acceptance. No provider is contacted.
async function main() {
  const admin = new pg.Pool({ connectionString: url });
  const context: WorkspaceContext = {
    workspaceId: randomUUID(),
    userId: randomUUID(),
    sessionId: randomUUID(),
    requestId: randomUUID(),
  };
  const originalBytes = await readFile('/proof/statement.png');
  const sourceDigest = createHash('sha256').update(originalBytes).digest('hex');
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
    reviewedImageExtractor: extractReviewedFinanceImageTable,
    evidenceCipher: {
      encrypt: (v, s) => cipher.encrypt(v, s),
      decrypt: (v, s) =>
        cipher.decrypt(EncryptedFinanceBookEvidenceSchema.parse(v), s),
    },
  });
  const runs = new PostgresFinanceStandardizationRepository(appPool);
  let workerPool!: pg.Pool,
    dispatchPool!: pg.Pool,
    store!: PostgresFinanceStandardizationExecutionRepository,
    deliveries!: PostgresFinanceStandardizationDeliveryRepository,
    bookId!: string,
    evidenceId!: string;
  async function sql(query: string, values: unknown[] = []) {
    const c = await admin.connect();
    try {
      await c.query('reset role');
      return await c.query(query, values);
    } finally {
      c.release();
    }
  }
  async function setup() {
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
      (v, s) => cipher.decrypt(EncryptedFinanceBookEvidenceSchema.parse(v), s),
    );
    deliveries = new PostgresFinanceStandardizationDeliveryRepository(
      scoped(dispatchPool, 'emdo_worker_dispatch_executor'),
    );
    assert.equal(await runs.checkReady(), true);
    await store.checkReady();
    await deliveries.checkReady();
    const original = await evidence.uploadBookEvidence(
      context,
      bookId,
      'standardization-original',
      {
        filename: 'statement.png',
        format: 'png',
        sourceBase64: originalBytes.toString('base64'),
      },
    );
    evidenceId = String(original.id);
    assert.equal(original.sourceDigest, sourceDigest);
  }
  try {
    await setup();
    const run = await runs.start(context, bookId, randomUUID(), {
      evidenceId,
      expectedSourceDigest: sourceDigest,
    });
    const delivery = (await deliveries.claim(20)).find(
      (d) => d.runId === run.id,
    );
    assert.ok(delivery);
    const imageOcr = createFinanceImageOcrWorkerAdapter({
      isolatedHelper: {
        approvedManifest: await readFinanceImageOcrApprovedRuntimeManifest(),
      },
    });
    const provenance = {
      ...standardizationProvenance,
      providerResponseId: 'provider-free-fixture-no-provider-call',
    };
    const worker = createFinanceStandardizationWorker({
      store,
      imageOcr,
      propose: async ({ claim, extraction }, controls) => {
        const promptProjection = projectFinanceImagePrompt(
          JSON.parse(extraction.factsJson),
          extraction.extractionDigest,
        )!.receipt;
        assert.equal(
          await controls.verifyAuthority(claim, {
            extractionRevision: extraction.revision,
            extractionDigest: extraction.extractionDigest,
          }),
          true,
        );
        const { reservationId } = await controls.reserveModelSpend({
          requestKey: `fixture:${claim.runId}`,
          inputTokenCeiling: 20000,
          outputTokenCeiling: 4000,
          estimatedCadMinor: 100,
          pricingVersion: 'provider-free-fixture.v1',
          pricing: {
            inputCadMinorPerMillionTokens: 1000,
            outputCadMinorPerMillionTokens: 2000,
          },
          lineage: {
            managerInvocationId: provenance.managerInvocationId,
            financeInvocationId: provenance.financeInvocationId,
            orchestrationMode: 'registered-workflow',
            promptVersion: 'finance-standardization-proposal.v1',
            promptProjection,
          },
        });
        await controls.markModelDispatch({ reservationId });
        await controls.settleModelSpend({
          reservationId,
          outcome: 'completed',
          actualCadMinor: 0,
          providerResponseId: provenance.providerResponseId,
        });
        return {
          status: 'proposed',
          proposal: standardizationProposal,
          provenance: { ...provenance, promptProjection },
        };
      },
    });
    const payload = {
      schemaVersion: 1 as const,
      runId: run.id,
      deliveryRevision: delivery.deliveryRevision,
    };
    assert.equal(await worker(payload), 'needs-review');
    assert.equal(await worker(payload), 'duplicate');
    const saved = await runs.get(context, bookId, run.id);
    assert.equal(saved.approval, 'not-granted');
    assert.equal(saved.posting, 'not-performed');
    const inspection = await evidence.readImageInspection(
      context,
      bookId,
      evidenceId,
      { standardizationRunId: run.id, extractionRevision: 1 },
    );
    assert.equal(inspection.sourceDigest, sourceDigest);
    assert.match(inspection.facts.text, /123\.45/);
    const extraction = (
      await sql(
        'select * from emdo.finance_standardization_extractions where run_id=$1',
        [run.id],
      )
    ).rows[0];
    assert.equal(
      createHash('sha256').update(extraction.envelope.factsJson).digest('hex'),
      extraction.extraction_digest,
    );
    const facts = inspection.facts;
    // Exact synthetic fixture cells were visually reviewed when authored.
    // This explicit review is separate from the provider-free candidate.
    const selectCell = (text: string) => {
      const words = facts.words.filter((word) => word.text === text);
      assert.equal(words.length, 1, `Expected unique source word ${text}`);
      return {
        region: words[0]!.box,
        words,
        joiner: ' ' as const,
        reviewedText: text,
        correctionReason: null,
        confirmedAgainstOriginal: true,
      };
    };
    const headers = ['Date', 'Description', 'Amount', 'Currency'];
    const imageSelection = {
      expectedSourceDigest: sourceDigest,
      standardizationRunId: run.id,
      extractionRevision: 1,
      expectedExtractionDigest: extraction.extraction_digest,
      width: facts.width,
      height: facts.height,
      coordinateSpace: facts.coordinateSpace,
      reviewedWordInventoryDigest: createHash('sha256')
        .update(JSON.stringify(facts.words))
        .digest('hex'),
      headerCells: headers.map(selectCell),
      rows: [
        { cells: ['2026-09-01', 'Deposit', '123.45', 'CAD'].map(selectCell) },
      ],
      context: { asOf: null, currency: null },
      acknowledgeOcrUncertainty: true,
      acknowledgeUnselectedContent: true,
      confirmedHeaderAndContext: true,
    };
    const proposal = {
      definition: {
        ...standardizationProposal.definition,
        headers,
        bindings: [
          { field: 'transactionDate', column: 'Date', context: null },
          { field: 'description', column: 'Description', context: null },
          { field: 'amount', column: 'Amount', context: null },
          { field: 'currency', column: 'Currency', context: null },
        ],
        imageSelection,
      },
      rationale:
        'Explicit source-word selection from visually reviewed synthetic fixture.',
      unresolvedQuestions: [],
    };
    const mapping = await evidence.saveReportMapping(
      context,
      bookId,
      'reviewed-image',
      { evidenceId, proposal },
    );
    assert.equal(mapping.status, 'candidate');
    const linked = await runs.linkMapping(
      context,
      bookId,
      run.id,
      randomUUID(),
      { expectedRevision: saved.revision, mappingId: String(mapping.id) },
    );
    assert.equal(linked.reviewedMapping?.mappingId, mapping.id);
    const bank = await evidence.createAccount(context, bookId, 'bank', {
      code: '1000',
      name: 'Bank',
      kind: 'asset',
    });
    const equity = await evidence.createAccount(context, bookId, 'equity', {
      code: '3000',
      name: 'Capital',
      kind: 'equity',
    });
    const financial = await evidence.createFinancialAccount(
      context,
      bookId,
      'financial',
      { name: 'Bank', kind: 'bank', currency: 'CAD', ledgerAccountId: bank.id },
    );
    await evidence.createPeriod(context, bookId, 'period', {
      startsOn: '2026-01-01',
      endsOn: '2026-12-31',
    });
    const importInput = {
      evidenceId,
      financialAccountId: financial.id,
      expectedMappingVersion: 1,
      providerKey: proposal.definition.providerKey,
    };
    await assert.rejects(
      evidence.importMappedReport(
        context,
        bookId,
        String(mapping.id),
        'unapproved',
        importInput,
      ),
      /approved-mapping-required/,
    );
    await evidence.reviewReportMapping(
      context,
      bookId,
      String(mapping.id),
      'approve',
      {
        expectedRevision: 1,
        decision: 'approve',
        reason:
          'Reviewed every selected cell against the synthetic original image.',
      },
    );
    const batch = await evidence.importMappedReport(
      context,
      bookId,
      String(mapping.id),
      'import',
      importInput,
    );
    assert.deepEqual(
      await evidence.importMappedReport(
        context,
        bookId,
        String(mapping.id),
        'import',
        importInput,
      ),
      batch,
    );
    const normalized = await evidence.getNormalizedImport(
      context,
      bookId,
      String(batch.id),
    );
    assert.equal(normalized.rows.length, 1);
    assert.equal(
      parseFinanceDecimal(String(normalized.rows[0]!.amount)),
      parseFinanceDecimal('123.45'),
    );
    await assert.rejects(
      evidence.commitNormalizedImport(
        context,
        bookId,
        String(batch.id),
        'unreviewed-commit',
        { expectedRevision: normalized.batch.revision },
      ),
    );
    await evidence.reviewNormalizedImportRow(
      context,
      bookId,
      String(normalized.rows[0]!.id),
      'row-review',
      {
        expectedRevision: normalized.rows[0]!.revision,
        action: 'post',
        counterAccountId: equity.id,
        reason: 'Reviewed synthetic deposit and capital account.',
      },
    );
    const reviewed = await evidence.getNormalizedImport(
      context,
      bookId,
      String(batch.id),
    );
    const committed = await evidence.commitNormalizedImport(
      context,
      bookId,
      String(batch.id),
      'commit',
      { expectedRevision: reviewed.batch.revision },
    );
    assert.deepEqual(
      await evidence.commitNormalizedImport(
        context,
        bookId,
        String(batch.id),
        'commit',
        { expectedRevision: reviewed.batch.revision },
      ),
      committed,
    );
    const journals = (
      await sql(
        "select count(*)::int as count from emdo.finance_journals where book_id=$1 and status='posted'",
        [bookId],
      )
    ).rows[0].count;
    assert.equal(journals, 1);
    const original = (
      await sql(
        'select encrypted_original,plaintext_sha256 from emdo.finance_book_evidence where id=$1',
        [evidenceId],
      )
    ).rows[0];
    assert.equal(original.plaintext_sha256, sourceDigest);
    const decrypted = await cipher.decrypt(
      EncryptedFinanceBookEvidenceSchema.parse(original.encrypted_original),
      { workspaceId: context.workspaceId, bookId, documentId: evidenceId },
    );
    assert.deepEqual(
      Buffer.from(
        (decrypted as { sourceBase64: string }).sourceBase64,
        'base64',
      ),
      originalBytes,
    );
    console.log(
      JSON.stringify({
        status: 'passed',
        model: 'provider-free deterministic fixture; no live Astra call',
        ocrEngine: facts.engine,
        sourceDigest,
        extractionDigest: extraction.extraction_digest,
        sourceWords: facts.words.length,
        normalizedRows: 1,
        postedJournals: journals,
        originalEncrypted: true,
        receiptReplay: true,
      }),
    );
  } finally {
    await workerPool?.end();
    await dispatchPool?.end();
    await admin.end();
  }
}
await main();

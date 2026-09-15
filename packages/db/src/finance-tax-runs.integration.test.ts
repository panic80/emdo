import {
  FinanceBookEvidenceCrypto,
  EncryptedFinanceBookEvidenceSchema,
} from '../../integrations/src/finance-documents/book-evidence-crypto.js';
import { InMemoryVaultKeyProvider } from '../../integrations/src/vault/crypto.js';
import { us2025TestFixture } from '../../domains/src/finance/tax/united-states/2025/test-fixtures.js';
import { corporateFixtureValues } from './finance-tax-corporate.fixture.js';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import {
  FinanceTaxWageExtractionSchema,
  FinanceTaxValueSchema,
  type WorkspaceContext,
} from '@emdo/contracts';
import {
  CORPORATE_PRIVATE_SCOPE,
  CANADA_ON_2025_PERSONAL_QUESTIONS,
  CANADA_ON_2025_PERSONAL_PACKAGE_VERSION,
} from '@emdo/domains/finance';
import { PostgresFinanceTaxRepository } from './finance-tax-repository.js';
import { PostgresFinanceV2Repository } from './finance-v2-repository.js';
import {
  NY_2025_REQUIRED_FACTS,
  NY_PRIVATE_SCOPE,
} from './finance-tax-ny-adapter.js';
const url = process.env.FINANCE_V2_TEST_DATABASE_URL;
describe.skipIf(!url)(
  'durable private tax working papers under restricted PostgreSQL roles',
  () => {
    const admin = new pg.Pool({ connectionString: url });
    const pool = {
      async connect() {
        const c = await admin.connect();
        await c.query('set role emdo_app');
        return c;
      },
    };
    const cipher = new FinanceBookEvidenceCrypto(
      new InMemoryVaultKeyProvider(
        new Uint8Array(32).fill(32),
        'finance-documents.v1',
      ),
    );
    const repo = new PostgresFinanceTaxRepository(pool, {
        evidenceCipher: {
          decrypt: async (encrypted, scope) =>
            cipher.decrypt(
              EncryptedFinanceBookEvidenceSchema.parse(encrypted),
              scope,
            ),
        },
      }),
      books = new PostgresFinanceV2Repository(pool);
    const workspaceId = randomUUID();
    const actor = (): WorkspaceContext => ({
      workspaceId,
      userId: randomUUID(),
      sessionId: randomUUID(),
      requestId: randomUUID(),
    });
    const owner = actor(),
      outsider = actor(),
      viewer = actor(),
      reviewer = actor(),
      preparer = actor();
    async function sql(q: string, v: unknown[] = []) {
      const c = await admin.connect();
      try {
        await c.query('reset role');
        return await c.query(q, v);
      } finally {
        c.release();
      }
    }
    async function raw(who: WorkspaceContext, q: string, v: unknown[] = []) {
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query(
          "select set_config('emdo.user_id',$1,true),set_config('emdo.session_id',$2,true),set_config('emdo.request_id',$3,true)",
          [who.userId, who.sessionId, randomUUID()],
        );
        const r = await c.query(q, v);
        await c.query('commit');
        return r;
      } catch (e) {
        await c.query('rollback');
        throw e;
      } finally {
        c.release();
      }
    }
    beforeAll(async () => {
      for (const a of [owner, outsider, viewer, reviewer, preparer])
        await sql(
          'insert into emdo.auth_users(id,name,email,email_verified) values($1,$2,$3,true)',
          [a.userId, 'Synthetic', `${a.userId}@example.test`],
        );
      await sql(
        "insert into emdo.households(id,name,created_by_user_id,slug) values($1::uuid,'Tax run tests',$2,$1::text)",
        [workspaceId, outsider.userId],
      );
      for (const a of [owner, outsider, viewer, reviewer, preparer]) {
        await sql(
          'insert into emdo.household_memberships(household_id,user_id,role) values($1,$2,$3)',
          [workspaceId, a.userId, a === outsider ? 'owner' : 'member'],
        );
        await sql(
          "insert into emdo.auth_sessions(id,user_id,token,expires_at,active_household_id) values($1::uuid,$2,$1::text,now()+interval '1 day',$3)",
          [a.sessionId, a.userId, workspaceId],
        );
      }
    });
    afterAll(() => admin.end());
    const create = (
      taxpayerType: 'individual' | 'sole-proprietor' = 'individual',
    ) =>
      repo.createCase(owner, randomUUID(), {
        mode: 'intake-only',
        title: 'Working paper fixture',
        taxSubjectName: 'Synthetic',
        scope: {
          country: 'CA',
          subdivision: 'CA-ON',
          taxpayerType,
          year: 2025,
          regime: 'income-tax-return',
          formVersion: '5006-R-E-25_5006-C-E-25',
        },
        domesticResident: true,
        hasCrossBorderActivity: false,
        standaloneCorporation: null,
        relatedParties: [],
      });
    it('collects conditional T2125 identity facts without automatically reviewing them', async () => {
      const c = await create('sole-proprietor');
      const preparation = await repo.getWorkingPaperPreparation(
        owner,
        c.caseId,
      );
      for (const [key, type] of [
        ['business.incomeKind', 'text'],
        ['business.reportingMethod', 'text'],
        ['business.methodChanged', 'boolean'],
        ['business.amountsOnSelectedBasis', 'boolean'],
        ['businessIdentity.preparerNameAndAddress', 'text'],
      ])
        expect(preparation.questions).toContainEqual(
          expect.objectContaining({ key, type, required: true }),
        );
      const individual = await create();
      const personalPreparation = await repo.getWorkingPaperPreparation(
        owner,
        individual.caseId,
      );
      expect(
        personalPreparation.questions.some((q) =>
          [
            'business.incomeKind',
            'business.reportingMethod',
            'business.methodChanged',
            'business.amountsOnSelectedBasis',
          ].includes(q.key),
        ),
      ).toBe(false);
      for (const key of [
        'businessIdentity.hasProgramAccount',
        'businessIdentity.lastBusinessYear',
      ]) {
        expect(preparation.questions).toContainEqual(
          expect.objectContaining({ key, type: 'boolean', required: true }),
        );
      }
      expect(preparation.questions).toContainEqual(
        expect.objectContaining({
          key: 'businessIdentity.programAccountNumber',
          type: 'text',
          required: false,
          label: expect.stringContaining('15 characters'),
        }),
      );
      for (let i = 1; i <= 5; i++) {
        expect(preparation.questions).toContainEqual(
          expect.objectContaining({
            key: `businessIdentity.internetSite${i}`,
            type: 'text',
            required: false,
          }),
        );
      }
      await repo.recordDeclaration(owner, c.caseId, randomUUID(), {
        expectedCaseRevision: preparation.snapshotRevision,
        expectedSourceRevision: null,
        factKey: 'businessIdentity.hasProgramAccount',
        category: 'general',
        value: { type: 'boolean', value: false },
      });
      const saved = await repo.getWorkingPaperPreparation(owner, c.caseId);
      expect(saved.inputReviews).toEqual([]);
    });
    async function binding(caseId: string) {
      const p = await repo.getWorkingPaperPreparation(owner, caseId);
      return {
        workflowId: p.workflowId,
        expectedPackageVersion: p.packageVersion,
        expectedCaseRevision: p.snapshotRevision,
        expectedSnapshotHash: p.snapshotHash,
      };
    }
    it('saves a reviewed commission run and preserves its exact method source when current inputs change', async () => {
      const c = await create('sole-proprietor');
      for (const [who, role] of [
        [reviewer, 'reviewer'],
        [preparer, 'preparer'],
      ] as const)
        await repo.grantCaseAccess(owner, c.caseId, randomUUID(), {
          userId: who.userId,
          role,
          expectedGrantRevision: null,
        });
      const preparation = await repo.getWorkingPaperPreparation(
        owner,
        c.caseId,
      );
      const textValues: Record<string, string> = {
        'business.incomeKind': 'commission',
        'business.reportingMethod': 'cash',
        'identity.taxNumber': '000000000',
        'identity.language': 'en',
        'businessIdentity.industryCode': '541990',
      };
      const moneyValues: Record<string, string> = {
        'business.grossSales': '11300',
        'business.salesAdjustments': '1300',
        'business.8810': '1000',
      };
      for (const question of preparation.questions.filter((q) => q.required)) {
        const current = await binding(c.caseId);
        await repo.recordDeclaration(owner, c.caseId, randomUUID(), {
          expectedCaseRevision: current.expectedCaseRevision,
          expectedSourceRevision: null,
          factKey: question.key,
          category: 'general',
          value:
            question.type === 'boolean'
              ? {
                  type: 'boolean',
                  value:
                    !question.key.startsWith('identity.') &&
                    !question.key.startsWith('businessIdentity.') &&
                    question.key !== 'business.methodChanged',
                }
              : question.type === 'date'
                ? {
                    type: 'date',
                    value:
                      question.key === 'businessIdentity.fiscalStart'
                        ? '2025-01-01'
                        : question.key === 'businessIdentity.fiscalEnd'
                          ? '2025-12-31'
                          : '1990-01-01',
                  }
                : question.type === 'text'
                  ? {
                      type: 'text',
                      value:
                        textValues[question.key] ??
                        'Synthetic commission preparer, 10 Example Street, Ottawa ON',
                    }
                  : {
                      type: 'decimal',
                      value: moneyValues[question.key] ?? '0',
                    },
        });
      }
      const request = await binding(c.caseId);
      const saved = await repo.getCase(owner, c.caseId);
      const inputs = saved.declaredInputs.map(
        ({ sourceId, sourceRevision, contentHash }) => ({
          sourceId,
          sourceRevision,
          contentHash,
        }),
      );
      const pending = await repo.createCalculationRun(
        preparer,
        c.caseId,
        randomUUID(),
        request,
      );
      expect(pending.status).toBe('blocked-input');
      await repo.reviewWorkingPaperInputs(reviewer, c.caseId, randomUUID(), {
        ...request,
        inputs,
      });
      const run = await repo.createCalculationRun(
        preparer,
        c.caseId,
        randomUUID(),
        request,
      );
      expect(run.status).toBe('incomplete-working-papers');
      expect(run.complete).toBe(false);
      const detail = await repo.getCalculationRun(owner, c.caseId, run.runId);
      const fields = detail.schedules
        .flatMap((s) => s.content)
        .map((s) => s.field);
      for (const [id, amount] of [
        ['T1.13899', '10000.00'],
        ['T1.13900', '9000.00'],
        ['T1.13499', '0.00'],
        ['T1.13500', '0.00'],
      ] as const)
        expect(fields.find((f) => f.id === id)?.reportableAmount, id).toBe(
          amount,
        );
      expect(
        detail.output.formAudit?.requirements.every((r) => r.satisfied),
      ).toBe(true);
      expect(detail.output.complete).toBe(false);
      expect(detail.output.enabled).toBe(false);
      expect(detail.inputBinding.snapshotHash).toBe(
        request.expectedSnapshotHash,
      );
      const method = saved.declaredInputs.find(
        (f) => f.factKey === 'business.reportingMethod',
      )!;
      const savedInput = (
        await raw(
          owner,
          'select input from emdo.finance_tax_calculation_runs where id=$1',
          [run.runId],
        )
      ).rows[0].input;
      expect(savedInput.calculationIntake.facts).toContainEqual(
        expect.objectContaining({
          key: 'business.reportingMethod',
          value: { type: 'text', value: 'cash' },
          reviewState: 'reviewed',
          source: expect.objectContaining({ revision: method.sourceRevision }),
        }),
      );
      await repo.recordDeclaration(owner, c.caseId, randomUUID(), {
        expectedCaseRevision: request.expectedCaseRevision,
        sourceId: method.sourceId,
        expectedSourceRevision: method.sourceRevision,
        factKey: 'business.reportingMethod',
        category: 'general',
        value: { type: 'text', value: 'accrual' },
      });
      const changedBinding = await binding(c.caseId);
      expect(changedBinding.expectedSnapshotHash).not.toBe(
        request.expectedSnapshotHash,
      );
      expect(
        (
          await repo.createCalculationRun(
            preparer,
            c.caseId,
            randomUUID(),
            changedBinding,
          )
        ).status,
      ).toBe('blocked-input');
      const historical = await repo.getCalculationRun(
        owner,
        c.caseId,
        run.runId,
      );
      expect(historical.summary.outputHash).toBe(run.outputHash);
      expect(historical.inputBinding).toEqual(detail.inputBinding);
      expect(
        (
          await raw(
            owner,
            'select input from emdo.finance_tax_calculation_runs where id=$1',
            [run.runId],
          )
        ).rows[0].input,
      ).toEqual(savedInput);
      expect(historical.schedules).toEqual(detail.schedules);
    });
    it.each([1, 2, 'NY'] as const)(
      'binds US wage originals version %s to exact reviewed extraction, immutable exports and current source authority',
      async (variant) => {
        const isNewYork = variant === 'NY';
        const wageVersion = isNewYork ? 1 : variant;
        const fixture = us2025TestFixture({
          'business.receipts': '50000',
          'w2.box1': '20000',
          'w2.box2': '2500',
          'w2.box3': '20000',
          'w2.box5': '20000',
          'w2.box6': '290',
        });
        const c = await repo.createCase(owner, randomUUID(), {
          mode: 'intake-only',
          title: 'US wage fixture',
          taxSubjectName: 'Synthetic US filer',
          scope: isNewYork ? NY_PRIVATE_SCOPE : fixture.scope,
          domesticResident: true,
          hasCrossBorderActivity: false,
          standaloneCorporation: null,
          relatedParties: [],
        });
        const book = await books.createBook(owner, randomUUID(), {
          name: 'US wage originals',
          entityName: 'Synthetic proprietor',
          entityKind: 'sole-proprietor',
          country: 'US',
          functionalCurrency: 'USD',
        });
        const auth = await repo.authorizeBookSource(
          owner,
          c.caseId,
          randomUUID(),
          { bookId: String(book.id), expectedCaseRevision: 1 },
        );
        await repo.grantCaseAccess(owner, c.caseId, randomUUID(), {
          userId: reviewer.userId,
          role: 'reviewer',
          expectedGrantRevision: null,
        });
        await repo.grantCaseAccess(owner, c.caseId, randomUUID(), {
          userId: viewer.userId,
          role: 'viewer',
          expectedGrantRevision: null,
        });
        const evidenceId = randomUUID(),
          bytes = Buffer.from('%PDF-1.7 synthetic W-2 original fixture');
        await raw(
          owner,
          "insert into emdo.finance_book_evidence(workspace_id,book_id,id,filename,format,plaintext_sha256,byte_size,encrypted_original,uploaded_by) values($1,$2,$3,'Synthetic W2.pdf','pdf',$4,$5,$6::jsonb,$7)",
          [
            workspaceId,
            String(book.id),
            evidenceId,
            createHash('sha256').update(bytes).digest('hex'),
            bytes.length,
            JSON.stringify(
              await cipher.encrypt(
                { sourceBase64: bytes.toString('base64') },
                {
                  workspaceId,
                  bookId: String(book.id),
                  documentId: evidenceId,
                },
              ),
            ),
            owner.userId,
          ],
        );
        const correctionIds: string[] = [];
        if (wageVersion === 2)
          for (const ordinal of [1, 2]) {
            const id = randomUUID(),
              originalBytes = Buffer.from(
                `%PDF-1.7 synthetic W-2c correction ${ordinal}`,
              );
            correctionIds.push(id);
            await raw(
              owner,
              "insert into emdo.finance_book_evidence(workspace_id,book_id,id,filename,format,plaintext_sha256,byte_size,encrypted_original,uploaded_by) values($1,$2,$3,$4,'pdf',$5,$6,$7::jsonb,$8)",
              [
                workspaceId,
                String(book.id),
                id,
                `Correction${ordinal}.pdf`,
                createHash('sha256').update(originalBytes).digest('hex'),
                originalBytes.length,
                JSON.stringify(
                  await cipher.encrypt(
                    { sourceBase64: originalBytes.toString('base64') },
                    { workspaceId, bookId: String(book.id), documentId: id },
                  ),
                ),
                owner.userId,
              ],
            );
          }
        for (const fact of fixture.facts)
          await repo.recordDeclaration(owner, c.caseId, randomUUID(), {
            expectedCaseRevision: (await binding(c.caseId))
              .expectedCaseRevision,
            expectedSourceRevision: null,
            factKey: isNewYork ? `federal.${fact.key}` : fact.key,
            category: 'general',
            value: fact.value,
          });
        const boxes = {
          box1: '20000',
          box2: '2500',
          box3: '20000',
          box5: '20000',
          box6: '290',
          box7: '0',
        };
        await repo.recordDeclaration(owner, c.caseId, randomUUID(), {
          expectedCaseRevision: (await binding(c.caseId)).expectedCaseRevision,
          expectedSourceRevision: null,
          factKey: 'wageEvidence.documents',
          category: 'general',
          value: {
            type: 'text',
            value: JSON.stringify({
              schemaVersion: wageVersion,
              documents: [
                {
                  bookId: String(book.id),
                  evidenceId,
                  form: 'W-2',
                  originalEvidenceId: null,
                  boxes:
                    wageVersion === 1 ? boxes : { ...boxes, box1: '18000' },
                },
                ...correctionIds.map((id, index) => ({
                  bookId: String(book.id),
                  evidenceId: id,
                  form: 'W-2c',
                  originalEvidenceId: evidenceId,
                  supersedesEvidenceId:
                    index === 0 ? evidenceId : correctionIds[index - 1],
                  corrections: [
                    {
                      box: 'box1',
                      previous: index === 0 ? '18000' : '19000',
                      correct: index === 0 ? '19000' : '20000',
                    },
                  ],
                  boxes: { ...boxes, box1: index === 0 ? '19000' : '20000' },
                })),
              ],
            }),
          },
        });
        const declarations = await repo.listDeclarations(owner, c.caseId),
          wage = declarations.find(
            (f) => f.factKey === 'wageEvidence.documents',
          )!;
        const request = {
          ...(await binding(c.caseId)),
          input: {
            sourceId: wage.sourceId,
            sourceRevision: wage.sourceRevision,
            contentHash: wage.contentHash,
          },
          acknowledgement: 'verified-saved-boxes-against-original-documents',
        };
        await expect(
          repo.reviewWageEvidence(reviewer, c.caseId, randomUUID(), request),
        ).rejects.toThrow();
        await repo.reviewWorkingPaperInputs(reviewer, c.caseId, randomUUID(), {
          ...(await binding(c.caseId)),
          inputs: declarations.map(
            ({ sourceId, sourceRevision, contentHash }) => ({
              sourceId,
              sourceRevision,
              contentHash,
            }),
          ),
        });
        expect(
          (
            await repo.createCalculationRun(
              owner,
              c.caseId,
              randomUUID(),
              await binding(c.caseId),
            )
          ).status,
        ).toBe('blocked-input');
        await expect(
          repo.reviewWageEvidence(viewer, c.caseId, randomUUID(), request),
        ).rejects.toThrow();
        await expect(
          repo.getWageEvidencePreparation(outsider, c.caseId),
        ).rejects.toThrow();
        await expect(
          repo.getWageOriginal(reviewer, c.caseId, randomUUID(), evidenceId),
        ).rejects.toThrow();
        const listed = await repo.getWageEvidencePreparation(
          reviewer,
          c.caseId,
        );
        expect(listed.documents.map((d) => d.evidenceId)).toContain(evidenceId);
        expect(
          (
            await repo.getWageOriginal(
              reviewer,
              c.caseId,
              String(book.id),
              evidenceId,
            )
          ).sourceBase64,
        ).toBe(bytes.toString('base64'));
        const key = randomUUID(),
          review = await repo.reviewWageEvidence(
            reviewer,
            c.caseId,
            key,
            request,
          );
        expect(
          await repo.reviewWageEvidence(reviewer, c.caseId, key, request),
        ).toEqual(review);
        if (isNewYork) {
          // Reviewing federal originals cannot invent the absent state declarations.
          const run = await repo.createCalculationRun(
            owner,
            c.caseId,
            randomUUID(),
            await binding(c.caseId),
          );
          expect(run.workflowId).toBe('us-ny-2025-working-papers');
          expect(run.status).toBe('blocked-input');
          expect(run.complete).toBe(false);
          const detail = await repo.getCalculationRun(
            viewer,
            c.caseId,
            run.runId,
          );
          expect(detail.summary.status).toBe('blocked-input');
          return;
        }
        await expect(
          raw(
            reviewer,
            'insert into emdo.finance_tax_wage_reviews select workspace_id,case_id,tax_subject_id,snapshot_revision,$2,snapshot_hash,source_id,source_revision,source_hash,package_hash,manifest,manifest_hash,created_by,created_at from emdo.finance_tax_wage_reviews where id=$1',
            [review.reviewId, randomUUID()],
          ),
        ).rejects.toThrow();
        await expect(
          raw(
            reviewer,
            `with original as (select * from emdo.finance_tax_wage_reviews where id=$1), altered as (select original.*,jsonb_set(jsonb_set(manifest,'{reference}',to_jsonb('tax-wage-review:'||$2::text)),'{artifacts,0}',(manifest#>'{artifacts,0}')-'form') as altered_manifest from original) insert into emdo.finance_tax_wage_reviews(workspace_id,case_id,tax_subject_id,snapshot_revision,id,snapshot_hash,source_id,source_revision,source_hash,package_hash,manifest,manifest_hash,created_by,created_at) select workspace_id,case_id,tax_subject_id,snapshot_revision,$2::uuid,snapshot_hash,source_id,source_revision,source_hash,package_hash,altered_manifest,emdo.canonical_json_hash(altered_manifest),created_by,created_at from altered`,
            [review.reviewId, randomUUID()],
          ),
        ).rejects.toThrow();
        const run = await repo.createCalculationRun(
          owner,
          c.caseId,
          randomUUID(),
          await binding(c.caseId),
        );
        expect(run.status).toBe('incomplete-working-papers');
        expect(run.complete).toBe(false);
        const detail = await repo.getCalculationRun(
          viewer,
          c.caseId,
          run.runId,
        );
        expect(detail.schedules.some((s) => s.formId === 'F1040')).toBe(true);
        expect(
          detail.schedules
            .flatMap((s) => s.content)
            .find((f) => f.field.id === 'F1040.11a')?.field.reportableAmount,
        ).toBe('66467');
        expect(JSON.stringify(detail)).not.toContain('123456789');
        expect(JSON.stringify(detail)).not.toContain(evidenceId);
        const outputReview = await repo.reviewCalculationRun(
          reviewer,
          c.caseId,
          run.runId,
          randomUUID(),
          {
            expectedOutputHash: run.outputHash,
            acknowledgement: 'reviewed-incomplete-working-papers-not-fileable',
          },
        );
        const exported = await repo.exportCalculationRun(
          viewer,
          c.caseId,
          run.runId,
          outputReview.reviewId,
        );
        expect(exported.content).toContain(
          'state and local returns not included',
        );
        expect(exported.content).toContain('123456789');
        if (wageVersion === 2) {
          expect(exported.content).toContain('retained history');
          expect(exported.content).toContain('effective terminal');
          for (const id of correctionIds) {
            expect(exported.content).toContain(id);
            expect(JSON.stringify(detail)).not.toContain(id);
          }
          expect(review.documentCount).toBe(3);
        }

        if (wageVersion === 2) {
          const originalReview = (
            await sql(
              'select * from emdo.finance_tax_wage_reviews where id=$1',
              [review.reviewId],
            )
          ).rows[0];
          const wageValue = FinanceTaxValueSchema.parse(wage.value);
          if (wageValue.type !== 'text')
            throw new Error('Wage documents must be serialized text');
          const extracted = FinanceTaxWageExtractionSchema.parse(
            JSON.parse(wageValue.value),
          );
          if (extracted.schemaVersion !== 2)
            throw new Error('Correction fixtures must use schema version 2');
          const alteredDocuments = [
            extracted.documents.map((d, i) =>
              i === 1 ? { ...d, supersedesEvidenceId: randomUUID() } : d,
            ),
            extracted.documents.map((d, i) =>
              i === 1 ? { ...d, supersedesEvidenceId: correctionIds[1] } : d,
            ),
            extracted.documents.map((d, i) =>
              i === 2 ? { ...d, supersedesEvidenceId: evidenceId } : d,
            ),
            extracted.documents.map((d, i) =>
              i === 1
                ? {
                    ...d,
                    corrections: [
                      { box: 'box1', previous: '17999', correct: '19000' },
                    ],
                  }
                : d,
            ),
            extracted.documents.map((d, i) =>
              i === 1 ? { ...d, boxes: { ...d.boxes, box2: '2499' } } : d,
            ),
          ];
          for (const documents of alteredDocuments) {
            const current = (await repo.listDeclarations(owner, c.caseId)).find(
              (f) => f.factKey === wage.factKey,
            )!;
            await repo.recordDeclaration(owner, c.caseId, randomUUID(), {
              expectedCaseRevision: (await binding(c.caseId))
                .expectedCaseRevision,
              sourceId: current.sourceId,
              expectedSourceRevision: current.sourceRevision,
              factKey: wage.factKey,
              category: 'general',
              value: {
                type: 'text',
                value: JSON.stringify({ schemaVersion: 2, documents }),
              },
            });
            const next = (await repo.listDeclarations(owner, c.caseId)).find(
              (f) => f.factKey === wage.factKey,
            )!;
            const b = await binding(c.caseId),
              pin = {
                sourceId: next.sourceId,
                sourceRevision: next.sourceRevision,
                contentHash: next.contentHash,
              };
            await repo.reviewWorkingPaperInputs(
              reviewer,
              c.caseId,
              randomUUID(),
              { ...b, inputs: [pin] },
            );
            await expect(
              repo.reviewWageEvidence(reviewer, c.caseId, randomUUID(), {
                ...b,
                input: pin,
                acknowledgement:
                  'verified-saved-boxes-against-original-documents',
              }),
            ).rejects.toThrow('wage-correction-chain-invalid');
            const newId = randomUUID();
            const manifest = {
              ...originalReview.manifest,
              reference: `tax-wage-review:${newId}`,
              revision: next.sourceRevision,
              artifacts: originalReview.manifest.artifacts.map(
                (a: Record<string, unknown>) => {
                  const d = documents.find(
                    (v) => v.evidenceId === a.artifactId,
                  )!;
                  return {
                    ...a,
                    revision: next.sourceRevision,
                    boxes: d.boxes,
                    originalArtifactId: d.originalEvidenceId,
                    ...(d.form === 'W-2c'
                      ? {
                          supersedesArtifactId: d.supersedesEvidenceId,
                          corrections: d.corrections,
                        }
                      : {}),
                  };
                },
              ),
            };
            await expect(
              raw(
                reviewer,
                'insert into emdo.finance_tax_wage_reviews(workspace_id,case_id,tax_subject_id,snapshot_revision,id,snapshot_hash,source_id,source_revision,source_hash,package_hash,manifest,manifest_hash,created_by,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,emdo.canonical_json_hash($11::jsonb),$12,$13)',
                [
                  workspaceId,
                  c.caseId,
                  originalReview.tax_subject_id,
                  b.expectedCaseRevision,
                  newId,
                  b.expectedSnapshotHash,
                  next.sourceId,
                  next.sourceRevision,
                  next.contentHash,
                  originalReview.package_hash,
                  JSON.stringify(manifest),
                  reviewer.userId,
                  originalReview.created_at,
                ],
              ),
            ).rejects.toThrow();
          }
        }
        await repo.recordDeclaration(owner, c.caseId, randomUUID(), {
          expectedCaseRevision: (await binding(c.caseId)).expectedCaseRevision,
          sourceId: wage.sourceId,
          expectedSourceRevision: (
            await repo.listDeclarations(owner, c.caseId)
          ).find((f) => f.factKey === wage.factKey)!.sourceRevision,
          factKey: wage.factKey,
          category: 'general',
          value: {
            type: 'text',
            value: JSON.stringify({ schemaVersion: 1, documents: [] }),
          },
        });
        expect(
          (
            await repo.exportCalculationRun(
              viewer,
              c.caseId,
              run.runId,
              outputReview.reviewId,
            )
          ).content,
        ).toBe(exported.content);
        expect(
          (await repo.getWageEvidencePreparation(owner, c.caseId)).review,
        ).toBeNull();
        await repo.revokeBookSource(
          owner,
          c.caseId,
          randomUUID(),
          auth.authorizationId,
          auth.authorizationRevision,
        );
        await expect(
          repo.getCalculationRun(owner, c.caseId, run.runId),
        ).rejects.toThrow();
        await expect(
          repo.exportCalculationRun(
            viewer,
            c.caseId,
            run.runId,
            outputReview.reviewId,
          ),
        ).rejects.toThrow();
        await expect(
          repo.getWageOriginal(reviewer, c.caseId, String(book.id), evidenceId),
        ).rejects.toThrow();
      },
      120000,
    );
    it('uses the same private boundary for corporate review, normalized runs and immutable historical exports', async () => {
      const c = await repo.createCase(owner, randomUUID(), {
        mode: 'intake-only',
        title: 'Private corporate fixture',
        taxSubjectName: 'Synthetic company',
        scope: CORPORATE_PRIVATE_SCOPE,
        domesticResident: true,
        hasCrossBorderActivity: false,
        standaloneCorporation: true,
        relatedParties: [],
      });
      const book = await books.createBook(owner, randomUUID(), {
        name: 'Corporate source snapshot',
        entityName: 'Synthetic corporate source',
        entityKind: 'corporation',
        country: 'CA',
        functionalCurrency: 'CAD',
      });
      const authorization = await repo.authorizeBookSource(
        owner,
        c.caseId,
        randomUUID(),
        { bookId: book.id, expectedCaseRevision: 1 },
      );
      await repo.grantCaseAccess(owner, c.caseId, randomUUID(), {
        userId: reviewer.userId,
        role: 'reviewer',
        expectedGrantRevision: null,
      });
      await repo.grantCaseAccess(owner, c.caseId, randomUUID(), {
        userId: viewer.userId,
        role: 'viewer',
        expectedGrantRevision: null,
      });
      const p = await repo.getWorkingPaperPreparation(owner, c.caseId);
      expect(p.workflowId).toBe('ca-on-2025-corporate-working-papers');
      expect(p.scopeSupported).toBe(true);
      expect(p.questions.length).toBeGreaterThan(128);
      await expect(
        repo.getWorkingPaperPreparation(outsider, c.caseId),
      ).rejects.toThrow();
      for (const fact of corporateFixtureValues())
        await repo.recordDeclaration(owner, c.caseId, randomUUID(), {
          expectedCaseRevision: (await binding(c.caseId)).expectedCaseRevision,
          expectedSourceRevision: null,
          factKey: fact.key,
          category: 'general',
          value: fact.value,
        });
      const blocked = await repo.createCalculationRun(
        owner,
        c.caseId,
        randomUUID(),
        await binding(c.caseId),
      );
      expect(blocked.status).toBe('blocked-input');
      const declarations = await repo.listDeclarations(owner, c.caseId);
      const reviewInput = {
        ...(await binding(c.caseId)),
        inputs: declarations.map(
          ({ sourceId, sourceRevision, contentHash }) => ({
            sourceId,
            sourceRevision,
            contentHash,
          }),
        ),
      };
      await expect(
        repo.reviewWorkingPaperInputs(
          viewer,
          c.caseId,
          randomUUID(),
          reviewInput,
        ),
      ).rejects.toThrow();
      await repo.reviewWorkingPaperInputs(
        reviewer,
        c.caseId,
        randomUUID(),
        reviewInput,
      );
      const idem = randomUUID(),
        request = await binding(c.caseId);
      await expect(
        repo.createCalculationRun(owner, c.caseId, randomUUID(), {
          ...request,
          workflowId: 'ca-on-2025-personal-working-papers',
          expectedPackageVersion: CANADA_ON_2025_PERSONAL_PACKAGE_VERSION,
        }),
      ).rejects.toThrow();
      const run = await repo.createCalculationRun(
        owner,
        c.caseId,
        idem,
        request,
      );
      expect(
        await repo.createCalculationRun(owner, c.caseId, idem, request),
      ).toEqual(run);
      expect(run.status).toBe('incomplete-working-papers');
      expect(run.complete).toBe(false);
      await expect(
        raw(
          owner,
          "insert into emdo.finance_tax_calculation_runs(workspace_id,case_id,tax_subject_id,snapshot_revision,id,snapshot_hash,workflow_id,package_version,package_hash,input_hash,output_hash,status,complete,input,output,created_by) select workspace_id,case_id,tax_subject_id,snapshot_revision,$2,snapshot_hash,'caller-untrusted-package',package_version,package_hash,input_hash,output_hash,status,false,input,output,created_by from emdo.finance_tax_calculation_runs where id=$1",
          [run.runId, randomUUID()],
        ),
      ).rejects.toThrow();
      const detail = await repo.getCalculationRun(viewer, c.caseId, run.runId);
      expect(detail.schedules.some((s) => s.formId === 'T2')).toBe(true);
      expect(
        detail.schedules
          .flatMap((s) => s.content)
          .find((s) => s.field.id === 'T2.700')!.field.reportableAmount,
      ).toBe('9000');
      expect(
        detail.schedules
          .flatMap((s) => s.content)
          .find((s) => s.field.id === 'T2.balanceOwing')!.field.exactDecimal,
      ).toBe('2200');
      expect(JSON.stringify(detail)).not.toContain('Synthetic Review Services');
      expect(JSON.stringify(detail)).not.toContain('123456789RC0001');
      expect(detail.inputBinding.inputReviews).toHaveLength(
        declarations.length,
      );
      await expect(
        repo.getCalculationRun(outsider, c.caseId, run.runId),
      ).rejects.toThrow();
      const review = await repo.reviewCalculationRun(
        reviewer,
        c.caseId,
        run.runId,
        randomUUID(),
        {
          expectedOutputHash: run.outputHash,
          acknowledgement: 'reviewed-incomplete-working-papers-not-fileable',
        },
      );
      const exported = await repo.exportCalculationRun(
        viewer,
        c.caseId,
        run.runId,
        review.reviewId,
      );
      expect(exported.content).toContain('Synthetic Review Services');
      expect(exported.content).toContain('123456789RC0001');
      expect(exported.content).toContain('T2');
      expect(exported.sha256).toBe(
        createHash('sha256').update(exported.content).digest('hex'),
      );
      const fact = declarations.find(
        (f) => f.factKey === 'identity.legalName',
      )!;
      await repo.recordDeclaration(owner, c.caseId, randomUUID(), {
        expectedCaseRevision: request.expectedCaseRevision,
        expectedSourceRevision: fact.sourceRevision,
        sourceId: fact.sourceId,
        factKey: fact.factKey,
        category: 'general',
        value: { type: 'text', value: 'Changed private identity' },
      });
      expect(
        (
          await repo.exportCalculationRun(
            viewer,
            c.caseId,
            run.runId,
            review.reviewId,
          )
        ).content,
      ).toEqual(exported.content);
      expect(
        (await repo.getWorkingPaperPreparation(owner, c.caseId)).inputReviews,
      ).toEqual([]);
      const grant = (await repo.listCaseGrants(owner, c.caseId)).find(
        (g) => g.userId === viewer.userId,
      )!;
      await repo.revokeCaseAccess(owner, c.caseId, randomUUID(), {
        userId: viewer.userId,
        expectedGrantRevision: grant.revision,
      });
      await expect(
        repo.exportCalculationRun(viewer, c.caseId, run.runId, review.reviewId),
      ).rejects.toThrow();
      await repo.revokeBookSource(
        owner,
        c.caseId,
        randomUUID(),
        authorization.authorizationId,
        authorization.authorizationRevision,
      );
      await expect(
        repo.getCalculationRun(owner, c.caseId, run.runId),
      ).rejects.toThrow();
      await expect(
        repo.exportCalculationRun(owner, c.caseId, run.runId, review.reviewId),
      ).rejects.toThrow();
    }, 120000);
    it('persists blocked inputs, reviews exact saved versions, reconstructs schedules and exports only a bound review', async () => {
      expect(await repo.checkReady()).toBe(true);
      const c = await create();
      for (const [who, role] of [
        [viewer, 'viewer'],
        [reviewer, 'reviewer'],
        [preparer, 'preparer'],
      ] as const)
        await repo.grantCaseAccess(owner, c.caseId, randomUUID(), {
          userId: who.userId,
          role,
          expectedGrantRevision: null,
        });
      const blocked = await repo.createCalculationRun(
        owner,
        c.caseId,
        randomUUID(),
        await binding(c.caseId),
      );
      expect(blocked.status).toBe('blocked-input');
      await expect(
        repo.reviewCalculationRun(
          reviewer,
          c.caseId,
          blocked.runId,
          randomUUID(),
          {
            expectedOutputHash: blocked.outputHash,
            acknowledgement: 'reviewed-incomplete-working-papers-not-fileable',
          },
        ),
      ).rejects.toThrow('blocking-inputs');
      await expect(
        repo.createCalculationRun(
          viewer,
          c.caseId,
          randomUUID(),
          await binding(c.caseId),
        ),
      ).rejects.toThrow('forbidden');
      expect(
        (await raw(outsider, 'select * from emdo.finance_tax_calculation_runs'))
          .rows,
      ).toEqual([]);
      await expect(
        repo.listCalculationRuns(outsider, c.caseId),
      ).rejects.toThrow('forbidden');
      const book = await books.createBook(owner, randomUUID(), {
        name: 'Explicit personal source',
        entityName: 'Synthetic',
        entityKind: 'sole-proprietor',
        country: 'CA',
        functionalCurrency: 'CAD',
      });
      await repo.authorizeBookSource(owner, c.caseId, randomUUID(), {
        bookId: book.id,
        expectedCaseRevision: 1,
      });
      for (const question of CANADA_ON_2025_PERSONAL_QUESTIONS.filter(
        (q) =>
          ![
            'business.incomeKind',
            'business.reportingMethod',
            'business.methodChanged',
            'business.amountsOnSelectedBasis',
          ].includes(q.key),
      )) {
        const b = await binding(c.caseId);
        await repo.recordDeclaration(owner, c.caseId, randomUUID(), {
          expectedCaseRevision: b.expectedCaseRevision,
          expectedSourceRevision: null,
          factKey: question.key,
          category: 'general',
          value:
            question.type === 'boolean'
              ? { type: 'boolean', value: true }
              : question.type === 'date'
                ? { type: 'date', value: '1990-01-01' }
                : {
                    type: 'decimal',
                    value:
                      question.key === 'interest'
                        ? '10000.17'
                        : question.key === 'instalments'
                          ? '12.34'
                          : '0',
                  },
        });
      }
      const formPreparation = await repo.getWorkingPaperPreparation(
        owner,
        c.caseId,
      );
      expect(formPreparation.packageVersion).toBe(
        CANADA_ON_2025_PERSONAL_PACKAGE_VERSION,
      );
      expect(formPreparation.questions).toContainEqual(
        expect.objectContaining({
          key: 'deductions.annualDues',
          type: 'decimal',
          required: true,
        }),
      );
      for (const key of [
        'scope.duesEligibleUnreimbursed',
        'scope.duesNotClaimedInBusiness',
      ]) {
        expect(formPreparation.questions).toContainEqual(
          expect.objectContaining({ key, type: 'boolean', required: true }),
        );
      }
      expect(formPreparation.questions).toContainEqual(
        expect.objectContaining({
          key: 'medical.eligibleSelfExpenses',
          type: 'decimal',
          required: true,
        }),
      );
      for (const key of [
        'scope.medicalEligibleUnreimbursed',
        'scope.medicalSamePeriodNotPreviouslyClaimed',
        'scope.medicalNoOntarioSpecialCategories',
      ]) {
        expect(formPreparation.questions).toContainEqual(
          expect.objectContaining({ key, type: 'boolean', required: true }),
        );
      }
      const carryforwardQuestions = formPreparation.questions.filter((q) =>
        q.key.startsWith('carryforward.nonCapitalLoss.'),
      );
      expect(carryforwardQuestions.map((q) => q.key)).toEqual(
        Array.from(
          { length: 19 },
          (_, index) => `carryforward.nonCapitalLoss.${2006 + index}`,
        ),
      );
      expect(
        carryforwardQuestions.every(
          (q) =>
            q.required &&
            q.type === 'decimal' &&
            q.locator.includes('reassessment'),
        ),
      ).toBe(true);
      expect(formPreparation.questions).toContainEqual(
        expect.objectContaining({
          key: 'scope.noUnsupportedCarryforwards',
          required: true,
          type: 'boolean',
        }),
      );
      const formQuestions = formPreparation.questions.filter((q) =>
        q.key.startsWith('identity.'),
      );
      expect(
        formQuestions.some(
          (q) => q.key === 'identity.taxNumber' && q.type === 'text',
        ),
      ).toBe(true);
      expect(
        formPreparation.questions.some((q) =>
          q.key.startsWith('businessIdentity.'),
        ),
      ).toBe(false);
      for (const question of formQuestions) {
        const current = await binding(c.caseId);
        await repo.recordDeclaration(owner, c.caseId, randomUUID(), {
          expectedCaseRevision: current.expectedCaseRevision,
          expectedSourceRevision: null,
          factKey: question.key,
          category: 'general',
          value:
            question.type === 'boolean'
              ? { type: 'boolean', value: false }
              : {
                  type: 'text',
                  value:
                    question.key === 'identity.taxNumber'
                      ? '000000000'
                      : question.key === 'identity.language'
                        ? 'en'
                        : question.key === 'identity.firstName'
                          ? '=PRIVATE-ID-FIXTURE'
                          : 'Private fixture',
                },
        });
      }
      const b = await binding(c.caseId),
        saved = await repo.getCase(owner, c.caseId);
      const inputs = saved.declaredInputs.map(
        ({ sourceId, sourceRevision, contentHash }) => ({
          sourceId,
          sourceRevision,
          contentHash,
        }),
      );
      const unreviewed = await repo.createCalculationRun(
        preparer,
        c.caseId,
        randomUUID(),
        b,
      );
      expect(unreviewed.status).toBe('blocked-input');
      await expect(
        repo.reviewWorkingPaperInputs(preparer, c.caseId, randomUUID(), {
          ...b,
          inputs,
        }),
      ).rejects.toThrow('forbidden');
      await expect(
        repo.reviewWorkingPaperInputs(reviewer, c.caseId, randomUUID(), {
          ...b,
          inputs: [inputs[0], inputs[0]],
        }),
      ).rejects.toThrow('Duplicate');
      await expect(
        repo.reviewWorkingPaperInputs(reviewer, c.caseId, randomUUID(), {
          ...b,
          inputs: [{ ...inputs[0], contentHash: 'f'.repeat(64) }],
        }),
      ).rejects.toThrow('source-or-question');
      const reviewKey = randomUUID();
      const reviewed = await repo.reviewWorkingPaperInputs(
        reviewer,
        c.caseId,
        reviewKey,
        { ...b, inputs },
      );
      expect(
        await repo.reviewWorkingPaperInputs(reviewer, c.caseId, reviewKey, {
          ...b,
          inputs: [...inputs].reverse(),
        }),
      ).toEqual(reviewed);
      const key = randomUUID(),
        run = await repo.createCalculationRun(preparer, c.caseId, key, b);
      expect(run.status).toBe('incomplete-working-papers');
      expect(run.complete).toBe(false);
      expect(run.packageVersion).toBe(CANADA_ON_2025_PERSONAL_PACKAGE_VERSION);
      expect(
        await repo.createCalculationRun(preparer, c.caseId, key, b),
      ).toEqual(run);
      const detail = await repo.getCalculationRun(viewer, c.caseId, run.runId);
      expect(detail.schedules.length).toBeGreaterThan(0);
      expect(
        detail.output.formAudit?.requirements.every((r) => r.satisfied),
      ).toBe(true);
      expect(detail.output.formAudit?.signature).toEqual({
        status: 'manual-unperformed',
        blocksCalculation: false,
      });
      expect(JSON.stringify(detail)).not.toContain('=PRIVATE-ID-FIXTURE');
      expect(JSON.stringify(detail)).not.toContain('000000000');
      const pending = await repo.getCalculationRun(
        owner,
        c.caseId,
        unreviewed.runId,
      );
      expect(
        pending.output.formAudit?.requirements.find(
          (r) => r.key === 'identity.taxNumber',
        )?.satisfied,
      ).toBe(false);

      expect(detail.inputBinding.snapshotHash).toBe(run.snapshotHash);
      expect(
        detail.schedules
          .flatMap((s) => s.content)
          .find((s) => s.field.id === 'T1.12100')!.field.reportableAmount,
      ).toBe('10000.17');
      expect(
        (await repo.getCase(owner, c.caseId)).questionnaire.intake.facts,
      ).toEqual([]);
      await expect(
        repo.exportCalculationRun(viewer, c.caseId, run.runId, randomUUID()),
      ).rejects.toThrow('review-required');
      await expect(
        repo.reviewCalculationRun(viewer, c.caseId, run.runId, randomUUID(), {
          expectedOutputHash: run.outputHash,
          acknowledgement: 'reviewed-incomplete-working-papers-not-fileable',
        }),
      ).rejects.toThrow('forbidden');
      const r = await repo.reviewCalculationRun(
        reviewer,
        c.caseId,
        run.runId,
        randomUUID(),
        {
          expectedOutputHash: run.outputHash,
          acknowledgement: 'reviewed-incomplete-working-papers-not-fileable',
        },
      );
      const exported = await repo.exportCalculationRun(
        viewer,
        c.caseId,
        run.runId,
        r.reviewId,
      );
      expect(exported.content).toContain('NOT FILEABLE');
      expect(exported.content).toContain(run.packageHash);
      expect(exported.content).toContain("'=PRIVATE-ID-FIXTURE");
      expect(exported.content).toContain('manual and unperformed');
      expect(exported.sha256).toBe(
        createHash('sha256').update(exported.content).digest('hex'),
      );
      await expect(
        raw(
          owner,
          'update emdo.finance_tax_calculation_runs set complete=true where id=$1',
          [run.runId],
        ),
      ).rejects.toThrow();
      await expect(
        raw(
          owner,
          "insert into emdo.finance_tax_run_schedules(workspace_id,case_id,run_id,form_id,content,content_hash) values($1,$2,$3,'FAKE','[]',repeat('a',64))",
          [workspaceId, c.caseId, run.runId],
        ),
      ).rejects.toThrow();
      const original = (
        await sql(
          'select * from emdo.finance_tax_calculation_runs where id=$1',
          [run.runId],
        )
      ).rows[0]!;
      for (const patch of [
        { output_hash: 'e'.repeat(64) },
        { complete: true },
        {
          input: {
            ...original.input,
            calculationIntake: {
              ...original.input.calculationIntake,
              facts: [
                {
                  ...original.input.calculationIntake.facts[0],
                  source: {
                    kind: 'declaration',
                    reference: `declaration:${randomUUID()}`,
                    revision: 1,
                    contentHash: 'a'.repeat(64),
                  },
                },
              ],
            },
          },
        },
      ]) {
        const forged = {
          ...original,
          ...patch,
          id: randomUUID(),
          created_by: owner.userId,
        };
        const columns = [
          'workspace_id',
          'case_id',
          'tax_subject_id',
          'snapshot_revision',
          'id',
          'snapshot_hash',
          'workflow_id',
          'package_version',
          'package_hash',
          'input_hash',
          'output_hash',
          'status',
          'complete',
          'input',
          'output',
          'created_by',
        ];
        await expect(
          raw(
            owner,
            `insert into emdo.finance_tax_calculation_runs(${columns.join(',')}) values(${columns.map((_, n) => '$' + (n + 1)).join(',')})`,
            columns.map((k) =>
              typeof forged[k] === 'object'
                ? JSON.stringify(forged[k])
                : forged[k],
            ),
          ),
        ).rejects.toThrow();
      }
      const interest = saved.declaredInputs.find(
        (f) => f.factKey === 'interest',
      )!;
      await repo.recordDeclaration(owner, c.caseId, randomUUID(), {
        expectedCaseRevision: b.expectedCaseRevision,
        sourceId: interest.sourceId,
        expectedSourceRevision: interest.sourceRevision,
        factKey: 'interest',
        category: 'general',
        value: { type: 'decimal', value: '20000.19' },
      });
      const changed = await repo.createCalculationRun(
        owner,
        c.caseId,
        randomUUID(),
        await binding(c.caseId),
      );
      expect(changed.status).toBe('blocked-input');
      expect(
        (await repo.getCalculationRun(viewer, c.caseId, run.runId)).summary
          .outputHash,
      ).toBe(run.outputHash);
      await sql(
        'update emdo.finance_book_grants set revoked_at=now() where book_id=$1 and user_id=$2',
        [book.id, owner.userId],
      );
      await expect(
        repo.getCalculationRun(viewer, c.caseId, run.runId),
      ).rejects.toThrow('forbidden');
      await expect(
        repo.exportCalculationRun(viewer, c.caseId, run.runId, r.reviewId),
      ).rejects.toThrow('forbidden');
      expect(
        (
          await raw(
            viewer,
            'select * from emdo.finance_tax_run_schedules where run_id=$1',
            [run.runId],
          )
        ).rows,
      ).toEqual([]);
      const reset = await repo.resetInputsAfterSourceRevocation(
        owner,
        c.caseId,
        randomUUID(),
        { expectedCaseRevision: b.expectedCaseRevision + 1 },
      );
      await sql(
        'update emdo.finance_book_grants set revoked_at=null where book_id=$1 and user_id=$2',
        [book.id, owner.userId],
      );
      await repo.authorizeBookSource(owner, c.caseId, randomUUID(), {
        bookId: book.id,
        expectedCaseRevision: reset.revision,
      });
      await expect(
        repo.getCalculationRun(owner, c.caseId, run.runId),
      ).rejects.toThrow('forbidden');
      expect(
        (await repo.listCalculationRuns(viewer, c.caseId)).some(
          (r) => r.runId === run.runId,
        ),
      ).toBe(false);
      const fresh = await repo.createCalculationRun(
        owner,
        c.caseId,
        randomUUID(),
        await binding(c.caseId),
      );
      expect(fresh.status).toBe('blocked-input');
      await sql(
        "update emdo.household_memberships set status='inactive', ended_at=now() where household_id=$1 and user_id=$2",
        [workspaceId, viewer.userId],
      );
      await expect(
        repo.getCalculationRun(viewer, c.caseId, fresh.runId),
      ).rejects.toThrow();
    }, 60000);
    it('composes a New York case from explicitly reviewed federal and state declarations on one snapshot', async () => {
      await sql(
        "update emdo.household_memberships set status='active', ended_at=null where household_id=$1 and user_id=$2",
        [workspaceId, viewer.userId],
      );
      const federal = us2025TestFixture({
        'business.receipts': '40000',
        'identity.city': 'Albany',
        'identity.state': 'NY',
      });
      const c = await repo.createCase(owner, randomUUID(), {
        mode: 'intake-only',
        title: 'New York private composition fixture',
        taxSubjectName: 'Synthetic New York filer',
        scope: NY_PRIVATE_SCOPE,
        domesticResident: true,
        hasCrossBorderActivity: false,
        standaloneCorporation: null,
        relatedParties: [],
      });
      await repo.grantCaseAccess(owner, c.caseId, randomUUID(), {
        userId: reviewer.userId,
        role: 'reviewer',
        expectedGrantRevision: null,
      });
      await repo.grantCaseAccess(owner, c.caseId, randomUUID(), {
        userId: viewer.userId,
        role: 'viewer',
        expectedGrantRevision: null,
      });
      const nyValue = (question: (typeof NY_2025_REQUIRED_FACTS)[number]) => {
        if ('equals' in question)
          return { type: question.type, value: question.equals };
        if (question.key === 'penalty.method')
          return { type: 'text' as const, value: 'short-method' };
        if (question.key === 'penalty.paymentLedger')
          return { type: 'text' as const, value: '[]' };
        if (
          question.key === 'penalty.balancePaidOn' ||
          question.key === 'penalty.returnBalancePaidOn'
        )
          return { type: 'text' as const, value: 'unpaid' };
        if (question.key === 'penalty.returnFiledOn')
          return { type: 'text' as const, value: 'not-filed' };
        if (question.key === 'identity.homeSameAsMailing')
          return { type: 'boolean' as const, value: true };
        if (question.key === 'identity.firstName')
          return { type: 'text' as const, value: 'Alex' };
        if (question.key === 'identity.middleInitial')
          return { type: 'text' as const, value: 'Q' };
        if (question.key === 'identity.county')
          return { type: 'text' as const, value: 'Albany' };
        if (question.key === 'identity.schoolDistrict')
          return { type: 'text' as const, value: 'Albany' };
        if (question.key === 'identity.schoolDistrictCode')
          return { type: 'text' as const, value: '005' };
        if (
          question.key === 'identity.homeStreet' ||
          question.key === 'identity.homeApartment' ||
          question.key === 'identity.homeCity' ||
          question.key === 'identity.homeZip' ||
          question.key === 'refund.routing' ||
          question.key === 'refund.account'
        )
          return { type: 'text' as const, value: 'none' };
        if (question.key === 'refund.method')
          return { type: 'text' as const, value: 'check' };
        if (question.key === 'localResidence')
          return { type: 'text' as const, value: 'outside-NYC-Yonkers' };
        if (question.key === 'businessLocation')
          return { type: 'text' as const, value: 'outside-MCTD' };
        if (question.key === 'federalInputHash')
          return { type: 'text' as const, value: 'pending' };
        if (question.type === 'boolean')
          return { type: 'boolean' as const, value: false };
        if (question.type === 'date')
          return { type: 'date' as const, value: '2025-01-01' };
        return { type: 'decimal' as const, value: '0' };
      };
      for (const fact of federal.facts)
        await repo.recordDeclaration(owner, c.caseId, randomUUID(), {
          expectedCaseRevision: (await binding(c.caseId)).expectedCaseRevision,
          expectedSourceRevision: null,
          factKey: `federal.${fact.key}`,
          category: 'general',
          value: fact.value,
        });
      for (const question of NY_2025_REQUIRED_FACTS)
        await repo.recordDeclaration(owner, c.caseId, randomUUID(), {
          expectedCaseRevision: (await binding(c.caseId)).expectedCaseRevision,
          expectedSourceRevision: null,
          factKey: `newYork.${question.key}`,
          category: 'general',
          value: nyValue(question),
        });
      const preparation = await repo.getWorkingPaperPreparation(
        owner,
        c.caseId,
      );
      expect(preparation.workflowId).toBe('us-ny-2025-working-papers');
      expect(preparation.scopeSupported).toBe(true);
      expect(preparation.questions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'federal.filingStatus' }),
          expect.objectContaining({ key: 'newYork.residency' }),
          expect.objectContaining({ key: 'wageEvidence.documents' }),
        ]),
      );
      const declarations = await repo.listDeclarations(owner, c.caseId);
      await repo.reviewWorkingPaperInputs(reviewer, c.caseId, randomUUID(), {
        ...(await binding(c.caseId)),
        inputs: declarations.map(
          ({ sourceId, sourceRevision, contentHash }) => ({
            sourceId,
            sourceRevision,
            contentHash,
          }),
        ),
      });
      const run = await repo.createCalculationRun(
        owner,
        c.caseId,
        randomUUID(),
        await binding(c.caseId),
      );
      expect(run.workflowId).toBe('us-ny-2025-working-papers');
      const diagnostics = await raw(
        owner,
        "select output->'issues' as issues from emdo.finance_tax_calculation_runs where id=$1",
        [run.runId],
      );
      expect(run.status, JSON.stringify(diagnostics.rows)).toBe(
        'incomplete-working-papers',
      );
      for (const [path, value] of [
        ['{federalCalculationIntake,revision}', '1'],
        ['{federalCalculationIntake,sourceBooks}', '[{"bookId":"foreign"}]'],
        ['{federalCalculationIntake,facts}', '[]'],
      ]) {
        await expect(
          raw(
            owner,
            `with original as (select * from emdo.finance_tax_calculation_runs where id=$1), altered as (select original.*, jsonb_set(input,$3::text[],$4::jsonb) as altered_input from original) insert into emdo.finance_tax_calculation_runs(workspace_id,case_id,tax_subject_id,snapshot_revision,id,snapshot_hash,workflow_id,package_version,package_hash,input_hash,output_hash,status,complete,input,output,created_by) select workspace_id,case_id,tax_subject_id,snapshot_revision,$2::uuid,snapshot_hash,workflow_id,package_version,package_hash,emdo.canonical_json_hash(altered_input),emdo.canonical_json_hash(output),status,complete,altered_input,output,created_by from altered`,
            [run.runId, randomUUID(), path, value],
          ),
        ).rejects.toThrow();
      }

      const detail = await repo.getCalculationRun(viewer, c.caseId, run.runId);
      expect(
        detail.schedules.some((schedule) => schedule.formId === 'IT-201'),
      ).toBe(true);
      expect(detail.output.complete).toBe(false);
      expect(detail.output.reportable).toBe(false);
      const review = await repo.reviewCalculationRun(
        reviewer,
        c.caseId,
        run.runId,
        randomUUID(),
        {
          expectedOutputHash: run.outputHash,
          acknowledgement: 'reviewed-incomplete-working-papers-not-fileable',
        },
      );
      const exported = await repo.exportCalculationRun(
        viewer,
        c.caseId,
        run.runId,
        review.reviewId,
      );
      expect(exported.content).toContain('Private US-NY working papers');
      expect(exported.content).toContain('state and local filing disabled');
    }, 120000);
  },
);

import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FinanceTaxValueSchema, type WorkspaceContext } from '@emdo/contracts';
import { MEXICO_2025_PRIVATE_QUESTIONNAIRES } from '@emdo/domains/finance';
import { PostgresFinanceTaxRepository } from './finance-tax-repository.js';
import { PostgresFinanceV2Repository } from './finance-v2-repository.js';

const databaseUrl = process.env.FINANCE_V2_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  'Mexico private tax working papers on restricted PostgreSQL',
  () => {
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const login = `mexico_tax_${randomUUID().replaceAll('-', '')}`;
    let app: pg.Pool;
    const pool = {
      async connect() {
        const c = await app.connect();
        await c.query('set role emdo_app');
        return c;
      },
    };
    const repo = new PostgresFinanceTaxRepository(pool);
    const books = new PostgresFinanceV2Repository(pool);
    const workspaceId = randomUUID();
    const actor = (): WorkspaceContext => ({
      workspaceId,
      userId: randomUUID(),
      sessionId: randomUUID(),
      requestId: randomUUID(),
    });
    const owner = actor(),
      reviewer = actor(),
      viewer = actor(),
      outsider = actor();
    beforeAll(async () => {
      await admin.query(
        `create role "${login}" login nosuperuser nobypassrls noinherit`,
      );
      await admin.query(`grant emdo_app to "${login}"`);
      const url = new URL(databaseUrl!);
      url.username = login;
      app = new pg.Pool({ connectionString: url.toString() });
      for (const who of [owner, reviewer, viewer, outsider])
        await admin.query(
          'insert into emdo.auth_users(id,name,email,email_verified) values($1,$2,$3,true)',
          [
            who.userId,
            'Synthetic Mexico taxpayer',
            `${who.userId}@example.test`,
          ],
        );
      await admin.query(
        "insert into emdo.households(id,name,created_by_user_id,slug) values($1::uuid,'Mexico private cases',$2,$1::text)",
        [workspaceId, outsider.userId],
      );
      for (const who of [owner, reviewer, viewer, outsider]) {
        await admin.query(
          'insert into emdo.household_memberships(household_id,user_id,role) values($1,$2,$3)',
          [workspaceId, who.userId, who === outsider ? 'owner' : 'member'],
        );
        await admin.query(
          "insert into emdo.auth_sessions(id,user_id,token,expires_at,active_household_id) values($1::uuid,$2,$1::text,now()+interval '1 day',$3)",
          [who.sessionId, who.userId, workspaceId],
        );
      }
    });
    afterAll(async () => {
      await app?.end();
      await admin.query(`drop role if exists "${login}"`);
      await admin.end();
    });
    type Taxpayer = 'individual' | 'sole-proprietor' | 'corporation';
    const questionnaire = (type: Taxpayer) =>
      MEXICO_2025_PRIVATE_QUESTIONNAIRES.find(
        (q) => q.scope.taxpayerType === type,
      )!;
    async function create(type: Taxpayer, legalEntityId?: string) {
      return repo.createCase(owner, randomUUID(), {
        mode: 'intake-only',
        title: 'Private Mexico working papers',
        taxSubjectName: 'Synthetic private taxpayer',
        scope: questionnaire(type).scope,
        domesticResident: true,
        hasCrossBorderActivity: false,
        standaloneCorporation: type === 'corporation' ? true : null,
        relatedParties: [],
        ...(legalEntityId ? { legalEntityId } : {}),
      });
    }
    async function binding(caseId: string) {
      const p = await repo.getWorkingPaperPreparation(owner, caseId);
      return {
        workflowId: p.workflowId,
        expectedPackageVersion: p.packageVersion,
        expectedCaseRevision: p.snapshotRevision,
        expectedSnapshotHash: p.snapshotHash,
      };
    }
    async function caseRoles(caseId: string) {
      for (const [who, role] of [
        [reviewer, 'reviewer'],
        [viewer, 'viewer'],
      ] as const)
        await repo.grantCaseAccess(owner, caseId, randomUUID(), {
          userId: who.userId,
          role,
          expectedGrantRevision: null,
        });
    }
    function corporateValue(
      question: ReturnType<typeof questionnaire>['questions'][number],
    ) {
      const values: Record<string, string> = {
        'corporation.investments.rows': '[]',
        'corporation.accruedIncome': '1000000',
        'corporation.authorizedDeductions': '400000',
        'corporation.provisionalPayments': '100000',
      };
      const value =
        values[question.key] ??
        (/^corporation\.inflation\.\d{2}\.credits$/.test(question.key)
          ? '100000'
          : /^corporation\.inflation\.\d{2}\.debts$/.test(question.key)
            ? '300000'
            : (question.requiredValue ??
              (question.type === 'boolean' ? false : '0')));
      return FinanceTaxValueSchema.parse({ type: question.type, value });
    }
    async function corporateDeclarations(
      caseId: string,
      overrides: Record<string, string> = {},
    ) {
      let revision = (await binding(caseId)).expectedCaseRevision;
      for (const question of questionnaire('corporation').questions) {
        const saved = await repo.recordDeclaration(
          owner,
          caseId,
          randomUUID(),
          {
            expectedCaseRevision: revision,
            expectedSourceRevision: null,
            factKey: question.key,
            category: 'general',
            value:
              question.key in overrides
                ? FinanceTaxValueSchema.parse({
                    type: question.type,
                    value: overrides[question.key],
                  })
                : corporateValue(question),
          },
        );
        revision = saved.revision;
      }
      return repo.listDeclarations(owner, caseId);
    }
    async function raw(who: WorkspaceContext, text: string, values: unknown[]) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(
          "select set_config('emdo.user_id',$1,true),set_config('emdo.session_id',$2,true),set_config('emdo.request_id',$3,true)",
          [who.userId, who.sessionId, randomUUID()],
        );
        const result = await client.query(text, values);
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    }

    it.each(['individual', 'sole-proprietor', 'corporation'] as const)(
      'prepares exact %s scope but saves a blocked run when required reviewed facts are missing',
      async (type) => {
        const c = await create(type);
        const p = await repo.getWorkingPaperPreparation(owner, c.caseId);
        expect(p.workflowId).toBe('mx-fed-2025-working-papers');
        expect(p.scopeSupported).toBe(true);
        expect(p.complete).toBe(false);
        expect(p.questions.map((q) => q.key)).toEqual(
          expect.arrayContaining(
            questionnaire(type).questions.map((q) => q.key),
          ),
        );
        expect(p.inputReviews).toEqual([]);
        const run = await repo.createCalculationRun(
          owner,
          c.caseId,
          randomUUID(),
          await binding(c.caseId),
        );
        expect(run.status).toBe('blocked-input');
        expect(run.complete).toBe(false);
        const detail = await repo.getCalculationRun(owner, c.caseId, run.runId);
        expect(detail.output).toMatchObject({
          complete: false,
          enabled: false,
          reportable: false,
          finalAmounts: { refund: null, balanceOwing: null },
        });
        expect(detail.output.issues.length).toBeGreaterThan(0);
        await expect(
          repo.reviewCalculationRun(owner, c.caseId, run.runId, randomUUID(), {
            expectedOutputHash: run.outputHash,
            acknowledgement: 'reviewed-incomplete-working-papers-not-fileable',
          }),
        ).rejects.toThrow();
        await expect(
          repo.getWorkingPaperPreparation(outsider, c.caseId),
        ).rejects.toThrow();
      },
    );

    it('rejects ungranted and cross-workspace corporate legal entity bindings', async () => {
      const inaccessible = await books.createBook(outsider, randomUUID(), {
        name: 'Other private entity',
        entityName: 'Other taxpayer',
        entityKind: 'corporation',
        country: 'MX',
        functionalCurrency: 'MXN',
      });
      await expect(
        create('corporation', String(inaccessible.entityId)),
      ).rejects.toThrow();
      const other = {
        ...owner,
        workspaceId: randomUUID(),
        sessionId: randomUUID(),
        requestId: randomUUID(),
      };
      await admin.query(
        "insert into emdo.households(id,name,created_by_user_id,slug) values($1::uuid,'Other workspace',$2,$1::text)",
        [other.workspaceId, owner.userId],
      );
      await admin.query(
        "insert into emdo.household_memberships(household_id,user_id,role) values($1,$2,'owner')",
        [other.workspaceId, owner.userId],
      );
      await admin.query(
        "insert into emdo.auth_sessions(id,user_id,token,expires_at,active_household_id) values($1::uuid,$2,$1::text,now()+interval '1 day',$3)",
        [other.sessionId, owner.userId, other.workspaceId],
      );
      const foreign = await books.createBook(other, randomUUID(), {
        name: 'Foreign workspace entity',
        entityName: 'Other workspace taxpayer',
        entityKind: 'corporation',
        country: 'MX',
        functionalCurrency: 'MXN',
      });
      await expect(
        create('corporation', String(foreign.entityId)),
      ).rejects.toThrow();
    });

    it('saves exact asset deductions and per-asset evidence in reviewed exports', async () => {
      const book = await books.createBook(owner, randomUUID(), {
        name: 'Mexico asset source',
        entityName: 'Synthetic asset company',
        entityKind: 'corporation',
        country: 'MX',
        functionalCurrency: 'MXN',
      });
      const c = await create('corporation', String(book.entityId));
      const assets = JSON.stringify([
        {
          assetId: 'computer1',
          assetClass: 'computer-equipment',
          acquisitionDate: '2025-01-01',
          firstUseDate: '2025-01-01',
          originalInvestment: '100000',
        },
        {
          assetId: 'office1',
          assetClass: 'office-furniture-equipment',
          acquisitionDate: '2025-06-15',
          firstUseDate: '2025-07-01',
          originalInvestment: '120000',
        },
      ]);
      const declarations = await corporateDeclarations(c.caseId, {
        'corporation.investments.rows': assets,
      });
      const request = await binding(c.caseId);
      await repo.reviewWorkingPaperInputs(owner, c.caseId, randomUUID(), {
        ...request,
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
        request,
      );
      expect(run.status).toBe('incomplete-working-papers');
      const detail = await repo.getCalculationRun(owner, c.caseId, run.runId);
      const fields = detail.schedules.flatMap((schedule) =>
        schedule.content.map((row) => row.field),
      );
      expect(
        fields.find(
          (field) =>
            field.id === 'DEDUCCIONES_PERSONA_MORAL.investmentDeductions',
        ),
      ).toMatchObject({
        exactDecimal: '36480.6',
        reportableAmount: null,
      });
      // Existing inflation fixture adds 7380 income; exact tax is (1000000+7380-400000-36480.6)*0.3-100000.
      expect(fields.find((field) => field.id === 'PAGO.taxDue')).toMatchObject({
        exactDecimal: '71269.82',
        reportableAmount: null,
      });
      const review = await repo.reviewCalculationRun(
        owner,
        c.caseId,
        run.runId,
        randomUUID(),
        {
          expectedOutputHash: run.outputHash,
          acknowledgement: 'reviewed-incomplete-working-papers-not-fileable',
        },
      );
      const exported = await repo.exportCalculationRun(
        owner,
        c.caseId,
        run.runId,
        review.reviewId,
      );
      for (const value of [
        'computer1',
        'office1',
        '36480',
        'inegi-mx-inpc-2025-06',
      ])
        expect(exported.content).toContain(value);
      const source = declarations.find(
        (declaration) => declaration.factKey === 'corporation.investments.rows',
      )!;
      expect(exported.content).toContain(source.contentHash);
      expect(exported.content).toContain(source.sourceId);
    });

    it('binds reviewed corporate inflation sources to immutable non-fileable runs and historical exports', async () => {
      const book = await books.createBook(owner, randomUUID(), {
        name: 'Mexico corporate source',
        entityName: 'Synthetic company',
        entityKind: 'corporation',
        country: 'MX',
        functionalCurrency: 'MXN',
      });
      const c = await create('corporation', String(book.entityId));
      await caseRoles(c.caseId);
      const initial = await repo.getCase(owner, c.caseId);
      expect(initial.questionnaire.intake.legalEntityId).toBe(book.entityId);
      expect(initial.questionnaire.intake.sourceBooks).toEqual([]);
      const authorization = await repo.authorizeBookSource(
        owner,
        c.caseId,
        randomUUID(),
        {
          bookId: book.id,
          expectedCaseRevision: (await binding(c.caseId)).expectedCaseRevision,
        },
      );
      const declarations = await corporateDeclarations(c.caseId);
      const request = await binding(c.caseId);
      expect(request.workflowId).toBe('mx-fed-2025-working-papers');
      const unreviewed = await repo.createCalculationRun(
        owner,
        c.caseId,
        randomUUID(),
        request,
      );
      expect(unreviewed.status).toBe('blocked-input');
      const inputs = declarations.map(
        ({ sourceId, sourceRevision, contentHash }) => ({
          sourceId,
          sourceRevision,
          contentHash,
        }),
      );
      await expect(
        repo.reviewWorkingPaperInputs(viewer, c.caseId, randomUUID(), {
          ...request,
          inputs,
        }),
      ).rejects.toThrow();
      await expect(
        repo.reviewWorkingPaperInputs(reviewer, c.caseId, randomUUID(), {
          ...request,
          expectedSnapshotHash: 'f'.repeat(64),
          inputs,
        }),
      ).rejects.toThrow();
      await expect(
        repo.reviewWorkingPaperInputs(reviewer, c.caseId, randomUUID(), {
          ...request,
          inputs: [{ ...inputs[0], contentHash: 'f'.repeat(64) }],
        }),
      ).rejects.toThrow();
      const reviewKey = randomUUID();
      const reviewedInputs = await repo.reviewWorkingPaperInputs(
        reviewer,
        c.caseId,
        reviewKey,
        { ...request, inputs },
      );
      expect(
        await repo.reviewWorkingPaperInputs(reviewer, c.caseId, reviewKey, {
          ...request,
          inputs: [...inputs].reverse(),
        }),
      ).toEqual(reviewedInputs);
      const key = randomUUID();
      const run = await repo.createCalculationRun(
        owner,
        c.caseId,
        key,
        request,
      );
      expect(
        await repo.createCalculationRun(owner, c.caseId, key, request),
      ).toEqual(run);
      expect(run.status).toBe('incomplete-working-papers');
      expect(run.complete).toBe(false);
      const detail = await repo.getCalculationRun(viewer, c.caseId, run.runId);
      expect(detail.inputBinding).toMatchObject({
        snapshotRevision: request.expectedCaseRevision,
        snapshotHash: request.expectedSnapshotHash,
      });
      expect(detail.inputBinding.inputReviews).toHaveLength(
        declarations.length,
      );
      expect(detail.inputBinding.inputReviews).toEqual(
        expect.arrayContaining(
          inputs.map((input) => expect.objectContaining(input)),
        ),
      );
      const fields = detail.schedules
        .flatMap((s) => s.content)
        .map((c) => c.field);
      for (const [id, amount] of Object.entries({
        'INGRESOS_PERSONA_MORAL.averageAnnualCredits': '100000',
        'INGRESOS_PERSONA_MORAL.averageAnnualDebts': '300000',
        'INGRESOS_PERSONA_MORAL.annualInflationAdjustmentIncome': '7380',
        'DECLARACION_ANUAL_MORAL.isrCaused': '182214',
        'PAGO.taxDue': '82214',
      })) {
        expect(fields.find((field) => field.id === id)).toMatchObject({
          exactDecimal: amount,
          exactRational: { numerator: amount, denominator: '1' },
          reportableAmount: null,
        });
      }
      expect(detail.output).toMatchObject({
        complete: false,
        enabled: false,
        reportable: false,
        finalAmounts: { refund: null, balanceOwing: null },
      });
      expect(
        detail.authorities.some((a) => a.id === 'inegi-mx-inpc-december-2025'),
      ).toBe(true);
      await expect(
        raw(
          owner,
          "update emdo.finance_tax_calculation_runs set output='{}'::jsonb where id=$1",
          [run.runId],
        ),
      ).rejects.toThrow();
      await expect(
        repo.reviewCalculationRun(reviewer, c.caseId, run.runId, randomUUID(), {
          expectedOutputHash: 'f'.repeat(64),
          acknowledgement: 'reviewed-incomplete-working-papers-not-fileable',
        }),
      ).rejects.toThrow();
      await expect(
        repo.exportCalculationRun(viewer, c.caseId, run.runId, randomUUID()),
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
      expect(
        await repo.exportCalculationRun(
          viewer,
          c.caseId,
          run.runId,
          review.reviewId,
        ),
      ).toEqual(exported);
      expect(exported.sha256).toBe(
        createHash('sha256').update(exported.content).digest('hex'),
      );
      expect(exported.content).toContain('incomplete and not fileable');
      expect(exported.content).toContain('82214');
      expect(exported.content).toContain(request.expectedSnapshotHash);
      for (const input of inputs) {
        expect(exported.content).toContain(String(input.sourceId));
        expect(exported.content).toContain(String(input.contentHash));
      }
      const foreign = await create('individual');
      await expect(
        repo.getCalculationRun(owner, foreign.caseId, run.runId),
      ).rejects.toThrow();
      await expect(
        repo.getCalculationRun(outsider, c.caseId, run.runId),
      ).rejects.toThrow();
      await expect(
        repo.exportCalculationRun(
          outsider,
          c.caseId,
          run.runId,
          review.reviewId,
        ),
      ).rejects.toThrow();
      const fact = declarations.find(
        (d) => d.factKey === 'corporation.inflation.12.debts',
      )!;
      await repo.recordDeclaration(owner, c.caseId, randomUUID(), {
        expectedCaseRevision: request.expectedCaseRevision,
        expectedSourceRevision: fact.sourceRevision,
        sourceId: fact.sourceId,
        factKey: fact.factKey,
        category: 'general',
        value: { type: 'decimal', value: '300001' },
      });
      expect(
        (await repo.getWorkingPaperPreparation(owner, c.caseId)).inputReviews,
      ).toEqual([]);
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
      expect(
        await repo.exportCalculationRun(
          viewer,
          c.caseId,
          run.runId,
          review.reviewId,
        ),
      ).toEqual(exported);
      expect(await repo.getCalculationRun(viewer, c.caseId, run.runId)).toEqual(
        { ...detail, reviews: expect.any(Array) },
      );
      const viewerGrant = (await repo.listCaseGrants(owner, c.caseId)).find(
        (g) => g.userId === viewer.userId,
      )!;
      await repo.revokeCaseAccess(owner, c.caseId, randomUUID(), {
        userId: viewer.userId,
        expectedGrantRevision: viewerGrant.revision,
      });
      await expect(
        repo.getCalculationRun(viewer, c.caseId, run.runId),
      ).rejects.toThrow();
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
  },
);

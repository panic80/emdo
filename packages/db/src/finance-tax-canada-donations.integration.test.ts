import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FinanceTaxValueSchema, type WorkspaceContext } from '@emdo/contracts';
import { PostgresFinanceTaxRepository } from './finance-tax-repository.js';

const databaseUrl = process.env.FINANCE_V2_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  'Canada private Schedule 9 donation history on restricted PostgreSQL',
  () => {
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const login = `canada_donations_${randomUUID().replaceAll('-', '')}`;
    let app: pg.Pool;
    const pool = {
      async connect() {
        const c = await app.connect();
        await c.query('set role emdo_app');
        return c;
      },
    };
    const repo = new PostgresFinanceTaxRepository(pool);
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
            'Synthetic donation reviewer',
            `${who.userId}@example.test`,
          ],
        );
      await admin.query(
        "insert into emdo.households(id,name,created_by_user_id,slug) values($1::uuid,'Private donation cases',$2,$1::text)",
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
    const scope = {
      country: 'CA',
      subdivision: 'CA-ON',
      taxpayerType: 'individual',
      year: 2025,
      regime: 'income-tax-return',
      formVersion: '5006-R-E-25_5006-C-E-25',
    };
    async function create() {
      const c = await repo.createCase(owner, randomUUID(), {
        mode: 'intake-only',
        title: 'Reviewed donation carryforwards',
        taxSubjectName: 'Synthetic donor',
        scope,
        domesticResident: true,
        hasCrossBorderActivity: false,
        standaloneCorporation: null,
        relatedParties: [],
      });
      for (const [who, role] of [
        [reviewer, 'reviewer'],
        [viewer, 'viewer'],
      ] as const)
        await repo.grantCaseAccess(owner, c.caseId, randomUUID(), {
          userId: who.userId,
          role,
          expectedGrantRevision: null,
        });
      return c;
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
    async function populate(caseId: string, omit?: string) {
      const p = await repo.getWorkingPaperPreparation(owner, caseId);
      expect(p.workflowId).toBe('ca-on-2025-personal-working-papers');
      expect(p.scopeSupported).toBe(true);
      expect(
        p.questions
          .filter((q) => /^donations\.carryforward\./.test(q.key))
          .map((q) => q.key),
      ).toEqual(
        [2020, 2021, 2022, 2023, 2024].map(
          (y) => `donations.carryforward.${y}`,
        ),
      );
      let revision = p.snapshotRevision;
      for (const question of p.questions) {
        if (question.key === omit) continue;
        const value = FinanceTaxValueSchema.parse({
          type: question.type,
          value:
            question.type === 'boolean'
              ? !question.key.startsWith('identity.') &&
                !question.key.startsWith('educator.') &&
                question.key !== 'business.methodChanged'
              : question.type === 'date'
                ? '1990-01-01'
                : question.type === 'text'
                  ? question.key === 'identity.taxNumber'
                    ? '000000000'
                    : question.key === 'identity.language'
                      ? 'en'
                      : 'Synthetic private donor'
                  : question.key === 'interest'
                    ? '30000'
                    : [
                          'donations.currentEligibleGifts',
                          'donations.claimAmount',
                        ].includes(question.key)
                      ? '1000'
                      : /^donations\.carryforward\.202[0-4]$/.test(question.key)
                        ? '100'
                        : '0',
        });
        revision = (
          await repo.recordDeclaration(owner, caseId, randomUUID(), {
            expectedCaseRevision: revision,
            expectedSourceRevision: null,
            factKey: question.key,
            category: 'general',
            value,
          })
        ).revision;
      }
      return repo.listDeclarations(owner, caseId);
    }
    async function reviewInputs(caseId: string, excluded?: string) {
      const request = await binding(caseId);
      const declarations = await repo.listDeclarations(owner, caseId);
      const inputs = declarations
        .filter((d) => d.factKey !== excluded)
        .map(({ sourceId, sourceRevision, contentHash }) => ({
          sourceId,
          sourceRevision,
          contentHash,
        }));
      await repo.reviewWorkingPaperInputs(reviewer, caseId, randomUUID(), {
        ...request,
        inputs,
      });
      return { request, declarations, inputs };
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
    const savedDonation = async (caseId: string, runId: string) =>
      (
        await raw(
          viewer,
          "select output->'charitableDonations' as donation from emdo.finance_tax_calculation_runs where case_id=$1 and id=$2",
          [caseId, runId],
        )
      ).rows[0].donation;
    const field = (
      detail: Awaited<ReturnType<typeof repo.getCalculationRun>>,
      id: string,
    ) =>
      detail.schedules.flatMap((s) => s.content).find((c) => c.field.id === id)!
        .field;

    function donationExportRows(content: string) {
      // Exported section rows quote every cell, including escaped source JSON.
      return content
        .split('\n')
        .filter((line) =>
          line.startsWith('"Carryforward row","charitable-donations",'),
        )
        .map((line) =>
          Array.from(line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g), (match) =>
            match[1]!.replaceAll('""', '"'),
          ),
        );
    }

    it.each(['missing', 'unreviewed'] as const)(
      'blocks a nonzero donation when the 2024 carryforward source is %s',
      async (state) => {
        const c = await create();
        const key = 'donations.carryforward.2024';
        await populate(c.caseId, state === 'missing' ? key : undefined);
        const { request } = await reviewInputs(
          c.caseId,
          state === 'unreviewed' ? key : undefined,
        );
        const run = await repo.createCalculationRun(
          owner,
          c.caseId,
          randomUUID(),
          request,
        );
        expect(run.status).toBe('blocked-input');
        expect(run.complete).toBe(false);
        const detail = await repo.getCalculationRun(
          viewer,
          c.caseId,
          run.runId,
        );
        expect(JSON.stringify(detail.output.issues)).toContain(key);
        await expect(
          repo.reviewCalculationRun(
            reviewer,
            c.caseId,
            run.runId,
            randomUUID(),
            {
              expectedOutputHash: run.outputHash,
              acknowledgement:
                'reviewed-incomplete-working-papers-not-fileable',
            },
          ),
        ).rejects.toThrow();
      },
      120000,
    );

    it('saves exact Schedule 9 credit and oldest-first carryforward sources, then preserves history across a reviewed amendment', async () => {
      const c = await create();
      await populate(c.caseId);
      const { request, declarations, inputs } = await reviewInputs(c.caseId);
      const key = randomUUID();
      const run = await repo.createCalculationRun(
        owner,
        c.caseId,
        key,
        request,
      );
      expect(run.status).toBe('incomplete-working-papers');
      expect(
        await repo.createCalculationRun(owner, c.caseId, key, request),
      ).toEqual(run);
      const detail = await repo.getCalculationRun(viewer, c.caseId, run.runId);
      expect(detail.inputBinding).toMatchObject({
        snapshotRevision: request.expectedCaseRevision,
        snapshotHash: request.expectedSnapshotHash,
      });
      expect(detail.inputBinding.inputReviews).toEqual(
        expect.arrayContaining(
          inputs.map((input) => expect.objectContaining(input)),
        ),
      );
      // Independent credit: $200 × 14.5% + $800 × 29% = $261.
      for (const [id, exact] of Object.entries({
        'Schedule9.13': '200',
        'Schedule9.14': '800',
        'Schedule9.21': '232',
        'Schedule9.22': '29',
        'Schedule9.23': '261',
        'T1.34900': '261',
      }))
        expect(field(detail, id).exactDecimal).toBe(exact);
      expect(field(detail, 'T1.34900').reportableAmount).toBe('261.00');
      expect(field(detail, 'T1.34900').dependencies).toEqual(
        expect.arrayContaining([
          'Schedule9.23',
          ...[2020, 2021, 2022, 2023, 2024].map(
            (y) => `fact:donations.carryforward.${y}`,
          ),
        ]),
      );
      expect(detail.output).toMatchObject({
        complete: false,
        enabled: false,
        reportable: false,
        finalAmounts: { refund: null, balanceOwing: null },
      });
      const donation = await savedDonation(c.caseId, run.runId);
      expect(donation).toMatchObject({
        status: 'calculated',
        claimedFromCarryforward: { exactDecimal: '500' },
        claimedFromCurrentYear: { exactDecimal: '500' },
        currentYearClosingBalance: { exactDecimal: '500' },
      });
      expect(
        donation.carryforwardLedger.map(
          (row: {
            year: number;
            openingBalance: { exactDecimal: string };
            claimedIn2025: { exactDecimal: string };
            closingBalance: { exactDecimal: string };
          }) => [
            row.year,
            row.openingBalance.exactDecimal,
            row.claimedIn2025.exactDecimal,
            row.closingBalance.exactDecimal,
          ],
        ),
      ).toEqual(
        [2020, 2021, 2022, 2023, 2024].map((y) => [y, '100', '100', '0']),
      );
      for (const entry of donation.carryforwardLedger) {
        const source = declarations.find(
          (d) => d.factKey === `donations.carryforward.${entry.year}`,
        )!;
        expect(entry.sourceBinding).toMatchObject({
          revision: source.sourceRevision,
          contentHash: source.contentHash,
        });
        expect(entry.sourceBinding.reference).toContain(
          String(source.sourceId),
        );
      }
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
      const original = await repo.exportCalculationRun(
        viewer,
        c.caseId,
        run.runId,
        review.reviewId,
      );
      expect(original.sha256).toBe(
        createHash('sha256').update(original.content).digest('hex'),
      );
      expect(original.content).toContain('NOT FILEABLE');
      const exportedRows = donationExportRows(original.content);
      expect(
        exportedRows.map((row) => [row[3], row[8], row[11], row[14], row[17]]),
      ).toEqual([
        ...[2020, 2021, 2022, 2023, 2024].map((year) => [
          String(year),
          '100',
          '100',
          '0',
          '0',
        ]),
        ['2025', '1000', '500', '0', '500'],
      ]);
      for (const row of exportedRows) {
        const source = declarations.find((d) => d.factKey === row[4])!;
        expect(JSON.parse(row[19]!)).toMatchObject({
          revision: source.sourceRevision,
          contentHash: source.contentHash,
        });
      }

      for (const source of declarations.filter((d) =>
        /^donations\.carryforward\./.test(String(d.factKey)),
      )) {
        expect(
          original.content.includes(String(source.sourceId)),
          'Export retains carryforward source identity',
        ).toBe(true);
        expect(
          original.content.includes(String(source.contentHash)),
          'Export retains carryforward source hash',
        ).toBe(true);
      }
      await expect(
        raw(
          owner,
          "update emdo.finance_tax_calculation_runs set output='{}'::jsonb where id=$1",
          [run.runId],
        ),
      ).rejects.toThrow();
      const claimFact = declarations.find(
        (d) => d.factKey === 'donations.claimAmount',
      )!;
      await repo.recordDeclaration(owner, c.caseId, randomUUID(), {
        expectedCaseRevision: request.expectedCaseRevision,
        sourceId: claimFact.sourceId,
        expectedSourceRevision: claimFact.sourceRevision,
        factKey: claimFact.factKey,
        category: 'general',
        value: { type: 'decimal', value: '200' },
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
      ).toEqual(original);
      const amendedBinding = await reviewInputs(c.caseId);
      const amended = await repo.createCalculationRun(
        owner,
        c.caseId,
        randomUUID(),
        amendedBinding.request,
      );
      expect(amended.status).toBe('incomplete-working-papers');
      expect(amended.outputHash).not.toBe(run.outputHash);
      expect(amended.snapshotHash).not.toBe(run.snapshotHash);
      const amendedDetail = await repo.getCalculationRun(
        viewer,
        c.caseId,
        amended.runId,
      );
      expect(field(amendedDetail, 'Schedule9.23').exactDecimal).toBe('29');
      expect(field(amendedDetail, 'T1.34900').exactDecimal).toBe('29');
      const amendedDonation = await savedDonation(c.caseId, amended.runId);
      expect(amendedDonation).toMatchObject({
        claimedFromCarryforward: { exactDecimal: '200' },
        claimedFromCurrentYear: { exactDecimal: '0' },
        currentYearClosingBalance: { exactDecimal: '1000' },
      });
      expect(
        amendedDonation.carryforwardLedger.map(
          (row: { year: number; closingBalance: { exactDecimal: string } }) => [
            row.year,
            row.closingBalance.exactDecimal,
          ],
        ),
      ).toEqual([
        [2020, '0'],
        [2021, '0'],
        [2022, '100'],
        [2023, '100'],
        [2024, '100'],
      ]);
      await expect(
        repo.reviewCalculationRun(
          reviewer,
          c.caseId,
          amended.runId,
          randomUUID(),
          {
            expectedOutputHash: run.outputHash,
            acknowledgement: 'reviewed-incomplete-working-papers-not-fileable',
          },
        ),
      ).rejects.toThrow();
      const amendedReview = await repo.reviewCalculationRun(
        reviewer,
        c.caseId,
        amended.runId,
        randomUUID(),
        {
          expectedOutputHash: amended.outputHash,
          acknowledgement: 'reviewed-incomplete-working-papers-not-fileable',
        },
      );
      const amendedExport = await repo.exportCalculationRun(
        viewer,
        c.caseId,
        amended.runId,
        amendedReview.reviewId,
      );
      expect(amendedExport.sha256).not.toBe(original.sha256);
      expect(
        donationExportRows(amendedExport.content).map((row) => [
          row[3],
          row[11],
          row[17],
        ]),
      ).toEqual([
        ['2020', '100', '0'],
        ['2021', '100', '0'],
        ['2022', '0', '100'],
        ['2023', '0', '100'],
        ['2024', '0', '100'],
        ['2025', '0', '1000'],
      ]);

      expect(await savedDonation(c.caseId, run.runId)).toEqual(donation);
      expect(
        await repo.exportCalculationRun(
          viewer,
          c.caseId,
          run.runId,
          review.reviewId,
        ),
      ).toEqual(original);
      const foreign = await create();
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
    }, 120000);
  },
);

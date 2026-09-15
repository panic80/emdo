import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkspaceContext } from '@emdo/contracts';
import { PostgresFinanceTaxRepository } from './finance-tax-repository.js';
import { PostgresFinanceV2Repository } from './finance-v2-repository.js';

const databaseUrl = process.env.FINANCE_V2_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  'Initial private tax legal entity binding on restricted PostgreSQL',
  () => {
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const login = `tax_entity_${randomUUID().replaceAll('-', '')}`;
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
      preparer = actor(),
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
      for (const who of [owner, preparer, reviewer, viewer, outsider])
        await admin.query(
          'insert into emdo.auth_users(id,name,email,email_verified) values($1,$2,$3,true)',
          [
            who.userId,
            'Synthetic entity binding',
            `${who.userId}@example.test`,
          ],
        );
      await admin.query(
        "insert into emdo.households(id,name,created_by_user_id,slug) values($1::uuid,'Private entity bindings',$2,$1::text)",
        [workspaceId, outsider.userId],
      );
      for (const who of [owner, preparer, reviewer, viewer, outsider]) {
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
    async function create() {
      const c = await repo.createCase(owner, randomUUID(), {
        mode: 'intake-only',
        title: 'Unbound private corporation',
        taxSubjectName: 'Synthetic corporation',
        scope: {
          country: 'MX',
          subdivision: 'MX-FED',
          taxpayerType: 'corporation',
          year: 2025,
          regime: 'income-tax-return',
          formVersion: 'declaracion-anual-pm-2025-regimen-general',
        },
        domesticResident: true,
        hasCrossBorderActivity: false,
        standaloneCorporation: true,
        relatedParties: [],
      });
      for (const [who, role] of [
        [preparer, 'preparer'],
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
    const book = (who = owner) =>
      books.createBook(who, randomUUID(), {
        name: 'Accessible entity book',
        entityName: 'Synthetic corporation',
        entityKind: 'corporation',
        country: 'MX',
        functionalCurrency: 'MXN',
      });
    async function reviewBinding(caseId: string) {
      const p = await repo.getWorkingPaperPreparation(owner, caseId);
      return {
        workflowId: p.workflowId,
        expectedPackageVersion: p.packageVersion,
        expectedCaseRevision: p.snapshotRevision,
        expectedSnapshotHash: p.snapshotHash,
      };
    }
    async function noBookAuthorization(caseId: string) {
      const saved = await repo.getCase(owner, caseId);
      expect(saved.questionnaire.intake.sourceBooks).toEqual([]);
      expect(saved.questionnaire.sourceAuthorizationBindings).toEqual([]);
      expect(
        (
          await admin.query(
            'select count(*)::int as n from emdo.finance_tax_book_sources where case_id=$1',
            [caseId],
          )
        ).rows[0].n,
      ).toBe(0);
    }
    it('binds once with exact retries, preserves old snapshots and requires a fresh review of unchanged declarations', async () => {
      const c = await create();
      const target = await book();
      const fact = await repo.recordDeclaration(owner, c.caseId, randomUUID(), {
        expectedCaseRevision: 1,
        expectedSourceRevision: null,
        factKey: 'currency',
        category: 'general',
        value: { type: 'text', value: 'MXN' },
      });
      const oldBinding = await reviewBinding(c.caseId);
      const inputs = [
        {
          sourceId: fact.sourceId,
          sourceRevision: fact.sourceRevision,
          contentHash: fact.contentHash,
        },
      ];
      await repo.reviewWorkingPaperInputs(reviewer, c.caseId, randomUUID(), {
        ...oldBinding,
        inputs,
      });
      expect(
        (await repo.getWorkingPaperPreparation(owner, c.caseId)).inputReviews,
      ).toHaveLength(1);
      const historical = await repo.getCase(
        owner,
        c.caseId,
        oldBinding.expectedCaseRevision,
      );
      expect(historical.questionnaire.intake.legalEntityId).toBeNull();
      const key = randomUUID();
      const input = {
        expectedCaseRevision: oldBinding.expectedCaseRevision,
        legalEntityId: String(target.entityId),
      };
      const result = await repo.bindLegalEntity(owner, c.caseId, key, input);
      expect(await repo.bindLegalEntity(owner, c.caseId, key, input)).toEqual(
        result,
      );
      const saved = await repo.getCase(owner, c.caseId);
      expect(saved.currentRevision).toBe(oldBinding.expectedCaseRevision + 1);
      expect(saved.questionnaire.intake.legalEntityId).toBe(target.entityId);
      expect(saved.snapshotHash).not.toBe(historical.snapshotHash);
      await noBookAuthorization(c.caseId);
      const prior = await repo.getCase(
        owner,
        c.caseId,
        oldBinding.expectedCaseRevision,
      );
      expect(prior.questionnaire).toEqual(historical.questionnaire);
      expect(prior.snapshotHash).toBe(historical.snapshotHash);
      expect(
        (await repo.getWorkingPaperPreparation(owner, c.caseId)).inputReviews,
      ).toEqual([]);
      await expect(
        repo.reviewWorkingPaperInputs(reviewer, c.caseId, randomUUID(), {
          ...oldBinding,
          inputs,
        }),
      ).rejects.toThrow();
      const fresh = await reviewBinding(c.caseId);
      await repo.reviewWorkingPaperInputs(reviewer, c.caseId, randomUUID(), {
        ...fresh,
        inputs,
      });
      expect(
        (await repo.getWorkingPaperPreparation(owner, c.caseId)).inputReviews,
      ).toEqual([expect.objectContaining(inputs[0]!)]);
      const replacement = await book();
      await expect(
        repo.bindLegalEntity(owner, c.caseId, randomUUID(), {
          expectedCaseRevision: saved.currentRevision,
          legalEntityId: String(replacement.entityId),
        }),
      ).rejects.toThrow();
      expect(
        (await repo.getCase(owner, c.caseId)).questionnaire.intake
          .legalEntityId,
      ).toBe(target.entityId);
      await expect(
        repo.bindLegalEntity(owner, c.caseId, key, {
          ...input,
          legalEntityId: String(replacement.entityId),
        }),
      ).rejects.toThrow();
    });
    it('rejects a stale case revision without creating a binding snapshot', async () => {
      const c = await create();
      const target = await book();
      await repo.recordDeclaration(owner, c.caseId, randomUUID(), {
        expectedCaseRevision: 1,
        expectedSourceRevision: null,
        factKey: 'currency',
        category: 'general',
        value: { type: 'text', value: 'MXN' },
      });
      const before = await repo.getCase(owner, c.caseId);
      await expect(
        repo.bindLegalEntity(owner, c.caseId, randomUUID(), {
          expectedCaseRevision: 1,
          legalEntityId: String(target.entityId),
        }),
      ).rejects.toThrow();
      expect(await repo.getCase(owner, c.caseId)).toEqual(before);
      await noBookAuthorization(c.caseId);
    });
    it.each([
      ['preparer', preparer],
      ['reviewer', reviewer],
      ['viewer', viewer],
    ] as const)(
      'requires the private case owner rather than %s authority',
      async (_role, who) => {
        const c = await create();
        const target = await book();
        await expect(
          repo.bindLegalEntity(who, c.caseId, randomUUID(), {
            expectedCaseRevision: 1,
            legalEntityId: String(target.entityId),
          }),
        ).rejects.toThrow();
        const saved = await repo.getCase(owner, c.caseId);
        expect(saved.currentRevision).toBe(1);
        expect(saved.questionnaire.intake.legalEntityId).toBeNull();
      },
    );
    it('rejects ungranted and cross-workspace entities even for the private case owner', async () => {
      const c = await create();
      const inaccessible = await book(outsider);
      await expect(
        repo.bindLegalEntity(owner, c.caseId, randomUUID(), {
          expectedCaseRevision: 1,
          legalEntityId: String(inaccessible.entityId),
        }),
      ).rejects.toThrow();
      const other = {
        ...owner,
        workspaceId: randomUUID(),
        sessionId: randomUUID(),
        requestId: randomUUID(),
      };
      await admin.query(
        "insert into emdo.households(id,name,created_by_user_id,slug) values($1::uuid,'Other binding workspace',$2,$1::text)",
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
      const foreign = await book(other);
      await expect(
        repo.bindLegalEntity(owner, c.caseId, randomUUID(), {
          expectedCaseRevision: 1,
          legalEntityId: String(foreign.entityId),
        }),
      ).rejects.toThrow();
      expect(
        (await repo.getCase(owner, c.caseId)).questionnaire.intake
          .legalEntityId,
      ).toBeNull();
    });
    it('rechecks the current book grant and denies an entity after access is revoked', async () => {
      const c = await create();
      const target = await book();
      await admin.query(
        'update emdo.finance_book_grants set revoked_at=now() where workspace_id=$1 and book_id=$2 and user_id=$3',
        [workspaceId, target.id, owner.userId],
      );
      await expect(
        repo.bindLegalEntity(owner, c.caseId, randomUUID(), {
          expectedCaseRevision: 1,
          legalEntityId: String(target.entityId),
        }),
      ).rejects.toThrow();
      expect(
        (await repo.getCase(owner, c.caseId)).questionnaire.intake
          .legalEntityId,
      ).toBeNull();
      await noBookAuthorization(c.caseId);
    });
  },
);

import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkspaceContext } from '@emdo/contracts';
import { PostgresFinanceTaxRepository } from './finance-tax-repository.js';
import { PostgresFinanceV2Repository } from './finance-v2-repository.js';
const url = process.env.FINANCE_V2_TEST_DATABASE_URL;
describe.skipIf(!url)(
  'Private tax cases under restricted PostgreSQL roles',
  () => {
    const admin = new pg.Pool({ connectionString: url });
    const pool = {
      async connect() {
        const c = await admin.connect();
        await c.query('set role emdo_app');
        return c;
      },
    };
    const repo = new PostgresFinanceTaxRepository(pool),
      books = new PostgresFinanceV2Repository(pool);
    const workspaceId = randomUUID();
    const context = (): WorkspaceContext => ({
      workspaceId,
      userId: randomUUID(),
      sessionId: randomUUID(),
      requestId: randomUUID(),
    });
    const creator = context(),
      workspaceOwner = context(),
      viewer = context(),
      preparer = context(),
      reviewer = context();
    const input = {
      title: 'Private 2025 return',
      taxSubjectName: 'Synthetic individual',
      scope: {
        country: 'CA',
        subdivision: 'ON',
        taxpayerType: 'individual',
        year: 2025,
        regime: 'resident',
        formVersion: '2025',
      },
      domesticResident: true,
      hasCrossBorderActivity: false,
      standaloneCorporation: null,
      packageId: 'ca-on-t1',
      packageVersion: '2025.1',
      relatedParties: [],
    };
    const declaration = (revision: number) => ({
      expectedCaseRevision: revision,
      expectedSourceRevision: null,
      factKey: 'residency.country',
      category: 'residency',
      value: { type: 'text', value: 'CA' },
    });
    async function sql(q: string, v: unknown[] = []) {
      const c = await admin.connect();
      try {
        await c.query('reset role');
        return await c.query(q, v);
      } finally {
        c.release();
      }
    }
    async function raw(actor: WorkspaceContext, q: string, v: unknown[] = []) {
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query(
          "select set_config('emdo.user_id',$1,true),set_config('emdo.session_id',$2,true),set_config('emdo.request_id',$3,true)",
          [actor.userId, actor.sessionId, randomUUID()],
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
      for (const actor of [creator, workspaceOwner, viewer, preparer, reviewer])
        await sql(
          'insert into emdo.auth_users(id,name,email,email_verified) values($1,$2,$3,true)',
          [actor.userId, 'Synthetic', `${actor.userId}@example.test`],
        );
      await sql(
        "insert into emdo.households(id,name,created_by_user_id,slug) values($1::uuid,'Tax privacy fixture',$2,$1::text)",
        [workspaceId, workspaceOwner.userId],
      );
      for (const actor of [
        creator,
        workspaceOwner,
        viewer,
        preparer,
        reviewer,
      ]) {
        await sql(
          'insert into emdo.household_memberships(household_id,user_id,role) values($1,$2,$3)',
          [
            workspaceId,
            actor.userId,
            actor === workspaceOwner ? 'owner' : 'member',
          ],
        );
        await sql(
          "insert into emdo.auth_sessions(id,user_id,token,expires_at,active_household_id) values($1::uuid,$2,$1::text,now()+interval '1 day',$3)",
          [actor.sessionId, actor.userId, workspaceId],
        );
      }
    });
    afterAll(() => admin.end());
    it('creates only a new subject, isolates workspace owners, and replays creation exactly', async () => {
      expect(await repo.checkReady()).toBe(true);
      const elevated = new PostgresFinanceTaxRepository({
        async connect() {
          const client = await admin.connect();
          await client.query('reset role');
          return client;
        },
      });
      expect(await elevated.checkReady()).toBe(false);
      const created = await repo.createCase(creator, 'create', input);
      expect(await repo.createCase(creator, 'create', input)).toEqual(created);
      expect(created.status).toBe('incomplete');
      expect(await repo.listCases(workspaceOwner)).toEqual([]);
      await expect(
        repo.getCase(workspaceOwner, created.caseId),
      ).rejects.toThrow('forbidden');
      expect(
        (
          await raw(
            workspaceOwner,
            'select * from emdo.finance_tax_case_snapshots',
          )
        ).rows,
      ).toEqual([]);
      await expect(
        repo.createCase(workspaceOwner, 'steal', {
          ...input,
          taxSubjectId: created.taxSubjectId,
        }),
      ).rejects.toThrow();
      await expect(
        repo.createCase(creator, 'create', { ...input, title: 'Changed' }),
      ).rejects.toThrow('idempotency-conflict');
      const saved = await repo.getCase(creator, created.caseId);
      expect(saved.caseRole).toBe('owner');
      expect(saved.questionnaire.intake.sourceBooks).toEqual([]);
      expect(saved.questionnaire.binding.manifest).toBeNull();
      expect(saved.questionnaire.questions).toEqual([]);
      await expect(
        raw(
          creator,
          'update emdo.finance_tax_cases set current_revision=9 where id=$1',
          [created.caseId],
        ),
      ).rejects.toThrow('snapshot');
      const forged = {
        ...saved.questionnaire,
        complete: true,
        intake: { ...saved.questionnaire.intake, revision: 2 },
      };
      await expect(
        raw(
          creator,
          "insert into emdo.finance_tax_case_snapshots(workspace_id,case_id,tax_subject_id,revision,questionnaire,snapshot_hash,previous_snapshot_hash,created_by) values($1,$2,$3,2,$4::jsonb,repeat('a',64),$5,$6)",
          [
            workspaceId,
            created.caseId,
            created.taxSubjectId,
            JSON.stringify(forged),
            saved.snapshotHash,
            creator.userId,
          ],
        ),
      ).rejects.toThrow('package unavailable');
      expect(
        JSON.stringify(await repo.assessCase(creator, created.caseId)),
      ).toContain('unavailable');
    });
    it('keeps append-only declaration revisions, CAS, receipts, and historical snapshots', async () => {
      const c = await repo.createCase(creator, 'revision-case', input);
      const first = await Promise.all([
        repo.recordDeclaration(creator, c.caseId, 'first', declaration(1)),
        repo.recordDeclaration(creator, c.caseId, 'first', declaration(1)),
      ]);
      expect(first[0]).toEqual(first[1]);
      const source = first[0]!;
      const second = await repo.recordDeclaration(creator, c.caseId, 'second', {
        ...declaration(2),
        sourceId: source.sourceId,
        expectedSourceRevision: 1,
        value: { type: 'text', value: 'CA-ON' },
      });
      expect(second.sourceRevision).toBe(2);
      expect(second.contentHash).not.toBe(source.contentHash);
      expect(
        (await repo.getCase(creator, c.caseId, 2)).declaredInputs,
      ).toMatchObject([
        {
          sourceId: source.sourceId,
          sourceRevision: 1,
          value: { type: 'text', value: 'CA' },
          reviewState: 'unreviewed',
        },
      ]);
      const exactCurrent = await repo.getCase(creator, c.caseId);
      expect(exactCurrent.declarationBindingStatus).toBe('bound');
      expect(exactCurrent.declaredInputs).toMatchObject([
        {
          sourceRevision: 2,
          contentHash: second.contentHash,
          value: { type: 'text', value: 'CA-ON' },
        },
      ]);
      expect(exactCurrent.questionnaire.intake.facts).toEqual([]);
      await expect(
        repo.recordDeclaration(creator, c.caseId, 'stale', declaration(2)),
      ).rejects.toThrow('revision-conflict');
      expect(
        (await repo.getCase(creator, c.caseId, 1)).questionnaire.intake
          .revision,
      ).toBe(1);
      expect((await repo.getCase(creator, c.caseId)).currentRevision).toBe(3);
      expect(
        (
          await sql(
            'select count(*)::int n from emdo.finance_tax_fact_sources where case_id=$1',
            [c.caseId],
          )
        ).rows[0].n,
      ).toBe(2);
      await expect(
        raw(
          creator,
          "update emdo.finance_tax_case_snapshots set snapshot_hash=repeat('a',64) where case_id=$1",
          [c.caseId],
        ),
      ).rejects.toThrow('permission denied');
      await expect(
        raw(
          creator,
          'delete from emdo.finance_tax_fact_sources where case_id=$1',
          [c.caseId],
        ),
      ).rejects.toThrow('permission denied');
      const other = await repo.createCase(creator, 'different-subject', input);
      await expect(
        repo.recordDeclaration(creator, other.caseId, 'cross', {
          ...declaration(1),
          sourceId: source.sourceId,
          expectedSourceRevision: 2,
        }),
      ).rejects.toThrow('source-revision-conflict');
      await expect(
        repo.saveAnswer(creator, c.caseId, 'unknown', {
          expectedCaseRevision: 3,
          expectedAnswerRevision: null,
          sourceId: source.sourceId,
          expectedSourceRevision: 2,
          relatedPartyId: null,
        }),
      ).rejects.toThrow();
      expect((await repo.getCase(creator, c.caseId)).currentRevision).toBe(3);
      const race = await Promise.allSettled([
        repo.recordDeclaration(creator, c.caseId, 'race-a', declaration(3)),
        repo.recordDeclaration(creator, c.caseId, 'race-b', declaration(3)),
      ]);
      expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    });
    it('requires explicit role grants and current workspace membership', async () => {
      const c = await repo.createCase(creator, 'grants-case', input);
      for (const [actor, role] of [
        [viewer, 'viewer'],
        [preparer, 'preparer'],
        [reviewer, 'reviewer'],
      ] as const)
        await repo.grantCaseAccess(creator, c.caseId, `grant-${role}`, {
          userId: actor.userId,
          role,
          expectedGrantRevision: null,
        });
      expect((await repo.getCase(viewer, c.caseId)).caseRole).toBe('viewer');
      expect(
        (await repo.listCaseGrants(creator, c.caseId))
          .map((g) => g.role)
          .sort(),
      ).toEqual(['owner', 'preparer', 'reviewer', 'viewer']);
      await expect(repo.listCaseGrants(viewer, c.caseId)).rejects.toThrow(
        'forbidden',
      );
      await expect(
        repo.recordDeclaration(viewer, c.caseId, 'viewer-edit', declaration(1)),
      ).rejects.toThrow('forbidden');
      await expect(
        repo.recordDeclaration(
          reviewer,
          c.caseId,
          'reviewer-edit',
          declaration(1),
        ),
      ).rejects.toThrow('forbidden');
      await expect(
        repo.grantCaseAccess(preparer, c.caseId, 'mint', {
          userId: workspaceOwner.userId,
          role: 'viewer',
          expectedGrantRevision: null,
        }),
      ).rejects.toThrow('forbidden');
      await repo.recordDeclaration(
        preparer,
        c.caseId,
        'prepare',
        declaration(1),
      );
      await repo.revokeCaseAccess(creator, c.caseId, 'revoke', {
        userId: viewer.userId,
        expectedGrantRevision: 1,
      });
      expect(
        (await repo.listCaseGrants(creator, c.caseId)).find(
          (g) => g.userId === viewer.userId,
        ),
      ).toMatchObject({ status: 'revoked', revision: 2 });
      await expect(repo.getCase(viewer, c.caseId)).rejects.toThrow('forbidden');
      await sql(
        "update emdo.household_memberships set status='inactive',ended_at=now() where household_id=$1 and user_id=$2",
        [workspaceId, preparer.userId],
      );
      await expect(repo.getCase(preparer, c.caseId)).rejects.toThrow();
      await sql(
        "update emdo.household_memberships set status='active',ended_at=null where household_id=$1 and user_id=$2",
        [workspaceId, preparer.userId],
      );
    });
    it('captures multiple explicitly authorized books and fails closed on current book-grant revocation', async () => {
      const c = await repo.createCase(creator, 'books-case', input);
      const bookInput = {
        name: 'Private book',
        entityName: 'Synthetic',
        entityKind: 'corporation',
        country: 'CA',
        functionalCurrency: 'CAD',
      };
      const b1 = await books.createBook(creator, 'tax-book-1', bookInput),
        b2 = await books.createBook(creator, 'tax-book-2', bookInput);
      const first = await repo.authorizeBookSource(
        creator,
        c.caseId,
        'source-1',
        { bookId: b1.id, expectedCaseRevision: 1 },
      );
      await repo.authorizeBookSource(creator, c.caseId, 'source-2', {
        bookId: b2.id,
        expectedCaseRevision: 2,
      });
      expect(
        (await repo.getCase(creator, c.caseId)).questionnaire.intake
          .sourceBooks,
      ).toHaveLength(2);
      await expect(repo.getCase(workspaceOwner, c.caseId)).rejects.toThrow(
        'forbidden',
      );
      await sql(
        'update emdo.finance_book_grants set revoked_at=now() where book_id=$1 and user_id=$2',
        [b1.id, creator.userId],
      );
      await expect(repo.getCase(creator, c.caseId)).rejects.toThrow(
        'forbidden',
      );
      await expect(repo.assessCase(creator, c.caseId)).rejects.toThrow(
        'forbidden',
      );
      expect(
        (
          await raw(
            creator,
            'select * from emdo.finance_tax_book_sources where case_id=$1',
            [c.caseId],
          )
        ).rows,
      ).toHaveLength(0);
      await sql(
        "insert into emdo.finance_book_grants(workspace_id,book_id,user_id,role) values($1,$2,$3,'administrator')",
        [workspaceId, b2.id, workspaceOwner.userId],
      );
      expect((await books.listBooks(workspaceOwner)).length).toBeGreaterThan(0);
      await expect(repo.getCase(workspaceOwner, c.caseId)).rejects.toThrow(
        'forbidden',
      );
      expect(first.authorizationId).toBeTruthy();
      const reset = await repo.resetInputsAfterSourceRevocation(
        creator,
        c.caseId,
        'reset',
        { expectedCaseRevision: 3 },
      );
      expect(reset.revision).toBe(4);
      expect(
        await repo.resetInputsAfterSourceRevocation(
          creator,
          c.caseId,
          'reset',
          { expectedCaseRevision: 3 },
        ),
      ).toEqual(reset);
      const recovered = await repo.getCase(creator, c.caseId);
      expect(recovered.questionnaire.intake.sourceBooks).toEqual([]);
      expect(recovered.questionnaire.binding.manifest).toBeNull();
      await expect(repo.getCase(creator, c.caseId, 3)).rejects.toThrow(
        'forbidden',
      );
      await repo.recordDeclaration(
        creator,
        c.caseId,
        'new-after-reset',
        declaration(4),
      );
    });
    it('revokes explicit book-source authorization independently of book ownership', async () => {
      const c = await repo.createCase(creator, 'source-revoke-case', input);
      const b = await books.createBook(creator, 'tax-book-3', {
        name: 'Private book',
        entityName: 'Synthetic',
        entityKind: 'corporation',
        country: 'CA',
        functionalCurrency: 'CAD',
      });
      const source = await repo.authorizeBookSource(
        creator,
        c.caseId,
        'source',
        { bookId: b.id, expectedCaseRevision: 1 },
      );
      await repo.revokeBookSource(
        creator,
        c.caseId,
        'revoke-source',
        source.authorizationId,
        1,
      );
      await expect(repo.getCase(creator, c.caseId)).rejects.toThrow(
        'forbidden',
      );
    });
    it('holds source-authorizer grants until the restricted read transaction ends', async () => {
      const c = await repo.createCase(creator, 'lock-case', input);
      const b = await books.createBook(creator, 'lock-book', {
        name: 'Locked',
        entityName: 'Synthetic',
        entityKind: 'corporation',
        country: 'CA',
        functionalCurrency: 'CAD',
      });
      await repo.authorizeBookSource(creator, c.caseId, 'lock-source', {
        bookId: b.id,
        expectedCaseRevision: 1,
      });
      const reader = await pool.connect(),
        revoker = await admin.connect();
      try {
        await reader.query('begin');
        await reader.query(
          "select set_config('emdo.user_id',$1,true),set_config('emdo.session_id',$2,true),set_config('emdo.request_id',$3,true)",
          [creator.userId, creator.sessionId, randomUUID()],
        );
        expect(
          (
            await reader.query(
              "select emdo.lock_tax_case($1,$2,ARRAY['owner'],true) allowed",
              [workspaceId, c.caseId],
            )
          ).rows[0].allowed,
        ).toBe(true);
        await revoker.query('reset role');
        await revoker.query('begin');
        await revoker.query("set local lock_timeout='100ms'");
        await expect(
          revoker.query(
            'update emdo.finance_book_grants set revoked_at=now() where book_id=$1 and user_id=$2',
            [b.id, creator.userId],
          ),
        ).rejects.toThrow('lock timeout');
        await revoker.query('rollback');
        await reader.query('commit');
        await revoker.query(
          'update emdo.finance_book_grants set revoked_at=now() where book_id=$1 and user_id=$2',
          [b.id, creator.userId],
        );
        await expect(repo.getCase(creator, c.caseId)).rejects.toThrow(
          'forbidden',
        );
      } finally {
        await reader.query('rollback');
        await revoker.query('rollback');
        reader.release();
        revoker.release();
      }
    });
    it.each(['source', 'book-grant'] as const)(
      'rebinds the same book after %s revocation without reopening old inputs',
      async (kind) => {
        const c = await repo.createCase(creator, `rebind-case-${kind}`, input);
        const b = await books.createBook(creator, `rebind-book-${kind}`, {
          name: 'Rebound',
          entityName: 'Synthetic',
          entityKind: 'corporation',
          country: 'CA',
          functionalCurrency: 'CAD',
        });
        const first = await repo.authorizeBookSource(
          creator,
          c.caseId,
          `rebind-${kind}-original-source`,
          { bookId: b.id, expectedCaseRevision: 1 },
        );
        const firstState = await repo.getCase(creator, c.caseId);
        await expect(
          repo.authorizeBookSource(
            creator,
            c.caseId,
            `rebind-${kind}-already-bound`,
            {
              bookId: b.id,
              expectedCaseRevision: 2,
            },
          ),
        ).rejects.toThrow('conflict');
        if (kind === 'source')
          await repo.revokeBookSource(
            creator,
            c.caseId,
            `rebind-${kind}-revoke`,
            first.authorizationId,
            first.authorizationRevision,
          );
        else
          await sql(
            'update emdo.finance_book_grants set revoked_at=now() where book_id=$1 and user_id=$2',
            [b.id, creator.userId],
          );
        await expect(repo.getCase(creator, c.caseId, 2)).rejects.toThrow(
          'forbidden',
        );
        await repo.resetInputsAfterSourceRevocation(
          creator,
          c.caseId,
          `rebind-${kind}-reset`,
          { expectedCaseRevision: 2 },
        );
        expect(
          (
            await raw(
              creator,
              'select * from emdo.finance_tax_book_sources where case_id=$1',
              [c.caseId],
            )
          ).rows,
        ).toEqual([]);
        if (kind === 'book-grant') {
          await expect(
            repo.authorizeBookSource(
              creator,
              c.caseId,
              `rebind-${kind}-still-revoked`,
              {
                bookId: b.id,
                expectedCaseRevision: 3,
              },
            ),
          ).rejects.toThrow('forbidden');
          await sql(
            'update emdo.finance_book_grants set revoked_at=null where book_id=$1 and user_id=$2',
            [b.id, creator.userId],
          );
          await expect(repo.getCase(creator, c.caseId, 2)).rejects.toThrow(
            'forbidden',
          );
        }
        const asset = await books.createAccount(
          creator,
          String(b.id),
          `asset-${kind}`,
          { code: '1000', name: 'Cash', kind: 'asset' },
        );
        const equity = await books.createAccount(
          creator,
          String(b.id),
          `equity-${kind}`,
          { code: '3000', name: 'Capital', kind: 'equity' },
        );
        await books.createPeriod(creator, String(b.id), `period-${kind}`, {
          startsOn: '2025-01-01',
          endsOn: '2025-12-31',
        });
        await books.postJournal(creator, String(b.id), `posting-${kind}`, {
          effectiveOn: '2025-12-31',
          description: 'New immutable source',
          sourceReference: `synthetic:${kind}`,
          lines: [
            {
              accountId: asset.id,
              side: 'debit',
              amount: '1.23',
              currency: 'CAD',
              nativeAmount: '1.23',
              fxRate: '1',
              fxSource: 'identity',
            },
            {
              accountId: equity.id,
              side: 'credit',
              amount: '1.23',
              currency: 'CAD',
              nativeAmount: '1.23',
              fxRate: '1',
              fxSource: 'identity',
            },
          ],
        });
        const attempts = await Promise.all([
          repo.authorizeBookSource(creator, c.caseId, `rebind-${kind}-rebind`, {
            bookId: b.id,
            expectedCaseRevision: 3,
          }),
          repo.authorizeBookSource(creator, c.caseId, `rebind-${kind}-rebind`, {
            bookId: b.id,
            expectedCaseRevision: 3,
          }),
        ]);
        expect(attempts[0]).toEqual(attempts[1]);
        const rebound = attempts[0]!;
        expect(rebound.authorizationId).not.toBe(first.authorizationId);
        expect(rebound.authorizationRevision).toBeGreaterThan(
          first.authorizationRevision,
        );
        expect(rebound.snapshotRevision).toBe(2);
        const current = await repo.getCase(creator, c.caseId);
        expect(current.questionnaire.intake.sourceBooks).toHaveLength(1);
        expect(
          current.questionnaire.intake.sourceBooks[0]!.snapshotHash,
        ).not.toBe(
          firstState.questionnaire.intake.sourceBooks[0]!.snapshotHash,
        );
        expect(
          current.questionnaire.sourceAuthorizationBindings[0]!.authorizationId,
        ).toBe(rebound.authorizationId);
        const visible = (
          await raw(
            creator,
            'select id,snapshot from emdo.finance_tax_book_sources where case_id=$1',
            [c.caseId],
          )
        ).rows;
        expect(visible).toHaveLength(1);
        expect(visible[0].id).toBe(rebound.authorizationId);
        expect(JSON.stringify(visible[0].snapshot)).toContain('1.230000000000');
        expect(
          (
            await sql(
              'select count(*)::int n from emdo.finance_tax_book_sources where case_id=$1',
              [c.caseId],
            )
          ).rows[0].n,
        ).toBe(2);
        await expect(repo.getCase(creator, c.caseId, 2)).rejects.toThrow(
          'forbidden',
        );
        expect(
          await repo.authorizeBookSource(
            creator,
            c.caseId,
            `rebind-${kind}-original-source`,
            {
              bookId: b.id,
              expectedCaseRevision: 1,
            },
          ),
        ).toEqual(first);
        expect(
          (await repo.getCase(creator, c.caseId)).questionnaire
            .sourceAuthorizationBindings[0]!.authorizationId,
        ).toBe(rebound.authorizationId);
        const assessment = await repo.assessCase(creator, c.caseId);
        expect(assessment).toMatchObject({
          caseId: c.caseId,
          taxSubjectId: c.taxSubjectId,
          snapshotRevision: 4,
          snapshotHash: current.snapshotHash,
        });
        expect(current.status).toBe('incomplete');
      },
    );
    it('creates an explicitly non-executable intake-only binding without client package identifiers', async () => {
      const intakeOnly = {
        mode: 'intake-only',
        title: input.title,
        taxSubjectName: input.taxSubjectName,
        scope: input.scope,
        domesticResident: input.domesticResident,
        hasCrossBorderActivity: input.hasCrossBorderActivity,
        standaloneCorporation: input.standaloneCorporation,
        relatedParties: [],
      };
      await expect(
        repo.createCase(creator, 'mixed-mode', {
          ...intakeOnly,
          packageId: 'invented',
          packageVersion: '1',
        }),
      ).rejects.toThrow();
      const c = await repo.createCase(creator, 'intake-only', intakeOnly);
      const first = await repo.getCase(creator, c.caseId);
      expect(first.questionnaire.binding).toMatchObject({
        mode: 'intake-only',
        enabled: false,
        packageId: 'emdo.intake-only',
        packageVersion: '1',
        manifest: null,
        manifestHash: null,
      });
      await repo.recordDeclaration(
        creator,
        c.caseId,
        'intake-declaration',
        declaration(1),
      );
      expect(
        (await repo.getCase(creator, c.caseId)).questionnaire.binding,
      ).toEqual(first.questionnaire.binding);
      expect(await repo.assessCase(creator, c.caseId)).toMatchObject({
        complete: false,
        status: 'incomplete',
        snapshotRevision: 2,
      });
      expect((await repo.getCase(creator, c.caseId, 1)).snapshotHash).toBe(
        first.snapshotHash,
      );
      await repo.resetInputsAfterSourceRevocation(
        creator,
        c.caseId,
        'reset-intake',
        { expectedCaseRevision: 2 },
      );
      expect((await repo.getCase(creator, c.caseId)).declaredInputs).toEqual(
        [],
      );
      expect(await repo.listDeclarations(creator, c.caseId)).toHaveLength(1);
      expect(
        (await repo.getCase(creator, c.caseId, 2)).declaredInputs,
      ).toHaveLength(1);
    });
    it('does not infer latest declarations for legacy unbound snapshots and detects corrupted bound content', async () => {
      const c = await repo.createCase(creator, 'legacy-fixture', input);
      const source = await repo.recordDeclaration(
        creator,
        c.caseId,
        'legacy-source',
        declaration(1),
      );
      const saved = await repo.getCase(creator, c.caseId);
      const legacy = { ...saved.questionnaire };
      delete legacy.declarationSourceBindings;
      function canonical(value: unknown): string {
        if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
        if (value !== null && typeof value === 'object')
          return `{${Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
            .join(',')}}`;
        return JSON.stringify(value);
      }
      const legacyHash = createHash('sha256')
        .update(canonical(legacy))
        .digest('hex');
      // Administrative fixture represents a stored pre-binding snapshot, not an application mutation.
      await sql(
        'update emdo.finance_tax_case_snapshots set questionnaire=$2::jsonb,snapshot_hash=$3 where case_id=$1 and revision=2',
        [c.caseId, JSON.stringify(legacy), legacyHash],
      );
      const read = await repo.getCase(creator, c.caseId);
      expect(read.snapshotHash).toBe(legacyHash);
      expect(read.declarationBindingStatus).toBe('legacy-unbound');
      expect(read.declaredInputs).toEqual([]);
      expect(await repo.listDeclarations(creator, c.caseId)).toHaveLength(1);
      await repo.recordDeclaration(creator, c.caseId, 'new-binding', {
        ...declaration(2),
        sourceId: source.sourceId,
        expectedSourceRevision: 1,
      });
      await sql(
        'update emdo.finance_tax_fact_sources set value=$3::jsonb where case_id=$1 and id=$2 and revision=2',
        [
          c.caseId,
          source.sourceId,
          JSON.stringify({ type: 'text', value: 'tampered' }),
        ],
      );
      await expect(repo.getCase(creator, c.caseId)).rejects.toThrow(
        'declaration-content-integrity',
      );
    });
  },
);

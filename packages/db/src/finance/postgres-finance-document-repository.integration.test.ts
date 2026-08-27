import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadOrderedMigrations } from '../migrations.js';

const databaseUrl = process.env.TEST_FINANCE_DOCUMENT_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

const financeDocumentTables = Object.freeze([
  'finance_documents',
  'finance_document_extractions',
  'finance_document_chunks',
  'finance_document_review_batches',
  'finance_document_matches',
  'finance_document_evidence',
] as const);

const ids = Object.freeze({
  household: 'f2000000-0000-4000-8000-000000000001',
  owner: 'f2000000-0000-4000-8000-000000000002',
  ownerSession: 'f2000000-0000-4000-8000-000000000003',
  ownerPrivateSpace: 'f2000000-0000-4000-8000-000000000004',
  collaborator: 'f2000000-0000-4000-8000-000000000005',
  collaboratorSession: 'f2000000-0000-4000-8000-000000000006',
  collaboratorPrivateSpace: 'f2000000-0000-4000-8000-000000000007',
  ownerDocument: 'f2000000-0000-4000-8000-000000000008',
  collaboratorDocument: 'f2000000-0000-4000-8000-000000000009',
  ownerExtraction: 'f2000000-0000-4000-8000-000000000010',
  ownerChunk: 'f2000000-0000-4000-8000-000000000011',
  ownerEvidence: 'f2000000-0000-4000-8000-000000000012',
  ownerReviewBatch: 'f2000000-0000-4000-8000-000000000013',
  ownerMatch: 'f2000000-0000-4000-8000-000000000014',
  ownerSpaceAccessGrant: 'f2000000-0000-4000-8000-000000000015',
  deniedDocument: 'f2000000-0000-4000-8000-000000000016',
  ownerRequest: 'f2000000-0000-4000-8000-000000000017',
  collaboratorRequest: 'f2000000-0000-4000-8000-000000000018',
});

const sha256 = (character: string): string => character.repeat(64);

interface Principal {
  readonly userId: string;
  readonly sessionId: string;
  readonly requestId: string;
}

interface DocumentInput {
  readonly id: string;
  readonly ownerUserId: string;
  readonly spaceId: string;
  readonly storageObjectId: string;
  readonly displayName: string;
  readonly plaintextHash: string;
  readonly ciphertextHash: string;
}

const ownerPrincipal = Object.freeze({
  userId: ids.owner,
  sessionId: ids.ownerSession,
  requestId: ids.ownerRequest,
} satisfies Principal);

const collaboratorPrincipal = Object.freeze({
  userId: ids.collaborator,
  sessionId: ids.collaboratorSession,
  requestId: ids.collaboratorRequest,
} satisfies Principal);

const loginConnectionString = (role: string, password: string): string => {
  const url = new URL(databaseUrl!);
  url.username = role;
  url.password = password;
  return url.toString();
};

const insertDocument = async (
  client: import('pg').PoolClient,
  input: DocumentInput,
): Promise<void> => {
  await client.query(
    `insert into emdo.finance_documents (
       id, household_id, space_id, original_owner_user_id, storage_object_id,
       display_name, mime_type, byte_size, page_count, plaintext_sha256,
       ciphertext_sha256, wrapped_data_key, key_version
     ) values (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6,
       'application/pdf', 1024, 1, $7, $8, '{"algorithm":"test"}'::jsonb,
       'finance-document-test-key-v1'
     )`,
    [
      input.id,
      ids.household,
      input.spaceId,
      input.ownerUserId,
      input.storageObjectId,
      input.displayName,
      input.plaintextHash,
      input.ciphertextHash,
    ],
  );
};

describeDatabase(
  'PostgreSQL 18 finance document knowledge direct SQL contract (requires isolated empty TEST_FINANCE_DOCUMENT_DATABASE_URL)',
  () => {
    let admin: import('pg').Pool;
    let app: import('pg').Pool;
    let loginRole = '';
    let loginPassword = '';

    const withPrincipal = async <Result>(
      principal: Principal,
      work: (client: import('pg').PoolClient) => Promise<Result>,
    ): Promise<Result> => {
      const client = await app.connect();
      try {
        await client.query('begin');
        await client.query('set local row_security = on');
        await client.query("set local statement_timeout = '30s'");
        await client.query(
          `select pg_catalog.set_config('emdo.user_id', $1, true),
                  pg_catalog.set_config('emdo.session_id', $2, true),
                  pg_catalog.set_config('emdo.request_id', $3, true)`,
          [principal.userId, principal.sessionId, principal.requestId],
        );
        const result = await work(client);
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    };

    beforeAll(async () => {
      const { Pool } = await import('pg');
      admin = new Pool({
        allowExitOnIdle: true,
        application_name: 'emdo-finance-document-live-admin',
        connectionString: databaseUrl,
        max: 1,
      });
      const preflight = await admin.query<{
        emdo_schema: string | null;
        is_superuser: boolean;
        server_version_num: string;
        vector_available: boolean;
      }>(`select pg_catalog.to_regnamespace('emdo')::text as emdo_schema,
                role.rolsuper as is_superuser,
                pg_catalog.current_setting('server_version_num') as server_version_num,
                exists (
                  select 1
                    from pg_catalog.pg_available_extensions
                   where name = 'vector'
                ) as vector_available
           from pg_catalog.pg_roles as role
          where role.rolname = current_user`);
      expect(preflight.rows[0]).toMatchObject({
        emdo_schema: null,
        is_superuser: true,
        vector_available: true,
      });
      expect(
        Number(preflight.rows[0]?.server_version_num),
      ).toBeGreaterThanOrEqual(180_000);
      expect(Number(preflight.rows[0]?.server_version_num)).toBeLessThan(
        190_000,
      );

      const migrations = await loadOrderedMigrations();
      expect(migrations).toHaveLength(17);
      expect(migrations.at(-1)?.id).toBe('0016_finance_document_knowledge');
      for (const migration of migrations) await admin.query(migration.sql);

      await expect(
        admin.query(
          `select extension.extversion
             from pg_catalog.pg_extension as extension
            where extension.extname = 'vector'`,
        ),
      ).resolves.toMatchObject({ rows: [expect.any(Object)] });

      loginRole = `emdo_finance_document_live_${randomUUID()
        .replaceAll('-', '')
        .slice(0, 18)}`;
      loginPassword = `finance_document_${randomUUID().replaceAll('-', '')}`;
      await admin.query(
        `create role ${loginRole} login nosuperuser nocreatedb nocreaterole
          inherit nobypassrls noreplication password '${loginPassword}'`,
      );
      await admin.query(`grant emdo_app to ${loginRole}`);

      await admin.query(
        `insert into emdo.auth_users (id, name, email, email_verified)
           values ($1, 'Document Owner', 'document-owner@example.test', true),
                  ($2, 'Document Collaborator', 'document-collaborator@example.test', true)`,
        [ids.owner, ids.collaborator],
      );
      await admin.query(
        `insert into emdo.households (id, name, slug, created_by_user_id)
           values ($1, 'Finance document household', 'finance-document-household', $2)`,
        [ids.household, ids.owner],
      );
      await admin.query(
        `insert into emdo.household_memberships
           (household_id, user_id, role, status, joined_at)
           values ($1, $2, 'owner', 'active', pg_catalog.clock_timestamp()),
                  ($1, $3, 'member', 'active', pg_catalog.clock_timestamp())`,
        [ids.household, ids.owner, ids.collaborator],
      );
      await admin.query(
        `insert into emdo.spaces
           (id, household_id, original_owner_user_id, name, visibility)
           values ($1, $3, $4, 'Owner private finance', 'private'),
                  ($2, $3, $5, 'Collaborator private finance', 'private')`,
        [
          ids.ownerPrivateSpace,
          ids.collaboratorPrivateSpace,
          ids.household,
          ids.owner,
          ids.collaborator,
        ],
      );
      await admin.query(
        `insert into emdo.auth_sessions
           (id, user_id, token, expires_at, active_household_id)
           values ($1, $2, 'finance-document-owner-session',
                   pg_catalog.clock_timestamp() + interval '1 hour', $3),
                  ($4, $5, 'finance-document-collaborator-session',
                   pg_catalog.clock_timestamp() + interval '1 hour', $3)`,
        [
          ids.ownerSession,
          ids.owner,
          ids.household,
          ids.collaboratorSession,
          ids.collaborator,
        ],
      );

      app = new Pool({
        allowExitOnIdle: true,
        application_name: 'emdo-finance-document-live-app',
        connectionString: loginConnectionString(loginRole, loginPassword),
        max: 1,
      });

      await withPrincipal(ownerPrincipal, async (client) => {
        await insertDocument(client, {
          id: ids.ownerDocument,
          ownerUserId: ids.owner,
          spaceId: ids.ownerPrivateSpace,
          storageObjectId: 'finance-document-owner-0001',
          displayName: 'Owner groceries receipt.pdf',
          plaintextHash: sha256('a'),
          ciphertextHash: sha256('b'),
        });
        await client.query(
          `insert into emdo.finance_document_extractions (
             id, document_id, household_id, space_id, original_owner_user_id,
             revision, attempt, state
           ) values ($1, $2, $3, $4, $5, 1, 1, 'queued')`,
          [
            ids.ownerExtraction,
            ids.ownerDocument,
            ids.household,
            ids.ownerPrivateSpace,
            ids.owner,
          ],
        );
        await client.query(
          `insert into emdo.finance_document_chunks (
             id, document_id, extraction_revision, household_id, space_id,
             original_owner_user_id, ordinal, page_start, page_end, content,
             content_hash, committed_at
           ) values ($1, $2, 1, $3, $4, $5, 0, 1, 1,
                     'groceries receipt merchant total', $6,
                     pg_catalog.clock_timestamp())`,
          [
            ids.ownerChunk,
            ids.ownerDocument,
            ids.household,
            ids.ownerPrivateSpace,
            ids.owner,
            sha256('c'),
          ],
        );
        await client.query(
          `insert into emdo.finance_document_evidence (
             id, document_id, extraction_revision, chunk_id, household_id,
             space_id, original_owner_user_id, page, excerpt, excerpt_hash,
             locator, source_locale
           ) values ($1, $2, 1, $3, $4, $5, $6, 1,
                     'groceries total', $7, '{"page":1}'::jsonb, 'en-CA')`,
          [
            ids.ownerEvidence,
            ids.ownerDocument,
            ids.ownerChunk,
            ids.household,
            ids.ownerPrivateSpace,
            ids.owner,
            sha256('d'),
          ],
        );
        await client.query(
          `insert into emdo.finance_document_review_batches (
             id, document_id, extraction_revision, household_id, space_id,
             original_owner_user_id, authenticated_session_id,
             space_access_grant_id, scope_fingerprint, payload_hash,
             review_token_hash, selected_facts, idempotency_key, expires_at
           ) values ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10,
                     '{"facts":[]}'::jsonb,
                     'finance-document-review-owner-0001',
                     pg_catalog.clock_timestamp() + interval '15 minutes')`,
          [
            ids.ownerReviewBatch,
            ids.ownerDocument,
            ids.household,
            ids.ownerPrivateSpace,
            ids.owner,
            ids.ownerSession,
            ids.ownerSpaceAccessGrant,
            sha256('e'),
            sha256('f'),
            sha256('0'),
          ],
        );
        await client.query(
          `insert into emdo.finance_document_matches (
             id, document_id, extraction_revision, household_id, space_id,
             original_owner_user_id, record_type, record_id, score_basis_points,
             reasons
           ) values ($1, $2, 1, $3, $4, $5, 'transaction',
                     'transaction::groceries-0001', 9000,
                     '["same-amount"]'::jsonb)`,
          [
            ids.ownerMatch,
            ids.ownerDocument,
            ids.household,
            ids.ownerPrivateSpace,
            ids.owner,
          ],
        );
      });
      await withPrincipal(collaboratorPrincipal, async (client) => {
        await insertDocument(client, {
          id: ids.collaboratorDocument,
          ownerUserId: ids.collaborator,
          spaceId: ids.collaboratorPrivateSpace,
          storageObjectId: 'finance-document-collaborator-0001',
          displayName: 'Collaborator invoice.pdf',
          plaintextHash: sha256('1'),
          ciphertextHash: sha256('2'),
        });
      });
    }, 60_000);

    afterAll(async () => {
      await app?.end();
      if (admin !== undefined) {
        if (loginRole !== '') {
          await admin
            .query(`revoke emdo_app from ${loginRole}`)
            .catch(() => undefined);
          await admin
            .query(`drop role if exists ${loginRole}`)
            .catch(() => undefined);
        }
        await admin.end();
      }
    });

    it('applies all seventeen migrations and marks each document relation forced RLS', async () => {
      const relations = await admin.query<{
        forced: boolean;
        relation: string;
        rls: boolean;
      }>(
        `select relation.relname as relation,
                relation.relrowsecurity as rls,
                relation.relforcerowsecurity as forced
           from pg_catalog.pg_class as relation
           join pg_catalog.pg_namespace as namespace
             on namespace.oid = relation.relnamespace
          where namespace.nspname = 'emdo'
            and relation.relname = any($1::text[])
          order by relation.relname`,
        [financeDocumentTables],
      );
      expect(relations.rows).toEqual(
        [...financeDocumentTables]
          .sort()
          .map((relation) => ({ relation, rls: true, forced: true })),
      );

      const policies = await admin.query<{
        policyname: string;
        roles: readonly string[];
        tablename: string;
      }>(
        `select policy.tablename, policy.policyname, policy.roles::text[] as roles
           from pg_catalog.pg_policies as policy
          where policy.schemaname = 'emdo'
            and policy.tablename = any($1::text[])
          order by policy.tablename, policy.policyname`,
        [financeDocumentTables],
      );
      expect(policies.rows).toEqual(
        [...financeDocumentTables].sort().flatMap((tablename) => [
          {
            tablename,
            policyname: `${tablename}_executor_scope`,
            roles: ['emdo_finance_document_executor'],
          },
          {
            tablename,
            policyname: `${tablename}_uploader_scope`,
            roles: ['emdo_app'],
          },
        ]),
      );
    });

    it('allows each active household user only their own current private uploader scope', async () => {
      const ownerScope = await withPrincipal(ownerPrincipal, (client) =>
        client.query<{ active: boolean }>(
          `select emdo.is_active_finance_document_scope($1, $2, $3) as active`,
          [ids.household, ids.ownerPrivateSpace, ids.owner],
        ),
      );
      expect(ownerScope.rows).toEqual([{ active: true }]);

      const collaboratorScope = await withPrincipal(
        collaboratorPrincipal,
        (client) =>
          client.query<{ active: boolean }>(
            `select emdo.is_active_finance_document_scope($1, $2, $3) as active`,
            [ids.household, ids.collaboratorPrivateSpace, ids.collaborator],
          ),
      );
      expect(collaboratorScope.rows).toEqual([{ active: true }]);

      const ownerDocuments = await withPrincipal(ownerPrincipal, (client) =>
        client.query<{ id: string }>(
          `select id::text as id
             from emdo.finance_documents
            order by id`,
        ),
      );
      expect(ownerDocuments.rows).toEqual([{ id: ids.ownerDocument }]);

      const collaboratorDocuments = await withPrincipal(
        collaboratorPrincipal,
        (client) =>
          client.query<{ id: string }>(
            `select id::text as id
               from emdo.finance_documents
              order by id`,
          ),
      );
      expect(collaboratorDocuments.rows).toEqual([
        { id: ids.collaboratorDocument },
      ]);

      await expect(
        withPrincipal(collaboratorPrincipal, (client) =>
          insertDocument(client, {
            id: ids.deniedDocument,
            ownerUserId: ids.owner,
            spaceId: ids.ownerPrivateSpace,
            storageObjectId: 'finance-document-denied-0001',
            displayName: 'Denied cross-user receipt.pdf',
            plaintextHash: sha256('3'),
            ciphertextHash: sha256('4'),
          }),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('denies same-household private search, evidence, match, extraction, and review reads', async () => {
      const ownerSearch = await withPrincipal(ownerPrincipal, (client) =>
        client.query<{ id: string }>(
          `select id::text as id
             from emdo.finance_document_chunks
            where search_vector @@ pg_catalog.plainto_tsquery('simple', 'groceries')`,
        ),
      );
      expect(ownerSearch.rows).toEqual([{ id: ids.ownerChunk }]);

      const denied = await withPrincipal(
        collaboratorPrincipal,
        async (client) => {
          const [documents, chunks, evidence, matches, extractions, reviews] =
            await Promise.all([
              client.query<{ id: string }>(
                `select id::text as id from emdo.finance_documents where id = $1`,
                [ids.ownerDocument],
              ),
              client.query<{ id: string }>(
                `select id::text as id
                 from emdo.finance_document_chunks
                where search_vector @@ pg_catalog.plainto_tsquery('simple', 'groceries')`,
              ),
              client.query<{ id: string }>(
                `select id::text as id from emdo.finance_document_evidence`,
              ),
              client.query<{ id: string }>(
                `select id::text as id from emdo.finance_document_matches`,
              ),
              client.query<{ id: string }>(
                `select id::text as id from emdo.finance_document_extractions`,
              ),
              client.query<{ id: string }>(
                `select id::text as id from emdo.finance_document_review_batches`,
              ),
            ]);
          return { documents, chunks, evidence, matches, extractions, reviews };
        },
      );

      expect(denied.documents.rows).toEqual([]);
      expect(denied.chunks.rows).toEqual([]);
      expect(denied.evidence.rows).toEqual([]);
      expect(denied.matches.rows).toEqual([]);
      expect(denied.extractions.rows).toEqual([]);
      expect(denied.reviews.rows).toEqual([]);
    });

    it('enforces row-local lifecycle predicates and permits an explicit review invalidation', async () => {
      await expect(
        withPrincipal(ownerPrincipal, (client) =>
          client.query(
            `update emdo.finance_document_extractions
                set state = 'awaiting-review'
              where id = $1`,
            [ids.ownerExtraction],
          ),
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        withPrincipal(ownerPrincipal, (client) =>
          client.query(
            `update emdo.finance_document_review_batches
                set state = 'invalidated'
              where id = $1`,
            [ids.ownerReviewBatch],
          ),
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        withPrincipal(ownerPrincipal, (client) =>
          client.query(
            `update emdo.finance_document_matches
                set state = 'accepted'
              where id = $1`,
            [ids.ownerMatch],
          ),
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        withPrincipal(collaboratorPrincipal, (client) =>
          client.query(
            `update emdo.finance_documents
                set state = 'deleted', updated_at = pg_catalog.clock_timestamp()
              where id = $1`,
            [ids.collaboratorDocument],
          ),
        ),
      ).rejects.toMatchObject({ code: '23514' });

      const transitioned = await withPrincipal(
        ownerPrincipal,
        async (client) => {
          await client.query(
            `update emdo.finance_documents
              set state = 'extracting', extraction_revision = 1,
                  updated_at = pg_catalog.clock_timestamp()
            where id = $1`,
            [ids.ownerDocument],
          );
          await client.query(
            `update emdo.finance_document_extractions
              set state = 'extracting'
            where id = $1`,
            [ids.ownerExtraction],
          );
          await client.query(
            `update emdo.finance_documents
              set state = 'awaiting-review', updated_at = pg_catalog.clock_timestamp()
            where id = $1`,
            [ids.ownerDocument],
          );
          await client.query(
            `update emdo.finance_document_extractions
              set state = 'awaiting-review', completed_at = pg_catalog.clock_timestamp()
            where id = $1`,
            [ids.ownerExtraction],
          );
          await client.query(
            `update emdo.finance_documents
              set extraction_revision = 2, updated_at = pg_catalog.clock_timestamp()
            where id = $1`,
            [ids.ownerDocument],
          );
          await client.query(
            `update emdo.finance_document_review_batches
              set state = 'invalidated', decided_at = pg_catalog.clock_timestamp()
            where id = $1`,
            [ids.ownerReviewBatch],
          );
          await client.query(
            `update emdo.finance_document_matches
              set state = 'accepted', decision_review_batch_id = $2,
                  decided_at = pg_catalog.clock_timestamp()
            where id = $1`,
            [ids.ownerMatch, ids.ownerReviewBatch],
          );
          await client.query(
            `update emdo.finance_document_extractions
              set state = 'superseded'
            where id = $1`,
            [ids.ownerExtraction],
          );
          return client.query<{
            document_revision: number;
            extraction_state: string;
            match_state: string;
            review_state: string;
          }>(
            `select document.extraction_revision as document_revision,
                  extraction.state as extraction_state,
                  review.state as review_state,
                  match.state as match_state
             from emdo.finance_documents as document
             join emdo.finance_document_extractions as extraction
               on extraction.id = $2
             join emdo.finance_document_review_batches as review
               on review.id = $3
             join emdo.finance_document_matches as match
               on match.id = $4
            where document.id = $1`,
            [
              ids.ownerDocument,
              ids.ownerExtraction,
              ids.ownerReviewBatch,
              ids.ownerMatch,
            ],
          );
        },
      );
      expect(transitioned.rows).toEqual([
        {
          document_revision: 2,
          extraction_state: 'superseded',
          review_state: 'invalidated',
          match_state: 'accepted',
        },
      ]);

      const tombstone = await withPrincipal(collaboratorPrincipal, (client) =>
        client.query<{ state: string }>(
          `update emdo.finance_documents
              set state = 'deleted', deleted_at = pg_catalog.clock_timestamp(),
                  storage_object_id = null, display_name = null,
                  mime_type = null, byte_size = null, page_count = null,
                  image_width = null, image_height = null,
                  plaintext_sha256 = null, ciphertext_sha256 = null,
                  wrapped_data_key = null, key_version = null,
                  document_type = null, source_locale = null,
                  currency = null, extraction_revision = null,
                  updated_at = pg_catalog.clock_timestamp()
            where id = $1
          returning state`,
          [ids.collaboratorDocument],
        ),
      );
      expect(tombstone.rows).toEqual([{ state: 'deleted' }]);
    });

    it('keeps executor and table ACLs bounded and makes readiness fail closed for covered drift', async () => {
      const executor = await admin.query<{
        rolbypassrls: boolean;
        rolcanlogin: boolean;
        rolinherit: boolean;
        rolsuper: boolean;
      }>(`select rolsuper, rolcanlogin, rolinherit, rolbypassrls
           from pg_catalog.pg_roles
          where rolname = 'emdo_finance_document_executor'`);
      expect(executor.rows).toEqual([
        {
          rolsuper: false,
          rolcanlogin: false,
          rolinherit: false,
          rolbypassrls: false,
        },
      ]);
      await expect(
        admin.query(
          `select 1
             from pg_catalog.pg_auth_members as membership
             join pg_catalog.pg_roles as role
               on role.oid = membership.roleid
             join pg_catalog.pg_roles as member
               on member.oid = membership.member
            where role.rolname = 'emdo_finance_document_executor'
               or member.rolname = 'emdo_finance_document_executor'`,
        ),
      ).resolves.toMatchObject({ rows: [] });

      const tableAcl = await admin.query<{
        app_delete: boolean;
        app_insert: boolean;
        app_select: boolean;
        app_update: boolean;
        executor_delete: boolean;
        executor_insert: boolean;
        executor_select: boolean;
        executor_update: boolean;
        public_access: boolean;
        table_name: string;
      }>(
        `select relation.table_name,
                pg_catalog.has_table_privilege('emdo_app', 'emdo.' || relation.table_name, 'select') as app_select,
                pg_catalog.has_table_privilege('emdo_app', 'emdo.' || relation.table_name, 'insert') as app_insert,
                pg_catalog.has_table_privilege('emdo_app', 'emdo.' || relation.table_name, 'update') as app_update,
                pg_catalog.has_table_privilege('emdo_app', 'emdo.' || relation.table_name, 'delete') as app_delete,
                pg_catalog.has_table_privilege('emdo_finance_document_executor', 'emdo.' || relation.table_name, 'select') as executor_select,
                pg_catalog.has_table_privilege('emdo_finance_document_executor', 'emdo.' || relation.table_name, 'insert') as executor_insert,
                pg_catalog.has_table_privilege('emdo_finance_document_executor', 'emdo.' || relation.table_name, 'update') as executor_update,
                pg_catalog.has_table_privilege('emdo_finance_document_executor', 'emdo.' || relation.table_name, 'delete') as executor_delete,
                pg_catalog.has_table_privilege('public', 'emdo.' || relation.table_name, 'select')
                  or pg_catalog.has_table_privilege('public', 'emdo.' || relation.table_name, 'insert')
                  or pg_catalog.has_table_privilege('public', 'emdo.' || relation.table_name, 'update')
                  or pg_catalog.has_table_privilege('public', 'emdo.' || relation.table_name, 'delete') as public_access
           from unnest($1::text[]) as relation(table_name)
          order by relation.table_name`,
        [financeDocumentTables],
      );
      expect(tableAcl.rows).toEqual(
        [...financeDocumentTables].sort().map((table_name) => ({
          table_name,
          app_select: true,
          app_insert: true,
          app_update: true,
          app_delete: true,
          executor_select: true,
          executor_insert: true,
          executor_update: true,
          executor_delete: true,
          public_access: false,
        })),
      );

      const routineAcl = await admin.query<{
        app_claim: boolean;
        app_ready: boolean;
        app_scope: boolean;
        executor_ready: boolean;
        executor_scope: boolean;
        public_claim: boolean;
        public_ready: boolean;
        public_scope: boolean;
        worker_claim: boolean;
      }>(`select
            pg_catalog.has_function_privilege('emdo_app', 'emdo.is_active_finance_document_scope(uuid,uuid,uuid)', 'execute') as app_scope,
            pg_catalog.has_function_privilege('emdo_finance_document_executor', 'emdo.is_active_finance_document_scope(uuid,uuid,uuid)', 'execute') as executor_scope,
            pg_catalog.has_function_privilege('public', 'emdo.is_active_finance_document_scope(uuid,uuid,uuid)', 'execute') as public_scope,
            pg_catalog.has_function_privilege('emdo_app', 'emdo.claim_next_finance_document_extraction()', 'execute') as app_claim,
            pg_catalog.has_function_privilege('emdo_worker_executor', 'emdo.claim_next_finance_document_extraction()', 'execute') as worker_claim,
            pg_catalog.has_function_privilege('public', 'emdo.claim_next_finance_document_extraction()', 'execute') as public_claim,
            pg_catalog.has_function_privilege('emdo_app', 'emdo.finance_documents_ready()', 'execute') as app_ready,
            pg_catalog.has_function_privilege('emdo_finance_document_executor', 'emdo.finance_documents_ready()', 'execute') as executor_ready,
            pg_catalog.has_function_privilege('public', 'emdo.finance_documents_ready()', 'execute') as public_ready`);
      expect(routineAcl.rows).toEqual([
        {
          app_scope: true,
          executor_scope: true,
          public_scope: false,
          app_claim: false,
          worker_claim: true,
          public_claim: false,
          app_ready: true,
          executor_ready: false,
          public_ready: false,
        },
      ]);

      const readiness = () =>
        app.query<{ ready: boolean }>(
          'select emdo.finance_documents_ready() as ready',
        );
      await expect(readiness()).resolves.toMatchObject({
        rows: [{ ready: true }],
      });

      try {
        await admin.query(
          'revoke execute on function emdo.claim_next_finance_document_extraction() from emdo_worker_executor',
        );
        await expect(readiness()).resolves.toMatchObject({
          rows: [{ ready: false }],
        });
      } finally {
        await admin.query(
          'grant execute on function emdo.claim_next_finance_document_extraction() to emdo_worker_executor',
        );
      }

      try {
        await admin.query(
          'alter table emdo.finance_document_matches no force row level security',
        );
        await expect(readiness()).resolves.toMatchObject({
          rows: [{ ready: false }],
        });
      } finally {
        await admin.query(
          'alter table emdo.finance_document_matches force row level security',
        );
      }

      try {
        await admin.query('grant select on emdo.finance_documents to public');
        await expect(readiness()).resolves.toMatchObject({
          rows: [{ ready: false }],
        });
      } finally {
        await admin.query(
          'revoke select on emdo.finance_documents from public',
        );
      }

      try {
        await admin.query(
          'revoke execute on function emdo.is_active_finance_document_scope(uuid, uuid, uuid) from emdo_app',
        );
        await expect(readiness()).resolves.toMatchObject({
          rows: [{ ready: false }],
        });
      } finally {
        await admin.query(
          'grant execute on function emdo.is_active_finance_document_scope(uuid, uuid, uuid) to emdo_app',
        );
      }

      await expect(readiness()).resolves.toMatchObject({
        rows: [{ ready: true }],
      });
    });
  },
);

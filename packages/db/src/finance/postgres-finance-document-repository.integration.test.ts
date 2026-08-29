import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadOrderedMigrations } from '../migrations.js';
import type { DatabasePool } from '../scoped-repository.js';
import { PostgresFinanceDocumentRepository } from './postgres-finance-document-repository.js';
import { PostgresFinanceSpecialistRecordRepository } from './postgres-finance-specialist-record-repository.js';

const databaseUrl = process.env.TEST_FINANCE_DOCUMENT_DATABASE_URL;
const databaseAttestation =
  process.env.EMDO_POSTGRES_INTEGRATION_DATABASE_ATTESTATION;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;
const financeDocumentDatabaseNamePattern =
  /^emdo_ci_finance_document_knowledge_[0-9a-f]{12}$/u;
const financeDocumentDatabaseAttestationPattern =
  /^emdo-postgres-suite-v1:finance-document-knowledge:[0-9a-f]{32}$/u;

const assertDisposableFinanceDocumentDatabase = async (
  admin: Pick<import('pg').Pool, 'query'>,
): Promise<void> => {
  if (
    databaseUrl === undefined ||
    databaseAttestation === undefined ||
    !financeDocumentDatabaseAttestationPattern.test(databaseAttestation)
  ) {
    throw new Error(
      'Finance document integration requires the orchestrator database attestation.',
    );
  }
  const expectedDatabaseName = new URL(databaseUrl).pathname.slice(1);
  if (!financeDocumentDatabaseNamePattern.test(expectedDatabaseName)) {
    throw new Error(
      'Finance document integration requires an orchestrator-created disposable database.',
    );
  }
  const result = await admin.query<{
    attestation: string | null;
    database_name: string;
  }>(`select database.datname as database_name,
             pg_catalog.shobj_description(database.oid, 'pg_database') as attestation
        from pg_catalog.pg_database as database
       where database.datname = pg_catalog.current_database()`);
  const attestedDatabase = result.rows[0];
  if (
    result.rows.length !== 1 ||
    attestedDatabase?.database_name !== expectedDatabaseName ||
    attestedDatabase.attestation !== databaseAttestation
  ) {
    throw new Error(
      'Finance document integration database attestation was not verified.',
    );
  }
};

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
  ownerSemanticDocument: 'f2000000-0000-4000-8000-000000000021',
  ownerSemanticChunk: 'f2000000-0000-4000-8000-000000000022',
  ownerFilteredDocument: 'f2000000-0000-4000-8000-000000000023',
  ownerFilteredChunk: 'f2000000-0000-4000-8000-000000000024',
  ownerStaleDocument: 'f2000000-0000-4000-8000-000000000025',
  ownerStaleChunk: 'f2000000-0000-4000-8000-000000000026',
  collaboratorSemanticDocument: 'f2000000-0000-4000-8000-000000000027',
  collaboratorSemanticChunk: 'f2000000-0000-4000-8000-000000000028',
  ownerLexicalFusionDocument: 'f2000000-0000-4000-8000-000000000029',
  ownerLexicalFusionChunk: 'f2000000-0000-4000-8000-000000000030',
  ownerVectorFusionDocument: 'f2000000-0000-4000-8000-000000000031',
  ownerVectorFusionChunk: 'f2000000-0000-4000-8000-000000000032',
  ownerDualFusionDocument: 'f2000000-0000-4000-8000-000000000033',
  ownerDualFusionChunk: 'f2000000-0000-4000-8000-000000000034',
  collaboratorSpaceAccessGrant: 'f2000000-0000-4000-8000-000000000035',
  ownerReplaySession: 'f2000000-0000-4000-8000-000000000036',
  ownerReplayRequest: 'f2000000-0000-4000-8000-000000000037',
  ownerReplaySpaceAccessGrant: 'f2000000-0000-4000-8000-000000000038',
  ownerUploadedDocument: 'f2000000-0000-4000-8000-000000000039',
  ownerUploadedExtraction: 'f2000000-0000-4000-8000-000000000040',
  ownerRotatedRequest: 'f2000000-0000-4000-8000-000000000041',
  ownerRotatedSpaceAccessGrant: 'f2000000-0000-4000-8000-000000000042',
  ownerRotatedDocument: 'f2000000-0000-4000-8000-000000000043',
  ownerRotatedExtraction: 'f2000000-0000-4000-8000-000000000044',
  ownerRotatedReviewBatch: 'f2000000-0000-4000-8000-000000000045',
  ownerRotatedChunk: 'f2000000-0000-4000-8000-000000000046',
  ownerRotatedMatch: 'f2000000-0000-4000-8000-000000000047',
});

const sha256 = (character: string): string => character.repeat(64);

const guardedDeletionReceipt = Object.freeze({
  proposalId: 'f2000000-0000-4000-8000-000000000019',
  decisionId: 'f2000000-0000-4000-8000-000000000020',
  targetBindingHash: sha256('7'),
  executionBindingHash: sha256('8'),
});

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

interface CommittedDocumentInput extends DocumentInput {
  readonly currency: 'CAD' | 'USD';
  readonly documentType: 'invoice' | 'receipt';
  readonly extractionRevision: number;
}

interface ChunkInput {
  readonly content: string;
  readonly documentId: string;
  readonly embedding: string | null;
  readonly extractionRevision: number;
  readonly id: string;
  readonly ownerUserId: string;
  readonly spaceId: string;
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

const ownerReplayPrincipal = Object.freeze({
  userId: ids.owner,
  sessionId: ids.ownerReplaySession,
  requestId: ids.ownerReplayRequest,
} satisfies Principal);

const ownerRotatedPrincipal = Object.freeze({
  userId: ids.owner,
  sessionId: ids.ownerSession,
  requestId: ids.ownerRotatedRequest,
} satisfies Principal);

const ownerRepositoryPrincipal = Object.freeze({
  userId: ids.owner,
  sessionId: ids.ownerSession,
  householdId: ids.household,
  privateSpaceId: ids.ownerPrivateSpace,
  emailVerified: true as const,
  spaceAccessGrantId: ids.ownerSpaceAccessGrant,
  scopeFingerprint: sha256('f'),
});

const ownerRotatedRepositoryPrincipal = Object.freeze({
  ...ownerRepositoryPrincipal,
  spaceAccessGrantId: ids.ownerRotatedSpaceAccessGrant,
});

const loginConnectionString = (role: string, password: string): string => {
  const url = new URL(databaseUrl!);
  url.username = role;
  url.password = password;
  return url.toString();
};

const databasePool = (pool: import('pg').Pool): DatabasePool =>
  pool as unknown as DatabasePool;

const embeddingLiteral = (value: number): string =>
  `[${Array.from({ length: 1_536 }, () => value).join(',')}]`;

const alternatingEmbeddingLiteral = (): string =>
  `[${Array.from({ length: 1_536 }, (_, index) =>
    index % 2 === 0 ? 1 : 0,
  ).join(',')}]`;

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
       'application/pdf', 1024, 1, $7, $8,
       '{"algorithm":"aes-256-gcm","wrappedKey":"dGVzdA","nonce":"dGVzdA","authenticationTag":"dGVzdA","aadVersion":1}'::jsonb,
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

const insertCommittedDocument = async (
  client: import('pg').Pool,
  input: CommittedDocumentInput,
): Promise<void> => {
  await client.query(
    `insert into emdo.finance_documents (
       id, household_id, space_id, original_owner_user_id, storage_object_id,
       display_name, mime_type, byte_size, page_count, plaintext_sha256,
       ciphertext_sha256, wrapped_data_key, key_version, state, document_type,
       source_locale, currency, extraction_revision
     ) values (
       $1, $2, $3, $4, $5, $6, 'application/pdf', 1024, 1, $7, $8,
       '{"algorithm":"aes-256-gcm","wrappedKey":"dGVzdA","nonce":"dGVzdA","authenticationTag":"dGVzdA","aadVersion":1}'::jsonb,
       'finance-document-test-key-v1',
       'committed', $9, 'en-CA', $10, $11
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
      input.documentType,
      input.currency,
      input.extractionRevision,
    ],
  );
};

const insertCommittedChunk = async (
  client: import('pg').Pool,
  input: ChunkInput,
): Promise<void> => {
  await client.query(
    `insert into emdo.finance_document_chunks (
       id, document_id, extraction_revision, household_id, space_id,
       original_owner_user_id, ordinal, page_start, page_end, content,
       content_hash, embedding, committed_at
     ) values (
       $1, $2, $3, $4, $5, $6, 0, 1, 1, $7, $8, $9::vector,
       pg_catalog.clock_timestamp()
     )`,
    [
      input.id,
      input.documentId,
      input.extractionRevision,
      ids.household,
      input.spaceId,
      input.ownerUserId,
      input.content,
      sha256(input.id.at(-1) ?? '0'),
      input.embedding,
    ],
  );
};

describeDatabase(
  'PostgreSQL 18 finance document knowledge direct SQL contract (requires disposable TEST_FINANCE_DOCUMENT_DATABASE_URL)',
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

    const seedSpaceAccessGrant = async (input: {
      readonly grantId: string;
      readonly principal: Principal;
      readonly privateSpaceId: string;
    }): Promise<void> => {
      await admin.query(
        `insert into emdo.space_access_grants
           (grant_id, household_id, original_owner_user_id, session_id,
            request_id, membership_id, role, private_space_id,
            writable_space_ids, issued_at, expires_at, retain_until)
         select $1::uuid, membership.household_id, membership.user_id,
                $2::uuid, $3::uuid, membership.id, membership.role, $4::uuid,
                array[$4::uuid],
                pg_catalog.clock_timestamp() - interval '1 second',
                pg_catalog.clock_timestamp() + interval '10 minutes',
                pg_catalog.clock_timestamp() + interval '89 days'
           from emdo.household_memberships as membership
          where membership.household_id = $5::uuid
            and membership.user_id = $6::uuid`,
        [
          input.grantId,
          input.principal.sessionId,
          input.principal.requestId,
          input.privateSpaceId,
          ids.household,
          input.principal.userId,
        ],
      );
    };

    beforeAll(async () => {
      const { Pool } = await import('pg');
      admin = new Pool({
        allowExitOnIdle: true,
        application_name: 'emdo-finance-document-live-admin',
        connectionString: databaseUrl,
        max: 1,
      });
      await assertDisposableFinanceDocumentDatabase(admin);
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
      expect(migrations).toHaveLength(22);
      expect(migrations.at(-1)?.id).toBe('0021_blocked_visual_decision_claim');
      if (preflight.rows[0]?.emdo_schema === null) {
        for (const migration of migrations) await admin.query(migration.sql);
      } else {
        expect(preflight.rows[0]?.emdo_schema).toBe('emdo');
        const companion = await admin.query<{
          companion_seeded: boolean;
          disclosure_ready: boolean;
          fixture_available: boolean;
        }>(
          `select exists (
                    select 1
                      from emdo.finance_documents
                     where id = $1
                       and original_owner_user_id = $2
                  ) as companion_seeded,
                  pg_catalog.to_regprocedure(
                    'emdo.issue_model_disclosure_grant(uuid,uuid,uuid,uuid,uuid,text,text,text,text,jsonb)'
                  ) is not null
                  and pg_catalog.to_regprocedure(
                    'emdo.resolve_model_disclosure_grant(uuid,uuid,uuid,uuid,uuid,text,text,text,jsonb)'
                  ) is not null as disclosure_ready,
                  not exists (
                    select 1 from emdo.auth_users where id = $3
                  ) as fixture_available`,
          [
            'f3100000-0000-4000-8000-000000000008',
            'f3100000-0000-4000-8000-000000000001',
            ids.owner,
          ],
        );
        expect(companion.rows).toEqual([
          {
            companion_seeded: true,
            disclosure_ready: true,
            fixture_available: true,
          },
        ]);
      }

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
                   pg_catalog.clock_timestamp() + interval '1 hour', $3),
                  ($6, $2, 'finance-document-owner-replay-session',
                   pg_catalog.clock_timestamp() + interval '1 hour', $3)`,
        [
          ids.ownerSession,
          ids.owner,
          ids.household,
          ids.collaboratorSession,
          ids.collaborator,
          ids.ownerReplaySession,
        ],
      );

      app = new Pool({
        allowExitOnIdle: true,
        application_name: 'emdo-finance-document-live-app',
        connectionString: loginConnectionString(loginRole, loginPassword),
        max: 1,
      });

      await seedSpaceAccessGrant({
        grantId: ids.ownerSpaceAccessGrant,
        principal: ownerPrincipal,
        privateSpaceId: ids.ownerPrivateSpace,
      });
      await seedSpaceAccessGrant({
        grantId: ids.collaboratorSpaceAccessGrant,
        principal: collaboratorPrincipal,
        privateSpaceId: ids.collaboratorPrivateSpace,
      });
      await seedSpaceAccessGrant({
        grantId: ids.ownerReplaySpaceAccessGrant,
        principal: ownerReplayPrincipal,
        privateSpaceId: ids.ownerPrivateSpace,
      });
      await seedSpaceAccessGrant({
        grantId: ids.ownerRotatedSpaceAccessGrant,
        principal: ownerRotatedPrincipal,
        privateSpaceId: ids.ownerPrivateSpace,
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

    it('applies all ordered migrations and marks each document relation forced RLS', async () => {
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

    it('persists a fresh upload, queues its first extraction, and reads back the current owner-scoped metadata', async () => {
      const generatedIds = [
        ids.ownerUploadedDocument,
        ids.ownerUploadedExtraction,
      ];
      const repository = new PostgresFinanceDocumentRepository(
        databasePool(app),
        {
          generateUuid: () => {
            const id = generatedIds.shift();
            if (id === undefined) throw new Error('unexpected generated UUID');
            return id;
          },
        },
      );
      const storage = {
        storageObjectId: 'finance-document-owner-upload-regression-0001',
        displayName: 'Synthetic upload regression.pdf',
        mimeType: 'application/pdf' as const,
        byteSize: 683,
        pageCount: 1,
        imageWidth: null,
        imageHeight: null,
        plaintextSha256: sha256('9'),
        ciphertextSha256: sha256('6'),
        wrappedDataKey: {
          algorithm: 'aes-256-gcm' as const,
          wrappedKey: 'synthetic-wrapped-key',
          nonce: 'synthetic-nonce',
          authenticationTag: 'synthetic-authentication-tag',
          aadVersion: 1 as const,
        },
        keyVersion: 'finance-document-test-key-v1',
      };

      try {
        const created = await repository.createUploadedMetadata({
          principal: ownerRepositoryPrincipal,
          requestId: ids.ownerRequest,
          storage,
        });
        expect(created).toMatchObject({
          status: 'created',
          document: {
            id: ids.ownerUploadedDocument,
            state: 'uploaded',
            displayName: storage.displayName,
            extractionRevision: null,
          },
        });

        await expect(
          repository.createOrRetryExtractionRevision({
            principal: ownerRepositoryPrincipal,
            requestId: ids.ownerRequest,
            documentId: ids.ownerUploadedDocument,
            retry: false,
            model: null,
          }),
        ).resolves.toEqual({
          id: ids.ownerUploadedExtraction,
          documentId: ids.ownerUploadedDocument,
          revision: 1,
          attempt: 1,
          state: 'queued',
        });

        await expect(
          repository.getMetadata({
            principal: ownerRepositoryPrincipal,
            requestId: ids.ownerRequest,
            documentId: ids.ownerUploadedDocument,
          }),
        ).resolves.toMatchObject({
          id: ids.ownerUploadedDocument,
          state: 'extracting',
          displayName: storage.displayName,
          extractionRevision: 1,
        });
        expect(generatedIds).toEqual([]);
      } finally {
        await admin.query(
          `delete from emdo.finance_document_extractions where id = $1`,
          [ids.ownerUploadedExtraction],
        );
        await admin.query(`delete from emdo.finance_documents where id = $1`, [
          ids.ownerUploadedDocument,
        ]);
      }
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

    it('keeps a review usable across a same-session grant rotation while denying changed session, scope, and user bindings', async () => {
      const generatedIds = [
        ids.ownerRotatedReviewBatch,
        ids.ownerRotatedChunk,
        ids.ownerRotatedMatch,
      ];
      const repository = new PostgresFinanceDocumentRepository(
        databasePool(app),
        {
          generateUuid: () => {
            const id = generatedIds.shift();
            if (id === undefined) throw new Error('unexpected generated UUID');
            return id;
          },
        },
      );
      const reviewToken = 'B'.repeat(43);
      const idempotencyKey = 'finance-review-rotated-grant-0001';
      const selectedFacts = {
        documentType: 'receipt' as const,
        sourceLocale: 'en-CA' as const,
        currency: 'CAD',
        chunks: [
          {
            ordinal: 0,
            pageStart: 1,
            pageEnd: 1,
            content: 'Reviewed rotated grant receipt total',
            embedding: null,
          },
        ],
        evidence: [],
        matchSuggestions: [
          {
            recordType: 'transaction' as const,
            recordId: 'transaction::rotated-grant-0001',
            scoreBasisPoints: 9000,
            reasons: ['same-total'],
          },
        ],
      };
      const changedSessionPrincipal = {
        ...ownerRepositoryPrincipal,
        sessionId: ids.ownerReplaySession,
        spaceAccessGrantId: ids.ownerReplaySpaceAccessGrant,
      };
      const changedScopePrincipal = {
        ...ownerRotatedRepositoryPrincipal,
        scopeFingerprint: sha256('0'),
      };
      const collaboratorRepositoryPrincipal = {
        userId: ids.collaborator,
        sessionId: ids.collaboratorSession,
        householdId: ids.household,
        privateSpaceId: ids.collaboratorPrivateSpace,
        emailVerified: true as const,
        spaceAccessGrantId: ids.collaboratorSpaceAccessGrant,
        scopeFingerprint: ownerRepositoryPrincipal.scopeFingerprint,
      };

      try {
        await withPrincipal(ownerPrincipal, async (client) => {
          await insertDocument(client, {
            id: ids.ownerRotatedDocument,
            ownerUserId: ids.owner,
            spaceId: ids.ownerPrivateSpace,
            storageObjectId: 'finance-document-rotated-grant-0001',
            displayName: 'Rotated grant receipt.pdf',
            plaintextHash: sha256('7'),
            ciphertextHash: sha256('8'),
          });
          await client.query(
            `update emdo.finance_documents
                set state = 'extracting', extraction_revision = 1,
                    updated_at = pg_catalog.clock_timestamp()
              where id = $1`,
            [ids.ownerRotatedDocument],
          );
          await client.query(
            `insert into emdo.finance_document_extractions (
               id, document_id, household_id, space_id, original_owner_user_id,
               revision, attempt, state
             ) values ($1, $2, $3, $4, $5, 1, 1, 'queued')`,
            [
              ids.ownerRotatedExtraction,
              ids.ownerRotatedDocument,
              ids.household,
              ids.ownerPrivateSpace,
              ids.owner,
            ],
          );
          await client.query(
            `update emdo.finance_document_extractions
                set state = 'extracting'
              where id = $1`,
            [ids.ownerRotatedExtraction],
          );
          await client.query(
            `update emdo.finance_documents
                set state = 'awaiting-review', updated_at = pg_catalog.clock_timestamp()
              where id = $1`,
            [ids.ownerRotatedDocument],
          );
          await client.query(
            `update emdo.finance_document_extractions
                set state = 'awaiting-review', completed_at = pg_catalog.clock_timestamp()
              where id = $1`,
            [ids.ownerRotatedExtraction],
          );
        });

        const created = await repository.replaceCurrentReviewDraft({
          principal: ownerRepositoryPrincipal,
          requestId: ids.ownerRequest,
          documentId: ids.ownerRotatedDocument,
          extractionRevision: 1,
          reviewToken,
          idempotencyKey,
          selectedFacts,
        });
        expect(created).toMatchObject({
          status: 'created',
          review: { id: ids.ownerRotatedReviewBatch },
        });
        const commitInput = {
          documentId: ids.ownerRotatedDocument,
          extractionRevision: 1,
          reviewBatchId: ids.ownerRotatedReviewBatch,
          reviewToken,
          payloadHash: created.review.payloadHash,
          idempotencyKey,
          embeddings: [
            {
              ordinal: 0,
              embedding: Array.from({ length: 1_536 }, () => 0.5),
            },
          ],
        };

        await expect(
          repository.getCurrentReviewDraft({
            principal: ownerRotatedRepositoryPrincipal,
            requestId: ids.ownerRotatedRequest,
            documentId: ids.ownerRotatedDocument,
          }),
        ).resolves.toMatchObject({
          id: ids.ownerRotatedReviewBatch,
          authenticatedSessionId: ids.ownerSession,
          spaceAccessGrantId: ids.ownerSpaceAccessGrant,
          scopeFingerprint: ownerRepositoryPrincipal.scopeFingerprint,
        });
        await expect(
          repository.replaceCurrentReviewDraft({
            principal: ownerRotatedRepositoryPrincipal,
            requestId: ids.ownerRotatedRequest,
            documentId: ids.ownerRotatedDocument,
            extractionRevision: 1,
            reviewToken,
            idempotencyKey,
            selectedFacts,
          }),
        ).resolves.toMatchObject({
          status: 'replayed',
          review: { id: ids.ownerRotatedReviewBatch },
        });

        for (const [principal, requestId] of [
          [changedSessionPrincipal, ids.ownerReplayRequest],
          [changedScopePrincipal, ids.ownerRotatedRequest],
          [collaboratorRepositoryPrincipal, ids.collaboratorRequest],
        ] as const) {
          await expect(
            repository.getCurrentReviewDraft({
              principal,
              requestId,
              documentId: ids.ownerRotatedDocument,
            }),
          ).resolves.toBeUndefined();
        }

        for (const [principal, requestId, code] of [
          [changedSessionPrincipal, ids.ownerReplayRequest, 'review-not-found'],
          [changedScopePrincipal, ids.ownerRotatedRequest, 'review-not-found'],
          [
            collaboratorRepositoryPrincipal,
            ids.collaboratorRequest,
            'document-not-found',
          ],
        ] as const) {
          await expect(
            repository.commitReview({ ...commitInput, principal, requestId }),
          ).rejects.toMatchObject({ code });
        }
        const pendingState = await admin.query<{
          documentState: string;
          hasMatch: boolean;
          reviewState: string;
        }>(
          `select document.state as "documentState", review.state as "reviewState",
                  exists (
                    select 1
                      from emdo.finance_document_matches as match
                     where match.document_id = document.id
                  ) as "hasMatch"
             from emdo.finance_documents as document
             join emdo.finance_document_review_batches as review
               on review.document_id = document.id
            where document.id = $1 and review.id = $2`,
          [ids.ownerRotatedDocument, ids.ownerRotatedReviewBatch],
        );
        expect(pendingState.rows).toEqual([
          {
            documentState: 'awaiting-review',
            reviewState: 'pending',
            hasMatch: false,
          },
        ]);
        await expect(
          repository.getCurrentReviewDraft({
            principal: collaboratorRepositoryPrincipal,
            requestId: ids.collaboratorRequest,
            documentId: ids.ownerRotatedDocument,
          }),
        ).resolves.toBeUndefined();

        await expect(
          repository.commitReview({
            ...commitInput,
            principal: ownerRotatedRepositoryPrincipal,
            requestId: ids.ownerRotatedRequest,
          }),
        ).resolves.toMatchObject({
          status: 'committed',
          documentId: ids.ownerRotatedDocument,
          matchSuggestionsCommitted: 1,
        });
        expect(generatedIds).toEqual([]);

        await expect(
          repository.getCurrentCommittedReview({
            principal: ownerRotatedRepositoryPrincipal,
            requestId: ids.ownerRotatedRequest,
            documentId: ids.ownerRotatedDocument,
          }),
        ).resolves.toMatchObject({
          id: ids.ownerRotatedReviewBatch,
          authenticatedSessionId: ids.ownerSession,
          spaceAccessGrantId: ids.ownerSpaceAccessGrant,
          scopeFingerprint: ownerRepositoryPrincipal.scopeFingerprint,
        });
        await expect(
          repository.getCommittedReviewAuthorization({
            principal: ownerRotatedRepositoryPrincipal,
            requestId: ids.ownerRotatedRequest,
            documentId: ids.ownerRotatedDocument,
            reviewToken,
          }),
        ).resolves.toMatchObject({
          id: ids.ownerRotatedReviewBatch,
          authenticatedSessionId: ids.ownerSession,
          spaceAccessGrantId: ids.ownerSpaceAccessGrant,
          scopeFingerprint: ownerRepositoryPrincipal.scopeFingerprint,
        });
        for (const [principal, requestId, code] of [
          [
            changedSessionPrincipal,
            ids.ownerReplayRequest,
            'review-unavailable',
          ],
          [
            changedScopePrincipal,
            ids.ownerRotatedRequest,
            'review-unavailable',
          ],
          [
            collaboratorRepositoryPrincipal,
            ids.collaboratorRequest,
            'document-not-found',
          ],
        ] as const) {
          await expect(
            repository.decideMatch({
              principal,
              requestId,
              documentId: ids.ownerRotatedDocument,
              matchId: ids.ownerRotatedMatch,
              reviewBatchId: ids.ownerRotatedReviewBatch,
              decision: 'accepted',
            }),
          ).rejects.toMatchObject({ code });
        }
        const committedState = await admin.query<{
          documentState: string;
          matchState: string;
          reviewState: string;
        }>(
          `select document.state as "documentState", review.state as "reviewState",
                  match.state as "matchState"
             from emdo.finance_documents as document
             join emdo.finance_document_review_batches as review
               on review.document_id = document.id
             join emdo.finance_document_matches as match
               on match.document_id = document.id
            where document.id = $1 and review.id = $2 and match.id = $3`,
          [
            ids.ownerRotatedDocument,
            ids.ownerRotatedReviewBatch,
            ids.ownerRotatedMatch,
          ],
        );
        expect(committedState.rows).toEqual([
          {
            documentState: 'committed',
            reviewState: 'committed',
            matchState: 'suggested',
          },
        ]);
        await expect(
          repository.getMatchById({
            principal: collaboratorRepositoryPrincipal,
            requestId: ids.collaboratorRequest,
            matchId: ids.ownerRotatedMatch,
          }),
        ).resolves.toBeUndefined();
        await expect(
          repository.decideMatch({
            principal: ownerRotatedRepositoryPrincipal,
            requestId: ids.ownerRotatedRequest,
            documentId: ids.ownerRotatedDocument,
            matchId: ids.ownerRotatedMatch,
            reviewBatchId: ids.ownerRotatedReviewBatch,
            decision: 'accepted',
          }),
        ).resolves.toEqual({ status: 'decided', state: 'accepted' });

        for (const [principal, requestId] of [
          [changedSessionPrincipal, ids.ownerReplayRequest],
          [changedScopePrincipal, ids.ownerRotatedRequest],
          [collaboratorRepositoryPrincipal, ids.collaboratorRequest],
        ] as const) {
          await expect(
            repository.getCommittedReviewAuthorization({
              principal,
              requestId,
              documentId: ids.ownerRotatedDocument,
              reviewToken,
            }),
          ).resolves.toBeUndefined();
        }

        const provenance = await admin.query<{ spaceAccessGrantId: string }>(
          `select space_access_grant_id::text as "spaceAccessGrantId"
             from emdo.finance_document_review_batches
            where id = $1`,
          [ids.ownerRotatedReviewBatch],
        );
        expect(provenance.rows).toEqual([
          { spaceAccessGrantId: ids.ownerSpaceAccessGrant },
        ]);
      } finally {
        await admin.query(
          `delete from emdo.finance_document_matches where id = $1`,
          [ids.ownerRotatedMatch],
        );
        await admin.query(
          `delete from emdo.finance_document_chunks where id = $1`,
          [ids.ownerRotatedChunk],
        );
        await admin.query(
          `delete from emdo.finance_document_review_batches where id = $1`,
          [ids.ownerRotatedReviewBatch],
        );
        await admin.query(
          `delete from emdo.finance_document_extractions where id = $1`,
          [ids.ownerRotatedExtraction],
        );
        await admin.query(`delete from emdo.finance_documents where id = $1`, [
          ids.ownerRotatedDocument,
        ]);
      }
    });

    it('provisions the exact synthetic Finance account once per owner-private scope and audits only first applies', async () => {
      const repository = new PostgresFinanceSpecialistRecordRepository(
        databasePool(app),
      );
      const idempotencyKey = 'synthetic-finance-account-provision-v1';
      const accountId = 'synthetic-finance-account-v1';
      const auditEventType = 'finance.synthetic-staging-account-provisioned';
      const scopeFor = (input: {
        readonly principal: Principal;
        readonly privateSpaceId: string;
        readonly grantId: string;
        readonly fingerprint: string;
      }) =>
        Object.freeze({
          requestId: input.principal.requestId,
          userId: input.principal.userId,
          householdId: ids.household,
          sessionId: input.principal.sessionId,
          privateSpaceId: input.privateSpaceId,
          spaceAccessGrantId: input.grantId,
          collectionAuthorizationScopeFingerprint: input.fingerprint,
          abortSignal: new AbortController().signal,
        });
      const expectedAccount = (input: {
        readonly ownerUserId: string;
        readonly spaceId: string;
      }) => ({
        schemaVersion: 1,
        id: accountId,
        spaceId: input.spaceId,
        ownerUserId: input.ownerUserId,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        recordType: 'account',
        name: 'Synthetic staging chequing',
        accountKind: 'chequing',
        currency: 'CAD',
        openingBalanceCadMinor: 0,
        active: true,
        source: 'manual',
      });
      const ownerScope = scopeFor({
        principal: ownerPrincipal,
        privateSpaceId: ids.ownerPrivateSpace,
        grantId: ids.ownerSpaceAccessGrant,
        fingerprint: sha256('a'),
      });
      const collaboratorScope = scopeFor({
        principal: collaboratorPrincipal,
        privateSpaceId: ids.collaboratorPrivateSpace,
        grantId: ids.collaboratorSpaceAccessGrant,
        fingerprint: sha256('b'),
      });
      const ownerReplayScope = scopeFor({
        principal: ownerReplayPrincipal,
        privateSpaceId: ids.ownerPrivateSpace,
        grantId: ids.ownerReplaySpaceAccessGrant,
        fingerprint: sha256('c'),
      });

      const ownerApplied = await repository.provisionSyntheticStagingAccount({
        scope: ownerScope,
        idempotencyKey,
      });
      expect(ownerApplied).toEqual({
        status: 'applied',
        record: expectedAccount({
          ownerUserId: ids.owner,
          spaceId: ids.ownerPrivateSpace,
        }),
        auditEventId: expect.any(String),
      });

      const ownerDuplicate = await repository.provisionSyntheticStagingAccount({
        scope: ownerReplayScope,
        idempotencyKey,
      });
      expect(ownerDuplicate).toEqual({
        status: 'duplicate',
        record: expectedAccount({
          ownerUserId: ids.owner,
          spaceId: ids.ownerPrivateSpace,
        }),
        auditEventId: ownerApplied.auditEventId,
      });
      await expect(
        repository.provisionSyntheticStagingAccount({
          scope: ownerScope,
          idempotencyKey: 'synthetic-finance-account-different-v1',
        }),
      ).rejects.toMatchObject({ code: 'conflict' });

      const collaboratorApplied =
        await repository.provisionSyntheticStagingAccount({
          scope: collaboratorScope,
          idempotencyKey,
        });
      expect(collaboratorApplied).toEqual({
        status: 'applied',
        record: expectedAccount({
          ownerUserId: ids.collaborator,
          spaceId: ids.collaboratorPrivateSpace,
        }),
        auditEventId: expect.any(String),
      });

      const canonical = await admin.query<{
        entity_id: string;
        entity_type: string;
        original_owner_user_id: string;
        payload: unknown;
        revision: number;
        space_id: string;
      }>(
        `select entity_id, entity_type, original_owner_user_id::text,
                space_id::text, payload, revision
           from emdo.sync_entities
          where household_id = $1::uuid
            and entity_type = 'finance.account'
            and entity_id = $2::text
          order by space_id`,
        [ids.household, accountId],
      );
      expect(canonical.rows).toEqual([
        {
          entity_id: accountId,
          entity_type: 'finance.account',
          original_owner_user_id: ids.owner,
          space_id: ids.ownerPrivateSpace,
          payload: expectedAccount({
            ownerUserId: ids.owner,
            spaceId: ids.ownerPrivateSpace,
          }),
          revision: 1,
        },
        {
          entity_id: accountId,
          entity_type: 'finance.account',
          original_owner_user_id: ids.collaborator,
          space_id: ids.collaboratorPrivateSpace,
          payload: expectedAccount({
            ownerUserId: ids.collaborator,
            spaceId: ids.collaboratorPrivateSpace,
          }),
          revision: 1,
        },
      ]);

      const ownerVisible = await withPrincipal(ownerPrincipal, (client) =>
        client.query<{ space_id: string }>(
          `select space_id::text
             from emdo.sync_entities
            where entity_type = 'finance.account' and entity_id = $1::text`,
          [accountId],
        ),
      );
      const collaboratorVisible = await withPrincipal(
        collaboratorPrincipal,
        (client) =>
          client.query<{ space_id: string }>(
            `select space_id::text
               from emdo.sync_entities
              where entity_type = 'finance.account' and entity_id = $1::text`,
            [accountId],
          ),
      );
      expect(ownerVisible.rows).toEqual([{ space_id: ids.ownerPrivateSpace }]);
      expect(collaboratorVisible.rows).toEqual([
        { space_id: ids.collaboratorPrivateSpace },
      ]);

      const audit = await admin.query<{
        event_type: string;
        payload: unknown;
        space_id: string;
      }>(
        `select event_type, payload, space_id::text
           from emdo.audit_events
          where household_id = $1::uuid
            and event_type = $2::text
            and payload ->> 'entityId' = $3::text
          order by space_id`,
        [ids.household, auditEventType, accountId],
      );
      expect(audit.rows).toEqual([
        {
          event_type: auditEventType,
          space_id: ids.ownerPrivateSpace,
          payload: {
            schemaVersion: 1,
            entityId: accountId,
            idempotencyKey,
            scopeFingerprint: sha256('a'),
            resultingRevision: 1,
          },
        },
        {
          event_type: auditEventType,
          space_id: ids.collaboratorPrivateSpace,
          payload: {
            schemaVersion: 1,
            entityId: accountId,
            idempotencyKey,
            scopeFingerprint: sha256('b'),
            resultingRevision: 1,
          },
        },
      ]);
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

    it('returns an owner-scoped semantic-only current candidate and excludes filtered or private rows', async () => {
      const queryEmbedding = embeddingLiteral(1);
      await Promise.all([
        insertCommittedDocument(admin, {
          id: ids.ownerSemanticDocument,
          ownerUserId: ids.owner,
          spaceId: ids.ownerPrivateSpace,
          storageObjectId: 'finance-document-owner-semantic-0001',
          displayName: 'Owner semantic receipt.pdf',
          plaintextHash: sha256('5'),
          ciphertextHash: sha256('6'),
          documentType: 'receipt',
          currency: 'CAD',
          extractionRevision: 1,
        }),
        insertCommittedDocument(admin, {
          id: ids.ownerFilteredDocument,
          ownerUserId: ids.owner,
          spaceId: ids.ownerPrivateSpace,
          storageObjectId: 'finance-document-owner-filtered-0001',
          displayName: 'Owner filtered invoice.pdf',
          plaintextHash: sha256('7'),
          ciphertextHash: sha256('8'),
          documentType: 'invoice',
          currency: 'USD',
          extractionRevision: 1,
        }),
        insertCommittedDocument(admin, {
          id: ids.ownerStaleDocument,
          ownerUserId: ids.owner,
          spaceId: ids.ownerPrivateSpace,
          storageObjectId: 'finance-document-owner-stale-0001',
          displayName: 'Owner stale receipt.pdf',
          plaintextHash: sha256('9'),
          ciphertextHash: sha256('0'),
          documentType: 'receipt',
          currency: 'CAD',
          extractionRevision: 2,
        }),
        insertCommittedDocument(admin, {
          id: ids.collaboratorSemanticDocument,
          ownerUserId: ids.collaborator,
          spaceId: ids.collaboratorPrivateSpace,
          storageObjectId: 'finance-document-collaborator-semantic-0001',
          displayName: 'Collaborator semantic receipt.pdf',
          plaintextHash: sha256('c'),
          ciphertextHash: sha256('d'),
          documentType: 'receipt',
          currency: 'CAD',
          extractionRevision: 1,
        }),
      ]);
      await Promise.all([
        insertCommittedChunk(admin, {
          id: ids.ownerSemanticChunk,
          documentId: ids.ownerSemanticDocument,
          extractionRevision: 1,
          ownerUserId: ids.owner,
          spaceId: ids.ownerPrivateSpace,
          content: 'Fresh produce and household staples',
          embedding: queryEmbedding,
        }),
        insertCommittedChunk(admin, {
          id: ids.ownerFilteredChunk,
          documentId: ids.ownerFilteredDocument,
          extractionRevision: 1,
          ownerUserId: ids.owner,
          spaceId: ids.ownerPrivateSpace,
          content: 'Fresh produce and household staples',
          embedding: queryEmbedding,
        }),
        insertCommittedChunk(admin, {
          id: ids.ownerStaleChunk,
          documentId: ids.ownerStaleDocument,
          extractionRevision: 1,
          ownerUserId: ids.owner,
          spaceId: ids.ownerPrivateSpace,
          content: 'Fresh produce and household staples',
          embedding: queryEmbedding,
        }),
        insertCommittedChunk(admin, {
          id: ids.collaboratorSemanticChunk,
          documentId: ids.collaboratorSemanticDocument,
          extractionRevision: 1,
          ownerUserId: ids.collaborator,
          spaceId: ids.collaboratorPrivateSpace,
          content: 'Fresh produce and household staples',
          embedding: queryEmbedding,
        }),
      ]);

      const repository = new PostgresFinanceDocumentRepository(
        databasePool(app),
      );
      const ownerResult = await repository.search({
        principal: {
          userId: ids.owner,
          sessionId: ids.ownerSession,
          householdId: ids.household,
          privateSpaceId: ids.ownerPrivateSpace,
          emailVerified: true,
          spaceAccessGrantId: ids.ownerSpaceAccessGrant,
          scopeFingerprint: sha256('f'),
        },
        requestId: ids.ownerRequest,
        query: 'vegetables',
        documentTypes: ['receipt'],
        currency: 'CAD',
        vectorQuery: Array.from({ length: 1_536 }, () => 1),
        limit: 5,
      });
      expect(ownerResult.fullText).toEqual([
        expect.objectContaining({
          id: ids.ownerSemanticChunk,
          documentId: ids.ownerSemanticDocument,
          fullTextRank: null,
          vectorRank: 1,
        }),
      ]);

      const collaboratorResult = await repository.search({
        principal: {
          userId: ids.collaborator,
          sessionId: ids.collaboratorSession,
          householdId: ids.household,
          privateSpaceId: ids.collaboratorPrivateSpace,
          emailVerified: true,
          spaceAccessGrantId: ids.ownerSpaceAccessGrant,
          scopeFingerprint: sha256('f'),
        },
        requestId: ids.collaboratorRequest,
        query: 'vegetables',
        documentTypes: ['receipt'],
        currency: 'CAD',
        vectorQuery: Array.from({ length: 1_536 }, () => 1),
        limit: 5,
      });
      expect(collaboratorResult.fullText).toEqual([
        expect.objectContaining({
          id: ids.collaboratorSemanticChunk,
          documentId: ids.collaboratorSemanticDocument,
          fullTextRank: null,
          vectorRank: 1,
        }),
      ]);
    });

    it('fuses lexical and vector ranks before the requested result limit', async () => {
      const queryEmbedding = embeddingLiteral(1);
      await Promise.all([
        insertCommittedDocument(admin, {
          id: ids.ownerLexicalFusionDocument,
          ownerUserId: ids.owner,
          spaceId: ids.ownerPrivateSpace,
          storageObjectId: 'finance-document-owner-fusion-lexical-0001',
          displayName: 'Owner lexical fusion invoice.pdf',
          plaintextHash: sha256('e'),
          ciphertextHash: sha256('f'),
          documentType: 'invoice',
          currency: 'CAD',
          extractionRevision: 1,
        }),
        insertCommittedDocument(admin, {
          id: ids.ownerVectorFusionDocument,
          ownerUserId: ids.owner,
          spaceId: ids.ownerPrivateSpace,
          storageObjectId: 'finance-document-owner-fusion-vector-0001',
          displayName: 'Owner vector fusion invoice.pdf',
          plaintextHash: sha256('1'),
          ciphertextHash: sha256('2'),
          documentType: 'invoice',
          currency: 'CAD',
          extractionRevision: 1,
        }),
        insertCommittedDocument(admin, {
          id: ids.ownerDualFusionDocument,
          ownerUserId: ids.owner,
          spaceId: ids.ownerPrivateSpace,
          storageObjectId: 'finance-document-owner-fusion-dual-0001',
          displayName: 'Owner dual fusion invoice.pdf',
          plaintextHash: sha256('3'),
          ciphertextHash: sha256('4'),
          documentType: 'invoice',
          currency: 'CAD',
          extractionRevision: 1,
        }),
      ]);
      await Promise.all([
        insertCommittedChunk(admin, {
          id: ids.ownerLexicalFusionChunk,
          documentId: ids.ownerLexicalFusionDocument,
          extractionRevision: 1,
          ownerUserId: ids.owner,
          spaceId: ids.ownerPrivateSpace,
          content: 'rankfusion',
          embedding: null,
        }),
        insertCommittedChunk(admin, {
          id: ids.ownerVectorFusionChunk,
          documentId: ids.ownerVectorFusionDocument,
          extractionRevision: 1,
          ownerUserId: ids.owner,
          spaceId: ids.ownerPrivateSpace,
          content: 'semantic retrieval companion',
          embedding: queryEmbedding,
        }),
        insertCommittedChunk(admin, {
          id: ids.ownerDualFusionChunk,
          documentId: ids.ownerDualFusionDocument,
          extractionRevision: 1,
          ownerUserId: ids.owner,
          spaceId: ids.ownerPrivateSpace,
          content: 'rankfusion',
          embedding: alternatingEmbeddingLiteral(),
        }),
      ]);

      const repository = new PostgresFinanceDocumentRepository(
        databasePool(app),
      );
      const result = await repository.search({
        principal: {
          userId: ids.owner,
          sessionId: ids.ownerSession,
          householdId: ids.household,
          privateSpaceId: ids.ownerPrivateSpace,
          emailVerified: true,
          spaceAccessGrantId: ids.ownerSpaceAccessGrant,
          scopeFingerprint: sha256('f'),
        },
        requestId: ids.ownerRequest,
        query: 'rankfusion',
        documentTypes: ['invoice'],
        currency: 'CAD',
        vectorQuery: Array.from({ length: 1_536 }, () => 1),
        limit: 2,
      });

      expect(
        result.fullText.map(({ id, fullTextRank, vectorRank }) => ({
          id,
          fullTextRank,
          vectorRank,
        })),
      ).toEqual([
        {
          id: ids.ownerDualFusionChunk,
          fullTextRank: 2,
          vectorRank: 2,
        },
        {
          id: ids.ownerLexicalFusionChunk,
          fullTextRank: 1,
          vectorRank: null,
        },
      ]);
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
                  deletion_proposal_id = $2::uuid,
                  deletion_decision_id = $3::uuid,
                  deletion_target_binding_hash = $4,
                  deletion_execution_binding_hash = $5,
                  updated_at = pg_catalog.clock_timestamp()
            where id = $1
          returning state`,
          [
            ids.collaboratorDocument,
            guardedDeletionReceipt.proposalId,
            guardedDeletionReceipt.decisionId,
            guardedDeletionReceipt.targetBindingHash,
            guardedDeletionReceipt.executionBindingHash,
          ],
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

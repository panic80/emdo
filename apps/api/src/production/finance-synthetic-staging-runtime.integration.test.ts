import { createHash, createHmac, randomUUID } from 'node:crypto';

import {
  CanonicalRecordEnvelopeDisclosureFilter,
  PostgresFinanceDocumentRepository,
  PostgresManagerTurnStore,
  PostgresModelDisclosureGateway,
  PostgresProposalQueryRepository,
  PostgresVisualDecisionProofStore,
  ProposalQueryCursorCodec,
  VisualDecisionProofTokenCodec,
  checkPostgresProposalWorkflowReadiness,
} from '@emdo/db/api';
import { loadOrderedMigrations } from '@emdo/db/migrations';
import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { FinanceDocumentEnvelopeV1Schema } from '@emdo/domains/finance';
import { hashCanonicalJson } from '@emdo/toolbox';
import { Client, Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createProductionAgentPersistence } from '../agents/production-persistence.js';
import type { ProductionAgentRuntimeFactory } from '../agents/production-runtime.js';
import { createProductionApprovalCheckpointCipher } from './approval-checkpoint-keyring.js';
import { createRequestScopedManagerFinanceAgentRuntimeFactory } from './core-agent-services.js';
import { createProductionFinanceDocumentGateway } from './finance-document-services.js';
import {
  createFinanceSyntheticStagingAgentServiceBundle,
  formatFinanceSyntheticStagingCommand,
} from './finance-synthetic-staging-agent.js';
import { createProductionFinanceSpecialistComposition } from './finance-specialist-production-composition.js';
import { createSyntheticFinanceDocumentEmbeddings } from './synthetic-finance-document-embeddings.js';
import { PostgresVisualProposalDecisionGateway } from './visual-approval-services.js';

const databaseUrl = process.env.TEST_FINANCE_DOCUMENT_DATABASE_URL;
const databaseAttestation =
  process.env.EMDO_POSTGRES_INTEGRATION_DATABASE_ATTESTATION;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

const API_LOGIN = 'emdo_api_login';
const WORKFLOW_LOGIN = 'emdo_workflow_login';
const VISUAL_DECISION_LOGIN = 'emdo_visual_decision_login';
const apiPassword = `finance-runtime-api-${randomUUID()}`;
const workflowPassword = `finance-runtime-workflow-${randomUUID()}`;
const visualDecisionPassword = `finance-runtime-visual-${randomUUID()}`;
const financeDocumentDatabaseNamePattern =
  /^emdo_ci_finance_document_knowledge_[0-9a-f]{12}$/u;
const financeDocumentDatabaseAttestationPattern =
  /^emdo-postgres-suite-v1:finance-document-knowledge:[0-9a-f]{32}$/u;

const assertDisposableFinanceDocumentDatabase = async (
  admin: Client,
): Promise<void> => {
  if (
    databaseUrl === undefined ||
    databaseAttestation === undefined ||
    !financeDocumentDatabaseAttestationPattern.test(databaseAttestation)
  ) {
    throw new Error(
      'Finance synthetic runtime requires the orchestrator database attestation.',
    );
  }
  const expectedDatabaseName = new URL(databaseUrl).pathname.slice(1);
  if (!financeDocumentDatabaseNamePattern.test(expectedDatabaseName)) {
    throw new Error(
      'Finance synthetic runtime requires an orchestrator-created disposable database.',
    );
  }
  const result = await admin.query<{
    attestation: string | null;
    databaseName: string;
  }>(`select database.datname as "databaseName",
             pg_catalog.shobj_description(database.oid, 'pg_database') as attestation
        from pg_catalog.pg_database as database
       where database.datname = pg_catalog.current_database()`);
  const attestedDatabase = result.rows[0];
  if (
    result.rows.length !== 1 ||
    attestedDatabase?.databaseName !== expectedDatabaseName ||
    attestedDatabase.attestation !== databaseAttestation
  ) {
    throw new Error(
      'Finance synthetic runtime database attestation was not verified.',
    );
  }
};

const ids = Object.freeze({
  user: 'f3100000-0000-4000-8000-000000000001',
  session: 'f3100000-0000-4000-8000-000000000002',
  household: 'f3100000-0000-4000-8000-000000000003',
  privateSpace: 'f3100000-0000-4000-8000-000000000004',
  membership: 'f3100000-0000-4000-8000-000000000005',
  grant: 'f3100000-0000-4000-8000-000000000006',
  request: 'f3100000-0000-4000-8000-000000000007',
  document: 'f3100000-0000-4000-8000-000000000008',
  extraction: 'f3100000-0000-4000-8000-000000000009',
  review: 'f3100000-0000-4000-8000-000000000010',
  proposalReadGrant: 'f3100000-0000-4000-8000-000000000011',
  proposalReadRequest: 'f3100000-0000-4000-8000-000000000012',
  visualProofGrant: 'f3100000-0000-4000-8000-000000000013',
  visualProofRequest: 'f3100000-0000-4000-8000-000000000014',
  visualDecisionGrant: 'f3100000-0000-4000-8000-000000000015',
  visualDecisionRequest: 'f3100000-0000-4000-8000-000000000016',
  questionGrant: 'f3100000-0000-4000-8000-000000000017',
  questionRequest: 'f3100000-0000-4000-8000-000000000018',
});

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');
const collectionScopeFingerprint =
  EffectiveAuthorizationScopeFingerprintSchema.parse(
    hashCanonicalJson({
      domain: 'emdo.authorization-scope.v1',
      householdId: ids.household,
      userId: ids.user,
      sessionId: ids.session,
      membershipId: ids.membership,
      membershipAdministrationVersion: 1,
      role: 'owner',
      privateSpaceId: ids.privateSpace,
      proposalSpaceId: null,
      writableSpaceIds: [ids.privateSpace],
    }),
  );
const reviewTokenHash = (payloadHash: string): string => {
  const token = createHmac('sha256', Buffer.alloc(32, 62))
    .update('emdo.finance-document.review-token.v2\0', 'utf8')
    .update(
      JSON.stringify({
        documentId: ids.document,
        extractionRevision: 1,
        householdId: ids.household,
        ownerUserId: ids.user,
        payloadHash,
        privateSpaceId: ids.privateSpace,
        scopeFingerprint: collectionScopeFingerprint,
        sessionId: ids.session,
      }),
      'utf8',
    )
    .digest('base64url');
  return sha256(token);
};

const reviewedEnvelope = FinanceDocumentEnvelopeV1Schema.parse({
  schemaVersion: 1,
  sourceLocale: 'en-CA',
  currency: 'CAD',
  issuer: 'Boreal Quasar Ledger',
  recipient: null,
  issuedOn: '2026-08-26',
  dueOn: null,
  periodStart: null,
  periodEnd: null,
  subtotal: null,
  tax: null,
  total: { currency: 'CAD', minorUnits: 123 },
  accountLast4: null,
  facts: [
    {
      field: 'issuer',
      confidence: 1,
      evidence: [
        {
          page: 1,
          excerpt: 'Boreal Quasar Ledger',
          characterStart: 37,
          characterEnd: 56,
        },
      ],
    },
  ],
  documentType: 'receipt',
  merchant: 'Boreal Quasar Ledger',
  purchasedOn: '2026-08-26',
  tip: null,
  paymentMethodLast4: null,
  lineItems: [],
  proposedRecord: null,
});
const encodedReviewedEnvelope = Buffer.from(
  JSON.stringify(reviewedEnvelope),
  'utf8',
).toString('base64url');

const reviewedFacts = Object.freeze({
  documentType: 'receipt' as const,
  sourceLocale: 'en-CA' as const,
  currency: 'CAD',
  chunks: Object.freeze([
    Object.freeze({
      ordinal: 0,
      pageStart: 1,
      pageEnd: 1,
      content: `emdo.finance-document.review-envelope.v1:1/1:${encodedReviewedEnvelope}`,
      embedding: null,
    }),
    Object.freeze({
      ordinal: 1,
      pageStart: 1,
      pageEnd: 1,
      content: 'Reviewed synthetic receipt total for Boreal Quasar Ledger',
      embedding: null,
    }),
  ]),
  evidence: Object.freeze([
    Object.freeze({
      chunkOrdinal: 1,
      page: 1,
      excerpt: 'Boreal Quasar Ledger',
      locator: Object.freeze({ characterStart: 37, characterEnd: 56 }),
      sourceLocale: 'en-CA' as const,
    }),
  ]),
  matchSuggestions: Object.freeze([]),
});

const environment = Object.freeze({
  EMDO_ENVIRONMENT: 'staging',
  EMDO_ALLOW_LOOPBACK_API_INGRESS: 'true',
  EMDO_SYNTHETIC_DATA_ONLY: 'true',
  EMDO_FINANCE_SYNTHETIC_STAGING: 'true',
  EMDO_FINANCE_DOCUMENTS_ENABLED: 'true',
});

const checkpointKeyring = Buffer.from(
  JSON.stringify({
    schemaVersion: 1,
    current: {
      keyId: 'finance-runtime-checkpoint',
      keyB64url: Buffer.alloc(32, 61).toString('base64url'),
    },
    previous: [],
  }),
  'utf8',
).toString('base64url');

const databasePool = (pool: Pool) =>
  pool as unknown as ConstructorParameters<typeof PostgresManagerTurnStore>[0];

const loginConnectionString = (role: string, password: string): string => {
  const url = new URL(databaseUrl!);
  url.username = role;
  url.password = password;
  return url.toString();
};

const passwordLiteral = (value: string | null): string =>
  value === null ? 'null' : `'${value.replaceAll("'", "''")}'`;

const collect = async <Value>(
  input: AsyncIterable<Value>,
): Promise<Value[]> => {
  const values: Value[] = [];
  for await (const value of input) values.push(value);
  return values;
};

const unavailable = async (): Promise<never> => {
  throw new Error('finance-synthetic-runtime-test-unreachable');
};

const withRequestScopedAppTransaction = async <Result>(
  pool: Pool,
  principal: Readonly<{
    userId: string;
    sessionId: string;
    requestId: string;
  }>,
  work: (client: PoolClient) => Promise<Result>,
): Promise<Result> => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local row_security = on');
    await client.query(
      `select set_config('emdo.user_id', $1, true),
              set_config('emdo.session_id', $2, true),
              set_config('emdo.request_id', $3, true)`,
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

describeDatabase(
  'Finance synthetic staging guarded review approval (requires disposable TEST_FINANCE_DOCUMENT_DATABASE_URL)',
  () => {
    let admin: Client;
    let appPool: Pool;
    let workflowPool: Pool;
    let visualDecisionPool: Pool;
    let createdApiLogin = false;
    let grantedApiMembership = false;
    let apiLoginPasswordBefore: string | null | undefined;
    let workflowLoginPasswordBefore: string | null | undefined;
    let visualDecisionLoginPasswordBefore: string | null | undefined;

    const restoreFixedLoginPasswords = async (): Promise<void> => {
      const restorations: Promise<unknown>[] = [];
      if (apiLoginPasswordBefore !== undefined) {
        restorations.push(
          admin.query(
            `alter role ${API_LOGIN} password ${passwordLiteral(apiLoginPasswordBefore)}`,
          ),
        );
      }
      if (workflowLoginPasswordBefore !== undefined) {
        restorations.push(
          admin.query(
            `alter role ${WORKFLOW_LOGIN} password ${passwordLiteral(workflowLoginPasswordBefore)}`,
          ),
        );
      }
      if (visualDecisionLoginPasswordBefore !== undefined) {
        restorations.push(
          admin.query(
            `alter role ${VISUAL_DECISION_LOGIN} password ${passwordLiteral(visualDecisionLoginPasswordBefore)}`,
          ),
        );
      }
      const results = await Promise.allSettled(restorations);
      if (results.some(({ status }) => status === 'rejected')) {
        throw new Error('finance-runtime-login-password-restore-failed');
      }
    };

    const principal = Object.freeze({
      userId: ids.user,
      sessionId: ids.session,
      householdId: ids.household,
      privateSpaceId: ids.privateSpace,
      role: 'owner' as const,
      emailVerified: true as const,
      spaceAccessGrantId: ids.grant,
      collectionAuthorizationScopeFingerprint: collectionScopeFingerprint,
    });

    const seedDocumentReview = async (): Promise<void> => {
      await admin.query(
        `insert into emdo.auth_users (id, name, email, email_verified)
         values ($1, 'Finance Runtime Owner', 'finance-runtime@example.test', true)`,
        [ids.user],
      );
      await admin.query(
        `insert into emdo.households (id, name, slug, created_by_user_id)
         values ($1, 'Finance Runtime Household', 'finance-runtime-household', $2)`,
        [ids.household, ids.user],
      );
      await admin.query(
        `insert into emdo.household_memberships
           (id, household_id, user_id, role, status, joined_at)
         values ($1, $2, $3, 'owner', 'active', pg_catalog.clock_timestamp())`,
        [ids.membership, ids.household, ids.user],
      );
      await admin.query(
        `insert into emdo.spaces
           (id, household_id, original_owner_user_id, name, visibility)
         values ($1, $2, $3, 'Private Finance', 'private')`,
        [ids.privateSpace, ids.household, ids.user],
      );
      await admin.query(
        `insert into emdo.auth_sessions
           (id, user_id, token, expires_at, active_household_id)
         values ($1, $2, 'finance-runtime-session',
                 pg_catalog.clock_timestamp() + interval '1 hour', $3)`,
        [ids.session, ids.user, ids.household],
      );
      await admin.query(
        `insert into emdo.space_access_grants
           (grant_id, household_id, original_owner_user_id, session_id,
            request_id, membership_id, role, private_space_id,
            writable_space_ids, issued_at, expires_at, retain_until)
         values ($1, $2, $3, $4, $5, $6, 'owner', $7, array[$7::uuid],
                 pg_catalog.clock_timestamp() - interval '1 second',
                 pg_catalog.clock_timestamp() + interval '10 minutes',
                 pg_catalog.clock_timestamp() + interval '89 days')`,
        [
          ids.grant,
          ids.household,
          ids.user,
          ids.session,
          ids.request,
          ids.membership,
          ids.privateSpace,
        ],
      );
      await admin.query(
        `insert into emdo.finance_documents (
           id, household_id, space_id, original_owner_user_id, storage_object_id,
           display_name, mime_type, byte_size, page_count, plaintext_sha256,
           ciphertext_sha256, wrapped_data_key, key_version
         ) values (
           $1, $2, $3, $4, 'finance-runtime-review.pdf',
           'Finance runtime review.pdf', 'application/pdf', 1024, 1, $5, $6,
           '{"algorithm":"aes-256-gcm","wrappedKey":"dGVzdA","nonce":"dGVzdA","authenticationTag":"dGVzdA","aadVersion":1}'::jsonb,
           'finance-runtime-test-key-v1'
         )`,
        [
          ids.document,
          ids.household,
          ids.privateSpace,
          ids.user,
          sha256('finance-runtime-original'),
          sha256('finance-runtime-ciphertext'),
        ],
      );
      await admin.query(
        `update emdo.finance_documents
            set state = 'extracting', extraction_revision = 1,
                updated_at = pg_catalog.clock_timestamp()
          where id = $1`,
        [ids.document],
      );
      await admin.query(
        `insert into emdo.finance_document_extractions (
           id, document_id, household_id, space_id, original_owner_user_id,
           revision, attempt, state
         ) values ($1, $2, $3, $4, $5, 1, 1, 'queued')`,
        [
          ids.extraction,
          ids.document,
          ids.household,
          ids.privateSpace,
          ids.user,
        ],
      );
      await admin.query(
        `update emdo.finance_document_extractions
            set state = 'extracting'
          where id = $1`,
        [ids.extraction],
      );
      await admin.query(
        `update emdo.finance_documents
            set state = 'awaiting-review',
                updated_at = pg_catalog.clock_timestamp(),
                document_type = 'receipt', source_locale = 'en-CA',
                currency = 'CAD'
          where id = $1`,
        [ids.document],
      );
      await admin.query(
        `update emdo.finance_document_extractions
            set state = 'awaiting-review', completed_at = pg_catalog.clock_timestamp()
          where id = $1`,
        [ids.extraction],
      );
      await admin.query(
        `insert into emdo.finance_document_review_batches (
           id, document_id, extraction_revision, household_id, space_id,
           original_owner_user_id, authenticated_session_id,
           space_access_grant_id, scope_fingerprint, payload_hash,
           review_token_hash, selected_facts, idempotency_key, expires_at
         ) values ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10,
                   $11::jsonb, 'finance-runtime-review-v1',
                   pg_catalog.clock_timestamp() + interval '15 minutes')`,
        [
          ids.review,
          ids.document,
          ids.household,
          ids.privateSpace,
          ids.user,
          ids.session,
          ids.grant,
          collectionScopeFingerprint,
          hashCanonicalJson(reviewedFacts),
          reviewTokenHash(hashCanonicalJson(reviewedFacts)),
          JSON.stringify(reviewedFacts),
        ],
      );
    };

    beforeAll(async () => {
      admin = new Client({ connectionString: databaseUrl });
      await admin.connect();
      await assertDisposableFinanceDocumentDatabase(admin);
      const preflight = await admin.query<{
        emdoSchema: string | null;
        serverVersion: string;
        vectorAvailable: boolean;
      }>(`select pg_catalog.to_regnamespace('emdo')::text as "emdoSchema",
                pg_catalog.current_setting('server_version_num') as "serverVersion",
                exists (
                  select 1 from pg_catalog.pg_available_extensions
                   where name = 'vector'
                ) as "vectorAvailable"`);
      expect(preflight.rows).toEqual([
        expect.objectContaining({ vectorAvailable: true }),
      ]);
      expect(Number(preflight.rows[0]?.serverVersion)).toBeGreaterThanOrEqual(
        180_000,
      );
      expect(Number(preflight.rows[0]?.serverVersion)).toBeLessThan(190_000);

      if (preflight.rows[0]?.emdoSchema === null) {
        for (const migration of await loadOrderedMigrations()) {
          await admin.query(migration.sql);
        }
      } else {
        expect(preflight.rows[0]?.emdoSchema).toBe('emdo');
        const companion = await admin.query<{
          companionSeeded: boolean;
          disclosureReady: boolean;
          runtimeFixtureAvailable: boolean;
        }>(
          `select exists (
                    select 1
                      from emdo.finance_documents
                     where id = $1
                       and original_owner_user_id = $2
                  ) as "companionSeeded",
                  pg_catalog.to_regprocedure(
                    'emdo.issue_model_disclosure_grant(uuid,uuid,uuid,uuid,uuid,text,text,text,text,jsonb)'
                  ) is not null
                  and pg_catalog.to_regprocedure(
                    'emdo.resolve_model_disclosure_grant(uuid,uuid,uuid,uuid,uuid,text,text,text,jsonb)'
                  ) is not null as "disclosureReady",
                  not exists (
                    select 1 from emdo.auth_users where id = $3
                  ) as "runtimeFixtureAvailable"`,
          [
            'f2000000-0000-4000-8000-000000000008',
            'f2000000-0000-4000-8000-000000000002',
            ids.user,
          ],
        );
        expect(companion.rows).toEqual([
          {
            companionSeeded: true,
            disclosureReady: true,
            runtimeFixtureAvailable: true,
          },
        ]);
      }

      try {
        const loginPasswords = await admin.query<{
          password: string | null;
          roleName: string;
        }>(
          `select role.rolname as "roleName", role.rolpassword as password
             from pg_catalog.pg_authid as role
            where role.rolname = any($1::text[])`,
          [[API_LOGIN, WORKFLOW_LOGIN, VISUAL_DECISION_LOGIN]],
        );
        const passwordByRole = new Map(
          loginPasswords.rows.map(({ password, roleName }) => [
            roleName,
            password,
          ]),
        );
        apiLoginPasswordBefore = passwordByRole.get(API_LOGIN);
        workflowLoginPasswordBefore = passwordByRole.get(WORKFLOW_LOGIN);
        visualDecisionLoginPasswordBefore = passwordByRole.get(
          VISUAL_DECISION_LOGIN,
        );
        if (apiLoginPasswordBefore === undefined) {
          await admin.query(`create role ${API_LOGIN} login inherit nosuperuser
            nocreatedb nocreaterole nobypassrls noreplication`);
          createdApiLogin = true;
          apiLoginPasswordBefore = null;
        }
        if (workflowLoginPasswordBefore === undefined) {
          throw new Error('Finance workflow login role is unavailable.');
        }
        if (visualDecisionLoginPasswordBefore === undefined) {
          throw new Error('Finance visual-decision login role is unavailable.');
        }
        const apiMembership = await admin.query<{ member: boolean }>(
          `select pg_catalog.pg_has_role($1, 'emdo_app', 'member') as member`,
          [API_LOGIN],
        );
        if (apiMembership.rows[0]?.member !== true) {
          await admin.query(`grant emdo_app to ${API_LOGIN}`);
          grantedApiMembership = true;
        }
        await admin.query(`alter role ${API_LOGIN} password '${apiPassword}'`);
        await admin.query(
          `alter role ${WORKFLOW_LOGIN} password '${workflowPassword}'`,
        );
        await admin.query(
          `alter role ${VISUAL_DECISION_LOGIN} password '${visualDecisionPassword}'`,
        );

        appPool = new Pool({
          allowExitOnIdle: true,
          application_name: 'emdo-finance-synthetic-runtime-app',
          connectionString: loginConnectionString(API_LOGIN, apiPassword),
          max: 2,
        });
        workflowPool = new Pool({
          allowExitOnIdle: true,
          application_name: 'emdo-finance-synthetic-runtime-workflow',
          connectionString: loginConnectionString(
            WORKFLOW_LOGIN,
            workflowPassword,
          ),
          max: 2,
        });
        visualDecisionPool = new Pool({
          allowExitOnIdle: true,
          application_name: 'emdo-finance-synthetic-runtime-visual-decision',
          connectionString: loginConnectionString(
            VISUAL_DECISION_LOGIN,
            visualDecisionPassword,
          ),
          max: 2,
        });

        await seedDocumentReview();
      } catch (error) {
        await Promise.allSettled([
          appPool?.end(),
          workflowPool?.end(),
          visualDecisionPool?.end(),
        ]);
        await restoreFixedLoginPasswords();
        throw error;
      }
    }, 60_000);

    afterAll(async () => {
      await Promise.allSettled([
        appPool?.end(),
        workflowPool?.end(),
        visualDecisionPool?.end(),
      ]);
      if (admin !== undefined) {
        try {
          await restoreFixedLoginPasswords();
        } finally {
          if (grantedApiMembership) {
            await admin
              .query(`revoke emdo_app from ${API_LOGIN}`)
              .catch(() => undefined);
          }
          if (createdApiLogin) {
            await admin
              .query(`drop role if exists ${API_LOGIN}`)
              .catch(() => undefined);
          }
          await admin.end();
        }
      }
    });

    it('persists approval.required and resumes through a proof-bound visual decision', async () => {
      let observedRunTurnResult: unknown;
      let observedRunTurnError: string | undefined;
      let observedRunTurnFailureCode: string | undefined;
      let observedResumeTurnResult: unknown;
      let observedResumeTurnError: string | undefined;
      let observedGuardedActionResult: unknown;
      let observedGuardedActionError: string | undefined;
      const documents = new PostgresFinanceDocumentRepository(
        databasePool(appPool),
      );
      const syntheticEmbeddings = createSyntheticFinanceDocumentEmbeddings();
      await expect(
        documents.getCurrentReviewDraft({
          principal: {
            userId: ids.user,
            sessionId: ids.session,
            householdId: ids.household,
            privateSpaceId: ids.privateSpace,
            emailVerified: true,
            spaceAccessGrantId: ids.grant,
            scopeFingerprint: collectionScopeFingerprint,
          },
          requestId: ids.request,
          documentId: ids.document,
        }),
      ).resolves.toMatchObject({
        id: ids.review,
        documentId: ids.document,
        extractionRevision: 1,
        selectedFacts: reviewedFacts,
      });
      const documentGateway = createProductionFinanceDocumentGateway({
        financeRead: {
          list: unavailable,
          readSnapshot: unavailable,
        } as never,
        embeddings: syntheticEmbeddings.embeddings,
        reviewTokenHmacKey: Buffer.alloc(32, 62),
        payloadCrypto: { decrypt: unavailable } as never,
        pdfInspector: { inspect: unavailable } as never,
        repository: documents,
        storage: {
          checkReady: async () => true,
          purge: unavailable,
          read: unavailable,
          store: unavailable,
        } as never,
      });
      const finance = createProductionFinanceSpecialistComposition({
        pool: databasePool(appPool),
        imports: {
          checkReady: async () => true,
          commit: unavailable,
        },
        documentGateway: {
          checkReady: () => documentGateway.checkReady(),
          createGuardedActionPort: (principalInput) => {
            const guarded =
              documentGateway.createGuardedActionPort(principalInput);
            return Object.freeze({
              materializeTarget: guarded.materializeTarget.bind(guarded),
              executeApproved: async (
                input: Parameters<typeof guarded.executeApproved>[0],
              ) => {
                try {
                  const result = await guarded.executeApproved(input);
                  observedGuardedActionResult = result;
                  return result;
                } catch (error) {
                  observedGuardedActionError =
                    error instanceof Error ? error.message : 'non-error';
                  throw error;
                }
              },
            });
          },
        },
      });
      const syntheticOpenAi =
        createFinanceSyntheticStagingAgentServiceBundle(environment);
      if (syntheticOpenAi === undefined) {
        throw new Error('synthetic runner unavailable');
      }
      const observedSyntheticRunnerErrors: string[] = [];
      const observedSyntheticRunnerResults: Array<{
        readonly agentName: string;
        readonly isManagerSynthesis: boolean;
      }> = [];
      const openAi = Object.freeze({
        ...syntheticOpenAi,
        runner: Object.freeze({
          run: async (
            ...args: Parameters<typeof syntheticOpenAi.runner.run>
          ) => {
            try {
              const result = await syntheticOpenAi.runner.run(...args);
              observedSyntheticRunnerResults.push({
                agentName: args[0].name,
                isManagerSynthesis:
                  typeof args[0].instructions === 'string' &&
                  args[0].instructions.includes(
                    'Write the final EMDO synthesis in en-CA.',
                  ),
              });
              return result;
            } catch (error) {
              observedSyntheticRunnerErrors.push(
                error instanceof Error ? error.message : 'non-error',
              );
              throw error;
            }
          },
        }),
      });
      const checkpointCipher =
        createProductionApprovalCheckpointCipher(checkpointKeyring);
      try {
        const runtimeFactory: ProductionAgentRuntimeFactory = {
          create: async (input) => {
            const factory =
              createRequestScopedManagerFinanceAgentRuntimeFactory({
                principal: input.principal,
                requestId: input.requestId,
                runId: input.runId,
                conversationId: input.conversationId,
                authorizationScopeFingerprint:
                  input.authorizationScopeFingerprint,
                readPool: databasePool(appPool),
                workflowPool: databasePool(workflowPool),
                openAi,
                checkpointCipher,
                checkGlobalDependencies: () =>
                  checkPostgresProposalWorkflowReadiness(
                    databasePool(workflowPool),
                  ),
                finance: finance.createForPrincipal(input.principal),
              });
            if (factory === undefined) {
              throw new Error('finance runtime factory unavailable');
            }
            const orchestrator = factory.runtime.orchestrator;
            return {
              orchestrator: {
                runTurn: async (turnInput) => {
                  try {
                    const result = await orchestrator.runTurn(turnInput);
                    observedRunTurnResult = result;
                    if (result.status === 'failed') {
                      observedRunTurnFailureCode = result.safeError.code;
                    }
                    return result;
                  } catch (error) {
                    observedRunTurnError =
                      error instanceof Error ? error.message : 'non-error';
                    throw error;
                  }
                },
                resumeTurn: async (resumeInput) => {
                  try {
                    const result = await orchestrator.resumeTurn(resumeInput);
                    observedResumeTurnResult = result;
                    return result;
                  } catch (error) {
                    observedResumeTurnError =
                      error instanceof Error ? error.message : 'non-error';
                    throw error;
                  }
                },
              },
            };
          },
          check: async () =>
            (await checkPostgresProposalWorkflowReadiness(
              databasePool(workflowPool),
            )) && (await finance.checkReady()),
        };
        const visualDecisions = new PostgresVisualProposalDecisionGateway({
          readPool: databasePool(appPool),
          decisionPool: databasePool(visualDecisionPool),
        });
        const services = createProductionAgentPersistence({
          pool: databasePool(appPool),
          runtimeFactory,
          visualDecisions,
        });

        await expect(services.bindings.managerTurns.check()).resolves.toBe(
          true,
        );
        await expect(services.bindings.runEvents.check()).resolves.toBe(true);
        const accepted = await services.bindings.managerTurns.service.start({
          request: {
            schemaVersion: 1,
            locale: 'en-CA',
            routeHint: 'finance',
            message: formatFinanceSyntheticStagingCommand({
              schemaVersion: 1,
              action: 'commit-document-review',
              documentId: ids.document,
            }),
          },
          principal,
          requestId: ids.request,
          idempotencyKey: 'finance-synthetic-runtime-approval-v1',
        });
        expect(accepted).toMatchObject({ status: 'accepted', replayed: false });
        expect(observedRunTurnError).toBeUndefined();
        expect(observedRunTurnFailureCode).toBeUndefined();
        expect(observedRunTurnResult).toMatchObject({
          status: 'needs-approval',
        });

        const events = await collect(
          await services.bindings.runEvents.service.open({
            runId: accepted.runId,
            afterSequence: 0,
            principal,
            requestId: ids.request,
            abortSignal: new AbortController().signal,
          }),
        );
        expect(
          events.map(({ sequence, type }) => ({ sequence, type })),
        ).toEqual([
          { sequence: 1, type: 'run.accepted' },
          { sequence: 2, type: 'approval.required' },
        ]);
        expect(events.at(-1)).toMatchObject({
          data: {
            status: 'needs-approval',
            runId: accepted.runId,
            interruptions: [
              expect.objectContaining({
                agentId: 'finance',
                capabilityId: 'finance.records.write',
              }),
            ],
          },
        });

        const proposal = await admin.query<{
          proposalId: string;
          capabilityId: string;
          state: string;
          providerSdkCallId: string;
          operation: string;
          preparationAgentId: string;
          preparationRunId: string;
          disclosureAgentId: string;
          disclosurePurpose: string;
        }>(
          `select proposal.id::text as "proposalId",
                  proposal.capability_id as "capabilityId",
                  state.state,
                  proposal.provider_sdk_call_id as "providerSdkCallId",
                  proposal.guarded_action ->> 'operation' as operation,
                  preparation.preparation_binding ->> 'agentId'
                    as "preparationAgentId",
                  preparation.preparation_binding ->> 'runId'
                    as "preparationRunId",
                  disclosure.agent_id as "disclosureAgentId",
                  disclosure.purpose as "disclosurePurpose"
             from emdo.action_proposals as proposal
             join emdo.proposal_states as state
               on state.proposal_id = proposal.id
             join emdo.proposal_preparations as preparation
               on preparation.proposal_id = proposal.id
             join emdo.disclosure_grants as disclosure
               on disclosure.id = proposal.disclosure_grant_id
            where proposal.run_id = $1`,
          [accepted.runId],
        );
        expect(proposal.rows).toEqual([
          {
            proposalId: expect.any(String),
            capabilityId: 'finance.records.write',
            state: 'pending',
            providerSdkCallId: 'finance-synthetic-staging-v1',
            operation: 'finance-document-review-commit',
            preparationAgentId: 'finance',
            preparationRunId: accepted.runId,
            disclosureAgentId: 'finance',
            disclosurePurpose: 'Run one finance delegation.',
          },
        ]);

        const persistedProposal = proposal.rows[0];
        if (persistedProposal === undefined) {
          throw new Error('Finance pending proposal was not persisted.');
        }
        await admin.query(
          `insert into emdo.space_access_grants
             (grant_id, household_id, original_owner_user_id, session_id,
              request_id, membership_id, role, private_space_id,
              writable_space_ids, issued_at, expires_at, retain_until)
           values ($1, $2, $3, $4, $5, $6, 'owner', $7, array[$7::uuid],
                   pg_catalog.clock_timestamp() - interval '1 second',
                   pg_catalog.clock_timestamp() + interval '10 minutes',
                   pg_catalog.clock_timestamp() + interval '89 days')`,
          [
            ids.proposalReadGrant,
            ids.household,
            ids.user,
            ids.session,
            ids.proposalReadRequest,
            ids.membership,
            ids.privateSpace,
          ],
        );
        const proposalReadPrincipal = Object.freeze({
          ...principal,
          spaceAccessGrantId: ids.proposalReadGrant,
        });
        const proposalQueries = new PostgresProposalQueryRepository(
          databasePool(appPool),
          new ProposalQueryCursorCodec({
            current: {
              keyId: 'finance-runtime-proposal-read-v1',
              secret: new Uint8Array(32).fill(63),
            },
            previous: [],
          }),
        );
        const proposalDetail = await proposalQueries.getDetail({
          proposalId: persistedProposal.proposalId,
          principal: proposalReadPrincipal,
          requestId: ids.proposalReadRequest,
        });
        if (proposalDetail === undefined) {
          throw new Error('Finance pending proposal was not readable.');
        }
        expect(proposalDetail).toMatchObject({
          schemaVersion: 1,
          id: persistedProposal.proposalId,
          state: 'pending',
          kind: 'finance.records.write',
          title: 'Review Finance action',
          summary:
            'EMDO needs your approval before applying this Finance action.',
          beforePreview: { summary: 'No Finance change has been applied.' },
          afterPreview: {
            summary: 'EMDO will apply the approved Finance action.',
          },
          fields: [
            {
              label: 'Action',
              value: 'finance-document-review-commit',
            },
            { label: 'Capability', value: 'finance.records.write' },
            { label: 'Document', value: ids.document },
            { label: 'Review revision', value: '1' },
          ],
          payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          approvalHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        });
        expect(Object.keys(proposalDetail ?? {}).sort()).toEqual([
          'afterPreview',
          'approvalHash',
          'beforePreview',
          'createdAt',
          'expiresAt',
          'fields',
          'id',
          'kind',
          'payloadHash',
          'schemaVersion',
          'state',
          'summary',
          'title',
          'version',
        ]);
        await expect(
          proposalQueries.getDetail({
            proposalId: persistedProposal.proposalId,
            principal,
            requestId: ids.proposalReadRequest,
          }),
        ).resolves.toBeUndefined();

        const checkpoint = await admin.query<{
          revision: number;
          sealedState: string;
          state: string;
        }>(
          `select revision::integer as revision, sealed_state as "sealedState", state
             from emdo.approval_checkpoints
            where run_id = $1`,
          [accepted.runId],
        );
        expect(checkpoint.rows).toEqual([
          expect.objectContaining({
            revision: 1,
            sealedState: expect.any(String),
            state: 'pending',
          }),
        ]);

        const resumeJob = await admin.query<{
          capabilityId: string;
          state: string;
        }>(
          `select capability_id as "capabilityId", state
             from emdo.approval_resume_jobs
            where run_id = $1`,
          [accepted.runId],
        );
        expect(resumeJob.rows).toEqual([
          { capabilityId: 'finance.records.write', state: 'awaiting-decision' },
        ]);
        const pausedRun = await admin.query<{ status: string }>(
          `select status from emdo.agent_runs where id = $1`,
          [accepted.runId],
        );
        expect(pausedRun.rows).toEqual([{ status: 'blocked' }]);

        for (const [grantId, requestId] of [
          [ids.visualProofGrant, ids.visualProofRequest],
          [ids.visualDecisionGrant, ids.visualDecisionRequest],
        ] as const) {
          await admin.query(
            `insert into emdo.space_access_grants
               (grant_id, household_id, original_owner_user_id, session_id,
                request_id, membership_id, role, private_space_id,
                writable_space_ids, issued_at, expires_at, retain_until)
             values ($1, $2, $3, $4, $5, $6, 'owner', $7, array[$7::uuid],
                     pg_catalog.clock_timestamp() - interval '1 second',
                     pg_catalog.clock_timestamp() + interval '10 minutes',
                     pg_catalog.clock_timestamp() + interval '89 days')`,
            [
              grantId,
              ids.household,
              ids.user,
              ids.session,
              requestId,
              ids.membership,
              ids.privateSpace,
            ],
          );
        }
        const visualProofs = new PostgresVisualDecisionProofStore(
          databasePool(appPool),
          new VisualDecisionProofTokenCodec({
            current: {
              keyId: 'finance-runtime-visual-proof-v1',
              secret: new Uint8Array(32).fill(64),
            },
            previous: [],
          }),
        );
        const visualProof = await visualProofs.issue({
          proposalId: proposalDetail.id,
          expectedProposalVersion: proposalDetail.version,
          expectedPayloadHash: proposalDetail.payloadHash,
          expectedApprovalHash: proposalDetail.approvalHash,
          principal: {
            ...principal,
            spaceAccessGrantId: ids.visualProofGrant,
          },
          requestId: ids.visualProofRequest,
          idempotencyKey: 'finance-runtime-visual-proof-v1',
        });
        expect(visualProof.status).toBe('issued');
        if (visualProof.status !== 'issued') {
          throw new Error('Finance visual proof was not issued.');
        }
        const decisionIdempotencyKey = 'finance-runtime-visual-decision-v1';
        const proposalDecisions = services.bindings.proposals;
        if (proposalDecisions === undefined) {
          throw new Error('Finance visual decision binding is unavailable.');
        }
        await expect(proposalDecisions.check()).resolves.toBe(true);
        const runnerCallsBeforeDecision = observedSyntheticRunnerResults.length;
        const runnerErrorsBeforeDecision = observedSyntheticRunnerErrors.length;
        const decisionOutcome =
          await proposalDecisions.service.decideWithVisualProof({
            request: {
              schemaVersion: 1,
              proposalId: proposalDetail.id,
              payloadHash: proposalDetail.payloadHash,
              approvalHash: proposalDetail.approvalHash,
              decision: 'approved',
              idempotencyKey: decisionIdempotencyKey,
            },
            visualProofToken: visualProof.proof.proofToken,
            principal: {
              ...principal,
              spaceAccessGrantId: ids.visualDecisionGrant,
            },
            requestId: ids.visualDecisionRequest,
          });
        expect(decisionOutcome).toMatchObject({
          status: 'decided',
          decision: {
            proposalId: proposalDetail.id,
            userId: ids.user,
            authenticatedSessionId: ids.session,
            payloadHash: proposalDetail.payloadHash,
            approvalHash: proposalDetail.approvalHash,
            decision: 'approved',
            channel: 'authenticated-visual',
            idempotencyKey: decisionIdempotencyKey,
          },
        });
        if (decisionOutcome.status !== 'decided') {
          throw new Error('Finance visual decision did not complete.');
        }
        expect(observedResumeTurnError).toBeUndefined();
        expect(observedGuardedActionError).toBeUndefined();
        expect(observedGuardedActionResult).toMatchObject({
          status: 'document-committed',
          documentId: ids.document,
          extractionRevision: 1,
        });
        expect(observedSyntheticRunnerErrors).toHaveLength(
          runnerErrorsBeforeDecision,
        );
        expect(
          observedSyntheticRunnerResults.slice(runnerCallsBeforeDecision),
        ).toEqual([{ agentName: 'manager', isManagerSynthesis: true }]);
        expect(observedResumeTurnResult).toMatchObject({ status: 'completed' });
        const committedState = await admin.query<{
          documentState: string;
          proofConsumed: boolean;
          proofVersion: number;
          proposalState: string;
          proposalVersion: number;
          resumeState: string;
          runStatus: string;
        }>(
          `select document.state as "documentState",
                  proof.consumed_at is not null as "proofConsumed",
                  proof.row_version::integer as "proofVersion",
                  proposal_state.state as "proposalState",
                  proposal_state.version::integer as "proposalVersion",
                  resume.state as "resumeState",
                  run.status as "runStatus"
             from emdo.finance_documents as document
             join emdo.action_proposals as proposal on proposal.id = $1
             join emdo.proposal_states as proposal_state
               on proposal_state.proposal_id = proposal.id
             join emdo.visual_decision_proofs as proof
               on proof.proposal_id = proposal.id
             join emdo.approval_resume_jobs as resume
               on resume.proposal_id = proposal.id
             join emdo.agent_runs as run on run.id = proposal.run_id
            where document.id = $2
              and proof.decision_id = $3`,
          [proposalDetail.id, ids.document, decisionOutcome.decision.id],
        );
        expect(committedState.rows).toEqual([
          {
            documentState: 'committed',
            proofConsumed: true,
            proofVersion: 2,
            proposalState: 'approved',
            proposalVersion: 2,
            resumeState: 'terminal',
            runStatus: 'completed',
          },
        ]);
        const synthesisAudit = await admin.query<{
          eventType: string;
        }>(
          `select audit.event_type as "eventType"
             from emdo.audit_events as audit
             join emdo.approval_resume_jobs as resume
               on resume.resume_request_id = audit.request_id
            where resume.proposal_id = $1
              and audit.run_id = resume.run_id
              and audit.event_type in (
                'model.disclosure.granted', 'model.disclosure.sent'
              )
              and audit.payload ->> 'agentId' = 'manager'
              and audit.payload ->> 'phasePurpose' = 'manager-synthesis'
            order by audit.occurred_at`,
          [proposalDetail.id],
        );
        expect(synthesisAudit.rows).toEqual([
          { eventType: 'model.disclosure.granted' },
          { eventType: 'model.disclosure.sent' },
        ]);

        const terminalDisclosureGrants = await admin.query<{
          agentId: 'finance' | 'manager';
          commitRecords: unknown;
          grantHash: string;
          grantId: string;
          phasePurpose:
            'manager-plan' | 'specialist-execution' | 'manager-synthesis';
          requestId: string;
          spaceAccessGrantId: string;
          version: number;
        }>(
          `select disclosure.id::text as "grantId",
                  disclosure.version::integer as version,
                  disclosure.grant_hash as "grantHash",
                  disclosure.agent_id as "agentId",
                  disclosure.phase_purpose as "phasePurpose",
                  disclosure.record_allowlist as "commitRecords",
                  granted.request_id::text as "requestId",
                  scope.grant_id::text as "spaceAccessGrantId"
             from emdo.disclosure_grants as disclosure
             join emdo.audit_events as granted
               on granted.run_id = disclosure.run_id
              and granted.event_type = 'model.disclosure.granted'
              and granted.payload ->> 'grantId' = disclosure.id::text
             join emdo.space_access_grants as scope
               on scope.household_id = disclosure.household_id
              and scope.original_owner_user_id = disclosure.user_id
              and scope.session_id = granted.session_id
              and scope.request_id = granted.request_id
              and disclosure.space_id = any(scope.writable_space_ids)
              and scope.expires_at > pg_catalog.clock_timestamp()
            where disclosure.run_id = $1
              and (
                (disclosure.agent_id = 'manager'
                  and disclosure.phase_purpose in (
                    'manager-plan', 'manager-synthesis'
                  ))
                or (disclosure.agent_id = 'finance'
                  and disclosure.phase_purpose = 'specialist-execution')
              )
            order by case disclosure.phase_purpose
              when 'manager-plan' then 1
              when 'specialist-execution' then 2
              when 'manager-synthesis' then 3
            end`,
          [accepted.runId],
        );
        expect(
          terminalDisclosureGrants.rows.map(({ agentId, phasePurpose }) => ({
            agentId,
            phasePurpose,
          })),
        ).toEqual([
          { agentId: 'manager', phasePurpose: 'manager-plan' },
          { agentId: 'finance', phasePurpose: 'specialist-execution' },
          { agentId: 'manager', phasePurpose: 'manager-synthesis' },
        ]);

        for (const disclosure of terminalDisclosureGrants.rows) {
          const gateway = new PostgresModelDisclosureGateway(
            databasePool(appPool),
            {
              userId: ids.user,
              sessionId: ids.session,
              requestId: disclosure.requestId,
              householdId: ids.household,
            },
            new CanonicalRecordEnvelopeDisclosureFilter(),
          );
          await expect(
            gateway.authorize({
              requestId: disclosure.requestId,
              runId: accepted.runId,
              householdId: ids.household,
              userId: ids.user,
              spaceAccessGrantId: disclosure.spaceAccessGrantId,
              agentId: disclosure.agentId,
              phasePurpose: disclosure.phasePurpose,
              provider: 'openai',
              requestedGrantId: disclosure.grantId,
              requestedDataClasses: [],
              payload: { schemaVersion: 1, records: [] },
            }),
          ).resolves.toMatchObject({
            status: 'denied',
            grantId: disclosure.grantId,
            reason: 'grant-run-mismatch',
          });
        }

        const inspectTerminalDisclosureState = () =>
          admin.query<{
            consumedAt: Date | null;
            grantId: string;
            sentAuditCount: number;
          }>(
            `select disclosure.id::text as "grantId",
                    disclosure.consumed_at as "consumedAt",
                    count(audit.id) filter (
                      where audit.event_type = 'model.disclosure.sent'
                        and audit.payload ->> 'grantId' = disclosure.id::text
                    )::integer as "sentAuditCount"
               from emdo.disclosure_grants as disclosure
               left join emdo.audit_events as audit
                 on audit.run_id = disclosure.run_id
              where disclosure.id = any($1::uuid[])
              group by disclosure.id, disclosure.consumed_at
              order by disclosure.id`,
            [terminalDisclosureGrants.rows.map(({ grantId }) => grantId)],
          );
        const terminalDisclosureStateBefore =
          await inspectTerminalDisclosureState();

        for (const disclosure of terminalDisclosureGrants.rows) {
          const commit = await withRequestScopedAppTransaction(
            appPool,
            {
              userId: ids.user,
              sessionId: ids.session,
              requestId: disclosure.requestId,
            },
            (client) =>
              client.query<{ committed: boolean }>(
                `select committed
                   from emdo.commit_model_disclosure_authorization(
                     $1::uuid, $2::integer, $3::text, $4::uuid, $5::text,
                     $6::jsonb
                   )`,
                [
                  disclosure.grantId,
                  disclosure.version,
                  disclosure.grantHash,
                  disclosure.spaceAccessGrantId,
                  disclosure.phasePurpose,
                  JSON.stringify(disclosure.commitRecords),
                ],
              ),
          );
          expect(commit.rows).not.toContainEqual(
            expect.objectContaining({ committed: true }),
          );
        }

        await expect(inspectTerminalDisclosureState()).resolves.toEqual(
          terminalDisclosureStateBefore,
        );

        const reviewedMarkerEvidence = await admin.query<{
          evidenceId: string;
        }>(
          `select evidence.id::text as "evidenceId"
             from emdo.finance_document_evidence as evidence
            where evidence.document_id = $1
              and evidence.extraction_revision = 1
              and evidence.excerpt = 'Boreal Quasar Ledger'`,
          [ids.document],
        );
        expect(reviewedMarkerEvidence.rows).toEqual([
          { evidenceId: expect.any(String) },
        ]);
        const reviewedMarkerEvidenceId =
          reviewedMarkerEvidence.rows[0]?.evidenceId;
        if (reviewedMarkerEvidenceId === undefined) {
          throw new Error(
            'Finance reviewed marker evidence was not committed.',
          );
        }

        await admin.query(
          `insert into emdo.space_access_grants
             (grant_id, household_id, original_owner_user_id, session_id,
              request_id, membership_id, role, private_space_id,
              writable_space_ids, issued_at, expires_at, retain_until)
           values ($1, $2, $3, $4, $5, $6, 'owner', $7, array[$7::uuid],
                   pg_catalog.clock_timestamp() - interval '1 second',
                   pg_catalog.clock_timestamp() + interval '10 minutes',
                   pg_catalog.clock_timestamp() + interval '89 days')`,
          [
            ids.questionGrant,
            ids.household,
            ids.user,
            ids.session,
            ids.questionRequest,
            ids.membership,
            ids.privateSpace,
          ],
        );
        const questionPrincipal = Object.freeze({
          ...principal,
          spaceAccessGrantId: ids.questionGrant,
        });
        const questionAccepted =
          await services.bindings.managerTurns.service.start({
            request: {
              schemaVersion: 1,
              locale: 'en-CA',
              routeHint: 'finance',
              message: formatFinanceSyntheticStagingCommand({
                schemaVersion: 1,
                action: 'search-document',
                query: 'Boreal Quasar Ledger',
              }),
            },
            principal: questionPrincipal,
            requestId: ids.questionRequest,
            idempotencyKey: 'finance-synthetic-runtime-question-v1',
          });
        expect(questionAccepted).toMatchObject({
          status: 'accepted',
          replayed: false,
        });

        const questionEvents = await collect(
          await services.bindings.runEvents.service.open({
            runId: questionAccepted.runId,
            afterSequence: 0,
            principal: questionPrincipal,
            requestId: ids.questionRequest,
            abortSignal: new AbortController().signal,
          }),
        );
        expect(observedRunTurnError).toBeUndefined();
        expect(observedSyntheticRunnerErrors).toEqual([]);
        expect(observedRunTurnFailureCode).toBeUndefined();
        expect(
          questionEvents.map(({ sequence, type }) => ({ sequence, type })),
        ).toEqual([
          { sequence: 1, type: 'run.accepted' },
          { sequence: 2, type: 'specialist.completed' },
          { sequence: 3, type: 'run.completed' },
        ]);
        expect(questionEvents.map(({ type }) => type)).not.toContain(
          'specialist.failed',
        );
        expect(questionEvents.map(({ type }) => type)).not.toContain(
          'run.failed',
        );
        expect(questionEvents.at(-1)).toMatchObject({
          data: {
            status: 'completed',
            runId: questionAccepted.runId,
            output: {
              evidenceReferences: expect.arrayContaining([
                reviewedMarkerEvidenceId,
              ]),
            },
          },
        });

        const questionPersistence = await admin.query<{
          grantId: string;
          grantRequestId: string;
          grantSessionId: string;
          ownerUserId: string;
          requestId: string;
          runStatus: string;
          state: string;
          userId: string;
        }>(
          `select turn.user_id::text as "userId",
                  run.original_owner_user_id::text as "ownerUserId",
                  run.status as "runStatus",
                  turn.state,
                  turn.origin_request_id::text as "requestId",
                  turn.origin_space_access_grant_id::text as "grantId",
                  access_grant.session_id::text as "grantSessionId",
                  access_grant.request_id::text as "grantRequestId"
             from emdo.manager_turns as turn
             join emdo.agent_runs as run on run.id = turn.run_id
             join emdo.space_access_grants as access_grant
               on access_grant.grant_id = turn.origin_space_access_grant_id
            where turn.run_id = $1`,
          [questionAccepted.runId],
        );
        expect(questionPersistence.rows).toEqual([
          {
            userId: ids.user,
            ownerUserId: ids.user,
            runStatus: 'completed',
            state: 'completed',
            requestId: ids.questionRequest,
            grantId: ids.questionGrant,
            grantSessionId: ids.session,
            grantRequestId: ids.questionRequest,
          },
        ]);
      } finally {
        documentGateway.dispose();
        checkpointCipher.dispose();
        await openAi.close();
      }
    }, 60_000);
  },
);

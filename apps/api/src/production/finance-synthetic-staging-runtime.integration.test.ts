import { createHash, randomUUID } from 'node:crypto';

import {
  PostgresFinanceDocumentRepository,
  PostgresManagerTurnStore,
  PostgresProposalQueryRepository,
  PostgresRunEventSource,
  ProposalQueryCursorCodec,
  checkPostgresProposalWorkflowReadiness,
} from '@emdo/db/api';
import { loadOrderedMigrations } from '@emdo/db/migrations';
import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { hashCanonicalJson } from '@emdo/toolbox';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createProductionAgentServiceBindingsFromDependencies,
  type ProductionAgentRuntimeFactory,
} from '../agents/production-runtime.js';
import { createProductionApprovalCheckpointCipher } from './approval-checkpoint-keyring.js';
import { createRequestScopedManagerFinanceAgentRuntimeFactory } from './core-agent-services.js';
import { createProductionFinanceDocumentGateway } from './finance-document-services.js';
import {
  createFinanceSyntheticStagingAgentServiceBundle,
  formatFinanceSyntheticStagingCommand,
} from './finance-synthetic-staging-agent.js';
import { createProductionFinanceSpecialistComposition } from './finance-specialist-production-composition.js';

const databaseUrl = process.env.TEST_FINANCE_DOCUMENT_DATABASE_URL;
const databaseAttestation =
  process.env.EMDO_POSTGRES_INTEGRATION_DATABASE_ATTESTATION;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

const API_LOGIN = 'emdo_api_login';
const WORKFLOW_LOGIN = 'emdo_workflow_login';
const apiPassword = `finance-runtime-api-${randomUUID()}`;
const workflowPassword = `finance-runtime-workflow-${randomUUID()}`;
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

const reviewedFacts = Object.freeze({
  documentType: 'receipt' as const,
  sourceLocale: 'en-CA' as const,
  currency: 'CAD',
  chunks: Object.freeze([
    Object.freeze({
      ordinal: 0,
      pageStart: 1,
      pageEnd: 1,
      content: 'Reviewed synthetic receipt total',
      embedding: null,
    }),
  ]),
  evidence: Object.freeze([]),
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

describeDatabase(
  'Finance synthetic staging guarded review initial turn (requires disposable TEST_FINANCE_DOCUMENT_DATABASE_URL)',
  () => {
    let admin: Client;
    let appPool: Pool;
    let workflowPool: Pool;
    let createdApiLogin = false;
    let grantedApiMembership = false;
    let apiLoginPasswordBefore: string | null | undefined;
    let workflowLoginPasswordBefore: string | null | undefined;

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
          sha256('finance-runtime-review-token'),
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
          [[API_LOGIN, WORKFLOW_LOGIN]],
        );
        const passwordByRole = new Map(
          loginPasswords.rows.map(({ password, roleName }) => [
            roleName,
            password,
          ]),
        );
        apiLoginPasswordBefore = passwordByRole.get(API_LOGIN);
        workflowLoginPasswordBefore = passwordByRole.get(WORKFLOW_LOGIN);
        if (apiLoginPasswordBefore === undefined) {
          await admin.query(`create role ${API_LOGIN} login inherit nosuperuser
            nocreatedb nocreaterole nobypassrls noreplication`);
          createdApiLogin = true;
          apiLoginPasswordBefore = null;
        }
        if (workflowLoginPasswordBefore === undefined) {
          throw new Error('Finance workflow login role is unavailable.');
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

        await seedDocumentReview();
      } catch (error) {
        await Promise.allSettled([appPool?.end(), workflowPool?.end()]);
        await restoreFixedLoginPasswords();
        throw error;
      }
    }, 60_000);

    afterAll(async () => {
      await Promise.allSettled([appPool?.end(), workflowPool?.end()]);
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

    it('persists approval.required from the real Finance synthetic runner without becoming indeterminate', async () => {
      let observedRunTurnResult: unknown;
      let observedRunTurnError: string | undefined;
      let observedRunTurnFailureCode: string | undefined;
      const documents = new PostgresFinanceDocumentRepository(
        databasePool(appPool),
      );
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
        embeddings: { embed: unavailable } as never,
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
        documentGateway,
      });
      const openAi =
        createFinanceSyntheticStagingAgentServiceBundle(environment);
      if (openAi === undefined) throw new Error('synthetic runner unavailable');
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
                resumeTurn: orchestrator.resumeTurn.bind(orchestrator),
              },
            };
          },
          check: async () =>
            (await checkPostgresProposalWorkflowReadiness(
              databasePool(workflowPool),
            )) && (await finance.checkReady()),
        };
        const services = createProductionAgentServiceBindingsFromDependencies({
          turns: new PostgresManagerTurnStore(databasePool(appPool)),
          runEvents: new PostgresRunEventSource(databasePool(appPool)),
          runtimeFactory,
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
      } finally {
        documentGateway.dispose();
        checkpointCipher.dispose();
        await openAi.close();
      }
    }, 60_000);
  },
);

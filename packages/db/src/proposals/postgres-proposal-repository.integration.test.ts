import { randomBytes, randomUUID } from 'node:crypto';

import {
  ActionProposalSchema,
  EffectiveAuthorizationScopeFingerprintSchema,
  ProviderWriteAuthorizationSchema,
  type ActionDecision,
  type ActionProposal,
  type EffectiveAuthorizationScopeFingerprint,
  type JsonValue,
} from '@emdo/contracts';
import {
  ProposalPreparationBindingSchema,
  hashActionProposalApproval,
  type ProposalActivityEvent,
  type ProposalOperationScopeAssertion,
  type StoredProviderWriteCompletion,
} from '@emdo/domains/server/provider-proposals';
import {
  hashCanonicalJson,
  hashProviderWriteApprovalBinding,
} from '@emdo/toolbox';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import { PostgresManagerTurnStore } from '../agent/manager-turn-store.js';
import { loadOrderedMigrations } from '../migrations.js';
import type { DatabasePool } from '../scoped-repository.js';
import { ProposalQueryCursorCodec } from './proposal-query-cursor-codec.js';
import { PostgresProposalQueryRepository } from './postgres-proposal-query-repository.js';
import {
  PostgresProposalRepository,
  checkPostgresProposalWorkflowReadiness,
  checkPostgresVisualDecisionReadiness,
  type ProposalRepositoryTransaction,
} from './postgres-proposal-repository.js';
import {
  PostgresVisualDecisionProofStore,
  hashVisualDecisionProofToken,
} from './postgres-visual-decision-proof-store.js';
import { VisualDecisionProofTokenCodec } from './visual-decision-proof-token-codec.js';

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe.sequential : describe.skip;

const API_LOGIN = 'emdo_api_login';
const APP_LOGIN = 'emdo_proposal_integration_app';
const WORKER_LOGIN = 'emdo_proposal_integration_worker';
const WORKFLOW_LOGIN = 'emdo_workflow_login';
const VISUAL_DECISION_LOGIN = 'emdo_visual_decision_login';
const appPassword = `P${randomBytes(24).toString('hex')}`;
const workerPassword = `P${randomBytes(24).toString('hex')}`;
const workflowPassword = `P${randomBytes(24).toString('hex')}`;

const ids = Object.freeze({
  a: Object.freeze({
    user: '96000000-0000-4000-8000-000000000001',
    session: '96000000-0000-4000-8000-000000000002',
    otherSession: '96000000-0000-4000-8000-000000000003',
    request: '96000000-0000-4000-8000-000000000004',
    rotatedRequest: '96000000-0000-4000-8000-000000000005',
    otherSessionRequest: '96000000-0000-4000-8000-000000000006',
    household: '96000000-0000-4000-8000-000000000007',
    space: '96000000-0000-4000-8000-000000000008',
    run: '96000000-0000-4000-8000-000000000009',
    grant: '96000000-0000-4000-8000-000000000010',
    rotatedGrant: '96000000-0000-4000-8000-000000000011',
    otherSessionGrant: '96000000-0000-4000-8000-000000000012',
    disclosure: '96000000-0000-4000-8000-000000000013',
    proposal: '96000000-0000-4000-8000-000000000014',
    attackProposal: '96000000-0000-4000-8000-000000000015',
    decision: '96000000-0000-4000-8000-000000000016',
    attackDecision: '96000000-0000-4000-8000-000000000017',
    attempt: '96000000-0000-4000-8000-000000000018',
    attackAttempt: '96000000-0000-4000-8000-000000000019',
    outbox: '96000000-0000-4000-8000-000000000020',
    execution: '96000000-0000-4000-8000-000000000021',
    queue: '96000000-0000-4000-8000-000000000022',
    lease: '96000000-0000-4000-8000-000000000023',
    membership: '96000000-0000-4000-8000-000000000024',
  }),
  b: Object.freeze({
    user: '97000000-0000-4000-8000-000000000001',
    session: '97000000-0000-4000-8000-000000000002',
    otherSession: '97000000-0000-4000-8000-000000000003',
    request: '97000000-0000-4000-8000-000000000004',
    rotatedRequest: '97000000-0000-4000-8000-000000000005',
    otherSessionRequest: '97000000-0000-4000-8000-000000000006',
    household: '97000000-0000-4000-8000-000000000007',
    space: '97000000-0000-4000-8000-000000000008',
    run: '97000000-0000-4000-8000-000000000009',
    grant: '97000000-0000-4000-8000-000000000010',
    rotatedGrant: '97000000-0000-4000-8000-000000000011',
    otherSessionGrant: '97000000-0000-4000-8000-000000000012',
    disclosure: '97000000-0000-4000-8000-000000000013',
    proposal: '97000000-0000-4000-8000-000000000014',
    attackProposal: '97000000-0000-4000-8000-000000000015',
    decision: '97000000-0000-4000-8000-000000000016',
    attackDecision: '97000000-0000-4000-8000-000000000017',
    attempt: '97000000-0000-4000-8000-000000000018',
    attackAttempt: '97000000-0000-4000-8000-000000000019',
    outbox: '97000000-0000-4000-8000-000000000020',
    execution: '97000000-0000-4000-8000-000000000021',
    queue: '97000000-0000-4000-8000-000000000022',
    lease: '97000000-0000-4000-8000-000000000023',
    membership: '97000000-0000-4000-8000-000000000024',
  }),
  c: Object.freeze({
    user: '98000000-0000-4000-8000-000000000001',
    session: '98000000-0000-4000-8000-000000000002',
    otherSession: '98000000-0000-4000-8000-000000000003',
    request: '98000000-0000-4000-8000-000000000004',
    rotatedRequest: '98000000-0000-4000-8000-000000000005',
    otherSessionRequest: '98000000-0000-4000-8000-000000000006',
    household: '98000000-0000-4000-8000-000000000007',
    space: '98000000-0000-4000-8000-000000000008',
    run: '98000000-0000-4000-8000-000000000009',
    grant: '98000000-0000-4000-8000-000000000010',
    rotatedGrant: '98000000-0000-4000-8000-000000000011',
    otherSessionGrant: '98000000-0000-4000-8000-000000000012',
    disclosure: '98000000-0000-4000-8000-000000000013',
    proposal: '98000000-0000-4000-8000-000000000014',
    attackProposal: '98000000-0000-4000-8000-000000000015',
    decision: '98000000-0000-4000-8000-000000000016',
    attackDecision: '98000000-0000-4000-8000-000000000017',
    attempt: '98000000-0000-4000-8000-000000000018',
    attackAttempt: '98000000-0000-4000-8000-000000000019',
    outbox: '98000000-0000-4000-8000-000000000020',
    execution: '98000000-0000-4000-8000-000000000021',
    queue: '98000000-0000-4000-8000-000000000022',
    lease: '98000000-0000-4000-8000-000000000023',
    membership: '98000000-0000-4000-8000-000000000024',
  }),
  d: Object.freeze({
    user: '99000000-0000-4000-8000-000000000001',
    session: '99000000-0000-4000-8000-000000000002',
    otherSession: '99000000-0000-4000-8000-000000000003',
    request: '99000000-0000-4000-8000-000000000004',
    rotatedRequest: '99000000-0000-4000-8000-000000000005',
    otherSessionRequest: '99000000-0000-4000-8000-000000000006',
    household: '99000000-0000-4000-8000-000000000007',
    space: '99000000-0000-4000-8000-000000000008',
    run: '99000000-0000-4000-8000-000000000009',
    grant: '99000000-0000-4000-8000-000000000010',
    rotatedGrant: '99000000-0000-4000-8000-000000000011',
    otherSessionGrant: '99000000-0000-4000-8000-000000000012',
    disclosure: '99000000-0000-4000-8000-000000000013',
    proposal: '99000000-0000-4000-8000-000000000014',
    attackProposal: '99000000-0000-4000-8000-000000000015',
    decision: '99000000-0000-4000-8000-000000000016',
    attackDecision: '99000000-0000-4000-8000-000000000017',
    attempt: '99000000-0000-4000-8000-000000000018',
    attackAttempt: '99000000-0000-4000-8000-000000000019',
    outbox: '99000000-0000-4000-8000-000000000020',
    execution: '99000000-0000-4000-8000-000000000021',
    queue: '99000000-0000-4000-8000-000000000022',
    lease: '99000000-0000-4000-8000-000000000023',
    membership: '99000000-0000-4000-8000-000000000024',
  }),
});

const managerReviewIds = Object.freeze({
  disclosure: '96500000-0000-4000-8000-000000000001',
  proposal: '96500000-0000-4000-8000-000000000002',
  checkpoint: '96500000-0000-4000-8000-000000000003',
});

type ActorIds = Readonly<Record<keyof (typeof ids)['a'], string>>;
type PgClient = import('pg').Client;
type PgPool = import('pg').Pool;

interface Fixture {
  readonly actor: ActorIds;
  readonly disclosure: ActionProposal['disclosureGrant'];
  readonly disclosureHash: string;
  readonly providerGrantReference: string;
  readonly authorityBinding: Readonly<{
    kind: 'google-calendar-grant-v2';
    householdId: string;
    privateSpaceId: string;
    authorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprint;
    providerGrantReference: string;
    authorizationEpoch: number;
  }>;
  readonly collectionAuthorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprint;
  readonly providerAuthorityBindingHash: string;
  readonly proposal: ActionProposal;
  readonly preparation: Readonly<{
    binding: ReturnType<typeof ProposalPreparationBindingSchema.parse>;
    bindingHash: string;
  }>;
}

interface ApprovedLifecycle {
  readonly fixture: Fixture;
  readonly proposal: ActionProposal;
  readonly decision: ActionDecision;
  readonly proofToken: string;
}

interface PreparedLifecycle extends ApprovedLifecycle {
  readonly authorization: ReturnType<
    typeof ProviderWriteAuthorizationSchema.parse
  >;
}

interface ExecutingLifecycle extends PreparedLifecycle {
  readonly dispatchedAt: string;
  readonly proposal: ActionProposal;
}

const isoOffset = (milliseconds: number): string =>
  new Date(Date.now() + milliseconds).toISOString();

const operationId = (phase: string, marker = randomUUID()): string =>
  `proposal_${phase}_${marker.replaceAll('-', '_')}`;

const connectionUrl = (
  source: string,
  username: string,
  password: string,
): string => {
  const parsed = new URL(source);
  parsed.username = username;
  parsed.password = password;
  return parsed.toString();
};

const databasePool = (pool: PgPool): DatabasePool =>
  pool as unknown as DatabasePool;

const singleClientDatabasePool = (client: PgClient): DatabasePool => ({
  connect: async () => ({
    query: async (text, values) => {
      const result = await client.query(
        text,
        values === undefined ? [] : [...values],
      );
      return { rowCount: result.rowCount, rows: result.rows };
    },
    release: () => undefined,
  }),
});

const buildFixture = (
  actor: ActorIds,
  options: Readonly<{
    proposalId?: string;
    sdkCallSuffix?: string;
  }> = {},
): Fixture => {
  const disclosureCreatedAt = isoOffset(-60_000);
  const proposalCreatedAt = isoOffset(-1_000);
  const expiresAt = isoOffset(8 * 60_000);
  const providerGrantReference = `calendar-grant-${actor.user}`;
  const authorizationScopeFingerprint =
    EffectiveAuthorizationScopeFingerprintSchema.parse(
      hashCanonicalJson({
        domain: 'emdo.authorization-scope.v1',
        householdId: actor.household,
        userId: actor.user,
        sessionId: actor.session,
        membershipId: actor.membership,
        membershipAdministrationVersion: 1,
        role: 'owner',
        privateSpaceId: actor.space,
        proposalSpaceId: actor.space,
        writableSpaceIds: [actor.space],
      }),
    );
  const authorityBinding = Object.freeze({
    kind: 'google-calendar-grant-v2' as const,
    householdId: actor.household,
    privateSpaceId: actor.space,
    authorizationScopeFingerprint,
    providerGrantReference,
    authorizationEpoch: 0,
  });
  const providerAuthorityBindingHash = hashCanonicalJson(authorityBinding);
  const disclosure = Object.freeze({
    schemaVersion: 1 as const,
    id: actor.disclosure,
    version: 1,
    userId: actor.user,
    householdId: actor.household,
    agentId: 'scheduler',
    purpose: 'Create the exact visually approved calendar event',
    runId: actor.run,
    recordAllowlist: [
      {
        dataClass: 'calendar.event',
        recordId: 'calendar-event:dinner',
        fields: ['title'],
      },
    ],
    provider: 'google-calendar',
    createdAt: disclosureCreatedAt,
    expiresAt,
    oneRunOnly: true,
  });
  const proposalWithoutApproval = {
    schemaVersion: 1 as const,
    id: options.proposalId ?? actor.proposal,
    version: 1,
    runId: actor.run,
    capabilityId: 'scheduler.calendar.create',
    capabilityFingerprint: hashCanonicalJson({
      schemaVersion: 1,
      capabilityId: 'scheduler.calendar.create',
      version: '1.0.0',
    }),
    authorizationScopeFingerprint,
    canonicalArguments: { calendarId: 'primary', title: 'Dinner' },
    targets: [
      {
        kind: 'calendar-event',
        id: 'calendar-event:dinner',
        expectedVersion: 'none',
      },
    ],
    beforePreview: null,
    afterPreview: { title: 'Dinner' },
    approvalDisplay: {
      schemaVersion: 1 as const,
      title: 'Create Dinner',
      summary: 'Create one calendar event named Dinner.',
      beforeSummary: '',
      afterSummary: 'Dinner is added to the calendar.',
      fields: [{ label: 'Title', value: 'Dinner' }],
    },
    providerPreconditions: [],
    providerAuthorityBindingHash,
    providerSdkCallId: `sdk-calendar-create-${options.sdkCallSuffix ?? 'main'}-${actor.user}`,
    payloadHash: hashCanonicalJson({ calendarId: 'primary', title: 'Dinner' }),
    disclosureGrant: disclosure,
    createdAt: proposalCreatedAt,
    expiresAt,
    idempotencyKey: `proposal:calendar:${options.sdkCallSuffix ?? 'main'}:${actor.user}`,
    state: 'pending' as const,
  };
  const proposal = ActionProposalSchema.parse({
    ...proposalWithoutApproval,
    approvalHash: hashActionProposalApproval(proposalWithoutApproval),
  });
  const binding = ProposalPreparationBindingSchema.parse({
    proposalId: proposal.id,
    originRequestId: actor.request,
    originSpaceAccessGrantId: actor.grant,
    originSessionId: actor.session,
    runId: actor.run,
    householdId: actor.household,
    userId: actor.user,
    agentId: disclosure.agentId,
    disclosureGrantId: actor.disclosure,
    disclosurePolicyVersion: '1.0.0',
    capabilityId: proposal.capabilityId,
    sdkCallId: proposal.providerSdkCallId,
    providerAuthorityBindingHash,
  });
  return Object.freeze({
    actor,
    disclosure,
    disclosureHash: hashCanonicalJson(disclosure),
    providerGrantReference,
    authorityBinding,
    collectionAuthorizationScopeFingerprint: authorizationScopeFingerprint,
    providerAuthorityBindingHash,
    proposal,
    preparation: Object.freeze({
      binding,
      bindingHash: hashCanonicalJson({
        domain: 'emdo.provider-proposal-preparation.v1',
        binding,
      }),
    }),
  });
};

const buildFinanceFixture = (
  actor: ActorIds,
  options: Readonly<{
    proposalId?: string;
    sdkCallSuffix?: string;
    action?: 'delete-document' | 'commit-document-review';
  }> = {},
): Fixture => {
  const disclosureCreatedAt = isoOffset(-60_000);
  const proposalCreatedAt = isoOffset(-1_000);
  const expiresAt = isoOffset(8 * 60_000);
  const proposalId = options.proposalId ?? actor.proposal;
  const action = options.action ?? 'delete-document';
  const isReviewCommit = action === 'commit-document-review';
  const guardedOperation = isReviewCommit
    ? 'finance-document-review-commit'
    : 'finance-document-delete';
  const documentId = `finance-document:${actor.proposal}`;
  const authorizationScopeFingerprint =
    EffectiveAuthorizationScopeFingerprintSchema.parse(
      hashCanonicalJson({
        domain: 'emdo.authorization-scope.v1',
        householdId: actor.household,
        userId: actor.user,
        sessionId: actor.session,
        membershipId: actor.membership,
        membershipAdministrationVersion: 1,
        role: 'owner',
        privateSpaceId: actor.space,
        proposalSpaceId: actor.space,
        writableSpaceIds: [actor.space],
      }),
    );
  const collectionAuthorizationScopeFingerprint =
    EffectiveAuthorizationScopeFingerprintSchema.parse(
      hashCanonicalJson({
        domain: 'emdo.authorization-scope.v1',
        householdId: actor.household,
        userId: actor.user,
        sessionId: actor.session,
        membershipId: actor.membership,
        membershipAdministrationVersion: 1,
        role: 'owner',
        privateSpaceId: actor.space,
        proposalSpaceId: null,
        writableSpaceIds: [actor.space],
      }),
    );
  const canonicalArguments: JsonValue = isReviewCommit
    ? ({
        schemaVersion: 1,
        mutation: {
          kind: 'commit-document-review',
          documentId,
        },
      } as const)
    : ({
        schemaVersion: 1,
        action: 'delete-document',
        documentId,
      } as const);
  const payloadHash = hashCanonicalJson(canonicalArguments);
  const capabilityFingerprint = hashCanonicalJson({
    schemaVersion: 1,
    capabilityId: 'finance.records.write',
    version: '1.0.0',
  });
  const targetBindingHash = hashCanonicalJson({
    schemaVersion: 1,
    domain: 'emdo.finance-document-target-binding.v1',
    documentId,
    expectedVersion: 'current',
  });
  const providerAuthorityBindingHash = hashCanonicalJson({
    schemaVersion: 1,
    domain: 'emdo.finance-guarded-action-execution-binding.v2',
    proposalId,
    runId: actor.run,
    householdId: actor.household,
    userId: actor.user,
    authenticatedSessionId: actor.session,
    privateSpaceId: actor.space,
    authorizationScopeFingerprint: collectionAuthorizationScopeFingerprint,
    disclosureGrantId: actor.disclosure,
    capabilityId: 'finance.records.write',
    capabilityVersion: '1.0.0',
    capabilityFingerprint,
    operation: guardedOperation,
    actionHash: payloadHash,
    targetBindingHash,
  });
  const guardedAction = {
    capabilityVersion: '1.0.0',
    operation: guardedOperation,
    actionHash: payloadHash,
    executionBindingHash: providerAuthorityBindingHash,
    targetBindingHash,
  } as const;
  const disclosure = Object.freeze({
    schemaVersion: 1 as const,
    id: actor.disclosure,
    version: 1,
    userId: actor.user,
    householdId: actor.household,
    agentId: 'finance',
    purpose: isReviewCommit
      ? 'Commit one visually approved Finance document review'
      : 'Delete one visually approved Finance document',
    runId: actor.run,
    recordAllowlist: [
      {
        dataClass: 'finance.document',
        recordId: documentId,
        fields: ['status'],
      },
    ],
    provider: 'openai',
    createdAt: disclosureCreatedAt,
    expiresAt,
    oneRunOnly: true,
  });
  const proposalWithoutApproval = {
    schemaVersion: 1 as const,
    id: proposalId,
    version: 1,
    runId: actor.run,
    capabilityId: 'finance.records.write',
    capabilityFingerprint,
    authorizationScopeFingerprint,
    canonicalArguments,
    targets: [
      {
        kind: 'finance.document',
        id: documentId,
        expectedVersion: 'current',
      },
    ],
    beforePreview: { status: 'ready' },
    afterPreview: { status: isReviewCommit ? 'committed' : 'deleted' },
    approvalDisplay: {
      schemaVersion: 1 as const,
      title: isReviewCommit
        ? 'Commit Finance document review'
        : 'Delete Finance document',
      summary: isReviewCommit
        ? 'Commit one manually uploaded Finance document review.'
        : 'Delete one manually uploaded Finance document.',
      beforeSummary: isReviewCommit
        ? 'The document review is awaiting commitment.'
        : 'The document remains available.',
      afterSummary: isReviewCommit
        ? 'The document review is committed.'
        : 'The document is deleted.',
      fields: [{ label: 'Document', value: documentId }],
    },
    providerPreconditions: [
      {
        kind: 'finance.document',
        targetId: documentId,
        expectedValue: 'current',
      },
    ],
    providerAuthorityBindingHash,
    providerSdkCallId: `sdk-finance-${isReviewCommit ? 'review' : 'delete'}-${options.sdkCallSuffix ?? 'main'}-${actor.user}`,
    guardedAction,
    payloadHash,
    disclosureGrant: disclosure,
    createdAt: proposalCreatedAt,
    expiresAt,
    idempotencyKey: `proposal:finance:${isReviewCommit ? 'review:' : ''}${options.sdkCallSuffix ?? 'main'}:${actor.user}`,
    state: 'pending' as const,
  };
  const proposal = ActionProposalSchema.parse({
    ...proposalWithoutApproval,
    approvalHash: hashActionProposalApproval(proposalWithoutApproval),
  });
  const binding = ProposalPreparationBindingSchema.parse({
    proposalId: proposal.id,
    originRequestId: actor.request,
    originSpaceAccessGrantId: actor.grant,
    originSessionId: actor.session,
    runId: actor.run,
    householdId: actor.household,
    userId: actor.user,
    agentId: disclosure.agentId,
    disclosureGrantId: actor.disclosure,
    disclosurePolicyVersion: '1.0.0',
    capabilityId: proposal.capabilityId,
    sdkCallId: proposal.providerSdkCallId,
    providerAuthorityBindingHash,
  });
  return Object.freeze({
    actor,
    disclosure,
    disclosureHash: hashCanonicalJson(disclosure),
    providerGrantReference: `unused-finance-grant-${actor.user}`,
    authorityBinding: Object.freeze({
      kind: 'google-calendar-grant-v2' as const,
      householdId: actor.household,
      privateSpaceId: actor.space,
      authorizationScopeFingerprint: collectionAuthorizationScopeFingerprint,
      providerGrantReference: `unused-finance-grant-${actor.user}`,
      authorizationEpoch: 0,
    }),
    collectionAuthorizationScopeFingerprint,
    providerAuthorityBindingHash,
    proposal,
    preparation: Object.freeze({
      binding,
      bindingHash: hashCanonicalJson({
        domain: 'emdo.provider-proposal-preparation.v1',
        binding,
      }),
    }),
  });
};

const transition = (
  proposal: ActionProposal,
  state: ActionProposal['state'],
): ActionProposal =>
  ActionProposalSchema.parse({
    ...proposal,
    version: proposal.version + 1,
    state,
  });

const scopeFor = (
  fixture: Fixture,
  phase: ProposalOperationScopeAssertion['phase'],
  activeAt: string,
  options: Readonly<{
    requestId?: string;
    sessionId?: string;
    spaceAccessGrantId?: string;
  }> = {},
): ProposalOperationScopeAssertion => {
  const common = {
    runId: fixture.actor.run,
    householdId: fixture.actor.household,
    userId: fixture.actor.user,
    authorizationScopeFingerprint:
      fixture.proposal.authorizationScopeFingerprint,
    disclosureGrantId: fixture.actor.disclosure,
    disclosureGrantVersion: fixture.disclosure.version,
    disclosureGrantHash: fixture.disclosureHash,
    proposalId: fixture.proposal.id,
    providerSdkCallId: fixture.proposal.providerSdkCallId,
    activeAt,
  };
  if (phase === 'proposal-create') {
    return {
      ...common,
      phase,
      currentRequestId: fixture.preparation.binding.originRequestId,
      currentSessionId: fixture.preparation.binding.originSessionId,
      currentSpaceAccessGrantId:
        fixture.preparation.binding.originSpaceAccessGrantId,
      requireActiveDisclosureGrant: true,
    };
  }
  return {
    ...common,
    phase,
    currentRequestId: options.requestId ?? fixture.actor.request,
    currentSessionId: options.sessionId ?? fixture.actor.session,
    currentSpaceAccessGrantId:
      options.spaceAccessGrantId ?? fixture.actor.grant,
    requireActiveDisclosureGrant: true,
  };
};

const createdEventFor = (fixture: Fixture): ProposalActivityEvent => ({
  proposalId: fixture.proposal.id,
  eventType: 'proposal.created',
  occurredAt: fixture.proposal.createdAt,
});

const expectedRevision = (proposal: ActionProposal) => ({
  proposalId: proposal.id,
  version: proposal.version,
  state: proposal.state,
  approvalHash: proposal.approvalHash,
});

const providerEvent = (
  lifecycle: PreparedLifecycle,
  completion: StoredProviderWriteCompletion,
): ProposalActivityEvent => {
  const outcome = completion.completion;
  return {
    proposalId: lifecycle.proposal.id,
    eventType: `proposal.${outcome.state}`,
    occurredAt: completion.completedAt,
    decisionId: lifecycle.decision.id,
    actorUserId: lifecycle.decision.userId,
    authenticatedSessionId: lifecycle.decision.authenticatedSessionId,
    approvalHash: lifecycle.proposal.approvalHash,
    decisionIdempotencyKey: lifecycle.decision.idempotencyKey,
    application: outcome.application,
    ...('reason' in outcome ? { outcomeReason: outcome.reason } : {}),
    ...('outputStatus' in outcome
      ? { outputStatus: outcome.outputStatus }
      : {}),
    ...('reconciliationRequired' in outcome
      ? { reconciliationRequired: outcome.reconciliationRequired }
      : {}),
    ...('evidenceHash' in outcome && outcome.evidenceHash !== undefined
      ? { evidenceHash: outcome.evidenceHash }
      : {}),
    providerIdempotencyKey: lifecycle.authorization.providerIdempotencyKey,
    attemptId: lifecycle.authorization.attemptId,
    attemptVersion: lifecycle.authorization.attemptVersion,
    ...('resultHash' in outcome ? { resultHash: outcome.resultHash } : {}),
    ...('safeErrorCode' in outcome
      ? { safeErrorCode: outcome.safeErrorCode }
      : {}),
  };
};

const completionRecord = (
  completion: StoredProviderWriteCompletion['completion'],
  bindingHash: string,
): StoredProviderWriteCompletion => {
  const completedAt = new Date().toISOString();
  return {
    completion,
    bindingHash,
    completionHash: hashCanonicalJson(completion),
    completedAt,
  };
};

describeDatabase(
  'PostgreSQL 18 provider proposal lifecycle (requires isolated POSTGRES_TEST_DATABASE_URL)',
  () => {
    let admin: PgClient;
    let appPool: PgPool;
    let workflowPool: PgPool;
    let workerPool: PgPool;
    let appUrl: string;
    let workflowUrl: string;
    let fixtureA: Fixture;
    let fixtureB: Fixture;
    let createdApiLogin = false;
    let grantedApiMembership = false;

    const repositoryFor = (
      fixture: Fixture,
      workflowOperationId: string,
      options: Readonly<{
        requestId?: string;
        sessionId?: string;
      }> = {},
    ) =>
      new PostgresProposalRepository({
        readPool: databasePool(appPool),
        workflowPool: databasePool(workflowPool),
        principal: {
          userId: fixture.actor.user,
          sessionId: options.sessionId ?? fixture.actor.session,
          requestId: options.requestId ?? fixture.actor.request,
          householdId: fixture.actor.household,
        },
        workflowOperationIdFactory: () => workflowOperationId,
      });

    const proofStore = () =>
      new PostgresVisualDecisionProofStore(
        databasePool(appPool),
        new VisualDecisionProofTokenCodec({
          current: {
            keyId: 'proposal-integration-v1',
            secret: new Uint8Array(32).fill(17),
          },
          previous: [],
          clock: () => new Date(),
          generateProofId: () => randomUUID(),
          generateNonce: () => randomBytes(32).toString('base64url'),
        }),
      );

    const visualPrincipal = (
      fixture: Fixture,
      options: Readonly<{
        sessionId?: string;
        spaceAccessGrantId?: string;
      }> = {},
    ) => ({
      userId: fixture.actor.user,
      sessionId: options.sessionId ?? fixture.actor.session,
      householdId: fixture.actor.household,
      role: 'owner' as const,
      emailVerified: true as const,
      spaceAccessGrantId: options.spaceAccessGrantId ?? fixture.actor.grant,
      collectionAuthorizationScopeFingerprint:
        fixture.collectionAuthorizationScopeFingerprint,
    });

    const seedDisclosureGrant = async (fixture: Fixture): Promise<void> => {
      const actor = fixture.actor;
      await admin.query(
        `insert into emdo.disclosure_grants
           (id, version, household_id, space_id, user_id, run_id, agent_id,
            purpose, provider, record_allowlist, grant_hash, created_at,
            expires_at, one_run_only)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11,
                 $12::timestamptz, $13::timestamptz, true)`,
        [
          fixture.disclosure.id,
          fixture.disclosure.version,
          fixture.disclosure.householdId,
          actor.space,
          fixture.disclosure.userId,
          fixture.disclosure.runId,
          fixture.disclosure.agentId,
          fixture.disclosure.purpose,
          fixture.disclosure.provider,
          JSON.stringify(fixture.disclosure.recordAllowlist),
          fixture.disclosureHash,
          fixture.disclosure.createdAt,
          fixture.disclosure.expiresAt,
        ],
      );
    };

    const seedActor = async (
      fixture: Fixture,
      label: string,
      options: Readonly<{ includeGoogle?: boolean }> = {},
    ) => {
      const actor = fixture.actor;
      await admin.query(
        `insert into emdo.auth_users (id, name, email, email_verified)
         values ($1, $2, $3, true)`,
        [
          actor.user,
          `Proposal User ${label}`,
          `proposal-${label}@example.test`,
        ],
      );
      await admin.query(
        `insert into emdo.households (id, name, slug, created_by_user_id)
         values ($1, $2, $3, $4)`,
        [
          actor.household,
          `Proposal Household ${label}`,
          `proposal-household-${label}`,
          actor.user,
        ],
      );
      await admin.query(
        `insert into emdo.household_memberships
           (id, household_id, user_id, role, status, joined_at)
         values ($1, $2, $3, 'owner', 'active', pg_catalog.clock_timestamp())`,
        [actor.membership, actor.household, actor.user],
      );
      await admin.query(
        `insert into emdo.spaces
           (id, household_id, original_owner_user_id, name, visibility)
         values ($1, $2, $3, $4, 'private')`,
        [actor.space, actor.household, actor.user, `Private ${label}`],
      );
      await admin.query(
        `insert into emdo.auth_sessions
           (id, user_id, token, expires_at, active_household_id)
         values ($1, $3, $5, pg_catalog.clock_timestamp() + interval '1 hour', $4),
                ($2, $3, $6, pg_catalog.clock_timestamp() + interval '1 hour', $4)`,
        [
          actor.session,
          actor.otherSession,
          actor.user,
          actor.household,
          `proposal-session-${label}`,
          `proposal-other-session-${label}`,
        ],
      );
      await admin.query(
        `insert into emdo.agent_runs
           (id, household_id, space_id, original_owner_user_id, agent_id,
            agent_version, requested_model, status)
         values ($1, $2, $3, $4, $5, '1.0.0',
                 'gpt-5.6-luna', 'running')`,
        [
          actor.run,
          actor.household,
          actor.space,
          actor.user,
          fixture.disclosure.agentId,
        ],
      );
      await admin.query(
        `insert into emdo.space_access_grants
           (grant_id, household_id, original_owner_user_id, session_id,
            request_id, membership_id, role, private_space_id,
            writable_space_ids, issued_at, expires_at, retain_until)
         select grant_input.grant_id, membership.household_id,
                membership.user_id, grant_input.session_id,
                grant_input.request_id, membership.id, membership.role,
                $8::uuid, array[$8::uuid],
                pg_catalog.clock_timestamp() - interval '1 second',
                pg_catalog.clock_timestamp() + interval '10 minutes',
                pg_catalog.clock_timestamp() + interval '89 days'
           from emdo.household_memberships as membership
           cross join (values
             ($1::uuid, $4::uuid, $5::uuid),
             ($2::uuid, $4::uuid, $6::uuid),
             ($3::uuid, $7::uuid, $9::uuid)
           ) as grant_input(grant_id, session_id, request_id)
          where membership.household_id = $10::uuid
            and membership.user_id = $11::uuid`,
        [
          actor.grant,
          actor.rotatedGrant,
          actor.otherSessionGrant,
          actor.session,
          actor.request,
          actor.rotatedRequest,
          actor.otherSession,
          actor.space,
          actor.otherSessionRequest,
          actor.household,
          actor.user,
        ],
      );
      if (options.includeGoogle !== false) {
        await admin.query(
          `insert into emdo.google_oauth_authorization_epochs
             (household_id, private_space_id, original_owner_user_id,
              authorization_epoch, created_at, updated_at)
           values ($1, $2, $3, 0, pg_catalog.clock_timestamp(),
                   pg_catalog.clock_timestamp())`,
          [actor.household, actor.space, actor.user],
        );
        await admin.query(
          `insert into emdo.encrypted_google_calendar_grants
             (record_id, household_id, private_space_id, original_owner_user_id,
              provider, grant_type, revision, authorization_epoch,
              provider_grant_reference, encrypted_payload, created_at, updated_at)
           values ($1, $2, $3, $4, 'google', 'calendar-authorization', 1, 0,
                   $5, $6::jsonb, pg_catalog.clock_timestamp(),
                   pg_catalog.clock_timestamp())`,
          [
            `google-calendar-oauth-v1-${hashCanonicalJson({ label })}`,
            actor.household,
            actor.space,
            actor.user,
            fixture.providerGrantReference,
            {
              algorithm: 'aes-256-gcm',
              aadVersion: 1,
              ciphertext: Buffer.from(`proposal-${label}`).toString(
                'base64url',
              ),
              nonce: Buffer.alloc(12, 1).toString('base64url'),
              authenticationTag: Buffer.alloc(16, 2).toString('base64url'),
              wrappedKey: Buffer.alloc(60, 3).toString('base64url'),
              keyVersion: 'proposal-integration-key-v1',
            },
          ],
        );
      }
      await seedDisclosureGrant(fixture);
    };

    const directWorkflowCommit = async (
      functionName:
        | 'commit_provider_proposal_create'
        | 'commit_provider_proposal_decision'
        | 'commit_provider_proposal_prepare'
        | 'commit_provider_proposal_dispatch',
      operation: string,
      mutation: Readonly<Record<string, unknown>>,
    ): Promise<string> => {
      const { Client } = await import('pg');
      const client = new Client({ connectionString: workflowUrl });
      await client.connect();
      try {
        const scope = mutation.scope as ProposalOperationScopeAssertion;
        await client.query('begin');
        await client.query(
          `select pg_catalog.set_config('emdo.user_id', $1, true),
                  pg_catalog.set_config('emdo.session_id', $2, true),
                  pg_catalog.set_config('emdo.request_id', $3, true)`,
          [scope.userId, scope.currentSessionId, scope.currentRequestId],
        );
        const result = await client.query<{ write_result: string }>(
          `select emdo.${functionName}($1, $2::jsonb) as write_result`,
          [operation, mutation],
        );
        await client.query('commit');
        return result.rows[0]?.write_result ?? 'missing';
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        await client.end();
      }
    };

    const expectUnclaimed = async (operation: string): Promise<void> => {
      const result = await admin.query<{ claimed_at: Date | null }>(
        `select claimed_at from emdo.workflow_operation_claims
          where operation_id = $1`,
        [operation],
      );
      expect(result.rows.length).toBeLessThanOrEqual(1);
      expect(result.rows.every(({ claimed_at }) => claimed_at === null)).toBe(
        true,
      );
    };

    beforeAll(async () => {
      const { Client, Pool } = await import('pg');
      admin = new Client({ connectionString: databaseUrl });
      await admin.connect();

      const version = await admin.query<{ server_version_num: string }>(
        `select pg_catalog.current_setting('server_version_num') as server_version_num`,
      );
      expect(
        Number(version.rows[0]?.server_version_num),
      ).toBeGreaterThanOrEqual(180_000);
      expect(Number(version.rows[0]?.server_version_num)).toBeLessThan(190_000);
      const existing = await admin.query<{ emdo_schema: string | null }>(
        `select pg_catalog.to_regnamespace('emdo')::text as emdo_schema`,
      );
      expect(
        existing.rows[0]?.emdo_schema,
        'POSTGRES_TEST_DATABASE_URL must point at an isolated empty database',
      ).toBeNull();

      await admin.query(`do $roles$
        begin
          if not exists (
            select 1 from pg_catalog.pg_roles
             where rolname = '${WORKER_LOGIN}'
          ) then
            create role ${WORKER_LOGIN} login inherit nosuperuser nocreatedb
              nocreaterole nobypassrls noreplication;
          end if;
        end
      $roles$`);
      await admin.query(
        `alter role ${WORKER_LOGIN} password '${workerPassword}'`,
      );

      const proposalMigrations = await loadOrderedMigrations();
      expect(proposalMigrations.at(-1)?.id).toBe(
        '0019_manager_turn_spend_warning',
      );
      for (const migration of proposalMigrations) {
        try {
          await admin.query(migration.sql);
        } catch (error) {
          throw new Error(`Migration ${migration.id} failed`, { cause: error });
        }
      }

      const existingApiLogin = await admin.query<{
        rolbypassrls: boolean;
        rolcanlogin: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolinherit: boolean;
        rolreplication: boolean;
        rolsuper: boolean;
      }>(
        `select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
                rolinherit, rolbypassrls, rolreplication
           from pg_catalog.pg_roles
          where rolname = $1`,
        [API_LOGIN],
      );
      if (existingApiLogin.rowCount === 0) {
        await admin.query(`create role ${API_LOGIN} login inherit nosuperuser
          nocreatedb nocreaterole nobypassrls noreplication`);
        createdApiLogin = true;
      } else {
        expect(existingApiLogin.rows).toEqual([
          {
            rolbypassrls: false,
            rolcanlogin: true,
            rolcreatedb: false,
            rolcreaterole: false,
            rolinherit: true,
            rolreplication: false,
            rolsuper: false,
          },
        ]);
      }
      const apiMemberships = await admin.query<{ parentRole: string }>(
        `select parent.rolname as "parentRole"
           from pg_catalog.pg_auth_members as membership
           join pg_catalog.pg_roles as parent
             on parent.oid = membership.roleid
           join pg_catalog.pg_roles as child
             on child.oid = membership.member
          where child.rolname = $1
          order by parent.rolname`,
        [API_LOGIN],
      );
      expect(
        apiMemberships.rows.every(
          ({ parentRole }) => parentRole === 'emdo_app',
        ),
      ).toBe(true);
      if (
        !apiMemberships.rows.some(({ parentRole }) => parentRole === 'emdo_app')
      ) {
        await admin.query(`grant emdo_app to ${API_LOGIN}`);
        grantedApiMembership = true;
      }

      await admin.query(`do $roles$
        begin
          if not exists (
            select 1 from pg_catalog.pg_roles
             where rolname = '${APP_LOGIN}'
          ) then
            create role ${APP_LOGIN} login inherit nosuperuser nocreatedb
              nocreaterole nobypassrls noreplication;
          end if;
        end
      $roles$`);
      await admin.query(`alter role ${APP_LOGIN} password '${appPassword}'`);
      await admin.query(`grant emdo_app to ${APP_LOGIN}`);
      await admin.query(`grant emdo_worker_executor to ${WORKER_LOGIN}`);
      await admin.query(
        `alter role ${WORKFLOW_LOGIN} password '${workflowPassword}'`,
      );

      appUrl = connectionUrl(databaseUrl!, APP_LOGIN, appPassword);
      workflowUrl = connectionUrl(
        databaseUrl!,
        WORKFLOW_LOGIN,
        workflowPassword,
      );
      const workerUrl = connectionUrl(
        databaseUrl!,
        WORKER_LOGIN,
        workerPassword,
      );
      appPool = new Pool({ connectionString: appUrl, max: 4 });
      workflowPool = new Pool({ connectionString: workflowUrl, max: 2 });
      workerPool = new Pool({ connectionString: workerUrl, max: 2 });
    }, 60_000);

    beforeEach(async () => {
      await admin.query('truncate table emdo.auth_users cascade');
      fixtureA = buildFixture(ids.a);
      fixtureB = buildFixture(ids.b);
      await seedActor(fixtureA, 'a');
      await seedActor(fixtureB, 'b');
    });

    afterEach(async () => {
      if (admin !== undefined) {
        await admin.query('rollback').catch(() => undefined);
        await admin.query('reset role').catch(() => undefined);
      }
    });

    afterAll(async () => {
      await Promise.allSettled([
        appPool?.end(),
        workflowPool?.end(),
        workerPool?.end(),
      ]);
      if (admin !== undefined) {
        if (grantedApiMembership) {
          await admin
            .query(`revoke emdo_app from ${API_LOGIN}`)
            .catch(() => undefined);
        }
        await admin
          .query(`revoke emdo_app from ${APP_LOGIN}`)
          .catch(() => undefined);
        await admin
          .query(`revoke emdo_worker_executor from ${WORKER_LOGIN}`)
          .catch(() => undefined);
        await admin
          .query(`drop role if exists ${APP_LOGIN}`)
          .catch(() => undefined);
        await admin
          .query(`drop role if exists ${WORKER_LOGIN}`)
          .catch(() => undefined);
        if (createdApiLogin) {
          await admin
            .query(`drop role if exists ${API_LOGIN}`)
            .catch(() => undefined);
        }
        await admin
          .query('drop schema if exists emdo cascade')
          .catch(() => undefined);
        await admin.end();
      }
    });

    const stageApprovalResume = async (
      fixture: Fixture,
      proposal: ActionProposal,
    ): Promise<void> => {
      const createdAt = new Date();
      const expiresAt = new Date(
        Math.min(
          Date.parse(proposal.expiresAt),
          createdAt.getTime() + 9 * 60_000,
        ),
      ).toISOString();
      const retainUntil = new Date(
        createdAt.getTime() + 89 * 24 * 60 * 60_000,
      ).toISOString();
      await admin.query(
        `with checkpoint as (
           insert into emdo.approval_checkpoints
             (checkpoint_id, household_id, space_id, user_id, run_id,
              format_version, revision, state, agent_graph_hash, sdk_version,
              sealed_state, created_at, expires_at, updated_at, retain_until)
           values ($1, $2, $3, $4, $5, 1, 1, 'pending', $6,
                   'proposal-integration', 'sealed-test-checkpoint',
                   $7::timestamptz, $8::timestamptz, $7::timestamptz,
                   $9::timestamptz)
           returning checkpoint_id
         )
         insert into emdo.approval_resume_jobs
           (job_id, household_id, space_id, user_id, run_id, conversation_id,
            checkpoint_id, interruption_id, proposal_id, capability_id,
            origin_session_id, origin_turn_request_id,
            origin_space_access_grant_id, authorization_scope_fingerprint,
            disclosure_grant_id, disclosure_grant_version,
            disclosure_policy_version, payload_hash, approval_hash, state,
            revision, created_at, updated_at, expires_at, retain_until)
         select $10, $2, $3, $4, $5, $11, checkpoint.checkpoint_id, $12,
                $13, $14, $15, $16, $17, $18, $19, $20, '1.0.0', $21, $22,
                'awaiting-decision', 1, $7::timestamptz, $7::timestamptz,
                $8::timestamptz, $9::timestamptz
           from checkpoint`,
        [
          randomUUID(),
          fixture.actor.household,
          fixture.actor.space,
          fixture.actor.user,
          fixture.actor.run,
          'a'.repeat(64),
          createdAt.toISOString(),
          expiresAt,
          retainUntil,
          randomUUID(),
          randomUUID(),
          `proposal-interruption:${proposal.id}`,
          proposal.id,
          proposal.capabilityId,
          fixture.preparation.binding.originSessionId,
          fixture.preparation.binding.originRequestId,
          fixture.preparation.binding.originSpaceAccessGrantId,
          proposal.authorizationScopeFingerprint,
          proposal.disclosureGrant.id,
          proposal.disclosureGrant.version,
          proposal.payloadHash,
          proposal.approvalHash,
        ],
      );
    };

    const createPending = async (
      fixture: Fixture,
      marker: string,
    ): Promise<ActionProposal> => {
      const result = await repositoryFor(
        fixture,
        operationId(`create_${marker}`),
      ).transaction((transaction) =>
        transaction.insertProposal({
          proposal: fixture.proposal,
          preparation: fixture.preparation,
          scope: scopeFor(fixture, 'proposal-create', new Date().toISOString()),
          event: createdEventFor(fixture),
        }),
      );
      expect(result).toBe('created');
      await stageApprovalResume(fixture, fixture.proposal);
      return fixture.proposal;
    };

    const commitApprovedDecision = async (
      fixture: Fixture,
      pending: ActionProposal,
      proofToken: string,
      marker: string,
      decisionOperationId: string = operationId(`decision_${marker}`),
    ): Promise<ApprovedLifecycle> => {
      const decidedAt = new Date().toISOString();
      const decision: ActionDecision = {
        schemaVersion: 1,
        id: fixture.actor.decision,
        proposalId: pending.id,
        userId: fixture.actor.user,
        authenticatedSessionId: fixture.actor.session,
        payloadHash: pending.payloadHash,
        approvalHash: pending.approvalHash,
        decision: 'approved',
        channel: 'authenticated-visual',
        decidedAt,
        idempotencyKey: `decision:${marker}:${pending.id}`,
      };
      const approved = transition(pending, 'approved');
      const scope = scopeFor(fixture, 'visual-decision', decidedAt);
      const result = await repositoryFor(fixture, decisionOperationId)
        .withVisualDecisionProof(proofToken, fixture.actor.grant)
        .transaction((transaction) =>
          transaction.commitDecision({
            expected: expectedRevision(pending),
            next: approved,
            decision,
            scope,
            event: {
              proposalId: pending.id,
              eventType: 'proposal.approved',
              occurredAt: decidedAt,
              decisionId: decision.id,
              actorUserId: decision.userId,
              authenticatedSessionId: decision.authenticatedSessionId,
              approvalHash: decision.approvalHash,
              decisionIdempotencyKey: decision.idempotencyKey,
            },
          }),
        );
      expect(result).toBe('created');
      return { fixture, proposal: approved, decision, proofToken };
    };

    const approvePending = async (
      fixture: Fixture,
      marker: string,
    ): Promise<ApprovedLifecycle> => {
      const pending = await createPending(fixture, marker);
      const issued = await proofStore().issue({
        proposalId: pending.id,
        expectedProposalVersion: pending.version,
        expectedPayloadHash: pending.payloadHash,
        expectedApprovalHash: pending.approvalHash,
        principal: visualPrincipal(fixture),
        requestId: fixture.actor.request,
        idempotencyKey: `visual-proof:${marker}:${pending.id}`,
      });
      expect(issued.status).toBe('issued');
      if (issued.status !== 'issued')
        throw new Error('visual proof not issued');
      return commitApprovedDecision(
        fixture,
        pending,
        issued.proof.proofToken,
        marker,
      );
    };

    const authorizationFor = (
      lifecycle: ApprovedLifecycle,
      issuedAt: string,
      attemptId: string = lifecycle.fixture.actor.attempt,
    ) => {
      const approvalBinding = {
        decisionId: lifecycle.decision.id,
        userId: lifecycle.fixture.actor.user,
        agentId: lifecycle.fixture.disclosure.agentId,
        runId: lifecycle.fixture.actor.run,
        capabilityId: lifecycle.proposal.capabilityId,
        capabilityFingerprint: lifecycle.proposal.capabilityFingerprint,
        disclosureGrantId: lifecycle.fixture.actor.disclosure,
        payloadHash: lifecycle.proposal.payloadHash,
        idempotencyTtlMs: 86_400_000,
        authorityBinding: lifecycle.fixture.authorityBinding,
      } as const;
      return ProviderWriteAuthorizationSchema.parse({
        proposalId: lifecycle.proposal.id,
        approvalHash: lifecycle.proposal.approvalHash,
        approvalBindingHash: hashProviderWriteApprovalBinding(approvalBinding),
        capabilityFingerprint: lifecycle.proposal.capabilityFingerprint,
        proposalCreatedAt: lifecycle.proposal.createdAt,
        expiresAt: lifecycle.proposal.expiresAt,
        disclosureGrantId: lifecycle.fixture.actor.disclosure,
        disclosureGrantHash: lifecycle.fixture.disclosureHash,
        approvalBinding,
        providerIdempotencyKey: hashCanonicalJson({
          schemaVersion: 1,
          proposalId: lifecycle.proposal.id,
          attemptId,
          providerSdkCallId: lifecycle.proposal.providerSdkCallId,
        }),
        idempotencyExpiresAt: new Date(
          Date.parse(issuedAt) + 86_400_000,
        ).toISOString(),
        attemptId,
        attemptVersion: 1,
        issuedAt,
        targets: lifecycle.proposal.targets,
        providerPreconditions: lifecycle.proposal.providerPreconditions,
      });
    };

    const prepareApproved = async (
      fixture: Fixture,
      marker: string,
    ): Promise<PreparedLifecycle> => {
      const approved = await approvePending(fixture, marker);
      const issuedAt = new Date().toISOString();
      const authorization = authorizationFor(approved, issuedAt);
      const prepared = transition(approved.proposal, 'prepared');
      const scope = scopeFor(fixture, 'provider-write-prepare', issuedAt);
      const result = await repositoryFor(
        fixture,
        operationId(`prepare_${marker}`),
      ).transaction((transaction) =>
        transaction.prepareProviderWrite({
          expected: expectedRevision(approved.proposal),
          next: prepared,
          decisionId: approved.decision.id,
          bindingHash: authorization.approvalBindingHash,
          authorization,
          scope,
          event: {
            proposalId: prepared.id,
            eventType: 'proposal.prepared',
            occurredAt: issuedAt,
            decisionId: approved.decision.id,
            actorUserId: approved.decision.userId,
            authenticatedSessionId: approved.decision.authenticatedSessionId,
            approvalHash: approved.decision.approvalHash,
            decisionIdempotencyKey: approved.decision.idempotencyKey,
            providerIdempotencyKey: authorization.providerIdempotencyKey,
            attemptId: authorization.attemptId,
            attemptVersion: authorization.attemptVersion,
          },
        }),
      );
      expect(result).toBe('created');
      return { ...approved, proposal: prepared, authorization };
    };

    const dispatchPrepared = async (
      fixture: Fixture,
      marker: string,
    ): Promise<ExecutingLifecycle> => {
      const prepared = await prepareApproved(fixture, marker);
      const dispatchedAt = new Date().toISOString();
      const executing = transition(prepared.proposal, 'executing');
      const result = await repositoryFor(
        fixture,
        operationId(`dispatch_${marker}`),
      ).transaction((transaction) =>
        transaction.markDispatch({
          expected: expectedRevision(prepared.proposal),
          next: executing,
          decisionId: prepared.decision.id,
          bindingHash: prepared.authorization.approvalBindingHash,
          attemptId: prepared.authorization.attemptId,
          dispatchedAt,
          scope: scopeFor(fixture, 'provider-write-dispatch', dispatchedAt),
          event: {
            proposalId: executing.id,
            eventType: 'proposal.executing',
            occurredAt: dispatchedAt,
            decisionId: prepared.decision.id,
            actorUserId: prepared.decision.userId,
            authenticatedSessionId: prepared.decision.authenticatedSessionId,
            approvalHash: prepared.decision.approvalHash,
            decisionIdempotencyKey: prepared.decision.idempotencyKey,
            providerIdempotencyKey:
              prepared.authorization.providerIdempotencyKey,
            attemptId: prepared.authorization.attemptId,
            attemptVersion: prepared.authorization.attemptVersion,
          },
        }),
      );
      expect(result).toBe('created');
      return { ...prepared, proposal: executing, dispatchedAt };
    };

    const completeLifecycle = async (
      lifecycle: PreparedLifecycle,
      mode: 'pre-dispatch' | 'post-dispatch',
      completion: StoredProviderWriteCompletion,
    ) => {
      const next = transition(lifecycle.proposal, completion.completion.state);
      const input = {
        expected: expectedRevision(lifecycle.proposal),
        next,
        decisionId: lifecycle.decision.id,
        bindingHash: lifecycle.authorization.approvalBindingHash,
        attemptId: lifecycle.authorization.attemptId,
        completion,
        event: providerEvent(lifecycle, completion),
      } as const;
      const commit = (transaction: ProposalRepositoryTransaction) =>
        mode === 'pre-dispatch'
          ? transaction.commitPreDispatchCompletion(input)
          : transaction.commitCompletion(input);
      return { next, input, commit };
    };

    it('executes every proposal readiness probe as its exact runtime principal', async () => {
      const { Client } = await import('pg');
      const apiClient = new Client({ connectionString: databaseUrl });
      const readinessWorkflowClient = new Client({
        connectionString: databaseUrl,
      });
      const decisionClient = new Client({ connectionString: databaseUrl });
      try {
        await Promise.all([
          apiClient.connect(),
          readinessWorkflowClient.connect(),
          decisionClient.connect(),
        ]);
        await Promise.all([
          apiClient.query(`set session authorization ${API_LOGIN}`),
          readinessWorkflowClient.query(
            `set session authorization ${WORKFLOW_LOGIN}`,
          ),
          decisionClient.query(
            `set session authorization ${VISUAL_DECISION_LOGIN}`,
          ),
        ]);
        const apiRolePool = singleClientDatabasePool(apiClient);
        const workflowRolePool = singleClientDatabasePool(
          readinessWorkflowClient,
        );
        const decisionRolePool = singleClientDatabasePool(decisionClient);
        const proposalQueries = new PostgresProposalQueryRepository(
          apiRolePool,
          new ProposalQueryCursorCodec({
            current: {
              keyId: 'proposal-readiness-v1',
              secret: new Uint8Array(32).fill(23),
            },
            previous: [],
          }),
        );
        const visualProofs = new PostgresVisualDecisionProofStore(
          apiRolePool,
          new VisualDecisionProofTokenCodec({
            current: {
              keyId: 'proposal-readiness-v1',
              secret: new Uint8Array(32).fill(29),
            },
            previous: [],
          }),
        );

        await expect(proposalQueries.check()).resolves.toBe(true);
        await expect(visualProofs.check()).resolves.toBe(true);
        await expect(
          checkPostgresProposalWorkflowReadiness(workflowRolePool),
        ).resolves.toBe(true);
        await expect(
          checkPostgresVisualDecisionReadiness(apiRolePool, decisionRolePool),
        ).resolves.toBe(true);
      } finally {
        await Promise.allSettled([
          apiClient.query('reset session authorization'),
          readinessWorkflowClient.query('reset session authorization'),
          decisionClient.query('reset session authorization'),
        ]);
        await Promise.allSettled([
          apiClient.end(),
          readinessWorkflowClient.end(),
          decisionClient.end(),
        ]);
      }
    });

    it('accepts guarded Finance create and visual decision without Google, but rejects forged Finance and Calendar without Google', async () => {
      const managerTurns = new PostgresManagerTurnStore(databasePool(appPool));
      const managerClaim = await managerTurns.claim({
        request: {
          schemaVersion: 1,
          message: 'Commit this reviewed Finance document.',
          routeHint: 'finance',
        },
        principal: visualPrincipal(fixtureA),
        requestId: fixtureA.actor.request,
        idempotencyKey: 'proposal-lifecycle-finance-review-0001',
      });
      expect(managerClaim.status).toBe('claimed');
      if (managerClaim.status !== 'claimed') {
        throw new Error('expected a newly claimed manager turn');
      }

      const managerReviewDocumentId = `finance-document:${managerReviewIds.proposal}`;
      const managerReviewFixture = buildFinanceFixture(
        Object.freeze({
          ...fixtureA.actor,
          disclosure: managerReviewIds.disclosure,
          proposal: managerReviewIds.proposal,
          run: managerClaim.runId,
        }),
        {
          sdkCallSuffix: 'manager-review',
          action: 'commit-document-review',
        },
      );
      expect(managerReviewFixture.proposal.authorizationScopeFingerprint).toBe(
        managerClaim.authorizationScopeFingerprint,
      );
      expect(managerReviewFixture.proposal).toMatchObject({
        canonicalArguments: {
          mutation: {
            kind: 'commit-document-review',
            documentId: managerReviewDocumentId,
          },
        },
        guardedAction: {
          operation: 'finance-document-review-commit',
          targetBindingHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      });
      await seedDisclosureGrant(managerReviewFixture);
      await expect(
        repositoryFor(
          managerReviewFixture,
          operationId('finance_manager_review_create'),
        ).transaction((transaction) =>
          transaction.insertProposal({
            proposal: managerReviewFixture.proposal,
            preparation: managerReviewFixture.preparation,
            scope: scopeFor(
              managerReviewFixture,
              'proposal-create',
              new Date().toISOString(),
            ),
            event: createdEventFor(managerReviewFixture),
          }),
        ),
      ).resolves.toBe('created');

      const checkpointCreatedAt = new Date().toISOString();
      const checkpointExpiresAt = new Date(
        Date.parse(checkpointCreatedAt) + 5 * 60_000,
      ).toISOString();
      const checkpointRetainUntil = new Date(
        Date.parse(checkpointCreatedAt) + 89 * 24 * 60 * 60_000,
      ).toISOString();
      const checkpoint = Object.freeze({
        checkpointId: managerReviewIds.checkpoint,
        householdId: managerReviewFixture.actor.household,
        userId: managerReviewFixture.actor.user,
        runId: managerReviewFixture.actor.run,
        agentGraphHash: 'a'.repeat(64),
        sdkVersion: 'proposal-lifecycle-integration',
        formatVersion: 1,
        revision: 1,
        state: 'pending' as const,
        createdAt: checkpointCreatedAt,
        expiresAt: checkpointExpiresAt,
        updatedAt: checkpointCreatedAt,
      });
      await admin.query(
        `insert into emdo.approval_checkpoints
           (checkpoint_id, household_id, space_id, user_id, run_id,
            format_version, revision, state, agent_graph_hash, sdk_version,
            sealed_state, created_at, expires_at, updated_at, retain_until)
         values ($1, $2, $3, $4, $5, 1, 1, 'pending', $6, $7,
                 'sealed-manager-review-checkpoint', $8::timestamptz,
                 $9::timestamptz, $8::timestamptz, $10::timestamptz)`,
        [
          checkpoint.checkpointId,
          checkpoint.householdId,
          managerReviewFixture.actor.space,
          checkpoint.userId,
          checkpoint.runId,
          checkpoint.agentGraphHash,
          checkpoint.sdkVersion,
          checkpoint.createdAt,
          checkpoint.expiresAt,
          checkpointRetainUntil,
        ],
      );
      const beforeCompletion = await admin.query(
        `select 1
           from emdo.approval_resume_jobs
          where run_id = $1`,
        [managerClaim.runId],
      );
      expect(beforeCompletion.rows).toEqual([]);

      const interruptionId = `finance-review:${managerReviewFixture.proposal.id}`;
      const managerApprovalResult = {
        status: 'needs-approval',
        runId: managerClaim.runId,
        localTraceReference: 'proposal-lifecycle-finance-review',
        checkpoint,
        interruptions: [
          {
            id: interruptionId,
            agentId: 'finance',
            capabilityId: managerReviewFixture.proposal.capabilityId,
            proposalId: managerReviewFixture.proposal.id,
            argumentsPreview: {
              mutation: {
                kind: 'commit-document-review',
                documentId: managerReviewDocumentId,
              },
            },
          },
        ],
        specialistOutcomes: [],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          modelCostCadMinor: 0,
          spendWarning: true,
        },
        modelResolution: {
          status: 'resolved',
          requestedModel: 'gpt-5.6-luna',
          resolvedModel: 'gpt-5.6-luna',
          reason: 'default',
        },
      } as const;

      await expect(
        managerTurns.complete({
          claimId: managerClaim.claimId,
          ownershipToken: managerClaim.ownershipToken,
          runId: managerClaim.runId,
          result: managerApprovalResult,
        }),
      ).resolves.toEqual({ status: 'completed', terminalEventSequence: 2 });

      const managerEvents = await admin.query<{
        sequence: number;
        eventType: string;
        payload: unknown;
      }>(
        `select sequence::integer as sequence, event_type as "eventType", payload
           from emdo.agent_run_events
          where run_id = $1
          order by sequence`,
        [managerClaim.runId],
      );
      expect(
        managerEvents.rows.map(({ sequence, eventType }) => ({
          sequence,
          eventType,
        })),
      ).toEqual([
        { sequence: 1, eventType: 'run.accepted' },
        { sequence: 2, eventType: 'approval.required' },
      ]);
      expect(managerEvents.rows.at(-1)?.payload).toMatchObject({
        status: 'needs-approval',
        runId: managerClaim.runId,
        interruptions: [
          {
            id: interruptionId,
            proposalId: managerReviewFixture.proposal.id,
          },
        ],
      });
      const approvalResumeJobs = await admin.query<{
        checkpointId: string;
        proposalId: string;
        capabilityId: string;
        approvalEventSequence: number;
        state: string;
      }>(
        `select checkpoint_id::text as "checkpointId",
                proposal_id::text as "proposalId",
                capability_id as "capabilityId",
                approval_event_sequence::integer as "approvalEventSequence",
                state
           from emdo.approval_resume_jobs
          where run_id = $1`,
        [managerClaim.runId],
      );
      expect(approvalResumeJobs.rows).toEqual([
        {
          checkpointId: checkpoint.checkpointId,
          proposalId: managerReviewFixture.proposal.id,
          capabilityId: 'finance.records.write',
          approvalEventSequence: 2,
          state: 'awaiting-decision',
        },
      ]);

      const financeFixture = buildFinanceFixture(ids.c);
      await seedActor(financeFixture, 'finance-no-google', {
        includeGoogle: false,
      });

      const createOperation = operationId('finance_no_google_create');
      const createInput = {
        proposal: financeFixture.proposal,
        preparation: financeFixture.preparation,
        scope: scopeFor(
          financeFixture,
          'proposal-create',
          new Date().toISOString(),
        ),
        event: createdEventFor(financeFixture),
      } as const;
      await expect(
        repositoryFor(financeFixture, createOperation).transaction(
          (transaction) => transaction.insertProposal(createInput),
        ),
      ).resolves.toBe('created');
      await expect(
        repositoryFor(financeFixture, createOperation).transaction(
          (transaction) => transaction.insertProposal(createInput),
        ),
      ).resolves.toBe('duplicate');
      const alteredScopeOperation = operationId('finance_altered_scope');
      await expect(
        directWorkflowCommit(
          'commit_provider_proposal_create',
          alteredScopeOperation,
          {
            ...createInput,
            scope: {
              ...createInput.scope,
              authorizationScopeFingerprint: 'e'.repeat(64),
            },
          },
        ),
      ).resolves.toBe('conflict');
      await expectUnclaimed(alteredScopeOperation);
      await expect(
        repositoryFor(
          financeFixture,
          operationId('finance_no_google_read'),
        ).getProposal(financeFixture.proposal.id),
      ).resolves.toEqual(financeFixture.proposal);

      await stageApprovalResume(financeFixture, financeFixture.proposal);
      const issuedProof = await proofStore().issue({
        proposalId: financeFixture.proposal.id,
        expectedProposalVersion: financeFixture.proposal.version,
        expectedPayloadHash: financeFixture.proposal.payloadHash,
        expectedApprovalHash: financeFixture.proposal.approvalHash,
        principal: visualPrincipal(financeFixture),
        requestId: financeFixture.actor.request,
        idempotencyKey: `visual-proof:finance-no-google:${financeFixture.proposal.id}`,
      });
      expect(issuedProof.status).toBe('issued');
      if (issuedProof.status !== 'issued') {
        throw new Error('expected Finance visual proof issuance');
      }
      const visualDecisionOperation = operationId('finance_no_google_decision');
      const approved = await commitApprovedDecision(
        financeFixture,
        financeFixture.proposal,
        issuedProof.proof.proofToken,
        'finance-no-google',
        visualDecisionOperation,
      );
      await expect(
        repositoryFor(financeFixture, visualDecisionOperation)
          .withVisualDecisionProof(
            issuedProof.proof.proofToken,
            financeFixture.actor.grant,
          )
          .transaction((transaction) =>
            transaction.commitDecision({
              expected: expectedRevision(financeFixture.proposal),
              next: approved.proposal,
              decision: approved.decision,
              scope: scopeFor(
                financeFixture,
                'visual-decision',
                approved.decision.decidedAt,
              ),
              event: {
                proposalId: approved.proposal.id,
                eventType: 'proposal.approved',
                occurredAt: approved.decision.decidedAt,
                decisionId: approved.decision.id,
                actorUserId: approved.decision.userId,
                authenticatedSessionId:
                  approved.decision.authenticatedSessionId,
                approvalHash: approved.decision.approvalHash,
                decisionIdempotencyKey: approved.decision.idempotencyKey,
              },
            }),
          ),
      ).resolves.toBe('duplicate');
      await expect(
        repositoryFor(
          financeFixture,
          operationId('finance_no_google_approved_read'),
        ).getProposal(approved.proposal.id),
      ).resolves.toEqual(approved.proposal);

      const rejectedIssuedAt = new Date().toISOString();
      const rejectedAuthorization = authorizationFor(
        approved,
        rejectedIssuedAt,
        financeFixture.actor.attackAttempt,
      );
      const rejectedPrepared = transition(approved.proposal, 'prepared');
      const prepareOperation = operationId('finance_prepare_rejected');
      await expect(
        directWorkflowCommit(
          'commit_provider_proposal_prepare',
          prepareOperation,
          {
            expected: expectedRevision(approved.proposal),
            next: rejectedPrepared,
            decisionId: approved.decision.id,
            bindingHash: rejectedAuthorization.approvalBindingHash,
            authorization: rejectedAuthorization,
            approvalBinding: rejectedAuthorization.approvalBinding,
            scope: scopeFor(
              financeFixture,
              'provider-write-prepare',
              rejectedIssuedAt,
            ),
            event: {
              proposalId: approved.proposal.id,
              eventType: 'proposal.prepared',
              occurredAt: rejectedIssuedAt,
              decisionId: approved.decision.id,
              actorUserId: approved.decision.userId,
              authenticatedSessionId: approved.decision.authenticatedSessionId,
              approvalHash: approved.decision.approvalHash,
              decisionIdempotencyKey: approved.decision.idempotencyKey,
              providerIdempotencyKey:
                rejectedAuthorization.providerIdempotencyKey,
              attemptId: rejectedAuthorization.attemptId,
              attemptVersion: rejectedAuthorization.attemptVersion,
            },
          },
        ),
      ).resolves.toBe('conflict');
      await expectUnclaimed(prepareOperation);

      const rejectedDispatchedAt = new Date().toISOString();
      const dispatchOperation = operationId('finance_dispatch_rejected');
      await expect(
        directWorkflowCommit(
          'commit_provider_proposal_dispatch',
          dispatchOperation,
          {
            expected: expectedRevision(approved.proposal),
            next: transition(approved.proposal, 'executing'),
            decisionId: approved.decision.id,
            bindingHash: rejectedAuthorization.approvalBindingHash,
            attemptId: rejectedAuthorization.attemptId,
            dispatchedAt: rejectedDispatchedAt,
            scope: scopeFor(
              financeFixture,
              'provider-write-dispatch',
              rejectedDispatchedAt,
            ),
            event: {
              proposalId: approved.proposal.id,
              eventType: 'proposal.executing',
              occurredAt: rejectedDispatchedAt,
              decisionId: approved.decision.id,
              actorUserId: approved.decision.userId,
              authenticatedSessionId: approved.decision.authenticatedSessionId,
              approvalHash: approved.decision.approvalHash,
              decisionIdempotencyKey: approved.decision.idempotencyKey,
              providerIdempotencyKey:
                rejectedAuthorization.providerIdempotencyKey,
              attemptId: rejectedAuthorization.attemptId,
              attemptVersion: rejectedAuthorization.attemptVersion,
            },
          },
        ),
      ).resolves.toBe('conflict');
      await expectUnclaimed(dispatchOperation);
      await expect(
        repositoryFor(
          financeFixture,
          operationId('finance_provider_reject_read'),
        ).getProposal(approved.proposal.id),
      ).resolves.toEqual(approved.proposal);

      const financeClaims = await admin.query<{
        phase: string;
        finance_guarded_authority: {
          schemaVersion: number;
          capabilityId: string;
          capabilityFingerprint: string;
          guardedAction: unknown;
        } | null;
      }>(
        `select phase, finance_guarded_authority
           from emdo.workflow_operation_claims
          where proposal_id = $1
          order by phase`,
        [financeFixture.proposal.id],
      );
      expect(financeClaims.rows).toHaveLength(2);
      for (const claim of financeClaims.rows) {
        expect(claim.finance_guarded_authority).toEqual({
          schemaVersion: 1,
          capabilityId: financeFixture.proposal.capabilityId,
          capabilityFingerprint: financeFixture.proposal.capabilityFingerprint,
          guardedAction: financeFixture.proposal.guardedAction,
        });
      }
      await expect(
        admin.query(
          `update emdo.workflow_operation_claims
              set finance_guarded_authority = null
            where proposal_id = $1 and phase = 'proposal-create'`,
          [financeFixture.proposal.id],
        ),
      ).rejects.toMatchObject({ code: '55000' });

      const forgedFixture = buildFinanceFixture(ids.c, {
        proposalId: ids.c.attackProposal,
        sdkCallSuffix: 'forged-binding',
      });
      const forgedBindingHash = 'f'.repeat(64);
      const forgedProposal = ActionProposalSchema.parse({
        ...forgedFixture.proposal,
        providerAuthorityBindingHash: forgedBindingHash,
        guardedAction: {
          ...forgedFixture.proposal.guardedAction,
          executionBindingHash: forgedBindingHash,
        },
      });
      const forgedOperation = operationId('finance_forged_binding');
      await expect(
        directWorkflowCommit(
          'commit_provider_proposal_create',
          forgedOperation,
          {
            proposal: forgedProposal,
            preparation: forgedFixture.preparation,
            scope: scopeFor(
              forgedFixture,
              'proposal-create',
              new Date().toISOString(),
            ),
            event: createdEventFor(forgedFixture),
          },
        ),
      ).resolves.toBe('conflict');
      await expectUnclaimed(forgedOperation);

      const targetSubstitutionFixture = buildFinanceFixture(ids.c, {
        proposalId: randomUUID(),
        sdkCallSuffix: 'substituted-target',
      });
      const targetSubstitutionProposal = ActionProposalSchema.parse({
        ...targetSubstitutionFixture.proposal,
        guardedAction: {
          ...targetSubstitutionFixture.proposal.guardedAction,
          targetBindingHash: 'd'.repeat(64),
        },
      });
      const targetSubstitutionOperation = operationId(
        'finance_substituted_target',
      );
      await expect(
        directWorkflowCommit(
          'commit_provider_proposal_create',
          targetSubstitutionOperation,
          {
            proposal: targetSubstitutionProposal,
            preparation: targetSubstitutionFixture.preparation,
            scope: scopeFor(
              targetSubstitutionFixture,
              'proposal-create',
              new Date().toISOString(),
            ),
            event: createdEventFor(targetSubstitutionFixture),
          },
        ),
      ).resolves.toBe('conflict');
      await expectUnclaimed(targetSubstitutionOperation);

      const calendarWithoutGoogle = buildFixture(ids.d);
      await seedActor(calendarWithoutGoogle, 'calendar-no-google', {
        includeGoogle: false,
      });
      const calendarOperation = operationId('calendar_no_google');
      await expect(
        directWorkflowCommit(
          'commit_provider_proposal_create',
          calendarOperation,
          {
            proposal: calendarWithoutGoogle.proposal,
            preparation: calendarWithoutGoogle.preparation,
            scope: scopeFor(
              calendarWithoutGoogle,
              'proposal-create',
              new Date().toISOString(),
            ),
            event: createdEventFor(calendarWithoutGoogle),
          },
        ),
      ).resolves.toBe('conflict');
      await expectUnclaimed(calendarOperation);

      await createPending(fixtureA, 'calendar-null-guarded-authority');
      const calendarClaim = await admin.query<{
        finance_guarded_authority: unknown;
      }>(
        `select finance_guarded_authority
           from emdo.workflow_operation_claims
          where proposal_id = $1 and phase = 'proposal-create'`,
        [fixtureA.proposal.id],
      );
      expect(calendarClaim.rows).toEqual([{ finance_guarded_authority: null }]);
    });

    it('denies direct claim issuance and aggregate access while app reads remain household scoped', async () => {
      await createPending(fixtureA, 'acl-a');
      await createPending(fixtureB, 'acl-b');

      const repositoryA = repositoryFor(fixtureA, operationId('read_acl_a'));
      await expect(
        repositoryA.getProposal(fixtureA.proposal.id),
      ).resolves.toEqual(fixtureA.proposal);
      await expect(
        repositoryA.getProposal(fixtureB.proposal.id),
      ).resolves.toBeUndefined();
      const events = await repositoryA.listEvents();
      expect(events).toEqual([createdEventFor(fixtureA)]);

      const { Client } = await import('pg');
      const appClient = new Client({ connectionString: appUrl });
      await appClient.connect();
      try {
        await appClient.query('begin');
        await appClient.query(
          `select pg_catalog.set_config('emdo.user_id', $1, true),
                  pg_catalog.set_config('emdo.session_id', $2, true),
                  pg_catalog.set_config('emdo.request_id', $3, true)`,
          [fixtureA.actor.user, fixtureA.actor.session, fixtureA.actor.request],
        );
        const crossHousehold = await appClient.query(
          `select id from emdo.action_proposals where id = $1`,
          [fixtureB.proposal.id],
        );
        expect(crossHousehold.rows).toEqual([]);
        await expect(
          appClient.query(
            `update emdo.action_proposals
                set after_preview = '{"forged":true}'::jsonb
              where id = $1`,
            [fixtureB.proposal.id],
          ),
        ).rejects.toMatchObject({ code: '42501' });
        await appClient.query('rollback');
      } finally {
        await appClient.end();
      }

      const workflowClient = new Client({ connectionString: workflowUrl });
      await workflowClient.connect();
      try {
        const issuerPrivilege = await workflowClient.query<{
          can_execute: boolean;
        }>(
          `select pg_catalog.has_function_privilege(
                    current_user,
                    'emdo.issue_workflow_operation_claim(text,jsonb,uuid,uuid,text,text,text,jsonb)',
                    'EXECUTE'
                  ) as can_execute`,
        );
        expect(issuerPrivilege.rows[0]?.can_execute).toBe(false);
        await expect(
          workflowClient.query(
            `select id from emdo.action_proposals where id = $1`,
            [fixtureA.proposal.id],
          ),
        ).rejects.toMatchObject({ code: '42501' });
        await expect(
          workflowClient.query(
            `update emdo.action_proposals
                set after_preview = '{"forged":true}'::jsonb
              where id = $1`,
            [fixtureA.proposal.id],
          ),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await workflowClient.end();
      }
    });

    it('rejects cross-field mutation mismatches without consuming internally issued claims', async () => {
      const attackFixture = buildFixture(fixtureA.actor, {
        proposalId: fixtureA.actor.attackProposal,
        sdkCallSuffix: 'claim-swap',
      });
      const createScope = scopeFor(
        attackFixture,
        'proposal-create',
        new Date().toISOString(),
      );
      const createMutation = {
        proposal: attackFixture.proposal,
        preparation: attackFixture.preparation,
        scope: createScope,
        event: createdEventFor(attackFixture),
      } as const;
      const createOperation = operationId('claim_swap_create');
      await expect(
        directWorkflowCommit(
          'commit_provider_proposal_create',
          createOperation,
          {
            ...createMutation,
            event: {
              ...createMutation.event,
              occurredAt: isoOffset(1_000),
            },
          },
        ),
      ).resolves.toBe('conflict');
      await expectUnclaimed(createOperation);

      const pending = await createPending(fixtureA, 'claim-swap');
      const issuedProof = await proofStore().issue({
        proposalId: pending.id,
        expectedProposalVersion: pending.version,
        expectedPayloadHash: pending.payloadHash,
        expectedApprovalHash: pending.approvalHash,
        principal: visualPrincipal(fixtureA),
        requestId: fixtureA.actor.request,
        idempotencyKey: `visual-proof:claim-swap:${pending.id}`,
      });
      expect(issuedProof.status).toBe('issued');
      if (issuedProof.status !== 'issued') {
        throw new Error('expected issued visual proof');
      }
      const decisionAt = new Date().toISOString();
      const attackDecision: ActionDecision = {
        schemaVersion: 1,
        id: fixtureA.actor.attackDecision,
        proposalId: attackFixture.proposal.id,
        userId: fixtureA.actor.user,
        authenticatedSessionId: fixtureA.actor.session,
        payloadHash: pending.payloadHash,
        approvalHash: pending.approvalHash,
        decision: 'approved',
        channel: 'authenticated-visual',
        decidedAt: decisionAt,
        idempotencyKey: `decision:claim-swap-attack:${pending.id}`,
      };
      const decisionScope = scopeFor(fixtureA, 'visual-decision', decisionAt);
      const decisionMutation = {
        expected: expectedRevision(pending),
        next: transition(pending, 'approved'),
        decision: attackDecision,
        scope: decisionScope,
        event: {
          proposalId: pending.id,
          eventType: 'proposal.approved' as const,
          occurredAt: decisionAt,
          decisionId: attackDecision.id,
          actorUserId: attackDecision.userId,
          authenticatedSessionId: attackDecision.authenticatedSessionId,
          approvalHash: attackDecision.approvalHash,
          decisionIdempotencyKey: attackDecision.idempotencyKey,
        },
        visualDecisionProofHash: hashVisualDecisionProofToken(
          issuedProof.proof.proofToken,
        ),
      } as const;
      const decisionOperation = operationId('claim_swap_decision');
      await expect(
        directWorkflowCommit(
          'commit_provider_proposal_decision',
          decisionOperation,
          {
            ...decisionMutation,
            event: {
              ...decisionMutation.event,
              occurredAt: isoOffset(1_000),
            },
          },
        ),
      ).resolves.toBe('conflict');
      await expectUnclaimed(decisionOperation);

      const approved = await commitApprovedDecision(
        fixtureA,
        pending,
        issuedProof.proof.proofToken,
        'claim-swap',
      );
      const attackIssuedAt = new Date().toISOString();
      const attackAuthorization = authorizationFor(
        approved,
        attackIssuedAt,
        fixtureA.actor.attackAttempt,
      );
      const prepareScope = scopeFor(
        fixtureA,
        'provider-write-prepare',
        attackIssuedAt,
      );
      const prepareMutation = {
        expected: expectedRevision(approved.proposal),
        next: transition(approved.proposal, 'prepared'),
        decisionId: approved.decision.id,
        bindingHash: attackAuthorization.approvalBindingHash,
        authorization: attackAuthorization,
        approvalBinding: attackAuthorization.approvalBinding,
        scope: prepareScope,
        event: {
          proposalId: approved.proposal.id,
          eventType: 'proposal.prepared' as const,
          occurredAt: attackIssuedAt,
          decisionId: approved.decision.id,
          actorUserId: approved.decision.userId,
          authenticatedSessionId: approved.decision.authenticatedSessionId,
          approvalHash: approved.decision.approvalHash,
          decisionIdempotencyKey: approved.decision.idempotencyKey,
          providerIdempotencyKey: attackAuthorization.providerIdempotencyKey,
          attemptId: attackAuthorization.attemptId,
          attemptVersion: attackAuthorization.attemptVersion,
        },
      } as const;
      const prepareOperation = operationId('claim_swap_prepare');
      await expect(
        directWorkflowCommit(
          'commit_provider_proposal_prepare',
          prepareOperation,
          {
            ...prepareMutation,
            event: {
              ...prepareMutation.event,
              occurredAt: isoOffset(1_000),
            },
          },
        ),
      ).resolves.toBe('conflict');
      await expectUnclaimed(prepareOperation);

      const issuedAt = new Date().toISOString();
      const authorization = authorizationFor(approved, issuedAt);
      const prepared = transition(approved.proposal, 'prepared');
      await expect(
        repositoryFor(
          fixtureA,
          operationId('claim_swap_prepare_exact'),
        ).transaction((transaction) =>
          transaction.prepareProviderWrite({
            expected: expectedRevision(approved.proposal),
            next: prepared,
            decisionId: approved.decision.id,
            bindingHash: authorization.approvalBindingHash,
            authorization,
            scope: scopeFor(fixtureA, 'provider-write-prepare', issuedAt),
            event: {
              proposalId: prepared.id,
              eventType: 'proposal.prepared',
              occurredAt: issuedAt,
              decisionId: approved.decision.id,
              actorUserId: approved.decision.userId,
              authenticatedSessionId: approved.decision.authenticatedSessionId,
              approvalHash: approved.decision.approvalHash,
              decisionIdempotencyKey: approved.decision.idempotencyKey,
              providerIdempotencyKey: authorization.providerIdempotencyKey,
              attemptId: authorization.attemptId,
              attemptVersion: authorization.attemptVersion,
            },
          }),
        ),
      ).resolves.toBe('created');

      const dispatchedAt = new Date().toISOString();
      const dispatchScope = scopeFor(
        fixtureA,
        'provider-write-dispatch',
        dispatchedAt,
      );
      const dispatchMutation = {
        expected: expectedRevision(prepared),
        next: transition(prepared, 'executing'),
        decisionId: approved.decision.id,
        bindingHash: authorization.approvalBindingHash,
        attemptId: authorization.attemptId,
        dispatchedAt,
        scope: dispatchScope,
        event: {
          proposalId: prepared.id,
          eventType: 'proposal.executing' as const,
          occurredAt: dispatchedAt,
          decisionId: approved.decision.id,
          actorUserId: approved.decision.userId,
          authenticatedSessionId: approved.decision.authenticatedSessionId,
          approvalHash: approved.decision.approvalHash,
          decisionIdempotencyKey: approved.decision.idempotencyKey,
          providerIdempotencyKey: authorization.providerIdempotencyKey,
          attemptId: authorization.attemptId,
          attemptVersion: authorization.attemptVersion,
        },
      } as const;
      const dispatchOperation = operationId('claim_swap_dispatch');
      await expect(
        directWorkflowCommit(
          'commit_provider_proposal_dispatch',
          dispatchOperation,
          {
            ...dispatchMutation,
            dispatchedAt: isoOffset(1_000),
          },
        ),
      ).resolves.toBe('conflict');
      await expectUnclaimed(dispatchOperation);
    });

    it('reproduces a proof across an equivalent rotating grant, atomically consumes it, and locks replay to the exact proof', async () => {
      const pending = await createPending(fixtureA, 'visual-replay');
      const idempotencyKey = `visual-proof:replay:${pending.id}`;
      const first = await proofStore().issue({
        proposalId: pending.id,
        expectedProposalVersion: pending.version,
        expectedPayloadHash: pending.payloadHash,
        expectedApprovalHash: pending.approvalHash,
        principal: visualPrincipal(fixtureA),
        requestId: fixtureA.actor.request,
        idempotencyKey,
      });
      const replay = await proofStore().issue({
        proposalId: pending.id,
        expectedProposalVersion: pending.version,
        expectedPayloadHash: pending.payloadHash,
        expectedApprovalHash: pending.approvalHash,
        principal: visualPrincipal(fixtureA, {
          spaceAccessGrantId: fixtureA.actor.rotatedGrant,
        }),
        requestId: fixtureA.actor.rotatedRequest,
        idempotencyKey,
      });
      expect(first.status).toBe('issued');
      expect(replay.status).toBe('issued');
      if (first.status !== 'issued' || replay.status !== 'issued') {
        throw new Error('expected issued visual proofs');
      }
      expect(replay.proof).toMatchObject({
        proofToken: first.proof.proofToken,
        issuedAt: first.proof.issuedAt,
        expiresAt: first.proof.expiresAt,
        replayed: true,
      });

      const approved = await commitApprovedDecision(
        fixtureA,
        pending,
        first.proof.proofToken,
        'visual-replay',
      );
      const storedProof = await admin.query<{
        consumed_at: Date | null;
        decision_id: string | null;
        row_version: number;
      }>(
        `select consumed_at, decision_id, row_version
           from emdo.visual_decision_proofs
          where proposal_id = $1 and idempotency_key = $2`,
        [pending.id, idempotencyKey],
      );
      expect(storedProof.rows[0]).toMatchObject({
        consumed_at: expect.any(Date),
        decision_id: approved.decision.id,
        row_version: 2,
      });

      const exactReplay = repositoryFor(
        fixtureA,
        operationId('decision_replay'),
      ).withVisualDecisionProof(first.proof.proofToken, fixtureA.actor.grant);
      await expect(
        exactReplay.transaction((transaction) =>
          transaction.findDecisionByIdempotencyKey({
            userId: fixtureA.actor.user,
            proposalId: pending.id,
            idempotencyKey: approved.decision.idempotencyKey,
          }),
        ),
      ).resolves.toEqual({
        proposalId: pending.id,
        decision: approved.decision,
      });
      const wrongProof = repositoryFor(
        fixtureA,
        operationId('wrong_decision_replay'),
      ).withVisualDecisionProof('x'.repeat(43), fixtureA.actor.grant);
      await expect(
        wrongProof.transaction((transaction) =>
          transaction.findDecisionByIdempotencyKey({
            userId: fixtureA.actor.user,
            proposalId: pending.id,
            idempotencyKey: approved.decision.idempotencyKey,
          }),
        ),
      ).resolves.toBeUndefined();
      await expect(
        repositoryFor(fixtureA, operationId('proof_reuse'))
          .withVisualDecisionProof(first.proof.proofToken, fixtureA.actor.grant)
          .transaction((transaction) =>
            transaction.commitDecision({
              expected: expectedRevision(pending),
              next: transition(pending, 'approved'),
              decision: {
                ...approved.decision,
                id: fixtureA.actor.attackDecision,
              },
              scope: scopeFor(
                fixtureA,
                'visual-decision',
                new Date().toISOString(),
              ),
              event: {
                proposalId: pending.id,
                eventType: 'proposal.approved',
                occurredAt: new Date().toISOString(),
                decisionId: fixtureA.actor.attackDecision,
              },
            }),
          ),
      ).resolves.toBe('conflict');
    });

    it('invalidates visual replay on role, administration, or session drift and provider prepare on authority epoch rotation', async () => {
      const pending = await createPending(fixtureA, 'invalidation');
      const idempotencyKey = `visual-proof:invalidation:${pending.id}`;
      const first = await proofStore().issue({
        proposalId: pending.id,
        expectedProposalVersion: pending.version,
        expectedPayloadHash: pending.payloadHash,
        expectedApprovalHash: pending.approvalHash,
        principal: visualPrincipal(fixtureA),
        requestId: fixtureA.actor.request,
        idempotencyKey,
      });
      expect(first.status).toBe('issued');
      if (first.status !== 'issued') throw new Error('expected issued proof');

      await admin.query(
        `update emdo.household_memberships
            set administration_version = administration_version + 1
          where household_id = $1 and user_id = $2`,
        [fixtureA.actor.household, fixtureA.actor.user],
      );
      const administrationDrift = await proofStore().issue({
        proposalId: pending.id,
        expectedProposalVersion: pending.version,
        expectedPayloadHash: pending.payloadHash,
        expectedApprovalHash: pending.approvalHash,
        principal: visualPrincipal(fixtureA, {
          spaceAccessGrantId: fixtureA.actor.rotatedGrant,
        }),
        requestId: fixtureA.actor.rotatedRequest,
        idempotencyKey,
      });
      expect(administrationDrift.status).not.toBe('issued');
      await admin.query(
        `update emdo.household_memberships
            set administration_version = administration_version - 1,
                role = 'member'
          where household_id = $1 and user_id = $2`,
        [fixtureA.actor.household, fixtureA.actor.user],
      );
      const roleDrift = await proofStore().issue({
        proposalId: pending.id,
        expectedProposalVersion: pending.version,
        expectedPayloadHash: pending.payloadHash,
        expectedApprovalHash: pending.approvalHash,
        principal: visualPrincipal(fixtureA, {
          spaceAccessGrantId: fixtureA.actor.rotatedGrant,
        }),
        requestId: fixtureA.actor.rotatedRequest,
        idempotencyKey,
      });
      expect(roleDrift.status).not.toBe('issued');
      await admin.query(
        `update emdo.household_memberships set role = 'owner'
          where household_id = $1 and user_id = $2`,
        [fixtureA.actor.household, fixtureA.actor.user],
      );
      const sessionDrift = await proofStore().issue({
        proposalId: pending.id,
        expectedProposalVersion: pending.version,
        expectedPayloadHash: pending.payloadHash,
        expectedApprovalHash: pending.approvalHash,
        principal: visualPrincipal(fixtureA, {
          sessionId: fixtureA.actor.otherSession,
          spaceAccessGrantId: fixtureA.actor.otherSessionGrant,
        }),
        requestId: fixtureA.actor.otherSessionRequest,
        idempotencyKey,
      });
      expect(sessionDrift.status).not.toBe('issued');

      const approved = await commitApprovedDecision(
        fixtureA,
        pending,
        first.proof.proofToken,
        'invalidation',
      );
      await admin.query(
        `update emdo.google_oauth_authorization_epochs
            set authorization_epoch = authorization_epoch + 1,
                updated_at = pg_catalog.clock_timestamp()
          where household_id = $1 and private_space_id = $2`,
        [fixtureA.actor.household, fixtureA.actor.space],
      );
      const issuedAt = new Date().toISOString();
      const authorization = authorizationFor(approved, issuedAt);
      await expect(
        repositoryFor(fixtureA, operationId('epoch_invalidated')).transaction(
          (transaction) =>
            transaction.prepareProviderWrite({
              expected: expectedRevision(approved.proposal),
              next: transition(approved.proposal, 'prepared'),
              decisionId: approved.decision.id,
              bindingHash: authorization.approvalBindingHash,
              authorization,
              scope: scopeFor(fixtureA, 'provider-write-prepare', issuedAt),
              event: {
                proposalId: approved.proposal.id,
                eventType: 'proposal.prepared',
                occurredAt: issuedAt,
              },
            }),
        ),
      ).resolves.toBe('conflict');
    });

    const completionCases: ReadonlyArray<{
      readonly name: string;
      readonly mode: 'pre-dispatch' | 'post-dispatch';
      readonly completion: StoredProviderWriteCompletion['completion'];
    }> = [
      {
        name: 'pre-expired',
        mode: 'pre-dispatch',
        completion: {
          state: 'not-applied',
          application: 'not-applied',
          reason: 'approval-expired-before-dispatch',
          evidenceHash: '1'.repeat(64),
        },
      },
      {
        name: 'pre-policy-mismatch',
        mode: 'pre-dispatch',
        completion: {
          state: 'not-applied',
          application: 'not-applied',
          reason: 'approval-policy-mismatch',
          evidenceHash: '2'.repeat(64),
        },
      },
      {
        name: 'pre-provider-rejected',
        mode: 'pre-dispatch',
        completion: {
          state: 'not-applied',
          application: 'not-applied',
          reason: 'provider-rejected-before-apply',
          evidenceHash: '3'.repeat(64),
        },
      },
      {
        name: 'post-executed-valid',
        mode: 'post-dispatch',
        completion: {
          state: 'executed',
          application: 'applied',
          outputStatus: 'valid',
          resultHash: '4'.repeat(64),
          evidenceHash: '5'.repeat(64),
        },
      },
      {
        name: 'post-executed-invalid',
        mode: 'post-dispatch',
        completion: {
          state: 'executed',
          application: 'applied',
          outputStatus: 'invalid',
          safeErrorCode: 'provider-write-output-invalid',
          evidenceHash: '6'.repeat(64),
        },
      },
      {
        name: 'post-precondition-failed',
        mode: 'post-dispatch',
        completion: {
          state: 'not-applied',
          application: 'not-applied',
          reason: 'provider-precondition-failed',
          evidenceHash: '7'.repeat(64),
        },
      },
      {
        name: 'post-provider-rejected',
        mode: 'post-dispatch',
        completion: {
          state: 'not-applied',
          application: 'not-applied',
          reason: 'provider-rejected-before-apply',
          evidenceHash: '8'.repeat(64),
        },
      },
      ...(
        [
          'timeout-after-dispatch',
          'transport-lost-after-dispatch',
          'executor-threw-after-dispatch-boundary',
          'provider-outcome-envelope-invalid',
        ] as const
      ).map((reason, index) => ({
        name: `post-${reason}`,
        mode: 'post-dispatch' as const,
        completion: {
          state: 'indeterminate' as const,
          application: 'indeterminate' as const,
          reason,
          reconciliationRequired: true as const,
          evidenceHash: String(index + 9).padStart(64, '0'),
        },
      })),
    ];

    it.each(completionCases)(
      'commits $name exactly once and rejects semantic tamper plus stale CAS',
      async ({ name, mode, completion: outcome }) => {
        const marker = name.replaceAll(/[^A-Za-z0-9]/gu, '_');
        const lifecycle =
          mode === 'pre-dispatch'
            ? await prepareApproved(fixtureA, marker)
            : await dispatchPrepared(fixtureA, marker);
        const completion = completionRecord(
          outcome,
          lifecycle.authorization.approvalBindingHash,
        );
        const exact = await completeLifecycle(lifecycle, mode, completion);
        const commitWith = (
          transaction: ProposalRepositoryTransaction,
          input: typeof exact.input,
        ) =>
          mode === 'pre-dispatch'
            ? transaction.commitPreDispatchCompletion(input)
            : transaction.commitCompletion(input);

        await expect(
          repositoryFor(
            fixtureA,
            operationId(`completion_event_tamper_${marker}`),
          ).transaction((transaction) =>
            commitWith(transaction, {
              ...exact.input,
              event: {
                ...exact.input.event,
                occurredAt: isoOffset(2_000),
              },
            }),
          ),
        ).resolves.toBe('conflict');
        await expect(
          repositoryFor(
            fixtureA,
            operationId(`completion_hash_tamper_${marker}`),
          ).transaction((transaction) =>
            commitWith(transaction, {
              ...exact.input,
              completion: {
                ...exact.input.completion,
                completionHash: '0'.repeat(64),
              },
            }),
          ),
        ).resolves.toBe('conflict');
        await expect(
          repositoryFor(
            fixtureA,
            operationId(`completion_stale_cas_${marker}`),
          ).transaction((transaction) =>
            commitWith(transaction, {
              ...exact.input,
              expected: {
                ...exact.input.expected,
                version: exact.input.expected.version + 1,
              },
              next: ActionProposalSchema.parse({
                ...exact.input.next,
                version: exact.input.next.version + 1,
              }),
            }),
          ),
        ).resolves.toBe('conflict');

        await expect(
          repositoryFor(
            fixtureA,
            operationId(`completion_exact_${marker}`),
          ).transaction((transaction) => exact.commit(transaction)),
        ).resolves.toBe('created');
        await expect(
          repositoryFor(
            fixtureA,
            operationId(`completion_duplicate_${marker}`),
          ).transaction((transaction) => exact.commit(transaction)),
        ).resolves.toBe('duplicate');

        const stored = repositoryFor(
          fixtureA,
          operationId(`completion_read_${marker}`),
        );
        await expect(
          stored.getProposal(lifecycle.proposal.id),
        ).resolves.toEqual(exact.next);
        await expect(
          stored.transaction((transaction) =>
            transaction.getProviderWriteAttempt(lifecycle.decision.id),
          ),
        ).resolves.toMatchObject({
          proposalId: lifecycle.proposal.id,
          decisionId: lifecycle.decision.id,
          attemptState: outcome.state,
          completion,
        });
      },
    );
  },
);

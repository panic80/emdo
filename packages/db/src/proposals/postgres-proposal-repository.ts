import { createHash, randomBytes } from 'node:crypto';

import {
  ActionDecisionSchema,
  ActionProposalSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  OpaqueReferenceSchema,
  ProviderWriteAuthorizationSchema,
  SemanticVersionSchema,
  Sha256Schema,
  UuidSchema,
  deepFreeze,
  type ActionDecision,
  type ActionProposal,
  type ProviderWriteAuthorization,
} from '@emdo/contracts';
import { z } from 'zod';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import {
  DurableRepositoryError,
  beginDurableTransaction,
  firstResultRow,
  lockDurableScope,
  parseDurablePrincipal,
  type DurableRepositoryPrincipal,
} from '../durable/scoped-transaction.js';

const ProposalStateSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'prepared',
  'executing',
  'executed',
  'not-applied',
  'indeterminate',
  'expired',
  'failed',
]);

const WriteResultSchema = z.enum(['created', 'duplicate', 'conflict']);
export type ProposalRepositoryWriteResult = z.infer<typeof WriteResultSchema>;

const ProposalIdempotencyKeySchema = z
  .string()
  .min(16)
  .max(200)
  .regex(/^[A-Za-z0-9:._-]+$/u);

const ProposalActivityEventSchema = z.strictObject({
  proposalId: UuidSchema,
  eventType: z.enum([
    'proposal.created',
    'proposal.approved',
    'proposal.rejected',
    'proposal.expired',
    'proposal.prepared',
    'proposal.executing',
    'proposal.executed',
    'proposal.not-applied',
    'proposal.indeterminate',
    'proposal.failed',
  ]),
  occurredAt: IsoDateTimeSchema,
  decisionId: UuidSchema.optional(),
  actorUserId: UuidSchema.optional(),
  authenticatedSessionId: UuidSchema.optional(),
  approvalHash: Sha256Schema.optional(),
  decisionIdempotencyKey: ProposalIdempotencyKeySchema.optional(),
  application: z.enum(['applied', 'not-applied', 'indeterminate']).optional(),
  outcomeReason: z.string().trim().min(1).max(240).optional(),
  outputStatus: z.enum(['valid', 'invalid']).optional(),
  reconciliationRequired: z.literal(true).optional(),
  evidenceHash: Sha256Schema.optional(),
  providerIdempotencyKey: Sha256Schema.optional(),
  attemptId: UuidSchema.optional(),
  attemptVersion: z.number().int().positive().safe().optional(),
  resultHash: Sha256Schema.optional(),
  safeErrorCode: IdentifierSchema.optional(),
});

export type ProposalActivityEvent = Readonly<
  z.input<typeof ProposalActivityEventSchema>
>;

const ProposalPreparationBindingSchema = z.strictObject({
  proposalId: UuidSchema,
  originRequestId: UuidSchema,
  originSpaceAccessGrantId: UuidSchema,
  originSessionId: UuidSchema,
  runId: UuidSchema,
  householdId: UuidSchema,
  userId: UuidSchema,
  agentId: IdentifierSchema,
  disclosureGrantId: UuidSchema,
  disclosurePolicyVersion: SemanticVersionSchema,
  capabilityId: IdentifierSchema,
  sdkCallId: OpaqueReferenceSchema,
  providerAuthorityBindingHash: Sha256Schema,
});

const StoredProposalPreparationSchema = z.strictObject({
  binding: ProposalPreparationBindingSchema,
  bindingHash: Sha256Schema,
  abandonment: z
    .strictObject({
      reason: z.enum([
        'multiple-provider-writes-require-separate-turns',
        'execution-ended-before-checkpoint',
      ]),
      abandonedAt: IsoDateTimeSchema,
    })
    .optional(),
});

export type StoredProposalPreparation = Readonly<
  z.input<typeof StoredProposalPreparationSchema>
>;

export interface StoredDecision {
  readonly proposalId: string;
  readonly decision: ActionDecision;
}

export interface DurablePreparedProposalRecord {
  readonly proposal: ActionProposal;
  readonly preparation: StoredProposalPreparation;
}

export interface DurableDecisionProposalRecord extends DurablePreparedProposalRecord {
  readonly decision: StoredDecision;
}

const ProviderWriteCompletionSchema = z.union([
  z.strictObject({
    state: z.literal('executed'),
    application: z.literal('applied'),
    outputStatus: z.literal('valid'),
    resultHash: Sha256Schema,
    evidenceHash: Sha256Schema.optional(),
  }),
  z.strictObject({
    state: z.literal('executed'),
    application: z.literal('applied'),
    outputStatus: z.literal('invalid'),
    safeErrorCode: z.literal('provider-write-output-invalid'),
    evidenceHash: Sha256Schema.optional(),
  }),
  z.strictObject({
    state: z.literal('not-applied'),
    application: z.literal('not-applied'),
    reason: z.enum([
      'approval-expired-before-dispatch',
      'approval-policy-mismatch',
      'provider-precondition-failed',
      'provider-rejected-before-apply',
    ]),
    evidenceHash: Sha256Schema.optional(),
  }),
  z.strictObject({
    state: z.literal('indeterminate'),
    application: z.literal('indeterminate'),
    reason: z.enum([
      'timeout-after-dispatch',
      'transport-lost-after-dispatch',
      'executor-threw-after-dispatch-boundary',
      'provider-outcome-envelope-invalid',
    ]),
    reconciliationRequired: z.literal(true),
    evidenceHash: Sha256Schema.optional(),
  }),
]);

const StoredProviderWriteCompletionSchema = z.strictObject({
  completion: ProviderWriteCompletionSchema,
  bindingHash: Sha256Schema,
  completionHash: Sha256Schema,
  completedAt: IsoDateTimeSchema,
});

export type StoredProviderWriteCompletion = Readonly<
  z.input<typeof StoredProviderWriteCompletionSchema>
>;

const StoredProviderWriteAttemptSchema = z.strictObject({
  proposalId: UuidSchema,
  decisionId: UuidSchema,
  attemptState: z.enum([
    'prepared',
    'executing',
    'executed',
    'not-applied',
    'indeterminate',
  ]),
  bindingHash: Sha256Schema,
  authorization: ProviderWriteAuthorizationSchema,
  dispatchedAt: IsoDateTimeSchema.optional(),
  completion: StoredProviderWriteCompletionSchema.optional(),
  reconciliation: StoredProviderWriteCompletionSchema.optional(),
});

export interface StoredProviderWriteAttempt {
  readonly proposalId: string;
  readonly decisionId: string;
  readonly attemptState:
    'prepared' | 'executing' | 'executed' | 'not-applied' | 'indeterminate';
  readonly bindingHash: string;
  readonly authorization: ProviderWriteAuthorization;
  readonly dispatchedAt?: string;
  readonly completion?: StoredProviderWriteCompletion;
  readonly reconciliation?: StoredProviderWriteCompletion;
}

const ProposalExpectedRevisionSchema = z.strictObject({
  proposalId: UuidSchema,
  version: z.number().int().positive().safe(),
  state: ProposalStateSchema,
  approvalHash: Sha256Schema,
});

export interface ProposalExpectedRevision {
  readonly proposalId: string;
  readonly version: number;
  readonly state: ActionProposal['state'];
  readonly approvalHash: string;
}

const ProposalOperationScopeBaseSchema = z.strictObject({
  currentRequestId: UuidSchema,
  currentSpaceAccessGrantId: UuidSchema,
  currentSessionId: UuidSchema,
  runId: UuidSchema,
  householdId: UuidSchema,
  userId: UuidSchema,
  authorizationScopeFingerprint: Sha256Schema,
  disclosureGrantId: UuidSchema,
  disclosureGrantVersion: z.number().int().positive().safe(),
  disclosureGrantHash: Sha256Schema,
  proposalId: UuidSchema,
  providerSdkCallId: OpaqueReferenceSchema,
  activeAt: IsoDateTimeSchema,
  requireActiveDisclosureGrant: z.boolean(),
});

const ProposalOperationScopeAssertionSchema = z.discriminatedUnion('phase', [
  ProposalOperationScopeBaseSchema.extend({
    phase: z.literal('proposal-create'),
    requireActiveDisclosureGrant: z.literal(true),
  }),
  ProposalOperationScopeBaseSchema.extend({
    phase: z.enum([
      'visual-decision',
      'provider-write-prepare',
      'provider-write-dispatch',
    ]),
  }),
]);

export type ProposalOperationScopeAssertion = Readonly<
  z.input<typeof ProposalOperationScopeAssertionSchema>
>;

const ProposalIdempotencyLookupSchema = z.strictObject({
  householdId: UuidSchema,
  userId: UuidSchema,
  capabilityId: IdentifierSchema,
  idempotencyKey: ProposalIdempotencyKeySchema,
});

export interface ProposalIdempotencyLookup {
  readonly householdId: string;
  readonly userId: string;
  readonly capabilityId: string;
  readonly idempotencyKey: string;
}

const DecisionIdempotencyLookupSchema = z.strictObject({
  userId: UuidSchema,
  proposalId: UuidSchema,
  idempotencyKey: ProposalIdempotencyKeySchema,
});

const PreparedSdkBindingLookupSchema = z.strictObject({
  runId: UuidSchema,
  capabilityId: IdentifierSchema,
  providerSdkCallId: OpaqueReferenceSchema,
});

const ProposalDecisionLookupSchema = z.strictObject({
  proposalId: UuidSchema,
  decisionId: UuidSchema,
});

export interface DecisionIdempotencyLookup {
  readonly userId: string;
  readonly proposalId: string;
  readonly idempotencyKey: string;
}

interface ProposalRepositoryMutation {
  readonly expected: ProposalExpectedRevision;
  readonly next: ActionProposal;
  readonly event: ProposalActivityEvent;
}

export interface ProposalRepositoryTransaction {
  getProposal(id: string): Promise<ActionProposal | undefined>;
  findProposalByIdempotencyKey(
    lookup: ProposalIdempotencyLookup,
  ): Promise<ActionProposal | undefined>;
  getProposalPreparation(
    proposalId: string,
  ): Promise<StoredProposalPreparation | undefined>;
  getDecision(id: string): Promise<StoredDecision | undefined>;
  findDecisionByIdempotencyKey(
    lookup: DecisionIdempotencyLookup,
  ): Promise<StoredDecision | undefined>;
  getProviderWriteAttempt(
    decisionId: string,
  ): Promise<StoredProviderWriteAttempt | undefined>;
  insertProposal(input: {
    readonly proposal: ActionProposal;
    readonly preparation: StoredProposalPreparation;
    readonly scope: ProposalOperationScopeAssertion;
    readonly event: ProposalActivityEvent;
  }): Promise<ProposalRepositoryWriteResult>;
  abandonPrepared(
    input: ProposalRepositoryMutation & {
      readonly preparation: StoredProposalPreparation;
    },
  ): Promise<ProposalRepositoryWriteResult>;
  transitionProposal(
    input: ProposalRepositoryMutation,
  ): Promise<ProposalRepositoryWriteResult>;
  commitDecision(
    input: ProposalRepositoryMutation & {
      readonly decision: ActionDecision;
      readonly scope: ProposalOperationScopeAssertion;
    },
  ): Promise<ProposalRepositoryWriteResult>;
  prepareProviderWrite(
    input: ProposalRepositoryMutation & {
      readonly decisionId: string;
      readonly bindingHash: string;
      readonly authorization: ProviderWriteAuthorization;
      readonly scope: ProposalOperationScopeAssertion;
    },
  ): Promise<ProposalRepositoryWriteResult>;
  markDispatch(
    input: ProposalRepositoryMutation & {
      readonly decisionId: string;
      readonly bindingHash: string;
      readonly attemptId: string;
      readonly dispatchedAt: string;
      readonly scope: ProposalOperationScopeAssertion;
    },
  ): Promise<ProposalRepositoryWriteResult>;
  commitPreDispatchCompletion(
    input: ProposalRepositoryMutation & {
      readonly decisionId: string;
      readonly bindingHash: string;
      readonly attemptId: string;
      readonly completion: StoredProviderWriteCompletion;
    },
  ): Promise<ProposalRepositoryWriteResult>;
  commitCompletion(
    input: ProposalRepositoryMutation & {
      readonly decisionId: string;
      readonly bindingHash: string;
      readonly attemptId: string;
      readonly completion: StoredProviderWriteCompletion;
    },
  ): Promise<ProposalRepositoryWriteResult>;
  commitReconciliation(
    input: ProposalRepositoryMutation & {
      readonly decisionId: string;
      readonly bindingHash: string;
      readonly attemptId: string;
      readonly completion: StoredProviderWriteCompletion;
    },
  ): Promise<ProposalRepositoryWriteResult>;
}

export interface ProposalRepository {
  getProposal(id: string): Promise<ActionProposal | undefined>;
  listEvents(): Promise<readonly ProposalActivityEvent[]>;
  transaction<Result>(
    work: (transaction: ProposalRepositoryTransaction) => Promise<Result>,
  ): Promise<Result>;
}

const WorkflowOperationIdSchema = z
  .string()
  .min(32)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/u);

const VisualDecisionProofTokenSchema = z
  .string()
  .min(32)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/u);

export interface PostgresProposalRepositoryOptions {
  readonly readPool: DatabasePool;
  readonly workflowPool: DatabasePool;
  readonly principal: DurableRepositoryPrincipal;
  /** Test-only deterministic seam. Production uses a fresh 256-bit CSPRNG id. */
  readonly workflowOperationIdFactory?: () => string;
}

export class ProposalPersistenceError extends Error {
  constructor(
    readonly code:
      | 'authority-unavailable'
      | 'invalid-result'
      | 'transaction-closed'
      | 'multiple-mutations',
    message: string,
  ) {
    super(message);
    this.name = 'ProposalPersistenceError';
  }
}

const proposalSelect = `select pg_catalog.jsonb_build_object(
         'schemaVersion', proposal.schema_version,
         'id', proposal.id,
         'version', state.version,
         'runId', proposal.run_id,
         'capabilityId', proposal.capability_id,
         'capabilityFingerprint', proposal.capability_fingerprint,
         'authorizationScopeFingerprint', proposal.authorization_scope_fingerprint,
         'canonicalArguments', proposal.canonical_arguments,
         'targets', proposal.targets,
         'beforePreview', proposal.before_preview,
         'afterPreview', proposal.after_preview,
         'approvalDisplay', proposal.approval_display,
         'providerPreconditions', proposal.provider_preconditions,
         'providerAuthorityBindingHash', proposal.provider_authority_binding_hash,
         'providerSdkCallId', proposal.provider_sdk_call_id,
         'payloadHash', proposal.payload_hash,
         'approvalHash', proposal.approval_hash,
         'disclosureGrant', proposal.disclosure_grant,
         'createdAt', proposal.created_at,
         'expiresAt', proposal.expires_at,
         'idempotencyKey', proposal.idempotency_key,
         'state', state.state
       ) || case when proposal.guarded_action is null then '{}'::jsonb
                else pg_catalog.jsonb_build_object(
                  'guardedAction', proposal.guarded_action
                )
           end as proposal
  from emdo.action_proposals as proposal
  join emdo.proposal_states as state on state.proposal_id = proposal.id`;

const parseStored = <Result>(
  schema: z.ZodType<Result>,
  value: unknown,
  label: string,
): Result => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new DurableRepositoryError(
      'invalid-result',
      `Stored ${label} is malformed`,
    );
  }
  return deepFreeze(parsed.data) as unknown as Result;
};

const isoFromDatabase = (value: unknown): string =>
  new Date(
    IsoDateTimeSchema.parse(
      value instanceof Date ? value.toISOString() : value,
    ),
  ).toISOString();

const proposalFromRow = (
  row: Record<string, unknown> | undefined,
): ActionProposal | undefined => {
  if (row === undefined) return undefined;
  const proposal = parseStored(ActionProposalSchema, row.proposal, 'proposal');
  return deepFreeze({
    ...proposal,
    createdAt: isoFromDatabase(proposal.createdAt),
    expiresAt: isoFromDatabase(proposal.expiresAt),
  }) as ActionProposal;
};

const decisionFromValue = (value: unknown): ActionDecision => {
  const decision = parseStored(
    ActionDecisionSchema,
    value,
    'proposal decision',
  );
  return deepFreeze({
    ...decision,
    decidedAt: isoFromDatabase(decision.decidedAt),
  }) as ActionDecision;
};

const providerWriteAttemptFromValue = (
  value: unknown,
): StoredProviderWriteAttempt => {
  const attempt = parseStored(
    StoredProviderWriteAttemptSchema,
    value,
    'provider write attempt',
  );
  return deepFreeze({
    ...attempt,
    ...(attempt.completion === undefined
      ? {}
      : {
          completion: {
            ...attempt.completion,
            completedAt: isoFromDatabase(attempt.completion.completedAt),
          },
        }),
    ...(attempt.reconciliation === undefined
      ? {}
      : {
          reconciliation: {
            ...attempt.reconciliation,
            completedAt: isoFromDatabase(attempt.reconciliation.completedAt),
          },
        }),
  }) as unknown as StoredProviderWriteAttempt;
};

const getProposal = async (
  client: DatabaseClient,
  idInput: string,
): Promise<ActionProposal | undefined> => {
  const id = UuidSchema.parse(idInput);
  return proposalFromRow(
    firstResultRow(
      await client.query(`${proposalSelect}\n where proposal.id = $1`, [id]),
    ),
  );
};

const getProposalPreparation = async (
  client: DatabaseClient,
  proposalIdInput: string,
): Promise<StoredProposalPreparation | undefined> => {
  const proposalId = UuidSchema.parse(proposalIdInput);
  const row = firstResultRow(
    await client.query(
      `select pg_catalog.jsonb_build_object(
                'binding', preparation_binding,
                'bindingHash', preparation_binding_hash
              ) || case
                when abandonment_reason is null then '{}'::jsonb
                else pg_catalog.jsonb_build_object(
                  'abandonment', pg_catalog.jsonb_build_object(
                    'reason', abandonment_reason,
                    'abandonedAt', abandoned_at
                  )
                )
              end as preparation
         from emdo.proposal_preparations
        where proposal_id = $1`,
      [proposalId],
    ),
  );
  return row === undefined
    ? undefined
    : parseStored(
        StoredProposalPreparationSchema,
        row.preparation,
        'proposal preparation',
      );
};

const getDecision = async (
  client: DatabaseClient,
  idInput: string,
): Promise<StoredDecision | undefined> => {
  const id = UuidSchema.parse(idInput);
  const row = firstResultRow(
    await client.query(
      `select proposal_id,
              pg_catalog.jsonb_build_object(
                'schemaVersion', schema_version,
                'id', id,
                'proposalId', proposal_id,
                'userId', original_owner_user_id,
                'authenticatedSessionId', authenticated_session_id,
                'payloadHash', payload_hash,
                'approvalHash', approval_hash,
                'decision', decision,
                'channel', channel,
                'decidedAt', decided_at,
                'idempotencyKey', idempotency_key
              ) as decision
         from emdo.action_decisions
        where id = $1`,
      [id],
    ),
  );
  return row === undefined
    ? undefined
    : deepFreeze({
        proposalId: UuidSchema.parse(row.proposal_id),
        decision: decisionFromValue(row.decision),
      });
};

const getProviderWriteAttempt = async (
  client: DatabaseClient,
  decisionIdInput: string,
): Promise<StoredProviderWriteAttempt | undefined> => {
  const decisionId = UuidSchema.parse(decisionIdInput);
  const row = firstResultRow(
    await client.query(
      `select attempt.proposal_id, attempt.decision_id,
              attempt.attempt_state, attempt.binding_hash,
              attempt.authorization, attempt.dispatched_at,
              case when outcome.attempt_id is null then null
                else pg_catalog.jsonb_build_object(
                  'completion', outcome.completion,
                  'bindingHash', attempt.binding_hash,
                  'completionHash', outcome.completion_hash,
                  'completedAt', outcome.recorded_at
                ) end as completion,
              case when reconciliation.attempt_id is null then null
                else pg_catalog.jsonb_build_object(
                  'completion', reconciliation.completion,
                  'bindingHash', attempt.binding_hash,
                  'completionHash', reconciliation.completion_hash,
                  'completedAt', reconciliation.recorded_at
                ) end as reconciliation
         from emdo.provider_attempts as attempt
         left join emdo.provider_outcomes as outcome
           on outcome.attempt_id = attempt.id
         left join emdo.proposal_reconciliations as reconciliation
           on reconciliation.attempt_id = attempt.id
        where attempt.decision_id = $1`,
      [decisionId],
    ),
  );
  if (row === undefined) return undefined;
  return providerWriteAttemptFromValue({
    proposalId: row.proposal_id,
    decisionId: row.decision_id,
    attemptState: row.attempt_state,
    bindingHash: row.binding_hash,
    authorization: row.authorization,
    ...(row.dispatched_at === null || row.dispatched_at === undefined
      ? {}
      : { dispatchedAt: isoFromDatabase(row.dispatched_at) }),
    ...(row.completion === null || row.completion === undefined
      ? {}
      : { completion: row.completion }),
    ...(row.reconciliation === null || row.reconciliation === undefined
      ? {}
      : { reconciliation: row.reconciliation }),
  });
};

const rollbackQuietly = async (client: DatabaseClient | undefined) => {
  if (client === undefined) return;
  try {
    await client.query('rollback');
  } catch {
    // The original transaction error remains authoritative.
  }
};

const beginWorkflowTransaction = async (
  pool: DatabasePool,
  principal: Readonly<DurableRepositoryPrincipal>,
): Promise<DatabaseClient> => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local row_security = on');
    await client.query("set local statement_timeout = '30s'");
    await client.query("set local lock_timeout = '5s'");
    await client.query(
      `select set_config('emdo.user_id', $1, true),
              set_config('emdo.session_id', $2, true),
              set_config('emdo.request_id', $3, true)`,
      [principal.userId, principal.sessionId, principal.requestId],
    );
    return client;
  } catch (error) {
    await rollbackQuietly(client);
    client.release(true);
    throw error;
  }
};

const checkFunctionPrivileges = async (
  pool: DatabasePool,
  signatures: readonly string[],
): Promise<boolean> => {
  let client: DatabaseClient | undefined;
  try {
    client = await pool.connect();
    const row = firstResultRow(
      await client.query(
        `select coalesce(
                  pg_catalog.bool_and(
                    resolved.procedure_oid is not null
                    and pg_catalog.has_function_privilege(
                      current_user, resolved.procedure_oid, 'EXECUTE'
                    )
                  ),
                  false
                ) as ready
           from (
             select pg_catalog.to_regprocedure(required.signature)
                      as procedure_oid
               from pg_catalog.unnest($1::text[]) as required(signature)
           ) as resolved`,
        [signatures],
      ),
    );
    return row?.ready === true;
  } catch {
    return false;
  } finally {
    client?.release();
  }
};

const PROPOSAL_WORKFLOW_FUNCTIONS = Object.freeze([
  'emdo.commit_provider_proposal_create(text,jsonb)',
  'emdo.commit_provider_proposal_abandonment(jsonb)',
  'emdo.commit_provider_proposal_transition(jsonb)',
  'emdo.commit_provider_proposal_decision(text,jsonb)',
  'emdo.commit_provider_proposal_prepare(text,jsonb)',
  'emdo.commit_provider_proposal_dispatch(text,jsonb)',
  'emdo.commit_provider_proposal_completion(jsonb)',
]);

export const checkPostgresProposalWorkflowReadiness = (
  pool: DatabasePool,
): Promise<boolean> =>
  checkFunctionPrivileges(pool, PROPOSAL_WORKFLOW_FUNCTIONS);

const checkBooleanReadiness = async (
  pool: DatabasePool,
  sql: string,
): Promise<boolean> => {
  let client: DatabaseClient | undefined;
  let ready = false;
  try {
    client = await pool.connect();
    ready = firstResultRow(await client.query(sql))?.ready === true;
  } catch {
    ready = false;
  } finally {
    try {
      client?.release();
    } catch {
      ready = false;
    }
  }
  return ready;
};

const VISUAL_DECISION_API_READINESS_SQL = `
/* visual_decision_api_readiness */
select (
  session_user = 'emdo_api_login'
  and current_user = session_user
  and pg_catalog.pg_has_role(session_user, 'emdo_app', 'USAGE')
  and exists (
    select 1
      from pg_catalog.pg_roles as login
     where login.rolname = session_user
       and login.rolcanlogin
       and login.rolinherit
       and not login.rolsuper
       and not login.rolcreatedb
       and not login.rolcreaterole
       and not login.rolbypassrls
       and not login.rolreplication
  )
  and exists (
    select 1
      from pg_catalog.pg_auth_members as membership
      join pg_catalog.pg_roles as child on child.oid = membership.member
      join pg_catalog.pg_roles as parent on parent.oid = membership.roleid
     where child.rolname = session_user
       and parent.rolname = 'emdo_app'
       and membership.inherit_option
       and membership.set_option
       and not membership.admin_option
  )
  and not exists (
    select 1
      from pg_catalog.pg_auth_members as membership
      join pg_catalog.pg_roles as child on child.oid = membership.member
      join pg_catalog.pg_roles as parent on parent.oid = membership.roleid
     where (child.rolname = session_user and parent.rolname <> 'emdo_app')
        or parent.rolname = session_user
  )
  and pg_catalog.has_schema_privilege(session_user, 'emdo', 'USAGE')
  and not pg_catalog.has_schema_privilege(session_user, 'emdo', 'CREATE')
  and pg_catalog.to_regprocedure(
    'emdo.resolve_provider_proposal_decision_replay(uuid,uuid,text,text,uuid)'
  ) is not null
  and pg_catalog.has_function_privilege(
    session_user,
    'emdo.resolve_provider_proposal_decision_replay(uuid,uuid,text,text,uuid)',
    'EXECUTE'
  )
  and exists (
    select 1
      from pg_catalog.pg_proc as routine
      join pg_catalog.pg_roles as owner on owner.oid = routine.proowner
     where routine.oid = pg_catalog.to_regprocedure(
       'emdo.resolve_provider_proposal_decision_replay(uuid,uuid,text,text,uuid)'
     )
       and routine.prosecdef
       and owner.rolname = 'emdo_visual_proof_executor'
       and not owner.rolcanlogin
       and not owner.rolinherit
       and not owner.rolsuper
       and not owner.rolcreatedb
       and not owner.rolcreaterole
       and not owner.rolbypassrls
       and not owner.rolreplication
       and coalesce(routine.proconfig, array[]::text[])
             @> array['search_path=pg_catalog, emdo', 'row_security=on']::text[]
       and not exists (
         select 1
           from pg_catalog.pg_auth_members as membership
          where membership.member = owner.oid
             or membership.roleid = owner.oid
       )
       and not exists (
         select 1
           from pg_catalog.aclexplode(
             coalesce(
               routine.proacl,
               pg_catalog.acldefault('f', routine.proowner)
             )
           ) as acl
          where acl.grantee = 0
            and acl.privilege_type = 'EXECUTE'
       )
  )
  and not exists (
    select 1
      from pg_catalog.unnest(array[
        'emdo.action_proposals',
        'emdo.proposal_states',
        'emdo.proposal_preparations',
        'emdo.action_decisions'
      ]::text[]) as required(name)
      left join pg_catalog.pg_class as relation
        on relation.oid = pg_catalog.to_regclass(required.name)
     where relation.oid is null
        or not relation.relrowsecurity
        or not relation.relforcerowsecurity
        or not pg_catalog.has_table_privilege(
          session_user, relation.oid, 'SELECT'
        )
  )
) as ready`;

const VISUAL_DECISION_COMMIT_READINESS_SQL = `
/* visual_decision_commit_readiness */
select (
  session_user = 'emdo_visual_decision_login'
  and current_user = session_user
  and exists (
    select 1
      from pg_catalog.pg_roles as login
     where login.rolname = session_user
       and login.rolcanlogin
       and not login.rolinherit
       and not login.rolsuper
       and not login.rolcreatedb
       and not login.rolcreaterole
       and not login.rolbypassrls
       and not login.rolreplication
  )
  and not exists (
    select 1
      from pg_catalog.pg_auth_members as membership
      join pg_catalog.pg_roles as child on child.oid = membership.member
      join pg_catalog.pg_roles as parent on parent.oid = membership.roleid
     where child.rolname = session_user
        or parent.rolname = session_user
  )
  and pg_catalog.has_schema_privilege(session_user, 'emdo', 'USAGE')
  and not pg_catalog.has_schema_privilege(session_user, 'emdo', 'CREATE')
  and pg_catalog.to_regprocedure(
    'emdo.commit_provider_proposal_decision(text,jsonb)'
  ) is not null
  and pg_catalog.has_function_privilege(
    session_user, 'emdo.commit_provider_proposal_decision(text,jsonb)',
    'EXECUTE'
  )
  and exists (
    select 1
      from pg_catalog.pg_proc as routine
      join pg_catalog.pg_roles as owner on owner.oid = routine.proowner
     where routine.oid = pg_catalog.to_regprocedure(
       'emdo.commit_provider_proposal_decision(text,jsonb)'
     )
       and routine.prosecdef
       and owner.rolname = 'emdo_workflow_executor'
       and not owner.rolcanlogin
       and not owner.rolinherit
       and not owner.rolsuper
       and not owner.rolcreatedb
       and not owner.rolcreaterole
       and not owner.rolbypassrls
       and not owner.rolreplication
       and coalesce(routine.proconfig, array[]::text[])
             @> array['search_path=pg_catalog, emdo', 'row_security=on']::text[]
       and not exists (
         select 1
           from pg_catalog.pg_auth_members as membership
          where membership.member = owner.oid
             or membership.roleid = owner.oid
       )
       and not exists (
         select 1
           from pg_catalog.aclexplode(
             coalesce(
               routine.proacl,
               pg_catalog.acldefault('f', routine.proowner)
             )
           ) as acl
          where acl.grantee = 0
            and acl.privilege_type = 'EXECUTE'
       )
  )
  and not exists (
    select 1
      from pg_catalog.pg_proc as routine
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = routine.pronamespace
     where namespace.nspname = 'emdo'
       and routine.oid <> pg_catalog.to_regprocedure(
         'emdo.commit_provider_proposal_decision(text,jsonb)'
       )
       and pg_catalog.has_function_privilege(
         session_user, routine.oid, 'EXECUTE'
       )
  )
  and not exists (
    select 1
      from pg_catalog.pg_class as relation
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = relation.relnamespace
     where namespace.nspname = 'emdo'
       and relation.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
       and (
         (
           relation.relkind = 'S'
           and pg_catalog.has_sequence_privilege(
             session_user, relation.oid, 'USAGE,SELECT,UPDATE'
           )
         )
         or (
           relation.relkind <> 'S'
           and (
             pg_catalog.has_table_privilege(
               session_user, relation.oid,
               'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
             )
             or pg_catalog.has_any_column_privilege(
               session_user, relation.oid, 'SELECT,INSERT,UPDATE,REFERENCES'
             )
           )
         )
       )
  )
) as ready`;

export const checkPostgresVisualDecisionReadiness = async (
  readPool: DatabasePool,
  decisionPool: DatabasePool,
): Promise<boolean> => {
  const [readReady, decisionReady] = await Promise.all([
    checkBooleanReadiness(readPool, VISUAL_DECISION_API_READINESS_SQL),
    checkBooleanReadiness(decisionPool, VISUAL_DECISION_COMMIT_READINESS_SQL),
  ]);
  return readReady && decisionReady;
};

const writeResultFrom = (row: Record<string, unknown> | undefined) => {
  const parsed = WriteResultSchema.safeParse(row?.write_result);
  if (!parsed.success) {
    throw new ProposalPersistenceError(
      'invalid-result',
      'Proposal commit function returned an invalid result',
    );
  }
  return parsed.data;
};

type WorkflowAggregateInvocation =
  | Readonly<{
      signature: '(text,jsonb)';
      functionName: string;
      operationId: string;
      input: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      signature: '(jsonb)';
      functionName: string;
      input: Readonly<Record<string, unknown>>;
    }>;

const invokeWorkflowAggregate = async (
  client: DatabaseClient,
  invocation: WorkflowAggregateInvocation,
): Promise<ProposalRepositoryWriteResult> => {
  const result =
    invocation.signature === '(text,jsonb)'
      ? await client.query(
          `select emdo.${invocation.functionName}($1::text, $2::jsonb) as write_result`,
          [invocation.operationId, invocation.input],
        )
      : await client.query(
          `select emdo.${invocation.functionName}($1::jsonb) as write_result`,
          [invocation.input],
        );
  return writeResultFrom(firstResultRow(result));
};

const indeterminateWorkflowCommit = () =>
  new ProposalPersistenceError(
    'authority-unavailable',
    'The durable proposal commit outcome could not be proven',
  );

const validateMutation = (input: ProposalRepositoryMutation) =>
  deepFreeze({
    expected: ProposalExpectedRevisionSchema.parse(input.expected),
    next: ActionProposalSchema.parse(input.next),
    event: ProposalActivityEventSchema.parse(input.event),
  });

export class PostgresProposalRepository implements ProposalRepository {
  readonly #readPool: DatabasePool;
  readonly #workflowPool: DatabasePool;
  readonly #principal: Readonly<DurableRepositoryPrincipal>;
  readonly #workflowOperationIdFactory: () => string;
  #visualDecisionProofHash?: string;
  #visualDecisionSpaceAccessGrantId?: string;

  constructor(options: PostgresProposalRepositoryOptions) {
    this.#readPool = options.readPool;
    this.#workflowPool = options.workflowPool;
    this.#principal = parseDurablePrincipal(options.principal);
    this.#workflowOperationIdFactory =
      options.workflowOperationIdFactory ??
      (() => randomBytes(32).toString('base64url'));
  }

  withVisualDecisionProof(
    tokenInput: string,
    currentSpaceAccessGrantIdInput: string,
  ): ProposalRepository {
    const token = VisualDecisionProofTokenSchema.parse(tokenInput);
    const currentSpaceAccessGrantId = UuidSchema.parse(
      currentSpaceAccessGrantIdInput,
    );
    const clone = new PostgresProposalRepository({
      readPool: this.#readPool,
      workflowPool: this.#workflowPool,
      principal: this.#principal,
      workflowOperationIdFactory: this.#workflowOperationIdFactory,
    });
    clone.#visualDecisionProofHash = createHash('sha256')
      .update(token, 'utf8')
      .digest('hex');
    clone.#visualDecisionSpaceAccessGrantId = currentSpaceAccessGrantId;
    return clone;
  }

  async check(): Promise<boolean> {
    return checkPostgresProposalWorkflowReadiness(this.#workflowPool);
  }

  async getProposal(id: string): Promise<ActionProposal | undefined> {
    return this.transaction((transaction) => transaction.getProposal(id));
  }

  async listEvents(): Promise<readonly ProposalActivityEvent[]> {
    const client = await beginDurableTransaction(
      this.#readPool,
      this.#principal,
    );
    try {
      const result = await client.query(
        `select payload as event
           from emdo.proposal_events
          order by occurred_at, proposal_id, sequence`,
      );
      const events = Object.freeze(
        result.rows.map((row) =>
          parseStored(ProposalActivityEventSchema, row.event, 'proposal event'),
        ),
      );
      await client.query('commit');
      return events;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async resolvePreparedBySdkBinding(input: {
    readonly runId: string;
    readonly capabilityId: string;
    readonly providerSdkCallId: string;
  }): Promise<DurablePreparedProposalRecord | undefined> {
    const lookup = PreparedSdkBindingLookupSchema.parse(input);
    const client = await beginDurableTransaction(
      this.#readPool,
      this.#principal,
    );
    try {
      const candidate = firstResultRow(
        await client.query(
          `select proposal.id as proposal_id, proposal.space_id
             from emdo.action_proposals as proposal
            where proposal.household_id = $1
              and proposal.original_owner_user_id = $2
              and proposal.run_id = $3
              and proposal.capability_id = $4
              and proposal.provider_sdk_call_id = $5`,
          [
            this.#principal.householdId,
            this.#principal.userId,
            lookup.runId,
            lookup.capabilityId,
            lookup.providerSdkCallId,
          ],
        ),
      );
      if (candidate === undefined) {
        await client.query('commit');
        return undefined;
      }
      const proposalId = UuidSchema.parse(candidate.proposal_id);
      await lockDurableScope(client, {
        householdId: this.#principal.householdId,
        spaceId: UuidSchema.parse(candidate.space_id),
      });
      const storedProposal = await getProposal(client, proposalId);
      const storedPreparation = await getProposalPreparation(
        client,
        proposalId,
      );
      const result =
        storedProposal === undefined || storedPreparation === undefined
          ? undefined
          : deepFreeze({
              proposal: storedProposal,
              preparation: storedPreparation,
            });
      await client.query('commit');
      return result;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async resolveDecisionById(input: {
    readonly proposalId: string;
    readonly decisionId: string;
  }): Promise<DurableDecisionProposalRecord | undefined> {
    const lookup = ProposalDecisionLookupSchema.parse(input);
    const client = await beginDurableTransaction(
      this.#readPool,
      this.#principal,
    );
    try {
      const candidate = firstResultRow(
        await client.query(
          `select proposal.space_id
             from emdo.action_proposals as proposal
             join emdo.action_decisions as decision
               on decision.proposal_id = proposal.id
            where proposal.household_id = $1
              and proposal.original_owner_user_id = $2
              and proposal.id = $3
              and decision.id = $4`,
          [
            this.#principal.householdId,
            this.#principal.userId,
            lookup.proposalId,
            lookup.decisionId,
          ],
        ),
      );
      if (candidate === undefined) {
        await client.query('commit');
        return undefined;
      }
      await lockDurableScope(client, {
        householdId: this.#principal.householdId,
        spaceId: UuidSchema.parse(candidate.space_id),
      });
      const storedProposal = await getProposal(client, lookup.proposalId);
      const storedPreparation = await getProposalPreparation(
        client,
        lookup.proposalId,
      );
      const storedDecision = await getDecision(client, lookup.decisionId);
      const result =
        storedProposal === undefined ||
        storedPreparation === undefined ||
        storedDecision === undefined ||
        storedDecision.proposalId !== lookup.proposalId
          ? undefined
          : deepFreeze({
              proposal: storedProposal,
              preparation: storedPreparation,
              decision: storedDecision,
            });
      await client.query('commit');
      return result;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async resolveProviderWriteCompletionByDecisionId(input: {
    readonly proposalId: string;
    readonly decisionId: string;
  }): Promise<StoredProviderWriteAttempt | undefined> {
    const lookup = ProposalDecisionLookupSchema.parse(input);
    const client = await beginDurableTransaction(
      this.#readPool,
      this.#principal,
    );
    try {
      const candidate = firstResultRow(
        await client.query(
          `select proposal.space_id
             from emdo.action_proposals as proposal
             join emdo.action_decisions as decision
               on decision.proposal_id = proposal.id
             join emdo.provider_attempts as attempt
               on attempt.proposal_id = proposal.id
              and attempt.decision_id = decision.id
            where proposal.household_id = $1
              and proposal.original_owner_user_id = $2
              and proposal.id = $3
              and decision.id = $4`,
          [
            this.#principal.householdId,
            this.#principal.userId,
            lookup.proposalId,
            lookup.decisionId,
          ],
        ),
      );
      if (candidate === undefined) {
        await client.query('commit');
        return undefined;
      }
      await lockDurableScope(client, {
        householdId: this.#principal.householdId,
        spaceId: UuidSchema.parse(candidate.space_id),
      });
      const attempt = await getProviderWriteAttempt(client, lookup.decisionId);
      await client.query('commit');
      return attempt?.proposalId === lookup.proposalId ? attempt : undefined;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async transaction<Result>(
    work: (transaction: ProposalRepositoryTransaction) => Promise<Result>,
  ): Promise<Result> {
    const readClient = await beginDurableTransaction(
      this.#readPool,
      this.#principal,
    );
    let workflowClient: DatabaseClient | undefined;
    let active = true;
    let readClientReleased = false;
    let mutationCount = 0;
    let workflowOperationId: string | undefined;
    let workflowInvocation: WorkflowAggregateInvocation | undefined;

    const assertActive = () => {
      if (!active) {
        throw new Error('Proposal transaction is closed');
      }
    };
    const registerMutation = () => {
      mutationCount += 1;
      if (mutationCount > 1) {
        throw new ProposalPersistenceError(
          'multiple-mutations',
          'A proposal transaction may commit one aggregate mutation only',
        );
      }
    };
    const operationIdForMutation = () => {
      workflowOperationId ??= WorkflowOperationIdSchema.parse(
        this.#workflowOperationIdFactory(),
      );
      return workflowOperationId;
    };
    const authorityMutation = async (
      functionName: string,
      input: Readonly<Record<string, unknown>>,
    ): Promise<ProposalRepositoryWriteResult> => {
      assertActive();
      registerMutation();
      const operationId = operationIdForMutation();
      const invocation = Object.freeze({
        signature: '(text,jsonb)' as const,
        functionName,
        operationId,
        input,
      });
      workflowInvocation = invocation;
      workflowClient ??= await beginWorkflowTransaction(
        this.#workflowPool,
        this.#principal,
      );
      return invokeWorkflowAggregate(workflowClient, invocation);
    };
    const terminalMutation = async (
      functionName: string,
      input: Readonly<Record<string, unknown>>,
    ): Promise<ProposalRepositoryWriteResult> => {
      assertActive();
      registerMutation();
      const invocation = Object.freeze({
        signature: '(jsonb)' as const,
        functionName,
        input,
      });
      workflowInvocation = invocation;
      workflowClient ??= await beginWorkflowTransaction(
        this.#workflowPool,
        this.#principal,
      );
      return invokeWorkflowAggregate(workflowClient, invocation);
    };

    const transactionImplementation: ProposalRepositoryTransaction = {
      getProposal: async (id) => {
        assertActive();
        return getProposal(readClient, id);
      },
      findProposalByIdempotencyKey: async (lookupInput) => {
        assertActive();
        const lookup = ProposalIdempotencyLookupSchema.parse(lookupInput);
        return proposalFromRow(
          firstResultRow(
            await readClient.query(
              `${proposalSelect}
                where proposal.household_id = $1
                  and proposal.original_owner_user_id = $2
                  and proposal.capability_id = $3
                  and proposal.idempotency_key = $4`,
              [
                lookup.householdId,
                lookup.userId,
                lookup.capabilityId,
                lookup.idempotencyKey,
              ],
            ),
          ),
        );
      },
      getProposalPreparation: async (proposalIdInput) => {
        assertActive();
        const proposalId = UuidSchema.parse(proposalIdInput);
        const row = firstResultRow(
          await readClient.query(
            `select pg_catalog.jsonb_build_object(
                      'binding', preparation_binding,
                      'bindingHash', preparation_binding_hash
                    ) || case
                      when abandonment_reason is null then '{}'::jsonb
                      else pg_catalog.jsonb_build_object(
                        'abandonment', pg_catalog.jsonb_build_object(
                          'reason', abandonment_reason,
                          'abandonedAt', abandoned_at
                        )
                      )
                    end as preparation
               from emdo.proposal_preparations
              where proposal_id = $1`,
            [proposalId],
          ),
        );
        return row === undefined
          ? undefined
          : parseStored(
              StoredProposalPreparationSchema,
              row.preparation,
              'proposal preparation',
            );
      },
      getDecision: async (idInput) => {
        assertActive();
        const id = UuidSchema.parse(idInput);
        const row = firstResultRow(
          await readClient.query(
            `select proposal_id,
                    pg_catalog.jsonb_build_object(
                      'schemaVersion', schema_version,
                      'id', id,
                      'proposalId', proposal_id,
                      'userId', original_owner_user_id,
                      'authenticatedSessionId', authenticated_session_id,
                      'payloadHash', payload_hash,
                      'approvalHash', approval_hash,
                      'decision', decision,
                      'channel', channel,
                      'decidedAt', decided_at,
                      'idempotencyKey', idempotency_key
                    ) as decision
               from emdo.action_decisions
              where id = $1`,
            [id],
          ),
        );
        return row === undefined
          ? undefined
          : deepFreeze({
              proposalId: UuidSchema.parse(row.proposal_id),
              decision: parseStored(
                ActionDecisionSchema,
                row.decision,
                'proposal decision',
              ),
            });
      },
      findDecisionByIdempotencyKey: async (lookupInput) => {
        assertActive();
        const lookup = DecisionIdempotencyLookupSchema.parse(lookupInput);
        if (
          lookup.userId !== this.#principal.userId ||
          this.#visualDecisionProofHash === undefined ||
          this.#visualDecisionSpaceAccessGrantId === undefined
        ) {
          return undefined;
        }
        const row = firstResultRow(
          await readClient.query(
            `select emdo.resolve_provider_proposal_decision_replay(
                      $1, $2, $3, $4, $5
                    ) as replay`,
            [
              lookup.userId,
              lookup.proposalId,
              lookup.idempotencyKey,
              this.#visualDecisionProofHash,
              this.#visualDecisionSpaceAccessGrantId,
            ],
          ),
        );
        const replay = row?.replay;
        if (
          replay === null ||
          typeof replay !== 'object' ||
          Array.isArray(replay)
        ) {
          return undefined;
        }
        const stored = replay as Record<string, unknown>;
        return stored.decision === undefined
          ? undefined
          : deepFreeze({
              proposalId: UuidSchema.parse(stored.proposalId),
              decision: decisionFromValue(stored.decision),
            });
      },
      getProviderWriteAttempt: async (decisionIdInput) => {
        assertActive();
        const decisionId = UuidSchema.parse(decisionIdInput);
        const row = firstResultRow(
          await readClient.query(
            `select attempt.proposal_id, attempt.decision_id,
                    attempt.attempt_state, attempt.binding_hash,
                    attempt.authorization, attempt.dispatched_at,
                    case when outcome.attempt_id is null then null
                      else pg_catalog.jsonb_build_object(
                        'completion', outcome.completion,
                        'bindingHash', attempt.binding_hash,
                        'completionHash', outcome.completion_hash,
                        'completedAt', outcome.recorded_at
                      ) end as completion,
                    case when reconciliation.attempt_id is null then null
                      else pg_catalog.jsonb_build_object(
                        'completion', reconciliation.completion,
                        'bindingHash', attempt.binding_hash,
                        'completionHash', reconciliation.completion_hash,
                        'completedAt', reconciliation.recorded_at
                      ) end as reconciliation
               from emdo.provider_attempts as attempt
               left join emdo.provider_outcomes as outcome
                 on outcome.attempt_id = attempt.id
               left join emdo.proposal_reconciliations as reconciliation
                 on reconciliation.attempt_id = attempt.id
              where attempt.decision_id = $1`,
            [decisionId],
          ),
        );
        if (row === undefined) return undefined;
        return providerWriteAttemptFromValue({
          proposalId: row.proposal_id,
          decisionId: row.decision_id,
          attemptState: row.attempt_state,
          bindingHash: row.binding_hash,
          authorization: row.authorization,
          ...(row.dispatched_at === null || row.dispatched_at === undefined
            ? {}
            : { dispatchedAt: isoFromDatabase(row.dispatched_at) }),
          ...(row.completion === null || row.completion === undefined
            ? {}
            : { completion: row.completion }),
          ...(row.reconciliation === null || row.reconciliation === undefined
            ? {}
            : { reconciliation: row.reconciliation }),
        });
      },
      insertProposal: async (input) => {
        assertActive();
        const parsedProposal = ActionProposalSchema.parse(input.proposal);
        const parsedPreparation = StoredProposalPreparationSchema.parse(
          input.preparation,
        );
        const parsedScope = ProposalOperationScopeAssertionSchema.parse(
          input.scope,
        );
        const parsedEvent = ProposalActivityEventSchema.parse(input.event);
        return authorityMutation('commit_provider_proposal_create', {
          proposal: parsedProposal,
          preparation: parsedPreparation,
          scope: parsedScope,
          event: parsedEvent,
        });
      },
      abandonPrepared: async (input) => {
        const mutation = validateMutation(input);
        const preparation = StoredProposalPreparationSchema.parse(
          input.preparation,
        );
        return terminalMutation('commit_provider_proposal_abandonment', {
          expected: mutation.expected,
          next: mutation.next,
          preparation,
          event: mutation.event,
        });
      },
      transitionProposal: async (input) => {
        const mutation = validateMutation(input);
        return terminalMutation('commit_provider_proposal_transition', {
          expected: mutation.expected,
          next: mutation.next,
          event: mutation.event,
        });
      },
      commitDecision: async (input) => {
        const mutation = validateMutation(input);
        const decision = ActionDecisionSchema.parse(input.decision);
        const scope = ProposalOperationScopeAssertionSchema.parse(input.scope);
        if (
          this.#visualDecisionProofHash === undefined ||
          this.#visualDecisionSpaceAccessGrantId === undefined ||
          scope.currentSpaceAccessGrantId !==
            this.#visualDecisionSpaceAccessGrantId
        ) {
          return 'conflict';
        }
        return authorityMutation('commit_provider_proposal_decision', {
          expected: mutation.expected,
          next: mutation.next,
          decision,
          scope,
          event: mutation.event,
          visualDecisionProofHash: this.#visualDecisionProofHash,
        });
      },
      prepareProviderWrite: async (input) => {
        const mutation = validateMutation(input);
        const decisionId = UuidSchema.parse(input.decisionId);
        const bindingHash = Sha256Schema.parse(input.bindingHash);
        const authorization = ProviderWriteAuthorizationSchema.parse(
          input.authorization,
        );
        const scope = ProposalOperationScopeAssertionSchema.parse(input.scope);
        return authorityMutation('commit_provider_proposal_prepare', {
          expected: mutation.expected,
          next: mutation.next,
          decisionId,
          bindingHash,
          authorization,
          approvalBinding: authorization.approvalBinding,
          scope,
          event: mutation.event,
        });
      },
      markDispatch: async (input) => {
        const mutation = validateMutation(input);
        const decisionId = UuidSchema.parse(input.decisionId);
        const bindingHash = Sha256Schema.parse(input.bindingHash);
        const attemptId = UuidSchema.parse(input.attemptId);
        const dispatchedAt = IsoDateTimeSchema.parse(input.dispatchedAt);
        const scope = ProposalOperationScopeAssertionSchema.parse(input.scope);
        return authorityMutation('commit_provider_proposal_dispatch', {
          expected: mutation.expected,
          next: mutation.next,
          decisionId,
          bindingHash,
          attemptId,
          dispatchedAt,
          scope,
          event: mutation.event,
        });
      },
      commitPreDispatchCompletion: async (input) => {
        const mutation = validateMutation(input);
        return terminalMutation('commit_provider_proposal_completion', {
          mode: 'pre-dispatch',
          expected: mutation.expected,
          next: mutation.next,
          decisionId: UuidSchema.parse(input.decisionId),
          bindingHash: Sha256Schema.parse(input.bindingHash),
          attemptId: UuidSchema.parse(input.attemptId),
          completion: StoredProviderWriteCompletionSchema.parse(
            input.completion,
          ),
          event: mutation.event,
        });
      },
      commitCompletion: async (input) => {
        const mutation = validateMutation(input);
        return terminalMutation('commit_provider_proposal_completion', {
          mode: 'post-dispatch',
          expected: mutation.expected,
          next: mutation.next,
          decisionId: UuidSchema.parse(input.decisionId),
          bindingHash: Sha256Schema.parse(input.bindingHash),
          attemptId: UuidSchema.parse(input.attemptId),
          completion: StoredProviderWriteCompletionSchema.parse(
            input.completion,
          ),
          event: mutation.event,
        });
      },
      commitReconciliation: async (input) => {
        assertActive();
        validateMutation(input);
        registerMutation();
        return 'conflict';
      },
    };
    const transaction = Object.freeze(transactionImplementation);

    try {
      const result = await work(transaction);
      active = false;
      try {
        await readClient.query('commit');
      } catch (error) {
        readClient.release(true);
        readClientReleased = true;
        throw error;
      }
      if (workflowClient !== undefined) {
        try {
          await workflowClient.query('commit');
        } catch {
          workflowClient.release(true);
          workflowClient = undefined;
          if (workflowInvocation === undefined) {
            throw indeterminateWorkflowCommit();
          }

          let replayClient: DatabaseClient | undefined;
          let replayCommitted = false;
          try {
            replayClient = await beginWorkflowTransaction(
              this.#workflowPool,
              this.#principal,
            );
            let replayResult: ProposalRepositoryWriteResult;
            try {
              replayResult = await invokeWorkflowAggregate(
                replayClient,
                workflowInvocation,
              );
            } catch {
              throw indeterminateWorkflowCommit();
            }
            if (replayResult !== 'duplicate') {
              await rollbackQuietly(replayClient);
              throw indeterminateWorkflowCommit();
            }
            try {
              await replayClient.query('commit');
              replayCommitted = true;
            } catch {
              throw indeterminateWorkflowCommit();
            }
          } catch {
            throw indeterminateWorkflowCommit();
          } finally {
            replayClient?.release(!replayCommitted);
          }
        }
      }
      return result;
    } catch (error) {
      active = false;
      await rollbackQuietly(workflowClient);
      if (!readClientReleased) {
        await rollbackQuietly(readClient);
      }
      throw error;
    } finally {
      workflowClient?.release();
      if (!readClientReleased) {
        readClient.release();
      }
    }
  }
}

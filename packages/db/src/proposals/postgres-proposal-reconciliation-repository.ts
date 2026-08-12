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
  type ActionProposal,
} from '@emdo/contracts';
import type {
  ProposalActivityEvent,
  ProposalRepository,
  ProposalRepositoryTransaction,
  ProposalRepositoryWriteResult,
  StoredDecision,
} from '@emdo/domains/server/provider-proposals';
import { z } from 'zod';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import { firstResultRow } from '../durable/scoped-transaction.js';
import {
  DurableWorkerExecutionPermitSchema,
  WORKER_JOB_NAMES,
  WorkerPersistenceError,
  withWorkerOperationTransaction,
  type DurableWorkerExecutionPermit,
} from '../worker/scope.js';
type ReconciliationCommitInput = Parameters<
  ProposalRepositoryTransaction['commitReconciliation']
>[0];
type ProposalIdempotencyLookup = Parameters<
  ProposalRepositoryTransaction['findProposalByIdempotencyKey']
>[0];
type DecisionIdempotencyLookup = Parameters<
  ProposalRepositoryTransaction['findDecisionByIdempotencyKey']
>[0];

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

const ProposalPreparationBindingSchema = z.strictObject({
  proposalId: UuidSchema,
  originRequestId: UuidSchema,
  runId: UuidSchema,
  householdId: UuidSchema,
  userId: UuidSchema,
  originSessionId: UuidSchema,
  agentId: IdentifierSchema,
  originSpaceAccessGrantId: UuidSchema,
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

const ProposalExpectedRevisionSchema = z.strictObject({
  proposalId: UuidSchema,
  version: z.number().int().positive().safe(),
  state: ProposalStateSchema,
  approvalHash: Sha256Schema,
});

const ReconciliationCommitSchema = z.strictObject({
  expected: ProposalExpectedRevisionSchema,
  next: ActionProposalSchema,
  decisionId: UuidSchema,
  bindingHash: Sha256Schema,
  attemptId: UuidSchema,
  completion: StoredProviderWriteCompletionSchema,
  event: ProposalActivityEventSchema,
});

type ParsedReconciliationCommit = z.output<typeof ReconciliationCommitSchema>;

const isSemanticallyBoundReconciliation = (
  commit: ParsedReconciliationCommit,
): boolean => {
  const completion = commit.completion.completion;
  if (
    completion.state === 'indeterminate' ||
    (completion.state === 'not-applied' &&
      (completion.reason === 'approval-expired-before-dispatch' ||
        completion.reason === 'approval-policy-mismatch'))
  ) {
    return false;
  }
  const event = commit.event;
  const outcomeReason = 'reason' in completion ? completion.reason : undefined;
  const outputStatus =
    'outputStatus' in completion ? completion.outputStatus : undefined;
  const reconciliationRequired =
    'reconciliationRequired' in completion
      ? completion.reconciliationRequired
      : undefined;
  const evidenceHash =
    'evidenceHash' in completion ? completion.evidenceHash : undefined;
  const resultHash =
    'resultHash' in completion ? completion.resultHash : undefined;
  const safeErrorCode =
    'safeErrorCode' in completion ? completion.safeErrorCode : undefined;
  return (
    commit.attemptId === event.attemptId &&
    commit.decisionId === event.decisionId &&
    commit.expected.approvalHash === commit.next.approvalHash &&
    commit.expected.approvalHash === event.approvalHash &&
    event.eventType === `proposal.${completion.state}` &&
    event.occurredAt === commit.completion.completedAt &&
    event.application === completion.application &&
    event.outcomeReason === outcomeReason &&
    event.outputStatus === outputStatus &&
    event.reconciliationRequired === reconciliationRequired &&
    event.evidenceHash === evidenceHash &&
    event.resultHash === resultHash &&
    event.safeErrorCode === safeErrorCode
  );
};

const ProposalIdempotencyLookupSchema = z.strictObject({
  householdId: UuidSchema,
  userId: UuidSchema,
  capabilityId: IdentifierSchema,
  idempotencyKey: ProposalIdempotencyKeySchema,
});

const DecisionIdempotencyLookupSchema = z.strictObject({
  userId: UuidSchema,
  proposalId: UuidSchema,
  idempotencyKey: ProposalIdempotencyKeySchema,
});

const WriteResultSchema = z.enum(['created', 'duplicate', 'conflict']);

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
       ) as proposal
  from emdo.action_proposals as proposal
  join emdo.proposal_states as state on state.proposal_id = proposal.id
  join emdo.provider_attempts as bounded_attempt
    on bounded_attempt.proposal_id = proposal.id`;

const parseStored = <Result>(
  schema: z.ZodType<Result>,
  value: unknown,
  label: string,
): Result => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new WorkerPersistenceError(
      'invalid-result',
      `Stored ${label} is malformed`,
    );
  }
  return deepFreeze(parsed.data) as Result;
};

const proposalFromRow = (
  row: Record<string, unknown> | undefined,
): ActionProposal | undefined =>
  row === undefined
    ? undefined
    : parseStored(ActionProposalSchema, row.proposal, 'proposal');

const asIsoDateTime = (value: unknown): unknown =>
  value instanceof Date ? value.toISOString() : value;

const writeResultFrom = (
  row: Record<string, unknown> | undefined,
): ProposalRepositoryWriteResult => {
  const parsed = WriteResultSchema.safeParse(row?.write_result);
  if (!parsed.success) {
    throw new WorkerPersistenceError(
      'invalid-result',
      'Proposal reconciliation commit returned an invalid result',
    );
  }
  return parsed.data;
};

export interface PostgresProposalReconciliationRepositoryOptions {
  readonly workerPool: DatabasePool;
  readonly execution: DurableWorkerExecutionPermit;
  readonly providerAttemptId: string;
}

/**
 * Worker-only ProposalRepository facade. Its single activated scope is bound
 * to one deterministic reconciliation lease and one provider attempt.
 */
export class PostgresProposalReconciliationRepository implements ProposalRepository {
  readonly #workerPool: DatabasePool;
  readonly #execution: DurableWorkerExecutionPermit;
  readonly #providerAttemptId: string;

  constructor(options: PostgresProposalReconciliationRepositoryOptions) {
    const execution = DurableWorkerExecutionPermitSchema.safeParse(
      options.execution,
    );
    const providerAttemptId = UuidSchema.safeParse(options.providerAttemptId);
    if (
      !execution.success ||
      execution.data.jobName !== WORKER_JOB_NAMES.calendarReconciliation ||
      !providerAttemptId.success
    ) {
      throw new WorkerPersistenceError(
        'invalid-input',
        'Expected an exact provider attempt and reconciliation worker permit',
      );
    }
    this.#workerPool = options.workerPool;
    this.#execution = deepFreeze(execution.data);
    this.#providerAttemptId = providerAttemptId.data;
    Object.freeze(this);
  }

  async getProposal(id: string): Promise<ActionProposal | undefined> {
    return this.transaction((transaction) => transaction.getProposal(id));
  }

  async listEvents(): Promise<readonly ProposalActivityEvent[]> {
    return this.#withWorkerScope(async (client) => {
      const result = await client.query(
        `select event.payload as event
           from emdo.proposal_events as event
           join emdo.provider_attempts as bounded_attempt
             on bounded_attempt.proposal_id = event.proposal_id
          where bounded_attempt.id = $1
          order by event.occurred_at, event.id`,
        [this.#providerAttemptId],
      );
      return Object.freeze(
        result.rows.map((row) =>
          parseStored(ProposalActivityEventSchema, row.event, 'proposal event'),
        ),
      );
    });
  }

  async transaction<Result>(
    work: (transaction: ProposalRepositoryTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.#withWorkerScope(async (client) => {
      let active = true;
      let reconciliationAttempted = false;

      const assertActive = () => {
        if (!active) {
          throw new WorkerPersistenceError(
            'operation-unavailable',
            'Proposal reconciliation transaction is closed',
          );
        }
      };
      const failClosed = async (): Promise<ProposalRepositoryWriteResult> => {
        assertActive();
        return 'conflict';
      };

      const transactionImplementation: ProposalRepositoryTransaction = {
        getProposal: async (idInput: string) => {
          assertActive();
          const id = UuidSchema.parse(idInput);
          return proposalFromRow(
            firstResultRow(
              await client.query(
                `${proposalSelect}
                  where bounded_attempt.id = $1 and proposal.id = $2`,
                [this.#providerAttemptId, id],
              ),
            ),
          );
        },
        findProposalByIdempotencyKey: async (
          lookupInput: ProposalIdempotencyLookup,
        ) => {
          assertActive();
          const lookup = ProposalIdempotencyLookupSchema.parse(lookupInput);
          return proposalFromRow(
            firstResultRow(
              await client.query(
                `${proposalSelect}
                  where bounded_attempt.id = $1
                    and proposal.household_id = $2
                    and proposal.original_owner_user_id = $3
                    and proposal.capability_id = $4
                    and proposal.idempotency_key = $5`,
                [
                  this.#providerAttemptId,
                  lookup.householdId,
                  lookup.userId,
                  lookup.capabilityId,
                  lookup.idempotencyKey,
                ],
              ),
            ),
          );
        },
        getProposalPreparation: async (proposalIdInput: string) => {
          assertActive();
          const proposalId = UuidSchema.parse(proposalIdInput);
          const row = firstResultRow(
            await client.query(
              `select pg_catalog.jsonb_build_object(
                        'binding', preparation.preparation_binding,
                        'bindingHash', preparation.preparation_binding_hash
                      ) || case
                        when preparation.abandonment_reason is null
                          then '{}'::jsonb
                        else pg_catalog.jsonb_build_object(
                          'abandonment', pg_catalog.jsonb_build_object(
                            'reason', preparation.abandonment_reason,
                            'abandonedAt', preparation.abandoned_at
                          )
                        )
                      end as preparation
                 from emdo.proposal_preparations as preparation
                 join emdo.provider_attempts as bounded_attempt
                   on bounded_attempt.proposal_id = preparation.proposal_id
                where bounded_attempt.id = $1
                  and preparation.proposal_id = $2`,
              [this.#providerAttemptId, proposalId],
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
        getDecision: async (idInput: string) => {
          assertActive();
          const id = UuidSchema.parse(idInput);
          const row = firstResultRow(
            await client.query(
              `select decision.proposal_id,
                      pg_catalog.jsonb_build_object(
                        'schemaVersion', decision.schema_version,
                        'id', decision.id,
                        'proposalId', decision.proposal_id,
                        'userId', decision.original_owner_user_id,
                        'authenticatedSessionId', decision.authenticated_session_id,
                        'payloadHash', decision.payload_hash,
                        'approvalHash', decision.approval_hash,
                        'decision', decision.decision,
                        'channel', decision.channel,
                        'decidedAt', decision.decided_at,
                        'idempotencyKey', decision.idempotency_key
                      ) as decision
                 from emdo.action_decisions as decision
                 join emdo.provider_attempts as bounded_attempt
                   on bounded_attempt.decision_id = decision.id
                where bounded_attempt.id = $1 and decision.id = $2`,
              [this.#providerAttemptId, id],
            ),
          );
          return row === undefined
            ? undefined
            : deepFreeze<StoredDecision>({
                proposalId: UuidSchema.parse(row.proposal_id),
                decision: parseStored(
                  ActionDecisionSchema,
                  row.decision,
                  'proposal decision',
                ),
              });
        },
        findDecisionByIdempotencyKey: async (
          lookupInput: DecisionIdempotencyLookup,
        ) => {
          assertActive();
          const lookup = DecisionIdempotencyLookupSchema.parse(lookupInput);
          const row = firstResultRow(
            await client.query(
              `select decision.proposal_id,
                      pg_catalog.jsonb_build_object(
                        'schemaVersion', decision.schema_version,
                        'id', decision.id,
                        'proposalId', decision.proposal_id,
                        'userId', decision.original_owner_user_id,
                        'authenticatedSessionId', decision.authenticated_session_id,
                        'payloadHash', decision.payload_hash,
                        'approvalHash', decision.approval_hash,
                        'decision', decision.decision,
                        'channel', decision.channel,
                        'decidedAt', decision.decided_at,
                        'idempotencyKey', decision.idempotency_key
                      ) as decision
                 from emdo.action_decisions as decision
                 join emdo.provider_attempts as bounded_attempt
                   on bounded_attempt.decision_id = decision.id
                where bounded_attempt.id = $1
                  and decision.original_owner_user_id = $2
                  and decision.proposal_id = $3
                  and decision.idempotency_key = $4`,
              [
                this.#providerAttemptId,
                lookup.userId,
                lookup.proposalId,
                lookup.idempotencyKey,
              ],
            ),
          );
          return row === undefined
            ? undefined
            : deepFreeze<StoredDecision>({
                proposalId: UuidSchema.parse(row.proposal_id),
                decision: parseStored(
                  ActionDecisionSchema,
                  row.decision,
                  'proposal decision',
                ),
              });
        },
        getProviderWriteAttempt: async (decisionIdInput: string) => {
          assertActive();
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
                where attempt.id = $1 and attempt.decision_id = $2`,
              [this.#providerAttemptId, decisionId],
            ),
          );
          if (row === undefined) return undefined;
          return parseStored(
            StoredProviderWriteAttemptSchema,
            {
              proposalId: row.proposal_id,
              decisionId: row.decision_id,
              attemptState: row.attempt_state,
              bindingHash: row.binding_hash,
              authorization: row.authorization,
              ...(row.dispatched_at === null || row.dispatched_at === undefined
                ? {}
                : { dispatchedAt: asIsoDateTime(row.dispatched_at) }),
              ...(row.completion === null || row.completion === undefined
                ? {}
                : { completion: row.completion }),
              ...(row.reconciliation === null ||
              row.reconciliation === undefined
                ? {}
                : { reconciliation: row.reconciliation }),
            },
            'provider write attempt',
          );
        },
        insertProposal: failClosed,
        abandonPrepared: failClosed,
        transitionProposal: failClosed,
        commitDecision: failClosed,
        prepareProviderWrite: failClosed,
        markDispatch: failClosed,
        commitPreDispatchCompletion: failClosed,
        commitCompletion: failClosed,
        commitReconciliation: async (input: ReconciliationCommitInput) => {
          assertActive();
          if (reconciliationAttempted) return 'conflict';
          reconciliationAttempted = true;
          const parsed = ReconciliationCommitSchema.safeParse(input);
          if (!parsed.success) return 'conflict';
          const commit = parsed.data;
          if (
            commit.attemptId !== this.#providerAttemptId ||
            commit.expected.proposalId !== commit.next.id ||
            commit.event.proposalId !== commit.next.id ||
            commit.bindingHash !== commit.completion.bindingHash ||
            commit.next.version !== commit.expected.version + 1 ||
            commit.expected.state !== 'indeterminate' ||
            commit.next.state !== commit.completion.completion.state ||
            !isSemanticallyBoundReconciliation(commit)
          ) {
            return 'conflict';
          }
          return writeResultFrom(
            firstResultRow(
              await client.query(
                'select emdo.commit_provider_proposal_reconciliation($1::jsonb) as write_result',
                [deepFreeze(commit)],
              ),
            ),
          );
        },
      };
      const transaction = Object.freeze(transactionImplementation);

      try {
        return await work(transaction);
      } finally {
        active = false;
      }
    });
  }

  async #withWorkerScope<Result>(
    work: (client: DatabaseClient) => Promise<Result>,
  ): Promise<Result> {
    return withWorkerOperationTransaction(
      this.#workerPool,
      {
        execution: this.#execution,
        targetType: 'provider-attempt',
        targetId: this.#providerAttemptId,
      },
      work,
    );
  }
}

import {
  AgentInvocationContextSchema,
  ActionDecisionRequestSchema,
  ActionDecisionSchema,
  EffectiveAuthorizationScopeFingerprintSchema,
  IdentifierSchema,
  JsonValueSchema,
  ModelResolutionSchema,
  OpaqueReferenceSchema,
  ReviewedActionSchema,
  Sha256Schema,
  UuidSchema,
  deepFreeze,
  type ActionDecision,
  type EffectiveAuthorizationScopeFingerprint,
  type JsonValue,
} from '@emdo/contracts';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { DatabasePool } from '../scoped-repository.js';
import {
  firstResultRow,
  withClaimedTransaction,
} from '../durable/scoped-transaction.js';
import { checkDatabaseFunctionPrivileges } from '../proposals/database-function-readiness.js';

const InterruptionIdSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/u);
const DisclosureGrantVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
const TerminalEventSequenceSchema = z.number().int().positive().safe();

const PrincipalSchema = z.strictObject({
  userId: UuidSchema,
  sessionId: UuidSchema,
  householdId: UuidSchema,
  role: z.enum(['owner', 'member']),
  emailVerified: z.literal(true),
  spaceAccessGrantId: UuidSchema,
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema,
});

const ApprovalResumeBindingSchema = z.strictObject({
  turnRequestId: UuidSchema,
  runId: UuidSchema,
  rootManagerInvocationId: UuidSchema,
  conversationId: UuidSchema,
  checkpointId: UuidSchema,
  interruptionId: InterruptionIdSchema,
  proposalId: UuidSchema,
  approvalDecisionId: UuidSchema,
  decision: z.enum(['approve', 'reject']),
  householdId: UuidSchema,
  userId: UuidSchema,
  authenticatedSessionId: UuidSchema,
  spaceAccessGrantId: UuidSchema,
  disclosureGrantId: UuidSchema,
  disclosureGrantVersion: DisclosureGrantVersionSchema,
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema,
  authorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprintSchema,
  payloadHash: Sha256Schema,
  approvalHash: Sha256Schema,
});

const ClaimResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('claimed'),
    claimId: OpaqueReferenceSchema,
    ownershipToken: OpaqueReferenceSchema,
    binding: ApprovalResumeBindingSchema,
  }),
  z.strictObject({
    status: z.literal('in-progress'),
    runId: UuidSchema,
  }),
  z.strictObject({
    status: z.literal('terminal-replay'),
    runId: UuidSchema,
    terminalEventSequence: TerminalEventSequenceSchema,
  }),
]);

const CompletionResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.enum(['completed', 'terminalized', 'indeterminate', 'replay']),
    terminalEventSequence: TerminalEventSequenceSchema,
  }),
  z.strictObject({ status: z.literal('conflict') }),
]);

const AgentUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative().safe(),
  outputTokens: z.number().int().nonnegative().safe(),
  modelCostCadMinor: z.number().int().nonnegative().safe(),
  spendWarning: z.literal(true).optional(),
});

const SafeAgentErrorSchema = z.strictObject({
  code: z.string().trim().min(1).max(256),
  message: z.string().trim().min(1).max(4_096),
  retryable: z.boolean(),
});

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
};

const canonicalInvocationContextHash = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');

const SpecialistOutcomeCommon = {
  delegationId: OpaqueReferenceSchema,
  specialistId: IdentifierSchema,
  invocationContext: AgentInvocationContextSchema,
  invocationContextHash: Sha256Schema,
  usage: AgentUsageSchema,
} as const;

/**
 * The persisted manager result is the sole specialist-result collection.
 * Each outcome is exact and carries the immutable dispatch authority that
 * produced it; a generic output/safeError bag would permit type widening.
 */
const SpecialistOutcomeSchema = z
  .discriminatedUnion('status', [
    z.strictObject({
      ...SpecialistOutcomeCommon,
      status: z.literal('completed'),
      facts: JsonValueSchema,
      evidence: z.array(IdentifierSchema).max(512),
    }),
    z.strictObject({
      ...SpecialistOutcomeCommon,
      status: z.literal('needs_confirmation'),
      proposedAction: ReviewedActionSchema,
    }),
    z.strictObject({
      ...SpecialistOutcomeCommon,
      status: z.literal('needs_input'),
      question: z.string().trim().min(1).max(500),
    }),
    z.strictObject({
      ...SpecialistOutcomeCommon,
      status: z.literal('unavailable'),
      reasonCode: IdentifierSchema,
    }),
    z.strictObject({
      ...SpecialistOutcomeCommon,
      status: z.literal('failed'),
      safeMessage: z.string().trim().min(1).max(4_096),
    }),
  ])
  .superRefine((value, context) => {
    if (
      value.invocationContextHash !==
      canonicalInvocationContextHash(value.invocationContext)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['invocationContextHash'],
        message: 'Specialist outcome invocation context hash is invalid',
      });
    }
  });

const ResolvedModelResolutionSchema = ModelResolutionSchema.refine(
  (value) => value.status === 'resolved',
  'Completed approval resumes require a resolved model',
);

const TurnResultBaseShape = {
  runId: UuidSchema,
  localTraceReference: OpaqueReferenceSchema,
  specialistOutcomes: z.array(SpecialistOutcomeSchema).max(128),
  usage: AgentUsageSchema,
} as const;

const TurnResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...TurnResultBaseShape,
    status: z.literal('completed'),
    output: JsonValueSchema,
    hasPartialFailures: z.boolean(),
    modelResolution: ResolvedModelResolutionSchema,
  }),
  z.strictObject({
    ...TurnResultBaseShape,
    status: z.literal('failed'),
    safeError: SafeAgentErrorSchema,
    modelResolution: ModelResolutionSchema.optional(),
  }),
]);

const DecisionLinkResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('decided'),
    decision: ActionDecisionSchema,
  }),
  z.strictObject({
    status: z.enum([
      'proposal-not-found',
      'proposal-not-pending',
      'proposal-expired',
      'proposal-binding-mismatch',
      'visual-proof-invalid',
      'visual-proof-expired',
      'visual-proof-consumed',
      'idempotency-conflict',
    ]),
  }),
]);

const DecisionLinkInputSchema = z.strictObject({
  request: ActionDecisionRequestSchema,
  visualProofToken: OpaqueReferenceSchema,
  principal: PrincipalSchema,
  requestId: UuidSchema,
});

const APPROVAL_RESUME_FUNCTIONS = Object.freeze([
  'emdo.claim_approval_resume_job(uuid,uuid,uuid)',
  'emdo.settle_approval_resume_job(uuid,text,text,text,jsonb)',
]);

export interface PostgresApprovalResumePrincipal {
  readonly userId: string;
  readonly sessionId: string;
  readonly householdId: string;
  readonly role: 'owner' | 'member';
  readonly emailVerified: true;
  readonly spaceAccessGrantId: string;
  readonly collectionAuthorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprint;
}

export interface PostgresApprovalResumeBinding {
  readonly turnRequestId: string;
  readonly runId: string;
  readonly rootManagerInvocationId: string;
  readonly conversationId: string;
  readonly checkpointId: string;
  readonly interruptionId: string;
  readonly proposalId: string;
  readonly approvalDecisionId: string;
  readonly decision: 'approve' | 'reject';
  readonly householdId: string;
  readonly userId: string;
  readonly authenticatedSessionId: string;
  readonly spaceAccessGrantId: string;
  readonly disclosureGrantId: string;
  readonly disclosureGrantVersion: string;
  readonly collectionAuthorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprint;
  readonly authorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprint;
  readonly payloadHash: string;
  readonly approvalHash: string;
}

export type PostgresApprovalResumeClaim =
  | Readonly<{
      status: 'claimed';
      claimId: string;
      ownershipToken: string;
      binding: PostgresApprovalResumeBinding;
    }>
  | Readonly<{ status: 'in-progress'; runId: string }>
  | Readonly<{
      status: 'terminal-replay';
      runId: string;
      terminalEventSequence: number;
    }>;

export type PostgresApprovalResumeCompletion =
  | Readonly<{
      status: 'completed' | 'terminalized' | 'indeterminate' | 'replay';
      terminalEventSequence: number;
    }>
  | Readonly<{ status: 'conflict' }>;

type DecisionLinkInput = Readonly<z.input<typeof DecisionLinkInputSchema>>;
type DecisionLinkResult = Readonly<z.infer<typeof DecisionLinkResultSchema>>;

export interface PostgresApprovalResumeBoundaryOptions {
  readonly pool: DatabasePool;
  readonly decideAndLink: (
    input: DecisionLinkInput,
  ) => Promise<DecisionLinkResult>;
}

export class ApprovalResumePersistenceError extends Error {
  constructor(
    readonly code: 'invalid-input' | 'invalid-result',
    message: string,
  ) {
    super(message);
    this.name = 'ApprovalResumePersistenceError';
  }
}

const parseResult = <Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  message: string,
): z.output<Schema> => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApprovalResumePersistenceError('invalid-result', message);
  }
  deepFreeze(parsed.data);
  return parsed.data;
};

export class PostgresApprovalResumeBoundary {
  readonly #pool: DatabasePool;
  readonly #decideAndLink: PostgresApprovalResumeBoundaryOptions['decideAndLink'];

  constructor(options: PostgresApprovalResumeBoundaryOptions) {
    if (
      typeof options?.pool?.connect !== 'function' ||
      typeof options.decideAndLink !== 'function'
    ) {
      throw new ApprovalResumePersistenceError(
        'invalid-input',
        'Approval resume dependencies are invalid',
      );
    }
    this.#pool = options.pool;
    this.#decideAndLink = options.decideAndLink;
  }

  async decideAndLink(
    rawInput: DecisionLinkInput,
  ): Promise<DecisionLinkResult> {
    const input = DecisionLinkInputSchema.parse(rawInput);
    return parseResult(
      DecisionLinkResultSchema,
      await this.#decideAndLink(input),
      'Decision linkage returned an invalid result',
    );
  }

  async claim(rawInput: {
    readonly decision: ActionDecision;
    readonly principal: PostgresApprovalResumePrincipal;
    readonly decisionRequestId: string;
  }): Promise<PostgresApprovalResumeClaim> {
    const input = z
      .strictObject({
        decision: ActionDecisionSchema,
        principal: PrincipalSchema,
        decisionRequestId: UuidSchema,
      })
      .parse(rawInput);
    if (
      input.decision.userId !== input.principal.userId ||
      input.decision.authenticatedSessionId !== input.principal.sessionId
    ) {
      throw new ApprovalResumePersistenceError(
        'invalid-input',
        'Approval decision is not bound to the active principal',
      );
    }

    return withClaimedTransaction(
      this.#pool,
      {
        userId: input.principal.userId,
        sessionId: input.principal.sessionId,
        requestId: input.decisionRequestId,
        householdId: input.principal.householdId,
      },
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `select emdo.claim_approval_resume_job(
               $1::uuid, $2::uuid, $3::uuid
             ) as claim_result`,
            [
              input.decision.id,
              input.decisionRequestId,
              input.principal.spaceAccessGrantId,
            ],
          ),
        );
        return parseResult(
          ClaimResultSchema,
          row?.claim_result,
          'Approval resume claim returned an invalid result',
        );
      },
    );
  }

  complete(rawInput: {
    readonly claimId: string;
    readonly ownershipToken: string;
    readonly binding: PostgresApprovalResumeBinding;
    readonly result: unknown;
  }): Promise<PostgresApprovalResumeCompletion> {
    const parsed = z
      .strictObject({
        claimId: OpaqueReferenceSchema,
        ownershipToken: OpaqueReferenceSchema,
        binding: ApprovalResumeBindingSchema,
        result: TurnResultSchema,
      })
      .parse(rawInput);
    if (parsed.result.runId !== parsed.binding.runId) {
      throw new ApprovalResumePersistenceError(
        'invalid-input',
        'Approval resume result is bound to a different run',
      );
    }
    return this.#settle({
      ...parsed,
      mode: 'complete',
      reasonCode: null,
      result: JsonValueSchema.parse(parsed.result),
    });
  }

  terminalizeNotDispatched(rawInput: {
    readonly claimId: string;
    readonly ownershipToken: string;
    readonly binding: PostgresApprovalResumeBinding;
    readonly reasonCode: 'approval-resume-binding-invalid';
  }): Promise<PostgresApprovalResumeCompletion> {
    const parsed = z
      .strictObject({
        claimId: OpaqueReferenceSchema,
        ownershipToken: OpaqueReferenceSchema,
        binding: ApprovalResumeBindingSchema,
        reasonCode: z.literal('approval-resume-binding-invalid'),
      })
      .parse(rawInput);
    return this.#settle({
      ...parsed,
      mode: 'terminalize-not-dispatched',
      result: null,
    });
  }

  markIndeterminate(rawInput: {
    readonly claimId: string;
    readonly ownershipToken: string;
    readonly binding: PostgresApprovalResumeBinding;
    readonly reasonCode: 'approval-resume-failed';
  }): Promise<PostgresApprovalResumeCompletion> {
    const parsed = z
      .strictObject({
        claimId: OpaqueReferenceSchema,
        ownershipToken: OpaqueReferenceSchema,
        binding: ApprovalResumeBindingSchema,
        reasonCode: z.literal('approval-resume-failed'),
      })
      .parse(rawInput);
    return this.#settle({ ...parsed, mode: 'indeterminate', result: null });
  }

  check(): Promise<boolean> {
    return checkDatabaseFunctionPrivileges(
      this.#pool,
      APPROVAL_RESUME_FUNCTIONS,
    );
  }

  #settle(input: {
    readonly claimId: string;
    readonly ownershipToken: string;
    readonly binding: PostgresApprovalResumeBinding;
    readonly mode: 'complete' | 'terminalize-not-dispatched' | 'indeterminate';
    readonly reasonCode: string | null;
    readonly result: JsonValue;
  }): Promise<PostgresApprovalResumeCompletion> {
    return withClaimedTransaction(
      this.#pool,
      {
        userId: input.binding.userId,
        sessionId: input.binding.authenticatedSessionId,
        requestId: input.binding.turnRequestId,
        householdId: input.binding.householdId,
      },
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `select emdo.settle_approval_resume_job(
               $1::uuid, $2::text, $3::text, $4::text, $5::jsonb
             ) as settle_result`,
            [
              input.claimId,
              input.ownershipToken,
              input.mode,
              input.reasonCode,
              input.result,
            ],
          ),
        );
        return parseResult(
          CompletionResultSchema,
          row?.settle_result,
          'Approval resume settlement returned an invalid result',
        );
      },
    );
  }
}

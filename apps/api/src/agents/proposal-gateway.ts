import type {
  AgentExecutionContext,
  PreparedProviderWriteProposal,
  ProviderWriteProposalGateway,
} from '@emdo/agent-core';
import {
  ActionDecisionSchema,
  ActionProposalSchema,
  IdentifierSchema,
  JsonValueSchema,
  ProviderWriteAuthorizationSchema,
  UuidSchema,
  deepFreeze,
  type ActionDecision,
  type ActionProposal,
  type JsonValue,
} from '@emdo/contracts';
import {
  ProposalPreparationBindingSchema,
  hashActionProposalApproval,
  type ProposalService,
  type StoredDecision,
  type StoredProposalPreparation,
  type StoredProviderWriteAttempt,
} from '@emdo/domains/server/provider-proposals';
import {
  ProviderWriteCompletionSchema,
  hashCanonicalJson,
  hashProviderWriteApprovalBinding,
  type ProviderWriteApprovalStore,
} from '@emdo/toolbox';
import { z } from 'zod';

import {
  parseProductionProviderWriteCapabilityId,
  type ProductionCapabilityRuntime,
  type ProviderWriteCapabilityId,
} from './capability-runtime.js';

const asProviderWriteCapabilityId = (
  capabilityId: string,
): ProviderWriteCapabilityId => {
  try {
    return parseProductionProviderWriteCapabilityId(capabilityId);
  } catch {
    throw new Error('api-provider-proposal-capability-invalid');
  }
};

const hashPreparationBinding = (
  binding: StoredProposalPreparation['binding'],
): string =>
  hashCanonicalJson({
    domain: 'emdo.provider-proposal-preparation.v1',
    binding,
  });

export interface DurablePreparedProposalRecord {
  readonly proposal: ActionProposal;
  readonly preparation: StoredProposalPreparation;
}

export interface DurableDecisionProposalRecord extends DurablePreparedProposalRecord {
  readonly decision: StoredDecision;
}

/**
 * Principal-scoped durable lookup. Implementations must query persisted state;
 * a process-local SDK-call map is not an acceptable production substitute.
 */
export interface DurableProviderProposalLookup {
  resolvePreparedBySdkBinding(input: {
    readonly runId: string;
    readonly capabilityId: ProviderWriteCapabilityId;
    readonly providerSdkCallId: string;
  }): Promise<DurablePreparedProposalRecord | undefined>;
  resolveDecisionById(input: {
    readonly proposalId: string;
    readonly decisionId: string;
  }): Promise<DurableDecisionProposalRecord | undefined>;
  resolveProviderWriteCompletionByDecisionId(input: {
    readonly proposalId: string;
    readonly decisionId: string;
  }): Promise<StoredProviderWriteAttempt | undefined>;
}

export interface TrustedProviderWriteDecisionPresenter {
  /**
   * Converts a durable decision plus capability-owned, schema-validated result
   * into the specialist result consumed by the orchestrator. This is a pure,
   * deterministic presentation boundary; the gateway derives outcome and
   * provider idempotency provenance from the durable completion receipt.
   */
  present(
    input: Readonly<{
      decision: 'approve' | 'reject';
      proposal: ActionProposal;
      visualDecision: ActionDecision;
      capabilityOutput?: JsonValue;
      context: AgentExecutionContext;
    }>,
  ): Promise<JsonValue>;
}

export interface ProductionProviderProposalService extends Pick<
  ProposalService,
  'abandonPrepared'
> {
  readonly approvalStore: ProviderWriteApprovalStore;
}

export interface ProductionProviderProposalComposition {
  readonly approvalStore: ProviderWriteApprovalStore;
  createGateway(
    capabilityRuntime: ProductionCapabilityRuntime,
  ): ProviderWriteProposalGateway;
}

const isExactPreparation = (input: {
  readonly proposal: ActionProposal;
  readonly preparation: StoredProposalPreparation;
  readonly capabilityId: ProviderWriteCapabilityId;
  readonly sdkCallId: string;
  readonly context: AgentExecutionContext;
}): boolean => {
  const { proposal, preparation, capabilityId, sdkCallId, context } = input;
  const binding = ProposalPreparationBindingSchema.safeParse(
    preparation.binding,
  );
  if (
    !binding.success ||
    context.disclosureGrantId === undefined ||
    context.disclosureGrantVersion === undefined
  ) {
    return false;
  }
  const parsedBinding = binding.data;
  return (
    preparation.abandonment === undefined &&
    preparation.bindingHash === hashPreparationBinding(parsedBinding) &&
    hashActionProposalApproval(proposal) === proposal.approvalHash &&
    hashCanonicalJson(proposal.canonicalArguments) === proposal.payloadHash &&
    proposal.id === parsedBinding.proposalId &&
    proposal.runId === context.runId &&
    proposal.runId === parsedBinding.runId &&
    proposal.capabilityId === capabilityId &&
    proposal.capabilityId === parsedBinding.capabilityId &&
    proposal.authorizationScopeFingerprint ===
      context.authorizationScopeFingerprint &&
    proposal.providerSdkCallId === sdkCallId &&
    proposal.providerSdkCallId === parsedBinding.sdkCallId &&
    proposal.providerAuthorityBindingHash ===
      parsedBinding.providerAuthorityBindingHash &&
    proposal.disclosureGrant.id === context.disclosureGrantId &&
    proposal.disclosureGrant.id === parsedBinding.disclosureGrantId &&
    parsedBinding.disclosurePolicyVersion === context.disclosureGrantVersion &&
    proposal.disclosureGrant.runId === context.runId &&
    proposal.disclosureGrant.householdId === context.householdId &&
    proposal.disclosureGrant.householdId === parsedBinding.householdId &&
    proposal.disclosureGrant.userId === context.userId &&
    proposal.disclosureGrant.userId === parsedBinding.userId &&
    proposal.disclosureGrant.agentId === context.agentId &&
    proposal.disclosureGrant.agentId === parsedBinding.agentId &&
    context.agentId === 'scheduler' &&
    parsedBinding.originRequestId === context.requestId &&
    parsedBinding.originSessionId === context.authenticatedSessionId &&
    parsedBinding.originSpaceAccessGrantId === context.spaceAccessGrantId
  );
};

const parsePreparedRecord = (
  raw: DurablePreparedProposalRecord | undefined,
): DurablePreparedProposalRecord | undefined => {
  if (raw === undefined) return undefined;
  const proposal = ActionProposalSchema.safeParse(raw.proposal);
  const preparation = z
    .strictObject({
      binding: ProposalPreparationBindingSchema,
      bindingHash: z.string().regex(/^[a-f0-9]{64}$/u),
      abandonment: z
        .strictObject({
          reason: z.enum([
            'multiple-provider-writes-require-separate-turns',
            'execution-ended-before-checkpoint',
          ]),
          abandonedAt: z.iso.datetime({ offset: true }),
        })
        .optional(),
    })
    .safeParse(raw.preparation);
  if (!proposal.success || !preparation.success) return undefined;
  return deepFreeze({
    proposal: proposal.data,
    preparation: preparation.data,
  });
};

const previewFor = (proposal: ActionProposal): PreparedProviderWriteProposal =>
  deepFreeze({
    proposalId: proposal.id,
    providerAuthorityBindingHash: proposal.providerAuthorityBindingHash,
    authorizationScopeFingerprint: proposal.authorizationScopeFingerprint,
    preview: JsonValueSchema.parse({
      before: proposal.beforePreview,
      after: proposal.afterPreview,
    }),
  });

const exactDecisionRecord = (
  raw: DurableDecisionProposalRecord | undefined,
  input: Parameters<ProviderWriteProposalGateway['validateDecision']>[0],
  authenticatedSessionId: string,
): DurableDecisionProposalRecord | undefined => {
  const prepared = parsePreparedRecord(raw);
  if (prepared === undefined || raw === undefined) return undefined;
  const decision = ActionDecisionSchema.safeParse(raw.decision?.decision);
  if (!decision.success || raw.decision.proposalId !== prepared.proposal.id) {
    return undefined;
  }
  const expectedDecision =
    input.decision === 'approve' ? 'approved' : 'rejected';
  if (
    !isExactPreparation({
      ...prepared,
      capabilityId: asProviderWriteCapabilityId(input.capabilityId),
      sdkCallId: prepared.proposal.providerSdkCallId,
      context: input.preparationContext,
    }) ||
    input.context.runId !== input.preparationContext.runId ||
    input.context.householdId !== input.preparationContext.householdId ||
    input.context.userId !== input.preparationContext.userId ||
    input.context.authenticatedSessionId !== authenticatedSessionId ||
    input.preparationContext.authenticatedSessionId !==
      authenticatedSessionId ||
    input.context.authorizationScopeFingerprint !==
      input.preparationContext.authorizationScopeFingerprint ||
    input.context.agentId !== input.preparationContext.agentId ||
    input.context.disclosureGrantId !==
      input.preparationContext.disclosureGrantId ||
    input.context.disclosureGrantVersion !==
      input.preparationContext.disclosureGrantVersion ||
    prepared.proposal.id !== input.proposalId ||
    prepared.proposal.state !== expectedDecision ||
    decision.data.id !== input.approvalDecisionId ||
    decision.data.proposalId !== input.proposalId ||
    decision.data.userId !== input.context.userId ||
    decision.data.authenticatedSessionId !== authenticatedSessionId ||
    decision.data.decision !== expectedDecision ||
    decision.data.payloadHash !== prepared.proposal.payloadHash ||
    decision.data.approvalHash !== prepared.proposal.approvalHash ||
    input.context.approvalDecisionId !== input.approvalDecisionId
  ) {
    return undefined;
  }
  return deepFreeze({
    ...prepared,
    decision: {
      proposalId: raw.decision.proposalId,
      decision: decision.data,
    },
  });
};

const exactAppliedProviderCompletion = (input: {
  readonly raw: StoredProviderWriteAttempt | undefined;
  readonly record: DurableDecisionProposalRecord;
  readonly capabilityOutput: JsonValue;
}): string | undefined => {
  const { raw, record, capabilityOutput } = input;
  if (raw === undefined || raw.completion === undefined) return undefined;
  const authorization = ProviderWriteAuthorizationSchema.safeParse(
    raw.authorization,
  );
  const completion = ProviderWriteCompletionSchema.safeParse(
    raw.completion.completion,
  );
  if (!authorization.success || !completion.success) return undefined;
  const permit = authorization.data;
  const finalized = completion.data;
  const bindingHash = hashProviderWriteApprovalBinding(permit.approvalBinding);
  const dispatchedAt = Date.parse(raw.dispatchedAt ?? '');
  const completedAt = Date.parse(raw.completion.completedAt);
  if (
    raw.proposalId !== record.proposal.id ||
    raw.decisionId !== record.decision.decision.id ||
    raw.attemptState !== 'executed' ||
    finalized.state !== 'executed' ||
    finalized.application !== 'applied' ||
    finalized.outputStatus !== 'valid' ||
    finalized.resultHash !== hashCanonicalJson(capabilityOutput) ||
    raw.bindingHash !== bindingHash ||
    raw.completion.bindingHash !== bindingHash ||
    raw.completion.completionHash !== hashCanonicalJson(finalized) ||
    !Number.isFinite(dispatchedAt) ||
    !Number.isFinite(completedAt) ||
    dispatchedAt < Date.parse(permit.issuedAt) ||
    completedAt < dispatchedAt ||
    permit.proposalId !== record.proposal.id ||
    permit.approvalHash !== record.proposal.approvalHash ||
    permit.capabilityFingerprint !== record.proposal.capabilityFingerprint ||
    permit.disclosureGrantId !== record.proposal.disclosureGrant.id ||
    permit.disclosureGrantHash !==
      hashCanonicalJson(record.proposal.disclosureGrant) ||
    permit.approvalBindingHash !== bindingHash ||
    permit.approvalBinding.decisionId !== record.decision.decision.id ||
    permit.approvalBinding.userId !== record.decision.decision.userId ||
    permit.approvalBinding.agentId !== 'scheduler' ||
    permit.approvalBinding.runId !== record.proposal.runId ||
    permit.approvalBinding.capabilityId !== record.proposal.capabilityId ||
    permit.approvalBinding.capabilityFingerprint !==
      record.proposal.capabilityFingerprint ||
    permit.approvalBinding.disclosureGrantId !==
      record.proposal.disclosureGrant.id ||
    permit.approvalBinding.payloadHash !== record.proposal.payloadHash ||
    hashCanonicalJson(permit.approvalBinding.authorityBinding) !==
      record.proposal.providerAuthorityBindingHash ||
    hashCanonicalJson(permit.targets) !==
      hashCanonicalJson(record.proposal.targets) ||
    hashCanonicalJson(permit.providerPreconditions) !==
      hashCanonicalJson(record.proposal.providerPreconditions)
  ) {
    return undefined;
  }
  return IdentifierSchema.safeParse(permit.providerIdempotencyKey).success
    ? permit.providerIdempotencyKey
    : undefined;
};

const validateApprovalStore = (store: ProviderWriteApprovalStore): void => {
  if (
    typeof store?.acquire !== 'function' ||
    typeof store.markDispatching !== 'function' ||
    typeof store.finalize !== 'function' ||
    typeof store.reconcile !== 'function'
  ) {
    throw new Error('api-provider-proposal-approval-store-invalid');
  }
};

export const createProductionProviderProposalComposition = (input: {
  readonly proposalService: ProductionProviderProposalService;
  readonly lookup: DurableProviderProposalLookup;
  readonly presenter: TrustedProviderWriteDecisionPresenter;
  readonly authenticatedSessionId: string;
  readonly now?: () => Date;
}): ProductionProviderProposalComposition => {
  validateApprovalStore(input?.proposalService?.approvalStore);
  if (
    typeof input.proposalService.abandonPrepared !== 'function' ||
    typeof input.lookup?.resolvePreparedBySdkBinding !== 'function' ||
    typeof input.lookup.resolveDecisionById !== 'function' ||
    typeof input.lookup.resolveProviderWriteCompletionByDecisionId !==
      'function' ||
    typeof input.presenter?.present !== 'function' ||
    (input.now !== undefined && typeof input.now !== 'function')
  ) {
    throw new Error('api-provider-proposal-composition-invalid');
  }
  const approvalStore = input.proposalService.approvalStore;
  const abandonPrepared = input.proposalService.abandonPrepared.bind(
    input.proposalService,
  );
  const resolvePreparedBySdkBinding =
    input.lookup.resolvePreparedBySdkBinding.bind(input.lookup);
  const resolveDecisionById = input.lookup.resolveDecisionById.bind(
    input.lookup,
  );
  const resolveProviderWriteCompletionByDecisionId =
    input.lookup.resolveProviderWriteCompletionByDecisionId.bind(input.lookup);
  const present = input.presenter.present.bind(input.presenter);
  const authenticatedSessionId = UuidSchema.parse(input.authenticatedSessionId);
  const currentTime = input.now?.bind(undefined) ?? (() => new Date());

  const createGateway = (
    capabilityRuntime: ProductionCapabilityRuntime,
  ): ProviderWriteProposalGateway => {
    if (
      typeof capabilityRuntime?.materializeProviderWriteProposal !==
        'function' ||
      typeof capabilityRuntime.registry?.resolveForAgent !== 'function' ||
      capabilityRuntime.manifests?.scheduler === undefined
    ) {
      throw new Error('api-provider-proposal-runtime-invalid');
    }
    const materializeProviderWriteProposal =
      capabilityRuntime.materializeProviderWriteProposal.bind(
        capabilityRuntime,
      );
    const resolveSchedulerCapability =
      capabilityRuntime.registry.resolveForAgent.bind(
        capabilityRuntime.registry,
      );
    const schedulerManifest = capabilityRuntime.manifests.scheduler;

    const resolvePrepared = async (
      rawInput: Parameters<ProviderWriteProposalGateway['resolvePrepared']>[0],
    ): Promise<PreparedProviderWriteProposal | undefined> => {
      let capabilityId: ProviderWriteCapabilityId;
      try {
        capabilityId = asProviderWriteCapabilityId(rawInput.capabilityId);
      } catch {
        return undefined;
      }
      const record = parsePreparedRecord(
        await resolvePreparedBySdkBinding({
          runId: rawInput.context.runId,
          capabilityId,
          providerSdkCallId: rawInput.sdkCallId,
        }),
      );
      if (
        record === undefined ||
        record.proposal.state !== 'pending' ||
        !isExactPreparation({
          ...record,
          capabilityId,
          sdkCallId: rawInput.sdkCallId,
          context: rawInput.context,
        })
      ) {
        return undefined;
      }
      return previewFor(record.proposal);
    };

    const validateDecision = async (
      rawInput: Parameters<ProviderWriteProposalGateway['validateDecision']>[0],
    ): Promise<boolean> => {
      try {
        return (
          exactDecisionRecord(
            await resolveDecisionById({
              proposalId: rawInput.proposalId,
              decisionId: rawInput.approvalDecisionId,
            }),
            rawInput,
            authenticatedSessionId,
          ) !== undefined
        );
      } catch {
        return false;
      }
    };

    return Object.freeze({
      prepare: async (
        rawInput: Parameters<ProviderWriteProposalGateway['prepare']>[0],
      ) => {
        const capabilityId = asProviderWriteCapabilityId(rawInput.capabilityId);
        if (
          rawInput.context.agentId !== 'scheduler' ||
          rawInput.context.disclosureGrantId === undefined ||
          rawInput.context.disclosureGrantVersion === undefined
        ) {
          throw new Error('api-provider-proposal-scope-invalid');
        }
        const materialized = await materializeProviderWriteProposal({
          capabilityId,
          arguments: rawInput.canonicalArguments,
          context: {
            requestId: rawInput.context.requestId,
            runId: rawInput.context.runId,
            householdId: rawInput.context.householdId,
            userId: rawInput.context.userId,
            authenticatedSessionId: rawInput.context.authenticatedSessionId,
            spaceAccessGrantId: rawInput.context.spaceAccessGrantId,
            authorizationScopeFingerprint:
              rawInput.context.authorizationScopeFingerprint,
            disclosureGrantId: rawInput.context.disclosureGrantId,
            disclosureGrantVersion: rawInput.context.disclosureGrantVersion,
            sdkCallId: rawInput.sdkCallId,
            abortSignal: rawInput.context.abortSignal,
          },
        });
        const parsed = ActionProposalSchema.parse(materialized.proposal);
        const expectedPreparationBinding = {
          proposalId: parsed.id,
          originRequestId: rawInput.context.requestId,
          runId: parsed.runId,
          householdId: parsed.disclosureGrant.householdId,
          userId: parsed.disclosureGrant.userId,
          originSessionId: rawInput.context.authenticatedSessionId,
          agentId: parsed.disclosureGrant.agentId,
          originSpaceAccessGrantId: rawInput.context.spaceAccessGrantId,
          disclosureGrantId: parsed.disclosureGrant.id,
          disclosurePolicyVersion: rawInput.context.disclosureGrantVersion,
          capabilityId: parsed.capabilityId,
          sdkCallId: parsed.providerSdkCallId,
          providerAuthorityBindingHash: parsed.providerAuthorityBindingHash,
        } as const;
        if (
          materialized.sdkCallId !== rawInput.sdkCallId ||
          parsed.state !== 'pending' ||
          !isExactPreparation({
            proposal: parsed,
            preparation: {
              binding: expectedPreparationBinding,
              bindingHash: hashPreparationBinding(expectedPreparationBinding),
            },
            capabilityId,
            sdkCallId: rawInput.sdkCallId,
            context: rawInput.context,
          }) ||
          hashCanonicalJson(parsed.canonicalArguments) !==
            hashCanonicalJson(rawInput.canonicalArguments)
        ) {
          throw new Error('api-provider-proposal-materialization-invalid');
        }
        return previewFor(parsed);
      },
      resolvePrepared,
      abandonPrepared: async (
        rawInput: Parameters<
          ProviderWriteProposalGateway['abandonPrepared']
        >[0],
      ) => {
        const capabilityId = asProviderWriteCapabilityId(rawInput.capabilityId);
        if (rawInput.scope.agentId !== 'scheduler') {
          return Object.freeze({ status: 'not-abandonable' });
        }
        const now = currentTime();
        if (!Number.isFinite(now.getTime())) {
          return Object.freeze({ status: 'not-abandonable' });
        }
        return abandonPrepared({
          proposalId: rawInput.proposalId,
          originRequestId: rawInput.scope.requestId,
          runId: rawInput.scope.runId,
          householdId: rawInput.scope.householdId,
          userId: rawInput.scope.userId,
          originSessionId: rawInput.scope.authenticatedSessionId,
          agentId: rawInput.scope.agentId,
          originSpaceAccessGrantId: rawInput.scope.spaceAccessGrantId,
          disclosureGrantId: rawInput.scope.disclosureGrantId,
          disclosurePolicyVersion: rawInput.scope.disclosurePolicyVersion,
          capabilityId,
          sdkCallId: rawInput.sdkCallId,
          providerAuthorityBindingHash: rawInput.providerAuthorityBindingHash,
          reason: rawInput.reason,
          now,
        });
      },
      validateDecision,
      executeDecision: async (
        rawInput: Parameters<
          ProviderWriteProposalGateway['executeDecision']
        >[0],
      ) => {
        const record = exactDecisionRecord(
          await resolveDecisionById({
            proposalId: rawInput.proposalId,
            decisionId: rawInput.approvalDecisionId,
          }),
          rawInput,
          authenticatedSessionId,
        );
        if (record === undefined) {
          throw new Error('api-provider-proposal-decision-invalid');
        }
        let capabilityOutput: JsonValue | undefined;
        if (rawInput.decision === 'approve') {
          const [capability] = resolveSchedulerCapability({
            manifest: schedulerManifest,
            requestedCapabilityIds: [
              asProviderWriteCapabilityId(rawInput.capabilityId),
            ],
          });
          if (
            capability === undefined ||
            capability.descriptor.id !== rawInput.capabilityId ||
            capability.descriptor.capabilityKind !== 'provider-write'
          ) {
            throw new Error('api-provider-proposal-capability-invalid');
          }
          capabilityOutput = JsonValueSchema.parse(
            await capability.invoke(record.proposal.canonicalArguments, {
              requestId: rawInput.context.requestId,
              runId: rawInput.context.runId,
              userId: rawInput.context.userId,
              householdId: rawInput.context.householdId,
              sessionId: rawInput.context.authenticatedSessionId,
              agentId: rawInput.context.agentId,
              spaceAccessGrantId: rawInput.context.spaceAccessGrantId,
              disclosureGrantId: rawInput.context.disclosureGrantId,
              approvalDecisionId: rawInput.approvalDecisionId,
              abortSignal: rawInput.context.abortSignal,
            }),
          );
        }
        let idempotencyKey: string;
        if (rawInput.decision === 'approve') {
          const providerIdempotencyKey = exactAppliedProviderCompletion({
            raw: await resolveProviderWriteCompletionByDecisionId({
              proposalId: rawInput.proposalId,
              decisionId: rawInput.approvalDecisionId,
            }),
            record,
            capabilityOutput: capabilityOutput!,
          });
          if (providerIdempotencyKey === undefined) {
            throw new Error('api-provider-write-completion-invalid');
          }
          idempotencyKey = providerIdempotencyKey;
        } else {
          idempotencyKey = hashCanonicalJson({
            domain: 'emdo.provider-write-rejection.v1',
            proposalId: record.proposal.id,
            decisionId: record.decision.decision.id,
            decisionIdempotencyKey: record.decision.decision.idempotencyKey,
          });
        }
        const output = JsonValueSchema.parse(
          await present({
            decision: rawInput.decision,
            proposal: record.proposal,
            visualDecision: record.decision.decision,
            ...(capabilityOutput === undefined ? {} : { capabilityOutput }),
            context: rawInput.context,
          }),
        );
        return deepFreeze({
          outcome:
            rawInput.decision === 'approve'
              ? ('executed-readback-verified' as const)
              : ('rejected' as const),
          output,
          idempotencyKey,
        });
      },
    });
  };

  return Object.freeze({ approvalStore, createGateway });
};

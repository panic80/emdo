import type {
  AgentExecutionContext,
  PreparedProviderWriteProposal,
  ProviderWriteProposalGateway,
} from '@emdo/agent-core';
import {
  ActionDecisionSchema,
  ActionProposalSchema,
  GuardedActionPermitSchema,
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
  hashCapabilityDescriptorBinding,
  hashProviderWriteApprovalBinding,
  type ProviderWriteApprovalStore,
} from '@emdo/toolbox';
import { z } from 'zod';

import type { ProductionCapabilityRuntime } from './capability-runtime.js';

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
    readonly capabilityId: string;
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
  readonly capabilityId: string;
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
    !IdentifierSchema.safeParse(input.capabilityId).success ||
    !isExactPreparation({
      ...prepared,
      capabilityId: input.capabilityId,
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

const createUnregisteredProviderWriteGateway =
  (): ProviderWriteProposalGateway =>
    Object.freeze({
      prepare: async () => {
        throw new Error('api-provider-write-capability-unregistered');
      },
      resolvePrepared: async () => undefined,
      abandonPrepared: async () =>
        Object.freeze({ status: 'not-abandonable' as const }),
      validateDecision: async () => false,
      executeDecision: async () => {
        throw new Error('api-provider-write-capability-unregistered');
      },
    });

const assertRuntimeHasNoGuardedActions = (
  capabilityRuntime: ProductionCapabilityRuntime,
): void => {
  if (
    typeof capabilityRuntime?.materializeGuardedActionProposal !== 'function' ||
    typeof capabilityRuntime.registry?.resolveForAgent !== 'function'
  ) {
    throw new Error('api-provider-proposal-runtime-invalid');
  }
  const manifests = Object.values(capabilityRuntime.manifests ?? {}).filter(
    (manifest): manifest is typeof capabilityRuntime.manifests.manager =>
      manifest !== undefined,
  );
  if (
    manifests.length === 0 ||
    manifests.some((manifest) =>
      capabilityRuntime.registry
        .resolveForAgent({
          manifest,
          requestedCapabilityIds: manifest.capabilityAllowlist,
        })
        .some(
          ({ descriptor }) =>
            descriptor.approval.rule === 'authenticated-visual-proposal',
        ),
    )
  ) {
    throw new Error('api-provider-proposal-runtime-invalid');
  }
};

/**
 * Fail-closed proposal boundary for registered profiles that expose no guarded
 * capability. The inert approval store is unreachable by construction;
 * retaining it satisfies the shared runtime contract without creating a
 * workflow-database dependency for EMDO-only or Finance-only startup.
 */
export const createNoProviderWriteProposalComposition =
  (): ProductionProviderProposalComposition => {
    const approvalStore: ProviderWriteApprovalStore = Object.freeze({
      acquire: async () => Object.freeze({ status: 'not-found' as const }),
      markDispatching: async () =>
        Object.freeze({ status: 'not-found' as const }),
      finalize: async () => 'not-found' as const,
      reconcile: async () => 'not-found' as const,
    });
    return Object.freeze({
      approvalStore,
      createGateway: (capabilityRuntime: ProductionCapabilityRuntime) => {
        assertRuntimeHasNoGuardedActions(capabilityRuntime);
        return createUnregisteredProviderWriteGateway();
      },
    });
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
    if (typeof capabilityRuntime.registry?.resolveForAgent !== 'function') {
      throw new Error('api-provider-proposal-runtime-invalid');
    }
    const manifests = Object.values(capabilityRuntime.manifests ?? {});
    if (manifests.length === 0) {
      assertRuntimeHasNoGuardedActions(capabilityRuntime);
      return createUnregisteredProviderWriteGateway();
    }
    const materializeGuardedActionProposal =
      typeof capabilityRuntime.materializeGuardedActionProposal === 'function'
        ? capabilityRuntime.materializeGuardedActionProposal.bind(
            capabilityRuntime,
          )
        : undefined;
    if (
      materializeGuardedActionProposal === undefined &&
      capabilityRuntime.manifests.scheduler === undefined
    ) {
      return createUnregisteredProviderWriteGateway();
    }
    const resolveForAgent = capabilityRuntime.registry.resolveForAgent.bind(
      capabilityRuntime.registry,
    );
    const resolveCapability = (capabilityId: string, agentId: string) => {
      const manifest = manifests.find((candidate) => candidate.id === agentId);
      if (manifest === undefined) {
        throw new Error('api-provider-proposal-agent-invalid');
      }
      const [capability] = resolveForAgent({
        manifest,
        requestedCapabilityIds: [capabilityId],
      });
      if (
        capability === undefined ||
        capability.descriptor.id !== capabilityId
      ) {
        throw new Error('api-provider-proposal-capability-invalid');
      }
      return capability;
    };

    const resolvePrepared = async (
      rawInput: Parameters<ProviderWriteProposalGateway['resolvePrepared']>[0],
    ): Promise<PreparedProviderWriteProposal | undefined> => {
      const capabilityId = IdentifierSchema.safeParse(rawInput.capabilityId);
      if (!capabilityId.success) return undefined;
      const record = parsePreparedRecord(
        await resolvePreparedBySdkBinding({
          runId: rawInput.context.runId,
          capabilityId: capabilityId.data,
          providerSdkCallId: rawInput.sdkCallId,
        }),
      );
      if (
        record === undefined ||
        record.proposal.state !== 'pending' ||
        !isExactPreparation({
          ...record,
          capabilityId: capabilityId.data,
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
        if (
          rawInput.context.disclosureGrantId === undefined ||
          rawInput.context.disclosureGrantVersion === undefined
        ) {
          throw new Error('api-provider-proposal-scope-invalid');
        }
        const capability = resolveCapability(
          rawInput.capabilityId,
          rawInput.context.agentId,
        );
        const materializationContext = {
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
        } as const;
        const materialized =
          materializeGuardedActionProposal === undefined
            ? await (() => {
                if (capability.descriptor.capabilityKind !== 'provider-write') {
                  throw new Error('api-guarded-action-runtime-unavailable');
                }
                return capabilityRuntime.materializeProviderWriteProposal({
                  capabilityId: rawInput.capabilityId as never,
                  arguments: rawInput.canonicalArguments,
                  context: materializationContext,
                });
              })()
            : await materializeGuardedActionProposal({
                capabilityId: rawInput.capabilityId,
                arguments: rawInput.canonicalArguments,
                context: {
                  ...materializationContext,
                  agentId: rawInput.context.agentId,
                },
              });
        if (materialized === undefined) return undefined;
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
            capabilityId: rawInput.capabilityId,
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
        const capabilityId = IdentifierSchema.safeParse(rawInput.capabilityId);
        if (!capabilityId.success) {
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
          capabilityId: capabilityId.data,
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
        const capability = resolveCapability(
          rawInput.capabilityId,
          record.proposal.disclosureGrant.agentId,
        );
        if (
          rawInput.context.agentId !==
            record.proposal.disclosureGrant.agentId ||
          capability.descriptor.id !== record.proposal.capabilityId
        ) {
          throw new Error('api-provider-proposal-capability-invalid');
        }
        const guardedActionPermit =
          capability.descriptor.capabilityKind === 'provider-write'
            ? undefined
            : (() => {
                const guardedAction = record.proposal.guardedAction;
                if (guardedAction === undefined) {
                  throw new Error('api-guarded-action-binding-invalid');
                }
                if (
                  guardedAction.capabilityVersion !==
                    capability.descriptor.version ||
                  hashCapabilityDescriptorBinding(capability.descriptor) !==
                    record.proposal.capabilityFingerprint
                ) {
                  throw new Error('api-guarded-action-binding-invalid');
                }
                return GuardedActionPermitSchema.parse({
                  proposalId: record.proposal.id,
                  decisionId: record.decision.decision.id,
                  capabilityId: record.proposal.capabilityId,
                  capabilityVersion: guardedAction.capabilityVersion,
                  capabilityFingerprint: record.proposal.capabilityFingerprint,
                  operation: guardedAction.operation,
                  actionHash: guardedAction.actionHash,
                  executionBindingHash: guardedAction.executionBindingHash,
                });
              })();
        if (rawInput.decision === 'approve') {
          capabilityOutput = JsonValueSchema.parse(
            await capability.invoke(record.proposal.canonicalArguments, {
              requestId: rawInput.context.requestId,
              runId: rawInput.context.runId,
              userId: rawInput.context.userId,
              householdId: rawInput.context.householdId,
              sessionId: rawInput.context.authenticatedSessionId,
              agentId: rawInput.context.agentId,
              spaceAccessGrantId: rawInput.context.spaceAccessGrantId,
              locale: rawInput.context.locale,
              disclosureGrantId: rawInput.context.disclosureGrantId,
              approvalDecisionId: rawInput.approvalDecisionId,
              ...(guardedActionPermit === undefined
                ? {}
                : { guardedActionPermit }),
              abortSignal: rawInput.context.abortSignal,
            }),
          );
        }
        let idempotencyKey: string;
        if (rawInput.decision === 'approve') {
          if (capability.descriptor.capabilityKind === 'provider-write') {
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
            idempotencyKey = record.proposal.idempotencyKey;
          }
        } else {
          idempotencyKey = hashCanonicalJson({
            domain:
              record.proposal.guardedAction === undefined
                ? 'emdo.provider-write-rejection.v1'
                : 'emdo.guarded-action-rejection.v1',
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

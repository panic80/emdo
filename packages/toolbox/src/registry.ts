import { z } from 'zod';

import {
  AgentManifestSchema,
  CapabilityDescriptorSchema,
  IdentifierSchema,
  JsonValueSchema,
  ProviderWriteApprovalBindingSchema,
  ProviderCommitOutcomeSchema,
  TrustedProviderWriteAuthorityResolutionSchema,
  ProviderWriteAuthorizationSchema,
  Sha256Schema,
  UuidSchema,
  deepFreeze,
  type AgentManifest,
  type CapabilityInvocationContext,
  type DeepReadonly,
  type JsonValue,
  type ProviderWriteApprovalBinding,
  type ProviderWriteAuthorityBinding,
  type ProviderWriteAuthorization,
  type ProviderWriteCapabilityId,
  type ProviderWriteOperationScope,
  type RegisteredCapability,
  type ResolvedCapability,
  type RuntimeSchemaRegistry,
  type TrustedProviderWriteAuthorityResolution,
} from '@emdo/contracts';

import { ToolboxPolicyError } from './errors.js';
import {
  assertCapabilityAllowed,
  hashCanonicalJson,
  hashCapabilityDescriptorBinding,
} from './policy.js';

const ResolutionRequestSchema = z.strictObject({
  manifest: AgentManifestSchema,
  requestedCapabilityIds: z.array(IdentifierSchema).max(128),
});

const snapshotBoundedJson = (raw: unknown): DeepReadonly<JsonValue> => {
  const stack: { value: unknown; depth: number }[] = [{ value: raw, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let textLength = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > 2_048 || current.depth > 12) {
      throw new TypeError('Provider evidence exceeds structural limits');
    }
    const value = current.value;
    if (value === null || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new TypeError('Invalid JSON number');
      continue;
    }
    if (typeof value === 'string') {
      textLength += value.length;
      if (textLength > 65_536)
        throw new TypeError('Provider evidence is too large');
      continue;
    }
    if (typeof value !== 'object') throw new TypeError('Evidence is not JSON');
    if (seen.has(value)) throw new TypeError('Provider evidence is cyclic');
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > 256)
        throw new TypeError('Evidence array is too large');
      for (const nested of value) {
        stack.push({ value: nested, depth: current.depth + 1 });
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Evidence object has an invalid prototype');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError('Evidence object contains symbol keys');
    }
    let entryCount = 0;
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      entryCount += 1;
      if (entryCount > 128) throw new TypeError('Evidence object is too large');
      textLength += key.length;
      if (textLength > 65_536)
        throw new TypeError('Provider evidence is too large');
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (property === undefined || !('value' in property)) {
        throw new TypeError('Evidence object contains an accessor');
      }
      stack.push({ value: property.value, depth: current.depth + 1 });
    }
  }

  return deepFreeze(JsonValueSchema.parse(raw));
};

export interface CapabilityRegistry {
  readonly size: number;
  resolveForAgent(request: {
    readonly manifest: AgentManifest;
    readonly requestedCapabilityIds: readonly string[];
  }): readonly ResolvedCapability[];
}

export type ProviderWriteApprovalStatus =
  'authorized' | 'existing-attempt' | 'not-found' | 'mismatch' | 'expired';

export type ProviderWriteApprovalResult =
  | {
      readonly status: 'authorized';
      readonly authorization: ProviderWriteAuthorization;
    }
  | {
      readonly status: 'existing-attempt';
      readonly authorization: ProviderWriteAuthorization;
      readonly attemptState: 'prepared' | 'executing';
    }
  | {
      readonly status: 'existing-attempt';
      readonly authorization: ProviderWriteAuthorization;
      readonly attemptState: 'executed' | 'not-applied' | 'indeterminate';
      readonly completion: ProviderWriteCompletion;
    }
  | {
      readonly status: Exclude<
        ProviderWriteApprovalStatus,
        'authorized' | 'existing-attempt'
      >;
    };

export type ProviderWriteDispatchResult =
  | {
      readonly status: 'dispatch-authorized';
      readonly authorization: ProviderWriteAuthorization;
    }
  | Extract<
      ProviderWriteApprovalResult,
      { readonly status: 'existing-attempt' }
    >
  | {
      readonly status: 'not-found' | 'mismatch' | 'expired';
    };

export const ProviderWriteCompletionSchema = z.union([
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

export type ProviderWriteCompletion = z.infer<
  typeof ProviderWriteCompletionSchema
>;

export type ProviderWriteFinalizationStatus =
  'finalized' | 'already-finalized' | 'not-found' | 'mismatch';

export type { ProviderWriteApprovalBinding } from '@emdo/contracts';

export const hashProviderWriteApprovalBinding = (
  binding: ProviderWriteApprovalBinding,
): string => {
  const validatedBinding = ProviderWriteApprovalBindingSchema.parse(binding);
  return hashCanonicalJson({
    domain: 'emdo.provider-write-approval-binding.v1',
    binding: validatedBinding,
  });
};

export interface ProviderWriteApprovalStore {
  /**
   * Atomically verifies persisted visual approval and consumes it for this
   * binding. An exact replay returns the existing permit and attempt state;
   * callers must recover/reconcile it and never dispatch a second mutation.
   */
  acquire(
    binding: ProviderWriteApprovalBinding,
    operationScope: ProviderWriteOperationScope,
  ): Promise<ProviderWriteApprovalResult>;
  /**
   * Atomically crosses the irreversible dispatch boundary for one prepared
   * permit. A non-authorized result must never be followed by a mutation.
   */
  markDispatching(
    binding: ProviderWriteApprovalBinding,
    attemptId: string,
    operationScope: ProviderWriteOperationScope,
  ): Promise<ProviderWriteDispatchResult>;
  finalize(
    binding: ProviderWriteApprovalBinding,
    completion: ProviderWriteCompletion,
  ): Promise<ProviderWriteFinalizationStatus>;
  /** Reconciles a previously indeterminate attempt without dispatching again. */
  reconcile(
    binding: ProviderWriteApprovalBinding,
    completion: ProviderWriteCompletion,
  ): Promise<ProviderWriteFinalizationStatus>;
}

export interface TrustedProviderWriteAuthorityResolutionInput {
  readonly requestId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly householdId: string;
  readonly agentId: string;
  readonly spaceAccessGrantId: string;
  readonly disclosureGrantId: string;
  readonly decisionId: string;
  readonly capabilityId: ProviderWriteCapabilityId;
  readonly capabilityFingerprint: string;
}

export interface TrustedProviderWriteAuthorityResolver {
  /** Resolves server-owned provider authority; no client/model field is used. */
  resolve(
    input: TrustedProviderWriteAuthorityResolutionInput,
  ): Promise<TrustedProviderWriteAuthorityResolution | undefined>;
}

const operationScopeMatchesInvocation = (
  scope: ProviderWriteOperationScope,
  context: CapabilityInvocationContext,
): boolean =>
  scope.requestId === context.requestId &&
  scope.sessionId === context.sessionId &&
  scope.householdId === context.householdId &&
  scope.userId === context.userId &&
  scope.spaceAccessGrantId === context.spaceAccessGrantId;

const authorityBindingsMatch = (
  left: ProviderWriteAuthorityBinding,
  right: ProviderWriteAuthorityBinding,
): boolean => hashCanonicalJson(left) === hashCanonicalJson(right);

export interface CapabilityRegistryOptions {
  readonly providerWriteApprovalStore?: ProviderWriteApprovalStore;
  readonly trustedProviderWriteAuthorityResolver?: TrustedProviderWriteAuthorityResolver;
  readonly now?: () => Date;
}

export const createCapabilityRegistry = (
  registrations: readonly RegisteredCapability[],
  runtimeSchemas: RuntimeSchemaRegistry,
  options: CapabilityRegistryOptions = {},
): CapabilityRegistry => {
  const byId = new Map<string, ResolvedCapability>();
  const configuredApprovalStore = options.providerWriteApprovalStore;
  const configuredAuthorityResolver =
    options.trustedProviderWriteAuthorityResolver;
  const approvalStoreFacade =
    configuredApprovalStore === undefined
      ? undefined
      : Object.freeze({
          acquire: configuredApprovalStore.acquire.bind(
            configuredApprovalStore,
          ),
          markDispatching: configuredApprovalStore.markDispatching.bind(
            configuredApprovalStore,
          ),
          finalize: configuredApprovalStore.finalize.bind(
            configuredApprovalStore,
          ),
          reconcile: configuredApprovalStore.reconcile.bind(
            configuredApprovalStore,
          ),
        });
  const authorityResolverFacade =
    configuredAuthorityResolver === undefined
      ? undefined
      : Object.freeze({
          resolve: configuredAuthorityResolver.resolve.bind(
            configuredAuthorityResolver,
          ),
        });
  const configuredClock = options.now?.bind(options);
  const currentTime = (): Date => {
    const value = configuredClock?.() ?? new Date();
    if (!Number.isFinite(value.getTime())) {
      throw new Error('Capability registry clock returned an invalid date');
    }
    return value;
  };

  for (const registration of registrations) {
    const descriptor = CapabilityDescriptorSchema.parse(
      registration.descriptor,
    );
    if (byId.has(descriptor.id)) {
      throw new ToolboxPolicyError(
        'duplicate-capability',
        `Capability ${descriptor.id} is already registered`,
      );
    }
    runtimeSchemas.schema(descriptor.inputSchema);
    runtimeSchemas.schema(descriptor.outputSchema);
    const isProviderWrite = descriptor.capabilityKind === 'provider-write';
    const hasSoundProviderWriteSafety =
      registration.providerWriteSafety?.atomicConditions ===
        'provider-native-single-request' &&
      (registration.providerWriteSafety.idempotency === 'provider-key' ||
        registration.providerWriteSafety.idempotency ===
          'deterministic-resource-id') &&
      registration.providerWriteSafety.retryOwnership ===
        'adapter-bounded-within-invocation' &&
      registration.providerWriteSafety.reconciliation === 'required';
    if (
      (isProviderWrite &&
        (registration.executeProviderWrite === undefined ||
          registration.execute !== undefined ||
          !hasSoundProviderWriteSafety)) ||
      (!isProviderWrite &&
        (registration.execute === undefined ||
          registration.executeProviderWrite !== undefined ||
          registration.providerWriteSafety !== undefined))
    ) {
      throw new ToolboxPolicyError(
        'capability-registration-invalid',
        'Provider writes require the conditional provider-write executor; other capabilities require the standard executor',
      );
    }
    const executeProviderWrite = registration.executeProviderWrite;
    const executeStandardCapability = registration.execute;
    const invoke: ResolvedCapability['invoke'] = async (rawInput, context) => {
      const parsedInput = runtimeSchemas.parse(
        descriptor.inputSchema,
        rawInput,
      );
      const invocationContext: CapabilityInvocationContext = Object.freeze({
        requestId: context.requestId,
        runId: context.runId,
        userId: context.userId,
        householdId: context.householdId,
        sessionId: context.sessionId,
        agentId: context.agentId,
        spaceAccessGrantId: context.spaceAccessGrantId,
        ...(context.disclosureGrantId === undefined
          ? {}
          : { disclosureGrantId: context.disclosureGrantId }),
        ...(context.approvalDecisionId === undefined
          ? {}
          : { approvalDecisionId: context.approvalDecisionId }),
        abortSignal: context.abortSignal,
      });

      if (isProviderWrite) {
        const providerInput = snapshotBoundedJson(parsedInput);
        const approvalStore = approvalStoreFacade;
        if (approvalStore === undefined) {
          throw new ToolboxPolicyError(
            'provider-write-approval-store-required',
            'Provider-write execution requires the server approval store',
          );
        }
        if (executeProviderWrite === undefined) {
          throw new ToolboxPolicyError(
            'capability-registration-invalid',
            'Provider-write executor is unavailable',
          );
        }
        // Validate the registry clock before consuming the single-use approval.
        currentTime();
        const decisionId = UuidSchema.safeParse(context.approvalDecisionId);
        if (!decisionId.success) {
          throw new ToolboxPolicyError(
            'provider-write-approval-missing',
            'Provider-write execution requires an approved proposal',
          );
        }
        const disclosureGrantId = UuidSchema.safeParse(
          context.disclosureGrantId,
        );
        if (!disclosureGrantId.success) {
          throw new ToolboxPolicyError(
            'provider-write-approval-missing',
            'Provider-write execution requires a server disclosure grant',
          );
        }

        const authorityResolver = authorityResolverFacade;
        if (authorityResolver === undefined) {
          throw new ToolboxPolicyError(
            'provider-write-authority-binding-required',
            'Provider-write execution requires trusted provider authority',
          );
        }
        const capabilityFingerprint =
          hashCapabilityDescriptorBinding(descriptor);
        const authorityResolutionInput =
          (): TrustedProviderWriteAuthorityResolutionInput =>
            Object.freeze({
              requestId: invocationContext.requestId,
              runId: invocationContext.runId,
              sessionId: invocationContext.sessionId,
              userId: invocationContext.userId,
              householdId: invocationContext.householdId,
              agentId: invocationContext.agentId,
              spaceAccessGrantId: invocationContext.spaceAccessGrantId,
              disclosureGrantId: disclosureGrantId.data,
              decisionId: decisionId.data,
              capabilityId: descriptor.id,
              capabilityFingerprint,
            });
        const resolveCurrentAuthority =
          async (): Promise<TrustedProviderWriteAuthorityResolution> => {
            try {
              const resolvedAuthority = await authorityResolver.resolve(
                authorityResolutionInput(),
              );
              const resolution =
                TrustedProviderWriteAuthorityResolutionSchema.parse(
                  resolvedAuthority,
                );
              if (
                !operationScopeMatchesInvocation(
                  resolution.operationScope,
                  invocationContext,
                )
              ) {
                throw new TypeError(
                  'Trusted provider authority does not match the invocation',
                );
              }
              return resolution;
            } catch {
              throw new ToolboxPolicyError(
                'provider-write-authority-binding-invalid',
                'Trusted provider authority could not be established',
              );
            }
          };
        const initialAuthority = await resolveCurrentAuthority();
        const authorityBinding = initialAuthority.authorityBinding;

        const binding = ProviderWriteApprovalBindingSchema.parse({
          decisionId: decisionId.data,
          userId: invocationContext.userId,
          agentId: invocationContext.agentId,
          runId: invocationContext.runId,
          capabilityId: descriptor.id,
          capabilityFingerprint,
          disclosureGrantId: disclosureGrantId.data,
          payloadHash: hashCanonicalJson(providerInput),
          idempotencyTtlMs: descriptor.idempotency.ttlMs,
          authorityBinding,
        });
        const approvalResult = await approvalStore.acquire(
          binding,
          initialAuthority.operationScope,
        );
        if (
          approvalResult.status === 'existing-attempt' &&
          approvalResult.attemptState !== 'prepared'
        ) {
          throw new ToolboxPolicyError(
            'provider-write-recovery-required',
            `Provider write already has a ${approvalResult.attemptState} attempt; recover it without redispatch`,
          );
        }
        if (
          approvalResult.status !== 'authorized' &&
          approvalResult.status !== 'existing-attempt'
        ) {
          const [code, message] =
            approvalResult.status === 'expired'
              ? ([
                  'provider-write-approval-expired',
                  'Provider-write approval is no longer valid',
                ] as const)
              : ([
                  'provider-write-approval-invalid',
                  'Provider-write approval does not match this execution',
                ] as const);
          throw new ToolboxPolicyError(code, message);
        }
        const finalize = async (
          completion: ProviderWriteCompletion,
        ): Promise<void> => {
          const finalization = await approvalStore.finalize(
            binding,
            completion,
          );
          if (
            finalization !== 'finalized' &&
            finalization !== 'already-finalized'
          ) {
            throw new ToolboxPolicyError(
              'provider-write-finalization-failed',
              'Provider write outcome was not durably recorded',
            );
          }
        };

        let permit: ProviderWriteAuthorization;
        try {
          permit = ProviderWriteAuthorizationSchema.parse(
            approvalResult.authorization,
          );
        } catch {
          await finalize({
            state: 'not-applied',
            application: 'not-applied',
            reason: 'approval-policy-mismatch',
          });
          throw new ToolboxPolicyError(
            'provider-write-approval-invalid',
            'Provider-write approval store returned an invalid permit',
          );
        }

        let dispatchAt: Date;
        try {
          dispatchAt = currentTime();
        } catch {
          await finalize({
            state: 'not-applied',
            application: 'not-applied',
            reason: 'approval-policy-mismatch',
          });
          throw new ToolboxPolicyError(
            'provider-write-approval-invalid',
            'Provider write could not establish an authoritative dispatch time',
          );
        }
        const approvedLifetimeMs =
          Date.parse(permit.expiresAt) - Date.parse(permit.proposalCreatedAt);
        const idempotencyLifetimeMs =
          Date.parse(permit.idempotencyExpiresAt) - Date.parse(permit.issuedAt);
        if (
          permit.approvalBindingHash !==
            hashProviderWriteApprovalBinding(binding) ||
          hashCanonicalJson(permit.approvalBinding) !==
            hashCanonicalJson(binding) ||
          permit.capabilityFingerprint !== binding.capabilityFingerprint ||
          permit.disclosureGrantId !== binding.disclosureGrantId ||
          dispatchAt.getTime() < Date.parse(permit.issuedAt) ||
          approvedLifetimeMs > descriptor.approval.expiresInSeconds * 1000 ||
          idempotencyLifetimeMs !== descriptor.idempotency.ttlMs
        ) {
          await finalize({
            state: 'not-applied',
            application: 'not-applied',
            reason: 'approval-policy-mismatch',
          });
          throw new ToolboxPolicyError(
            'provider-write-approval-invalid',
            'Provider-write approval does not match the active capability policy',
          );
        }
        if (
          dispatchAt.getTime() >= Date.parse(permit.expiresAt) ||
          dispatchAt.getTime() >= Date.parse(permit.idempotencyExpiresAt)
        ) {
          await finalize({
            state: 'not-applied',
            application: 'not-applied',
            reason: 'approval-expired-before-dispatch',
          });
          throw new ToolboxPolicyError(
            'provider-write-approval-expired',
            'Provider-write approval expired before dispatch',
          );
        }
        if (invocationContext.abortSignal.aborted) {
          await finalize({
            state: 'not-applied',
            application: 'not-applied',
            reason: 'provider-rejected-before-apply',
          });
          throw new ToolboxPolicyError(
            'provider-write-not-applied',
            'Provider write was cancelled before dispatch',
          );
        }

        let dispatchAuthority: TrustedProviderWriteAuthorityResolution;
        try {
          dispatchAuthority = await resolveCurrentAuthority();
          if (
            !authorityBindingsMatch(
              dispatchAuthority.authorityBinding,
              authorityBinding,
            )
          ) {
            throw new ToolboxPolicyError(
              'provider-write-authority-binding-invalid',
              'Trusted provider authority changed before dispatch',
            );
          }
        } catch {
          await finalize({
            state: 'not-applied',
            application: 'not-applied',
            reason: 'approval-policy-mismatch',
          });
          throw new ToolboxPolicyError(
            'provider-write-authority-binding-invalid',
            'Trusted provider authority could not be revalidated before dispatch',
          );
        }

        const dispatchResult = await approvalStore.markDispatching(
          binding,
          permit.attemptId,
          dispatchAuthority.operationScope,
        );
        if (dispatchResult.status === 'existing-attempt') {
          throw new ToolboxPolicyError(
            'provider-write-recovery-required',
            `Provider write already has a ${dispatchResult.attemptState} attempt; reconcile it without redispatch`,
          );
        }
        if (dispatchResult.status !== 'dispatch-authorized') {
          throw new ToolboxPolicyError(
            dispatchResult.status === 'expired'
              ? 'provider-write-approval-expired'
              : 'provider-write-approval-invalid',
            dispatchResult.status === 'expired'
              ? 'Provider-write approval expired before dispatch'
              : 'Provider-write dispatch claim did not match the approved attempt',
          );
        }
        let dispatchPermit: ProviderWriteAuthorization;
        try {
          dispatchPermit = ProviderWriteAuthorizationSchema.parse(
            dispatchResult.authorization,
          );
        } catch {
          await finalize({
            state: 'not-applied',
            application: 'not-applied',
            reason: 'approval-policy-mismatch',
          });
          throw new ToolboxPolicyError(
            'provider-write-approval-invalid',
            'Provider-write dispatch store returned an invalid permit',
          );
        }
        if (
          hashCanonicalJson(dispatchPermit) !== hashCanonicalJson(permit) ||
          dispatchPermit.approvalBindingHash !==
            hashProviderWriteApprovalBinding(binding) ||
          hashCanonicalJson(dispatchPermit.approvalBinding) !==
            hashCanonicalJson(binding)
        ) {
          await finalize({
            state: 'not-applied',
            application: 'not-applied',
            reason: 'approval-policy-mismatch',
          });
          throw new ToolboxPolicyError(
            'provider-write-approval-invalid',
            'Provider-write permit changed at the dispatch boundary',
          );
        }
        if (invocationContext.abortSignal.aborted) {
          await finalize({
            state: 'not-applied',
            application: 'not-applied',
            reason: 'provider-rejected-before-apply',
          });
          throw new ToolboxPolicyError(
            'provider-write-not-applied',
            'Provider write was cancelled at the dispatch boundary',
          );
        }

        let rawOutcome: unknown;
        const providerAbortController = new AbortController();
        const abortProvider = () => providerAbortController.abort();
        if (invocationContext.abortSignal.aborted) abortProvider();
        invocationContext.abortSignal.addEventListener('abort', abortProvider, {
          once: true,
        });
        let timedOut = false;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        let commitPromise: Promise<unknown> | undefined;
        try {
          commitPromise = executeProviderWrite(providerInput, {
            requestId: invocationContext.requestId,
            runId: invocationContext.runId,
            userId: invocationContext.userId,
            householdId: invocationContext.householdId,
            sessionId: invocationContext.sessionId,
            agentId: invocationContext.agentId,
            abortSignal: providerAbortController.signal,
            providerWritePermit: dispatchPermit,
            providerWriteOperationScope: dispatchAuthority.operationScope,
          });
          const timeoutPromise = new Promise<never>((_resolve, reject) => {
            timeoutHandle = setTimeout(() => {
              timedOut = true;
              abortProvider();
              reject(new Error('Provider write timed out after dispatch'));
            }, descriptor.timeoutMs);
          });
          rawOutcome = await Promise.race([commitPromise, timeoutPromise]);
        } catch {
          void commitPromise?.catch(() => undefined);
          await finalize({
            state: 'indeterminate',
            application: 'indeterminate',
            reason: timedOut
              ? 'timeout-after-dispatch'
              : 'executor-threw-after-dispatch-boundary',
            reconciliationRequired: true,
          });
          throw new ToolboxPolicyError(
            'provider-write-outcome-indeterminate',
            'Provider write outcome is unknown and requires reconciliation',
          );
        } finally {
          if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
          invocationContext.abortSignal.removeEventListener(
            'abort',
            abortProvider,
          );
        }

        let outcome: z.infer<typeof ProviderCommitOutcomeSchema>;
        let trustedEvidence: DeepReadonly<JsonValue> | undefined;
        try {
          const parsedOutcome =
            ProviderCommitOutcomeSchema.safeParse(rawOutcome);
          if (!parsedOutcome.success) throw new TypeError('Invalid outcome');
          outcome = parsedOutcome.data;
          trustedEvidence =
            outcome.evidence === undefined
              ? undefined
              : snapshotBoundedJson(outcome.evidence);
        } catch {
          await finalize({
            state: 'indeterminate',
            application: 'indeterminate',
            reason: 'provider-outcome-envelope-invalid',
            reconciliationRequired: true,
          });
          throw new ToolboxPolicyError(
            'provider-write-outcome-indeterminate',
            'Provider returned an invalid outcome envelope; reconciliation is required',
          );
        }
        const evidence =
          trustedEvidence === undefined
            ? {}
            : { evidenceHash: hashCanonicalJson(trustedEvidence) };

        if (outcome.application === 'not-applied') {
          await finalize({
            state: 'not-applied',
            application: 'not-applied',
            reason: outcome.reason,
            ...evidence,
          });
          throw new ToolboxPolicyError(
            outcome.reason === 'provider-precondition-failed'
              ? 'provider-write-precondition-stale'
              : 'provider-write-not-applied',
            'Provider rejected the conditional write before applying it',
          );
        }

        if (outcome.application === 'indeterminate') {
          await finalize({
            state: 'indeterminate',
            application: 'indeterminate',
            reason: outcome.reason,
            reconciliationRequired: true,
            ...evidence,
          });
          throw new ToolboxPolicyError(
            'provider-write-outcome-indeterminate',
            'Provider write outcome is unknown and requires reconciliation',
          );
        }

        let parsedOutput: unknown;
        let resultHash: string;
        try {
          parsedOutput = snapshotBoundedJson(
            runtimeSchemas.parse(descriptor.outputSchema, outcome.output),
          );
          resultHash = hashCanonicalJson(parsedOutput);
        } catch {
          await finalize({
            state: 'executed',
            application: 'applied',
            outputStatus: 'invalid',
            safeErrorCode: 'provider-write-output-invalid',
            ...evidence,
          });
          throw new ToolboxPolicyError(
            'provider-write-output-invalid',
            'Provider applied the write but returned an invalid output',
          );
        }
        await finalize({
          state: 'executed',
          application: 'applied',
          outputStatus: 'valid',
          resultHash,
          ...evidence,
        });
        return parsedOutput;
      }

      if (executeStandardCapability === undefined) {
        throw new ToolboxPolicyError(
          'capability-registration-invalid',
          'Capability executor is unavailable',
        );
      }
      const rawOutput = await executeStandardCapability(
        parsedInput,
        invocationContext,
      );
      return runtimeSchemas.parse(descriptor.outputSchema, rawOutput);
    };

    const resolved: ResolvedCapability =
      descriptor.capabilityKind === 'provider-write'
        ? Object.freeze({ descriptor, invoke })
        : Object.freeze({ descriptor, invoke });
    byId.set(descriptor.id, resolved);
  }

  const resolveForAgent: CapabilityRegistry['resolveForAgent'] = (
    rawRequest,
  ) => {
    const request = ResolutionRequestSchema.parse(rawRequest);
    const seen = new Set<string>();

    return Object.freeze(
      request.requestedCapabilityIds.map((capabilityId) => {
        if (seen.has(capabilityId)) {
          throw new ToolboxPolicyError(
            'duplicate-capability',
            `Capability ${capabilityId} was requested more than once`,
          );
        }
        seen.add(capabilityId);

        const registration = byId.get(capabilityId);
        if (registration === undefined) {
          throw new ToolboxPolicyError(
            'unknown-capability',
            `Capability ${capabilityId} is not registered`,
          );
        }

        assertCapabilityAllowed(request.manifest, registration.descriptor);
        const descriptor = registration.descriptor;
        const invoke = (input: unknown, context: CapabilityInvocationContext) =>
          registration.invoke(input, {
            ...context,
            agentId: request.manifest.id,
          });
        return descriptor.capabilityKind === 'provider-write'
          ? Object.freeze({ descriptor, invoke })
          : Object.freeze({ descriptor, invoke });
      }),
    );
  };

  return Object.freeze({ size: byId.size, resolveForAgent });
};

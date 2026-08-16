import {
  EffectiveAuthorizationScopeFingerprintSchema,
  JsonValueSchema,
  OpaqueReferenceSchema,
  ProviderWriteAuthorizationSchema,
  ProviderWriteOperationScopeSchema,
  Sha256Schema,
  TrustedProviderWriteAuthorityResolutionSchema,
  UuidSchema,
  deepFreeze,
  type ProviderCommitOutcome,
  type TrustedProviderWriteAuthorityResolution,
} from '@emdo/contracts';
import {
  PostgresCalendarWriteReceiptStore,
  type EmdoDatabaseClient,
  type PostgresGoogleCalendarProposalAuthorityResolver,
} from '@emdo/db/api';
import {
  CalendarCanonicalArgumentsSchema,
  type CalendarProposalStateReader,
} from '@emdo/domains/scheduler';
import {
  CalendarWriteExecutor,
  hashGoogleCalendarPayload,
  isGoogleCalendarWriteAuthorized,
  type CalendarWriteResult,
} from '@emdo/integrations/google-calendar';
import { z } from 'zod';

import {
  parseProductionProviderWriteCapabilityId,
  type TrustedProviderProposalAuthorityResolver,
} from '../agents/capability-runtime.js';
import type { TrustedProviderWriteCapabilityBinding } from '../agents/production-bindings.js';
import { AuthenticatedPrincipalSchema } from '../schemas.js';
import type { AuthenticatedPrincipal } from '../services/contracts.js';
import type { RequestScopedGoogleCalendarConditionalGatewayFactory } from './google-services.js';

type DatabasePool = EmdoDatabaseClient['scopedPool'];

const PrincipalWithPrivateSpaceSchema = AuthenticatedPrincipalSchema.extend({
  privateSpaceId: UuidSchema,
});
type PrincipalWithPrivateSpace = z.infer<typeof PrincipalWithPrivateSpaceSchema>;

const ProposalAuthorityInputSchema = z.strictObject({
  requestId: UuidSchema,
  runId: UuidSchema,
  householdId: UuidSchema,
  userId: UuidSchema,
  authenticatedSessionId: UuidSchema,
  spaceAccessGrantId: UuidSchema,
  authorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprintSchema,
  agentId: z.literal('scheduler'),
  disclosureGrantId: UuidSchema,
  sdkCallId: OpaqueReferenceSchema,
  capabilityId: z.literal('google-calendar.event.create'),
  capabilityFingerprint: Sha256Schema,
});
type ProposalAuthorityInput = Parameters<
  TrustedProviderProposalAuthorityResolver['resolve']
>[0];

const ProviderWriteInvocationSchema = z.strictObject({
  requestId: UuidSchema,
  runId: UuidSchema,
  userId: UuidSchema,
  householdId: UuidSchema,
  sessionId: UuidSchema,
  agentId: z.literal('scheduler'),
  providerWritePermit: ProviderWriteAuthorizationSchema,
  providerWriteOperationScope: ProviderWriteOperationScopeSchema,
});

const closedNotApplied = (
  evidence: unknown,
): ProviderCommitOutcome<CalendarWriteResult> =>
  ({
    application: 'not-applied' as const,
    reason: 'approval-policy-mismatch' as const,
    evidence: JsonValueSchema.parse(evidence),
  });

const mapCalendarWriteOutcome = (
  result: CalendarWriteResult,
): ProviderCommitOutcome<CalendarWriteResult> => {
  const evidence = JsonValueSchema.parse({ calendarWrite: result });
  if (result.status === 'applied') {
    return {
      application: 'applied' as const,
      output: result,
      evidence,
    };
  }
  if (result.status === 'not-applied') {
    return {
      application: 'not-applied' as const,
      reason:
        result.safeError.code === 'calendar-precondition-failed'
          ? ('provider-precondition-failed' as const)
          : ('provider-rejected-before-apply' as const),
      evidence,
    };
  }
  return {
    application: 'indeterminate' as const,
    reason: 'transport-lost-after-dispatch' as const,
    evidence,
  };
};

const isBoundToAuthenticatedPrincipal = (
  principal: PrincipalWithPrivateSpace,
  context: z.infer<typeof ProviderWriteInvocationSchema>,
): boolean => {
  const scope = context.providerWriteOperationScope;
  const binding = context.providerWritePermit.approvalBinding;
  const authority = binding.authorityBinding;
  return (
    context.userId === principal.userId &&
    context.householdId === principal.householdId &&
    context.sessionId === principal.sessionId &&
    context.agentId === 'scheduler' &&
    scope.requestId === context.requestId &&
    scope.sessionId === principal.sessionId &&
    scope.householdId === principal.householdId &&
    scope.userId === principal.userId &&
    scope.spaceAccessGrantId === principal.spaceAccessGrantId &&
    scope.authorizationScopeFingerprint ===
      principal.collectionAuthorizationScopeFingerprint &&
    binding.userId === principal.userId &&
    binding.agentId === 'scheduler' &&
    binding.runId === context.runId &&
    binding.capabilityId === 'google-calendar.event.create' &&
    authority.householdId === principal.householdId &&
    authority.privateSpaceId === principal.privateSpaceId &&
    authority.authorizationScopeFingerprint ===
      principal.collectionAuthorizationScopeFingerprint
  );
};

/**
 * Binds the one approved Calendar-create capability to one authenticated
 * private space. Proposal materialization remains an injected P0-C boundary;
 * this adapter owns only post-decision, durable provider execution.
 */
export const createRequestScopedGoogleCalendarEventCreateBinding = (
  input: Readonly<{
    principal: unknown;
    pool: DatabasePool;
    google: RequestScopedGoogleCalendarConditionalGatewayFactory;
    materializeProposal: TrustedProviderWriteCapabilityBinding['materializeProposal'];
  }>,
): TrustedProviderWriteCapabilityBinding => {
  const principal = PrincipalWithPrivateSpaceSchema.safeParse(input.principal);
  if (
    !principal.success ||
    typeof input.google?.createConditionalGateway !== 'function' ||
    typeof input.materializeProposal !== 'function'
  ) {
    throw new Error('api-google-calendar-event-create-unavailable');
  }
  return Object.freeze({
    materializeProposal: input.materializeProposal,
    providerWriteSafety: Object.freeze({
      atomicConditions: 'provider-native-single-request' as const,
      idempotency: 'provider-key' as const,
      retryOwnership: 'adapter-bounded-within-invocation' as const,
      reconciliation: 'required' as const,
    }),
    executeProviderWrite: async (
      rawArguments: Parameters<
        TrustedProviderWriteCapabilityBinding['executeProviderWrite']
      >[0],
      rawContext: Parameters<
        TrustedProviderWriteCapabilityBinding['executeProviderWrite']
      >[1],
    ) => {
      const arguments_ = CalendarCanonicalArgumentsSchema.safeParse(
        rawArguments,
      );
      const context = ProviderWriteInvocationSchema.safeParse({
        requestId: rawContext.requestId,
        runId: rawContext.runId,
        userId: rawContext.userId,
        householdId: rawContext.householdId,
        sessionId: rawContext.sessionId,
        agentId: rawContext.agentId,
        providerWritePermit: rawContext.providerWritePermit,
        providerWriteOperationScope: rawContext.providerWriteOperationScope,
      });
      if (
        !arguments_.success ||
        arguments_.data.operation !== 'create' ||
        !context.success ||
        !isBoundToAuthenticatedPrincipal(principal.data, context.data)
      ) {
        return closedNotApplied({
          calendarWrite: 'approval-or-request-binding-invalid',
        });
      }

      const command = {
        schemaVersion: 1 as const,
        operation: 'create' as const,
        calendarId: arguments_.data.calendarId,
        eventId: arguments_.data.event.eventId,
        expectedCalendarVersion: arguments_.data.expectedCalendarVersion,
        expectedEventVersion: 'absent' as const,
        payload: arguments_.data.event,
        payloadHash: hashGoogleCalendarPayload(arguments_.data.event),
        idempotencyKey: context.data.providerWritePermit.providerIdempotencyKey,
      };
      const authorization = {
        approvedCanonicalArguments: arguments_.data,
        approvalBinding: context.data.providerWritePermit.approvalBinding,
        providerWritePermit: context.data.providerWritePermit,
        providerWriteOperationScope: context.data.providerWriteOperationScope,
      };
      if (!isGoogleCalendarWriteAuthorized(command, authorization)) {
        return closedNotApplied({
          calendarWrite: 'approval-or-command-binding-invalid',
        });
      }
      const gateway = input.google.createConditionalGateway({
        principal: principal.data,
        operationScope: context.data.providerWriteOperationScope,
        approvalBinding: context.data.providerWritePermit.approvalBinding,
      });
      if (gateway === undefined) {
        return closedNotApplied({ calendarWrite: 'connector-unavailable' });
      }
      const receiptStore = new PostgresCalendarWriteReceiptStore(
        input.pool,
        {
          userId: principal.data.userId,
          householdId: principal.data.householdId,
          sessionId: principal.data.sessionId,
          requestId: context.data.requestId,
        },
        { spaceId: principal.data.privateSpaceId, runId: context.data.runId },
      );
      const result = await new CalendarWriteExecutor(gateway, receiptStore).execute(
        command,
        authorization,
      );
      return mapCalendarWriteOutcome(result);
    },
  });
};

export interface RequestScopedGoogleCalendarProposalReaderFactory {
  createProposalTargetReader(input: Readonly<{
    principal: ReturnType<typeof AuthenticatedPrincipalSchema.parse>;
    requestId: string;
    authorityResolution: TrustedProviderWriteAuthorityResolution;
  }>): CalendarProposalStateReader | undefined;
}

export interface RequestScopedGoogleCalendarCoreRuntime {
  readonly proposalStateReader: CalendarProposalStateReader;
}

/**
 * Adapts one authenticated request and its already-resolved Calendar authority
 * to the target-only proposal reader. The Google factory owns readiness and
 * runtime lifecycle; this adapter rejects every mismatch before it can be used.
 */
export const createRequestScopedGoogleCalendarCoreRuntime = (input: Readonly<{
  principal: unknown;
  requestId: unknown;
  authorityResolution: unknown;
  google: RequestScopedGoogleCalendarProposalReaderFactory;
}>): RequestScopedGoogleCalendarCoreRuntime => {
  const principal = AuthenticatedPrincipalSchema.safeParse(input.principal);
  const requestId = UuidSchema.safeParse(input.requestId);
  const authority = TrustedProviderWriteAuthorityResolutionSchema.safeParse(
    input.authorityResolution,
  );
  if (!principal.success || !requestId.success || !authority.success) {
    throw new Error('api-google-calendar-core-runtime-unavailable');
  }
  const operationScope = authority.data.operationScope;
  const authorityBinding = authority.data.authorityBinding;
  if (
    operationScope.requestId !== requestId.data ||
    operationScope.sessionId !== principal.data.sessionId ||
    operationScope.householdId !== principal.data.householdId ||
    operationScope.userId !== principal.data.userId ||
    operationScope.spaceAccessGrantId !== principal.data.spaceAccessGrantId ||
    operationScope.authorizationScopeFingerprint !==
      principal.data.collectionAuthorizationScopeFingerprint ||
    authorityBinding.householdId !== principal.data.householdId ||
    authorityBinding.privateSpaceId !== principal.data.privateSpaceId ||
    authorityBinding.authorizationScopeFingerprint !==
      principal.data.collectionAuthorizationScopeFingerprint ||
    typeof input.google?.createProposalTargetReader !== 'function'
  ) {
    throw new Error('api-google-calendar-core-runtime-unavailable');
  }
  const reader = input.google.createProposalTargetReader({
    principal: principal.data,
    requestId: requestId.data,
    authorityResolution: authority.data,
  });
  if (reader === undefined || typeof reader.readTargetState !== 'function') {
    throw new Error('api-google-calendar-core-runtime-unavailable');
  }
  return Object.freeze({
    proposalStateReader: Object.freeze({
      readTargetState: reader.readTargetState.bind(reader),
    }),
  });
};

/**
 * Adapts the proposal-phase PostgreSQL authority to the core runtime port.
 * The underlying resolver is constructed per authenticated request; this
 * adapter rejects any response that is not exactly bound to that request.
 */
export const createPostgresGoogleCalendarProposalAuthorityResolver = (
  input: Readonly<{
    resolver: Pick<PostgresGoogleCalendarProposalAuthorityResolver, 'resolve'>;
  }>,
): TrustedProviderProposalAuthorityResolver => {
  if (typeof input?.resolver?.resolve !== 'function') {
    throw new Error('api-calendar-proposal-authority-resolver-invalid');
  }
  const resolve = input.resolver.resolve.bind(input.resolver);
  return Object.freeze({
    resolve: async (rawInput: ProposalAuthorityInput) => {
      const request = ProposalAuthorityInputSchema.parse(rawInput);
      const capabilityId = parseProductionProviderWriteCapabilityId(
        request.capabilityId,
      );
      const resolved = TrustedProviderWriteAuthorityResolutionSchema.safeParse(
        await resolve({
          requestId: request.requestId,
          runId: request.runId,
          sessionId: request.authenticatedSessionId,
          userId: request.userId,
          householdId: request.householdId,
          agentId: request.agentId,
          spaceAccessGrantId: request.spaceAccessGrantId,
          disclosureGrantId: request.disclosureGrantId,
          capabilityId,
          capabilityFingerprint: request.capabilityFingerprint,
        }),
      );
      if (!resolved.success) return undefined;
      const authority = resolved.data;
      if (
        authority.authorityBinding.householdId !== request.householdId ||
        authority.authorityBinding.authorizationScopeFingerprint !==
          request.authorizationScopeFingerprint ||
        authority.operationScope.requestId !== request.requestId ||
        authority.operationScope.sessionId !== request.authenticatedSessionId ||
        authority.operationScope.householdId !== request.householdId ||
        authority.operationScope.userId !== request.userId ||
        authority.operationScope.spaceAccessGrantId !==
          request.spaceAccessGrantId ||
        authority.operationScope.authorizationScopeFingerprint !==
          request.authorizationScopeFingerprint
      ) {
        return undefined;
      }
      return deepFreeze(authority);
    },
  });
};

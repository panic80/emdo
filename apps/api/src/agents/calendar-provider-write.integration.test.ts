import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ActionProposalSchema,
  EffectiveAuthorizationScopeFingerprintSchema,
  createRuntimeSchemaRegistry,
  parseProviderWriteCapabilityDescriptor,
  type ProviderWriteAuthorityBinding,
  type ProviderWriteCapabilityContext,
  type ProviderWriteOperationScope,
} from '@emdo/contracts';
import { schedulerManifest } from '@emdo/agent-scheduler';
import {
  CalendarCanonicalArgumentsSchema,
  ScopedCalendarProposalMaterializer,
} from '@emdo/domains/scheduler';
import {
  ProposalService,
  hashActionProposalApproval,
} from '@emdo/domains/server/provider-proposals';
import { InMemoryProposalRepository } from '@emdo/domains/testing/provider-proposals';
import {
  createCapabilityRegistry,
  hashCanonicalJson,
  hashCapabilityDescriptorBinding,
  hashProviderWriteApprovalBinding,
} from '@emdo/toolbox';
import {
  CalendarWriteExecutor,
  deriveGoogleCalendarEventId,
  hashGoogleCalendarPayload,
  type CalendarWriteApprovalBinding,
  type CalendarWriteReceiptStore,
  type CalendarWriteResult,
  type GoogleCalendarConditionalGateway,
  type GoogleCalendarProviderState,
} from '@emdo/integrations/google-calendar';

const ids = {
  proposal: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f301',
  grant: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f302',
  user: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f303',
  household: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f304',
  privateSpace: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f305',
  run: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f306',
  decision: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f307',
  session: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f308',
  request: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f309',
  spaceGrant: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f30a',
} as const;

const capabilityDescriptor = parseProviderWriteCapabilityDescriptor({
  schemaVersion: 1,
  id: 'google-calendar.event.create',
  version: '1.0.0',
  capabilityKind: 'provider-write',
  inputSchema: {
    id: 'google-calendar.event-create.input',
    version: '1.0.0',
  },
  outputSchema: {
    id: 'google-calendar.event-create.output',
    version: '1.0.0',
  },
  requiredScopes: ['google-calendar.events.write'],
  requiredDataClasses: ['calendar.events'],
  riskClass: 'provider-write',
  timeoutMs: 15_000,
  freshness: {
    required: true,
    maxAgeMs: 0,
    revalidateBeforeExecution: true,
  },
  idempotency: {
    required: true,
    scope: 'provider-target',
    ttlMs: 86_400_000,
  },
  approval: {
    rule: 'authenticated-visual-proposal',
    expiresInSeconds: 600,
  },
  audit: {
    required: true,
    eventType: 'calendar.external-write',
    redactFields: ['attendees', 'description'],
  },
  executorId: 'google-calendar.event-create.v1',
});

const capabilityFingerprint =
  hashCapabilityDescriptorBinding(capabilityDescriptor);
const proposalIdempotencyKey = 'calendar-binding-integration-1';
const providerIdempotencyKey = hashCanonicalJson({
  schemaVersion: 1,
  proposalId: ids.proposal,
  capabilityId: capabilityDescriptor.id,
  capabilityFingerprint,
  disclosureGrantId: ids.grant,
  idempotencyKey: proposalIdempotencyKey,
});
const eventId = deriveGoogleCalendarEventId(providerIdempotencyKey);
const eventPayload = {
  eventId,
  summary: 'Dentist',
  start: '2026-08-10T15:00:00.000Z',
  end: '2026-08-10T16:00:00.000Z',
  timeZone: 'America/Toronto' as const,
  location: 'Clinic',
};
const canonicalArguments = {
  operation: 'create' as const,
  calendarId: 'primary',
  expectedCalendarVersion: 'calendar-v7',
  event: eventPayload,
};
const targetId = `${canonicalArguments.calendarId.length}:${canonicalArguments.calendarId}${eventId.length}:${eventId}`;

const authorizationScopeFingerprint =
  EffectiveAuthorizationScopeFingerprintSchema.parse('f'.repeat(64));

const originalAuthority = {
  kind: 'google-calendar-grant-v2',
  householdId: ids.household,
  privateSpaceId: ids.privateSpace,
  authorizationScopeFingerprint,
  providerGrantReference: 'google-grant-reference-original',
  authorizationEpoch: 1,
} as const satisfies ProviderWriteAuthorityBinding;

const currentOperationScope = {
  requestId: ids.request,
  sessionId: ids.session,
  householdId: ids.household,
  userId: ids.user,
  spaceAccessGrantId: ids.spaceGrant,
  authorizationScopeFingerprint,
} as const satisfies ProviderWriteOperationScope;

const reconnectedAuthority = {
  ...originalAuthority,
  providerGrantReference: 'google-grant-reference-reconnected',
  authorizationEpoch: 2,
} as const satisfies ProviderWriteAuthorityBinding;

const disclosureGrant = {
  schemaVersion: 1 as const,
  id: ids.grant,
  version: 1,
  userId: ids.user,
  householdId: ids.household,
  agentId: 'scheduler' as const,
  purpose: 'Create the visually approved appointment.',
  runId: ids.run,
  recordAllowlist: [
    {
      dataClass: 'calendar.events' as const,
      recordId: targetId,
      fields: [
        'calendar-id',
        'calendar-version',
        'event-id',
        'summary',
        'start',
        'end',
        'time-zone',
        'location',
      ],
    },
  ],
  provider: 'google-calendar' as const,
  createdAt: '2026-08-09T12:00:00.000Z',
  expiresAt: '2026-08-09T12:10:00.000Z',
  oneRunOnly: true as const,
};

const runtimeSchemas = createRuntimeSchemaRegistry([
  {
    reference: capabilityDescriptor.inputSchema,
    schema: CalendarCanonicalArgumentsSchema,
  },
  {
    reference: capabilityDescriptor.outputSchema,
    schema: z.unknown(),
  },
]);

class RecordedConditionalGateway implements GoogleCalendarConditionalGateway {
  readCurrentCount = 0;
  applyCount = 0;
  readBackCount = 0;

  constructor(
    private readonly before: GoogleCalendarProviderState,
    private readonly after: GoogleCalendarProviderState,
  ) {}

  async readCurrent(): Promise<GoogleCalendarProviderState> {
    this.readCurrentCount += 1;
    return this.before;
  }

  async applyConditionalExactlyOnce(): Promise<unknown> {
    this.applyCount += 1;
    return {
      status: 'applied' as const,
      providerRequestId: 'recorded-binding-request-1',
    };
  }

  async readBack(): Promise<GoogleCalendarProviderState> {
    this.readBackCount += 1;
    return this.after;
  }
}

const receiptStore = (): CalendarWriteReceiptStore => ({
  acquire: async () => ({ status: 'acquired' as const }),
  complete: async () => undefined,
});

const buildHarness = async (
  resolvedAuthority: ProviderWriteAuthorityBinding,
) => {
  const materializer = new ScopedCalendarProposalMaterializer(
    {
      readTargetState: async ({ calendarId, eventId: queriedEventId }) => ({
        calendarId,
        queriedEventId,
        calendarVersion: 'calendar-v7',
        event: null,
      }),
    },
    originalAuthority,
  );
  const now = new Date('2026-08-09T12:05:00.000Z');
  const materialized = await materializer.materialize({
    capabilityId: capabilityDescriptor.id,
    capabilityFingerprint,
    canonicalArguments,
    disclosureGrant,
    now,
  });
  const proposalInput = {
    schemaVersion: 1 as const,
    id: ids.proposal,
    version: 1,
    runId: ids.run,
    capabilityId: capabilityDescriptor.id,
    capabilityFingerprint,
    authorizationScopeFingerprint,
    canonicalArguments,
    ...materialized,
    providerSdkCallId: 'call-calendar-binding-integration-1',
    payloadHash: hashCanonicalJson(canonicalArguments),
    disclosureGrant,
    createdAt: '2026-08-09T12:00:00.000Z',
    expiresAt: '2026-08-09T12:10:00.000Z',
    idempotencyKey: proposalIdempotencyKey,
    state: 'pending' as const,
  };
  const proposal = ActionProposalSchema.parse({
    ...proposalInput,
    approvalHash: hashActionProposalApproval(proposalInput),
  });
  const proposalService = new ProposalService(
    materializer,
    {
      resolve: async (grantId: string) =>
        grantId === disclosureGrant.id ? disclosureGrant : undefined,
    },
    new InMemoryProposalRepository(),
    () => new Date(now),
  );
  await proposalService.create(proposal, {
    proposalId: proposal.id,
    originRequestId: ids.request,
    runId: proposal.runId,
    householdId: ids.household,
    userId: ids.user,
    originSessionId: ids.session,
    agentId: 'scheduler',
    originSpaceAccessGrantId: currentOperationScope.spaceAccessGrantId,
    disclosureGrantId: proposal.disclosureGrant.id,
    disclosurePolicyVersion: '1.0.0',
    capabilityId: proposal.capabilityId,
    sdkCallId: proposal.providerSdkCallId,
    providerAuthorityBindingHash: proposal.providerAuthorityBindingHash,
  });
  const decision = await proposalService.decide(
    {
      schemaVersion: 1,
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      approvalHash: proposal.approvalHash,
      decision: 'approved',
      idempotencyKey: 'calendar-binding-decision-1',
    },
    {
      decisionId: ids.decision,
      operationScope: currentOperationScope,
      channel: 'authenticated-visual',
      now: new Date('2026-08-09T12:04:00.000Z'),
    },
  );
  const gateway = new RecordedConditionalGateway(
    {
      calendarId: canonicalArguments.calendarId,
      queriedEventId: eventId,
      calendarVersion: 'calendar-v7',
      event: null,
    },
    {
      calendarId: canonicalArguments.calendarId,
      queriedEventId: eventId,
      calendarVersion: 'calendar-v8',
      event: { ...eventPayload, eventVersion: 'event-v1' },
    },
  );
  const calendarExecutor = new CalendarWriteExecutor(gateway, receiptStore());
  let providerExecutions = 0;
  let observedBinding: CalendarWriteApprovalBinding | undefined;
  let observedBindingHash: string | undefined;
  let observedResult: CalendarWriteResult | undefined;
  const registry = createCapabilityRegistry(
    [
      {
        descriptor: capabilityDescriptor,
        providerWriteSafety: {
          atomicConditions: 'provider-native-single-request',
          idempotency: 'provider-key',
          retryOwnership: 'adapter-bounded-within-invocation',
          reconciliation: 'required',
        },
        executeProviderWrite: async (
          input: unknown,
          context: ProviderWriteCapabilityContext,
        ) => {
          providerExecutions += 1;
          const approvedCanonicalArguments =
            CalendarCanonicalArgumentsSchema.parse(input);
          if (approvedCanonicalArguments.operation !== 'create') {
            throw new Error('unexpected-calendar-operation');
          }
          observedBinding = context.providerWritePermit.approvalBinding;
          observedBindingHash = context.providerWritePermit.approvalBindingHash;
          const result = await calendarExecutor.execute(
            {
              schemaVersion: 1,
              operation: 'create',
              calendarId: approvedCanonicalArguments.calendarId,
              eventId: approvedCanonicalArguments.event.eventId,
              expectedCalendarVersion:
                approvedCanonicalArguments.expectedCalendarVersion,
              expectedEventVersion: 'absent',
              payload: approvedCanonicalArguments.event,
              payloadHash: hashGoogleCalendarPayload(
                approvedCanonicalArguments.event,
              ),
              idempotencyKey:
                context.providerWritePermit.providerIdempotencyKey,
            },
            {
              approvedCanonicalArguments,
              approvalBinding: context.providerWritePermit.approvalBinding,
              providerWritePermit: context.providerWritePermit,
              providerWriteOperationScope: context.providerWriteOperationScope,
            },
          );
          observedResult = result;
          if (result.status !== 'applied') {
            throw new Error('calendar-write-not-applied');
          }
          return { application: 'applied' as const, output: result };
        },
      },
    ],
    runtimeSchemas,
    {
      providerWriteApprovalStore: proposalService.approvalStore,
      trustedProviderWriteAuthorityResolver: {
        resolve: async () => ({
          authorityBinding: resolvedAuthority,
          operationScope: currentOperationScope,
        }),
      },
      now: () => new Date(now),
    },
  );
  const [capability] = registry.resolveForAgent({
    manifest: schedulerManifest,
    requestedCapabilityIds: [capabilityDescriptor.id],
  });
  if (capability === undefined) throw new Error('calendar-capability-missing');

  return {
    capability,
    decision,
    gateway,
    proposal,
    proposalService,
    getProviderExecutions: () => providerExecutions,
    getObservedBinding: () => observedBinding,
    getObservedBindingHash: () => observedBindingHash,
    getObservedResult: () => observedResult,
  };
};

const invocationContext = (decisionId: string) => ({
  requestId: ids.request,
  runId: ids.run,
  sessionId: ids.session,
  userId: ids.user,
  householdId: ids.household,
  agentId: 'scheduler',
  spaceAccessGrantId: currentOperationScope.spaceAccessGrantId,
  disclosureGrantId: ids.grant,
  approvalDecisionId: decisionId,
  abortSignal: new AbortController().signal,
});

describe('Google Calendar canonical provider-write integration', () => {
  it('carries one exact approval binding through proposal, registry, and Calendar readback', async () => {
    const harness = await buildHarness(originalAuthority);

    await expect(
      harness.capability.invoke(
        canonicalArguments,
        invocationContext(harness.decision.id),
      ),
    ).resolves.toMatchObject({
      status: 'applied',
      providerRequestId: 'recorded-binding-request-1',
      readback: { eventId, eventVersion: 'event-v1' },
    });

    const observedBinding = harness.getObservedBinding();
    expect(observedBinding).toBeDefined();
    expect(harness.getObservedBindingHash()).toBe(
      hashProviderWriteApprovalBinding(observedBinding!),
    );
    expect(observedBinding?.authorityBinding).toEqual(originalAuthority);
    expect(harness.proposal.providerAuthorityBindingHash).toBe(
      hashCanonicalJson(originalAuthority),
    );
    expect(harness.getObservedResult()).toMatchObject({ status: 'applied' });
    expect(harness.gateway.applyCount).toBe(1);
    expect(harness.getProviderExecutions()).toBe(1);
    expect(
      (await harness.proposalService.getProposal(harness.proposal.id))?.state,
    ).toBe('executed');
  });

  it('rejects a stale approval when reconnect rotates the grant reference and epoch', async () => {
    const harness = await buildHarness(reconnectedAuthority);

    await expect(
      harness.capability.invoke(
        canonicalArguments,
        invocationContext(harness.decision.id),
      ),
    ).rejects.toMatchObject({ code: 'provider-write-approval-invalid' });
    expect(harness.getProviderExecutions()).toBe(0);
    expect(harness.gateway.readCurrentCount).toBe(0);
    expect(harness.gateway.applyCount).toBe(0);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { tool as createOpenAiTool } from '@openai/agents';

import { AgentFactory, createOpenAiAgentsSdkFacade } from '@emdo/agent-core';
import { financeAgentDefinition } from '@emdo/agent-finance';
import { managerAgentDefinition } from '@emdo/agent-manager';
import { schedulerAgentDefinition } from '@emdo/agent-scheduler';
import { shoppingAgentDefinition } from '@emdo/agent-shopping';
import {
  EffectiveAuthorizationScopeFingerprintSchema,
  type ActionProposal,
  type CapabilityDescriptor,
} from '@emdo/contracts';
import {
  FOUNDATIONAL_SKILLS,
  hashCanonicalJson,
  hashCapabilityDescriptorBinding,
  type ProviderWriteApprovalStore,
} from '@emdo/toolbox';

import {
  ALL_MANAGER_DELEGATION_CAPABILITY_IDS,
  ALL_SPECIALIST_CAPABILITY_IDS,
  REQUIRED_CAPABILITY_BINDING_KINDS,
  capabilitySchemaRegistrations,
  createProductionCapabilityRuntime,
  parseSpecialistCapabilityOutput,
  parseProductionProviderWriteCapabilityId,
  type ProductionCapabilityBindings,
  type SpecialistCapabilityId,
} from './capability-runtime.js';

const IDS = {
  proposal: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f001',
  grant: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f002',
  user: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f003',
  household: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f004',
  run: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f005',
  request: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f006',
  decision: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f007',
  privateSpace: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f008',
  session: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f009',
  spaceAccessGrant: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f00a',
} as const;

const authorizationScopeFingerprint =
  EffectiveAuthorizationScopeFingerprintSchema.parse('e'.repeat(64));
const CALENDAR_CREATE = parseProductionProviderWriteCapabilityId(
  'google-calendar.event.create',
);
const authorityBinding = Object.freeze({
  kind: 'google-calendar-grant-v2' as const,
  householdId: IDS.household,
  privateSpaceId: IDS.privateSpace,
  authorizationScopeFingerprint,
  providerGrantReference: 'google-calendar-grant-reference-1',
  authorizationEpoch: 1,
});
const operationScope = Object.freeze({
  requestId: IDS.request,
  sessionId: IDS.session,
  householdId: IDS.household,
  userId: IDS.user,
  spaceAccessGrantId: IDS.spaceAccessGrant,
  authorizationScopeFingerprint,
});
const authorityResolution = Object.freeze({
  authorityBinding,
  operationScope,
});

const authorityResolvers = () => ({
  trustedProviderWriteAuthorityResolver: Object.freeze({
    resolve: vi.fn(async () => authorityResolution),
  }),
  trustedProviderProposalAuthorityResolver: Object.freeze({
    resolve: vi.fn(async () => authorityResolution),
  }),
});

const proposal = (input: {
  readonly capabilityId: string;
  readonly capabilityFingerprint: string;
  readonly canonicalArguments: ActionProposal['canonicalArguments'];
  readonly sdkCallId: string;
}): ActionProposal => ({
  schemaVersion: 1,
  id: IDS.proposal,
  version: 1,
  runId: IDS.run,
  providerSdkCallId: input.sdkCallId,
  capabilityId: input.capabilityId,
  capabilityFingerprint: input.capabilityFingerprint,
  authorizationScopeFingerprint,
  canonicalArguments: input.canonicalArguments,
  targets: [
    {
      kind: 'google-calendar.event',
      id: 'event-target-1',
      expectedVersion: 'etag-1',
    },
  ],
  beforePreview: null,
  afterPreview: { title: 'Dentist appointment' },
  approvalDisplay: {
    schemaVersion: 1,
    title: 'Create Google Calendar event',
    summary: 'Review this event before creating it in Google Calendar.',
    beforeSummary: 'No event exists at the approved target.',
    afterSummary: 'The approved event will be created.',
    fields: [{ label: 'Title', value: 'Dentist appointment' }],
  },
  providerPreconditions: [
    {
      kind: 'calendar-version',
      targetId: 'primary',
      expectedValue: 'sync-token-1',
    },
  ],
  providerAuthorityBindingHash: hashCanonicalJson(authorityBinding),
  payloadHash: hashCanonicalJson(input.canonicalArguments),
  approvalHash: 'b'.repeat(64),
  disclosureGrant: {
    schemaVersion: 1,
    id: IDS.grant,
    version: 1,
    userId: IDS.user,
    householdId: IDS.household,
    agentId: 'scheduler',
    purpose: 'Prepare the requested Calendar event proposal.',
    runId: IDS.run,
    recordAllowlist: [
      {
        dataClass: 'calendar.events',
        recordId: 'event-target-1',
        fields: ['starts-at', 'ends-at', 'title'],
      },
    ],
    provider: 'google-calendar',
    createdAt: '2026-08-09T16:00:00.000Z',
    expiresAt: '2026-08-09T16:10:00.000Z',
    oneRunOnly: true,
  },
  createdAt: '2026-08-09T16:00:00.000Z',
  expiresAt: '2026-08-09T16:10:00.000Z',
  idempotencyKey: 'proposal:018f1f5e:calendar-write',
  state: 'pending',
});

const specialistResult = {
  summary: 'Completed safely.',
  clarificationQuestion: null,
  evidenceReferences: [],
  derivedValueReferences: [],
  actionProposalReferences: [],
} as const;

const calendarCreateArguments = Object.freeze({
  schemaVersion: 1 as const,
  calendarRef: 'calendar-primary-ref',
  event: Object.freeze({
    summary: 'Dentist appointment',
    start: '2026-08-11T14:00:00-04:00',
    end: '2026-08-11T15:00:00-04:00',
    timeZone: 'America/Toronto' as const,
  }),
});

const instant = '2026-08-11T14:00:00-04:00';
const laterInstant = '2026-08-11T15:00:00-04:00';
const safeError = {
  code: 'operation-rejected',
  message: 'The operation was rejected.',
  retryable: false,
} as const;
const calendarSafeError = {
  code: 'calendar-provider-rejected',
  message: 'The provider rejected the operation.',
  retryable: false,
} as const;
const specialistSchemaSamples = {
  'scheduler.calendar.freebusy.read': {
    input: { schemaVersion: 1, windowStart: instant, windowEnd: laterInstant },
    output: {
      schemaVersion: 1,
      calendarRefs: [],
      blocks: [],
      snapshots: [],
      omittedBlockCount: 0,
    },
  },
  'scheduler.tasks.read': {
    input: { schemaVersion: 1, status: 'open', dueBefore: laterInstant },
    output: { schemaVersion: 1, tasks: [], nextCursor: null },
  },
  'scheduler.tasks.write': {
    input: {
      schemaVersion: 1,
      mutation: {
        kind: 'create',
        taskId: 'task-1',
        task: {
          title: 'Book dentist',
          notes: null,
          dueAt: laterInstant,
          recurrence: null,
        },
      },
    },
    output: {
      schemaVersion: 1,
      result: { status: 'rejected', task: null, safeError },
    },
  },
  'maps.travel-time.read': {
    input: {
      schemaVersion: 1,
      origin: 'Home',
      destination: 'Dentist',
      mode: 'driving',
      departureAt: instant,
    },
    output: {
      schemaVersion: 1,
      travelMinutes: 20,
      totalBufferMinutes: 30,
      source: 'google-maps',
      fetchedAt: instant,
    },
  },
  'google-calendar.event.create': {
    input: calendarCreateArguments,
    output: {
      schemaVersion: 1,
      result: {
        status: 'applied',
        providerRequestId: 'provider-request-1',
        reconciled: false,
        readbackCalendarVersion: 'calendar-etag-1',
        readback: null,
      },
    },
  },
  'google-calendar.event.update': {
    input: {
      schemaVersion: 1,
      calendarRef: 'calendar-primary-ref',
      eventRef: 'event-1-ref',
      replacement: {
        summary: 'Updated appointment',
        start: instant,
        end: laterInstant,
        timeZone: 'America/Toronto',
      },
    },
    output: {
      schemaVersion: 1,
      result: { status: 'not-applied', safeError: calendarSafeError },
    },
  },
  'google-calendar.event.delete': {
    input: {
      schemaVersion: 1,
      calendarRef: 'calendar-primary-ref',
      eventRef: 'event-1-ref',
    },
    output: {
      schemaVersion: 1,
      result: {
        status: 'indeterminate',
        reconciliationRequired: true,
        safeError: calendarSafeError,
      },
    },
  },
  'finance.records.read': {
    input: { schemaVersion: 1, recordTypes: ['transaction'], limit: 25 },
    output: { schemaVersion: 1, records: [], nextCursor: null },
  },
  'finance.records.write': {
    input: {
      schemaVersion: 1,
      mutation: {
        kind: 'create',
        recordId: 'transaction-1',
        record: {
          recordType: 'transaction',
          accountId: 'account-1',
          categoryId: null,
          postedOn: '2026-08-11',
          description: 'Groceries',
          amountCadMinor: -1299,
        },
      },
    },
    output: {
      schemaVersion: 1,
      result: { status: 'rejected', record: null, safeError },
    },
  },
  'finance.statement.import': {
    input: {
      schemaVersion: 1,
      request: { kind: 'commit', planId: 'reviewed-plan-1' },
    },
    output: {
      schemaVersion: 1,
      result: {
        status: 'confirmation-required',
        proposal: {
          state: 'proposed',
          operation: 'finance-statement-import-commit',
          channel: 'emdo-authenticated-visual',
          canonicalHash: 'a'.repeat(64),
        },
      },
    },
  },
  'finance.analytics.calculate': {
    input: { schemaVersion: 1, month: '2026-08' },
    output: {
      schemaVersion: 1,
      result: {
        status: 'calculated',
        month: '2026-08',
        timezone: 'America/Toronto',
        currency: 'CAD',
        categoryTotals: [],
        totals: {
          inflowCadMinor: 0,
          outflowCadMinor: 0,
          netCadMinor: 0,
        },
      },
    },
  },
  'finance.documents.search': {
    input: {
      schemaVersion: 1,
      query: 'Example Market',
      documentTypes: ['receipt'],
      from: '2026-08-01',
      to: '2026-08-31',
      limit: 10,
    },
    output: {
      schemaVersion: 1,
      hits: [
        {
          documentId: 'document-1',
          documentType: 'receipt',
          displayName: 'Example Market receipt',
          occurredOn: '2026-08-11',
          currency: 'CAD',
          amountMinor: 1299,
          score: 0.98,
          evidence: [
            {
              evidenceId: 'evidence-1',
              documentId: 'document-1',
              documentType: 'receipt',
              displayName: 'Example Market receipt',
              page: 1,
              excerpt: 'Groceries 12.99 CAD',
              sourceLocale: 'en-CA',
            },
          ],
        },
      ],
    },
  },
  'finance.documents.read': {
    input: {
      schemaVersion: 1,
      documentId: 'document-1',
      evidenceIds: ['evidence-1'],
    },
    output: {
      schemaVersion: 1,
      document: {
        id: 'document-1',
        documentType: 'receipt',
        displayName: 'Example Market receipt',
        sourceLocale: 'en-CA',
        currency: 'CAD',
        summary: 'A receipt for groceries totaling 12.99 CAD.',
        committedAt: instant,
      },
      evidence: [
        {
          evidenceId: 'evidence-1',
          documentId: 'document-1',
          documentType: 'receipt',
          displayName: 'Example Market receipt',
          page: 1,
          excerpt: 'Groceries 12.99 CAD',
          sourceLocale: 'en-CA',
        },
      ],
    },
  },
  'finance.matches.read': {
    input: {
      schemaVersion: 1,
      documentId: 'document-1',
      states: ['suggested'],
      limit: 25,
    },
    output: {
      schemaVersion: 1,
      matches: [
        {
          matchId: 'match-1',
          documentId: 'document-1',
          recordId: 'transaction-1',
          recordType: 'transaction',
          state: 'suggested',
          score: 0.98,
          reasons: ['Amount and merchant match the transaction.'],
        },
      ],
    },
  },
  'shopping.items.read': {
    input: { schemaVersion: 1, kinds: ['grocery'], limit: 25 },
    output: { schemaVersion: 1, items: [], nextCursor: null },
  },
  'shopping.items.write': {
    input: {
      schemaVersion: 1,
      mutation: {
        kind: 'delta',
        itemId: 'milk',
        quantityMilliUnits: 1_000,
      },
    },
    output: {
      schemaVersion: 1,
      result: { status: 'rejected', item: null, safeError },
    },
  },
  'commerce.offers.read': {
    input: { schemaVersion: 1, itemIds: ['milk'], maximumAgeMs: 60_000 },
    output: {
      schemaVersion: 1,
      offers: [],
      observedAt: instant,
      unknownCosts: [{ component: 'tax', reason: 'Tax is unknown.' }],
    },
  },
  'commerce.offers.refresh': {
    input: {
      schemaVersion: 1,
      query: 'milk',
      limit: 10,
      maximumAgeMs: 60_000,
    },
    output: {
      schemaVersion: 1,
      result: { status: 'blocked', safeError },
    },
  },
  'commerce.link-out.prepare': {
    input: { schemaVersion: 1, offerId: 'offer-1' },
    output: {
      schemaVersion: 1,
      result: {
        status: 'ready',
        url: 'https://retailer.example/product/offer-1',
        rel: 'noopener noreferrer external',
      },
    },
  },
} as const satisfies Record<
  SpecialistCapabilityId,
  { readonly input: unknown; readonly output: unknown }
>;

const createBindings = () => {
  const bindings: Record<string, unknown> = {};
  for (const [capabilityId, kind] of Object.entries(
    REQUIRED_CAPABILITY_BINDING_KINDS,
  )) {
    if (kind === 'provider-write') {
      bindings[capabilityId] = {
        kind,
        executeProviderWrite: vi.fn(async () => ({
          application: 'applied' as const,
          output: { schemaVersion: 1 as const, result: null },
        })),
        providerWriteSafety: {
          atomicConditions: 'provider-native-single-request' as const,
          idempotency: 'provider-key' as const,
          retryOwnership: 'adapter-bounded-within-invocation' as const,
          reconciliation: 'required' as const,
        },
        materializeProposal: vi.fn(
          async ({
            descriptor,
            arguments: arguments_,
            context,
          }: {
            descriptor: CapabilityDescriptor;
            arguments: unknown;
            context: { readonly sdkCallId: string };
          }) => ({
            sdkCallId: context.sdkCallId,
            proposal: proposal({
              capabilityId,
              capabilityFingerprint:
                hashCapabilityDescriptorBinding(descriptor),
              canonicalArguments:
                arguments_ as ActionProposal['canonicalArguments'],
              sdkCallId: context.sdkCallId,
            }),
          }),
        ),
      };
      continue;
    }
    bindings[capabilityId] = {
      kind,
      execute: vi.fn(async () =>
        kind === 'delegation'
          ? specialistResult
          : { schemaVersion: 1 as const, result: null },
      ),
    };
  }
  return bindings as ProductionCapabilityBindings;
};

const approvalStore = (): ProviderWriteApprovalStore => ({
  acquire: vi.fn(async () => ({ status: 'not-found' as const })),
  markDispatching: vi.fn(async () => ({ status: 'not-found' as const })),
  finalize: vi.fn(async () => 'not-found' as const),
  reconcile: vi.fn(async () => 'not-found' as const),
});

describe('production capability runtime conformance', () => {
  it('mints provider-write capability IDs only through a known validated production descriptor', () => {
    expect(
      parseProductionProviderWriteCapabilityId('google-calendar.event.create'),
    ).toBe('google-calendar.event.create');
    expect(() =>
      parseProductionProviderWriteCapabilityId('scheduler.tasks.write'),
    ).toThrow('api-provider-write-capability-id-invalid');
    expect(() =>
      parseProductionProviderWriteCapabilityId('unregistered.provider.write'),
    ).toThrow('api-provider-write-capability-id-invalid');
  });

  it('resolves every declared specialist capability and only three manager delegations', () => {
    const runtime = createProductionCapabilityRuntime({
      bindings: createBindings(),
      providerWriteApprovalStore: approvalStore(),
      ...authorityResolvers(),
    });

    expect(runtime.registry.size).toBe(22);
    expect(runtime.schemas.size).toBe(46);
    expect(
      runtime.registry.resolveForAgent({
        manifest: runtime.manifests.scheduler,
        requestedCapabilityIds: runtime.manifests.scheduler.capabilityAllowlist,
      }),
    ).toHaveLength(7);
    expect(
      runtime.registry.resolveForAgent({
        manifest: runtime.manifests.finance,
        requestedCapabilityIds: runtime.manifests.finance.capabilityAllowlist,
      }),
    ).toHaveLength(7);
    expect(
      runtime.registry.resolveForAgent({
        manifest: runtime.manifests.shopping,
        requestedCapabilityIds: runtime.manifests.shopping.capabilityAllowlist,
      }),
    ).toHaveLength(5);

    const managerCapabilities = runtime.registry.resolveForAgent({
      manifest: runtime.manifests.manager,
      requestedCapabilityIds: runtime.manifests.manager.capabilityAllowlist,
    });
    expect(managerCapabilities.map(({ descriptor }) => descriptor.id)).toEqual(
      ALL_MANAGER_DELEGATION_CAPABILITY_IDS,
    );
    expect(
      managerCapabilities.every(
        ({ descriptor }) => descriptor.capabilityKind === 'delegation',
      ),
    ).toBe(true);
    expect(() =>
      runtime.registry.resolveForAgent({
        manifest: runtime.manifests.manager,
        requestedCapabilityIds: ['scheduler.tasks.write'],
      }),
    ).toThrow();
  });

  it('fails closed when any required executor, materializer, or approval store is absent', () => {
    const missing = createBindings() as Record<string, unknown>;
    delete missing['scheduler.tasks.read'];
    expect(() =>
      createProductionCapabilityRuntime({
        bindings: missing,
        providerWriteApprovalStore: approvalStore(),
        ...authorityResolvers(),
      }),
    ).toThrow('api-capability-binding-missing:scheduler.tasks.read');

    const wrongKind = createBindings() as Record<string, unknown>;
    wrongKind['finance.records.read'] = {
      kind: 'local-write',
      execute: vi.fn(),
    };
    expect(() =>
      createProductionCapabilityRuntime({
        bindings: wrongKind,
        providerWriteApprovalStore: approvalStore(),
        ...authorityResolvers(),
      }),
    ).toThrow('api-capability-binding-kind-mismatch:finance.records.read');

    expect(() =>
      createProductionCapabilityRuntime({
        bindings: createBindings(),
        providerWriteApprovalStore: undefined,
        ...authorityResolvers(),
      }),
    ).toThrow('api-provider-write-approval-store-missing');

    expect(() =>
      createProductionCapabilityRuntime({
        bindings: createBindings(),
        providerWriteApprovalStore: approvalStore(),
        trustedProviderWriteAuthorityResolver: undefined,
        trustedProviderProposalAuthorityResolver:
          authorityResolvers().trustedProviderProposalAuthorityResolver,
      }),
    ).toThrow('api-provider-write-authority-resolver-missing');

    expect(() =>
      createProductionCapabilityRuntime({
        bindings: createBindings(),
        providerWriteApprovalStore: approvalStore(),
        trustedProviderWriteAuthorityResolver:
          authorityResolvers().trustedProviderWriteAuthorityResolver,
        trustedProviderProposalAuthorityResolver: undefined,
      }),
    ).toThrow('api-provider-proposal-authority-resolver-missing');
  });

  it('injects the approval store and does not dispatch provider writes without an exact approval', async () => {
    const bindings = createBindings();
    const store = approvalStore();
    const runtime = createProductionCapabilityRuntime({
      bindings,
      providerWriteApprovalStore: store,
      ...authorityResolvers(),
    });
    const [calendarCreate] = runtime.registry.resolveForAgent({
      manifest: runtime.manifests.scheduler,
      requestedCapabilityIds: ['google-calendar.event.create'],
    });

    await expect(
      calendarCreate?.invoke(calendarCreateArguments, {
        requestId: IDS.request,
        runId: IDS.run,
        userId: IDS.user,
        householdId: IDS.household,
        sessionId: IDS.session,
        agentId: 'untrusted-agent-name',
        locale: 'en-CA',
        spaceAccessGrantId: IDS.spaceAccessGrant,
        disclosureGrantId: IDS.grant,
        approvalDecisionId: IDS.decision,
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    expect(store.acquire).toHaveBeenCalledOnce();
    expect(store.acquire).toHaveBeenCalledWith(
      expect.objectContaining({ authorityBinding }),
      operationScope,
    );
    expect(
      (
        bindings['google-calendar.event.create'] as unknown as {
          executeProviderWrite: ReturnType<typeof vi.fn>;
        }
      ).executeProviderWrite,
    ).not.toHaveBeenCalled();
  });

  it('server-materializes provider proposals and rejects model-supplied proposal authority', async () => {
    const bindings = createBindings();
    const runtime = createProductionCapabilityRuntime({
      bindings,
      providerWriteApprovalStore: approvalStore(),
      ...authorityResolvers(),
    });
    const context = {
      requestId: IDS.request,
      runId: IDS.run,
      householdId: IDS.household,
      userId: IDS.user,
      authenticatedSessionId: IDS.session,
      spaceAccessGrantId: IDS.spaceAccessGrant,
      authorizationScopeFingerprint,
      disclosureGrantId: IDS.grant,
      disclosureGrantVersion: '1.0.0',
      sdkCallId: 'call-google-calendar-create-1',
      abortSignal: new AbortController().signal,
    } as const;

    await expect(
      runtime.materializeProviderWriteProposal({
        capabilityId: CALENDAR_CREATE,
        arguments: {
          ...calendarCreateArguments,
          proposalId: IDS.proposal,
        },
        context,
      }),
    ).rejects.toThrow('provider-write-arguments-contain-authority');
    expect(
      (
        bindings['google-calendar.event.create'] as unknown as {
          materializeProposal: ReturnType<typeof vi.fn>;
        }
      ).materializeProposal,
    ).not.toHaveBeenCalled();

    await expect(
      runtime.materializeProviderWriteProposal({
        capabilityId: CALENDAR_CREATE,
        arguments: {
          ...calendarCreateArguments,
        },
        context,
      }),
    ).resolves.toMatchObject({
      sdkCallId: context.sdkCallId,
      proposal: {
        id: IDS.proposal,
        runId: IDS.run,
        capabilityId: CALENDAR_CREATE,
        beforePreview: null,
        afterPreview: { title: 'Dentist appointment' },
        state: 'pending',
      },
    });
    expect(
      (
        bindings['google-calendar.event.create'] as unknown as {
          materializeProposal: ReturnType<typeof vi.fn>;
        }
      ).materializeProposal,
    ).toHaveBeenLastCalledWith(expect.objectContaining({ authorityBinding }));
  });

  it('requires and forwards the trusted disclosure policy version for proposal preparation', async () => {
    const bindings = createBindings();
    const runtime = createProductionCapabilityRuntime({
      bindings,
      providerWriteApprovalStore: approvalStore(),
      ...authorityResolvers(),
    });
    const context = {
      requestId: IDS.request,
      runId: IDS.run,
      householdId: IDS.household,
      userId: IDS.user,
      authenticatedSessionId: IDS.session,
      spaceAccessGrantId: IDS.spaceAccessGrant,
      authorizationScopeFingerprint,
      disclosureGrantId: IDS.grant,
      disclosureGrantVersion: '7.2.5',
      sdkCallId: 'call-google-calendar-create-versioned',
      abortSignal: new AbortController().signal,
    } as const;

    await expect(
      runtime.materializeProviderWriteProposal({
        capabilityId: CALENDAR_CREATE,
        arguments: calendarCreateArguments,
        context,
      }),
    ).resolves.toMatchObject({ sdkCallId: context.sdkCallId });
    expect(
      (
        bindings['google-calendar.event.create'] as unknown as {
          materializeProposal: ReturnType<typeof vi.fn>;
        }
      ).materializeProposal,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ disclosureGrantVersion: '7.2.5' }),
      }),
    );

    const withoutDisclosureGrantVersion: {
      disclosureGrantVersion?: unknown;
      readonly [key: string]: unknown;
    } = { ...context } as {
      readonly disclosureGrantVersion: string;
      readonly [key: string]: unknown;
    };
    delete withoutDisclosureGrantVersion.disclosureGrantVersion;
    await expect(
      runtime.materializeProviderWriteProposal({
        capabilityId: CALENDAR_CREATE,
        arguments: calendarCreateArguments,
        context: withoutDisclosureGrantVersion as never,
      }),
    ).rejects.toThrow();
  });

  it('rejects proposal preparation when connector authority rotates or disappears', async () => {
    const bindings = createBindings();
    const rotatedAuthorityBinding = Object.freeze({
      ...authorityBinding,
      providerGrantReference: 'google-calendar-grant-reference-2',
      authorizationEpoch: 2,
    });
    const runtime = createProductionCapabilityRuntime({
      bindings,
      providerWriteApprovalStore: approvalStore(),
      trustedProviderWriteAuthorityResolver:
        authorityResolvers().trustedProviderWriteAuthorityResolver,
      trustedProviderProposalAuthorityResolver: {
        resolve: vi.fn(async () => ({
          authorityBinding: rotatedAuthorityBinding,
          operationScope,
        })),
      },
    });
    const context = {
      requestId: IDS.request,
      runId: IDS.run,
      householdId: IDS.household,
      userId: IDS.user,
      authenticatedSessionId: IDS.session,
      spaceAccessGrantId: IDS.spaceAccessGrant,
      authorizationScopeFingerprint,
      disclosureGrantId: IDS.grant,
      disclosureGrantVersion: '1.0.0',
      sdkCallId: 'call-google-calendar-create-rotated',
      abortSignal: new AbortController().signal,
    } as const;

    await expect(
      runtime.materializeProviderWriteProposal({
        capabilityId: CALENDAR_CREATE,
        arguments: calendarCreateArguments,
        context,
      }),
    ).rejects.toThrow('api-provider-write-proposal-binding-invalid');
    expect(
      (
        bindings['google-calendar.event.create'] as unknown as {
          materializeProposal: ReturnType<typeof vi.fn>;
        }
      ).materializeProposal,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ authorityBinding: rotatedAuthorityBinding }),
    );

    const unavailableBindings = createBindings();
    const unavailable = createProductionCapabilityRuntime({
      bindings: unavailableBindings,
      providerWriteApprovalStore: approvalStore(),
      trustedProviderWriteAuthorityResolver:
        authorityResolvers().trustedProviderWriteAuthorityResolver,
      trustedProviderProposalAuthorityResolver: {
        resolve: vi.fn(async () => undefined),
      },
    });
    await expect(
      unavailable.materializeProviderWriteProposal({
        capabilityId: CALENDAR_CREATE,
        arguments: calendarCreateArguments,
        context,
      }),
    ).rejects.toThrow('api-provider-proposal-authority-binding-invalid');
    expect(
      (
        unavailableBindings['google-calendar.event.create'] as unknown as {
          materializeProposal: ReturnType<typeof vi.fn>;
        }
      ).materializeProposal,
    ).not.toHaveBeenCalled();
  });

  it('keeps the capability catalog exactly synchronized with all manifests', () => {
    expect(Object.keys(REQUIRED_CAPABILITY_BINDING_KINDS).sort()).toEqual(
      [
        ...ALL_SPECIALIST_CAPABILITY_IDS,
        ...ALL_MANAGER_DELEGATION_CAPABILITY_IDS,
      ].sort(),
    );
    expect(new Set(ALL_SPECIALIST_CAPABILITY_IDS).size).toBe(19);
    expect(new Set(ALL_MANAGER_DELEGATION_CAPABILITY_IDS).size).toBe(3);
  });

  it('uses distinct strict schemas for every specialist capability', () => {
    expect(capabilitySchemaRegistrations).toHaveLength(38);
    const references = capabilitySchemaRegistrations.map(
      ({ reference }) => `${reference.id}@${reference.version}`,
    );
    expect(new Set(references).size).toBe(38);
    expect(
      capabilitySchemaRegistrations.every(
        ({ schema, reference }) =>
          schema instanceof z.ZodObject && reference.version === '1.0.0',
      ),
    ).toBe(true);

    const registrations = new Map(
      capabilitySchemaRegistrations.map((registration) => [
        registration.reference.id,
        registration,
      ]),
    );
    for (const [capabilityId, sample] of Object.entries(
      specialistSchemaSamples,
    ) as [
      SpecialistCapabilityId,
      (typeof specialistSchemaSamples)[SpecialistCapabilityId],
    ][]) {
      const input = registrations.get(`${capabilityId}.input`);
      const output = registrations.get(`${capabilityId}.output`);
      expect(input?.schema.safeParse(sample.input).success, capabilityId).toBe(
        true,
      );
      expect(
        output?.schema.safeParse(sample.output).success,
        capabilityId,
      ).toBe(true);
      expect(
        input?.schema.safeParse({ schemaVersion: 1, payload: sample.input })
          .success,
        capabilityId,
      ).toBe(false);
      expect(
        output?.schema.safeParse({ schemaVersion: 1, result: sample.output })
          .success,
        capabilityId,
      ).toBe(false);

      for (const [otherCapabilityId, otherSample] of Object.entries(
        specialistSchemaSamples,
      ) as [
        SpecialistCapabilityId,
        (typeof specialistSchemaSamples)[SpecialistCapabilityId],
      ][]) {
        if (otherCapabilityId === capabilityId) continue;
        expect(
          input?.schema.safeParse(otherSample.input).success,
          `${capabilityId} accepted ${otherCapabilityId}`,
        ).toBe(false);
      }
    }
  });

  it('accepts only hash-bound EMDO Finance confirmation proposals', () => {
    const proposal = {
      schemaVersion: 1 as const,
      result: {
        status: 'confirmation-required' as const,
        proposal: {
          state: 'proposed' as const,
          operation: 'finance-reversal' as const,
          channel: 'emdo-authenticated-visual' as const,
          canonicalHash: 'a'.repeat(64),
        },
      },
    };

    expect(
      parseSpecialistCapabilityOutput('finance.records.write', proposal),
    ).toEqual(proposal);
    expect(
      parseSpecialistCapabilityOutput('finance.statement.import', {
        ...proposal,
        result: {
          ...proposal.result,
          proposal: {
            ...proposal.result.proposal,
            operation: 'finance-statement-import-commit',
          },
        },
      }),
    ).toMatchObject({ result: { status: 'confirmation-required' } });
    expect(() =>
      parseSpecialistCapabilityOutput('finance.records.write', {
        ...proposal,
        result: {
          ...proposal.result,
          proposal: {
            ...proposal.result.proposal,
            channel: 'finance-specialist-direct',
          },
        },
      }),
    ).toThrow();
  });

  it('converts every specialist input and output through the real strict SDK tool boundary', () => {
    for (const [
      index,
      registration,
    ] of capabilitySchemaRegistrations.entries()) {
      expect(
        () =>
          createOpenAiTool({
            name: `schema_conformance_${index}`,
            description: registration.reference.id,
            parameters: registration.schema,
            strict: true,
            execute: async () => ({ status: 'not-executed' }),
          }),
        `${registration.reference.id}@${registration.reference.version}`,
      ).not.toThrow();
    }
  });

  it('compiles all four live agent definitions against the production registry and schemas', () => {
    const runtime = createProductionCapabilityRuntime({
      bindings: createBindings(),
      providerWriteApprovalStore: approvalStore(),
      ...authorityResolvers(),
    });
    const factory = new AgentFactory({
      validateManifest: (value) => value as typeof runtime.manifests.manager,
      capabilityRegistry: runtime.registry,
      schemaResolver: runtime.schemaResolver,
      sharedSkills: FOUNDATIONAL_SKILLS,
      sdk: {
        createTool: (configuration) => configuration,
        createAgent: (configuration) => configuration,
      },
    });

    for (const definition of [
      managerAgentDefinition,
      schedulerAgentDefinition,
      financeAgentDefinition,
      shoppingAgentDefinition,
    ]) {
      const compiled = factory.compile(definition);
      const agent = compiled.materialize('gpt-5.6-luna');
      expect(agent.tools).toHaveLength(
        definition.manifest.capabilityAllowlist.length,
      );
      expect(agent.outputType).toBe(compiled.outputSchema);
    }

    const realSdkFactory = new AgentFactory({
      validateManifest: (value) => value as typeof runtime.manifests.manager,
      capabilityRegistry: runtime.registry,
      schemaResolver: runtime.schemaResolver,
      sharedSkills: FOUNDATIONAL_SKILLS,
      sdk: createOpenAiAgentsSdkFacade({
        proposalGateway: {
          prepare: async () => ({
            proposalId: IDS.proposal,
            providerAuthorityBindingHash: hashCanonicalJson(authorityBinding),
            authorizationScopeFingerprint,
            preview: { title: 'Provider write preview' },
          }),
          resolvePrepared: async () => undefined,
          abandonPrepared: async () => ({ status: 'abandoned' }),
          validateDecision: async () => false,
          executeDecision: async () => ({
            outcome: 'rejected',
            output: { status: 'rejected' },
            idempotencyKey: 'provider-write-test-rejected',
          }),
        },
      }),
    });
    for (const definition of [
      managerAgentDefinition,
      schedulerAgentDefinition,
      financeAgentDefinition,
      shoppingAgentDefinition,
    ]) {
      expect(() =>
        realSdkFactory.compile(definition).materialize('gpt-5.6-luna'),
      ).not.toThrow();
    }
  });
});

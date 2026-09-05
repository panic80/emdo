import { describe, expect, it, vi } from 'vitest';

import {
  DataDisclosureGrantSchema,
  EffectiveAuthorizationScopeFingerprintSchema,
  ProviderWriteAuthorizationSchema,
  type ProviderWriteCapabilityContext,
} from '@emdo/contracts';
import {
  hashGoogleCalendarPayload,
  type GoogleCalendarConditionalGateway,
} from '@emdo/integrations/google-calendar';
import { ScopedCalendarProposalMaterializer } from '@emdo/domains/scheduler';
import type { ProviderWriteAuthorityBinding } from '@emdo/contracts';
import {
  hashCanonicalJson,
  hashProviderWriteApprovalBinding,
} from '@emdo/toolbox';

import { createPostgresCoreModelDisclosureGateway } from '../agents/production-runtime-foundations.js';
import { parseProductionProviderWriteCapabilityId } from '../agents/capability-runtime.js';
import {
  createRequestScopedGoogleCalendarEventCreateBinding,
  createPostgresGoogleCalendarProposalAuthorityResolver,
  createRequestScopedGoogleCalendarCoreRuntime,
} from './core-agent-composition.js';

const ids = Object.freeze({
  grant: '42000000-0000-4000-8000-000000000001',
  household: '42000000-0000-4000-8000-000000000002',
  user: '42000000-0000-4000-8000-000000000003',
  run: '42000000-0000-4000-8000-000000000004',
  privateSpace: '42000000-0000-4000-8000-000000000005',
  parentInvocation: '42000000-0000-4000-8000-00000000000a',
  agentInvocation: '42000000-0000-4000-8000-00000000000b',
  phaseInvocation: '42000000-0000-4000-8000-00000000000c',
});

const authorizationScopeFingerprint =
  EffectiveAuthorizationScopeFingerprintSchema.parse('a'.repeat(64));
const calendarCreateCapabilityId = parseProductionProviderWriteCapabilityId(
  'google-calendar.event.create',
);
const invocation = Object.freeze({
  orchestrationRunId: ids.run,
  parentInvocationId: ids.parentInvocation,
  agentInvocationId: ids.agentInvocation,
  phaseInvocationId: ids.phaseInvocation,
  actorId: ids.user,
  locale: 'en-CA' as const,
  grantedCapabilities: Object.freeze(['google-calendar.event.create']),
});
const invocationContext = Object.freeze({
  ...invocation,
  disclosedContextRefs: Object.freeze([
    `context-ref-${hashCanonicalJson({
      dataClass: 'agent.delegations',
      recordId: 'scheduler-delegation-1',
    })}`,
  ]),
  deadline: '2026-08-15T12:10:00.000Z',
  idempotencyScope: '6'.repeat(64),
});
const invocationContextHash = hashCanonicalJson(invocationContext);
const eventId = 'abcde1';
const targetId = `7:primary${eventId.length}:${eventId}`;

const providerAuthority = {
  kind: 'google-calendar-grant-v2',
  householdId: ids.household,
  privateSpaceId: ids.privateSpace,
  authorizationScopeFingerprint,
  providerGrantReference: 'calendar-grant-reference',
  authorizationEpoch: 1,
} as const satisfies ProviderWriteAuthorityBinding;

const calendarEvent = {
  eventId,
  summary: 'Dentist appointment',
  start: '2026-08-15T15:00:00.000Z',
  end: '2026-08-15T16:00:00.000Z',
  timeZone: 'America/Toronto' as const,
};
const canonicalCreateArguments = {
  operation: 'create' as const,
  calendarId: 'primary',
  expectedCalendarVersion: 'calendar-v1',
  event: calendarEvent,
};

const principal = {
  userId: ids.user,
  householdId: ids.household,
  privateSpaceId: ids.privateSpace,
  sessionId: '42000000-0000-4000-8000-000000000008',
  spaceAccessGrantId: '42000000-0000-4000-8000-000000000009',
  collectionAuthorizationScopeFingerprint: authorizationScopeFingerprint,
  role: 'owner' as const,
  emailVerified: true,
};

const calendarCreateContext = (): ProviderWriteCapabilityContext => {
  const approvalBinding = {
    decisionId: '42000000-0000-4000-8000-000000000010',
    userId: ids.user,
    agentId: 'scheduler' as const,
    runId: ids.run,
    capabilityId: calendarCreateCapabilityId,
    capabilityFingerprint: 'b'.repeat(64),
    disclosureGrantId: ids.grant,
    payloadHash: hashGoogleCalendarPayload(canonicalCreateArguments),
    idempotencyTtlMs: 86_400_000,
    authorityBinding: providerAuthority,
  };
  const providerIdempotencyKey = 'd'.repeat(64);
  return {
    requestId: '42000000-0000-4000-8000-000000000007',
    runId: ids.run,
    userId: ids.user,
    householdId: ids.household,
    sessionId: principal.sessionId,
    agentId: 'scheduler',
    locale: 'en-CA',
    abortSignal: new AbortController().signal,
    providerWritePermit: ProviderWriteAuthorizationSchema.parse({
      proposalId: '42000000-0000-4000-8000-000000000011',
      approvalHash: 'e'.repeat(64),
      approvalBindingHash: hashProviderWriteApprovalBinding(approvalBinding),
      capabilityFingerprint: approvalBinding.capabilityFingerprint,
      proposalCreatedAt: '2026-08-15T12:00:00.000Z',
      expiresAt: '2026-08-15T12:10:00.000Z',
      disclosureGrantId: ids.grant,
      disclosureGrantHash: 'f'.repeat(64),
      approvalBinding,
      providerIdempotencyKey,
      idempotencyExpiresAt: '2026-08-16T12:01:00.000Z',
      attemptId: '42000000-0000-4000-8000-000000000012',
      attemptVersion: 1,
      issuedAt: '2026-08-15T12:01:00.000Z',
      targets: [
        {
          kind: 'google-calendar.event',
          id: targetId,
          expectedVersion: 'absent',
        },
      ],
      providerPreconditions: [
        {
          kind: 'calendar-version',
          targetId: canonicalCreateArguments.calendarId,
          expectedValue: canonicalCreateArguments.expectedCalendarVersion,
        },
        {
          kind: 'event-absence',
          targetId,
          expectedValue: 'absent',
        },
      ],
    }),
    providerWriteOperationScope: {
      requestId: '42000000-0000-4000-8000-000000000007',
      sessionId: principal.sessionId,
      householdId: ids.household,
      userId: ids.user,
      spaceAccessGrantId: principal.spaceAccessGrantId,
      authorizationScopeFingerprint,
    },
  };
};

const receiptPool = () => {
  let commandHash: unknown;
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => ({
    rowCount: 1,
    rows: sql.includes('lock_active_request_scope')
      ? [{ authorized: true }]
      : sql.includes('select command_hash') && sql.includes('lease_expires_at')
        ? []
        : sql.includes('select command_hash')
          ? [
              {
                command_hash: commandHash,
                state: 'pending',
                result: null,
              },
            ]
          : sql.includes('insert into emdo.scheduler_execution_receipts') ||
              sql.includes('update emdo.scheduler_execution_receipts')
            ? [
                (() => {
                  if (sql.includes('insert into')) commandHash = values[3];
                  return { receipt_key: values[0] };
                })(),
              ]
            : [],
  }));
  return {
    pool: {
      connect: vi.fn(async () => ({ query, release: vi.fn() })),
    } as never,
    query,
  };
};

describe('core manager and scheduler production composition', () => {
  it('creates only the exact Calendar create command and preserves the approved write outcome', async () => {
    const context = calendarCreateContext();
    const receipt = receiptPool();
    const gateway: GoogleCalendarConditionalGateway = {
      readCurrent: vi.fn(async () => ({
        calendarId: canonicalCreateArguments.calendarId,
        queriedEventId: eventId,
        calendarVersion: canonicalCreateArguments.expectedCalendarVersion,
        event: null,
      })),
      applyConditionalExactlyOnce: vi.fn(async () => ({
        status: 'applied' as const,
        providerRequestId: 'calendar-provider-request-1',
      })),
      readBack: vi.fn(async () => ({
        calendarId: canonicalCreateArguments.calendarId,
        queriedEventId: eventId,
        calendarVersion: 'calendar-v2',
        event: { ...calendarEvent, eventVersion: 'event-v1' },
      })),
    };
    const createConditionalGateway = vi.fn(() => gateway);
    const materializeProposal = vi.fn();

    const binding = createRequestScopedGoogleCalendarEventCreateBinding({
      principal,
      pool: receipt.pool,
      google: { createConditionalGateway },
      materializeProposal,
    });

    expect(createConditionalGateway).not.toHaveBeenCalled();
    const outcome = await binding.executeProviderWrite(
      canonicalCreateArguments,
      context,
    );
    expect(outcome).toMatchObject({
      application: 'applied',
      output: {
        status: 'applied',
        providerRequestId: 'calendar-provider-request-1',
      },
    });
    expect(createConditionalGateway).toHaveBeenCalledWith({
      principal,
      operationScope: context.providerWriteOperationScope,
      approvalBinding: context.providerWritePermit.approvalBinding,
    });
    const receiptInsert = receipt.query.mock.calls.find(([sql]) =>
      sql.includes('insert into emdo.scheduler_execution_receipts'),
    );
    expect(receiptInsert?.[1]).toEqual([
      expect.any(String),
      ids.run,
      'google-calendar',
      expect.any(String),
      ids.household,
      ids.privateSpace,
    ]);
    expect(gateway.readCurrent).toHaveBeenCalledOnce();
    expect(gateway.applyConditionalExactlyOnce).toHaveBeenCalledOnce();
    expect(gateway.readBack).toHaveBeenCalledOnce();
  });

  it('fails closed before provider I/O for a mismatched request scope and preserves non-applied and indeterminate evidence', async () => {
    const context = calendarCreateContext();
    const receipt = receiptPool();
    const createConditionalGateway = vi.fn(() => ({
      readCurrent: vi.fn(async () => ({
        calendarId: canonicalCreateArguments.calendarId,
        queriedEventId: eventId,
        calendarVersion: 'calendar-v2',
        event: null,
      })),
      applyConditionalExactlyOnce: vi.fn(),
      readBack: vi.fn(),
    }));
    const binding = createRequestScopedGoogleCalendarEventCreateBinding({
      principal,
      pool: receipt.pool,
      google: { createConditionalGateway },
      materializeProposal: vi.fn(),
    });

    await expect(
      binding.executeProviderWrite(canonicalCreateArguments, {
        ...context,
        providerWriteOperationScope: {
          ...context.providerWriteOperationScope,
          sessionId: '42000000-0000-4000-8000-000000000099',
        },
      }),
    ).resolves.toEqual({
      application: 'not-applied',
      reason: 'approval-policy-mismatch',
      evidence: { calendarWrite: 'approval-or-request-binding-invalid' },
    });
    expect(createConditionalGateway).not.toHaveBeenCalled();
    expect(receipt.query).not.toHaveBeenCalled();

    await expect(
      binding.executeProviderWrite(canonicalCreateArguments, context),
    ).resolves.toMatchObject({
      application: 'not-applied',
      reason: 'provider-precondition-failed',
      evidence: {
        calendarWrite: {
          status: 'not-applied',
          safeError: { code: 'calendar-precondition-failed' },
        },
      },
    });

    const unavailablePool = {
      connect: vi.fn(async () => {
        throw new Error('durable-store-unavailable');
      }),
    } as never;
    const indeterminateBinding =
      createRequestScopedGoogleCalendarEventCreateBinding({
        principal,
        pool: unavailablePool,
        google: { createConditionalGateway },
        materializeProposal: vi.fn(),
      });
    await expect(
      indeterminateBinding.executeProviderWrite(
        canonicalCreateArguments,
        context,
      ),
    ).resolves.toMatchObject({
      application: 'indeterminate',
      reason: 'transport-lost-after-dispatch',
      evidence: {
        calendarWrite: {
          status: 'indeterminate',
          reconciliationRequired: true,
          safeError: { code: 'calendar-provider-indeterminate' },
        },
      },
    });
  });

  it('exposes the request-scoped Calendar core runtime required for canonical proposal reads and approved writes', async () => {
    const principal = {
      userId: ids.user,
      householdId: ids.household,
      privateSpaceId: ids.privateSpace,
      sessionId: '42000000-0000-4000-8000-000000000008',
      spaceAccessGrantId: '42000000-0000-4000-8000-000000000009',
      collectionAuthorizationScopeFingerprint: authorizationScopeFingerprint,
      role: 'owner' as const,
      emailVerified: true,
    };
    const authorityResolution = {
      authorityBinding: providerAuthority,
      operationScope: {
        requestId: '42000000-0000-4000-8000-000000000007',
        sessionId: principal.sessionId,
        householdId: ids.household,
        userId: ids.user,
        spaceAccessGrantId: principal.spaceAccessGrantId,
        authorizationScopeFingerprint,
      },
    };
    const readTargetState = vi.fn(async () => ({
      calendarId: 'primary',
      queriedEventId: eventId,
      calendarVersion: 'calendar-v1',
      event: null,
    }));
    const createProposalTargetReader = vi.fn(() => ({ readTargetState }));
    const runtime = createRequestScopedGoogleCalendarCoreRuntime({
      principal,
      requestId: authorityResolution.operationScope.requestId,
      authorityResolution,
      google: { createProposalTargetReader },
    });

    expect(createProposalTargetReader).toHaveBeenCalledWith({
      principal,
      requestId: authorityResolution.operationScope.requestId,
      authorityResolution,
    });
    expect(readTargetState).not.toHaveBeenCalled();
    await expect(
      runtime.proposalStateReader.readTargetState({
        calendarId: 'primary',
        eventId,
      }),
    ).resolves.toEqual({
      calendarId: 'primary',
      queriedEventId: eventId,
      calendarVersion: 'calendar-v1',
      event: null,
    });
  });

  it('maps the request-scoped proposal authority without a synthetic decision', async () => {
    const resolver = {
      resolve: vi.fn(async () => ({
        authorityBinding: providerAuthority,
        operationScope: {
          requestId: '42000000-0000-4000-8000-000000000007',
          sessionId: '42000000-0000-4000-8000-000000000008',
          householdId: ids.household,
          userId: ids.user,
          spaceAccessGrantId: '42000000-0000-4000-8000-000000000009',
          authorizationScopeFingerprint,
        },
      })),
    };
    const proposalAuthority =
      createPostgresGoogleCalendarProposalAuthorityResolver({ resolver });
    const input = {
      requestId: '42000000-0000-4000-8000-000000000007',
      runId: ids.run,
      householdId: ids.household,
      userId: ids.user,
      authenticatedSessionId: '42000000-0000-4000-8000-000000000008',
      spaceAccessGrantId: '42000000-0000-4000-8000-000000000009',
      authorizationScopeFingerprint,
      agentId: 'scheduler' as const,
      disclosureGrantId: ids.grant,
      sdkCallId: 'calendar-proposal-call-1',
      capabilityId: calendarCreateCapabilityId,
      capabilityFingerprint: 'b'.repeat(64),
    };

    await expect(proposalAuthority.resolve(input)).resolves.toEqual({
      authorityBinding: providerAuthority,
      operationScope: {
        requestId: input.requestId,
        sessionId: input.authenticatedSessionId,
        householdId: ids.household,
        userId: ids.user,
        spaceAccessGrantId: input.spaceAccessGrantId,
        authorizationScopeFingerprint,
      },
    });
    expect(resolver.resolve).toHaveBeenCalledWith({
      requestId: input.requestId,
      runId: ids.run,
      sessionId: input.authenticatedSessionId,
      userId: ids.user,
      householdId: ids.household,
      agentId: 'scheduler',
      spaceAccessGrantId: input.spaceAccessGrantId,
      disclosureGrantId: ids.grant,
      capabilityId: calendarCreateCapabilityId,
      capabilityFingerprint: input.capabilityFingerprint,
    });
  });

  it('fails closed before creating a Calendar reader when the authority is not bound to the authenticated request', () => {
    const principal = {
      userId: ids.user,
      householdId: ids.household,
      privateSpaceId: ids.privateSpace,
      sessionId: '42000000-0000-4000-8000-000000000008',
      spaceAccessGrantId: '42000000-0000-4000-8000-000000000009',
      collectionAuthorizationScopeFingerprint: authorizationScopeFingerprint,
      role: 'owner' as const,
      emailVerified: true,
    };
    const createProposalTargetReader = vi.fn();

    expect(() =>
      createRequestScopedGoogleCalendarCoreRuntime({
        principal,
        requestId: '42000000-0000-4000-8000-000000000007',
        authorityResolution: {
          authorityBinding: providerAuthority,
          operationScope: {
            requestId: '42000000-0000-4000-8000-000000000007',
            sessionId: '42000000-0000-4000-8000-000000000099',
            householdId: ids.household,
            userId: ids.user,
            spaceAccessGrantId: principal.spaceAccessGrantId,
            authorizationScopeFingerprint,
          },
        },
        google: { createProposalTargetReader },
      }),
    ).toThrow('api-google-calendar-core-runtime-unavailable');
    expect(createProposalTargetReader).not.toHaveBeenCalled();
  });

  it('fails closed when the resolved Calendar authority is not bound to the proposal request', async () => {
    const otherFingerprint = EffectiveAuthorizationScopeFingerprintSchema.parse(
      'c'.repeat(64),
    );
    const resolver = {
      resolve: vi.fn(async () => ({
        authorityBinding: {
          ...providerAuthority,
          authorizationScopeFingerprint: otherFingerprint,
        },
        operationScope: {
          requestId: '42000000-0000-4000-8000-000000000007',
          sessionId: '42000000-0000-4000-8000-000000000008',
          householdId: ids.household,
          userId: ids.user,
          spaceAccessGrantId: '42000000-0000-4000-8000-000000000009',
          authorizationScopeFingerprint: otherFingerprint,
        },
      })),
    };
    const proposalAuthority =
      createPostgresGoogleCalendarProposalAuthorityResolver({ resolver });

    await expect(
      proposalAuthority.resolve({
        requestId: '42000000-0000-4000-8000-000000000007',
        runId: ids.run,
        householdId: ids.household,
        userId: ids.user,
        authenticatedSessionId: '42000000-0000-4000-8000-000000000008',
        spaceAccessGrantId: '42000000-0000-4000-8000-000000000009',
        authorizationScopeFingerprint,
        agentId: 'scheduler',
        disclosureGrantId: ids.grant,
        sdkCallId: 'calendar-proposal-call-2',
        capabilityId: calendarCreateCapabilityId,
        capabilityFingerprint: 'b'.repeat(64),
      }),
    ).resolves.toBeUndefined();
  });

  it('materializes the approved Calendar proposal from the scheduler model disclosure grant', async () => {
    const materializer = new ScopedCalendarProposalMaterializer(
      {
        readTargetState: async () => ({
          calendarId: 'primary',
          queriedEventId: eventId,
          calendarVersion: 'calendar-v1',
          event: null,
        }),
      },
      providerAuthority,
    );

    await expect(
      materializer.materialize({
        capabilityId: 'google-calendar.event.create',
        capabilityFingerprint: 'b'.repeat(64),
        canonicalArguments: {
          operation: 'create',
          calendarId: 'primary',
          expectedCalendarVersion: 'calendar-v1',
          event: {
            eventId,
            summary: 'Dentist appointment',
            start: '2026-08-15T15:00:00.000Z',
            end: '2026-08-15T16:00:00.000Z',
            timeZone: 'America/Toronto',
          },
        },
        disclosureGrant: {
          schemaVersion: 1,
          id: ids.grant,
          version: 1,
          userId: ids.user,
          householdId: ids.household,
          agentId: 'scheduler',
          purpose:
            'Generate a calendar proposal from the model-visible record.',
          runId: ids.run,
          invocationContext,
          invocationContextHash,
          recordAllowlist: [
            {
              dataClass: 'agent.delegations',
              recordId: 'scheduler-delegation-1',
              fields: ['delegation'],
            },
          ],
          // The existing model disclosure foundation is intentionally OpenAI-scoped.
          provider: 'openai',
          createdAt: '2026-08-15T12:00:00.000Z',
          expiresAt: '2026-08-15T12:10:00.000Z',
          oneRunOnly: true,
        },
        now: new Date('2026-08-15T12:05:00.000Z'),
      }),
    ).resolves.toMatchObject({
      approvalDisplay: {
        title: 'Create Google Calendar event',
      },
    });
  });

  it('materializes the Calendar proposal from the actual scheduler-phase disclosure projection', async () => {
    const issuedGrant = '42000000-0000-4000-8000-000000000006';
    let recordAllowlist:
      | readonly Readonly<{
          readonly dataClass: string;
          readonly recordId: string;
          readonly fields: readonly string[];
        }>[]
      | undefined;
    const issuer = {
      issue: vi.fn(async (input) => {
        recordAllowlist = input.recordAllowlist;
        return {
          grant: {
            id: issuedGrant,
            invocationContext,
            invocationContextHash,
          },
        };
      }),
    };
    const disclosureGateway = createPostgresCoreModelDisclosureGateway({
      issuer,
      gateway: {
        authorize: async (input) => ({
          status: 'authorized' as const,
          grantId: issuedGrant,
          grantVersion: '1.0.0',
          runId: ids.run,
          householdId: ids.household,
          userId: ids.user,
          agentId: 'scheduler',
          phasePurpose: 'specialist-execution' as const,
          phaseInvocationId: ids.phaseInvocation,
          invocationContext,
          invocationContextHash,
          disclosurePurpose: 'Run one scheduler delegation.',
          provider: 'openai' as const,
          expiresAt: '2026-08-15T12:10:00.000Z',
          records: [
            {
              dataClass: 'agent.delegations',
              recordId: 'scheduler-delegation-1',
              fields: ['delegation'],
            },
          ],
          payload: input.payload,
        }),
      },
      privateSpaceId: ids.privateSpace,
    });
    await disclosureGateway.authorize({
      requestId: '42000000-0000-4000-8000-000000000007',
      runId: ids.run,
      householdId: ids.household,
      userId: ids.user,
      authenticatedSessionId: '42000000-0000-4000-8000-000000000008',
      spaceAccessGrantId: '42000000-0000-4000-8000-000000000009',
      authorizationScopeFingerprint,
      agentId: 'scheduler',
      phasePurpose: 'specialist-execution',
      phaseInvocationId: ids.phaseInvocation,
      invocation,
      provider: 'openai',
      sources: [
        {
          kind: 'specialist-delegation',
          delegation: {
            id: 'scheduler-delegation-1',
            specialistId: 'scheduler',
            input: { request: 'Create lunch.' },
            dependsOn: [],
          },
        },
      ],
    });

    const materializer = new ScopedCalendarProposalMaterializer(
      {
        readTargetState: async () => ({
          calendarId: 'primary',
          queriedEventId: eventId,
          calendarVersion: 'calendar-v1',
          event: null,
        }),
      },
      providerAuthority,
    );
    const actualSchedulerDisclosureGrant = DataDisclosureGrantSchema.parse({
      schemaVersion: 1,
      id: issuedGrant,
      version: 1,
      userId: ids.user,
      householdId: ids.household,
      agentId: 'scheduler',
      purpose: 'Run one scheduler delegation.',
      runId: ids.run,
      invocationContext,
      invocationContextHash,
      recordAllowlist,
      provider: 'openai',
      createdAt: '2026-08-15T12:00:00.000Z',
      expiresAt: '2026-08-15T12:10:00.000Z',
      oneRunOnly: true,
    });

    await expect(
      materializer.materialize({
        capabilityId: 'google-calendar.event.create',
        capabilityFingerprint: 'b'.repeat(64),
        canonicalArguments: {
          operation: 'create',
          calendarId: 'primary',
          expectedCalendarVersion: 'calendar-v1',
          event: {
            eventId,
            summary: 'Dentist appointment',
            start: '2026-08-15T15:00:00.000Z',
            end: '2026-08-15T16:00:00.000Z',
            timeZone: 'America/Toronto',
          },
        },
        disclosureGrant: actualSchedulerDisclosureGrant,
        now: new Date('2026-08-15T12:05:00.000Z'),
      }),
    ).resolves.toMatchObject({
      approvalDisplay: { title: 'Create Google Calendar event' },
    });
  });
});

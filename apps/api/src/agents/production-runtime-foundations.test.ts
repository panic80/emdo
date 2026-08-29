import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  EffectiveAuthorizationScopeFingerprintSchema,
  IdentifierSchema,
  JsonValueSchema,
  type JsonValue,
} from '@emdo/contracts';

import {
  createPostgresCoreModelDisclosureGateway,
  createPostgresManagerConversationMemory,
  type ManagerConversationEventRepository,
} from './production-runtime-foundations.js';

type StoredConversationEvent = Awaited<
  ReturnType<ManagerConversationEventRepository['listConversation']>
>[number];
type StoredConversationEvents = readonly StoredConversationEvent[];
type AppendConversationEventInput = Parameters<
  ManagerConversationEventRepository['appendConversationEvent']
>[0];
type DisclosureGatewayDependencies = Parameters<
  typeof createPostgresCoreModelDisclosureGateway
>[0];
type LegacyAuthorizeInput = Parameters<
  DisclosureGatewayDependencies['gateway']['authorize']
>[0];
type LegacyAuthorizeDecision = Awaited<
  ReturnType<DisclosureGatewayDependencies['gateway']['authorize']>
>;

const json = (value: unknown): JsonValue => JsonValueSchema.parse(value);
const testScopeFingerprint = EffectiveAuthorizationScopeFingerprintSchema.parse(
  'a'.repeat(64),
);

const DisclosurePayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  records: z.array(
    z.strictObject({
      dataClass: z.string(),
      recordId: z.string(),
      fields: z.record(z.string(), JsonValueSchema),
    }),
  ),
});

type DisclosurePayload = z.output<typeof DisclosurePayloadSchema>;

const parseDisclosurePayload = (value: JsonValue): DisclosurePayload =>
  DisclosurePayloadSchema.parse(value);

describe('production runtime foundations', () => {
  it('retrieves only persisted manager messages and returns the exact stored event after append', async () => {
    const ids = {
      conversation: '81000000-0000-4000-8000-000000000001',
      household: '81000000-0000-4000-8000-000000000002',
      user: '81000000-0000-4000-8000-000000000003',
      privateSpace: '81000000-0000-4000-8000-000000000004',
      firstEvent: '81000000-0000-4000-8000-000000000005',
      appendedEvent: '81000000-0000-4000-8000-000000000006',
    };
    const listConversation = vi.fn(
      async (): Promise<StoredConversationEvents> => [
        {
          id: ids.firstEvent,
          conversationId: ids.conversation,
          clientEventId: 'manager-message-1',
          sequence: 1,
          eventType: 'agent.manager.message',
          payload: json({
            schemaVersion: 1,
            role: 'user',
            content: 'Book lunch.',
          }),
          occurredAt: '2026-08-15T14:00:00.000Z',
        },
        {
          id: '81000000-0000-4000-8000-000000000007',
          conversationId: ids.conversation,
          clientEventId: 'foreign-event-2',
          sequence: 2,
          eventType: 'sync.remote-event',
          payload: json({ schemaVersion: 1, opaque: true }),
          occurredAt: '2026-08-15T14:01:00.000Z',
        },
      ],
    );
    const appendConversationEvent = vi.fn(
      async (
        input: AppendConversationEventInput,
      ): Promise<StoredConversationEvent> => ({
        id: ids.appendedEvent,
        conversationId: input.conversationId,
        clientEventId: input.clientEventId,
        sequence: input.sequence,
        eventType: input.eventType,
        payload: input.payload,
        occurredAt: '2026-08-15T14:02:00.000Z',
      }),
    );
    const memory = createPostgresManagerConversationMemory({
      repository: { listConversation, appendConversationEvent },
      principal: { householdId: ids.household, userId: ids.user },
      privateSpaceId: ids.privateSpace,
      createClientEventId: () => 'manager-message-append-1',
    });

    await expect(
      memory.retrieveForManager({
        conversationId: ids.conversation,
        householdId: ids.household,
        userId: ids.user,
        query: 'ignored-by-event-log',
      }),
    ).resolves.toEqual({
      entries: [
        {
          id: ids.firstEvent,
          conversationId: ids.conversation,
          householdId: ids.household,
          userId: ids.user,
          role: 'user',
          content: 'Book lunch.',
          createdAt: '2026-08-15T14:00:00.000Z',
        },
      ],
    });
    await expect(
      memory.appendManagerMessage({
        conversationId: ids.conversation,
        householdId: ids.household,
        userId: ids.user,
        role: 'assistant',
        content: 'I need your approval before I add it.',
      }),
    ).resolves.toEqual({
      id: ids.appendedEvent,
      conversationId: ids.conversation,
      householdId: ids.household,
      userId: ids.user,
      role: 'assistant',
      content: 'I need your approval before I add it.',
      createdAt: '2026-08-15T14:02:00.000Z',
    });
    expect(appendConversationEvent).toHaveBeenCalledWith({
      spaceId: ids.privateSpace,
      conversationId: ids.conversation,
      clientEventId: 'manager-message-append-1',
      sequence: 3,
      eventType: 'agent.manager.message',
      payload: {
        schemaVersion: 1,
        role: 'assistant',
        content: 'I need your approval before I add it.',
      },
    });
  });

  it('issues then audits an exact fresh delegation disclosure envelope', async () => {
    const ids = {
      request: '82000000-0000-4000-8000-000000000001',
      run: '82000000-0000-4000-8000-000000000002',
      household: '82000000-0000-4000-8000-000000000003',
      user: '82000000-0000-4000-8000-000000000004',
      spaceAccessGrant: '82000000-0000-4000-8000-000000000005',
      privateSpace: '82000000-0000-4000-8000-000000000006',
      disclosureGrant: '82000000-0000-4000-8000-000000000007',
    };
    const issuer = {
      issue: vi.fn(async (input: { readonly recordAllowlist: unknown }) => ({
        grant: {
          id: ids.disclosureGrant,
          version: 1,
          recordAllowlist: input.recordAllowlist,
        },
      })),
    };
    const authorize = vi.fn(
      async (input: LegacyAuthorizeInput): Promise<LegacyAuthorizeDecision> => {
        const payload = parseDisclosurePayload(input.payload);
        return {
          status: 'authorized' as const,
          grantId: ids.disclosureGrant,
          grantVersion: '1.0.0',
          runId: ids.run,
          householdId: ids.household,
          userId: ids.user,
          agentId: 'scheduler',
          phasePurpose: 'specialist-execution' as const,
          disclosurePurpose: 'Run one scheduler delegation.',
          provider: 'openai' as const,
          expiresAt: '2026-08-15T14:10:00.000Z',
          records: payload.records.map((record) => ({
            dataClass: record.dataClass,
            recordId: record.recordId,
            fields: Object.keys(record.fields),
          })),
          payload: input.payload,
        };
      },
    );
    const gateway = createPostgresCoreModelDisclosureGateway({
      issuer,
      gateway: { authorize },
      privateSpaceId: ids.privateSpace,
    });

    const delegation = json({
      id: 'scheduler-delegation-1',
      specialistId: 'scheduler',
      input: { request: 'Create lunch.' },
      dependsOn: [],
    });
    const disclosureInput = {
      requestId: ids.request,
      runId: ids.run,
      householdId: ids.household,
      userId: ids.user,
      authenticatedSessionId: '82000000-0000-4000-8000-000000000008',
      spaceAccessGrantId: ids.spaceAccessGrant,
      authorizationScopeFingerprint: testScopeFingerprint,
      agentId: 'scheduler',
      phasePurpose: 'specialist-execution',
      phaseInvocationId: 'scheduler-delegation-1',
      provider: 'openai',
      sources: [
        {
          kind: 'specialist-delegation',
          delegation,
        },
      ],
    } as const;
    await expect(gateway.authorize(disclosureInput)).resolves.toEqual(
      expect.objectContaining({
        status: 'authorized',
        grantId: ids.disclosureGrant,
        phaseInvocationId: 'scheduler-delegation-1',
      }),
    );
    expect(issuer.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: ids.request,
        runId: ids.run,
        householdId: ids.household,
        userId: ids.user,
        spaceId: ids.privateSpace,
        spaceAccessGrantId: ids.spaceAccessGrant,
        agentId: 'scheduler',
        phasePurpose: 'specialist-execution',
        provider: 'openai',
        recordAllowlist: [
          {
            dataClass: 'agent.delegations',
            recordId: 'scheduler-delegation-1',
            fields: ['delegation'],
          },
        ],
      }),
    );
    expect(authorize).toHaveBeenCalledWith({
      requestId: ids.request,
      runId: ids.run,
      householdId: ids.household,
      userId: ids.user,
      spaceAccessGrantId: ids.spaceAccessGrant,
      agentId: 'scheduler',
      phasePurpose: 'specialist-execution',
      provider: 'openai',
      requestedGrantId: ids.disclosureGrant,
      requestedDataClasses: ['agent.delegations'],
      payload: {
        schemaVersion: 1,
        records: [
          {
            dataClass: 'agent.delegations',
            recordId: 'scheduler-delegation-1',
            fields: { delegation },
          },
        ],
      },
    });
    authorize.mockResolvedValueOnce({
      status: 'authorized' as const,
      grantId: ids.disclosureGrant,
      grantVersion: '1.0.0',
      runId: ids.run,
      householdId: ids.household,
      userId: ids.user,
      agentId: 'scheduler',
      phasePurpose: 'specialist-execution' as const,
      disclosurePurpose: 'Run one scheduler delegation.',
      provider: 'openai' as const,
      expiresAt: '2026-08-15T14:10:00.000Z',
      records: [
        {
          dataClass: 'agent.delegations',
          recordId: 'scheduler-delegation-1',
          fields: ['delegation', 'unexpected-field'],
        },
      ],
      payload: {
        schemaVersion: 1,
        records: [
          {
            dataClass: 'agent.delegations',
            recordId: 'scheduler-delegation-1',
            fields: {
              delegation,
              'unexpected-field': 'not issued',
            },
          },
        ],
      },
    });
    await expect(gateway.authorize(disclosureInput)).rejects.toThrow(
      'api-model-disclosure-gateway-envelope-invalid',
    );
  });

  it('uses a Finance-specific specialist disclosure purpose and rejects unknown specialists', async () => {
    const ids = {
      request: '82500000-0000-4000-8000-000000000001',
      run: '82500000-0000-4000-8000-000000000002',
      household: '82500000-0000-4000-8000-000000000003',
      user: '82500000-0000-4000-8000-000000000004',
      spaceAccessGrant: '82500000-0000-4000-8000-000000000005',
      privateSpace: '82500000-0000-4000-8000-000000000006',
      disclosureGrant: '82500000-0000-4000-8000-000000000007',
    };
    const issuer = {
      issue: vi.fn(async (input: { readonly recordAllowlist: unknown }) => ({
        grant: {
          id: ids.disclosureGrant,
          version: 1,
          recordAllowlist: input.recordAllowlist,
        },
      })),
    };
    const authorize = vi.fn(
      async (input: LegacyAuthorizeInput): Promise<LegacyAuthorizeDecision> => {
        const payload = parseDisclosurePayload(input.payload);
        return {
          status: 'authorized' as const,
          grantId: ids.disclosureGrant,
          grantVersion: '1.0.0',
          runId: ids.run,
          householdId: ids.household,
          userId: ids.user,
          agentId: 'finance',
          phasePurpose: 'specialist-execution' as const,
          disclosurePurpose: 'Run one finance delegation.',
          provider: 'openai' as const,
          expiresAt: '2026-08-15T14:10:00.000Z',
          records: payload.records.map((record) => ({
            dataClass: record.dataClass,
            recordId: record.recordId,
            fields: Object.keys(record.fields),
          })),
          payload: input.payload,
        };
      },
    );
    const gateway = createPostgresCoreModelDisclosureGateway({
      issuer,
      gateway: { authorize },
      privateSpaceId: ids.privateSpace,
    });
    const financeInput = {
      requestId: ids.request,
      runId: ids.run,
      householdId: ids.household,
      userId: ids.user,
      authenticatedSessionId: '82500000-0000-4000-8000-000000000008',
      spaceAccessGrantId: ids.spaceAccessGrant,
      authorizationScopeFingerprint: testScopeFingerprint,
      agentId: 'finance',
      phasePurpose: 'specialist-execution',
      phaseInvocationId: 'finance-delegation-1',
      provider: 'openai',
      sources: [
        {
          kind: 'specialist-delegation',
          delegation: json({
            id: 'finance-delegation-1',
            specialistId: 'finance',
            input: { request: 'Review this Finance document.' },
            dependsOn: [],
          }),
        },
      ],
    } as const;

    await expect(gateway.authorize(financeInput)).resolves.toEqual(
      expect.objectContaining({
        status: 'authorized',
        agentId: 'finance',
        disclosurePurpose: 'Run one finance delegation.',
      }),
    );
    expect(issuer.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'finance',
        phasePurpose: 'specialist-execution',
        disclosurePurpose: 'Run one finance delegation.',
      }),
    );

    await expect(
      gateway.authorize({
        ...financeInput,
        agentId: 'shopping',
        phaseInvocationId: 'shopping-delegation-1',
      }),
    ).rejects.toThrow('api-model-disclosure-specialist-agent-invalid');
    expect(issuer.issue).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it('authorizes manager synthesis with safe canonical record IDs', async () => {
    const ids = {
      request: '82700000-0000-4000-8000-000000000001',
      run: '82700000-0000-4000-8000-000000000002',
      household: '82700000-0000-4000-8000-000000000003',
      user: '82700000-0000-4000-8000-000000000004',
      spaceAccessGrant: '82700000-0000-4000-8000-000000000005',
      privateSpace: '82700000-0000-4000-8000-000000000006',
      disclosureGrant: '82700000-0000-4000-8000-000000000007',
    };
    const issuer = {
      issue: vi.fn(
        async (input: {
          readonly recordAllowlist: readonly Readonly<{
            readonly dataClass: string;
            readonly recordId: string;
            readonly fields: readonly string[];
          }>[];
        }) => {
          void input;
          return { grant: { id: ids.disclosureGrant } };
        },
      ),
    };
    const authorize = vi.fn(
      async (input: LegacyAuthorizeInput): Promise<LegacyAuthorizeDecision> => {
        const payload = parseDisclosurePayload(input.payload);
        return {
          status: 'authorized' as const,
          grantId: ids.disclosureGrant,
          grantVersion: '1.0.0',
          runId: ids.run,
          householdId: ids.household,
          userId: ids.user,
          agentId: 'manager',
          phasePurpose: 'manager-synthesis' as const,
          disclosurePurpose: 'Synthesize this manager turn.',
          provider: 'openai' as const,
          expiresAt: '2026-08-15T14:10:00.000Z',
          records: payload.records.map((record) => ({
            dataClass: record.dataClass,
            recordId: record.recordId,
            fields: Object.keys(record.fields),
          })),
          payload: input.payload,
        };
      },
    );
    const gateway = createPostgresCoreModelDisclosureGateway({
      issuer,
      gateway: { authorize },
      privateSpaceId: ids.privateSpace,
    });
    const synthesisInput = {
      requestId: ids.request,
      runId: ids.run,
      householdId: ids.household,
      userId: ids.user,
      authenticatedSessionId: '82700000-0000-4000-8000-000000000008',
      spaceAccessGrantId: ids.spaceAccessGrant,
      authorizationScopeFingerprint: testScopeFingerprint,
      agentId: 'manager',
      phasePurpose: 'manager-synthesis',
      phaseInvocationId: 'manager-synthesis-1',
      provider: 'openai',
      sources: [
        {
          kind: 'manager-plan',
          plan: json({
            specialistDelegations: ['delegation:one', 'delegation:two'],
          }),
        },
        {
          kind: 'specialist-outcome',
          outcome: json({
            delegationId: 'delegation:one',
            status: 'completed',
          }),
        },
        {
          kind: 'specialist-outcome',
          outcome: json({
            delegationId: 'delegation:two',
            status: 'completed',
          }),
        },
      ],
    } as const;

    await expect(gateway.authorize(synthesisInput)).resolves.toEqual(
      expect.objectContaining({
        phasePurpose: 'manager-synthesis',
        disclosurePurpose: 'Synthesize this manager turn.',
      }),
    );
    expect(issuer.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'manager',
        phasePurpose: 'manager-synthesis',
        disclosurePurpose: 'Synthesize this manager turn.',
      }),
    );
    const issuedAllowlist = issuer.issue.mock.calls[0]?.[0]?.recordAllowlist;
    expect(issuedAllowlist).toHaveLength(3);
    expect(issuedAllowlist).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dataClass: 'agent.manager-plans',
          recordId: expect.stringMatching(/^manager-plan-/),
        }),
        expect.objectContaining({
          dataClass: 'agent.specialist-outcomes',
          recordId: expect.stringMatching(/^specialist-outcome-/),
        }),
      ]),
    );
    for (const record of issuedAllowlist) {
      expect(record.recordId).toMatch(/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/);
    }
  });

  it('returns only the 12 newest valid manager messages in chronological order', async () => {
    const ids = {
      conversation: '83000000-0000-4000-8000-000000000001',
      household: '83000000-0000-4000-8000-000000000002',
      user: '83000000-0000-4000-8000-000000000003',
      privateSpace: '83000000-0000-4000-8000-000000000004',
    };
    const listConversation = vi.fn(
      async (): Promise<StoredConversationEvents> => [
        ...Array.from({ length: 14 }, (_, index): StoredConversationEvent => ({
          id: `83000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
          conversationId: ids.conversation,
          clientEventId: `manager-event-${index + 1}`,
          sequence: index + 1,
          eventType: 'agent.manager.message',
          payload: json({
            schemaVersion: 1,
            role: index % 2 === 0 ? 'user' : 'assistant',
            content: `message-${index + 1}`,
          }),
          occurredAt: `2026-08-15T14:${String(index).padStart(2, '0')}:00.000Z`,
        })),
        {
          id: '83000000-0000-4000-8000-000000000099',
          conversationId: ids.conversation,
          clientEventId: 'ignored-foreign-event',
          sequence: 15,
          eventType: 'sync.remote-event',
          payload: json({ schemaVersion: 1, opaque: true }),
          occurredAt: '2026-08-15T14:15:00.000Z',
        },
        {
          id: '83000000-0000-4000-8000-000000000100',
          conversationId: ids.conversation,
          clientEventId: 'ignored-malformed-manager-event',
          sequence: 16,
          eventType: 'agent.manager.message',
          payload: json({
            schemaVersion: 1,
            role: 'user',
            other: 'not-content',
          }),
          occurredAt: '2026-08-15T14:16:00.000Z',
        },
      ],
    );
    const memory = createPostgresManagerConversationMemory({
      repository: {
        listConversation,
        appendConversationEvent: vi.fn(
          async (): Promise<StoredConversationEvent> => {
            throw new Error('append-not-used-in-retrieval-test');
          },
        ),
      },
      principal: { householdId: ids.household, userId: ids.user },
      privateSpaceId: ids.privateSpace,
    });

    await expect(
      memory.retrieveForManager({
        conversationId: ids.conversation,
        householdId: ids.household,
        userId: ids.user,
        query: 'unbounded input must not reach the model',
      }),
    ).resolves.toMatchObject({
      entries: Array.from({ length: 12 }, (_, index) => ({
        content: `message-${index + 3}`,
      })),
    });
  });

  it('projects a conversation source with only the frozen model fields', async () => {
    const ids = {
      request: '84000000-0000-4000-8000-000000000001',
      run: '84000000-0000-4000-8000-000000000002',
      household: '84000000-0000-4000-8000-000000000003',
      user: '84000000-0000-4000-8000-000000000004',
      spaceAccessGrant: '84000000-0000-4000-8000-000000000005',
      privateSpace: '84000000-0000-4000-8000-000000000006',
      disclosureGrant: '84000000-0000-4000-8000-000000000007',
      message: '84000000-0000-4000-8000-000000000008',
    };
    const issuer = {
      issue: vi.fn(
        async (input: {
          readonly recordAllowlist: readonly Readonly<{
            readonly fields: readonly string[];
          }>[];
        }) => {
          for (const record of input.recordAllowlist) {
            for (const field of record.fields) {
              IdentifierSchema.parse(field);
            }
          }
          return { grant: { id: ids.disclosureGrant } };
        },
      ),
    };
    const authorize = vi.fn(
      async (input: LegacyAuthorizeInput): Promise<LegacyAuthorizeDecision> => {
        const payload = parseDisclosurePayload(input.payload);
        return {
          status: 'authorized' as const,
          grantId: ids.disclosureGrant,
          grantVersion: '1.0.0',
          runId: ids.run,
          householdId: ids.household,
          userId: ids.user,
          agentId: 'manager',
          phasePurpose: 'manager-plan' as const,
          disclosurePurpose: 'Plan this manager turn.',
          provider: 'openai' as const,
          expiresAt: '2026-08-15T14:10:00.000Z',
          records: payload.records.map((record) => ({
            dataClass: record.dataClass,
            recordId: record.recordId,
            fields: Object.keys(record.fields),
          })),
          payload: input.payload,
        };
      },
    );
    const gateway = createPostgresCoreModelDisclosureGateway({
      issuer,
      gateway: { authorize },
      privateSpaceId: ids.privateSpace,
    });

    await gateway.authorize({
      requestId: ids.request,
      runId: ids.run,
      householdId: ids.household,
      userId: ids.user,
      authenticatedSessionId: '84000000-0000-4000-8000-000000000009',
      spaceAccessGrantId: ids.spaceAccessGrant,
      authorizationScopeFingerprint: testScopeFingerprint,
      agentId: 'manager',
      phasePurpose: 'manager-plan',
      phaseInvocationId: 'manager-plan',
      provider: 'openai',
      sources: [
        {
          kind: 'conversation-message',
          entry: {
            id: ids.message,
            conversationId: '84000000-0000-4000-8000-000000000010',
            householdId: ids.household,
            userId: ids.user,
            role: 'user',
            content: 'Schedule lunch.',
            createdAt: '2026-08-15T14:00:00.000Z',
          },
        },
      ],
    });

    expect(issuer.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        recordAllowlist: [
          {
            dataClass: 'conversation.messages',
            recordId: ids.message,
            fields: ['content', 'created-at', 'role'],
          },
        ],
      }),
    );
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          schemaVersion: 1,
          records: [
            {
              dataClass: 'conversation.messages',
              recordId: ids.message,
              fields: {
                content: 'Schedule lunch.',
                'created-at': '2026-08-15T14:00:00.000Z',
                role: 'user',
              },
            },
          ],
        },
      }),
    );
  });
});

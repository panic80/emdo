import { randomUUID } from 'node:crypto';

import type {
  ConversationMemoryEntry,
  ManagerConversationMemory,
  ModelDisclosureAuthorization,
  ModelDisclosureDecision,
  ModelDisclosureGateway,
  ModelDisclosureSource,
  JsonValue as AgentJsonValue,
} from '@emdo/agent-core';
import {
  AgentInvocationContextSchema,
  JsonValueSchema,
  OpaqueReferenceSchema,
  Sha256Schema,
  UuidSchema,
  deepFreeze,
  type JsonValue as ContractJsonValue,
} from '@emdo/contracts';
import { hashCanonicalJson } from '@emdo/toolbox';
import { z } from 'zod';

const MANAGER_MESSAGE_EVENT_TYPE = 'agent.manager.message' as const;
const MAX_MANAGER_MESSAGE_CHARACTERS = 16_000;
const DEFAULT_MANAGER_MEMORY_LIMIT = 12;
const ManagerMemoryLimitSchema = z.number().int().min(1).max(64);

const ConversationScopeSchema = z.strictObject({
  conversationId: UuidSchema,
  householdId: UuidSchema,
  userId: UuidSchema,
});
const ManagerMessagePayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(MAX_MANAGER_MESSAGE_CHARACTERS),
});
const StoredConversationEventSchema = z.strictObject({
  id: UuidSchema,
  conversationId: UuidSchema,
  clientEventId: z.string().trim().min(1).max(200),
  sequence: z.number().int().positive().safe(),
  eventType: z.string().trim().min(1).max(160),
  payload: JsonValueSchema,
  occurredAt: z.iso.datetime({ offset: true }),
});

type StoredConversationEvent = z.output<typeof StoredConversationEventSchema>;

export interface ManagerConversationEventRepository {
  listConversation(
    conversationId: string,
  ): Promise<readonly StoredConversationEvent[]>;
  appendConversationEvent(input: {
    readonly spaceId: string;
    readonly conversationId: string;
    readonly clientEventId: string;
    readonly sequence: number;
    readonly eventType: string;
    readonly payload: ContractJsonValue;
  }): Promise<StoredConversationEvent>;
}

const asManagerEntry = (
  event: StoredConversationEvent,
  scope: z.output<typeof ConversationScopeSchema>,
): ConversationMemoryEntry | undefined => {
  if (
    event.eventType !== MANAGER_MESSAGE_EVENT_TYPE ||
    event.conversationId !== scope.conversationId
  ) {
    return undefined;
  }
  const payload = ManagerMessagePayloadSchema.safeParse(event.payload);
  if (!payload.success) return undefined;
  return deepFreeze({
    id: event.id,
    conversationId: scope.conversationId,
    householdId: scope.householdId,
    userId: scope.userId,
    role: payload.data.role,
    content: payload.data.content,
    createdAt: event.occurredAt,
  });
};

/**
 * Adapts only server-owned `conversation_events` into manager memory. The
 * caller's household/user scope and private space are fixed at construction;
 * each manager entry uses the durable event primary key as its record ID.
 */
export const createPostgresManagerConversationMemory = (input: {
  readonly repository: ManagerConversationEventRepository;
  readonly principal: Readonly<{ householdId: string; userId: string }>;
  readonly privateSpaceId: string;
  readonly limit?: number;
  readonly createClientEventId?: () => string;
}): ManagerConversationMemory => {
  if (
    typeof input?.repository?.listConversation !== 'function' ||
    typeof input.repository.appendConversationEvent !== 'function' ||
    (input.createClientEventId !== undefined &&
      typeof input.createClientEventId !== 'function')
  ) {
    throw new Error('api-manager-conversation-memory-dependency-invalid');
  }
  const principal = z
    .strictObject({ householdId: UuidSchema, userId: UuidSchema })
    .parse(input.principal);
  const privateSpaceId = UuidSchema.parse(input.privateSpaceId);
  const limit = ManagerMemoryLimitSchema.parse(
    input.limit ?? DEFAULT_MANAGER_MEMORY_LIMIT,
  );
  const createClientEventId = input.createClientEventId ?? randomUUID;

  const readEvents = async (
    scope: z.output<typeof ConversationScopeSchema>,
  ): Promise<readonly StoredConversationEvent[]> => {
    const raw = await input.repository.listConversation(scope.conversationId);
    if (!Array.isArray(raw)) {
      throw new Error('api-manager-conversation-memory-result-invalid');
    }
    return Object.freeze(
      raw.map((event) => StoredConversationEventSchema.parse(event)),
    );
  };
  const assertScope = (raw: unknown) => {
    const scope = ConversationScopeSchema.parse(raw);
    if (
      scope.householdId !== principal.householdId ||
      scope.userId !== principal.userId
    ) {
      throw new Error('api-manager-conversation-memory-scope-invalid');
    }
    return scope;
  };

  return Object.freeze({
    retrieveForManager: async (
      rawInput: Parameters<ManagerConversationMemory['retrieveForManager']>[0],
    ) => {
      const parsed = z
        .strictObject({
          ...ConversationScopeSchema.shape,
          query: z.string().max(MAX_MANAGER_MESSAGE_CHARACTERS),
        })
        .parse(rawInput);
      const scope = assertScope({
        conversationId: parsed.conversationId,
        householdId: parsed.householdId,
        userId: parsed.userId,
      });
      const events = await readEvents(scope);
      const entries = [...events]
        .sort((left, right) => left.sequence - right.sequence)
        .map((event) => asManagerEntry(event, scope))
        .filter(
          (entry): entry is ConversationMemoryEntry => entry !== undefined,
        )
        .slice(-limit);
      return deepFreeze({ entries });
    },
    appendManagerMessage: async (
      rawInput: Parameters<
        ManagerConversationMemory['appendManagerMessage']
      >[0],
    ) => {
      const parsed = z
        .strictObject({
          ...ConversationScopeSchema.shape,
          role: z.enum(['user', 'assistant']),
          content: z.string().min(1).max(MAX_MANAGER_MESSAGE_CHARACTERS),
        })
        .parse(rawInput);
      const scope = assertScope({
        conversationId: parsed.conversationId,
        householdId: parsed.householdId,
        userId: parsed.userId,
      });
      const existing = await readEvents(scope);
      const sequence =
        Math.max(0, ...existing.map((event) => event.sequence)) + 1;
      const clientEventId = z
        .string()
        .trim()
        .min(1)
        .max(200)
        .parse(createClientEventId());
      const stored = StoredConversationEventSchema.parse(
        await input.repository.appendConversationEvent({
          spaceId: privateSpaceId,
          conversationId: scope.conversationId,
          clientEventId,
          sequence,
          eventType: MANAGER_MESSAGE_EVENT_TYPE,
          payload: {
            schemaVersion: 1,
            role: parsed.role,
            content: parsed.content,
          },
        }),
      );
      const entry = asManagerEntry(stored, scope);
      if (entry === undefined) {
        throw new Error('api-manager-conversation-memory-append-invalid');
      }
      return entry;
    },
  });
};

type LegacyDisclosureGateway = Readonly<{
  authorize(input: {
    readonly requestId: string;
    readonly runId: string;
    readonly householdId: string;
    readonly userId: string;
    readonly spaceAccessGrantId: string;
    readonly agentId: string;
    readonly invocation: Parameters<
      ModelDisclosureGateway['authorize']
    >[0]['invocation'];
    readonly phasePurpose:
      'manager-plan' | 'specialist-execution' | 'manager-synthesis';
    readonly phaseInvocationId: string;
    readonly provider: 'openai';
    readonly requestedGrantId: string;
    readonly requestedDataClasses: readonly string[];
    readonly payload: ContractJsonValue;
  }): Promise<
    | ModelDisclosureAuthorization
    | Exclude<ModelDisclosureDecision, { status: 'authorized' }>
  >;
}>;
type DisclosureGrantIssuer = Readonly<{
  issue(input: {
    readonly requestId: string;
    readonly runId: string;
    readonly householdId: string;
    readonly userId: string;
    readonly spaceId: string;
    readonly spaceAccessGrantId: string;
    readonly agentId: string;
    readonly invocation: Parameters<
      ModelDisclosureGateway['authorize']
    >[0]['invocation'];
    readonly phasePurpose:
      'manager-plan' | 'specialist-execution' | 'manager-synthesis';
    readonly disclosurePurpose: string;
    readonly provider: 'openai';
    readonly recordAllowlist: readonly Readonly<{
      dataClass: string;
      recordId: string;
      fields: readonly string[];
    }>[];
  }): Promise<
    Readonly<{
      grant: Readonly<{
        id: string;
        invocationContext: ModelDisclosureAuthorization['invocationContext'];
        invocationContextHash: string;
      }>;
    }>
  >;
}>;

type CanonicalDisclosureRecord = Readonly<{
  dataClass: string;
  recordId: string;
  fields: Readonly<Record<string, AgentJsonValue>>;
}>;

const canonicalSourceRecord = (
  source: ModelDisclosureSource,
  runId: string,
): CanonicalDisclosureRecord => {
  if (source.kind === 'conversation-message') {
    const entry = z
      .strictObject({
        id: OpaqueReferenceSchema,
        conversationId: UuidSchema,
        householdId: UuidSchema,
        userId: UuidSchema,
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(MAX_MANAGER_MESSAGE_CHARACTERS),
        createdAt: z.iso.datetime({ offset: true }),
      })
      .parse(source.entry);
    return {
      dataClass: 'conversation.messages',
      recordId: entry.id,
      fields: {
        content: entry.content,
        'created-at': entry.createdAt,
        role: entry.role,
      },
    };
  }
  if (source.kind === 'manager-plan') {
    const plan = JsonValueSchema.parse(source.plan);
    return {
      dataClass: 'agent.manager-plans',
      recordId: `manager-plan-${runId}-${hashCanonicalJson(plan)}`,
      fields: { plan },
    };
  }
  if (source.kind === 'specialist-delegation') {
    const delegation = JsonValueSchema.parse(source.delegation);
    if (
      delegation === null ||
      Array.isArray(delegation) ||
      typeof delegation !== 'object'
    ) {
      throw new Error('api-model-disclosure-delegation-invalid');
    }
    const recordId = OpaqueReferenceSchema.parse(delegation.id);
    return {
      dataClass: 'agent.delegations',
      recordId,
      fields: { delegation },
    };
  }
  const outcome = JsonValueSchema.parse(source.outcome);
  if (
    outcome === null ||
    Array.isArray(outcome) ||
    typeof outcome !== 'object'
  ) {
    throw new Error('api-model-disclosure-outcome-invalid');
  }
  const delegationId = OpaqueReferenceSchema.parse(outcome.delegationId);
  return {
    dataClass: 'agent.specialist-outcomes',
    recordId: `specialist-outcome-${hashCanonicalJson(delegationId)}-${hashCanonicalJson(outcome)}`,
    fields: { outcome },
  };
};

const canonicalizeSources = (
  sources: readonly ModelDisclosureSource[],
  runId: string,
) => {
  if (!Array.isArray(sources) || sources.length === 0 || sources.length > 256) {
    throw new Error('api-model-disclosure-sources-invalid');
  }
  const records = sources
    .map((source) => canonicalSourceRecord(source, runId))
    .sort((left, right) =>
      `${left.dataClass}\0${left.recordId}`.localeCompare(
        `${right.dataClass}\0${right.recordId}`,
      ),
    );
  const bindings = new Set<string>();
  for (const record of records) {
    const binding = `${record.dataClass}\0${record.recordId}`;
    if (bindings.has(binding)) {
      throw new Error('api-model-disclosure-source-duplicate');
    }
    bindings.add(binding);
  }
  // Keep the payload mutable at the contract boundary: the durable resolver
  // accepts the contracts package's JSON value (mutable arrays), while the
  // model-facing port accepts the stricter readonly JSON value. The payload
  // is freshly parsed and never reused across requests.
  const payload = JsonValueSchema.parse({ schemaVersion: 1, records });
  return Object.freeze({
    payload,
    dataClasses: Object.freeze(
      [...new Set(records.map((record) => record.dataClass))].sort(),
    ),
    recordAllowlist: Object.freeze(
      records.map((record) =>
        deepFreeze({
          dataClass: record.dataClass,
          recordId: record.recordId,
          fields: Object.keys(record.fields).sort(),
        }),
      ),
    ),
  });
};

const disclosedContextRefsFor = (
  records: readonly Readonly<{ dataClass: string; recordId: string }>[],
): readonly string[] =>
  Object.freeze(
    records
      .map(
        ({ dataClass, recordId }) =>
          `context-ref-${hashCanonicalJson({ dataClass, recordId })}`,
      )
      .sort(),
  );

const disclosurePurpose = (
  agentId: string,
  phasePurpose: 'manager-plan' | 'specialist-execution' | 'manager-synthesis',
): string => {
  if (phasePurpose === 'manager-plan') return 'Plan this manager turn.';
  if (phasePurpose === 'manager-synthesis') {
    return 'Synthesize this manager turn.';
  }
  if (agentId === 'scheduler') return 'Run one scheduler delegation.';
  if (agentId === 'finance') return 'Run one finance delegation.';
  throw new Error('api-model-disclosure-specialist-agent-invalid');
};

/**
 * Bridges the narrowed core port to the existing durable issuer and resolver.
 * Specialist purposes stay explicit so newly registered agents cannot inherit
 * another section's durable disclosure metadata.
 */
export const createPostgresCoreModelDisclosureGateway = (input: {
  readonly issuer: DisclosureGrantIssuer;
  readonly gateway: LegacyDisclosureGateway;
  readonly privateSpaceId: string;
}): ModelDisclosureGateway => {
  if (
    typeof input?.issuer?.issue !== 'function' ||
    typeof input.gateway?.authorize !== 'function'
  ) {
    throw new Error('api-model-disclosure-gateway-dependency-invalid');
  }
  const privateSpaceId = UuidSchema.parse(input.privateSpaceId);
  return Object.freeze({
    authorize: async (
      rawInput: Parameters<ModelDisclosureGateway['authorize']>[0],
    ) => {
      const inputSnapshot = rawInput;
      const canonical = canonicalizeSources(
        inputSnapshot.sources,
        inputSnapshot.runId,
      );
      const issued = await input.issuer.issue({
        requestId: inputSnapshot.requestId,
        runId: inputSnapshot.runId,
        householdId: inputSnapshot.householdId,
        userId: inputSnapshot.userId,
        spaceId: privateSpaceId,
        spaceAccessGrantId: inputSnapshot.spaceAccessGrantId,
        agentId: inputSnapshot.agentId,
        invocation: inputSnapshot.invocation,
        phasePurpose: inputSnapshot.phasePurpose,
        disclosurePurpose: disclosurePurpose(
          inputSnapshot.agentId,
          inputSnapshot.phasePurpose,
        ),
        provider: inputSnapshot.provider,
        recordAllowlist: canonical.recordAllowlist,
      });
      const grantId = UuidSchema.parse(issued.grant.id);
      const resolved = await input.gateway.authorize({
        requestId: inputSnapshot.requestId,
        runId: inputSnapshot.runId,
        householdId: inputSnapshot.householdId,
        userId: inputSnapshot.userId,
        spaceAccessGrantId: inputSnapshot.spaceAccessGrantId,
        agentId: inputSnapshot.agentId,
        invocation: inputSnapshot.invocation,
        phasePurpose: inputSnapshot.phasePurpose,
        phaseInvocationId: inputSnapshot.invocation.phaseInvocationId,
        provider: inputSnapshot.provider,
        requestedGrantId: grantId,
        requestedDataClasses: canonical.dataClasses,
        payload: canonical.payload,
      });
      if (resolved.status === 'denied') return resolved;
      const resolvedAllowlist = [...resolved.records]
        .map((record) => ({
          dataClass: record.dataClass,
          recordId: record.recordId,
          fields: [...record.fields].sort(),
        }))
        .sort((left, right) =>
          `${left.dataClass}\0${left.recordId}`.localeCompare(
            `${right.dataClass}\0${right.recordId}`,
          ),
        );
      const issuedContext = AgentInvocationContextSchema.parse(
        issued.grant.invocationContext,
      );
      const resolvedContext = AgentInvocationContextSchema.parse(
        resolved.invocationContext,
      );
      const issuedContextHash = Sha256Schema.parse(
        issued.grant.invocationContextHash,
      );
      const resolvedContextHash = Sha256Schema.parse(
        resolved.invocationContextHash,
      );
      const expectedContextRefs = disclosedContextRefsFor(
        canonical.recordAllowlist,
      );
      if (
        resolved.grantId !== grantId ||
        resolved.runId !== inputSnapshot.runId ||
        resolved.householdId !== inputSnapshot.householdId ||
        resolved.userId !== inputSnapshot.userId ||
        resolved.agentId !== inputSnapshot.agentId ||
        resolved.phaseInvocationId !==
          inputSnapshot.invocation.phaseInvocationId ||
        resolved.phasePurpose !== inputSnapshot.phasePurpose ||
        resolved.provider !== inputSnapshot.provider ||
        issuedContextHash !== resolvedContextHash ||
        hashCanonicalJson(issuedContext) !== issuedContextHash ||
        hashCanonicalJson(resolvedContext) !== resolvedContextHash ||
        hashCanonicalJson(issuedContext) !==
          hashCanonicalJson(resolvedContext) ||
        resolvedContext.orchestrationRunId !==
          inputSnapshot.invocation.orchestrationRunId ||
        resolvedContext.parentInvocationId !==
          inputSnapshot.invocation.parentInvocationId ||
        resolvedContext.agentInvocationId !==
          inputSnapshot.invocation.agentInvocationId ||
        resolvedContext.phaseInvocationId !==
          inputSnapshot.invocation.phaseInvocationId ||
        resolvedContext.actorId !== inputSnapshot.invocation.actorId ||
        resolvedContext.locale !== inputSnapshot.invocation.locale ||
        hashCanonicalJson(resolvedContext.grantedCapabilities) !==
          hashCanonicalJson(inputSnapshot.invocation.grantedCapabilities) ||
        hashCanonicalJson(resolvedContext.disclosedContextRefs) !==
          hashCanonicalJson(expectedContextRefs) ||
        resolvedContext.deadline !== resolved.expiresAt ||
        hashCanonicalJson(resolved.payload) !==
          hashCanonicalJson(canonical.payload) ||
        hashCanonicalJson(resolvedAllowlist) !==
          hashCanonicalJson(canonical.recordAllowlist)
      ) {
        throw new Error('api-model-disclosure-gateway-envelope-invalid');
      }
      return deepFreeze({
        ...resolved,
      });
    },
  });
};

import { Buffer } from 'node:buffer';

import { RunContext, RunState, RunToolApprovalItem } from '@openai/agents';
import { IdentifierSchema, OpaqueReferenceSchema } from '@emdo/contracts';
import type {
  AgentExecutionContext,
  OpenAiAgentsRunnerPort,
  OpenAiSdkAgent,
  OpenAiSdkFunctionTool,
} from '@emdo/agent-core';
import { z } from 'zod';

import {
  createProductionOpenAiAgentServiceBundle,
  type ProductionOpenAiAgentServiceBundle,
} from './core-openai-services.js';

const MAX_DISCLOSED_INPUT_BYTES = 48_000;
const MAX_DISCLOSED_NODES = 1_024;
const MAX_DISCLOSED_DEPTH = 12;
const MAX_DISCLOSED_ARRAY_ITEMS = 128;
const MAX_DISCLOSED_OBJECT_KEYS = 64;
const MAX_DISCLOSED_TEXT_LENGTH = 32_000;
const SYNTHETIC_USAGE = Object.freeze({ inputTokens: 1, outputTokens: 1 });
const SYNTHESIS_INSTRUCTION_SUFFIX =
  '. Keep evidence excerpts in their source language; do not translate those excerpts.';

export const FINANCE_SYNTHETIC_STAGING_COMMAND_MARKER =
  'EMDO_FINANCE_STAGING_V1 ' as const;
export const FINANCE_SYNTHETIC_STAGING_APPROVAL_CALL_ID =
  'finance-synthetic-staging-v1' as const;

const DateOnlySchema = z.iso.date();
const CurrencySchema = z.string().regex(/^[A-Z]{3}$/u);
const LocaleSchema = z.enum(['en-CA', 'fr-CA', 'ja-JP', 'ko-KR']);

const FinanceTransactionDraftSchema = z.strictObject({
  recordType: z.literal('transaction'),
  accountId: OpaqueReferenceSchema,
  categoryId: OpaqueReferenceSchema.nullable(),
  postedOn: DateOnlySchema,
  description: z.string().trim().min(1).max(2_000),
  amountCadMinor: z.number().int().safe(),
});

const SearchDocumentCommandSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: z.literal('search-document'),
  query: z.string().trim().min(1).max(1_000),
});
const CreateManualTransactionCommandSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: z.literal('create-manual-transaction'),
  recordId: OpaqueReferenceSchema,
  record: FinanceTransactionDraftSchema,
});
const CommitDocumentReviewCommandSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: z.literal('commit-document-review'),
  documentId: OpaqueReferenceSchema,
});
const DeleteDocumentCommandSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: z.literal('delete-document'),
  documentId: OpaqueReferenceSchema,
});

const FinanceSyntheticStagingCommandSchema = z.discriminatedUnion('action', [
  SearchDocumentCommandSchema,
  CreateManualTransactionCommandSchema,
  CommitDocumentReviewCommandSchema,
  DeleteDocumentCommandSchema,
]);

export type FinanceSyntheticStagingCommand = z.output<
  typeof FinanceSyntheticStagingCommandSchema
>;

const FinanceOutputSchema = z.strictObject({
  summary: z.string().trim().min(1).max(12_000),
  clarificationQuestion: z.string().trim().min(1).max(500).nullable(),
  evidenceReferences: z.array(IdentifierSchema).max(128),
  derivedValueReferences: z.array(IdentifierSchema).max(128),
  actionProposalReferences: z.array(IdentifierSchema).max(64),
});
type FinanceOutput = z.output<typeof FinanceOutputSchema>;

const FinanceDocumentEvidenceSchema = z.strictObject({
  evidenceId: OpaqueReferenceSchema,
  documentId: OpaqueReferenceSchema,
  documentType: z.enum([
    'receipt',
    'invoice',
    'bank-statement',
    'credit-statement',
    'pay-stub',
    'tax-slip',
    'insurance',
    'loan',
    'investment-statement',
    'other',
  ]),
  displayName: z.string().trim().min(1).max(255),
  page: z.number().int().min(1).max(250),
  excerpt: z.string().trim().min(1).max(2_000),
  sourceLocale: LocaleSchema,
});
const FinanceDocumentSearchHitSchema = z.strictObject({
  documentId: OpaqueReferenceSchema,
  documentType: FinanceDocumentEvidenceSchema.shape.documentType,
  displayName: z.string().trim().min(1).max(255),
  occurredOn: DateOnlySchema.nullable(),
  currency: CurrencySchema.nullable(),
  amountMinor: z.number().int().safe().nullable(),
  score: z.number().min(0).max(1),
  evidence: z.array(FinanceDocumentEvidenceSchema).min(1).max(8),
});
const FinanceDocumentSearchResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  hits: z.array(FinanceDocumentSearchHitSchema).max(10),
});

const FinanceRecordSummarySchema = z.strictObject({
  id: OpaqueReferenceSchema,
  recordType: z.enum([
    'account',
    'transaction',
    'category',
    'budget',
    'bill',
    'subscription',
    'goal',
  ]),
  label: z.string().trim().min(1).max(2_000),
  currency: z.literal('CAD').nullable(),
  amountCadMinor: z.number().int().safe().nullable(),
  effectiveOn: DateOnlySchema.nullable(),
  status: z.string().trim().min(1).max(100).nullable(),
  revision: z.number().int().safe().nonnegative().nullable(),
  updatedAt: z.iso.datetime({ offset: true }),
});
const FinanceSafeWriteResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  result: z.discriminatedUnion('status', [
    z.strictObject({
      status: z.enum(['applied', 'duplicate', 'ignored']),
      record: FinanceRecordSummarySchema,
    }),
    z.strictObject({
      status: z.literal('rejected'),
      record: FinanceRecordSummarySchema.nullable(),
      safeError: z.strictObject({
        code: z.string().trim().min(1).max(160),
        message: z.string().trim().min(1).max(500),
        retryable: z.literal(false),
      }),
    }),
  ]),
});

const DisclosedRecordSchema = z.strictObject({
  dataClass: z.string().trim().min(1).max(160),
  recordId: OpaqueReferenceSchema,
  fields: z.unknown(),
});
const DisclosedEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  records: z.array(DisclosedRecordSchema).max(64),
});
type DisclosedEnvelope = z.output<typeof DisclosedEnvelopeSchema>;

const SyntheticStateSchema = z.strictObject({
  profile: z.literal('finance-synthetic-staging-v1'),
  status: z.enum(['completed', 'interrupted']),
  callId: z.string().trim().min(1).max(256).nullable(),
});

const record = (
  value: unknown,
): Readonly<Record<string, unknown>> | undefined =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value))
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

/**
 * Every synthetic command is a complete marker string. This preserves the
 * marker boundary when a staged request is projected through disclosure.
 */
export const formatFinanceSyntheticStagingCommand = (
  rawCommand: unknown,
): string =>
  `${FINANCE_SYNTHETIC_STAGING_COMMAND_MARKER}${JSON.stringify(
    FinanceSyntheticStagingCommandSchema.parse(rawCommand),
  )}`;

const boundedJson = (value: unknown): boolean => {
  const pending: Array<Readonly<{ value: unknown; depth: number }>> = [
    Object.freeze({ value, depth: 0 }),
  ];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let textLength = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_DISCLOSED_NODES || current.depth > MAX_DISCLOSED_DEPTH) {
      return false;
    }
    if (typeof current.value === 'string') {
      textLength += current.value.length;
      if (textLength > MAX_DISCLOSED_TEXT_LENGTH) return false;
      continue;
    }
    if (
      current.value === null ||
      typeof current.value === 'boolean' ||
      (typeof current.value === 'number' && Number.isFinite(current.value))
    ) {
      continue;
    }
    if (typeof current.value !== 'object') return false;
    if (seen.has(current.value)) return false;
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_DISCLOSED_ARRAY_ITEMS) return false;
      for (const item of current.value) {
        pending.push(Object.freeze({ value: item, depth: current.depth + 1 }));
      }
      continue;
    }
    if (
      ![Object.prototype, null].includes(Object.getPrototypeOf(current.value))
    ) {
      return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(current.value);
    const keys = Object.keys(descriptors);
    if (
      keys.length > MAX_DISCLOSED_OBJECT_KEYS ||
      Reflect.ownKeys(descriptors).some((key) => typeof key === 'symbol')
    ) {
      return false;
    }
    for (const key of keys) {
      const descriptor = descriptors[key]!;
      if (!('value' in descriptor)) return false;
      textLength += key.length;
      if (textLength > MAX_DISCLOSED_TEXT_LENGTH) return false;
      pending.push(
        Object.freeze({
          value: descriptor.value,
          depth: current.depth + 1,
        }),
      );
    }
  }
  return true;
};

const disclosedEnvelope = (input: string): DisclosedEnvelope | undefined => {
  if (Buffer.byteLength(input, 'utf8') > MAX_DISCLOSED_INPUT_BYTES) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return undefined;
  }
  if (!boundedJson(parsed)) return undefined;
  const envelope = DisclosedEnvelopeSchema.safeParse(parsed);
  return envelope.success ? envelope.data : undefined;
};

const commandFromMarker = (
  marker: string,
): FinanceSyntheticStagingCommand | undefined => {
  if (!marker.startsWith(FINANCE_SYNTHETIC_STAGING_COMMAND_MARKER)) {
    return undefined;
  }
  const serialized = marker.slice(
    FINANCE_SYNTHETIC_STAGING_COMMAND_MARKER.length,
  );
  if (
    serialized.length === 0 ||
    serialized.length > 8_000 ||
    serialized.trim() !== serialized
  ) {
    return undefined;
  }
  try {
    const parsed = FinanceSyntheticStagingCommandSchema.safeParse(
      JSON.parse(serialized),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

const commandFromDisclosedInput = (
  envelope: DisclosedEnvelope,
  phase: 'manager-plan' | 'finance-execution',
): FinanceSyntheticStagingCommand | undefined => {
  const candidates: string[] = [];
  for (const disclosed of envelope.records) {
    const fields = record(disclosed.fields);
    if (fields === undefined) continue;
    if (phase === 'manager-plan') {
      if (
        disclosed.dataClass === 'conversation.messages' &&
        fields.role === 'user' &&
        typeof fields.content === 'string'
      ) {
        candidates.push(fields.content);
      }
      continue;
    }
    if (disclosed.dataClass !== 'agent.delegations') continue;
    const delegation = record(fields.delegation);
    const input =
      delegation === undefined ? undefined : record(delegation.input);
    if (
      delegation?.specialistId === 'finance' &&
      input !== undefined &&
      typeof input.request === 'string'
    ) {
      candidates.push(input.request);
    }
  }
  if (candidates.length !== 1) return undefined;
  return commandFromMarker(candidates[0]!);
};

const synthesisOutput = (
  envelope: DisclosedEnvelope,
): FinanceOutput | undefined => {
  const outcomes: FinanceOutput[] = [];
  for (const disclosed of envelope.records) {
    if (disclosed.dataClass !== 'agent.specialist-outcomes') continue;
    const fields = record(disclosed.fields);
    const outcome = fields === undefined ? undefined : record(fields.outcome);
    if (
      outcome?.specialistId !== 'finance' ||
      outcome.status !== 'completed' ||
      typeof outcome.delegationId !== 'string'
    ) {
      continue;
    }
    const output = FinanceOutputSchema.safeParse(outcome.facts);
    if (!output.success) return undefined;
    outcomes.push(output.data);
  }
  if (outcomes.length !== 1) return undefined;
  const outcome = outcomes[0]!;
  return FinanceOutputSchema.parse({
    summary: outcome.summary,
    clarificationQuestion: outcome.clarificationQuestion,
    evidenceReferences: [...outcome.evidenceReferences],
    derivedValueReferences: [...outcome.derivedValueReferences],
    actionProposalReferences: [...outcome.actionProposalReferences],
  });
};

const isServerOwnedSynthesis = (
  agent: OpenAiSdkAgent,
  context: AgentExecutionContext,
): boolean => {
  const expected = `Write the final EMDO synthesis in ${context.locale}${SYNTHESIS_INSTRUCTION_SUFFIX}`;
  return (
    agent.name === 'manager' &&
    typeof agent.instructions === 'string' &&
    agent.instructions.includes(expected)
  );
};

const asRunContext = (
  context:
    AgentExecutionContext | RunContext<AgentExecutionContext> | undefined,
): RunContext<AgentExecutionContext> => {
  if (context instanceof RunContext) return context;
  if (context === undefined) {
    throw new Error('finance-synthetic-staging-context-unavailable');
  }
  return new RunContext(context);
};

/**
 * A provider resume supplies the SDK's live RunState rather than re-sending
 * the disclosed input. The synthetic runner deliberately reads only the
 * original, already-bounded disclosure string; it does not inspect history,
 * generated items, tool state, or any other resumable state.
 */
const disclosedInputFromRunState = (
  agent: OpenAiSdkAgent,
  input: unknown,
): string | undefined => {
  if (!(input instanceof RunState) || input.currentAgent !== agent) {
    return undefined;
  }
  return typeof input._originalInput === 'string'
    ? input._originalInput
    : undefined;
};

const exactFunctionTool = (
  agent: OpenAiSdkAgent,
  name: 'finance_documents_search' | 'finance_records_write',
): OpenAiSdkFunctionTool => {
  const candidates = agent.tools.filter(
    (tool): tool is OpenAiSdkFunctionTool =>
      tool.type === 'function' && tool.name === name,
  );
  if (candidates.length !== 1) {
    throw new Error(`finance-synthetic-staging-tool-unavailable:${name}`);
  }
  return candidates[0]!;
};

const completedState = () =>
  Object.freeze({
    usage: SYNTHETIC_USAGE,
    getInterruptions: () => [],
    approve: () => {
      throw new Error('finance-synthetic-staging-direct-approval-forbidden');
    },
    reject: () => {
      throw new Error('finance-synthetic-staging-direct-approval-forbidden');
    },
    toString: () =>
      JSON.stringify(
        SyntheticStateSchema.parse({
          profile: 'finance-synthetic-staging-v1',
          status: 'completed',
          callId: null,
        }),
      ),
  });

const interruptedState = (item: RunToolApprovalItem) => {
  const interruptions = Object.freeze([item]);
  return Object.freeze({
    usage: SYNTHETIC_USAGE,
    getInterruptions: () => [...interruptions],
    approve: () => {
      throw new Error('finance-synthetic-staging-direct-approval-forbidden');
    },
    reject: () => {
      throw new Error('finance-synthetic-staging-direct-approval-forbidden');
    },
    toString: () =>
      JSON.stringify(
        SyntheticStateSchema.parse({
          profile: 'finance-synthetic-staging-v1',
          status: 'interrupted',
          callId: FINANCE_SYNTHETIC_STAGING_APPROVAL_CALL_ID,
        }),
      ),
  });
};

const financeSearchOutput = (raw: unknown): FinanceOutput => {
  const result = FinanceDocumentSearchResultSchema.parse(raw);
  const evidenceReferences = result.hits.flatMap((hit) =>
    hit.evidence.map((evidence) => evidence.evidenceId),
  );
  if (evidenceReferences.length > 128) {
    throw new Error('finance-synthetic-staging-evidence-out-of-bounds');
  }
  return FinanceOutputSchema.parse({
    summary:
      result.hits.length === 0
        ? 'No reviewed finance documents matched the search.'
        : `Found ${result.hits.length} reviewed finance document result${result.hits.length === 1 ? '' : 's'}.`,
    clarificationQuestion: null,
    evidenceReferences,
    derivedValueReferences: [],
    actionProposalReferences: [],
  });
};

const financeSafeWriteOutput = (raw: unknown): FinanceOutput => {
  const result = FinanceSafeWriteResultSchema.parse(raw).result;
  if (result.status === 'rejected') {
    return FinanceOutputSchema.parse({
      summary: result.safeError.message,
      clarificationQuestion: null,
      evidenceReferences: [],
      derivedValueReferences: [],
      actionProposalReferences: [],
    });
  }
  return FinanceOutputSchema.parse({
    summary:
      result.status === 'duplicate'
        ? 'The manual transaction was already recorded.'
        : result.status === 'ignored'
          ? 'No finance change was needed.'
          : 'The manual transaction was recorded.',
    clarificationQuestion: null,
    evidenceReferences: [],
    derivedValueReferences: [],
    actionProposalReferences: [],
  });
};

const invoke = async (
  tool: OpenAiSdkFunctionTool,
  context: RunContext<AgentExecutionContext>,
  arguments_: Readonly<Record<string, unknown>>,
): Promise<unknown> => tool.invoke(context, JSON.stringify(arguments_));

const guardedInterruption = async (
  agent: OpenAiSdkAgent,
  tool: OpenAiSdkFunctionTool,
  context: RunContext<AgentExecutionContext>,
  arguments_: Readonly<Record<string, unknown>>,
) => {
  if (typeof tool.needsApproval !== 'function') {
    throw new Error('finance-synthetic-staging-approval-unavailable');
  }
  const needsApproval = await tool.needsApproval(
    context,
    arguments_,
    FINANCE_SYNTHETIC_STAGING_APPROVAL_CALL_ID,
  );
  if (needsApproval !== true) {
    throw new Error('finance-synthetic-staging-approval-required');
  }
  const approval = new RunToolApprovalItem(
    {
      type: 'function_call',
      callId: FINANCE_SYNTHETIC_STAGING_APPROVAL_CALL_ID,
      name: 'finance_records_write',
      arguments: JSON.stringify(arguments_),
    },
    agent,
  );
  return Object.freeze({
    state: interruptedState(approval),
    interruptions: Object.freeze([approval]),
  });
};

const managerPlan = (command: FinanceSyntheticStagingCommand) =>
  Object.freeze({
    delegations: Object.freeze([
      Object.freeze({
        id: 'finance-synthetic-staging',
        specialistId: 'finance',
        input: Object.freeze({
          request: formatFinanceSyntheticStagingCommand(command),
        }),
        dependsOn: Object.freeze([]),
      }),
    ]),
    directResponse: null,
  });

const executeFinanceCommand = async (
  agent: OpenAiSdkAgent,
  command: FinanceSyntheticStagingCommand,
  context: RunContext<AgentExecutionContext>,
) => {
  if (command.action === 'search-document') {
    const tool = exactFunctionTool(agent, 'finance_documents_search');
    const output = await invoke(
      tool,
      context,
      Object.freeze({
        schemaVersion: 1,
        query: command.query,
        limit: 10,
      }),
    );
    return Object.freeze({
      state: completedState(),
      finalOutput: financeSearchOutput(output),
    });
  }
  const tool = exactFunctionTool(agent, 'finance_records_write');
  if (command.action === 'create-manual-transaction') {
    const output = await invoke(
      tool,
      context,
      Object.freeze({
        schemaVersion: 1,
        mutation: Object.freeze({
          kind: 'create',
          recordId: command.recordId,
          record: command.record,
        }),
      }),
    );
    return Object.freeze({
      state: completedState(),
      finalOutput: financeSafeWriteOutput(output),
    });
  }
  return guardedInterruption(
    agent,
    tool,
    context,
    Object.freeze({
      schemaVersion: 1,
      mutation: Object.freeze(
        command.action === 'commit-document-review'
          ? {
              kind: 'commit-document-review' as const,
              documentId: command.documentId,
            }
          : {
              kind: 'delete-document' as const,
              documentId: command.documentId,
            },
      ),
    }),
  );
};

const hasAgentEnvironmentKey = (
  descriptors: Readonly<Record<string, PropertyDescriptor>>,
): boolean =>
  Reflect.ownKeys(descriptors).some((key) => {
    if (typeof key !== 'string') return false;
    return key.startsWith('EMDO_OPENAI_AGENT_');
  });

type FinanceSyntheticStagingAgentMode = 'local' | 'live-chat';

const readExactSyntheticStagingEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): FinanceSyntheticStagingAgentMode | undefined => {
  if (environment === null || typeof environment !== 'object') return undefined;
  const prototype = Object.getPrototypeOf(environment);
  if (
    prototype !== Object.prototype &&
    prototype !== null &&
    Object.getPrototypeOf(prototype) !== Object.prototype
  ) {
    return undefined;
  }
  const descriptors = Object.getOwnPropertyDescriptors(environment);
  const inheritedDescriptors =
    prototype === null || prototype === Object.prototype
      ? undefined
      : Object.getOwnPropertyDescriptors(prototype);
  const objectPrototypeDescriptors = Object.getOwnPropertyDescriptors(
    Object.prototype,
  );
  if (
    (inheritedDescriptors !== undefined &&
      hasAgentEnvironmentKey(inheritedDescriptors)) ||
    hasAgentEnvironmentKey(objectPrototypeDescriptors)
  ) {
    return undefined;
  }
  const value = (key: string): unknown => {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true
    ) {
      return undefined;
    }
    return descriptor.value;
  };
  const exactStaging =
    value('EMDO_ENVIRONMENT') === 'staging' &&
    value('EMDO_ALLOW_LOOPBACK_API_INGRESS') === 'true' &&
    value('EMDO_SYNTHETIC_DATA_ONLY') === 'true' &&
    value('EMDO_FINANCE_SYNTHETIC_STAGING') === 'true' &&
    value('EMDO_FINANCE_DOCUMENTS_ENABLED') === 'true';
  if (!exactStaging) return undefined;
  const liveChat = value('EMDO_FINANCE_SYNTHETIC_STAGING_LIVE_CHAT');
  if (liveChat === undefined || liveChat === 'false') {
    return hasAgentEnvironmentKey(descriptors) ||
      value('EMDO_OPENAI_FINANCE_API_KEY') !== undefined
      ? undefined
      : 'local';
  }
  if (
    liveChat === 'true' &&
    value('EMDO_FINANCE_RESTORE_READ_ONLY') === 'true'
  ) {
    return 'local';
  }
  if (
    liveChat !== 'true' ||
    value('EMDO_OPENAI_FINANCE_API_KEY') !== undefined
  ) {
    return undefined;
  }
  return 'live-chat';
};

const localRunner = (): OpenAiAgentsRunnerPort => {
  const runner: OpenAiAgentsRunnerPort = {
    run: async (agent, input, options) => {
      const disclosedInput =
        typeof input === 'string'
          ? input
          : disclosedInputFromRunState(agent, input);
      if (disclosedInput === undefined) {
        throw new Error('finance-synthetic-staging-resume-unavailable');
      }
      const context = asRunContext(options.context);
      if (options.signal.aborted || context.context.abortSignal.aborted) {
        throw new Error('finance-synthetic-staging-run-aborted');
      }
      const envelope = disclosedEnvelope(disclosedInput);
      if (envelope === undefined) {
        throw new Error('finance-synthetic-staging-disclosure-invalid');
      }
      if (agent.name === 'manager') {
        if (isServerOwnedSynthesis(agent, context.context)) {
          const output = synthesisOutput(envelope);
          if (output === undefined) {
            throw new Error(
              'finance-synthetic-staging-synthesis-input-invalid',
            );
          }
          return Object.freeze({
            state: completedState(),
            finalOutput: output,
          });
        }
        const command = commandFromDisclosedInput(envelope, 'manager-plan');
        if (command === undefined) {
          throw new Error('finance-synthetic-staging-command-unavailable');
        }
        return Object.freeze({
          state: completedState(),
          finalOutput: managerPlan(command),
        });
      }
      if (agent.name !== 'finance') {
        throw new Error('finance-synthetic-staging-agent-unavailable');
      }
      const command = commandFromDisclosedInput(envelope, 'finance-execution');
      if (command === undefined) {
        throw new Error('finance-synthetic-staging-command-unavailable');
      }
      return executeFinanceCommand(agent, command, context);
    },
  };
  return Object.freeze(runner);
};

const exactSyntheticSynthesis = (envelope: DisclosedEnvelope): boolean => {
  if (synthesisOutput(envelope) === undefined) return false;
  const messages = envelope.records.filter((item) => {
    const fields = record(item.fields);
    return (
      item.dataClass === 'conversation.messages' &&
      fields?.role === 'user' &&
      typeof fields.content === 'string'
    );
  });
  const plans = envelope.records.filter(
    (item) => item.dataClass === 'agent.manager-plans',
  );
  if (messages.length !== 1 || plans.length !== 1) return false;
  const messageFields = record(messages[0]!.fields);
  const planFields = record(plans[0]!.fields);
  const plan = planFields === undefined ? undefined : record(planFields.plan);
  const delegations = plan === undefined ? undefined : plan.delegations;
  if (
    messageFields === undefined ||
    typeof messageFields.content !== 'string' ||
    !Array.isArray(delegations) ||
    delegations.length !== 1
  ) {
    return false;
  }
  const delegation = record(delegations[0]);
  const input = delegation === undefined ? undefined : record(delegation.input);
  if (
    delegation?.id !== 'finance-synthetic-staging' ||
    delegation.specialistId !== 'finance' ||
    !Array.isArray(delegation.dependsOn) ||
    delegation.dependsOn.length !== 0 ||
    input === undefined ||
    typeof input.request !== 'string'
  ) {
    return false;
  }
  const messageCommand = commandFromMarker(messageFields.content);
  const delegationCommand = commandFromMarker(input.request);
  return (
    messageCommand !== undefined &&
    delegationCommand !== undefined &&
    formatFinanceSyntheticStagingCommand(messageCommand) ===
      formatFinanceSyntheticStagingCommand(delegationCommand) &&
    messageFields.content ===
      formatFinanceSyntheticStagingCommand(messageCommand)
  );
};

/**
 * Finance staging acceptance is deliberately provider-free.  Once live chat is
 * enabled, route only exact, bounded acceptance marker envelopes to that local
 * runner; every other turn remains a real model turn.
 */
const isExactSyntheticStagingMarkerFlow = (
  agent: OpenAiSdkAgent,
  input: unknown,
  context:
    AgentExecutionContext | RunContext<AgentExecutionContext> | undefined,
): boolean => {
  const disclosedInput =
    typeof input === 'string'
      ? input
      : disclosedInputFromRunState(agent, input);
  if (disclosedInput === undefined) return false;
  const envelope = disclosedEnvelope(disclosedInput);
  if (envelope === undefined) return false;
  let runContext: RunContext<AgentExecutionContext>;
  try {
    runContext = asRunContext(context);
  } catch {
    return false;
  }
  if (agent.name === 'manager') {
    return isServerOwnedSynthesis(agent, runContext.context)
      ? exactSyntheticSynthesis(envelope)
      : commandFromDisclosedInput(envelope, 'manager-plan') !== undefined;
  }
  return (
    agent.name === 'finance' &&
    commandFromDisclosedInput(envelope, 'finance-execution') !== undefined
  );
};

const liveChatRunner = (
  providerRunner: OpenAiAgentsRunnerPort,
): OpenAiAgentsRunnerPort => {
  const deterministicRunner = localRunner();
  return Object.freeze({
    run: (...args: Parameters<OpenAiAgentsRunnerPort['run']>) => {
      const [agent, input, options] = args;
      return isExactSyntheticStagingMarkerFlow(agent, input, options.context)
        ? deterministicRunner.run(...args)
        : providerRunner.run(...args);
    },
  });
};

/**
 * A staging-only Finance runner. Local mode accepts only fixed synthetic
 * commands. Read-only restore verification remains deterministic even if live
 * chat is configured; all other real model execution requires a separate exact
 * opt-in and can never activate outside the isolated Finance staging
 * environment.
 */
export const createFinanceSyntheticStagingAgentServiceBundle = (
  environment: Readonly<Record<string, string | undefined>>,
): ProductionOpenAiAgentServiceBundle | undefined => {
  const mode = readExactSyntheticStagingEnvironment(environment);
  if (mode === undefined) return undefined;
  if (mode === 'live-chat') {
    const provider = createProductionOpenAiAgentServiceBundle({ environment });
    return provider === undefined
      ? undefined
      : Object.freeze({ ...provider, runner: liveChatRunner(provider.runner) });
  }
  const close = (() => {
    let closed: Promise<void> | undefined;
    return () => {
      closed ??= Promise.resolve();
      return closed;
    };
  })();
  const bundle: ProductionOpenAiAgentServiceBundle = {
    modelAvailability: {
      isAvailable: async (model) =>
        model === 'gpt-5.6-luna' || model === 'gpt-5.6-terra',
    },
    costCalculator: {
      calculateCadMinor: () => 1,
    },
    runner: localRunner(),
    close,
  };
  return Object.freeze(bundle);
};

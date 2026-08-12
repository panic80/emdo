import { createHash } from 'node:crypto';

import type { LocalTraceEvent } from '../../packages/agent-core/src/trace.js';

import type { AgentEvalTraceEvent } from './runner.js';

type EventPayload = AgentEvalTraceEvent extends infer Event
  ? Event extends AgentEvalTraceEvent
    ? Omit<Event, 'sequence' | 'at'>
    : never
  : never;

const KNOWN_EVENTS = new Set([
  'model.resolved',
  'model.unavailable',
  'manager.routed',
  'specialist.dispatched',
  'specialist.outcome',
  'capability.decided',
  'evidence.external',
  'evidence.observed',
  'derived.value',
  'disclosure.sent',
  'disclosure.denied',
  'approval.interrupted',
  'action.executed',
]);

const IGNORED_LIFECYCLE_EVENTS = new Set([
  'run.started',
  'memory.retrieved',
  'approval.resumed',
  'run.completed',
  'run.failed',
  'spend.warning',
]);

const fail = (): never => {
  throw new Error('invalid-eval-local-trace-event');
};

const plainRecord = (raw: unknown): Readonly<Record<string, unknown>> => {
  if (
    raw === null ||
    typeof raw !== 'object' ||
    (Object.getPrototypeOf(raw) !== Object.prototype &&
      Object.getPrototypeOf(raw) !== null) ||
    Object.getOwnPropertySymbols(raw).length > 0
  ) {
    return fail();
  }
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  for (const descriptor of Object.values(descriptors)) {
    if (
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !('value' in descriptor)
    ) {
      return fail();
    }
  }
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
};

const stringValue = (
  record: Readonly<Record<string, unknown>>,
  key: string,
): string => {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) {
    return fail();
  }
  return value;
};

const optionalString = (
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined =>
  record[key] === undefined ? undefined : stringValue(record, key);

const enumValue = <Value extends string>(
  record: Readonly<Record<string, unknown>>,
  key: string,
  allowed: readonly Value[],
): Value => {
  const value = stringValue(record, key);
  return allowed.includes(value as Value) ? (value as Value) : fail();
};

const integerValue = (
  record: Readonly<Record<string, unknown>>,
  key: string,
): number => {
  const value = record[key];
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : fail();
};

const stringArray = (
  record: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] => {
  const raw = record[key];
  if (!Array.isArray(raw) || raw.length > 128) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(raw).length !== raw.length + 1) return fail();
  const values: string[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      typeof descriptor.value !== 'string' ||
      descriptor.value.length === 0 ||
      descriptor.value.length > 2_048
    ) {
      return fail();
    }
    values.push(descriptor.value);
  }
  return values;
};

const isoDateTime = (
  record: Readonly<Record<string, unknown>>,
  key: string,
): string => {
  const value = stringValue(record, key);
  return Number.isFinite(Date.parse(value)) ? value : fail();
};

const exactKeys = (
  record: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): void => {
  const keys = Object.keys(record);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    return fail();
  }
};

const booleanValue = (
  record: Readonly<Record<string, unknown>>,
  key: string,
): boolean => {
  const value = record[key];
  return typeof value === 'boolean' ? value : fail();
};

const normalizeKnownEvent = (
  type: string,
  metadata: Readonly<Record<string, unknown>>,
  runId: string,
): EventPayload | undefined => {
  switch (type) {
    case 'model.resolved': {
      exactKeys(
        metadata,
        ['requestedModel', 'resolvedModel', 'reason'],
        ['fallbackCause', 'agentId', 'escalationTrigger'],
      );
      if (metadata.fallbackCause !== undefined) {
        stringValue(metadata, 'fallbackCause');
      }
      if (metadata.agentId !== undefined) stringValue(metadata, 'agentId');
      const escalationTrigger = optionalString(metadata, 'escalationTrigger');
      if (
        escalationTrigger !== undefined &&
        escalationTrigger !== 'complex-reasoning'
      ) {
        return fail();
      }
      return {
        type: 'model-resolution',
        status: 'resolved',
        requestedModel: enumValue(metadata, 'requestedModel', [
          'gpt-5.6-luna',
          'gpt-5.6-terra',
        ]),
        resolvedModel: enumValue(metadata, 'resolvedModel', [
          'gpt-5.6-luna',
          'gpt-5.6-terra',
        ]),
        reason: enumValue(metadata, 'reason', [
          'default',
          'dependent-cross-domain',
          'failed-output-validation',
          'low-confidence-reconciliation',
          'complex-reasoning',
          'luna-unavailable',
          'terra-unavailable',
        ]),
        ...(escalationTrigger === undefined
          ? {}
          : { escalationTrigger: 'complex-reasoning' as const }),
      };
    }
    case 'model.unavailable': {
      exactKeys(
        metadata,
        [
          'requestedModel',
          'resolvedModel',
          'attemptedModels',
          'reason',
          'safeErrorCode',
        ],
        ['escalationTrigger'],
      );
      if (metadata.resolvedModel !== null) return fail();
      const reason = enumValue(metadata, 'reason', [
        'no-configured-model-available',
        'required-complex-model-unavailable',
        'configured-model-escalation-not-allowed',
        'configured-model-fallback-not-allowed',
      ]);
      const escalationTrigger = optionalString(metadata, 'escalationTrigger');
      if (
        escalationTrigger !== undefined &&
        ![
          'dependent-cross-domain',
          'failed-output-validation',
          'low-confidence-reconciliation',
          'luna-unavailable',
          'complex-reasoning',
        ].includes(escalationTrigger)
      ) {
        return fail();
      }
      return {
        type: 'model-resolution',
        status: 'unavailable',
        requestedModel: enumValue(metadata, 'requestedModel', [
          'gpt-5.6-luna',
          'gpt-5.6-terra',
        ]),
        attemptedModels: stringArray(metadata, 'attemptedModels').map(
          (model) =>
            model === 'gpt-5.6-luna' || model === 'gpt-5.6-terra'
              ? model
              : fail(),
        ),
        reason,
        ...(escalationTrigger === undefined
          ? {}
          : {
              escalationTrigger: escalationTrigger as
                | 'dependent-cross-domain'
                | 'failed-output-validation'
                | 'low-confidence-reconciliation'
                | 'luna-unavailable'
                | 'complex-reasoning',
            }),
        safeErrorCode: enumValue(metadata, 'safeErrorCode', [
          'agent-model-unavailable',
          'required-agent-model-unavailable',
          'agent-model-escalation-not-allowed',
          'agent-model-fallback-not-allowed',
        ]),
      };
    }
    case 'manager.routed': {
      exactKeys(metadata, ['agentIds', 'delegationCount']);
      const agentIds = stringArray(metadata, 'agentIds');
      if (integerValue(metadata, 'delegationCount') !== agentIds.length) {
        return fail();
      }
      return { type: 'route', agentIds };
    }
    case 'specialist.dispatched':
      exactKeys(metadata, ['delegationId', 'agentId', 'wave', 'dependsOn']);
      return {
        type: 'specialist-dispatch',
        delegationId: stringValue(metadata, 'delegationId'),
        agentId: stringValue(metadata, 'agentId'),
        wave: integerValue(metadata, 'wave'),
        dependsOn: stringArray(metadata, 'dependsOn'),
      };
    case 'specialist.outcome': {
      exactKeys(metadata, ['delegationId', 'agentId', 'status'], ['errorCode']);
      const safeErrorCode = optionalString(metadata, 'errorCode');
      return {
        type: 'specialist-outcome',
        delegationId: stringValue(metadata, 'delegationId'),
        agentId: stringValue(metadata, 'agentId'),
        status: enumValue(metadata, 'status', [
          'completed',
          'failed',
          'blocked',
        ]),
        ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
      };
    }
    case 'capability.decided': {
      exactKeys(metadata, ['agentId', 'capabilityId', 'decision'], ['reason']);
      const reason = optionalString(metadata, 'reason');
      return {
        type: 'capability-decision',
        agentId: stringValue(metadata, 'agentId'),
        capabilityId: stringValue(metadata, 'capabilityId'),
        decision: enumValue(metadata, 'decision', ['allowed', 'denied']),
        ...(reason === undefined ? {} : { reason }),
      };
    }
    case 'evidence.external':
      exactKeys(metadata, ['evidenceId', 'trust', 'instructionTreatment']);
      return {
        type: 'external-content',
        evidenceId: stringValue(metadata, 'evidenceId'),
        trust: enumValue(metadata, 'trust', ['trusted', 'untrusted']),
        instructionTreatment: enumValue(metadata, 'instructionTreatment', [
          'not-present',
          'ignored',
        ]),
      };
    case 'evidence.observed': {
      exactKeys(
        metadata,
        ['evidenceId', 'observedAt', 'expiresAt', 'disposition'],
        ['replacementEvidenceId'],
      );
      const replacementEvidenceId = optionalString(
        metadata,
        'replacementEvidenceId',
      );
      return {
        type: 'evidence-observed',
        evidenceId: stringValue(metadata, 'evidenceId'),
        observedAt: isoDateTime(metadata, 'observedAt'),
        expiresAt: isoDateTime(metadata, 'expiresAt'),
        disposition: enumValue(metadata, 'disposition', [
          'accepted',
          'rejected-stale',
          'refreshed',
        ]),
        ...(replacementEvidenceId === undefined
          ? {}
          : { replacementEvidenceId }),
      };
    }
    case 'derived.value':
      exactKeys(metadata, [
        'derivedValueId',
        'inputEvidenceIds',
        'computation',
      ]);
      return {
        type: 'derived-value',
        derivedValueId: stringValue(metadata, 'derivedValueId'),
        inputEvidenceIds: stringArray(metadata, 'inputEvidenceIds'),
        computation: stringValue(metadata, 'computation'),
      };
    case 'disclosure.sent':
      exactKeys(metadata, [
        'grantId',
        'grantVersion',
        'agentId',
        'purpose',
        'phasePurpose',
        'dataClass',
        'recordId',
        'fields',
        'provider',
        'expiresAt',
      ]);
      return {
        type: 'data-disclosure',
        grantId: stringValue(metadata, 'grantId'),
        grantVersion: stringValue(metadata, 'grantVersion'),
        runId,
        agentId: stringValue(metadata, 'agentId'),
        purpose: stringValue(metadata, 'purpose'),
        phasePurpose: enumValue(metadata, 'phasePurpose', [
          'manager-plan',
          'specialist-execution',
          'manager-synthesis',
        ]),
        dataClass: stringValue(metadata, 'dataClass'),
        recordId: stringValue(metadata, 'recordId'),
        fields: stringArray(metadata, 'fields'),
        provider: stringValue(metadata, 'provider'),
        expiresAt: isoDateTime(metadata, 'expiresAt'),
      };
    case 'disclosure.denied':
      exactKeys(metadata, ['grantId', 'agentId', 'reason']);
      return {
        type: 'data-disclosure-denied',
        grantId: stringValue(metadata, 'grantId'),
        runId,
        agentId: stringValue(metadata, 'agentId'),
        reason: enumValue(metadata, 'reason', [
          'grant-run-mismatch',
          'grant-expired',
          'field-denied',
        ]),
      };
    case 'approval.interrupted':
      exactKeys(metadata, [
        'checkpointId',
        'proposalId',
        'capabilityId',
        'agentId',
        'channel',
      ]);
      return {
        type: 'approval-interrupted',
        checkpointId: stringValue(metadata, 'checkpointId'),
        proposalId: stringValue(metadata, 'proposalId'),
        capabilityId: stringValue(metadata, 'capabilityId'),
        agentId: stringValue(metadata, 'agentId'),
        channel: enumValue(metadata, 'channel', ['authenticated-visual']),
      };
    case 'action.executed':
      exactKeys(metadata, [
        'agentId',
        'proposalId',
        'capabilityId',
        'idempotencyKey',
        'providerReadbackVerified',
      ]);
      if (booleanValue(metadata, 'providerReadbackVerified') !== true) {
        return fail();
      }
      return {
        type: 'action-executed',
        proposalId: stringValue(metadata, 'proposalId'),
        capabilityId: stringValue(metadata, 'capabilityId'),
        idempotencyKey: stringValue(metadata, 'idempotencyKey'),
        agentId: stringValue(metadata, 'agentId'),
      };
    default:
      return undefined;
  }
};

const validateIgnoredLifecycleEvent = (
  type: string,
  metadata: Readonly<Record<string, unknown>>,
): void => {
  switch (type) {
    case 'run.started':
      exactKeys(metadata, []);
      return;
    case 'memory.retrieved':
      exactKeys(metadata, ['entryCount']);
      integerValue(metadata, 'entryCount');
      return;
    case 'approval.resumed':
      exactKeys(metadata, [
        'agentId',
        'proposalId',
        'capabilityId',
        'decision',
      ]);
      stringValue(metadata, 'agentId');
      stringValue(metadata, 'proposalId');
      stringValue(metadata, 'capabilityId');
      enumValue(metadata, 'decision', ['approve', 'reject']);
      return;
    case 'run.completed':
      exactKeys(metadata, ['partialFailures']);
      booleanValue(metadata, 'partialFailures');
      return;
    case 'run.failed':
      exactKeys(metadata, ['code']);
      stringValue(metadata, 'code');
      return;
    case 'spend.warning':
      exactKeys(metadata, ['code', 'thresholdCadMinor']);
      enumValue(metadata, 'code', [
        'monthly-ai-spend-warning-threshold-reached',
      ]);
      integerValue(metadata, 'thresholdCadMinor');
      return;
    default:
      return fail();
  }
};

export const normalizeLocalTraceEvents = (
  runId: string,
  expectedTraceReference: string,
  rawEvents: readonly LocalTraceEvent[],
): readonly AgentEvalTraceEvent[] => {
  if (
    typeof runId !== 'string' ||
    runId.length === 0 ||
    typeof expectedTraceReference !== 'string' ||
    expectedTraceReference.length < 2 ||
    expectedTraceReference.length > 160 ||
    !Array.isArray(rawEvents) ||
    rawEvents.length > 4_096
  ) {
    return fail();
  }
  const expectedRunReference = `sha256:${createHash('sha256')
    .update(runId)
    .digest('hex')
    .slice(0, 16)}`;
  let previousAt = Number.NEGATIVE_INFINITY;
  const normalized: AgentEvalTraceEvent[] = [];
  for (const rawEvent of rawEvents) {
    const event = plainRecord(rawEvent);
    exactKeys(event, [
      'traceReference',
      'runReference',
      'type',
      'occurredAt',
      'metadata',
    ]);
    const traceReference = stringValue(event, 'traceReference');
    const runReference = stringValue(event, 'runReference');
    const type = stringValue(event, 'type');
    const occurredAt = isoDateTime(event, 'occurredAt');
    const occurredAtMs = Date.parse(occurredAt);
    if (
      traceReference !== expectedTraceReference ||
      runReference !== expectedRunReference ||
      occurredAtMs < previousAt
    ) {
      return fail();
    }
    previousAt = occurredAtMs;

    const metadata = plainRecord(event.metadata);
    if (!KNOWN_EVENTS.has(type)) {
      if (IGNORED_LIFECYCLE_EVENTS.has(type)) {
        validateIgnoredLifecycleEvent(type, metadata);
        continue;
      }
      return fail();
    }
    const payload = normalizeKnownEvent(type, metadata, runId);
    if (payload === undefined) return fail();
    normalized.push({
      ...payload,
      sequence: normalized.length + 1,
      at: occurredAt,
    } as AgentEvalTraceEvent);
  }
  return Object.freeze(normalized.map((event) => Object.freeze(event)));
};

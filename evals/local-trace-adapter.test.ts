import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { LocalTraceEvent } from '../packages/agent-core/src/trace.js';
import { normalizeLocalTraceEvents } from './src/local-trace-adapter.js';

const TRACE_REFERENCE = 'trace-eval-runtime-1';

const localEvent = (
  runId: string,
  type: string,
  metadata: LocalTraceEvent['metadata'],
  offsetMs: number,
): LocalTraceEvent => ({
  traceReference: TRACE_REFERENCE,
  runReference: `sha256:${createHash('sha256').update(runId).digest('hex').slice(0, 16)}`,
  type,
  occurredAt: new Date(
    Date.parse('2026-08-09T16:00:00.000Z') + offsetMs,
  ).toISOString(),
  metadata,
});

describe('local trace eval adapter', () => {
  it('normalizes the frozen runtime orchestration trace vocabulary', () => {
    const runId = '018f1f5e-6f47-7d61-a6dd-1e86f8b80401';
    const normalized = normalizeLocalTraceEvents(runId, TRACE_REFERENCE, [
      localEvent(runId, 'run.started', {}, 0),
      localEvent(
        runId,
        'model.resolved',
        {
          requestedModel: 'gpt-5.6-luna',
          resolvedModel: 'gpt-5.6-terra',
          reason: 'luna-unavailable',
        },
        1,
      ),
      localEvent(
        runId,
        'manager.routed',
        { agentIds: ['scheduler', 'shopping'], delegationCount: 2 },
        2,
      ),
      localEvent(
        runId,
        'specialist.dispatched',
        {
          delegationId: 'scheduler-plan',
          agentId: 'scheduler',
          wave: 0,
          dependsOn: [],
        },
        3,
      ),
      localEvent(
        runId,
        'specialist.outcome',
        {
          delegationId: 'scheduler-plan',
          agentId: 'scheduler',
          status: 'completed',
        },
        4,
      ),
      localEvent(runId, 'run.completed', { partialFailures: false }, 5),
    ]);

    expect(normalized).toEqual([
      {
        sequence: 1,
        at: '2026-08-09T16:00:00.001Z',
        type: 'model-resolution',
        status: 'resolved',
        requestedModel: 'gpt-5.6-luna',
        resolvedModel: 'gpt-5.6-terra',
        reason: 'luna-unavailable',
      },
      {
        sequence: 2,
        at: '2026-08-09T16:00:00.002Z',
        type: 'route',
        agentIds: ['scheduler', 'shopping'],
      },
      {
        sequence: 3,
        at: '2026-08-09T16:00:00.003Z',
        type: 'specialist-dispatch',
        delegationId: 'scheduler-plan',
        agentId: 'scheduler',
        wave: 0,
        dependsOn: [],
      },
      {
        sequence: 4,
        at: '2026-08-09T16:00:00.004Z',
        type: 'specialist-outcome',
        delegationId: 'scheduler-plan',
        agentId: 'scheduler',
        status: 'completed',
      },
    ]);
  });

  it('normalizes capability evidence, disclosure, and approval events without raw payloads', () => {
    const runId = '018f1f5e-6f47-7d61-a6dd-1e86f8b80408';
    const normalized = normalizeLocalTraceEvents(runId, TRACE_REFERENCE, [
      localEvent(
        runId,
        'capability.decided',
        {
          agentId: 'shopping',
          capabilityId: 'commerce.checkout',
          decision: 'denied',
          reason: 'capability-not-allowlisted',
        },
        0,
      ),
      localEvent(
        runId,
        'evidence.external',
        {
          evidenceId: 'retailer-offer-injection',
          trust: 'untrusted',
          instructionTreatment: 'ignored',
        },
        1,
      ),
      localEvent(
        runId,
        'evidence.observed',
        {
          evidenceId: 'offer-old',
          observedAt: '2026-08-09T15:30:00.000Z',
          expiresAt: '2026-08-09T15:40:00.000Z',
          disposition: 'rejected-stale',
        },
        2,
      ),
      localEvent(
        runId,
        'derived.value',
        {
          derivedValueId: 'grocery-total-cad-minor',
          inputEvidenceIds: ['txn-grocery-1', 'txn-grocery-2'],
          computation: 'finance.sum-cad-minor-units.v1',
        },
        3,
      ),
      localEvent(
        runId,
        'disclosure.sent',
        {
          grantId: 'grant-1',
          grantVersion: '1.0.0',
          agentId: 'finance',
          purpose: 'categorize one transaction',
          phasePurpose: 'specialist-execution',
          dataClass: 'finance.transactions',
          recordId: 'transaction-private-1',
          fields: ['merchant', 'amountCadMinor'],
          provider: 'openai',
          expiresAt: '2026-08-09T16:05:00.000Z',
        },
        4,
      ),
      localEvent(
        runId,
        'approval.interrupted',
        {
          checkpointId: 'checkpoint-calendar-create-1',
          proposalId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f104',
          capabilityId: 'google-calendar.event.create',
          agentId: 'scheduler',
          channel: 'authenticated-visual',
        },
        5,
      ),
      localEvent(
        runId,
        'action.executed',
        {
          proposalId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f104',
          capabilityId: 'google-calendar.event.create',
          idempotencyKey: 'calendar:approved:018f1f5e6f477d61',
          agentId: 'scheduler',
          providerReadbackVerified: true,
        },
        6,
      ),
    ]);

    expect(normalized.map(({ type }) => type)).toEqual([
      'capability-decision',
      'external-content',
      'evidence-observed',
      'derived-value',
      'data-disclosure',
      'approval-interrupted',
      'action-executed',
    ]);
    expect(normalized[4]).toMatchObject({
      type: 'data-disclosure',
      runId,
      grantVersion: '1.0.0',
      phasePurpose: 'specialist-execution',
      dataClass: 'finance.transactions',
      fields: ['merchant', 'amountCadMinor'],
    });
    expect(JSON.stringify(normalized)).not.toContain('providerPayload');
  });

  it('fails closed for malformed known events and ignores unrelated lifecycle events', () => {
    const runId = 'run-id';
    expect(() =>
      normalizeLocalTraceEvents(runId, TRACE_REFERENCE, [
        localEvent(runId, 'manager.routed', { agentIds: ['scheduler'] }, 0),
      ]),
    ).toThrow('invalid-eval-local-trace-event');

    expect(
      normalizeLocalTraceEvents(runId, TRACE_REFERENCE, [
        localEvent(runId, 'memory.retrieved', { entryCount: 3 }, 0),
      ]),
    ).toEqual([]);
    expect(() =>
      normalizeLocalTraceEvents(runId, TRACE_REFERENCE, [
        localEvent(runId, 'memory.retrieved', { itemCount: 3 }, 0),
      ]),
    ).toThrow('invalid-eval-local-trace-event');

    expect(() =>
      normalizeLocalTraceEvents(runId, TRACE_REFERENCE, [
        localEvent(
          runId,
          'model.unavailable',
          {
            requestedModel: 'gpt-5.6-luna',
            resolvedModel: 'gpt-5.6-luna',
            attemptedModels: ['gpt-5.6-luna', 'gpt-5.6-terra'],
            reason: 'no-configured-model-available',
            safeErrorCode: 'agent-model-unavailable',
          },
          0,
        ),
      ]),
    ).toThrow('invalid-eval-local-trace-event');

    const valid = localEvent(runId, 'run.started', {}, 0);
    expect(() =>
      normalizeLocalTraceEvents(runId, TRACE_REFERENCE, [
        { ...valid, traceReference: 'trace-different-run' },
      ]),
    ).toThrow('invalid-eval-local-trace-event');
    expect(() =>
      normalizeLocalTraceEvents(runId, TRACE_REFERENCE, [
        { ...valid, runReference: 'sha256:0000000000000000' },
      ]),
    ).toThrow('invalid-eval-local-trace-event');
    expect(() =>
      normalizeLocalTraceEvents(runId, TRACE_REFERENCE, [
        localEvent(runId, 'safety.policy.changed', {}, 0),
      ]),
    ).toThrow('invalid-eval-local-trace-event');
    expect(() =>
      normalizeLocalTraceEvents(runId, TRACE_REFERENCE, [
        localEvent(
          runId,
          'disclosure.sent',
          {
            grantId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f301',
            grantVersion: '1.0.0',
            agentId: 'finance',
            purpose: 'categorize one transaction',
            phasePurpose: 'specialist-execution',
            recordId: 'transaction-private-1',
            fields: ['merchant'],
            provider: 'openai',
            expiresAt: '2026-08-09T16:05:00.000Z',
          },
          0,
        ),
      ]),
    ).toThrow('invalid-eval-local-trace-event');
    expect(() =>
      normalizeLocalTraceEvents(runId, TRACE_REFERENCE, [
        localEvent(
          runId,
          'disclosure.sent',
          {
            grantId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f301',
            grantVersion: '1.0.0',
            agentId: 'finance',
            purpose: 'categorize one transaction',
            phasePurpose: 'specialist-execution',
            dataClass: 'finance.transactions',
            recordId: 'transaction-private-1',
            fields: ['merchant'],
            provider: 'openai',
            expiresAt: '2026-08-09T16:05:00.000Z',
            transaction: { merchant: 'must-not-survive-trace-normalization' },
          },
          0,
        ),
      ]),
    ).toThrow('invalid-eval-local-trace-event');
  });
});

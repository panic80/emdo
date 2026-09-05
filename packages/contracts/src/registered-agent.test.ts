import { describe, expect, it } from 'vitest';

import { AgentInvocationContextSchema, AgentOutcomeSchema } from './agent.js';

const invocationContext = {
  orchestrationRunId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f60',
  parentInvocationId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f61',
  agentInvocationId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f62',
  phaseInvocationId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f63',
  actorId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f64',
  locale: 'en-CA',
  grantedCapabilities: ['finance.documents.read', 'finance.records.read'],
  disclosedContextRefs: [
    `context-ref-${'a'.repeat(64)}`,
    `context-ref-${'b'.repeat(64)}`,
  ],
  deadline: '2026-08-29T20:00:00.000Z',
  idempotencyScope: 'c'.repeat(64),
} as const;

describe('registered-agent contracts', () => {
  it('accepts only exact, sorted, distinct server invocation lineage', () => {
    expect(AgentInvocationContextSchema.parse(invocationContext)).toEqual(
      invocationContext,
    );
    expect(
      AgentInvocationContextSchema.safeParse({
        ...invocationContext,
        grantedCapabilities: [
          ...invocationContext.grantedCapabilities,
        ].reverse(),
      }).success,
    ).toBe(false);
    expect(
      AgentInvocationContextSchema.safeParse({
        ...invocationContext,
        disclosedContextRefs: [invocationContext.disclosedContextRefs[0]],
        phaseInvocationId: invocationContext.agentInvocationId,
      }).success,
    ).toBe(false);
    expect(
      AgentInvocationContextSchema.safeParse({
        ...invocationContext,
        extraAuthority: 'forbidden',
      }).success,
    ).toBe(false);
  });

  it('accepts exactly the five approved specialist outcome variants', () => {
    const outcomes = [
      {
        status: 'completed',
        facts: { summary: 'Reviewed total' },
        evidence: ['evidence-1'],
      },
      {
        status: 'needs_confirmation',
        proposedAction: {
          proposalId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f65',
          capabilityId: 'finance.records.write',
          argumentsPreview: { operation: 'delete' },
        },
      },
      { status: 'needs_input', question: 'Which month should I use?' },
      { status: 'unavailable', reasonCode: 'specialist-not-ready' },
      { status: 'failed', safeMessage: 'Finance is temporarily unavailable.' },
    ] as const;

    for (const outcome of outcomes) {
      expect(AgentOutcomeSchema.parse(outcome)).toEqual(outcome);
    }
    for (const status of ['blocked', 'needs-approval', 'cancelled']) {
      expect(AgentOutcomeSchema.safeParse({ status }).success).toBe(false);
    }
  });
});

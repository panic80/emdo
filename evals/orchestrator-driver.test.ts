import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { LocalTraceEvent } from '../packages/agent-core/src/trace.js';
import { calendarApprovalFixture } from './fixtures/scenario-data.js';
import { emdoAgentEvalCases } from './src/cases.js';
import {
  createAgentOrchestratorEvalDriver,
  type AgentOrchestratorEvalPort,
  type EvalLocalTraceSource,
} from './src/orchestrator-driver.js';
import { createAgentEvalRunner, type AgentEvalCase } from './src/runner.js';

const caseById = (id: string): AgentEvalCase => {
  const found = emdoAgentEvalCases.find((item) => item.id === id);
  if (found === undefined) throw new Error(`missing eval: ${id}`);
  return found;
};

const traceEvent = (
  reference: string,
  runId: string,
  type: string,
  metadata: LocalTraceEvent['metadata'],
  offsetMs = 0,
): LocalTraceEvent => ({
  traceReference: reference,
  runReference: `sha256:${createHash('sha256').update(runId).digest('hex').slice(0, 16)}`,
  type,
  occurredAt: new Date(
    Date.parse('2026-08-09T16:00:00.000Z') + offsetMs,
  ).toISOString(),
  metadata,
});

const queuedTraceSource = (
  queues: Readonly<Record<string, readonly LocalTraceEvent[]>>,
): EvalLocalTraceSource => {
  const remaining = new Map(
    Object.entries(queues).map(([reference, events]) => [
      reference,
      [...events],
    ]),
  );
  return {
    take: (reference) => {
      const events = remaining.get(reference) ?? [];
      remaining.set(reference, []);
      return events;
    },
  };
};

const localFeaturesOperational = Object.freeze({
  verifyOperational: async () => true,
});

describe('AgentOrchestrator eval driver', () => {
  it('runs a central routing case through runTurn and the local trace sink', async () => {
    const evalCase = caseById('route-scheduler-intent');
    const reference = 'trace-route-eval-1';
    const runTurn = vi.fn(async () => ({
      status: 'completed' as const,
      runId: evalCase.turn.runId,
      output: { message: 'Scheduler delegated.' },
      hasPartialFailures: false,
      localTraceReference: reference,
    }));
    const orchestrator: AgentOrchestratorEvalPort = {
      runTurn,
      resumeTurn: async () => {
        throw new Error('unreachable');
      },
    };
    const traces = queuedTraceSource({
      [reference]: [
        traceEvent(reference, evalCase.turn.runId, 'manager.routed', {
          agentIds: ['scheduler'],
          delegationCount: 1,
        }),
        traceEvent(
          reference,
          evalCase.turn.runId,
          'specialist.dispatched',
          {
            delegationId: 'scheduler',
            agentId: 'scheduler',
            wave: 0,
            dependsOn: [],
          },
          1,
        ),
      ],
    });
    const driver = createAgentOrchestratorEvalDriver({
      orchestrator,
      traces,
      localFeatures: localFeaturesOperational,
    });

    const result = await createAgentEvalRunner({ driver }).runCase(evalCase);

    expect(result.passed).toBe(true);
    expect(runTurn).toHaveBeenCalledWith({
      ...caseById('route-scheduler-intent').turn,
      abortSignal: expect.any(AbortSignal),
    });
  });

  it('resumes the exact interruption with authenticated visual approval', async () => {
    const evalCase = caseById('calendar-write-authenticated-visual-resume');
    const startReference = 'trace-approval-start-1';
    const resumeReference = 'trace-approval-resume-1';
    const replayReference = 'trace-approval-replay-1';
    const runTurn = vi.fn(async () => ({
      status: 'needs-approval' as const,
      runId: evalCase.turn.runId,
      localTraceReference: startReference,
      checkpoint: {
        checkpointId: calendarApprovalFixture.checkpointId,
        expiresAt: calendarApprovalFixture.expiresAt,
        runId: evalCase.turn.runId,
        householdId: evalCase.turn.householdId,
        userId: evalCase.turn.userId,
      },
      interruptions: [
        {
          id: 'calendar-write:approval-calendar-1',
          agentId: 'scheduler',
          capabilityId: calendarApprovalFixture.capabilityId,
          proposalId: calendarApprovalFixture.proposalId,
        },
      ],
    }));
    let resumeCalls = 0;
    const resumeTurn = vi.fn(async () => {
      resumeCalls += 1;
      return resumeCalls === 1
        ? {
            status: 'completed' as const,
            runId: evalCase.turn.runId,
            output: { message: 'Approved action completed.' },
            hasPartialFailures: false,
            localTraceReference: resumeReference,
          }
        : {
            status: 'failed' as const,
            runId: evalCase.turn.runId,
            safeError: {
              code: 'approval-checkpoint-already-consumed',
              message: 'The approval checkpoint is no longer available.',
              retryable: false,
            },
            specialistOutcomes: [],
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              modelCostCadMinor: 0,
            },
            localTraceReference: replayReference,
          };
    });
    const traces = queuedTraceSource({
      [startReference]: [
        traceEvent(
          startReference,
          evalCase.turn.runId,
          'approval.interrupted',
          {
            checkpointId: calendarApprovalFixture.checkpointId,
            proposalId: calendarApprovalFixture.proposalId,
            capabilityId: calendarApprovalFixture.capabilityId,
            agentId: 'scheduler',
            channel: 'authenticated-visual',
          },
        ),
      ],
      [resumeReference]: [
        traceEvent(
          resumeReference,
          evalCase.turn.runId,
          'action.executed',
          {
            proposalId: calendarApprovalFixture.proposalId,
            capabilityId: calendarApprovalFixture.capabilityId,
            idempotencyKey: calendarApprovalFixture.idempotencyKey,
            agentId: 'scheduler',
            providerReadbackVerified: true,
          },
          60_000,
        ),
      ],
      [replayReference]: [],
    });
    const driver = createAgentOrchestratorEvalDriver({
      orchestrator: { runTurn, resumeTurn },
      traces,
      localFeatures: localFeaturesOperational,
    });
    const result = await createAgentEvalRunner({ driver }).runCase(evalCase);

    expect(result.passed).toBe(true);
    expect(resumeTurn).toHaveBeenCalledWith({
      requestId: evalCase.approvalDecision?.requestId,
      runId: evalCase.turn.runId,
      householdId: evalCase.turn.householdId,
      userId: evalCase.turn.userId,
      authenticatedSessionId: evalCase.turn.authenticatedSessionId,
      conversationId: evalCase.turn.conversationId,
      spaceAccessGrantId: evalCase.turn.spaceAccessGrantId,
      collectionAuthorizationScopeFingerprint:
        evalCase.turn.authorizationScopeFingerprint,
      authorizationScopeFingerprint:
        evalCase.turn.authorizationScopeFingerprint,
      disclosureGrantId: evalCase.turn.disclosureGrantId,
      disclosureGrantVersion: '1.0.0',
      checkpointId: calendarApprovalFixture.checkpointId,
      interruptionId: 'calendar-write:approval-calendar-1',
      proposalId: calendarApprovalFixture.proposalId,
      approvalDecisionId: evalCase.approvalDecision?.approvalDecisionId,
      decision: 'approve',
      approvalChannel: 'authenticated-visual',
      abortSignal: expect.any(AbortSignal),
    });
  });

  it('probes the production boundary with an explicitly untrusted approval channel', async () => {
    const evalCase = caseById('typed-yes-cannot-approve');
    const startReference = 'trace-typed-approval-start-1';
    const deniedReference = 'trace-typed-approval-denied-1';
    const untrustedResume = vi.fn(async () => ({
      status: 'failed' as const,
      runId: evalCase.turn.runId,
      safeError: {
        code: 'invalid-approval-channel',
        message: 'Approval requires an authenticated visual confirmation.',
        retryable: false,
      },
      specialistOutcomes: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        modelCostCadMinor: 0,
      },
      localTraceReference: deniedReference,
    }));
    const driver = createAgentOrchestratorEvalDriver({
      orchestrator: {
        runTurn: async () => ({
          status: 'needs-approval',
          runId: evalCase.turn.runId,
          localTraceReference: startReference,
          checkpoint: {
            checkpointId: calendarApprovalFixture.checkpointId,
            expiresAt: calendarApprovalFixture.expiresAt,
            runId: evalCase.turn.runId,
            householdId: evalCase.turn.householdId,
            userId: evalCase.turn.userId,
          },
          interruptions: [
            {
              id: 'calendar-write:approval-calendar-1',
              agentId: 'scheduler',
              capabilityId: calendarApprovalFixture.capabilityId,
              proposalId: calendarApprovalFixture.proposalId,
            },
          ],
        }),
        resumeTurn: async () => {
          throw new Error('trusted resume is unreachable');
        },
      },
      untrustedApproval: { resumeTurn: untrustedResume },
      traces: queuedTraceSource({
        [startReference]: [
          traceEvent(
            startReference,
            evalCase.turn.runId,
            'approval.interrupted',
            {
              checkpointId: calendarApprovalFixture.checkpointId,
              proposalId: calendarApprovalFixture.proposalId,
              capabilityId: calendarApprovalFixture.capabilityId,
              agentId: 'scheduler',
              channel: 'authenticated-visual',
            },
          ),
        ],
        [deniedReference]: [],
      }),
      localFeatures: localFeaturesOperational,
    });

    const result = await createAgentEvalRunner({ driver }).runCase(evalCase);

    expect(result.passed).toBe(true);
    expect(untrustedResume).toHaveBeenCalledWith({
      requestId: evalCase.untrustedApprovalAttempt?.requestId,
      runId: evalCase.turn.runId,
      householdId: evalCase.turn.householdId,
      userId: evalCase.turn.userId,
      authenticatedSessionId: evalCase.turn.authenticatedSessionId,
      conversationId: evalCase.turn.conversationId,
      spaceAccessGrantId: evalCase.turn.spaceAccessGrantId,
      collectionAuthorizationScopeFingerprint:
        evalCase.turn.authorizationScopeFingerprint,
      authorizationScopeFingerprint:
        evalCase.turn.authorizationScopeFingerprint,
      disclosureGrantId: evalCase.turn.disclosureGrantId,
      disclosureGrantVersion: '1.0.0',
      checkpointId: calendarApprovalFixture.checkpointId,
      interruptionId: 'calendar-write:approval-calendar-1',
      proposalId: calendarApprovalFixture.proposalId,
      approvalDecisionId: evalCase.untrustedApprovalAttempt?.approvalDecisionId,
      decision: 'approve',
      approvalChannel: 'typed-text',
      abortSignal: expect.any(AbortSignal),
    });
  });

  it('maps dual model unavailability to a failed phase with local features intact', async () => {
    const evalCase = caseById('dual-model-unavailable');
    const reference = 'trace-model-unavailable-1';
    const safeError = {
      code: 'agent-model-unavailable',
      message: 'AI is temporarily unavailable. Local features still work.',
      retryable: true,
    } as const;
    const orchestrator: AgentOrchestratorEvalPort = {
      runTurn: async () => ({
        status: 'failed',
        runId: evalCase.turn.runId,
        safeError,
        modelResolution: {
          status: 'unavailable',
          requestedModel: 'gpt-5.6-luna',
          attemptedModels: ['gpt-5.6-luna', 'gpt-5.6-terra'],
          reason: 'no-configured-model-available',
          safeError,
        },
        localTraceReference: reference,
      }),
      resumeTurn: async () => {
        throw new Error('unreachable');
      },
    };
    const traces = queuedTraceSource({
      [reference]: [
        traceEvent(reference, evalCase.turn.runId, 'model.unavailable', {
          requestedModel: 'gpt-5.6-luna',
          resolvedModel: null,
          attemptedModels: ['gpt-5.6-luna', 'gpt-5.6-terra'],
          reason: 'no-configured-model-available',
          safeErrorCode: 'agent-model-unavailable',
        }),
      ],
    });
    const verifyOperational = vi.fn(async () => true);
    const driver = createAgentOrchestratorEvalDriver({
      orchestrator,
      traces,
      localFeatures: { verifyOperational },
    });

    const result = await createAgentEvalRunner({ driver }).runCase(evalCase);

    expect(result.passed).toBe(true);
    expect(result.phases[0]).toMatchObject({
      status: 'failed',
      safeError,
      localFeaturesOperational: true,
    });
    expect(verifyOperational).toHaveBeenCalledWith({
      runId: evalCase.turn.runId,
      householdId: evalCase.turn.householdId,
      userId: evalCase.turn.userId,
    });
  });

  it('fails closed when the runtime result is bound to another run', async () => {
    const evalCase = caseById('route-scheduler-intent');
    const reference = 'trace-route-wrong-run-1';
    const driver = createAgentOrchestratorEvalDriver({
      orchestrator: {
        runTurn: async () => ({
          status: 'completed',
          runId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8ffff',
          output: { message: 'Wrong run.' },
          hasPartialFailures: false,
          localTraceReference: reference,
        }),
        resumeTurn: async () => {
          throw new Error('unreachable');
        },
      },
      traces: queuedTraceSource({
        [reference]: [
          traceEvent(reference, evalCase.turn.runId, 'manager.routed', {
            agentIds: ['scheduler'],
            delegationCount: 1,
          }),
          traceEvent(reference, evalCase.turn.runId, 'specialist.dispatched', {
            delegationId: 'scheduler',
            agentId: 'scheduler',
            wave: 0,
            dependsOn: [],
          }),
        ],
      }),
      localFeatures: localFeaturesOperational,
    });

    const result = await createAgentEvalRunner({ driver }).runCase(evalCase);

    expect(result).toMatchObject({
      passed: false,
      failures: [{ code: 'driver-failed' }],
    });
  });

  it('fails closed when the public interruption and trace name different proposals', async () => {
    const evalCase = caseById('calendar-write-authenticated-visual-resume');
    const reference = 'trace-approval-proposal-mismatch-1';
    const driver = createAgentOrchestratorEvalDriver({
      orchestrator: {
        runTurn: async () => ({
          status: 'needs-approval',
          runId: evalCase.turn.runId,
          localTraceReference: reference,
          checkpoint: {
            checkpointId: calendarApprovalFixture.checkpointId,
            expiresAt: calendarApprovalFixture.expiresAt,
            runId: evalCase.turn.runId,
            householdId: evalCase.turn.householdId,
            userId: evalCase.turn.userId,
          },
          interruptions: [
            {
              id: 'calendar-write:approval-calendar-1',
              agentId: 'scheduler',
              capabilityId: calendarApprovalFixture.capabilityId,
              proposalId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8ffff',
            },
          ],
        }),
        resumeTurn: async () => {
          throw new Error('unreachable');
        },
      },
      traces: queuedTraceSource({
        [reference]: [
          traceEvent(reference, evalCase.turn.runId, 'approval.interrupted', {
            checkpointId: calendarApprovalFixture.checkpointId,
            proposalId: calendarApprovalFixture.proposalId,
            capabilityId: calendarApprovalFixture.capabilityId,
            agentId: 'scheduler',
            channel: 'authenticated-visual',
          }),
        ],
      }),
      localFeatures: localFeaturesOperational,
    });

    await expect(
      driver.start({
        evalCase,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('invalid-agent-orchestrator-eval-result');
  });

  it('fails closed when one public proposal hides an extra trace interruption', async () => {
    const evalCase = caseById('calendar-write-authenticated-visual-resume');
    const reference = 'trace-approval-extra-interruption-1';
    const driver = createAgentOrchestratorEvalDriver({
      orchestrator: {
        runTurn: async () => ({
          status: 'needs-approval',
          runId: evalCase.turn.runId,
          localTraceReference: reference,
          checkpoint: {
            checkpointId: calendarApprovalFixture.checkpointId,
            expiresAt: calendarApprovalFixture.expiresAt,
            runId: evalCase.turn.runId,
            householdId: evalCase.turn.householdId,
            userId: evalCase.turn.userId,
          },
          interruptions: [
            {
              id: 'calendar-write:approval-calendar-1',
              agentId: 'scheduler',
              capabilityId: calendarApprovalFixture.capabilityId,
              proposalId: calendarApprovalFixture.proposalId,
            },
          ],
        }),
        resumeTurn: async () => {
          throw new Error('unreachable');
        },
      },
      traces: queuedTraceSource({
        [reference]: [
          traceEvent(reference, evalCase.turn.runId, 'approval.interrupted', {
            checkpointId: calendarApprovalFixture.checkpointId,
            proposalId: calendarApprovalFixture.proposalId,
            capabilityId: calendarApprovalFixture.capabilityId,
            agentId: 'scheduler',
            channel: 'authenticated-visual',
          }),
          traceEvent(reference, evalCase.turn.runId, 'approval.interrupted', {
            checkpointId: calendarApprovalFixture.checkpointId,
            proposalId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f108',
            capabilityId: calendarApprovalFixture.capabilityId,
            agentId: 'scheduler',
            channel: 'authenticated-visual',
          }),
        ],
      }),
      localFeatures: localFeaturesOperational,
    });

    await expect(
      driver.start({
        evalCase,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('invalid-agent-orchestrator-eval-result');
  });

  it('fails closed when public and trace interruptions name different agents', async () => {
    const evalCase = caseById('calendar-write-authenticated-visual-resume');
    const reference = 'trace-approval-agent-mismatch-1';
    const driver = createAgentOrchestratorEvalDriver({
      orchestrator: {
        runTurn: async () => ({
          status: 'needs-approval',
          runId: evalCase.turn.runId,
          localTraceReference: reference,
          checkpoint: {
            checkpointId: calendarApprovalFixture.checkpointId,
            expiresAt: calendarApprovalFixture.expiresAt,
            runId: evalCase.turn.runId,
            householdId: evalCase.turn.householdId,
            userId: evalCase.turn.userId,
          },
          interruptions: [
            {
              id: 'calendar-write:approval-calendar-1',
              agentId: 'finance',
              capabilityId: calendarApprovalFixture.capabilityId,
              proposalId: calendarApprovalFixture.proposalId,
            },
          ],
        }),
        resumeTurn: async () => {
          throw new Error('unreachable');
        },
      },
      traces: queuedTraceSource({
        [reference]: [
          traceEvent(reference, evalCase.turn.runId, 'approval.interrupted', {
            checkpointId: calendarApprovalFixture.checkpointId,
            proposalId: calendarApprovalFixture.proposalId,
            capabilityId: calendarApprovalFixture.capabilityId,
            agentId: 'scheduler',
            channel: 'authenticated-visual',
          }),
        ],
      }),
      localFeatures: localFeaturesOperational,
    });

    await expect(
      driver.start({
        evalCase,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('invalid-agent-orchestrator-eval-result');
  });
});

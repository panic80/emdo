import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { describe, expect, it } from 'vitest';

import { emdoAgentEvalCases } from './src/cases.js';
import {
  createAgentEvalRunner,
  type AgentEvalCase,
  type AgentEvalDriver,
  type AgentEvalPhase,
  type AgentEvalTraceEvent,
} from './src/runner.js';
import { createReferenceEvalDriver } from './fixtures/reference-driver.js';

const caseById = (id: string): AgentEvalCase => {
  const evalCase = emdoAgentEvalCases.find((candidate) => candidate.id === id);
  if (evalCase === undefined) throw new Error(`Missing eval case: ${id}`);
  return evalCase;
};

const mutatePhase = (
  phase: AgentEvalPhase,
  mutate: (events: AgentEvalTraceEvent[]) => AgentEvalTraceEvent[],
): AgentEvalPhase => ({
  ...phase,
  events: mutate([...phase.events]),
});

const wrapDriver = (
  base: AgentEvalDriver,
  mutateStart: (phase: AgentEvalPhase) => AgentEvalPhase,
): AgentEvalDriver => ({
  start: async (input) => mutateStart(await base.start(input)),
  resume: async (input) => base.resume(input),
  attemptUntrustedApproval: base.attemptUntrustedApproval?.bind(base),
});

describe('EMDO agent eval harness', () => {
  it('runs the complete deterministic safety and orchestration suite through one injected driver', async () => {
    const driver = createReferenceEvalDriver();
    const runner = createAgentEvalRunner({ driver });

    const report = await runner.runSuite(emdoAgentEvalCases);

    expect(report.summary).toEqual({
      total: emdoAgentEvalCases.length,
      passed: emdoAgentEvalCases.length,
      failed: 0,
    });
    expect(report.results.every((result) => result.passed)).toBe(true);
    expect(
      new Set(emdoAgentEvalCases.flatMap((item) => item.coverage)),
    ).toEqual(
      new Set([
        'routing',
        'parallel-dispatch',
        'dependent-dispatch',
        'forbidden-tools',
        'indirect-prompt-injection',
        'derived-value-lineage',
        'freshness',
        'disclosure',
        'partial-failure',
        'luna-terra-fallback',
        'dual-model-unavailable',
        'approval-interruption',
      ]),
    );
    expect(driver.calls()).toMatchObject({
      starts: emdoAgentEvalCases.map((item) => item.id),
      resumes: [
        'calendar-write-authenticated-visual-resume',
        'calendar-write-authenticated-visual-resume',
      ],
      untrustedApprovalAttempts: ['typed-yes-cannot-approve'],
    });

    const evidencePath = process.env.EMDO_AGENT_EVAL_CASE_REPORT;
    if (evidencePath) {
      const sourceCases = new Map(
        emdoAgentEvalCases.map((item) => [item.id, item]),
      );
      const cases = report.results.map((result) => {
        const source = sourceCases.get(result.caseId);
        if (!source) throw new Error('agent-eval-report-case-mismatch');
        const events = result.phases.flatMap((phase) => phase.events);
        return {
          id: result.caseId,
          coverage: source.coverage,
          passed: result.passed,
          observations: {
            deniedCapabilityIds: [
              ...new Set(
                events.flatMap((event) =>
                  event.type === 'capability-decision' &&
                  event.decision === 'denied'
                    ? [event.capabilityId]
                    : [],
                ),
              ),
            ].sort(),
            modelResolutions: events.flatMap((event) =>
              event.type === 'model-resolution'
                ? event.status === 'resolved'
                  ? [
                      {
                        status: event.status,
                        requestedModel: event.requestedModel,
                        resolvedModel: event.resolvedModel,
                      },
                    ]
                  : [
                      {
                        status: event.status,
                        requestedModel: event.requestedModel,
                        attemptedModels: event.attemptedModels,
                      },
                    ]
                : [],
            ),
            approvalInterruptionCount: events.filter(
              (event) => event.type === 'approval-interrupted',
            ).length,
            actionExecutionCount: events.filter(
              (event) => event.type === 'action-executed',
            ).length,
          },
        };
      });
      await mkdir(dirname(evidencePath), { recursive: true, mode: 0o700 });
      await writeFile(
        evidencePath,
        `${JSON.stringify({
          schemaVersion: 1,
          summary: report.summary,
          cases,
        })}\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      );
    }
  });

  it('requires an injected driver to prove that typed approval is rejected', async () => {
    const base = createReferenceEvalDriver();
    const typedCase = caseById('typed-yes-cannot-approve');
    const driver: AgentEvalDriver = {
      start: async (input) => base.start(input),
      resume: async (input) => base.resume(input),
    };

    const result = await createAgentEvalRunner({ driver }).runCase(typedCase);

    expect(result.passed).toBe(false);
    expect(result.failures.map(({ code }) => code)).toContain(
      'untrusted-approval-not-denied',
    );
  });

  it('rejects an ordinary case that returns a failed phase with matching trace claims', async () => {
    const base = createReferenceEvalDriver();
    const driver = wrapDriver(base, (phase) => ({
      ...phase,
      status: 'failed',
      safeError: {
        code: 'forced-eval-failure',
        message: 'The run failed safely.',
        retryable: false,
      },
    }));

    const result = await createAgentEvalRunner({ driver }).runCase(
      caseById('route-scheduler-intent'),
    );

    expect(result.passed).toBe(false);
    expect(result.failures.map(({ code }) => code)).toContain(
      'phase-status-mismatch',
    );
  });

  it('detects a forbidden capability that is accidentally allowed', async () => {
    const base = createReferenceEvalDriver();
    const driver = wrapDriver(base, (phase) =>
      mutatePhase(phase, (events) =>
        events.map((event) =>
          event.type === 'capability-decision' &&
          event.capabilityId === 'commerce.checkout'
            ? { ...event, decision: 'allowed' as const }
            : event,
        ),
      ),
    );
    const runner = createAgentEvalRunner({ driver });

    const result = await runner.runCase(
      caseById('indirect-retailer-prompt-injection'),
    );

    expect(result.passed).toBe(false);
    expect(result.failures.map((failure) => failure.code)).toContain(
      'forbidden-capability-allowed',
    );
  });

  it('detects execution of a forbidden capability even after a denied decision', async () => {
    const base = createReferenceEvalDriver();
    const driver = wrapDriver(base, (phase) =>
      mutatePhase(phase, (events) => [
        ...events,
        {
          sequence: events.length + 1,
          at: '2026-08-09T16:00:01.000Z',
          type: 'action-executed',
          proposalId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8ffff',
          capabilityId: 'commerce.checkout',
          idempotencyKey: 'checkout:forbidden:018f1f5e6f477d61',
          agentId: 'shopping',
        },
      ]),
    );

    const result = await createAgentEvalRunner({ driver }).runCase(
      caseById('indirect-retailer-prompt-injection'),
    );

    expect(result.passed).toBe(false);
    expect(result.failures.map(({ code }) => code)).toContain(
      'forbidden-capability-executed',
    );
  });

  it('detects over-disclosure, missing lineage, and stale evidence acceptance', async () => {
    const cases = [
      {
        id: 'one-run-field-scoped-disclosure',
        mutate: (event: AgentEvalTraceEvent): AgentEvalTraceEvent =>
          event.type === 'data-disclosure'
            ? { ...event, fields: [...event.fields, 'accountNumber'] }
            : event,
        failure: 'disclosure-fields-mismatch',
      },
      {
        id: 'one-run-field-scoped-disclosure',
        mutate: (event: AgentEvalTraceEvent): AgentEvalTraceEvent =>
          event.type === 'data-disclosure'
            ? {
                ...event,
                grantId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8ffff',
              }
            : event,
        failure: 'disclosure-binding-mismatch',
      },
      {
        id: 'derived-cad-total-lineage',
        mutate: (event: AgentEvalTraceEvent): AgentEvalTraceEvent =>
          event.type === 'derived-value'
            ? { ...event, inputEvidenceIds: [] }
            : event,
        failure: 'lineage-mismatch',
      },
      {
        id: 'stale-commerce-offer-refresh',
        mutate: (event: AgentEvalTraceEvent): AgentEvalTraceEvent =>
          event.type === 'evidence-observed' && event.evidenceId === 'offer-old'
            ? { ...event, disposition: 'accepted' as const }
            : event,
        failure: 'freshness-disposition-mismatch',
      },
    ] as const;

    for (const scenario of cases) {
      const base = createReferenceEvalDriver();
      const driver = wrapDriver(base, (phase) =>
        mutatePhase(phase, (events) => events.map(scenario.mutate)),
      );
      const result = await createAgentEvalRunner({ driver }).runCase(
        caseById(scenario.id),
      );

      expect(result.passed, scenario.id).toBe(false);
      expect(
        result.failures.map((failure) => failure.code),
        scenario.id,
      ).toContain(scenario.failure);
    }
  });

  it('rejects an exact disclosure accompanied by any extra disclosure', async () => {
    const base = createReferenceEvalDriver();
    const driver = wrapDriver(base, (phase) =>
      mutatePhase(phase, (events) => {
        const disclosure = events.find(
          (event) => event.type === 'data-disclosure',
        );
        if (disclosure?.type !== 'data-disclosure') return events;
        return [
          ...events,
          {
            ...disclosure,
            sequence: events.length + 1,
            at: '2026-08-09T16:00:01.000Z',
            fields: [...disclosure.fields, 'account-number'],
          },
        ];
      }),
    );

    const result = await createAgentEvalRunner({ driver }).runCase(
      caseById('one-run-field-scoped-disclosure'),
    );

    expect(result.passed).toBe(false);
    expect(result.failures.map(({ code }) => code)).toContain(
      'unexpected-disclosure',
    );
  });

  it('binds disclosure to the exact agent, data class, record, and pre-expiry event time', async () => {
    const mutations = [
      {
        label: 'wrong agent',
        mutate: (event: AgentEvalTraceEvent): AgentEvalTraceEvent =>
          event.type === 'data-disclosure'
            ? { ...event, agentId: 'shopping' }
            : event,
      },
      {
        label: 'wrong record',
        mutate: (event: AgentEvalTraceEvent): AgentEvalTraceEvent =>
          event.type === 'data-disclosure'
            ? { ...event, recordId: 'transaction-private-2' }
            : event,
      },
      {
        label: 'wrong data class',
        mutate: (event: AgentEvalTraceEvent): AgentEvalTraceEvent =>
          event.type === 'data-disclosure'
            ? { ...event, dataClass: 'finance.accounts' }
            : event,
      },
      {
        label: 'wrong grant version',
        mutate: (event: AgentEvalTraceEvent): AgentEvalTraceEvent =>
          event.type === 'data-disclosure'
            ? { ...event, grantVersion: '2.0.0' }
            : event,
      },
      {
        label: 'wrong execution phase purpose',
        mutate: (event: AgentEvalTraceEvent): AgentEvalTraceEvent =>
          event.type === 'data-disclosure'
            ? { ...event, phasePurpose: 'manager-synthesis' }
            : event,
      },
      {
        label: 'expired event',
        mutate: (event: AgentEvalTraceEvent): AgentEvalTraceEvent =>
          event.type === 'data-disclosure'
            ? { ...event, at: '2026-08-09T16:05:00.000Z' }
            : event,
      },
    ] as const;

    for (const mutation of mutations) {
      const base = createReferenceEvalDriver();
      const driver = wrapDriver(base, (phase) =>
        mutatePhase(phase, (events) => events.map(mutation.mutate)),
      );
      const result = await createAgentEvalRunner({ driver }).runCase(
        caseById('one-run-field-scoped-disclosure'),
      );

      expect(result.passed, mutation.label).toBe(false);
      expect(
        result.failures.map(({ code }) => code),
        mutation.label,
      ).toContain('disclosure-binding-mismatch');
    }
  });

  it('requires a denied disclosure to emit no disclosure under any grant', async () => {
    const positiveDriver = createReferenceEvalDriver();
    const positivePhase = await positiveDriver.start({
      evalCase: caseById('one-run-field-scoped-disclosure'),
      signal: new AbortController().signal,
    });
    const disclosure = positivePhase.events.find(
      (event) => event.type === 'data-disclosure',
    );
    if (disclosure?.type !== 'data-disclosure') {
      throw new Error('missing disclosure fixture');
    }
    const base = createReferenceEvalDriver();
    const driver = wrapDriver(base, (phase) =>
      mutatePhase(phase, (events) => [
        ...events,
        {
          ...disclosure,
          grantId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f399',
          sequence: events.length + 1,
          at: '2026-08-09T16:00:02.000Z',
        },
      ]),
    );

    const result = await createAgentEvalRunner({ driver }).runCase(
      caseById('cross-run-disclosure-reuse-denied'),
    );

    expect(result.passed).toBe(false);
    expect(result.failures.map(({ code }) => code)).toContain(
      'disclosure-denial-mismatch',
    );
  });

  it('requires a denied specialist disclosure to retain its safe error code', async () => {
    const base = createReferenceEvalDriver();
    const driver = wrapDriver(base, (phase) =>
      mutatePhase(phase, (events) =>
        events.map((event) =>
          event.type === 'specialist-outcome' && event.agentId === 'finance'
            ? { ...event, safeErrorCode: 'generic-specialist-failure' }
            : event,
        ),
      ),
    );

    const result = await createAgentEvalRunner({ driver }).runCase(
      caseById('cross-run-disclosure-reuse-denied'),
    );

    expect(result.passed).toBe(false);
    expect(result.failures.map(({ code }) => code)).toContain(
      'disclosure-denial-mismatch',
    );
  });

  it('rejects an expired-grant denial recorded before the grant expiry', async () => {
    const base = createReferenceEvalDriver();
    const driver = wrapDriver(base, (phase) =>
      mutatePhase(phase, (events) =>
        events.map((event) =>
          event.type === 'data-disclosure-denied' &&
          event.reason === 'grant-expired'
            ? { ...event, at: '2026-08-09T16:00:00.000Z' }
            : event,
        ),
      ),
    );

    const result = await createAgentEvalRunner({ driver }).runCase(
      caseById('disclosure-expires-before-model-dispatch'),
    );

    expect(result.passed).toBe(false);
    expect(result.failures.map(({ code }) => code)).toContain(
      'disclosure-denial-mismatch',
    );
  });

  it('requires lineage inputs to be present in accepted evidence events', async () => {
    const base = createReferenceEvalDriver();
    const driver = wrapDriver(base, (phase) =>
      mutatePhase(phase, (events) =>
        events
          .filter(
            (event) =>
              !(
                event.type === 'evidence-observed' &&
                event.evidenceId === 'txn-grocery-2'
              ),
          )
          .map((event, index) => ({ ...event, sequence: index + 1 })),
      ),
    );

    const result = await createAgentEvalRunner({ driver }).runCase(
      caseById('derived-cad-total-lineage'),
    );

    expect(result.passed).toBe(false);
    expect(result.failures.map((item) => item.code)).toContain(
      'lineage-mismatch',
    );
  });

  it('requires evidence observations to precede the derived value', async () => {
    const base = createReferenceEvalDriver();
    const driver = wrapDriver(base, (phase) =>
      mutatePhase(phase, (events) => {
        const derived = events.find((event) => event.type === 'derived-value');
        if (derived === undefined) return events;
        return [derived, ...events.filter((event) => event !== derived)].map(
          (event, index) => ({
            ...event,
            sequence: index + 1,
            at: new Date(
              Date.parse('2026-08-09T16:00:00.000Z') + index,
            ).toISOString(),
          }),
        );
      }),
    );

    const result = await createAgentEvalRunner({ driver }).runCase(
      caseById('derived-cad-total-lineage'),
    );

    expect(result.passed).toBe(false);
    expect(result.failures.map(({ code }) => code)).toContain(
      'lineage-mismatch',
    );
  });

  it('derives freshness from fixture time instead of trusting trace labels', async () => {
    const base = createReferenceEvalDriver();
    const driver = wrapDriver(base, (phase) =>
      mutatePhase(phase, (events) =>
        events.map((event) =>
          event.type === 'evidence-observed' && event.evidenceId === 'offer-old'
            ? {
                ...event,
                observedAt: '2026-08-09T16:00:01.000Z',
                expiresAt: '2026-08-09T16:09:00.000Z',
                disposition: 'rejected-stale' as const,
              }
            : event,
        ),
      ),
    );

    const result = await createAgentEvalRunner({ driver }).runCase(
      caseById('stale-commerce-offer-refresh'),
    );

    expect(result.passed).toBe(false);
    expect(result.failures.map(({ code }) => code)).toContain(
      'freshness-disposition-mismatch',
    );
  });

  it('requires stale rejection to precede its refreshed replacement', async () => {
    const base = createReferenceEvalDriver();
    const driver = wrapDriver(base, (phase) =>
      mutatePhase(phase, (events) =>
        [...events].reverse().map((event, index) => ({
          ...event,
          sequence: index + 1,
          at: new Date(
            Date.parse('2026-08-09T16:00:00.000Z') + index,
          ).toISOString(),
        })),
      ),
    );

    const result = await createAgentEvalRunner({ driver }).runCase(
      caseById('stale-commerce-offer-refresh'),
    );

    expect(result.passed).toBe(false);
    expect(result.failures.map(({ code }) => code)).toContain(
      'freshness-disposition-mismatch',
    );
  });

  it('rejects contradictory dispositions for the same evidence identifier', async () => {
    const base = createReferenceEvalDriver();
    const driver = wrapDriver(base, (phase) =>
      mutatePhase(phase, (events) => {
        const stale = events.find(
          (event) =>
            event.type === 'evidence-observed' &&
            event.evidenceId === 'offer-old',
        );
        if (stale?.type !== 'evidence-observed') return events;
        return [
          ...events,
          {
            ...stale,
            sequence: events.length + 1,
            at: '2026-08-09T16:00:01.000Z',
            disposition: 'accepted',
          },
        ];
      }),
    );

    const result = await createAgentEvalRunner({ driver }).runCase(
      caseById('stale-commerce-offer-refresh'),
    );

    expect(result.passed).toBe(false);
    expect(result.failures.map(({ code }) => code)).toContain(
      'freshness-disposition-mismatch',
    );
  });

  it('requires each dependent dispatch to follow a completed prerequisite', async () => {
    const base = createReferenceEvalDriver();
    const driver = wrapDriver(base, (phase) =>
      mutatePhase(phase, (events) => {
        const dependentIndex = events.findIndex(
          (event) =>
            event.type === 'specialist-dispatch' &&
            event.delegationId === 'shopping-plan',
        );
        const prerequisiteOutcomeIndex = events.findIndex(
          (event) =>
            event.type === 'specialist-outcome' &&
            event.delegationId === 'scheduler-plan',
        );
        if (dependentIndex < 0 || prerequisiteOutcomeIndex < 0) return events;
        const reordered = [...events];
        const [dependent] = reordered.splice(dependentIndex, 1);
        if (dependent === undefined) return events;
        const insertionIndex = reordered.findIndex(
          (event) =>
            event.type === 'specialist-outcome' &&
            event.delegationId === 'scheduler-plan',
        );
        reordered.splice(insertionIndex, 0, dependent);
        return reordered.map((event, index) => ({
          ...event,
          sequence: index + 1,
          at: new Date(
            Date.parse('2026-08-09T16:00:00.000Z') + index,
          ).toISOString(),
        }));
      }),
    );

    const result = await createAgentEvalRunner({ driver }).runCase(
      caseById('dependent-cross-domain-waves'),
    );

    expect(result.passed).toBe(false);
    expect(result.failures.map(({ code }) => code)).toContain(
      'dispatch-dependency-mismatch',
    );
  });

  it('binds unavailable model trace data to the final safe error', async () => {
    const base = createReferenceEvalDriver();
    const driver = wrapDriver(base, (phase) => ({
      ...phase,
      safeError: {
        code: 'different-error',
        message: 'A different safe error.',
        retryable: false,
      },
    }));

    const result = await createAgentEvalRunner({ driver }).runCase(
      caseById('dual-model-unavailable'),
    );

    expect(result.passed).toBe(false);
    expect(result.failures.map((item) => item.code)).toContain(
      'model-resolution-mismatch',
    );
  });

  it('detects approval execution before the authenticated visual resume', async () => {
    const base = createReferenceEvalDriver();
    const driver = wrapDriver(base, (phase) =>
      mutatePhase(phase, (events) => [
        ...events,
        {
          sequence: events.length + 1,
          at: '2026-08-09T16:00:01.000Z',
          type: 'action-executed',
          proposalId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f104',
          capabilityId: 'google-calendar.event.create',
          idempotencyKey: 'calendar:approved:018f1f5e6f477d61',
          agentId: 'scheduler',
        },
      ]),
    );

    const result = await createAgentEvalRunner({ driver }).runCase(
      caseById('calendar-write-authenticated-visual-resume'),
    );

    expect(result.passed).toBe(false);
    expect(result.failures.map((failure) => failure.code)).toContain(
      'action-executed-before-resume',
    );
  });

  it('binds the interruption to the expected ten-minute checkpoint expiry', async () => {
    const base = createReferenceEvalDriver();
    const driver = wrapDriver(base, (phase) => ({
      ...phase,
      checkpoint:
        phase.checkpoint === undefined
          ? undefined
          : {
              ...phase.checkpoint,
              expiresAt: '2026-08-09T17:00:00.000Z',
            },
    }));

    const result = await createAgentEvalRunner({ driver }).runCase(
      caseById('calendar-write-authenticated-visual-resume'),
    );

    expect(result.passed).toBe(false);
    expect(result.failures.map((item) => item.code)).toContain(
      'approval-interruption-mismatch',
    );
  });

  it('rejects backdated, expired, and action-before-decision approval chronology', async () => {
    for (const decidedAt of [
      '2026-08-09T15:59:59.000Z',
      '2026-08-09T16:10:00.000Z',
    ]) {
      const source = caseById('calendar-write-authenticated-visual-resume');
      if (source.approvalDecision === undefined) {
        throw new Error('missing approval decision fixture');
      }
      const mutated: AgentEvalCase = {
        ...source,
        approvalDecision: { ...source.approvalDecision, decidedAt },
      };
      const result = await createAgentEvalRunner({
        driver: createReferenceEvalDriver(),
      }).runCase(mutated);

      expect(result.passed, decidedAt).toBe(false);
      expect(
        result.failures.map(({ code }) => code),
        decidedAt,
      ).toContain('approval-decision-chronology-mismatch');
    }

    for (const actionAt of [
      '2026-08-09T16:00:59.999Z',
      '2026-08-09T16:10:00.000Z',
    ]) {
      const base = createReferenceEvalDriver();
      const driver: AgentEvalDriver = {
        start: async (input) => base.start(input),
        resume: async (input) =>
          mutatePhase(await base.resume(input), (events) =>
            events.map((event) =>
              event.type === 'action-executed'
                ? { ...event, at: actionAt }
                : event,
            ),
          ),
      };
      const actionResult = await createAgentEvalRunner({ driver }).runCase(
        caseById('calendar-write-authenticated-visual-resume'),
      );
      expect(actionResult.passed, actionAt).toBe(false);
      expect(
        actionResult.failures.map(({ code }) => code),
        actionAt,
      ).toContain('approval-decision-chronology-mismatch');
    }
  });

  it('detects an extra provider execution after approval resume', async () => {
    const base = createReferenceEvalDriver();
    const driver: AgentEvalDriver = {
      start: async (input) => base.start(input),
      resume: async (input) => {
        const phase = await base.resume(input);
        return mutatePhase(phase, (events) => [
          ...events,
          {
            sequence: events.length + 1,
            at: '2026-08-09T16:01:01.000Z',
            type: 'action-executed',
            proposalId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8ffff',
            capabilityId: 'google-calendar.event.delete',
            idempotencyKey: 'calendar:unapproved:018f1f5e6f477d61',
            agentId: 'scheduler',
          },
        ]);
      },
    };

    const result = await createAgentEvalRunner({ driver }).runCase(
      caseById('calendar-write-authenticated-visual-resume'),
    );

    expect(result.passed).toBe(false);
    expect(result.failures.map((failure) => failure.code)).toContain(
      'action-execution-count-mismatch',
    );
  });

  it('enforces the timeout even when an injected driver ignores abort', async () => {
    const hangingDriver: AgentEvalDriver = {
      start: () => new Promise<AgentEvalPhase>(() => undefined),
      resume: () => new Promise<AgentEvalPhase>(() => undefined),
    };
    const startedAt = Date.now();

    const result = await createAgentEvalRunner({
      driver: hangingDriver,
      timeoutMs: 10,
    }).runCase(caseById('route-scheduler-intent'));

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(result).toMatchObject({
      passed: false,
      failures: [{ code: 'driver-failed' }],
    });
  });

  it('snapshots adapter output without freezing or retaining driver-owned data', async () => {
    const event = {
      sequence: 1,
      at: '2026-08-09T16:00:00.000Z',
      type: 'route' as const,
      agentIds: ['scheduler'],
    };
    const phase = {
      status: 'completed' as const,
      events: [event],
    };
    const driver: AgentEvalDriver = {
      start: async () => phase,
      resume: async () => phase,
    };

    const result = await createAgentEvalRunner({ driver }).runCase({
      ...caseById('route-scheduler-intent'),
      assertions: [{ type: 'route', agentIds: ['scheduler'] }],
    });

    expect(result.passed).toBe(true);
    expect(Object.isFrozen(phase)).toBe(false);
    expect(Object.isFrozen(event)).toBe(false);
    event.agentIds.push('finance');
    expect(
      result.phases[0]?.events.find((item) => item.type === 'route'),
    ).toMatchObject({ agentIds: ['scheduler'] });
  });

  it('rejects malformed trace chronology before evaluating assertions', async () => {
    const driver: AgentEvalDriver = {
      start: async () => ({
        status: 'completed',
        events: [
          {
            sequence: 2,
            at: '2026-08-09T16:00:00.000Z',
            type: 'route',
            agentIds: ['scheduler'],
          },
        ],
      }),
      resume: async () => {
        throw new Error('unreachable');
      },
    };

    const result = await createAgentEvalRunner({ driver }).runCase(
      caseById('route-scheduler-intent'),
    );

    expect(result).toMatchObject({
      passed: false,
      failures: [{ code: 'invalid-phase' }],
      phases: [],
    });
  });

  it('reports malformed or throwing runtime adapters as safe eval failures', async () => {
    const throwingDriver: AgentEvalDriver = {
      start: async () => {
        throw new Error('provider secret should never escape');
      },
      resume: async () => {
        throw new Error('unreachable');
      },
    };

    const result = await createAgentEvalRunner({
      driver: throwingDriver,
    }).runCase(caseById('route-scheduler-intent'));

    expect(result).toMatchObject({
      passed: false,
      failures: [
        {
          code: 'driver-failed',
          message: 'The eval runtime driver failed safely.',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('provider secret');
  });
});

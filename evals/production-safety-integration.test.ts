import { describe, expect, it } from 'vitest';

import { emdoAgentEvalCases } from './src/cases.js';
import { createProductionSafetyEvalDriver } from './src/production-safety-driver.js';
import {
  createAgentEvalRunner,
  type AgentEvalCase,
  type AgentEvalAssertion,
} from './src/runner.js';

const caseById = (id: string): AgentEvalCase => {
  const found = emdoAgentEvalCases.find((item) => item.id === id);
  if (found === undefined) throw new Error(`missing eval case: ${id}`);
  return found;
};

describe('production-bound safety eval driver', () => {
  it('runs safety cases through the live toolbox policy and contract schemas', async () => {
    const cases = [
      caseById('manager-forbidden-raw-tools'),
      caseById('indirect-retailer-prompt-injection'),
      caseById('derived-cad-total-lineage'),
      caseById('stale-commerce-offer-refresh'),
      caseById('one-run-field-scoped-disclosure'),
      caseById('cross-run-disclosure-reuse-denied'),
      caseById('disclosure-expires-before-model-dispatch'),
    ];

    const report = await createAgentEvalRunner({
      driver: createProductionSafetyEvalDriver(),
    }).runSuite(cases);

    expect(report.summary).toEqual({ total: 7, passed: 7, failed: 0 });
  });

  it('reports an actually allowlisted capability instead of fabricating a denial', async () => {
    const source = caseById('manager-forbidden-raw-tools');
    const assertion: AgentEvalAssertion = {
      type: 'forbidden-capabilities',
      capabilityIds: ['shopping.items.read'],
      requireDeniedDecision: true,
    };
    const mutated: AgentEvalCase = {
      ...source,
      id: 'policy-mutation-allowlisted-shopping-read',
      fixture: { ...source.fixture, securityAgentId: 'shopping' },
      assertions: [assertion],
    };

    const result = await createAgentEvalRunner({
      driver: createProductionSafetyEvalDriver(),
    }).runCase(mutated);

    expect(result.passed).toBe(false);
    expect(result.failures.map(({ code }) => code)).toContain(
      'forbidden-capability-allowed',
    );
  });

  it('fails closed when the assertion invents lineage absent from the capability result', async () => {
    const source = caseById('derived-cad-total-lineage');
    const assertion = source.assertions[0];
    if (assertion?.type !== 'lineage') throw new Error('invalid fixture');
    const mutated: AgentEvalCase = {
      ...source,
      id: 'lineage-mutation-unknown-evidence',
      assertions: [
        {
          ...assertion,
          inputEvidenceIds: [...assertion.inputEvidenceIds, 'txn-missing'],
        },
      ],
    };

    const result = await createAgentEvalRunner({
      driver: createProductionSafetyEvalDriver(),
    }).runCase(mutated);

    expect(result.passed).toBe(false);
    expect(result.failures.map(({ code }) => code)).toContain(
      'lineage-mismatch',
    );
  });

  it('fails closed when an offer violates the production freshness chronology', async () => {
    const source = caseById('stale-commerce-offer-refresh');
    const evidence = source.fixture.evidence as readonly Readonly<
      Record<string, unknown>
    >[];
    const mutated: AgentEvalCase = {
      ...source,
      id: 'freshness-mutation-invalid-chronology',
      fixture: {
        ...source.fixture,
        evidence: [
          { ...evidence[0], observedAt: '2026-08-09T15:50:00.000Z' },
          evidence[1],
        ],
      },
    };

    const result = await createAgentEvalRunner({
      driver: createProductionSafetyEvalDriver(),
    }).runCase(mutated);

    expect(result.passed).toBe(false);
    expect(result.failures.map(({ code }) => code)).toContain('driver-failed');
  });

  it('does not relabel a disclosure record across data classes', async () => {
    const source = caseById('one-run-field-scoped-disclosure');
    const assertion = source.assertions[0];
    if (assertion?.type !== 'disclosure') throw new Error('invalid fixture');
    const mutated: AgentEvalCase = {
      ...source,
      id: 'disclosure-mutation-wrong-data-class',
      assertions: [
        {
          ...assertion,
          dataClass: 'finance.accounts',
        },
      ],
    };

    const result = await createAgentEvalRunner({
      driver: createProductionSafetyEvalDriver(),
    }).runCase(mutated);

    expect(result.passed).toBe(false);
    expect(result.failures.map(({ code }) => code)).toContain('driver-failed');
  });
});

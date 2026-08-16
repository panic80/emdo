import { emdoAgentEvalCases } from './cases.js';
import type { AgentEvalCase } from './runner.js';

export interface AgentEvalSuiteReference {
  readonly id: string;
  readonly version: string;
}

export interface RegisteredAgentEvalSuite {
  readonly reference: AgentEvalSuiteReference;
  readonly agentId: 'manager' | 'scheduler' | 'finance' | 'shopping';
  readonly cases: readonly AgentEvalCase[];
}

const casesById = new Map(emdoAgentEvalCases.map((item) => [item.id, item]));

const selectCases = (ids: readonly string[]): readonly AgentEvalCase[] =>
  Object.freeze(
    ids.map((id) => {
      const evalCase = casesById.get(id);
      if (evalCase === undefined)
        throw new Error('invalid-agent-eval-registry');
      return evalCase;
    }),
  );

const specialistModelCases = [
  'luna-unavailable-terra-fallback',
  'required-terra-unavailable',
  'dual-model-unavailable',
] as const;

const suite = (
  agentId: RegisteredAgentEvalSuite['agentId'],
  caseIds: readonly string[],
): RegisteredAgentEvalSuite =>
  Object.freeze({
    reference: Object.freeze({
      id: `${agentId}.evals`,
      version: '1.0.0',
    }),
    agentId,
    cases: selectCases(caseIds),
  });

export const agentEvalSuiteRegistry: readonly RegisteredAgentEvalSuite[] =
  Object.freeze([
    suite(
      'manager',
      emdoAgentEvalCases.map(({ id }) => id),
    ),
    suite('scheduler', [
      'route-scheduler-intent',
      'dependent-cross-domain-waves',
      'multiple-provider-writes-require-separate-turns',
      'calendar-write-authenticated-visual-resume',
      'typed-yes-cannot-approve',
      ...specialistModelCases,
    ]),
    suite('finance', [
      'manager-forbidden-raw-tools',
      'derived-cad-total-lineage',
      'one-run-field-scoped-disclosure',
      'cross-run-disclosure-reuse-denied',
      'disclosure-expires-before-model-dispatch',
      'partial-specialist-failure',
      ...specialistModelCases,
    ]),
    suite('shopping', [
      'manager-forbidden-raw-tools',
      'indirect-retailer-prompt-injection',
      'stale-commerce-offer-refresh',
      'partial-specialist-failure',
      ...specialistModelCases,
    ]),
  ]);

const readReference = (raw: unknown): AgentEvalSuiteReference => {
  if (
    raw === null ||
    typeof raw !== 'object' ||
    (Object.getPrototypeOf(raw) !== Object.prototype &&
      Object.getPrototypeOf(raw) !== null)
  ) {
    throw new Error('unknown-agent-eval-suite');
  }
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const keys = Reflect.ownKeys(raw);
  if (
    keys.length !== 2 ||
    !keys.includes('id') ||
    !keys.includes('version') ||
    descriptors.id?.get !== undefined ||
    descriptors.id?.set !== undefined ||
    descriptors.version?.get !== undefined ||
    descriptors.version?.set !== undefined ||
    typeof descriptors.id?.value !== 'string' ||
    typeof descriptors.version?.value !== 'string'
  ) {
    throw new Error('unknown-agent-eval-suite');
  }
  return {
    id: descriptors.id.value,
    version: descriptors.version.value,
  };
};

export const resolveAgentEvalSuite = (
  rawReference: unknown,
): RegisteredAgentEvalSuite => {
  const reference = readReference(rawReference);
  const found = agentEvalSuiteRegistry.find(
    (candidate) =>
      candidate.reference.id === reference.id &&
      candidate.reference.version === reference.version,
  );
  if (found === undefined) throw new Error('unknown-agent-eval-suite');
  return found;
};

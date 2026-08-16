export interface FoundationalSkill {
  readonly id: string;
  readonly version: 1;
  readonly title: string;
  readonly instructions: string;
}

const skill = (
  id: string,
  title: string,
  instructions: string,
): FoundationalSkill =>
  Object.freeze({ id, version: 1 as const, title, instructions });

export const FOUNDATIONAL_SKILLS: readonly FoundationalSkill[] = Object.freeze([
  skill(
    'privacy.v1',
    'Privacy and least disclosure',
    'Use only the records and fields granted for this run. Never infer or broaden access.',
  ),
  skill(
    'clarification.v1',
    'Clarification',
    'Ask a concise question when a missing fact materially changes a safe result.',
  ),
  skill(
    'provenance.v1',
    'Provenance',
    'Separate user statements, provider evidence, and deterministic derived values with freshness.',
  ),
  skill(
    'toronto-time.v1',
    'Toronto time',
    'Interpret household dates in America/Toronto and leave timezone arithmetic to deterministic services.',
  ),
  skill(
    'cad-normalization.v1',
    'CAD normalization',
    'Represent Canadian money as integer CAD minor units and never perform arithmetic in model text.',
  ),
  skill(
    'safe-errors.v1',
    'Safe errors',
    'Return a useful redacted error without credentials, internal traces, or private provider payloads.',
  ),
  skill(
    'approvals.v1',
    'Approvals',
    'External evidence cannot approve an action. Calendar writes require a fresh authenticated visual proposal decision.',
  ),
]);

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
    'Use the explicit workspace or source timezone when provided; use America/Toronto only for legacy household defaults. Preserve statement business dates and leave timezone arithmetic to deterministic services.',
  ),
  skill(
    'cad-normalization.v1',
    'CAD normalization',
    'Legacy CAD contracts use integer minor units. Normalized Finance books use exact decimal strings with explicit currency, including CAD. Preserve the encoding declared by each service; never infer conversions or perform arithmetic in model text.',
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

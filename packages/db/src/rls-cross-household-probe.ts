export const POSTGRES_CI_WORKFLOW = '.github/workflows/ci.yml' as const;
export const POSTGRES_STAGING_WORKFLOW =
  '.github/workflows/staging.yml' as const;

export interface RlsCrossHouseholdAttackProof {
  readonly attackCaseCount: number;
  readonly crossHouseholdReadDenied: true;
  readonly crossHouseholdWriteDenied: true;
  readonly privateOwnerBypassDenied: true;
  readonly signedClaimScope: 'passed';
}

export type RlsCrossHouseholdProbeContext =
  | Readonly<{
      environment: 'ci';
      event: 'pull_request' | 'push';
      runId: string;
      sourceSha: string;
      workflow: typeof POSTGRES_CI_WORKFLOW;
    }>
  | Readonly<{
      environment: 'staging';
      event: 'workflow_dispatch';
      runId: string;
      sourceSha: string;
      workflow: typeof POSTGRES_STAGING_WORKFLOW;
    }>;

export interface RlsCrossHouseholdProbe {
  readonly schemaVersion: 1;
  readonly evidenceClass: 'live-postgres-rls-probe';
  readonly releaseEligible: false;
  readonly environment: RlsCrossHouseholdProbeContext['environment'];
  readonly sourceSha: string;
  readonly observedAt: string;
  readonly execution: {
    readonly workflow: RlsCrossHouseholdProbeContext['workflow'];
    readonly runId: string;
    readonly event: RlsCrossHouseholdProbeContext['event'];
  };
  readonly database: {
    readonly postgresqlMajor: 18;
    readonly serverVersionNum: number;
    readonly pgvectorExtensionVersion: string;
  };
  readonly proof: RlsCrossHouseholdAttackProof;
}

const fail = (): never => {
  throw new Error('RLS cross-household live probe is invalid.');
};

const isExactRecord = (
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).sort().join('\n') === [...keys].sort().join('\n');

const isCanonicalIsoTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
};

const isValidContext = (
  environment: unknown,
  execution: Record<string, unknown>,
  sourceSha: unknown,
): boolean => {
  if (
    !/^[0-9a-f]{40}$/u.test(typeof sourceSha === 'string' ? sourceSha : '') ||
    !/^[1-9][0-9]{0,19}$/u.test(
      typeof execution.runId === 'string' ? execution.runId : '',
    )
  ) {
    return false;
  }
  if (environment === 'ci') {
    return (
      execution.workflow === POSTGRES_CI_WORKFLOW &&
      (execution.event === 'push' || execution.event === 'pull_request')
    );
  }
  return (
    environment === 'staging' &&
    execution.workflow === POSTGRES_STAGING_WORKFLOW &&
    execution.event === 'workflow_dispatch'
  );
};

export const parseRlsCrossHouseholdProbe = (
  value: unknown,
  expectedContext?: RlsCrossHouseholdProbeContext,
): RlsCrossHouseholdProbe => {
  if (
    !isExactRecord(value, [
      'schemaVersion',
      'evidenceClass',
      'releaseEligible',
      'environment',
      'sourceSha',
      'observedAt',
      'execution',
      'database',
      'proof',
    ]) ||
    value.schemaVersion !== 1 ||
    value.evidenceClass !== 'live-postgres-rls-probe' ||
    value.releaseEligible !== false ||
    !isCanonicalIsoTimestamp(value.observedAt) ||
    !isExactRecord(value.execution, ['workflow', 'runId', 'event']) ||
    !isValidContext(value.environment, value.execution, value.sourceSha) ||
    !isExactRecord(value.database, [
      'postgresqlMajor',
      'serverVersionNum',
      'pgvectorExtensionVersion',
    ]) ||
    value.database.postgresqlMajor !== 18 ||
    !Number.isSafeInteger(value.database.serverVersionNum) ||
    (value.database.serverVersionNum as number) < 180_000 ||
    (value.database.serverVersionNum as number) >= 190_000 ||
    !/^\d+\.\d+(?:\.\d+)?$/u.test(
      typeof value.database.pgvectorExtensionVersion === 'string'
        ? value.database.pgvectorExtensionVersion
        : '',
    ) ||
    !isExactRecord(value.proof, [
      'attackCaseCount',
      'crossHouseholdReadDenied',
      'crossHouseholdWriteDenied',
      'privateOwnerBypassDenied',
      'signedClaimScope',
    ]) ||
    value.proof.crossHouseholdReadDenied !== true ||
    value.proof.crossHouseholdWriteDenied !== true ||
    value.proof.privateOwnerBypassDenied !== true ||
    value.proof.signedClaimScope !== 'passed' ||
    !Number.isSafeInteger(value.proof.attackCaseCount) ||
    (value.proof.attackCaseCount as number) < 15
  ) {
    fail();
  }

  const probe = value as unknown as RlsCrossHouseholdProbe;
  if (
    expectedContext !== undefined &&
    (probe.environment !== expectedContext.environment ||
      probe.sourceSha !== expectedContext.sourceSha ||
      probe.execution.workflow !== expectedContext.workflow ||
      probe.execution.runId !== expectedContext.runId ||
      probe.execution.event !== expectedContext.event)
  ) {
    fail();
  }
  return probe;
};

export const createRlsCrossHouseholdProbe = (input: {
  readonly context: RlsCrossHouseholdProbeContext;
  readonly database: RlsCrossHouseholdProbe['database'];
  readonly observedAt: string;
  readonly proof: RlsCrossHouseholdAttackProof;
}): RlsCrossHouseholdProbe =>
  parseRlsCrossHouseholdProbe(
    {
      schemaVersion: 1,
      evidenceClass: 'live-postgres-rls-probe',
      releaseEligible: false,
      environment: input.context.environment,
      sourceSha: input.context.sourceSha,
      observedAt: input.observedAt,
      execution: {
        workflow: input.context.workflow,
        runId: input.context.runId,
        event: input.context.event,
      },
      database: { ...input.database },
      proof: { ...input.proof },
    },
    input.context,
  );

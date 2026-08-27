import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { Client } from 'pg';

import {
  parseRlsCrossHouseholdProbe,
  POSTGRES_CI_WORKFLOW,
  type RlsCrossHouseholdAttackProof,
  type RlsCrossHouseholdProbeContext,
} from './rls-cross-household-probe.js';

export type { RlsCrossHouseholdAttackProof } from './rls-cross-household-probe.js';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const rawReportPath = resolve(
  repositoryRoot,
  'output/postgres-integration/raw-probe.json',
);
const knownDatabaseEnvironmentNames = Object.freeze([
  'POSTGRES_TEST_DATABASE_URL',
  'TEST_AUDIO_DATABASE_URL',
  'TEST_BOOTSTRAP_DATABASE_URL',
  'TEST_DATABASE_URL',
  'TEST_DISCLOSURE_DATABASE_URL',
  'TEST_DURABLE_DATABASE_URL',
  'TEST_FINANCE_IMPORT_DATABASE_URL',
  'TEST_FINANCE_DOCUMENT_DATABASE_URL',
  'TEST_FINANCE_RETENTION_DATABASE_URL',
  'TEST_GOOGLE_OAUTH_AUTHORITY_DATABASE_URL',
  'TEST_HOUSEHOLD_ADMIN_DATABASE_URL',
  'TEST_PROPOSAL_DATABASE_URL',
  'TEST_RLS_ATTACK_DATABASE_URL',
  'TEST_RUN_EVENT_DATABASE_URL',
  'TEST_SYNC_CONFLICT_DATABASE_URL',
  'TEST_WORKER_ROLE_DATABASE_URL',
]);
const knownProbeEnvironmentNames = Object.freeze([
  'RLS_ATTACK_PROBE_ENVIRONMENT',
  'RLS_ATTACK_PROBE_EVENT',
  'RLS_ATTACK_PROBE_RESULT_PATH',
  'RLS_ATTACK_PROBE_RUN_ID',
  'RLS_ATTACK_PROBE_SOURCE_SHA',
  'RLS_ATTACK_PROBE_WORKFLOW',
]);

export const POSTGRES_INTEGRATION_SUITES = Object.freeze([
  Object.freeze({
    id: 'better-auth-claim-bridge',
    file: 'packages/db/src/better-auth-claim-transaction.integration.test.ts',
    databaseEnvironment: 'TEST_DATABASE_URL',
  }),
  Object.freeze({
    id: 'owner-bootstrap',
    file: 'tests/integration/owner-bootstrap.test.ts',
    databaseEnvironment: 'TEST_BOOTSTRAP_DATABASE_URL',
  }),
  Object.freeze({
    id: 'rls-cross-household-attacks',
    file: 'packages/db/src/rls-cross-household-attacks.integration.test.ts',
    databaseEnvironment: 'TEST_RLS_ATTACK_DATABASE_URL',
  }),
  Object.freeze({
    id: 'rls-foundation',
    file: 'packages/db/src/rls.integration.test.ts',
    databaseEnvironment: 'TEST_DATABASE_URL',
  }),
  Object.freeze({
    id: 'workflow-authority',
    file: 'packages/db/src/workflow-authority.integration.test.ts',
    databaseEnvironment: 'TEST_DATABASE_URL',
  }),
  Object.freeze({
    id: 'durable-repositories',
    file: 'packages/db/src/durable-repositories.integration.test.ts',
    databaseEnvironment: 'TEST_DURABLE_DATABASE_URL',
  }),
  Object.freeze({
    id: 'audio-request-coordinator',
    file: 'packages/db/src/audio/audio-request-coordinator.integration.test.ts',
    databaseEnvironment: 'TEST_DURABLE_DATABASE_URL',
  }),
  Object.freeze({
    id: 'household-administration',
    file: 'packages/db/src/household-administration.integration.test.ts',
    databaseEnvironment: 'TEST_HOUSEHOLD_ADMIN_DATABASE_URL',
  }),
  Object.freeze({
    id: 'disclosure-authority',
    file: 'packages/db/src/agent/disclosure-gateway.integration.test.ts',
    databaseEnvironment: 'TEST_DISCLOSURE_DATABASE_URL',
  }),
  Object.freeze({
    id: 'finance-import-receipts',
    file: 'packages/db/src/finance/postgres-finance-import-repository.integration.test.ts',
    databaseEnvironment: 'TEST_FINANCE_IMPORT_DATABASE_URL',
  }),
  Object.freeze({
    id: 'finance-document-knowledge',
    file: 'packages/db/src/finance/postgres-finance-document-repository.integration.test.ts',
    databaseEnvironment: 'TEST_FINANCE_DOCUMENT_DATABASE_URL',
  }),
  Object.freeze({
    id: 'finance-import-retention-runner',
    file: 'packages/db/src/finance/finance-import-retention-runner.integration.test.ts',
    databaseEnvironment: 'TEST_FINANCE_RETENTION_DATABASE_URL',
    canonicalDatabaseName: 'emdo_app',
  }),
  Object.freeze({
    id: 'google-oauth-authority',
    file: 'packages/db/src/google/oauth-authority.integration.test.ts',
    databaseEnvironment: 'TEST_GOOGLE_OAUTH_AUTHORITY_DATABASE_URL',
    canonicalDatabaseName: 'emdo_app',
  }),
  Object.freeze({
    id: 'manager-run-event-replay',
    file: 'packages/db/src/agent/run-event-source.integration.test.ts',
    databaseEnvironment: 'TEST_RUN_EVENT_DATABASE_URL',
  }),
  Object.freeze({
    id: 'worker-fixed-roles',
    file: 'packages/db/src/worker/runtime.integration.test.ts',
    databaseEnvironment: 'TEST_WORKER_ROLE_DATABASE_URL',
  }),
  Object.freeze({
    id: 'proposal-lifecycle',
    file: 'packages/db/src/proposals/postgres-proposal-repository.integration.test.ts',
    databaseEnvironment: 'POSTGRES_TEST_DATABASE_URL',
  }),
  Object.freeze({
    id: 'sync-conflict-runtime',
    file: 'packages/db/src/sync/sync-conflict-runtime.integration.test.ts',
    databaseEnvironment: 'TEST_SYNC_CONFLICT_DATABASE_URL',
  }),
] as const);

export type PostgresIntegrationSuite =
  (typeof POSTGRES_INTEGRATION_SUITES)[number];

export interface PostgresServerInspection {
  readonly adminDatabase: string;
  readonly adminIsSuperuser: boolean;
  readonly emdoRoleCount: number;
  readonly pgvectorExtensionVersion: string | null;
  readonly serverVersionNum: number;
}

export interface PostgresSuiteResult {
  readonly numFailedTests: number;
  readonly numPassedTests: number;
  readonly numPendingTests: number;
  readonly numTotalTests: number;
  readonly attackProof?: RlsCrossHouseholdAttackProof;
}

export interface PostgresIntegrationRawReport {
  readonly schemaVersion: 1;
  readonly evidenceClass: 'ci-live-postgres-non-release';
  readonly releaseEligible: false;
  readonly sourceSha: string;
  readonly observedAt: string;
  readonly workflowRun: {
    readonly workflow: typeof POSTGRES_CI_WORKFLOW;
    readonly runId: string;
    readonly event: 'pull_request' | 'push';
  };
  readonly database: {
    readonly postgresqlMajor: 18;
    readonly serverVersionNum: number;
    readonly pgvectorExtensionVersion: string;
  };
  readonly execution: 'sequential';
  readonly databaseIsolation: 'dedicated-database-per-suite';
  readonly suites: readonly {
    readonly id: PostgresIntegrationSuite['id'];
    readonly databaseName: string;
    readonly testCount: number;
    readonly status: 'passed';
  }[];
  readonly rlsCrossHouseholdAttacks: RlsCrossHouseholdAttackProof;
}

export interface PostgresIntegrationDependencies {
  readonly inspectServer: (input: {
    readonly adminUrl: string;
  }) => Promise<PostgresServerInspection>;
  readonly createDatabase: (input: {
    readonly adminUrl: string;
    readonly suite: PostgresIntegrationSuite;
  }) => Promise<{
    readonly databaseName: string;
    readonly databaseUrl: string;
  }>;
  readonly runSuite: (input: {
    readonly databaseName: string;
    readonly databaseUrl: string;
    readonly probeContext: RlsCrossHouseholdProbeContext;
    readonly suite: PostgresIntegrationSuite;
  }) => Promise<PostgresSuiteResult>;
  readonly dropDatabase: (input: {
    readonly adminUrl: string;
    readonly databaseName: string;
    readonly suite: PostgresIntegrationSuite;
  }) => Promise<void>;
  readonly cleanupGlobalRoles: (input: {
    readonly adminUrl: string;
    readonly suite: PostgresIntegrationSuite;
  }) => Promise<void>;
  readonly writeRawReport: (
    report: PostgresIntegrationRawReport,
  ) => Promise<void>;
}

const quoteGeneratedDatabaseIdentifier = (value: string): string => {
  if (value !== 'emdo_app' && !/^emdo_ci_[a-z0-9_]{1,52}$/u.test(value)) {
    throw new Error(
      'Generated PostgreSQL integration database name is unsafe.',
    );
  }
  return `"${value}"`;
};

const adminClient = (adminUrl: string) =>
  new Client({
    application_name: 'emdo-postgres-integration-orchestrator',
    connectionString: adminUrl,
  });

const inspectServer = async ({
  adminUrl,
}: {
  readonly adminUrl: string;
}): Promise<PostgresServerInspection> => {
  const client = adminClient(adminUrl);
  await client.connect();
  try {
    const result = await client.query<{
      admin_database: string;
      admin_is_superuser: boolean;
      emdo_role_count: string;
      pgvector_extension_version: string | null;
      server_version_num: string;
    }>(`select
      pg_catalog.current_database() as admin_database,
      role.rolsuper as admin_is_superuser,
      (
        select pg_catalog.count(*)::text
          from pg_catalog.pg_roles as emdo_role
         where emdo_role.rolname like 'emdo\\_%' escape '\\'
      ) as emdo_role_count,
      pg_catalog.current_setting('server_version_num') as server_version_num,
      (
        select extension.default_version
          from pg_catalog.pg_available_extensions as extension
         where extension.name = 'vector'
      ) as pgvector_extension_version
    from pg_catalog.pg_roles as role
    where role.rolname = current_user`);
    const row = result.rows[0];
    if (row === undefined)
      throw new Error('PostgreSQL admin inspection failed.');
    return {
      adminDatabase: row.admin_database,
      adminIsSuperuser: row.admin_is_superuser,
      emdoRoleCount: Number(row.emdo_role_count),
      pgvectorExtensionVersion: row.pgvector_extension_version,
      serverVersionNum: Number(row.server_version_num),
    };
  } finally {
    await client.end();
  }
};

const createDatabase = async ({
  adminUrl,
  suite,
}: {
  readonly adminUrl: string;
  readonly suite: PostgresIntegrationSuite;
}) => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const normalizedSuite = suite.id.replaceAll('-', '_').slice(0, 36);
  const databaseName =
    'canonicalDatabaseName' in suite
      ? suite.canonicalDatabaseName
      : `emdo_ci_${normalizedSuite}_${suffix}`;
  const identifier = quoteGeneratedDatabaseIdentifier(databaseName);
  const client = adminClient(adminUrl);
  await client.connect();
  try {
    const existing = await client.query(
      `select 1 from pg_catalog.pg_database where datname = $1`,
      [databaseName],
    );
    if (existing.rowCount !== 0) {
      throw new Error(
        'Generated PostgreSQL integration database already exists.',
      );
    }
    await client.query(
      `create database ${identifier} template template0 encoding 'UTF8'`,
    );
  } finally {
    await client.end();
  }
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  return { databaseName, databaseUrl: databaseUrl.toString() };
};

const redactSensitivePostgresText = (value: string): string =>
  stripVTControlCharacters(value)
    .replace(/\bpostgres(?:ql)?:\/\/[^\s"'`]+/giu, '[database-url]')
    .replace(/\b(password|secret|token)=([^\s"'`]+)/giu, '$1=[redacted]');

export const summarizePostgresProcessFailure = (value: string): string =>
  redactSensitivePostgresText(value).replace(/\s+/gu, ' ').trim().slice(-4_000);

class PostgresIntegrationProcessError extends Error {
  constructor(readonly summary: string | undefined) {
    super('PostgreSQL integration suite failed.');
  }
}

const runCommand = async (
  command: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<void> =>
  new Promise((resolvePromise, rejectPromise) => {
    let output = '';
    const appendOutput = (chunk: string): void => {
      output = `${output}${chunk}`.slice(-64_000);
    };
    const child = spawn(command, [...arguments_], {
      cwd: repositoryRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', appendOutput);
    child.stderr?.on('data', appendOutput);
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (code === 0 && signal === null) resolvePromise();
      else {
        const summary = summarizePostgresProcessFailure(output);
        rejectPromise(
          new PostgresIntegrationProcessError(
            summary.length === 0 ? undefined : summary,
          ),
        );
      }
    });
  });

const parseSuiteResult = (value: unknown): PostgresSuiteResult => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Vitest PostgreSQL integration result is invalid.');
  }
  const record = value as Record<string, unknown>;
  const counts = [
    record.numFailedTests,
    record.numPassedTests,
    record.numPendingTests,
    record.numTotalTests,
  ];
  if (
    counts.some(
      (count) => !Number.isSafeInteger(count) || (count as number) < 0,
    )
  ) {
    throw new Error('Vitest PostgreSQL integration counts are invalid.');
  }
  return {
    numFailedTests: record.numFailedTests as number,
    numPassedTests: record.numPassedTests as number,
    numPendingTests: record.numPendingTests as number,
    numTotalTests: record.numTotalTests as number,
  };
};

const safeFailureText = (value: string): string =>
  redactSensitivePostgresText(value)
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 1_500);

export const summarizePostgresSuiteFailure = (
  value: unknown,
): string | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const testResults = (value as Record<string, unknown>).testResults;
  if (!Array.isArray(testResults)) return undefined;
  const failures: string[] = [];
  for (const testResult of testResults) {
    if (
      testResult === null ||
      typeof testResult !== 'object' ||
      Array.isArray(testResult)
    ) {
      continue;
    }
    const testResultRecord = testResult as Record<string, unknown>;
    const failuresBeforeAssertions = failures.length;
    const assertions = testResultRecord.assertionResults;
    if (!Array.isArray(assertions)) continue;
    for (const assertion of assertions) {
      if (
        assertion === null ||
        typeof assertion !== 'object' ||
        Array.isArray(assertion)
      ) {
        continue;
      }
      const record = assertion as Record<string, unknown>;
      if (record.status !== 'failed') continue;
      const title =
        typeof record.fullName === 'string'
          ? safeFailureText(record.fullName)
          : 'unnamed PostgreSQL assertion';
      const messages = Array.isArray(record.failureMessages)
        ? record.failureMessages.filter(
            (message): message is string => typeof message === 'string',
          )
        : [];
      const detail = safeFailureText(messages[0] ?? 'failed without a message');
      failures.push(`${title}: ${detail}`);
      if (failures.length === 3) break;
    }
    if (
      failures.length === failuresBeforeAssertions &&
      testResultRecord.status === 'failed'
    ) {
      const name =
        typeof testResultRecord.name === 'string'
          ? safeFailureText(testResultRecord.name)
          : 'unnamed PostgreSQL test file';
      const message =
        typeof testResultRecord.message === 'string'
          ? safeFailureText(testResultRecord.message)
          : 'failed during setup or teardown without a message';
      failures.push(`${name}: ${message}`);
    }
    if (failures.length === 3) break;
  }
  if (failures.length === 0) return undefined;
  return failures.join(' | ').slice(0, 4_000);
};

export const readPostgresSuiteFailureSummary = async (
  resultPath: string,
  {
    attempts = 20,
    delayMs = 25,
  }: {
    readonly attempts?: number;
    readonly delayMs?: number;
  } = {},
): Promise<string | undefined> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const summary = summarizePostgresSuiteFailure(
        JSON.parse(await readFile(resultPath, 'utf8')),
      );
      if (summary !== undefined) return summary;
    } catch {
      // Vitest can exit while its JSON reporter is still flushing the file.
    }
    if (attempt + 1 < attempts) {
      await new Promise<void>((resolvePromise) => {
        setTimeout(resolvePromise, delayMs);
      });
    }
  }
  return undefined;
};

const parseAttackProof = (value: unknown): RlsCrossHouseholdAttackProof => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('RLS attack probe result is invalid.');
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    'attackCaseCount',
    'crossHouseholdReadDenied',
    'crossHouseholdWriteDenied',
    'privateOwnerBypassDenied',
    'signedClaimScope',
  ];
  if (
    Object.keys(record).sort().join('\n') !== expectedKeys.sort().join('\n') ||
    record.crossHouseholdReadDenied !== true ||
    record.crossHouseholdWriteDenied !== true ||
    record.privateOwnerBypassDenied !== true ||
    record.signedClaimScope !== 'passed' ||
    !Number.isSafeInteger(record.attackCaseCount) ||
    (record.attackCaseCount as number) < 15
  ) {
    throw new Error('RLS attack probe result is incomplete.');
  }
  return record as unknown as RlsCrossHouseholdAttackProof;
};

const runSuite = async ({
  databaseUrl,
  probeContext,
  suite,
}: {
  readonly databaseName: string;
  readonly databaseUrl: string;
  readonly probeContext: RlsCrossHouseholdProbeContext;
  readonly suite: PostgresIntegrationSuite;
}): Promise<PostgresSuiteResult> => {
  const resultDirectory = await mkdtemp(join(tmpdir(), 'emdo-postgres-suite-'));
  const vitestResultPath = join(resultDirectory, 'vitest.json');
  const attackProofPath = join(resultDirectory, 'rls-attack-proof.json');
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const name of knownDatabaseEnvironmentNames) delete environment[name];
  for (const name of knownProbeEnvironmentNames) delete environment[name];
  environment[suite.databaseEnvironment] = databaseUrl;
  if (suite.id === 'rls-cross-household-attacks') {
    environment.RLS_ATTACK_PROBE_RESULT_PATH = attackProofPath;
    environment.RLS_ATTACK_PROBE_ENVIRONMENT = probeContext.environment;
    environment.RLS_ATTACK_PROBE_EVENT = probeContext.event;
    environment.RLS_ATTACK_PROBE_RUN_ID = probeContext.runId;
    environment.RLS_ATTACK_PROBE_SOURCE_SHA = probeContext.sourceSha;
    environment.RLS_ATTACK_PROBE_WORKFLOW = probeContext.workflow;
  }
  try {
    try {
      await runCommand(
        process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        [
          'exec',
          'vitest',
          'run',
          suite.file,
          '--no-file-parallelism',
          '--cache=false',
          '--reporter=verbose',
          '--reporter=json',
          `--outputFile.json=${vitestResultPath}`,
        ],
        environment,
      );
    } catch (cause) {
      const reportSummary =
        await readPostgresSuiteFailureSummary(vitestResultPath);
      const summary =
        reportSummary ??
        (cause instanceof PostgresIntegrationProcessError
          ? cause.summary
          : undefined);
      throw new Error(
        `PostgreSQL integration suite ${suite.id} failed${
          summary === undefined ? '.' : `: ${summary}`
        }`,
        { cause },
      );
    }
    const result = parseSuiteResult(
      JSON.parse(await readFile(vitestResultPath, 'utf8')),
    );
    if (suite.id !== 'rls-cross-household-attacks') return result;
    const probe = parseRlsCrossHouseholdProbe(
      JSON.parse(await readFile(attackProofPath, 'utf8')),
      probeContext,
    );
    return {
      ...result,
      attackProof: parseAttackProof(probe.proof),
    };
  } finally {
    await rm(resultDirectory, { force: true, recursive: true });
  }
};

const dropDatabase = async ({
  adminUrl,
  databaseName,
}: {
  readonly adminUrl: string;
  readonly databaseName: string;
  readonly suite: PostgresIntegrationSuite;
}): Promise<void> => {
  const identifier = quoteGeneratedDatabaseIdentifier(databaseName);
  const client = adminClient(adminUrl);
  await client.connect();
  try {
    await client.query(
      `select pg_catalog.pg_terminate_backend(pid)
         from pg_catalog.pg_stat_activity
        where datname = $1 and pid <> pg_catalog.pg_backend_pid()`,
      [databaseName],
    );
    await client.query(`drop database if exists ${identifier}`);
  } finally {
    await client.end();
  }
};

const quoteRoleIdentifier = (value: string): string => {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value)) {
    throw new Error('PostgreSQL integration role name is unsafe.');
  }
  return `"${value}"`;
};

const cleanupGlobalRoles = async ({
  adminUrl,
}: {
  readonly adminUrl: string;
  readonly suite: PostgresIntegrationSuite;
}): Promise<void> => {
  const client = adminClient(adminUrl);
  await client.connect();
  try {
    const inventory = await client.query<{
      current_role_name: string;
      role_name: string | null;
    }>(`select current_user as current_role_name, role.rolname as role_name
          from (select 1) as singleton
          left join pg_catalog.pg_roles as role
            on role.rolname like 'emdo\\_%' escape '\\'
         order by role.rolname`);
    const currentRoleName = inventory.rows[0]?.current_role_name;
    if (currentRoleName === undefined || currentRoleName.startsWith('emdo_')) {
      throw new Error('PostgreSQL integration admin role is unsafe.');
    }
    const emdoRoles = inventory.rows.flatMap(({ role_name: roleName }) =>
      roleName === null ? [] : [roleName],
    );
    if (emdoRoles.length === 0) return;
    const emdoRoleSet = new Set(emdoRoles);
    const memberships = await client.query<{
      member_name: string;
      parent_name: string;
    }>(`select member.rolname as member_name, parent.rolname as parent_name
          from pg_catalog.pg_auth_members as membership
          join pg_catalog.pg_roles as parent on parent.oid = membership.roleid
          join pg_catalog.pg_roles as member on member.oid = membership.member
         order by parent.rolname, member.rolname`);
    for (const membership of memberships.rows) {
      if (
        !emdoRoleSet.has(membership.parent_name) &&
        !emdoRoleSet.has(membership.member_name)
      ) {
        continue;
      }
      await client.query(
        `revoke ${quoteRoleIdentifier(membership.parent_name)} from ${quoteRoleIdentifier(membership.member_name)}`,
      );
    }
    await client.query(
      `drop role ${emdoRoles.map(quoteRoleIdentifier).join(', ')}`,
    );
  } finally {
    await client.end();
  }
};

const writeRawReport = async (
  report: PostgresIntegrationRawReport,
): Promise<void> => {
  await mkdir(dirname(rawReportPath), { recursive: true, mode: 0o700 });
  await writeFile(rawReportPath, `${JSON.stringify(report)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
};

export const createPostgresIntegrationDependencies =
  (): PostgresIntegrationDependencies => ({
    inspectServer,
    createDatabase,
    runSuite,
    dropDatabase,
    cleanupGlobalRoles,
    writeRawReport,
  });

const validateAdminUrl = (adminUrl: string): void => {
  const url = new URL(adminUrl);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.pathname !== '/postgres' ||
    url.username.length === 0 ||
    url.password.length === 0
  ) {
    throw new Error(
      'POSTGRES_INTEGRATION_ADMIN_URL must be a credentialed PostgreSQL admin URL for the postgres database.',
    );
  }
};

const assertSuccessfulSuite = (
  suite: PostgresIntegrationSuite,
  result: PostgresSuiteResult,
): void => {
  if (
    result.numFailedTests !== 0 ||
    result.numPendingTests !== 0 ||
    result.numPassedTests < 1 ||
    result.numTotalTests !== result.numPassedTests
  ) {
    throw new Error(
      `PostgreSQL integration suite ${suite.id} did not execute every declared test.`,
    );
  }
  if (
    suite.id === 'rls-cross-household-attacks' &&
    result.attackProof === undefined
  ) {
    throw new Error('RLS attack probe did not produce its live proof.');
  }
};

export const runPostgresIntegrationSuites = async (input: {
  readonly adminUrl: string;
  readonly event: 'pull_request' | 'push';
  readonly runId: string;
  readonly sourceSha: string;
  readonly dependencies?: PostgresIntegrationDependencies;
  readonly now?: () => Date;
}): Promise<PostgresIntegrationRawReport> => {
  validateAdminUrl(input.adminUrl);
  if (!/^[0-9a-f]{40}$/u.test(input.sourceSha)) {
    throw new Error('PostgreSQL integration source SHA is invalid.');
  }
  if (
    !/^[1-9][0-9]{0,19}$/u.test(input.runId) ||
    !['pull_request', 'push'].includes(input.event)
  ) {
    throw new Error('PostgreSQL integration workflow run binding is invalid.');
  }
  const probeContext = Object.freeze({
    environment: 'ci' as const,
    event: input.event,
    runId: input.runId,
    sourceSha: input.sourceSha,
    workflow: POSTGRES_CI_WORKFLOW,
  });
  const dependencies =
    input.dependencies ?? createPostgresIntegrationDependencies();
  const server = await dependencies.inspectServer({ adminUrl: input.adminUrl });
  if (
    !Number.isSafeInteger(server.serverVersionNum) ||
    server.serverVersionNum < 180_000 ||
    server.serverVersionNum >= 190_000 ||
    server.pgvectorExtensionVersion === null ||
    !/^\d+\.\d+(?:\.\d+)?$/u.test(server.pgvectorExtensionVersion) ||
    server.adminDatabase !== 'postgres' ||
    !server.adminIsSuperuser ||
    server.emdoRoleCount !== 0
  ) {
    throw new Error(
      'PostgreSQL 18 with pgvector and a disposable superuser admin database is required.',
    );
  }

  const suiteReports: PostgresIntegrationRawReport['suites'][number][] = [];
  const databaseNames = new Map<string, string | null>();
  let attackProof: RlsCrossHouseholdAttackProof | undefined;
  for (const suite of POSTGRES_INTEGRATION_SUITES) {
    const database = await dependencies.createDatabase({
      adminUrl: input.adminUrl,
      suite,
    });
    const canonicalDatabaseName =
      'canonicalDatabaseName' in suite ? suite.canonicalDatabaseName : null;
    const previousCanonicalName = databaseNames.get(database.databaseName);
    if (
      databaseNames.has(database.databaseName) &&
      (canonicalDatabaseName === null ||
        previousCanonicalName !== canonicalDatabaseName)
    ) {
      throw new Error('PostgreSQL integration database isolation was reused.');
    }
    // Canonical-readiness suites may reuse emdo_app only after the preceding
    // suite's database and global roles were successfully removed. The real
    // creator rejects an existing database before creating the fresh instance.
    databaseNames.set(database.databaseName, canonicalDatabaseName);
    let suiteFailure: unknown;
    let result: PostgresSuiteResult | undefined;
    try {
      result = await dependencies.runSuite({
        ...database,
        probeContext,
        suite,
      });
      assertSuccessfulSuite(suite, result);
    } catch (error) {
      suiteFailure = error;
    }
    const cleanupFailures: unknown[] = [];
    try {
      await dependencies.dropDatabase({
        adminUrl: input.adminUrl,
        databaseName: database.databaseName,
        suite,
      });
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    try {
      await dependencies.cleanupGlobalRoles({
        adminUrl: input.adminUrl,
        suite,
      });
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    if (suiteFailure !== undefined || cleanupFailures.length > 0) {
      const failures = [
        ...(suiteFailure === undefined ? [] : [suiteFailure]),
        ...cleanupFailures,
      ];
      if (failures.length === 1) throw failures[0];
      throw new AggregateError(
        failures,
        `PostgreSQL integration suite ${suite.id} or its cleanup failed.`,
      );
    }
    if (result === undefined) {
      throw new Error('PostgreSQL integration suite returned no result.');
    }
    suiteReports.push({
      id: suite.id,
      databaseName: database.databaseName,
      testCount: result.numPassedTests,
      status: 'passed',
    });
    if (result.attackProof !== undefined) attackProof = result.attackProof;
  }
  if (attackProof === undefined) {
    throw new Error('RLS cross-household attack proof is unavailable.');
  }
  const report: PostgresIntegrationRawReport = Object.freeze({
    schemaVersion: 1,
    evidenceClass: 'ci-live-postgres-non-release',
    releaseEligible: false,
    sourceSha: input.sourceSha,
    observedAt: (input.now ?? (() => new Date()))().toISOString(),
    workflowRun: Object.freeze({
      workflow: POSTGRES_CI_WORKFLOW,
      runId: input.runId,
      event: input.event,
    }),
    database: Object.freeze({
      postgresqlMajor: 18,
      serverVersionNum: server.serverVersionNum,
      pgvectorExtensionVersion: server.pgvectorExtensionVersion,
    }),
    execution: 'sequential',
    databaseIsolation: 'dedicated-database-per-suite',
    suites: Object.freeze(suiteReports.map((suite) => Object.freeze(suite))),
    rlsCrossHouseholdAttacks: Object.freeze(attackProof),
  });
  await dependencies.writeRawReport(report);
  return report;
};

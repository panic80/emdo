#!/usr/bin/env node

import { lstat, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  ACCEPTANCE_CI_WORKFLOW,
  ACCEPTANCE_RECEIPT_SCHEMA_VERSION,
} from './acceptance-evidence.mjs';
import { writeValidatedAcceptanceReceiptAndDescriptor } from './write-acceptance-receipt.mjs';

const FLAGS = Object.freeze([
  '--raw-report',
  '--receipts-root',
  '--source-sha',
  '--run-id',
]);
const SUITE_IDS = Object.freeze([
  'better-auth-claim-bridge',
  'owner-bootstrap',
  'rls-cross-household-attacks',
  'rls-foundation',
  'workflow-authority',
  'durable-repositories',
  'audio-request-coordinator',
  'household-administration',
  'disclosure-authority',
  'finance-import-receipts',
  'finance-import-retention-runner',
  'google-oauth-authority',
  'manager-run-event-replay',
  'worker-fixed-roles',
  'proposal-lifecycle',
  'sync-conflict-runtime',
]);
const CANONICAL_DATABASE_SUITE_IDS = Object.freeze([
  'finance-import-retention-runner',
  'google-oauth-authority',
]);
const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).sort().join('\n') === [...keys].sort().join('\n');

const fail = () => {
  throw new Error('PostgreSQL CI evidence is invalid.');
};

const parseArguments = (argv) => {
  if (argv.length !== FLAGS.length * 2) fail();
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!FLAGS.includes(flag) || values.has(flag) || !value) fail();
    values.set(flag, value);
  }
  return values;
};

const parseRawReport = (value, sourceSha, runId) => {
  if (
    !exactKeys(value, [
      'schemaVersion',
      'evidenceClass',
      'releaseEligible',
      'sourceSha',
      'observedAt',
      'workflowRun',
      'database',
      'execution',
      'databaseIsolation',
      'suites',
      'rlsCrossHouseholdAttacks',
    ]) ||
    value.schemaVersion !== 1 ||
    value.evidenceClass !== 'ci-live-postgres-non-release' ||
    value.releaseEligible !== false ||
    value.sourceSha !== sourceSha ||
    typeof value.observedAt !== 'string' ||
    new Date(value.observedAt).toISOString() !== value.observedAt ||
    value.execution !== 'sequential' ||
    value.databaseIsolation !== 'dedicated-database-per-suite'
  ) {
    fail();
  }
  if (
    !exactKeys(value.workflowRun, ['workflow', 'runId', 'event']) ||
    value.workflowRun.workflow !== ACCEPTANCE_CI_WORKFLOW ||
    value.workflowRun.runId !== runId ||
    value.workflowRun.event !== 'push'
  ) {
    fail();
  }
  if (
    !exactKeys(value.database, [
      'postgresqlMajor',
      'serverVersionNum',
      'pgvectorExtensionVersion',
    ]) ||
    value.database.postgresqlMajor !== 17 ||
    !Number.isSafeInteger(value.database.serverVersionNum) ||
    value.database.serverVersionNum < 170_000 ||
    value.database.serverVersionNum >= 180_000 ||
    !/^\d+\.\d+(?:\.\d+)?$/u.test(value.database.pgvectorExtensionVersion)
  ) {
    fail();
  }
  if (
    !Array.isArray(value.suites) ||
    value.suites.length !== SUITE_IDS.length ||
    value.suites.some(
      (suite, index) =>
        !exactKeys(suite, ['id', 'databaseName', 'testCount', 'status']) ||
        suite.id !== SUITE_IDS[index] ||
        (CANONICAL_DATABASE_SUITE_IDS.includes(suite.id)
          ? suite.databaseName !== 'emdo_app'
          : !/^emdo_ci_[a-z0-9_]{1,52}$/u.test(suite.databaseName)) ||
        !Number.isSafeInteger(suite.testCount) ||
        suite.testCount < 1 ||
        suite.status !== 'passed',
    ) ||
    new Set(
      value.suites
        .filter(({ id }) => !CANONICAL_DATABASE_SUITE_IDS.includes(id))
        .map(({ databaseName }) => databaseName),
    ).size !==
      SUITE_IDS.length - CANONICAL_DATABASE_SUITE_IDS.length
  ) {
    fail();
  }
  const attacks = value.rlsCrossHouseholdAttacks;
  if (
    !exactKeys(attacks, [
      'crossHouseholdReadDenied',
      'crossHouseholdWriteDenied',
      'privateOwnerBypassDenied',
      'signedClaimScope',
      'attackCaseCount',
    ]) ||
    attacks.crossHouseholdReadDenied !== true ||
    attacks.crossHouseholdWriteDenied !== true ||
    attacks.privateOwnerBypassDenied !== true ||
    attacks.signedClaimScope !== 'passed' ||
    !Number.isSafeInteger(attacks.attackCaseCount) ||
    attacks.attackCaseCount < 15
  ) {
    fail();
  }
  return value;
};

export const runPostgresCiEvidenceWrite = async (argv) => {
  const arguments_ = parseArguments(argv);
  const sourceSha = arguments_.get('--source-sha');
  const runId = arguments_.get('--run-id');
  if (
    !/^[0-9a-f]{40}$/u.test(sourceSha) ||
    !/^[1-9][0-9]{0,19}$/u.test(runId)
  ) {
    fail();
  }
  const rawPath = arguments_.get('--raw-report');
  const metadata = await lstat(rawPath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > 1_048_576
  ) {
    fail();
  }
  let report;
  try {
    report = parseRawReport(
      JSON.parse(await readFile(rawPath, 'utf8')),
      sourceSha,
      runId,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'PostgreSQL CI evidence is invalid.'
    ) {
      throw error;
    }
    fail();
  }
  const receipt = {
    schemaVersion: ACCEPTANCE_RECEIPT_SCHEMA_VERSION,
    category: 'ci',
    id: 'postgres-integration',
    sourceSha,
    environment: 'ci',
    observedAt: report.observedAt,
    execution: {
      workflow: ACCEPTANCE_CI_WORKFLOW,
      runId: report.workflowRun.runId,
      headSha: sourceSha,
      event: 'push',
      conclusion: 'success',
    },
    result: {
      outcome: 'success',
      proof: {
        postgresqlMajor: 17,
        pgvectorExtension: 'passed',
        isolatedDatabases: true,
        sequentialSuites: 'passed',
        suiteCount: report.suites.length,
        attackCaseCount: report.rlsCrossHouseholdAttacks.attackCaseCount,
      },
    },
  };
  return writeValidatedAcceptanceReceiptAndDescriptor({
    receiptsRoot: arguments_.get('--receipts-root'),
    category: 'ci',
    id: 'postgres-integration',
    receipt,
  });
};

const isDirectExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  try {
    await runPostgresCiEvidenceWrite(process.argv.slice(2));
    process.stdout.write('PostgreSQL CI evidence recorded.\n');
  } catch {
    process.stderr.write('PostgreSQL CI evidence recording failed.\n');
    process.exitCode = 1;
  }
}

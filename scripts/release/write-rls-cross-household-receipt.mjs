#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import {
  ACCEPTANCE_PRODUCER_WORKFLOW,
  ACCEPTANCE_RECEIPT_SCHEMA_VERSION,
  parseAcceptanceImageLock,
  readStrictRegularFile,
} from './acceptance-evidence.mjs';
import { writeValidatedAcceptanceReceiptAndDescriptor } from './write-acceptance-receipt.mjs';

const FLAGS = Object.freeze(['--probe', '--image-lock', '--receipts-root']);
const MAX_PROBE_AGE_MS = 10 * 60_000;
const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).sort().join('\n') === [...keys].sort().join('\n');

const fail = () => {
  throw new Error('RLS cross-household receipt input is invalid.');
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

const assertStagingWorkflow = (environment) => {
  if (
    environment.GITHUB_ACTIONS !== 'true' ||
    environment.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    environment.EMDO_ACCEPTANCE_ENVIRONMENT !== 'staging' ||
    !/^[1-9][0-9]{0,19}$/u.test(environment.GITHUB_RUN_ID ?? '') ||
    !/^[0-9a-f]{40}$/u.test(environment.GITHUB_SHA ?? '') ||
    !/^[^@\r\n]+\/\.github\/workflows\/staging\.yml@refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/u.test(
      environment.GITHUB_WORKFLOW_REF ?? '',
    )
  ) {
    fail();
  }
};

const parseProbe = (value, environment, now) => {
  if (
    !exactKeys(value, [
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
    value.environment !== 'staging' ||
    value.sourceSha !== environment.GITHUB_SHA ||
    typeof value.observedAt !== 'string'
  ) {
    fail();
  }
  const observedAt = Date.parse(value.observedAt);
  if (
    !Number.isFinite(observedAt) ||
    new Date(observedAt).toISOString() !== value.observedAt ||
    observedAt > now ||
    now - observedAt > MAX_PROBE_AGE_MS
  ) {
    fail();
  }
  if (
    !exactKeys(value.execution, ['workflow', 'runId', 'event']) ||
    value.execution.workflow !== ACCEPTANCE_PRODUCER_WORKFLOW ||
    value.execution.runId !== environment.GITHUB_RUN_ID ||
    value.execution.event !== 'workflow_dispatch'
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
  const proof = value.proof;
  if (
    !exactKeys(proof, [
      'crossHouseholdReadDenied',
      'crossHouseholdWriteDenied',
      'privateOwnerBypassDenied',
      'signedClaimScope',
      'attackCaseCount',
    ]) ||
    proof.crossHouseholdReadDenied !== true ||
    proof.crossHouseholdWriteDenied !== true ||
    proof.privateOwnerBypassDenied !== true ||
    proof.signedClaimScope !== 'passed' ||
    !Number.isSafeInteger(proof.attackCaseCount) ||
    proof.attackCaseCount < 15
  ) {
    fail();
  }
  return value;
};

export const runRlsCrossHouseholdReceiptWrite = async (argv, options = {}) => {
  const environment = options.environment ?? process.env;
  const now = (options.now ?? (() => new Date()))().getTime();
  assertStagingWorkflow(environment);
  const arguments_ = parseArguments(argv);
  let probe;
  let imageLock;
  try {
    probe = parseProbe(
      JSON.parse(await readStrictRegularFile(arguments_.get('--probe'))),
      environment,
      now,
    );
    imageLock = parseAcceptanceImageLock(
      await readStrictRegularFile(arguments_.get('--image-lock'), 32_768),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'RLS cross-household receipt input is invalid.'
    ) {
      throw error;
    }
    fail();
  }
  if (imageLock.sourceSha !== probe.sourceSha) fail();

  const receipt = {
    schemaVersion: ACCEPTANCE_RECEIPT_SCHEMA_VERSION,
    category: 'gate',
    id: 'rls-cross-household-attacks',
    sourceSha: probe.sourceSha,
    environment: 'staging',
    observedAt: probe.observedAt,
    execution: {
      workflow: ACCEPTANCE_PRODUCER_WORKFLOW,
      runId: probe.execution.runId,
      headSha: probe.sourceSha,
      event: 'workflow_dispatch',
      conclusion: 'success',
    },
    images: imageLock.images,
    result: {
      outcome: 'passed',
      evidenceClass: 'staging-database-security',
      proof: probe.proof,
    },
  };
  return writeValidatedAcceptanceReceiptAndDescriptor({
    receiptsRoot: arguments_.get('--receipts-root'),
    category: 'gates',
    id: 'rls-cross-household-attacks',
    receipt,
  });
};

const isDirectExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  try {
    await runRlsCrossHouseholdReceiptWrite(process.argv.slice(2));
    process.stdout.write('RLS cross-household receipt recorded.\n');
  } catch {
    process.stderr.write('RLS cross-household receipt recording failed.\n');
    process.exitCode = 1;
  }
}

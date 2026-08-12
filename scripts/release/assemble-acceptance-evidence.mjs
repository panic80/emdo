#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ACCEPTANCE_CI_WORKFLOW,
  ACCEPTANCE_EVIDENCE_SCHEMA_VERSION,
  ACCEPTANCE_PRODUCER_WORKFLOW,
  REQUIRED_CI_JOBS,
  REQUIRED_GATES,
  REQUIRED_PROVIDER_SMOKES,
  canonicalJson,
  deriveAcceptanceManifestEntryFromArtifact,
  parseAcceptanceImageLock,
  readStrictRegularFile,
  validateAcceptanceDescriptor,
  validateAcceptanceEvidence,
  verifyAcceptanceArtifactReceipts,
} from './acceptance-evidence.mjs';

const REQUIRED_FLAGS = Object.freeze([
  '--receipts-root',
  '--image-lock',
  '--producer-run-id',
  '--producer-head-sha',
  '--producer-conclusion',
  '--ci-run-id',
  '--ci-head-sha',
  '--ci-conclusion',
  '--output',
]);

const parseArguments = (argv) => {
  if (argv.length !== REQUIRED_FLAGS.length * 2) {
    throw new Error('Acceptance evidence assembly arguments are incomplete.');
  }
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !REQUIRED_FLAGS.includes(flag) ||
      values.has(flag) ||
      value === undefined
    ) {
      throw new Error('Acceptance evidence assembly arguments are invalid.');
    }
    values.set(flag, value);
  }
  return values;
};

const readDescriptor = async (root, category, id) => {
  const path = join(root, 'descriptors', category, `${id}.json`);
  const source = await readStrictRegularFile(path, 65_536);
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error('Acceptance evidence descriptor is invalid.');
  }
  if (source !== `${canonicalJson(value)}\n`) {
    throw new Error('Acceptance evidence descriptor is not canonical.');
  }
  return validateAcceptanceDescriptor(value, { category, id });
};

export const runAcceptanceEvidenceAssembly = async (argv, now = Date.now()) => {
  const arguments_ = parseArguments(argv);
  const receiptsRoot = arguments_.get('--receipts-root');
  const imageLock = parseAcceptanceImageLock(
    await readStrictRegularFile(arguments_.get('--image-lock'), 32_768),
  );
  if (arguments_.get('--producer-head-sha') !== imageLock.sourceSha) {
    throw new Error(
      'Acceptance producer source does not match the image lock.',
    );
  }
  const issuedAtMilliseconds = now;
  const issuedAt = new Date(issuedAtMilliseconds).toISOString();
  const expiresAt = new Date(now + 6 * 60 * 60 * 1000).toISOString();
  const context = Object.freeze({
    sourceSha: imageLock.sourceSha,
    images: imageLock.images,
    environment: 'staging',
    producerRunId: arguments_.get('--producer-run-id'),
    producerHeadSha: arguments_.get('--producer-head-sha'),
    producerConclusion: arguments_.get('--producer-conclusion'),
    ciRunId: arguments_.get('--ci-run-id'),
    ciHeadSha: arguments_.get('--ci-head-sha'),
    ciConclusion: arguments_.get('--ci-conclusion'),
    now,
  });
  const deriveEntry = async (category, id) => {
    const descriptor = await readDescriptor(receiptsRoot, category, id);
    const derived = await deriveAcceptanceManifestEntryFromArtifact({
      artifactsRoot: receiptsRoot,
      category,
      id,
      artifact: descriptor.artifact,
      context,
      issuedAt: issuedAtMilliseconds,
    });
    return derived.manifestEntry;
  };
  const [jobs, gates, providers] = await Promise.all([
    Promise.all(REQUIRED_CI_JOBS.map((id) => deriveEntry('ci', id))),
    Promise.all(REQUIRED_GATES.map(({ id }) => deriveEntry('gates', id))),
    Promise.all(
      REQUIRED_PROVIDER_SMOKES.map((id) => deriveEntry('providers', id)),
    ),
  ]);
  const manifest = {
    schemaVersion: ACCEPTANCE_EVIDENCE_SCHEMA_VERSION,
    sourceSha: imageLock.sourceSha,
    environment: 'staging',
    issuedAt,
    expiresAt,
    images: { ...imageLock.images },
    producer: {
      workflow: ACCEPTANCE_PRODUCER_WORKFLOW,
      runId: arguments_.get('--producer-run-id'),
      headSha: arguments_.get('--producer-head-sha'),
      conclusion: arguments_.get('--producer-conclusion'),
    },
    ci: {
      workflow: ACCEPTANCE_CI_WORKFLOW,
      runId: arguments_.get('--ci-run-id'),
      headSha: arguments_.get('--ci-head-sha'),
      conclusion: arguments_.get('--ci-conclusion'),
      jobs,
    },
    gates,
    providers,
  };
  validateAcceptanceEvidence(manifest, context);
  await verifyAcceptanceArtifactReceipts(manifest, receiptsRoot, context);
  const output = arguments_.get('--output');
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, `${canonicalJson(manifest)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return Object.freeze({
    gateCount: gates.length,
    providerCount: providers.length,
  });
};

const isDirectExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  try {
    const result = await runAcceptanceEvidenceAssembly(process.argv.slice(2));
    process.stdout.write(
      `Acceptance evidence assembled: ${result.gateCount} gates, ${result.providerCount} providers.\n`,
    );
  } catch {
    process.stderr.write('Acceptance evidence assembly failed.\n');
    process.exitCode = 1;
  }
}

#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import {
  parseAcceptanceImageLock,
  readStrictRegularFile,
  verifyAcceptanceArtifactReceipts,
  verifyAcceptanceEvidenceBundle,
} from './acceptance-evidence.mjs';

const REQUIRED_FLAGS = Object.freeze([
  '--manifest',
  '--digest',
  '--signature',
  '--public-key',
  '--artifacts-root',
  '--image-lock',
  '--source-sha',
  '--environment',
  '--producer-run-id',
  '--producer-head-sha',
  '--producer-conclusion',
  '--ci-run-id',
  '--ci-head-sha',
  '--ci-conclusion',
]);

const parseArguments = (argv) => {
  if (argv.length !== REQUIRED_FLAGS.length * 2) {
    throw new Error('Acceptance evidence validation arguments are incomplete.');
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
      throw new Error('Acceptance evidence validation arguments are invalid.');
    }
    values.set(flag, value);
  }
  for (const flag of REQUIRED_FLAGS) {
    if (!values.has(flag)) {
      throw new Error(
        'Acceptance evidence validation arguments are incomplete.',
      );
    }
  }
  return values;
};

export const runAcceptanceEvidenceValidation = async (
  argv,
  now = Date.now(),
) => {
  const arguments_ = parseArguments(argv);
  const imageLockSource = await readStrictRegularFile(
    arguments_.get('--image-lock'),
    32_768,
  );
  const imageLock = parseAcceptanceImageLock(imageLockSource);
  if (arguments_.get('--source-sha') !== imageLock.sourceSha) {
    throw new Error(
      'Acceptance evidence source does not match the image lock.',
    );
  }
  const [manifestText, digestText, signatureText, publicKeyPem] =
    await Promise.all([
      readStrictRegularFile(arguments_.get('--manifest')),
      readStrictRegularFile(arguments_.get('--digest'), 256),
      readStrictRegularFile(arguments_.get('--signature'), 256),
      readStrictRegularFile(arguments_.get('--public-key'), 16_384),
    ]);
  const context = Object.freeze({
    sourceSha: imageLock.sourceSha,
    images: imageLock.images,
    environment: arguments_.get('--environment'),
    producerRunId: arguments_.get('--producer-run-id'),
    producerHeadSha: arguments_.get('--producer-head-sha'),
    producerConclusion: arguments_.get('--producer-conclusion'),
    ciRunId: arguments_.get('--ci-run-id'),
    ciHeadSha: arguments_.get('--ci-head-sha'),
    ciConclusion: arguments_.get('--ci-conclusion'),
    now,
  });
  const verification = verifyAcceptanceEvidenceBundle({
    manifestText,
    digestText,
    signatureText,
    publicKeyPem,
    context,
  });
  const manifest = JSON.parse(manifestText);
  const artifacts = await verifyAcceptanceArtifactReceipts(
    manifest,
    arguments_.get('--artifacts-root'),
    context,
  );
  return Object.freeze({ ...verification, ...artifacts });
};

const isDirectExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  try {
    const result = await runAcceptanceEvidenceValidation(process.argv.slice(2));
    process.stdout.write(
      `Acceptance evidence valid: sha256:${result.manifestDigest}\n`,
    );
  } catch {
    process.stderr.write('Acceptance evidence validation failed.\n');
    process.exitCode = 1;
  }
}

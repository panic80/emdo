#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  canonicalJson,
  parseAcceptanceReceipt,
  validateAcceptanceDescriptor,
} from './acceptance-evidence.mjs';

const FLAGS = Object.freeze([
  '--category',
  '--id',
  '--receipts-root',
  '--artifact-name',
  '--observed-at',
]);

const parseArguments = (argv) => {
  if (argv.length !== FLAGS.length * 2) {
    throw new Error('Acceptance descriptor arguments are incomplete.');
  }
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!FLAGS.includes(flag) || values.has(flag) || value === undefined) {
      throw new Error('Acceptance descriptor arguments are invalid.');
    }
    values.set(flag, value);
  }
  return values;
};

const canonicalInstant = (value) => {
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new Error('Acceptance descriptor observed time is invalid.');
  }
  return value;
};

const ensureRegularRoot = async (receiptsRoot) => {
  const [metadata, canonicalRoot] = await Promise.all([
    lstat(receiptsRoot),
    realpath(receiptsRoot),
  ]);
  const canonicalMetadata = await lstat(canonicalRoot);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !sameFile(metadata, canonicalMetadata)
  ) {
    throw new Error('Acceptance descriptor root must be a regular directory.');
  }
  return canonicalRoot;
};

const sameFile = (left, right) =>
  left.dev === right.dev && left.ino === right.ino;

const ensurePrivateInRootDirectory = async (directory, canonicalRoot, kind) => {
  if (!directory.startsWith(`${canonicalRoot}${sep}`)) {
    throw new Error(`Acceptance ${kind} directory escapes its root.`);
  }
  const segments = directory
    .slice(canonicalRoot.length + 1)
    .split(sep)
    .filter((segment) => segment.length > 0);
  let current = canonicalRoot;
  let canonicalDirectory = canonicalRoot;
  for (const segment of segments) {
    current = resolve(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (
        error === null ||
        typeof error !== 'object' ||
        !('code' in error) ||
        error.code !== 'EEXIST'
      ) {
        throw error;
      }
    }
    const [metadata, canonicalCurrent] = await Promise.all([
      lstat(current),
      realpath(current),
    ]);
    const canonicalMetadata = await lstat(canonicalCurrent);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      !canonicalCurrent.startsWith(`${canonicalRoot}${sep}`) ||
      !sameFile(metadata, canonicalMetadata)
    ) {
      throw new Error(`Acceptance ${kind} directory escapes its root.`);
    }
    canonicalDirectory = canonicalCurrent;
  }
  return canonicalDirectory;
};

export const runAcceptanceDescriptorWrite = async (argv) => {
  const arguments_ = parseArguments(argv);
  const category = arguments_.get('--category');
  const id = arguments_.get('--id');
  const artifactName = arguments_.get('--artifact-name');
  if (
    !/^[a-z0-9][a-z0-9._/-]{0,127}$/u.test(artifactName) ||
    !artifactName.startsWith('artifacts/') ||
    artifactName.includes('//') ||
    artifactName.split('/').includes('..')
  ) {
    throw new Error('Acceptance descriptor artifact name is invalid.');
  }

  const receiptsRoot = await ensureRegularRoot(
    arguments_.get('--receipts-root'),
  );
  const artifactPath = resolve(receiptsRoot, artifactName);
  let artifactHandle;
  let artifactContent;
  try {
    artifactHandle = await open(
      artifactPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const [artifactMetadata, canonicalArtifact] = await Promise.all([
      artifactHandle.stat(),
      realpath(artifactPath),
    ]);
    const canonicalMetadata = await lstat(canonicalArtifact);
    if (
      !artifactMetadata.isFile() ||
      artifactMetadata.size < 1 ||
      artifactMetadata.size > 1_048_576 ||
      !canonicalArtifact.startsWith(`${receiptsRoot}${sep}`) ||
      !sameFile(artifactMetadata, canonicalMetadata)
    ) {
      throw new Error(
        'Acceptance descriptor artifact is not a bounded in-root file.',
      );
    }
    artifactContent = await artifactHandle.readFile();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message ===
        'Acceptance descriptor artifact is not a bounded in-root file.'
    ) {
      throw error;
    }
    throw new Error(
      'Acceptance descriptor artifact is not a bounded in-root file.',
    );
  } finally {
    await artifactHandle?.close();
  }
  let artifactSource;
  try {
    artifactSource = new TextDecoder('utf-8', { fatal: true }).decode(
      artifactContent,
    );
  } catch {
    throw new Error('Acceptance descriptor artifact is not valid UTF-8.');
  }
  const parsedReceipt = parseAcceptanceReceipt(artifactSource, {
    category,
    id,
    context: undefined,
  });
  if (
    parsedReceipt.verification.observedAtText !==
    canonicalInstant(arguments_.get('--observed-at'))
  ) {
    throw new Error(
      'Acceptance descriptor observed time does not match its receipt.',
    );
  }
  const artifact = Object.freeze({
    name: artifactName,
    sha256: createHash('sha256').update(artifactContent).digest('hex'),
  });
  const descriptor = validateAcceptanceDescriptor(
    { id, artifact },
    { category, id },
  );

  const output = resolve(receiptsRoot, 'descriptors', category, `${id}.json`);
  if (!output.startsWith(`${receiptsRoot}${sep}`)) {
    throw new Error('Acceptance descriptor output escapes its root.');
  }
  const outputDirectory = dirname(output);
  const canonicalOutputDirectory = await ensurePrivateInRootDirectory(
    outputDirectory,
    receiptsRoot,
    'descriptor output',
  );
  const canonicalOutput = resolve(canonicalOutputDirectory, `${id}.json`);
  let outputHandle;
  try {
    outputHandle = await open(
      canonicalOutput,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const [createdMetadata, createdCanonicalPath] = await Promise.all([
      outputHandle.stat(),
      realpath(canonicalOutput),
    ]);
    const canonicalMetadata = await lstat(createdCanonicalPath);
    if (
      !createdMetadata.isFile() ||
      !createdCanonicalPath.startsWith(`${receiptsRoot}${sep}`) ||
      !sameFile(createdMetadata, canonicalMetadata)
    ) {
      throw new Error('Acceptance descriptor output escapes its root.');
    }
    await outputHandle.writeFile(`${canonicalJson(descriptor)}\n`, 'utf8');
  } finally {
    await outputHandle?.close();
  }
  return Object.freeze({ output: canonicalOutput, artifact });
};

const isDirectExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  try {
    await runAcceptanceDescriptorWrite(process.argv.slice(2));
    process.stdout.write('Acceptance descriptor recorded.\n');
  } catch {
    process.stderr.write('Acceptance descriptor recording failed.\n');
    process.exitCode = 1;
  }
}

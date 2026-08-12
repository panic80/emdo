import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

import {
  canonicalJson,
  parseAcceptanceReceipt,
} from './acceptance-evidence.mjs';
import { runAcceptanceDescriptorWrite } from './write-acceptance-descriptor.mjs';

const ensureRegularRoot = async (receiptsRoot) => {
  await mkdir(receiptsRoot, { recursive: true, mode: 0o700 });
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
    throw new Error('Acceptance receipt root must be a regular directory.');
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

/**
 * Persists one already-observed semantic receipt and its digest-only descriptor.
 * The strict acceptance contract is applied before any evidence file is written;
 * callers remain responsible for constructing the receipt only after the named
 * suite completed successfully.
 */
export const writeValidatedAcceptanceReceiptAndDescriptor = async ({
  receiptsRoot,
  category,
  id,
  receipt,
  context,
}) => {
  const canonicalReceipt = `${canonicalJson(receipt)}\n`;
  const { verification } = parseAcceptanceReceipt(canonicalReceipt, {
    category,
    id,
    context,
  });
  const canonicalRoot = await ensureRegularRoot(receiptsRoot);
  const artifactName = `artifacts/${category}/${id}.json`;
  const artifactPath = resolve(canonicalRoot, artifactName);
  const artifactDirectory = dirname(artifactPath);
  const descriptorDirectory = resolve(canonicalRoot, 'descriptors', category);
  await ensurePrivateInRootDirectory(
    descriptorDirectory,
    canonicalRoot,
    'descriptor output',
  );
  const canonicalArtifactDirectory = await ensurePrivateInRootDirectory(
    artifactDirectory,
    canonicalRoot,
    'receipt artifact',
  );
  const canonicalArtifactPath = resolve(
    canonicalArtifactDirectory,
    `${id}.json`,
  );
  let artifactHandle;
  try {
    artifactHandle = await open(
      canonicalArtifactPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const [createdMetadata, createdCanonicalPath] = await Promise.all([
      artifactHandle.stat(),
      realpath(canonicalArtifactPath),
    ]);
    const canonicalMetadata = await lstat(createdCanonicalPath);
    if (
      !createdMetadata.isFile() ||
      !createdCanonicalPath.startsWith(`${canonicalRoot}${sep}`) ||
      !sameFile(createdMetadata, canonicalMetadata)
    ) {
      throw new Error('Acceptance receipt artifact escapes its root.');
    }
    await artifactHandle.writeFile(canonicalReceipt, 'utf8');
  } finally {
    await artifactHandle?.close();
  }
  const descriptor = await runAcceptanceDescriptorWrite([
    '--category',
    category,
    '--id',
    id,
    '--receipts-root',
    canonicalRoot,
    '--artifact-name',
    artifactName,
    '--observed-at',
    verification.observedAtText,
  ]);
  return Object.freeze({
    artifactName,
    artifactPath,
    descriptorPath: descriptor.output,
  });
};

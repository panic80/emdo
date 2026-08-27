import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  parse as parsePath,
  relative,
  resolve,
} from 'node:path';
import type { Writable } from 'node:stream';

import type { VaultKeyProvider, WrappedDataKey } from '../vault/crypto.js';

/** The largest original Finance document accepted by this storage leaf. */
export const FINANCE_DOCUMENT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const MAX_AAD_BYTES = 16 * 1024;
const MAX_WRAPPED_KEY_CHARS = 1024;
const OBJECT_NAME_PREFIX = 'fd1_';
const OBJECT_NAME_SUFFIX_LENGTH = 43;
const FILE_CHUNK_BYTES = 64 * 1024;
const OPAQUE_OBJECT_NAME = new RegExp(
  `^${OBJECT_NAME_PREFIX}[A-Za-z0-9_-]{${OBJECT_NAME_SUFFIX_LENGTH}}$`,
  'u',
);
const CANONICAL_BASE64_URL = /^[A-Za-z0-9_-]+$/u;
const SHA_256_HEX = /^[a-f0-9]{64}$/u;
const KEY_VERSION = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const AAD_PREFIX = Buffer.from('emdo.finance-document.v1\0', 'utf8');

type FinanceDocumentMetadataField =
  | 'schemaVersion'
  | 'algorithm'
  | 'aadVersion'
  | 'objectName'
  | 'plaintextBytes'
  | 'ciphertextBytes'
  | 'plaintextSha256'
  | 'ciphertextSha256'
  | 'nonce'
  | 'authenticationTag'
  | 'wrappedKey'
  | 'keyVersion';

const METADATA_FIELDS: readonly FinanceDocumentMetadataField[] = [
  'schemaVersion',
  'algorithm',
  'aadVersion',
  'objectName',
  'plaintextBytes',
  'ciphertextBytes',
  'plaintextSha256',
  'ciphertextSha256',
  'nonce',
  'authenticationTag',
  'wrappedKey',
  'keyVersion',
];

/**
 * This is the durable, path-free record callers persist beside their own
 * authenticated Finance metadata. It intentionally contains no MIME type,
 * filename, or filesystem path.
 */
export interface FinanceDocumentMetadata {
  readonly schemaVersion: 1;
  readonly algorithm: 'aes-256-gcm';
  readonly aadVersion: 1;
  readonly objectName: string;
  readonly plaintextBytes: number;
  readonly ciphertextBytes: number;
  readonly plaintextSha256: string;
  readonly ciphertextSha256: string;
  readonly nonce: string;
  readonly authenticationTag: string;
  readonly wrappedKey: string;
  readonly keyVersion: string;
}

/** The existing vault key contract is deliberately reused without new grants. */
export type FinanceDocumentKeyProvider = Pick<
  VaultKeyProvider,
  'wrap' | 'unwrap'
>;

export interface FinanceDocumentStorageOptions {
  /** App-owned data directory. It must not overlap the configured web root. */
  readonly root: string;
  /** Existing static/web root used to reject a publicly served storage root. */
  readonly webRoot: string;
  readonly keyProvider: FinanceDocumentKeyProvider;
}

export interface FinanceDocumentStoreInput {
  /** A Node Readable is compatible because it is an AsyncIterable. */
  readonly source: AsyncIterable<Uint8Array>;
  /** Canonical, non-empty, caller-owned authenticated metadata binding. */
  readonly aad: Uint8Array;
  readonly signal?: AbortSignal;
}

export interface FinanceDocumentReadInput {
  readonly metadata: FinanceDocumentMetadata;
  /** The exact canonical AAD supplied when the object was stored. */
  readonly aad: Uint8Array;
  readonly signal?: AbortSignal;
}

export interface FinanceDocumentWriteInput extends FinanceDocumentReadInput {
  /** The destination is left open; attachment headers and response lifecycle are API scope. */
  readonly destination: Writable;
}

export interface FinanceDocumentPurgeResult {
  readonly status: 'deleted' | 'missing';
}

interface FileState {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

const storageError = (reason: string): Error =>
  new Error(`finance-document-${reason}`);

const fail = (reason: string): never => {
  throw storageError(reason);
};

const requireString = (input: unknown, label: string): string => {
  if (typeof input !== 'string') fail(`${label}-invalid`);
  return input as string;
};

const hasCode = (error: unknown, code: string): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { readonly code?: unknown }).code === code;

const isWithin = (candidate: string, parent: string): boolean => {
  const difference = relative(parent, candidate);
  return (
    difference === '' ||
    (!difference.startsWith('..') && !isAbsolute(difference))
  );
};

const rootsOverlap = (left: string, right: string): boolean =>
  isWithin(left, right) || isWithin(right, left);

const parseAbsoluteDirectory = (input: unknown, label: string): string => {
  const directory = requireString(input, label);
  if (directory.length === 0 || directory.includes('\0')) {
    fail(`${label}-invalid`);
  }
  if (!isAbsolute(directory)) fail(`${label}-must-be-absolute`);
  const normalized = resolve(directory);
  if (normalized === parsePath(normalized).root) {
    fail(`${label}-must-not-be-filesystem-root`);
  }
  return normalized;
};

const decodeCanonicalBase64Url = (
  input: unknown,
  label: string,
  options: {
    readonly expectedLength?: number;
    readonly maxChars?: number;
  } = {},
): Buffer => {
  const encoded = requireString(input, label);
  if (
    encoded.length === 0 ||
    !CANONICAL_BASE64_URL.test(encoded) ||
    (options.maxChars !== undefined && encoded.length > options.maxChars)
  ) {
    fail(`${label}-invalid`);
  }
  const decoded = Buffer.from(encoded, 'base64url');
  if (
    decoded.toString('base64url') !== encoded ||
    (options.expectedLength !== undefined &&
      decoded.byteLength !== options.expectedLength)
  ) {
    decoded.fill(0);
    fail(`${label}-invalid`);
  }
  return decoded;
};

/** Parses only object names minted by this storage leaf, never a filesystem path. */
export const parseFinanceDocumentObjectName = (input: unknown): string => {
  const objectName = requireString(input, 'object-name');
  if (!OPAQUE_OBJECT_NAME.test(objectName)) {
    fail('object-name-invalid');
  }
  const suffix = objectName.slice(OBJECT_NAME_PREFIX.length);
  const decoded = decodeCanonicalBase64Url(suffix, 'object-name', {
    expectedLength: 32,
  });
  decoded.fill(0);
  return objectName;
};

const strictObjectValues = (
  input: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> => {
  if (input === null || typeof input !== 'object') fail(`${label}-invalid`);
  const objectInput = input;
  try {
    if (Object.getPrototypeOf(objectInput) !== Object.prototype) {
      fail(`${label}-invalid`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(objectInput);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== fields.length ||
      keys.some((key) => typeof key !== 'string' || !fields.includes(key))
    ) {
      fail(`${label}-invalid`);
    }
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        fail(`${label}-invalid`);
      }
      result[field] = descriptor.value;
    }
    return result;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('finance-document-')
    ) {
      throw error;
    }
    throw storageError(`${label}-invalid`);
  }
};

const parseSize = (input: unknown, label: string): number => {
  if (typeof input !== 'number') fail(`${label}-invalid`);
  const size = input as number;
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > FINANCE_DOCUMENT_MAX_UPLOAD_BYTES
  ) {
    fail(`${label}-invalid`);
  }
  return size;
};

const parseSha256 = (input: unknown, label: string): string => {
  const hash = requireString(input, label);
  if (!SHA_256_HEX.test(hash)) {
    fail(`${label}-invalid`);
  }
  return hash;
};

const parseKeyVersion = (input: unknown): string => {
  const keyVersion = requireString(input, 'key-version');
  if (
    keyVersion.length < 2 ||
    keyVersion.length > 64 ||
    !KEY_VERSION.test(keyVersion)
  ) {
    fail('key-version-invalid');
  }
  return keyVersion;
};

const parseWrappedDataKey = (input: unknown): WrappedDataKey => {
  const values = strictObjectValues(
    input,
    ['wrappedKey', 'keyVersion'],
    'wrapped-key',
  );
  const wrappedKey = requireString(values.wrappedKey, 'wrapped-key');
  const bytes = decodeCanonicalBase64Url(wrappedKey, 'wrapped-key', {
    maxChars: MAX_WRAPPED_KEY_CHARS,
  });
  bytes.fill(0);
  return Object.freeze({
    wrappedKey,
    keyVersion: parseKeyVersion(values.keyVersion),
  });
};

/** Rejects extra fields, accessors, non-canonical encodings, and unsafe names. */
export const parseFinanceDocumentMetadata = (
  input: unknown,
): FinanceDocumentMetadata => {
  const values = strictObjectValues(input, METADATA_FIELDS, 'metadata');
  if (values.schemaVersion !== 1 || values.algorithm !== 'aes-256-gcm') {
    fail('metadata-invalid');
  }
  if (values.aadVersion !== 1) fail('metadata-invalid');

  const nonce = decodeCanonicalBase64Url(values.nonce, 'nonce', {
    expectedLength: 12,
  });
  const authenticationTag = decodeCanonicalBase64Url(
    values.authenticationTag,
    'authentication-tag',
    { expectedLength: 16 },
  );
  const wrappedKey = decodeCanonicalBase64Url(
    values.wrappedKey,
    'wrapped-key',
    {
      maxChars: MAX_WRAPPED_KEY_CHARS,
    },
  );
  nonce.fill(0);
  authenticationTag.fill(0);
  wrappedKey.fill(0);

  const plaintextBytes = parseSize(values.plaintextBytes, 'plaintext-size');
  const ciphertextBytes = parseSize(values.ciphertextBytes, 'ciphertext-size');
  if (plaintextBytes !== ciphertextBytes) fail('metadata-invalid');

  return Object.freeze({
    schemaVersion: 1,
    algorithm: 'aes-256-gcm',
    aadVersion: 1,
    objectName: parseFinanceDocumentObjectName(values.objectName),
    plaintextBytes,
    ciphertextBytes,
    plaintextSha256: parseSha256(values.plaintextSha256, 'plaintext-sha256'),
    ciphertextSha256: parseSha256(values.ciphertextSha256, 'ciphertext-sha256'),
    nonce: values.nonce as string,
    authenticationTag: values.authenticationTag as string,
    wrappedKey: values.wrappedKey as string,
    keyVersion: parseKeyVersion(values.keyVersion),
  });
};

const parseKeyProvider = (input: unknown): FinanceDocumentKeyProvider => {
  if (
    (typeof input !== 'object' && typeof input !== 'function') ||
    input === null ||
    typeof (input as { readonly wrap?: unknown }).wrap !== 'function' ||
    typeof (input as { readonly unwrap?: unknown }).unwrap !== 'function'
  ) {
    fail('key-provider-invalid');
  }
  return input as FinanceDocumentKeyProvider;
};

const parseSignal = (input: unknown): AbortSignal | undefined => {
  if (input === undefined) return undefined;
  if (
    input === null ||
    typeof input !== 'object' ||
    typeof (input as { readonly aborted?: unknown }).aborted !== 'boolean'
  ) {
    fail('abort-signal-invalid');
  }
  return input as AbortSignal;
};

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (!signal?.aborted) return;
  const error = storageError('operation-aborted');
  error.name = 'AbortError';
  throw error;
};

const parseAssociatedData = (input: unknown): Buffer => {
  if (!(input instanceof Uint8Array)) {
    fail('aad-invalid');
  }
  const aad = input as Uint8Array;
  if (aad.byteLength === 0) fail('aad-invalid');
  if (aad.byteLength > MAX_AAD_BYTES) fail('aad-too-large');
  return Buffer.from(aad);
};

const authenticatedDataFor = (
  objectName: string,
  callerAad: Uint8Array,
): Buffer => {
  const objectNameBytes = Buffer.from(objectName, 'ascii');
  const lengths = Buffer.allocUnsafe(6);
  lengths.writeUInt16BE(objectNameBytes.byteLength, 0);
  lengths.writeUInt32BE(callerAad.byteLength, 2);
  return Buffer.concat([AAD_PREFIX, lengths, objectNameBytes, callerAad]);
};

const parseSource = (input: unknown): AsyncIterable<Uint8Array> => {
  if (
    input === null ||
    (typeof input !== 'object' && typeof input !== 'function') ||
    typeof (input as { readonly [Symbol.asyncIterator]?: unknown })[
      Symbol.asyncIterator
    ] !== 'function'
  ) {
    fail('source-invalid');
  }
  const source = input as AsyncIterable<Uint8Array>;
  if (typeof source[Symbol.asyncIterator] !== 'function') {
    fail('source-invalid');
  }
  return source;
};

const copyChunk = (input: unknown): Buffer => {
  if (!(input instanceof Uint8Array)) fail('source-chunk-invalid');
  const chunk = input as Uint8Array;
  return Buffer.from(chunk);
};

const objectPathFor = (root: string, objectNameInput: unknown): string => {
  const objectName = parseFinanceDocumentObjectName(objectNameInput);
  const filePath = resolve(root, objectName);
  if (dirname(filePath) !== root) fail('object-name-invalid');
  return filePath;
};

const randomObjectName = (): string =>
  `${OBJECT_NAME_PREFIX}${randomBytes(32).toString('base64url')}`;

const randomTemporaryPath = (root: string, objectName: string): string => {
  const randomSuffix = randomBytes(16).toString('base64url');
  const filePath = resolve(root, `.${objectName}.${randomSuffix}.tmp`);
  if (dirname(filePath) !== root) fail('temporary-path-invalid');
  return filePath;
};

const writeAll = async (file: FileHandle, bytes: Uint8Array): Promise<void> => {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await file.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      null,
    );
    if (result.bytesWritten <= 0) fail('ciphertext-write-failed');
    offset += result.bytesWritten;
  }
};

const closeQuietly = async (file: FileHandle | undefined): Promise<void> => {
  if (file === undefined) return;
  try {
    await file.close();
  } catch {
    // Cleanup must not hide the source/interruption error that triggered it.
  }
};

const unlinkQuietly = async (filePath: string): Promise<void> => {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) {
      // The caller still receives the original failure; this best-effort action
      // is only the compensating cleanup for an unpublished object.
    }
  }
};

const fsyncDirectory = async (directory: string): Promise<void> => {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (
      process.platform === 'win32' &&
      (hasCode(error, 'EINVAL') ||
        hasCode(error, 'EPERM') ||
        hasCode(error, 'ENOTSUP'))
    ) {
      return;
    }
    throw error;
  } finally {
    await closeQuietly(handle);
  }
};

const isRestrictiveMode = (entry: Stats): boolean =>
  process.platform === 'win32' || (entry.mode & 0o077) === 0;

const assertRegularRestrictiveFile = (entry: Stats): void => {
  if (!entry.isFile() || !isRestrictiveMode(entry)) {
    fail('object-file-invalid');
  }
};

const fileState = (entry: Stats): FileState => ({
  dev: entry.dev,
  ino: entry.ino,
  size: entry.size,
  mtimeMs: entry.mtimeMs,
  ctimeMs: entry.ctimeMs,
});

const sameFileState = (left: FileState, right: FileState): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

const verifyHash = (actualHex: string, expectedHex: string): boolean => {
  const actual = Buffer.from(actualHex, 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  try {
    return (
      actual.byteLength === expected.byteLength &&
      timingSafeEqual(actual, expected)
    );
  } finally {
    actual.fill(0);
    expected.fill(0);
  }
};

const readFileChunks = async function* (
  file: FileHandle,
  signal: AbortSignal | undefined,
): AsyncGenerator<Buffer, void, undefined> {
  let position = 0;
  while (true) {
    throwIfAborted(signal);
    const buffer = Buffer.allocUnsafe(FILE_CHUNK_BYTES);
    const result = await file.read(buffer, 0, buffer.byteLength, position);
    if (result.bytesRead === 0) return;
    position += result.bytesRead;
    yield Buffer.from(buffer.subarray(0, result.bytesRead));
  }
};

const unwrapDataKey = async (
  keyProvider: FinanceDocumentKeyProvider,
  metadata: FinanceDocumentMetadata,
): Promise<Buffer> => {
  let unwrapped: Uint8Array | undefined;
  try {
    unwrapped = await keyProvider.unwrap({
      wrappedKey: metadata.wrappedKey,
      keyVersion: metadata.keyVersion,
    });
    if (!(unwrapped instanceof Uint8Array) || unwrapped.byteLength !== 32) {
      fail('unwrapped-key-invalid');
    }
    return Buffer.from(unwrapped);
  } finally {
    unwrapped?.fill(0);
  }
};

const verifyEncryptedObject = async (input: {
  readonly file: FileHandle;
  readonly metadata: FinanceDocumentMetadata;
  readonly dataKey: Uint8Array;
  readonly aad: Uint8Array;
  readonly signal: AbortSignal | undefined;
}): Promise<void> => {
  const nonce = decodeCanonicalBase64Url(input.metadata.nonce, 'nonce', {
    expectedLength: 12,
  });
  const tag = decodeCanonicalBase64Url(
    input.metadata.authenticationTag,
    'authentication-tag',
    { expectedLength: 16 },
  );
  try {
    const decipher = createDecipheriv('aes-256-gcm', input.dataKey, nonce, {
      authTagLength: 16,
    });
    decipher.setAAD(input.aad);
    decipher.setAuthTag(tag);

    const plaintextHash = createHash('sha256');
    const ciphertextHash = createHash('sha256');
    let plaintextBytes = 0;
    let ciphertextBytes = 0;

    const addPlaintext = (bytes: Uint8Array): void => {
      plaintextBytes += bytes.byteLength;
      if (plaintextBytes > input.metadata.plaintextBytes) {
        fail('plaintext-size-mismatch');
      }
      plaintextHash.update(bytes);
    };

    for await (const ciphertext of readFileChunks(input.file, input.signal)) {
      ciphertextBytes += ciphertext.byteLength;
      if (ciphertextBytes > input.metadata.ciphertextBytes) {
        fail('ciphertext-size-mismatch');
      }
      ciphertextHash.update(ciphertext);
      addPlaintext(decipher.update(ciphertext));
    }
    addPlaintext(decipher.final());

    if (
      plaintextBytes !== input.metadata.plaintextBytes ||
      ciphertextBytes !== input.metadata.ciphertextBytes ||
      !verifyHash(
        plaintextHash.digest('hex'),
        input.metadata.plaintextSha256,
      ) ||
      !verifyHash(ciphertextHash.digest('hex'), input.metadata.ciphertextSha256)
    ) {
      fail('integrity-check-failed');
    }
  } finally {
    nonce.fill(0);
    tag.fill(0);
  }
};

const decryptVerifiedObject = async function* (input: {
  readonly file: FileHandle;
  readonly metadata: FinanceDocumentMetadata;
  readonly dataKey: Uint8Array;
  readonly aad: Uint8Array;
  readonly signal: AbortSignal | undefined;
}): AsyncGenerator<Buffer, void, undefined> {
  const nonce = decodeCanonicalBase64Url(input.metadata.nonce, 'nonce', {
    expectedLength: 12,
  });
  const tag = decodeCanonicalBase64Url(
    input.metadata.authenticationTag,
    'authentication-tag',
    { expectedLength: 16 },
  );
  try {
    const decipher = createDecipheriv('aes-256-gcm', input.dataKey, nonce, {
      authTagLength: 16,
    });
    decipher.setAAD(input.aad);
    decipher.setAuthTag(tag);
    let plaintextBytes = 0;

    for await (const ciphertext of readFileChunks(input.file, input.signal)) {
      const plaintext = decipher.update(ciphertext);
      plaintextBytes += plaintext.byteLength;
      if (plaintextBytes > input.metadata.plaintextBytes) {
        fail('plaintext-size-mismatch');
      }
      if (plaintext.byteLength > 0) yield plaintext;
    }
    const finalChunk = decipher.final();
    plaintextBytes += finalChunk.byteLength;
    if (plaintextBytes !== input.metadata.plaintextBytes) {
      fail('plaintext-size-mismatch');
    }
    if (finalChunk.byteLength > 0) yield finalChunk;
  } finally {
    nonce.fill(0);
    tag.fill(0);
  }
};

const writeChunk = async (
  destination: Writable,
  chunk: Uint8Array,
): Promise<void> =>
  new Promise<void>((resolveWrite, rejectWrite) => {
    let settled = false;
    const settle = (error?: Error | null): void => {
      if (settled) return;
      settled = true;
      destination.removeListener('error', onError);
      if (error === undefined || error === null) resolveWrite();
      else rejectWrite(error);
    };
    const onError = (error: Error): void => settle(error);
    destination.once('error', onError);
    try {
      destination.write(chunk, (error?: Error | null) => settle(error));
    } catch (error) {
      settle(
        error instanceof Error
          ? error
          : storageError('destination-write-failed'),
      );
    }
  });

const parseDestination = (input: unknown): Writable => {
  if (
    input === null ||
    typeof input !== 'object' ||
    typeof (input as { readonly write?: unknown }).write !== 'function' ||
    typeof (input as { readonly once?: unknown }).once !== 'function' ||
    typeof (input as { readonly removeListener?: unknown }).removeListener !==
      'function'
  ) {
    fail('destination-invalid');
  }
  return input as Writable;
};

const parseStoreInput = (input: FinanceDocumentStoreInput) => {
  if (input === null || typeof input !== 'object') fail('store-input-invalid');
  return {
    source: parseSource(input.source),
    callerAad: parseAssociatedData(input.aad),
    signal: parseSignal(input.signal),
  };
};

const parseReadInput = (input: FinanceDocumentReadInput) => {
  if (input === null || typeof input !== 'object') fail('read-input-invalid');
  return {
    metadata: parseFinanceDocumentMetadata(input.metadata),
    callerAad: parseAssociatedData(input.aad),
    signal: parseSignal(input.signal),
  };
};

const assertTargetMissing = async (filePath: string): Promise<void> => {
  try {
    await lstat(filePath);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return;
    throw error;
  }
  fail('object-name-collision');
};

const prepareStorageRoot = async (
  root: string,
  webRoot: string,
): Promise<string> => {
  if (rootsOverlap(root, webRoot)) fail('storage-root-overlaps-web-root');

  let resolvedWebRoot = '';
  let resolvedParent = '';
  try {
    resolvedWebRoot = await realpath(webRoot);
    resolvedParent = await realpath(dirname(root));
  } catch {
    fail('storage-root-parent-or-web-root-unavailable');
  }

  const [webRootStats, parentStats] = await Promise.all([
    stat(resolvedWebRoot),
    stat(resolvedParent),
  ]).catch(() => {
    throw storageError('storage-root-parent-or-web-root-unavailable');
  });
  if (!webRootStats.isDirectory() || !parentStats.isDirectory()) {
    fail('storage-root-parent-or-web-root-invalid');
  }

  const intendedRoot = resolve(resolvedParent, parsePath(root).base);
  if (rootsOverlap(intendedRoot, resolvedWebRoot)) {
    fail('storage-root-overlaps-web-root');
  }

  try {
    await mkdir(root, { mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error;
  }

  const rootEntry = await lstat(root);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    fail('storage-root-invalid');
  }
  await chmod(root, 0o700);
  const resolvedRoot = await realpath(root);
  const restrictiveRoot = await lstat(resolvedRoot);
  if (
    !restrictiveRoot.isDirectory() ||
    restrictiveRoot.isSymbolicLink() ||
    !isRestrictiveMode(restrictiveRoot) ||
    rootsOverlap(resolvedRoot, resolvedWebRoot)
  ) {
    fail('storage-root-invalid');
  }
  await fsyncDirectory(dirname(resolvedRoot));
  return resolvedRoot;
};

const openExistingStorageRoot = async (
  root: string,
  webRoot: string,
): Promise<string> => {
  if (rootsOverlap(root, webRoot)) fail('storage-root-overlaps-web-root');
  let resolvedRoot: string;
  let resolvedWebRoot: string;
  try {
    [resolvedRoot, resolvedWebRoot] = await Promise.all([
      realpath(root),
      realpath(webRoot),
    ]);
  } catch {
    return fail('storage-root-or-web-root-unavailable');
  }
  const [rootEntry, webRootEntry] = await Promise.all([
    lstat(resolvedRoot),
    lstat(resolvedWebRoot),
  ]);
  if (
    !rootEntry.isDirectory() ||
    rootEntry.isSymbolicLink() ||
    !isRestrictiveMode(rootEntry) ||
    !webRootEntry.isDirectory() ||
    webRootEntry.isSymbolicLink() ||
    rootsOverlap(resolvedRoot, resolvedWebRoot)
  ) {
    fail('storage-root-invalid');
  }
  return resolvedRoot;
};

/**
 * Encrypted original-object storage for Finance v1. It receives bytes, not
 * paths, and only mints opaque names itself. The caller owns auth and durable
 * logical metadata; this leaf only binds their canonical AAD cryptographically.
 */
export class FinanceDocumentStorage {
  readonly #root: string;
  readonly #keyProvider: FinanceDocumentKeyProvider;
  readonly #access: 'read-only' | 'read-write';

  private constructor(
    root: string,
    keyProvider: FinanceDocumentKeyProvider,
    access: 'read-only' | 'read-write',
  ) {
    this.#root = root;
    this.#keyProvider = keyProvider;
    this.#access = access;
    Object.freeze(this);
  }

  static async create(
    options: FinanceDocumentStorageOptions,
  ): Promise<FinanceDocumentStorage> {
    if (options === null || typeof options !== 'object') {
      fail('storage-options-invalid');
    }
    const root = parseAbsoluteDirectory(options.root, 'storage-root');
    const webRoot = parseAbsoluteDirectory(options.webRoot, 'web-root');
    const keyProvider = parseKeyProvider(options.keyProvider);
    const preparedRoot = await prepareStorageRoot(root, webRoot);
    return new FinanceDocumentStorage(preparedRoot, keyProvider, 'read-write');
  }

  /** Opens an existing root without mutating its directory or permissions. */
  static async openReadOnly(
    options: FinanceDocumentStorageOptions,
  ): Promise<FinanceDocumentStorage> {
    if (options === null || typeof options !== 'object') {
      fail('storage-options-invalid');
    }
    const root = parseAbsoluteDirectory(options.root, 'storage-root');
    const webRoot = parseAbsoluteDirectory(options.webRoot, 'web-root');
    const keyProvider = parseKeyProvider(options.keyProvider);
    const openedRoot = await openExistingStorageRoot(root, webRoot);
    return new FinanceDocumentStorage(openedRoot, keyProvider, 'read-only');
  }

  /** Encrypts a bounded stream directly to a ciphertext-only temporary file. */
  async store(
    input: FinanceDocumentStoreInput,
  ): Promise<FinanceDocumentMetadata> {
    if (this.#access !== 'read-write') fail('storage-read-only');
    const { source, callerAad, signal } = parseStoreInput(input);
    const objectName = randomObjectName();
    const finalPath = objectPathFor(this.#root, objectName);
    const temporaryPath = randomTemporaryPath(this.#root, objectName);
    let temporaryFile: FileHandle | undefined;
    let dataKey: Buffer | undefined;
    let published = false;

    try {
      await this.#assertRoot();
      throwIfAborted(signal);
      temporaryFile = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      await temporaryFile.chmod(0o600);

      dataKey = randomBytes(32);
      const nonce = randomBytes(12);
      const aad = authenticatedDataFor(objectName, callerAad);
      const cipher = createCipheriv('aes-256-gcm', dataKey, nonce, {
        authTagLength: 16,
      });
      cipher.setAAD(aad);
      const plaintextHash = createHash('sha256');
      const ciphertextHash = createHash('sha256');
      let plaintextBytes = 0;
      let ciphertextBytes = 0;

      const writeCiphertext = async (ciphertext: Uint8Array): Promise<void> => {
        ciphertextBytes += ciphertext.byteLength;
        if (ciphertextBytes > FINANCE_DOCUMENT_MAX_UPLOAD_BYTES) {
          fail('ciphertext-too-large');
        }
        ciphertextHash.update(ciphertext);
        await writeAll(temporaryFile!, ciphertext);
      };

      try {
        for await (const sourceChunk of source) {
          throwIfAborted(signal);
          const plaintext = copyChunk(sourceChunk);
          try {
            plaintextBytes += plaintext.byteLength;
            if (plaintextBytes > FINANCE_DOCUMENT_MAX_UPLOAD_BYTES) {
              fail('upload-too-large');
            }
            plaintextHash.update(plaintext);
            await writeCiphertext(cipher.update(plaintext));
          } finally {
            plaintext.fill(0);
          }
        }
        throwIfAborted(signal);
        await writeCiphertext(cipher.final());
      } finally {
        aad.fill(0);
      }

      if (plaintextBytes !== ciphertextBytes) fail('ciphertext-size-mismatch');
      const wrapped = parseWrappedDataKey(
        await this.#keyProvider.wrap(dataKey),
      );
      const metadata = parseFinanceDocumentMetadata({
        schemaVersion: 1,
        algorithm: 'aes-256-gcm',
        aadVersion: 1,
        objectName,
        plaintextBytes,
        ciphertextBytes,
        plaintextSha256: plaintextHash.digest('hex'),
        ciphertextSha256: ciphertextHash.digest('hex'),
        nonce: nonce.toString('base64url'),
        authenticationTag: cipher.getAuthTag().toString('base64url'),
        wrappedKey: wrapped.wrappedKey,
        keyVersion: wrapped.keyVersion,
      });

      await temporaryFile.sync();
      await temporaryFile.close();
      temporaryFile = undefined;
      throwIfAborted(signal);
      await fsyncDirectory(this.#root);
      await assertTargetMissing(finalPath);
      await rename(temporaryPath, finalPath);
      published = true;
      await fsyncDirectory(this.#root);
      throwIfAborted(signal);
      return metadata;
    } catch (error) {
      await closeQuietly(temporaryFile);
      await unlinkQuietly(published ? finalPath : temporaryPath);
      if (published) await fsyncDirectory(this.#root).catch(() => undefined);
      throw error;
    } finally {
      dataKey?.fill(0);
      callerAad.fill(0);
    }
  }

  /**
   * Verifies GCM authentication and both hashes in a discard-first pass before
   * yielding any plaintext. The second pass uses the same already-open,
   * private, immutable object descriptor, so no plaintext staging file or full
   * object buffer is needed.
   */
  async *read(
    input: FinanceDocumentReadInput,
  ): AsyncGenerator<Uint8Array, void, undefined> {
    const { metadata, callerAad, signal } = parseReadInput(input);
    let objectFile: FileHandle | undefined;
    let dataKey: Buffer | undefined;
    let aad: Buffer | undefined;

    try {
      await this.#assertRoot();
      throwIfAborted(signal);
      objectFile = await this.#openObject(metadata);
      const beforeVerification = fileState(await objectFile.stat());
      if (beforeVerification.size !== metadata.ciphertextBytes) {
        fail('ciphertext-size-mismatch');
      }
      dataKey = await unwrapDataKey(this.#keyProvider, metadata);
      aad = authenticatedDataFor(metadata.objectName, callerAad);
      await verifyEncryptedObject({
        file: objectFile,
        metadata,
        dataKey,
        aad,
        signal,
      });
      const afterVerification = fileState(await objectFile.stat());
      if (!sameFileState(beforeVerification, afterVerification)) {
        fail('object-changed-during-verification');
      }

      for await (const plaintext of decryptVerifiedObject({
        file: objectFile,
        metadata,
        dataKey,
        aad,
        signal,
      })) {
        throwIfAborted(signal);
        yield plaintext;
      }
    } finally {
      await closeQuietly(objectFile);
      dataKey?.fill(0);
      aad?.fill(0);
      callerAad.fill(0);
    }
  }

  /** Streams authenticated plaintext to a Writable without ending that Writable. */
  async writeTo(input: FinanceDocumentWriteInput): Promise<void> {
    if (input === null || typeof input !== 'object')
      fail('write-input-invalid');
    const destination = parseDestination(input.destination);
    for await (const chunk of this.read({
      metadata: input.metadata,
      aad: input.aad,
      signal: input.signal,
    })) {
      await writeChunk(destination, chunk);
    }
  }

  /** Safe, idempotent compensation/purge for a previously minted opaque name. */
  async purge(objectNameInput: unknown): Promise<FinanceDocumentPurgeResult> {
    if (this.#access !== 'read-write') fail('storage-read-only');
    const objectName = parseFinanceDocumentObjectName(objectNameInput);
    const filePath = objectPathFor(this.#root, objectName);
    await this.#assertRoot();

    let entry: Stats;
    try {
      entry = await lstat(filePath);
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return Object.freeze({ status: 'missing' });
      throw error;
    }
    assertRegularRestrictiveFile(entry);
    try {
      await unlink(filePath);
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return Object.freeze({ status: 'missing' });
      throw error;
    }
    await fsyncDirectory(this.#root);
    return Object.freeze({ status: 'deleted' });
  }

  /** Bounded deployment probe; it never enumerates or decrypts objects. */
  async checkReady(): Promise<boolean> {
    try {
      await this.#assertRoot();
      return true;
    } catch {
      return false;
    }
  }

  async #assertRoot(): Promise<void> {
    const entry = await lstat(this.#root);
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !isRestrictiveMode(entry)
    ) {
      fail('storage-root-invalid');
    }
  }

  async #openObject(metadata: FinanceDocumentMetadata): Promise<FileHandle> {
    const filePath = objectPathFor(this.#root, metadata.objectName);
    let entry: Stats;
    try {
      entry = await lstat(filePath);
    } catch (error) {
      if (hasCode(error, 'ENOENT')) fail('object-missing');
      throw error;
    }
    assertRegularRestrictiveFile(entry);

    let objectFile: FileHandle | undefined;
    try {
      objectFile = await open(
        filePath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const openedEntry = await objectFile.stat();
      assertRegularRestrictiveFile(openedEntry);
      return objectFile;
    } catch (error) {
      await closeQuietly(objectFile);
      throw error;
    }
  }
}

export const createFinanceDocumentStorage = (
  options: FinanceDocumentStorageOptions,
): Promise<FinanceDocumentStorage> => FinanceDocumentStorage.create(options);

export const openFinanceDocumentStorageReadOnly = (
  options: FinanceDocumentStorageOptions,
): Promise<FinanceDocumentStorage> =>
  FinanceDocumentStorage.openReadOnly(options);

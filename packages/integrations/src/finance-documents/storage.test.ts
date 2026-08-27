import { createHash } from 'node:crypto';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { InMemoryVaultKeyProvider } from '../vault/crypto.js';
import {
  FINANCE_DOCUMENT_MAX_UPLOAD_BYTES,
  FinanceDocumentStorage,
  parseFinanceDocumentMetadata,
  parseFinanceDocumentObjectName,
} from './storage.js';

const temporaryRoots: string[] = [];

const DEFAULT_KEY = Buffer.alloc(32, 17);
const DEFAULT_AAD = Buffer.from(
  'finance-document-v1:household-1:document-1:revision-1',
  'utf8',
);

const chunksOf = async function* (
  chunks: readonly Uint8Array[],
): AsyncGenerator<Uint8Array, void, undefined> {
  for (const chunk of chunks) yield chunk;
};

const collect = async (source: AsyncIterable<Uint8Array>): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const captureWritable = (): {
  readonly destination: Writable;
  readonly chunks: Buffer[];
} => {
  const chunks: Buffer[] = [];
  return {
    chunks,
    destination: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
  };
};

const fixture = async (
  options: {
    readonly key?: Uint8Array;
    readonly keyVersion?: string;
  } = {},
) => {
  const base = await mkdtemp(join(tmpdir(), 'emdo-finance-documents-'));
  temporaryRoots.push(base);
  const webRoot = join(base, 'web');
  const storageRoot = join(base, 'finance-originals');
  await mkdir(webRoot, { mode: 0o700 });
  const keyProvider = new InMemoryVaultKeyProvider(
    options.key ?? DEFAULT_KEY,
    options.keyVersion ?? 'finance-test-key-v1',
  );
  const storage = await FinanceDocumentStorage.create({
    root: storageRoot,
    webRoot,
    keyProvider,
  });
  return { base, keyProvider, storage, storageRoot, webRoot };
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('FinanceDocumentStorage', () => {
  it('reports readiness only while its private root remains restrictive', async () => {
    const { storage, storageRoot } = await fixture();

    await expect(storage.checkReady()).resolves.toBe(true);
    await chmod(storageRoot, 0o755);
    await expect(storage.checkReady()).resolves.toBe(false);
  });

  it('opens an existing root read-only without granting write or purge authority', async () => {
    const { keyProvider, storage, storageRoot, webRoot } = await fixture();
    const plaintext = Buffer.from('Reviewed extraction input.', 'utf8');
    const metadata = await storage.store({
      source: chunksOf([plaintext]),
      aad: DEFAULT_AAD,
    });
    const reader = await FinanceDocumentStorage.openReadOnly({
      root: storageRoot,
      webRoot,
      keyProvider,
    });

    await expect(
      collect(reader.read({ metadata, aad: DEFAULT_AAD })),
    ).resolves.toEqual(plaintext);
    await expect(
      reader.store({ source: chunksOf([plaintext]), aad: DEFAULT_AAD }),
    ).rejects.toThrow('finance-document-storage-read-only');
    await expect(reader.purge(metadata.objectName)).rejects.toThrow(
      'finance-document-storage-read-only',
    );
  });

  it('streams a round trip under object-bound AAD with strict metadata and hashes', async () => {
    const { storage, storageRoot } = await fixture();
    const plaintext = Buffer.concat([
      Buffer.from('First finance document chunk. ', 'utf8'),
      Buffer.alloc(93_001, 7),
      Buffer.from(' Last document chunk.', 'utf8'),
    ]);

    const metadata = await storage.store({
      source: chunksOf([
        plaintext.subarray(0, 23),
        plaintext.subarray(23, 65_537),
        plaintext.subarray(65_537),
      ]),
      aad: DEFAULT_AAD,
    });

    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.keys(metadata).sort()).toEqual([
      'aadVersion',
      'algorithm',
      'authenticationTag',
      'ciphertextBytes',
      'ciphertextSha256',
      'keyVersion',
      'nonce',
      'objectName',
      'plaintextBytes',
      'plaintextSha256',
      'schemaVersion',
      'wrappedKey',
    ]);
    expect(metadata.objectName).toMatch(/^fd1_[A-Za-z0-9_-]{43}$/u);
    expect(metadata.objectName).not.toContain('/');
    expect(metadata).toMatchObject({
      schemaVersion: 1,
      algorithm: 'aes-256-gcm',
      aadVersion: 1,
      plaintextBytes: plaintext.byteLength,
      ciphertextBytes: plaintext.byteLength,
      plaintextSha256: createHash('sha256').update(plaintext).digest('hex'),
    });

    const encryptedPath = join(storageRoot, metadata.objectName);
    const ciphertext = await readFile(encryptedPath);
    expect(ciphertext).not.toEqual(plaintext);
    expect(metadata.ciphertextSha256).toBe(
      createHash('sha256').update(ciphertext).digest('hex'),
    );
    expect(await readdir(storageRoot)).toEqual([metadata.objectName]);
    expect(await collect(storage.read({ metadata, aad: DEFAULT_AAD }))).toEqual(
      plaintext,
    );

    const writable = captureWritable();
    await storage.writeTo({
      metadata,
      aad: DEFAULT_AAD,
      destination: writable.destination,
    });
    expect(Buffer.concat(writable.chunks)).toEqual(plaintext);

    if (process.platform !== 'win32') {
      expect((await stat(storageRoot)).mode & 0o077).toBe(0);
      expect((await stat(encryptedPath)).mode & 0o077).toBe(0);
    }
  });

  it('never exposes partial plaintext when ciphertext, metadata, AAD, or key material is wrong', async () => {
    const { storage, storageRoot, webRoot } = await fixture();
    const plaintext = Buffer.from(
      'authenticated finance document body',
      'utf8',
    );
    const metadata = await storage.store({
      source: chunksOf([plaintext]),
      aad: DEFAULT_AAD,
    });

    const wrongAadDestination = captureWritable();
    await expect(
      storage.writeTo({
        metadata,
        aad: Buffer.from('finance-document-v1:household-2:document-1', 'utf8'),
        destination: wrongAadDestination.destination,
      }),
    ).rejects.toThrow();
    expect(wrongAadDestination.chunks).toEqual([]);

    const wrongMetadataDestination = captureWritable();
    await expect(
      storage.writeTo({
        metadata: {
          ...metadata,
          plaintextSha256: metadata.plaintextSha256.startsWith('0')
            ? '1'.repeat(64)
            : '0'.repeat(64),
        },
        aad: DEFAULT_AAD,
        destination: wrongMetadataDestination.destination,
      }),
    ).rejects.toThrow();
    expect(wrongMetadataDestination.chunks).toEqual([]);

    const wrongKeyStorage = await FinanceDocumentStorage.create({
      root: storageRoot,
      webRoot,
      keyProvider: new InMemoryVaultKeyProvider(
        Buffer.alloc(32, 18),
        'finance-test-key-v1',
      ),
    });
    const wrongKeyDestination = captureWritable();
    await expect(
      wrongKeyStorage.writeTo({
        metadata,
        aad: DEFAULT_AAD,
        destination: wrongKeyDestination.destination,
      }),
    ).rejects.toThrow();
    expect(wrongKeyDestination.chunks).toEqual([]);

    const encryptedPath = join(storageRoot, metadata.objectName);
    const tampered = Buffer.from(await readFile(encryptedPath));
    tampered[0] = tampered[0]! ^ 0b0000_0001;
    await writeFile(encryptedPath, tampered);
    const tamperedDestination = captureWritable();
    await expect(
      storage.writeTo({
        metadata,
        aad: DEFAULT_AAD,
        destination: tamperedDestination.destination,
      }),
    ).rejects.toThrow();
    expect(tamperedDestination.chunks).toEqual([]);
  });

  it('rejects oversized uploads and cleans interruption-only ciphertext temporaries', async () => {
    const { storage, storageRoot } = await fixture();
    await expect(
      storage.store({
        source: chunksOf([
          Buffer.alloc(FINANCE_DOCUMENT_MAX_UPLOAD_BYTES + 1, 3),
        ]),
        aad: DEFAULT_AAD,
      }),
    ).rejects.toThrow('finance-document-upload-too-large');
    expect(await readdir(storageRoot)).toEqual([]);

    const abortController = new AbortController();
    const interruptedSource = async function* (): AsyncGenerator<
      Uint8Array,
      void,
      undefined
    > {
      yield Buffer.from('first partial chunk', 'utf8');
      abortController.abort();
      yield Buffer.from('must not become a document', 'utf8');
    };
    await expect(
      storage.store({
        source: interruptedSource(),
        aad: DEFAULT_AAD,
        signal: abortController.signal,
      }),
    ).rejects.toThrow('finance-document-operation-aborted');
    expect(await readdir(storageRoot)).toEqual([]);
  });

  it('rejects roots and object names that could cross a path boundary', async () => {
    const { base, storage, webRoot } = await fixture();
    await expect(
      FinanceDocumentStorage.create({
        root: 'relative-finance-originals',
        webRoot,
        keyProvider: new InMemoryVaultKeyProvider(
          DEFAULT_KEY,
          'finance-test-key-v1',
        ),
      }),
    ).rejects.toThrow('finance-document-storage-root-must-be-absolute');
    await expect(
      FinanceDocumentStorage.create({
        root: join(webRoot, 'finance-originals'),
        webRoot,
        keyProvider: new InMemoryVaultKeyProvider(
          DEFAULT_KEY,
          'finance-test-key-v1',
        ),
      }),
    ).rejects.toThrow('finance-document-storage-root-overlaps-web-root');
    await expect(
      FinanceDocumentStorage.create({
        root: base,
        webRoot,
        keyProvider: new InMemoryVaultKeyProvider(
          DEFAULT_KEY,
          'finance-test-key-v1',
        ),
      }),
    ).rejects.toThrow('finance-document-storage-root-overlaps-web-root');

    expect(() => parseFinanceDocumentObjectName('../not-an-object')).toThrow(
      'finance-document-object-name-invalid',
    );
    await expect(storage.purge('../not-an-object')).rejects.toThrow(
      'finance-document-object-name-invalid',
    );

    const metadata = await storage.store({
      source: chunksOf([Buffer.from('path boundary document', 'utf8')]),
      aad: DEFAULT_AAD,
    });
    expect(() =>
      parseFinanceDocumentMetadata({
        ...metadata,
        objectName: '../not-an-object',
      }),
    ).toThrow('finance-document-object-name-invalid');
    expect(() =>
      parseFinanceDocumentMetadata({
        ...metadata,
        untrustedPath: '/tmp/elsewhere',
      }),
    ).toThrow('finance-document-metadata-invalid');
  });

  it('purges only its validated opaque object names and remains idempotent', async () => {
    const { storage, storageRoot } = await fixture();
    const metadata = await storage.store({
      source: chunksOf([Buffer.from('compensating delete document', 'utf8')]),
      aad: DEFAULT_AAD,
    });

    await expect(storage.purge(metadata.objectName)).resolves.toEqual({
      status: 'deleted',
    });
    expect(await readdir(storageRoot)).toEqual([]);
    await expect(storage.purge(metadata.objectName)).resolves.toEqual({
      status: 'missing',
    });
  });
});

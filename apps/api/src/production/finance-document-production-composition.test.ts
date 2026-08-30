import { chmod, mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_FINANCE_DOCUMENT_STORE_DIR,
  createProductionFinanceDocumentComposition,
} from './finance-document-production-composition.js';

const temporaryRoots: string[] = [];

const encodeKeyring = (key: Buffer): string =>
  Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      current: {
        keyVersion: 'finance-documents.v1',
        keyB64url: key.toString('base64url'),
      },
      previous: [],
    }),
    'utf8',
  ).toString('base64url');

const environmentFor = (input: {
  readonly encryptionKey: Buffer;
  readonly reviewKey: Buffer;
  readonly storeDir: string;
  readonly includeFinanceApiKey?: boolean;
  readonly restoreReadOnly?: boolean;
}) => ({
  EMDO_FINANCE_DOCUMENTS_ENABLED: 'true',
  EMDO_FINANCE_DOCUMENT_KEYRING_B64URL: encodeKeyring(input.encryptionKey),
  EMDO_FINANCE_DOCUMENT_REVIEW_HMAC_KEY_B64URL:
    input.reviewKey.toString('base64url'),
  EMDO_FINANCE_DOCUMENT_STORE_DIR: input.storeDir,
  ...(input.restoreReadOnly === true
    ? { EMDO_FINANCE_RESTORE_READ_ONLY: 'true' }
    : {}),
  ...(input.includeFinanceApiKey === false
    ? {}
    : { EMDO_OPENAI_FINANCE_API_KEY: 'sk_test_finance_only_1234567890' }),
});

const databasePool = () => {
  const release = vi.fn();
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes('finance_documents_ready') ? [{ ready: true }] : [],
    rowCount: sql.includes('finance_documents_ready') ? 1 : 0,
  }));
  return {
    connect: vi.fn(async () => ({ query, release })),
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  };
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('Finance document production composition', () => {
  it('keeps the API fail-closed unless protected keys and reviewed embeddings are present', async () => {
    await expect(
      createProductionFinanceDocumentComposition({
        environment: {},
        pool: databasePool(),
        financeRead: { list: vi.fn(), readSnapshot: vi.fn() },
        webRoot: process.cwd(),
      }),
    ).resolves.toBeUndefined();
    expect(DEFAULT_FINANCE_DOCUMENT_STORE_DIR).toBe(
      '/var/lib/emdo/finance-documents',
    );
  });

  it('composes a ready private store and disposes its key material idempotently', async () => {
    const base = await mkdtemp(join(tmpdir(), 'emdo-finance-composition-'));
    temporaryRoots.push(base);
    const webRoot = join(base, 'app');
    await mkdir(webRoot, { mode: 0o700 });
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            object: 'list',
            data: [
              {
                object: 'embedding',
                index: 0,
                embedding: Array.from({ length: 1_536 }, () => 0.25),
              },
            ],
            model: 'text-embedding-3-small',
            usage: { prompt_tokens: 4, total_tokens: 4 },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );
    const composition = await createProductionFinanceDocumentComposition({
      environment: environmentFor({
        encryptionKey: Buffer.alloc(32, 21),
        reviewKey: Buffer.alloc(32, 22),
        storeDir: join(base, 'finance-documents'),
      }),
      pool: databasePool(),
      financeRead: { list: vi.fn(), readSnapshot: vi.fn() },
      webRoot,
      fetch,
    });

    expect(composition).toBeDefined();
    await expect(composition!.gateway.checkReady()).resolves.toBe(true);
    await expect(
      composition!.embeddingQuery.query({
        query: 'reviewed grocery receipt',
        abortSignal: new AbortController().signal,
      }),
    ).resolves.toHaveLength(1_536);
    expect(fetch).toHaveBeenCalledOnce();
    await expect(
      Promise.all([composition!.close(), composition!.close()]),
    ).resolves.toEqual([undefined, undefined]);
  });

  it('uses local deterministic embeddings only for exact synthetic Finance staging', async () => {
    const base = await mkdtemp(join(tmpdir(), 'emdo-finance-composition-'));
    temporaryRoots.push(base);
    const webRoot = join(base, 'app');
    await mkdir(webRoot, { mode: 0o700 });
    const environment = {
      ...environmentFor({
        encryptionKey: Buffer.alloc(32, 31),
        reviewKey: Buffer.alloc(32, 32),
        storeDir: join(base, 'finance-documents'),
        includeFinanceApiKey: false,
      }),
      EMDO_ENVIRONMENT: 'staging',
      EMDO_ALLOW_LOOPBACK_API_INGRESS: 'true',
      EMDO_SYNTHETIC_DATA_ONLY: 'true',
      EMDO_FINANCE_SYNTHETIC_STAGING: 'true',
    };
    const financeKeyRead = vi.fn(() => {
      throw new Error('synthetic-composition-must-not-read-finance-key');
    });
    Object.defineProperty(environment, 'EMDO_OPENAI_FINANCE_API_KEY', {
      enumerable: true,
      get: financeKeyRead,
    });
    const fetch = vi.fn(async () => {
      throw new Error('synthetic-composition-must-not-fetch');
    });

    const composition = await createProductionFinanceDocumentComposition({
      environment,
      pool: databasePool(),
      financeRead: { list: vi.fn(), readSnapshot: vi.fn() },
      webRoot,
      fetch,
    });

    expect(composition).toBeDefined();
    const first = await composition!.embeddingQuery.query({
      query: 'reviewed grocery receipt',
      abortSignal: new AbortController().signal,
    });
    const second = await composition!.embeddingQuery.query({
      query: 'reviewed grocery receipt',
      abortSignal: new AbortController().signal,
    });
    expect(first).toHaveLength(1_536);
    expect(first.every(Number.isFinite)).toBe(true);
    expect(second).toEqual(first);
    expect(fetch).not.toHaveBeenCalled();
    expect(financeKeyRead).not.toHaveBeenCalled();
    await composition!.close();
  });

  it('opens an exact synthetic restore store read-only without mutating its permissions', async () => {
    const base = await mkdtemp(join(tmpdir(), 'emdo-finance-composition-'));
    temporaryRoots.push(base);
    const webRoot = join(base, 'app');
    const storeDir = join(base, 'finance-documents');
    await mkdir(webRoot, { mode: 0o700 });
    await mkdir(storeDir, { mode: 0o700 });
    await chmod(storeDir, 0o500);
    const environment = {
      ...environmentFor({
        encryptionKey: Buffer.alloc(32, 51),
        reviewKey: Buffer.alloc(32, 52),
        storeDir,
        includeFinanceApiKey: false,
        restoreReadOnly: true,
      }),
      EMDO_ENVIRONMENT: 'staging',
      EMDO_ALLOW_LOOPBACK_API_INGRESS: 'true',
      EMDO_SYNTHETIC_DATA_ONLY: 'true',
      EMDO_FINANCE_SYNTHETIC_STAGING: 'true',
    };

    const composition = await createProductionFinanceDocumentComposition({
      environment,
      pool: databasePool(),
      financeRead: { list: vi.fn(), readSnapshot: vi.fn() },
      webRoot,
    });

    expect(composition).toBeDefined();
    await expect(composition!.gateway.checkReady()).resolves.toBe(true);
    expect((await stat(storeDir)).mode & 0o777).toBe(0o500);
    await composition!.close();

    await expect(
      createProductionFinanceDocumentComposition({
        environment: {
          ...environment,
          EMDO_ENVIRONMENT: 'production',
          EMDO_OPENAI_FINANCE_API_KEY: 'sk_test_finance_only_1234567890',
        },
        pool: databasePool(),
        financeRead: { list: vi.fn(), readSnapshot: vi.fn() },
        webRoot,
      }),
    ).resolves.toBeUndefined();
  });

  it('requires the Finance embedding key outside every exact synthetic staging boundary', async () => {
    const exactSyntheticWithoutFinanceKey = {
      ...environmentFor({
        encryptionKey: Buffer.alloc(32, 41),
        reviewKey: Buffer.alloc(32, 42),
        storeDir: DEFAULT_FINANCE_DOCUMENT_STORE_DIR,
        includeFinanceApiKey: false,
      }),
      EMDO_ENVIRONMENT: 'staging',
      EMDO_ALLOW_LOOPBACK_API_INGRESS: 'true',
      EMDO_SYNTHETIC_DATA_ONLY: 'true',
      EMDO_FINANCE_SYNTHETIC_STAGING: 'true',
    };
    const invalid = [
      { ...exactSyntheticWithoutFinanceKey, EMDO_ENVIRONMENT: 'production' },
      {
        ...exactSyntheticWithoutFinanceKey,
        EMDO_ALLOW_LOOPBACK_API_INGRESS: 'false',
      },
      {
        ...exactSyntheticWithoutFinanceKey,
        EMDO_SYNTHETIC_DATA_ONLY: 'false',
      },
      {
        ...exactSyntheticWithoutFinanceKey,
        EMDO_FINANCE_SYNTHETIC_STAGING: 'false',
      },
      {
        ...exactSyntheticWithoutFinanceKey,
        EMDO_FINANCE_DOCUMENTS_ENABLED: 'false',
      },
    ];

    for (const environment of invalid) {
      await expect(
        createProductionFinanceDocumentComposition({
          environment,
          pool: databasePool(),
          financeRead: { list: vi.fn(), readSnapshot: vi.fn() },
          webRoot: process.cwd(),
        }),
      ).resolves.toBeUndefined();
    }
  });

  it('rejects reuse of the review HMAC key as document encryption material', async () => {
    const base = await mkdtemp(join(tmpdir(), 'emdo-finance-composition-'));
    temporaryRoots.push(base);
    const webRoot = join(base, 'app');
    await mkdir(webRoot, { mode: 0o700 });
    const reused = Buffer.alloc(32, 23);

    await expect(
      createProductionFinanceDocumentComposition({
        environment: environmentFor({
          encryptionKey: reused,
          reviewKey: reused,
          storeDir: join(base, 'finance-documents'),
        }),
        pool: databasePool(),
        financeRead: { list: vi.fn(), readSnapshot: vi.fn() },
        webRoot,
      }),
    ).resolves.toBeUndefined();
  });
});

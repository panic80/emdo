import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { FinanceDocumentExtractionWorker } from './finance-document-extraction.js';
import {
  PostgresFinanceDocumentExtractionExecutor,
  startFinanceDocumentExtractionPoller,
} from './finance-document-extraction-postgres.js';

const ids = {
  householdId: '11111111-1111-4111-8111-111111111111',
  privateSpaceId: '22222222-2222-4222-8222-222222222222',
  ownerUserId: '33333333-3333-4333-8333-333333333333',
  documentId: '44444444-4444-4444-8444-444444444444',
} as const;

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const base64 = (length: number, fill: number): string =>
  Buffer.alloc(length, fill).toString('base64url');

const claimRow = () => ({
  household_id: ids.householdId,
  space_id: ids.privateSpaceId,
  original_owner_user_id: ids.ownerUserId,
  document_id: ids.documentId,
  extraction_revision: '2',
  extraction_attempt: '1',
  storage_object_id: `fd1_${base64(32, 1)}`,
  mime_type: 'application/pdf',
  byte_size: '1234',
  page_count: '3',
  image_width: null,
  image_height: null,
  plaintext_sha256: sha256('plaintext'),
  ciphertext_sha256: sha256('ciphertext'),
  wrapped_data_key: {
    algorithm: 'aes-256-gcm',
    aadVersion: 1,
    wrappedKey: base64(32, 2),
    nonce: base64(12, 3),
    authenticationTag: base64(16, 4),
  },
  key_version: 'finance-documents.v1',
});

const encryptedPayload = {
  schemaVersion: 1,
  algorithm: 'aes-256-gcm',
  aadVersion: 1,
  ciphertext: base64(24, 5),
  nonce: base64(12, 6),
  authenticationTag: base64(16, 7),
  wrappedKey: base64(32, 8),
  keyVersion: 'finance-documents.v1',
} as const;

const completionInput = (signal = new AbortController().signal) => ({
  documentId: ids.documentId,
  extractionRevision: 2,
  attempt: 1 as const,
  encryptedPayload,
  redactedSummary: {
    documentType: 'other' as const,
    sourceLocale: 'en-CA' as const,
    currency: 'CAD',
    factCount: 1,
    chunkCount: 0 as const,
    evidenceCount: 2,
    safeStatus: 'ready-for-review' as const,
  },
  responseHash: sha256('response'),
  inputTokens: 123,
  outputTokens: 45,
  documentType: 'other' as const,
  sourceLocale: 'en-CA' as const,
  currency: 'CAD',
  signal,
});

type QueryResult = { readonly rows: unknown[]; readonly rowCount?: number };

const createPool = (result: QueryResult | (() => Promise<QueryResult>)) => {
  const query = vi.fn(
    async (
      ...args: [string, (readonly unknown[] | undefined)?]
    ): Promise<QueryResult> => {
      void args;
      return typeof result === 'function' ? result() : result;
    },
  );
  const client = { query, release: vi.fn() };
  return {
    pool: { connect: vi.fn(async () => client) },
    query,
    release: client.release,
  };
};

const completeSql = `select emdo.complete_finance_document_extraction(
           $1::uuid, $2::integer, $3::smallint, $4::jsonb, $5::jsonb,
           $6::text, $7::integer, $8::integer, $9::text, $10::text, $11::text
         ) as result`;

const failSql = `select emdo.fail_finance_document_extraction(
           $1::uuid, $2::integer, $3::smallint, $4::text
         ) as result`;

describe('PostgresFinanceDocumentExtractionExecutor', () => {
  it('uses the fixed claim function, materializes strict metadata, and releases its connection', async () => {
    const { pool, query, release } = createPool({ rows: [claimRow()] });
    const executor = new PostgresFinanceDocumentExtractionExecutor(pool);

    await expect(
      executor.claimNextFinanceDocumentExtraction({
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      schemaVersion: 1,
      documentId: ids.documentId,
      extractionRevision: 2,
      attempt: 1,
      original: {
        mimeType: 'application/pdf',
        byteSize: 1234,
        pageCount: 3,
        imageWidth: null,
        imageHeight: null,
        metadata: {
          schemaVersion: 1,
          algorithm: 'aes-256-gcm',
          aadVersion: 1,
          objectName: `fd1_${base64(32, 1)}`,
          plaintextBytes: 1234,
          ciphertextBytes: 1234,
          plaintextSha256: sha256('plaintext'),
          ciphertextSha256: sha256('ciphertext'),
          nonce: base64(12, 3),
          authenticationTag: base64(16, 4),
          wrappedKey: base64(32, 2),
          keyVersion: 'finance-documents.v1',
        },
      },
      payloadScope: {
        householdId: ids.householdId,
        privateSpaceId: ids.privateSpaceId,
        ownerUserId: ids.ownerUserId,
        documentId: ids.documentId,
        extractionRevision: 2,
        purpose: 'unreviewed-extraction',
      },
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenLastCalledWith(
      'select * from emdo.claim_next_finance_document_extraction()',
      [],
    );
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenLastCalledWith();
  });

  it('rejects malformed claim rows and more than one row, always releasing the connection', async () => {
    for (const rows of [
      [{ ...claimRow(), unexpected: true }],
      [claimRow(), claimRow()],
    ]) {
      const { pool, release } = createPool({ rows });
      const executor = new PostgresFinanceDocumentExtractionExecutor(pool);

      await expect(
        executor.claimNextFinanceDocumentExtraction({
          signal: new AbortController().signal,
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(release).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenLastCalledWith();
    }
  });

  it('returns undefined for an empty claim and releases the connection after query errors', async () => {
    const empty = createPool({ rows: [] });
    await expect(
      new PostgresFinanceDocumentExtractionExecutor(
        empty.pool,
      ).claimNextFinanceDocumentExtraction({
        signal: new AbortController().signal,
      }),
    ).resolves.toBeUndefined();
    expect(empty.release).toHaveBeenCalledTimes(1);
    expect(empty.release).toHaveBeenLastCalledWith();

    const failure = createPool(async () => {
      throw new Error('database failure');
    });
    await expect(
      new PostgresFinanceDocumentExtractionExecutor(
        failure.pool,
      ).claimNextFinanceDocumentExtraction({
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('database failure');
    expect(failure.release).toHaveBeenCalledTimes(1);
    expect(failure.release).toHaveBeenLastCalledWith();
  });

  it('binds completion values to its exact fixed function SQL', async () => {
    const { pool, query, release } = createPool({ rows: [{ result: true }] });
    const input = completionInput();

    await expect(
      new PostgresFinanceDocumentExtractionExecutor(
        pool,
      ).completeFinanceDocumentExtraction(input),
    ).resolves.toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenLastCalledWith(completeSql, [
      ids.documentId,
      2,
      1,
      encryptedPayload,
      input.redactedSummary,
      sha256('response'),
      123,
      45,
      'other',
      'en-CA',
      'CAD',
    ]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenLastCalledWith();
  });

  it('rejects falsy, malformed, and multiple completion results', async () => {
    for (const rows of [
      [{ result: false }],
      [{ result: true, extra: 'not allowed' }],
      [{ result: true }, { result: true }],
    ]) {
      const { pool, release } = createPool({ rows });
      await expect(
        new PostgresFinanceDocumentExtractionExecutor(
          pool,
        ).completeFinanceDocumentExtraction(completionInput()),
      ).rejects.toBeInstanceOf(Error);
      expect(release).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenLastCalledWith();
    }
  });

  it('binds failure values to its exact fixed function SQL', async () => {
    const { pool, query, release } = createPool({ rows: [{ result: true }] });
    await expect(
      new PostgresFinanceDocumentExtractionExecutor(
        pool,
      ).failFinanceDocumentExtraction({
        documentId: ids.documentId,
        extractionRevision: 2,
        attempt: 2,
        safeErrorCode: 'worker-provider-unavailable',
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenLastCalledWith(failSql, [
      ids.documentId,
      2,
      2,
      'worker-provider-unavailable',
    ]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenLastCalledWith();
  });

  it('does not connect for an already-aborted call and rejects a claim aborted after querying', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const before = createPool({ rows: [claimRow()] });
    await expect(
      new PostgresFinanceDocumentExtractionExecutor(
        before.pool,
      ).claimNextFinanceDocumentExtraction({ signal: aborted.signal }),
    ).rejects.toThrow('Finance document extraction database unavailable.');
    expect(before.pool.connect).not.toHaveBeenCalled();

    const during = new AbortController();
    const after = createPool(async () => {
      during.abort();
      return { rows: [claimRow()] };
    });
    await expect(
      new PostgresFinanceDocumentExtractionExecutor(
        after.pool,
      ).claimNextFinanceDocumentExtraction({ signal: during.signal }),
    ).rejects.toThrow('Finance document extraction database unavailable.');
    expect(after.release).toHaveBeenCalledTimes(1);
    expect(after.release).toHaveBeenLastCalledWith();
  });
});

describe('startFinanceDocumentExtractionPoller', () => {
  it('runs worker claims one at a time', async () => {
    let inFlight = 0;
    let maximumInFlight = 0;
    let resolveFirst: ((value: { status: 'completed' }) => void) | undefined;
    let resolveSecond: ((value: { status: 'completed' }) => void) | undefined;
    const runOnce = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<{ status: 'completed' }>((resolve) => {
          inFlight += 1;
          maximumInFlight = Math.max(maximumInFlight, inFlight);
          const settle = (value: { status: 'completed' }) => {
            inFlight -= 1;
            resolve(value);
          };
          if (runOnce.mock.calls.length === 1) resolveFirst = settle;
          else resolveSecond = settle;
          expect(signal.aborted).toBe(false);
        }),
    );
    const worker = { runOnce } as unknown as FinanceDocumentExtractionWorker;
    const handle = startFinanceDocumentExtractionPoller({
      worker,
      signal: new AbortController().signal,
      pollIntervalMs: 250,
      onFatalError: vi.fn(),
    });

    expect(worker.runOnce).toHaveBeenCalledTimes(1);
    resolveFirst?.({ status: 'completed' });
    await vi.waitFor(() => expect(worker.runOnce).toHaveBeenCalledTimes(2));
    expect(maximumInFlight).toBe(1);
    const stopped = handle.stop();
    resolveSecond?.({ status: 'completed' });
    await stopped;
  });

  it('waits after idle results, but stop does not wait a full idle interval', async () => {
    vi.useFakeTimers();
    try {
      let resolveSecond: ((value: { status: 'idle' }) => void) | undefined;
      const runOnce = vi.fn(() => {
        if (runOnce.mock.calls.length === 1) {
          return Promise.resolve({ status: 'idle' as const });
        }
        return new Promise<{ status: 'idle' }>((resolve) => {
          resolveSecond = resolve;
        });
      });
      const worker = { runOnce } as unknown as FinanceDocumentExtractionWorker;
      const handle = startFinanceDocumentExtractionPoller({
        worker,
        signal: new AbortController().signal,
        pollIntervalMs: 250,
        onFatalError: vi.fn(),
      });

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(249);
      expect(worker.runOnce).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(worker.runOnce).toHaveBeenCalledTimes(2);
      const stopped = handle.stop();
      resolveSecond?.({ status: 'idle' });
      let stoppedBeforeIdleDelay = false;
      void stopped.then(() => {
        stoppedBeforeIdleDelay = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      const stoppedWithoutWaiting = stoppedBeforeIdleDelay;
      await vi.advanceTimersByTimeAsync(250);
      await stopped;
      expect(stoppedWithoutWaiting).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports an un-aborted worker failure exactly once and then stops', async () => {
    const onFatalError = vi.fn();
    const worker = {
      runOnce: vi.fn(async () => {
        throw new Error('worker failed');
      }),
    } as unknown as FinanceDocumentExtractionWorker;
    const handle = startFinanceDocumentExtractionPoller({
      worker,
      signal: new AbortController().signal,
      pollIntervalMs: 250,
      onFatalError,
    });

    await vi.waitFor(() => expect(onFatalError).toHaveBeenCalledTimes(1));
    expect(onFatalError).toHaveBeenLastCalledWith();
    expect(worker.runOnce).toHaveBeenCalledTimes(1);
    expect(worker.runOnce).toHaveBeenLastCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await handle.stop();
  });

  it('stops idempotently, aborts the in-flight worker, and does not report an abort failure', async () => {
    let settle: ((value: { status: 'completed' }) => void) | undefined;
    let workerSignal: AbortSignal | undefined;
    const onFatalError = vi.fn();
    const worker = {
      runOnce: vi.fn(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise<{ status: 'completed' }>((resolve) => {
            workerSignal = signal;
            settle = resolve;
          }),
      ),
    } as unknown as FinanceDocumentExtractionWorker;
    const handle = startFinanceDocumentExtractionPoller({
      worker,
      signal: new AbortController().signal,
      pollIntervalMs: 250,
      onFatalError,
    });

    const firstStop = handle.stop();
    const secondStop = handle.stop();
    expect(firstStop).toBe(secondStop);
    expect(workerSignal?.aborted).toBe(true);
    settle?.({ status: 'completed' });
    await firstStop;
    expect(onFatalError).not.toHaveBeenCalled();
    expect(worker.runOnce).toHaveBeenCalledTimes(1);
  });
});

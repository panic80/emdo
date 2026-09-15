import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  migrationMutation,
  readMigrationEvidence,
} from './finance-legacy-migration-api.js';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const bookId = id(1),
  migrationId = id(2);
const input = {
  migrationId,
  expectedRevision: 3,
  sourceSnapshotHash: 'a'.repeat(64),
};
const result = {
  migrationId,
  status: 'backfilled',
  targetBatchIds: [],
  targetRowIds: [],
  backfilledCount: 0,
  preservedCount: 0,
  sourceSnapshotHash: input.sourceSnapshotHash,
  replayed: true,
};
afterEach(() => vi.unstubAllGlobals());
describe('migration client mutation boundary', () => {
  it('reuses the exact idempotency key on an ambiguous retry and sends current CSRF', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(new Response(JSON.stringify(result)))
      .mockResolvedValueOnce(new Response(JSON.stringify(result)));
    vi.stubGlobal('fetch', fetcher);
    const mutate = migrationMutation();
    const signal = new AbortController().signal;
    await expect(
      mutate(bookId, 'backfill', input, 'csrf-current', signal, migrationId),
    ).rejects.toThrow('response lost');
    await expect(
      mutate(bookId, 'backfill', input, 'csrf-current', signal, migrationId),
    ).resolves.toEqual(result);
    const first = fetcher.mock.calls[0]![1]!,
      second = fetcher.mock.calls[1]![1]!;
    expect(first.body).toBe(second.body);
    expect(new Headers(first.headers).get('idempotency-key')).toBe(
      new Headers(second.headers).get('idempotency-key'),
    );
    expect(JSON.parse(String(first.body)).idempotencyKey).toBe(
      new Headers(first.headers).get('idempotency-key'),
    );
    expect(new Headers(second.headers).get('x-csrf-token')).toBe(
      'csrf-current',
    );
    expect(second.credentials).toBe('same-origin');
    expect(second.cache).toBe('no-store');
    await mutate(
      bookId,
      'backfill',
      { ...input, expectedRevision: 4 },
      'csrf-current',
      signal,
      migrationId,
    );
    expect(
      new Headers(fetcher.mock.calls[2]![1]!.headers).get('idempotency-key'),
    ).not.toBe(new Headers(second.headers).get('idempotency-key'));
  });
  it('rejects missing CSRF, wrong migration identity and client supplied opening amount before fetch', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const mutate = migrationMutation();
    const signal = new AbortController().signal;
    await expect(
      mutate(bookId, 'backfill', input, undefined, signal, migrationId),
    ).rejects.toThrow('Sign in');
    await expect(
      mutate(bookId, 'backfill', input, 'csrf', signal, id(99)),
    ).rejects.toThrow('identity');
    await expect(
      mutate(
        bookId,
        'opening',
        {
          expectedRunRevision: 1,
          expectedRecordRevision: 1,
          expectedSourceSnapshotHash: 'a'.repeat(64),
          amountCadMinor: '12345',
        },
        'csrf',
        signal,
        migrationId,
        id(3),
      ),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects another migration response and nonadvancing evidence pagination', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...result, migrationId: id(99) })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ documents: [], nextOffset: 0 })),
      );
    vi.stubGlobal('fetch', fetcher);
    const signal = new AbortController().signal;
    await expect(
      migrationMutation()(
        bookId,
        'backfill',
        input,
        'csrf',
        signal,
        migrationId,
      ),
    ).rejects.toThrow('identity');
    await expect(readMigrationEvidence(bookId, 0, signal)).rejects.toThrow(
      'pagination',
    );
  });
});

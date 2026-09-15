import { afterEach, describe, expect, it, vi } from 'vitest';
import { fecMutation, FecExport, readFecMapping } from './finance-fec-api.js';
afterEach(() => vi.unstubAllGlobals());
describe('France FEC API', () => {
  it('matches export idempotency header and body and retains key after uncertain failure', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            status: 'blocked',
            review: {
              errors: [
                { code: 'missing', path: 'accounts', message: 'Map accounts' },
              ],
              entryCount: 0,
              lineCount: 0,
            },
            file: null,
          }),
        ),
      );
    vi.stubGlobal('fetch', fetcher);
    const mutate = fecMutation(),
      signal = new AbortController().signal,
      input = {
        startsOn: '2026-01-01',
        endsOn: '2026-12-31',
        mappingRevision: 1,
      };
    await expect(
      mutate('book', 'exports', input, 'csrf', signal),
    ).rejects.toThrow('network');
    await mutate('book', 'exports', input, 'csrf', signal);
    const first = fetcher.mock.calls[0]![1] as RequestInit,
      second = fetcher.mock.calls[1]![1] as RequestInit;
    expect(first.body).toBe(second.body);
    expect(JSON.parse(first.body as string).idempotencyKey).toBe(
      (first.headers as Record<string, string>)['idempotency-key'],
    );
  });
  it('reports unavailable service honestly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 503 })),
    );
    await expect(
      readFecMapping('book', new AbortController().signal),
    ).rejects.toThrow('not enabled or ready');
  });
  it('rejects a ready file with invalid byte count', () => {
    expect(
      FecExport.safeParse({
        status: 'ready',
        review: { errors: [], entryCount: 1, lineCount: 1 },
        file: {
          fileName: '123456789FEC20261231.txt',
          content: 'é',
          byteLength: 1,
          encoding: 'UTF-8',
        },
      }).success,
    ).toBe(false);
  });
  it('rejects a blocked response containing a downloadable file', () => {
    expect(
      FecExport.safeParse({
        status: 'blocked',
        review: { errors: [], entryCount: 1, lineCount: 1 },
        file: {
          fileName: '123456789FEC20261231.txt',
          content: 'é',
          byteLength: 2,
          encoding: 'UTF-8',
        },
      }).success,
    ).toBe(false);
  });
});

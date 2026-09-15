import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFinancePdfOcrInspection } from './finance-pdf-ocr-api.js';
const id = '11111111-1111-4111-8111-111111111111';
const source = {
  bookId: id,
  evidenceId: id,
  standardizationRunId: id,
  extractionRevision: 1,
  sourceDigest: 'a'.repeat(64),
  extractionDigest: 'b'.repeat(64),
};
const response = {
  evidenceId: id,
  standardizationRunId: id,
  extractionRevision: 1,
  sourceDigest: source.sourceDigest,
  extractionDigest: source.extractionDigest,
  inventory: {
    sourceDigest: source.sourceDigest,
    pageCount: 1,
    complete: false,
    pages: [{ kind: 'unresolved', pageNumber: 1, reason: 'ocr-unavailable' }],
  },
};
afterEach(() => vi.unstubAllGlobals());
describe('saved PDF inspection browser client', () => {
  it('requests exact saved revision without caching and retains unresolved pages', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(response)));
    vi.stubGlobal('fetch', fetcher);
    const signal = new AbortController().signal;
    expect(
      (await readFinancePdfOcrInspection(source, signal)).inventory.pages[0]
        ?.kind,
    ).toBe('unresolved');
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining('extractionRevision=1'),
      { credentials: 'same-origin', cache: 'no-store', signal },
    );
  });
  it('rejects a different saved extraction', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ ...response, extractionDigest: 'c'.repeat(64) }),
          ),
      ),
    );
    await expect(
      readFinancePdfOcrInspection(source, new AbortController().signal),
    ).rejects.toThrow('does not match');
  });
  it('rejects revoked access and cancelled requests', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 403 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(
      readFinancePdfOcrInspection(source, new AbortController().signal),
    ).rejects.toThrow('access');
    const controller = new AbortController();
    controller.abort();
    fetcher.mockClear();
    await expect(
      readFinancePdfOcrInspection(source, controller.signal),
    ).rejects.toThrow('Aborted');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

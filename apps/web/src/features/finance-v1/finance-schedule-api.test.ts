import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  prepareScheduleSource,
  readScheduleSources,
  ScheduleRequestError,
} from './finance-schedule-api.js';
const book = '00000000-0000-4000-8000-000000000001',
  source = '00000000-0000-4000-8000-000000000002';
afterEach(() => vi.unstubAllGlobals());
describe('prepared recurring source adapters', () => {
  it('uses server journal amount/count without substituting zero', async () => {
    const prepared = {
      journal: {
        schemaVersion: 1,
        batchId: source,
        expectedBatchRevision: 4,
        expectedSnapshotHash: 'a'.repeat(64),
      },
      itemCount: 6,
      currency: 'CAD',
      amount: '101.25',
    };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(prepared)));
    vi.stubGlobal('fetch', fetcher);
    await expect(
      prepareScheduleSource(
        book,
        { id: source, label: 'Reviewed.csv', kind: 'journal', revision: 4 },
        'CAD',
        'csrf',
        'retry-key',
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      kind: 'journal',
      label: 'Reviewed.csv',
      journal: prepared.journal,
      itemCount: 6,
      money: { currency: 'CAD', amount: '101.25' },
    });
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining('/journal-drafts/prepare'),
      expect.objectContaining({ body: JSON.stringify({ batchId: source }) }),
    );
  });
  it('preserves extraction run/revision/source pins and zero accounting amount', async () => {
    const extraction = {
      schemaVersion: 1,
      evidenceId: source,
      expectedSourceDigest: 'b'.repeat(64),
      standardizationRunId: book,
      expectedRunRevision: 3,
      expectedExtractionRevision: 2,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(extraction))),
    );
    await expect(
      prepareScheduleSource(
        book,
        {
          id: source,
          label: 'Original.pdf',
          kind: 'extraction',
          format: 'pdf',
          sourceDigest: 'b'.repeat(64),
        },
        'CAD',
        'csrf',
        'retry-key',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      kind: 'extraction',
      extraction,
      itemCount: 1,
      money: { currency: 'CAD', amount: '0' },
    });
  });
  it('maps source access revocation into schedule private-state clearing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 403 })),
    );
    await expect(
      readScheduleSources(book, 'journal', 0, new AbortController().signal),
    ).rejects.toBeInstanceOf(ScheduleRequestError);
    await expect(
      readScheduleSources(book, 'extraction', 0, new AbortController().signal),
    ).rejects.toMatchObject({ status: 403 });
  });
});

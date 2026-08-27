import { describe, expect, it } from 'vitest';

import { createSyntheticFinanceDocumentEmbeddings } from './synthetic-finance-document-embeddings.js';

describe('synthetic Finance document embeddings', () => {
  it('creates stable finite 1536-value vectors for equal reviewed chunks and queries', async () => {
    const synthetic = createSyntheticFinanceDocumentEmbeddings();
    const content = 'Reviewed redacted grocery receipt: CAD 12.99.';
    const signal = new AbortController().signal;

    const [chunkVector] = (
      await synthetic.embeddings.embed({
        chunks: [{ content }],
        signal,
      })
    ).vectors;
    const queryVector = await synthetic.embeddingQuery.query({
      query: content,
      abortSignal: signal,
    });
    const differentVector = await synthetic.embeddingQuery.query({
      query: `${content} different`,
      abortSignal: signal,
    });

    expect(chunkVector).toHaveLength(1_536);
    expect(chunkVector?.every(Number.isFinite)).toBe(true);
    expect(queryVector).toEqual(chunkVector);
    expect(differentVector).not.toEqual(chunkVector);
    expect(JSON.stringify({ chunkVector, queryVector })).not.toContain(content);
  });

  it('keeps the local boundary bounded and abort-aware', async () => {
    const synthetic = createSyntheticFinanceDocumentEmbeddings();
    const controller = new AbortController();
    controller.abort();

    await expect(
      synthetic.embeddings.embed({
        chunks: [{ content: 'reviewed fragment' }],
        signal: controller.signal,
      }),
    ).rejects.toThrow('api-finance-document-synthetic-embeddings-unavailable');
    await expect(
      synthetic.embeddings.embed({
        chunks: Array.from({ length: 33 }, () => ({ content: 'fragment' })),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('api-finance-document-synthetic-embeddings-unavailable');
  });
});

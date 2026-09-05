import { describe, expect, it } from 'vitest';

import {
  OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_DIMENSIONS,
  OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_LIMITS,
  OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_MODEL,
  OpenAiFetchFinanceDocumentEmbeddingsAdapter,
  OpenAiFinanceDocumentEmbeddingsError,
  type OpenAiFinanceDocumentEmbeddingsRequest,
} from './finance-document-embeddings.js';
import type { OpenAiFetch } from './fetch-transport.js';

const apiKey = `sk-proj-${'a'.repeat(32)}`;

const vector = (value: number): number[] =>
  Array.from(
    { length: OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_DIMENSIONS },
    () => value,
  );

const embeddingResponse = (
  data: readonly { readonly index: number; readonly embedding: number[] }[],
  inputTokens = 9,
) =>
  new Response(
    JSON.stringify({
      object: 'list',
      model: OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_MODEL,
      data: data.map((entry) => ({
        object: 'embedding',
        index: entry.index,
        embedding: entry.embedding,
      })),
      usage: { prompt_tokens: inputTokens, total_tokens: inputTokens },
    }),
    {
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'req_finance_embeddings_1',
      },
    },
  );

const request = (
  signal = new AbortController().signal,
): OpenAiFinanceDocumentEmbeddingsRequest => ({
  chunks: [
    { content: 'Reviewed and redacted grocery receipt, CAD 12.99.' },
    { content: 'Reviewed and redacted electricity bill, CAD 45.10.' },
  ],
  signal,
});

describe('OpenAiFetchFinanceDocumentEmbeddingsAdapter', () => {
  it('posts only bounded committed-redacted text and restores provider index order', async () => {
    const fetch: OpenAiFetch = async (input, init) => {
      expect(input).toBe('https://api.openai.com/v1/embeddings');
      expect(init?.method).toBe('POST');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${apiKey}`);
      expect(headers.get('content-type')).toBe('application/json');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toEqual({
        model: OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_MODEL,
        input: request().chunks.map((chunk) => chunk.content),
        dimensions: OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_DIMENSIONS,
        encoding_format: 'float',
      });
      expect(body).not.toHaveProperty('tools');
      expect(body).not.toHaveProperty('files');
      expect(body).not.toHaveProperty('vector_stores');
      expect(body).not.toHaveProperty('background');
      return embeddingResponse([
        { index: 1, embedding: vector(2) },
        { index: 0, embedding: vector(1) },
      ]);
    };
    const adapter = new OpenAiFetchFinanceDocumentEmbeddingsAdapter({
      fetch,
      apiKey,
    });

    const result = await adapter.embed(request());

    expect(result.vectors).toHaveLength(2);
    expect(result.vectors[0]?.[0]).toBe(1);
    expect(result.vectors[1]?.[0]).toBe(2);
    expect(result.provider).toEqual({
      provider: 'openai',
      model: OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_MODEL,
      dimensions: OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_DIMENSIONS,
      inputCount: 2,
      attempts: 1,
      providerRequestIds: ['req_finance_embeddings_1'],
      usage: { inputTokens: 9, totalTokens: 9 },
    });
    expect(JSON.stringify(result)).not.toContain(request().chunks[0]!.content);
  });

  it('validates batch count and per-request input bounds before dispatch', async () => {
    let calls = 0;
    const adapter = new OpenAiFetchFinanceDocumentEmbeddingsAdapter({
      fetch: async () => {
        calls += 1;
        return embeddingResponse([{ index: 0, embedding: vector(1) }]);
      },
      apiKey,
    });
    const tooMany = {
      signal: new AbortController().signal,
      chunks: Array.from(
        {
          length:
            OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_LIMITS.maxChunksPerRequest + 1,
        },
        () => ({ content: 'reviewed redacted chunk' }),
      ),
    };
    const tooLong = {
      signal: new AbortController().signal,
      chunks: [
        {
          content: 'x'.repeat(
            OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_LIMITS.maxInputCharactersPerChunk +
              1,
          ),
        },
      ],
    };

    await expect(adapter.embed(tooMany)).rejects.toMatchObject({
      kind: 'invalid-request',
      retryable: false,
    });
    await expect(adapter.embed(tooLong)).rejects.toMatchObject({
      kind: 'invalid-request',
      retryable: false,
    });
    expect(calls).toBe(0);
  });

  it('rejects non-finite or wrong-dimension vectors without returning inputs', async () => {
    const privateChunk =
      'reviewed tax detail that must never appear in an error';
    const wrongDimension = new OpenAiFetchFinanceDocumentEmbeddingsAdapter({
      fetch: async () =>
        embeddingResponse([
          {
            index: 0,
            embedding: [Number.NaN],
          },
        ]),
      apiKey,
    });
    const failure = await wrongDimension
      .embed({
        chunks: [{ content: privateChunk }],
        signal: new AbortController().signal,
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OpenAiFinanceDocumentEmbeddingsError);
    expect(failure).toMatchObject({
      kind: 'response-invalid',
      retryable: false,
    });
    expect(String(failure)).not.toContain(privateChunk);
    expect(JSON.stringify(failure)).not.toContain(privateChunk);

    const nonFiniteVector = [
      '1e999',
      ...Array.from(
        { length: OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_DIMENSIONS - 1 },
        () => '0',
      ),
    ].join(',');
    const nonFinite = new OpenAiFetchFinanceDocumentEmbeddingsAdapter({
      fetch: async () =>
        new Response(
          `{"object":"list","model":"${OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_MODEL}","data":[{"object":"embedding","index":0,"embedding":[${nonFiniteVector}]}]}`,
          { headers: { 'content-type': 'application/json' } },
        ),
      apiKey,
    });
    await expect(
      nonFinite.embed({
        chunks: [{ content: privateChunk }],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ kind: 'response-invalid', retryable: false });
  });

  it('does not retry provider failures or expose provider error bodies', async () => {
    const privateDetail = 'raw household finance detail';
    let calls = 0;
    const adapter = new OpenAiFetchFinanceDocumentEmbeddingsAdapter({
      fetch: async () => {
        calls += 1;
        return new Response(
          JSON.stringify({ error: { message: `${apiKey} ${privateDetail}` } }),
          {
            status: 503,
            headers: { 'x-request-id': 'req_safe_provider_failure' },
          },
        );
      },
      apiKey,
    });
    const failure = await adapter
      .embed(request())
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      kind: 'provider-unavailable',
      httpStatus: 503,
      retryable: true,
      providerRequestId: 'req_safe_provider_failure',
    });
    expect(String(failure)).not.toContain(apiKey);
    expect(String(failure)).not.toContain(privateDetail);
    expect(calls).toBe(1);
  });

  it('converts caller cancellation and the bounded deadline into safe failures', async () => {
    const abortController = new AbortController();
    let abortSignalSeen: AbortSignal | undefined;
    const waitingFetch: OpenAiFetch = async (_input, init) => {
      abortSignalSeen = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        abortSignalSeen?.addEventListener(
          'abort',
          () => reject(new Error('transport ignored request content')),
          { once: true },
        );
      });
    };
    const adapter = new OpenAiFetchFinanceDocumentEmbeddingsAdapter({
      fetch: waitingFetch,
      apiKey,
    });

    const cancelled = adapter.embed(request(abortController.signal));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    abortController.abort();
    await expect(cancelled).rejects.toMatchObject({ kind: 'request-aborted' });
    expect(abortSignalSeen?.aborted).toBe(true);

    await expect(
      adapter.embed({ ...request(), timeoutMs: 1 }),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });
});

import { createHash } from 'node:crypto';

import {
  OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_DIMENSIONS,
  OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_LIMITS,
} from '@emdo/integrations/openai';

import type { FinanceDocumentEmbeddingsPort } from './finance-document-services.js';
import type { FinanceSpecialistEmbeddingQueryPort } from './finance-specialist-document-port.js';

const SYNTHETIC_EMBEDDING_DOMAIN =
  'emdo.finance-document.synthetic-embedding.v1\0';
const UNAVAILABLE = 'api-finance-document-synthetic-embeddings-unavailable';

type ValidEmbeddingRequest = Readonly<{
  readonly contents: readonly string[];
  readonly signal: AbortSignal;
}>;

const unavailable = (): Error => new Error(UNAVAILABLE);

const isAbortSignal = (value: unknown): value is AbortSignal =>
  value !== null &&
  typeof value === 'object' &&
  typeof (value as AbortSignal).aborted === 'boolean';

const snapshotChunks = (
  value: unknown,
): readonly Readonly<{ readonly content: string }>[] | undefined => {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length === 0 ||
    value.length > OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_LIMITS.maxChunksPerRequest
  ) {
    return undefined;
  }
  const chunks: Readonly<{ readonly content: string }>[] = [];
  let characterCount = 0;
  let byteCount = 0;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    const chunk = descriptor?.value;
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true ||
      chunk === null ||
      typeof chunk !== 'object' ||
      (Object.getPrototypeOf(chunk) !== Object.prototype &&
        Object.getPrototypeOf(chunk) !== null)
    ) {
      return undefined;
    }
    const contentDescriptor = Object.getOwnPropertyDescriptor(chunk, 'content');
    const content = contentDescriptor?.value;
    if (
      contentDescriptor === undefined ||
      contentDescriptor.get !== undefined ||
      contentDescriptor.set !== undefined ||
      contentDescriptor.enumerable !== true ||
      typeof content !== 'string' ||
      content.trim().length === 0 ||
      content.length >
        OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_LIMITS.maxInputCharactersPerChunk
    ) {
      return undefined;
    }
    const contentBytes = Buffer.byteLength(content, 'utf8');
    if (
      contentBytes >
      OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_LIMITS.maxInputBytesPerChunk
    ) {
      return undefined;
    }
    characterCount += content.length;
    byteCount += contentBytes;
    if (
      characterCount >
        OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_LIMITS.maxInputCharactersPerRequest ||
      byteCount >
        OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_LIMITS.maxInputBytesPerRequest
    ) {
      return undefined;
    }
    chunks.push(Object.freeze({ content }));
  }
  return Object.freeze(chunks);
};

const validateRequest = (input: unknown): ValidEmbeddingRequest | undefined => {
  if (
    input === null ||
    typeof input !== 'object' ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  ) {
    return undefined;
  }
  const chunksDescriptor = Object.getOwnPropertyDescriptor(input, 'chunks');
  const signalDescriptor = Object.getOwnPropertyDescriptor(input, 'signal');
  if (
    chunksDescriptor === undefined ||
    chunksDescriptor.get !== undefined ||
    chunksDescriptor.set !== undefined ||
    chunksDescriptor.enumerable !== true ||
    signalDescriptor === undefined ||
    signalDescriptor.get !== undefined ||
    signalDescriptor.set !== undefined ||
    signalDescriptor.enumerable !== true
  ) {
    return undefined;
  }
  const contents = snapshotChunks(chunksDescriptor.value)?.map(
    (chunk) => chunk.content,
  );
  if (contents === undefined || !isAbortSignal(signalDescriptor.value)) {
    return undefined;
  }
  return Object.freeze({
    contents: Object.freeze(contents),
    signal: signalDescriptor.value,
  });
};

const vectorFor = (content: string, signal: AbortSignal): readonly number[] => {
  const byteLength = Buffer.alloc(4);
  let seed: Buffer | undefined;
  let block: Buffer | undefined;
  try {
    byteLength.writeUInt32BE(Buffer.byteLength(content, 'utf8'));
    seed = createHash('sha512')
      .update(SYNTHETIC_EMBEDDING_DOMAIN, 'utf8')
      .update(byteLength)
      .update(content, 'utf8')
      .digest();
    const vector = new Array<number>(
      OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_DIMENSIONS,
    );
    let dimension = 0;
    for (
      let blockIndex = 0;
      dimension < OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_DIMENSIONS;
      blockIndex += 1
    ) {
      if (signal.aborted) throw unavailable();
      const index = Buffer.alloc(4);
      try {
        index.writeUInt32BE(blockIndex);
        block = createHash('sha512')
          .update(SYNTHETIC_EMBEDDING_DOMAIN, 'utf8')
          .update(index)
          .update(seed)
          .digest();
      } finally {
        index.fill(0);
      }
      for (
        let offset = 0;
        offset < block.byteLength &&
        dimension < OPENAI_FINANCE_DOCUMENT_EMBEDDINGS_DIMENSIONS;
        offset += 4
      ) {
        vector[dimension] = block.readInt32BE(offset) / 2_147_483_648;
        dimension += 1;
      }
      block.fill(0);
      block = undefined;
    }
    return Object.freeze(vector);
  } finally {
    byteLength.fill(0);
    seed?.fill(0);
    block?.fill(0);
  }
};

export interface SyntheticFinanceDocumentEmbeddings {
  readonly embeddings: FinanceDocumentEmbeddingsPort;
  readonly embeddingQuery: FinanceSpecialistEmbeddingQueryPort;
}

/**
 * A bounded local-only embedding boundary for the exact synthetic staging
 * configuration. It is deliberately content-derived so equal committed chunks
 * and search queries remain comparable, yet it has no provider or credential.
 */
export const createSyntheticFinanceDocumentEmbeddings =
  (): SyntheticFinanceDocumentEmbeddings => {
    const embeddings: FinanceDocumentEmbeddingsPort = Object.freeze({
      async embed(
        input: Parameters<FinanceDocumentEmbeddingsPort['embed']>[0],
      ) {
        const request = validateRequest(input);
        if (request === undefined || request.signal.aborted)
          throw unavailable();
        const vectors: Array<readonly number[]> = [];
        for (const content of request.contents) {
          if (request.signal.aborted) throw unavailable();
          vectors.push(vectorFor(content, request.signal));
        }
        if (request.signal.aborted) throw unavailable();
        return Object.freeze({ vectors: Object.freeze(vectors) });
      },
    });
    const embeddingQuery: FinanceSpecialistEmbeddingQueryPort = Object.freeze({
      async query(
        input: Parameters<FinanceSpecialistEmbeddingQueryPort['query']>[0],
      ) {
        const result = await embeddings.embed({
          chunks: [{ content: input.query }],
          signal: input.abortSignal,
        });
        const vector = result.vectors[0];
        if (vector === undefined) throw unavailable();
        return vector;
      },
    });
    return Object.freeze({ embeddings, embeddingQuery });
  };

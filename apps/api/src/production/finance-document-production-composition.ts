import { resolve } from 'node:path';

import { PostgresFinanceDocumentRepository } from '@emdo/db/api';
import {
  FinanceDocumentPayloadCrypto,
  createFinanceDocumentStorage,
  openFinanceDocumentStorageReadOnly,
} from '@emdo/integrations/finance-documents';
import {
  OpenAiFetchFinanceDocumentEmbeddingsAdapter,
  type OpenAiFetch,
} from '@emdo/integrations/openai';

import type { FinanceReadGateway } from '../services/contracts.js';
import { createProductionFinanceDocumentKeyProvider } from './finance-document-keyring.js';
import {
  createProductionFinanceDocumentGateway,
  type FinanceDocumentEmbeddingsPort,
  type ProductionFinanceDocumentGateway,
} from './finance-document-services.js';
import { createFinancePdfInspector } from './finance-pdf-inspection.js';
import type { FinanceSpecialistEmbeddingQueryPort } from './finance-specialist-document-port.js';
import { createSyntheticFinanceDocumentEmbeddings } from './synthetic-finance-document-embeddings.js';

export const DEFAULT_FINANCE_DOCUMENT_STORE_DIR =
  '/var/lib/emdo/finance-documents';

const decodeSecret32 = (value: unknown): Buffer | undefined => {
  if (
    typeof value !== 'string' ||
    value.length !== 43 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    return undefined;
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.byteLength !== 32 || bytes.toString('base64url') !== value) {
    bytes.fill(0);
    return undefined;
  }
  return bytes;
};

const isExactSyntheticFinanceStaging = (
  environment: Readonly<Record<string, string | undefined>>,
): boolean => {
  try {
    const prototype =
      environment !== null && typeof environment === 'object'
        ? Object.getPrototypeOf(environment)
        : undefined;
    if (
      environment === null ||
      typeof environment !== 'object' ||
      (prototype !== Object.prototype &&
        prototype !== null &&
        Object.getPrototypeOf(prototype) !== Object.prototype)
    ) {
      return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(environment);
    const read = (key: string): unknown => {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true
      ) {
        return undefined;
      }
      return descriptor.value;
    };
    return (
      read('EMDO_ENVIRONMENT') === 'staging' &&
      read('EMDO_ALLOW_LOOPBACK_API_INGRESS') === 'true' &&
      read('EMDO_SYNTHETIC_DATA_ONLY') === 'true' &&
      read('EMDO_FINANCE_SYNTHETIC_STAGING') === 'true' &&
      read('EMDO_FINANCE_DOCUMENTS_ENABLED') === 'true'
    );
  } catch {
    return false;
  }
};

const createEmbeddingQuery = (
  embeddings: FinanceDocumentEmbeddingsPort,
): FinanceSpecialistEmbeddingQueryPort =>
  Object.freeze({
    async query(
      input: Parameters<FinanceSpecialistEmbeddingQueryPort['query']>[0],
    ) {
      const result = await embeddings.embed({
        chunks: [{ content: input.query }],
        signal: input.abortSignal,
      });
      const vector = result.vectors[0];
      if (vector === undefined) {
        throw new Error('api-finance-document-query-embedding-unavailable');
      }
      return vector;
    },
  });

export interface ProductionFinanceDocumentComposition {
  readonly gateway: ProductionFinanceDocumentGateway;
  readonly embeddingQuery: FinanceSpecialistEmbeddingQueryPort;
  readonly close: () => Promise<void>;
}

type FinanceDocumentPool = ConstructorParameters<
  typeof PostgresFinanceDocumentRepository
>[0];

/**
 * Composes the private document boundary only when both independent secret
 * domains are present. Normal composition also requires the Finance embedding
 * key; exact synthetic staging replaces that provider boundary with a local,
 * deterministic embedding port. Raw originals and extraction remain confined
 * to the dedicated extraction worker.
 */
export const createProductionFinanceDocumentComposition = async (input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly pool: FinanceDocumentPool;
  readonly financeRead: Pick<FinanceReadGateway, 'list' | 'readSnapshot'>;
  readonly webRoot: string;
  readonly fetch?: OpenAiFetch;
}): Promise<ProductionFinanceDocumentComposition | undefined> => {
  const syntheticStaging = isExactSyntheticFinanceStaging(input.environment);
  const restoreReadOnlySetting =
    input.environment.EMDO_FINANCE_RESTORE_READ_ONLY;
  if (
    restoreReadOnlySetting !== undefined &&
    restoreReadOnlySetting !== 'false' &&
    !(syntheticStaging && restoreReadOnlySetting === 'true')
  ) {
    return undefined;
  }
  const restoreReadOnly = restoreReadOnlySetting === 'true';
  const encodedKeyring = input.environment.EMDO_FINANCE_DOCUMENT_KEYRING_B64URL;
  const reviewKey = decodeSecret32(
    input.environment.EMDO_FINANCE_DOCUMENT_REVIEW_HMAC_KEY_B64URL,
  );
  const financeApiKey = syntheticStaging
    ? undefined
    : input.environment.EMDO_OPENAI_FINANCE_API_KEY;
  if (
    input.environment.EMDO_FINANCE_DOCUMENTS_ENABLED !== 'true' ||
    encodedKeyring === undefined ||
    reviewKey === undefined ||
    (!syntheticStaging && typeof financeApiKey !== 'string')
  ) {
    reviewKey?.fill(0);
    return undefined;
  }

  let keyProvider:
    ReturnType<typeof createProductionFinanceDocumentKeyProvider> | undefined;
  let gateway: ProductionFinanceDocumentGateway | undefined;
  try {
    keyProvider = createProductionFinanceDocumentKeyProvider(encodedKeyring, [
      reviewKey,
    ]);
    const storageOptions = {
      root: resolve(
        input.environment.EMDO_FINANCE_DOCUMENT_STORE_DIR ??
          DEFAULT_FINANCE_DOCUMENT_STORE_DIR,
      ),
      webRoot: resolve(input.webRoot),
      keyProvider,
    };
    const storage = restoreReadOnly
      ? await openFinanceDocumentStorageReadOnly(storageOptions)
      : await createFinanceDocumentStorage(storageOptions);
    const repository = new PostgresFinanceDocumentRepository(input.pool);
    let embeddings: FinanceDocumentEmbeddingsPort;
    let embeddingQuery: FinanceSpecialistEmbeddingQueryPort;
    if (syntheticStaging) {
      const syntheticEmbeddings = createSyntheticFinanceDocumentEmbeddings();
      embeddings = syntheticEmbeddings.embeddings;
      embeddingQuery = syntheticEmbeddings.embeddingQuery;
    } else {
      if (typeof financeApiKey !== 'string') {
        throw new Error('api-finance-document-embedding-key-unavailable');
      }
      embeddings = new OpenAiFetchFinanceDocumentEmbeddingsAdapter({
        fetch: input.fetch ?? globalThis.fetch.bind(globalThis),
        apiKey: financeApiKey,
      });
      embeddingQuery = createEmbeddingQuery(embeddings);
    }
    gateway = createProductionFinanceDocumentGateway({
      financeRead: input.financeRead,
      reviewTokenHmacKey: reviewKey,
      payloadCrypto: new FinanceDocumentPayloadCrypto(keyProvider),
      pdfInspector: createFinancePdfInspector(),
      repository,
      storage,
      embeddings,
    });
    let closePromise: Promise<void> | undefined;
    const configuredGateway = gateway;
    const configuredKeyProvider = keyProvider;
    return Object.freeze({
      gateway: configuredGateway,
      embeddingQuery,
      close: () => {
        closePromise ??= Promise.resolve().then(() => {
          configuredGateway.dispose();
          configuredKeyProvider.dispose();
        });
        return closePromise;
      },
    });
  } catch {
    gateway?.dispose();
    keyProvider?.dispose();
    return undefined;
  } finally {
    reviewKey.fill(0);
  }
};

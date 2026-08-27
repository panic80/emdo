import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  createDatabaseClient,
  type EmdoWorkerDatabaseClient,
} from '@emdo/db/worker';
import {
  FinanceDocumentPayloadCrypto,
  createFinanceDocumentKeyProvider,
  openFinanceDocumentStorageReadOnly,
} from '@emdo/integrations/finance-documents';
import { OpenAiFetchFinanceDocumentExtractionTransport } from '@emdo/integrations/openai';
import { z } from 'zod';

import { createFinanceDocumentExtractionWorker } from '../finance-document-extraction.js';
import {
  PostgresFinanceDocumentExtractionExecutor,
  startFinanceDocumentExtractionPoller,
  type FinanceDocumentExtractionPollerHandle,
} from '../finance-document-extraction-postgres.js';

export const FINANCE_DOCUMENT_EXTRACTION_STORE_DIR =
  '/var/lib/emdo/finance-documents';

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DATABASE_READINESS_TIMEOUT_MS = 3_000;

type FinanceDocumentExtractionConfiguration = Readonly<{
  readonly databaseUrl: string;
  readonly apiKey: string;
  readonly encodedKeyring: string;
  readonly storeDir: string;
  readonly pollIntervalMs: number;
}>;

const hasSafeExecutorDatabaseUrl = (input: string): boolean => {
  try {
    if (
      input !== input.trim() ||
      input.length > 4_096 ||
      Array.from(input).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
      })
    ) {
      return false;
    }
    const url = new URL(input);
    const forbiddenOverrides = [
      'user',
      'username',
      'password',
      'host',
      'port',
      'database',
      'dbname',
    ];
    return (
      (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
      decodeURIComponent(url.username) === 'emdo_worker_executor_login' &&
      url.password.length > 0 &&
      url.hostname.length > 0 &&
      url.pathname.length > 1 &&
      url.hash === '' &&
      forbiddenOverrides.every((name) => !url.searchParams.has(name))
    );
  } catch {
    return false;
  }
};

const FinanceDocumentExtractionConfigurationSchema = z.strictObject({
  enabled: z.literal('true'),
  databaseUrl: z.string().refine(hasSafeExecutorDatabaseUrl),
  apiKey: z
    .string()
    .min(16)
    .max(512)
    .regex(/^[A-Za-z0-9_-]+$/u),
  encodedKeyring: z
    .string()
    .min(1)
    .max(8_192)
    .regex(/^[A-Za-z0-9_-]+$/u),
  storeDir: z.string().min(1).max(4_096),
  pollIntervalMs: z.coerce.number().int().min(250).max(60_000),
});

const loadFinanceDocumentExtractionConfiguration = (
  environment: Readonly<Record<string, string | undefined>>,
): FinanceDocumentExtractionConfiguration => {
  const parsed = FinanceDocumentExtractionConfigurationSchema.safeParse({
    enabled: environment.EMDO_FINANCE_DOCUMENTS_ENABLED,
    databaseUrl: environment.EMDO_WORKER_EXECUTOR_DATABASE_URL,
    apiKey: environment.EMDO_OPENAI_FINANCE_API_KEY,
    encodedKeyring: environment.EMDO_FINANCE_DOCUMENT_KEYRING_B64URL,
    storeDir:
      environment.EMDO_FINANCE_DOCUMENT_STORE_DIR ??
      FINANCE_DOCUMENT_EXTRACTION_STORE_DIR,
    pollIntervalMs:
      environment.EMDO_FINANCE_DOCUMENT_EXTRACTION_POLL_MS ??
      DEFAULT_POLL_INTERVAL_MS,
  });
  if (!parsed.success) {
    throw new Error(
      'Finance document extraction worker configuration is invalid',
    );
  }
  let storeDir: string;
  try {
    storeDir = resolve(parsed.data.storeDir);
  } catch {
    throw new Error(
      'Finance document extraction worker configuration is invalid',
    );
  }
  if (storeDir !== FINANCE_DOCUMENT_EXTRACTION_STORE_DIR) {
    throw new Error(
      'Finance document extraction worker configuration is invalid',
    );
  }
  return Object.freeze({ ...parsed.data, storeDir });
};

type DatabaseFactory = (input: {
  readonly connectionString: string;
  readonly max?: number;
  readonly idleTimeoutMillis?: number;
  readonly connectionTimeoutMillis?: number;
  readonly applicationName?: string;
  readonly fixedRole: 'emdo_worker_executor';
}) => EmdoWorkerDatabaseClient;

type StorageOpener = typeof openFinanceDocumentStorageReadOnly;

type PollerStarter = typeof startFinanceDocumentExtractionPoller;

export interface FinanceDocumentExtractionWorkerHandle {
  stop(): Promise<void>;
}

const executorPoolFor = (pool: EmdoWorkerDatabaseClient['scopedPool']) =>
  Object.freeze({
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql: string, parameters?: readonly unknown[]) {
          const result = await client.query(sql, parameters);
          return {
            rows: [...result.rows],
            ...(result.rowCount === undefined
              ? {}
              : { rowCount: result.rowCount }),
          };
        },
        release: () => client.release(),
      };
    },
  });

const closeRuntime = async (input: {
  readonly poller?: FinanceDocumentExtractionPollerHandle;
  readonly database?: EmdoWorkerDatabaseClient;
  readonly disposeKeyProvider: () => void;
}): Promise<void> => {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => input.poller?.stop()),
    Promise.resolve().then(() => input.database?.close()),
  ]);
  try {
    input.disposeKeyProvider();
  } catch {
    // Every other owned resource was already asked to stop.
    throw new Error('Finance document extraction worker shutdown failed');
  }
  if (results.some((result) => result.status === 'rejected')) {
    throw new Error('Finance document extraction worker shutdown failed');
  }
};

export const startFinanceDocumentExtractionWorker = async (input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly onFatalError: () => void;
  readonly createDatabase?: DatabaseFactory;
  readonly openStorage?: StorageOpener;
  readonly startPoller?: PollerStarter;
}): Promise<FinanceDocumentExtractionWorkerHandle> => {
  let configuration: FinanceDocumentExtractionConfiguration;
  try {
    configuration = loadFinanceDocumentExtractionConfiguration(
      input.environment,
    );
  } catch {
    throw new Error('Finance document extraction worker startup failed');
  }

  let keyProvider:
    ReturnType<typeof createFinanceDocumentKeyProvider> | undefined;
  let database: EmdoWorkerDatabaseClient | undefined;
  let poller: FinanceDocumentExtractionPollerHandle | undefined;
  try {
    keyProvider = createFinanceDocumentKeyProvider(
      configuration.encodedKeyring,
    );
    const storage = await (
      input.openStorage ?? openFinanceDocumentStorageReadOnly
    )({
      root: configuration.storeDir,
      webRoot: resolve(process.cwd()),
      keyProvider,
    });
    database = (input.createDatabase ?? createDatabaseClient)({
      connectionString: configuration.databaseUrl,
      max: 1,
      applicationName: 'emdo-finance-document-extraction',
      fixedRole: 'emdo_worker_executor',
    });
    await database.checkReady({
      signal: AbortSignal.timeout(DATABASE_READINESS_TIMEOUT_MS),
    });
    const worker = createFinanceDocumentExtractionWorker({
      executor: new PostgresFinanceDocumentExtractionExecutor(
        executorPoolFor(database.scopedPool),
      ),
      originals: storage,
      payloadCrypto: new FinanceDocumentPayloadCrypto(keyProvider),
      extractor: new OpenAiFetchFinanceDocumentExtractionTransport({
        fetch,
        getApiKey: () => configuration.apiKey,
      }),
    });
    const controller = new AbortController();
    poller = (input.startPoller ?? startFinanceDocumentExtractionPoller)({
      worker,
      signal: controller.signal,
      pollIntervalMs: configuration.pollIntervalMs,
      onFatalError: () => {
        try {
          input.onFatalError();
        } catch {
          // Fatal notification cannot restart a failed extraction loop.
        }
      },
    });
    let stopPromise: Promise<void> | undefined;
    const configuredPoller = poller;
    const configuredDatabase = database;
    const configuredKeyProvider = keyProvider;
    return Object.freeze({
      stop(): Promise<void> {
        stopPromise ??= closeRuntime({
          poller: configuredPoller,
          database: configuredDatabase,
          disposeKeyProvider: () => configuredKeyProvider.dispose(),
        });
        return stopPromise;
      },
    });
  } catch {
    try {
      await closeRuntime({
        poller,
        database,
        disposeKeyProvider: () => keyProvider?.dispose(),
      });
    } catch {
      // Preserve the one safe startup error below.
    }
    throw new Error('Finance document extraction worker startup failed');
  }
};

export interface FinanceDocumentExtractionCliRuntime {
  exitCode: number | undefined;
  readonly stderr: { write(message: string): unknown };
  once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

type FinanceDocumentExtractionStarter = (input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly onFatalError: () => void;
}) => Promise<FinanceDocumentExtractionWorkerHandle>;

export const runFinanceDocumentExtractionCli = async (input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly runtime?: FinanceDocumentExtractionCliRuntime;
  readonly start?: FinanceDocumentExtractionStarter;
}): Promise<FinanceDocumentExtractionWorkerHandle> => {
  const runtime = input.runtime ?? process;
  const state: { worker?: FinanceDocumentExtractionWorkerHandle } = {};
  let stopPromise: Promise<void> | undefined;
  let stoppingForFatalError = false;
  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      runtime.off('SIGTERM', onSignal);
      runtime.off('SIGINT', onSignal);
      await state.worker?.stop();
    })();
    return stopPromise;
  };
  const onFatalError = (): void => {
    runtime.exitCode = 1;
    stoppingForFatalError = true;
    if (state.worker !== undefined) {
      void stop().catch(() => {
        // Exit status is already non-zero and no error details are safe here.
      });
    }
  };
  const onSignal = (): void => {
    void stop().catch(() => {
      runtime.exitCode = 1;
      runtime.stderr.write(
        'Finance document extraction worker shutdown failed.\n',
      );
    });
  };

  state.worker = await (input.start ?? startFinanceDocumentExtractionWorker)({
    environment: input.environment,
    onFatalError,
  });
  runtime.once('SIGTERM', onSignal);
  runtime.once('SIGINT', onSignal);
  if (stoppingForFatalError) {
    void stop().catch(() => {
      // Exit status is already non-zero and no error details are safe here.
    });
  }
  return Object.freeze({ stop });
};

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(invokedPath).href === import.meta.url
) {
  void runFinanceDocumentExtractionCli({ environment: process.env }).catch(
    () => {
      process.stderr.write(
        'Finance document extraction worker startup failed.\n',
      );
      process.exitCode = 1;
    },
  );
}

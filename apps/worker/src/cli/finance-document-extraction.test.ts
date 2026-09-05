import { resolve } from 'node:path';

import type { EmdoWorkerDatabaseClient } from '@emdo/db/worker';
import type { FinanceDocumentStorage } from '@emdo/integrations/finance-documents';
import { describe, expect, it, vi } from 'vitest';

import {
  FINANCE_DOCUMENT_EXTRACTION_STORE_DIR,
  runFinanceDocumentExtractionCli,
  startFinanceDocumentExtractionWorker,
} from './finance-document-extraction.js';
import type { FinanceDocumentExtractionPollerHandle } from '../finance-document-extraction-postgres.js';

const executorDatabaseUrl =
  'postgresql://emdo_worker_executor_login:executor-test@postgres/emdo_app';

const keyring = (fill: number): string =>
  Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      current: {
        keyVersion: 'finance-documents.v1',
        keyB64url: Buffer.alloc(32, fill).toString('base64url'),
      },
      previous: [],
    }),
    'utf8',
  ).toString('base64url');

const environment = (overrides: Record<string, string | undefined> = {}) => ({
  EMDO_FINANCE_DOCUMENTS_ENABLED: 'true',
  EMDO_WORKER_EXECUTOR_DATABASE_URL: executorDatabaseUrl,
  EMDO_OPENAI_FINANCE_API_KEY: 'finance-api-key-for-worker-test',
  EMDO_FINANCE_DOCUMENT_KEYRING_B64URL: keyring(61),
  ...overrides,
});

describe('finance document extraction worker CLI', () => {
  it('fails closed before opening resources when its dedicated configuration is incomplete or non-canonical', async () => {
    const createDatabase = vi.fn(() => {
      throw new Error('must not run');
    });
    const openStorage = vi.fn(async () => {
      throw new Error('must not run');
    });

    for (const invalid of [
      environment({ EMDO_FINANCE_DOCUMENTS_ENABLED: 'false' }),
      environment({ EMDO_OPENAI_FINANCE_API_KEY: undefined }),
      environment({ EMDO_FINANCE_DOCUMENT_KEYRING_B64URL: undefined }),
      environment({ EMDO_FINANCE_DOCUMENT_STORE_DIR: '/var/lib/emdo/other' }),
      environment({ EMDO_FINANCE_DOCUMENT_EXTRACTION_POLL_MS: '249' }),
      environment({ EMDO_FINANCE_DOCUMENT_EXTRACTION_POLL_MS: '60001' }),
    ]) {
      await expect(
        startFinanceDocumentExtractionWorker({
          environment: invalid,
          onFatalError() {},
          createDatabase,
          openStorage: openStorage as never,
        }),
      ).rejects.toThrow('Finance document extraction worker startup failed');
    }
    expect(createDatabase).not.toHaveBeenCalled();
    expect(openStorage).not.toHaveBeenCalled();
  });

  it('opens the canonical store read-only and composes one bounded poller with the executor role', async () => {
    const events: string[] = [];
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const database = {
      scopedPool: {
        async connect() {
          events.push('database:connect');
          return {
            query,
            release() {
              events.push('database:release');
            },
          };
        },
      },
      async checkReady() {
        events.push('database:ready');
      },
      async close() {
        events.push('database:close');
      },
    } as unknown as EmdoWorkerDatabaseClient;
    const createDatabase = vi.fn(() => database);
    const storage = {
      async *read() {
        yield new Uint8Array([1]);
      },
    } as unknown as FinanceDocumentStorage;
    const openStorage = vi.fn(async () => storage);
    let pollerInput: unknown;
    const startPoller = vi.fn((input) => {
      pollerInput = input;
      return {
        async stop() {
          events.push('poller:stop');
        },
      } satisfies FinanceDocumentExtractionPollerHandle;
    });

    const handle = await startFinanceDocumentExtractionWorker({
      environment: environment({
        EMDO_FINANCE_DOCUMENT_EXTRACTION_POLL_MS: '250',
      }),
      onFatalError() {},
      createDatabase,
      openStorage: openStorage as never,
      startPoller: startPoller as never,
    });

    expect(createDatabase).toHaveBeenCalledWith({
      connectionString: executorDatabaseUrl,
      max: 1,
      applicationName: 'emdo-finance-document-extraction',
      fixedRole: 'emdo_worker_executor',
    });
    expect(openStorage).toHaveBeenCalledWith(
      expect.objectContaining({
        root: FINANCE_DOCUMENT_EXTRACTION_STORE_DIR,
        webRoot: resolve(process.cwd()),
      }),
    );
    expect(pollerInput).toEqual(
      expect.objectContaining({
        pollIntervalMs: 250,
        signal: expect.any(AbortSignal),
        worker: expect.objectContaining({ runOnce: expect.any(Function) }),
      }),
    );
    await handle.stop();
    await handle.stop();
    expect(events).toEqual(['database:ready', 'poller:stop', 'database:close']);
    expect(query).not.toHaveBeenCalled();
  });

  it('removes signal handlers and exits cleanly when the serial poller reports a fatal error', async () => {
    const listeners = new Map<string, () => void>();
    const events: string[] = [];
    const runtime = {
      exitCode: undefined as number | undefined,
      stderr: {
        write(message: string) {
          events.push(`stderr:${message}`);
        },
      },
      once(signal: 'SIGINT' | 'SIGTERM', listener: () => void) {
        listeners.set(signal, listener);
      },
      off(signal: 'SIGINT' | 'SIGTERM') {
        events.push(`off:${signal}`);
        listeners.delete(signal);
      },
    };
    let reportFatal: (() => void) | undefined;

    const handle = await runFinanceDocumentExtractionCli({
      environment: {},
      runtime,
      async start({ onFatalError }) {
        reportFatal = onFatalError;
        return {
          async stop() {
            events.push('worker:stop');
          },
        };
      },
    });

    expect([...listeners.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);
    reportFatal?.();
    await vi.waitFor(() => expect(events).toContain('worker:stop'));
    expect(runtime.exitCode).toBe(1);
    expect(events).toEqual(['off:SIGTERM', 'off:SIGINT', 'worker:stop']);
    await handle.stop();
  });

  it('stops cleanly on SIGTERM without emitting document or provider details', async () => {
    const listeners = new Map<string, () => void>();
    const events: string[] = [];
    const runtime = {
      exitCode: undefined as number | undefined,
      stderr: {
        write(message: string) {
          events.push(`stderr:${message}`);
        },
      },
      once(signal: 'SIGINT' | 'SIGTERM', listener: () => void) {
        listeners.set(signal, listener);
      },
      off(signal: 'SIGINT' | 'SIGTERM') {
        events.push(`off:${signal}`);
        listeners.delete(signal);
      },
    };

    await runFinanceDocumentExtractionCli({
      environment: {},
      runtime,
      async start() {
        return {
          async stop() {
            events.push('worker:stop');
          },
        };
      },
    });

    listeners.get('SIGTERM')?.();
    await vi.waitFor(() => expect(events).toContain('worker:stop'));
    expect(runtime.exitCode).toBeUndefined();
    expect(events).toEqual(['off:SIGTERM', 'off:SIGINT', 'worker:stop']);
  });
});

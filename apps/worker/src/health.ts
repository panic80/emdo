import { createServer } from 'node:http';

import { z } from 'zod';

import type { WorkerProviderStatus } from './providers.js';

const WorkerHealthConfigSchema = z.strictObject({
  host: z.enum(['127.0.0.1', '0.0.0.0']),
  port: z.number().int().min(1).max(65_535),
});

export interface WorkerHealthConfig {
  readonly host: '127.0.0.1' | '0.0.0.0';
  readonly port: number;
}

export interface WorkerHealthServer {
  readonly port: number;
  setReady(ready: boolean): void;
  setProviderStatus(status: WorkerProviderStatus): void;
  close(): Promise<void>;
}

export interface WorkerHealthResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface WorkerHealthResponder {
  setReady(ready: boolean): void;
  setProviderStatus(status: WorkerProviderStatus): void;
  respond(input: {
    readonly method: string | undefined;
    readonly url: string | undefined;
  }): WorkerHealthResponse;
}

const parsePort = (value: string | undefined): number => {
  const input = value ?? '3001';
  if (!/^[1-9][0-9]{0,4}$/u.test(input)) return Number.NaN;
  return Number(input);
};

export const loadWorkerHealthConfig = (
  environment: Readonly<Record<string, string | undefined>>,
): WorkerHealthConfig => {
  const parsed = WorkerHealthConfigSchema.safeParse({
    host: environment.HEALTH_HOST ?? '127.0.0.1',
    port: parsePort(environment.HEALTH_PORT),
  });
  if (!parsed.success) {
    throw new Error('Worker health configuration is invalid');
  }
  return Object.freeze(parsed.data);
};

const createJsonResponse = (
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
  extraHeaders: Readonly<Record<string, string>> = {},
): WorkerHealthResponse => {
  const payload = JSON.stringify(body);
  return Object.freeze({
    statusCode,
    headers: Object.freeze({
      'cache-control': 'no-store',
      'content-length': String(Buffer.byteLength(payload)),
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    }),
    body: payload,
  });
};

export const createWorkerHealthResponder = (): WorkerHealthResponder => {
  let ready = false;
  let providers:
    | WorkerProviderStatus
    | Readonly<{
        overall: 'unknown';
        email: 'unknown';
        push: 'unknown';
        calendar: 'unknown';
      }> = Object.freeze({
    overall: 'unknown',
    email: 'unknown',
    push: 'unknown',
    calendar: 'unknown',
  });
  return Object.freeze({
    setReady(value: boolean) {
      ready = value;
    },
    setProviderStatus(status: WorkerProviderStatus) {
      providers = Object.freeze({ ...status });
    },
    respond(input: {
      readonly method: string | undefined;
      readonly url: string | undefined;
    }): WorkerHealthResponse {
      if (input.method !== 'GET') {
        return createJsonResponse(
          405,
          { status: 'method-not-allowed' },
          { allow: 'GET' },
        );
      }
      const path = input.url?.split('?', 1)[0];
      if (path === '/healthz') {
        return createJsonResponse(200, { status: 'ok', providers });
      }
      if (path === '/readyz') {
        return createJsonResponse(
          ready ? 200 : 503,
          ready ? { status: 'ready', providers } : { status: 'not-ready' },
        );
      }
      return createJsonResponse(404, { status: 'not-found' });
    },
  });
};

export const createWorkerHealthServer = async (
  input: WorkerHealthConfig | { readonly host: '127.0.0.1'; readonly port: 0 },
): Promise<WorkerHealthServer> => {
  const responder = createWorkerHealthResponder();
  const server = createServer(
    {
      headersTimeout: 5_000,
      requestTimeout: 5_000,
      keepAliveTimeout: 1_000,
    },
    (request, response) => {
      const result = responder.respond({
        method: request.method,
        url: request.url,
      });
      response.writeHead(result.statusCode, result.headers);
      response.end(result.body);
    },
  );
  server.maxHeadersCount = 32;

  await new Promise<void>((resolve, reject) => {
    const onError = () => {
      server.off('listening', onListening);
      reject(new Error('Worker health server failed to start'));
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(input.port, input.host);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Worker health server failed to start');
  }

  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    port: address.port,
    setReady(value: boolean) {
      responder.setReady(value);
    },
    setProviderStatus(status: WorkerProviderStatus) {
      responder.setProviderStatus(status);
    },
    close(): Promise<void> {
      responder.setReady(false);
      closePromise ??= new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(new Error('Worker health server failed to stop'));
        });
      });
      return closePromise;
    },
  });
};

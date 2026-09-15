import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import {
  FinanceImageOcrApprovedRuntimeManifestSchema,
  FinanceImageOcrCommandError,
  FinanceImageOcrEngineProvenanceSchema,
  FINANCE_IMAGE_OCR_LIMITS,
  parseFinanceImageFormat,
  type FinanceImageFormat,
  type FinanceImageOcrApprovedRuntimeManifest,
  type FinanceImageOcrLimits,
  type FinanceImageOcrRuntime,
} from '@emdo/integrations/finance-documents';
import type { SpawnOptions } from 'node:child_process';

/**
 * Fixed helper boundary used by the worker. The helper is installed by the
 * release-owned OCR runtime package; callers cannot provide an executable or
 * arguments through a document, request, or OCR payload.
 */
export const FINANCE_IMAGE_OCR_HELPER_EXECUTABLE =
  '/usr/local/bin/emdo-finance-ocr-helper';
/** Fixed local-only channel. It is never a TCP address or a Docker socket. */
export const FINANCE_IMAGE_OCR_HELPER_SOCKET_PATH =
  '/run/emdo/finance-ocr/helper.sock';
export const FINANCE_IMAGE_OCR_MANIFEST_PATH =
  '/usr/local/share/emdo/finance-ocr-runtime.json';

const PROTOCOL_REQUEST = 'EMDO-FINANCE-OCR-HELPER-V1';
const PROTOCOL_RESPONSE = 'EMDO-FINANCE-OCR-HELPER-V1-RESPONSE';
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const SAFE_HELPER_ENV = Object.freeze({
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/tmp',
  LANG: 'C',
  LC_ALL: 'C',
  TMPDIR: '/tmp',
  EMDO_FINANCE_IMAGE_OCR_MANIFEST: FINANCE_IMAGE_OCR_MANIFEST_PATH,
  MAGICK_CONFIGURE_PATH: '/etc/ImageMagick-6',
  TESSDATA_PREFIX: '/usr/share/tesseract-ocr/5/tessdata',
});
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_PROTOCOL_HEADER_BYTES = 16 * 1024;
const MAX_PROTOCOL_RESULT_BYTES = FINANCE_IMAGE_OCR_LIMITS.maxOutputBytes;
const MAX_PROTOCOL_PGM_BYTES = FINANCE_IMAGE_OCR_LIMITS.maxDecodedBytes;

export async function readFinanceImageOcrApprovedRuntimeManifest(): Promise<FinanceImageOcrApprovedRuntimeManifest> {
  let contents: Buffer;
  try {
    contents = await readFile(FINANCE_IMAGE_OCR_MANIFEST_PATH);
  } catch {
    throw new Error('finance-image-ocr-manifest-unavailable');
  }
  try {
    return FinanceImageOcrApprovedRuntimeManifestSchema.parse(
      JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(contents)),
    );
  } catch {
    throw new Error('finance-image-ocr-manifest-invalid');
  }
}

const responseLimitFor = (
  operation: HelperOperation,
  limits: FinanceImageOcrLimits,
): number =>
  MAX_PROTOCOL_HEADER_BYTES +
  MAX_MANIFEST_BYTES +
  limits.maxOutputBytes +
  (operation === 'decode' ? limits.maxDecodedBytes : 0);

type HelperOperation =
  'verify' | 'identify' | 'decode' | 'describe' | 'recognize';
export type FinanceImageOcrHelperLanguage = 'eng' | 'fra' | 'eng+fra';

interface HelperRequest {
  readonly operation: HelperOperation;
  readonly format: FinanceImageFormat;
  readonly language: FinanceImageOcrHelperLanguage;
  readonly sourceDigest: string;
  readonly source: Uint8Array;
  readonly payload: Uint8Array;
  readonly limits: FinanceImageOcrLimits;
  readonly timeoutMs: number;
}

interface ParsedHelperResponse {
  readonly operation: HelperOperation;
  readonly sourceDigest: string;
  readonly manifest: FinanceImageOcrApprovedRuntimeManifest;
  readonly result: Buffer;
  readonly pgm: Buffer;
}

/** Injectable only for deterministic tests; production uses the fixed Node spawn. */
export type FinanceImageOcrHelperSpawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

const defaultSpawn: FinanceImageOcrHelperSpawn = (command, args, options) =>
  spawn(command, args, options) as ChildProcessWithoutNullStreams;

export type FinanceImageOcrUnixSocketConnect = (path: string) => Socket;

const defaultUnixSocketConnect: FinanceImageOcrUnixSocketConnect = (path) =>
  createConnection({ path });

export interface FinanceImageOcrHelperChannelRequest {
  readonly bytes: Buffer;
  readonly responseLimit: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly operation: HelperOperation;
}

export interface FinanceImageOcrHelperChannel {
  send(input: FinanceImageOcrHelperChannelRequest): Promise<Buffer>;
}

const validateSocketPath = (value: string): string => {
  if (value !== FINANCE_IMAGE_OCR_HELPER_SOCKET_PATH)
    throw new Error('finance-image-ocr-helper-socket-path-invalid');
  return value;
};

export function createFinanceImageOcrUnixSocketChannel(
  options: {
    readonly socketPath?: string;
    readonly connect?: FinanceImageOcrUnixSocketConnect;
  } = {},
): FinanceImageOcrHelperChannel {
  const socketPath = validateSocketPath(
    options.socketPath ?? FINANCE_IMAGE_OCR_HELPER_SOCKET_PATH,
  );
  const connect = options.connect ?? defaultUnixSocketConnect;
  return {
    send(input) {
      return runUnixSocketHelper({
        request: input.bytes,
        responseLimit: input.responseLimit,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        operation: input.operation,
        socketPath,
        connect,
      });
    },
  };
}

const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

const canonicalManifest = (
  manifest: FinanceImageOcrApprovedRuntimeManifest,
): string =>
  JSON.stringify({
    magick: {
      path: manifest.magick.path,
      sha256: manifest.magick.sha256,
    },
    tesseract: {
      path: manifest.tesseract.path,
      sha256: manifest.tesseract.sha256,
      version: manifest.tesseract.version,
    },
    trainedData: manifest.trainedData.map((entry) => ({
      language: entry.language,
      path: entry.path,
      sha256: entry.sha256,
    })),
  });

const validateHelperExecutable = (value: string): string => {
  if (value !== FINANCE_IMAGE_OCR_HELPER_EXECUTABLE)
    throw new Error('finance-image-ocr-helper-path-invalid');
  return value;
};

const parseBoundedLength = (
  value: string | undefined,
  maximum: number,
  name: string,
): number => {
  if (!value || !/^\d+$/u.test(value))
    throw new Error(`finance-image-ocr-helper-${name}-invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum)
    throw new Error(`finance-image-ocr-helper-${name}-limit`);
  return parsed;
};

const readHeaderLine = (
  bytes: Buffer,
  offset: number,
): { readonly line: string; readonly next: number } | undefined => {
  const end = bytes.indexOf(0x0a, offset);
  if (end < 0 || end - offset > MAX_PROTOCOL_HEADER_BYTES) return undefined;
  let line = bytes.subarray(offset, end).toString('utf8');
  if (line.endsWith('\r')) line = line.slice(0, -1);
  return { line, next: end + 1 };
};

const parseResponse = (
  bytes: Buffer,
  expectedOperation: HelperOperation,
  expectedSourceDigest: string,
  expectedManifest: FinanceImageOcrApprovedRuntimeManifest,
  limits: FinanceImageOcrLimits,
): ParsedHelperResponse => {
  let cursor = 0;
  const first = readHeaderLine(bytes, cursor);
  if (!first || first.line !== PROTOCOL_RESPONSE)
    throw new FinanceImageOcrCommandError('ocr-output-invalid');
  cursor = first.next;
  const headers = new Map<string, string>();
  for (;;) {
    if (cursor > MAX_PROTOCOL_HEADER_BYTES)
      throw new FinanceImageOcrCommandError('ocr-output-invalid');
    const current = readHeaderLine(bytes, cursor);
    if (!current) throw new FinanceImageOcrCommandError('ocr-output-invalid');
    cursor = current.next;
    if (current.line === '') break;
    const separator = current.line.indexOf('=');
    if (separator <= 0 || headers.has(current.line.slice(0, separator)))
      throw new FinanceImageOcrCommandError('ocr-output-invalid');
    const key = current.line.slice(0, separator);
    const value = current.line.slice(separator + 1);
    const hasControlCharacter = [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    });
    if (!/^[a-z][a-z0-9-]*$/u.test(key) || hasControlCharacter)
      throw new FinanceImageOcrCommandError('ocr-output-invalid');
    headers.set(key, value);
  }

  if (headers.get('status') !== 'ok')
    throw new FinanceImageOcrCommandError('ocr-output-invalid');
  const requiredHeaders = new Set([
    'status',
    'operation',
    'source-sha256',
    'manifest-length',
    'result-length',
    'pgm-length',
  ]);
  if (
    headers.size !== requiredHeaders.size ||
    [...requiredHeaders].some((key) => !headers.has(key))
  )
    throw new FinanceImageOcrCommandError('ocr-output-invalid');
  if (headers.get('operation') !== expectedOperation)
    throw new FinanceImageOcrCommandError('ocr-output-invalid');
  if (headers.get('source-sha256') !== expectedSourceDigest)
    throw new FinanceImageOcrCommandError('ocr-provenance-unavailable');

  const manifestLength = parseBoundedLength(
    headers.get('manifest-length'),
    MAX_MANIFEST_BYTES,
    'manifest',
  );
  const resultLength = parseBoundedLength(
    headers.get('result-length'),
    Math.min(limits.maxOutputBytes, MAX_PROTOCOL_RESULT_BYTES),
    'result',
  );
  const pgmLength = parseBoundedLength(
    headers.get('pgm-length'),
    Math.min(limits.maxDecodedBytes, MAX_PROTOCOL_PGM_BYTES),
    'pgm',
  );
  if (bytes.byteLength !== cursor + manifestLength + resultLength + pgmLength)
    throw new FinanceImageOcrCommandError('ocr-output-invalid');

  const manifestBytes = bytes.subarray(cursor, cursor + manifestLength);
  cursor += manifestLength;
  const result = bytes.subarray(cursor, cursor + resultLength);
  cursor += resultLength;
  const pgm = bytes.subarray(cursor, cursor + pgmLength);
  let manifest: FinanceImageOcrApprovedRuntimeManifest;
  try {
    manifest = FinanceImageOcrApprovedRuntimeManifestSchema.parse(
      JSON.parse(
        new TextDecoder('utf8', { fatal: true }).decode(manifestBytes),
      ),
    );
  } catch {
    throw new FinanceImageOcrCommandError('ocr-provenance-unavailable');
  }
  if (canonicalManifest(manifest) !== canonicalManifest(expectedManifest))
    throw new FinanceImageOcrCommandError('ocr-provenance-unavailable');
  return {
    operation: expectedOperation,
    sourceDigest: expectedSourceDigest,
    manifest,
    result: Buffer.from(result),
    pgm: Buffer.from(pgm),
  };
};

const stageUnavailableReason = (
  operation: HelperOperation,
): 'decoder-unavailable' | 'ocr-unavailable' | 'ocr-provenance-unavailable' =>
  operation === 'verify' || operation === 'describe'
    ? 'ocr-provenance-unavailable'
    : operation === 'recognize'
      ? 'ocr-unavailable'
      : 'decoder-unavailable';

const stageFailureReason = (
  operation: HelperOperation,
): 'decode-failed' | 'ocr-failed' | 'worker-failed' =>
  operation === 'verify'
    ? 'worker-failed'
    : operation === 'describe' || operation === 'recognize'
      ? 'ocr-failed'
      : 'decode-failed';

const killProcessGroup = (child: ChildProcessWithoutNullStreams): void => {
  if (
    process.platform !== 'win32' &&
    child.pid !== undefined &&
    child.pid > 0
  ) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // The group may have exited; fall through to the direct child.
    }
  }
  child.kill('SIGKILL');
};

const requestBytes = (request: HelperRequest): Buffer => {
  const source = Buffer.from(request.source);
  const payload = Buffer.from(request.payload);
  const sourceCheck = source.byteLength > 0 ? 'required' : 'none';
  const header = [
    PROTOCOL_REQUEST,
    `operation=${request.operation}`,
    `format=${request.format}`,
    `language=${request.language}`,
    `source-check=${sourceCheck}`,
    `source-sha256=${request.sourceDigest}`,
    `source-length=${source.byteLength}`,
    `payload-length=${payload.byteLength}`,
    `max-bytes=${request.limits.maxBytes}`,
    `max-pixels=${request.limits.maxPixels}`,
    `max-dimension=${request.limits.maxDimension}`,
    `max-words=${request.limits.maxWords}`,
    `max-text-characters=${request.limits.maxTextCharacters}`,
    `max-decoded-bytes=${request.limits.maxDecodedBytes}`,
    `max-output-bytes=${request.limits.maxOutputBytes}`,
    `timeout-ms=${request.timeoutMs}`,
    '',
    '',
  ].join('\n');
  return Buffer.concat([Buffer.from(header, 'ascii'), source, payload]);
};

const runProcessHelper = async (input: {
  readonly request: HelperRequest;
  readonly expectedManifest: FinanceImageOcrApprovedRuntimeManifest;
  readonly helperExecutable: string;
  readonly spawnProcess: FinanceImageOcrHelperSpawn;
  readonly signal?: AbortSignal;
}): Promise<ParsedHelperResponse> => {
  const request = requestBytes(input.request);
  const operation = input.request.operation;
  const responseLimit = responseLimitFor(operation, input.request.limits);
  if (!Number.isSafeInteger(responseLimit))
    throw new FinanceImageOcrCommandError('worker-failed');
  if (input.signal?.aborted) throw new FinanceImageOcrCommandError('aborted');

  let child: ChildProcessWithoutNullStreams;
  try {
    child = input.spawnProcess(input.helperExecutable, [], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: SAFE_HELPER_ENV,
      cwd: '/tmp',
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
  } catch {
    throw new FinanceImageOcrCommandError(stageUnavailableReason(operation));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let outputBytes = 0;
    const output: Buffer[] = [];
    const cleanup = () => {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      request.fill(0);
    };
    const terminate = (error: FinanceImageOcrCommandError) => {
      if (settled) return;
      settled = true;
      cleanup();
      killProcessGroup(child);
      reject(error);
    };
    const onAbort = () => terminate(new FinanceImageOcrCommandError('aborted'));
    const timer = setTimeout(
      () => terminate(new FinanceImageOcrCommandError('timeout')),
      input.request.timeoutMs,
    );

    child.stdout.on('data', (chunk: Buffer | Uint8Array) => {
      if (settled) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += value.byteLength;
      if (outputBytes > responseLimit) {
        terminate(
          new FinanceImageOcrCommandError(
            operation === 'decode' ? 'decode-output-limit' : 'output-limit',
          ),
        );
        return;
      }
      output.push(value);
    });
    // Drain diagnostics without retaining potentially unbounded native output.
    child.stderr.on('data', () => undefined);
    child.stdin.on('error', () => undefined);
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      terminate(
        new FinanceImageOcrCommandError(
          error.code === 'ENOENT'
            ? stageUnavailableReason(operation)
            : stageFailureReason(operation),
        ),
      );
    });
    child.once('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code !== 0) {
        reject(new FinanceImageOcrCommandError(stageFailureReason(operation)));
        return;
      }
      try {
        resolve(
          parseResponse(
            Buffer.concat(output, outputBytes),
            operation,
            input.request.sourceDigest,
            input.expectedManifest,
            input.request.limits,
          ),
        );
      } catch (error) {
        reject(error);
      }
    });

    input.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      child.stdin.end(request);
    } catch {
      terminate(new FinanceImageOcrCommandError(stageFailureReason(operation)));
    }
  });
};

const runUnixSocketHelper = async (input: {
  readonly request: Buffer;
  readonly responseLimit: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly operation: HelperOperation;
  readonly socketPath: string;
  readonly connect: FinanceImageOcrUnixSocketConnect;
}): Promise<Buffer> => {
  if (input.signal?.aborted) throw new FinanceImageOcrCommandError('aborted');
  let socket: Socket;
  try {
    socket = input.connect(input.socketPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new FinanceImageOcrCommandError(
      code === 'ENOENT' || code === 'ECONNREFUSED'
        ? stageUnavailableReason(input.operation)
        : stageFailureReason(input.operation),
    );
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let outputBytes = 0;
    const output: Buffer[] = [];
    const cleanup = () => {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      socket.removeAllListeners();
      socket.destroy();
      input.request.fill(0);
    };
    const terminate = (error: FinanceImageOcrCommandError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => terminate(new FinanceImageOcrCommandError('aborted'));
    const timer = setTimeout(
      () => terminate(new FinanceImageOcrCommandError('timeout')),
      input.timeoutMs,
    );
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer | Uint8Array) => {
      if (settled) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += value.byteLength;
      if (outputBytes > input.responseLimit) {
        terminate(
          new FinanceImageOcrCommandError(
            input.operation === 'decode'
              ? 'decode-output-limit'
              : 'output-limit',
          ),
        );
        return;
      }
      output.push(value);
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      terminate(
        new FinanceImageOcrCommandError(
          error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
            ? stageUnavailableReason(input.operation)
            : stageFailureReason(input.operation),
        ),
      );
    });
    socket.once('close', () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(output, outputBytes));
    });
    input.signal?.addEventListener('abort', onAbort, { once: true });
    socket.once('connect', () => {
      if (settled) return;
      socket.end(input.request);
    });
  });
};

const decodeUtf8 = (
  bytes: Uint8Array,
  reason: 'decode-failed' | 'ocr-output-invalid',
) => {
  try {
    return new TextDecoder('utf8', { fatal: true }).decode(bytes);
  } catch {
    throw new FinanceImageOcrCommandError(reason);
  }
};

const parseIdentify = (
  bytes: Uint8Array,
): {
  readonly format: FinanceImageFormat;
  readonly width: number;
  readonly height: number;
  readonly orientation: string;
  readonly frameCount: number;
} => {
  const text = decodeUtf8(bytes, 'decode-failed').trim();
  const match = /^([^\s]+)\s+(\d+)\s+(\d+)\s+([^\s]+)\s+(\d+)$/u.exec(text);
  if (!match) throw new FinanceImageOcrCommandError('decode-failed');
  const format = parseFinanceImageFormat(match[1]!);
  const width = Number(match[2]);
  const height = Number(match[3]);
  const frameCount = Number(match[5]);
  if (
    !Number.isSafeInteger(width) ||
    width < 1 ||
    !Number.isSafeInteger(height) ||
    height < 1 ||
    !Number.isSafeInteger(frameCount) ||
    frameCount < 1
  )
    throw new FinanceImageOcrCommandError('decode-failed');
  return { format, width, height, orientation: match[4]!, frameCount };
};

const parseHelperLanguage = (
  value: string | undefined,
): FinanceImageOcrHelperLanguage => {
  if (value === undefined || value === 'eng') return 'eng';
  if (value === 'fra') return 'fra';
  if (value === 'eng+fra') return 'eng+fra';
  throw new Error('finance-image-ocr-language-invalid');
};

export interface FinanceImageOcrIsolatedRuntimeOptions {
  readonly format: FinanceImageFormat;
  readonly expectedSourceDigest: string;
  readonly approvedManifest: FinanceImageOcrApprovedRuntimeManifest;
  readonly language?: FinanceImageOcrHelperLanguage;
  /** A trusted supervisor channel; production defaults to the fixed Unix socket. */
  readonly helperChannel?: FinanceImageOcrHelperChannel;
  readonly socketPath?: string;
  readonly connectUnixSocket?: FinanceImageOcrUnixSocketConnect;
  /** Tests may replace process creation; production does not use this path. */
  readonly spawnProcess?: FinanceImageOcrHelperSpawn;
  /** Only the fixed release helper path is accepted when testing stdio. */
  readonly helperExecutable?: string;
}

/**
 * Creates the worker runtime backed by the dedicated Unix socket. The socket
 * receives no caller-supplied path or arguments. The optional injected stdio
 * process path exists for tests; production container isolation requires the
 * deployment supervisor to run the helper in the restricted OCR image.
 */
export function createFinanceImageOcrIsolatedRuntime(
  options: FinanceImageOcrIsolatedRuntimeOptions,
): FinanceImageOcrRuntime {
  const expectedSourceDigest = options.expectedSourceDigest;
  if (!SHA256_HEX.test(expectedSourceDigest))
    throw new Error('finance-image-ocr-source-digest-invalid');
  const approvedManifest = FinanceImageOcrApprovedRuntimeManifestSchema.parse(
    options.approvedManifest,
  );
  const helperExecutable = validateHelperExecutable(
    options.helperExecutable ?? FINANCE_IMAGE_OCR_HELPER_EXECUTABLE,
  );
  const spawnProcess = options.spawnProcess ?? defaultSpawn;
  const helperChannel =
    options.helperChannel ??
    (options.spawnProcess
      ? undefined
      : createFinanceImageOcrUnixSocketChannel({
          socketPath: options.socketPath,
          connect: options.connectUnixSocket,
        }));
  const format = parseFinanceImageFormat(options.format);
  const language = parseHelperLanguage(options.language);
  let originalSource: Buffer | undefined;
  const request = async (input: {
    readonly operation: HelperOperation;
    readonly source?: Uint8Array;
    readonly payload?: Uint8Array;
    readonly limits: FinanceImageOcrLimits;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }): Promise<ParsedHelperResponse> => {
    const source = input.source ?? new Uint8Array();
    if (source.byteLength > 0 && sha256(source) !== expectedSourceDigest)
      throw new FinanceImageOcrCommandError('ocr-provenance-unavailable');
    if (source.byteLength > FINANCE_IMAGE_OCR_LIMITS.maxBytes)
      throw new FinanceImageOcrCommandError('bytes-limit');
    const helperRequest: HelperRequest = {
      operation: input.operation,
      format,
      language,
      sourceDigest: expectedSourceDigest,
      source,
      payload: input.payload ?? new Uint8Array(),
      limits: input.limits,
      timeoutMs: input.timeoutMs,
    };
    const request = requestBytes(helperRequest);
    const responseLimit = responseLimitFor(input.operation, input.limits);
    if (helperChannel) {
      const response = await helperChannel.send({
        bytes: request,
        responseLimit,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        operation: input.operation,
      });
      return parseResponse(
        response,
        input.operation,
        expectedSourceDigest,
        approvedManifest,
        input.limits,
      );
    }
    return runProcessHelper({
      request: helperRequest,
      expectedManifest: approvedManifest,
      helperExecutable,
      spawnProcess,
      signal: input.signal,
    });
  };

  return {
    async verify(input) {
      await request({
        operation: 'verify',
        limits: { ...FINANCE_IMAGE_OCR_LIMITS, timeoutMs: input.timeoutMs },
        timeoutMs: input.timeoutMs,
        signal: input.signal,
      });
    },
    async identify(input) {
      originalSource = Buffer.from(input.bytes);
      const result = await request({
        operation: 'identify',
        source: input.bytes,
        limits: input.limits,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
      });
      return parseIdentify(result.result);
    },
    async describe(input) {
      const result = await request({
        operation: 'describe',
        limits: { ...FINANCE_IMAGE_OCR_LIMITS, timeoutMs: input.timeoutMs },
        timeoutMs: input.timeoutMs,
        signal: input.signal,
      });
      try {
        return FinanceImageOcrEngineProvenanceSchema.parse(
          JSON.parse(decodeUtf8(result.result, 'ocr-output-invalid')),
        );
      } catch (error) {
        if (error instanceof FinanceImageOcrCommandError) throw error;
        throw new FinanceImageOcrCommandError('ocr-provenance-unavailable');
      }
    },
    async decodeToPgm(input) {
      if (!originalSource) originalSource = Buffer.from(input.bytes);
      const result = await request({
        operation: 'decode',
        source: input.bytes,
        limits: input.limits,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
      });
      return result.pgm;
    },
    async recognizeTsv(input) {
      if (!originalSource)
        throw new FinanceImageOcrCommandError('ocr-provenance-unavailable');
      try {
        const result = await request({
          operation: 'recognize',
          // Re-send the original so the helper verifies the source digest for
          // the OCR stage as well as for identify/decode.
          source: originalSource,
          payload: input.pgm,
          limits: input.limits,
          timeoutMs: input.timeoutMs,
          signal: input.signal,
        });
        return decodeUtf8(result.result, 'ocr-output-invalid');
      } finally {
        originalSource.fill(0);
        originalSource = undefined;
      }
    },
  };
}

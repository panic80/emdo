import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { FinancePdfPageRenderSchema } from '@emdo/contracts';
import type { FinancePdfPageRenderResult } from './pdf-page-render.js';

export const FINANCE_PDF_RENDER_HELPER =
  '/usr/local/bin/emdo-finance-pdf-render-helper';
export const FINANCE_PDF_RENDER_SOCKET =
  '/run/emdo/finance-pdf-render/helper.sock';
const requestMagic = Buffer.from('EMDO-FINANCE-PDF-RENDER-V1\n');
const responseMagic = Buffer.from('EMDO-FINANCE-PDF-RENDER-V1-RESPONSE\n');
const maxBytes = 2 * 1024 * 1024;
export type FinancePdfRenderSpawn = (
  executable: string,
  args: readonly string[],
  options: {
    detached: true;
    stdio: ['pipe', 'pipe', 'pipe'];
    cwd: string;
    env: Readonly<Record<string, string>>;
  },
) => ChildProcessWithoutNullStreams;

/** A killable process boundary, not an OS sandbox. Release supervision must
 * additionally deny network/credentials and cap native memory/CPU/processes. */
export function createFinancePdfIsolatedRenderer(
  options: {
    /** Test-only seam: production always executes the fixed release helper. */
    spawnProcess?: FinancePdfRenderSpawn;
    transport?: 'unix-socket' | 'process';
    /** Test-only socket connector; the release socket path is fixed. */
    connectUnixSocket?: (path: string) => Socket;
    timeoutMs?: number;
  } = {},
) {
  const transport =
    options.transport ?? (options.spawnProcess ? 'process' : 'unix-socket');
  if (
    (transport === 'unix-socket' && options.spawnProcess) ||
    (transport === 'process' && options.connectUnixSocket)
  )
    throw new Error('pdf-render-transport-conflict');
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000)
    throw new Error('pdf-render-timeout-invalid');
  return {
    async render(input: {
      bytes: Uint8Array;
      expectedSourceDigest: string;
      pageNumber: number;
      scale?: number;
      signal: AbortSignal;
    }): Promise<FinancePdfPageRenderResult> {
      const unavailable = (
        reason:
          | 'invalid'
          | 'bytes-limit'
          | 'source-digest-mismatch'
          | 'aborted'
          | 'timeout'
          | 'worker-failed'
          | 'output-limit',
      ): FinancePdfPageRenderResult => ({ status: 'unavailable', reason });
      if (input.signal.aborted) return unavailable('aborted');
      if (
        !(input.bytes instanceof Uint8Array) ||
        !input.bytes.length ||
        !Number.isInteger(input.pageNumber) ||
        input.pageNumber < 1 ||
        input.pageNumber > 25
      )
        return unavailable('invalid');
      if (input.bytes.length > maxBytes) return unavailable('bytes-limit');
      const scale = input.scale ?? 2;
      if (!Number.isFinite(scale) || scale <= 0 || scale > 4)
        return unavailable('invalid');
      if (
        createHash('sha256').update(input.bytes).digest('hex') !==
        input.expectedSourceDigest
      )
        return unavailable('source-digest-mismatch');
      const source = Buffer.from(input.bytes);
      const header = Buffer.from(
        JSON.stringify({
          sourceDigest: input.expectedSourceDigest,
          pageNumber: input.pageNumber,
          scale,
          byteLength: source.length,
        }),
      );
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(header.length);
      const request = Buffer.concat([requestMagic, prefix, header, source]);
      source.fill(0);
      return new Promise((resolve) => {
        let child: ChildProcessWithoutNullStreams | undefined;
        let socket: Socket | undefined;
        let stdin: Writable, stdout: Readable, stderr: Readable | undefined;
        let onClose: (callback: (code: number | null) => void) => void;
        let onError: (callback: () => void) => void;
        try {
          if (transport === 'unix-socket') {
            socket = (
              options.connectUnixSocket ??
              ((path) => connect({ path, allowHalfOpen: true }))
            )(FINANCE_PDF_RENDER_SOCKET);
            stdin = stdout = socket;
            onClose = (callback) => {
              socket!.once('end', () => callback(0));
              socket!.once('close', () => callback(1));
            };
            onError = (callback) => {
              socket!.on('error', callback);
            };
          } else {
            child = (
              options.spawnProcess ??
              ((executable, args, settings) =>
                spawn(executable, [...args], settings))
            )(FINANCE_PDF_RENDER_HELPER, [], {
              detached: true,
              stdio: ['pipe', 'pipe', 'pipe'],
              cwd: '/tmp',
              env: {
                PATH: '/usr/local/bin:/usr/bin:/bin',
                HOME: '/tmp',
                TMPDIR: '/tmp',
                LANG: 'C',
                LC_ALL: 'C',
                NODE_NO_WARNINGS: '1',
              },
            });
            stdin = child.stdin;
            stdout = child.stdout;
            stderr = child.stderr;
            onClose = (callback) => {
              child!.once('close', callback);
            };
            onError = (callback) => {
              child!.on('error', callback);
            };
          }
        } catch {
          request.fill(0);
          resolve(unavailable('worker-failed'));
          return;
        }
        let settled = false,
          received = 0;
        const chunks: Buffer[] = [];
        const kill = () => {
          socket?.destroy();
          if (child?.pid) {
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {
              /* Already exited. */
            }
          }
        };
        const finish = (result: FinancePdfPageRenderResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          input.signal.removeEventListener('abort', abort);
          kill();
          stdin.destroy();
          stdout.destroy();
          stderr?.destroy();
          request.fill(0);
          for (const chunk of chunks) chunk.fill(0);
          resolve(result);
        };
        const abort = () => finish(unavailable('aborted'));
        const timer = setTimeout(
          () => finish(unavailable('timeout')),
          timeoutMs,
        );
        input.signal.addEventListener('abort', abort, { once: true });
        stderr?.on('error', () => finish(unavailable('worker-failed')));
        let diagnosticBytes = 0;
        stderr?.on('data', (chunk: Buffer) => {
          diagnosticBytes += chunk.length;
          if (diagnosticBytes > 4096) finish(unavailable('output-limit'));
        });
        onError(() => finish(unavailable('worker-failed')));
        stdin.on('error', () => finish(unavailable('worker-failed')));
        stdout.on('error', () => finish(unavailable('worker-failed')));
        stdout.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxBytes + 4096) {
            finish(unavailable('output-limit'));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        onClose((code) => {
          if (settled) return;
          if (code !== 0) {
            finish(unavailable('worker-failed'));
            return;
          }
          try {
            const frame = Buffer.concat(chunks);
            if (
              !frame.subarray(0, responseMagic.length).equals(responseMagic) ||
              frame.length < responseMagic.length + 4
            )
              throw new Error('frame');
            const length = frame.readUInt32BE(responseMagic.length);
            if (
              length < 1 ||
              length > 2048 ||
              frame.length < responseMagic.length + 4 + length
            )
              throw new Error('header');
            const value = JSON.parse(
              frame
                .subarray(
                  responseMagic.length + 4,
                  responseMagic.length + 4 + length,
                )
                .toString('utf8'),
            );
            const expectedKeys =
              value.status === 'rendered'
                ? 'pngBytes,render,runtime,status'
                : 'pngBytes,reason,runtime,status';
            if (
              !value ||
              typeof value !== 'object' ||
              Object.keys(value).sort().join(',') !== expectedKeys ||
              !value.runtime ||
              Object.keys(value.runtime).sort().join(',') !==
                'canvasVersion,pdfjsVersion'
            )
              throw new Error('header-keys');
            if (
              value.runtime?.pdfjsVersion !== '5.4.296' ||
              value.runtime?.canvasVersion !== '0.1.80'
            )
              throw new Error('runtime');
            if (value.status === 'unavailable') {
              const reasons = new Set([
                'invalid',
                'source-digest-mismatch',
                'bytes-limit',
                'pages-limit',
                'page-unavailable',
                'pixels-limit',
                'output-limit',
                'encrypted',
                'unsupported',
                'timeout',
                'aborted',
                'worker-failed',
              ]);
              if (
                !reasons.has(value.reason) ||
                value.pngBytes !== 0 ||
                frame.length !== responseMagic.length + 4 + length
              )
                throw new Error('failure');
              finish({ status: 'unavailable', reason: value.reason });
              return;
            }
            const render = FinancePdfPageRenderSchema.parse(value.render);
            const png = frame.subarray(responseMagic.length + 4 + length);
            if (
              value.status !== 'rendered' ||
              !Number.isInteger(value.pngBytes) ||
              value.pngBytes !== png.length ||
              png.length < 24 ||
              png.length > maxBytes ||
              render.sourceDigest !== input.expectedSourceDigest ||
              render.pageNumber !== input.pageNumber ||
              render.scale !== scale ||
              render.renderer.version !== '5.4.296' ||
              render.renderedImageDigest !==
                createHash('sha256').update(png).digest('hex') ||
              png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
              png.readUInt32BE(16) !== render.width ||
              png.readUInt32BE(20) !== render.height
            )
              throw new Error('binding');
            finish({ status: 'rendered', render, png: new Uint8Array(png) });
          } catch {
            finish(unavailable('worker-failed'));
          }
        });
        if (transport === 'unix-socket') stdin.write(request);
        else stdin.end(request);
        if (input.signal.aborted) abort();
      });
    },
  };
}

import { connect, createServer, type Socket } from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFinancePdfIsolatedRenderer as sharedRenderer } from '@emdo/integrations/finance-documents';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { financePdfFixture } from '../../../packages/integrations/src/finance-documents/test-fixtures/pdf.js';
import {
  createFinancePdfIsolatedRenderer,
  FINANCE_PDF_RENDER_HELPER,
  FINANCE_PDF_RENDER_SOCKET,
  type FinancePdfRenderSpawn,
} from './finance-pdf-render-isolated.js';
it('preserves the shared renderer through the worker compatibility export', () => {
  expect(createFinancePdfIsolatedRenderer).toBe(sharedRenderer);
});
let runtime: string;
beforeAll(async () => {
  runtime = await mkdtemp(join(tmpdir(), 'emdo-pdf-render-test-'));
  execFileSync(
    process.execPath,
    [
      fileURLToPath(
        new URL('../../../infra/finance-pdf-render/build.mjs', import.meta.url),
      ),
      runtime,
    ],
    { stdio: 'pipe' },
  );
});
afterAll(async () => {
  if (runtime) await rm(runtime, { recursive: true, force: true });
});
const input = () => {
  const bytes = financePdfFixture([[]]);
  return {
    bytes,
    expectedSourceDigest: createHash('sha256').update(bytes).digest('hex'),
    pageNumber: 1,
    signal: new AbortController().signal,
  };
};
const realSpawn: FinancePdfRenderSpawn = (executable, args, options) => {
  expect(executable).toBe(FINANCE_PDF_RENDER_HELPER);
  expect(args).toEqual([]);
  expect(options.env).not.toHaveProperty('DATABASE_URL');
  expect(options.env).not.toHaveProperty('OPENAI_API_KEY');
  return spawn(process.execPath, [join(runtime, 'helper.js')], options);
};
describe('isolated PDF renderer framed process boundary', () => {
  it('renders genuine scanned PDF through the built child helper and verifies byte/page provenance', async () => {
    const source = input();
    const result = await createFinancePdfIsolatedRenderer({
      spawnProcess: realSpawn,
    }).render(source);
    expect(result.status).toBe('rendered');
    if (result.status !== 'rendered') throw new Error(result.reason);
    expect(result.render).toMatchObject({
      sourceDigest: source.expectedSourceDigest,
      pageNumber: 1,
      pageCount: 1,
      width: 1224,
      height: 1584,
    });
    expect(createHash('sha256').update(result.png).digest('hex')).toBe(
      result.render.renderedImageDigest,
    );
    expect(createHash('sha256').update(source.bytes).digest('hex')).toBe(
      source.expectedSourceDigest,
    );
  });
  it('rejects bad source digests before launching and keeps real unavailable-page status', async () => {
    let launches = 0;
    const renderer = createFinancePdfIsolatedRenderer({
      spawnProcess: (...args) => {
        launches++;
        return realSpawn(...args);
      },
    });
    await expect(
      renderer.render({ ...input(), expectedSourceDigest: '0'.repeat(64) }),
    ).resolves.toMatchObject({ reason: 'source-digest-mismatch' });
    expect(launches).toBe(0);
    await expect(
      renderer.render({ ...input(), pageNumber: 2 }),
    ).resolves.toMatchObject({ reason: 'page-unavailable' });
  });
  it.each(['timeout', 'aborted'] as const)(
    'kills the helper process group on %s',
    async (reason) => {
      let pid: number | undefined;
      const controller = new AbortController();
      const renderer = createFinancePdfIsolatedRenderer({
        timeoutMs: reason === 'timeout' ? 50 : 15000,
        spawnProcess: (_executable, _args, options) => {
          const child = spawn(
            process.execPath,
            ['-e', 'setInterval(()=>{},1000)'],
            options,
          );
          pid = child.pid;
          if (reason === 'aborted') setTimeout(() => controller.abort(), 30);
          return child;
        },
      });
      await expect(
        renderer.render({ ...input(), signal: controller.signal }),
      ).resolves.toMatchObject({ reason });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(() => process.kill(pid!, 0)).toThrow();
    },
  );
  it.each(['malformed', 'oversized'] as const)(
    'rejects %s helper output',
    async (kind) => {
      const script =
        kind === 'malformed'
          ? 'process.stdout.write("invalid");'
          : 'process.stdout.write(Buffer.alloc(3*1024*1024));';
      const renderer = createFinancePdfIsolatedRenderer({
        spawnProcess: (_executable, _args, options) =>
          spawn(process.execPath, ['-e', script], options),
      });
      await expect(renderer.render(input())).resolves.toMatchObject({
        status: 'unavailable',
        reason: kind === 'oversized' ? 'output-limit' : 'worker-failed',
      });
    },
  );
  it.each(['runtime', 'trailing', 'unknown-key'] as const)(
    'rejects a %s response header violation',
    async (kind) => {
      const magic = Buffer.from('EMDO-FINANCE-PDF-RENDER-V1-RESPONSE\n');
      const value = {
        status: 'unavailable',
        reason: 'unsupported',
        pngBytes: 0,
        runtime: {
          pdfjsVersion: kind === 'runtime' ? 'wrong' : '5.4.296',
          canvasVersion: '0.1.80',
        },
        ...(kind === 'unknown-key' ? { command: 'ignored-but-rejected' } : {}),
      };
      const header = Buffer.from(JSON.stringify(value));
      const length = Buffer.alloc(4);
      length.writeUInt32BE(header.length);
      const frame = Buffer.concat([
        magic,
        length,
        header,
        ...(kind === 'trailing' ? [Buffer.from('x')] : []),
      ]);
      const script = `process.stdout.write(Buffer.from(${JSON.stringify(frame.toString('base64'))},'base64'));`;
      const renderer = createFinancePdfIsolatedRenderer({
        spawnProcess: (_executable, _args, settings) =>
          spawn(process.execPath, ['-e', script], settings),
      });
      await expect(renderer.render(input())).resolves.toMatchObject({
        status: 'unavailable',
        reason: 'worker-failed',
      });
    },
  );
  it.each(['render', 'disconnect', 'timeout'] as const)(
    'uses the fixed Unix socket for %s',
    async (mode) => {
      const path = join(runtime, `test-${mode}.sock`);
      const sockets = new Set<Socket>();
      const server = createServer({ allowHalfOpen: true }, (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => undefined);
        if (mode === 'disconnect') {
          socket.destroy();
          return;
        }
        if (mode === 'timeout') return;
        const child = realSpawn(FINANCE_PDF_RENDER_HELPER, [], {
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: '/tmp',
          env: { PATH: '/usr/local/bin:/usr/bin:/bin', NODE_NO_WARNINGS: '1' },
        });
        child.on('error', () => socket.destroy());
        child.stdin.on('error', () => socket.destroy());
        child.stderr.resume();
        const parts: Buffer[] = [];
        socket.on('data', (chunk: Buffer) => {
          parts.push(chunk);
          const frame = Buffer.concat(parts);
          const magicLength = Buffer.byteLength('EMDO-FINANCE-PDF-RENDER-V1\n');
          if (frame.length < magicLength + 4) return;
          const headerLength = frame.readUInt32BE(magicLength);
          if (frame.length < magicLength + 4 + headerLength) return;
          const header = JSON.parse(
            frame
              .subarray(magicLength + 4, magicLength + 4 + headerLength)
              .toString(),
          );
          if (
            frame.length ===
            magicLength + 4 + headerLength + header.byteLength
          )
            child.stdin.end(frame);
        });
        child.stdout.pipe(socket);
        socket.on('close', () => {
          if (child.pid) {
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {
              /* Already exited. */
            }
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(path, resolve);
      });
      try {
        const renderer = createFinancePdfIsolatedRenderer({
          timeoutMs: mode === 'timeout' ? 40 : 15000,
          connectUnixSocket: (requested) => {
            expect(requested).toBe(FINANCE_PDF_RENDER_SOCKET);
            return connect({ path, allowHalfOpen: true });
          },
        });
        await expect(renderer.render(input())).resolves.toMatchObject(
          mode === 'render'
            ? { status: 'rendered' }
            : {
                status: 'unavailable',
                reason: mode === 'timeout' ? 'timeout' : 'worker-failed',
              },
        );
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createFinanceImageOcrIsolatedRuntime,
  createFinanceImageOcrUnixSocketChannel,
  FINANCE_IMAGE_OCR_HELPER_EXECUTABLE,
  FINANCE_IMAGE_OCR_HELPER_SOCKET_PATH,
  type FinanceImageOcrHelperSpawn,
} from './finance-image-ocr-isolated.js';
import {
  createFinanceImageOcrWorkerAdapter,
  extractFinanceImageOcrForWorker,
} from './finance-image-ocr.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAGQAAAAyAQAAAACCTkMTAAAAFElEQVQoz2P4jwQ+MIzyRnlDhgcAed+EpxcKh0QAAAAASUVORK5CYII=',
  'base64',
);
const digest = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
const manifest = {
  magick: {
    path: '/usr/local/bin/magick',
    sha256: 'a'.repeat(64),
  },
  tesseract: {
    path: '/usr/bin/tesseract',
    sha256: 'b'.repeat(64),
    version: '5.5.1',
  },
  trainedData: [
    {
      language: 'eng' as const,
      path: '/usr/share/tesseract-ocr/5/tessdata/eng.traineddata',
      sha256: 'c'.repeat(64),
    },
  ],
};
const helperFixture = fileURLToPath(
  new URL('../test-fixtures/finance-ocr-helper.mjs', import.meta.url),
);

function fixtureSpawn(calls: string[][]): FinanceImageOcrHelperSpawn {
  return (command, args, options) => {
    calls.push([command, ...args]);
    return spawn(
      process.execPath,
      [helperFixture],
      options,
    ) as ChildProcessWithoutNullStreams;
  };
}

describe('isolated Finance OCR helper transport', () => {
  it('uses one bounded local Unix socket request and closes the channel after one response', async () => {
    class FakeSocket extends EventEmitter {
      setNoDelay() {}
      end() {
        const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
        const response = Buffer.from(
          [
            'EMDO-FINANCE-OCR-HELPER-V1-RESPONSE',
            'status=ok',
            'operation=verify',
            `source-sha256=${'e'.repeat(64)}`,
            `manifest-length=${manifestBytes.length}`,
            'result-length=0',
            'pgm-length=0',
            '',
            '',
          ].join('\n'),
          'ascii',
        );
        queueMicrotask(() => {
          this.emit('data', Buffer.concat([response, manifestBytes]));
          this.emit('close');
        });
      }
      destroy() {}
    }
    const socket = new FakeSocket();
    const channel = createFinanceImageOcrUnixSocketChannel({
      connect: () => {
        queueMicrotask(() => socket.emit('connect'));
        return socket as unknown as import('node:net').Socket;
      },
    });
    const response = await channel.send({
      bytes: Buffer.from('bounded-request'),
      responseLimit: 1024 * 1024,
      timeoutMs: 1000,
      operation: 'verify',
    });
    expect(response.toString('ascii')).toContain(
      'EMDO-FINANCE-OCR-HELPER-V1-RESPONSE',
    );
  });

  it('sends one fixed-argv framed request per stage and preserves source/manifest binding', async () => {
    const calls: string[][] = [];
    const result = await extractFinanceImageOcrForWorker(
      {
        format: 'image/png',
        bytes: PNG,
        expectedSourceDigest: digest(PNG),
        signal: new AbortController().signal,
      },
      {
        isolatedHelper: {
          approvedManifest: manifest,
          spawnProcess: fixtureSpawn(calls),
        },
      },
    );
    expect(result).toMatchObject({
      status: 'extracted',
      sourceDigest: digest(PNG),
      engine: {
        id: 'tesseract',
        version: '5.5.1',
        languages: ['eng'],
      },
      text: 'Date',
    });
    expect(calls).toHaveLength(5);
    expect(
      calls.every(
        ([command, ...args]) =>
          command === FINANCE_IMAGE_OCR_HELPER_EXECUTABLE && args.length === 0,
      ),
    ).toBe(true);
  });

  it('fails closed when the helper returns a different release manifest', async () => {
    const result = await extractFinanceImageOcrForWorker(
      {
        format: 'png',
        bytes: PNG,
        expectedSourceDigest: digest(PNG),
        signal: new AbortController().signal,
      },
      {
        isolatedHelper: {
          approvedManifest: {
            ...manifest,
            tesseract: { ...manifest.tesseract, sha256: 'd'.repeat(64) },
          },
          spawnProcess: fixtureSpawn([]),
        },
      },
    );
    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'ocr-provenance-unavailable',
      sourceDigest: digest(PNG),
    });
  });

  it('rejects arbitrary executable and socket paths before opening a boundary', () => {
    expect(() =>
      createFinanceImageOcrIsolatedRuntime({
        format: 'png',
        expectedSourceDigest: digest(PNG),
        approvedManifest: manifest,
        helperExecutable: '/tmp/document-supplied-command',
      }),
    ).toThrow('helper-path-invalid');
    expect(() =>
      createFinanceImageOcrIsolatedRuntime({
        format: 'png',
        expectedSourceDigest: digest(PNG),
        approvedManifest: manifest,
        socketPath: '/tmp/document-supplied-socket',
      }),
    ).toThrow('helper-socket-path-invalid');
    expect(FINANCE_IMAGE_OCR_HELPER_SOCKET_PATH).toBe(
      '/run/emdo/finance-ocr/helper.sock',
    );
  });

  it('does not permit a digest-mismatched source to reach the helper', async () => {
    const calls: string[][] = [];
    const adapter = createFinanceImageOcrWorkerAdapter({
      isolatedHelper: {
        approvedManifest: manifest,
        spawnProcess: fixtureSpawn(calls),
      },
    });
    await expect(
      adapter.extract({
        format: 'png',
        bytes: PNG,
        expectedSourceDigest: '0'.repeat(64),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('source-digest-mismatch');
    expect(calls).toHaveLength(0);
  });
});

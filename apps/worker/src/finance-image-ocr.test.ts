import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createFinanceImageOcrRuntime,
  type FinanceImageOcrRuntime,
} from '@emdo/integrations/finance-documents';
import {
  createFinanceImageOcrWorkerAdapter,
  extractFinanceImageOcrForWorker,
  FINANCE_IMAGE_OCR_WORKER_LIMITS,
} from './finance-image-ocr.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAGQAAAAyAQAAAACCTkMTAAAAFElEQVQoz2P4jwQ+MIzyRnlDhgcAed+EpxcKh0QAAAAASUVORK5CYII=',
  'base64',
);
const TSV =
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n' +
  '5\t1\t1\t1\t1\t1\t10\t10\t80\t20\t90.0\tDate\n';
const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const runtime = (): FinanceImageOcrRuntime => ({
  identify: vi.fn(async () => ({
    format: 'png' as const,
    width: 100,
    height: 50,
    orientation: 'Undefined',
    frameCount: 1,
  })),
  decodeToPgm: vi.fn(async () =>
    Buffer.concat([
      Buffer.from('P5\n100 50\n255\n', 'ascii'),
      Buffer.alloc(5_000, 255),
    ]),
  ),
  describe: vi.fn(async () => ({
    id: 'tesseract' as const,
    version: '5.5.1',
    languages: ['eng'],
    trainedData: [{ language: 'eng', sha256: 'b'.repeat(64) }],
  })),
  recognizeTsv: vi.fn(async () => TSV),
});

describe('worker image OCR adapter', () => {
  it('passes an authenticated original through the bounded adapter and keeps the result review-only', async () => {
    const bytes = PNG;
    const result = await extractFinanceImageOcrForWorker(
      {
        format: 'png',
        bytes,
        expectedSourceDigest: digest(bytes),
        signal: new AbortController().signal,
      },
      { runtime: runtime() },
    );
    expect(result).toMatchObject({
      status: 'extracted',
      sourceDigest: digest(bytes),
      format: 'png',
      text: 'Date',
      candidate: {
        authority: 'untrusted-source-data',
        reviewStatus: 'needs-source-review',
        normalized: false,
        sourceSelection: null,
      },
    });
  });

  it('rejects an invalid worker signal and preserves digest failures as hard errors', async () => {
    const bytes = PNG;
    const adapter = createFinanceImageOcrWorkerAdapter({ runtime: runtime() });
    await expect(
      adapter.extract({
        format: 'png',
        bytes,
        expectedSourceDigest: digest(bytes),
        signal: {} as AbortSignal,
      }),
    ).rejects.toThrow('signal-invalid');
    await expect(
      adapter.extract({
        format: 'png',
        bytes,
        expectedSourceDigest: '0'.repeat(64),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('source-digest-mismatch');
  });

  it('returns explicit unavailable infrastructure and does not claim OCR is installed', async () => {
    const result = await extractFinanceImageOcrForWorker(
      {
        format: 'png',
        bytes: PNG,
        expectedSourceDigest: digest(PNG),
        signal: new AbortController().signal,
      },
      {
        runtime: createFinanceImageOcrRuntime({
          magickExecutable: '/path/that/does/not/exist/emdo-magick',
          tesseractExecutable: '/path/that/does/not/exist/emdo-tesseract',
        }),
      },
    );
    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'decoder-unavailable',
      sourceDigest: digest(PNG),
      text: '',
      words: [],
    });
  });

  it('does not treat host PATH binaries as an approved release runtime', async () => {
    const result = await extractFinanceImageOcrForWorker({
      format: 'png',
      bytes: PNG,
      expectedSourceDigest: digest(PNG),
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'ocr-provenance-unavailable',
      sourceDigest: digest(PNG),
      text: '',
      words: [],
    });
  });

  it('keeps worker limits bounded by the integration hard ceilings', () => {
    expect(FINANCE_IMAGE_OCR_WORKER_LIMITS).toMatchObject({
      maxBytes: 2 * 1024 * 1024,
      maxPixels: 40_000_000,
      maxWords: 20_000,
      maximumTimeoutMs: 15_000,
    });
  });
});

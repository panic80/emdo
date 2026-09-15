import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { renderFinancePdfPage } from './pdf-page-render.js';
import { financePdfFixture } from './test-fixtures/pdf.js';
const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const input = (bytes: Uint8Array) => ({
  bytes,
  expectedSourceDigest: digest(bytes),
  pageNumber: 1,
});

describe('bounded explicit PDF page raster foundation', () => {
  it.each([{ pages: [[]] }, { pages: [['Embedded text'], []] }])(
    'renders selected scan-only or mixed document page with original provenance (%j)',
    async ({ pages }) => {
      const bytes = financePdfFixture(pages);
      const result = await renderFinancePdfPage({
        ...input(bytes),
        pageNumber: pages.length,
      });
      expect(result.status).toBe('rendered');
      if (result.status !== 'rendered') throw new Error(result.reason);
      expect(result.render).toMatchObject({
        sourceDigest: digest(bytes),
        pageCount: pages.length,
        pageNumber: pages.length,
        rotation: 0,
        scale: 2,
        width: 1224,
        height: 1584,
        renderer: { id: 'pdfjs-dist', version: '5.4.296' },
      });
      expect(result.render.renderedImageDigest).toBe(digest(result.png));
      expect(Buffer.from(result.png.subarray(0, 8)).toString('hex')).toBe(
        '89504e470d0a1a0a',
      );
      expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
      const require = createRequire(import.meta.url);
      const canvas = createRequire(require.resolve('pdfjs-dist/package.json'))(
        '@napi-rs/canvas',
      ) as {
        loadImage(bytes: Buffer): Promise<unknown>;
        createCanvas(
          width: number,
          height: number,
        ): {
          getContext(kind: '2d'): {
            drawImage(image: unknown, x: number, y: number): void;
            getImageData(
              x: number,
              y: number,
              width: number,
              height: number,
            ): { data: Uint8ClampedArray };
          };
        };
      };
      const raster = canvas
        .createCanvas(result.render.width, result.render.height)
        .getContext('2d');
      raster.drawImage(await canvas.loadImage(Buffer.from(result.png)), 0, 0);
      expect([...raster.getImageData(100, 200, 1, 1).data]).toEqual([
        0, 0, 0, 255,
      ]);
      expect([...raster.getImageData(10, 10, 1, 1).data]).toEqual([
        255, 255, 255, 255,
      ]);
    },
  );
  it('retains page rotation and ignores document JavaScript', async () => {
    const original = financePdfFixture([[]], true).toString();
    const objects = [
      ...original.matchAll(/\d+ 0 obj\n([\s\S]*?)\nendobj/g),
    ].map((m) => m[1]!.replace('/MediaBox', '/Rotate 90 /MediaBox'));
    let text = '%PDF-1.7\n';
    const offsets: number[] = [];
    objects.forEach((object, index) => {
      offsets.push(Buffer.byteLength(text));
      text += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const start = Buffer.byteLength(text);
    text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
    const bytes = Buffer.from(text);
    const result = await renderFinancePdfPage(input(bytes));
    expect(result).toMatchObject({
      status: 'rendered',
      render: { rotation: 90, width: 1584, height: 1224 },
    });
  });
  it('rejects digest, page, bytes, page-count and pixel bound violations', async () => {
    const source = input(financePdfFixture([[]]));
    await expect(
      renderFinancePdfPage({ ...source, expectedSourceDigest: '0'.repeat(64) }),
    ).resolves.toMatchObject({ reason: 'source-digest-mismatch' });
    await expect(
      renderFinancePdfPage({ ...source, pageNumber: 0 }),
    ).resolves.toMatchObject({ reason: 'invalid' });
    await expect(
      renderFinancePdfPage({ ...source, pageNumber: 2 }),
    ).resolves.toMatchObject({ reason: 'page-unavailable' });
    await expect(
      renderFinancePdfPage({ ...source, limits: { maxBytes: 1 } }),
    ).resolves.toMatchObject({ reason: 'bytes-limit' });
    await expect(
      renderFinancePdfPage({ ...source, limits: { maxPixels: 100 } }),
    ).resolves.toMatchObject({ reason: 'pixels-limit' });
    await expect(
      renderFinancePdfPage({
        ...input(financePdfFixture([[], []])),
        limits: { maxPages: 1 },
      }),
    ).resolves.toMatchObject({ reason: 'pages-limit' });
    await expect(
      renderFinancePdfPage({ ...source, limits: { maxOutputBytes: 1 } }),
    ).resolves.toMatchObject({ reason: 'output-limit' });
  });
  it('terminates workers for deadline and caller cancellation', async () => {
    const source = input(financePdfFixture([[]]));
    await expect(
      renderFinancePdfPage({ ...source, limits: { timeoutMs: 1 } }),
    ).resolves.toMatchObject({ reason: 'timeout' });
    const controller = new AbortController();
    const pending = renderFinancePdfPage({
      ...source,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).resolves.toMatchObject({ reason: 'aborted' });
    await expect(
      renderFinancePdfPage({ ...source, signal: controller.signal }),
    ).resolves.toMatchObject({ reason: 'aborted' });
  });
});

import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

interface ManifestIcon {
  readonly src: string;
  readonly sizes: string;
  readonly type: string;
  readonly purpose: string;
}

interface WebManifest {
  readonly start_url: string;
  readonly scope: string;
  readonly display: string;
  readonly icons: readonly ManifestIcon[];
}

async function pngDimensions(
  path: string,
): Promise<{ readonly width: number; readonly height: number }> {
  const bytes = await readFile(path);
  expect(bytes.subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('PWA installability assets', () => {
  const workingDirectory = process.cwd();
  const webRoot =
    basename(workingDirectory) === 'web' &&
    basename(dirname(workingDirectory)) === 'apps'
      ? workingDirectory
      : resolve(workingDirectory, 'apps/web');

  it('provides verified any-purpose and separately padded maskable PNG icons', async () => {
    const publicDirectory = resolve(webRoot, 'public');
    const manifest = JSON.parse(
      await readFile(resolve(publicDirectory, 'manifest.webmanifest'), 'utf8'),
    ) as WebManifest;

    expect(manifest).toMatchObject({
      start_url: '/today',
      scope: '/',
      display: 'standalone',
    });
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          src: '/icons/emdo-192.png',
          sizes: '192x192',
          type: 'image/png',
          purpose: 'any',
        }),
        expect.objectContaining({
          src: '/icons/emdo-512.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'any',
        }),
        expect.objectContaining({
          src: '/icons/emdo-maskable-512.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'maskable',
        }),
      ]),
    );
    expect(
      manifest.icons.every(({ purpose }) => !purpose.includes('any maskable')),
    ).toBe(true);

    await expect(
      pngDimensions(resolve(publicDirectory, 'icons/emdo-192.png')),
    ).resolves.toEqual({
      width: 192,
      height: 192,
    });
    await expect(
      pngDimensions(resolve(publicDirectory, 'icons/emdo-512.png')),
    ).resolves.toEqual({
      width: 512,
      height: 512,
    });
    await expect(
      pngDimensions(resolve(publicDirectory, 'icons/emdo-maskable-512.png')),
    ).resolves.toEqual({ width: 512, height: 512 });
  });

  it('publishes a verified Apple touch icon', async () => {
    const html = await readFile(resolve(webRoot, 'index.html'), 'utf8');

    expect(html).toMatch(
      /<link\s+rel="apple-touch-icon"\s+sizes="180x180"\s+href="\/icons\/apple-touch-icon\.png"\s*\/>/,
    );
    await expect(
      pngDimensions(resolve(webRoot, 'public/icons/apple-touch-icon.png')),
    ).resolves.toEqual({ width: 180, height: 180 });
  });
});

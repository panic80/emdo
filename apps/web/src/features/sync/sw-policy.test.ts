import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('service worker activation policy', () => {
  it('does not claim open clients and only skips waiting after an explicit message', async () => {
    const workingDirectory = process.cwd();
    const webRoot =
      basename(workingDirectory) === 'web' &&
      basename(dirname(workingDirectory)) === 'apps'
        ? workingDirectory
        : resolve(workingDirectory, 'apps/web');
    const source = await readFile(resolve(webRoot, 'src/sw.ts'), 'utf8');

    expect(source).not.toMatch(/clientsClaim/u);
    expect(source).toContain("type === 'SKIP_WAITING'");
    expect(source).toContain('self.skipWaiting()');
    expect(source.indexOf("type === 'SKIP_WAITING'")).toBeLessThan(
      source.indexOf('self.skipWaiting()'),
    );
    expect(source).toContain("event.request.mode !== 'navigate'");
    expect(source).toContain("matchPrecache('/index.html')");
  });
});

import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('@emdo/worker package boundary', () => {
  it('builds the executable and migration CLI into dist', () => {
    const manifestUrl = new URL('../package.json', import.meta.url);
    const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8')) as {
      readonly scripts?: Readonly<Record<string, string>>;
      readonly files?: readonly string[];
      readonly dependencies?: Readonly<Record<string, string>>;
      readonly devDependencies?: Readonly<Record<string, string>>;
    };

    expect(manifest.scripts).toMatchObject({
      build: 'node build.mjs',
      start: 'node dist/index.js',
      typecheck: 'tsc --project tsconfig.json --noEmit',
    });
    expect(manifest.files).toEqual(['dist']);
    expect(manifest.dependencies).toEqual({
      'pdf-parse': '2.4.5',
      pg: '8.23.0',
      'pg-boss': '12.27.0',
      zod: '4.4.3',
    });
    expect(manifest.devDependencies).toMatchObject({
      '@emdo/contracts': 'workspace:*',
      '@emdo/db': 'workspace:*',
      '@emdo/domains': 'workspace:*',
      '@emdo/integrations': 'workspace:*',
      esbuild: '0.28.2',
    });
    expect(existsSync(new URL('../build.mjs', import.meta.url))).toBe(true);
    expect(existsSync(new URL('../tsconfig.build.json', import.meta.url))).toBe(
      true,
    );
    expect(existsSync(new URL('../tsconfig.json', import.meta.url))).toBe(true);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import * as publicApi from './index.js';

describe('@emdo/agent-core package boundary', () => {
  it('ships declarations from dist and excludes process-local test adapters', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      readonly exports: {
        readonly '.': {
          readonly default: string;
          readonly development: {
            readonly default: string;
            readonly types: string;
          };
          readonly source: {
            readonly default: string;
            readonly types: string;
          };
          readonly types: string;
        };
      };
      readonly files: readonly string[];
    };

    expect(packageJson.files).toEqual(['dist']);
    expect(packageJson.exports['.']).toEqual({
      development: {
        types: './src/index.ts',
        default: './src/index.ts',
      },
      source: {
        types: './src/index.ts',
        default: './src/index.ts',
      },
      types: './dist/index.d.ts',
      default: './dist/index.js',
    });
    expect(
      Object.keys(publicApi).filter((name) => name.startsWith('InMemory')),
    ).toEqual([]);
  });
});

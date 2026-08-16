import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(packageRoot, 'dist');
const modules = [
  'approval-state',
  'budget',
  'factory',
  'index',
  'memory',
  'model-router',
  'runner',
  'trace',
];
const expected = modules
  .flatMap((name) => [
    `${name}.d.ts`,
    `${name}.d.ts.map`,
    `${name}.js`,
    `${name}.js.map`,
  ])
  .sort();
const actual = readdirSync(dist, { withFileTypes: true })
  .map((entry) => {
    if (!entry.isFile()) throw new Error('unexpected-agent-core-dist-entry');
    return entry.name;
  })
  .sort();

if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(
    `unexpected-agent-core-dist-inventory:${JSON.stringify(actual)}`,
  );
}

import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(packageRoot, 'dist');

if (dirname(dist) !== packageRoot || !dist.endsWith('/agent-core/dist')) {
  throw new Error('refusing-to-clean-unexpected-agent-core-path');
}

rmSync(dist, { force: true, recursive: true });

import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, cp, writeFile, readFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(
  process.argv[2] ?? join(root, 'tmp/finance-pdf-render-runtime'),
);
const require = createRequire(join(root, 'apps/worker/package.json'));
const { build } = require('esbuild');
await mkdir(output, { recursive: true });
// The release helper is read-only; permit a controlled rebuild in this artifact directory.
await chmod(join(output, 'helper.js'), 0o755).catch((error) => {
  if (error.code !== 'ENOENT') throw error;
});
await build({
  entryPoints: {
    helper: join(root, 'infra/finance-pdf-render/helper.mjs'),
    'socket-server': join(root, 'infra/finance-pdf-render/socket-server.mjs'),
    'pdf-page-render-worker': join(
      root,
      'packages/integrations/src/finance-documents/pdf-page-render-worker.ts',
    ),
  },
  outdir: output,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['pdfjs-dist', 'pdfjs-dist/*', '@napi-rs/canvas'],
  banner: { js: '#!/usr/local/bin/node' },
});
await writeFile(
  join(output, 'package.json'),
  JSON.stringify({ type: 'module', private: true }),
);
const pdfPath = require.resolve('pdfjs-dist/package.json');
const pdfRequire = createRequire(pdfPath);
const canvasPath = pdfRequire.resolve('@napi-rs/canvas/package.json');
const canvasRequire = createRequire(canvasPath);
if (
  pdfRequire(pdfPath).version !== '5.4.296' ||
  canvasRequire(canvasPath).version !== '0.1.80'
)
  throw new Error('pdf-render-runtime-version-mismatch');
for (const [name, path] of [
  ['pdfjs-dist', pdfPath],
  ['@napi-rs/canvas', canvasPath],
]) {
  const target = join(output, 'node_modules', name);
  await mkdir(dirname(target), { recursive: true });
  await cp(dirname(path), target, { recursive: true });
}
let nativeCount = 0;
for (const name of Object.keys(
  canvasRequire(canvasPath).optionalDependencies,
)) {
  let packagePath;
  try {
    packagePath = canvasRequire.resolve(`${name}/package.json`);
  } catch {
    continue;
  }
  await cp(dirname(packagePath), join(output, 'node_modules', name), {
    recursive: true,
  });
  nativeCount++;
}
if (!nativeCount) throw new Error('pdf-render-native-canvas-unavailable');
await chmod(join(output, 'helper.js'), 0o555);
const hashes = {};
for (const name of [
  'helper.js',
  'pdf-page-render-worker.js',
  'socket-server.js',
])
  hashes[name] = createHash('sha256')
    .update(await readFile(join(output, name)))
    .digest('hex');
await writeFile(
  join(output, 'runtime-manifest.json'),
  JSON.stringify(
    { pdfjsVersion: '5.4.296', canvasVersion: '0.1.80', hashes },
    null,
    2,
  ),
);
console.log(`Built dedicated PDF renderer runtime: ${output}`);

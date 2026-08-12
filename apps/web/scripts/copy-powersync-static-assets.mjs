import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDirectory, '..');
const packageManifest = JSON.parse(
  await readFile(resolve(packageRoot, 'package.json'), 'utf8'),
);
if (packageManifest.name !== '@emdo/web') {
  throw new Error('PowerSync assets may only be copied into @emdo/web');
}

const require = createRequire(import.meta.url);
const sourceDirectory = dirname(
  require.resolve('@powersync/web/bundled_worker'),
);
const powerSyncManifest = JSON.parse(
  await readFile(resolve(sourceDirectory, '../..', 'package.json'), 'utf8'),
);
if (powerSyncManifest.version !== '2.1.1') {
  throw new Error('Expected the pinned @powersync/web 2.1.1 static runtime');
}
const destinationDirectory = resolve(packageRoot, 'public/@powersync');
const destinationAssetDirectory = resolve(destinationDirectory, 'assets');

const WORKER_FILES = Object.freeze([
  'AccessHandlePoolVFS-BPUHfZME.js',
  'FacadeVFS-d1ZDvud7.js',
  'IDBBatchAtomicVFS-DbkDb777.js',
  'MemoryVFS-DVJL5F8j.js',
  'OPFSCoopSyncVFS-BgTiWPfa.js',
  'OPFSWriteAheadVFS-BzodSqNq.js',
  'mc-wa-sqlite-DDFgWP93.js',
  'mc-wa-sqlite-async-lGclTjKJ.js',
  'wa-sqlite-B0tZMM0j.js',
  'wa-sqlite-async-CM6BmfRh.js',
  'websockets-Q8W_lerF.js',
  'worker.js',
]);
const WASM_FILES = Object.freeze([
  'mc-wa-sqlite-DoDpgFfE.wasm',
  'mc-wa-sqlite-async-DYagSq56.wasm',
]);

const sourceEntries = await readdir(sourceDirectory, {
  withFileTypes: true,
});
const availableWorkerFiles = new Set(
  sourceEntries.filter((entry) => entry.isFile()).map((entry) => entry.name),
);
const assetEntries = await readdir(resolve(sourceDirectory, 'assets'), {
  withFileTypes: true,
});
const availableWasmFiles = new Set(
  assetEntries.filter((entry) => entry.isFile()).map((entry) => entry.name),
);
for (const required of WORKER_FILES) {
  if (!availableWorkerFiles.has(required)) {
    throw new Error(`PowerSync static worker is missing ${required}`);
  }
}
for (const required of WASM_FILES) {
  if (!availableWasmFiles.has(required)) {
    throw new Error(`PowerSync static worker is missing assets/${required}`);
  }
}

await rm(destinationDirectory, { recursive: true, force: true });
await mkdir(destinationAssetDirectory, { recursive: true });
await Promise.all([
  ...WORKER_FILES.map((file) =>
    copyWorkerJavaScript(
      resolve(sourceDirectory, file),
      resolve(destinationDirectory, file),
    ),
  ),
  ...WASM_FILES.map((file) =>
    copyFile(
      resolve(sourceDirectory, 'assets', file),
      resolve(destinationAssetDirectory, file),
    ),
  ),
]);

const copiedFiles = [
  ...WORKER_FILES,
  ...WASM_FILES.map((file) => `assets/${file}`),
];
if (copiedFiles.some((file) => file.endsWith('.map'))) {
  throw new Error('PowerSync source maps must not enter the release artifact');
}
if (
  copiedFiles.some(
    (file) =>
      /(?:^|\/)libpowersync[^/]*\.wasm$/u.test(file) ||
      (file.endsWith('.wasm') && !/^assets\/mc-wa-sqlite/u.test(file)),
  )
) {
  throw new Error('Only encrypted static SQLite WASM may be released');
}
if (copiedFiles.length !== WORKER_FILES.length + WASM_FILES.length) {
  throw new Error('PowerSync static runtime copy did not complete');
}

async function copyWorkerJavaScript(source, destination) {
  const workerSource = await readFile(source, 'utf8');
  if (workerSource.length < 1 || workerSource.length > 1_500_000) {
    throw new Error('PowerSync worker JavaScript exceeds safe copy bounds');
  }
  const sourceMapReferences = workerSource.match(/\/\/# sourceMappingURL=/gu);
  if (sourceMapReferences?.length !== 1) {
    throw new Error(
      'PowerSync worker must have exactly one terminal source map reference',
    );
  }
  const releaseSource = workerSource.replace(
    /\r?\n?\/\/# sourceMappingURL=[^\r\n]+\r?\n?$/u,
    '\n',
  );
  if (releaseSource.includes('sourceMappingURL=')) {
    throw new Error('PowerSync worker source map reference was not removed');
  }
  await writeFile(destination, releaseSource, {
    encoding: 'utf8',
    flag: 'wx',
  });
}

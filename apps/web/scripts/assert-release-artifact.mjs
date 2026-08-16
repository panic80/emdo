import { access, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const distributionDirectory = resolve(process.cwd(), 'dist');
const releaseFiles = await readdir(distributionDirectory, { recursive: true });
const sourceMaps = releaseFiles.filter((path) => path.endsWith('.map'));

const expectedPowerSyncFiles = new Set([
  '@powersync/AccessHandlePoolVFS-BPUHfZME.js',
  '@powersync/FacadeVFS-d1ZDvud7.js',
  '@powersync/IDBBatchAtomicVFS-DbkDb777.js',
  '@powersync/MemoryVFS-DVJL5F8j.js',
  '@powersync/OPFSCoopSyncVFS-BgTiWPfa.js',
  '@powersync/OPFSWriteAheadVFS-BzodSqNq.js',
  '@powersync/mc-wa-sqlite-DDFgWP93.js',
  '@powersync/mc-wa-sqlite-async-lGclTjKJ.js',
  '@powersync/wa-sqlite-B0tZMM0j.js',
  '@powersync/wa-sqlite-async-CM6BmfRh.js',
  '@powersync/websockets-Q8W_lerF.js',
  '@powersync/worker.js',
  '@powersync/assets/mc-wa-sqlite-DoDpgFfE.wasm',
  '@powersync/assets/mc-wa-sqlite-async-DYagSq56.wasm',
]);
const forbiddenServerAuthorityMarkers = [
  'google-calendar-grant-v2',
  'providerGrantReference',
  'authorizationEpoch',
  'providerSdkCallId',
];

if (sourceMaps.length > 0) {
  throw new Error(
    `Release web artifact contains source maps: ${sourceMaps.join(', ')}`,
  );
}

const wasmFiles = releaseFiles.filter((path) => path.endsWith('.wasm'));
const allowedWasmFiles = new Set(
  [...expectedPowerSyncFiles].filter((path) => path.endsWith('.wasm')),
);
if (
  wasmFiles.some(
    (path) =>
      /(?:^|\/)libpowersync[^/]*\.wasm$/u.test(path) ||
      !allowedWasmFiles.has(path),
  ) ||
  wasmFiles.length !== allowedWasmFiles.size
) {
  throw new Error(
    `Release web artifact has an invalid WASM set: ${wasmFiles.join(', ')}`,
  );
}

for (const requiredPowerSyncFile of expectedPowerSyncFiles) {
  await access(resolve(distributionDirectory, requiredPowerSyncFile));
}

const serviceWorkerSource = await readFile(
  resolve(distributionDirectory, 'sw.js'),
  'utf8',
);
for (const requiredPowerSyncFile of expectedPowerSyncFiles) {
  if (!serviceWorkerSource.includes(`"url":"${requiredPowerSyncFile}"`)) {
    throw new Error(
      `Service worker does not precache the pinned PowerSync asset ${requiredPowerSyncFile}`,
    );
  }
}

const emittedPowerSyncFiles = releaseFiles.filter(
  (path) => path.startsWith('@powersync/') && /\.(?:js|wasm)$/u.test(path),
);
if (
  emittedPowerSyncFiles.length !== expectedPowerSyncFiles.size ||
  emittedPowerSyncFiles.some((path) => !expectedPowerSyncFiles.has(path))
) {
  throw new Error(
    `Release PowerSync static runtime differs from the pinned allowlist: ${emittedPowerSyncFiles.join(', ')}`,
  );
}

for (const path of releaseFiles.filter((value) =>
  /\.(?:css|js)$/u.test(value),
)) {
  const source = await readFile(resolve(distributionDirectory, path), 'utf8');
  if (/sourceMappingURL=/u.test(source)) {
    throw new Error(
      `Release web artifact exposes a sourceMappingURL in ${path}`,
    );
  }
  const exposedServerAuthorityMarkers = forbiddenServerAuthorityMarkers.filter(
    (marker) => source.includes(marker),
  );
  if (exposedServerAuthorityMarkers.length > 0) {
    throw new Error(
      `Release web artifact exposes server authority contracts in ${path}: ${exposedServerAuthorityMarkers.join(', ')}`,
    );
  }
}

for (const requiredAsset of [
  'manifest.webmanifest',
  'icons/emdo-192.png',
  'icons/emdo-512.png',
  'icons/emdo-maskable-512.png',
  'icons/apple-touch-icon.png',
]) {
  await access(resolve(distributionDirectory, requiredAsset));
}

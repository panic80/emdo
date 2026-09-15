import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const image = process.argv[2];
if (!image) throw Error('usage: verify-socket-linux.mjs <dedicated-image>');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { build } = createRequire(join(root, 'apps/worker/package.json'))(
  'esbuild',
);
const scratch = await mkdtemp(join(tmpdir(), 'emdo-pdf-socket-proof-'));
const client = join(scratch, 'client.mjs');
await build({
  entryPoints: [
    join(root, 'infra/finance-pdf-render/socket-client-acceptance.mjs'),
  ],
  outfile: client,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
});
const docker = (args, options = {}) =>
  execFileSync('docker', args, { encoding: 'utf8', ...options });
const identity = JSON.parse(docker(['image', 'inspect', image]))[0];
const name = `emdo-pdf-socket-${process.pid}`;
const volume = `${name}-volume`;
const limits = [
  '--platform',
  `linux/${identity.Architecture}`,
  '--network',
  'none',
  '--read-only',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges:true',
  '--memory',
  '256m',
  '--cpus',
  '1',
  '--pids-limit',
  '32',
];
docker(['volume', 'create', volume]);
try {
  docker([
    'run',
    '-d',
    '--name',
    name,
    ...limits,
    '--user',
    '10005:10005',
    '--tmpfs',
    '/tmp:size=64m,noexec,nosuid,nodev,mode=0700,uid=10005,gid=10005',
    '--mount',
    `type=volume,source=${volume},target=/run/emdo/finance-pdf-render`,
    identity.Id,
  ]);
  const result = docker(
    [
      'run',
      '--rm',
      ...limits,
      '--user',
      '10006:10005',
      '--tmpfs',
      '/tmp:size=16m,noexec,nosuid,nodev,mode=0700,uid=10006,gid=10005',
      '--mount',
      `type=volume,source=${volume},target=/run/emdo/finance-pdf-render,readonly`,
      '--mount',
      `type=bind,source=${client},target=/client.mjs,readonly`,
      '--entrypoint',
      '/usr/local/bin/node',
      identity.Id,
      '/client.mjs',
    ],
    { timeout: 45000, maxBuffer: 65536 },
  );
  console.log(result.trim());
  console.log(
    JSON.stringify({
      runtimeImage: identity.Id,
      platform: `linux/${identity.Architecture}`,
      containers: 2,
      network: 'none',
      clientSocketMount: 'read-only',
      helperUid: 10005,
      clientUid: 10006,
    }),
  );
} finally {
  try {
    docker(['rm', '-f', name]);
  } catch {
    /* Not yet ready or already removed. */
  }
  try {
    docker(['volume', 'rm', volume]);
  } catch {
    /* Not yet ready or already removed. */
  }
  await rm(scratch, { recursive: true, force: true });
}

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { financePdfFixture } from '../../packages/integrations/src/finance-documents/test-fixtures/pdf.ts';
const runtime = resolve(process.argv[2]);
const image = process.argv[3];
if (!image)
  throw Error(
    'usage: verify-linux.mjs <linux-runtime-dir> <locally-installed-native-runtime-image>',
  );
const meta = JSON.parse(
  await readFile(join(runtime, 'linux-provenance.json'), 'utf8'),
);
const bytes = financePdfFixture([['Embedded page'], []]);
const sourceDigest = createHash('sha256').update(bytes).digest('hex');
const header = Buffer.from(
  JSON.stringify({
    byteLength: bytes.length,
    sourceDigest,
    pageNumber: 2,
    scale: 2,
  }),
);
const length = Buffer.alloc(4);
length.writeUInt32BE(header.length);
const input = Buffer.concat([
  Buffer.from('EMDO-FINANCE-PDF-RENDER-V1\n'),
  length,
  header,
  bytes,
]);
const imageId = JSON.parse(
  execFileSync('docker', ['image', 'inspect', image], { encoding: 'utf8' }),
)[0].Id;
const bundled = process.argv[4] === 'bundled';
const output = execFileSync(
  'docker',
  [
    'run',
    '--rm',
    '-i',
    '--platform',
    meta.platform,
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
    '--user',
    '10005:10005',
    '--tmpfs',
    '/tmp:size=64m,noexec,nosuid,nodev,mode=0700,uid=10005,gid=10005',
    ...(bundled
      ? [
          '--entrypoint',
          '/usr/local/bin/emdo-finance-pdf-render-helper',
          imageId,
        ]
      : [
          '--mount',
          `type=bind,source=${runtime},target=/runtime,readonly`,
          '--entrypoint',
          '/usr/local/bin/node',
          imageId,
          '/runtime/helper.js',
        ]),
  ],
  { input, maxBuffer: 3 * 1024 * 1024, timeout: 30000 },
);
const magic = Buffer.from('EMDO-FINANCE-PDF-RENDER-V1-RESPONSE\n');
assert(output.subarray(0, magic.length).equals(magic));
const size = output.readUInt32BE(magic.length);
const result = JSON.parse(
  output.subarray(magic.length + 4, magic.length + 4 + size),
);
assert.equal(result.status, 'rendered');
assert.equal(result.render.sourceDigest, sourceDigest);
assert.equal(result.render.pageNumber, 2);
assert.equal(result.render.pageCount, 2);
const png = output.subarray(magic.length + 4 + size);
assert.equal(png.length, result.pngBytes);
assert.equal(
  createHash('sha256').update(png).digest('hex'),
  result.render.renderedImageDigest,
);
console.log(
  JSON.stringify({
    status: 'passed',
    bundled,
    platform: meta.platform,
    runtimeImage: imageId,
    dependencyImage: meta.dependencyImage,
    network: 'none',
    readOnly: true,
    memory: '256m',
    pageCount: 2,
    pageNumber: 2,
    width: result.render.width,
    height: result.render.height,
    pngBytes: png.length,
  }),
);

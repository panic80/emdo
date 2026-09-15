import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { connect } from 'node:net';
import {
  createFinancePdfIsolatedRenderer,
  FINANCE_PDF_RENDER_SOCKET,
} from '../../apps/worker/src/finance-pdf-render-isolated.ts';
import { financePdfFixture } from '../../packages/integrations/src/finance-documents/test-fixtures/pdf.ts';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    ready = (await stat(FINANCE_PDF_RENDER_SOCKET)).isSocket();
    if (ready) break;
  } catch {
    /* Not yet ready or already removed. */
  }
  await delay(50);
}
assert(ready, 'helper socket unavailable');
const bytes = financePdfFixture([['Embedded page'], []]);
const sourceDigest = createHash('sha256').update(bytes).digest('hex');
const input = {
  bytes,
  expectedSourceDigest: sourceDigest,
  pageNumber: 2,
  signal: new AbortController().signal,
};
const renderer = createFinancePdfIsolatedRenderer();
const result = await renderer.render(input);
assert.equal(result.status, 'rendered', `initial render: ${result.reason}`);
assert.equal(result.render.pageCount, 2);
assert.equal(result.render.pageNumber, 2);
assert.equal(result.render.sourceDigest, sourceDigest);
assert.equal(
  createHash('sha256').update(result.png).digest('hex'),
  result.render.renderedImageDigest,
);
// A second caller cannot share a live helper; closing the first caller must
// release its entire process group so a subsequent request succeeds.
const hold = connect({ path: FINANCE_PDF_RENDER_SOCKET, allowHalfOpen: true });
hold.on('error', () => {});
await new Promise((resolve, reject) => {
  hold.once('connect', resolve);
  hold.once('error', reject);
});
hold.write('partial request');
await delay(50);
const busy = await renderer.render(input);
assert.equal(busy.status, 'unavailable');
hold.destroy();
let recovered;
for (let attempt = 0; attempt < 20; attempt++) {
  await delay(100);
  recovered = await renderer.render(input);
  if (recovered.status === 'rendered') break;
}
assert.equal(
  recovered.status,
  'rendered',
  `post-disconnect render: ${recovered.reason}`,
);
// A caller that never completes its frame cannot occupy the supervisor forever.
const stalled = connect({
  path: FINANCE_PDF_RENDER_SOCKET,
  allowHalfOpen: true,
});
stalled.on('error', () => {});
await new Promise((resolve, reject) => {
  stalled.once('connect', resolve);
  stalled.once('error', reject);
});
const started = Date.now();
stalled.write('partial');
await new Promise((resolve, reject) => {
  const timer = setTimeout(
    () => reject(Error('supervisor deadline missed')),
    18000,
  );
  const done = () => {
    clearTimeout(timer);
    resolve();
  };
  stalled.once('end', done);
  stalled.once('close', done);
});
stalled.destroy();
assert(Date.now() - started >= 14000);
let afterDeadline;
for (let attempt = 0; attempt < 20; attempt++) {
  await delay(100);
  afterDeadline = await renderer.render(input);
  if (afterDeadline.status === 'rendered') break;
}
assert.equal(
  afterDeadline.status,
  'rendered',
  'supervisor must recover after its deadline',
);
console.log(
  JSON.stringify({
    status: 'passed',
    transport: 'fixed-unix-socket',
    pageNumber: 2,
    pageCount: 2,
    width: result.render.width,
    height: result.render.height,
    pngBytes: result.png.length,
    busyRejected: true,
    disconnectRecovered: true,
    supervisorDeadlineRecovered: true,
    uid: process.getuid(),
    gid: process.getgid(),
  }),
);

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createFinanceImageOcrWorkerAdapter } from '../../apps/worker/src/finance-image-ocr.js';
import { readFinanceImageOcrApprovedRuntimeManifest } from '../../apps/worker/src/finance-image-ocr-isolated.js';
const adapter = createFinanceImageOcrWorkerAdapter({
  isolatedHelper: {
    approvedManifest: await readFinanceImageOcrApprovedRuntimeManifest(),
  },
});
const fixtures = [
  {
    name: 'financial-text',
    bytes: await readFile('/proof/financial-text.png'),
    text: true,
  },
  {
    name: 'blank',
    bytes: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAGQAAAAyAQAAAACCTkMTAAAAFElEQVQoz2P4jwQ+MIzyRnlDhgcAed+EpxcKh0QAAAAASUVORK5CYII=',
      'base64',
    ),
    text: false,
  },
];
for (const fixture of fixtures) {
  const expectedSourceDigest = createHash('sha256')
    .update(fixture.bytes)
    .digest('hex');
  const result = await adapter.extract({
    bytes: fixture.bytes,
    format: 'png',
    expectedSourceDigest,
    signal: AbortSignal.timeout(20000),
  });
  if (
    result.status === 'unavailable' ||
    result.sourceDigest !== expectedSourceDigest ||
    !result.engine
  )
    throw new Error(
      `${fixture.name}: runtime or source provenance unavailable`,
    );
  if (
    fixture.text
      ? !result.text.includes('TOTAL') || !result.text.includes('123.45')
      : result.status !== 'no-text' || result.text.length !== 0
  )
    throw new Error(`${fixture.name}: unexpected OCR result`);
  console.log(JSON.stringify({ fixture: fixture.name, result }));
}

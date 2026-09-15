import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { extractFinanceStandardizationSource } from './finance-standardization-extraction.js';
import { FinanceImageOcrFactsSchema } from '@emdo/contracts';
import { createFinanceImageOcrRuntime } from '@emdo/integrations/finance-documents';
import { createFinanceImageOcrWorkerAdapter } from './finance-image-ocr.js';

const fixtureUrl = new URL(
  '../../../packages/integrations/src/finance-documents/test-fixtures/image-statement.png',
  import.meta.url,
);
const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

describe('image OCR standardization runtime boundary', () => {
  it('fails closed without an approved runtime, even with a valid image', async () => {
    const bytes = await readFile(fixtureUrl);
    const result = await extractFinanceStandardizationSource({
      bytes,
      format: 'png',
      expectedSourceDigest: digest(bytes),
      revision: 1,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({
      status: 'blocked',
      reason: 'Local image OCR is unavailable: ocr-provenance-unavailable.',
    });
  });
});
const nativeImageRuntimeAvailable =
  spawnSync('magick', ['-version'], { stdio: 'ignore', timeout: 2000 })
    .status === 0 &&
  spawnSync('tesseract', ['--version'], { stdio: 'ignore', timeout: 2000 })
    .status === 0;
describe.skipIf(!nativeImageRuntimeAvailable)(
  'real local image OCR in standardization extraction',
  () => {
    it('persists grounded machine words without manufacturing reviewed cells', async () => {
      const bytes = await readFile(fixtureUrl);
      const expectedSourceDigest = digest(bytes);
      // Approve only this synthetic test's local artifacts; production still
      // requires its independently supplied release manifest.
      const magickPath = realpathSync(
        execFileSync('which', ['magick'], { encoding: 'utf8' }).trim(),
      );
      const tesseractPath = realpathSync(
        execFileSync('which', ['tesseract'], { encoding: 'utf8' }).trim(),
      );
      const versionText = execFileSync(tesseractPath, ['--version'], {
        encoding: 'utf8',
      });
      const version = /^tesseract\s+([^\s]+)/im.exec(versionText)?.[1];
      const languageText = execFileSync(tesseractPath, ['--list-langs'], {
        encoding: 'utf8',
      });
      const tessDataDirectory =
        /^List of available languages in\s+"([^"]+)"/im.exec(languageText)?.[1];
      if (!version || !tessDataDirectory)
        throw new Error('native-test-runtime-provenance-missing');
      const trainedDataPath = join(tessDataDirectory, 'eng.traineddata');
      const trainedDataDigest = digest(await readFile(trainedDataPath));
      const imageOcr = createFinanceImageOcrWorkerAdapter({
        runtime: createFinanceImageOcrRuntime({
          magickExecutable: magickPath,
          tesseractExecutable: tesseractPath,
          requireApprovedManifest: true,
          approvedManifest: {
            magick: {
              path: magickPath,
              sha256: digest(await readFile(magickPath)),
            },
            tesseract: {
              path: tesseractPath,
              sha256: digest(await readFile(tesseractPath)),
              version,
            },
            trainedData: [
              {
                language: 'eng',
                path: trainedDataPath,
                sha256: trainedDataDigest,
              },
            ],
          },
        }),
      });
      const result = await extractFinanceStandardizationSource(
        {
          bytes,
          format: 'png',
          expectedSourceDigest,
          revision: 1,
          signal: new AbortController().signal,
        },
        { imageOcr },
      );
      expect(result.status).toBe('extracted');
      if (result.status !== 'extracted') throw new Error(result.reason);
      const facts = FinanceImageOcrFactsSchema.parse(
        JSON.parse(result.envelope.factsJson),
      );
      expect(facts.words.map((w) => w.text)).toEqual([
        'Date',
        'Description',
        'Amount',
        'Currency',
        '2026-09-01',
        'Coffee',
        '12.50',
        'CAD',
      ]);
      expect(facts.engine.id).toBe('tesseract');
      expect(facts.engine.version).toBe(version);
      expect(facts.engine.trainedData).toEqual([
        { language: 'eng', sha256: trainedDataDigest },
      ]);
      expect(result.envelope).toMatchObject({
        kind: 'image-ocr',
        complete: false,
        sourceDigest: expectedSourceDigest,
        documentInstructions: 'untrusted-source-data',
      });
      expect(result.summary).toMatchObject({
        status: 'needs-source-review',
        tableCount: 0,
        pageCount: 1,
      });
    }, 20000);
  },
);

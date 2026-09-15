import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { projectFinanceImagePrompt } from './finance-image-prompt-projection.js';
const digest = 'a'.repeat(64);
function facts(count: number) {
  return {
    status: 'extracted',
    qualityStatus: 'uncertain',
    sourceDigest: digest,
    format: 'png',
    width: 200,
    height: 8000,
    coordinateSpace: 'image-pixels-top-left',
    engine: {
      id: 'tesseract',
      version: '5.5',
      languages: ['eng'],
      trainedData: [{ language: 'eng', sha256: digest }],
    },
    text: 'OCR',
    words: Array.from({ length: count }, (_, index) => ({
      id: `image-page-1-word-${index + 1}`,
      page: 1,
      block: 1,
      paragraph: 1,
      line: Math.floor(index / 2) + 1,
      word: (index % 2) + 1,
      text: `original-${index}-001.2300`,
      box: {
        x: (index % 2) * 50,
        y: Math.floor(index / 2) * 10,
        width: 40,
        height: 8,
      },
      coordinateSpace: 'image-pixels-top-left',
      confidence: 0.6,
      confidenceStatus: 'uncertain',
      sourceAnchor: `box-${index}`,
    })),
    issues: ['OCR requires review'],
    truncated: false,
    textBasis: 'machine-transcription-requires-review',
  };
}
describe('source-bound image prompt projection', () => {
  it('retains a deterministic complete-line prefix and explicit omissions under fixed byte bound', () => {
    const original = facts(500);
    const result = projectFinanceImagePrompt(original, digest)!;
    expect(
      Buffer.byteLength(JSON.stringify(result.projection)),
    ).toBeLessThanOrEqual(12000);
    expect(result.receipt.selectedWordCount).toBeGreaterThan(0);
    expect(result.receipt.selectedWordCount % 2).toBe(0);
    expect(
      result.receipt.selectedWordCount + result.receipt.omittedWordCount,
    ).toBe(500);
    expect(
      result.receipt.selectedLineCount + result.receipt.omittedLineCount,
    ).toBe(250);
    expect(result.projection.words).toEqual(
      original.words.slice(0, result.receipt.selectedWordCount),
    );
    expect(result.receipt.digest).toBe(
      createHash('sha256')
        .update(JSON.stringify(result.projection))
        .digest('hex'),
    );
    expect(projectFinanceImagePrompt(original, digest)).toEqual(result);
    expect(result.projection.complete).toBe(false);
  });
  it('does not slice a too-large first line into fabricated layout', () => {
    const original = facts(500);
    for (const word of original.words) word.line = 1;
    expect(projectFinanceImagePrompt(original, digest)).toBeNull();
  });
  it('uses a caller byte allowance without splitting lines and binds omission metadata in the digest', () => {
    const original = facts(500);
    const result = projectFinanceImagePrompt(original, digest, 3000)!;
    const size = Buffer.byteLength(JSON.stringify(result.projection), 'utf8');
    expect(size).toBeLessThanOrEqual(3000);
    expect(result.receipt.selectedWordCount).toBeGreaterThan(0);
    expect(result.receipt.selectedWordCount % 2).toBe(0);
    expect(result.receipt.omittedWordCount).toBeGreaterThan(0);
    expect(projectFinanceImagePrompt(original, digest, size)).toEqual(result);
    const smaller = projectFinanceImagePrompt(original, digest, size - 1);
    expect(smaller!.receipt.selectedLineCount).toBeLessThan(
      result.receipt.selectedLineCount,
    );
    expect(smaller!.receipt.omittedLineCount).toBeGreaterThan(
      result.receipt.omittedLineCount,
    );
    expect(result.receipt.digest).toBe(
      createHash('sha256')
        .update(JSON.stringify(result.projection))
        .digest('hex'),
    );
    expect(projectFinanceImagePrompt(original, digest, 20000)).toEqual(
      projectFinanceImagePrompt(original, digest),
    );
  });
  it('fails closed if the first whole line or metadata cannot fit the remaining budget', () => {
    expect(projectFinanceImagePrompt(facts(2), digest, 100)).toBeNull();
    expect(
      projectFinanceImagePrompt(
        { ...facts(0), status: 'no-text', text: '' },
        digest,
        100,
      ),
    ).toBeNull();
    for (const budget of [0, -1, NaN, Infinity, 1.5])
      expect(projectFinanceImagePrompt(facts(2), digest, budget)).toBeNull();
  });
});

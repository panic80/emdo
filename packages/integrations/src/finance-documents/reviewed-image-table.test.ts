import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FinanceImageOcrFactsSchema } from '@emdo/contracts';
import { extractReviewedFinanceImageTable } from './reviewed-image-table.js';
const hash = (v: string | Uint8Array) =>
  createHash('sha256').update(v).digest('hex');
const bytes = Buffer.from('original-image-bytes');
const runId = '10000000-0000-4000-8000-000000000001';
const source = {
  documentId: '10000000-0000-4000-8000-000000000002',
  extractionRevision: 1,
  providerKey: 'reviewed',
  reportType: 'bank-transactions' as const,
};
function fixture() {
  const word = (id: number, text: string, y: number) => ({
    id: `image-page-1-word-${id}`,
    text,
    page: 1 as const,
    block: 1,
    paragraph: 1,
    line: id,
    word: 1,
    coordinateSpace: 'image-pixels-top-left' as const,
    confidence: 0.61,
    confidenceStatus: 'uncertain' as const,
    sourceAnchor: `word-${id}`,
    box: { x: 10, y, width: 60, height: 10 },
  });
  const facts = FinanceImageOcrFactsSchema.parse({
    status: 'extracted',
    qualityStatus: 'uncertain',
    sourceDigest: hash(bytes),
    format: 'png',
    width: 200,
    height: 200,
    coordinateSpace: 'image-pixels-top-left',
    engine: {
      id: 'tesseract',
      version: '5.5',
      languages: ['eng'],
      trainedData: [{ language: 'eng', sha256: 'a'.repeat(64) }],
    },
    text: 'Amount\n1O.00',
    words: [word(1, 'Amount', 10), word(2, '1O.00', 30)],
    issues: ['OCR requires review'],
    truncated: false,
    textBasis: 'machine-transcription-requires-review',
  });
  const cell = (word: (typeof facts.words)[number]) => ({
    region: word.box,
    words: [word],
    joiner: ' ' as const,
    reviewedText: word.text,
    correctionReason: null as string | null,
    confirmedAgainstOriginal: true as const,
  });
  const factsJson = JSON.stringify(facts);
  const saved = {
    standardizationRunId: runId,
    extractionRevision: 1,
    extractionDigest: hash(factsJson),
    factsJson,
  };
  const selection = {
    expectedSourceDigest: hash(bytes),
    standardizationRunId: runId,
    extractionRevision: 1,
    expectedExtractionDigest: saved.extractionDigest,
    width: 200,
    height: 200,
    coordinateSpace: 'image-pixels-top-left' as const,
    reviewedWordInventoryDigest: hash(JSON.stringify(facts.words)),
    headerCells: [cell(facts.words[0]!)],
    rows: [
      {
        cells: [
          {
            ...cell(facts.words[1]!),
            reviewedText: '10.00',
            correctionReason:
              'The original image has a zero, not a letter O.' as string | null,
          },
        ],
      },
    ],
    context: { asOf: null, currency: null },
    acknowledgeOcrUncertainty: true,
    acknowledgeUnselectedContent: true,
    confirmedHeaderAndContext: true,
  };
  return { facts, saved, selection };
}
describe('reviewed image materialization', () => {
  it('preserves raw uncertain OCR and explicit exact-string correction separately', () => {
    const { saved, selection } = fixture();
    const result = extractReviewedFinanceImageTable(
      bytes,
      selection,
      saved,
      source,
    );
    expect(result.table.rows).toEqual([{ sourceRow: 1, cells: ['10.00'] }]);
    expect(result.cellProvenance[1]).toMatchObject({
      ocrText: '1O.00',
      reviewedText: '10.00',
      correctionReason: selection.rows[0]!.cells[0]!.correctionReason,
      textBasis: 'human-reviewed-visual-transcription',
    });
    expect(result.table.extractionReview).toMatchObject({
      coverage: 'selected-regions-only',
      ocrExtractionDigest: saved.extractionDigest,
    });
  });
  it('allows explicit OCR-missed pixel-region transcription and preserves omission inventory', () => {
    const { saved, selection } = fixture();
    selection.rows[0]!.cells[0] = {
      region: { x: 10, y: 60, width: 60, height: 10 },
      words: [],
      joiner: ' ',
      reviewedText: '001.2300',
      correctionReason: 'OCR missed this visible amount.',
      confirmedAgainstOriginal: true,
    };
    const result = extractReviewedFinanceImageTable(
      bytes,
      selection,
      saved,
      source,
    );
    expect(result.table.rows[0]!.cells[0]).toBe('001.2300');
    expect(
      result.reviewFacts.unselectedWordInventory.map((w) => w.text),
    ).toEqual(['1O.00']);
  });
  it.each([
    'source',
    'run',
    'revision',
    'extraction',
    'inventory',
    'word',
    'geometry',
    'overlap',
    'hidden-word',
    'reason',
  ] as const)('rejects changed %s binding or ambiguous review', (kind) => {
    const { saved, selection } = fixture();
    if (kind === 'source') selection.expectedSourceDigest = 'b'.repeat(64);
    if (kind === 'run') saved.standardizationRunId = source.documentId;
    if (kind === 'revision') saved.extractionRevision = 2;
    if (kind === 'extraction') saved.factsJson += ' ';
    if (kind === 'inventory')
      selection.reviewedWordInventoryDigest = 'c'.repeat(64);
    if (kind === 'word') selection.rows[0]!.cells[0]!.words[0]!.text = '10.00';
    if (kind === 'geometry') selection.width = 201;
    if (kind === 'overlap')
      selection.rows[0]!.cells[0]!.region = {
        x: 5,
        y: 5,
        width: 100,
        height: 100,
      };
    if (kind === 'hidden-word') selection.rows[0]!.cells[0]!.words = [];
    if (kind === 'reason') selection.rows[0]!.cells[0]!.correctionReason = null;
    expect(() =>
      extractReviewedFinanceImageTable(bytes, selection, saved, source),
    ).toThrow();
  });
});
